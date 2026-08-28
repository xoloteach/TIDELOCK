/**
 * NavigationSystem integration tests.
 *
 * These run the real Recast/Detour WASM module. Nothing here is mocked, and
 * mocking it would be worse than having no tests: a fake Recast would assert
 * that our wrapper calls `generateSoloNavMesh`, not that a path exists, that it
 * goes around a wall rather than through it, or that an unreachable
 * destination is reported as unreachable instead of as a short path that ends
 * nowhere. Every geometric claim below is checked against the actual solver.
 *
 * Two library behaviours drive most of what is asserted here, both confirmed
 * empirically against recast-navigation 0.43.1:
 *
 * 1. Recast decides walkability from the normal of `cross(v1 - v0, v2 - v0)`,
 *    so a floor wound the wrong way rasterises to an empty navmesh. The
 *    geometry helpers below emit counter-clockwise-from-above floors on
 *    purpose, and one test builds a reversed one to prove the wrapper explains
 *    the failure.
 * 2. `NavMeshQuery.computePath` reports an unreachable destination as
 *    `success: true` with a corridor truncated at the edge of the reachable
 *    region. The wrapper turns that into an explicit failure, and the test
 *    asserts both halves: failure by default, opt-in partial path on request.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_PROFILE,
  NavigationSystem,
  type NavGeometry,
  type NavigationSystemOptions,
  type SectorId,
} from '@/engine/navigation/NavigationSystem';
import { GameWorld } from '@/engine/ecs/GameWorld';
import { createTransform, distance, vec3, type Entity, type NavAgent, type Vec3 } from '@/engine/ecs/components';

const HZ = 60;
const STEP = 1 / HZ;

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * An axis-aligned floor rectangle wound counter-clockwise seen from above, so
 * both triangle normals point at +Y and Recast treats it as walkable.
 *
 * Verified: with `v0 = (x0, y, z0)`, `v1 = (x1, y, z1)`, `v2 = (x1, y, z0)`,
 * the Y component of `cross(v1 - v0, v2 - v0)` is `dx * dz`, positive whenever
 * `x1 > x0` and `z1 > z0`. The helper normalises the corners so a caller
 * cannot accidentally produce a downward-facing floor.
 */
function floorRect(x0: number, z0: number, x1: number, z1: number, y = 0): number[] {
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minZ = Math.min(z0, z1);
  const maxZ = Math.max(z0, z1);
  return [
    minX, y, minZ, maxX, y, maxZ, maxX, y, minZ,
    minX, y, minZ, minX, y, maxZ, maxX, y, maxZ,
  ];
}

/**
 * A solid axis-aligned box, used for walls and obstacles.
 *
 * Winding only matters for the top face — vertical faces fail the slope test
 * whichever way they are wound — so only the top is guaranteed upward here.
 */
