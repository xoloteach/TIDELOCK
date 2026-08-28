/**
 * First-use contextual tutorial system.
 *
 * One mechanic, taught at the moment it first matters, and never more than one
 * prompt on screen. The system owns *when* to teach and *when it was learned*;
 * it owns no pixels. It emits `shown`/`updated`/`hidden` with a message key and
 * the `GameAction` to illustrate, and the HUD decides how that looks for the
 * active input family — desktop key hint, controller glyph, or a pulse on the
 * real on-screen touch button (spec 86.4).
 *
 * Everything the system needs to know about the world arrives through
 * read-only ports:
 *
 *   - `TutorialWorldContext` answers trigger questions (position, objectives,
 *     flags, sector, health, interaction focus). It has no setters, which is
 *     the structural reason `resetAll()` cannot damage campaign progress.
 *   - `TutorialSettingsPort` supplies the two gameplay settings that matter.
 *   - `TutorialPersistencePort` stores completed ids. The save system provides
 *     an adapter; this file deliberately knows nothing about IndexedDB.
 *
 * Time is the fixed-step simulation clock, never `Date.now()`. Cooldowns and
 * escalation therefore pause with the game and are deterministic in tests.
 */

import type { System } from '../../engine/ecs/GameWorld';
import { Emitter } from '../../engine/events';
import type { GameAction, InputFamily } from '../../engine/input/actions';
import type { GameplaySettings } from '../../persistence/settingsSchema';
import {
  REDUCED_TUTORIALS_MIN_PRIORITY,
  TUTORIALS,
  TUTORIAL_RESET_VERSION,
  tutorialEscalationTiming,
  tutorialIllustratedAction,
  type TutorialDefinition,
  type TutorialEscalationLevel,
  type TutorialPoint,
  type TutorialTrigger,
} from './tutorialSchema';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Seconds between trigger scans.
 *
 * Cost decision: a scan asks the world a handful of questions per definition —
 * distance to the nearest tagged entity, objective/flag lookups, the current
 * interaction focus. Across the registry that is a few dozen reads, and some of
 * them walk entity lists. At 60 Hz that is thousands of reads per second spent
 * deciding whether to draw a hint a human cannot perceive appearing any faster
 * than a few hundred milliseconds. At 4 Hz the worst-case latency before a
 * prompt appears is 250 ms, which reads as instant, for ~7% of the work.
 *
 * The active prompt's own bookkeeping (visible time, escalation, the elapsed
 * completion) still advances every fixed step: it is one object, and escalation
 * thresholds should not quantise to the scan interval.
 */
export const TUTORIAL_EVALUATION_INTERVAL_S = 0.25;

/**
 * Minimum gap before a tutorial whose context vanished may return, when the
 * definition declares no cooldown. Stops a prompt strobing while the player
 * stands exactly on a trigger radius.
 */
export const TUTORIAL_MIN_RESHOW_GAP_S = 1.5;

/**
 * How much a reported failed attempt counts toward escalation, in seconds.
 *
 * A player who has pressed the wrong thing three times is further from
 * succeeding than one who has stood still for twelve seconds, so failures
 * accelerate assistance rather than waiting on the clock alone.
 */
export const TUTORIAL_FAILED_ATTEMPT_WEIGHT_S = 4;

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * Read-only view of the world, as far as tutorials are concerned.
 *
 * Implemented over the ECS/mission/interaction systems at wiring time. Every
 * method must be cheap: they are called on every scan.
 */
export interface TutorialWorldContext {
  /** Player position, or null when there is no player (menus, loading). */
  playerPosition(): TutorialPoint | null;
  /** Distance in metres to the nearest entity carrying `tag`, or null. */
  distanceToNearestTagged(tag: string): number | null;
  isObjectiveActive(objectiveId: string): boolean;
  isObjectiveComplete(objectiveId: string): boolean;
  isFlagSet(flag: string): boolean;
  /** Whether the action is currently usable — tool equipped, control granted. */
  isActionAvailable(action: GameAction): boolean;
  currentSectorId(): string | null;
  /** 0..1. Returns 1 when there is no player, so no tutorial fires. */
  playerHealthFraction(): number;
  /** Kind of the interactable the player is aimed at, or null for none. */
  focusedInteractableKind(): string | null;
}

