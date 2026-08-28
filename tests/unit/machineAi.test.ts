/**
 * Machine perception and behaviour tests.
 *
 * These are spec 65's named benchmark scenarios (A–F), implemented as
 * deterministic unit tests rather than a dev room, plus the properties the
 * perception model claims about itself: that awareness ramps, that difficulty
 * changes forgiveness rather than health, that a disabled machine really is
 * blind, and that the distance throttle actually throttles.
 *
 * Scenario B is the load-bearing one. "No detection" is trivially satisfiable by
 * a broken system that never detects anything, so the occlusion test always
 * proves the negative twice: with the wall there is no detection, and with the
 * same setup and the wall removed there is. Anything less is a test that would
 * pass if perception were deleted.
 *
 * Both systems are driven directly rather than through `GameWorld.fixedUpdate`,
 * so a throw fails the test instead of being swallowed by the scheduler's error
 * isolation.
 */

import { describe, it, expect } from 'vitest';
import { GameWorld } from '../../src/engine/ecs/GameWorld';
import {
  createTransform,
  distance,
  vec3,
  type Entity,
  type MachineAi,
  type MachineState,
  type NavAgent,
  type Perception,
  type Vec3,
} from '../../src/engine/ecs/components';
import {
  DIFFICULTY_TUNING,
  PerceptionSystem,
  SOUND_AWARENESS_CEILING,
  createStaticPerceptionQuality,
  facingFromYaw,
  type MachineDifficulty,
  type MachineDifficultyPort,
  type PerceptionRaycastPort,
} from '../../src/game/ai/PerceptionSystem';
import {
  ALERT_AWARENESS,
  MachineAiSystem,
  SUSPICION_AWARENESS,
  createMachineAi,
  createPerception,
  isMachineState,
  type MachineAiSnapshot,
} from '../../src/game/ai/MachineAiSystem';

const DT = 1 / 60;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Faces -Z (yaw 0 in the Three.js convention the systems share). */
const YAW_NEG_Z = 0;
/** Faces +X. */
const YAW_POS_X = -Math.PI / 2;

function fakeNavAgent(): NavAgent {
  return {
    destination: null,
    path: [],
    pathIndex: 0,
    speed: 1.2,
    radius: 0.4,
    repathCooldown: 0,
    arrived: true,
  };
}

/**
 * An opaque wall as an infinite plane.
 *
 * Enough for a line-of-sight test: the segment is blocked exactly when its two
 * endpoints sit on opposite sides of the plane. A real port raycasts colliders;
 * the system only ever asks the yes/no question.
 */
function wallAtX(planeX: number): PerceptionRaycastPort {
  return {
    isOccluded: (from, to) =>
      Math.sign(from.x - planeX) !== Math.sign(to.x - planeX) &&
      from.x !== planeX &&
      to.x !== planeX,
  };
}

function wallAtZ(planeZ: number): PerceptionRaycastPort {
  return {
    isOccluded: (from, to) =>
      Math.sign(from.z - planeZ) !== Math.sign(to.z - planeZ) &&
      from.z !== planeZ &&
      to.z !== planeZ,
  };
}

/** A difficulty port whose level can be changed mid-test. */
function mutableDifficulty(initial: MachineDifficulty = 'standard'): MachineDifficultyPort & {
  set(level: MachineDifficulty): void;
} {
  let level = initial;
  return {
    difficulty: () => level,
    set: (next) => {
      level = next;
    },
  };
}

interface MachineOptions {
  readonly name?: string;
  readonly position?: Vec3;
  readonly yaw?: number;
  readonly state?: MachineState;
  readonly patrolRoute?: Vec3[];
  readonly patrolIndex?: number;
  readonly perception?: Partial<Perception>;
  readonly machineAi?: Partial<MachineAi>;
  /** Authored persistent id. Required for save/restore. */
  readonly id?: string;
  /** Set false to model a machine with no nav agent at all. */
  readonly navAgent?: boolean;
}

function spawnMachine(world: GameWorld, options: MachineOptions = {}): Entity {
  const entity: Entity = {
    isMachine: true,
    debugName: options.name ?? 'machine',
    transform: createTransform(options.position ?? vec3(), options.yaw ?? YAW_NEG_Z),
    machineAi: createMachineAi({
      state: options.state ?? 'patrol',
      patrolRoute: options.patrolRoute ?? [],
      patrolIndex: options.patrolIndex ?? 0,
      ...options.machineAi,
    }),
    perception: createPerception(options.perception),
  };
  if (options.navAgent !== false) entity.navAgent = fakeNavAgent();
  if (options.id) entity.persistent = { id: options.id, state: {} };
  return world.spawn(entity);
}

/** A vision-only sensor package: no proximity sense, no hearing. */
const SIGHT_ONLY: Partial<Perception> = {
  visionRange: 18,
  visionHalfAngle: 0.6,
  proximityRange: 0,
  hearingRange: 0,
  timeToDetect: 1.5,
};

/** Senses nothing at all. Used to prove escalation came from a peer's alert. */
const SENSORS_OFF: Partial<Perception> = {
  visionRange: 0,
  visionHalfAngle: 0,
  proximityRange: 0,
  hearingRange: 0,
};

interface Transition {
  readonly name: string;
  readonly from: MachineState;
  readonly to: MachineState;
  readonly reason: string;
  /** Awareness at the moment of the transition. */
  readonly awareness: number;
}

interface HarnessOptions {
  readonly playerAt?: Vec3;
  readonly raycast?: PerceptionRaycastPort | null;
  readonly difficulty?: MachineDifficulty;
  readonly aiFarUpdateHz?: number;
}

