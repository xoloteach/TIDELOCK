/**
 * Cutscene (sequence) runtime.
 *
 * Plays the authored sequences described by `sequenceSchema`: it walks a
 * time-ordered schedule flattened from parallel tracks and pushes each event at
 * an effect sink. It renders nothing, plays no audio and moves no bones. There
 * is no `three` import, no `AudioEngine` import and no DOM access in this file,
 * and there must never be one — the same system runs under Vitest with no
 * renderer and no audio context at all.
 *
 * Everything is deterministic and driven by `fixedUpdate(dt)`. No `Date.now`,
 * no `requestAnimationFrame`, no render delta: a 32-second cutscene is exactly
 * 1920 steps at 60 Hz whether the machine renders at 30 FPS or 144, which is
 * the only reason a smoke test can assert an act transition completes.
 *
 * The four operations that matter, and the invariants they hold:
 *
 *   `start`   — from the top. Events at t=0 fire before the first step, so the
 *               fade and the control lock are applied on the frame the cutscene
 *               appears rather than one step late.
 *   `skip`    — a skipped cutscene must leave the campaign, the world and the
 *               screen where a watched one would. Standing state (control lock,
 *               letterbox, fade, ambience bed, actor marks, world events) is
 *               settled; one-shots the player chose not to watch (sfx stings,
 *               subtitles, animations, gestures) are dropped; terminal effects
 *               are applied. Control is never left locked, the letterbox is
 *               never left down, and a fade is never left half-applied.
 *   `resume`  — after a pause, a save or a reload. Already-dispatched events are
 *               never re-fired; standing presentation is re-asserted so the
 *               screen matches the recorded time.
 *   `cleanup` — torn down from outside. Everything the sequence took is given
 *               back. A `safe-end` sequence additionally applies its terminal
 *               effects on the way out, so quitting mid-cutscene cannot leave
 *               the story half-written.
 *
 * Effects reach the rest of the game through ports, the same way
 * `DialogueSystem` writes flags and objectives. `applyNarrativeEffect` and the
 * campaign/objective/cinematic ports are imported from there rather than
 * redefined: one implementation of "what does `setFlag` mean", not two.
 */

import type { Vec3 } from '../../engine/ecs/components';
import type { System } from '../../engine/ecs/GameWorld';
import { Emitter } from '../../engine/events';
import type { CinematicState } from '../../persistence/saveSchema';
import {
  applyNarrativeEffect,
  type CampaignStatePort,
  type CinematicUnlockPort,
  type ObjectivePort,
} from '../dialogue/DialogueSystem';
import type {
  NarrativeEffect,
  PresentationTier,
  SequenceId,
  SpeakerId,
} from '../dialogue/dialogueSchema';
import {
  blocksGameplay,
  buildSchedule,
  effectKey,
  sequenceDuration,
  validateSequence,
  type ActorMoveSpeed,
  type CameraHandoffTarget,
  type CheckpointId,
  type CueId,
  type FadeEndpoint,
  type MarkId,
  type ScheduledEvent,
  type Sequence,
  type SequenceEasing,
  type SequenceEvent,
} from './sequenceSchema';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Seconds a forced release takes when the runtime has to settle presentation
 * the content did not settle itself — a skip, or a teardown mid-cutscene.
 *
 * Short but not instant: snapping the letterbox open in a single frame reads as
 * a glitch, and the player who pressed skip is already looking at the screen.
 */
export const SEQUENCE_SETTLE_SECONDS = 0.2;

/** Default blend shape when content does not name one. */
export const DEFAULT_SEQUENCE_EASING: SequenceEasing = 'smooth';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** A framed camera position. Plain data; no `THREE.Vector3` in a game system. */
export interface CameraShot {
  readonly position: Vec3;
  readonly lookAt: Vec3;
  /** Vertical FOV in degrees. Omitted keeps the current lens. */
  readonly fov?: number;
}

/**
 * The cutscene camera, seen from the runtime.
 *
 * The implementation owns the actual camera object and the gameplay camera it
 * borrows from. `release` must be idempotent: it is called on completion, on
 * skip and on teardown, sometimes after the content already handed off.
 */
export interface SequenceCameraPort {
  cut(shot: CameraShot): void;
  blendTo(shot: CameraShot, duration: number, easing: SequenceEasing): void;
  /** Hand the view back to gameplay over `duration`. */
  handOff(target: CameraHandoffTarget, duration: number, easing: SequenceEasing): void;
  /** Track a living actor instead of a fixed point. `bone` is null for the origin. */
  lookAtActor(actor: SpeakerId, bone: string | null): void;
  release(): void;
}

/**
 * Authored actor choreography.
 *
 * `placeAt` exists for settling a skip: the actors must end where the cutscene
 * would have left them, and walking them there over six seconds the player has
 * just declined to watch is not that.
 */