/**
 * An inert context: nothing is near, nothing is active, health is full.
 *
 * Used before the world exists, and as the base for tests that only care about
 * one or two answers.
 */
export function createInertTutorialContext(
  overrides: Partial<TutorialWorldContext> = {},
): TutorialWorldContext {
  return {
    playerPosition: () => null,
    distanceToNearestTagged: () => null,
    isObjectiveActive: () => false,
    isObjectiveComplete: () => false,
    isFlagSet: () => false,
    isActionAvailable: () => false,
    currentSectorId: () => null,
    playerHealthFraction: () => 1,
    focusedInteractableKind: () => null,
    ...overrides,
  };
}

export type TutorialGameplaySettings = Pick<
  GameplaySettings,
  'tutorialsEnabled' | 'reducedTutorials'
>;

export interface TutorialSettingsPort {
  /** Read at scan time so toggling the setting takes effect immediately. */
  gameplay(): TutorialGameplaySettings;
}

/** The slice of a save this system owns. Nothing else. */
export interface TutorialPersistedState {
  readonly completedIds: readonly string[];
  /** The content version these completions were recorded against. */
  readonly resetVersion: number;
}

/**
 * Storage for tutorial completion.
 *
 * Synchronous by design: the save system holds the campaign blob in memory and
 * writes it on its own schedule, so `save` here is a handoff, not I/O.
 */
export interface TutorialPersistencePort {
  load(): TutorialPersistedState | null;
  save(state: TutorialPersistedState): void;
}

