/**
 * Authored dialogue data model.
 *
 * Every line Mara, Sera, Ivo and Dax speak is authored, committed and
 * validated. Nothing here generates text at runtime, and no system is allowed
 * to branch a conversation in TypeScript: conditions, choices, effects and
 * interrupts are all *data*, so adding a conversation means adding a JSON file
 * and never touching a system.
 *
 * This module also hosts the shared narrative primitives — the condition AST,
 * the effect list, the story acts and the read-only state view they are
 * evaluated against — because dialogue is their heaviest consumer.
 * `missionSchema.ts` imports them. If a third domain needs them, lift them
 * into `src/game/progression/conditions.ts` rather than duplicating.
 *
 * Two layers of checking, deliberately separate:
 *
 *   `dialogueSceneSchema`  — shape validation (Zod). Rejects malformed data at
 *                            load time. Objects are strict, so a typo like
 *                            `nextt` fails loudly instead of being dropped.
 *   `validateDialogueScene` — authoring lint over an already-typed scene.
 *                            Errors are structural bugs (dangling pointers,
 *                            unreachable nodes). Warnings are the anti-slop
 *                            signals: banned trailer phrases, a line that has
 *                            turned into a monologue, a "conversation" where
 *                            only one person talks.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** Stable authored ids. Aliased for readability at call sites, not branded. */
export type SceneId = string;
export type NodeId = string;
export type ChoiceId = string;
export type ObjectiveId = string;
export type EvidenceId = string;
export type FlagName = string;
export type SequenceId = string;

// ---------------------------------------------------------------------------
// Cast
// ---------------------------------------------------------------------------

/** The four characters carrying the campaign. */
export const MAIN_CAST_IDS = ['mara', 'sera', 'ivo', 'dax'] as const;

/**
 * Recurring minor NPCs.
 *
 * Six to eight, each with a name, a purpose and a handful of lines — not a
 * pool of anonymous exposition dispensers. Adding a speaker here is a
 * deliberate cast decision, which is why the speaker field is a closed enum:
 * a typo in authored content becomes a load-time failure, not a silent
 * unnamed voice.
 */
export const MINOR_CAST_IDS = [
  /** Recovery contractor crew lead at Pump Station 12. */
  'noor',
  /** Depot volunteer sorting donated supplies. */
  'teo',
  /** Field clinic nurse working under Ivo. */
  'luz',
  /** Night warden who never left the transit depot. */
  'abe',
  /** Teenager who refuses to leave the residential block. */
  'kit',
  /** Pump technician working the flooded lower gallery. */
  'renna',
  /** Bus driver stranded at the depot since the evacuation. */
  'paulo',
  /** Emergency dispatch radio operator, heard more than seen. */
  'wen',
] as const;

export const SPEAKER_IDS = [...MAIN_CAST_IDS, ...MINOR_CAST_IDS] as const;

export type MainCastId = (typeof MAIN_CAST_IDS)[number];
export type MinorCastId = (typeof MINOR_CAST_IDS)[number];
export type SpeakerId = (typeof SPEAKER_IDS)[number];

export const speakerIdSchema = z.enum(SPEAKER_IDS);