function harness(options: HarnessOptions = {}) {
  const world = new GameWorld();
  const playerTransform = createTransform(options.playerAt ?? vec3());
  world.spawn({ isPlayer: true, transform: playerTransform, debugName: 'mara' });

  const difficulty = mutableDifficulty(options.difficulty ?? 'standard');
  const perception = new PerceptionSystem({
    world,
    raycast: options.raycast ?? null,
    quality: createStaticPerceptionQuality(options.aiFarUpdateHz ?? 6),
    difficulty,
  });
  const ai = new MachineAiSystem({ world, perception, difficulty });

  const transitions: Transition[] = [];
  const alertsRaised: { name: string; notified: number; radius: number }[] = [];
  const alertsReceived: { name: string; from: string; position: Vec3 }[] = [];
  const abandoned: string[] = [];
  const sighted: string[] = [];
  const heard: { name: string; position: Vec3 }[] = [];

  ai.on('state-changed', ({ entity, from, to, reason }) => {
    transitions.push({
      name: entity.debugName ?? '?',
      from,
      to,
      reason,
      awareness: entity.machineAi?.awareness ?? 0,
    });
  });
  ai.on('alert-raised', ({ entity, notified, radius }) => {
    alertsRaised.push({ name: entity.debugName ?? '?', notified, radius });
  });
  ai.on('alert-received', ({ entity, from, position }) => {
    alertsReceived.push({
      name: entity.debugName ?? '?',
      from: from.debugName ?? '?',
      position,
    });
  });
  ai.on('search-abandoned', ({ entity }) => abandoned.push(entity.debugName ?? '?'));
  perception.on('sighted', ({ entity }) => sighted.push(entity.debugName ?? '?'));
  perception.on('heard', ({ entity, position }) =>
    heard.push({ name: entity.debugName ?? '?', position }),
  );

  const step = (dt = DT): void => {
    perception.fixedUpdate(dt);
    ai.fixedUpdate(dt);
  };

  const run = (seconds: number, dt = DT): void => {
    const steps = Math.max(1, Math.round(seconds / dt));
    for (let i = 0; i < steps; i += 1) step(dt);
  };

  const statesFor = (name: string): MachineState[] =>
    transitions.filter((t) => t.name === name).map((t) => t.to);

  return {
    world,
    perception,
    ai,
    playerTransform,
    difficulty,
    transitions,
    alertsRaised,
    alertsReceived,
    abandoned,
    sighted,
    heard,
    step,
    run,
    statesFor,
  };
}

function stateOf(entity: Entity): MachineState {
  return entity.machineAi!.state;
}

function awarenessOf(entity: Entity): number {
  return entity.machineAi!.awareness;
}

// ---------------------------------------------------------------------------
// Shared conventions
// ---------------------------------------------------------------------------

