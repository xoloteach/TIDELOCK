/**
 * Authored cutscene (sequence) data model.
 *
 * A sequence is a set of parallel tracks of timestamped events: presentation
 * (control lock, letterbox, fade, checkpoint), camera, actor choreography,
 * audio, subtitles and world state. Nothing here plays anything and nothing
 * here touches a renderer — `SequenceSystem` walks the schedule this module
 * derives and pushes each event at an effect sink.
 *
 * The same two-layer split the dialogue and mission content uses:
 *
 *   `sequenceSchema`   — shape validation (Zod). Objects are strict, so a typo
 *                        like `durration` is a load-time failure rather than a
 *                        silently dropped field.
 *   `validateSequence` — authoring lint over an already-typed sequence. Errors
 *                        are the failure modes that strand a player: a cutscene
 *                        that locks control and never unlocks it, a letterbox
 *                        that never lifts, a fade that ends on black, a skip
 *                        that quietly drops progress a watched playthrough
 *                        would have granted. Warnings are authoring smells.
 *
 * The narrative primitives (conditions, effects, cast, presentation tiers) come
 * from `dialogueSchema` rather than being redefined here, for the same reason
 * `missionSchema` imports them: one definition of "what does `setFlag` mean".
 */

import { z } from 'zod';
import type { Vec3 } from '../../engine/ecs/components';
import {
  findBannedPhrases,
  findPlaceholderMarkers,
  narrativeEffectSchema,
  presentationTierSchema,
  speakerIdSchema,
  type IssueSeverity,
  type NarrativeEffect,
  type ObjectiveId,
  type PresentationTier,
  type SequenceId,
  type SpeakerId,
  type ValidationIssue,
  type ValidationResult,
} from '../dialogue/dialogueSchema';

export type { SequenceId } from '../dialogue/dialogueSchema';

/** Authored world-space mark, e.g. `depot.overlook_rail`. Content owns the ids. */
export type MarkId = string;
/** Audio/light cue id resolved by the audio and lighting layers. */
export type CueId = string;
/** Checkpoint id the save layer writes under. */
export type CheckpointId = string;

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/**
 * Track kinds.
 *
 * One kind may appear more than once — a second `camera` track carrying look
 * targets alongside the shot track is normal, and each actor gets their own
 * track. What a kind buys is a home for the events that belong to it and a
 * deterministic tie-break when two tracks fire on the same frame.
 */
export const SEQUENCE_TRACK_KINDS = [
  'presentation',
  'camera',
  'actor',
  'audio',
  'dialogue',
  'world',
] as const;
export type SequenceTrackKind = (typeof SEQUENCE_TRACK_KINDS)[number];

/**
 * What happens when a sequence that was cut short is picked up again.
 *
 * `restart`      — replay from the top. For short stings where resuming
 *                  mid-shot would look broken.
 * `resume-exact` — continue at the recorded time. Already-dispatched events are
 *                  not re-fired; standing presentation state (control lock,
 *                  letterbox, fade, last camera shot) is re-asserted.
 * `safe-end`     — `resume-exact`, plus a guarantee at the other end: a
 *                  `safe-end` sequence may never be abandoned half-applied. If
 *                  it is torn down without completing, its terminal effects are
 *                  applied anyway. Anything that gates later story on a
 *                  cutscene having happened wants this.
 */
export const SEQUENCE_RESUME_POLICIES = ['restart', 'resume-exact', 'safe-end'] as const;
export type SequenceResumePolicy = (typeof SEQUENCE_RESUME_POLICIES)[number];

/** Interpolation shape for a camera blend. */
export const SEQUENCE_EASINGS = ['linear', 'smooth', 'damped'] as const;
export type SequenceEasing = (typeof SEQUENCE_EASINGS)[number];

/**
 * Fade endpoints. `scene` means "the game is visible", which is the only state
 * a sequence is allowed to end in.
 */
export const FADE_ENDPOINTS = ['black', 'white', 'scene'] as const;
export type FadeEndpoint = (typeof FADE_ENDPOINTS)[number];

/** How an actor covers ground to a mark. `stand` places them without walking. */
export const ACTOR_MOVE_SPEEDS = ['stand', 'walk', 'run'] as const;
export type ActorMoveSpeed = (typeof ACTOR_MOVE_SPEEDS)[number];

