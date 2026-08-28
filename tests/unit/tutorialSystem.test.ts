/**
 * First-use contextual tutorial system tests.
 *
 * The failure this system exists to prevent is a player standing at a ledge
 * they cannot cross with no prompt, and its opposite: five panels at spawn
 * explaining mechanics nobody has met. Both failures are invisible to a
 * typecheck, so the properties that stop them are tested directly — a trigger
 * that cannot fire before its situation exists, a completion that means the
 * player actually did the thing, one slot on screen with a queue behind it, and
 * completion state that survives a reload but is never confused with campaign
 * progress (spec 86.8).
 *
 * Time here is the fixed simulation clock. Every test drives `fixedUpdate` with
 * explicit steps rather than mocking `Date.now`, because that is what the game
 * does and it makes cooldowns and escalation exactly reproducible.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  TutorialSystem,
  createInertTutorialContext,
  createMemoryTutorialPersistence,
  TUTORIAL_FAILED_ATTEMPT_WEIGHT_S,
  TUTORIAL_MIN_RESHOW_GAP_S,
  type TutorialEvents,
  type TutorialGameplaySettings,
  type TutorialPresentation,
  type TutorialSettingsPort,
  type TutorialWorldContext,
} from '../../src/game/tutorial/TutorialSystem';
import {
  DEFAULT_ESCALATION_TIMING,
  REDUCED_TUTORIALS_MIN_PRIORITY,
  TUTORIAL_PRIORITY,
  TUTORIAL_RESET_VERSION,
  getTutorial,
  validateTutorials,
  type TutorialDefinition,
} from '../../src/game/tutorial/tutorialSchema';
import { isButtonAction } from '../../src/engine/input/actions';

const DT = 1 / 60;

// ---------------------------------------------------------------------------
// Ports and fixtures
// ---------------------------------------------------------------------------

interface MutableSettingsPort extends TutorialSettingsPort {
  /** The live object the port hands back, so a test can flip a setting mid-run. */
  readonly state: TutorialGameplaySettings;
}

function settingsPort(initial: Partial<TutorialGameplaySettings> = {}): MutableSettingsPort {
  const state: TutorialGameplaySettings = {
    tutorialsEnabled: true,
    reducedTutorials: false,
    ...initial,
  };
  return { state, gameplay: () => state };
}

/**
 * A world where the only thing that can be true is a flag.
 *
 * Most of these tests are about *when* a prompt appears, not about how a
 * situation is detected, so a mutable flag set is the cheapest honest trigger:
 * `flags.add(...)` is "the player walked into the situation".
 */
function flagContext(flags: Set<string>): TutorialWorldContext {
  return createInertTutorialContext({ isFlagSet: (flag) => flags.has(flag) });
}

/** Control has just been handed to the player: every action is usable, nothing else is true. */
function controlHandoverContext(): TutorialWorldContext {
  return createInertTutorialContext({ isActionAvailable: () => true });
}

/**
 * A focused definition whose trigger is the flag `ctx.<id>`.
 *
 * Completions default to `interact`; tests with several definitions in play
 * override them, because `notifyActionPerformed` credits every waiting
 * tutorial that teaches the reported action and sharing one would complete
 * them all at once.
 */
function definition(
  overrides: Partial<TutorialDefinition> & Pick<TutorialDefinition, 'id'>,
): TutorialDefinition {
  return {
    trigger: { kind: 'flagSet', flag: `ctx.${overrides.id}` },
    completion: { kind: 'actionPerformed', action: 'interact' },
    messageKey: `tutorial.${overrides.id}`,
    priority: TUTORIAL_PRIORITY.normal,
    repeatPolicy: 'until-success',
    ...overrides,
  };
}

/** Advances the simulation clock in fixed steps, as the real loop does. */
function step(system: TutorialSystem, seconds: number, dt = DT): void {
  const steps = Math.max(1, Math.round(seconds / dt));
  for (let i = 0; i < steps; i += 1) system.fixedUpdate(dt);
}

interface Recorded {
  shown: TutorialPresentation[];
  updated: TutorialPresentation[];
  hidden: TutorialEvents['hidden'][];
  completed: TutorialEvents['completed'][];
  reset: TutorialEvents['reset'][];
}

function record(system: TutorialSystem): Recorded {
  const events: Recorded = { shown: [], updated: [], hidden: [], completed: [], reset: [] };
  system.on('shown', (payload) => events.shown.push(payload));
  system.on('updated', (payload) => events.updated.push(payload));
  system.on('hidden', (payload) => events.hidden.push(payload));
  system.on('completed', (payload) => events.completed.push(payload));
  system.on('reset', (payload) => events.reset.push(payload));
  return events;
}

/**
 * A system that scans on every fixed step.
 *
 * The shipped 250 ms scan interval exists to avoid spending thousands of world
 * queries a second deciding whether to draw a hint. Tests are about the
 * decisions, not the throttle, so they scan every step and the throttle itself
 * is covered by its own test.
 */
function eagerSystem(
  options: Omit<ConstructorParameters<typeof TutorialSystem>[0], 'evaluationInterval'>,
): TutorialSystem {
  return new TutorialSystem({ ...options, evaluationInterval: 0 });
}

// ---------------------------------------------------------------------------

