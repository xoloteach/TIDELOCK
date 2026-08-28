/**
 * Interaction targeting and activation.
 *
 * One action interacts with everything — door, switch, valve, terminal,
 * pickup, note, NPC, breaker, ladder, objective object. The *verb* and *label*
 * come from the `Interactable` component, so a new interaction type is authored
 * data, never a new input binding and never a branch in here.
 *
 * Each fixed step the system:
 *   1. picks at most one target from the ECS `interactables` query;
 *   2. advances or cancels a hold in progress;
 *   3. emits the interaction's authored event string on completion.
 *
 * It builds no DOM and touches no renderer. The HUD subscribes to
 * `target-changed` and reads {@link InteractionSystem.target} each frame for
 * the hold ring. That keeps prompt presentation replaceable (screen HUD, touch
 * button, controller glyph) without touching selection logic.
 *
 * Everything platform-facing arrives as a port: the input state, the occlusion
 * raycast, and the "may the player interact right now" predicate. The system
 * therefore has no dependency on the renderer, physics, dialogue or sequence
 * systems, and is exercised in unit tests with plain fakes.
 */

import type { GameWorld, System } from '../../engine/ecs/GameWorld';
import {
  distanceSquared,
  vec3,
  type Entity,
  type Interactable,
  type InteractionVerb,
  type Transform,
  type Vec3,
} from '../../engine/ecs/components';
import { Emitter, type Handler, type Unsubscribe } from '../../engine/events';
import type { ButtonAction } from '../../engine/input/actions';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * The slice of the input layer this system needs.
 *
 * Declared locally rather than importing `InputState` so interaction logic can
 * be driven by a fake in tests and by the real input state in the game — the
 * concrete `InputState` satisfies this structurally.
 *
 * `getHoldDuration` is deliberately *not* part of the port. The input layer
 * times how long a button has been held; this system needs how long it has
 * been held *against the current target*, which is a different number the
 * moment the player swings the camera mid-hold. Timing it here also means a
 * player already holding interact when an object comes into view does not get
 * a free instant activation — they must press again, deliberately.
 */
export interface InteractionInputPort {
  /** Held right now, whether it started this step or twenty steps ago. */
  isDown(action: ButtonAction): boolean;
  /** Went down during this step. True for exactly one step per press. */
  wasPressed(action: ButtonAction): boolean;
}

/**
 * Line-of-sight test, normally backed by `three-mesh-bvh` against world
 * geometry.
 *
 * Optional: with no port supplied the check is skipped entirely, so early
 * sectors and unit tests work before a BVH exists.
 */
export interface InteractionOcclusionPort {
  /** True when world geometry blocks the segment from `from` to `to`. */
  isOccluded(from: Vec3, to: Vec3): boolean;
}

/**
 * Gate consulted every step. Return false while a cutscene, dialogue, menu or
 * scripted sequence owns the player.
 *
 * A predicate rather than a `setEnabled` call: the owners of those states
 * already know their own status, and one shared query cannot drift out of sync
 * the way two mirrored booleans can.
 */
export type CanInteractPredicate = () => boolean;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** What the HUD needs to draw a prompt. A snapshot, not a live reference. */
export interface InteractionTarget {
  readonly entity: Entity;
  readonly verb: InteractionVerb;
  readonly label: string;
  /** Metres from the player's eye to the prompt anchor, last fixed step. */
  readonly distance: number;
  /** Effective range in metres, after accessibility assist. */
  readonly range: number;
  /** Seconds the interact action must be held. 0 = instant. */
  readonly holdDuration: number;
  /** 0..1 hold completion. Always 0 for instant interactions. */
  readonly holdProgress: number;
  /** World position the prompt anchors to (transform + promptOffset). */
  readonly anchor: Vec3;
}

