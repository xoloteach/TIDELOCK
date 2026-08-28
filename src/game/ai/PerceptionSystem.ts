/**
 * Machine perception — what a malfunctioning municipal machine can actually
 * sense (spec 7.3).
 *
 * The governing rule is the one the spec states negatively: **avoid omniscient
 * AI**. A machine may only act on information it acquired through a sense, and
 * every sense here can fail:
 *
 *   - **Vision** needs range, a yaw cone, *and* an unobstructed line of sight.
 *   - **Proximity** ignores facing (a crawler two metres behind you notices
 *     you) but still needs line of sight, otherwise a machine on the far side
 *     of a flood door would "feel" the player through concrete.
 *   - **Hearing** is discrete: it is pushed in as a stimulus with a position
 *     and a loudness, and it reveals the *sound's* position, never the
 *     player's. Distraction only works because a machine can hold a belief
 *     that is wrong.
 *
 * Detection is never instantaneous. Awareness is a 0..1 accumulator that ramps
 * over `Perception.timeToDetect` and decays when the player is not visible, so
 * clipping the edge of a cone for a third of a second is survivable and
 * standing in the open is not.
 *
 * What the system writes, and nothing else:
 *   - `MachineAi.awareness` — the ramp.
 *   - `MachineAi.lastKnownPlayerPosition` — the machine's *belief*, which may
 *     be a thrown-object impact rather than the player.
 *   - `MachineAi.perceptionCooldown` — its own distance throttle.
 *
 * Behaviour (states, patrol, pursuit, alert propagation) belongs to
 * {@link MachineAiSystem}, which reads the belief and the awareness value and
 * queries this system through a small port. Splitting them keeps "what can it
 * know" honest and separately testable from "what does it do".
 *
 * Everything platform-facing arrives as a port: the occlusion raycast (normally
 * Rapier or a BVH, imported nowhere near here), the quality preset's AI tick
 * budget, and the difficulty level. The system therefore has no dependency on
 * physics, the renderer or the settings store, and unit tests drive it with
 * plain fakes.
 */

import type { GameWorld, System } from '../../engine/ecs/GameWorld';
import {
  distanceSquared,
  planarDistanceSquared,
  vec3,
  type Entity,
  type MachineAi,
  type Perception,
  type Transform,
  type Vec3,
} from '../../engine/ecs/components';
import { Emitter, type Handler, type Unsubscribe } from '../../engine/events';
import type { GameplaySettings } from '../../persistence/settingsSchema';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * Line-of-sight test against world geometry.
 *
 * Normally backed by Rapier's scene query or a `three-mesh-bvh` raycast at
 * wiring time. Declared as a one-method structural interface so this file
 * imports neither, matching `InteractionOcclusionPort`: an AI system that
 * imports a physics backend cannot be unit tested, and a sector that has no
 * collider yet would crash it.
 *
 * With no port supplied nothing occludes. That is correct for an open rooftop
 * and for tests, and it is *not* safe for a finished interior — an unwired
 * occlusion port is how a machine ends up seeing through a wall, which is the
 * omniscience the spec forbids. Wiring must supply one.
 */
export interface PerceptionRaycastPort {
  /** True when world geometry blocks the segment from `from` to `to`. */
  isOccluded(from: Vec3, to: Vec3): boolean;
}

/**
 * The one number this system needs from the graphics/simulation quality
 * preset: `aiFarUpdateHz`.
 *
 * A function rather than a cached value so a preset change applies on the next
 * step without a subscription to unwind. Wiring passes
 * `() => qualitySystem.quality.aiFarUpdateHz`.
 */
export interface PerceptionQualityPort {
  /** Evaluation rate in Hz for machines outside the near band. */
  aiFarUpdateHz(): number;
}

/** Fixed-rate quality port, for tests and for boot before quality exists. */
export function createStaticPerceptionQuality(hz: number): PerceptionQualityPort {
  return { aiFarUpdateHz: () => hz };
}

export type MachineDifficulty = GameplaySettings['difficulty'];

/**
 * Difficulty, read at evaluation time.
 *
 * Read rather than cached so changing the setting mid-session takes effect
 * immediately, the way the tutorial system reads its own gameplay settings.
 */
export interface MachineDifficultyPort {
  difficulty(): MachineDifficulty;
}