describe('TutorialSystem first trigger', () => {
  it('teaches movement first on a fresh state', () => {
    const system = eagerSystem({ context: controlHandoverContext(), settings: settingsPort() });
    const events = record(system);

    system.fixedUpdate(DT);

    // `move` is the only priority-100 entry in the registry, so the first thing
    // the player is ever told is how to walk.
    expect(system.activeTutorialId).toBe('move');
    expect(events.shown.map((p) => p.id)).toEqual(['move']);
    expect(events.shown[0]?.messageKey).toBe('tutorial.move');
    expect(events.shown[0]?.level).toBe(1);
  });

  it('shows nothing at all in an inert world', () => {
    const system = eagerSystem({
      context: createInertTutorialContext(),
      settings: settingsPort(),
    });
    const events = record(system);

    step(system, 3);

    // Every trigger in the registry describes a situation, so "at spawn,
    // always" is not expressible. That is the structural reason New Game
    // cannot open with a wall of prompts.
    expect(system.activeTutorialId).toBeNull();
    expect(system.queuedIds).toEqual([]);
    expect(events.shown).toHaveLength(0);
  });

  it('withholds the interact tutorial until the player is actually facing something', () => {
    let facing: string | null = null;
    const system = eagerSystem({
      context: createInertTutorialContext({
        isActionAvailable: (action) => action === 'interact',
        focusedInteractableKind: () => facing,
      }),
      settings: settingsPort(),
      definitions: [getTutorial('interact')!],
    });

    step(system, 1);

    // The action being bound is not a reason to teach it; the situation is.
    expect(system.activeTutorialId).toBeNull();

    facing = 'valve';
    system.fixedUpdate(DT);

    expect(system.activeTutorialId).toBe('interact');
  });

  it('scans on its declared interval rather than every step', () => {
    const flags = new Set<string>();
    const system = new TutorialSystem({
      context: flagContext(flags),
      settings: settingsPort(),
      definitions: [definition({ id: 'valve' })],
      evaluationInterval: 0.25,
    });

    flags.add('ctx.valve');
    step(system, 0.2);
    expect(system.activeTutorialId).toBeNull();

    // Worst-case latency before a prompt appears is one interval, which reads
    // as instant to a human but costs ~7% of a per-step scan.
    step(system, 0.1);
    expect(system.activeTutorialId).toBe('valve');
  });
});

describe('TutorialSystem completion', () => {
  it('completes when the taught action is performed', () => {
    const system = eagerSystem({ context: controlHandoverContext(), settings: settingsPort() });
    const events = record(system);
    system.fixedUpdate(DT);

    system.notifyActionPerformed('moveY');

    expect(events.completed).toEqual([{ id: 'move', cause: 'action' }]);
    expect(events.hidden).toEqual([{ id: 'move', reason: 'completed' }]);
    expect(system.isCompleted('move')).toBe(true);
    expect(system.activeTutorialId).toBeNull();
  });

  it('ignores an action performed before the mechanic was ever taught', () => {
    const flags = new Set<string>();
    const system = eagerSystem({
      context: flagContext(flags),
      settings: settingsPort(),
      definitions: [definition({ id: 'valve' })],
    });
    const events = record(system);

    step(system, 1);
    system.notifyActionPerformed('interact');

    // An incidental press before the prompt exists is not evidence the player
    // understood the mechanic, and crediting it would delete the lesson.
    expect(system.isCompleted('valve')).toBe(false);
    expect(events.completed).toHaveLength(0);

    flags.add('ctx.valve');
    system.fixedUpdate(DT);
    expect(system.activeTutorialId).toBe('valve');
  });

  it('requires the declared number of repetitions', () => {
    const flags = new Set(['ctx.look']);
    const system = eagerSystem({
      context: flagContext(flags),
      settings: settingsPort(),
      definitions: [
        definition({ id: 'look', completion: { kind: 'actionPerformed', action: 'interact', times: 2 } }),
      ],
    });
    system.fixedUpdate(DT);

    system.notifyActionPerformed('interact');
    expect(system.isCompleted('look')).toBe(false);

    system.notifyActionPerformed('interact');
    expect(system.isCompleted('look')).toBe(true);
  });

  it('completes on a world flag rather than a keypress', () => {
    const flags = new Set(['ctx.hazard']);
    const system = eagerSystem({
      context: flagContext(flags),
      settings: settingsPort(),
      definitions: [
        definition({
          id: 'hazard',
          repeatPolicy: 'once',
          completion: { kind: 'flagSet', flag: 'hazard.understood' },
        }),
      ],
    });
    const events = record(system);
    system.fixedUpdate(DT);
    expect(system.activeTutorialId).toBe('hazard');

    flags.add('hazard.understood');
    system.fixedUpdate(DT);

    expect(events.completed).toEqual([{ id: 'hazard', cause: 'flag' }]);
  });

  it('completes when the objective it teaches completes', () => {
    let done = false;
    const system = eagerSystem({
      context: createInertTutorialContext({
        isObjectiveActive: (id) => id === 'prologue.cross-service-bridge',
        isObjectiveComplete: () => done,
      }),
      settings: settingsPort(),
      definitions: [
        definition({
          id: 'bridge',
          repeatPolicy: 'once',
          trigger: { kind: 'objectiveActive', objectiveId: 'prologue.cross-service-bridge' },
          completion: { kind: 'objectiveCompleted', objectiveId: 'prologue.cross-service-bridge' },
        }),
      ],
    });
    const events = record(system);
    system.fixedUpdate(DT);

    done = true;
    system.fixedUpdate(DT);

    expect(events.completed).toEqual([{ id: 'bridge', cause: 'objective' }]);
  });

  it('dismisses an informational prompt after its declared duration', () => {
    const flags = new Set(['ctx.autosave']);
    const system = eagerSystem({
      context: flagContext(flags),
      settings: settingsPort(),
      definitions: [
        definition({
          id: 'autosave',
          repeatPolicy: 'once',
          completion: { kind: 'elapsed', seconds: 2 },
        }),
      ],
    });
    const events = record(system);

    step(system, 1.5);
    // A timer is only defensible when there is no action to perform.
    expect(system.activeTutorialId).toBe('autosave');

    step(system, 1);

    expect(events.completed).toEqual([{ id: 'autosave', cause: 'elapsed' }]);
    expect(system.activeTutorialId).toBeNull();
  });

  it('never shows a completed tutorial again', () => {
    const system = eagerSystem({ context: controlHandoverContext(), settings: settingsPort() });
    const events = record(system);
    system.fixedUpdate(DT);
    system.notifyActionPerformed('moveY');

    step(system, 20);

    expect(events.shown.filter((p) => p.id === 'move')).toHaveLength(1);
    expect(system.completedIds).toContain('move');
  });

  it('records a once tutorial as seen when its context ends before the player acts', () => {
    const flags = new Set(['ctx.journal']);
    const system = eagerSystem({
      context: flagContext(flags),
      settings: settingsPort(),
      definitions: [definition({ id: 'journal', repeatPolicy: 'once' })],
    });
    const events = record(system);
    system.fixedUpdate(DT);

    flags.delete('ctx.journal');
    system.fixedUpdate(DT);

    expect(events.hidden).toEqual([{ id: 'journal', reason: 'context-lost' }]);
    // `once` means shown once, which is exactly why progress-gating mechanics
    // use `until-success` instead.
    expect(events.completed).toEqual([{ id: 'journal', cause: 'dismissed' }]);

    flags.add('ctx.journal');
    step(system, 10);
    expect(events.shown).toHaveLength(1);
  });

  it('re-offers an until-success tutorial every time its context returns', () => {
    const flags = new Set(['ctx.vault']);
    const system = eagerSystem({
      context: flagContext(flags),
      settings: settingsPort(),
      definitions: [definition({ id: 'vault', cooldown: 1 })],
    });
    const events = record(system);
    system.fixedUpdate(DT);

    flags.delete('ctx.vault');
    system.fixedUpdate(DT);
    flags.add('ctx.vault');
    step(system, 1.5);

    // A ledge the player still cannot cross must keep offering the prompt.
    expect(events.shown.map((p) => p.id)).toEqual(['vault', 'vault']);
    expect(system.isCompleted('vault')).toBe(false);
  });
});

