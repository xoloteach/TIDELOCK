/**
 * Tutorial definitions: triggers, completions and the campaign registry.
 *
 * TIDELOCK teaches one mechanic at the moment it first becomes relevant. There
 * is no controls panel at New Game, and no tutorial exists for a mechanic the
 * player has not yet met. Front-loading a wall of prompts is an explicit
 * project rejection condition, so the shape of the data here is designed to
 * make that mistake awkward: a definition cannot exist without a trigger that
 * describes the *situation* it teaches in, and the validator rejects a
 * timer-based completion for anything that has an action to perform.
 *
 * Everything is data. `TutorialSystem` interprets it; adding, retiming or
 * removing a tutorial never requires touching the system. Message *text* is
 * not here either — `messageKey` points into localization, so a definition
 * carries mechanics metadata only.
 */

import type { GameAction } from '../../engine/input/actions';

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

/**
 * Bumped when tutorial content changes in a way that makes existing
 * completions wrong — a rebound control scheme, a rewritten prompt, a mechanic
 * that now works differently. The tutorial system compares this against the
 * version stored with a save's completions and re-arms everything when they
 * differ.
 *
 * Owned here rather than in the save schema: this is a property of tutorial
 * *content*, and the persistence layer only stores the number opaquely.
 */
export const TUTORIAL_RESET_VERSION = 1;

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

/**
 * Named priority bands.
 *
 * Priority decides two things: which of several simultaneously-eligible
 * tutorials is shown first, and whether a tutorial survives the
 * `reducedTutorials` setting. Bands exist so those decisions are not made with
 * magic numbers scattered through the registry.
 */
export const TUTORIAL_PRIORITY = {
  /** The player is being detected, or is about to die. Interrupt anything. */
  critical: 100,
  /** The mechanic gates the current objective. The player is stuck without it. */
  high: 80,
  /** Useful, but the campaign is completable without ever reading it. */
  normal: 50,
  /** Informational. Safe to never show. */
  low: 20,
} as const;

/**
 * With `reducedTutorials` on, only tutorials at or above this priority fire.
 * An experienced player still gets the safety cues and the mechanics that gate
 * progress; they do not get told what the journal button is.
 */
export const REDUCED_TUTORIALS_MIN_PRIORITY: number = TUTORIAL_PRIORITY.high;

// ---------------------------------------------------------------------------
// Escalation (spec 86.6)
// ---------------------------------------------------------------------------

/** 1 = normal prompt, 2 = stronger prompt/highlight, 3 = optional hint. */
export type TutorialEscalationLevel = 1 | 2 | 3;

export interface TutorialEscalationTiming {
  /** Seconds visible (plus failure weight) before the prompt strengthens. */
  readonly toStrongAfter: number;
  /** Seconds before the optional hint appears. */
  readonly toHintAfter: number;
}

/**
 * Deliberately slow. Escalating after three seconds reads as nagging, and the
 * point of level 3 is a hint, not a solution — the player still performs the
 * action themselves.
 */
export const DEFAULT_ESCALATION_TIMING: TutorialEscalationTiming = {
  toStrongAfter: 12,
  toHintAfter: 26,
};

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/** World-space point. A tuple, not a THREE.Vector3, so definitions serialise. */
export type TutorialPoint = readonly [number, number, number];

/**
 * The situation in which a tutorial becomes relevant.
 *
 * Each variant is a question the system can ask the world through a read-only
 * context port. None of them can be answered "at spawn, always", which is the
 * property that keeps teaching contextual.
 */
