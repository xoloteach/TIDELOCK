/**
 * Recast/Detour navigation.
 *
 * Owns every navmesh in the game and the pathfinding queries against them.
 * Nothing else imports `recast-navigation`: sectors are addressed by their
 * authored string id and paths come back as plain `Vec3[]`, so the navigation
 * backend stays replaceable and no WASM object ever reaches the ECS.
 *
 * ## Sectors, not one big navmesh
 *
 * The world streams as sectors, so navigation does too. Each sector owns one
 * *solo* Detour navmesh keyed by its sector id, built or imported
 * independently and freed on unload. An agent paths in the navmesh of the
 * sector it belongs to (`SectorMember.sectorId`), falling back to the active
 * sector.
 *
 * This means **a path cannot cross a sector boundary**. Solo navmeshes are
 * separate Detour instances with no shared polygon graph, so an off-mesh link
 * cannot bridge them either. Crossing a boundary is a hand-off at the
 * transition sector, owned by the streaming layer, not something this class
 * papers over by silently returning a path that stops at the edge.
 *
 * ## Pre-baked navmeshes are the intended path
 *
 * The spec prefers pre-generated sector artefacts, and the library supports
 * it: `exportSector` produces the exact bytes `loadSector` consumes.
 * Generating a real sector's navmesh takes tens to hundreds of milliseconds,
 * which is a visible hitch mid-stream on a phone, so `buildSector` is for
 * tooling, tests and small dynamic regions and `loadSector` is for shipping.
 *
 * ## Triangle winding is not optional
 *
 * Recast decides a triangle is walkable from the normal of
 * `cross(v1 - v0, v2 - v0)`: it must point up. A floor wound the other way
 * rasterises to nothing and the navmesh comes out empty. `PhysicsWorld`
 * deliberately treats collision trimeshes as unoriented to avoid exactly this
 * footgun, but Recast has no equivalent option, so `buildSector` checks the
 * winding when a build produces no polygons and says so in the error rather
 * than reporting an unexplained empty navmesh. Windings are never silently
 * flipped — a mesh with mixed winding would be half-broken either way, and
 * the fix belongs in the exporter.
 *
 * ## Pathfinding is throttled, never per-frame
 *
 * A full path query is a Detour A* over the polygon graph plus a string-pull
 * pass. It is orders of magnitude more expensive than following a path that
 * already exists, and the spec forbids running it every frame. Agents
 * therefore hold a `repathCooldown` and only ever re-run A* when the cooldown
 * has expired *and* something actually changed. See `fixedUpdate`.
 */

import {
  exportNavMesh,
  getNavMeshPositionsAndIndices,
  importNavMesh,
  init as initRecast,
  NavMeshQuery,
  statusToReadableString,
  type NavMesh,
  type OffMeshConnectionParams,
} from 'recast-navigation';
import { generateSoloNavMesh } from 'recast-navigation/generators';
import {
  distance,
  planarDistanceSquared,
  type Entity,
  type NavAgent,
  type Vec3,
} from '../ecs/components';
import type { GameWorld, System } from '../ecs/GameWorld';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Authored sector id, matching `SectorMember.sectorId`. */
export type SectorId = string;

/**
 * Agent dimensions in **world units** (metres and degrees).
 *
 * Recast's own config wants most of these in voxels, which is a routine source
 * of navmeshes that are subtly wrong in a way nobody notices until an NPC
 * walks through a railing. The conversion happens in one place, in
 * `toRecastConfig`.
 */
export interface NavAgentProfile {
  /** Metres. The walkable surface is eroded by this much from every wall. */
  radius: number;
  /** Metres. Minimum floor-to-ceiling clearance the agent needs. */
  height: number;
  /** Metres. Tallest step or kerb the agent can walk up. */
  maxClimb: number;
  /** Degrees. Steepest slope still considered floor. */
  maxSlope: number;
}

/**
 * Mara and the maintenance machines are close enough in size that one profile
 * covers both. Kerbs and the depot's steel stair nosings are the reason
 * `maxClimb` is 0.4 rather than a token value.
 */
export const DEFAULT_AGENT_PROFILE: NavAgentProfile = {
  radius: 0.4,
  height: 1.8,
  maxClimb: 0.4,
  maxSlope: 45,
};

/**
 * Simplified navigation geometry: a flat position array and a flat triangle
 * index array, exactly as a glTF accessor or a `BufferGeometry` provides them.
 *
 * Deliberately not a Three.js object — `engine/` must not need the scene
 * graph to build a navmesh, and the authoring side already has to produce a
 * simplified nav-only mesh rather than the render mesh.
 */
export interface NavGeometry {
  /** `[x0, y0, z0, x1, y1, z1, ...]` */
  positions: ArrayLike<number>;
  /** `[a0, b0, c0, a1, b1, c1, ...]`, counter-clockwise seen from above. */
  indices: ArrayLike<number>;
}

/**
 * An authored traversal that is not a walk across the floor: a stair flight
 * treated as a single hop, a doorway threshold, a ladder, the depot's service
 * bridge handrail gap.
 *
 * Baked into the navmesh at build time, so they survive `exportSector` /
 * `loadSector`. Both endpoints must land on the same sector's navmesh.
 */
export interface OffMeshLink {
  /** Authored id. Diagnostics only; Detour identifies links by `userId`. */
  id?: string;
  start: Vec3;
  end: Vec3;
  /** Metres. How close an agent must get to the endpoint to use the link. */
  radius: number;
  /** False makes the link one-way from `start` to `end`. */
  bidirectional: boolean;
  /** Detour area id, for per-area traversal cost. Defaults to 0 (ground). */
  area?: number;
  /** Detour poly flags, matched against the query filter. Defaults to 1. */
  flags?: number;
}