/** Why a hold ended without firing. Surfaced so the HUD can react. */
export type HoldCancelReason =
  /** Player let go early. */
  | 'released'
  /** Target left range, turned away, was disabled, occluded or despawned. */
  | 'target-lost'
  /** A sequence, dialogue or menu took over. */
  | 'suppressed'
  /** Sector transition or save load. */
  | 'reset';

/**
 * Declared as a type alias, not an interface: TypeScript only infers an
 * implicit index signature for aliases, which the `EventMap` constraint needs.
 */
type InteractionEvents = {
  /**
   * Fires only when the prompt genuinely changes — a different entity, or the
   * same entity whose verb/label changed (a door flipping `open` to `close`).
   * Distance and hold progress change constantly and are read from
   * {@link InteractionSystem.target}, never pushed.
   */
  'target-changed': {
    target: InteractionTarget | null;
    previous: InteractionTarget | null;
  };
  'hold-started': {
    entity: Entity;
    label: string;
    holdDuration: number;
  };
  'hold-cancelled': {
    entity: Entity;
    /** Progress reached before the cancel, 0..1. */
    progress: number;
    reason: HoldCancelReason;
  };
  /** The interaction fired. `event` is the authored `Interactable.event`. */
  completed: {
    entity: Entity;
    event: string;
    verb: InteractionVerb;
    label: string;
    /** Seconds the action was held. 0 for instant interactions. */
    heldFor: number;
  };
};