/** Where a camera blend can hand off to instead of an authored shot. */
export const CAMERA_HANDOFF_TARGETS = ['gameplay'] as const;
export type CameraHandoffTarget = (typeof CAMERA_HANDOFF_TARGETS)[number];

const vec3Schema = z.strictObject({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

/** Seconds from the start of the sequence. */
const atSchema = z.number().min(0);

// ---------------------------------------------------------------------------
// Presentation events
// ---------------------------------------------------------------------------

/** Takes gameplay control away, or gives it back. */
export interface ControlLockEvent {
  at: number;
  kind: 'controlLock';
  locked: boolean;
}

export interface FadeEvent {
  at: number;
  kind: 'fade';
  from: FadeEndpoint;
  to: FadeEndpoint;
  duration: number;
}

export interface LetterboxEvent {
  at: number;
  kind: 'letterbox';
  visible: boolean;
  /** Seconds the bars take to travel. */
  duration: number;
}

/** Asks the save layer for a checkpoint. The save layer decides. */
export interface CheckpointCueEvent {
  at: number;
  kind: 'checkpointCue';
  checkpointId: CheckpointId;
}

export type PresentationEvent =
  | ControlLockEvent
  | FadeEvent
  | LetterboxEvent
  | CheckpointCueEvent;

const controlLockSchema = z.strictObject({
  at: atSchema,
  kind: z.literal('controlLock'),
  locked: z.boolean(),
});

const fadeSchema = z.strictObject({
  at: atSchema,
  kind: z.literal('fade'),
  from: z.enum(FADE_ENDPOINTS),
  to: z.enum(FADE_ENDPOINTS),
  duration: z.number().min(0),
});

const letterboxSchema = z.strictObject({
  at: atSchema,
  kind: z.literal('letterbox'),
  visible: z.boolean(),
  duration: z.number().min(0),
});

const checkpointCueSchema = z.strictObject({
  at: atSchema,
  kind: z.literal('checkpointCue'),
  checkpointId: z.string().min(1),
});

export const presentationEventSchema = z.discriminatedUnion('kind', [
  controlLockSchema,
  fadeSchema,
  letterboxSchema,
  checkpointCueSchema,
]);

// ---------------------------------------------------------------------------
// Camera events
// ---------------------------------------------------------------------------

export interface CameraCutEvent {
  at: number;
  kind: 'cameraCut';
  position: Vec3;
  lookAt: Vec3;
  /** Vertical FOV in degrees. Omitted keeps the current lens. */
  fov?: number;
}

/**
 * Moves the camera over `duration`.
 *
 * Either an authored destination (`position` + `lookAt`) or a handoff
 * (`target: 'gameplay'`) — never both and never neither.
 * `validateSequence` enforces that, because the schema cannot express "exactly
 * one of these" inside a discriminated union without giving up strict objects.
 */
export interface CameraBlendEvent {
  at: number;
  kind: 'cameraBlend';
  position?: Vec3;
  lookAt?: Vec3;
  fov?: number;
  target?: CameraHandoffTarget;
  duration: number;
  easing?: SequenceEasing;
}

/** Points the sequence camera at a living actor rather than a fixed point. */
export interface CameraLookTargetEvent {
  at: number;
  kind: 'cameraLookTarget';
  actor: SpeakerId;
  /** Skeleton bone, e.g. `head`. Omitted uses the actor origin. */
  bone?: string;
}

export type CameraEvent = CameraCutEvent | CameraBlendEvent | CameraLookTargetEvent;

const cameraCutSchema = z.strictObject({
  at: atSchema,
  kind: z.literal('cameraCut'),
  position: vec3Schema,
  lookAt: vec3Schema,
  fov: z.number().positive().max(179).optional(),
});

const cameraBlendSchema = z.strictObject({
  at: atSchema,
  kind: z.literal('cameraBlend'),
  position: vec3Schema.optional(),
  lookAt: vec3Schema.optional(),
  fov: z.number().positive().max(179).optional(),
  target: z.enum(CAMERA_HANDOFF_TARGETS).optional(),
  duration: z.number().min(0),
  easing: z.enum(SEQUENCE_EASINGS).optional(),
});

const cameraLookTargetSchema = z.strictObject({
  at: atSchema,
  kind: z.literal('cameraLookTarget'),
  actor: speakerIdSchema,
  bone: z.string().min(1).optional(),
});

export const cameraEventSchema = z.discriminatedUnion('kind', [
  cameraCutSchema,
  cameraBlendSchema,
  cameraLookTargetSchema,
]);

// ---------------------------------------------------------------------------
// Actor events
// ---------------------------------------------------------------------------

export interface ActorMoveToEvent {
  at: number;
  kind: 'actorMoveTo';
  mark: MarkId;
  speed: ActorMoveSpeed;
}

export interface ActorAnimationEvent {
  at: number;
  kind: 'actorAnimation';
  clip: string;
}

/** Upper-body look, without turning the body. */
export interface ActorLookAtEvent {
  at: number;
  kind: 'actorLookAt';
  mark: MarkId;
}

/** Turns the whole body to face a mark. */
export interface ActorTurnToEvent {
  at: number;
  kind: 'actorTurnTo';
  mark: MarkId;
}

/** Additive one-shot layered over whatever the actor is doing. */
export interface ActorGestureEvent {
  at: number;
  kind: 'actorGesture';
  clip: string;
}

export type ActorEvent =
  | ActorMoveToEvent
  | ActorAnimationEvent
  | ActorLookAtEvent
  | ActorTurnToEvent
  | ActorGestureEvent;

const actorMoveToSchema = z.strictObject({
  at: atSchema,
  kind: z.literal('actorMoveTo'),
  mark: z.string().min(1),
  speed: z.enum(ACTOR_MOVE_SPEEDS),
});

const actorAnimationSchema = z.strictObject({
  at: atSchema,
  kind: z.literal('actorAnimation'),
  clip: z.string().min(1),
});

const actorLookAtSchema = z.strictObject({
  at: atSchema,
  kind: z.literal('actorLookAt'),
  mark: z.string().min(1),
});

const actorTurnToSchema = z.strictObject({
  at: atSchema,
  kind: z.literal('actorTurnTo'),
  mark: z.string().min(1),
});

const actorGestureSchema = z.strictObject({
  at: atSchema,
  kind: z.literal('actorGesture'),
  clip: z.string().min(1),
});

export const actorEventSchema = z.discriminatedUnion('kind', [
  actorMoveToSchema,
  actorAnimationSchema,
  actorLookAtSchema,
  actorTurnToSchema,
  actorGestureSchema,
]);

// ---------------------------------------------------------------------------
// Audio events
// ---------------------------------------------------------------------------

/** Ambience bed. Replaces the previous bed rather than layering. */
export interface AmbienceCueEvent {
  at: number;
  kind: 'ambienceCue';
  cue: CueId;
  fadeIn?: number;
}

export interface SfxCueEvent {
  at: number;
  kind: 'sfxCue';
  cue: CueId;
  fadeIn?: number;
}

export type AudioEvent = AmbienceCueEvent | SfxCueEvent;

const ambienceCueSchema = z.strictObject({
  at: atSchema,
  kind: z.literal('ambienceCue'),
  cue: z.string().min(1),
  fadeIn: z.number().min(0).optional(),
});

const sfxCueSchema = z.strictObject({
  at: atSchema,
  kind: z.literal('sfxCue'),
  cue: z.string().min(1),
  fadeIn: z.number().min(0).optional(),
});

export const audioEventSchema = z.discriminatedUnion('kind', [
  ambienceCueSchema,
  sfxCueSchema,
]);

// ---------------------------------------------------------------------------
// Dialogue (subtitle) events
// ---------------------------------------------------------------------------

/**
 * A line of subtitle owned by the cutscene rather than by a dialogue scene.
 *
 * `speakerLabel` is `null` for sound the player hears but nobody is credited
 * with — a radio nobody is holding, an announcement over a depot PA. Spoken
 * conversations belong in `content/dialogue`, not here.
 */
export interface SubtitleCueEvent {
  at: number;
  kind: 'subtitleCue';
  text: string;
  duration: number;
  speakerLabel: string | null;
}

export type SequenceDialogueEvent = SubtitleCueEvent;

const subtitleCueSchema = z.strictObject({
  at: atSchema,
  kind: z.literal('subtitleCue'),
  text: z.string().min(1),
  duration: z.number().positive(),
  speakerLabel: z.string().min(1).nullable(),
});

export const sequenceDialogueEventSchema = z.discriminatedUnion('kind', [subtitleCueSchema]);

// ---------------------------------------------------------------------------
// World events
// ---------------------------------------------------------------------------

/**
 * Something changes in the world: a pump drops discharge, a gate finishes
 * travelling. Gameplay-relevant, so a skipped cutscene still applies it.
 */
export interface WorldStateEvent {
  at: number;
  kind: 'worldStateEvent';
  event: string;
}

export interface LightCueEvent {
  at: number;
  kind: 'lightCue';
  cue: CueId;
  /** Seconds the cue runs for. Omitted means it latches. */
  duration?: number;
}

export type SequenceWorldEvent = WorldStateEvent | LightCueEvent;

const worldStateEventSchema = z.strictObject({
  at: atSchema,
  kind: z.literal('worldStateEvent'),
  event: z.string().min(1),
});

const lightCueSchema = z.strictObject({
  at: atSchema,
  kind: z.literal('lightCue'),
  cue: z.string().min(1),
  duration: z.number().min(0).optional(),
});

export const sequenceWorldEventSchema = z.discriminatedUnion('kind', [
  worldStateEventSchema,
  lightCueSchema,
]);

// ---------------------------------------------------------------------------
// Any event
// ---------------------------------------------------------------------------

export type SequenceEvent =
  | PresentationEvent
  | CameraEvent
  | ActorEvent
  | AudioEvent
  | SequenceDialogueEvent
  | SequenceWorldEvent;

export type SequenceEventKind = SequenceEvent['kind'];

/** Every event kind, grouped by the track kind allowed to carry it. */
export const EVENT_KINDS_BY_TRACK: Readonly<
  Record<SequenceTrackKind, readonly SequenceEventKind[]>
> = {
  presentation: ['controlLock', 'fade', 'letterbox', 'checkpointCue'],
  camera: ['cameraCut', 'cameraBlend', 'cameraLookTarget'],
  actor: [
    'actorMoveTo',
    'actorAnimation',
    'actorLookAt',
    'actorTurnTo',
    'actorGesture',
  ],
  audio: ['ambienceCue', 'sfxCue'],
  dialogue: ['subtitleCue'],
  world: ['worldStateEvent', 'lightCue'],
};

/**
 * Seconds an event occupies after it fires.
 *
 * Used to derive the sequence length, so a fade or a subtitle that starts on
 * the last beat is not cut off by the cutscene ending underneath it.
 */
export function eventEndTime(event: SequenceEvent): number {
  switch (event.kind) {
    case 'fade':
    case 'letterbox':
    case 'cameraBlend':
    case 'subtitleCue':
      return event.at + event.duration;
    case 'lightCue':
      return event.at + (event.duration ?? 0);
    default:
      return event.at;
  }
}

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

export interface PresentationTrack {
  kind: 'presentation';
  events: PresentationEvent[];
}

export interface CameraTrack {
  kind: 'camera';
  events: CameraEvent[];
}

/** One actor's choreography. The actor is on the track, not on every event. */
export interface ActorTrack {
  kind: 'actor';
  actor: SpeakerId;
  events: ActorEvent[];
}

export interface AudioTrack {
  kind: 'audio';
  events: AudioEvent[];
}

export interface DialogueTrack {
  kind: 'dialogue';
  events: SequenceDialogueEvent[];
}

export interface WorldTrack {
  kind: 'world';
  events: SequenceWorldEvent[];
}

export type SequenceTrack =
  | PresentationTrack
  | CameraTrack
  | ActorTrack
  | AudioTrack
  | DialogueTrack
  | WorldTrack;

export const sequenceTrackSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('presentation'),
    events: z.array(presentationEventSchema),
  }),
  z.strictObject({
    kind: z.literal('camera'),
    events: z.array(cameraEventSchema),
  }),
  z.strictObject({
    kind: z.literal('actor'),
    actor: speakerIdSchema,
    events: z.array(actorEventSchema),
  }),
  z.strictObject({
    kind: z.literal('audio'),
    events: z.array(audioEventSchema),
  }),
  z.strictObject({
    kind: z.literal('dialogue'),
    events: z.array(sequenceDialogueEventSchema),
  }),
  z.strictObject({
    kind: z.literal('world'),
    events: z.array(sequenceWorldEventSchema),
  }),
]);

