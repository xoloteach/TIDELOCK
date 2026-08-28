/**
 * Sector streaming tests.
 *
 * Streaming is the system most able to destroy a playthrough quietly. Every
 * failure it has is invisible to a typecheck and most are invisible for the
 * first hour of play: a valve that forgets it was opened, a prop from a sector
 * two districts away inserted after the player left, a collider leaked into the
 * physics world, a boundary that reloads a district every time she steps over a
 * seam. Each of those is pinned here.
 *
 * The load policy under test is deliberately asymmetric — topology loads,
 * distance unloads — so the fixture separates the two: `clinic` is adjacent to
 * `depot` but sits beyond the eviction radius, which is the only way to tell
 * "loaded because it is next door" apart from "loaded because it is close".
 *
 * The system is driven directly rather than through `GameWorld.fixedUpdate`, so
 * a throw fails the test instead of being swallowed by the scheduler's error
 * isolation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GameWorld } from '../../src/engine/ecs/GameWorld';
import { createTransform, vec3, type Entity } from '../../src/engine/ecs/components';
import type { BodyHandle } from '../../src/engine/physics/PhysicsWorld';
import { hasIssue, issuesWithCode } from '../../src/game/dialogue/dialogueSchema';
import {
  SECTOR_SCHEMA_VERSION,
  boundsCenter,
  boundsDistance,
  boundsOverlap,
  collisionMask,
  parseSector,
  scaleLodDistances,
  validateSectorGraph,
  type AssetRef,
  type SectorBounds,
  type SectorDefinition,
  type SectorId,
} from '../../src/game/world/sectorSchema';
import {
  StreamingSystem,
  residentSectorIds,
  type SectorAssetLoaderPort,
  type SectorPayload,
  type SectorPhysicsPort,
  type SectorUnloadReason,
  type StreamingQualityPort,
} from '../../src/game/world/StreamingSystem';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function assetRef(id: string, bytes = 1_000_000): AssetRef {
  return { id, url: `models/${id}.glb`, bytes };
}

/** Sectors are laid out along X. Y and Z are wide enough to be irrelevant. */
function span(minX: number, maxX: number): SectorBounds {
  return { min: { x: minX, y: -5, z: -30 }, max: { x: maxX, y: 15, z: 30 } };
}

const RESIDENT_BYTES = 12_000_000;

function makeSector(id: string, overrides: Partial<SectorDefinition> = {}): SectorDefinition {
  return {
    version: SECTOR_SCHEMA_VERSION,
    id,
    name: id.replace(/_/g, ' '),
    kind: 'playable',
    district: 'morrow-quay',
    bounds: span(0, 40),
    neighbours: [],
    render: {
      models: [assetRef(`${id}_shell`)],
      textures: [assetRef(`${id}_atlas`, 2_000_000)],
    },
    collision: {
      asset: assetRef(`${id}_collision`, 200_000),
      membership: ['World'],
      orientedMesh: false,
    },
    navmesh: assetRef(`${id}_nav`, 40_000),
    lighting: {
      probes: null,
      lightmap: null,
      lights: [],
      ambientHex: '#3d4a4a',
    },
    audioZones: [],
    interactables: [],
    npcSpawns: [],
    machineSpawns: [],
    triggers: [],
    lod: { distances: [25, 60, 140], triangleBudget: 400_000, impostorDistance: 0 },
    budget: {
      maxCompressedBytes: 30_000_000,
      estimatedResidentBytes: RESIDENT_BYTES,
      maxResidentTextures: 60,
    },
    alwaysResident: false,
    ...overrides,
  };
}

/**
 * The borough, reduced to what the streaming rules need.
 *
 *   clinic ─── depot ═══ service_bridge ═══ residential_edge ─── pump_12
 *  [-140,-60]  [0,40]       [38,60]             [60,120]        [120,160]
 *
 *   barrier [400,460] — unreachable by adjacency, used for pinning.
 *
 * `service_bridge` is a transition sector, so residency expands through it and
 * `residential_edge` is resident while the player is still in the depot.
 * `clinic` is adjacent but 80 m away, which is what separates topology-driven
 * loading from distance-driven loading in these tests.
 */