export interface InteractionSystemOptions {
  readonly world: GameWorld;
  readonly input: InteractionInputPort;
  /** Which action activates interactions. One action for every type. */
  readonly action?: ButtonAction;
  /**
   * Half-angle of the selection cone in radians. Generous on purpose: a tight
   * cone reads as the game ignoring you.
   */
  readonly coneHalfAngle?: number;
  /** Cone half-angle while interaction assist is on. */
  readonly assistConeHalfAngle?: number;
  /** Range multiplier while interaction assist is on. */
  readonly assistRangeScale?: number;
  /** Accessibility setting: widen the cone and range. */
  readonly interactionAssist?: boolean;
  /**
   * Eye offset from the player transform. Range and the occlusion ray both
   * start here — measuring from the feet rejects anything behind a kerb.
   */
  readonly eyeOffset?: Vec3;
  readonly occlusion?: InteractionOcclusionPort | null;
  readonly canInteract?: CanInteractPredicate;
  /** Weight of view-centredness in the candidate score. */
  readonly alignmentWeight?: number;
  /** Weight of proximity in the candidate score. */
  readonly proximityWeight?: number;
  /**
   * Score bonus the current target keeps, so a challenger must win by a
   * margin. Prevents the prompt flickering between two adjacent objects.
   */
  readonly hysteresisScoreBonus?: number;
  /** Extra metres of reach the current target keeps, in metres. */
  readonly hysteresisRangeSlack?: number;
  /** Cone widening for the current target, in cosine units. */
  readonly hysteresisConeSlack?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;

/** 60° each side. Forgiving rather than finicky. */
const DEFAULT_CONE_HALF_ANGLE = 60 * DEG;
/** Assist widens to nearly a hemisphere. */
const DEFAULT_ASSIST_CONE_HALF_ANGLE = 85 * DEG;
const DEFAULT_ASSIST_RANGE_SCALE = 1.25;
const DEFAULT_EYE_HEIGHT = 1.6;

const DEFAULT_ALIGNMENT_WEIGHT = 1;
const DEFAULT_PROXIMITY_WEIGHT = 0.35;

const DEFAULT_HYSTERESIS_SCORE_BONUS = 0.08;
const DEFAULT_HYSTERESIS_RANGE_SLACK = 0.15;
const DEFAULT_HYSTERESIS_CONE_SLACK = 0.05;

/**
 * Below this planar separation the direction to a target is numerical noise —
 * the player is standing on it. Facing stops being meaningful, so treat it as
 * perfectly centred instead of dividing by ~0.
 */
const PLANAR_EPSILON_SQ = 1e-6;

/**
 * The entity shape the `interactables` query guarantees. Mirrors miniplex's
 * narrowing so the target can be held in a typed field.
 */
type InteractableEntity = Entity & { transform: Transform; interactable: Interactable };

/**
 * Reused inside the candidate loop. Allocating an anchor per interactable per
 * step is pure garbage on a phone; anything escaping the loop gets a copy.
 */
const SCRATCH_ANCHOR: Vec3 = vec3();

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Player forward from yaw.
 *
 * Three.js convention: yaw 0 looks down -Z and positive yaw rotates about +Y,
 * so rotating (0,0,-1) yields (-sin, 0, -cos). Matches the audio listener's
 * default forward, so prompts and panning never disagree.
 */
export function forwardFromYaw(yaw: number): Vec3 {
  return { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
}

/** Writes `transform.position + promptOffset` into `out`. */
function anchorInto(out: Vec3, entity: InteractableEntity): Vec3 {
  const p = entity.transform.position;
  const o = entity.interactable.promptOffset;
  out.x = p.x + o.x;
  out.y = p.y + o.y;
  out.z = p.z + o.z;
  return out;
}

/**
 * Cosine of the horizontal angle between the player's facing and the target,
 * in [-1,1]. 1 is dead centre.
 *
 * Horizontal only: yaw is the only rotation the cone is expressed in, and
 * comparing a full 3D direction against a flat forward vector would reject a
 * valve at the player's feet — the exact object they are obviously looking at.
 * Vertical aim never selects; it only frames the shot.
 */
function planarAlignment(eye: Vec3, forward: Vec3, anchor: Vec3): number {
  const dx = anchor.x - eye.x;
  const dz = anchor.z - eye.z;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq < PLANAR_EPSILON_SQ) return 1;
  const inverseLength = 1 / Math.sqrt(lengthSq);
  return (dx * inverseLength) * forward.x + (dz * inverseLength) * forward.z;
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export class InteractionSystem implements System {
  readonly name = 'interaction';

  private readonly emitter = new Emitter<InteractionEvents>();

  private readonly world: GameWorld;
  private readonly input: InteractionInputPort;
  private readonly action: ButtonAction;
  private readonly coneHalfAngle: number;
  private readonly assistConeHalfAngle: number;
  private readonly assistRangeScale: number;
  private readonly eyeOffset: Vec3;
  private readonly alignmentWeight: number;
  private readonly proximityWeight: number;
  private readonly hysteresisScoreBonus: number;
  private readonly hysteresisRangeSlack: number;
  private readonly hysteresisConeSlack: number;

  private occlusion: InteractionOcclusionPort | null;
  private canInteract: CanInteractPredicate;
  private assistEnabled: boolean;

  /** Pre-computed cone thresholds, so the loop compares cosines not angles. */
  private coneCos: number;
  private assistConeCos: number;

  private current: InteractableEntity | null = null;
  /** Verb/label the last `target-changed` reported, to detect real changes. */
  private currentVerb: InteractionVerb | null = null;
  private currentLabel = '';

  /** Seconds accumulated against the current target, or null when idle. */
  private holdElapsed: number | null = null;
  /**
   * Set after firing and cleared on release, so one press is one interaction
   * and a held button does not machine-gun a repeatable switch.
   */
  private awaitingRelease = false;

  /** Eye position from the most recent step, reused by `target`. */
  private readonly lastEye: Vec3 = vec3();
  private hasPlayer = false;

  constructor(options: InteractionSystemOptions) {
    this.world = options.world;
    this.input = options.input;
    this.action = options.action ?? 'interact';
    this.coneHalfAngle = options.coneHalfAngle ?? DEFAULT_CONE_HALF_ANGLE;
    this.assistConeHalfAngle = options.assistConeHalfAngle ?? DEFAULT_ASSIST_CONE_HALF_ANGLE;
    this.assistRangeScale = options.assistRangeScale ?? DEFAULT_ASSIST_RANGE_SCALE;
    this.eyeOffset = { ...(options.eyeOffset ?? vec3(0, DEFAULT_EYE_HEIGHT, 0)) };
    this.occlusion = options.occlusion ?? null;
    this.canInteract = options.canInteract ?? (() => true);
    this.assistEnabled = options.interactionAssist ?? false;
    this.alignmentWeight = options.alignmentWeight ?? DEFAULT_ALIGNMENT_WEIGHT;
    this.proximityWeight = options.proximityWeight ?? DEFAULT_PROXIMITY_WEIGHT;
    this.hysteresisScoreBonus = options.hysteresisScoreBonus ?? DEFAULT_HYSTERESIS_SCORE_BONUS;
    this.hysteresisRangeSlack = options.hysteresisRangeSlack ?? DEFAULT_HYSTERESIS_RANGE_SLACK;
    this.hysteresisConeSlack = options.hysteresisConeSlack ?? DEFAULT_HYSTERESIS_CONE_SLACK;

    this.coneCos = Math.cos(this.coneHalfAngle);
    this.assistConeCos = Math.cos(this.assistConeHalfAngle);
  }

  // ---- Subscription -----------------------------------------------------

  on<K extends keyof InteractionEvents>(
    event: K,
    handler: Handler<InteractionEvents[K]>,
  ): Unsubscribe {
    return this.emitter.on(event, handler);
  }

  off<K extends keyof InteractionEvents>(event: K, handler: Handler<InteractionEvents[K]>): void {
    this.emitter.off(event, handler);
  }

  // ---- Read model for the HUD ------------------------------------------

  /** The current prompt, or null. Rebuilt on read; only called when drawing. */
  get target(): InteractionTarget | null {
    if (!this.current || !this.hasPlayer) return null;
    return this.snapshot(this.current);
  }

  /** 0..1 hold completion. Cheap enough to poll every rendered frame. */
  get holdProgress(): number {
    if (this.holdElapsed === null || !this.current) return 0;
    const duration = this.current.interactable.holdDuration;
    if (duration <= 0) return 0;
    return Math.min(1, this.holdElapsed / duration);
  }

  get isHolding(): boolean {
    return this.holdElapsed !== null;
  }

  // ---- Configuration ---------------------------------------------------

  /** Accessibility: widen cone and range. Safe to call at any time. */
  setInteractionAssist(enabled: boolean): void {
    this.assistEnabled = enabled;
  }

  setOcclusionPort(port: InteractionOcclusionPort | null): void {
    this.occlusion = port;
  }

  setCanInteract(predicate: CanInteractPredicate): void {
    this.canInteract = predicate;
  }

  /** Drops the target and any hold without firing. For sector/save changes. */
  reset(): void {
    this.cancelHold('reset');
    this.setTarget(null);
    this.awaitingRelease = false;
  }

  dispose(): void {
    this.emitter.clear();
    this.current = null;
    this.holdElapsed = null;
  }

  // ---- Simulation ------------------------------------------------------

  fixedUpdate(dt: number): void {
    // A sequence, dialogue or menu owns the player: no prompt, no progress,
    // and an in-flight hold is abandoned rather than resumed behind the UI.
    if (!this.canInteract()) {
      this.cancelHold('suppressed');
      this.setTarget(null);
      this.hasPlayer = false;
      return;
    }

    const player = this.world.player;
    if (!player?.transform) {
      this.cancelHold('target-lost');
      this.setTarget(null);
      this.hasPlayer = false;
      return;
    }

    this.hasPlayer = true;
    const position = player.transform.position;
    this.lastEye.x = position.x + this.eyeOffset.x;
    this.lastEye.y = position.y + this.eyeOffset.y;
    this.lastEye.z = position.z + this.eyeOffset.z;
    const forward = forwardFromYaw(player.transform.yaw);

    // 1. Selection. A hold in flight locks its target: retargeting mid-hold
    //    would let a camera twitch spend the player's held press on the wrong
    //    object. If the held target stops qualifying the hold dies and normal
    //    selection resumes on the same step.
    if (this.holdElapsed !== null && this.current) {
      if (!this.isStillValid(this.current, forward)) {
        this.cancelHold('target-lost');
        this.setTarget(this.selectBest(forward));
      }
    } else {
      this.setTarget(this.selectBest(forward));
    }

    // 2. Activation.
    const held = this.input.isDown(this.action);
    if (this.awaitingRelease) {
      if (held) return;
      this.awaitingRelease = false;
    }

    if (this.holdElapsed === null) {
      if (this.input.wasPressed(this.action) && this.current) this.beginPress();
      return;
    }

    if (!held) {
      this.cancelHold('released');
      return;
    }

    this.holdElapsed += dt;
    if (this.current && this.holdElapsed >= this.current.interactable.holdDuration) {
      this.complete();
    }
  }

  // ---- Selection -------------------------------------------------------

  /**
   * Picks the best candidate, or null.
   *
   * Not simply the nearest: standing between a breaker panel and a doorframe,
   * "nearest" hands the prompt to whichever happens to be 10 cm closer,
   * regardless of where the player is looking. Score is therefore
   * view-centredness first, proximity second:
   *
   *   score = alignment * alignmentWeight + 1/(1+distance) * proximityWeight
   *
   * `alignment` is the cosine to the target, so a dead-centre object scores a
   * full weight and one at the cone edge scores about half of it. The
   * hyperbolic proximity term needs no normalisation, stays bounded in (0,1]
   * and is monotonic in absolute metres, so between two equally centred
   * objects the nearer always wins — but a centred object 3 m away beats an
   * off-centre one at 2.5 m, which is what the player means.
   */
  private selectBest(forward: Vec3): InteractableEntity | null {
    let best: InteractableEntity | null = null;
    let bestScore = -Infinity;

    for (const entity of this.world.interactables.entities) {
      const score = this.evaluate(entity, forward, entity === this.current);
      if (score === null) continue;
      if (score > bestScore) {
        bestScore = score;
        best = entity;
      }
    }

    return best;
  }

  /**
   * Scores one candidate, or returns null when it is not selectable.
   *
   * Rejection order is cheapest-first: enabled flag, then squared range, then
   * the cone, and only then the occlusion raycast, which is the one test that
   * costs real time.
   */
  private evaluate(
    entity: InteractableEntity,
    forward: Vec3,
    incumbent: boolean,
  ): number | null {
    const interactable = entity.interactable;
    if (!interactable.enabled) return null;

    const anchor = anchorInto(SCRATCH_ANCHOR, entity);
    const range = this.effectiveRange(interactable, incumbent);

    // Squared distance: no sqrt in the hot loop. The sqrt is paid once below,
    // only for candidates that survived every rejection test.
    const distanceSq = distanceSquared(this.lastEye, anchor);
    if (distanceSq > range * range) return null;

    const alignment = planarAlignment(this.lastEye, forward, anchor);
    if (alignment < this.effectiveConeCos(incumbent)) return null;

    if (this.occlusion) {
      // Fresh anchor: the scratch vector is overwritten on the next candidate
      // and a port implementation must be free to hold onto what it is given.
      if (this.occlusion.isOccluded(this.lastEye, { ...anchor })) return null;
    }

    const distance = Math.sqrt(distanceSq);
    let score =
      alignment * this.alignmentWeight + (1 / (1 + distance)) * this.proximityWeight;

    // Hysteresis: the incumbent keeps a margin, so sub-degree camera noise
    // while the player stands still cannot swap the prompt back and forth.
    if (incumbent) score += this.hysteresisScoreBonus;

    return score;
  }

  /** Still in the world, still enabled, still in reach, still visible. */
  private isStillValid(entity: InteractableEntity, forward: Vec3): boolean {
    if (!this.world.interactables.entities.includes(entity)) return false;
    return this.evaluate(entity, forward, true) !== null;
  }

  private effectiveRange(interactable: Interactable, incumbent: boolean): number {
    const assisted = this.assistEnabled
      ? interactable.range * this.assistRangeScale
      : interactable.range;
    return incumbent ? assisted + this.hysteresisRangeSlack : assisted;
  }

  private effectiveConeCos(incumbent: boolean): number {
    const base = this.assistEnabled ? this.assistConeCos : this.coneCos;
    if (!incumbent) return base;
    // Widening means a *lower* cosine threshold. Clamp so it stays a cone.
    return Math.max(-1, base - this.hysteresisConeSlack);
  }

  // ---- Target bookkeeping ----------------------------------------------

  /**
   * Swaps the target and emits only on a real change.
   *
   * A change is a different entity, or the same entity whose verb or label
   * moved (a door's prompt flipping from `open` to `close`). Distance is
   * excluded on purpose: it changes every step and would make this event
   * useless as a "rebuild the prompt" signal.
   */
  private setTarget(next: InteractableEntity | null): void {
    const sameEntity = next === this.current;
    if (sameEntity) {
      if (!next) return;
      const { verb, label } = next.interactable;
      if (verb === this.currentVerb && label === this.currentLabel) return;
    }

    const previous = this.current && this.hasPlayer ? this.snapshot(this.current) : null;

    this.current = next;
    this.currentVerb = next ? next.interactable.verb : null;
    this.currentLabel = next ? next.interactable.label : '';

    // Losing the target mid-hold must not leave a phantom hold running.
    if (!sameEntity && this.holdElapsed !== null) this.holdElapsed = null;

    this.emitter.emit('target-changed', {
      target: next ? this.snapshot(next) : null,
      previous,
    });
  }

  private snapshot(entity: InteractableEntity): InteractionTarget {
    const interactable = entity.interactable;
    const anchor = { ...anchorInto(SCRATCH_ANCHOR, entity) };
    return {
      entity,
      verb: interactable.verb,
      label: interactable.label,
      distance: Math.sqrt(distanceSquared(this.lastEye, anchor)),
      range: this.effectiveRange(interactable, true),
      holdDuration: interactable.holdDuration,
      holdProgress: entity === this.current ? this.holdProgress : 0,
      anchor,
    };
  }

  // ---- Activation ------------------------------------------------------

  private beginPress(): void {
    const entity = this.current;
    if (!entity) return;

    const { holdDuration, label } = entity.interactable;
    this.holdElapsed = 0;

    if (holdDuration <= 0) {
      this.complete();
      return;
    }

    this.emitter.emit('hold-started', { entity, label, holdDuration });
  }

  private cancelHold(reason: HoldCancelReason): void {
    if (this.holdElapsed === null) return;
    const entity = this.current;
    const progress = this.holdProgress;
    this.holdElapsed = null;
    if (!entity) return;
    this.emitter.emit('hold-cancelled', { entity, progress, reason });
  }

  private complete(): void {
    const entity = this.current;
    if (!entity) return;

    const interactable = entity.interactable;
    const heldFor = this.holdElapsed ?? 0;

    // Read the payload before mutating: a one-shot is about to disable itself
    // and listeners should still learn what fired.
    const payload = {
      entity: entity as Entity,
      event: interactable.event,
      verb: interactable.verb,
      label: interactable.label,
      heldFor: interactable.holdDuration > 0 ? heldFor : 0,
    };

    this.holdElapsed = null;
    // One press, one interaction: holding the button must not re-trigger.
    this.awaitingRelease = true;

    // One-shot interactions retire themselves. A pickup that can be taken
    // twice is a duplication bug, not a generous design.
    if (!interactable.repeatable) interactable.enabled = false;

    this.emitter.emit('completed', payload);

    // Clear the prompt in the same step rather than showing a stale one until
    // the next selection pass.
    if (!interactable.enabled) this.setTarget(null);
  }
}