describe('TutorialSystem cooldowns', () => {
  it('holds a tutorial off for its declared cooldown after its context disappears', () => {
    const flags = new Set(['ctx.valve']);
    const system = eagerSystem({
      context: flagContext(flags),
      settings: settingsPort(),
      definitions: [definition({ id: 'valve', cooldown: 5 })],
    });
    const events = record(system);
    system.fixedUpdate(DT);
    expect(system.activeTutorialId).toBe('valve');

    flags.delete('ctx.valve');
    system.fixedUpdate(DT);
    expect(events.hidden).toEqual([{ id: 'valve', reason: 'context-lost' }]);

    // The context returns immediately — the player is standing exactly on the
    // trigger radius. Without the cooldown the prompt would strobe.
    flags.add('ctx.valve');
    step(system, 2);
    expect(system.activeTutorialId).toBeNull();
    expect(events.shown).toHaveLength(1);

    step(system, 3.5);
    expect(system.activeTutorialId).toBe('valve');
    expect(events.shown).toHaveLength(2);
  });

  it('falls back to the minimum re-show gap when no cooldown is declared', () => {
    const flags = new Set(['ctx.ledge']);
    const system = eagerSystem({
      context: flagContext(flags),
      settings: settingsPort(),
      definitions: [definition({ id: 'ledge' })],
    });
    const events = record(system);
    system.fixedUpdate(DT);

    flags.delete('ctx.ledge');
    system.fixedUpdate(DT);
    flags.add('ctx.ledge');

    step(system, TUTORIAL_MIN_RESHOW_GAP_S * 0.5);
    expect(system.activeTutorialId).toBeNull();

    step(system, TUTORIAL_MIN_RESHOW_GAP_S);
    expect(events.shown).toHaveLength(2);
  });
});