// ---------------------------------------------------------------------------
// Sequence
// ---------------------------------------------------------------------------

export interface Sequence {
  id: SequenceId;
  /** Authoring label. Never shown to the player. */
  title?: string;
  /**
   * Presentation tier, shared with dialogue. `ambient` sequences leave the
   * player in control; `focused` and `cinematic` block gameplay.
   */
  mode: PresentationTier;
  skippable: boolean;
  resumePolicy: SequenceResumePolicy;
  /**
   * Replay protection. Defaults to true: a cutscene the player has watched
   * should not ambush them again when they walk back through the trigger.
   */
  once: boolean;
  /**
   * When true, the sequence refuses to start until something unlocks it —
   * the `unlockCinematic` narrative effect. Defaults to false so a cutscene
   * fired by a trigger volume needs no ceremony.
   */
  requiresUnlock: boolean;
  tracks: SequenceTrack[];
  /**
   * Authored total length in seconds. Omitted means "the last event's end",
   * which is what almost every cutscene wants; set it to hold on the final
   * beat.
   */
  duration?: number;
  /** Applied when the sequence plays out. */
  onComplete?: NarrativeEffect[];
  /**
   * Applied when the player skips, *in addition* to `onComplete` — a skipped
   * cutscene must leave the campaign in the state a watched one would.
   * Structurally identical effects are applied once, not twice.
   */
  onSkip?: NarrativeEffect[];
}