export interface SequenceActorPort {
  moveTo(actor: SpeakerId, mark: MarkId, speed: ActorMoveSpeed): void;
  placeAt(actor: SpeakerId, mark: MarkId): void;
  playAnimation(actor: SpeakerId, clip: string): void;
  playGesture(actor: SpeakerId, clip: string): void;
  lookAt(actor: SpeakerId, mark: MarkId): void;
  turnTo(actor: SpeakerId, mark: MarkId): void;
  /** Choreography is over; normal behaviour resumes. Idempotent. */
  release(): void;
}

export interface SequenceAudioPort {
  /** Ambience bed. Replaces the current bed rather than layering. */
  ambience(cue: CueId, fadeIn: number): void;
  sfx(cue: CueId, fadeIn: number): void;
  /**
   * Stop cues this sequence started. Called on teardown only: a bed a cutscene
   * established is meant to carry into gameplay, so completing or skipping
   * leaves it running.
   */
  stopSequenceCues(): void;
}

export interface SequenceSubtitlePort {
  show(text: string, duration: number, speakerLabel: string | null): void;
  clear(): void;
}

export interface SequenceWorldPort {
  /** Something changed in the world. Gameplay-relevant; a skip still applies it. */
  worldStateEvent(event: string): void;
  /** `duration` is null when the cue latches rather than running for a time. */
  lightCue(cue: CueId, duration: number | null): void;
}

/**
 * Control lock and the two full-screen presentation states.
 *
 * Grouped because they share one invariant: whatever a sequence does to them,
 * it must give back. `fade(from, to, 0)` with `from === to` is a well-defined
 * instruction meaning "the screen is at this state, with no travel" — it is how
 * a resumed cutscene re-asserts a fade it already played.
 */