export type TutorialTrigger =
  /** Player is within `radius` metres of a fixed authored point. */
  | { readonly kind: 'proximity'; readonly position: TutorialPoint; readonly radius: number }
  /** Player is within `radius` metres of any entity carrying `tag`. */
  | { readonly kind: 'nearEntity'; readonly tag: string; readonly radius: number }
  /** An objective is the player's current business. */
  | { readonly kind: 'objectiveActive'; readonly objectiveId: string }
  /** A campaign/world flag is set. Used for "the dialogue system needs a reply". */
  | { readonly kind: 'flagSet'; readonly flag: string }
  /**
   * The action has just become usable — a tool was picked up, camera control
   * was handed over. This is the honest trigger for "first use" of a verb that
   * has no physical landmark.
   */
  | { readonly kind: 'actionAvailable'; readonly action: GameAction }
  /** Player is inside a streaming sector. */
  | { readonly kind: 'sectorEntered'; readonly sectorId: string }
  /** Health has dropped below a fraction of maximum. */
  | { readonly kind: 'lowHealth'; readonly belowFraction: number }
  /**
   * The interaction system currently has a target. `interactableKind` narrows
   * it — "facing evidence" teaches something different from "facing a valve".
   */
  | { readonly kind: 'facingInteractable'; readonly interactableKind?: string }
  /** All of the sub-triggers hold. */
  | { readonly kind: 'all'; readonly of: readonly TutorialTrigger[] }
  /** Any of the sub-triggers holds. */
  | { readonly kind: 'any'; readonly of: readonly TutorialTrigger[] };

// ---------------------------------------------------------------------------
// Completions
// ---------------------------------------------------------------------------

/**
 * How the system knows the player learned it.
 *
 * `actionPerformed` is the preferred form and the only one that proves
 * anything: the prompt disappears because the player did the thing.
 *
 * `elapsed` exists for prompts with no action to perform (what an autosave
 * icon means) and is discouraged everywhere else. A timer dismisses the prompt
 * whether or not the player understood it, which produces the specific failure
 * this system is built to avoid: a player who never learned to vault, standing
 * at a ledge with no prompt because six seconds passed. `validateTutorials`
 * therefore rejects `elapsed` on any tutorial that illustrates an action.
 */
export type TutorialCompletion =
  /** The player performed the action, as reported by the owning system. */
  | { readonly kind: 'actionPerformed'; readonly action: GameAction; readonly times?: number }
  /** A flag became set — used when success is a world state, not a keypress. */
  | { readonly kind: 'flagSet'; readonly flag: string }
  /** An objective completed. */
  | { readonly kind: 'objectiveCompleted'; readonly objectiveId: string }
  /** Discouraged. See above. */
  | { readonly kind: 'elapsed'; readonly seconds: number };

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

/**
 * - `once`: shown at most once, ever. Dismissed when its context ends whether
 *   or not the player acted.
 * - `until-success`: re-offered every time its context returns, until the
 *   player actually performs the action. Correct for anything that gates
 *   progress.
 * - `contextual`: a recurring cue that may legitimately re-teach in a later
 *   act (machine detection, recovering from damage). Requires a cooldown.
 */
export type TutorialRepeatPolicy = 'once' | 'until-success' | 'contextual';

export interface TutorialDefinition {
  readonly id: string;
  readonly trigger: TutorialTrigger;
  readonly completion: TutorialCompletion;
  /**
   * The action the UI illustrates. Copy never names a key: the renderer
   * resolves this against the active input family, so the same definition
   * produces "Interact — E", a controller glyph, or a pulse on the on-screen
   * button (spec 86.4).
   */
  readonly inputAction?: GameAction;
  /** Localization key. The definition carries no player-visible text. */
  readonly messageKey: string;
  /** 0–100. See `TUTORIAL_PRIORITY`. */
  readonly priority: number;
  /** Seconds before this tutorial may appear again. Prevents prompt spam. */
  readonly cooldown?: number;
  /** While visible, lower-priority tutorials are suppressed, not queued. */
  readonly blocksOthers?: boolean;
  readonly repeatPolicy: TutorialRepeatPolicy;
  /** Overrides `DEFAULT_ESCALATION_TIMING` for this tutorial. */
  readonly escalation?: TutorialEscalationTiming;
}

/**
 * The action a prompt should illustrate.
 *
 * Falls back to the completion's action, so a definition does not have to
 * repeat itself when the thing being taught is the thing being measured.
 */
export function tutorialIllustratedAction(def: TutorialDefinition): GameAction | undefined {
  if (def.inputAction) return def.inputAction;
  if (def.completion.kind === 'actionPerformed') return def.completion.action;
  return undefined;
}