/** Fixed-level difficulty port, for tests and for a default session. */
export function createStaticDifficulty(
  level: MachineDifficulty = 'standard',
): MachineDifficultyPort {
  return { difficulty: () => level };
}

// ---------------------------------------------------------------------------
// Difficulty tuning (spec 7.5)
// ---------------------------------------------------------------------------

/**
 * What difficulty is allowed to change.
 *
 * Spec 7.5 is explicit that difficulty adjusts detection forgiveness, search
 * persistence, reaction time and recovery windows — and that it does **not**
 * merely multiply health. There is deliberately no health or damage field in
 * this table; combat is non-graphic and a tougher machine is one that gives you
 * less slack, not one with a bigger number.
 *
 * The table lives here rather than in {@link MachineAiSystem} because the first
 * two entries are perception values; the AI system imports the same table so
 * one difficulty level cannot mean two different things.
 */
export interface DifficultyTuning {
  /**
   * Multiplies `Perception.timeToDetect`. Greater than 1 is *more* forgiving:
   * the player has longer in the cone before awareness fills.
   */
  readonly detectionForgiveness: number;
  /** Multiplies the awareness decay rate. Greater than 1 forgets faster. */
  readonly awarenessDecayScale: number;
  /** Seconds a machine keeps searching a lost target before giving up. */
  readonly searchPersistence: number;
  /** Seconds between noticing something and acting on it. */
  readonly reactionTime: number;
  /** Seconds spent standing down before normal duty resumes. */
  readonly recoveryWindow: number;
  /** Metres within which an alert reaches other machines. Bounded on purpose. */
  readonly alertPropagationRadius: number;
}

export const DIFFICULTY_TUNING: Readonly<Record<MachineDifficulty, DifficultyTuning>> =
  Object.freeze({
    /** Story: the campaign is the point, the machines are scenery with teeth. */
    story: Object.freeze({
      detectionForgiveness: 1.6,
      awarenessDecayScale: 1.5,
      searchPersistence: 6,
      reactionTime: 1.1,
      recoveryWindow: 3,
      alertPropagationRadius: 10,
    }),
    standard: Object.freeze({
      detectionForgiveness: 1,
      awarenessDecayScale: 1,
      searchPersistence: 12,
      reactionTime: 0.6,
      recoveryWindow: 5,
      alertPropagationRadius: 14,
    }),
    /** Demanding: less slack everywhere. Still the same machine. */
    demanding: Object.freeze({
      detectionForgiveness: 0.7,
      awarenessDecayScale: 0.7,
      searchPersistence: 20,
      reactionTime: 0.3,
      recoveryWindow: 8,
      alertPropagationRadius: 18,
    }),
  });