export const sequenceSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  mode: presentationTierSchema,
  skippable: z.boolean(),
  resumePolicy: z.enum(SEQUENCE_RESUME_POLICIES),
  once: z.boolean().default(true),
  requiresUnlock: z.boolean().default(false),
  tracks: z.array(sequenceTrackSchema).min(1),
  duration: z.number().min(0).optional(),
  onComplete: z.array(narrativeEffectSchema).optional(),
  onSkip: z.array(narrativeEffectSchema).optional(),
});

/**
 * Parses authored sequence data, throwing on malformed input.
 *
 * Fatal, never a warning: a cutscene that fails to parse is an act transition
 * the player cannot get through.
 */
export function parseSequence(raw: unknown): Sequence {
  const parsed = sequenceSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid sequence: ${detail}`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Schedule derivation
// ---------------------------------------------------------------------------

/** One event, resolved against its track and given a total order. */
export interface ScheduledEvent {
  /** Seconds from the start of the sequence. */
  readonly at: number;
  /** Position in the flattened schedule. Unique and dense. */
  readonly order: number;
  readonly trackIndex: number;
  readonly trackKind: SequenceTrackKind;
  /** Present only for events from an actor track. */
  readonly actor?: SpeakerId;
  readonly event: SequenceEvent;
}

/**
 * Flattens parallel tracks into one deterministically ordered schedule.
 *
 * Two events on different tracks sharing a timestamp is normal and must not be
 * resolved by accident: the ordering is `at`, then track order as authored,
 * then event order within the track. Authoring the tracks in a different order
 * is therefore a deliberate change to which of two simultaneous events lands
 * first, and the same content always produces the same traversal.
 */
export function buildSchedule(sequence: Sequence): ScheduledEvent[] {
  const flat: Omit<ScheduledEvent, 'order'>[] = [];

  sequence.tracks.forEach((track, trackIndex) => {
    for (const event of track.events) {
      flat.push({
        at: event.at,
        trackIndex,
        trackKind: track.kind,
        ...(track.kind === 'actor' ? { actor: track.actor } : {}),
        event,
      });
    }
  });

  // Two keys, both from the authored data: no reliance on Array#sort stability
  // for correctness, and no reliance on authored events being in time order.
  const withIndex = flat.map((entry, index) => ({ entry, index }));
  withIndex.sort((a, b) => {
    if (a.entry.at !== b.entry.at) return a.entry.at - b.entry.at;
    if (a.entry.trackIndex !== b.entry.trackIndex) {
      return a.entry.trackIndex - b.entry.trackIndex;
    }
    return a.index - b.index;
  });

  return withIndex.map(({ entry }, order) => ({ ...entry, order }));
}

/** Authored length, or the moment the last event stops occupying the screen. */
export function sequenceDuration(sequence: Sequence): number {
  if (sequence.duration !== undefined) return sequence.duration;

  let end = 0;
  for (const track of sequence.tracks) {
    for (const event of track.events) {
      end = Math.max(end, eventEndTime(event));
    }
  }
  return end;
}

/** Whether the player keeps control while this sequence runs. */
export function blocksGameplay(sequence: Sequence): boolean {
  return sequence.mode !== 'ambient';
}

/** Actors with a choreography track, in authored order. */
export function sequenceActors(sequence: Sequence): SpeakerId[] {
  const actors: SpeakerId[] = [];
  for (const track of sequence.tracks) {
    if (track.kind !== 'actor') continue;
    if (!actors.includes(track.actor)) actors.push(track.actor);
  }
  return actors;
}

/** Objectives the terminal effect lists advance. Used by the linter and tooling. */
export function referencedObjectives(sequence: Sequence): ObjectiveId[] {
  const ids: ObjectiveId[] = [];
  for (const effect of [...(sequence.onComplete ?? []), ...(sequence.onSkip ?? [])]) {
    if (effect.kind === 'advanceObjective' && !ids.includes(effect.objectiveId)) {
      ids.push(effect.objectiveId);
    }
  }
  return ids;
}

/** Marks the choreography points at. Used by the linter and asset tooling. */
export function referencedMarks(sequence: Sequence): MarkId[] {
  const marks: MarkId[] = [];
  for (const track of sequence.tracks) {
    if (track.kind !== 'actor') continue;
    for (const event of track.events) {
      if (
        event.kind === 'actorMoveTo' ||
        event.kind === 'actorLookAt' ||
        event.kind === 'actorTurnTo'
      ) {
        if (!marks.includes(event.mark)) marks.push(event.mark);
      }
    }
  }
  return marks;
}

/** Structural equality for effects, so a repeated effect is applied once. */
export function effectKey(effect: NarrativeEffect): string {
  switch (effect.kind) {
    case 'setFlag':
      return `setFlag:${effect.flag}=${String(effect.value)}`;
    case 'advanceObjective':
      return `advanceObjective:${effect.objectiveId}`;
    case 'grantEvidence':
      return `grantEvidence:${effect.evidenceId}`;
    case 'adjustTrust':
      return `adjustTrust:${effect.character}:${effect.delta}`;
    case 'unlockCinematic':
      return `unlockCinematic:${effect.sequenceId}`;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type SequenceIssueCode =
  // Errors
  | 'empty-track'
  | 'no-events'
  | 'duplicate-actor-track'
  | 'event-on-wrong-track'
  | 'camera-blend-without-destination'
  | 'camera-blend-ambiguous-destination'
  | 'camera-look-target-not-in-sequence'
  | 'control-lock-never-released'
  | 'letterbox-never-lifted'
  | 'fade-not-resolved'
  | 'skip-drops-completion-effect'
  | 'event-after-duration'
  | 'placeholder-text'
  | 'unknown-actor'
  | 'unknown-objective'
  | 'unknown-mark'
  | 'unknown-checkpoint'
  // Warnings
  | 'unordered-track-events'
  | 'checkpoint-during-control-lock'
  | 'unskippable-cinematic'
  | 'banned-phrase';

export type SequenceValidationResult = ValidationResult<SequenceIssueCode>;

/**
 * Ids the linter can check authored references against.
 *
 * All optional: a unit test lints a sequence on its own, while the content
 * pipeline passes the mark, objective and checkpoint tables it has loaded and
 * gets dangling-reference detection for free. An omitted table means "cannot
 * check", never "everything is fine".
 */
export interface SequenceValidationContext {
  knownActors?: Iterable<SpeakerId>;
  knownObjectives?: Iterable<ObjectiveId>;
  knownMarks?: Iterable<MarkId>;
  knownCheckpoints?: Iterable<CheckpointId>;
}

function issue(
  code: SequenceIssueCode,
  severity: IssueSeverity,
  message: string,
  target?: string,
): ValidationIssue<SequenceIssueCode> {
  return target === undefined
    ? { code, severity, message }
    : { code, severity, message, target };
}

/**
 * Lints an authored sequence.
 *
 * The errors are the things that strand a player rather than merely look
 * wrong. A cutscene that locks control on its first frame and never unlocks it
 * is an unwinnable game, and no amount of runtime safety-netting makes that
 * acceptable content — `SequenceSystem` does release control on the way out,
 * but relying on that is the bug this catches.
 */
export function validateSequence(
  sequence: Sequence,
  context: SequenceValidationContext = {},
): SequenceValidationResult {
  const errors: ValidationIssue<SequenceIssueCode>[] = [];
  const warnings: ValidationIssue<SequenceIssueCode>[] = [];
  const error = (code: SequenceIssueCode, message: string, target?: string): void => {
    errors.push(issue(code, 'error', message, target));
  };
  const warn = (code: SequenceIssueCode, message: string, target?: string): void => {
    warnings.push(issue(code, 'warning', message, target));
  };

  const knownActors = context.knownActors ? new Set(context.knownActors) : null;
  const knownObjectives = context.knownObjectives ? new Set(context.knownObjectives) : null;
  const knownMarks = context.knownMarks ? new Set(context.knownMarks) : null;
  const knownCheckpoints = context.knownCheckpoints
    ? new Set(context.knownCheckpoints)
    : null;

  const trackActors = new Set<SpeakerId>();
  let eventCount = 0;

  // --- per-track checks ----------------------------------------------------
  sequence.tracks.forEach((track, trackIndex) => {
    const label = track.kind === 'actor' ? `${track.kind}[${track.actor}]` : `${track.kind}[${trackIndex}]`;

    if (track.events.length === 0) {
      error('empty-track', `track ${label} has no events`, label);
      return;
    }
    eventCount += track.events.length;

    if (track.kind === 'actor') {
      if (trackActors.has(track.actor)) {
        error(
          'duplicate-actor-track',
          `actor "${track.actor}" has more than one choreography track; one actor is one timeline`,
          label,
        );
      }
      trackActors.add(track.actor);

      if (knownActors && !knownActors.has(track.actor)) {
        error('unknown-actor', `track ${label} choreographs unknown actor "${track.actor}"`, label);
      }
    }

    const allowed = EVENT_KINDS_BY_TRACK[track.kind];
    let previousAt = -Infinity;

    for (const event of track.events) {
      if (!allowed.includes(event.kind)) {
        // Unreachable through the schema; reachable through a hand-built
        // sequence in a test or a future authoring tool.
        error(
          'event-on-wrong-track',
          `event "${event.kind}" is not valid on a ${track.kind} track`,
          label,
        );
      }

      if (event.at < previousAt) {
        warn(
          'unordered-track-events',
          `track ${label} has an event at ${event.at}s after one at ${previousAt}s; the runtime sorts it, authoring should not rely on that`,
          label,
        );
      }
      previousAt = event.at;

      if (sequence.duration !== undefined && event.at > sequence.duration) {
        error(
          'event-after-duration',
          `track ${label} has an event at ${event.at}s, past the authored duration of ${sequence.duration}s`,
          label,
        );
      }

      switch (event.kind) {
        case 'cameraBlend': {
          const hasShot = event.position !== undefined || event.lookAt !== undefined;
          if (!hasShot && event.target === undefined) {
            error(
              'camera-blend-without-destination',
              `camera blend at ${event.at}s has neither a shot nor a handoff target`,
              label,
            );
          } else if (hasShot && event.target !== undefined) {
            error(
              'camera-blend-ambiguous-destination',
              `camera blend at ${event.at}s has both a shot and a "${event.target}" handoff`,
              label,
            );
          } else if (hasShot && (event.position === undefined || event.lookAt === undefined)) {
            error(
              'camera-blend-without-destination',
              `camera blend at ${event.at}s needs both position and lookAt`,
              label,
            );
          }
          break;
        }
        case 'cameraLookTarget': {
          if (knownActors && !knownActors.has(event.actor)) {
            error(
              'unknown-actor',
              `camera look target at ${event.at}s points at unknown actor "${event.actor}"`,
              label,
            );
          }
          break;
        }
        case 'actorMoveTo':
        case 'actorLookAt':
        case 'actorTurnTo': {
          if (knownMarks && !knownMarks.has(event.mark)) {
            error(
              'unknown-mark',
              `track ${label} points at unknown mark "${event.mark}"`,
              label,
            );
          }
          break;
        }
        case 'checkpointCue': {
          if (knownCheckpoints && !knownCheckpoints.has(event.checkpointId)) {
            error(
              'unknown-checkpoint',
              `checkpoint cue at ${event.at}s writes unknown checkpoint "${event.checkpointId}"`,
              label,
            );
          }
          break;
        }
        case 'subtitleCue': {
          const placeholders = findPlaceholderMarkers(event.text);
          if (placeholders.length > 0) {
            error(
              'placeholder-text',
              `subtitle at ${event.at}s contains placeholder text (${[...new Set(placeholders)].join(', ')})`,
              label,
            );
          }
          for (const phrase of findBannedPhrases(event.text)) {
            warn(
              'banned-phrase',
              `subtitle at ${event.at}s uses the banned phrase "${phrase}"`,
              label,
            );
          }
          break;
        }
        default:
          break;
      }
    }
  });

  if (eventCount === 0) {
    error('no-events', 'sequence has tracks but no events');
  }

  // --- cross-track presentation state -------------------------------------
  const schedule = buildSchedule(sequence);

  let controlLocked = false;
  let letterbox = false;
  let fadeTo: FadeEndpoint = 'scene';
  let lockedAt = 0;
  let letterboxAt = 0;
  let fadeAt = 0;

  for (const scheduled of schedule) {
    const event = scheduled.event;
    switch (event.kind) {
      case 'controlLock':
        controlLocked = event.locked;
        lockedAt = event.at;
        break;
      case 'letterbox':
        letterbox = event.visible;
        letterboxAt = event.at;
        break;
      case 'fade':
        fadeTo = event.to;
        fadeAt = event.at;
        break;
      case 'checkpointCue':
        if (controlLocked) {
          warn(
            'checkpoint-during-control-lock',
            `checkpoint "${event.checkpointId}" is cued at ${event.at}s while control is still locked; a save taken here reloads into a locked cutscene`,
          );
        }
        break;
      default:
        break;
    }
  }

  if (controlLocked) {
    error(
      'control-lock-never-released',
      `control is locked at ${lockedAt}s and never released; the sequence must hand control back`,
    );
  }
  if (letterbox) {
    error(
      'letterbox-never-lifted',
      `letterbox is shown at ${letterboxAt}s and never hidden`,
    );
  }
  if (fadeTo !== 'scene') {
    error(
      'fade-not-resolved',
      `the last fade at ${fadeAt}s ends on "${fadeTo}"; a sequence must end with the scene visible`,
    );
  }

  // --- terminal effects ----------------------------------------------------
  for (const effect of [...(sequence.onComplete ?? []), ...(sequence.onSkip ?? [])]) {
    if (
      effect.kind === 'advanceObjective' &&
      knownObjectives &&
      !knownObjectives.has(effect.objectiveId)
    ) {
      error(
        'unknown-objective',
        `terminal effect advances unknown objective "${effect.objectiveId}"`,
        effect.objectiveId,
      );
    }
  }

  if (sequence.skippable) {
    const skipKeys = new Set((sequence.onSkip ?? []).map(effectKey));
    for (const effect of sequence.onComplete ?? []) {
      const key = effectKey(effect);
      if (!skipKeys.has(key)) {
        // The runtime applies onComplete on skip too, so this is not a
        // correctness hole — it is authored intent that reads as a mistake, and
        // an author who genuinely wants a skip-only difference should say so in
        // onSkip rather than leaving it implied.
        error(
          'skip-drops-completion-effect',
          `skippable sequence has completion effect ${key} with no counterpart in onSkip`,
        );
      }
    }
  } else if (sequence.mode === 'cinematic') {
    warn(
      'unskippable-cinematic',
      'a cinematic that cannot be skipped will be watched twice by anyone who reloads',
    );
  }

  // --- internal dangling pointers -----------------------------------------
  const actors = new Set(sequenceActors(sequence));
  for (const scheduled of schedule) {
    if (scheduled.event.kind !== 'cameraLookTarget') continue;
    if (actors.has(scheduled.event.actor)) continue;
    error(
      'camera-look-target-not-in-sequence',
      `camera looks at "${scheduled.event.actor}" at ${scheduled.event.at}s, but this sequence has no choreography track for them`,
      scheduled.event.actor,
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}