describe('TutorialSystem priority and queueing', () => {
  it('shows the highest-priority candidate and queues the rest instead of stacking', () => {
    const flags = new Set(['ctx.low', 'ctx.high', 'ctx.mid']);
    const system = eagerSystem({
      context: flagContext(flags),
      settings: settingsPort(),
      definitions: [
        definition({ id: 'low', priority: 30, completion: { kind: 'actionPerformed', action: 'jump' } }),
        definition({ id: 'high', priority: 90 }),
        definition({ id: 'mid', priority: 60, completion: { kind: 'actionPerformed', action: 'crouch' } }),
      ],
    });
    const events = record(system);

    system.fixedUpdate(DT);

    // One prompt on screen. The others wait in priority order rather than
    // appearing alongside it.
    expect(events.shown.map((p) => p.id)).toEqual(['high']);
    expect(system.activeTutorialId).toBe('high');
    expect(system.queuedIds).toEqual(['mid', 'low']);

    system.notifyActionPerformed('interact');
    system.fixedUpdate(DT);

    expect(system.activeTutorialId).toBe('mid');
    expect(system.queuedIds).toEqual(['low']);
  });

  it('breaks a priority tie with registry order', () => {
    const flags = new Set(['ctx.first', 'ctx.second']);
    const system = eagerSystem({
      context: flagContext(flags),
      settings: settingsPort(),
      definitions: [
        definition({ id: 'first', priority: 50 }),
        definition({ id: 'second', priority: 50, completion: { kind: 'actionPerformed', action: 'crouch' } }),
      ],
    });

    system.fixedUpdate(DT);

    // Authoring order is the tiebreak, so which prompt appears first is
    // deterministic rather than dependent on Map iteration.
    expect(system.activeTutorialId).toBe('first');
    expect(system.queuedIds).toEqual(['second']);
  });

  it('lets a higher-priority tutorial take the slot and returns the interrupted one to the queue', () => {
    const flags = new Set(['ctx.normal']);
    const system = eagerSystem({
      context: flagContext(flags),
      settings: settingsPort(),
      definitions: [
        definition({ id: 'normal', priority: 50 }),
        definition({
          id: 'urgent',
          priority: 99,
          completion: { kind: 'actionPerformed', action: 'crouch' },
        }),
      ],
    });
    const events = record(system);
    system.fixedUpdate(DT);
    expect(system.activeTutorialId).toBe('normal');

    flags.add('ctx.urgent');
    system.fixedUpdate(DT);

    expect(system.activeTutorialId).toBe('urgent');
    expect(events.hidden).toEqual([{ id: 'normal', reason: 'superseded' }]);
    // Interrupted, not learned: it goes back to the pool rather than being
    // marked complete.
    expect(system.queuedIds).toEqual(['normal']);
    expect(system.isCompleted('normal')).toBe(false);
  });

  it('drops lower-priority candidates while a blocking tutorial is visible', () => {
    const flags = new Set(['ctx.blocker', 'ctx.peer', 'ctx.quiet']);
    const system = eagerSystem({
      context: flagContext(flags),
      settings: settingsPort(),
      definitions: [
        definition({ id: 'blocker', priority: 94, blocksOthers: true }),
        definition({ id: 'peer', priority: 94, completion: { kind: 'actionPerformed', action: 'crouch' } }),
        definition({ id: 'quiet', priority: 50, completion: { kind: 'actionPerformed', action: 'jump' } }),
      ],
    });

    system.fixedUpdate(DT);

    expect(system.activeTutorialId).toBe('blocker');
    // Suppressed, not deferred: a stealth warning must not be followed by a
    // backlog of five stale hints. An equal-priority peer still waits.
    expect(system.queuedIds).toEqual(['peer']);

    system.notifyActionPerformed('interact');
    system.fixedUpdate(DT);

    expect(system.activeTutorialId).toBe('peer');
    // The suppressed one earns eligibility again once the blocker is gone.
    expect(system.queuedIds).toEqual(['quiet']);
  });

  it('marks a blocking tutorial exclusive so the HUD can clear the screen for it', () => {
    const flags = new Set(['ctx.blocker']);
    const system = eagerSystem({
      context: flagContext(flags),
      settings: settingsPort(),
      definitions: [definition({ id: 'blocker', priority: 94, blocksOthers: true })],
    });

    system.fixedUpdate(DT);

    expect(system.active?.exclusive).toBe(true);
    expect(system.active?.priority).toBe(94);
  });

  it('suppresses the whole registry behind the movement tutorial on a fresh start', () => {
    const system = eagerSystem({ context: controlHandoverContext(), settings: settingsPort() });

    system.fixedUpdate(DT);

    // `move` blocks others, so `look`, `tool-action` and the journal hint are
    // dropped rather than lining up behind it.
    expect(system.activeTutorialId).toBe('move');
    expect(system.queuedIds).toEqual([]);
  });
});

