/**
 * Sector streaming (spec §9.2, §59).
 *
 * Decides which sectors are resident, loads them through an injected port, and
 * tears them down without ever losing progress.
 *
 * ## The load/unload asymmetry
 *
 * Loading is decided by **topology**: the current sector, its neighbours, and
 * one extra hop through a `transition` sector so the far side of a short bridge
 * exists before the player steps onto it. Distance never *loads* anything —
 * on `cinematic` the draw distance is 600 m, which would drag most of the
 * borough into memory the moment the player looks down a street.
 *
 * Unloading is decided by **distance**, against the active preset's
 * `drawDistance` widened by a hysteresis factor. A sector that has dropped out
 * of the topology set lingers while it is still close enough to be visible, so
 * walking back and forth across a sector seam cannot thrash the loader. Two
 * different boundaries in two different units is the whole point: the load
 * boundary (adjacency) sits well inside the unload boundary (distance), so no
 * single step of the player can cross both.
 *
 * ## Gameplay state is not scene state
 *
 * This is the rule the spec is emphatic about and the one that is easiest to
 * break silently. Three mechanisms enforce it:
 *
 *  1. Entities tagged `isPersistentAcrossSectors` — the player — are never
 *     despawned. `GameWorld.despawnSector` excludes them structurally.
 *  2. Every `persistent` component in a sector is captured *before* despawn and
 *     restored onto the freshly loaded entity by its authored id. A valve left
 *     open two districts ago is still open.
 *  3. Nothing else in the system holds gameplay state. Missions, flags and
 *     dialogue live elsewhere and are never touched by a load or an unload.
 *
 * ## Failure and cancellation
 *
 * Both are real bugs when they are handled carelessly, so both are explicit:
 *
 *  - A failed load records no entities, no bodies and no bytes, reports itself,
 *    and backs off before retrying instead of hammering a flaky connection.
 *  - A sector unloaded while its load is in flight has its signal aborted and
 *    its eventual result **discarded** — the payload is released and any
 *    colliders the loader already created are removed. Inserting those entities
 *    would leave props from a sector nobody is standing in, attached to nothing.
 *
 * Nothing here imports Three, the renderer or Rapier. Assets arrive through
 * `SectorAssetLoaderPort`; colliders are released through `SectorPhysicsPort`
 * as opaque handles.
 */

import type { System, GameWorld } from '../../engine/ecs/GameWorld';
import type { Entity, Vec3 } from '../../engine/ecs/components';
import type { BodyHandle } from '../../engine/physics/PhysicsWorld';
import { Emitter } from '../../engine/events';
import { getPreset } from '../../graphics/quality/presets';
import {
  boundsContain,
  boundsDistance,
  buildSectorIndex,
  scaleLodDistances,
  type SectorDefinition,
  type SectorId,
} from './sectorSchema';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Seconds between residency evaluations.
 *
 * An evaluation walks the sector list measuring distances — cheap, but pointless
 * at 60 Hz: a sprinting player covers about 10 cm per frame and sector bounds
 * are tens of metres across. Quarter-second granularity is 15 cm of travel at
 * walking pace, far below the hysteresis band.
 */
export const STREAMING_EVALUATION_INTERVAL_S = 0.25;

/**
 * Multiplier from `drawDistance` to the eviction radius.
 *
 * The gap between "still relevant" and "evict" is what stops a sector at the
 * boundary loading and unloading repeatedly. 1.25 gives 55 m of slack at
 * medium's 220 m draw distance.
 */
export const STREAMING_UNLOAD_HYSTERESIS = 1.25;

/**
 * Concurrent sector loads.
 *
 * More would finish a district sooner on a desktop and starve the current
 * sector's own assets on a phone. The queue is priority-ordered, so the sector
 * the player is standing in always goes first.
 */
export const STREAMING_MAX_CONCURRENT_LOADS = 3;

/** Seconds before a failed load is retried, multiplied by the attempt count. */
export const STREAMING_RETRY_DELAY_S = 3;

/**
 * Metres a rival sector must beat the current one by before it becomes current,
 * while the player stands outside every sector's bounds (a service bridge gap,
 * a flooded street). Without it, walking the seam would flip the current sector
 * every evaluation.
 */
export const STREAMING_SECTOR_SWITCH_MARGIN_M = 2;

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * The result of loading one sector.
 *
 * Opaque to this system: it stamps ownership on the entities, remembers the
 * body handles so it can release them, and counts the bytes for diagnostics.
 */