function makeSectors(): SectorDefinition[] {
  return [
    makeSector('clinic', {
      bounds: span(-140, -60),
      neighbours: ['depot'],
    }),
    makeSector('depot', {
      bounds: span(0, 40),
      neighbours: ['service_bridge', 'clinic'],
      npcSpawns: [
        {
          id: 'ivo_triage',
          characterId: 'ivo',
          position: { x: 20, y: 0, z: 5 },
          yaw: 1.2,
          activityTag: 'clinic-triage',
        },
      ],
    }),
    makeSector('service_bridge', {
      kind: 'transition',
      // Overlaps the depot by 2 m: neighbours are expected to share a seam.
      bounds: span(38, 60),
      neighbours: ['depot', 'residential_edge'],
    }),
    makeSector('residential_edge', {
      bounds: span(60, 120),
      neighbours: ['service_bridge', 'pump_12'],
    }),
    makeSector('pump_12', {
      bounds: span(120, 160),
      neighbours: ['residential_edge'],
    }),
    makeSector('barrier', { bounds: span(400, 460) }),
  ];
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface Deferred {
  readonly signal: AbortSignal;
  resolve(): void;
  reject(error: Error): void;
}

/**
 * Stands in for the real asset pipeline.
 *
 * Loads resolve on a microtask by default. `manual` makes a sector's load hang
 * until the test releases it, which is how the mid-load unload race is made
 * deterministic; `failing` makes it reject.
 */
class FakeLoader implements SectorAssetLoaderPort {
  readonly started: SectorId[] = [];
  readonly manual = new Set<SectorId>();
  readonly failing = new Set<SectorId>();
  readonly released: SectorId[] = [];
  readonly signals = new Map<SectorId, AbortSignal>();

  private readonly deferred = new Map<SectorId, Deferred>();
  private nextBody = 1;
  /** Body handles handed out, per sector, so the test can check cleanup. */
  readonly bodiesFor = new Map<SectorId, BodyHandle[]>();

  load(sector: SectorDefinition, signal: AbortSignal): Promise<SectorPayload> {
    this.started.push(sector.id);
    this.signals.set(sector.id, signal);

    if (this.failing.has(sector.id)) {
      return Promise.reject(new Error(`asset fetch failed for ${sector.id}`));
    }

    if (this.manual.has(sector.id)) {
      return new Promise<SectorPayload>((resolve, reject) => {
        this.deferred.set(sector.id, {
          signal,
          resolve: () => resolve(this.payload(sector)),
          reject,
        });
      });
    }

    return Promise.resolve(this.payload(sector));
  }

  /** Hands over control of a hanging load and forgets it. */
  takeDeferred(id: SectorId): Deferred {
    const deferred = this.deferred.get(id);
    if (!deferred) throw new Error(`no deferred load for "${id}"`);
    this.deferred.delete(id);
    return deferred;
  }

  countStarts(id: SectorId): number {
    return this.started.filter((started) => started === id).length;
  }

  private payload(sector: SectorDefinition): SectorPayload {
    const centre = boundsCenter(sector.bounds);
    const body = this.nextBody++;
    const existing = this.bodiesFor.get(sector.id) ?? [];
    existing.push(body);
    this.bodiesFor.set(sector.id, existing);

    return {
      entities: [
        {
          debugName: `${sector.id}:shell`,
          transform: createTransform(centre),
        },
        {
          debugName: `${sector.id}:valve`,
          transform: createTransform(centre),
          persistent: { id: `${sector.id}.valve`, state: { open: false, turns: 0 } },
        },
      ],
      bodies: [body],
      bytes: sector.budget.estimatedResidentBytes,
      release: () => {
        this.released.push(sector.id);
      },
    };
  }
}

class FakePhysics implements SectorPhysicsPort {
  readonly removed: BodyHandle[] = [];

  removeBody(handle: BodyHandle): boolean {
    this.removed.push(handle);
    return true;
  }
}

interface Recorded {
  started: SectorId[];
  finished: SectorId[];
  failed: { sectorId: SectorId; message: string; attempt: number }[];
  unloaded: {
    sectorId: SectorId;
    reason: SectorUnloadReason;
    entities: number;
    wasLoading: boolean;
  }[];
  currentChanges: { from: SectorId | null; to: SectorId }[];
}

function record(system: StreamingSystem): Recorded {
  const events: Recorded = {
    started: [],
    finished: [],
    failed: [],
    unloaded: [],
    currentChanges: [],
  };
  system.on('sector-load-started', (e) => events.started.push(e.sectorId));
  system.on('sector-load-finished', (e) => events.finished.push(e.sectorId));
  system.on('sector-load-failed', (e) =>
    events.failed.push({ sectorId: e.sectorId, message: e.error.message, attempt: e.attempt }),
  );
  system.on('sector-unloaded', (e) => events.unloaded.push({ ...e }));
  system.on('current-sector-changed', (e) => events.currentChanges.push({ ...e }));
  return events;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Draw distance small enough that distance rules bite inside the fixture. */
const NEAR_QUALITY: StreamingQualityPort = { drawDistance: 45, lodMultiplier: 1 };

interface Harness {
  world: GameWorld;
  loader: FakeLoader;
  physics: FakePhysics;
  system: StreamingSystem;
  events: Recorded;
  player: Entity;
  moveTo(x: number): void;
  /** Flushes pending microtasks without waiting for in-flight loads. */
  tick(): Promise<void>;
}

interface HarnessOptions {
  quality?: StreamingQualityPort;
  unloadHysteresis?: number;
  maxConcurrentLoads?: number;
  memoryBudgetBytes?: number;
  sectors?: SectorDefinition[];
  /** Player start position on X. Inside the depot by default. */
  startX?: number;
}

function harness(options: HarnessOptions = {}): Harness {
  const world = new GameWorld();
  const loader = new FakeLoader();
  const physics = new FakePhysics();

  const player = world.spawn({
    isPlayer: true,
    isPersistentAcrossSectors: true,
    debugName: 'mara',
    transform: createTransform(vec3(options.startX ?? 20, 1.6, 0)),
    sector: { sectorId: 'depot' },
  });

  const system = new StreamingSystem({
    world,
    sectors: options.sectors ?? makeSectors(),
    loader,
    physics,
    quality: options.quality ?? NEAR_QUALITY,
    unloadHysteresis: options.unloadHysteresis,
    maxConcurrentLoads: options.maxConcurrentLoads,
    memoryBudgetBytes: options.memoryBudgetBytes,
  });

  return {
    world,
    loader,
    physics,
    system,
    events: record(system),
    player,
    moveTo(x: number) {
      player.transform!.position.x = x;
    },
    tick: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  };
}

function entityNames(world: GameWorld, sectorId: SectorId): string[] {
  return world.sectorMembers.entities
    .filter((entity) => entity.sector.sectorId === sectorId)
    .map((entity) => entity.debugName ?? '<unnamed>')
    .sort();
}

function valveState(world: GameWorld, id: string): Record<string, unknown> | undefined {
  return world.findPersistent(id)?.persistent?.state;
}

// ---------------------------------------------------------------------------
// Residency policy
// ---------------------------------------------------------------------------

describe('residentSectorIds', () => {
  const index = new Map(makeSectors().map((sector) => [sector.id, sector]));

  it('loads the current sector, its neighbours and one hop through a transition', () => {
    const resident = residentSectorIds(index, 'depot');

    // residential_edge is two hops away, reachable only through the bridge.
    expect([...resident].sort()).toEqual([
      'clinic',
      'depot',
      'residential_edge',
      'service_bridge',
    ]);
  });

  it('does not expand past a playable neighbour', () => {
    const resident = residentSectorIds(index, 'residential_edge');

    // pump_12 is adjacent; depot is reached through the bridge. clinic is three
    // hops out and must stay unloaded.
    expect([...resident].sort()).toEqual([
      'depot',
      'pump_12',
      'residential_edge',
      'service_bridge',
    ]);
  });

  it('can be told not to expand through transitions', () => {
    const resident = residentSectorIds(index, 'depot', false);
    expect([...resident].sort()).toEqual(['clinic', 'depot', 'service_bridge']);
  });

  it('is empty with no current sector and ignores unknown ids', () => {
    expect(residentSectorIds(index, null).size).toBe(0);
    expect(residentSectorIds(index, 'ferry_terminal').size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Loading and unloading
// ---------------------------------------------------------------------------

describe('StreamingSystem residency', () => {
  it('loads the current sector, its neighbours and the far side of a transition', async () => {
    const h = harness();

    h.system.evaluate();
    await h.system.whenSettled();

    expect(h.system.currentSectorId).toBe('depot');
    expect(h.system.loadedSectorIds.sort()).toEqual([
      'clinic',
      'depot',
      'residential_edge',
      'service_bridge',
    ]);
    expect(h.system.loadedSectorCount).toBe(4);

    // pump_12 is three hops away; barrier is unreachable by adjacency.
    expect(h.system.stateOf('pump_12')).toBe('unloaded');
    expect(h.system.stateOf('barrier')).toBe('unloaded');

    // clinic sits 80 m out, past the 56.25 m eviction radius. It is resident
    // because it is next door, which is the whole point of the policy.
    expect(boundsDistance(h.system.getSector('clinic')!.bounds, { x: 20, y: 1.6, z: 0 })).toBe(80);
    expect(h.system.unloadRadius).toBeCloseTo(56.25);

    expect(h.events.started.sort()).toEqual(h.system.loadedSectorIds.sort());
    expect(h.events.finished.sort()).toEqual(h.system.loadedSectorIds.sort());
    expect(h.events.currentChanges).toEqual([{ from: null, to: 'depot' }]);

    // Diagnostics: four sectors, two entities and one collider each.
    expect(h.system.estimatedBytes).toBe(4 * RESIDENT_BYTES);
    const diagnostics = h.system.getDiagnostics();
    expect(diagnostics.loaded).toBe(4);
    expect(diagnostics.entities).toBe(8);
    expect(diagnostics.bodies).toBe(4);
    expect(diagnostics.bytes).toBe(4 * RESIDENT_BYTES);
  });

  it('unloads sectors left behind, releasing their entities and colliders', async () => {
    const h = harness();
    h.system.evaluate();
    await h.system.whenSettled();

    const depotBody = h.loader.bodiesFor.get('depot')![0]!;

    h.moveTo(140); // Pump Station 12, three sectors along.
    h.system.evaluate();
    await h.system.whenSettled();

    expect(h.system.currentSectorId).toBe('pump_12');
    expect(h.system.loadedSectorIds.sort()).toEqual(['pump_12', 'residential_edge']);

    const unloaded = h.events.unloaded.filter((e) => e.reason === 'distance');
    expect(unloaded.map((e) => e.sectorId).sort()).toEqual([
      'clinic',
      'depot',
      'service_bridge',
    ]);
    // Two authored entities per sector, and the player was not one of them.
    expect(unloaded.every((e) => e.entities === 2)).toBe(true);
    expect(unloaded.every((e) => e.wasLoading === false)).toBe(true);

    expect(entityNames(h.world, 'depot')).toEqual([]);
    expect(h.physics.removed).toContain(depotBody);
    expect(h.loader.released.sort()).toEqual(['clinic', 'depot', 'service_bridge']);
    expect(h.system.estimatedBytes).toBe(2 * RESIDENT_BYTES);
  });

  it('keeps the eviction radius tied to the quality preset draw distance', async () => {
    const h = harness();
    h.system.evaluate();
    await h.system.whenSettled();

    h.moveTo(140);
    // Ultra-ish draw distance: everything already resident stays resident.
    h.system.setQuality({ drawDistance: 400, lodMultiplier: 1.7 });
    await h.system.whenSettled();

    expect(h.system.unloadRadius).toBe(500);
    expect(h.system.loadedSectorIds.sort()).toEqual([
      'clinic',
      'depot',
      'pump_12',
      'residential_edge',
      'service_bridge',
    ]);
    // LOD distances follow the same preset.
    expect(h.system.effectiveLodDistances('pump_12')).toEqual([42.5, 102, 238]);

    // Drop to a phone's draw distance: the same positions now evict.
    h.system.setQuality({ drawDistance: 50, lodMultiplier: 0.5 });
    await h.system.whenSettled();

    expect(h.system.unloadRadius).toBe(62.5);
    expect(h.system.loadedSectorIds.sort()).toEqual(['pump_12', 'residential_edge']);
    expect(h.system.effectiveLodDistances('pump_12')).toEqual([12.5, 30, 70]);
  });

  it('does not thrash when the player walks back and forth across a seam', async () => {
    // clinic is 110 m from the bridge. With the default 1.25 band the eviction
    // radius is 125 m, so it survives every crossing.
    const h = harness({ quality: { drawDistance: 100, lodMultiplier: 1 } });
    h.system.evaluate();
    await h.system.whenSettled();
    expect(h.system.isLoaded('clinic')).toBe(true);

    for (let crossing = 0; crossing < 3; crossing += 1) {
      h.moveTo(50); // service_bridge — clinic is no longer adjacent
      h.system.evaluate();
      await h.system.whenSettled();
      expect(h.system.currentSectorId).toBe('service_bridge');

      h.moveTo(20); // back into the depot
      h.system.evaluate();
      await h.system.whenSettled();
      expect(h.system.currentSectorId).toBe('depot');
    }

    expect(h.loader.countStarts('clinic')).toBe(1);
    expect(h.events.unloaded.filter((e) => e.sectorId === 'clinic')).toEqual([]);
    expect(h.system.isLoaded('clinic')).toBe(true);
  });

  it('thrashes without the hysteresis band, which is what the band is for', async () => {
    // Same geometry and draw distance, band removed: the eviction radius now
    // coincides with the relevance radius and clinic is 110 m out.
    const h = harness({
      quality: { drawDistance: 100, lodMultiplier: 1 },
      unloadHysteresis: 1,
    });
    h.system.evaluate();
    await h.system.whenSettled();

    for (let crossing = 0; crossing < 3; crossing += 1) {
      h.moveTo(50);
      h.system.evaluate();
      await h.system.whenSettled();

      h.moveTo(20);
      h.system.evaluate();
      await h.system.whenSettled();
    }

    expect(h.loader.countStarts('clinic')).toBe(4);
    expect(h.events.unloaded.filter((e) => e.sectorId === 'clinic')).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Pinning
// ---------------------------------------------------------------------------

describe('StreamingSystem pinning', () => {
  it('loads a pinned sector and never evicts it, however far away', async () => {
    const h = harness();
    h.system.evaluate();
    await h.system.whenSettled();

    // The barrier complex is 360 m away and adjacent to nothing.
    h.system.pin('barrier');
    await h.system.whenSettled();
    expect(h.system.isLoaded('barrier')).toBe(true);
    expect(h.system.isPinned('barrier')).toBe(true);
    expect(h.system.pinnedSectorIds).toEqual(['barrier']);

    h.moveTo(140);
    h.system.evaluate();
    await h.system.whenSettled();

    expect(h.system.isLoaded('barrier')).toBe(true);
    expect(h.events.unloaded.filter((e) => e.sectorId === 'barrier')).toEqual([]);

    // Unpinning hands it back to the ordinary distance rule.
    h.system.unpin('barrier');
    await h.system.whenSettled();
    expect(h.system.isLoaded('barrier')).toBe(false);
    expect(h.events.unloaded.filter((e) => e.sectorId === 'barrier')).toHaveLength(1);
  });

  it('treats an author-pinned sector the same way', async () => {
    const sectors = makeSectors().map((sector) =>
      sector.id === 'barrier' ? { ...sector, alwaysResident: true } : sector,
    );
    const h = harness({ sectors });

    h.system.evaluate();
    await h.system.whenSettled();

    expect(h.system.isLoaded('barrier')).toBe(true);
    expect(h.system.isPinned('barrier')).toBe(true);

    h.moveTo(140);
    h.system.evaluate();
    await h.system.whenSettled();
    expect(h.system.isLoaded('barrier')).toBe(true);
  });

  it('warns rather than silently ignoring a pin for a sector that does not exist', () => {
    const h = harness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    h.system.pin('ferry_terminal');

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('cannot pin unknown sector "ferry_terminal"'),
    );
    expect(h.system.pinnedSectorIds).toEqual([]);
    warn.mockRestore();
  });

  it('never evicts a pinned sector for the memory budget', async () => {
    // Budget for two sectors while four are wanted: eviction has to give up
    // rather than drop something required.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness({ memoryBudgetBytes: 2 * RESIDENT_BYTES });

    h.system.pin('barrier');
    h.system.evaluate();
    await h.system.whenSettled();

    // Everything resident is either topology-required or pinned.
    expect(h.system.isLoaded('barrier')).toBe(true);
    expect(h.system.loadedSectorCount).toBe(5);
    expect(h.system.getDiagnostics().memoryEvictions).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('evicts the furthest optional sector when over the memory budget', async () => {
    const h = harness({
      // Four sectors are topology-required at the depot; allow one spare.
      memoryBudgetBytes: 5 * RESIDENT_BYTES,
      quality: { drawDistance: 1000, lodMultiplier: 1 },
    });

    h.system.evaluate();
    await h.system.whenSettled();
    expect(h.system.loadedSectorCount).toBe(4);

    // Pin, load, then unpin: barrier becomes an optional resident sector 360 m
    // away, and the budget is already full.
    h.system.pin('barrier');
    await h.system.whenSettled();
    expect(h.system.loadedSectorCount).toBe(5);

    h.moveTo(140); // pulls pump_12 in, taking the count to six
    h.system.unpin('barrier');
    await h.system.whenSettled();

    // The furthest optional sector goes; everything near or required stays.
    expect(h.system.isLoaded('barrier')).toBe(false);
    expect(h.system.loadedSectorIds.sort()).toEqual([
      'clinic',
      'depot',
      'pump_12',
      'residential_edge',
      'service_bridge',
    ]);
    expect(h.system.estimatedBytes).toBe(5 * RESIDENT_BYTES);
    expect(h.system.getDiagnostics().memoryEvictions).toBe(1);
    expect(h.events.unloaded.filter((e) => e.reason === 'memory')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Gameplay state survives scene state
// ---------------------------------------------------------------------------

describe('StreamingSystem persistence', () => {
  it('leaves the player standing when her own sector is unloaded', async () => {
    const h = harness();
    h.system.evaluate();
    await h.system.whenSettled();

    expect(h.system.currentSectorId).toBe('depot');
    expect(entityNames(h.world, 'depot')).toEqual(['depot:shell', 'depot:valve', 'mara']);

    h.system.requestUnload('depot');

    // Same entity object, same position, still the world's player.
    expect(h.world.player).toBe(h.player);
    expect(h.player.transform!.position.x).toBe(20);
    expect(entityNames(h.world, 'depot')).toEqual(['mara']);

    const event = h.events.unloaded.find((e) => e.sectorId === 'depot');
    expect(event?.reason).toBe('requested');
    // Two props despawned. The player was not counted, because she was not
    // despawned.
    expect(event?.entities).toBe(2);

    // And she is still there after the sector comes back.
    h.system.evaluate();
    await h.system.whenSettled();
    expect(h.world.player).toBe(h.player);
    expect(entityNames(h.world, 'depot')).toEqual(['depot:shell', 'depot:valve', 'mara']);
  });

  it('round-trips persistent entity state through an unload and reload', async () => {
    const h = harness();
    h.system.evaluate();
    await h.system.whenSettled();

    const before = h.world.findPersistent('depot.valve');
    expect(before).toBeDefined();
    before!.persistent!.state.open = true;
    before!.persistent!.state.turns = 3;

    h.system.requestUnload('depot');

    // The entity is gone; the state is not.
    expect(h.world.findPersistent('depot.valve')).toBeUndefined();
    expect(h.system.persistentStateOf('depot.valve')).toEqual({ open: true, turns: 3 });

    // Capture copies rather than aliases. Another system holding a stale
    // reference to the despawned entity — a cached query result, an interaction
    // target — must not be able to rewrite what was stored.
    before!.persistent!.state.turns = 99;

    h.system.evaluate();
    await h.system.whenSettled();

    const after = h.world.findPersistent('depot.valve');
    expect(after).toBeDefined();
    // A genuinely new entity from a second load, carrying the old state.
    expect(after).not.toBe(before);
    expect(h.loader.countStarts('depot')).toBe(2);
    expect(after!.persistent!.state).toEqual({ open: true, turns: 3 });

    // While a sector is resident the live entity is the truth, so the accessor
    // reports it rather than the stored copy.
    after!.persistent!.state.turns = 9;
    expect(h.system.persistentStateOf('depot.valve')).toEqual({ open: true, turns: 9 });

    // A neighbour's identically-shaped state was not touched.
    expect(valveState(h.world, 'clinic.valve')).toEqual({ open: false, turns: 0 });
  });

  it('survives a save round trip through snapshot and loadFrom', async () => {
    const h = harness();
    h.system.evaluate();
    await h.system.whenSettled();

    h.world.findPersistent('depot.valve')!.persistent!.state.open = true;
    h.system.pin('barrier');
    await h.system.whenSettled();

    const snapshot = h.system.snapshot();
    expect(snapshot.currentSectorId).toBe('depot');
    expect(snapshot.pinnedSectorIds).toEqual(['barrier']);
    expect(snapshot.persistentState['depot.valve']).toEqual({ open: true, turns: 0 });

    // A fresh session adopting that save.
    const restored = harness();
    restored.system.loadFrom(snapshot);
    expect(restored.system.currentSectorId).toBe('depot');
    expect(restored.system.pinnedSectorIds).toEqual(['barrier']);

    restored.system.evaluate();
    await restored.system.whenSettled();
    expect(valveState(restored.world, 'depot.valve')).toEqual({ open: true, turns: 0 });
  });
});

// ---------------------------------------------------------------------------
// Failure and cancellation
// ---------------------------------------------------------------------------

describe('StreamingSystem load failures', () => {
  it('reports a failed load and leaves no partial state behind', async () => {
    const h = harness();
    h.loader.failing.add('service_bridge');

    h.system.evaluate();
    await h.system.whenSettled();

    expect(h.events.failed).toEqual([
      {
        sectorId: 'service_bridge',
        message: 'asset fetch failed for service_bridge',
        attempt: 1,
      },
    ]);
    expect(h.system.stateOf('service_bridge')).toBe('failed');
    expect(h.events.finished).not.toContain('service_bridge');

    // Nothing partial: no entities, no bytes, no colliders, and the rest of the
    // topology still loaded.
    expect(entityNames(h.world, 'service_bridge')).toEqual([]);
    expect(h.system.loadedSectorIds.sort()).toEqual(['clinic', 'depot', 'residential_edge']);
    expect(h.system.estimatedBytes).toBe(3 * RESIDENT_BYTES);
    expect(h.physics.removed).toEqual([]);
    expect(h.system.getDiagnostics().failed).toBe(1);

    // No hammering: an immediate re-evaluation does not retry.
    h.system.evaluate();
    await h.system.whenSettled();
    expect(h.loader.countStarts('service_bridge')).toBe(1);
  });

  it('retries a failed sector after backing off', async () => {
    const h = harness();
    h.loader.failing.add('service_bridge');

    h.system.evaluate();
    await h.system.whenSettled();
    expect(h.loader.countStarts('service_bridge')).toBe(1);

    // The connection comes back. Four seconds of simulation clears the 3 s
    // backoff and the scheduled evaluation picks it up.
    h.loader.failing.delete('service_bridge');
    for (let step = 0; step < 240; step += 1) h.system.fixedUpdate(1 / 60);
    await h.system.whenSettled();

    expect(h.loader.countStarts('service_bridge')).toBe(2);
    expect(h.system.isLoaded('service_bridge')).toBe(true);
    expect(h.system.getDiagnostics().failed).toBe(0);
  });

  it('discards a load whose sector was unloaded while it was in flight', async () => {
    const h = harness({ maxConcurrentLoads: 8 });
    h.loader.manual.add('residential_edge');

    h.system.evaluate();
    await h.tick();

    // Everything but the deferred sector has finished.
    expect(h.system.stateOf('residential_edge')).toBe('loading');
    expect(h.system.loadedSectorIds.sort()).toEqual(['clinic', 'depot', 'service_bridge']);
    const pending = h.loader.takeDeferred('residential_edge');
    expect(pending.signal.aborted).toBe(false);

    // Mara turns round and walks back past the clinic before the far side of
    // the bridge has finished loading.
    h.moveTo(-100);
    h.system.evaluate();

    expect(h.system.currentSectorId).toBe('clinic');
    expect(h.system.stateOf('residential_edge')).toBe('unloaded');
    expect(pending.signal.aborted).toBe(true);

    const cancelled = h.events.unloaded.find((e) => e.sectorId === 'residential_edge');
    expect(cancelled).toEqual({
      sectorId: 'residential_edge',
      reason: 'distance',
      entities: 0,
      wasLoading: true,
    });

    // The loader finishes anyway — a fetch already in flight cannot be recalled.
    pending.resolve();
    await h.system.whenSettled();

    // The result must not appear in the world.
    expect(entityNames(h.world, 'residential_edge')).toEqual([]);
    expect(h.system.stateOf('residential_edge')).toBe('unloaded');
    expect(h.events.finished).not.toContain('residential_edge');
    expect(h.world.findPersistent('residential_edge.valve')).toBeUndefined();

    // And its collider must not be left orphaned in the physics world.
    const orphan = h.loader.bodiesFor.get('residential_edge')![0]!;
    expect(h.physics.removed).toContain(orphan);
    expect(h.loader.released).toContain('residential_edge');
    expect(h.system.getDiagnostics().discardedLoads).toBe(1);
  });

  it('discards a stale load even when the sector was reloaded meanwhile', async () => {
    const h = harness({ maxConcurrentLoads: 8 });
    h.loader.manual.add('clinic');

    h.system.evaluate();
    await h.tick();
    const first = h.loader.takeDeferred('clinic');

    // Unload and immediately allow a fresh load to complete. `whenSettled` is
    // no use here: the abandoned first load is still counted in flight, which
    // is exactly the situation being tested.
    h.system.requestUnload('clinic');
    h.loader.manual.delete('clinic');
    h.system.evaluate();
    await h.tick();

    expect(h.system.isLoaded('clinic')).toBe(true);
    expect(entityNames(h.world, 'clinic')).toEqual(['clinic:shell', 'clinic:valve']);
    expect(h.loader.countStarts('clinic')).toBe(2);

    // The abandoned first load now settles. It must not duplicate the sector.
    first.resolve();
    await h.system.whenSettled();

    expect(entityNames(h.world, 'clinic')).toEqual(['clinic:shell', 'clinic:valve']);
    expect(h.system.isLoaded('clinic')).toBe(true);
    expect(h.system.getDiagnostics().discardedLoads).toBe(1);
  });

  it('does not wedge a sector in loading when the loader throws synchronously', async () => {
    const h = harness();
    const boom = new Error('loader exploded');
    const spy = vi.spyOn(h.loader, 'load').mockImplementation((sector, signal) => {
      if (sector.id === 'clinic') throw boom;
      return FakeLoader.prototype.load.call(h.loader, sector, signal);
    });

    h.system.evaluate();
    await h.system.whenSettled();

    expect(h.system.stateOf('clinic')).toBe('failed');
    expect(h.system.inFlightCount).toBe(0);
    expect(h.events.failed.map((e) => e.message)).toEqual(['loader exploded']);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

describe('StreamingSystem teardown', () => {
  it('unloads everything on dispose without touching the player', async () => {
    const h = harness();
    h.system.evaluate();
    await h.system.whenSettled();

    h.system.dispose();

    expect(h.system.loadedSectorCount).toBe(0);
    expect(h.system.estimatedBytes).toBe(0);
    expect(h.world.player).toBe(h.player);
    expect(h.world.entityCount).toBe(1);
    expect(h.system.isDisposed).toBe(true);

    // A disposed system stops scheduling work.
    h.system.fixedUpdate(1);
    h.system.evaluate();
    expect(h.system.loadedSectorCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe('sector schema', () => {
  it('parses a fully authored sector', () => {
    const authored = makeSector('pump_station_12', {
      bounds: span(120, 160),
      neighbours: ['residential_edge'],
      lighting: {
        probes: assetRef('pump_probes', 90_000),
        lightmap: null,
        lights: [
          {
            id: 'work_light_a',
            kind: 'spot',
            position: { x: 130, y: 4, z: 2 },
            colorHex: '#ffb45a',
            intensity: 12,
            range: 18,
            priority: 3,
            castsShadow: true,
            flicker: { hz: 7.5, amount: 0.2 },
          },
        ],
        ambientHex: '#3d4a4a',
      },
      audioZones: [
        {
          id: 'pump_hall',
          clipId: 'amb_pump_hall_loop',
          bus: 'ambience',
          bounds: span(120, 160),
          gain: 0.7,
          fadeSeconds: 1.5,
          reverb: 'concrete-hall',
        },
      ],
      interactables: [
        {
          id: 'breaker_4b',
          verb: 'turn',
          label: 'Breaker 4B',
          position: { x: 132, y: 1, z: -4 },
          yaw: 0,
          range: 1.8,
          holdDuration: 0.9,
          event: 'pump12.breaker.4b',
          repeatable: false,
          model: 'breaker_panel',
          persistentId: 'pump12.breaker4b',
        },
      ],
      machineSpawns: [
        {
          id: 'crawler_a',
          kind: 'repair-crawler',
          position: { x: 150, y: 0, z: 10 },
          yaw: 3.1,
          patrolRoute: [
            { x: 150, y: 0, z: 10 },
            { x: 128, y: 0, z: -8 },
          ],
          initialState: 'patrol',
        },
      ],
      triggers: [
        {
          id: 'pump_hall_entry',
          event: 'pump12.entered',
          bounds: span(120, 126),
          filter: ['Player'],
          once: true,
        },
      ],
    });

    const parsed = parseSector(JSON.parse(JSON.stringify(authored)));
    expect(parsed).toEqual(authored);
    expect(parsed.interactables[0]!.verb).toBe('turn');
    expect(parsed.machineSpawns[0]!.initialState).toBe('patrol');
  });

  it('rejects malformed sectors, unknown fields and inverted bounds', () => {
    expect(() => parseSector({ id: 'depot' })).toThrow(/invalid sector/);

    // Unknown keys are rejected rather than silently ignored: a renamed field
    // must not become a field nothing reads.
    const withExtra = { ...makeSector('depot'), lodMultiplier: 2 };
    expect(() => parseSector(withExtra)).toThrow(/invalid sector/);

    const inverted = makeSector('depot', {
      bounds: { min: { x: 40, y: 0, z: 0 }, max: { x: 0, y: 10, z: 10 } },
    });
    expect(() => parseSector(inverted)).toThrow(/bounds max must exceed min/);

    const badVerb = { ...makeSector('depot') } as unknown as Record<string, unknown>;
    badVerb.interactables = [
      {
        id: 'x',
        verb: 'hack',
        label: 'x',
        position: { x: 0, y: 0, z: 0 },
        yaw: 0,
        range: 1,
        holdDuration: 0,
        event: 'x',
        repeatable: false,
        model: null,
      },
    ];
    expect(() => parseSector(badVerb)).toThrow(/invalid sector/);
  });

  it('rejects a sector authored against a different schema version', () => {
    expect(() => parseSector(makeSector('depot', { version: 99 }))).toThrow(
      /schema version 99/,
    );
  });

  it('packs collision layer names into a mask', () => {
    expect(collisionMask(['World'])).toBe(1);
    expect(collisionMask(['World', 'Trigger'])).toBe(1 | (1 << 5));
    expect(collisionMask([])).toBe(0);
  });

  it('measures distance to bounds and treats touching faces as no overlap', () => {
    const a = span(0, 40);
    const b = span(40, 60);
    const c = span(38, 60);

    expect(boundsDistance(a, { x: 20, y: 1, z: 0 })).toBe(0);
    expect(boundsDistance(b, { x: 20, y: 1, z: 0 })).toBe(20);
    expect(boundsOverlap(a, b)).toBe(false);
    expect(boundsOverlap(a, c)).toBe(true);
  });

  it('scales authored LOD distances by the preset multiplier', () => {
    const lod = { distances: [20, 50], triangleBudget: 1000, impostorDistance: 0 };
    expect(scaleLodDistances(lod, 0.5)).toEqual([10, 25]);

    const cinematic = scaleLodDistances(lod, 2.2);
    expect(cinematic[0]).toBeCloseTo(44);
    expect(cinematic[1]).toBeCloseTo(110);
  });
});

// ---------------------------------------------------------------------------
// Graph validation
// ---------------------------------------------------------------------------

describe('validateSectorGraph', () => {
  it('accepts the campaign fixture, warning only about the unlinked sector', () => {
    const result = validateSectorGraph(makeSectors());

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    // depot and service_bridge overlap by 2 m, and that is allowed because they
    // are neighbours.
    expect(hasIssue(result, 'overlapping-bounds')).toBe(false);
    expect(issuesWithCode(result, 'isolated-sector').map((i) => i.target)).toEqual([
      'barrier',
    ]);
  });

  it('catches an unknown neighbour id', () => {
    const result = validateSectorGraph([
      makeSector('depot', { neighbours: ['ferry_terminal'] }),
    ]);

    expect(result.ok).toBe(false);
    const issues = issuesWithCode(result, 'unknown-neighbour');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('ferry_terminal');
  });

  it('catches adjacency declared in only one direction', () => {
    const result = validateSectorGraph([
      makeSector('depot', { bounds: span(0, 40), neighbours: ['service_bridge'] }),
      makeSector('service_bridge', {
        kind: 'transition',
        bounds: span(40, 60),
        neighbours: [],
      }),
    ]);

    expect(result.ok).toBe(false);
    expect(issuesWithCode(result, 'asymmetric-adjacency').map((i) => i.target)).toEqual([
      'depot',
    ]);
  });

  it('catches a sector listing itself as a neighbour', () => {
    const result = validateSectorGraph([makeSector('depot', { neighbours: ['depot'] })]);
    expect(hasIssue(result, 'self-neighbour')).toBe(true);
  });

  it('catches overlapping bounds between sectors that are not adjacent', () => {
    const overlapping = [
      makeSector('depot', { bounds: span(0, 40) }),
      makeSector('relay_annex', { bounds: span(20, 80) }),
    ];

    const result = validateSectorGraph(overlapping);
    expect(result.ok).toBe(false);
    expect(issuesWithCode(result, 'overlapping-bounds')).toHaveLength(1);

    // An explicit exemption covers the legitimate case: a flooded tunnel under
    // a street it has no connection to.
    const exempt = [
      makeSector('depot', { bounds: span(0, 40), overlapsAllowedWith: ['relay_annex'] }),
      makeSector('relay_annex', { bounds: span(20, 80) }),
    ];
    expect(validateSectorGraph(exempt).ok).toBe(true);
  });

  it('catches missing asset references', () => {
    const noModels = validateSectorGraph([
      makeSector('depot', { render: { models: [], textures: [] } }),
    ]);
    expect(hasIssue(noModels, 'missing-render-assets')).toBe(true);

    const noCollision = validateSectorGraph([makeSector('depot', { collision: null })]);
    expect(hasIssue(noCollision, 'missing-collision')).toBe(true);

    // A transition sector the player can never stand in is allowed none.
    const transition = validateSectorGraph([
      makeSector('overhead_gantry', { kind: 'transition', collision: null }),
    ]);
    expect(hasIssue(transition, 'missing-collision')).toBe(false);

    const spawnsWithoutNavmesh = validateSectorGraph([
      makeSector('depot', {
        navmesh: null,
        npcSpawns: [
          {
            id: 'ivo',
            characterId: 'ivo',
            position: { x: 20, y: 0, z: 0 },
            yaw: 0,
            activityTag: 'clinic-triage',
          },
        ],
      }),
    ]);
    expect(hasIssue(spawnsWithoutNavmesh, 'missing-navmesh')).toBe(true);

    const emptyUrl = validateSectorGraph([
      makeSector('depot', {
        render: { models: [{ id: 'shell', url: '   ', bytes: 10 }], textures: [] },
      }),
    ]);
    expect(hasIssue(emptyUrl, 'empty-asset-url')).toBe(true);

    const duplicateAsset = validateSectorGraph([
      makeSector('depot', {
        render: { models: [assetRef('shell'), assetRef('shell')], textures: [] },
      }),
    ]);
    expect(hasIssue(duplicateAsset, 'duplicate-asset-id')).toBe(true);
  });

  it('catches duplicate ids, bad bounds and an over-budget sector', () => {
    const duplicates = validateSectorGraph([makeSector('depot'), makeSector('depot')]);
    expect(hasIssue(duplicates, 'duplicate-sector-id')).toBe(true);

    const badBounds = validateSectorGraph([
      makeSector('depot', {
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 10, z: 10 } },
      }),
    ]);
    expect(hasIssue(badBounds, 'invalid-bounds')).toBe(true);

    const overBudget = validateSectorGraph([
      makeSector('depot', {
        budget: {
          maxCompressedBytes: 1000,
          estimatedResidentBytes: 1000,
          maxResidentTextures: 1,
        },
      }),
    ]);
    expect(hasIssue(overBudget, 'asset-budget-exceeded')).toBe(true);
  });

  it('catches content and sectors nobody can reach', () => {
    const result = validateSectorGraph(makeSectors(), { entrySectorId: 'depot' });
    expect(result.ok).toBe(false);
    expect(issuesWithCode(result, 'unreachable-sector').map((i) => i.target)).toEqual([
      'barrier',
    ]);

    const stray = validateSectorGraph([
      makeSector('depot', {
        interactables: [
          {
            id: 'notice_board',
            verb: 'read',
            label: 'Evacuation notice',
            position: { x: 900, y: 0, z: 0 },
            yaw: 0,
            range: 1.5,
            holdDuration: 0,
            event: 'depot.notice',
            repeatable: true,
            model: null,
          },
        ],
      }),
    ]);
    expect(hasIssue(stray, 'content-outside-bounds')).toBe(true);
    // A misplaced prop is a warning, not a blocker.
    expect(stray.ok).toBe(true);
  });

  it('warns when a transition sector does not join exactly two places', () => {
    const result = validateSectorGraph([
      makeSector('depot', { bounds: span(0, 40), neighbours: ['service_bridge'] }),
      makeSector('service_bridge', {
        kind: 'transition',
        bounds: span(40, 60),
        neighbours: ['depot'],
      }),
    ]);

    expect(result.errors).toEqual([]);
    expect(issuesWithCode(result, 'transition-degree').map((i) => i.target)).toEqual([
      'service_bridge',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Construction guards
// ---------------------------------------------------------------------------

describe('StreamingSystem construction', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('refuses two sectors with the same id', () => {
    expect(
      () =>
        new StreamingSystem({
          world: new GameWorld(),
          sectors: [makeSector('depot'), makeSector('depot')],
          loader: new FakeLoader(),
        }),
    ).toThrow(/duplicate sector id "depot"/);
  });

  it('warns about an unknown neighbour rather than refusing to boot', () => {
    const system = new StreamingSystem({
      world: new GameWorld(),
      sectors: [makeSector('depot', { neighbours: ['ferry_terminal'] })],
      loader: new FakeLoader(),
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown neighbour "ferry_terminal"'),
    );
    expect(system.sectorIds).toEqual(['depot']);
  });

  it('starts from an entry sector when there is no player yet', async () => {
    const world = new GameWorld();
    const loader = new FakeLoader();
    const system = new StreamingSystem({
      world,
      sectors: makeSectors(),
      loader,
      quality: NEAR_QUALITY,
      entrySectorId: 'depot',
    });

    expect(system.currentSectorId).toBe('depot');

    system.evaluate();
    await system.whenSettled();

    // Topology alone decides residency; nothing is evicted without a player to
    // measure distance from.
    expect(system.loadedSectorIds.sort()).toEqual([
      'clinic',
      'depot',
      'residential_edge',
      'service_bridge',
    ]);
  });
});