describe('TutorialSystem settings', () => {
  it('shows nothing while tutorials are switched off', () => {
    const settings = settingsPort({ tutorialsEnabled: false });
    const system = eagerSystem({ context: controlHandoverContext(), settings });
    const events = record(system);

    step(system, 3);

    expect(system.activeTutorialId).toBeNull();
    expect(system.queuedIds).toEqual([]);
    expect(events.shown).toHaveLength(0);

    settings.state.tutorialsEnabled = true;
    system.fixedUpdate(DT);

    // Read at scan time, so the toggle takes effect without a restart.
    expect(system.activeTutorialId).toBe('move');
  });

  it('hides a visible prompt when tutorials are switched off mid-prompt', () => {
    const settings = settingsPort();
    const system = eagerSystem({ context: controlHandoverContext(), settings });
    const events = record(system);
    system.fixedUpdate(DT);

    settings.state.tutorialsEnabled = false;
    system.fixedUpdate(DT);

    expect(events.hidden).toEqual([{ id: 'move', reason: 'disabled' }]);
    // Off means off: no completion is recorded for a prompt the player never
    // acted on, so turning tutorials back on still teaches it.
    expect(system.isCompleted('move')).toBe(false);
    expect(events.completed).toHaveLength(0);
  });

  it('keeps only high-priority tutorials when reduced tutorials is on', () => {
    const settings = settingsPort({ reducedTutorials: true });
    const flags = new Set(['ctx.gating', 'ctx.nicety']);
    const system = eagerSystem({
      context: flagContext(flags),
      settings,
      definitions: [
        definition({ id: 'gating', priority: REDUCED_TUTORIALS_MIN_PRIORITY }),
        definition({
          id: 'nicety',
          priority: REDUCED_TUTORIALS_MIN_PRIORITY - 1,
          completion: { kind: 'actionPerformed', action: 'crouch' },
        }),
      ],
    });
    const events = record(system);

    system.fixedUpdate(DT);

    // An experienced player still gets the mechanics that gate progress; they
    // do not get told what the journal button is.
    expect(system.activeTutorialId).toBe('gating');
    expect(system.queuedIds).toEqual([]);

    system.notifyActionPerformed('interact');
    step(system, 1);
    expect(system.activeTutorialId).toBeNull();
    expect(events.shown.map((p) => p.id)).toEqual(['gating']);

    settings.state.reducedTutorials = false;
    system.fixedUpdate(DT);

    expect(system.activeTutorialId).toBe('nicety');
  });
});

describe('TutorialSystem escalating assistance', () => {
  /** Thresholds stated in whole failures, so the arithmetic is visible. */
  const TWO_FAILURES = TUTORIAL_FAILED_ATTEMPT_WEIGHT_S * 2;
  const THREE_FAILURES = TUTORIAL_FAILED_ATTEMPT_WEIGHT_S * 3;

  function vaultSystem(flags: Set<string>): TutorialSystem {
    return eagerSystem({
      context: flagContext(flags),
      settings: settingsPort(),
      definitions: [
        definition({
          id: 'vault',
          cooldown: 1,
          completion: { kind: 'actionPerformed', action: 'jump' },
          escalation: { toStrongAfter: TWO_FAILURES, toHintAfter: THREE_FAILURES },
        }),
      ],
    });
  }

  it('advances through the three assistance levels as failures accumulate', () => {
    const system = vaultSystem(new Set(['ctx.vault']));
    const events = record(system);
    system.fixedUpdate(DT);
    expect(system.escalationLevel('vault')).toBe(1);

    system.notifyFailedAttempt();
    // One failure is not yet a pattern.
    expect(system.escalationLevel('vault')).toBe(1);
    expect(events.updated).toHaveLength(0);

    system.notifyFailedAttempt();
    expect(system.escalationLevel('vault')).toBe(2);

    system.notifyFailedAttempt();
    expect(system.escalationLevel('vault')).toBe(3);

    // Level 3 is a hint, not a solution, and there is nothing above it.
    system.notifyFailedAttempt();
    system.notifyFailedAttempt();
    expect(system.escalationLevel('vault')).toBe(3);
    expect(events.updated.map((p) => p.level)).toEqual([2, 3]);
  });

  it('ignores a failure reported against a different action', () => {
    const system = vaultSystem(new Set(['ctx.vault']));
    system.fixedUpdate(DT);

    system.notifyFailedAttempt('interact');
    system.notifyFailedAttempt('interact');
    system.notifyFailedAttempt('interact');

    // Fumbling an unrelated control is not evidence of struggling with vault.
    expect(system.escalationLevel('vault')).toBe(1);

    system.notifyFailedAttempt('jump');
    system.notifyFailedAttempt('jump');
    expect(system.escalationLevel('vault')).toBe(2);
  });

  it('escalates on time spent stuck as well as on failures', () => {
    const flags = new Set(['ctx.stuck']);
    const system = eagerSystem({
      context: flagContext(flags),
      settings: settingsPort(),
      definitions: [definition({ id: 'stuck' })],
    });
    const events = record(system);

    step(system, DEFAULT_ESCALATION_TIMING.toStrongAfter - 1);
    // Deliberately slow: escalating after three seconds reads as nagging.
    expect(system.escalationLevel('stuck')).toBe(1);

    step(system, 2);
    expect(system.escalationLevel('stuck')).toBe(2);

    step(system, DEFAULT_ESCALATION_TIMING.toHintAfter - DEFAULT_ESCALATION_TIMING.toStrongAfter);
    expect(system.escalationLevel('stuck')).toBe(3);
    expect(events.updated.map((p) => p.level)).toEqual([2, 3]);
  });

  it('keeps the struggle of an until-success tutorial across re-shows', () => {
    const flags = new Set(['ctx.vault']);
    const system = vaultSystem(flags);
    const events = record(system);
    system.fixedUpdate(DT);
    system.notifyFailedAttempt();
    system.notifyFailedAttempt();
    expect(system.escalationLevel('vault')).toBe(2);

    flags.delete('ctx.vault');
    system.fixedUpdate(DT);
    flags.add('ctx.vault');
    step(system, 1.5);

    // The player returning to the same ledge is still failing the same thing;
    // restarting escalation would make assistance unreachable.
    expect(events.shown).toHaveLength(2);
    expect(events.shown[1]?.level).toBe(2);
  });

  it('starts a contextual cue clean when it recurs later', () => {
    const flags = new Set(['ctx.detection']);
    const system = eagerSystem({
      context: flagContext(flags),
      settings: settingsPort(),
      definitions: [
        definition({
          id: 'detection',
          repeatPolicy: 'contextual',
          cooldown: 1,
          completion: { kind: 'flagSet', flag: 'detection.cleared' },
          escalation: { toStrongAfter: TWO_FAILURES, toHintAfter: THREE_FAILURES },
        }),
      ],
    });
    const events = record(system);
    system.fixedUpdate(DT);
    system.notifyFailedAttempt();
    system.notifyFailedAttempt();
    expect(system.escalationLevel('detection')).toBe(2);

    flags.delete('ctx.detection');
    system.fixedUpdate(DT);
    flags.add('ctx.detection');
    step(system, 1.5);

    // A cue that means the same thing an act later is not a continuing
    // failure, so it does not open at the assistance level it left off at.
    expect(events.shown).toHaveLength(2);
    expect(events.shown[1]?.level).toBe(1);
  });

  it('drops assistance back to level 1 after a successful attempt', () => {
    const system = vaultSystem(new Set(['ctx.vault']));
    system.fixedUpdate(DT);
    system.notifyFailedAttempt();
    system.notifyFailedAttempt();
    expect(system.escalationLevel('vault')).toBe(2);

    system.notifyActionPerformed('jump');

    expect(system.escalationLevel('vault')).toBe(1);
  });

  it('ignores a failure report when nothing is on screen', () => {
    const system = vaultSystem(new Set());

    step(system, 1);
    expect(() => system.notifyFailedAttempt()).not.toThrow();

    expect(system.escalationLevel('vault')).toBe(1);
  });
});