function box(
  min: [number, number, number],
  max: [number, number, number],
): number[] {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v: [number, number, number][] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
    [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces = [
    [4, 6, 5], [4, 7, 6], // top, upward
    [0, 1, 2], [0, 2, 3], // bottom
    [0, 5, 1], [0, 4, 5], // -Z
    [1, 6, 2], [1, 5, 6], // +X
    [2, 7, 3], [2, 6, 7], // +Z
    [3, 4, 0], [3, 7, 4], // -X
  ];
  const out: number[] = [];
  for (const face of faces) for (const i of face) out.push(...v[i]);
  return out;
}

/** Turns a de-indexed position soup into `NavGeometry`. */
function soup(...parts: number[][]): NavGeometry {
  const positions = parts.flat();
  const indices = Array.from({ length: positions.length / 3 }, (_, i) => i);
  return { positions, indices };
}

/** A flat 20 x 20 walkable slab centred on the origin. */
function openGround(): NavGeometry {
  return soup(floorRect(-10, -10, 10, 10));
}

/**
 * Open ground split by a 0.6 m thick, 3 m tall wall running along x = 0 from
 * z = -10 to z = 4, leaving a gap at the +Z end.
 */
function groundWithWall(): NavGeometry {
  return soup(floorRect(-10, -10, 10, 10), box([-0.3, 0, -10], [0.3, 3, 4]));
}

const WALL_GAP_Z = 4;

/** Two 8 x 8 slabs with a 12 m void between them. No walkable connection. */
function twoIslands(): NavGeometry {
  return soup(floorRect(-14, -4, -6, 4), floorRect(6, -4, 14, 4));
}

const ISLAND_A_CENTRE: Vec3 = { x: -10, y: 0, z: 0 };
const ISLAND_B_CENTRE: Vec3 = { x: 10, y: 0, z: 0 };
/** Just inside the inner edge of each island, where a link can be anchored. */
const ISLAND_A_EDGE: Vec3 = { x: -6.2, y: 0, z: 0 };
const ISLAND_B_EDGE: Vec3 = { x: 6.2, y: 0, z: 0 };

function pathLength(path: Vec3[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) total += distance(path[i - 1], path[i]);
  return total;
}

/**
 * True if any path segment crosses the wall plane at x = 0 inside the wall's
 * z extent. This is the assertion that matters: a path can be longer than the
 * straight line and still be wrong.
 */
function crossesWall(path: Vec3[]): boolean {
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1];
    const b = path[i];
    if (a.x < 0 === b.x < 0) continue;
    const t = (0 - a.x) / (b.x - a.x);
    const z = a.z + t * (b.z - a.z);
    if (z < WALL_GAP_Z) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Systems are disposed after every test so WASM allocations do not pile up. */
const openSystems: NavigationSystem[] = [];

async function makeSystem(
  options: Omit<NavigationSystemOptions, 'world'> & { world?: GameWorld } = {},
): Promise<{ nav: NavigationSystem; world: GameWorld }> {
  const world = options.world ?? new GameWorld();
  const nav = await NavigationSystem.create({ ...options, world });
  openSystems.push(nav);
  return { nav, world };
}

/** A system with one sector of open ground already loaded. */
async function makeGround(
  geometry: NavGeometry = openGround(),
  sectorId: SectorId = 'test-sector',
  options: Omit<NavigationSystemOptions, 'world'> = {},
): Promise<{ nav: NavigationSystem; world: GameWorld }> {
  const { nav, world } = await makeSystem(options);
  const built = nav.buildSector(sectorId, geometry);
  expect(built.error).toBeUndefined();
  expect(built.success).toBe(true);
  return { nav, world };
}

interface SpawnedAgent {
  entity: Entity;
  agent: NavAgent;
}

function spawnAgent(
  world: GameWorld,
  position: Vec3,
  overrides: Partial<NavAgent> = {},
): SpawnedAgent {
  const agent: NavAgent = {
    destination: null,
    path: [],
    pathIndex: 0,
    speed: 3,
    radius: DEFAULT_AGENT_PROFILE.radius,
    repathCooldown: 0,
    arrived: false,
    ...overrides,
  };
  const entity = world.spawn({
    transform: createTransform(position),
    velocity: { linear: vec3(), angular: 0 },
    navAgent: agent,
    debugName: 'test-agent',
  });
  return { entity, agent };
}

beforeAll(async () => {
  // Pay the WASM instantiation cost once and fail loudly here if the module
  // cannot load under vitest, rather than blaming the first assertion.
  const { nav } = await makeSystem();
  expect(nav.isDisposed).toBe(false);
}, 30_000);

afterEach(() => {
  for (const nav of openSystems.splice(0)) {
    if (!nav.isDisposed) nav.dispose();
  }
});

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

describe('initialisation', () => {
  it('loads the Recast WASM module and returns a live system', async () => {
    const { nav } = await makeSystem();
    expect(nav.isDisposed).toBe(false);
    expect(nav.name).toBe('navigation');
    expect(nav.navMeshCount).toBe(0);
    expect(nav.activeSectorId).toBeNull();
  });

  it('shares one memoised module across several systems', async () => {
    // If init were re-run per instance this would either fail or take an
    // order of magnitude longer than a single init.
    const first = await makeSystem();
    const started = performance.now();
    const second = await makeSystem();
    const elapsed = performance.now() - started;

    expect(first.nav.isDisposed).toBe(false);
    expect(second.nav.isDisposed).toBe(false);
    // A fresh Emscripten instantiation measured ~290 ms; a memoised one is a
    // resolved promise. 100 ms is a wide margin around that gap.
    expect(elapsed).toBeLessThan(100);

    // Both instances must be independently usable against the same module.
    expect(first.nav.buildSector('a', openGround()).success).toBe(true);
    expect(second.nav.buildSector('b', openGround()).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Navmesh construction
// ---------------------------------------------------------------------------

describe('navmesh construction', () => {
  it('builds a navmesh from a simple flat quad', async () => {
    const { nav } = await makeSystem();
    const result = nav.buildSector('flat', openGround());

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.sectorId).toBe('flat');
    expect(result.polygonCount).toBeGreaterThan(0);
    expect(result.offMeshLinkCount).toBe(0);
    expect(result.buildMs).toBeGreaterThan(0);

    expect(nav.hasSector('flat')).toBe(true);
    expect(nav.sectorIds).toEqual(['flat']);
    expect(nav.activeSectorId).toBe('flat');
    expect(nav.getSectorOrigin('flat')).toBe('built');
    expect(nav.getSectorPolygonCount('flat')).toBe(result.polygonCount);
  });

  it('explains a build that failed because the floor is wound the wrong way', async () => {
    const { nav } = await makeSystem();

    // Same quad, reversed winding, so both normals point at -Y.
    const flipped = openGround();
    const indices = [...flipped.indices as number[]];
    for (let t = 0; t < indices.length; t += 3) {
      const swap = indices[t + 1];
      indices[t + 1] = indices[t + 2];
      indices[t + 2] = swap;
    }

    const result = nav.buildSector('flipped', { positions: flipped.positions, indices });

    expect(result.success).toBe(false);
    expect(result.polygonCount).toBe(0);
    expect(result.error).toMatch(/winding/i);
    expect(result.error).toMatch(/upward/i);
    expect(nav.hasSector('flipped')).toBe(false);
  });

  it('rejects geometry with an index count that is not a multiple of three', async () => {
    const { nav } = await makeSystem();
    expect(() => nav.buildSector('bad', { positions: [0, 0, 0], indices: [0, 0] }))
      .toThrow(/not a multiple of 3/);
  });

  it('reports a build failure for geometry with no triangles', async () => {
    const { nav } = await makeSystem();
    const result = nav.buildSector('empty', { positions: [], indices: [] });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no triangles/);
  });

  it('keeps several sector navmeshes addressable by id', async () => {
    const { nav } = await makeSystem();

    // Two slabs, far apart, so a position in one is nowhere near the other.
    expect(nav.buildSector('depot', soup(floorRect(-10, -10, 10, 10))).success).toBe(true);
    expect(nav.buildSector('pump-12', soup(floorRect(90, -10, 110, 10))).success).toBe(true);

    expect(nav.sectorIds.sort()).toEqual(['depot', 'pump-12']);
    expect(nav.navMeshCount).toBe(2);
    // The first navmesh loaded becomes active; loading another must not steal it.
    expect(nav.activeSectorId).toBe('depot');

    const inDepot = nav.findPath({ x: -8, y: 0, z: -8 }, { x: 8, y: 0, z: 8 }, { sectorId: 'depot' });
    expect(inDepot.success).toBe(true);

    const inPump = nav.findPath({ x: 92, y: 0, z: -8 }, { x: 108, y: 0, z: 8 }, { sectorId: 'pump-12' });
    expect(inPump.success).toBe(true);

    // A depot position is not on the pump station's navmesh at all.
    const crossed = nav.findPath({ x: -8, y: 0, z: -8 }, { x: 8, y: 0, z: 8 }, { sectorId: 'pump-12' });
    expect(crossed.success).toBe(false);
    expect(crossed.failure).toBe('start-off-navmesh');

    expect(nav.setActiveSector('pump-12')).toBe(true);
    expect(nav.activeSectorId).toBe('pump-12');
    expect(nav.setActiveSector('nonexistent')).toBe(false);
    expect(nav.activeSectorId).toBe('pump-12');
  });

  it('replaces a sector navmesh on rebuild without leaving the old one reachable', async () => {
    const { nav } = await makeSystem();
    const first = nav.buildSector('depot', openGround());
    expect(first.success).toBe(true);

    // Rebuild the same id with a smaller slab. The old navmesh is freed inside
    // buildSector; if it were freed twice, or the query kept pointing at it,
    // the following query would fault the WASM heap.
    const second = nav.buildSector('depot', soup(floorRect(-3, -3, 3, 3)));
    expect(second.success).toBe(true);
    expect(nav.navMeshCount).toBe(1);

    // A point that was walkable on the big slab is off the small one.
    expect(nav.isOnNavMesh({ x: 8, y: 0, z: 8 })).toBe(false);
    expect(nav.isOnNavMesh({ x: 0, y: 0, z: 0 })).toBe(true);
  });

  it('frees a sector on unload and moves the active sector on', async () => {
    const { nav } = await makeSystem();
    nav.buildSector('depot', openGround());
    nav.buildSector('pump-12', soup(floorRect(90, -10, 110, 10)));

    expect(nav.unloadSector('depot')).toBe(true);
    expect(nav.hasSector('depot')).toBe(false);
    expect(nav.activeSectorId).toBe('pump-12');
    expect(nav.unloadSector('depot')).toBe(false);
    expect(nav.getSectorPolygonCount('depot')).toBeNull();

    expect(nav.unloadSector('pump-12')).toBe(true);
    expect(nav.activeSectorId).toBeNull();
    expect(nav.findPath({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }).failure).toBe('no-navmesh');
  });
});

// ---------------------------------------------------------------------------
// Baked artefacts
// ---------------------------------------------------------------------------

describe('serialisation', () => {
  it('round-trips a baked navmesh through a second system', async () => {
    const source = await makeSystem();
    const built = source.nav.buildSector('depot', openGround());
    expect(built.success).toBe(true);

    const bytes = source.nav.exportSector('depot');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes!.byteLength).toBeGreaterThan(0);

    // Load into a completely separate system, the way a shipped sector
    // artefact is loaded at runtime.
    const target = await makeSystem();
    const loaded = target.nav.loadSector('depot', bytes!);

    expect(loaded.success).toBe(true);
    expect(loaded.error).toBeUndefined();
    expect(loaded.polygonCount).toBe(built.polygonCount);
    expect(target.nav.getSectorOrigin('depot')).toBe('imported');

    // And it must actually be queryable, not merely present.
    const path = target.nav.findPath({ x: -8, y: 0, z: -8 }, { x: 8, y: 0, z: 8 });
    expect(path.success).toBe(true);
    expect(path.path.length).toBeGreaterThanOrEqual(2);
  });

  it('returns null when asked to export a sector that is not loaded', async () => {
    const { nav } = await makeSystem();
    expect(nav.exportSector('missing')).toBeNull();
  });

  it('reports a failure for an empty or unusable artefact instead of loading nothing', async () => {
    const { nav } = await makeSystem();

    const empty = nav.loadSector('depot', new Uint8Array(0));
    expect(empty.success).toBe(false);
    expect(empty.error).toMatch(/empty/);
    expect(nav.hasSector('depot')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pathfinding
// ---------------------------------------------------------------------------

describe('pathfinding', () => {
  it('finds a path across open ground with both endpoints on the mesh', async () => {
    const { nav } = await makeGround();
    const from = { x: -8, y: 0, z: -8 };
    const to = { x: 8, y: 0, z: 8 };

    const result = nav.findPath(from, to);

    expect(result.success).toBe(true);
    expect(result.failure).toBeUndefined();
    expect(result.partial).toBeUndefined();
    expect(result.path.length).toBeGreaterThanOrEqual(2);

    const start = result.path[0];
    const end = result.path[result.path.length - 1];

    // Endpoints must lie on the navmesh, not merely near the request.
    expect(nav.isOnNavMesh(start)).toBe(true);
    expect(nav.isOnNavMesh(end)).toBe(true);

    // And they must correspond to what was asked for. The navmesh floor sits a
    // voxel above y = 0 because spans quantise to cell height, so the
    // horizontal comparison is the meaningful one.
    expect(Math.hypot(start.x - from.x, start.z - from.z)).toBeLessThan(0.5);
    expect(Math.hypot(end.x - to.x, end.z - to.z)).toBeLessThan(0.5);
    expect(Math.abs(start.y)).toBeLessThan(0.5);
    expect(Math.abs(end.y)).toBeLessThan(0.5);

    // Open ground: the route should be essentially the straight line.
    const straight = distance(from, to);
    expect(pathLength(result.path)).toBeLessThan(straight * 1.1);

    expect(nav.getCounters().pathsComputed).toBe(1);
    expect(nav.getCounters().pathsFailed).toBe(0);
  });

  it('routes around an obstacle instead of through it', async () => {
    const { nav } = await makeGround(groundWithWall(), 'walled');

    const from = { x: -8, y: 0, z: -8 };
    const to = { x: 8, y: 0, z: -8 };
    const result = nav.findPath(from, to);

    expect(result.success).toBe(true);
    expect(result.path.length).toBeGreaterThan(2);

    const straight = distance(from, to);
    const routed = pathLength(result.path);

    // The only way through is round the +Z end of the wall, which is a long
    // detour: the straight line is 16 m, the detour is roughly 30 m.
    expect(routed).toBeGreaterThan(straight * 1.5);

    // Length alone is not enough — the route must not clip the wall.
    expect(crossesWall(result.path)).toBe(false);

    // Every waypoint must itself be walkable.
    for (const point of result.path) {
      expect(nav.isOnNavMesh(point)).toBe(true);
    }

    // And it must have gone round the correct end.
    const furthestZ = Math.max(...result.path.map((p) => p.z));
    expect(furthestZ).toBeGreaterThan(WALL_GAP_Z);
  });

  it('reports an unreachable destination as a failure rather than a truncated path', async () => {
    const { nav } = await makeGround(twoIslands(), 'islands');

    // Sanity: both endpoints are individually walkable, so this is genuinely a
    // connectivity failure and not a bad query.
    expect(nav.isOnNavMesh(ISLAND_A_CENTRE)).toBe(true);
    expect(nav.isOnNavMesh(ISLAND_B_CENTRE)).toBe(true);

    const result = nav.findPath(ISLAND_A_CENTRE, ISLAND_B_CENTRE);

    expect(result.success).toBe(false);
    expect(result.failure).toBe('unreachable');
    expect(result.path).toEqual([]);
    expect(result.detail).toMatch(/short of the destination/);
    expect(nav.getCounters().pathsFailed).toBe(1);
  });

  it('returns the truncated corridor only when a caller opts in', async () => {
    const { nav } = await makeGround(twoIslands(), 'islands');

    const result = nav.findPath(ISLAND_A_CENTRE, ISLAND_B_CENTRE, { allowPartial: true });

    expect(result.success).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.path.length).toBeGreaterThan(0);

    // It really is truncated: the corridor stays on island A.
    const end = result.path[result.path.length - 1];
    expect(end.x).toBeLessThan(0);
    expect(distance(end, ISLAND_B_CENTRE)).toBeGreaterThan(1);
  });

  it('reports which endpoint fell off the navmesh', async () => {
    const { nav } = await makeGround();

    const badStart = nav.findPath({ x: 400, y: 0, z: 400 }, { x: 0, y: 0, z: 0 });
    expect(badStart.success).toBe(false);
    expect(badStart.failure).toBe('start-off-navmesh');
    expect(badStart.path).toEqual([]);

    const badEnd = nav.findPath({ x: 0, y: 0, z: 0 }, { x: 400, y: 0, z: 400 });
    expect(badEnd.success).toBe(false);
    expect(badEnd.failure).toBe('end-off-navmesh');
    expect(badEnd.path).toEqual([]);

    // A failed snap costs no A* query.
    expect(nav.getCounters().pathsComputed).toBe(0);
  });

  it('reports no-navmesh when nothing is loaded', async () => {
    const { nav } = await makeSystem();
    const result = nav.findPath({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 1 });
    expect(result.success).toBe(false);
    expect(result.failure).toBe('no-navmesh');
    expect(nav.getCounters().pathsComputed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Nearest point
// ---------------------------------------------------------------------------

describe('nearest point', () => {
  it('snaps an off-mesh point onto the mesh', async () => {
    const { nav } = await makeGround();

    // 12 m along +X, two metres past the edge of a slab that ends at x = 10.
    const off = { x: 12, y: 0, z: 0 };
    expect(nav.isOnNavMesh(off)).toBe(false);

    const snapped = nav.nearestPoint(off, { searchHalfExtents: { x: 4, y: 4, z: 4 } });

    expect(snapped.found).toBe(true);
    expect(snapped.alreadyOnNavMesh).toBe(false);
    expect(nav.isOnNavMesh(snapped.point)).toBe(true);

    // It moved toward the mesh, not somewhere arbitrary.
    expect(snapped.point.x).toBeLessThan(off.x);
    expect(distance(snapped.point, off)).toBeLessThan(4);
    expect(Math.abs(snapped.point.z - off.z)).toBeLessThan(0.5);

    // And the snapped position is usable as a path endpoint.
    expect(nav.findPath(snapped.point, { x: 0, y: 0, z: 0 }).success).toBe(true);
  });

  it('snaps a point suspended above the mesh straight down', async () => {
    const { nav } = await makeGround();

    const above = { x: 3, y: 8, z: -3 };
    const snapped = nav.nearestPoint(above, { searchHalfExtents: { x: 2, y: 12, z: 2 } });

    expect(snapped.found).toBe(true);
    // Directly over a polygon, so the input was over the mesh even though it
    // was eight metres up.
    expect(snapped.alreadyOnNavMesh).toBe(true);
    expect(snapped.point.x).toBeCloseTo(above.x, 1);
    expect(snapped.point.z).toBeCloseTo(above.z, 1);
    expect(Math.abs(snapped.point.y)).toBeLessThan(0.5);
  });

  it('reports not-found rather than inventing a point', async () => {
    const { nav } = await makeGround();

    const far = { x: 500, y: 0, z: 500 };
    const result = nav.nearestPoint(far);

    expect(result.found).toBe(false);
    expect(result.alreadyOnNavMesh).toBe(false);
    // The input is echoed back unchanged, and it is a copy.
    expect(result.point).toEqual(far);
    expect(result.point).not.toBe(far);

    const noMesh = await makeSystem();
    expect(noMesh.nav.nearestPoint(far).found).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Off-mesh links
// ---------------------------------------------------------------------------

describe('off-mesh links', () => {
  it('connects two otherwise unreachable areas', async () => {
    const { nav } = await makeSystem();

    const built = nav.buildSector('islands', twoIslands(), {
      offMeshLinks: [{
        id: 'service-bridge',
        start: ISLAND_A_EDGE,
        end: ISLAND_B_EDGE,
        radius: 0.5,
        bidirectional: true,
      }],
    });

    expect(built.success).toBe(true);
    expect(built.offMeshLinkCount).toBe(1);

    const forward = nav.findPath(ISLAND_A_CENTRE, ISLAND_B_CENTRE);
    expect(forward.success).toBe(true);
    expect(forward.failure).toBeUndefined();

    // The route must actually traverse the link, i.e. cross the void.
    const crossings = forward.path.filter((p, i) =>
      i > 0 && (forward.path[i - 1].x < 0) !== (p.x < 0));
    expect(crossings.length).toBe(1);

    // Bidirectional, so the reverse must work too.
    expect(nav.findPath(ISLAND_B_CENTRE, ISLAND_A_CENTRE).success).toBe(true);

    expect(nav.getCounters().offMeshLinks).toBe(1);
  });

  it('bakes links into the exported artefact', async () => {
    const source = await makeSystem();
    source.nav.buildSector('islands', twoIslands(), {
      offMeshLinks: [{
        start: ISLAND_A_EDGE,
        end: ISLAND_B_EDGE,
        radius: 0.5,
        bidirectional: true,
      }],
    });
    const bytes = source.nav.exportSector('islands')!;

    const target = await makeSystem();
    const loaded = target.nav.loadSector('islands', bytes);

    expect(loaded.success).toBe(true);
    expect(loaded.offMeshLinkCount).toBe(1);
    // Connectivity survived the round trip, not just the link count.
    expect(target.nav.findPath(ISLAND_A_CENTRE, ISLAND_B_CENTRE).success).toBe(true);
  });

  it('respects a one-way link', async () => {
    const { nav } = await makeSystem();
    nav.buildSector('islands', twoIslands(), {
      offMeshLinks: [{
        start: ISLAND_A_EDGE,
        end: ISLAND_B_EDGE,
        radius: 0.5,
        bidirectional: false,
      }],
    });

    expect(nav.findPath(ISLAND_A_CENTRE, ISLAND_B_CENTRE).success).toBe(true);
    const back = nav.findPath(ISLAND_B_CENTRE, ISLAND_A_CENTRE);
    expect(back.success).toBe(false);
    expect(back.failure).toBe('unreachable');
  });
});

// ---------------------------------------------------------------------------
// Debug geometry
// ---------------------------------------------------------------------------

describe('debug geometry', () => {
  it('returns navmesh triangles without rendering anything', async () => {
    const { nav } = await makeGround();

    const debug = nav.getDebugGeometry();
    expect(debug).not.toBeNull();
    expect(debug!.positions).toBeInstanceOf(Float32Array);
    expect(debug!.indices).toBeInstanceOf(Uint32Array);
    expect(debug!.positions.length).toBeGreaterThan(0);
    expect(debug!.positions.length % 3).toBe(0);
    expect(debug!.indices.length % 3).toBe(0);
    expect(debug!.polygonCount).toBeGreaterThan(0);

    // Every vertex must sit inside the slab it was built from, so an overlay
    // drawn from this cannot silently be in the wrong place or wrong scale.
    for (let i = 0; i < debug!.positions.length; i += 3) {
      expect(Math.abs(debug!.positions[i])).toBeLessThanOrEqual(10.5);
      expect(Math.abs(debug!.positions[i + 2])).toBeLessThanOrEqual(10.5);
      expect(Math.abs(debug!.positions[i + 1])).toBeLessThanOrEqual(1);
    }

    // Indices must address real vertices.
    const vertexCount = debug!.positions.length / 3;
    for (const index of debug!.indices) {
      expect(index).toBeLessThan(vertexCount);
    }
  });

  it('returns null for a sector with no navmesh', async () => {
    const { nav } = await makeSystem();
    expect(nav.getDebugGeometry()).toBeNull();
    expect(nav.getDebugGeometry('nope')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

describe('agents', () => {
  it('advances along a path and reports arrival', async () => {
    const { nav, world } = await makeGround();
    const from = { x: -8, y: 0, z: -8 };
    const to = { x: 8, y: 0, z: 8 };
    const { entity, agent } = spawnAgent(world, from, { speed: 5 });

    expect(nav.setDestination(entity, to)).toBe(true);

    const travel = distance(from, to);
    // Generous ceiling: the trip takes about 4.5 s at 5 m/s.
    const maxSteps = Math.ceil((travel / 5) * HZ * 2);
    let steps = 0;
    while (!agent.arrived && steps < maxSteps) {
      nav.fixedUpdate(STEP);
      steps += 1;
    }

    expect(agent.arrived).toBe(true);
    expect(steps).toBeGreaterThan(travel / 5 * HZ * 0.5);

    const position = entity.transform!.position;
    expect(Math.hypot(position.x - to.x, position.z - to.z)).toBeLessThan(0.5);
    expect(agent.pathIndex).toBe(agent.path.length);

    // Following a path costs no further pathfinding: one A* for the whole trip.
    expect(nav.getCounters().pathsComputed).toBe(1);
  });

  it('moves at the agent speed and no faster', async () => {
    const { nav, world } = await makeGround();
    const { entity, agent } = spawnAgent(world, { x: -8, y: 0, z: 0 }, { speed: 2 });
    nav.setDestination(entity, { x: 8, y: 0, z: 0 });

    const position = entity.transform!.position;
    nav.fixedUpdate(STEP); // computes the path, then takes one step along it
    const afterFirst = { ...position };

    for (let i = 0; i < 30; i += 1) {
      const before = { ...position };
      nav.fixedUpdate(STEP);
      // Per-step displacement can never exceed speed * dt.
      expect(distance(before, position)).toBeLessThanOrEqual(2 * STEP + 1e-6);
    }

    // Half a second at 2 m/s is about a metre of progress toward +X.
    expect(position.x - afterFirst.x).toBeGreaterThan(0.8);
    expect(position.x - afterFirst.x).toBeLessThan(1.1);
    expect(agent.arrived).toBe(false);
  });

  it('writes velocity so animation can read ground speed', async () => {
    const { nav, world } = await makeGround();
    const { entity } = spawnAgent(world, { x: -8, y: 0, z: 0 }, { speed: 2 });
    nav.setDestination(entity, { x: 8, y: 0, z: 0 });

    nav.fixedUpdate(STEP);
    nav.fixedUpdate(STEP);

    const velocity = entity.velocity!.linear;
    expect(Math.hypot(velocity.x, velocity.z)).toBeCloseTo(2, 1);
    expect(velocity.x).toBeGreaterThan(0);
  });

  it('turns toward the direction of travel using the project yaw convention', async () => {
    const { nav, world } = await makeGround();
    // Heading toward +X. yaw 0 faces -Z and positive yaw rotates about +Y, so
    // the target yaw is atan2(-1, 0) = -pi/2.
    const { entity } = spawnAgent(world, { x: -8, y: 0, z: 0 }, { speed: 3 });
    nav.setDestination(entity, { x: 8, y: 0, z: 0 });

    for (let i = 0; i < 60; i += 1) nav.fixedUpdate(STEP);

    expect(entity.transform!.yaw).toBeCloseTo(-Math.PI / 2, 2);
  });

  it('holds still and reports no arrival when it has no destination', async () => {
    const { nav, world } = await makeGround();
    const { entity, agent } = spawnAgent(world, { x: 0, y: 0, z: 0 });

    for (let i = 0; i < 10; i += 1) nav.fixedUpdate(STEP);

    expect(agent.path).toEqual([]);
    expect(agent.arrived).toBe(false);
    expect(entity.transform!.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(nav.getCounters().pathsComputed).toBe(0);
  });

  it('drops the path when the destination is cleared', async () => {
    const { nav, world } = await makeGround();
    const { entity, agent } = spawnAgent(world, { x: -8, y: 0, z: 0 });
    nav.setDestination(entity, { x: 8, y: 0, z: 0 });
    nav.fixedUpdate(STEP);
    expect(agent.path.length).toBeGreaterThan(0);

    expect(nav.clearDestination(entity)).toBe(true);
    expect(agent.path).toEqual([]);
    expect(agent.pathIndex).toBe(0);
    expect(agent.destination).toBeNull();

    const stopped = { ...entity.transform!.position };
    for (let i = 0; i < 10; i += 1) nav.fixedUpdate(STEP);
    expect(entity.transform!.position).toEqual(stopped);
  });

  it('paths in the sector the entity belongs to', async () => {
    const { nav, world } = await makeSystem();
    nav.buildSector('depot', soup(floorRect(-10, -10, 10, 10)));
    nav.buildSector('pump-12', soup(floorRect(90, -10, 110, 10)));
    expect(nav.activeSectorId).toBe('depot');

    // The agent lives in pump-12, whose slab is 100 m away from the active
    // sector's. If it fell back to the active navmesh, no path would exist.
    const { entity, agent } = spawnAgent(world, { x: 92, y: 0, z: 0 }, { speed: 4 });
    entity.sector = { sectorId: 'pump-12' };
    nav.setDestination(entity, { x: 108, y: 0, z: 0 });

    nav.fixedUpdate(STEP);

    expect(agent.path.length).toBeGreaterThanOrEqual(2);
    expect(agent.path[0].x).toBeGreaterThan(89);
    expect(nav.getCounters().pathsFailed).toBe(0);
  });

  it('counts agents and paths for the diagnostics overlay', async () => {
    const { nav, world } = await makeGround();
    const a = spawnAgent(world, { x: -8, y: 0, z: -8 }, { speed: 3 });
    const b = spawnAgent(world, { x: -8, y: 0, z: 8 }, { speed: 3 });

    expect(nav.getCounters().agents).toBe(2);
    expect(nav.getCounters().agentsWithPath).toBe(0);

    nav.setDestination(a.entity, { x: 8, y: 0, z: -8 });
    nav.setDestination(b.entity, { x: 8, y: 0, z: 8 });
    nav.fixedUpdate(STEP);

    const counters = nav.getCounters();
    expect(counters.pathsComputed).toBe(2);
    expect(counters.agentsWithPath).toBe(2);
    expect(counters.navMeshes).toBe(1);
    expect(counters.polygons).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Repath throttling
// ---------------------------------------------------------------------------

describe('repath throttling', () => {
  const REPATH_INTERVAL = 0.5;

  it('suppresses recomputation inside the cooldown window', async () => {
    const { nav, world } = await makeGround(openGround(), 'test-sector', {
      repathInterval: REPATH_INTERVAL,
    });
    // Speed 0 so the agent cannot reach anything and change the outcome by
    // arriving; this test is only about how often A* runs.
    const { entity, agent } = spawnAgent(world, { x: -8, y: 0, z: -8 }, { speed: 0 });

    nav.setDestination(entity, { x: 8, y: 0, z: 8 });
    nav.fixedUpdate(STEP);
    expect(nav.getCounters().pathsComputed).toBe(1);
    expect(agent.repathCooldown).toBeCloseTo(REPATH_INTERVAL, 5);

    // Move the destination a long way. The agent wants a new path immediately.
    nav.setDestination(entity, { x: 8, y: 0, z: -8 });

    // 25 steps is 0.4166 s, comfortably inside the 0.5 s window.
    for (let i = 0; i < 25; i += 1) nav.fixedUpdate(STEP);
    expect(nav.getCounters().pathsComputed).toBe(1);
    expect(nav.getCounters().repathsSuppressed).toBe(25);

    // Now let the window expire.
    let extra = 0;
    while (nav.getCounters().pathsComputed === 1 && extra < 20) {
      nav.fixedUpdate(STEP);
      extra += 1;
    }
    expect(nav.getCounters().pathsComputed).toBe(2);
    // Total elapsed must be at least the interval, not merely "eventually".
    expect((25 + extra) * STEP).toBeGreaterThanOrEqual(REPATH_INTERVAL - STEP);
  });

  it('does not repath while the destination stays put', async () => {
    const { nav, world } = await makeGround(openGround(), 'test-sector', {
      repathInterval: REPATH_INTERVAL,
    });
    const { entity } = spawnAgent(world, { x: -8, y: 0, z: -8 }, { speed: 1 });
    nav.setDestination(entity, { x: 8, y: 0, z: 8 });

    // Three seconds — six cooldown windows.
    for (let i = 0; i < HZ * 3; i += 1) nav.fixedUpdate(STEP);

    expect(nav.getCounters().pathsComputed).toBe(1);
    expect(nav.getCounters().repathsSuppressed).toBe(0);
  });

  it('ignores destination jitter below the epsilon', async () => {
    const { nav, world } = await makeGround(openGround(), 'test-sector', {
      repathInterval: REPATH_INTERVAL,
      destinationEpsilon: 0.5,
    });
    const { entity } = spawnAgent(world, { x: -8, y: 0, z: -8 }, { speed: 0 });
    nav.setDestination(entity, { x: 8, y: 0, z: 8 });
    nav.fixedUpdate(STEP);
    expect(nav.getCounters().pathsComputed).toBe(1);

    // Nudge the destination by 10 cm every step for two seconds. Each nudge is
    // well inside the epsilon, so none of them should trigger A*.
    for (let i = 0; i < HZ * 2; i += 1) {
      nav.setDestination(entity, { x: 8 + (i % 2) * 0.1, y: 0, z: 8 });
      nav.fixedUpdate(STEP);
    }
    expect(nav.getCounters().pathsComputed).toBe(1);
  });

  it('repaths immediately when asked to', async () => {
    const { nav, world } = await makeGround(openGround(), 'test-sector', {
      repathInterval: REPATH_INTERVAL,
    });
    const { entity } = spawnAgent(world, { x: -8, y: 0, z: -8 }, { speed: 0 });

    nav.setDestination(entity, { x: 8, y: 0, z: 8 });
    nav.fixedUpdate(STEP);
    expect(nav.getCounters().pathsComputed).toBe(1);

    nav.setDestination(entity, { x: 8, y: 0, z: -8 }, { immediate: true });
    nav.fixedUpdate(STEP);
    expect(nav.getCounters().pathsComputed).toBe(2);
    expect(nav.getCounters().repathsSuppressed).toBe(0);
  });

  it('backs off instead of retrying a hopeless destination every window', async () => {
    const { nav, world } = await makeGround(twoIslands(), 'islands', {
      repathInterval: REPATH_INTERVAL,
    });
    const { entity, agent } = spawnAgent(world, ISLAND_A_CENTRE, { speed: 0 });
    nav.setDestination(entity, ISLAND_B_CENTRE);

    // Five seconds. Without backoff this would be ten A* queries.
    for (let i = 0; i < HZ * 5; i += 1) nav.fixedUpdate(STEP);

    const counters = nav.getCounters();
    expect(counters.pathsFailed).toBe(counters.pathsComputed);
    expect(counters.pathsComputed).toBeGreaterThan(1);
    expect(counters.pathsComputed).toBeLessThan(6);
    expect(agent.path).toEqual([]);
    expect(agent.arrived).toBe(false);
  });

  it('defers repaths past the per-step budget instead of running them all at once', async () => {
    const { nav, world } = await makeGround(openGround(), 'test-sector', {
      repathInterval: REPATH_INTERVAL,
      maxPathsPerStep: 2,
    });

    const agents = Array.from({ length: 5 }, (_, i) =>
      spawnAgent(world, { x: -8, y: 0, z: -8 + i * 2 }, { speed: 0 }));
    for (const { entity } of agents) {
      nav.setDestination(entity, { x: 8, y: 0, z: 8 });
    }

    nav.fixedUpdate(STEP);
    expect(nav.getCounters().pathsComputed).toBe(2);
    expect(nav.getCounters().repathsDeferred).toBe(3);

    // Deferred agents keep their expired cooldown, so they are served on the
    // next steps rather than waiting another full interval.
    nav.fixedUpdate(STEP);
    expect(nav.getCounters().pathsComputed).toBe(4);
    nav.fixedUpdate(STEP);
    expect(nav.getCounters().pathsComputed).toBe(5);

    for (const { agent } of agents) {
      expect(agent.path.length).toBeGreaterThan(0);
    }
  });

  it('repaths when the sector navmesh is rebuilt underneath an agent', async () => {
    const { nav, world } = await makeGround(openGround(), 'depot', {
      repathInterval: REPATH_INTERVAL,
    });
    const { entity } = spawnAgent(world, { x: -8, y: 0, z: -8 }, { speed: 0 });
    nav.setDestination(entity, { x: 8, y: 0, z: 8 });
    nav.fixedUpdate(STEP);
    expect(nav.getCounters().pathsComputed).toBe(1);

    // Rebuild with a wall in the way. The old waypoints are now wrong, so the
    // agent must re-query once its cooldown expires rather than walking them.
    expect(nav.buildSector('depot', groundWithWall()).success).toBe(true);

    for (let i = 0; i < HZ; i += 1) nav.fixedUpdate(STEP);
    expect(nav.getCounters().pathsComputed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

describe('dispose', () => {
  it('is idempotent', async () => {
    const { nav } = await makeSystem();
    nav.buildSector('depot', openGround());
    nav.buildSector('pump-12', soup(floorRect(90, -10, 110, 10)));

    nav.dispose();
    expect(nav.isDisposed).toBe(true);

    // Destroying a Detour navmesh twice faults the WASM heap with an
    // out-of-bounds access, so this is a real crash test, not a formality.
    expect(() => nav.dispose()).not.toThrow();
    expect(() => nav.dispose()).not.toThrow();
    expect(nav.isDisposed).toBe(true);
    expect(nav.navMeshCount).toBe(0);
    expect(nav.activeSectorId).toBeNull();
  });

  it('is idempotent after sectors were already unloaded', async () => {
    const { nav } = await makeSystem();
    nav.buildSector('depot', openGround());
    expect(nav.unloadSector('depot')).toBe(true);

    expect(() => nav.dispose()).not.toThrow();
    expect(() => nav.dispose()).not.toThrow();
  });

  it('throws rather than reading freed WASM memory', async () => {
    const { nav, world } = await makeGround();
    spawnAgent(world, { x: 0, y: 0, z: 0 });
    nav.dispose();

    expect(() => nav.findPath({ x: -8, y: 0, z: -8 }, { x: 8, y: 0, z: 8 }))
      .toThrow(/after dispose/);
    expect(() => nav.nearestPoint({ x: 0, y: 0, z: 0 })).toThrow(/after dispose/);
    expect(() => nav.getDebugGeometry()).toThrow(/after dispose/);
    expect(() => nav.buildSector('x', openGround())).toThrow(/after dispose/);
    expect(() => nav.exportSector('depot')).toThrow(/after dispose/);
    expect(() => nav.fixedUpdate(STEP)).toThrow(/after dispose/);
  });

  it('still reports counters after disposal', async () => {
    const { nav, world } = await makeGround();
    spawnAgent(world, { x: 0, y: 0, z: 0 });
    nav.dispose();

    const counters = nav.getCounters();
    expect(counters.navMeshes).toBe(0);
    expect(counters.polygons).toBe(0);
    expect(counters.agents).toBe(0);
  });
});