/** In-memory persistence, for tests and for a session with no save yet. */
export function createMemoryTutorialPersistence(
  initial: TutorialPersistedState | null = null,
): TutorialPersistencePort & { readonly state: TutorialPersistedState | null } {
  let state = initial;
  return {
    get state() {
      return state;
    },
    load: () => state,
    save: (next) => {
      state = next;
    },
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** What the HUD needs in order to render a prompt. It gets nothing else. */
export interface TutorialPresentation {
  readonly id: string;
  /** Localization key. Never player-visible text. */
  readonly messageKey: string;
  /** The action to illustrate. Undefined for informational prompts. */
  readonly action?: GameAction;
  /** 1 normal, 2 stronger, 3 hint (spec 86.6). */
  readonly level: TutorialEscalationLevel;
  /** Which prompt vocabulary to draw. */
  readonly family: InputFamily;
  readonly priority: number;
  /** True when this prompt must not be visually competed with. */
  readonly exclusive: boolean;
}

export type TutorialHideReason =
  /** The player performed the action / the world state was reached. */
  | 'completed'
  /** A higher-priority tutorial took the slot. This one returns to the queue. */
  | 'superseded'
  /** The situation ended — the player walked away from the ledge. */
  | 'context-lost'
  /** Tutorials were switched off. */
  | 'disabled'
  /** Tutorials were reset from settings, or a different save was loaded. */
  | 'reset';

export type TutorialCompletionCause =
  | 'action'
  | 'flag'
  | 'objective'
  | 'elapsed'
  /** A `once` tutorial whose context ended before the player acted. */
  | 'dismissed';

/**
 * Declared as a type alias, not an interface: TypeScript only infers an
 * implicit index signature for aliases, which the `EventMap` constraint needs.
 */
export type TutorialEvents = {
  /** A prompt became visible. */
  shown: TutorialPresentation;
  /** The visible prompt changed — escalation level or input family. */
  updated: TutorialPresentation;
  hidden: { id: string; reason: TutorialHideReason };
  completed: { id: string; cause: TutorialCompletionCause };
  reset: { clearedIds: readonly string[]; resetVersion: number };
};

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export interface TutorialSystemOptions {
  context: TutorialWorldContext;
  settings: TutorialSettingsPort;
  persistence?: TutorialPersistencePort | null;
  /** Defaults to the campaign registry. Tests pass focused sets. */
  definitions?: readonly TutorialDefinition[];
  /** Defaults to `TUTORIAL_RESET_VERSION`. */
  resetVersion?: number;
  inputFamily?: InputFamily;
  evaluationInterval?: number;
}

interface TutorialRuntime {
  readonly def: TutorialDefinition;
  /** Registry position. Stable tiebreak for equal priorities. */
  readonly order: number;
  completed: boolean;
  /** Sim-clock time before which this tutorial is not eligible. */
  cooldownUntil: number;
  /** Seconds this prompt has been visible without success. */
  visibleSeconds: number;
  /** Escalation weight contributed by reported failed attempts. */
  failurePenalty: number;
  /** Progress toward a multi-repetition `actionPerformed` completion. */
  actionCount: number;
  level: TutorialEscalationLevel;
  shownCount: number;
}

export class TutorialSystem implements System {
  readonly name = 'tutorial';

  private readonly emitter = new Emitter<TutorialEvents>();
  private readonly context: TutorialWorldContext;
  private readonly settings: TutorialSettingsPort;
  private readonly persistence: TutorialPersistencePort | null;
  private readonly runtimes = new Map<string, TutorialRuntime>();
  /** Registry order, for deterministic scanning. */
  private readonly all: TutorialRuntime[] = [];
  private readonly evaluationInterval: number;
  private readonly resetVersion: number;

  /** Eligible but not visible. A queue, never a stack of prompts. */
  private readonly queue: string[] = [];
  private activeId: string | null = null;

  private clock = 0;
  private sinceScan = 0;
  private family: InputFamily;

  constructor(options: TutorialSystemOptions) {
    this.context = options.context;
    this.settings = options.settings;
    this.persistence = options.persistence ?? null;
    this.evaluationInterval = options.evaluationInterval ?? TUTORIAL_EVALUATION_INTERVAL_S;
    this.resetVersion = options.resetVersion ?? TUTORIAL_RESET_VERSION;
    this.family = options.inputFamily ?? 'keyboard';

    const definitions = options.definitions ?? TUTORIALS;
    definitions.forEach((def, index) => {
      if (this.runtimes.has(def.id)) {
        // Two definitions with one id would make completion ambiguous, and the
        // second would be unreachable. Fail loudly at construction.
        throw new Error(`Duplicate tutorial id "${def.id}"`);
      }
      const runtime: TutorialRuntime = {
        def,
        order: index,
        completed: false,
        cooldownUntil: 0,
        visibleSeconds: 0,
        failurePenalty: 0,
        actionCount: 0,
        level: 1,
        shownCount: 0,
      };
      this.runtimes.set(def.id, runtime);
      this.all.push(runtime);
    });

    const stored = this.persistence?.load() ?? null;
    if (stored) this.applyPersisted(stored);
  }

  on = this.emitter.on.bind(this.emitter);
  off = this.emitter.off.bind(this.emitter);

  // ---- Public state -----------------------------------------------------

  /** The visible prompt, or null. */
  get active(): TutorialPresentation | null {
    const runtime = this.activeId ? this.runtimes.get(this.activeId) : undefined;
    return runtime ? this.present(runtime) : null;
  }

  get activeTutorialId(): string | null {
    return this.activeId;
  }

  /** Waiting tutorials, highest priority first. */
  get queuedIds(): readonly string[] {
    return this.sortedQueue().map((runtime) => runtime.def.id);
  }

  get completedIds(): readonly string[] {
    return this.all.filter((runtime) => runtime.completed).map((runtime) => runtime.def.id);
  }

  isCompleted(id: string): boolean {
    return this.runtimes.get(id)?.completed ?? false;
  }

  /** Escalation level of a tutorial, whether or not it is currently visible. */
  escalationLevel(id: string): TutorialEscalationLevel {
    return this.runtimes.get(id)?.level ?? 1;
  }

  /**
   * The input family prompts should be drawn for.
   *
   * Exposed so the HUD can pick its vocabulary and so a screen opened after a
   * family change starts correct. The system renders nothing itself.
   */
  get inputFamily(): InputFamily {
    return this.family;
  }

  /** Called by the input layer when the player switches device (spec 86.4). */
  setInputFamily(family: InputFamily): void {
    if (family === this.family) return;
    this.family = family;
    // A visible prompt must swap vocabulary immediately rather than waiting for
    // the next scan — the player just picked up a controller.
    const runtime = this.activeId ? this.runtimes.get(this.activeId) : undefined;
    if (runtime) this.emitter.emit('updated', this.present(runtime));
  }

  /** Simulation seconds elapsed. Exposed for diagnostics and tests. */
  get elapsed(): number {
    return this.clock;
  }

  // ---- Simulation -------------------------------------------------------

  fixedUpdate(dt: number): void {
    this.clock += dt;

    const gameplay = this.settings.gameplay();
    if (!gameplay.tutorialsEnabled) {
      // Off means off: nothing visible, nothing waiting, and no completions
      // recorded for prompts the player never saw.
      if (this.activeId) this.hideActive('disabled');
      this.queue.length = 0;
      // Scan promptly if the setting comes back on.
      this.sinceScan = this.evaluationInterval;
      return;
    }

    if (this.activeId) this.advanceActive(dt);

    this.sinceScan += dt;
    if (this.sinceScan < this.evaluationInterval) return;
    this.sinceScan = 0;
    this.scan(gameplay);
  }

  /** Per-step bookkeeping for the single visible prompt. */
  private advanceActive(dt: number): void {
    const runtime = this.runtimes.get(this.activeId!);
    if (!runtime) {
      this.activeId = null;
      return;
    }

    runtime.visibleSeconds += dt;

    if (
      runtime.def.completion.kind === 'elapsed' &&
      runtime.visibleSeconds >= runtime.def.completion.seconds
    ) {
      this.complete(runtime, 'elapsed');
      return;
    }

    this.refreshLevel(runtime);
  }

  private scan(gameplay: TutorialGameplaySettings): void {
    // 1. The visible prompt: has its success condition been met in world state,
    //    and does its situation still exist?
    const active = this.activeId ? this.runtimes.get(this.activeId) : undefined;
    if (active) {
      if (this.pollWorldCompletion(active)) {
        // `complete` cleared the slot.
      } else if (!this.evaluateTrigger(active.def.trigger)) {
        this.retire(active, 'context-lost');
      }
    }

    // 2. Refresh the waiting pool. Entries that lost their context or became
    //    ineligible leave rather than surfacing later out of context.
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const runtime = this.runtimes.get(this.queue[i]!);
      if (!runtime || !this.isEligible(runtime, gameplay)) this.queue.splice(i, 1);
    }

    for (const runtime of this.all) {
      if (runtime.def.id === this.activeId) continue;
      if (this.queue.includes(runtime.def.id)) continue;
      if (!this.isEligible(runtime, gameplay)) continue;
      this.queue.push(runtime.def.id);
    }

    // 3. `blocksOthers` suppresses lower-priority tutorials entirely: they are
    //    not merely deferred, they are dropped from the pool and must earn
    //    eligibility again once the blocker is gone. Otherwise a stealth
    //    warning would be followed by a backlog of five stale hints. Applied
    //    after the slot decision below, so a blocker suppresses in the same
    //    scan it becomes visible.

    // 4. Fill or preempt the single slot.
    const current = this.activeId ? this.runtimes.get(this.activeId) : undefined;
    const best = this.sortedQueue()[0];

    if (best && !current) {
      this.activate(best);
    } else if (best && current && best.def.priority > current.def.priority) {
      // The interrupted tutorial goes back to the pool with its struggle time
      // intact; it was not learned, it was interrupted.
      this.retire(current, 'superseded');
      this.activate(best);
    }

    // 5. Suppression, against whatever now holds the slot.
    const visible = this.activeId ? this.runtimes.get(this.activeId) : undefined;
    if (!visible?.def.blocksOthers) return;
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const runtime = this.runtimes.get(this.queue[i]!);
      if (!runtime || runtime.def.priority < visible.def.priority) this.queue.splice(i, 1);
    }
  }

  // ---- Eligibility ------------------------------------------------------

  private isEligible(runtime: TutorialRuntime, gameplay: TutorialGameplaySettings): boolean {
    // Experienced players keep the safety and progress-gating prompts only.
    if (gameplay.reducedTutorials && runtime.def.priority < REDUCED_TUTORIALS_MIN_PRIORITY) {
      return false;
    }
    // `contextual` cues may recur after completion; everything else is done.
    if (runtime.completed && runtime.def.repeatPolicy !== 'contextual') return false;
    if (this.clock < runtime.cooldownUntil) return false;
    return this.evaluateTrigger(runtime.def.trigger);
  }

  private evaluateTrigger(trigger: TutorialTrigger): boolean {
    switch (trigger.kind) {
      case 'proximity': {
        const position = this.context.playerPosition();
        if (!position) return false;
        return squaredDistance(position, trigger.position) <= trigger.radius * trigger.radius;
      }
      case 'nearEntity': {
        const distance = this.context.distanceToNearestTagged(trigger.tag);
        return distance !== null && distance <= trigger.radius;
      }
      case 'objectiveActive':
        return this.context.isObjectiveActive(trigger.objectiveId);
      case 'flagSet':
        return this.context.isFlagSet(trigger.flag);
      case 'actionAvailable':
        return this.context.isActionAvailable(trigger.action);
      case 'sectorEntered':
        return this.context.currentSectorId() === trigger.sectorId;
      case 'lowHealth':
        return this.context.playerHealthFraction() < trigger.belowFraction;
      case 'facingInteractable': {
        const kind = this.context.focusedInteractableKind();
        if (kind === null) return false;
        return trigger.interactableKind === undefined || trigger.interactableKind === kind;
      }
      case 'all':
        return trigger.of.every((sub) => this.evaluateTrigger(sub));
      case 'any':
        return trigger.of.some((sub) => this.evaluateTrigger(sub));
    }
  }

  /** Queue contents as runtimes, highest priority first, registry order tiebreak. */
  private sortedQueue(): TutorialRuntime[] {
    const runtimes: TutorialRuntime[] = [];
    for (const id of this.queue) {
      const runtime = this.runtimes.get(id);
      if (runtime) runtimes.push(runtime);
    }
    runtimes.sort((a, b) => b.def.priority - a.def.priority || a.order - b.order);
    return runtimes;
  }

  // ---- Slot transitions -------------------------------------------------

  private activate(runtime: TutorialRuntime): void {
    const index = this.queue.indexOf(runtime.def.id);
    if (index >= 0) this.queue.splice(index, 1);

    // `until-success` keeps its accumulated struggle time across re-shows: the
    // player returning to the same ledge is still failing the same thing, and
    // restarting escalation would make assistance unreachable. A `contextual`
    // cue recurring an act later starts clean.
    if (runtime.def.repeatPolicy !== 'until-success') {
      runtime.visibleSeconds = 0;
      runtime.failurePenalty = 0;
    }
    runtime.actionCount = 0;
    runtime.level = this.computeLevel(runtime);
    runtime.shownCount += 1;
    this.activeId = runtime.def.id;

    this.emitter.emit('shown', this.present(runtime));
  }

  private hideActive(reason: TutorialHideReason): void {
    const id = this.activeId;
    if (!id) return;
    this.activeId = null;
    this.emitter.emit('hidden', { id, reason });
  }

  /** Removes the prompt without success. */
  private retire(runtime: TutorialRuntime, reason: 'superseded' | 'context-lost'): void {
    this.hideActive(reason);

    if (reason === 'superseded') {
      // Straight back into the pool — the next scan re-checks its context.
      if (!this.queue.includes(runtime.def.id)) this.queue.push(runtime.def.id);
      return;
    }

    runtime.cooldownUntil = this.clock + (runtime.def.cooldown ?? TUTORIAL_MIN_RESHOW_GAP_S);

    // `once` means shown once. It is recorded as seen so it never returns,
    // which is exactly why gating mechanics use `until-success` instead.
    if (runtime.def.repeatPolicy === 'once') {
      runtime.completed = true;
      this.persist();
      this.emitter.emit('completed', { id: runtime.def.id, cause: 'dismissed' });
    }
  }

  private complete(runtime: TutorialRuntime, cause: TutorialCompletionCause): void {
    runtime.completed = true;
    runtime.visibleSeconds = 0;
    runtime.failurePenalty = 0;
    runtime.actionCount = 0;
    runtime.level = 1;
    // Applies to `contextual` cues, which may legitimately recur; harmless for
    // the rest, which will never be eligible again.
    runtime.cooldownUntil = this.clock + (runtime.def.cooldown ?? 0);

    const queueIndex = this.queue.indexOf(runtime.def.id);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);

    if (this.activeId === runtime.def.id) this.hideActive('completed');

    this.persist();
    this.emitter.emit('completed', { id: runtime.def.id, cause });
  }

  /** Completion conditions that live in world state rather than an event. */
  private pollWorldCompletion(runtime: TutorialRuntime): boolean {
    const completion = runtime.def.completion;
    switch (completion.kind) {
      case 'flagSet':
        if (this.context.isFlagSet(completion.flag)) {
          this.complete(runtime, 'flag');
          return true;
        }
        return false;
      case 'objectiveCompleted':
        if (this.context.isObjectiveComplete(completion.objectiveId)) {
          this.complete(runtime, 'objective');
          return true;
        }
        return false;
      default:
        // `actionPerformed` is event-driven and `elapsed` is handled per step.
        return false;
    }
  }

  // ---- Escalation (spec 86.6) -------------------------------------------

  private computeLevel(runtime: TutorialRuntime): TutorialEscalationLevel {
    const timing = tutorialEscalationTiming(runtime.def);
    const weight = runtime.visibleSeconds + runtime.failurePenalty;
    if (weight >= timing.toHintAfter) return 3;
    if (weight >= timing.toStrongAfter) return 2;
    return 1;
  }

  private refreshLevel(runtime: TutorialRuntime): void {
    const level = this.computeLevel(runtime);
    if (level === runtime.level) return;
    runtime.level = level;
    this.emitter.emit('updated', this.present(runtime));
  }

  // ---- Reports from other systems ---------------------------------------

  /**
   * The player performed an action. Called by the systems that know a real
   * attempt happened — movement (actually moved, not a nudge inside the
   * deadzone), interaction (a target was used), dialogue (a reply chosen).
   *
   * Only the visible prompt and the waiting pool can be satisfied this way. An
   * incidental press before the mechanic is ever relevant is not evidence the
   * player understood it, and crediting it would delete the lesson.
   */
  notifyActionPerformed(action: GameAction): void {
    const ids = this.activeId ? [this.activeId, ...this.queue] : [...this.queue];
    for (const id of ids) {
      const runtime = this.runtimes.get(id);
      if (!runtime || runtime.completed) continue;
      const completion = runtime.def.completion;
      if (completion.kind !== 'actionPerformed' || completion.action !== action) continue;

      runtime.actionCount += 1;
      if (runtime.actionCount >= (completion.times ?? 1)) this.complete(runtime, 'action');
    }
  }

  /**
   * The player tried and it did not work — Interact pressed with no target, a
   * vault attempt that clipped the ledge. Accelerates assistance without
   * performing the action for them.
   *
   * `action` narrows the report to the prompt that teaches it; omit it to
   * report a generic failed attempt against whatever is on screen.
   */
  notifyFailedAttempt(action?: GameAction): void {
    const runtime = this.activeId ? this.runtimes.get(this.activeId) : undefined;
    if (!runtime) return;
    if (action !== undefined && tutorialIllustratedAction(runtime.def) !== action) return;

    runtime.failurePenalty += TUTORIAL_FAILED_ATTEMPT_WEIGHT_S;
    this.refreshLevel(runtime);
  }

  // ---- Persistence ------------------------------------------------------

  /** The state the save system writes. Tutorial data only. */
  snapshot(): TutorialPersistedState {
    return { completedIds: this.completedIds, resetVersion: this.resetVersion };
  }

  /**
   * Adopts stored completions — at boot, or when a different save is loaded
   * mid-session. Clears anything on screen: the prompt belonged to the old
   * session.
   */
  loadFrom(state: TutorialPersistedState): void {
    if (this.activeId) this.hideActive('reset');
    this.queue.length = 0;
    this.applyPersisted(state);
  }

  private applyPersisted(state: TutorialPersistedState): void {
    for (const runtime of this.all) {
      runtime.completed = false;
      runtime.cooldownUntil = 0;
      runtime.visibleSeconds = 0;
      runtime.failurePenalty = 0;
      runtime.actionCount = 0;
      runtime.level = 1;
      runtime.shownCount = 0;
    }

    if (state.resetVersion !== this.resetVersion) {
      // Tutorial content changed since these completions were recorded. Re-arm
      // everything: a prompt completed against the old control scheme would
      // otherwise stay hidden while teaching nothing.
      console.info(
        `[tutorial] stored completions are version ${state.resetVersion}, content is ${this.resetVersion}; re-arming`,
      );
      this.persist();
      return;
    }

    for (const id of state.completedIds) {
      const runtime = this.runtimes.get(id);
      // Ids for tutorials that no longer exist are dropped rather than carried
      // forward forever.
      if (runtime) runtime.completed = true;
    }
  }

  private persist(): void {
    this.persistence?.save(this.snapshot());
  }

  /**
   * Clears tutorial completion and lets every tutorial teach again.
   *
   * Campaign progress is untouched, and not by convention: the system's only
   * view of missions, flags and objectives is `TutorialWorldContext`, which is
   * read-only, and its only writer is the tutorial slice of persistence. There
   * is no code path from here to a campaign flag.
   */
  resetAll(): void {
    const clearedIds = this.completedIds;

    if (this.activeId) this.hideActive('reset');
    this.queue.length = 0;

    for (const runtime of this.all) {
      runtime.completed = false;
      runtime.cooldownUntil = 0;
      runtime.visibleSeconds = 0;
      runtime.failurePenalty = 0;
      runtime.actionCount = 0;
      runtime.level = 1;
      runtime.shownCount = 0;
    }

    // Rescan on the next step so a tutorial whose context is already present
    // returns immediately.
    this.sinceScan = this.evaluationInterval;

    this.persist();
    this.emitter.emit('reset', { clearedIds, resetVersion: this.resetVersion });
  }

  dispose(): void {
    this.activeId = null;
    this.queue.length = 0;
    this.emitter.clear();
  }

  // ---- Presentation -----------------------------------------------------

  private present(runtime: TutorialRuntime): TutorialPresentation {
    return {
      id: runtime.def.id,
      messageKey: runtime.def.messageKey,
      action: tutorialIllustratedAction(runtime.def),
      level: runtime.level,
      family: this.family,
      priority: runtime.def.priority,
      exclusive: runtime.def.blocksOthers === true,
    };
  }
}

function squaredDistance(a: TutorialPoint, b: TutorialPoint): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}