describe('TutorialSystem persistence', () => {
  it('preserves completion across a reload', () => {
    const persistence = createMemoryTutorialPersistence();
    const first = eagerSystem({
      context: controlHandoverContext(),
      settings: settingsPort(),
      persistence,
    });
    first.fixedUpdate(DT);
    first.notifyActionPerformed('moveY');
    expect(persistence.state?.completedIds).toEqual(['move']);

    const second = eagerSystem({
      context: controlHandoverContext(),
      settings: settingsPort(),
      persistence,
    });
    const events = record(second);
    step(second, 2);

    expect(second.isCompleted('move')).toBe(true);
    expect(events.shown.map((p) => p.id)).not.toContain('move');
    // The next unlearned mechanic takes the slot instead.
    expect(second.activeTutorialId).toBe('look');
  });

  it('round-trips through an explicit snapshot', () => {
    const source = eagerSystem({ context: controlHandoverContext(), settings: settingsPort() });
    source.fixedUpdate(DT);
    source.notifyActionPerformed('moveY');

    const target = eagerSystem({ context: controlHandoverContext(), settings: settingsPort() });
    target.loadFrom(source.snapshot());

    expect(target.completedIds).toEqual(['move']);
    expect(target.snapshot()).toEqual(source.snapshot());
  });

  it('clears the visible prompt when a different save is loaded', () => {
    const system = eagerSystem({ context: controlHandoverContext(), settings: settingsPort() });
    const events = record(system);
    system.fixedUpdate(DT);
    expect(system.activeTutorialId).toBe('move');

    system.loadFrom({ completedIds: ['move'], resetVersion: TUTORIAL_RESET_VERSION });

    // The prompt belonged to the old session.
    expect(events.hidden).toEqual([{ id: 'move', reason: 'reset' }]);
    expect(system.activeTutorialId).toBeNull();
    expect(system.queuedIds).toEqual([]);
  });

  it('drops stored ids for tutorials that no longer exist', () => {
    const persistence = createMemoryTutorialPersistence({
      completedIds: ['move', 'aim-down-sights'],
      resetVersion: TUTORIAL_RESET_VERSION,
    });
    const system = eagerSystem({
      context: controlHandoverContext(),
      settings: settingsPort(),
      persistence,
    });

    // A removed mechanic's id must not be carried forward forever.
    expect(system.completedIds).toEqual(['move']);
  });

  it('re-arms everything when stored completions predate the current tutorial content', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const persistence = createMemoryTutorialPersistence({
      completedIds: ['move', 'look'],
      resetVersion: TUTORIAL_RESET_VERSION - 1,
    });

    const system = eagerSystem({
      context: controlHandoverContext(),
      settings: settingsPort(),
      persistence,
    });

    // A prompt completed against the old control scheme would otherwise stay
    // hidden while teaching nothing.
    expect(system.isCompleted('move')).toBe(false);
    expect(system.completedIds).toEqual([]);
    expect(persistence.state).toEqual({ completedIds: [], resetVersion: TUTORIAL_RESET_VERSION });
    expect(info).toHaveBeenCalled();
    info.mockRestore();
  });

  it('works with no persistence port at all', () => {
    const system = eagerSystem({ context: controlHandoverContext(), settings: settingsPort() });

    system.fixedUpdate(DT);
    system.notifyActionPerformed('moveY');

    expect(system.isCompleted('move')).toBe(true);
    expect(() => system.resetAll()).not.toThrow();
  });
});

