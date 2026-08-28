/**
 * Machine behaviour — the nine-state machine from spec 7.3, driven by what
 * {@link PerceptionSystem} was able to sense and by nothing else.
 *
 * The danger in Morrow Quay is municipal maintenance hardware running emergency
 * access rules off corrupted maps (spec 7.2). It is not a soldier. So this
 * system models escalation and de-escalation rather than combat: a machine
 * notices, hesitates, goes to look, calls it in, hunts for a while, and stands
 * down. Combat remains non-graphic and no weapon behaviour is modelled here.
 *
 * Two rules the spec states negatively, both structural in this file:
 *
 *   - **No omniscience.** This system never reads the player's transform. It
 *     acts on `MachineAi.lastKnownPlayerPosition`, which is a *belief* written
 *     by perception, and on `MachineAi.awareness`. A machine chasing a thrown
 *     tool tray is behaving correctly.
 *   - **No map-wide hive mind.** An alert propagates once, to machines inside
 *     the difficulty's `alertPropagationRadius` of the machine that raised it,
 *     and recipients enter `search` rather than `alert` — so they cannot
 *     re-broadcast and the alert cannot chain across a sector.
 *
 * Difficulty (spec 7.5) changes detection forgiveness, search persistence,
 * reaction time, recovery windows and alert reach. It does not multiply health;
 * there is no health field in the tuning table at all.
 *
 * Movement is expressed as a destination, written into `NavAgent` when the
 * machine has one. Pathfinding and locomotion belong elsewhere; re-targeting a
 * moving target is throttled through `NavAgent.repathCooldown` so pursuit never
 * turns into per-frame pathfinding (spec 7.4).
 */

import type { GameWorld, System } from '../../engine/ecs/GameWorld';
import {
  distanceSquared,
  planarDistanceSquared,
  vec3,
  type Entity,
  type MachineAi,
  type MachineState,
  type Perception,
  type Transform,
  type Vec3,
} from '../../engine/ecs/components';
import { Emitter, type Handler, type Unsubscribe } from '../../engine/events';
import {
  createStaticDifficulty,
  difficultyTuning,
  type DifficultyTuning,
  type MachineDifficultyPort,
} from './PerceptionSystem';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * The slice of perception this system needs.
 *
 * Declared locally rather than importing the concrete class so behaviour can be
 * driven by a fake in tests — `PerceptionSystem` satisfies it structurally.
 * Deliberately tiny: awareness and the belief already live on the component, so
 * the only things worth asking are "can it see the player right now" and "has
 * anything new arrived since I last looked".
 */
export interface MachinePerceptionPort {
  /** Confirmed by sight or proximity at the most recent evaluation. */
  isPlayerVisible(entity: Entity): boolean;
  /**
   * Monotonic count of fresh stimuli. This system compares it against the value
   * it last acted on; the absolute number is meaningless to it.
   */
  stimulusCount(entity: Entity): number;
  /** Optional. Clears sensory bookkeeping, used when restoring a save. */
  forget?(entity: Entity): void;
}