export interface NavMeshBuildOptions {
  /** Overrides the system-wide agent profile for this sector. */
  agent?: Partial<NavAgentProfile>;
  /** Metres. Horizontal voxel size. Smaller is more accurate and slower. */
  cellSize?: number;
  /** Metres. Vertical voxel size. */
  cellHeight?: number;
  offMeshLinks?: OffMeshLink[];
  /**
   * Explicit world bounds for the heightfield. Derived from the geometry when
   * omitted, which is correct except for a perfectly flat mesh whose bounding
   * box has zero height — pad the Y range there.
   */
  bounds?: { min: Vec3; max: Vec3 };
  /**
   * Voxels². Islands smaller than this are discarded. Raise it to stop a
   * sector generating unreachable scraps on top of pipework.
   */
  minRegionArea?: number;
  /** Voxels². Regions smaller than this are merged into a neighbour. */
  mergeRegionArea?: number;
}

export interface NavMeshBuildResult {
  success: boolean;
  sectorId: SectorId;
  /** Present only on failure. Already prefixed and human-readable. */
  error?: string;
  /** Detour polygons in the mesh, off-mesh link polys included. */
  polygonCount: number;
  offMeshLinkCount: number;
  /** Wall-clock milliseconds. The reason shipping builds are pre-baked. */
  buildMs: number;
}

/** Why a path query produced nothing usable. */
export type PathFailure =
  /** The sector has no navmesh loaded. */
  | 'no-navmesh'
  /** The start position is not within the search box of any polygon. */
  | 'start-off-navmesh'
  /** The destination is not within the search box of any polygon. */
  | 'end-off-navmesh'
  /** Detour could not produce a corridor at all. */
  | 'no-path'
  /** A corridor exists but does not reach the destination. */
  | 'unreachable';

export interface PathResult {
  success: boolean;
  /** World positions, start first. Empty on failure. */
  path: Vec3[];
  failure?: PathFailure;
  /** Library-reported detail, when there was one. */
  detail?: string;
  /**
   * True when `allowPartial` was set and this path stops short of the
   * destination. Never true unless asked for.
   */
  partial?: boolean;
}

export interface PathQueryOptions {
  /** Defaults to the active sector. */
  sectorId?: SectorId;
  /** Overrides the snap search box for this query. */
  searchHalfExtents?: Vec3;
  /**
   * Accept a corridor that gets as close as it can instead of failing.
   *
   * Off by default: Detour reports a truncated corridor as a *successful*
   * path, and a caller that trusts that will happily walk a machine into a
   * flood gate and call it arrival.
   */
  allowPartial?: boolean;
}

export interface NearestPointResult {
  found: boolean;
  /** The snapped position. Equal to the input when nothing was found. */
  point: Vec3;
  /**
   * True when the input was directly over a navmesh polygon.
   *
   * This is Detour's own `posOverPoly`, and it is a **strict interior** test:
   * a point sitting exactly on a polygon boundary — which is where every
   * string-pulled waypoint sits, by construction — reads false. Height is
   * ignored, so a point eight metres above the floor is still "over" it. Use
   * `isOnNavMesh` for the "is this a valid place to stand" question.
   */
  alreadyOnNavMesh: boolean;
}

/** Triangle soup for a navmesh overlay. Rendering it is the caller's job. */
export interface NavDebugGeometry {
  positions: Float32Array;
  indices: Uint32Array;
  polygonCount: number;
}

export interface NavigationCounters {
  /** Sectors with a navmesh loaded. */
  navMeshes: number;
  /** Detour polygons across every loaded navmesh. */
  polygons: number;
  offMeshLinks: number;
  /** Entities with a `navAgent` component. */
  agents: number;
  /** Agents currently following a path. */
  agentsWithPath: number;
  /** Full A* queries run since construction. The number that matters. */
  pathsComputed: number;
  pathsFailed: number;
  /** Repaths an agent wanted but did not get, because its cooldown was live. */
  repathsSuppressed: number;
  /** Repaths deferred to a later step because the per-step budget ran out. */
  repathsDeferred: number;
}

export interface NavigationSystemOptions {
  /** The ECS world whose `navAgents` this system drives. */
  world: GameWorld;
  /** Default agent profile for builds and query snapping. */
  agent?: Partial<NavAgentProfile>;
  /**
   * Seconds an agent must wait between full path queries.
   *
   * 0.5 s is a deliberate compromise: a maintenance crawler reacting half a
   * second late is invisible, and it caps A* at two queries per agent per
   * second instead of sixty.
   */
  repathInterval?: number;
  /** Metres, horizontal. Distance at which a waypoint counts as reached. */
  waypointTolerance?: number;
  /**
   * Metres, horizontal. Distance from the final waypoint at which `arrived` is
   * set. Vertical separation is checked separately against the agent height.
   */
  arrivalTolerance?: number;
  /**
   * Metres. How far the destination must move before the path is thrown away.
   * Stops a jittering follow target triggering A* on every cooldown expiry.
   */
  destinationEpsilon?: number;
  /**
   * Metres. Maximum gap between the snapped destination and the end of the
   * returned corridor before the path is called `unreachable`.
   */
  partialPathTolerance?: number;
  /** Rotate agents toward their travel direction. */
  faceTravelDirection?: boolean;
  /** Radians/second cap on that rotation. */
  turnRate?: number;
  /**
   * Full path queries allowed per fixed step, across all agents.
   *
   * A sector transition can hand a dozen machines a new destination on the
   * same step; without a budget they all run A* inside one 16 ms slice and
   * the frame is gone. Deferred agents keep their expired cooldown and are
   * served on the following steps.
   */
  maxPathsPerStep?: number;
}