describe('perception geometry', () => {
  it('agrees with the interaction cone about which way yaw 0 faces', () => {
    // Three.js convention: yaw 0 looks down -Z. A machine and a prompt
    // disagreeing here is a bug that only surfaces in one sector.
    const forward = facingFromYaw(0);
    expect(forward.x).toBeCloseTo(0, 6);
    expect(forward.z).toBeCloseTo(-1, 6);

    const east = facingFromYaw(YAW_POS_X);
    expect(east.x).toBeCloseTo(1, 6);
    expect(east.z).toBeCloseTo(0, 6);
  });

  it('rejects unknown machine states', () => {
    expect(isMachineState('patrol')).toBe(true);
    expect(isMachineState('pursue')).toBe(true);
    expect(isMachineState('hunting')).toBe(false);
    expect(isMachineState(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario A — Vision (spec 65)
// ---------------------------------------------------------------------------

describe('Scenario A — vision', () => {
  it('goes suspicious, inspects, and only alerts after the awareness threshold', () => {
    const h = harness({ playerAt: vec3(0, 0, -6) });
    const machine = spawnMachine(h.world, {
      name: 'inspection-4',
      yaw: YAW_NEG_Z,
      perception: SIGHT_ONLY,
    });

    // A fifth of a second in the cone is not a detection.
    h.run(0.2);
    expect(stateOf(machine)).toBe('patrol');
    expect(awarenessOf(machine)).toBeGreaterThan(0);
    expect(awarenessOf(machine)).toBeLessThan(SUSPICION_AWARENESS);

    h.run(2.0);

    const states = h.statesFor('inspection-4');
    expect(states.slice(0, 3)).toEqual(['suspicious', 'inspect', 'alert']);

    const suspicious = h.transitions.find((t) => t.to === 'suspicious')!;
    const inspect = h.transitions.find((t) => t.to === 'inspect')!;
    const alert = h.transitions.find((t) => t.to === 'alert')!;

    // Suspicion and inspection happen well below certainty; only the alert
    // requires the threshold. This is the ordering the scenario names.
    expect(suspicious.awareness).toBeGreaterThanOrEqual(SUSPICION_AWARENESS);
    expect(suspicious.awareness).toBeLessThan(ALERT_AWARENESS);
    expect(inspect.awareness).toBeLessThan(ALERT_AWARENESS);
    expect(alert.awareness).toBeGreaterThanOrEqual(ALERT_AWARENESS);
    expect(alert.reason).toBe('escalated');
  });

  it('does not alert for a player who clips the cone and leaves', () => {
    const h = harness({ playerAt: vec3(0, 0, -6) });
    const machine = spawnMachine(h.world, {
      name: 'inspection-4',
      yaw: YAW_NEG_Z,
      perception: SIGHT_ONLY,
    });

    h.run(0.4);
    const peak = awarenessOf(machine);
    expect(peak).toBeGreaterThan(0);

    // Step out of the cone: behind the machine, same distance.
    h.playerTransform.position.z = 6;
    h.run(3);

    expect(awarenessOf(machine)).toBe(0);
    expect(h.statesFor('inspection-4')).not.toContain('alert');
    expect(h.statesFor('inspection-4')).not.toContain('pursue');
  });

  it('ignores a player standing outside the cone the whole time', () => {
    const h = harness({ playerAt: vec3(0, 0, 8) });
    const machine = spawnMachine(h.world, { yaw: YAW_NEG_Z, perception: SIGHT_ONLY });

    h.run(4);

    expect(awarenessOf(machine)).toBe(0);
    expect(machine.machineAi!.lastKnownPlayerPosition).toBeNull();
    expect(h.sighted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scenario B — Occlusion (spec 65)
// ---------------------------------------------------------------------------

describe('Scenario B — occlusion', () => {
  it('produces no vision detection through an opaque wall', () => {
    const h = harness({ playerAt: vec3(5, 0, 0), raycast: wallAtX(1) });
    const machine = spawnMachine(h.world, {
      name: 'containment-2',
      yaw: YAW_POS_X,
      perception: SIGHT_ONLY,
    });

    h.run(6);

    expect(awarenessOf(machine)).toBe(0);
    expect(stateOf(machine)).toBe('patrol');
    expect(machine.machineAi!.lastKnownPlayerPosition).toBeNull();
    expect(h.sighted).toEqual([]);
    expect(h.perception.snapshot(machine)!.visible).toBe(false);
    expect(h.perception.isPlayerVisible(machine)).toBe(false);
  });

  it('would have detected the same player with the wall removed', () => {
    // Proves the negative above is caused by the wall, not by a perception
    // system that never detects anything.
    const h = harness({ playerAt: vec3(5, 0, 0), raycast: wallAtX(1) });
    const machine = spawnMachine(h.world, { yaw: YAW_POS_X, perception: SIGHT_ONLY });

    h.run(3);
    expect(awarenessOf(machine)).toBe(0);

    h.perception.setRaycastPort(null);
    h.run(2);

    expect(awarenessOf(machine)).toBeGreaterThanOrEqual(ALERT_AWARENESS);
    expect(h.perception.isPlayerVisible(machine)).toBe(true);
    expect(machine.machineAi!.lastKnownPlayerPosition).toEqual({ x: 5, y: 0, z: 0 });
  });

  it('does not feel the player through a wall at point-blank range', () => {
    // Proximity ignores facing, not concrete. A machine on the far side of a
    // flood door must not notice a player 1.5 m away through it.
    const h = harness({ playerAt: vec3(1.5, 0, 0), raycast: wallAtX(1) });
    const machine = spawnMachine(h.world, {
      // Facing away, so only the proximity sense could possibly fire.
      yaw: YAW_NEG_Z,
      perception: { ...SIGHT_ONLY, proximityRange: 3 },
    });

    h.run(4);
    expect(awarenessOf(machine)).toBe(0);
    expect(h.sighted).toEqual([]);

    // Same geometry, wall gone: proximity fires regardless of facing.
    h.perception.setRaycastPort(null);
    h.run(1);
    expect(h.perception.snapshot(machine)!.lastStimulus).toBe('proximity');
    expect(awarenessOf(machine)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario C — Sound (spec 65)
// ---------------------------------------------------------------------------

describe('Scenario C — sound', () => {
  it('investigates the sound position and does not learn the player position', () => {
    // Player stands behind the machine, out of the cone, where it can never be
    // seen. The only information the machine gets is the noise.
    const playerAt = vec3(0, 0, 10);
    const h = harness({ playerAt });
    const machine = spawnMachine(h.world, {
      name: 'crawler-7',
      yaw: YAW_NEG_Z,
      perception: { ...SIGHT_ONLY, hearingRange: 12 },
    });

    const soundAt = vec3(4, 0, 0);
    const listeners = h.perception.reportSound({ position: soundAt, loudness: 1, tag: 'tray' });
    expect(listeners).toBe(1);
    expect(h.heard).toHaveLength(1);
    expect(h.heard[0]!.position).toEqual(soundAt);

    // The belief is the noise, not the player. This is the whole reason
    // distraction works, and the whole reason the AI is not omniscient.
    const belief = machine.machineAi!.lastKnownPlayerPosition!;
    expect(belief).toEqual(soundAt);
    expect(belief).not.toEqual(playerAt);
    expect(h.perception.snapshot(machine)!.lastStimulus).toBe('sound');

    // Hearing alone never means "found you".
    expect(awarenessOf(machine)).toBeGreaterThan(SUSPICION_AWARENESS);
    expect(awarenessOf(machine)).toBeLessThan(ALERT_AWARENESS);

    h.run(1.2);

    expect(h.statesFor('crawler-7').slice(0, 2)).toEqual(['suspicious', 'inspect']);
    const destination = h.ai.destinationOf(machine)!;
    expect(destination).not.toBeNull();
    expect(distance(destination, soundAt)).toBeLessThan(1e-6);
    expect(distance(destination, playerAt)).toBeGreaterThan(5);
  });

  it('never reaches certainty from noise alone, however much of it there is', () => {
    const h = harness({ playerAt: vec3(0, 0, 10) });
    const machine = spawnMachine(h.world, {
      name: 'crawler-7',
      yaw: YAW_NEG_Z,
      perception: { ...SIGHT_ONLY, hearingRange: 12 },
    });

    for (let i = 0; i < 30; i += 1) {
      h.perception.reportSound({ position: vec3(0.5, 0, 0.5), loudness: 2 });
      h.step();
    }

    expect(awarenessOf(machine)).toBeLessThanOrEqual(SOUND_AWARENESS_CEILING);
    expect(awarenessOf(machine)).toBeLessThan(ALERT_AWARENESS);
    expect(h.statesFor('crawler-7')).not.toContain('alert');
    expect(h.statesFor('crawler-7')).not.toContain('pursue');
  });

  it('does not hear a noise beyond its hearing range', () => {
    const h = harness({ playerAt: vec3(0, 0, 10) });
    const machine = spawnMachine(h.world, {
      perception: { ...SIGHT_ONLY, hearingRange: 12 },
    });

    expect(h.perception.reportSound({ position: vec3(40, 0, 0), loudness: 1 })).toBe(0);
    expect(awarenessOf(machine)).toBe(0);
    expect(machine.machineAi!.lastKnownPlayerPosition).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scenario D — Lost target (spec 65)
// ---------------------------------------------------------------------------

describe('Scenario D — lost target', () => {
  it('moves to the last-known position, searches, then de-escalates', () => {
    const h = harness({ playerAt: vec3(0, 0, -6) });
    const machine = spawnMachine(h.world, {
      name: 'containment-2',
      yaw: YAW_NEG_Z,
      patrolRoute: [vec3(0, 0, 0), vec3(4, 0, 0)],
      perception: SIGHT_ONLY,
    });

    // Seen, alerted, chasing.
    h.run(2.5);
    expect(stateOf(machine)).toBe('pursue');
    expect(machine.machineAi!.lastKnownPlayerPosition).toEqual({ x: 0, y: 0, z: -6 });

    // Break line of sight. The player has not moved; the machine simply cannot
    // see them any more.
    h.perception.setRaycastPort(wallAtZ(-3));
    h.run(1.2);

    expect(stateOf(machine)).toBe('search');
    expect(h.transitions.find((t) => t.to === 'search')!.reason).toBe('sight-lost');
    // It goes to where it last saw the player, which is still correct here —
    // but it is acting on the belief, not on the player's transform.
    const destination = h.ai.destinationOf(machine)!;
    expect(distance(destination, vec3(0, 0, -6))).toBeLessThan(1e-6);

    // Searching outlives the awareness decay: persistence is a state timer.
    h.run(4);
    expect(stateOf(machine)).toBe('search');
    expect(awarenessOf(machine)).toBe(0);

    // ...but it is bounded. standard persistence is 12 s.
    h.run(9);
    expect(h.abandoned).toContain('containment-2');
    expect(machine.machineAi!.lastKnownPlayerPosition).toBeNull();

    // And it eventually goes back to work.
    h.run(6);
    expect(stateOf(machine)).toBe('patrol');
    const states = h.statesFor('containment-2');
    expect(states).toContain('recover');
    expect(states[states.length - 1]).toBe('patrol');
  });

  it('resumes pursuit when it regains sight during a search', () => {
    const h = harness({ playerAt: vec3(0, 0, -6) });
    const machine = spawnMachine(h.world, { yaw: YAW_NEG_Z, perception: SIGHT_ONLY });

    h.run(2.5);
    expect(stateOf(machine)).toBe('pursue');

    h.perception.setRaycastPort(wallAtZ(-3));
    h.run(1.2);
    expect(stateOf(machine)).toBe('search');

    h.perception.setRaycastPort(null);
    h.run(2);
    expect(stateOf(machine)).toBe('pursue');
  });
});

// ---------------------------------------------------------------------------
// Scenario E — Multiple machines (spec 65)
// ---------------------------------------------------------------------------

describe('Scenario E — multiple machines', () => {
  it('propagates one alert to nearby machines and no further', () => {
    const h = harness({ playerAt: vec3(0, 0, -6) });

    // Only the first machine has working sensors, so any escalation elsewhere
    // must have arrived as an alert.
    const source = spawnMachine(h.world, {
      name: 'source',
      position: vec3(0, 0, 0),
      yaw: YAW_NEG_Z,
      perception: SIGHT_ONLY,
    });
    const near = spawnMachine(h.world, {
      name: 'near',
      position: vec3(8, 0, 0),
      perception: SENSORS_OFF,
    });
    // 16 m from the source (outside the 14 m standard radius) but only 8 m from
    // `near` — so if `near` re-broadcast, this one would escalate too.
    const relay = spawnMachine(h.world, {
      name: 'relay-bait',
      position: vec3(16, 0, 0),
      perception: SENSORS_OFF,
    });
    const far = spawnMachine(h.world, {
      name: 'far',
      position: vec3(60, 0, 0),
      perception: SENSORS_OFF,
    });

    h.run(2.4);

    expect(stateOf(source)).toBe('pursue');
    expect(h.alertsRaised).toHaveLength(1);
    expect(h.alertsRaised[0]!.name).toBe('source');
    expect(h.alertsRaised[0]!.notified).toBe(1);
    expect(h.alertsRaised[0]!.radius).toBe(DIFFICULTY_TUNING.standard.alertPropagationRadius);

    // The neighbour searches, knows the belief, and knows it was told.
    expect(stateOf(near)).toBe('search');
    expect(near.machineAi!.lastKnownPlayerPosition).toEqual({ x: 0, y: 0, z: -6 });
    expect(h.ai.wasAlertedByPeer(near)).toBe(true);
    expect(h.alertsReceived.map((a) => a.name)).toEqual(['near']);
    expect(h.alertsReceived[0]!.from).toBe('source');

    // No hive mind: the alert did not chain through the neighbour, and it did
    // not reach the far side of the sector.
    expect(stateOf(relay)).toBe('patrol');
    expect(relay.machineAi!.lastKnownPlayerPosition).toBeNull();
    expect(stateOf(far)).toBe('patrol');
    expect(awarenessOf(far)).toBe(0);
    expect(h.ai.wasAlertedByPeer(far)).toBe(false);
  });

  it('does not let an alerted machine become certain on its own', () => {
    // A relayed alert must land below the alert threshold, otherwise the
    // recipient escalates to `alert` on its next step and re-broadcasts.
    const h = harness({ playerAt: vec3(0, 0, -6) });
    spawnMachine(h.world, { name: 'source', yaw: YAW_NEG_Z, perception: SIGHT_ONLY });
    const near = spawnMachine(h.world, {
      name: 'near',
      position: vec3(6, 0, 0),
      perception: SENSORS_OFF,
    });

    h.run(6);

    expect(awarenessOf(near)).toBeLessThan(ALERT_AWARENESS);
    expect(h.statesFor('near')).not.toContain('alert');
    expect(h.alertsRaised.map((a) => a.name)).toEqual(['source']);
  });

  it('skips machines that are already searching or disabled', () => {
    const h = harness({ playerAt: vec3(0, 0, -6) });
    spawnMachine(h.world, { name: 'source', yaw: YAW_NEG_Z, perception: SIGHT_ONLY });
    const down = spawnMachine(h.world, {
      name: 'down',
      position: vec3(5, 0, 0),
      state: 'disabled',
      perception: SENSORS_OFF,
    });

    h.run(2.0);

    expect(h.alertsRaised[0]!.notified).toBe(0);
    expect(stateOf(down)).toBe('disabled');
    expect(down.machineAi!.lastKnownPlayerPosition).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scenario F — Save / reload (spec 65)
// ---------------------------------------------------------------------------

describe('Scenario F — save and reload', () => {
  /** Spawns the three machines a sector loader would, in a fresh world. */
  function loadSector(h: ReturnType<typeof harness>) {
    return {
      patroller: spawnMachine(h.world, {
        name: 'patroller',
        id: 'machine.pump12.patroller',
        position: vec3(0, 0, 0),
        patrolRoute: [vec3(0, 0, 0), vec3(6, 0, 0), vec3(6, 0, 6)],
        perception: SENSORS_OFF,
      }),
      searcher: spawnMachine(h.world, {
        name: 'searcher',
        id: 'machine.pump12.searcher',
        position: vec3(20, 0, 0),
        perception: SENSORS_OFF,
      }),
      chaser: spawnMachine(h.world, {
        name: 'chaser',
        id: 'machine.pump12.chaser',
        position: vec3(40, 0, 0),
        patrolRoute: [vec3(40, 0, 0), vec3(44, 0, 0)],
        perception: SENSORS_OFF,
      }),
    };
  }

  function saveState(): MachineAiSnapshot[] {
    const h = harness({ playerAt: vec3(0, 0, -80) });
    const machines = loadSector(h);

    // Mid-patrol.
    h.run(0.5);
    // Mid-search, with a belief.
    machines.searcher.machineAi!.state = 'search';
    machines.searcher.machineAi!.stateTime = 3;
    machines.searcher.machineAi!.awareness = 0.5;
    machines.searcher.machineAi!.lastKnownPlayerPosition = vec3(22, 0, 4);
    // Mid-pursuit — a claim no save can honour.
    machines.chaser.machineAi!.state = 'pursue';
    machines.chaser.machineAi!.awareness = 1;
    machines.chaser.machineAi!.lastKnownPlayerPosition = vec3(41, 0, 2);
    machines.chaser.machineAi!.patrolIndex = 99;

    return h.ai.captureSnapshots();
  }

  it('captures only machines with an authored persistent id', () => {
    const h = harness();
    spawnMachine(h.world, { name: 'anonymous' });
    spawnMachine(h.world, { name: 'named', id: 'machine.named' });

    const snapshots = h.ai.captureSnapshots();
    expect(snapshots.map((s) => s.id)).toEqual(['machine.named']);
  });

  it('restores a valid state with no null nav agent and no duplicated entity', () => {
    const snapshots = saveState();
    expect(snapshots).toHaveLength(3);

    // Reload: a brand-new world with the sector spawned fresh.
    const h = harness({ playerAt: vec3(0, 0, -80) });
    const machines = loadSector(h);
    const countBefore = h.world.entityCount;

    const report = h.ai.restoreSnapshots(snapshots);

    expect(report.restored).toHaveLength(3);
    expect(report.unmatched).toEqual([]);
    // No duplicated entity: restore adopts, it never spawns.
    expect(h.world.entityCount).toBe(countBefore);
    expect(h.world.machines.entities).toHaveLength(3);

    // Every restored machine is in a state the state machine can actually run,
    // with a nav agent that is present and coherent.
    for (const entity of h.world.machines.entities) {
      const ai = entity.machineAi!;
      expect(isMachineState(ai.state)).toBe(true);
      expect(ai.awareness).toBeGreaterThanOrEqual(0);
      expect(ai.awareness).toBeLessThanOrEqual(1);
      expect(ai.patrolIndex).toBeGreaterThanOrEqual(0);
      if (ai.patrolRoute.length > 0) {
        expect(ai.patrolIndex).toBeLessThan(ai.patrolRoute.length);
      }
      const agent = entity.navAgent!;
      expect(agent).toBeDefined();
      expect(agent.path).toHaveLength(0);
      expect(agent.pathIndex).toBe(0);
    }

    // A movement state must have somewhere to go.
    expect(machines.patroller.navAgent!.destination).not.toBeNull();
    expect(machines.searcher.navAgent!.destination).toEqual({ x: 22, y: 0, z: 4 });
    expect(machines.searcher.navAgent!.arrived).toBe(false);

    // `pursue` cannot survive a reload: nothing has been perceived yet.
    expect(stateOf(machines.chaser)).toBe('search');
    expect(machines.chaser.navAgent!.destination).toEqual({ x: 41, y: 0, z: 2 });
    expect(report.repaired).toContain('machine.pump12.chaser');
    expect(machines.chaser.machineAi!.patrolIndex).toBeLessThan(2);

    // And the restored world keeps running without throwing.
    h.run(1);
    expect(stateOf(machines.patroller)).toBe('patrol');
    expect(stateOf(machines.searcher)).toBe('search');
  });

  it('is idempotent: replaying a payload changes nothing and duplicates nothing', () => {
    const snapshots = saveState();
    const h = harness({ playerAt: vec3(0, 0, -80) });
    loadSector(h);

    const first = h.ai.restoreSnapshots(snapshots);
    const countAfterFirst = h.world.entityCount;
    const second = h.ai.restoreSnapshots(snapshots);

    expect(second.restored).toEqual(first.restored);
    expect(h.world.entityCount).toBe(countAfterFirst);
    expect(h.world.machines.entities).toHaveLength(3);
  });

  it('applies a duplicated id once and reports ids it cannot match', () => {
    const h = harness();
    const machine = spawnMachine(h.world, {
      name: 'patroller',
      id: 'machine.a',
      patrolRoute: [vec3(0, 0, 0), vec3(3, 0, 0)],
      perception: SENSORS_OFF,
    });

    const snapshot: MachineAiSnapshot = {
      id: 'machine.a',
      state: 'inspect',
      stateTime: 1,
      awareness: 0.4,
      patrolIndex: 1,
      lastKnownPlayerPosition: vec3(2, 0, 2),
    };

    const report = h.ai.restoreSnapshots([
      snapshot,
      { ...snapshot, awareness: 0.9 },
      { ...snapshot, id: 'machine.gone' },
    ]);

    expect(report.restored).toEqual(['machine.a']);
    expect(report.unmatched).toEqual(['machine.gone']);
    // The second copy of the id was ignored, so the first one's value stands.
    expect(awarenessOf(machine)).toBeCloseTo(0.4, 6);
    expect(h.world.machines.entities).toHaveLength(1);
  });

  it('repairs an unknown stored state instead of freezing the machine', () => {
    const h = harness();
    const machine = spawnMachine(h.world, {
      id: 'machine.a',
      patrolRoute: [vec3(0, 0, 0), vec3(3, 0, 0)],
      perception: SENSORS_OFF,
    });

    const report = h.ai.restoreSnapshots([
      {
        id: 'machine.a',
        // A state from a content version that no longer exists.
        state: 'hunting' as MachineState,
        stateTime: 2,
        awareness: 5,
        patrolIndex: -3,
        lastKnownPlayerPosition: null,
      },
    ]);

    expect(report.repaired).toEqual(['machine.a']);
    expect(stateOf(machine)).toBe('patrol');
    // An out-of-range awareness is treated as corrupt and dropped, not clamped
    // up to certainty — otherwise a bad save hands the machine a free detection.
    expect(awarenessOf(machine)).toBe(0);
    expect(machine.machineAi!.patrolIndex).toBe(0);
    expect(machine.navAgent!.destination).not.toBeNull();

    h.run(1);
    expect(stateOf(machine)).toBe('patrol');
  });
});

// ---------------------------------------------------------------------------
// Awareness model
// ---------------------------------------------------------------------------

describe('awareness accumulator', () => {
  it('ramps rather than snapping to detection', () => {
    const h = harness({ playerAt: vec3(0, 0, -5) });
    const machine = spawnMachine(h.world, {
      yaw: YAW_NEG_Z,
      perception: { ...SIGHT_ONLY, timeToDetect: 1.5 },
    });

    h.step();
    const afterOneStep = awarenessOf(machine);
    expect(afterOneStep).toBeGreaterThan(0);
    expect(afterOneStep).toBeLessThan(0.05);

    const samples: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      h.run(0.25);
      samples.push(awarenessOf(machine));
    }

    // Strictly increasing, still short of certainty half way through the ramp.
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]!).toBeGreaterThan(samples[i - 1]!);
    }
    expect(samples[1]!).toBeGreaterThan(0.2);
    expect(samples[1]!).toBeLessThan(0.6);
    expect(samples[3]!).toBeLessThan(ALERT_AWARENESS);

    // And it does reach 1, at roughly timeToDetect.
    h.run(0.6);
    expect(awarenessOf(machine)).toBe(1);
  });

  it('decays when the player is no longer visible', () => {
    const h = harness({ playerAt: vec3(0, 0, -5) });
    const machine = spawnMachine(h.world, { yaw: YAW_NEG_Z, perception: SIGHT_ONLY });

    h.run(0.6);
    const peak = awarenessOf(machine);
    expect(peak).toBeGreaterThan(0.3);

    h.playerTransform.position.z = 5;
    h.run(0.5);
    const decayed = awarenessOf(machine);
    expect(decayed).toBeLessThan(peak);
    expect(decayed).toBeGreaterThan(0);

    h.run(3);
    expect(awarenessOf(machine)).toBe(0);
  });

  it('fills at the same rate whether the machine ticks fast or slowly', () => {
    // The distance throttle must change cost, never difficulty. A far machine
    // pulled into vision range would otherwise detect more slowly on potato.
    const fast = harness({ playerAt: vec3(0, 0, -5), aiFarUpdateHz: 15 });
    const slow = harness({ playerAt: vec3(0, 0, -5), aiFarUpdateHz: 2 });
    const a = spawnMachine(fast.world, { yaw: YAW_NEG_Z, perception: SIGHT_ONLY });
    const b = spawnMachine(slow.world, { yaw: YAW_NEG_Z, perception: SIGHT_ONLY });

    fast.run(1.0);
    slow.run(1.0);

    expect(awarenessOf(a)).toBeCloseTo(awarenessOf(b), 5);
  });
});

// ---------------------------------------------------------------------------
// Difficulty (spec 7.5)
// ---------------------------------------------------------------------------

describe('difficulty scaling', () => {
  it('changes detection forgiveness, not health', () => {
    const results: Record<MachineDifficulty, number> = {
      story: 0,
      standard: 0,
      demanding: 0,
    };

    for (const level of ['story', 'standard', 'demanding'] as const) {
      const h = harness({ playerAt: vec3(0, 0, -5), difficulty: level });
      const machine = spawnMachine(h.world, { yaw: YAW_NEG_Z, perception: SIGHT_ONLY });
      h.run(0.75);
      results[level] = awarenessOf(machine);
    }

    expect(results.story).toBeLessThan(results.standard);
    expect(results.standard).toBeLessThan(results.demanding);

    // The tuning table has no health or damage dimension at all — difficulty
    // cannot be implemented as a hit-point multiplier here.
    for (const tuning of Object.values(DIFFICULTY_TUNING)) {
      expect(Object.keys(tuning).sort()).toEqual([
        'alertPropagationRadius',
        'awarenessDecayScale',
        'detectionForgiveness',
        'reactionTime',
        'recoveryWindow',
        'searchPersistence',
      ]);
    }
  });

  it('changes search persistence', () => {
    const runSearch = (level: MachineDifficulty, seconds: number): MachineState => {
      const h = harness({ playerAt: vec3(0, 0, -6), difficulty: level });
      const machine = spawnMachine(h.world, {
        yaw: YAW_NEG_Z,
        patrolRoute: [vec3(0, 0, 0), vec3(4, 0, 0)],
        perception: SIGHT_ONLY,
      });
      h.run(4);
      h.perception.setRaycastPort(wallAtZ(-3));
      h.run(1.5);
      expect(stateOf(machine)).toBe('search');
      h.run(seconds);
      return stateOf(machine);
    };

    // story persistence is 6 s, demanding is 20 s.
    expect(runSearch('story', 8)).not.toBe('search');
    expect(runSearch('demanding', 8)).toBe('search');
  });

  it('changes alert reach', () => {
    const reached = (level: MachineDifficulty): boolean => {
      const h = harness({ playerAt: vec3(0, 0, -6), difficulty: level });
      spawnMachine(h.world, { name: 'source', yaw: YAW_NEG_Z, perception: SIGHT_ONLY });
      const peer = spawnMachine(h.world, {
        name: 'peer',
        position: vec3(12, 0, 0),
        perception: SENSORS_OFF,
      });
      h.run(2.2);
      return stateOf(peer) === 'search';
    };

    // 10 m on story, 14 m on standard: a peer at 12 m is inside one and not
    // the other.
    expect(reached('story')).toBe(false);
    expect(reached('standard')).toBe(true);
  });

  it('takes effect mid-session', () => {
    const h = harness({ playerAt: vec3(0, 0, -5), difficulty: 'story' });
    expect(h.perception.difficulty).toBe('story');
    expect(h.perception.tuning.searchPersistence).toBe(DIFFICULTY_TUNING.story.searchPersistence);

    h.difficulty.set('demanding');
    expect(h.perception.difficulty).toBe('demanding');
    expect(h.ai.tuning.reactionTime).toBe(DIFFICULTY_TUNING.demanding.reactionTime);
  });
});

// ---------------------------------------------------------------------------
// Disabled machines
// ---------------------------------------------------------------------------

describe('disabled machines', () => {
  it('stop perceiving entirely', () => {
    const h = harness({ playerAt: vec3(0, 0, -5) });
    const machine = spawnMachine(h.world, {
      name: 'crawler-7',
      yaw: YAW_NEG_Z,
      perception: { ...SIGHT_ONLY, hearingRange: 12 },
    });

    h.ai.disable(machine);
    const evaluationsAtDisable = h.perception.snapshot(machine)?.evaluations ?? 0;

    h.run(4);

    expect(stateOf(machine)).toBe('disabled');
    expect(awarenessOf(machine)).toBe(0);
    expect(h.sighted).toEqual([]);
    expect(h.perception.snapshot(machine)?.evaluations ?? 0).toBe(evaluationsAtDisable);
    expect(h.perception.isPlayerVisible(machine)).toBe(false);

    // Deaf as well as blind.
    expect(h.perception.reportSound({ position: vec3(0, 0, 0), loudness: 2 })).toBe(0);
    expect(awarenessOf(machine)).toBe(0);
  });

  it('resume duty when the disable window closes', () => {
    const h = harness({ playerAt: vec3(0, 0, 40) });
    const machine = spawnMachine(h.world, {
      name: 'crawler-7',
      patrolRoute: [vec3(0, 0, 0), vec3(4, 0, 0)],
      perception: SIGHT_ONLY,
    });

    h.ai.disable(machine, 2);
    h.run(1);
    expect(stateOf(machine)).toBe('disabled');
    expect(h.ai.disabledSecondsRemaining(machine)).toBeGreaterThan(0);

    h.run(1.5);
    expect(stateOf(machine)).toBe('recover');
    expect(h.ai.disabledSecondsRemaining(machine)).toBe(0);

    h.run(6);
    expect(stateOf(machine)).toBe('patrol');
  });

  it('stay down indefinitely until woken', () => {
    const h = harness({ playerAt: vec3(0, 0, 40) });
    const machine = spawnMachine(h.world, {
      patrolRoute: [vec3(0, 0, 0), vec3(4, 0, 0)],
      perception: SIGHT_ONLY,
    });

    h.ai.disable(machine);
    h.run(30);
    expect(stateOf(machine)).toBe('disabled');

    h.ai.wake(machine);
    h.run(6);
    expect(stateOf(machine)).toBe('patrol');
  });
});

// ---------------------------------------------------------------------------
// Cost: the distance throttle
// ---------------------------------------------------------------------------

describe('perception throttling', () => {
  it('evaluates far machines less often than near ones', () => {
    const h = harness({ playerAt: vec3(0, 0, 0), aiFarUpdateHz: 2 });
    const near = spawnMachine(h.world, { name: 'near', position: vec3(5, 0, 0) });
    const far = spawnMachine(h.world, { name: 'far', position: vec3(60, 0, 0) });

    h.run(1);

    const nearEvaluations = h.perception.snapshot(near)!.evaluations;
    const farEvaluations = h.perception.snapshot(far)!.evaluations;

    // Near band is 20 Hz; the far band is the preset's aiFarUpdateHz.
    expect(nearEvaluations).toBeGreaterThanOrEqual(18);
    expect(nearEvaluations).toBeLessThanOrEqual(22);
    expect(farEvaluations).toBeGreaterThanOrEqual(1);
    expect(farEvaluations).toBeLessThanOrEqual(3);
    expect(farEvaluations).toBeLessThan(nearEvaluations);
  });

  it('follows the quality preset for the far band', () => {
    const cheap = harness({ aiFarUpdateHz: 2 });
    const rich = harness({ aiFarUpdateHz: 15 });
    const a = spawnMachine(cheap.world, { position: vec3(60, 0, 0) });
    const b = spawnMachine(rich.world, { position: vec3(60, 0, 0) });

    cheap.run(1);
    rich.run(1);

    expect(rich.perception.snapshot(b)!.evaluations).toBeGreaterThan(
      cheap.perception.snapshot(a)!.evaluations,
    );
  });

  it('upgrades a machine to the near rate as the player approaches', () => {
    const h = harness({ playerAt: vec3(60, 0, 0), aiFarUpdateHz: 2 });
    const machine = spawnMachine(h.world, { position: vec3(0, 0, 0) });

    h.run(1);
    const whileFar = h.perception.snapshot(machine)!.evaluations;

    h.playerTransform.position.x = 4;
    h.run(1);
    const afterApproach = h.perception.snapshot(machine)!.evaluations - whileFar;

    expect(afterApproach).toBeGreaterThan(whileFar);
  });

  it('does not freeze machines when a preset reports a nonsensical rate', () => {
    const h = harness({ aiFarUpdateHz: 0 });
    const machine = spawnMachine(h.world, { position: vec3(60, 0, 0) });

    h.run(2);
    expect(h.perception.snapshot(machine)!.evaluations).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Patrol
// ---------------------------------------------------------------------------

describe('patrol routes', () => {
  it('advances through authored waypoints and wraps', () => {
    const h = harness({ playerAt: vec3(0, 0, 90) });
    const route = [vec3(0, 0, 0), vec3(6, 0, 0), vec3(6, 0, 6)];
    const machine = spawnMachine(h.world, { patrolRoute: route, perception: SENSORS_OFF });

    // Starts on waypoint 0, so the first step advances to waypoint 1.
    h.step();
    expect(machine.machineAi!.patrolIndex).toBe(1);
    expect(h.ai.destinationOf(machine)).toEqual({ x: 6, y: 0, z: 0 });

    // The follower does not exist yet, so move the machine the way one would.
    machine.transform!.position = vec3(6, 0, 0);
    h.step();
    expect(machine.machineAi!.patrolIndex).toBe(2);

    machine.transform!.position = vec3(6, 0, 6);
    h.step();
    expect(machine.machineAi!.patrolIndex).toBe(0);
    expect(h.ai.destinationOf(machine)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('keeps a nav agent path stable while walking to the same waypoint', () => {
    const h = harness({ playerAt: vec3(0, 0, 90) });
    const machine = spawnMachine(h.world, {
      position: vec3(0, 0, 0),
      patrolRoute: [vec3(0, 0, 0), vec3(20, 0, 0)],
      perception: SENSORS_OFF,
    });

    h.step();
    // A follower would fill this in; re-issuing the destination must not clear
    // it every step or the machine restarts forever.
    machine.navAgent!.path = [vec3(5, 0, 0), vec3(20, 0, 0)];
    machine.navAgent!.pathIndex = 1;
    h.run(1);

    expect(machine.navAgent!.path).toHaveLength(2);
    expect(machine.navAgent!.pathIndex).toBe(1);
    expect(machine.navAgent!.destination).toEqual({ x: 20, y: 0, z: 0 });
  });

  it('leaves a machine with no route parked rather than drifting', () => {
    const h = harness({ playerAt: vec3(0, 0, 90) });
    const machine = spawnMachine(h.world, { perception: SENSORS_OFF });

    h.run(2);
    expect(stateOf(machine)).toBe('patrol');
    expect(h.ai.destinationOf(machine)).toBeNull();
  });

  it('wakes a dormant machine on a stimulus and works without a nav agent', () => {
    const h = harness({ playerAt: vec3(0, 0, -5) });
    const machine = spawnMachine(h.world, {
      name: 'gate-frame-1',
      state: 'dormant',
      yaw: YAW_NEG_Z,
      navAgent: false,
      perception: SIGHT_ONLY,
    });

    h.run(2.4);

    expect(machine.navAgent).toBeUndefined();
    expect(h.statesFor('gate-frame-1').slice(0, 3)).toEqual([
      'suspicious',
      'inspect',
      'alert',
    ]);
    expect(h.ai.destinationOf(machine)).not.toBeNull();
  });
});