export interface SequenceControlPort {
  setControlLocked(locked: boolean): void;
  setLetterbox(visible: boolean, duration: number): void;
  fade(from: FadeEndpoint, to: FadeEndpoint, duration: number): void;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type SequenceEndReason =
  /** Played to its end. */
  | 'completed'
  /** The player skipped it. */
  | 'skipped'
  /** Torn down from outside — save loaded, sector unloaded, player quit. */
  | 'aborted';

export type SequenceSuppressedReason =
  /** Another sequence is already running. */
  | 'busy'
  /** A `once` sequence that has already played. */
  | 'already-seen'
  /** Needs `unlockCinematic` first. */
  | 'locked';

export type SequenceEvents = {
  'sequence-started': {
    sequenceId: SequenceId;
    mode: PresentationTier;
    blocksGameplay: boolean;
    duration: number;
  };
  'sequence-ended': { sequenceId: SequenceId; reason: SequenceEndReason };
  /** Every dispatched event, for the diagnostics overlay and integration tests. */
  'sequence-event': {
    sequenceId: SequenceId;
    at: number;
    order: number;
    event: SequenceEvent;
  };
  'sequence-suspended': { sequenceId: SequenceId; elapsed: number };
  'sequence-resumed': { sequenceId: SequenceId; elapsed: number };
  /** The save layer decides whether to honour this. */
  'checkpoint-requested': { sequenceId: SequenceId; checkpointId: CheckpointId };
  'sequence-unlocked': { sequenceId: SequenceId };
  'sequence-suppressed': { sequenceId: SequenceId; reason: SequenceSuppressedReason };
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** A cutscene caught part-way through by a save. */
export interface ActiveSequenceSnapshot {
  readonly sequenceId: SequenceId;
  /** Seconds of the sequence already played. */
  readonly elapsed: number;
  /** Schedule events already dispatched. Resume must not re-fire them. */
  readonly dispatched: number;
}

/**
 * Everything the system knows, including a cutscene in flight.
 *
 * `cinematics` is exactly the `saveSchema.cinematics` slice; `active` is the
 * part a save schema has no field for yet, which is why the snapshot is its own
 * type rather than pretending to be `CinematicState`.
 */
export interface SequenceSnapshot {
  readonly cinematics: CinematicState;
  readonly unlockedIds: readonly SequenceId[];
  readonly active: ActiveSequenceSnapshot | null;
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export interface SequencePorts {
  camera?: SequenceCameraPort | null;
  actors?: SequenceActorPort | null;
  audio?: SequenceAudioPort | null;
  subtitles?: SequenceSubtitlePort | null;
  world?: SequenceWorldPort | null;
  control?: SequenceControlPort | null;
  /** The mission system, for `advanceObjective` terminal effects. */
  missions?: ObjectivePort | null;
}

export interface SequenceSystemOptions extends SequencePorts {
  /** Authored sequences, already parsed. */
  sequences?: readonly Sequence[];
  state: CampaignStatePort;
  /**
   * Lint sequences at registration and refuse the broken ones. On by default:
   * a cutscene that locks control and never unlocks it is an unwinnable game,
   * and finding that out at registration beats finding out at the act
   * transition. Tests that deliberately register broken content turn it off.
   */
  validate?: boolean;
}

interface RunningSequence {
  readonly sequence: Sequence;
  readonly schedule: readonly ScheduledEvent[];
  readonly duration: number;
  /** Seconds played. Fixed-step clock. */
  elapsed: number;
  /** Index of the next schedule entry to dispatch. */
  cursor: number;
  /** True while the clock is stopped but the sequence is still the active one. */
  suspended: boolean;
}

/** Standing presentation state the sequence is responsible for giving back. */
interface PresentationState {
  controlLocked: boolean;
  letterbox: boolean;
  fade: FadeEndpoint;
}

function freshPresentation(): PresentationState {
  return { controlLocked: false, letterbox: false, fade: 'scene' };
}

export class SequenceSystem implements System, CinematicUnlockPort {
  readonly name = 'sequences';

  private readonly emitter = new Emitter<SequenceEvents>();
  private readonly sequences = new Map<SequenceId, Sequence>();
  private readonly ports: SequencePorts;
  private readonly state: CampaignStatePort;
  private readonly validate: boolean;

  /** Persisted: sequences that reached a terminal state, in first-seen order. */
  private readonly seenIds: SequenceId[] = [];
  private readonly seenSet = new Set<SequenceId>();
  /** Persisted separately: story logic may want to know it was skipped. */
  private readonly skippedIds: SequenceId[] = [];
  private readonly skippedSet = new Set<SequenceId>();
  /** Persisted: sequences an `unlockCinematic` effect has armed. */
  private readonly unlockedIds: SequenceId[] = [];
  private readonly unlockedSet = new Set<SequenceId>();

  private running: RunningSequence | null = null;
  private presentation: PresentationState = freshPresentation();
  /**
   * Checkpoint a settled skip owes, held until the run is cleared.
   *
   * A checkpoint written while a cutscene is nominally still running would
   * reload straight back into it.
   */
  private pendingCheckpoint: { sequenceId: SequenceId; checkpointId: CheckpointId } | null =
    null;

  constructor(options: SequenceSystemOptions) {
    this.state = options.state;
    this.validate = options.validate ?? true;
    this.ports = {
      camera: options.camera ?? null,
      actors: options.actors ?? null,
      audio: options.audio ?? null,
      subtitles: options.subtitles ?? null,
      world: options.world ?? null,
      control: options.control ?? null,
      missions: options.missions ?? null,
    };

    for (const sequence of options.sequences ?? []) this.register(sequence);
  }

  on = this.emitter.on.bind(this.emitter);
  off = this.emitter.off.bind(this.emitter);

  /**
   * Adds a sequence to the registry.
   *
   * Duplicate ids and lint errors are both fatal here rather than at play time:
   * two sequences sharing an id makes `start()` ambiguous, and a sequence that
   * never releases control is a soft-locked game.
   */
  register(sequence: Sequence): void {
    if (this.sequences.has(sequence.id)) {
      throw new Error(`Duplicate sequence id "${sequence.id}"`);
    }

    if (this.validate) {
      const result = validateSequence(sequence);
      if (!result.ok) {
        const detail = result.errors.map((issue) => issue.message).join('; ');
        throw new Error(`sequence "${sequence.id}" is invalid: ${detail}`);
      }
    }

    this.sequences.set(sequence.id, sequence);
  }

  getSequence(sequenceId: SequenceId): Sequence | undefined {
    return this.sequences.get(sequenceId);
  }

  // ---- Public state -----------------------------------------------------

  get activeSequenceId(): SequenceId | null {
    return this.running?.sequence.id ?? null;
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  get isSuspended(): boolean {
    return this.running?.suspended ?? false;
  }

  /** Seconds of the active sequence played so far. */
  get elapsed(): number {
    return this.running?.elapsed ?? 0;
  }

  /** Schedule entries dispatched so far in the active sequence. */
  get dispatched(): number {
    return this.running?.cursor ?? 0;
  }

  /** Whether the player's control should be taken away. */
  get blocksGameplay(): boolean {
    return this.running !== null && blocksGameplay(this.running.sequence);
  }

  get isControlLocked(): boolean {
    return this.presentation.controlLocked;
  }

  get isLetterboxVisible(): boolean {
    return this.presentation.letterbox;
  }

  /** Where the last fade landed. `scene` means the game is visible. */
  get fadeState(): FadeEndpoint {
    return this.presentation.fade;
  }

  hasSeen(sequenceId: SequenceId): boolean {
    return this.seenSet.has(sequenceId);
  }

  hasSkipped(sequenceId: SequenceId): boolean {
    return this.skippedSet.has(sequenceId);
  }

  isUnlocked(sequenceId: SequenceId): boolean {
    return this.unlockedSet.has(sequenceId);
  }

  /** Whether `sequenceId` could start right now. Does not start it. */
  canStart(sequenceId: SequenceId): boolean {
    const sequence = this.sequences.get(sequenceId);
    if (!sequence || this.running) return false;
    if (sequence.once && this.seenSet.has(sequenceId)) return false;
    if (sequence.requiresUnlock && !this.unlockedSet.has(sequenceId)) return false;
    return true;
  }

  /**
   * Arms a sequence that declares `requiresUnlock`.
   *
   * This is the `CinematicUnlockPort` the dialogue and mission systems already
   * write through, which is why it accepts ids for content that is not loaded
   * yet: the effect fires when the conversation happens, and the sequence may
   * live in a sector that streams in later.
   */
  unlockCinematic(sequenceId: SequenceId): void {
    if (this.unlockedSet.has(sequenceId)) return;
    this.unlockedSet.add(sequenceId);
    this.unlockedIds.push(sequenceId);
    this.emitter.emit('sequence-unlocked', { sequenceId });
  }

  // ---- Lifecycle --------------------------------------------------------

  /**
   * Starts a sequence from the top. Returns false when it was suppressed, with
   * a `sequence-suppressed` event explaining why.
   *
   * Events at t=0 are dispatched here, before any step: the fade-in, the
   * control lock and the opening camera cut all belong to the frame the
   * cutscene appears on, not to the one after it.
   */
  start(sequenceId: SequenceId): boolean {
    const sequence = this.sequences.get(sequenceId);
    if (!sequence) throw new Error(`Unknown sequence "${sequenceId}"`);

    if (this.running) {
      this.emitter.emit('sequence-suppressed', { sequenceId, reason: 'busy' });
      return false;
    }
    if (sequence.once && this.seenSet.has(sequenceId)) {
      this.emitter.emit('sequence-suppressed', { sequenceId, reason: 'already-seen' });
      return false;
    }
    if (sequence.requiresUnlock && !this.unlockedSet.has(sequenceId)) {
      this.emitter.emit('sequence-suppressed', { sequenceId, reason: 'locked' });
      return false;
    }

    const duration = sequenceDuration(sequence);
    const run: RunningSequence = {
      sequence,
      schedule: buildSchedule(sequence),
      duration,
      elapsed: 0,
      cursor: 0,
      suspended: false,
    };
    this.running = run;
    this.presentation = freshPresentation();

    this.emitter.emit('sequence-started', {
      sequenceId,
      mode: sequence.mode,
      blocksGameplay: blocksGameplay(sequence),
      duration,
    });

    this.pump(run);
    this.finishIfPlayedOut(run);
    return true;
  }

  /**
   * Advances the active sequence.
   *
   * The fixed-step clock, never a render delta: `dt` is the same constant every
   * call, so the schedule is walked identically on every machine and in every
   * test. A suspended sequence does not advance.
   */
  fixedUpdate(dt: number): void {
    const run = this.running;
    if (!run || run.suspended) return;

    run.elapsed += dt;
    this.pump(run);
    this.finishIfPlayedOut(run);
  }

  /**
   * Skips a skippable sequence.
   *
   * Returns false when the sequence cannot be skipped or none is running.
   * See the file header for what "skipped" is required to mean; the short
   * version is that the campaign, the world and the screen end up where a
   * watched playthrough would have left them.
   */
  skip(): boolean {
    const run = this.running;
    if (!run || !run.sequence.skippable) return false;

    const remaining = run.schedule.slice(run.cursor);
    run.cursor = run.schedule.length;
    run.elapsed = run.duration;

    this.settle(run, remaining);
    this.finish(run, 'skipped');
    return true;
  }

  /**
   * Stops the clock without giving anything back.
   *
   * For a pause menu drawn over a running cutscene, and for the moment before a
   * snapshot is taken. The letterbox stays down and control stays locked
   * because the sequence has not ended — `resume()` picks it up, `cleanup()`
   * throws it away.
   */
  suspend(): boolean {
    const run = this.running;
    if (!run || run.suspended) return false;
    run.suspended = true;
    this.emitter.emit('sequence-suspended', {
      sequenceId: run.sequence.id,
      elapsed: run.elapsed,
    });
    return true;
  }

  /**
   * Picks a suspended sequence back up.
   *
   * `restart` replays from the top. `resume-exact` and `safe-end` continue at
   * the recorded time: the cursor is untouched, so nothing already dispatched
   * fires twice, and standing presentation (control lock, letterbox, fade, the
   * last camera framing) is re-asserted so the screen matches the clock. A
   * one-shot the player already heard is not replayed.
   */
  resume(): boolean {
    const run = this.running;
    if (!run || !run.suspended) return false;

    if (run.sequence.resumePolicy === 'restart') {
      // Give back what the abandoned attempt was holding before replaying it,
      // so a letterbox from the first attempt cannot survive into the second.
      this.releasePresentation();
      run.cursor = 0;
      run.elapsed = 0;
      run.suspended = false;
      this.presentation = freshPresentation();
      this.emitter.emit('sequence-resumed', { sequenceId: run.sequence.id, elapsed: 0 });
      this.pump(run);
      this.finishIfPlayedOut(run);
      return true;
    }

    run.suspended = false;
    this.reassertPresentation(run);
    this.emitter.emit('sequence-resumed', {
      sequenceId: run.sequence.id,
      elapsed: run.elapsed,
    });
    // The clock did not move while suspended, so nothing new is due; the next
    // fixedUpdate carries on from here.
    return true;
  }

  /**
   * Tears the active sequence down from outside — a save was loaded, the sector
   * unloaded, the player quit to the menu.
   *
   * Everything the sequence took is given back: control, the letterbox, the
   * fade, the camera, the actors, its audio cues and its subtitle. A `safe-end`
   * sequence also applies its terminal effects and is recorded as seen, because
   * its whole point is that later story may depend on it having happened.
   * Under any other policy the sequence stays replayable and writes nothing.
   */
  cleanup(): boolean {
    const run = this.running;
    if (!run) return false;
    return this.tearDown(run.sequence.resumePolicy === 'safe-end');
  }

  dispose(): void {
    this.cleanup();
    this.emitter.clear();
  }

  /**
   * Gives everything back and clears the active run.
   *
   * `applyEffects` is the `safe-end` guarantee. It is false when a save is being
   * adopted: the run being discarded belonged to the session being replaced, and
   * writing its terminal effects into the campaign state that is arriving would
   * corrupt the save that was just loaded.
   */
  private tearDown(applyEffects: boolean): boolean {
    const run = this.running;
    if (!run) return false;

    this.ports.subtitles?.clear();
    this.ports.audio?.stopSequenceCues();
    this.ports.actors?.release();
    this.ports.camera?.release();
    this.releasePresentation();

    this.running = null;
    this.pendingCheckpoint = null;

    if (applyEffects) {
      this.markSeen(run.sequence.id);
      this.applyTerminalEffects(run.sequence);
    }

    this.emitter.emit('sequence-ended', { sequenceId: run.sequence.id, reason: 'aborted' });
    return true;
  }

  // ---- Dispatch ---------------------------------------------------------

  /**
   * Dispatches everything due at or before the current time.
   *
   * `at <= elapsed` rather than `<`, so a t=0 event fires on the frame the
   * sequence starts. The guard on `this.running` is not paranoia: a port
   * implementation is allowed to call `skip()` or `cleanup()` while handling an
   * event, and the loop must notice that the run it is walking is over.
   */
  private pump(run: RunningSequence): void {
    while (
      this.running === run &&
      !run.suspended &&
      run.cursor < run.schedule.length &&
      run.schedule[run.cursor].at <= run.elapsed
    ) {
      const scheduled = run.schedule[run.cursor];
      run.cursor += 1;
      this.dispatch(run, scheduled);
    }
  }

  private finishIfPlayedOut(run: RunningSequence): void {
    if (this.running !== run || run.suspended) return;
    if (run.cursor < run.schedule.length) return;
    if (run.elapsed < run.duration) return;
    this.finish(run, 'completed');
  }

  /**
   * Routes one event to its port.
   *
   * Exhaustive over `SequenceEvent`, so adding an event kind to the schema is a
   * compile error here rather than an authored event that silently does nothing.
   */
  private dispatch(run: RunningSequence, scheduled: ScheduledEvent): void {
    const event = scheduled.event;
    const { camera, actors, audio, subtitles, world, control } = this.ports;

    switch (event.kind) {
      case 'controlLock':
        this.presentation.controlLocked = event.locked;
        this.require(control, 'controlLock')?.setControlLocked(event.locked);
        break;
      case 'fade':
        this.presentation.fade = event.to;
        this.require(control, 'fade')?.fade(event.from, event.to, event.duration);
        break;
      case 'letterbox':
        this.presentation.letterbox = event.visible;
        this.require(control, 'letterbox')?.setLetterbox(event.visible, event.duration);
        break;
      case 'checkpointCue':
        this.emitter.emit('checkpoint-requested', {
          sequenceId: run.sequence.id,
          checkpointId: event.checkpointId,
        });
        break;
      case 'cameraCut':
        this.require(camera, 'cameraCut')?.cut(toShot(event));
        break;
      case 'cameraBlend':
        if (event.target !== undefined) {
          this.require(camera, 'cameraBlend')?.handOff(
            event.target,
            event.duration,
            event.easing ?? DEFAULT_SEQUENCE_EASING,
          );
        } else {
          this.require(camera, 'cameraBlend')?.blendTo(
            toShot(event),
            event.duration,
            event.easing ?? DEFAULT_SEQUENCE_EASING,
          );
        }
        break;
      case 'cameraLookTarget':
        this.require(camera, 'cameraLookTarget')?.lookAtActor(event.actor, event.bone ?? null);
        break;
      case 'actorMoveTo':
        this.withActor(scheduled, (actor) =>
          this.require(actors, 'actorMoveTo')?.moveTo(actor, event.mark, event.speed),
        );
        break;
      case 'actorAnimation':
        this.withActor(scheduled, (actor) =>
          this.require(actors, 'actorAnimation')?.playAnimation(actor, event.clip),
        );
        break;
      case 'actorGesture':
        this.withActor(scheduled, (actor) =>
          this.require(actors, 'actorGesture')?.playGesture(actor, event.clip),
        );
        break;
      case 'actorLookAt':
        this.withActor(scheduled, (actor) =>
          this.require(actors, 'actorLookAt')?.lookAt(actor, event.mark),
        );
        break;
      case 'actorTurnTo':
        this.withActor(scheduled, (actor) =>
          this.require(actors, 'actorTurnTo')?.turnTo(actor, event.mark),
        );
        break;
      case 'ambienceCue':
        this.require(audio, 'ambienceCue')?.ambience(event.cue, event.fadeIn ?? 0);
        break;
      case 'sfxCue':
        this.require(audio, 'sfxCue')?.sfx(event.cue, event.fadeIn ?? 0);
        break;
      case 'subtitleCue':
        this.require(subtitles, 'subtitleCue')?.show(
          event.text,
          event.duration,
          event.speakerLabel,
        );
        break;
      case 'worldStateEvent':
        this.require(world, 'worldStateEvent')?.worldStateEvent(event.event);
        break;
      case 'lightCue':
        this.require(world, 'lightCue')?.lightCue(event.cue, event.duration ?? null);
        break;
    }

    this.emitter.emit('sequence-event', {
      sequenceId: run.sequence.id,
      at: scheduled.at,
      order: scheduled.order,
      event,
    });
  }

  /**
   * A missing port is a wiring bug, not a content bug.
   *
   * Reported once per event rather than thrown: a diagnostics harness that
   * wires only the camera should still be able to scrub a cutscene, and a
   * half-wired shipping build is loud in the console instead of silently
   * dropping half the choreography.
   */
  private require<T>(port: T | null | undefined, kind: string): T | undefined {
    if (port === null || port === undefined) {
      console.warn(`[sequences] event "${kind}" had no port wired`);
      return undefined;
    }
    return port;
  }

  /** Actor events carry their actor on the track, not on the event. */
  private withActor(scheduled: ScheduledEvent, run: (actor: SpeakerId) => void): void {
    if (scheduled.actor === undefined) {
      console.warn(
        `[sequences] event "${scheduled.event.kind}" at ${scheduled.at}s is not on an actor track`,
      );
      return;
    }
    run(scheduled.actor);
  }

  // ---- Settling ---------------------------------------------------------

  /**
   * Collapses the events a skip did not play into their end state.
   *
   * The split is between state and performance. Standing state — control lock,
   * letterbox, fade, the ambience bed, where the actors are standing, what the
   * world did — has to be applied, or the player lands in a world that does not
   * match the one the cutscene was describing. A performance the player
   * declined to watch — sfx stings, subtitles, animations, gestures, walking
   * someone across a platform — is dropped.
   *
   * Only the last value of each standing key is applied, so skipping a cutscene
   * that flickers a light six times does not flicker it six times now.
   */
  private settle(run: RunningSequence, remaining: readonly ScheduledEvent[]): void {
    const { camera, actors, audio, subtitles, world, control } = this.ports;

    let lastControlLock: boolean | null = null;
    let lastLetterbox: boolean | null = null;
    let lastFade: { from: FadeEndpoint; to: FadeEndpoint } | null = null;
    let lastAmbience: { cue: CueId; fadeIn: number } | null = null;
    let lastCheckpoint: CheckpointId | null = null;
    const lastMark = new Map<SpeakerId, MarkId>();
    const lastFacing = new Map<SpeakerId, MarkId>();
    const lastLook = new Map<SpeakerId, MarkId>();
    const worldEvents: string[] = [];
    const lightCues = new Map<CueId, number | null>();

    for (const scheduled of remaining) {
      const event = scheduled.event;
      switch (event.kind) {
        case 'controlLock':
          lastControlLock = event.locked;
          break;
        case 'letterbox':
          lastLetterbox = event.visible;
          break;
        case 'fade':
          lastFade = { from: event.from, to: event.to };
          break;
        case 'ambienceCue':
          lastAmbience = { cue: event.cue, fadeIn: event.fadeIn ?? 0 };
          break;
        case 'checkpointCue':
          lastCheckpoint = event.checkpointId;
          break;
        case 'actorMoveTo':
          if (scheduled.actor !== undefined) lastMark.set(scheduled.actor, event.mark);
          break;
        case 'actorTurnTo':
          if (scheduled.actor !== undefined) lastFacing.set(scheduled.actor, event.mark);
          break;
        case 'actorLookAt':
          if (scheduled.actor !== undefined) lastLook.set(scheduled.actor, event.mark);
          break;
        case 'worldStateEvent':
          worldEvents.push(event.event);
          break;
        case 'lightCue':
          // Re-inserted so a cue re-issued later keeps its later position.
          lightCues.delete(event.cue);
          lightCues.set(event.cue, event.duration ?? null);
          break;
        default:
          // sfxCue, subtitleCue, actorAnimation, actorGesture, camera framing:
          // performance, not state.
          break;
      }
    }

    subtitles?.clear();

    for (const worldEvent of worldEvents) world?.worldStateEvent(worldEvent);
    for (const [cue, duration] of lightCues) world?.lightCue(cue, duration);
    if (lastAmbience) audio?.ambience(lastAmbience.cue, lastAmbience.fadeIn);

    for (const [actor, mark] of lastMark) actors?.placeAt(actor, mark);
    for (const [actor, mark] of lastFacing) actors?.turnTo(actor, mark);
    for (const [actor, mark] of lastLook) actors?.lookAt(actor, mark);

    if (lastControlLock !== null && lastControlLock !== this.presentation.controlLocked) {
      this.presentation.controlLocked = lastControlLock;
      control?.setControlLocked(lastControlLock);
    }
    if (lastLetterbox !== null && lastLetterbox !== this.presentation.letterbox) {
      this.presentation.letterbox = lastLetterbox;
      control?.setLetterbox(lastLetterbox, SEQUENCE_SETTLE_SECONDS);
    }
    if (lastFade !== null && lastFade.to !== this.presentation.fade) {
      this.presentation.fade = lastFade.to;
      control?.fade(lastFade.from, lastFade.to, SEQUENCE_SETTLE_SECONDS);
    }

    if (lastCheckpoint !== null) {
      this.pendingCheckpoint = { sequenceId: run.sequence.id, checkpointId: lastCheckpoint };
    }

    camera?.release();
  }

  /**
   * Gives back anything the sequence still holds.
   *
   * Authored content is expected to release its own control lock, letterbox and
   * fade — `validateSequence` errors when it does not — so on a clean
   * completion this is a no-op. It is the net under a skip, a teardown, and
   * content that slipped through with validation disabled.
   */
  private releasePresentation(): void {
    const control = this.ports.control;

    if (this.presentation.letterbox) {
      this.presentation.letterbox = false;
      control?.setLetterbox(false, SEQUENCE_SETTLE_SECONDS);
    }
    if (this.presentation.fade !== 'scene') {
      const from = this.presentation.fade;
      this.presentation.fade = 'scene';
      control?.fade(from, 'scene', SEQUENCE_SETTLE_SECONDS);
    }
    if (this.presentation.controlLocked) {
      // Last, so control comes back to a screen the player can see.
      this.presentation.controlLocked = false;
      control?.setControlLocked(false);
    }
  }

  /**
   * Re-asserts standing presentation from the events already dispatched.
   *
   * Replays state, not performance: the last control lock, letterbox and fade
   * values, the last camera framing and look target. Nothing that was heard
   * once is heard again.
   */
  private reassertPresentation(run: RunningSequence): void {
    const { camera, control } = this.ports;

    let shot: CameraShot | null = null;
    let handOff: CameraHandoffTarget | null = null;
    let lookActor: { actor: SpeakerId; bone: string | null } | null = null;

    for (let index = 0; index < run.cursor; index += 1) {
      const event = run.schedule[index].event;
      switch (event.kind) {
        case 'cameraCut':
          shot = toShot(event);
          handOff = null;
          break;
        case 'cameraBlend':
          if (event.target !== undefined) {
            handOff = event.target;
            shot = null;
          } else {
            shot = toShot(event);
            handOff = null;
          }
          break;
        case 'cameraLookTarget':
          lookActor = { actor: event.actor, bone: event.bone ?? null };
          break;
        default:
          break;
      }
    }

    control?.setControlLocked(this.presentation.controlLocked);
    control?.setLetterbox(this.presentation.letterbox, 0);
    control?.fade(this.presentation.fade, this.presentation.fade, 0);

    if (handOff !== null) camera?.handOff(handOff, 0, DEFAULT_SEQUENCE_EASING);
    else if (shot !== null) camera?.cut(shot);
    if (lookActor !== null) camera?.lookAtActor(lookActor.actor, lookActor.bone);
  }

  /**
   * Ends a run: releases what is outstanding, records it, applies its terminal
   * effects, then announces it.
   *
   * The active run is cleared before the effects land so anything reacting to
   * `sequence-ended` — including a listener that starts the next sequence —
   * sees a settled system rather than one still nominally mid-cutscene.
   */
  private finish(run: RunningSequence, reason: Exclude<SequenceEndReason, 'aborted'>): void {
    this.ports.subtitles?.clear();
    this.ports.actors?.release();
    this.ports.camera?.release();
    this.releasePresentation();

    this.running = null;

    this.markSeen(run.sequence.id);
    if (reason === 'skipped') this.markSkipped(run.sequence.id);

    const checkpoint = this.pendingCheckpoint;
    this.pendingCheckpoint = null;

    this.applyTerminalEffects(run.sequence);

    if (checkpoint) this.emitter.emit('checkpoint-requested', checkpoint);
    this.emitter.emit('sequence-ended', { sequenceId: run.sequence.id, reason });
  }

  /**
   * Applies `onComplete`, then `onSkip`.
   *
   * Both lists, in that order, on every terminal path — a skipped or abandoned
   * cutscene must leave the campaign where a watched one would, and `onSkip`
   * exists for what skipping *additionally* implies rather than as a substitute
   * list. Structurally identical effects are applied once, so the common case of
   * content repeating the same two effects in both lists does not advance an
   * objective twice.
   */
  private applyTerminalEffects(sequence: Sequence): void {
    const applied = new Set<string>();
    const effects: NarrativeEffect[] = [
      ...(sequence.onComplete ?? []),
      ...(sequence.onSkip ?? []),
    ];

    for (const effect of effects) {
      const key = effectKey(effect);
      if (applied.has(key)) continue;
      applied.add(key);
      applyNarrativeEffect(effect, {
        state: this.state,
        missions: this.ports.missions ?? null,
        // A cutscene unlocking another cutscene is this system's own business.
        cinematics: this,
      });
    }
  }

  private markSeen(sequenceId: SequenceId): void {
    if (this.seenSet.has(sequenceId)) return;
    this.seenSet.add(sequenceId);
    this.seenIds.push(sequenceId);
  }

  private markSkipped(sequenceId: SequenceId): void {
    if (this.skippedSet.has(sequenceId)) return;
    this.skippedSet.add(sequenceId);
    this.skippedIds.push(sequenceId);
  }

  // ---- Persistence ------------------------------------------------------

  /**
   * The `cinematics` slice of a save, exactly as `saveSchema` expects it.
   *
   * Arrays are copies in first-seen order, so two serialises of the same state
   * are deep-equal and a save diff is readable.
   */
  serialise(): CinematicState {
    return { seenIds: [...this.seenIds], skippedIds: [...this.skippedIds] };
  }

  /**
   * Adopts a stored cinematic slice.
   *
   * Tears down anything running: it belonged to the session being replaced.
   * Ids for content that no longer exists are kept rather than dropped —
   * this is history, and forgetting a cutscene was watched would replay it if
   * the content came back.
   */
  restore(state: CinematicState): void {
    this.tearDown(false);

    this.seenIds.length = 0;
    this.seenSet.clear();
    for (const id of state.seenIds) this.markSeen(id);

    this.skippedIds.length = 0;
    this.skippedSet.clear();
    for (const id of state.skippedIds) this.markSkipped(id);
  }

  /**
   * Everything, including a cutscene in flight.
   *
   * `dispatched` is what makes resume safe: it is a count of schedule entries,
   * and the schedule is derived deterministically from authored data, so the
   * same content always resolves the same count back to the same position.
   */
  snapshot(): SequenceSnapshot {
    const run = this.running;
    return {
      cinematics: this.serialise(),
      unlockedIds: [...this.unlockedIds],
      active:
        run === null
          ? null
          : {
              sequenceId: run.sequence.id,
              elapsed: run.elapsed,
              dispatched: run.cursor,
            },
    };
  }

  /**
   * Adopts a full snapshot.
   *
   * A restored in-flight sequence comes back *suspended*, never playing: the
   * game is still loading a sector when a save is adopted, and re-asserting a
   * camera and a control lock into a half-built world is how a cutscene ends up
   * looking at nothing. The caller calls `resume()` when the world is ready,
   * which is also what re-applies the letterbox and the fade.
   *
   * A snapshot naming content that is not registered is reported and dropped
   * rather than silently ignored, and the presentation state is left clean so a
   * missing cutscene cannot leave the player locked out of their own game.
   */
  restoreSnapshot(snapshot: SequenceSnapshot): void {
    this.restore(snapshot.cinematics);

    this.unlockedIds.length = 0;
    this.unlockedSet.clear();
    for (const id of snapshot.unlockedIds) {
      if (this.unlockedSet.has(id)) continue;
      this.unlockedSet.add(id);
      this.unlockedIds.push(id);
    }

    const active = snapshot.active;
    if (!active) return;

    const sequence = this.sequences.get(active.sequenceId);
    if (!sequence) {
      console.warn(
        `[sequences] snapshot resumes unknown sequence "${active.sequenceId}"; dropped`,
      );
      return;
    }

    const schedule = buildSchedule(sequence);
    const cursor = Math.min(Math.max(active.dispatched, 0), schedule.length);
    if (cursor !== active.dispatched) {
      // The content changed under a save. Clamping keeps the cutscene playable
      // instead of throwing, and says so.
      console.warn(
        `[sequences] snapshot of "${active.sequenceId}" dispatched ${active.dispatched} of ${schedule.length} events; clamped to ${cursor}`,
      );
    }

    this.running = {
      sequence,
      schedule,
      duration: sequenceDuration(sequence),
      elapsed: Math.max(active.elapsed, 0),
      cursor,
      suspended: true,
    };
    // Rebuilt from the dispatched prefix rather than persisted: it is derived
    // state, and deriving it cannot disagree with the schedule.
    this.presentation = presentationAt(this.running.schedule, cursor);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toShot(event: { position?: Vec3; lookAt?: Vec3; fov?: number }): CameraShot {
  // `validateSequence` rejects a shot missing either half, so the fallbacks are
  // only reachable through content registered with validation disabled.
  return {
    position: event.position ?? { x: 0, y: 0, z: 0 },
    lookAt: event.lookAt ?? { x: 0, y: 0, z: -1 },
    ...(event.fov !== undefined ? { fov: event.fov } : {}),
  };
}

/** Standing presentation state implied by the first `cursor` schedule entries. */
function presentationAt(
  schedule: readonly ScheduledEvent[],
  cursor: number,
): PresentationState {
  const state = freshPresentation();
  for (let index = 0; index < cursor && index < schedule.length; index += 1) {
    const event = schedule[index].event;
    if (event.kind === 'controlLock') state.controlLocked = event.locked;
    else if (event.kind === 'letterbox') state.letterbox = event.visible;
    else if (event.kind === 'fade') state.fade = event.to;
  }
  return state;
}