// ---------------------------------------------------------------------------
// WASM init
// ---------------------------------------------------------------------------

/**
 * Recast's `init()` loads and instantiates the Emscripten module. Memoised so
 * several `NavigationSystem` instances — or several test cases — share one
 * module instead of re-instantiating it. The module is process-global and
 * outlives any individual system, so `dispose()` never tears it down.
 */
let initPromise: Promise<void> | null = null;

function initRecastNavigation(): Promise<void> {
  initPromise ??= initRecast();
  return initPromise;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface SectorNav {
  id: SectorId;
  navMesh: NavMesh;
  query: NavMeshQuery;
  polygonCount: number;
  offMeshLinkCount: number;
  /** Bumped on every build/import so agents can invalidate stale paths. */
  generation: number;
  origin: 'built' | 'imported';
}

/**
 * Per-agent bookkeeping that does not belong in the component.
 *
 * Keyed on the `NavAgent` component rather than the entity, so replacing the
 * component resets the pathing state with it. Weak, so despawning an entity
 * does not leak.
 */
interface AgentRuntime {
  /** The destination the current path was computed for. */
  pathedTo: Vec3 | null;
  /** Sector generation the path was computed against. */
  generation: number;
  /** Consecutive failed attempts, for exponential backoff. */
  failures: number;
}

const DEFAULT_CELL_SIZE = 0.2;
const DEFAULT_CELL_HEIGHT = 0.2;

/** Recast rejects a walkable height below 3 voxels outright. */
const MIN_WALKABLE_HEIGHT_VOXELS = 3;

/** Detour's own ceiling on slope; 90° would make walls walkable. */
const MAX_SLOPE_DEGREES = 89;

/** Cap on backoff growth, so a permanently blocked agent still retries. */
const MAX_BACKOFF_MULTIPLIER = 8;

function copyVec3(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

/**
 * Fraction of triangles whose geometric normal points upward.
 *
 * Only ever called to explain a build that produced no polygons, so the O(n)
 * pass costs nothing in the normal case.
 */
function upwardFacingFraction(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
): number {
  const triangles = Math.floor(indices.length / 3);
  if (triangles === 0) return 0;

  let candidates = 0;
  let upward = 0;
  for (let t = 0; t < triangles; t += 1) {
    const a = indices[t * 3] * 3;
    const b = indices[t * 3 + 1] * 3;
    const c = indices[t * 3 + 2] * 3;

    // Only X and Z are read: the Y component of cross(e0, e1) is the only one
    // the slope test looks at, and it is built entirely from X and Z terms.
    const e0x = positions[b] - positions[a];
    const e0z = positions[b + 2] - positions[a + 2];
    const e1x = positions[c] - positions[a];
    const e1z = positions[c + 2] - positions[a + 2];

    const ny = e0z * e1x - e0x * e1z;

    // Vertical faces are skipped rather than counted as badly wound. A wall
    // has ny near zero whichever way it is wound and says nothing about
    // whether the floors are right, so including it would make a room with
    // correct floors look 50% broken.
    const horizontalExtent = Math.hypot(e0x, e0z) * Math.hypot(e1x, e1z);
    if (horizontalExtent === 0 || Math.abs(ny) <= horizontalExtent * 1e-3) continue;

    candidates += 1;
    if (ny > 0) upward += 1;
  }
  return candidates === 0 ? 0 : upward / candidates;
}

function describeLibraryError(error?: { name: string; status?: number }): string | undefined {
  if (!error) return undefined;
  if (error.status === undefined) return error.name;
  return `${error.name} (${statusToReadableString(error.status)})`;
}

// ---------------------------------------------------------------------------
// NavigationSystem
// ---------------------------------------------------------------------------

export class NavigationSystem implements System {
  readonly name = 'navigation';

  private readonly world: GameWorld;
  private readonly agentProfile: NavAgentProfile;
  private readonly repathInterval: number;
  private readonly waypointTolerance: number;
  private readonly arrivalTolerance: number;
  private readonly destinationEpsilon: number;
  private readonly partialPathTolerance: number;
  private readonly faceTravelDirection: boolean;
  private readonly turnRate: number;
  private readonly maxPathsPerStep: number;

  /**
   * Default snap search box, derived from the agent profile.
   *
   * Detour's own default is a 1 m cube, which is too tight vertically for a
   * spawn point authored a step above the floor, and too loose horizontally to
   * be cheap. Sized once here instead of at every call site.
   */
  private readonly searchHalfExtents: Vec3;

  private readonly sectors = new Map<SectorId, SectorNav>();
  private readonly agentRuntimes = new WeakMap<NavAgent, AgentRuntime>();

  private activeSector: SectorId | null = null;
  private nextGeneration = 1;
  private pathsComputed = 0;
  private pathsFailed = 0;
  private repathsSuppressed = 0;
  private repathsDeferred = 0;
  private disposed = false;

  private constructor(options: NavigationSystemOptions) {
    this.world = options.world;
    this.agentProfile = { ...DEFAULT_AGENT_PROFILE, ...options.agent };
    this.repathInterval = options.repathInterval ?? 0.5;
    this.waypointTolerance = options.waypointTolerance ?? 0.15;
    this.arrivalTolerance = options.arrivalTolerance ?? 0.25;
    this.destinationEpsilon = options.destinationEpsilon ?? 0.25;
    this.partialPathTolerance = options.partialPathTolerance ?? 1;
    this.faceTravelDirection = options.faceTravelDirection ?? true;
    this.turnRate = options.turnRate ?? Math.PI * 1.5;
    this.maxPathsPerStep = options.maxPathsPerStep ?? 4;

    const reach = Math.max(1, this.agentProfile.radius * 4);
    this.searchHalfExtents = {
      x: reach,
      y: Math.max(2, this.agentProfile.height * 2),
      z: reach,
    };
  }

  /**
   * Loads the Recast WASM module and returns a ready system.
   *
   * The async work lives here rather than in the constructor so construction
   * stays synchronous and a half-initialised instance can never exist —
   * mirroring `PhysicsWorld.create`.
   */
  static async create(options: NavigationSystemOptions): Promise<NavigationSystem> {
    await initRecastNavigation();
    return new NavigationSystem(options);
  }

  // ---- Navmesh lifecycle ------------------------------------------------

  /**
   * Builds a sector navmesh from simplified navigation geometry.
   *
   * Replaces any navmesh already loaded for `sectorId`, freeing the old one
   * first, and bumps the sector generation so agents mid-path re-query rather
   * than following waypoints through a mesh that no longer exists.
   *
   * Expensive. Prefer `loadSector` with a baked artefact at runtime.
   */
  buildSector(
    sectorId: SectorId,
    geometry: NavGeometry,
    options: NavMeshBuildOptions = {},
  ): NavMeshBuildResult {
    this.assertLive();

    const { positions, indices } = geometry;
    if (positions.length % 3 !== 0) {
      throw new Error(
        `[nav] sector "${sectorId}" position count ${positions.length} is not a multiple of 3`,
      );
    }
    if (indices.length % 3 !== 0) {
      throw new Error(
        `[nav] sector "${sectorId}" index count ${indices.length} is not a multiple of 3`,
      );
    }
    if (indices.length === 0) {
      return this.buildFailure(sectorId, 'navigation geometry has no triangles', 0);
    }

    const started = performance.now();
    const config = this.toRecastConfig(options);
    const offMeshLinks = options.offMeshLinks ?? [];
    if (offMeshLinks.length > 0) {
      config.offMeshConnections = offMeshLinks.map(toOffMeshConnectionParams);
    }
    if (options.bounds) {
      config.bounds = [
        [options.bounds.min.x, options.bounds.min.y, options.bounds.min.z],
        [options.bounds.max.x, options.bounds.max.y, options.bounds.max.z],
      ];
    }

    const result = generateSoloNavMesh(positions, indices, config);
    const buildMs = performance.now() - started;

    if (!result.success) {
      // Recast reports "failed to create navmesh data" for an empty polygon
      // mesh without saying why it was empty. Winding is by far the most
      // common cause, so check it and name it.
      let error = result.error;
      const upward = upwardFacingFraction(positions, indices);
      if (upward === 0) {
        error += ' — no triangle in this geometry faces upward. Recast marks a'
          + ' triangle walkable from the normal of cross(v1 - v0, v2 - v0), so'
          + ' floors must be wound counter-clockwise seen from above. Flip the'
          + ' triangle winding in the nav geometry exporter.';
      } else if (upward < 0.5) {
        error += ` — only ${Math.round(upward * 100)}% of triangles face upward,`
          + ' which suggests inconsistent winding in the nav geometry.';
      }
      return this.buildFailure(sectorId, error, buildMs);
    }

    return this.adopt(sectorId, result.navMesh, 'built', buildMs);
  }

  /**
   * Loads a pre-baked navmesh artefact produced by `exportSector`.
   *
   * This is the shipping path: the bytes come out of a build-time asset and
   * import in well under a millisecond, where generating the same mesh costs
   * tens to hundreds. Off-mesh links are baked into the data, so an imported
   * navmesh has the same connectivity as the mesh it was exported from.
   */
  loadSector(sectorId: SectorId, data: Uint8Array): NavMeshBuildResult {
    this.assertLive();

    if (data.byteLength === 0) {
      return this.buildFailure(sectorId, 'navmesh artefact is empty', 0);
    }

    const started = performance.now();
    let navMesh: NavMesh;
    try {
      navMesh = importNavMesh(data).navMesh;
    } catch (cause) {
      // A truncated or foreign artefact faults inside WASM. Surfacing it as a
      // failed load is right; swallowing it and continuing with no navmesh
      // would leave every machine in the sector standing still for no visible
      // reason.
      const message = cause instanceof Error ? cause.message : String(cause);
      return this.buildFailure(
        sectorId,
        `navmesh artefact could not be imported: ${message}`,
        performance.now() - started,
      );
    }

    const adopted = this.adopt(
      sectorId,
      navMesh,
      'imported',
      performance.now() - started,
    );
    if (adopted.polygonCount === 0) {
      // Imported cleanly but contains nothing. Better to reject it than to
      // hand agents a navmesh that fails every query.
      this.unloadSector(sectorId);
      return this.buildFailure(
        sectorId,
        'navmesh artefact imported but contains no polygons',
        adopted.buildMs,
      );
    }
    return adopted;
  }

  /**
   * Serialises a loaded navmesh to the exact bytes `loadSector` consumes.
   *
   * Used by the asset pipeline to bake sector artefacts, and by tests. The
   * format is Detour's own tile serialisation and is tied to this Recast
   * build, so artefacts are regenerated when the dependency moves — they are
   * not a save format.
   */
  exportSector(sectorId: SectorId): Uint8Array | null {
    this.assertLive();
    const sector = this.sectors.get(sectorId);
    if (!sector) return null;
    return exportNavMesh(sector.navMesh);
  }

  /**
   * Frees a sector's navmesh. Returns false for an unknown id rather than
   * throwing: streaming unload legitimately races with a manual reload.
   */
  unloadSector(sectorId: SectorId): boolean {
    const sector = this.sectors.get(sectorId);
    if (!sector) return false;

    // Delete before destroying, so a throw inside WASM cannot leave a freed
    // navmesh reachable from the map. Destroying one twice faults the module.
    this.sectors.delete(sectorId);
    destroySector(sector);

    if (this.activeSector === sectorId) {
      this.activeSector = this.sectors.keys().next().value ?? null;
    }
    return true;
  }

  hasSector(sectorId: SectorId): boolean {
    return this.sectors.has(sectorId);
  }

  get sectorIds(): SectorId[] {
    return [...this.sectors.keys()];
  }

  /**
   * Sector used by queries and agents that do not name one.
   *
   * Set automatically to the first navmesh loaded, so single-sector cases and
   * tests need not think about it.
   */
  get activeSectorId(): SectorId | null {
    return this.activeSector;
  }

  setActiveSector(sectorId: SectorId): boolean {
    if (!this.sectors.has(sectorId)) return false;
    this.activeSector = sectorId;
    return true;
  }

  private adopt(
    sectorId: SectorId,
    navMesh: NavMesh,
    origin: 'built' | 'imported',
    buildMs: number,
  ): NavMeshBuildResult {
    const previous = this.sectors.get(sectorId);
    if (previous) {
      this.sectors.delete(sectorId);
      destroySector(previous);
    }

    const query = new NavMeshQuery(navMesh);
    // Detour defaults to a 1 m cube, which misses a spawn authored a step off
    // the floor. Sized from the agent instead.
    query.defaultQueryHalfExtents = { ...this.searchHalfExtents };

    const { polygonCount, offMeshLinkCount } = countNavMeshPolys(navMesh);

    this.sectors.set(sectorId, {
      id: sectorId,
      navMesh,
      query,
      polygonCount,
      offMeshLinkCount,
      generation: this.nextGeneration++,
      origin,
    });
    this.activeSector ??= sectorId;

    return { success: true, sectorId, polygonCount, offMeshLinkCount, buildMs };
  }

  private buildFailure(
    sectorId: SectorId,
    error: string,
    buildMs: number,
  ): NavMeshBuildResult {
    return {
      success: false,
      sectorId,
      error: `[nav] sector "${sectorId}": ${error}`,
      polygonCount: 0,
      offMeshLinkCount: 0,
      buildMs,
    };
  }

  /**
   * Converts world-unit agent parameters into Recast's voxel-space config.
   *
   * Recast expresses walkable height, climb and radius in voxels, not metres.
   * Height and radius round up so the agent is never allowed through a gap it
   * does not fit, and climb rounds down so it is never allowed up a step it
   * cannot make.
   */
  private toRecastConfig(
    options: NavMeshBuildOptions,
  ): Parameters<typeof generateSoloNavMesh>[2] & { offMeshConnections?: OffMeshConnectionParams[] } {
    const agent = { ...this.agentProfile, ...options.agent };
    const cs = options.cellSize ?? DEFAULT_CELL_SIZE;
    const ch = options.cellHeight ?? DEFAULT_CELL_HEIGHT;

    const config: NonNullable<Parameters<typeof generateSoloNavMesh>[2]> = {
      cs,
      ch,
      walkableSlopeAngle: Math.min(MAX_SLOPE_DEGREES, Math.max(0, agent.maxSlope)),
      walkableHeight: Math.max(
        MIN_WALKABLE_HEIGHT_VOXELS,
        Math.ceil(agent.height / ch),
      ),
      walkableClimb: Math.max(0, Math.floor(agent.maxClimb / ch)),
      walkableRadius: Math.max(0, Math.ceil(agent.radius / cs)),
    };
    if (options.minRegionArea !== undefined) config.minRegionArea = options.minRegionArea;
    if (options.mergeRegionArea !== undefined) {
      config.mergeRegionArea = options.mergeRegionArea;
    }
    return config;
  }

  // ---- Queries ----------------------------------------------------------

  /**
   * Finds a walkable path between two world positions.
   *
   * Both endpoints are snapped onto the navmesh first, so a destination
   * authored slightly above the floor or a spawn a few centimetres inside a
   * wall still works. Failure to snap either endpoint is reported rather than
   * guessed at.
   *
   * ### Truncated corridors
   *
   * Detour reports an unreachable destination as a **successful** path that
   * simply stops at the far side of the reachable region. Taking that at face
   * value is how a machine ends up standing against a flood gate reporting
   * that it arrived, so the end of the corridor is checked against the snapped
   * destination and a short one is reported as `unreachable`. Callers that
   * genuinely want "get as close as you can" opt in with `allowPartial`.
   */
  findPath(from: Vec3, to: Vec3, options: PathQueryOptions = {}): PathResult {
    this.assertLive();

    const sector = this.resolveSector(options.sectorId);
    if (!sector) {
      return { success: false, path: [], failure: 'no-navmesh' };
    }

    const halfExtents = options.searchHalfExtents ?? this.searchHalfExtents;

    const start = sector.query.findClosestPoint(from, { halfExtents });
    if (!start.success) {
      return { success: false, path: [], failure: 'start-off-navmesh' };
    }
    const end = sector.query.findClosestPoint(to, { halfExtents });
    if (!end.success) {
      return { success: false, path: [], failure: 'end-off-navmesh' };
    }

    // The expensive part: A* over the polygon graph plus a string pull.
    this.pathsComputed += 1;
    const computed = sector.query.computePath(start.point, end.point, { halfExtents });

    if (!computed.success || computed.path.length === 0) {
      this.pathsFailed += 1;
      return {
        success: false,
        path: [],
        failure: 'no-path',
        detail: describeLibraryError(computed.error),
      };
    }

    const path = computed.path.map(copyVec3);
    const reached = path[path.length - 1];
    const shortfall = distance(reached, end.point);

    if (shortfall > this.partialPathTolerance) {
      if (!options.allowPartial) {
        this.pathsFailed += 1;
        return {
          success: false,
          path: [],
          failure: 'unreachable',
          detail: `corridor stops ${shortfall.toFixed(2)}m short of the destination`,
        };
      }
      return { success: true, path, partial: true };
    }

    return { success: true, path };
  }

  /**
   * Nearest walkable point to an arbitrary world position.
   *
   * Used to place a spawn, validate an authored checkpoint, or fix up a
   * destination picked from a render mesh whose floor sits a little above the
   * navmesh. `alreadyOnNavMesh` distinguishes "this was fine" from "this was
   * moved", which is what a story-checkpoint validator needs to report.
   */
  nearestPoint(
    point: Vec3,
    options: { sectorId?: SectorId; searchHalfExtents?: Vec3 } = {},
  ): NearestPointResult {
    this.assertLive();

    const sector = this.resolveSector(options.sectorId);
    if (!sector) {
      return { found: false, point: copyVec3(point), alreadyOnNavMesh: false };
    }

    const halfExtents = options.searchHalfExtents ?? this.searchHalfExtents;
    const result = sector.query.findClosestPoint(point, { halfExtents });
    if (!result.success) {
      return { found: false, point: copyVec3(point), alreadyOnNavMesh: false };
    }
    return {
      found: true,
      point: copyVec3(result.point),
      alreadyOnNavMesh: result.isPointOverPoly,
    };
  }

  /**
   * True if there is walkable ground at this position.
   *
   * Compared **horizontally**, because the navmesh floor does not sit at the
   * same height as the geometry it was built from: Recast rasterises to voxel
   * spans, so a surface authored at y = 0 becomes a polygon at y = one cell
   * height. Asking whether an authored spawn point is on the navmesh would
   * otherwise fail for every sector in the game.
   *
   * Not the same question as `NearestPointResult.alreadyOnNavMesh`, which is
   * Detour's strict polygon-interior test and reads false on boundaries.
   */
  isOnNavMesh(
    point: Vec3,
    options: { sectorId?: SectorId; tolerance?: number } = {},
  ): boolean {
    const tolerance = options.tolerance ?? 0.1;
    const nearest = this.nearestPoint(
      point,
      options.sectorId === undefined ? {} : { sectorId: options.sectorId },
    );
    if (!nearest.found) return false;
    return planarDistanceSquared(point, nearest.point) <= tolerance * tolerance;
  }

  private resolveSector(sectorId?: SectorId): SectorNav | undefined {
    const id = sectorId ?? this.activeSector;
    if (id === null || id === undefined) return undefined;
    return this.sectors.get(id);
  }

  // ---- Agents -----------------------------------------------------------

  /**
   * Points an agent at a destination.
   *
   * Writes the component directly, so a caller that prefers to do that itself
   * loses nothing. `immediate` clears the repath cooldown, for the cases where
   * a frame of latency is visible — an interaction the player just triggered,
   * or a machine escalating to pursue.
   */
  setDestination(
    entity: Entity,
    destination: Vec3,
    options: { immediate?: boolean } = {},
  ): boolean {
    const agent = entity.navAgent;
    if (!agent) return false;

    agent.destination = copyVec3(destination);
    agent.arrived = false;
    if (options.immediate) agent.repathCooldown = 0;
    return true;
  }

  /** Stops an agent and drops its path. */
  clearDestination(entity: Entity): boolean {
    const agent = entity.navAgent;
    if (!agent) return false;

    agent.destination = null;
    agent.path.length = 0;
    agent.pathIndex = 0;
    agent.arrived = false;
    this.agentRuntimes.delete(agent);
    return true;
  }

  /**
   * Repaths and advances every agent.
   *
   * Runs on the fixed step, so `dt` is constant and movement is frame-rate
   * independent. Two distinct pieces of work happen here, and keeping them
   * distinct is the whole point:
   *
   * 1. **Repathing** — a full Detour A* query. Gated by a per-agent cooldown,
   *    by whether the destination actually moved, and by a per-step budget.
   *    An agent standing on a valid path does no query work at all.
   * 2. **Following** — walking the existing waypoint list. Pure arithmetic,
   *    cheap enough to run for every agent every step.
   */
  fixedUpdate(dt: number): void {
    this.assertLive();

    let budget = this.maxPathsPerStep;

    for (const entity of this.world.navAgents.entities) {
      const agent = entity.navAgent;
      const transform = entity.transform;

      // Cooldown always ticks, clamped at zero so it cannot drift negative
      // and make the next comparison meaningless.
      if (agent.repathCooldown > 0) {
        agent.repathCooldown = Math.max(0, agent.repathCooldown - dt);
      }

      const destination = agent.destination;
      if (!destination) {
        if (agent.path.length > 0) {
          agent.path.length = 0;
          agent.pathIndex = 0;
        }
        agent.arrived = false;
        this.agentRuntimes.delete(agent);
        continue;
      }

      const sectorId = entity.sector?.sectorId ?? this.activeSector ?? undefined;
      const sector = this.resolveSector(sectorId);
      const runtime = this.runtimeFor(agent);

      const generation = sector?.generation ?? 0;
      const destinationMoved = runtime.pathedTo === null
        || distance(runtime.pathedTo, destination) > this.destinationEpsilon;
      const navMeshChanged = runtime.generation !== generation;
      const retryAfterFailure = runtime.failures > 0;

      if (destinationMoved || navMeshChanged || retryAfterFailure) {
        if (agent.repathCooldown > 0) {
          this.repathsSuppressed += 1;
        } else if (budget <= 0) {
          // Keep the expired cooldown so this agent is first in line next
          // step rather than waiting another full interval.
          this.repathsDeferred += 1;
        } else {
          budget -= 1;
          this.repath(agent, transform.position, destination, sectorId, runtime, generation);
        }
      }

      this.followPath(agent, entity, dt);
    }
  }

  private runtimeFor(agent: NavAgent): AgentRuntime {
    let runtime = this.agentRuntimes.get(agent);
    if (!runtime) {
      runtime = { pathedTo: null, generation: -1, failures: 0 };
      this.agentRuntimes.set(agent, runtime);
    }
    return runtime;
  }

  private repath(
    agent: NavAgent,
    origin: Vec3,
    destination: Vec3,
    sectorId: SectorId | undefined,
    runtime: AgentRuntime,
    generation: number,
  ): void {
    const options: PathQueryOptions = sectorId === undefined ? {} : { sectorId };
    const result = this.findPath(origin, destination, options);

    runtime.pathedTo = copyVec3(destination);
    runtime.generation = generation;

    if (!result.success) {
      runtime.failures += 1;
      agent.path.length = 0;
      agent.pathIndex = 0;
      agent.arrived = false;
      // Back off geometrically. An agent whose destination is behind a sealed
      // flood gate would otherwise re-run A* twice a second forever, and the
      // answer will not have changed.
      const multiplier = Math.min(
        MAX_BACKOFF_MULTIPLIER,
        2 ** (runtime.failures - 1),
      );
      agent.repathCooldown = this.repathInterval * multiplier;
      return;
    }

    runtime.failures = 0;
    agent.path = result.path;
    agent.pathIndex = 0;
    agent.arrived = false;
    agent.repathCooldown = this.repathInterval;
  }

  /**
   * Advances an agent along its waypoint list by one fixed step.
   *
   * Consumes as many waypoints as `speed * dt` reaches, so a fast agent on a
   * finely-tessellated corridor does not stall one waypoint per step. Landing
   * on a waypoint snaps exactly to it, which keeps corners tight and makes the
   * arrival test exact rather than tolerance-dependent.
   *
   * ## Steering is horizontal; height comes from the surface
   *
   * `speed` is ground speed, and distance to a waypoint is measured in the XZ
   * plane only. Height is taken from the waypoint rather than travelled to.
   *
   * This is not a simplification, it is a correctness requirement. Recast
   * rasterises geometry into voxel spans, so the navmesh polygon over a floor
   * authored at y = 0 sits one cell height above it, and an agent standing on
   * that floor is permanently offset from its own path. Measuring distance in
   * three dimensions makes the agent spend its first several steps climbing
   * that offset — straight up, at full speed, with no horizontal progress —
   * before it starts walking. Slopes and stair links still work, because each
   * waypoint's height is adopted as it is approached.
   */
  private followPath(agent: NavAgent, entity: Entity, dt: number): void {
    const transform = entity.transform;
    if (!transform) return;

    const position = transform.position;
    const startX = position.x;
    const startY = position.y;
    const startZ = position.z;

    let remaining = Math.max(0, agent.speed) * dt;

    while (agent.pathIndex < agent.path.length) {
      const target = agent.path[agent.pathIndex];
      const dx = target.x - position.x;
      const dz = target.z - position.z;
      const gap = Math.hypot(dx, dz);

      if (gap <= remaining) {
        position.x = target.x;
        position.z = target.z;
        position.y = target.y;
        remaining -= gap;
        agent.pathIndex += 1;
        continue;
      }
      if (gap <= this.waypointTolerance) {
        // Already close enough to count as reached. Adopt its height and
        // consume it without moving, so an agent does not shuffle backwards
        // onto a waypoint it has effectively passed. This is also the branch
        // that retires the first waypoint of every path, which is the agent's
        // own snapped position.
        position.y = target.y;
        agent.pathIndex += 1;
        continue;
      }
      if (remaining <= 0) break;

      const step = remaining / gap;
      position.x += dx * step;
      position.z += dz * step;
      // Ease toward the surface height at the same rate, so a ramp is followed
      // rather than climbed in one jump at the top.
      position.y += (target.y - position.y) * step;
      remaining = 0;
    }

    const moveX = position.x - startX;
    const moveY = position.y - startY;
    const moveZ = position.z - startZ;

    if (entity.velocity) {
      // Written so animation and audio can read actual ground speed rather
      // than re-deriving it from positions they would have to remember. Y
      // carries the one-off correction onto the navmesh surface on the first
      // step of a path, so locomotion should read the XZ magnitude.
      entity.velocity.linear.x = moveX / dt;
      entity.velocity.linear.y = moveY / dt;
      entity.velocity.linear.z = moveZ / dt;
    }

    if (this.faceTravelDirection && (moveX !== 0 || moveZ !== 0)) {
      // Three.js convention, matching PlayerController and PerceptionSystem:
      // yaw 0 looks down -Z and positive yaw rotates about +Y.
      turnToward(transform, Math.atan2(-moveX, -moveZ), this.turnRate * dt);
    }

    if (agent.pathIndex < agent.path.length) {
      agent.arrived = false;
      return;
    }

    // Arrival is horizontal for the same reason steering is, with a vertical
    // guard so an agent on a walkway directly above its destination does not
    // claim to have reached it.
    const goal = agent.path.length > 0
      ? agent.path[agent.path.length - 1]
      : agent.destination;
    if (!goal) {
      agent.arrived = false;
      return;
    }
    agent.arrived =
      planarDistanceSquared(position, goal) <= this.arrivalTolerance ** 2
      && Math.abs(position.y - goal.y) <= this.agentProfile.height;
  }

  // ---- Diagnostics ------------------------------------------------------

  /**
   * Triangle soup for a navmesh overlay, in world space.
   *
   * Returns geometry only. Building a mesh, picking a material and deciding
   * when to show it belong to the diagnostics overlay, not here — `engine/`
   * has no business owning debug visuals.
   */
  getDebugGeometry(sectorId?: SectorId): NavDebugGeometry | null {
    this.assertLive();
    const sector = this.resolveSector(sectorId);
    if (!sector) return null;

    const [positions, indices] = getNavMeshPositionsAndIndices(sector.navMesh);
    return {
      positions: new Float32Array(positions),
      indices: new Uint32Array(indices),
      polygonCount: sector.polygonCount,
    };
  }

  /** Polygon count for one loaded sector, or null if it is not loaded. */
  getSectorPolygonCount(sectorId: SectorId): number | null {
    return this.sectors.get(sectorId)?.polygonCount ?? null;
  }

  /** Whether a sector's navmesh was generated at runtime or imported baked. */
  getSectorOrigin(sectorId: SectorId): 'built' | 'imported' | null {
    return this.sectors.get(sectorId)?.origin ?? null;
  }

  getCounters(): NavigationCounters {
    let polygons = 0;
    let offMeshLinks = 0;
    for (const sector of this.sectors.values()) {
      polygons += sector.polygonCount;
      offMeshLinks += sector.offMeshLinkCount;
    }

    const agents = this.disposed ? [] : this.world.navAgents.entities;
    let agentsWithPath = 0;
    for (const entity of agents) {
      if (entity.navAgent.path.length > entity.navAgent.pathIndex) agentsWithPath += 1;
    }

    return {
      navMeshes: this.sectors.size,
      polygons,
      offMeshLinks,
      agents: agents.length,
      agentsWithPath,
      pathsComputed: this.pathsComputed,
      pathsFailed: this.pathsFailed,
      repathsSuppressed: this.repathsSuppressed,
      repathsDeferred: this.repathsDeferred,
    };
  }

  get navMeshCount(): number {
    return this.sectors.size;
  }

  // ---- Teardown ---------------------------------------------------------

  /**
   * Frees every navmesh and query this system owns.
   *
   * Idempotent, because both sector teardown and app shutdown can reach it,
   * and because `GameWorld.dispose` calls it too. Destroying a Detour navmesh
   * twice is not a no-op — it faults the WASM heap with an out-of-bounds
   * access — so the guard is load-bearing, not decoration.
   *
   * The Recast module itself is process-global and memoised, so it is left
   * alone: another `NavigationSystem` may still be using it.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const sector of this.sectors.values()) destroySector(sector);
    this.sectors.clear();
    this.activeSector = null;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new Error('[nav] NavigationSystem used after dispose()');
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toOffMeshConnectionParams(link: OffMeshLink): OffMeshConnectionParams {
  return {
    startPosition: copyVec3(link.start),
    endPosition: copyVec3(link.end),
    radius: link.radius,
    bidirectional: link.bidirectional,
    area: link.area ?? 0,
    flags: link.flags ?? 1,
  };
}

/**
 * Counts polygons and off-mesh links by walking the tile headers.
 *
 * Read from the finished navmesh rather than from Recast's intermediate
 * polygon mesh, so a built navmesh and an imported one report the same number.
 * The header count includes the synthetic polygon Detour creates per off-mesh
 * link, which is why both numbers come from the same pass.
 */
function countNavMeshPolys(navMesh: NavMesh): {
  polygonCount: number;
  offMeshLinkCount: number;
} {
  let polygonCount = 0;
  let offMeshLinkCount = 0;

  const maxTiles = navMesh.getMaxTiles();
  for (let i = 0; i < maxTiles; i += 1) {
    const header = navMesh.getTile(i)?.header();
    if (!header) continue;
    polygonCount += header.polyCount();
    offMeshLinkCount += header.offMeshConCount();
  }
  return { polygonCount, offMeshLinkCount };
}

/** Frees a sector's WASM allocations, query before navmesh. */
function destroySector(sector: SectorNav): void {
  // The query holds a pointer into the navmesh, so it goes first.
  sector.query.destroy();
  sector.navMesh.destroy();
}

/** Rotates yaw toward a target by at most `maxDelta`, taking the short way. */
function turnToward(
  transform: { yaw: number },
  targetYaw: number,
  maxDelta: number,
): void {
  const TAU = Math.PI * 2;
  let delta = (targetYaw - transform.yaw) % TAU;
  if (delta > Math.PI) delta -= TAU;
  if (delta < -Math.PI) delta += TAU;

  if (Math.abs(delta) <= maxDelta) {
    transform.yaw = targetYaw;
    return;
  }
  transform.yaw += Math.sign(delta) * maxDelta;
}