export function isSpeakerId(value: unknown): value is SpeakerId {
  return typeof value === 'string' && (SPEAKER_IDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

/** Campaign acts, used to group scenes and missions for tooling and smoke tests. */
export const STORY_ACTS = [
  'prologue',
  'act1',
  'act2',
  'act3',
  'finale',
  'epilogue',
] as const;

export type StoryAct = (typeof STORY_ACTS)[number];

export const storyActSchema = z.enum(STORY_ACTS);

/**
 * Presentation tiers (spec §84.1).
 *
 * `ambient`   — player keeps control, gameplay camera, no letterbox. Radio
 *               chatter, passing residents, objective updates.
 * `focused`   — movement may soft-lock, camera reframes but stays spatially
 *               believable, actors use authored marks. Briefings, handovers,
 *               evidence inspection.
 * `cinematic` — authored camera and choreography. Reserved for act
 *               transitions, pivotal discoveries and the control-room
 *               decision. Roughly 10–15 across the campaign, not dozens.
 */
export const PRESENTATION_TIERS = ['ambient', 'focused', 'cinematic'] as const;

export type PresentationTier = (typeof PRESENTATION_TIERS)[number];

export const presentationTierSchema = z.enum(PRESENTATION_TIERS);

// ---------------------------------------------------------------------------
// Narrative state view
// ---------------------------------------------------------------------------

/** Flags are small scalars so they serialise into a save without ceremony. */
export type FlagValue = string | number | boolean;

export const flagValueSchema = z.union([z.string(), z.number(), z.boolean()]);

/**
 * Read-only projection of campaign progress that conditions are evaluated
 * against.
 *
 * Deliberately a view, not the save format: the save system owns storage, the
 * mission system owns objectives, and this module only ever reads. Sets are
 * used for membership tests; `createNarrativeState` accepts arrays so a
 * deserialised save can be adapted without the caller building Sets by hand.
 */
export interface NarrativeState {
  readonly flags: Readonly<Record<FlagName, FlagValue>>;
  readonly evidence: ReadonlySet<EvidenceId>;
  readonly completedObjectives: ReadonlySet<ObjectiveId>;
  /** Scenes already played, for `once` replay protection. */
  readonly seenScenes: ReadonlySet<SceneId>;
  /** Per-character trust, keyed by speaker id. Absent means 0. */
  readonly trust: Readonly<Record<string, number>>;
}

export interface NarrativeStateInit {
  flags?: Readonly<Record<FlagName, FlagValue>>;
  evidence?: Iterable<EvidenceId>;
  completedObjectives?: Iterable<ObjectiveId>;
  seenScenes?: Iterable<SceneId>;
  trust?: Readonly<Record<string, number>>;
}

export function createNarrativeState(init: NarrativeStateInit = {}): NarrativeState {
  return {
    flags: { ...(init.flags ?? {}) },
    evidence: new Set(init.evidence ?? []),
    completedObjectives: new Set(init.completedObjectives ?? []),
    seenScenes: new Set(init.seenScenes ?? []),
    trust: { ...(init.trust ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// Condition AST
// ---------------------------------------------------------------------------

/**
 * Conditions are a tiny data AST, never a predicate function.
 *
 * Functions cannot be authored in JSON, diffed usefully, or checked by a
 * content linter, so gating lives in this closed set of node kinds.
 */
export type NarrativeCondition =
  /** Unconditional. Explicit so authored data never omits the field to mean "yes". */
  | { kind: 'always' }
  | { kind: 'flagEquals'; flag: FlagName; value: FlagValue }
  | { kind: 'flagSet'; flag: FlagName }
  | { kind: 'flagUnset'; flag: FlagName }
  | { kind: 'evidenceCollected'; evidenceId: EvidenceId }
  | { kind: 'objectiveComplete'; objectiveId: ObjectiveId }
  | { kind: 'sceneSeen'; sceneId: SceneId }
  | { kind: 'trustAtLeast'; character: SpeakerId; value: number }
  | { kind: 'and'; all: NarrativeCondition[] }
  | { kind: 'or'; any: NarrativeCondition[] }
  | { kind: 'not'; condition: NarrativeCondition };

export type NarrativeConditionKind = NarrativeCondition['kind'];

export const narrativeConditionSchema: z.ZodType<NarrativeCondition> = z.lazy(() =>
  z.union([
    z.strictObject({ kind: z.literal('always') }),
    z.strictObject({
      kind: z.literal('flagEquals'),
      flag: z.string().min(1),
      value: flagValueSchema,
    }),
    z.strictObject({ kind: z.literal('flagSet'), flag: z.string().min(1) }),
    z.strictObject({ kind: z.literal('flagUnset'), flag: z.string().min(1) }),
    z.strictObject({
      kind: z.literal('evidenceCollected'),
      evidenceId: z.string().min(1),
    }),
    z.strictObject({
      kind: z.literal('objectiveComplete'),
      objectiveId: z.string().min(1),
    }),
    z.strictObject({ kind: z.literal('sceneSeen'), sceneId: z.string().min(1) }),
    z.strictObject({
      kind: z.literal('trustAtLeast'),
      character: speakerIdSchema,
      value: z.number(),
    }),
    z.strictObject({
      kind: z.literal('and'),
      all: z.array(narrativeConditionSchema).min(1),
    }),
    z.strictObject({
      kind: z.literal('or'),
      any: z.array(narrativeConditionSchema).min(1),
    }),
    z.strictObject({ kind: z.literal('not'), condition: narrativeConditionSchema }),
  ]),
);

/** Convenience singleton for the common "no gate" case. */
export const ALWAYS: NarrativeCondition = { kind: 'always' };

/**
 * A flag counts as *set* when it is present and not literally `false`.
 *
 * Saves initialise known flags to `false` rather than omitting them, so
 * "present in the record" is not a usable definition of set.
 */
function flagIsSet(state: NarrativeState, flag: FlagName): boolean {
  const value = state.flags[flag];
  return value !== undefined && value !== false;
}

/**
 * Evaluates a condition against campaign progress. Pure, total, and cheap
 * enough to call while a conversation is running.
 *
 * `and` over an empty list is true and `or` over an empty list is false, the
 * standard identities. The schema requires at least one child, so validated
 * content never relies on either.
 */
export function evaluateCondition(
  condition: NarrativeCondition,
  state: NarrativeState,
): boolean {
  switch (condition.kind) {
    case 'always':
      return true;
    case 'flagEquals':
      return state.flags[condition.flag] === condition.value;
    case 'flagSet':
      return flagIsSet(state, condition.flag);
    case 'flagUnset':
      return !flagIsSet(state, condition.flag);
    case 'evidenceCollected':
      return state.evidence.has(condition.evidenceId);
    case 'objectiveComplete':
      return state.completedObjectives.has(condition.objectiveId);
    case 'sceneSeen':
      return state.seenScenes.has(condition.sceneId);
    case 'trustAtLeast':
      return (state.trust[condition.character] ?? 0) >= condition.value;
    case 'and':
      return condition.all.every((child) => evaluateCondition(child, state));
    case 'or':
      return condition.any.some((child) => evaluateCondition(child, state));
    case 'not':
      return !evaluateCondition(condition.condition, state);
    default:
      return assertUnreachable(condition);
  }
}

/**
 * Compile-time exhaustiveness guard.
 *
 * Reaching this at runtime means unvalidated content got past the schema,
 * which is an authoring bug worth surfacing rather than silently ignoring.
 */
function assertUnreachable(value: never): never {
  throw new Error(`unhandled narrative condition: ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/**
 * Consequences of a line or a choice, again as data.
 *
 * This module does not apply them — the dialogue runtime, mission system and
 * sequence system each own their side of the write. Keeping effects declarative
 * means a save can replay them and a linter can check their targets exist.
 */
export type NarrativeEffect =
  | { kind: 'setFlag'; flag: FlagName; value: FlagValue }
  | { kind: 'advanceObjective'; objectiveId: ObjectiveId }
  | { kind: 'grantEvidence'; evidenceId: EvidenceId }
  | { kind: 'adjustTrust'; character: SpeakerId; delta: number }
  | { kind: 'unlockCinematic'; sequenceId: SequenceId };

export type NarrativeEffectKind = NarrativeEffect['kind'];

export const narrativeEffectSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('setFlag'),
    flag: z.string().min(1),
    value: flagValueSchema,
  }),
  z.strictObject({
    kind: z.literal('advanceObjective'),
    objectiveId: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('grantEvidence'),
    evidenceId: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('adjustTrust'),
    character: speakerIdSchema,
    delta: z.number(),
  }),
  z.strictObject({
    kind: z.literal('unlockCinematic'),
    sequenceId: z.string().min(1),
  }),
]);

// ---------------------------------------------------------------------------
// Choices
// ---------------------------------------------------------------------------

/**
 * Player choice.
 *
 * Two or three options. One option is not a choice, and four options in a
 * grounded conversation almost always means two of them are padding — the
 * schema and the linter both enforce the range so a "fake choice with one
 * obviously correct option" cannot be shipped by accident.
 */
export interface DialogueChoice {
  /** Stable id. Saves record which choice was taken, so this cannot be positional. */
  id: ChoiceId;
  text: string;
  /** Hidden entirely when the condition fails. Omitted means always offered. */
  condition?: NarrativeCondition;
  target: NodeId;
  effects?: NarrativeEffect[];
}

/** Design rule, enforced by both the schema and `validateDialogueScene`. */
export const MIN_CHOICES_PER_NODE = 2;
export const MAX_CHOICES_PER_NODE = 3;

export const dialogueChoiceSchema = z.strictObject({
  id: z.string().min(1),
  text: z.string().min(1),
  condition: narrativeConditionSchema.optional(),
  target: z.string().min(1),
  effects: z.array(narrativeEffectSchema).optional(),
});

// ---------------------------------------------------------------------------
// Interrupts
// ---------------------------------------------------------------------------

/**
 * A world event allowed to cut a line short.
 *
 * A pump losing sync mid-sentence should interrupt Sera, not queue politely
 * behind her. `earliest` stops a line being cut before the player has heard
 * enough of it to matter.
 */
export interface DialogueInterrupt {
  /** Event bus name that triggers the cut. */
  event: string;
  /** Node to continue from. `null` ends the scene. */
  target: NodeId | null;
  /** Seconds into the line before the interrupt is permitted. */
  earliest?: number;
}

export const dialogueInterruptSchema = z.strictObject({
  event: z.string().min(1),
  target: z.string().min(1).nullable(),
  earliest: z.number().min(0).optional(),
});

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/**
 * One spoken line.
 *
 * A node either continues (`next`) or offers choices — never both. Neither
 * means the line ends the scene.
 */
export interface DialogueNode {
  id: NodeId;
  speaker: SpeakerId;
  /** The authored line. Also the subtitle text when no cue file is supplied. */
  text: string;
  /** Audio path relative to `public/assets/audio`, e.g. `dlg/act1/s1.ogg`. */
  audio?: string;
  /** Timed subtitle cue file, for lines that need word-level sync. */
  subtitles?: string;
  /**
   * Explicit line length in seconds. Overrides audio duration and is required
   * for lines with no recorded audio yet, so timing never depends on a
   * missing file.
   */
  duration?: number;
  /** Skipped entirely when the condition fails. */
  condition?: NarrativeCondition;
  next?: NodeId | null;
  choices?: DialogueChoice[];
  /** Applied when the line finishes (or is interrupted). */
  effects?: NarrativeEffect[];
  interrupts?: DialogueInterrupt[];
}

export const dialogueNodeSchema = z.strictObject({
  id: z.string().min(1),
  speaker: speakerIdSchema,
  text: z.string().min(1),
  audio: z.string().min(1).optional(),
  subtitles: z.string().min(1).optional(),
  duration: z.number().positive().optional(),
  condition: narrativeConditionSchema.optional(),
  next: z.string().min(1).nullable().optional(),
  choices: z.array(dialogueChoiceSchema).min(MIN_CHOICES_PER_NODE).max(MAX_CHOICES_PER_NODE).optional(),
  effects: z.array(narrativeEffectSchema).optional(),
  interrupts: z.array(dialogueInterruptSchema).optional(),
});

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

export interface DialogueScene {
  sceneId: SceneId;
  /** Authoring label. Never shown to the player. */
  title?: string;
  act: StoryAct;
  tier: PresentationTier;
  participants: SpeakerId[];
  /** Node the scene starts from. */
  entry: NodeId;
  nodes: DialogueNode[];
  /**
   * Replay protection. `true` (the default) means the scene plays at most
   * once per campaign, tracked by `seenScenes`. Ambient chatter that should
   * recur sets it false.
   */
  once: boolean;
  /**
   * Whether the player may skip. Cinematic tiers are skippable after
   * initialisation; a short ambient line has nothing to skip.
   */
  skippable: boolean;
  /** Gate on campaign progress before the scene may trigger at all. */
  availableWhen?: NarrativeCondition;
  /** Applied once when the scene ends, however it ended. */
  onEnd?: NarrativeEffect[];
}

export const dialogueSceneSchema = z.strictObject({
  sceneId: z.string().min(1),
  title: z.string().min(1).optional(),
  act: storyActSchema,
  tier: presentationTierSchema,
  participants: z.array(speakerIdSchema).min(1),
  entry: z.string().min(1),
  nodes: z.array(dialogueNodeSchema).min(1),
  once: z.boolean(),
  skippable: z.boolean(),
  availableWhen: narrativeConditionSchema.optional(),
  onEnd: z.array(narrativeEffectSchema).optional(),
});

/**
 * Parses authored scene data, throwing on malformed input.
 *
 * Content loading is a fatal path: a scene that fails to parse means a
 * conversation the player cannot have, so it must not be swallowed.
 */
export function parseDialogueScene(raw: unknown): DialogueScene {
  const parsed = dialogueSceneSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid dialogue scene: ${detail}`);
  }
  return parsed.data;
}

/**
 * Whether a scene may play right now: replay protection first, then its gate.
 */
export function canPlayScene(scene: DialogueScene, state: NarrativeState): boolean {
  if (scene.once && state.seenScenes.has(scene.sceneId)) return false;
  if (scene.availableWhen && !evaluateCondition(scene.availableWhen, state)) return false;
  return true;
}

/** Choices whose conditions currently pass, in authored order. */
export function availableChoices(
  node: DialogueNode,
  state: NarrativeState,
): DialogueChoice[] {
  if (!node.choices) return [];
  return node.choices.filter(
    (choice) => !choice.condition || evaluateCondition(choice.condition, state),
  );
}

// ---------------------------------------------------------------------------
// Validation results
// ---------------------------------------------------------------------------

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue<Code extends string = string> {
  code: Code;
  severity: IssueSeverity;
  message: string;
  /** Node, choice or objective id the issue is scoped to, when applicable. */
  target?: string;
}

export interface ValidationResult<Code extends string = string> {
  /** True when there are no errors. Warnings do not block. */
  ok: boolean;
  errors: ValidationIssue<Code>[];
  warnings: ValidationIssue<Code>[];
}

export function hasIssue<Code extends string>(
  result: ValidationResult<Code>,
  code: Code,
): boolean {
  return (
    result.errors.some((issue) => issue.code === code) ||
    result.warnings.some((issue) => issue.code === code)
  );
}

export function issuesWithCode<Code extends string>(
  result: ValidationResult<Code>,
  code: Code,
): ValidationIssue<Code>[] {
  return [...result.errors, ...result.warnings].filter((issue) => issue.code === code);
}

/** Collects issues and keeps errors and warnings separated. */
class IssueCollector<Code extends string> {
  private readonly errors: ValidationIssue<Code>[] = [];
  private readonly warnings: ValidationIssue<Code>[] = [];

  error(code: Code, message: string, target?: string): void {
    this.errors.push(target === undefined ? { code, severity: 'error', message } : { code, severity: 'error', message, target });
  }

  warn(code: Code, message: string, target?: string): void {
    this.warnings.push(target === undefined ? { code, severity: 'warning', message } : { code, severity: 'warning', message, target });
  }

  result(): ValidationResult<Code> {
    return {
      ok: this.errors.length === 0,
      errors: this.errors,
      warnings: this.warnings,
    };
  }
}

// ---------------------------------------------------------------------------
// Anti-slop checks
// ---------------------------------------------------------------------------

/**
 * Trailer-speak. Any of these in an authored line is a rewrite signal, not a
 * style preference — they are the phrases that make a grounded municipal
 * drama sound like a teaser.
 *
 * Matched after normalising curly apostrophes and case, ignoring trailing
 * punctuation, so "This changes everything!" is caught too.
 */
export const BANNED_PHRASES: readonly string[] = [
  'this changes everything',
  'you have no idea',
  "it's bigger than all of us",
  'i did what i had to do',
  'the truth deserves to be known',
  "there's no going back",
  'they lied to us',
  "we're running out of time",
  "we're out of time",
  "you don't understand what's at stake",
];

/** Markers that mean a line was never written. */
export const PLACEHOLDER_MARKERS: readonly string[] = ['todo', 'lorem ipsum', 'placeholder'];

/**
 * Above this, a line has stopped being dialogue and become a monologue.
 * Roughly 35–40 seconds of speech.
 */
export const MAX_SPOKEN_WORDS_PER_NODE = 90;

/** Lowercases and folds curly apostrophes so phrase matching is stable. */
function normaliseLine(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Banned phrases found in a line, normalised. Exported for content tooling. */
export function findBannedPhrases(text: string): string[] {
  const normalised = normaliseLine(text);
  return BANNED_PHRASES.filter((phrase) => normalised.includes(phrase));
}

/**
 * Placeholder markers found in a line.
 *
 * Word-boundary matched rather than substring matched: a bare "todo" is a
 * placeholder, but it is also a common Spanish word that will appear in
 * localised content.
 */
export function findPlaceholderMarkers(text: string): string[] {
  const normalised = normaliseLine(text);
  return PLACEHOLDER_MARKERS.filter((marker) =>
    new RegExp(`\\b${escapeForRegExp(marker)}\\b`).test(normalised),
  );
}

/** Whitespace-separated token count. Good enough to flag a monologue. */
export function countSpokenWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  return trimmed.split(/\s+/).length;
}

// ---------------------------------------------------------------------------
// Scene validation
// ---------------------------------------------------------------------------

export type DialogueIssueCode =
  // Errors
  | 'duplicate-node-id'
  | 'missing-entry-node'
  | 'dangling-next-pointer'
  | 'dangling-choice-target'
  | 'dangling-interrupt-target'
  | 'unreachable-node'
  | 'choices-and-next'
  | 'too-many-choices'
  | 'too-few-choices'
  | 'duplicate-choice-id'
  | 'empty-text'
  | 'placeholder-text'
  | 'speaker-not-participant'
  // Warnings
  | 'banned-phrase'
  | 'monologue-length'
  | 'single-speaker-scene'
  | 'missing-line-timing';

export type DialogueValidationResult = ValidationResult<DialogueIssueCode>;

/**
 * Lints an authored scene.
 *
 * Takes the typed `DialogueScene` rather than raw data on purpose: shape is
 * the schema's job, and this way the linter can be pointed at a scene built in
 * a test or produced by a future authoring tool.
 */
export function validateDialogueScene(scene: DialogueScene): DialogueValidationResult {
  const issues = new IssueCollector<DialogueIssueCode>();

  // --- node identity -------------------------------------------------------
  const byId = new Map<NodeId, DialogueNode>();
  const seenIds = new Set<NodeId>();
  for (const node of scene.nodes) {
    if (seenIds.has(node.id)) {
      issues.error('duplicate-node-id', `duplicate node id "${node.id}"`, node.id);
      continue; // First definition wins so the rest of the graph stays walkable.
    }
    seenIds.add(node.id);
    byId.set(node.id, node);
  }

  const participants = new Set<SpeakerId>(scene.participants);

  // --- per-node checks -----------------------------------------------------
  for (const node of byId.values()) {
    if (node.text.trim() === '') {
      issues.error('empty-text', `node "${node.id}" has no text`, node.id);
    } else {
      const placeholders = findPlaceholderMarkers(node.text);
      if (placeholders.length > 0) {
        issues.error(
          'placeholder-text',
          `node "${node.id}" contains placeholder text (${placeholders.join(', ')})`,
          node.id,
        );
      }

      const banned = findBannedPhrases(node.text);
      for (const phrase of banned) {
        issues.warn(
          'banned-phrase',
          `node "${node.id}" uses the banned phrase "${phrase}"`,
          node.id,
        );
      }

      const words = countSpokenWords(node.text);
      if (words > MAX_SPOKEN_WORDS_PER_NODE) {
        issues.warn(
          'monologue-length',
          `node "${node.id}" is ${words} spoken words, over the ${MAX_SPOKEN_WORDS_PER_NODE}-word limit — split it or let someone interrupt`,
          node.id,
        );
      }
    }

    if (!participants.has(node.speaker)) {
      issues.error(
        'speaker-not-participant',
        `node "${node.id}" is spoken by "${node.speaker}", who is not a participant of the scene`,
        node.id,
      );
    }

    // A line with neither recorded audio nor an explicit duration has no
    // length, so subtitle timing would be guesswork.
    if (node.audio === undefined && node.duration === undefined) {
      issues.warn(
        'missing-line-timing',
        `node "${node.id}" has neither audio nor an explicit duration`,
        node.id,
      );
    }

    const hasChoices = node.choices !== undefined && node.choices.length > 0;
    const hasNext = node.next !== undefined && node.next !== null;

    if (hasChoices && hasNext) {
      issues.error(
        'choices-and-next',
        `node "${node.id}" has both choices and a next pointer — a node either continues or branches`,
        node.id,
      );
    }

    if (hasNext && !byId.has(node.next as NodeId)) {
      issues.error(
        'dangling-next-pointer',
        `node "${node.id}" points at unknown node "${node.next}"`,
        node.id,
      );
    }

    if (node.choices) {
      if (node.choices.length > MAX_CHOICES_PER_NODE) {
        issues.error(
          'too-many-choices',
          `node "${node.id}" offers ${node.choices.length} choices, more than the ${MAX_CHOICES_PER_NODE} allowed`,
          node.id,
        );
      }
      if (node.choices.length < MIN_CHOICES_PER_NODE) {
        issues.error(
          'too-few-choices',
          `node "${node.id}" offers ${node.choices.length} choice(s); fewer than ${MIN_CHOICES_PER_NODE} is not a choice`,
          node.id,
        );
      }

      const choiceIds = new Set<ChoiceId>();
      for (const choice of node.choices) {
        if (choiceIds.has(choice.id)) {
          issues.error(
            'duplicate-choice-id',
            `node "${node.id}" reuses choice id "${choice.id}"`,
            choice.id,
          );
        }
        choiceIds.add(choice.id);

        if (choice.text.trim() === '') {
          issues.error('empty-text', `choice "${choice.id}" has no text`, choice.id);
        } else {
          const placeholders = findPlaceholderMarkers(choice.text);
          if (placeholders.length > 0) {
            issues.error(
              'placeholder-text',
              `choice "${choice.id}" contains placeholder text (${placeholders.join(', ')})`,
              choice.id,
            );
          }
          for (const phrase of findBannedPhrases(choice.text)) {
            issues.warn(
              'banned-phrase',
              `choice "${choice.id}" uses the banned phrase "${phrase}"`,
              choice.id,
            );
          }
        }

        if (!byId.has(choice.target)) {
          issues.error(
            'dangling-choice-target',
            `choice "${choice.id}" on node "${node.id}" targets unknown node "${choice.target}"`,
            choice.id,
          );
        }
      }
    }

    for (const interrupt of node.interrupts ?? []) {
      if (interrupt.target !== null && !byId.has(interrupt.target)) {
        issues.error(
          'dangling-interrupt-target',
          `interrupt "${interrupt.event}" on node "${node.id}" targets unknown node "${interrupt.target}"`,
          node.id,
        );
      }
    }
  }

  // --- reachability --------------------------------------------------------
  if (!byId.has(scene.entry)) {
    issues.error(
      'missing-entry-node',
      `scene entry "${scene.entry}" is not a node in this scene`,
      scene.entry,
    );
  } else {
    const reached = walkReachableNodes(scene.entry, byId);
    for (const id of byId.keys()) {
      if (!reached.has(id)) {
        issues.error('unreachable-node', `node "${id}" is unreachable from the scene entry`, id);
      }
    }
  }

  // --- conversation shape --------------------------------------------------
  if (scene.participants.length > 1 && byId.size > 1) {
    const speakers = new Set<SpeakerId>();
    for (const node of byId.values()) speakers.add(node.speaker);
    if (speakers.size === 1) {
      const [only] = [...speakers];
      issues.warn(
        'single-speaker-scene',
        `scene lists ${scene.participants.length} participants but every line is "${only}" — the others are furniture`,
      );
    }
  }

  return issues.result();
}

/** Breadth-first walk over next pointers, choice targets and interrupt targets. */
function walkReachableNodes(
  entry: NodeId,
  byId: ReadonlyMap<NodeId, DialogueNode>,
): Set<NodeId> {
  const reached = new Set<NodeId>([entry]);
  const queue: NodeId[] = [entry];

  while (queue.length > 0) {
    const current = queue.pop() as NodeId;
    const node = byId.get(current);
    if (!node) continue;

    const targets: (NodeId | null | undefined)[] = [node.next];
    for (const choice of node.choices ?? []) targets.push(choice.target);
    for (const interrupt of node.interrupts ?? []) targets.push(interrupt.target);

    for (const target of targets) {
      if (target === null || target === undefined) continue;
      if (reached.has(target)) continue;
      if (!byId.has(target)) continue; // Reported separately as dangling.
      reached.add(target);
      queue.push(target);
    }
  }

  return reached;
}