export interface SectorPayload {
  /**
   * Entities to insert. Their `sector` component is stamped by the system, so
   * the loader cannot accidentally attribute a prop to the wrong sector.
   */
  entities: Entity[];
  /** Static collider handles created for this sector. */
  bodies: BodyHandle[];
  /** Resident bytes. Falls back to the sector's authored estimate when 0. */
  bytes: number;
  /** Released on unload, and on a discarded load, after entities and bodies. */
  release?: () => void;
}

export interface SectorAssetLoaderPort {
  /**
   * Fetches and instantiates everything a sector owns.
   *
   * `signal` is aborted when the sector is unloaded mid-load. Honouring it is
   * an optimisation, not a correctness requirement: the system discards the
   * result either way. A loader that rejects *must* release whatever it had
   * already created — the system has no handle on partial work.
   */
  load(sector: SectorDefinition, signal: AbortSignal): Promise<SectorPayload>;
}

/** The one thing streaming needs from physics. Deliberately not the world. */
export interface SectorPhysicsPort {
  removeBody(handle: BodyHandle): boolean;
}

/**
 * The slice of the effective quality that streaming reads.
 *
 * `EffectiveQuality` satisfies this structurally, so wiring is one line in the
 * quality system's `changed` handler and no import of `QualitySystem` is needed.
 */