export function tutorialEscalationTiming(def: TutorialDefinition): TutorialEscalationTiming {
  return def.escalation ?? DEFAULT_ESCALATION_TIMING;
}

// ---------------------------------------------------------------------------
// Registry (spec 86.2)
// ---------------------------------------------------------------------------

/**
 * Entity tags the world/sector data attaches to the landmarks a tutorial keys
 * off. Kept as named constants so a typo in a sector file is findable rather
 * than a tutorial that silently never fires.
 */
export const TUTORIAL_TAGS = {
  lowClearance: 'tutorial:low-clearance',
  vaultLedge: 'tutorial:vault-ledge',
  serviceLadder: 'tutorial:service-ladder',
  scanTarget: 'tutorial:scan-target',
  machinePatrol: 'tutorial:machine-patrol',
} as const;

/**
 * The campaign tutorials.
 *
 * Coverage follows spec 86.2 for the mechanics TIDELOCK actually implements.
 * Aim/ADS, reload and inventory selection have no entries because the campaign
 * has no such mechanics — 86.2 lists them conditionally, and a tutorial for a
 * verb the player can never use is worse than none.
 *
 * Array order is authoring order and is used only as a stable tiebreak; the
 * system sorts by priority.
 */
export const TUTORIALS: readonly TutorialDefinition[] = [
  // --- Prologue: the depot -------------------------------------------------
  {
    id: 'move',
    // Available the instant control is handed over, which is the only honest
    // moment to teach walking.
    trigger: { kind: 'actionAvailable', action: 'moveY' },
    completion: { kind: 'actionPerformed', action: 'moveY' },
    messageKey: 'tutorial.move',
    priority: TUTORIAL_PRIORITY.critical,
    repeatPolicy: 'until-success',
    blocksOthers: true,
  },
  {
    id: 'look',
    trigger: { kind: 'actionAvailable', action: 'lookX' },
    completion: { kind: 'actionPerformed', action: 'lookX' },
    messageKey: 'tutorial.look',
    priority: 96,
    repeatPolicy: 'until-success',
    blocksOthers: true,
  },
  {
    id: 'interact',
    trigger: {
      kind: 'all',
      of: [
        { kind: 'facingInteractable' },
        { kind: 'actionAvailable', action: 'interact' },
      ],
    },
    completion: { kind: 'actionPerformed', action: 'interact' },
    messageKey: 'tutorial.interact',
    priority: 88,
    cooldown: 20,
    repeatPolicy: 'until-success',
  },
  {
    id: 'ladder-climb',
    // Contextual traversal: the depot's service ladder is the first thing that
    // is climbed rather than walked.
    trigger: { kind: 'nearEntity', tag: TUTORIAL_TAGS.serviceLadder, radius: 2.5 },
    completion: { kind: 'actionPerformed', action: 'interact' },
    messageKey: 'tutorial.ladderClimb',
    priority: TUTORIAL_PRIORITY.high,
    cooldown: 15,
    repeatPolicy: 'until-success',
  },
  {
    id: 'vault',
    trigger: {
      kind: 'all',
      of: [
        { kind: 'nearEntity', tag: TUTORIAL_TAGS.vaultLedge, radius: 2.5 },
        { kind: 'objectiveActive', objectiveId: 'prologue.cross-service-bridge' },
      ],
    },
    completion: { kind: 'actionPerformed', action: 'jump' },
    messageKey: 'tutorial.vault',
    priority: 82,
    cooldown: 10,
    repeatPolicy: 'until-success',
    // Faster than default: a ledge the player cannot cross stops the campaign.
    escalation: { toStrongAfter: 8, toHintAfter: 18 },
  },
  {
    id: 'crouch',
    trigger: { kind: 'nearEntity', tag: TUTORIAL_TAGS.lowClearance, radius: 3.5 },
    completion: { kind: 'actionPerformed', action: 'crouch' },
    messageKey: 'tutorial.crouch',
    priority: 70,
    cooldown: 15,
    repeatPolicy: 'until-success',
  },
  {
    id: 'sprint',
    // Only once the player has somewhere far to go.
    trigger: { kind: 'objectiveActive', objectiveId: 'prologue.cross-service-bridge' },
    completion: { kind: 'actionPerformed', action: 'sprint' },
    messageKey: 'tutorial.sprint',
    priority: 45,
    cooldown: 60,
    repeatPolicy: 'once',
  },

  // --- Tools and evidence --------------------------------------------------
  {
    id: 'scan',
    trigger: { kind: 'nearEntity', tag: TUTORIAL_TAGS.scanTarget, radius: 6 },
    completion: { kind: 'actionPerformed', action: 'scan' },
    messageKey: 'tutorial.scan',
    priority: 84,
    cooldown: 20,
    repeatPolicy: 'until-success',
  },
  {
    id: 'tool-action',
    trigger: { kind: 'actionAvailable', action: 'toolAction' },
    completion: { kind: 'actionPerformed', action: 'toolAction' },
    messageKey: 'tutorial.toolAction',
    priority: 86,
    cooldown: 20,
    repeatPolicy: 'until-success',
  },
  {
    id: 'evidence-pickup',
    trigger: { kind: 'facingInteractable', interactableKind: 'evidence' },
    completion: { kind: 'actionPerformed', action: 'interact' },
    messageKey: 'tutorial.evidencePickup',
    priority: 60,
    cooldown: 30,
    repeatPolicy: 'once',
  },

  // --- Hazards ------------------------------------------------------------
  {
    id: 'machine-detection',
    // Either a maintenance machine is close, or one has already flagged her.
    trigger: {
      kind: 'any',
      of: [
        { kind: 'nearEntity', tag: TUTORIAL_TAGS.machinePatrol, radius: 14 },
        { kind: 'flagSet', flag: 'machine.first-alert' },
      ],
    },
    completion: { kind: 'flagSet', flag: 'machine.first-detection-cleared' },
    messageKey: 'tutorial.machineDetection',
    priority: 94,
    cooldown: 90,
    blocksOthers: true,
    // Recurs across acts: the cue means the same thing in the relay annex as
    // it did on the residential edge, and a player may not have met it yet.
    repeatPolicy: 'contextual',
  },
  {
    id: 'deep-water',
    trigger: { kind: 'sectorEntered', sectorId: 'residential-edge-flooded' },
    completion: { kind: 'flagSet', flag: 'hazard.deep-water-understood' },
    messageKey: 'tutorial.deepWater',
    priority: 84,
    cooldown: 45,
    repeatPolicy: 'once',
  },
  {
    id: 'recover-from-damage',
    trigger: { kind: 'lowHealth', belowFraction: 0.35 },
    completion: { kind: 'flagSet', flag: 'player.recovered' },
    messageKey: 'tutorial.recoverFromDamage',
    priority: 98,
    cooldown: 45,
    blocksOthers: true,
    repeatPolicy: 'contextual',
  },

  // --- Interface ----------------------------------------------------------
  {
    id: 'dialogue-choice',
    // The dialogue system sets this when a scene first offers a reply.
    trigger: { kind: 'flagSet', flag: 'dialogue.choice-offered' },
    completion: { kind: 'actionPerformed', action: 'dialogueSelect' },
    messageKey: 'tutorial.dialogueChoice',
    priority: 92,
    cooldown: 30,
    // Nothing else may appear over a conversation.
    blocksOthers: true,
    repeatPolicy: 'until-success',
  },
  {
    id: 'objective-journal',
    trigger: { kind: 'actionAvailable', action: 'journal' },
    completion: { kind: 'actionPerformed', action: 'journal' },
    messageKey: 'tutorial.objectiveJournal',
    priority: 35,
    cooldown: 120,
    repeatPolicy: 'once',
  },
  {
    id: 'autosave',
    trigger: { kind: 'flagSet', flag: 'save.first-autosave' },
    // The one defensible timer in the registry: there is no action to perform.
    // It explains a thing that already happened, then goes away.
    completion: { kind: 'elapsed', seconds: 6 },
    messageKey: 'tutorial.autosave',
    priority: TUTORIAL_PRIORITY.low,
    repeatPolicy: 'once',
  },
];