describe('TutorialSystem reset', () => {
  it('makes a completed tutorial eligible again', () => {
    const system = eagerSystem({ context: controlHandoverContext(), settings: settingsPort() });
    const events = record(system);
    system.fixedUpdate(DT);
    system.notifyActionPerformed('moveY');
    expect(system.isCompleted('move')).toBe(true);

    system.resetAll();
    step(system, 1);

    expect(events.reset).toEqual([
      { clearedIds: ['move'], resetVersion: TUTORIAL_RESET_VERSION },
    ]);
    expect(system.isCompleted('move')).toBe(false);
    expect(events.shown.map((p) => p.id)).toEqual(['move', 'move']);
    expect(system.activeTutorialId).toBe('move');
  });

  it('leaves campaign progress untouched', () => {
    const campaign = {
      flags: new Set(['machine.first-alert', 'dialogue.choice-offered']),
      activeObjective: 'prologue.cross-service-bridge' as string | null,
      completedObjectives: new Set(['prologue.check-clinic-power']),
    };
    const before = {
      flags: [...campaign.flags],
      activeObjective: campaign.activeObjective,
      completedObjectives: [...campaign.completedObjectives],
    };
    const persistence = createMemoryTutorialPersistence();
    const system = eagerSystem({
      context: createInertTutorialContext({
        isFlagSet: (flag) => campaign.flags.has(flag),
        isObjectiveActive: (id) => campaign.activeObjective === id,
        isObjectiveComplete: (id) => campaign.completedObjectives.has(id),
      }),
      settings: settingsPort(),
      persistence,
      definitions: [
        definition({
          id: 'sprint',
          trigger: { kind: 'objectiveActive', objectiveId: 'prologue.cross-service-bridge' },
          completion: { kind: 'actionPerformed', action: 'sprint' },
        }),
      ],
    });
    system.fixedUpdate(DT);
    system.notifyActionPerformed('sprint');

    system.resetAll();

    // The system's only view of missions and flags is a read-only context, so
    // there is no code path from Reset Tutorials to a campaign flag.
    expect([...campaign.flags]).toEqual(before.flags);
    expect(campaign.activeObjective).toBe(before.activeObjective);
    expect([...campaign.completedObjectives]).toEqual(before.completedObjectives);
    // And the only thing it writes is its own slice of the save.
    expect(Object.keys(persistence.state ?? {}).sort()).toEqual(['completedIds', 'resetVersion']);
    expect(persistence.state?.completedIds).toEqual([]);
  });

  it('clears the visible prompt and the queue', () => {
    const flags = new Set(['ctx.high', 'ctx.low']);
    const system = eagerSystem({
      context: flagContext(flags),
      settings: settingsPort(),
      definitions: [
        definition({ id: 'high', priority: 90 }),
        definition({ id: 'low', priority: 20, completion: { kind: 'actionPerformed', action: 'jump' } }),
      ],
    });
    const events = record(system);
    system.fixedUpdate(DT);
    expect(system.queuedIds).toEqual(['low']);

    system.resetAll();

    expect(events.hidden).toEqual([{ id: 'high', reason: 'reset' }]);
    expect(system.activeTutorialId).toBeNull();
    expect(system.queuedIds).toEqual([]);
  });

  it('resets escalation along with completion', () => {
    const flags = new Set(['ctx.stuck']);
    const system = eagerSystem({
      context: flagContext(flags),
      settings: settingsPort(),
      definitions: [
        definition({
          id: 'stuck',
          escalation: {
            toStrongAfter: TUTORIAL_FAILED_ATTEMPT_WEIGHT_S,
            toHintAfter: TUTORIAL_FAILED_ATTEMPT_WEIGHT_S * 3,
          },
        }),
      ],
    });
    system.fixedUpdate(DT);
    system.notifyFailedAttempt();
    expect(system.escalationLevel('stuck')).toBe(2);

    system.resetAll();
    system.fixedUpdate(DT);

    // A player who reset tutorials is asking to be taught from scratch, not to
    // be handed the hint immediately.
    expect(system.escalationLevel('stuck')).toBe(1);
  });
});