export function difficultyTuning(level: MachineDifficulty): DifficultyTuning {
  return DIFFICULTY_TUNING[level];
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Metres within which a machine is evaluated at the near rate.
 *
 * Cost decision: the expensive part of perception is the occlusion raycast —
 * one per machine per evaluation, against world geometry. Everything else is a
 * squared distance and a dot product. Evaluating twelve machines at 60 Hz is
 * 720 raycasts a second on a phone, and the player cannot perceive the
 * difference between a machine that reconsiders every 16 ms and one that
 * reconsiders every 50 ms.
 *
 * So: machines close enough to matter this second are evaluated at
 * {@link PERCEPTION_NEAR_UPDATE_HZ}; everything beyond this radius falls back
 * to the preset's `aiFarUpdateHz` (2 Hz on potato, 15 Hz on ultra). A far
 * machine cannot see the player anyway — its `visionRange` is shorter than
 * this band — so the only thing a slower far tick delays is the moment it
 * *starts* mattering, and by then it is inside the near band.
 *
 * Awareness still accumulates over real elapsed seconds rather than per
 * evaluation, so the throttle changes cost, never difficulty.
 */
export const PERCEPTION_NEAR_DISTANCE_M = 25;

/**
 * Near-band evaluation rate in Hz. Three times a typical `timeToDetect` ramp
 * per tenth of a second: fast enough that a cone edge is sampled properly,
 * cheap enough to run a whole sector's worth of machines.
 */
export const PERCEPTION_NEAR_UPDATE_HZ = 20;

/**
 * Base awareness decay, in units per second, at `standard` difficulty.
 *
 * Slower than the ramp on purpose: breaking line of sight should buy the player
 * time, not amnesia. A machine that had fully detected you takes ~2.9 s to
 * forget entirely, and de-escalation timing on top of that belongs to the AI
 * system's search persistence.
 */
export const AWARENESS_DECAY_PER_S = 0.35;

/**
 * Awareness a single sound stimulus can contribute at point-blank range and
 * full loudness.
 *
 * Below 1 by construction, and clamped by {@link SOUND_AWARENESS_CEILING}: a
 * noise tells a machine *where the noise was*, never that it has found the
 * player. Anything else would make hearing an instant-detect sense and turn
 * distraction into suicide.
 */
export const SOUND_AWARENESS_GAIN = 0.45;

/** Hearing alone can never push awareness past this. Sight must finish the job. */
export const SOUND_AWARENESS_CEILING = 0.8;

/**
 * Height above the machine's target's origin that vision and the occlusion ray
 * aim at.
 *
 * Aiming at the feet lets a kerb or a puddle lip hide the player completely,
 * which reads as a bug. Torso height is what a camera on a maintenance frame
 * would actually be pointed at.
 */
export const PERCEPTION_TARGET_HEIGHT_M = 1;

/** Loudness is clamped into this range so one bad caller cannot deafen a sector. */
const MAX_LOUDNESS = 4;

/**
 * Slack on the cooldown comparison.
 *
 * A cooldown accumulated in 1/60 s steps lands on values like 1.7e-18 instead
 * of exactly 0, and a strict `> 0` test there costs a whole extra step —
 * quantising a 20 Hz band down to 15 Hz. A microsecond of slack is far below
 * any rate worth expressing.
 */
const COOLDOWN_EPSILON_S = 1e-6;

/**
 * Below this planar separation the direction to the player is numerical noise —
 * the machine is standing on them. Facing stops being meaningful, so treat the
 * cone as satisfied rather than dividing by ~0.
 */
const PLANAR_EPSILON_SQ = 1e-6;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** Which sense produced the machine's current belief. */
export type StimulusKind = 'vision' | 'proximity' | 'sound';

/** A discrete noise. Pushed in by gameplay; never polled. */
export interface SoundStimulus {
  /** Where the noise happened. Not where the player is. */
  readonly position: Vec3;
  /**
   * Relative loudness. 1 is an ordinary event audible at the machine's full
   * `hearingRange`; 0.25 is a careful footstep; 2 is a dropped tool tray.
   */
  readonly loudness: number;
  /** Optional authored tag, for diagnostics. */
  readonly tag?: string;
}

/** Read model for the AI system, the diagnostics overlay and tests. */
export interface PerceptionSnapshot {
  /** Confirmed by sight or proximity at the most recent evaluation. */
  readonly visible: boolean;
  /** 0..1 accumulator. 1 means fully detected. */
  readonly awareness: number;
  /** What produced the current belief, or null if nothing ever has. */
  readonly lastStimulus: StimulusKind | null;
  /** The machine's belief about the player's position. May be wrong. */
  readonly belief: Vec3 | null;
  /**
   * Increments whenever a fresh stimulus wrote a belief. The AI system uses
   * the change, not the value, to notice "there is something new to look at".
   */
  readonly stimulusCount: number;
  /** Evaluations performed. Exposed so the distance throttle is testable. */
  readonly evaluations: number;
  /** Seconds since sight was last confirmed, or null if never seen. */
  readonly secondsSinceSeen: number | null;
}

/**
 * Declared as a type alias, not an interface: TypeScript only infers an
 * implicit index signature for aliases, which the `EventMap` constraint needs.
 */
export type PerceptionEvents = {
  /** Sight or proximity confirmed the player, having previously lost them. */
  sighted: { entity: Entity; position: Vec3; kind: 'vision' | 'proximity' };
  /** Sight was confirmed and is now broken. Carries the belief left behind. */
  lost: { entity: Entity; lastKnown: Vec3 };
  /** A noise was within hearing. `position` is the noise, not the player. */
  heard: { entity: Entity; position: Vec3; loudness: number };
  /** Awareness reached 1. The AI system escalates on this. */
  detected: { entity: Entity; position: Vec3 };
};

export interface PerceptionSystemOptions {
  readonly world: GameWorld;
  /** Line-of-sight test. Null means nothing occludes — tests and open sky only. */
  readonly raycast?: PerceptionRaycastPort | null;
  /** Supplies `aiFarUpdateHz`. Defaults to a fixed 6 Hz (the medium preset). */
  readonly quality?: PerceptionQualityPort;
  /** Defaults to `standard`. */
  readonly difficulty?: MachineDifficultyPort;
  /** Metres inside which the near evaluation rate applies. */
  readonly nearDistance?: number;
  readonly nearUpdateHz?: number;
  /** Awareness lost per second when the player is not visible. */
  readonly awarenessDecayPerSecond?: number;
  /** Height above the player's origin that vision aims at. */
  readonly targetHeight?: number;
}

/** The entity shape the `machines` query guarantees. */
type MachineEntity = Entity & {
  transform: Transform;
  machineAi: MachineAi;
  perception: Perception;
};

/** Per-machine bookkeeping this system owns. Not saved; derived on reload. */
interface PerceptionRuntime {
  /** Seconds of real simulation time since the last evaluation. */
  sinceEval: number;
  visible: boolean;
  lastStimulus: StimulusKind | null;
  stimulusCount: number;
  evaluations: number;
  /** Seconds since sight was last confirmed, or null if never. */
  secondsSinceSeen: number | null;
}

/**
 * Reused for the eye and target points. Allocating two vectors per machine per
 * evaluation is pure garbage on a phone; anything handed to a port or escaping
 * the loop gets a copy.
 */
const SCRATCH_EYE: Vec3 = vec3();
const SCRATCH_TARGET: Vec3 = vec3();

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Facing direction from yaw.
 *
 * Three.js convention: yaw 0 looks down -Z and positive yaw rotates about +Y,
 * so rotating (0,0,-1) yields (-sin, 0, -cos). Identical to the interaction
 * cone's convention — a machine and a prompt disagreeing about which way "0"
 * points is a bug that only shows up in one sector.
 */
export function facingFromYaw(yaw: number): Vec3 {
  return { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
}

/**
 * Cosine of the horizontal angle between `facing` and the direction to
 * `target`, in [-1,1]. 1 is dead ahead.
 *
 * Horizontal only: `Transform.yaw` is the only rotation a machine's cone is
 * authored in, and pitch is not modelled for municipal hardware. Range is
 * still measured in full 3D, so a machine one storey below cannot see you.
 */
export function coneAlignment(eye: Vec3, facing: Vec3, target: Vec3): number {
  const dx = target.x - eye.x;
  const dz = target.z - eye.z;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq < PLANAR_EPSILON_SQ) return 1;
  const inverseLength = 1 / Math.sqrt(lengthSq);
  return dx * inverseLength * facing.x + dz * inverseLength * facing.z;
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export class PerceptionSystem implements System {
  readonly name = 'perception';

  private readonly emitter = new Emitter<PerceptionEvents>();

  private readonly world: GameWorld;
  private readonly nearDistanceSq: number;
  private readonly nearPeriod: number;
  private readonly awarenessDecayPerSecond: number;
  private readonly targetHeight: number;

  private raycast: PerceptionRaycastPort | null;
  private quality: PerceptionQualityPort;
  private difficultyPort: MachineDifficultyPort;

  /**
   * Runtime keyed weakly by entity: a machine despawned by a sector unload must
   * not keep its perception bookkeeping alive, and there is nothing here worth
   * iterating — every pass walks the `machines` query instead.
   */
  private readonly runtimes = new WeakMap<Entity, PerceptionRuntime>();

  /** Total evaluations since construction. Diagnostics only. */
  private totalEvaluations = 0;

  constructor(options: PerceptionSystemOptions) {
    this.world = options.world;
    this.raycast = options.raycast ?? null;
    this.quality = options.quality ?? createStaticPerceptionQuality(6);
    this.difficultyPort = options.difficulty ?? createStaticDifficulty('standard');
    const nearDistance = options.nearDistance ?? PERCEPTION_NEAR_DISTANCE_M;
    this.nearDistanceSq = nearDistance * nearDistance;
    this.nearPeriod = 1 / (options.nearUpdateHz ?? PERCEPTION_NEAR_UPDATE_HZ);
    this.awarenessDecayPerSecond = options.awarenessDecayPerSecond ?? AWARENESS_DECAY_PER_S;
    this.targetHeight = options.targetHeight ?? PERCEPTION_TARGET_HEIGHT_M;
  }

  // ---- Subscription -----------------------------------------------------

  on<K extends keyof PerceptionEvents>(
    event: K,
    handler: Handler<PerceptionEvents[K]>,
  ): Unsubscribe {
    return this.emitter.on(event, handler);
  }

  off<K extends keyof PerceptionEvents>(event: K, handler: Handler<PerceptionEvents[K]>): void {
    this.emitter.off(event, handler);
  }

  // ---- Configuration ---------------------------------------------------

  /** Wired once the sector's collision geometry exists. */
  setRaycastPort(port: PerceptionRaycastPort | null): void {
    this.raycast = port;
  }

  setQualityPort(port: PerceptionQualityPort): void {
    this.quality = port;
  }

  setDifficultyPort(port: MachineDifficultyPort): void {
    this.difficultyPort = port;
  }

  get difficulty(): MachineDifficulty {
    return this.difficultyPort.difficulty();
  }

  get tuning(): DifficultyTuning {
    return difficultyTuning(this.difficultyPort.difficulty());
  }

  get evaluationCount(): number {
    return this.totalEvaluations;
  }

  // ---- Read model (also the MachineAiSystem port) -----------------------

  /** True when the most recent evaluation confirmed the player by a sense. */
  isPlayerVisible(entity: Entity): boolean {
    return this.runtimes.get(entity)?.visible ?? false;
  }

  /**
   * Monotonic count of fresh stimuli. The AI system compares it against the
   * value it last acted on, so a new noise reads as "something changed" without
   * this system knowing anything about states.
   */
  stimulusCount(entity: Entity): number {
    return this.runtimes.get(entity)?.stimulusCount ?? 0;
  }

  secondsSinceSeen(entity: Entity): number | null {
    return this.runtimes.get(entity)?.secondsSinceSeen ?? null;
  }

  snapshot(entity: Entity): PerceptionSnapshot | null {
    const runtime = this.runtimes.get(entity);
    if (!runtime) return null;
    const belief = entity.machineAi?.lastKnownPlayerPosition ?? null;
    return {
      visible: runtime.visible,
      awareness: entity.machineAi?.awareness ?? 0,
      lastStimulus: runtime.lastStimulus,
      belief: belief ? { ...belief } : null,
      stimulusCount: runtime.stimulusCount,
      evaluations: runtime.evaluations,
      secondsSinceSeen: runtime.secondsSinceSeen,
    };
  }

  /** Drops sensory bookkeeping for one machine. Used by save restore. */
  forget(entity: Entity): void {
    const runtime = this.runtimes.get(entity);
    if (!runtime) return;
    runtime.visible = false;
    runtime.lastStimulus = null;
    runtime.secondsSinceSeen = null;
    runtime.sinceEval = 0;
  }

  dispose(): void {
    this.emitter.clear();
  }

  // ---- Stimuli ---------------------------------------------------------

  /**
   * Reports a noise.
   *
   * Evaluated immediately for every machine rather than queued. Hearing costs
   * one squared distance per machine and no raycast, so running it inline is
   * cheaper than the bookkeeping a queue would need — and queueing would let
   * the distance throttle silently drop a thrown-object distraction, which is
   * the one stimulus the player deliberately created.
   *
   * A heard sound writes the *sound's* position as the machine's belief. That
   * is the whole mechanism behind distraction: the belief is allowed to be
   * wrong, and hearing alone cannot fill awareness past
   * {@link SOUND_AWARENESS_CEILING}.
   *
   * @returns How many machines heard it.
   */
  reportSound(sound: SoundStimulus): number {
    const loudness = Math.max(0, Math.min(MAX_LOUDNESS, sound.loudness));
    if (loudness <= 0) return 0;

    let heard = 0;
    for (const entity of this.world.machines.entities) {
      const machine = entity as MachineEntity;
      // A disabled machine has no working sensors at all (spec 7.3 Disabled).
      if (machine.machineAi.state === 'disabled') continue;

      const range = machine.perception.hearingRange * loudness;
      if (range <= 0) continue;

      const eye = this.eyeInto(SCRATCH_EYE, machine);
      const distSq = distanceSquared(eye, sound.position);
      if (distSq > range * range) continue;

      // Linear falloff from the source: a noise at the edge of hearing barely
      // registers, one underfoot is worth the full gain.
      const falloff = 1 - Math.sqrt(distSq) / range;
      const gain = SOUND_AWARENESS_GAIN * falloff * Math.min(1, loudness);

      const ai = machine.machineAi;
      const before = ai.awareness;
      // Clamped to the ceiling, but never *lowered*: a machine that already has
      // eyes on the player is not talked down by a noise elsewhere.
      ai.awareness = Math.max(before, Math.min(SOUND_AWARENESS_CEILING, before + gain));

      // Only overwrite the belief if sight is not currently the better source.
      // A machine that can see the player should not be talked into staring at
      // a puddle.
      const runtime = this.runtimeFor(entity);
      if (!runtime.visible) {
        ai.lastKnownPlayerPosition = { ...sound.position };
        runtime.lastStimulus = 'sound';
        runtime.stimulusCount += 1;
      }

      heard += 1;
      this.emitter.emit('heard', {
        entity,
        position: { ...sound.position },
        loudness,
      });
    }
    return heard;
  }

  // ---- Simulation ------------------------------------------------------

  fixedUpdate(dt: number): void {
    const player = this.world.player;
    const playerPosition = player?.transform?.position ?? null;
    const tuning = this.tuning;
    const farPeriod = this.farPeriod();

    for (const entity of this.world.machines.entities) {
      const machine = entity as MachineEntity;
      const ai = machine.machineAi;
      const runtime = this.runtimeFor(entity);

      if (runtime.secondsSinceSeen !== null) runtime.secondsSinceSeen += dt;

      // Disabled machines stop perceiving entirely: no evaluation, no decay,
      // no cooldown bookkeeping. Whatever they believed when they went down is
      // what they wake up with, which is why a temporarily disabled machine is
      // still worth avoiding afterwards.
      if (ai.state === 'disabled') {
        if (runtime.visible) this.loseSight(entity, runtime);
        continue;
      }

      runtime.sinceEval += dt;
      ai.perceptionCooldown -= dt;
      if (ai.perceptionCooldown > COOLDOWN_EPSILON_S) continue;

      // Choosing the band costs one planar distance and no sqrt. Doing it every
      // step (rather than at evaluation time) means a machine the player is
      // running towards upgrades to the near rate immediately.
      const nearby =
        playerPosition !== null &&
        planarDistanceSquared(machine.transform.position, playerPosition) <= this.nearDistanceSq;
      const period = nearby ? this.nearPeriod : farPeriod;
      // Carry the overshoot instead of resetting to a full period, so the
      // long-run rate is the requested one rather than the next multiple of the
      // fixed step. Debt is capped at one period: a period shorter than dt must
      // mean "every step", not an unbounded catch-up backlog.
      ai.perceptionCooldown = Math.max(ai.perceptionCooldown, -period) + period;

      const elapsed = runtime.sinceEval;
      runtime.sinceEval = 0;
      runtime.evaluations += 1;
      this.totalEvaluations += 1;

      this.evaluate(entity, machine, runtime, playerPosition, elapsed, tuning);
    }
  }

  /** One machine, one evaluation. `elapsed` is real seconds since the last. */
  private evaluate(
    entity: Entity,
    machine: MachineEntity,
    runtime: PerceptionRuntime,
    playerPosition: Vec3 | null,
    elapsed: number,
    tuning: DifficultyTuning,
  ): void {
    const ai = machine.machineAi;

    if (playerPosition === null) {
      this.decay(entity, runtime, ai, elapsed, tuning);
      return;
    }

    const eye = this.eyeInto(SCRATCH_EYE, machine);
    const target = SCRATCH_TARGET;
    target.x = playerPosition.x;
    target.y = playerPosition.y + this.targetHeight;
    target.z = playerPosition.z;

    const kind = this.sense(machine, eye, target);
    if (kind === null) {
      this.decay(entity, runtime, ai, elapsed, tuning);
      return;
    }

    // Confirmed by a sense: the belief becomes the truth, and only now.
    ai.lastKnownPlayerPosition = { ...playerPosition };
    runtime.lastStimulus = kind;
    runtime.stimulusCount += 1;
    runtime.secondsSinceSeen = 0;

    if (!runtime.visible) {
      runtime.visible = true;
      this.emitter.emit('sighted', { entity, position: { ...playerPosition }, kind });
    }

    // The ramp. Divided by elapsed-independent `timeToDetect` so the throttle
    // changes cost, never how long detection takes: a machine evaluated at
    // 2 Hz and one at 20 Hz fill awareness over the same wall-clock seconds.
    const timeToDetect = Math.max(1e-3, machine.perception.timeToDetect * tuning.detectionForgiveness);
    const before = ai.awareness;
    ai.awareness = Math.min(1, before + elapsed / timeToDetect);

    if (ai.awareness >= 1 && before < 1) {
      this.emitter.emit('detected', { entity, position: { ...playerPosition } });
    }
  }

  /**
   * Which sense, if any, confirms the player this evaluation.
   *
   * Rejection order is cheapest-first: squared range, then the cone, and only
   * then the raycast — the one test that costs real time.
   */
  private sense(
    machine: MachineEntity,
    eye: Vec3,
    target: Vec3,
  ): 'vision' | 'proximity' | null {
    const perception = machine.perception;
    const distSq = distanceSquared(eye, target);

    const withinProximity =
      perception.proximityRange > 0 && distSq <= perception.proximityRange * perception.proximityRange;

    let withinVision = false;
    if (perception.visionRange > 0 && distSq <= perception.visionRange * perception.visionRange) {
      const facing = facingFromYaw(machine.transform.yaw);
      withinVision =
        coneAlignment(eye, facing, target) >= Math.cos(perception.visionHalfAngle);
    }

    if (!withinProximity && !withinVision) return null;

    // Line of sight gates *both* senses. Proximity ignores facing, not
    // concrete: a containment unit on the far side of a flood door must not
    // feel the player through it. This is the check that keeps the AI honest,
    // and it is why an unwired raycast port is a real problem rather than a
    // cosmetic one.
    if (this.raycast?.isOccluded({ ...eye }, { ...target })) return null;

    // Vision wins the label when both apply: it is the stronger claim and the
    // one the diagnostics overlay should show.
    return withinVision ? 'vision' : 'proximity';
  }

  private decay(
    entity: Entity,
    runtime: PerceptionRuntime,
    ai: MachineAi,
    elapsed: number,
    tuning: DifficultyTuning,
  ): void {
    if (runtime.visible) this.loseSight(entity, runtime);
    if (ai.awareness <= 0) return;
    ai.awareness = Math.max(
      0,
      ai.awareness - elapsed * this.awarenessDecayPerSecond * tuning.awarenessDecayScale,
    );
  }

  private loseSight(entity: Entity, runtime: PerceptionRuntime): void {
    runtime.visible = false;
    const lastKnown = entity.machineAi?.lastKnownPlayerPosition;
    // The belief survives losing sight — that is the point of recording it.
    this.emitter.emit('lost', { entity, lastKnown: lastKnown ? { ...lastKnown } : vec3() });
  }

  // ---- Internals -------------------------------------------------------

  private farPeriod(): number {
    const hz = this.quality.aiFarUpdateHz();
    // A zero or negative rate would mean "never perceive", which is a
    // misconfiguration rather than a design choice. Fall back to the cheapest
    // real preset rather than freezing every machine in the sector.
    return hz > 0 ? 1 / hz : 1 / 2;
  }

  private eyeInto(out: Vec3, machine: MachineEntity): Vec3 {
    const p = machine.transform.position;
    const o = machine.perception.eyeOffset;
    out.x = p.x + o.x;
    out.y = p.y + o.y;
    out.z = p.z + o.z;
    return out;
  }

  private runtimeFor(entity: Entity): PerceptionRuntime {
    let runtime = this.runtimes.get(entity);
    if (!runtime) {
      runtime = {
        sinceEval: 0,
        visible: false,
        lastStimulus: null,
        stimulusCount: 0,
        evaluations: 0,
        secondsSinceSeen: null,
      };
      this.runtimes.set(entity, runtime);
    }
    return runtime;
  }
}