/** A perception port that senses nothing. For boot order and focused tests. */
export function createBlindPerception(): MachinePerceptionPort {
  return {
    isPlayerVisible: () => false,
    stimulusCount: () => 0,
  };
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Awareness at which a machine stops what it is doing and looks up.
 *
 * Low on purpose: the interesting failure is a machine that noticed *something*
 * and is now inconveniently curious, not one that flips from oblivious to
 * hunting. Spec 65 Scenario A requires the player crossing a cone to produce
 * suspicion and an inspection *before* any alert.
 */
export const SUSPICION_AWARENESS = 0.25;

/** Awareness at which the machine is certain. Escalates to `alert`. */
export const ALERT_AWARENESS = 1;

/**
 * Awareness below which a curious machine gives up and stands down.
 *
 * Below the suspicion threshold, so a machine hovering at the boundary cannot
 * oscillate between `patrol` and `suspicious` every step.
 */
export const DEESCALATE_AWARENESS = 0.1;

/**
 * Awareness handed to a machine that receives an alert from a peer.
 *
 * Strictly below {@link ALERT_AWARENESS}: a relayed alert makes a machine
 * search, it does not make it certain. If it were 1 the recipient would
 * immediately escalate to `alert` itself and re-broadcast, which is precisely
 * the map-wide hive mind spec 65 Scenario E forbids.
 */
export const ALERT_RELAY_AWARENESS = 0.6;

/**
 * Seconds of broken line of sight tolerated before a pursuit becomes a search.
 *
 * A pillar, a passing crawler or a doorway should not convert a chase into a
 * shrug; a corner turned deliberately should.
 */
export const SIGHT_LOSS_GRACE_S = 0.75;

/** Metres from a destination at which a machine counts as arrived. */
export const ARRIVE_RADIUS_M = 0.6;

/** Metres around the last-known position that a search sweeps. */
export const SEARCH_RADIUS_M = 4;

/** Seconds between re-targeting a moving target during pursuit. */
export const PURSUIT_REPATH_S = 0.5;

/**
 * Deterministic sweep offsets, in units of {@link SEARCH_RADIUS_M}.
 *
 * Deterministic rather than random: spec 65 asks for repeatable benchmark
 * scenarios, and a machine that searches the same way twice is also a machine
 * the player can learn to read.
 */
const SEARCH_OFFSETS: readonly Vec3[] = [
  { x: 1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: -1 },
  { x: 0.7, y: 0, z: 0.7 },
  { x: -0.7, y: 0, z: 0.7 },
  { x: -0.7, y: 0, z: -0.7 },
  { x: 0.7, y: 0, z: -0.7 },
];

/**
 * Below this squared separation two destinations are the same place.
 *
 * Re-issuing an identical destination would clear the nav agent's path every
 * step, so a follower would restart before it ever walked anywhere.
 */
const DESTINATION_EPSILON_SQ = 1e-4;

/**
 * Escalation order, used to decide whether an incoming alert tells a machine
 * anything it does not already know.
 *
 * `components.ts` documents the state union as "ordered roughly by escalation";
 * this makes the comparison explicit rather than relying on declaration order.
 */
export const ESCALATION_RANK: Readonly<Record<MachineState, number>> = Object.freeze({
  disabled: -1,
  dormant: 0,
  patrol: 1,
  recover: 2,
  suspicious: 3,
  inspect: 4,
  search: 5,
  alert: 6,
  pursue: 7,
});

/**
 * Whether a value is a state this system knows how to run.
 *
 * Used on save data, which is untrusted: a save written by an older content
 * version can name a state that no longer exists, and running the state machine
 * on an unknown string would leave a machine frozen forever.
 */
export function isMachineState(value: unknown): value is MachineState {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ESCALATION_RANK, value);
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** Why a machine changed state. Surfaced so the reason is inspectable. */
export type MachineTransitionReason =
  /** A sense produced something new. */
  | 'stimulus'
  /** Awareness crossed a threshold. */
  | 'escalated'
  /** The reaction delay elapsed. */
  | 'reaction'
  /** Reached the destination it was moving to. */
  | 'arrived'
  /** A state's own time limit expired. */
  | 'timeout'
  /** Line of sight was broken for longer than the grace period. */
  | 'sight-lost'
  | 'sight-regained'
  /** Another machine's alert reached this one. */
  | 'alerted-by-peer'
  /** Awareness fell below the de-escalation threshold. */
  | 'de-escalated'
  /** Temporarily disabled by the player. */
  | 'disabled'
  /** A disable window ended. */
  | 'restored'
  /** State came from a save and was adjusted to something safe. */
  | 'restored-from-save'
  | 'woken';

/**
 * Declared as a type alias, not an interface: TypeScript only infers an
 * implicit index signature for aliases, which the `EventMap` constraint needs.
 */
export type MachineAiEvents = {
  'state-changed': {
    entity: Entity;
    from: MachineState;
    to: MachineState;
    reason: MachineTransitionReason;
  };
  /** A machine reached certainty and called it in. */
  'alert-raised': {
    entity: Entity;
    /** The belief being broadcast, or null when there is nothing to share. */
    position: Vec3 | null;
    /** How many peers were inside the bounded radius. */
    notified: number;
    radius: number;
  };
  'alert-received': { entity: Entity; from: Entity; position: Vec3 };
  /** A search ran out of persistence. The machine is standing down. */
  'search-abandoned': { entity: Entity; searchedFor: number };
};

/** The slice of a machine's state that belongs in a save. */
export interface MachineAiSnapshot {
  /** The authored `Persistent.id`. Generated ids cannot be matched on reload. */
  readonly id: string;
  readonly state: MachineState;
  readonly stateTime: number;
  readonly awareness: number;
  readonly patrolIndex: number;
  readonly lastKnownPlayerPosition: Vec3 | null;
}

/** What `restoreSnapshots` did, so a caller can log or assert on it. */
export interface MachineRestoreReport {
  /** Ids applied, in order. Each id is applied at most once. */
  readonly restored: readonly string[];
  /** Ids with no matching machine in the world. */
  readonly unmatched: readonly string[];
  /** Ids whose stored state was adjusted to something safe. */
  readonly repaired: readonly string[];
}

export interface MachineAiSystemOptions {
  readonly world: GameWorld;
  readonly perception?: MachinePerceptionPort;
  readonly difficulty?: MachineDifficultyPort;
  readonly arriveRadius?: number;
  readonly searchRadius?: number;
  readonly sightLossGrace?: number;
  readonly pursuitRepathInterval?: number;
}

/** The entity shape the `machines` query guarantees. */
type MachineEntity = Entity & {
  transform: Transform;
  machineAi: MachineAi;
  perception: Perception;
};

/** Per-machine bookkeeping this system owns. Derived, never saved. */
interface MachineRuntime {
  /** The `stimulusCount` value already acted on. */
  actedStimulus: number;
  /** Seconds of broken sight during a pursuit. */
  sightLostFor: number;
  /** Index into {@link SEARCH_OFFSETS}. */
  searchStep: number;
  /** Seconds left of a forced disable. */
  disabledFor: number;
  /** True when the current escalation came from a peer, not from its own senses. */
  fromAlert: boolean;
  /** Last commanded destination. Mirrored into `NavAgent` when present. */
  destination: Vec3 | null;
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export class MachineAiSystem implements System {
  readonly name = 'machine-ai';

  private readonly emitter = new Emitter<MachineAiEvents>();

  private readonly world: GameWorld;
  private readonly arriveRadiusSq: number;
  private readonly searchRadius: number;
  private readonly sightLossGrace: number;
  private readonly pursuitRepathInterval: number;

  private perception: MachinePerceptionPort;
  private difficultyPort: MachineDifficultyPort;

  /**
   * Keyed weakly: a machine removed by a sector unload must not keep its
   * behaviour bookkeeping alive, and every pass walks the `machines` query
   * rather than this map.
   */
  private readonly runtimes = new WeakMap<Entity, MachineRuntime>();

  constructor(options: MachineAiSystemOptions) {
    this.world = options.world;
    this.perception = options.perception ?? createBlindPerception();
    this.difficultyPort = options.difficulty ?? createStaticDifficulty('standard');
    const arriveRadius = options.arriveRadius ?? ARRIVE_RADIUS_M;
    this.arriveRadiusSq = arriveRadius * arriveRadius;
    this.searchRadius = options.searchRadius ?? SEARCH_RADIUS_M;
    this.sightLossGrace = options.sightLossGrace ?? SIGHT_LOSS_GRACE_S;
    this.pursuitRepathInterval = options.pursuitRepathInterval ?? PURSUIT_REPATH_S;
  }

  // ---- Subscription -----------------------------------------------------

  on<K extends keyof MachineAiEvents>(
    event: K,
    handler: Handler<MachineAiEvents[K]>,
  ): Unsubscribe {
    return this.emitter.on(event, handler);
  }

  off<K extends keyof MachineAiEvents>(event: K, handler: Handler<MachineAiEvents[K]>): void {
    this.emitter.off(event, handler);
  }

  // ---- Configuration ---------------------------------------------------

  setPerceptionPort(port: MachinePerceptionPort): void {
    this.perception = port;
  }

  setDifficultyPort(port: MachineDifficultyPort): void {
    this.difficultyPort = port;
  }

  get tuning(): DifficultyTuning {
    return difficultyTuning(this.difficultyPort.difficulty());
  }

  dispose(): void {
    this.emitter.clear();
  }

  // ---- Read model ------------------------------------------------------

  /** The destination the machine was last told to move to, or null. */
  destinationOf(entity: Entity): Vec3 | null {
    const destination = this.runtimes.get(entity)?.destination ?? null;
    return destination ? { ...destination } : null;
  }

  /** Seconds left of a temporary disable, or 0. */
  disabledSecondsRemaining(entity: Entity): number {
    return Math.max(0, this.runtimes.get(entity)?.disabledFor ?? 0);
  }

  /**
   * Whether this machine's current escalation came from a peer's alert rather
   * than from its own senses. Cleared when it stands down.
   */
  wasAlertedByPeer(entity: Entity): boolean {
    return this.runtimes.get(entity)?.fromAlert ?? false;
  }

  // ---- Player-facing verbs (spec 7.2) ----------------------------------

  /**
   * Temporarily disables a machine — the "temporarily disable" verb from spec
   * 7.2, non-graphic by construction: the machine stops sensing and moving, and
   * comes back with whatever it believed when it went down.
   *
   * @param seconds How long. Non-finite or non-positive means indefinite, and
   *   the machine stays down until {@link wake} is called.
   */
  disable(entity: Entity, seconds = Infinity): void {
    const machine = entity as MachineEntity;
    if (!machine.machineAi) return;
    const runtime = this.runtimeFor(entity);
    runtime.disabledFor = Number.isFinite(seconds) && seconds > 0 ? seconds : Infinity;
    runtime.sightLostFor = 0;
    this.commandDestination(machine, runtime, null);
    if (machine.machineAi.state !== 'disabled') {
      this.transition(machine, runtime, 'disabled', 'disabled');
    }
  }

  /** Brings a disabled or dormant machine back on duty. */
  wake(entity: Entity): void {
    const machine = entity as MachineEntity;
    if (!machine.machineAi) return;
    const state = machine.machineAi.state;
    if (state !== 'disabled' && state !== 'dormant') return;
    const runtime = this.runtimeFor(entity);
    runtime.disabledFor = 0;
    this.transition(machine, runtime, 'recover', 'woken');
  }

  // ---- Simulation ------------------------------------------------------

  fixedUpdate(dt: number): void {
    const tuning = this.tuning;

    for (const entity of this.world.machines.entities) {
      const machine = entity as MachineEntity;
      const ai = machine.machineAi;
      const runtime = this.runtimeFor(entity);

      ai.stateTime += dt;
      if (machine.navAgent && machine.navAgent.repathCooldown > 0) {
        machine.navAgent.repathCooldown -= dt;
      }

      if (ai.state === 'disabled') {
        // Indefinite disables wait for `wake`; timed ones stand themselves up.
        if (runtime.disabledFor !== Infinity) {
          runtime.disabledFor -= dt;
          if (runtime.disabledFor <= 0) {
            runtime.disabledFor = 0;
            this.transition(machine, runtime, 'recover', 'restored');
          }
        }
        continue;
      }

      const visible = this.perception.isPlayerVisible(entity);
      const stimulus = this.perception.stimulusCount(entity);
      const fresh = stimulus > runtime.actedStimulus;
      runtime.actedStimulus = stimulus;

      switch (ai.state) {
        case 'dormant':
          this.tickDormant(machine, runtime);
          break;
        case 'patrol':
          this.tickPatrol(machine, runtime);
          break;
        case 'suspicious':
          this.tickSuspicious(machine, runtime, tuning);
          break;
        case 'inspect':
          this.tickInspect(machine, runtime, tuning, fresh);
          break;
        case 'alert':
          this.tickAlert(machine, runtime, tuning, visible);
          break;
        case 'pursue':
          this.tickPursue(machine, runtime, visible, dt);
          break;
        case 'search':
          this.tickSearch(machine, runtime, tuning, visible, fresh);
          break;
        case 'recover':
          this.tickRecover(machine, runtime, tuning);
          break;
      }
    }
  }

  // ---- States ----------------------------------------------------------

  /** Parked hardware. Wakes on a stimulus, otherwise does nothing at all. */
  private tickDormant(machine: MachineEntity, runtime: MachineRuntime): void {
    if (machine.machineAi.awareness >= SUSPICION_AWARENESS) {
      this.transition(machine, runtime, 'suspicious', 'stimulus');
    }
  }

  private tickPatrol(machine: MachineEntity, runtime: MachineRuntime): void {
    if (machine.machineAi.awareness >= SUSPICION_AWARENESS) {
      this.transition(machine, runtime, 'suspicious', 'stimulus');
      return;
    }

    const ai = machine.machineAi;
    const route = ai.patrolRoute;
    if (route.length === 0) {
      // Authored with no route: it is a fixture, not a patroller.
      this.commandDestination(machine, runtime, null);
      return;
    }

    ai.patrolIndex = ((ai.patrolIndex % route.length) + route.length) % route.length;
    const waypoint = route[ai.patrolIndex]!;
    if (this.hasArrived(machine, waypoint)) {
      ai.patrolIndex = (ai.patrolIndex + 1) % route.length;
      this.commandDestination(machine, runtime, route[ai.patrolIndex]!, true);
      return;
    }
    this.commandDestination(machine, runtime, waypoint, true);
  }

  /**
   * Stopped and looking. The reaction delay is where difficulty lives: on story
   * a machine dithers for over a second before going to look, on demanding it
   * has already started walking.
   *
   * There is deliberately no awareness-based exit here. A machine that noticed
   * something commits to going to look at it: a single noise contributes about
   * 0.3 awareness and decays below the de-escalation threshold in under 0.6 s,
   * so an awareness check during the reaction window would make every
   * distraction a flinch the machine immediately forgot — which is both worse
   * behaviour and a broken player mechanic. De-escalation belongs to `inspect`,
   * which gives up on arriving at nothing or on its timeout.
   */
  private tickSuspicious(
    machine: MachineEntity,
    runtime: MachineRuntime,
    tuning: DifficultyTuning,
  ): void {
    const ai = machine.machineAi;

    // Standing still while suspicious: the machine is looking, not walking.
    this.commandDestination(machine, runtime, null);

    if (ai.awareness >= ALERT_AWARENESS) {
      this.transition(machine, runtime, 'alert', 'escalated');
      return;
    }
    if (ai.stateTime >= tuning.reactionTime) {
      this.transition(machine, runtime, 'inspect', 'reaction');
    }
  }

  /** Walking to the belief to have a look. Not yet certain of anything. */
  private tickInspect(
    machine: MachineEntity,
    runtime: MachineRuntime,
    tuning: DifficultyTuning,
    fresh: boolean,
  ): void {
    const ai = machine.machineAi;

    if (ai.awareness >= ALERT_AWARENESS) {
      this.transition(machine, runtime, 'alert', 'escalated');
      return;
    }

    const belief = ai.lastKnownPlayerPosition;
    // A fresh stimulus re-targets: the noise moved, so the destination moves.
    if (belief && (fresh || runtime.destination === null)) {
      this.commandDestination(machine, runtime, belief, true);
    } else if (!belief) {
      this.commandDestination(machine, runtime, null);
    }

    // Half the search budget: an inspection is a shorter commitment than a
    // hunt, and difficulty scales both from the same number.
    if (ai.stateTime >= tuning.searchPersistence * 0.5) {
      this.transition(machine, runtime, 'recover', 'timeout');
      return;
    }
    if (
      ai.awareness <= DEESCALATE_AWARENESS &&
      (belief === null || this.hasArrived(machine, belief))
    ) {
      this.transition(machine, runtime, 'recover', 'arrived');
    }
  }

  /**
   * Certain, and calling it in. A brief state: broadcast on entry, then commit
   * to a pursuit or a search once the reaction delay elapses.
   */
  private tickAlert(
    machine: MachineEntity,
    runtime: MachineRuntime,
    tuning: DifficultyTuning,
    visible: boolean,
  ): void {
    this.commandDestination(machine, runtime, null);
    if (machine.machineAi.stateTime < tuning.reactionTime) return;
    this.transition(machine, runtime, visible ? 'pursue' : 'search', 'reaction');
  }

  private tickPursue(
    machine: MachineEntity,
    runtime: MachineRuntime,
    visible: boolean,
    dt: number,
  ): void {
    const belief = machine.machineAi.lastKnownPlayerPosition;
    if (belief) this.commandDestination(machine, runtime, belief);

    if (visible) {
      runtime.sightLostFor = 0;
      return;
    }

    runtime.sightLostFor += dt;
    if (runtime.sightLostFor >= this.sightLossGrace) {
      this.transition(machine, runtime, 'search', 'sight-lost');
    }
  }

  /**
   * Hunting around the last-known position.
   *
   * `searchPersistence` is the de-escalation clock spec 65 Scenario D asks for:
   * the machine sweeps a deterministic ring of offsets until the budget runs
   * out, then stands down rather than searching forever.
   */
  private tickSearch(
    machine: MachineEntity,
    runtime: MachineRuntime,
    tuning: DifficultyTuning,
    visible: boolean,
    fresh: boolean,
  ): void {
    const ai = machine.machineAi;

    if (visible && ai.awareness >= ALERT_AWARENESS) {
      this.transition(machine, runtime, 'pursue', 'sight-regained');
      return;
    }

    if (ai.stateTime >= tuning.searchPersistence) {
      this.emitter.emit('search-abandoned', { entity: machine, searchedFor: ai.stateTime });
      this.transition(machine, runtime, 'recover', 'timeout');
      return;
    }

    const belief = ai.lastKnownPlayerPosition;
    if (!belief) {
      // Nothing to search around. Stand down rather than mill about.
      this.transition(machine, runtime, 'recover', 'de-escalated');
      return;
    }

    if (fresh) {
      // Something new: restart the sweep from the new belief.
      runtime.searchStep = 0;
      this.commandDestination(machine, runtime, belief, true);
      return;
    }

    if (runtime.destination === null) {
      this.commandDestination(machine, runtime, belief, true);
      return;
    }

    if (this.hasArrived(machine, runtime.destination)) {
      const offset = SEARCH_OFFSETS[runtime.searchStep % SEARCH_OFFSETS.length]!;
      runtime.searchStep += 1;
      this.commandDestination(
        machine,
        runtime,
        {
          x: belief.x + offset.x * this.searchRadius,
          y: belief.y,
          z: belief.z + offset.z * this.searchRadius,
        },
        true,
      );
    }
  }

  /** Standing down. Walks back to duty, then resumes patrol or goes dormant. */
  private tickRecover(
    machine: MachineEntity,
    runtime: MachineRuntime,
    tuning: DifficultyTuning,
  ): void {
    const ai = machine.machineAi;

    // Re-escalation during recovery is allowed — a machine that walks back into
    // the player has not "already given up".
    if (ai.awareness >= ALERT_AWARENESS) {
      this.transition(machine, runtime, 'alert', 'escalated');
      return;
    }
    if (ai.awareness >= SUSPICION_AWARENESS) {
      this.transition(machine, runtime, 'suspicious', 'stimulus');
      return;
    }

    const route = ai.patrolRoute;
    if (route.length > 0) {
      const waypoint = route[ai.patrolIndex % route.length]!;
      if (runtime.destination === null) this.commandDestination(machine, runtime, waypoint, true);
    } else {
      this.commandDestination(machine, runtime, null);
    }

    if (ai.stateTime >= tuning.recoveryWindow) {
      this.transition(machine, runtime, route.length > 0 ? 'patrol' : 'dormant', 'timeout');
    }
  }

  // ---- Alert propagation -----------------------------------------------

  /**
   * Tells nearby machines, once.
   *
   * Bounded three ways, all deliberate (spec 65 Scenario E):
   *   1. by distance from the machine that raised the alert;
   *   2. by escalation rank — a machine already searching learns nothing;
   *   3. by the recipient's landing state, which is `search`, never `alert`.
   *
   * (3) is the one that matters. Only `alert` broadcasts, and nothing this
   * method does can put a recipient into `alert`, so an alert cannot chain from
   * machine to machine across a sector. Recipients also receive
   * {@link ALERT_RELAY_AWARENESS}, which is below the alert threshold, so they
   * cannot escalate into `alert` on the next step either.
   */
  private propagateAlert(source: MachineEntity, tuning: DifficultyTuning): number {
    const belief = source.machineAi.lastKnownPlayerPosition;
    const radius = tuning.alertPropagationRadius;

    let notified = 0;
    if (belief && radius > 0) {
      const radiusSq = radius * radius;
      const searchRank = ESCALATION_RANK.search;

      for (const other of this.world.machines.entities) {
        if (other === (source as Entity)) continue;
        const peer = other as MachineEntity;
        const ai = peer.machineAi;
        if (ai.state === 'disabled') continue;
        if (ESCALATION_RANK[ai.state] >= searchRank) continue;
        if (
          planarDistanceSquared(peer.transform.position, source.transform.position) > radiusSq
        ) {
          continue;
        }

        ai.lastKnownPlayerPosition = { ...belief };
        ai.awareness = Math.max(ai.awareness, ALERT_RELAY_AWARENESS);
        const peerRuntime = this.runtimeFor(other);
        peerRuntime.fromAlert = true;
        peerRuntime.searchStep = 0;
        this.transition(peer, peerRuntime, 'search', 'alerted-by-peer');
        this.emitter.emit('alert-received', {
          entity: other,
          from: source,
          position: { ...belief },
        });
        notified += 1;
      }
    }

    this.emitter.emit('alert-raised', {
      entity: source,
      position: belief ? { ...belief } : null,
      notified,
      radius,
    });
    return notified;
  }

  // ---- Persistence (spec 65 Scenario F) --------------------------------

  /**
   * Captures every persistent machine's behavioural state.
   *
   * Only machines with an authored `Persistent.id` are captured: a generated id
   * cannot be matched on reload, so saving one would guarantee an orphan.
   */
  captureSnapshots(): MachineAiSnapshot[] {
    const snapshots: MachineAiSnapshot[] = [];
    for (const entity of this.world.machines.entities) {
      const machine = entity as MachineEntity;
      const id = machine.persistent?.id;
      if (!id) continue;
      const ai = machine.machineAi;
      snapshots.push({
        id,
        state: ai.state,
        stateTime: ai.stateTime,
        awareness: ai.awareness,
        patrolIndex: ai.patrolIndex,
        lastKnownPlayerPosition: ai.lastKnownPlayerPosition
          ? { ...ai.lastKnownPlayerPosition }
          : null,
      });
    }
    return snapshots;
  }

  /**
   * Restores behavioural state onto machines the world loader already spawned.
   *
   * This never creates or removes an entity — spawning is the sector loader's
   * job, and a restore that spawned would duplicate every machine on the second
   * load. Ids are applied at most once, so replaying a payload is idempotent.
   *
   * Stored state is treated as untrusted and repaired rather than trusted:
   *
   *   - `pursue` and `alert` cannot survive a reload. Both mean "I can see the
   *     player right now", which is a claim no save can make — on load the
   *     player is wherever the save put them and perception has evaluated
   *     nothing. They become `search` against the stored belief, or `recover`
   *     when there is no belief.
   *   - `patrolIndex` is clamped into the authored route, so a shortened route
   *     cannot leave a machine walking to `undefined`.
   *   - `awareness` is clamped to 0..1 and `stateTime` to a finite value.
   *   - the nav agent is rebuilt: the stored path belonged to a world that no
   *     longer exists, so it is cleared and a fresh destination is commanded.
   *     No movement state is ever left with a null destination.
   */
  restoreSnapshots(snapshots: readonly MachineAiSnapshot[]): MachineRestoreReport {
    const restored: string[] = [];
    const unmatched: string[] = [];
    const repaired: string[] = [];
    const seen = new Set<string>();

    for (const snapshot of snapshots) {
      if (seen.has(snapshot.id)) continue;
      seen.add(snapshot.id);

      const entity = this.world.findPersistent(snapshot.id);
      const machine = entity as MachineEntity | undefined;
      if (!machine?.machineAi || !machine.transform || !machine.perception) {
        unmatched.push(snapshot.id);
        continue;
      }

      const ai = machine.machineAi;
      const route = ai.patrolRoute;
      const belief = snapshot.lastKnownPlayerPosition
        ? { ...snapshot.lastKnownPlayerPosition }
        : null;

      let state: MachineState | null = isMachineState(snapshot.state) ? snapshot.state : null;
      let wasRepaired = state === null;
      if (state === null) state = route.length > 0 ? 'patrol' : 'dormant';

      if (state === 'pursue' || state === 'alert') {
        state = belief ? 'search' : 'recover';
        wasRepaired = true;
      }

      const patrolIndex =
        route.length > 0
          ? Math.min(Math.max(0, Math.floor(snapshot.patrolIndex) || 0), route.length - 1)
          : 0;
      if (patrolIndex !== snapshot.patrolIndex) wasRepaired = true;

      // Out of range means the value cannot be trusted, and the safe direction
      // is down: clamping a corrupt 5 up to 1 would hand the machine certainty
      // it never earned and it would escalate on its first step after load.
      const stored = snapshot.awareness;
      const awarenessValid = Number.isFinite(stored) && stored >= 0 && stored <= 1;
      const awareness = awarenessValid ? stored : 0;
      if (!awarenessValid) wasRepaired = true;

      ai.state = state;
      ai.stateTime = Number.isFinite(snapshot.stateTime) ? Math.max(0, snapshot.stateTime) : 0;
      ai.awareness = awareness;
      ai.patrolIndex = patrolIndex;
      ai.lastKnownPlayerPosition = belief;
      // Evaluate on the first step after load rather than inheriting a cooldown
      // that was measured against a different frame.
      ai.perceptionCooldown = 0;

      const runtime = this.runtimeFor(machine);
      runtime.actedStimulus = 0;
      runtime.sightLostFor = 0;
      runtime.searchStep = 0;
      runtime.fromAlert = false;
      runtime.disabledFor = state === 'disabled' ? Infinity : 0;
      runtime.destination = null;
      this.perception.forget?.(machine);

      this.commandDestination(machine, runtime, this.restoredDestination(machine, state, belief), true);
      restored.push(snapshot.id);
      if (wasRepaired) repaired.push(snapshot.id);
    }

    return { restored, unmatched, repaired };
  }

  /**
   * Where a restored machine should be heading.
   *
   * Never null for a state that implies movement: the fallback chain is belief,
   * then patrol waypoint, then the machine's own position — which is a valid
   * destination meaning "stay put", not a missing one.
   */
  private restoredDestination(
    machine: MachineEntity,
    state: MachineState,
    belief: Vec3 | null,
  ): Vec3 | null {
    const route = machine.machineAi.patrolRoute;
    const waypoint = route.length > 0 ? route[machine.machineAi.patrolIndex % route.length]! : null;

    switch (state) {
      case 'disabled':
      case 'dormant':
        return null;
      case 'patrol':
      case 'recover':
        return waypoint ?? { ...machine.transform.position };
      case 'suspicious':
      case 'alert':
        return null;
      case 'inspect':
      case 'search':
      case 'pursue':
        return belief ?? waypoint ?? { ...machine.transform.position };
    }
  }

  // ---- Internals -------------------------------------------------------

  /**
   * Changes state, resets the state clock and emits.
   *
   * Entering `alert` broadcasts; entering `recover` clears awareness and the
   * belief, which is what de-escalation *means* — otherwise the stale belief
   * would re-escalate the machine on its next step forever.
   */
  private transition(
    machine: MachineEntity,
    runtime: MachineRuntime,
    to: MachineState,
    reason: MachineTransitionReason,
  ): void {
    const ai = machine.machineAi;
    const from = ai.state;
    if (from === to) return;

    ai.state = to;
    ai.stateTime = 0;

    if (to === 'recover') {
      ai.awareness = 0;
      ai.lastKnownPlayerPosition = null;
      runtime.sightLostFor = 0;
      runtime.searchStep = 0;
      runtime.fromAlert = false;
      runtime.destination = null;
    }

    this.emitter.emit('state-changed', { entity: machine, from, to, reason });

    // After the event, so a listener sees `alert` before the peers do.
    if (to === 'alert') this.propagateAlert(machine, this.tuning);
  }

  /**
   * Commands a destination.
   *
   * `discrete` targets (waypoints, a belief, a search offset) are applied
   * immediately: they change rarely and waiting would look like hesitation.
   * A continuous target — the belief during a pursuit — is throttled through
   * `NavAgent.repathCooldown`, so chasing never becomes per-frame pathfinding
   * (spec 7.4).
   */
  private commandDestination(
    machine: MachineEntity,
    runtime: MachineRuntime,
    target: Vec3 | null,
    discrete = false,
  ): void {
    if (target === null) {
      runtime.destination = null;
      const agent = machine.navAgent;
      if (agent) {
        agent.destination = null;
        agent.path.length = 0;
        agent.pathIndex = 0;
        agent.arrived = true;
      }
      return;
    }

    // Already heading there. Re-issuing would clear the path every step and the
    // follower would restart before it walked anywhere.
    if (
      runtime.destination &&
      distanceSquared(runtime.destination, target) <= DESTINATION_EPSILON_SQ
    ) {
      return;
    }

    const agent = machine.navAgent;
    if (!discrete && agent && agent.repathCooldown > 0) return;

    runtime.destination = { ...target };
    if (agent) {
      agent.destination = { ...target };
      // The old path led somewhere else. Leaving it would have the follower
      // walk the previous route before noticing.
      agent.path.length = 0;
      agent.pathIndex = 0;
      agent.arrived = false;
      agent.repathCooldown = this.pursuitRepathInterval;
    }
  }

  /**
   * Whether the machine is at `target`.
   *
   * `NavAgent.arrived` wins when a follower set it; the planar fallback keeps
   * the state machine working for machines with no nav agent at all, and for
   * unit tests that move a transform directly.
   */
  private hasArrived(machine: MachineEntity, target: Vec3): boolean {
    if (machine.navAgent?.arrived) return true;
    return planarDistanceSquared(machine.transform.position, target) <= this.arriveRadiusSq;
  }

  private runtimeFor(entity: Entity): MachineRuntime {
    let runtime = this.runtimes.get(entity);
    if (!runtime) {
      runtime = {
        actedStimulus: this.perception.stimulusCount(entity),
        sightLostFor: 0,
        searchStep: 0,
        disabledFor: entity.machineAi?.state === 'disabled' ? Infinity : 0,
        fromAlert: false,
        destination: null,
      };
      this.runtimes.set(entity, runtime);
    }
    return runtime;
  }
}

/** Convenience for diagnostics and tests: a fresh, valid `MachineAi`. */
export function createMachineAi(overrides: Partial<MachineAi> = {}): MachineAi {
  return {
    kind: 'inspection-unit',
    state: 'patrol',
    stateTime: 0,
    awareness: 0,
    lastKnownPlayerPosition: null,
    patrolRoute: [],
    patrolIndex: 0,
    perceptionCooldown: 0,
    ...overrides,
  };
}

/** Convenience for diagnostics and tests: a fresh, valid `Perception`. */
export function createPerception(overrides: Partial<Perception> = {}): Perception {
  return {
    visionHalfAngle: 0.6,
    visionRange: 18,
    proximityRange: 3,
    hearingRange: 12,
    timeToDetect: 1.5,
    eyeOffset: vec3(0, 1.4, 0),
    ...overrides,
  };
}