describe('TutorialSystem input family', () => {
  it('exposes the active family so the HUD can pick its prompt vocabulary', () => {
    const system = eagerSystem({
      context: controlHandoverContext(),
      settings: settingsPort(),
      inputFamily: 'keyboard',
    });
    const events = record(system);
    system.fixedUpdate(DT);
    expect(system.inputFamily).toBe('keyboard');
    expect(system.active?.family).toBe('keyboard');

    system.setInputFamily('touch');

    // The player just picked up a phone: a visible prompt must swap vocabulary
    // immediately rather than waiting for the next scan.
    expect(system.inputFamily).toBe('touch');
    expect(system.active?.family).toBe('touch');
    expect(events.updated).toHaveLength(1);
    expect(events.updated[0]?.family).toBe('touch');
    expect(events.updated[0]?.id).toBe('move');
  });

  it('does not re-emit when the family is set to what it already is', () => {
    const system = eagerSystem({
      context: controlHandoverContext(),
      settings: settingsPort(),
      inputFamily: 'gamepad',
    });
    const events = record(system);
    system.fixedUpdate(DT);

    system.setInputFamily('gamepad');

    expect(events.updated).toHaveLength(0);
  });

  it('records a family change with no prompt on screen', () => {
    const system = eagerSystem({
      context: createInertTutorialContext(),
      settings: settingsPort(),
    });
    const events = record(system);

    system.setInputFamily('gamepad');
    system.fixedUpdate(DT);

    expect(system.inputFamily).toBe('gamepad');
    // Nothing to update, so nothing is emitted — but a prompt that appears
    // later must already be in the right vocabulary.
    expect(events.updated).toHaveLength(0);
  });

  it('names a real bindable action so a touch HUD can highlight the actual control', () => {
    const system = eagerSystem({
      context: createInertTutorialContext({
        isActionAvailable: (action) => action === 'interact',
        focusedInteractableKind: () => 'valve',
      }),
      settings: settingsPort(),
      definitions: [getTutorial('interact')!],
      inputFamily: 'touch',
    });

    system.fixedUpdate(DT);
    const presentation = system.active;

    // The prompt carries an action, never a key string, so the touch layer can
    // find the on-screen button that performs it and pulse that (spec 86.4).
    expect(presentation?.action).toBe('interact');
    expect(isButtonAction(presentation!.action!)).toBe(true);
    expect(presentation?.messageKey).toBe('tutorial.interact');
  });

  it('falls back to the completion action when no action is declared', () => {
    const flags = new Set(['ctx.crouch']);
    const system = eagerSystem({
      context: flagContext(flags),
      settings: settingsPort(),
      definitions: [
        definition({ id: 'crouch', completion: { kind: 'actionPerformed', action: 'crouch' } }),
      ],
    });

    system.fixedUpdate(DT);

    // A definition does not have to repeat itself when the thing being taught
    // is the thing being measured.
    expect(system.active?.action).toBe('crouch');
  });

  it('carries no action for a prompt with nothing to perform', () => {
    const flags = new Set(['ctx.autosave']);
    const system = eagerSystem({
      context: flagContext(flags),
      settings: settingsPort(),
      definitions: [
        definition({
          id: 'autosave',
          repeatPolicy: 'once',
          completion: { kind: 'elapsed', seconds: 6 },
        }),
      ],
    });

    system.fixedUpdate(DT);

    expect(system.activeTutorialId).toBe('autosave');
    expect(system.active?.action).toBeUndefined();
  });
});

describe('TutorialSystem lifecycle', () => {
  it('advances its clock on the fixed step, not wall time', () => {
    const system = eagerSystem({
      context: createInertTutorialContext(),
      settings: settingsPort(),
    });

    step(system, 2, 0.02);

    // Cooldowns and escalation therefore pause with the game and are
    // reproducible in tests.
    expect(system.elapsed).toBeCloseTo(2);
  });

  it('throws on a duplicate tutorial id', () => {
    // Two definitions with one id would make completion ambiguous and leave
    // the second unreachable.
    expect(
      () =>
        new TutorialSystem({
          context: createInertTutorialContext(),
          settings: settingsPort(),
          definitions: [definition({ id: 'move' }), definition({ id: 'move' })],
        }),
    ).toThrow(/Duplicate tutorial id/);
  });

  it('drops its listeners and its prompt on dispose', () => {
    const system = eagerSystem({ context: controlHandoverContext(), settings: settingsPort() });
    const events = record(system);
    system.fixedUpdate(DT);

    system.dispose();
    expect(system.activeTutorialId).toBeNull();

    step(system, 2);

    // Dispose does not stop the loop — it releases the subscriptions, so a HUD
    // torn down with the world cannot be driven by a stale system.
    expect(events.shown).toHaveLength(1);
    expect(events.hidden).toHaveLength(0);
  });

  it('reports an unknown id as neither completed nor escalated', () => {
    const system = eagerSystem({
      context: createInertTutorialContext(),
      settings: settingsPort(),
    });

    expect(system.isCompleted('no-such-tutorial')).toBe(false);
    expect(system.escalationLevel('no-such-tutorial')).toBe(1);
  });
});

describe('tutorial registry', () => {
  it('has no structural issues', () => {
    // Catches the design rules that are easy to break by accident: a
    // progress-gating tutorial measured by a timer, a recurring cue with no
    // cooldown, an unreachable priority.
    expect(validateTutorials()).toEqual([]);
  });

  it('reports an until-success tutorial that cannot prove success', () => {
    const issues = validateTutorials([
      definition({ id: 'vault', completion: { kind: 'elapsed', seconds: 6 } }),
    ]);

    expect(issues.map((issue) => issue.problem)).toEqual([
      expect.stringContaining('until-success requires an actionPerformed completion'),
    ]);
  });

  it('reports a timer used to dismiss a tutorial that teaches an action', () => {
    const issues = validateTutorials([
      definition({
        id: 'vault',
        repeatPolicy: 'once',
        inputAction: 'jump',
        completion: { kind: 'elapsed', seconds: 6 },
      }),
    ]);

    // A timer dismisses the prompt whether or not the player understood it,
    // which produces the exact failure this system exists to avoid.
    expect(issues).toEqual([
      {
        id: 'vault',
        problem: 'elapsed completion on a tutorial that teaches an action; measure the action',
      },
    ]);
  });

  it('reports a contextual cue with no cooldown', () => {
    const issues = validateTutorials([
      definition({
        id: 'detection',
        repeatPolicy: 'contextual',
        completion: { kind: 'flagSet', flag: 'detection.cleared' },
      }),
    ]);

    expect(issues).toEqual([
      { id: 'detection', problem: 'contextual tutorials need a cooldown or they spam' },
    ]);
  });
});