export const TUTORIAL_IDS: readonly string[] = TUTORIALS.map((t) => t.id);

const TUTORIALS_BY_ID: ReadonlyMap<string, TutorialDefinition> = new Map(
  TUTORIALS.map((t) => [t.id, t]),
);

export function getTutorial(id: string): TutorialDefinition | undefined {
  return TUTORIALS_BY_ID.get(id);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface TutorialRegistryIssue {
  readonly id: string;
  readonly problem: string;
}

/**
 * Structural checks on authored tutorials.
 *
 * These encode the design rules that are easy to break by accident:
 * a progress-gating tutorial measured by a timer, a recurring cue with no
 * cooldown, an unreachable priority. Run in tests over `TUTORIALS`, and by
 * tooling over any future authored file.
 */
export function validateTutorials(
  defs: readonly TutorialDefinition[] = TUTORIALS,
): TutorialRegistryIssue[] {
  const issues: TutorialRegistryIssue[] = [];
  const seen = new Set<string>();

  for (const def of defs) {
    if (def.id.trim().length === 0) {
      issues.push({ id: '<empty>', problem: 'id is empty' });
    }
    if (seen.has(def.id)) {
      issues.push({ id: def.id, problem: 'duplicate id' });
    }
    seen.add(def.id);

    if (!Number.isInteger(def.priority) || def.priority < 0 || def.priority > 100) {
      issues.push({ id: def.id, problem: `priority ${def.priority} is not an integer in 0..100` });
    }

    if (!def.messageKey.startsWith('tutorial.')) {
      issues.push({ id: def.id, problem: `messageKey "${def.messageKey}" is not namespaced` });
    }

    if (def.cooldown !== undefined && (!Number.isFinite(def.cooldown) || def.cooldown < 0)) {
      issues.push({ id: def.id, problem: 'cooldown must be a non-negative number of seconds' });
    }

    if (def.repeatPolicy === 'until-success' && def.completion.kind !== 'actionPerformed') {
      issues.push({
        id: def.id,
        problem: 'until-success requires an actionPerformed completion — success is the point',
      });
    }

    if (def.repeatPolicy === 'contextual' && (def.cooldown ?? 0) <= 0) {
      issues.push({ id: def.id, problem: 'contextual tutorials need a cooldown or they spam' });
    }

    if (def.completion.kind === 'elapsed') {
      if (tutorialIllustratedAction(def) !== undefined) {
        issues.push({
          id: def.id,
          problem: 'elapsed completion on a tutorial that teaches an action; measure the action',
        });
      }
      if (!(def.completion.seconds > 0)) {
        issues.push({ id: def.id, problem: 'elapsed completion needs a positive duration' });
      }
    }

    if (def.completion.kind === 'actionPerformed') {
      const times = def.completion.times ?? 1;
      if (!Number.isInteger(times) || times < 1) {
        issues.push({ id: def.id, problem: 'completion.times must be an integer >= 1' });
      }
    }

    const timing = tutorialEscalationTiming(def);
    if (!(timing.toStrongAfter > 0) || !(timing.toHintAfter > timing.toStrongAfter)) {
      issues.push({ id: def.id, problem: 'escalation thresholds must increase and be positive' });
    }

    collectTriggerIssues(def, def.trigger, issues);
  }

  return issues;
}

function collectTriggerIssues(
  def: TutorialDefinition,
  trigger: TutorialTrigger,
  issues: TutorialRegistryIssue[],
): void {
  switch (trigger.kind) {
    case 'proximity':
    case 'nearEntity':
      if (!(trigger.radius > 0)) {
        issues.push({ id: def.id, problem: `${trigger.kind} trigger needs a positive radius` });
      }
      break;
    case 'lowHealth':
      if (!(trigger.belowFraction > 0) || trigger.belowFraction > 1) {
        issues.push({ id: def.id, problem: 'lowHealth belowFraction must be within (0,1]' });
      }
      break;
    case 'all':
    case 'any':
      if (trigger.of.length === 0) {
        issues.push({ id: def.id, problem: `${trigger.kind} trigger has no sub-triggers` });
      }
      for (const sub of trigger.of) collectTriggerIssues(def, sub, issues);
      break;
    default:
      break;
  }
}