export interface StreamingQualityPort {
  readonly drawDistance: number;
  readonly lodMultiplier: number;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type SectorUnloadReason =
  /** Beyond the eviction radius. */
  | 'distance'
  /** The resident memory budget was exceeded. */
  | 'memory'
  /** An explicit `requestUnload`. */
  | 'requested'
  /** `unloadAll`, a save being loaded, or teardown. */
  | 'reset';

/**
 * Declared as a type alias so TypeScript infers the implicit index signature
 * `EventMap` requires.
 */
export type StreamingEvents = {
  'sector-load-started': { sectorId: SectorId; attempt: number };
  'sector-load-finished': {
    sectorId: SectorId;
    entities: number;
    bodies: number;
    bytes: number;
  };
  'sector-load-failed': { sectorId: SectorId; error: Error; attempt: number };
  'sector-unloaded': {
    sectorId: SectorId;
    reason: SectorUnloadReason;
    /** Entities despawned. 0 when the load had not finished. */
    entities: number;
    /** True when the load was still in flight and its result was discarded. */
    wasLoading: boolean;
  };
  'current-sector-changed': { from: SectorId | null; to: SectorId };
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type SectorState = 'unloaded' | 'loading' | 'loaded' | 'failed';

interface SectorRecord {
  readonly def: SectorDefinition;
  /** Registry position, for deterministic tie-breaks. */
  readonly order: number;
  state: SectorState;
  controller: AbortController | null;
  entities: Entity[];
  bodies: BodyHandle[];
  bytes: number;
  release: (() => void) | null;
  failures: number;
  /** Sim clock before which a failed sector is not retried. */
  retryAfter: number;
  pinned: boolean;
  /**
   * Bumped on every load start and every unload.
   *
   * A promise that settles after its sector was unloaded — or unloaded and
   * loaded again — carries a stale generation and is discarded. Comparing state
   * alone would not survive an unload/reload pair inside one load's lifetime.
   */
  generation: number;
}

export interface StreamingPersistedState {
  readonly currentSectorId: SectorId | null;
  readonly pinnedSectorIds: readonly SectorId[];
  /** Persistent entity state by authored id, across loaded and unloaded sectors. */
  readonly persistentState: Readonly<Record<string, Record<string, unknown>>>;
}

export interface StreamingDiagnostics {
  currentSectorId: SectorId | null;
  loaded: number;
  loading: number;
  failed: number;
  pinned: number;
  bytes: number;
  entities: number;
  bodies: number;
  drawDistance: number;
  unloadRadius: number;
  /** Loads whose sector was unloaded before they finished. */
  discardedLoads: number;
  /** Sectors evicted for the memory budget rather than distance. */
  memoryEvictions: number;
}

export interface StreamingSystemOptions {
  world: GameWorld;
  sectors: readonly SectorDefinition[];
  loader: SectorAssetLoaderPort;
  /** Omit in tests that do not care about colliders. */
  physics?: SectorPhysicsPort | null;
  /** Defaults to the `medium` preset's draw distance and LOD multiplier. */
  quality?: StreamingQualityPort;
  /** Current sector before the player has a position — New Game, checkpoint. */
  entrySectorId?: SectorId;
  evaluationInterval?: number;
  unloadHysteresis?: number;
  maxConcurrentLoads?: number;
  /** 0 (the default) disables memory-driven eviction. */
  memoryBudgetBytes?: number;
  retryDelaySeconds?: number;
  /** Expand residency one hop through transition sectors. Default true. */
  expandThroughTransitions?: boolean;
}

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

/**
 * The sectors that must be resident for a given current sector.
 *
 * Current, its neighbours, and — when `expandThroughTransitions` is set — the
 * neighbours of any adjacent transition sector. That last hop is what makes a
 * bridge crossing seamless: the sector on the far side is already loaded while
 * the player is still on the near bank.
 *
 * Exported because it is the whole residency policy and deserves to be tested
 * without a world, a loader or a clock.
 */
export function residentSectorIds(
  index: ReadonlyMap<SectorId, SectorDefinition>,
  currentId: SectorId | null,
  expandThroughTransitions = true,
): Set<SectorId> {
  const resident = new Set<SectorId>();
  if (currentId === null) return resident;

  const current = index.get(currentId);
  if (!current) return resident;

  resident.add(currentId);

  for (const neighbourId of current.neighbours) {
    const neighbour = index.get(neighbourId);
    if (!neighbour) continue;
    resident.add(neighbourId);

    if (!expandThroughTransitions || neighbour.kind !== 'transition') continue;
    for (const farId of neighbour.neighbours) {
      if (index.has(farId)) resident.add(farId);
    }
  }

  return resident;
}

// ---------------------------------------------------------------------------
// StreamingSystem
// ---------------------------------------------------------------------------

export class StreamingSystem implements System {
  readonly name = 'streaming';

  private readonly emitter = new Emitter<StreamingEvents>();
  private readonly world: GameWorld;
  private readonly loader: SectorAssetLoaderPort;
  private readonly physics: SectorPhysicsPort | null;
  private readonly index: Map<SectorId, SectorDefinition>;
  private readonly records = new Map<SectorId, SectorRecord>();

  private readonly evaluationInterval: number;
  private readonly unloadHysteresis: number;
  private readonly maxConcurrentLoads: number;
  private readonly memoryBudgetBytes: number;
  private readonly retryDelaySeconds: number;
  private readonly expandThroughTransitions: boolean;

  private quality: StreamingQualityPort;

  /**
   * Persistent component state for entities that are not currently loaded.
   *
   * The single reason an unload cannot lose progress. Keyed by the authored
   * `Persistent.id`, never by an entity reference.
   */
  private readonly persistentState = new Map<string, Record<string, unknown>>();

  private currentId: SectorId | null;
  private clock = 0;
  private sinceEvaluation = 0;
  private inFlight = 0;
  private discarded = 0;
  private memoryEvictions = 0;
  private evaluating = false;
  private evaluateAgain = false;
  private disposed = false;
  /** Suppresses repeat budget warnings while one over-budget episode lasts. */
  private memoryWarningIssued = false;
  private settleWaiters: (() => void)[] = [];

  constructor(options: StreamingSystemOptions) {
    this.world = options.world;
    this.loader = options.loader;
    this.physics = options.physics ?? null;
    // Throws on duplicate ids: two sectors with one id makes every lookup here
    // arbitrary, and that is not something to discover from a bug report.
    this.index = buildSectorIndex(options.sectors);

    const medium = getPreset('medium');
    this.quality = options.quality ?? {
      drawDistance: medium.drawDistance,
      lodMultiplier: medium.lodMultiplier,
    };

    this.evaluationInterval = options.evaluationInterval ?? STREAMING_EVALUATION_INTERVAL_S;
    this.unloadHysteresis = options.unloadHysteresis ?? STREAMING_UNLOAD_HYSTERESIS;
    this.maxConcurrentLoads = options.maxConcurrentLoads ?? STREAMING_MAX_CONCURRENT_LOADS;
    this.memoryBudgetBytes = options.memoryBudgetBytes ?? 0;
    this.retryDelaySeconds = options.retryDelaySeconds ?? STREAMING_RETRY_DELAY_S;
    this.expandThroughTransitions = options.expandThroughTransitions ?? true;

    let order = 0;
    for (const def of this.index.values()) {
      this.records.set(def.id, {
        def,
        order: order++,
        state: 'unloaded',
        controller: null,
        entities: [],
        bodies: [],
        bytes: 0,
        release: null,
        failures: 0,
        retryAfter: 0,
        pinned: false,
        generation: 0,
      });

      // An unknown neighbour is a content error, reported by
      // `validateSectorGraph`. Streaming skips it rather than throwing, so a
      // typo in one sector cannot make the whole campaign unbootable.
      for (const neighbourId of def.neighbours) {
        if (!this.index.has(neighbourId)) {
          console.warn(
            `[streaming] sector "${def.id}" lists unknown neighbour "${neighbourId}"`,
          );
        }
      }
    }

    this.currentId =
      options.entrySectorId !== undefined && this.index.has(options.entrySectorId)
        ? options.entrySectorId
        : null;
  }

  on = this.emitter.on.bind(this.emitter);
  off = this.emitter.off.bind(this.emitter);

  // ---- Read-only state --------------------------------------------------

  get currentSectorId(): SectorId | null {
    return this.currentId;
  }

  get sectorIds(): SectorId[] {
    return [...this.index.keys()];
  }

  getSector(id: SectorId): SectorDefinition | undefined {
    return this.index.get(id);
  }

  stateOf(id: SectorId): SectorState {
    return this.records.get(id)?.state ?? 'unloaded';
  }

  isLoaded(id: SectorId): boolean {
    return this.stateOf(id) === 'loaded';
  }

  get loadedSectorIds(): SectorId[] {
    return this.recordsWhere((record) => record.state === 'loaded').map((r) => r.def.id);
  }

  get loadingSectorIds(): SectorId[] {
    return this.recordsWhere((record) => record.state === 'loading').map((r) => r.def.id);
  }

  get loadedSectorCount(): number {
    return this.recordsWhere((record) => record.state === 'loaded').length;
  }

  /** Estimated resident bytes across loaded sectors. */
  get estimatedBytes(): number {
    let total = 0;
    for (const record of this.records.values()) {
      if (record.state === 'loaded') total += record.bytes;
    }
    return total;
  }

  get inFlightCount(): number {
    return this.inFlight;
  }

  get pinnedSectorIds(): SectorId[] {
    return this.recordsWhere((record) => record.pinned).map((r) => r.def.id);
  }

  isPinned(id: SectorId): boolean {
    const record = this.records.get(id);
    return record !== undefined && (record.pinned || record.def.alwaysResident);
  }

  /** Simulation seconds elapsed. */
  get elapsed(): number {
    return this.clock;
  }

  get drawDistance(): number {
    return this.quality.drawDistance;
  }

  /** Metres beyond which a sector outside the topology set is evicted. */
  get unloadRadius(): number {
    return this.quality.drawDistance * this.unloadHysteresis;
  }

  /** Authored LOD distances scaled by the active preset. */
  effectiveLodDistances(id: SectorId): number[] | null {
    const def = this.index.get(id);
    return def ? scaleLodDistances(def.lod, this.quality.lodMultiplier) : null;
  }

  getDiagnostics(): StreamingDiagnostics {
    let loaded = 0;
    let loading = 0;
    let failed = 0;
    let pinned = 0;
    let bytes = 0;
    let entities = 0;
    let bodies = 0;

    for (const record of this.records.values()) {
      if (record.state === 'loaded') {
        loaded += 1;
        bytes += record.bytes;
        entities += record.entities.length;
        bodies += record.bodies.length;
      } else if (record.state === 'loading') {
        loading += 1;
      } else if (record.state === 'failed') {
        failed += 1;
      }
      if (record.pinned || record.def.alwaysResident) pinned += 1;
    }

    return {
      currentSectorId: this.currentId,
      loaded,
      loading,
      failed,
      pinned,
      bytes,
      entities,
      bodies,
      drawDistance: this.quality.drawDistance,
      unloadRadius: this.unloadRadius,
      discardedLoads: this.discarded,
      memoryEvictions: this.memoryEvictions,
    };
  }

  // ---- Configuration ----------------------------------------------------

  /** Wire this to the quality system's `changed` event. */
  setQuality(quality: StreamingQualityPort): void {
    this.quality = quality;
    // The eviction radius just moved; act on it now rather than up to a
    // quarter-second later.
    this.evaluate();
  }

  /**
   * Forces a sector resident for a story beat — an archive the player must be
   * able to return to, a relay whose machines must keep running off-screen.
   *
   * Pinning loads the sector if it is not already; unpinning lets the ordinary
   * distance rule apply again.
   */
  pin(id: SectorId): void {
    const record = this.records.get(id);
    if (!record) {
      // A story beat pinning a sector that does not exist is a content bug that
      // would otherwise present as "the archive was empty when I went back".
      console.warn(`[streaming] cannot pin unknown sector "${id}"`);
      return;
    }
    if (record.pinned) return;
    record.pinned = true;
    this.evaluate();
  }

  unpin(id: SectorId): void {
    const record = this.records.get(id);
    if (!record || !record.pinned) return;
    record.pinned = false;
    this.evaluate();
  }

  // ---- Simulation -------------------------------------------------------

  fixedUpdate(dt: number): void {
    if (this.disposed) return;
    this.clock += dt;
    this.sinceEvaluation += dt;
    if (this.sinceEvaluation < this.evaluationInterval) return;
    this.sinceEvaluation = 0;
    this.evaluate();
  }

  /**
   * Recomputes residency now.
   *
   * Re-entrant calls (a listener that pins a sector, a load completing inside
   * an evaluation) are folded into one more pass rather than recursing.
   */
  evaluate(): void {
    if (this.disposed) return;
    if (this.evaluating) {
      this.evaluateAgain = true;
      return;
    }

    this.evaluating = true;
    try {
      do {
        this.evaluateAgain = false;
        this.evaluateOnce();
      } while (this.evaluateAgain);
    } finally {
      this.evaluating = false;
    }
  }

  private evaluateOnce(): void {
    const focus = this.focusPosition();
    if (focus) this.updateCurrentSector(focus);

    const wanted = this.wantedSectorIds();

    this.startLoads(wanted, focus);
    this.evictByDistance(wanted, focus);
    this.evictByMemory(wanted, focus);
  }

  /** The player's position, or null while there is no player (menus, boot). */
  private focusPosition(): Vec3 | null {
    const player = this.world.player;
    return player?.transform?.position ?? null;
  }

  /**
   * Picks the current sector, with hysteresis in two places.
   *
   * Staying inside the current sector's bounds always wins, so the seam volume
   * neighbouring sectors share does not flip the answer. Outside every sector
   * — the gap on a service bridge, a flooded street — a rival must be
   * meaningfully closer before it takes over.
   */
  private updateCurrentSector(focus: Vec3): void {
    const current = this.currentId ? this.index.get(this.currentId) : undefined;
    if (current && boundsContain(current.bounds, focus)) return;

    let next: SectorDefinition | undefined;

    const containing = [...this.index.values()].filter((def) =>
      boundsContain(def.bounds, focus),
    );
    if (containing.length > 0) {
      // Prefer a neighbour of the sector we were in: crossing a seam should
      // land in the sector we were walking towards, not in registry order.
      next = containing.find((def) => current?.neighbours.includes(def.id)) ?? containing[0];
    } else {
      let nearest: SectorDefinition | undefined;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (const def of this.index.values()) {
        const distance = boundsDistance(def.bounds, focus);
        if (distance >= nearestDistance) continue;
        nearest = def;
        nearestDistance = distance;
      }
      if (!nearest) return;

      if (!current) {
        next = nearest;
      } else {
        const currentDistance = boundsDistance(current.bounds, focus);
        next =
          nearestDistance + STREAMING_SECTOR_SWITCH_MARGIN_M < currentDistance
            ? nearest
            : current;
      }
    }

    if (!next || next.id === this.currentId) return;

    const from = this.currentId;
    this.currentId = next.id;

    // Keep the player's own sector attribution truthful: the tutorial system
    // and the save both read it. Only updated, never added — whether the player
    // is a sector member is the player controller's decision, not streaming's.
    const player = this.world.player;
    if (player?.sector) player.sector.sectorId = next.id;

    this.emitter.emit('current-sector-changed', { from, to: next.id });
  }

  /** Topology set plus every pinned or author-resident sector. */
  private wantedSectorIds(): Set<SectorId> {
    const wanted = residentSectorIds(
      this.index,
      this.currentId,
      this.expandThroughTransitions,
    );
    for (const record of this.records.values()) {
      if (record.pinned || record.def.alwaysResident) wanted.add(record.def.id);
    }
    return wanted;
  }

  // ---- Loading ----------------------------------------------------------

  private startLoads(wanted: ReadonlySet<SectorId>, focus: Vec3 | null): void {
    let budget = this.maxConcurrentLoads - this.inFlight;
    if (budget <= 0) return;

    const candidates: SectorRecord[] = [];
    for (const id of wanted) {
      const record = this.records.get(id);
      if (!record) continue;
      if (record.state === 'loading' || record.state === 'loaded') continue;
      // Back off after a failure instead of retrying every evaluation.
      if (record.state === 'failed' && this.clock < record.retryAfter) continue;
      candidates.push(record);
    }
    if (candidates.length === 0) return;

    candidates.sort((a, b) => {
      // The sector the player is standing in is never made to wait.
      const aCurrent = a.def.id === this.currentId ? 0 : 1;
      const bCurrent = b.def.id === this.currentId ? 0 : 1;
      if (aCurrent !== bCurrent) return aCurrent - bCurrent;
      if (focus) {
        const delta =
          boundsDistance(a.def.bounds, focus) - boundsDistance(b.def.bounds, focus);
        if (delta !== 0) return delta;
      }
      return a.order - b.order;
    });

    for (const record of candidates) {
      if (budget <= 0) break;
      this.startLoad(record);
      budget -= 1;
    }
  }

  private startLoad(record: SectorRecord): void {
    const controller = new AbortController();
    const generation = (record.generation += 1);

    record.state = 'loading';
    record.controller = controller;
    record.bytes = 0;
    record.entities = [];
    record.bodies = [];
    record.release = null;

    this.inFlight += 1;
    this.emitter.emit('sector-load-started', {
      sectorId: record.def.id,
      attempt: record.failures + 1,
    });

    let promise: Promise<SectorPayload>;
    try {
      promise = this.loader.load(record.def, controller.signal);
    } catch (error) {
      // A loader that throws synchronously must not leave the sector wedged in
      // `loading` with an inflated in-flight count.
      promise = Promise.reject(error);
    }

    void promise
      .then(
        (payload) => {
          this.onLoaded(record, generation, payload);
        },
        (error: unknown) => {
          this.onLoadFailed(record, generation, error);
        },
      )
      .then(() => {
        this.inFlight -= 1;
        this.afterSettle();
      });
  }

  private onLoaded(
    record: SectorRecord,
    generation: number,
    payload: SectorPayload,
  ): void {
    // Unloaded (or unloaded and reloaded) while this load was in flight. The
    // result is dropped rather than inserted: those entities belong to a sector
    // that is no longer resident, and their colliders would sit in the physics
    // world with nothing referencing them.
    if (this.disposed || record.generation !== generation) {
      this.discardPayload(payload);
      return;
    }

    record.controller = null;
    record.state = 'loaded';
    record.failures = 0;
    record.retryAfter = 0;
    record.bytes = payload.bytes > 0 ? payload.bytes : record.def.budget.estimatedResidentBytes;
    record.bodies = [...payload.bodies];
    record.release = payload.release ?? null;
    record.entities = [];

    for (const entity of payload.entities) {
      // Ownership is stamped here, not trusted from the loader: `despawnSector`
      // is only correct if every entity's attribution is.
      entity.sector = { sectorId: record.def.id };
      const spawned = this.world.spawn(entity);
      this.restorePersistentState(spawned);
      record.entities.push(spawned);
    }

    this.emitter.emit('sector-load-finished', {
      sectorId: record.def.id,
      entities: record.entities.length,
      bodies: record.bodies.length,
      bytes: record.bytes,
    });
  }

  private onLoadFailed(record: SectorRecord, generation: number, error: unknown): void {
    if (this.disposed || record.generation !== generation) {
      // An abort rejection for a sector that has already been unloaded. Nothing
      // to report and nothing to clean up: a rejecting loader owns its partial
      // work.
      this.discarded += 1;
      return;
    }

    record.controller = null;
    record.state = 'failed';
    record.failures += 1;
    record.retryAfter = this.clock + this.retryDelaySeconds * record.failures;
    // No entities, no bodies, no bytes: a failed sector leaves nothing behind.
    record.entities = [];
    record.bodies = [];
    record.bytes = 0;
    record.release = null;

    this.emitter.emit('sector-load-failed', {
      sectorId: record.def.id,
      error: error instanceof Error ? error : new Error(String(error)),
      attempt: record.failures,
    });
  }

  /** Releases a payload the system decided not to adopt. */
  private discardPayload(payload: SectorPayload): void {
    this.discarded += 1;
    for (const handle of payload.bodies) this.physics?.removeBody(handle);
    try {
      payload.release?.();
    } catch (error) {
      console.error('[streaming] discarded payload release threw', error);
    }
  }

  private afterSettle(): void {
    if (this.disposed) {
      this.drainSettleWaiters();
      return;
    }
    // A completed load frees a concurrency slot and may reveal the next sector
    // in the queue.
    this.evaluate();
    if (this.inFlight === 0) this.drainSettleWaiters();
  }

  private drainSettleWaiters(): void {
    if (this.settleWaiters.length === 0) return;
    const waiters = this.settleWaiters;
    this.settleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * Resolves when nothing is loading.
   *
   * Used by New Game and checkpoint restore to decide whether a loading screen
   * is needed at all (spec §59: no fake 30-second loading animations), and by
   * tests to await the loader.
   */
  whenSettled(): Promise<void> {
    if (this.inFlight === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.settleWaiters.push(resolve);
    });
  }

  // ---- Unloading --------------------------------------------------------

  private evictByDistance(wanted: ReadonlySet<SectorId>, focus: Vec3 | null): void {
    if (!focus) return;
    const radius = this.unloadRadius;

    for (const record of this.records.values()) {
      if (record.state !== 'loaded' && record.state !== 'loading') continue;
      if (wanted.has(record.def.id)) continue;
      if (boundsDistance(record.def.bounds, focus) <= radius) continue;
      this.unload(record, 'distance');
    }
  }

  /**
   * Sheds the furthest resident sectors while over the memory budget.
   *
   * Topology and pinned sectors are exempt: dropping the sector the player is
   * standing in to save memory trades a stutter for a hole in the world.
   */
  private evictByMemory(wanted: ReadonlySet<SectorId>, focus: Vec3 | null): void {
    if (this.memoryBudgetBytes <= 0) return;

    if (this.estimatedBytes <= this.memoryBudgetBytes) {
      this.memoryWarningIssued = false;
      return;
    }

    while (this.estimatedBytes > this.memoryBudgetBytes) {
      let victim: SectorRecord | undefined;
      let victimDistance = -1;

      for (const record of this.records.values()) {
        if (record.state !== 'loaded') continue;
        if (wanted.has(record.def.id)) continue;
        const distance = focus ? boundsDistance(record.def.bounds, focus) : record.order;
        if (distance <= victimDistance) continue;
        victim = record;
        victimDistance = distance;
      }

      if (!victim) {
        // Every resident sector is required. Reported once per episode rather
        // than four times a second, but never swallowed: it means the authored
        // budget cannot hold one district's worth of adjacency.
        if (!this.memoryWarningIssued) {
          this.memoryWarningIssued = true;
          console.warn(
            `[streaming] resident bytes ${this.estimatedBytes} exceed the ${this.memoryBudgetBytes} byte budget and every loaded sector is required`,
          );
        }
        return;
      }

      this.memoryEvictions += 1;
      this.unload(victim, 'memory');
    }

    this.memoryWarningIssued = false;
  }

  /**
   * Explicitly drops a sector.
   *
   * The next evaluation will load it straight back if it is still topologically
   * required — this is for scripted teardown, not for fighting the policy.
   */
  requestUnload(id: SectorId): void {
    const record = this.records.get(id);
    if (!record) return;
    this.unload(record, 'requested');
  }

  /** Drops every sector. Persistent state and pins survive. */
  unloadAll(reason: SectorUnloadReason = 'reset'): void {
    for (const record of this.records.values()) this.unload(record, reason);
  }

  private unload(record: SectorRecord, reason: SectorUnloadReason): void {
    if (record.state === 'unloaded') return;

    if (record.state === 'failed') {
      // Nothing resident; just clear the failure so a later visit retries.
      record.state = 'unloaded';
      record.failures = 0;
      record.retryAfter = 0;
      return;
    }

    const wasLoading = record.state === 'loading';

    // Invalidate the in-flight load before anything else: the generation bump
    // is what makes the eventual result a discard rather than an insertion.
    record.generation += 1;
    record.controller?.abort();
    record.controller = null;

    let despawned = 0;
    if (!wasLoading) {
      // Capture before despawn. This is the line that keeps progress.
      this.capturePersistentState(record.def.id);
      despawned = this.world.despawnSector(record.def.id);

      for (const handle of record.bodies) this.physics?.removeBody(handle);
      try {
        record.release?.();
      } catch (error) {
        console.error(`[streaming] release for sector "${record.def.id}" threw`, error);
      }
    }

    record.state = 'unloaded';
    record.entities = [];
    record.bodies = [];
    record.bytes = 0;
    record.release = null;

    this.emitter.emit('sector-unloaded', {
      sectorId: record.def.id,
      reason,
      entities: despawned,
      wasLoading,
    });
  }

  // ---- Persistent state -------------------------------------------------

  /**
   * Copies the `persistent` component of every entity in a sector into the
   * store, keyed by authored id.
   *
   * Entities tagged `isPersistentAcrossSectors` are skipped: they are not
   * despawned, so capturing them would only risk overwriting live state with a
   * stale copy on the next load.
   */
  private capturePersistentState(sectorId: SectorId): void {
    for (const entity of this.world.sectorMembers.entities) {
      if (entity.sector.sectorId !== sectorId) continue;
      if (entity.isPersistentAcrossSectors) continue;
      const persistent = entity.persistent;
      if (!persistent) continue;
      this.persistentState.set(persistent.id, clonePersistentState(persistent.state));
    }
  }

  private restorePersistentState(entity: Entity): void {
    const persistent = entity.persistent;
    if (!persistent) return;
    const stored = this.persistentState.get(persistent.id);
    if (!stored) return;
    persistent.state = clonePersistentState(stored);
  }

  /** Stored state for an entity id, whether or not its sector is resident. */
  persistentStateOf(entityId: string): Record<string, unknown> | undefined {
    const live = this.world.findPersistent(entityId);
    if (live?.persistent) return clonePersistentState(live.persistent.state);
    const stored = this.persistentState.get(entityId);
    return stored ? clonePersistentState(stored) : undefined;
  }

  /**
   * The slice of a save this system owns.
   *
   * Live entities are read at snapshot time and take precedence over stored
   * copies, so saving does not require unloading anything first.
   */
  snapshot(): StreamingPersistedState {
    const merged: Record<string, Record<string, unknown>> = {};
    for (const [id, state] of this.persistentState) {
      merged[id] = clonePersistentState(state);
    }
    for (const entity of this.world.persistent.entities) {
      merged[entity.persistent.id] = clonePersistentState(entity.persistent.state);
    }

    return {
      currentSectorId: this.currentId,
      pinnedSectorIds: this.pinnedSectorIds,
      persistentState: merged,
    };
  }

  /**
   * Adopts a saved streaming state. Does not load anything: the caller decides
   * when to `evaluate()` and whether to show a loading screen.
   */
  loadFrom(state: StreamingPersistedState): void {
    this.unloadAll('reset');

    this.persistentState.clear();
    for (const [id, entityState] of Object.entries(state.persistentState)) {
      this.persistentState.set(id, clonePersistentState(entityState));
    }

    for (const record of this.records.values()) {
      record.pinned = state.pinnedSectorIds.includes(record.def.id);
    }

    this.currentId =
      state.currentSectorId !== null && this.index.has(state.currentSectorId)
        ? state.currentSectorId
        : null;
  }

  // ---- Teardown ---------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.unloadAll('reset');
    this.disposed = true;
    this.drainSettleWaiters();
    this.emitter.clear();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  private recordsWhere(predicate: (record: SectorRecord) => boolean): SectorRecord[] {
    const matches: SectorRecord[] = [];
    for (const record of this.records.values()) {
      if (predicate(record)) matches.push(record);
    }
    return matches;
  }
}

/**
 * Deep-copies persistent state.
 *
 * Deep, because a shallow copy would leave the restored entity sharing nested
 * objects with the store, so a later mutation would silently rewrite history.
 * Functions and class instances do not belong in persistent state — it has to
 * survive a save — but losing a story beat is worse than sharing a reference,
 * so a failed clone degrades to a shallow copy rather than throwing.
 */
function clonePersistentState(state: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(state);
  } catch (error) {
    // Almost always a function or class instance that should not be in
    // persistent state at all, so name the keys: the shallow fallback keeps
    // the story beat but leaves nested objects shared with the store.
    console.error(
      `[streaming] persistent state clone failed; degraded to a shallow copy (keys: ${Object.keys(
        state,
      ).join(', ')})`,
      error,
    );
    return { ...state };
  }
}
