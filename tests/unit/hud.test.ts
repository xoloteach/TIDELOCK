/**
 * HUD tests.
 *
 * Three behaviours here are project rejection conditions rather than nice-to-
 * haves, and they get the most attention:
 *
 *   1. A touch device must never be shown a keyboard key name. The keyboard and
 *      touch prompts are separate render paths and the tests assert the key cue
 *      is emptied, not merely hidden, when the touch path runs.
 *   2. `cinematic` must hide every HUD group. A composed shot with an objective
 *      card floating in the corner is the failure this guards.
 *   3. Text is only written when it changed. Asserted with a real spy installed
 *      over the node's `textContent` setter, not by reading the value back —
 *      reading back cannot tell an unchanged write from no write at all.
 *
 * The HUD is a sink, so every test drives it through its public setters and
 * asserts on the DOM it produced.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  Hud,
  type HudContext,
  type HudGroup,
  type HudInteractionPrompt,
} from '../../src/ui/Hud';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let host: HTMLElement;
let hud: Hud;

function query(selector: string): HTMLElement {
  const found = hud.element.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`missing HUD node: ${selector}`);
  return found;
}

/**
 * Installs a counting setter over one node's `textContent`.
 *
 * jsdom defines `textContent` as an accessor on `Node.prototype`; an own
 * property on the instance shadows it, so the spy sees every write the HUD
 * makes to that specific node and nothing else.
 */
const TEXT_CONTENT_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  Node.prototype,
  'textContent',
);

function trackTextWrites(node: Node): {
  spy: ReturnType<typeof vi.fn<(value: string) => void>>;
  restore: () => void;
} {
  const getter = TEXT_CONTENT_DESCRIPTOR?.get;
  const setter = TEXT_CONTENT_DESCRIPTOR?.set;
  if (!getter || !setter) {
    throw new Error('textContent is not an accessor in this environment');
  }

  const spy = vi.fn<(value: string) => void>();
  Object.defineProperty(node, 'textContent', {
    configurable: true,
    get: () => getter.call(node) as string,
    set: (value: string) => {
      spy(value);
      setter.call(node, value);
    },
  });

  return { spy, restore: () => void Reflect.deleteProperty(node, 'textContent') };
}

const KEYBOARD_PROMPT: HudInteractionPrompt = {
  verb: 'turn',
  label: 'Valve V-12',
  holdDuration: 1.5,
  input: { family: 'keyboard', keyLabel: 'E' },
};

/**
 * A key label chosen so it cannot collide with any verb or object name the
 * touch prompt renders. If 'F13' shows up in the touch prompt's text, the key
 * path leaked.
 */
const DISTINCTIVE_KEY = 'F13';

const TOUCH_PROMPT: HudInteractionPrompt = {
  verb: 'turn',
  label: 'Valve V-12',
  holdDuration: 1.5,
  input: { family: 'touch', controlId: 'interact', controlLabel: 'ACT' },
};

/** Puts every group in a state where it has something to say. */
function populateAllGroups(): void {
  hud.setObjective('Restore power to Pump Station 12');
  hud.setInteractionPrompt(KEYBOARD_PROMPT);
  hud.setToolStatus({ tool: 'Multimeter', state: 'ready' });
  hud.setHealth({ current: 60, max: 100 });
}

const ALL_GROUPS: readonly HudGroup[] = ['objective', 'prompt', 'tool', 'health'];

function visibleGroups(): HudGroup[] {
  return ALL_GROUPS.filter((group) => hud.isGroupVisible(group));
}

/** Replaces the shared HUD with one built from different options. */
function recreate(options: ConstructorParameters<typeof Hud>[1]): void {
  hud.dispose();
  hud = new Hud(host, options);
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  hud = new Hud(host);
});

afterEach(() => {
  hud.dispose();
  host.remove();
});

// ---------------------------------------------------------------------------

describe('Hud construction', () => {
  it('attaches a passthrough root to the host', () => {
    expect(hud.element.parentElement).toBe(host);
    // base.css uses this class to keep the layer from eating taps.
    expect(hud.element.classList.contains('layer-passthrough')).toBe(true);
  });

  it('starts in exploration with nothing to show', () => {
    expect(hud.context).toBe('exploration');
    expect(visibleGroups()).toEqual([]);
  });

  it('accepts a starting context', () => {
    recreate({ context: 'cinematic' });
    expect(hud.context).toBe('cinematic');
  });
});

describe('Hud objective card', () => {
  it('reveals on a new objective and prints kicker plus text', () => {
    hud.setObjective('Cross the service bridge');

    expect(hud.isGroupVisible('objective')).toBe(true);
    expect(hud.isObjectiveRevealed).toBe(true);
    expect(query('.hud__objective-kicker').textContent).toBe('Objective');
    expect(query('.hud__objective-text').textContent).toBe('Cross the service bridge');
  });

  it('accepts a custom kicker', () => {
    hud.setObjective('Find the depot generator log', 'Optional');
    expect(query('.hud__objective-kicker').textContent).toBe('Optional');
  });

  it('fades back after the hold window elapses', () => {
    recreate({ objectiveHoldSeconds: 2 });
    hud.setObjective('Restart Pump Cluster B');

    hud.tick(1.5);
    expect(hud.isGroupVisible('objective')).toBe(true);

    hud.tick(0.6);
    expect(hud.isObjectiveRevealed).toBe(false);
    expect(hud.isGroupVisible('objective')).toBe(false);
    // The text survives the fade; only the card's visibility changed.
    expect(hud.objectiveLabel).toBe('Restart Pump Cluster B');
  });

  it('does not re-reveal when the same objective is set again', () => {
    recreate({ objectiveHoldSeconds: 2 });
    hud.setObjective('Restart Pump Cluster B');
    hud.tick(3);
    expect(hud.isGroupVisible('objective')).toBe(false);

    // A save load or a mission system pushing state every step must not flash
    // the card again.
    hud.setObjective('Restart Pump Cluster B');

    expect(hud.isGroupVisible('objective')).toBe(false);
  });

  it('re-reveals on an explicit request', () => {
    recreate({ objectiveHoldSeconds: 2 });
    hud.setObjective('Restart Pump Cluster B');
    hud.tick(3);

    hud.revealObjective();

    expect(hud.isGroupVisible('objective')).toBe(true);
  });

  it('clears on null', () => {
    hud.setObjective('Restart Pump Cluster B');
    hud.setObjective(null);

    expect(hud.objectiveLabel).toBeNull();
    expect(hud.isGroupVisible('objective')).toBe(false);
    expect(query('.hud__objective-text').textContent).toBe('');
  });

  it('is an aria-live region so the change is announced', () => {
    expect(query('.hud__objective').getAttribute('aria-live')).toBe('polite');
    expect(query('.hud__objective').getAttribute('role')).toBe('status');
  });
});

describe('Hud context switching', () => {
  beforeEach(() => {
    populateAllGroups();
  });

  it('shows every group during exploration', () => {
    expect(visibleGroups()).toEqual(['objective', 'prompt', 'tool', 'health']);
  });

  it('drops the objective card during a sustained interaction', () => {
    hud.setContext('interaction');
    expect(visibleGroups()).toEqual(['prompt', 'tool', 'health']);
  });

  it('keeps only condition during dialogue', () => {
    hud.setContext('dialogue');
    // A conversation held while something is closing in still shows the thing
    // that can kill you; nothing else earns screen space.
    expect(visibleGroups()).toEqual(['health']);
  });

  it('hides everything during a cinematic', () => {
    hud.setContext('cinematic');
    expect(visibleGroups()).toEqual([]);
  });

  it('hides everything in a menu', () => {
    hud.setContext('menu');
    expect(visibleGroups()).toEqual([]);
  });

  it('restores the conditional groups on return to exploration', () => {
    hud.setContext('cinematic');
    hud.setContext('exploration');

    // The prompt, tool and condition come back because they still have state.
    // The objective card does not: its reveal was cancelled by the cutscene
    // rather than parked, so a stale card cannot reappear afterwards.
    expect(visibleGroups()).toEqual(['prompt', 'tool', 'health']);
    expect(hud.objectiveLabel).toBe('Restore power to Pump Station 12');
  });

  it('records the context on the root for CSS', () => {
    hud.setContext('dialogue');
    expect(hud.element.dataset.context).toBe('dialogue');
  });

  it('ignores a repeated context', () => {
    hud.setContext('dialogue');
    const before = visibleGroups();
    hud.setContext('dialogue');
    expect(visibleGroups()).toEqual(before);
  });

  it('never shows a group that has nothing to say', () => {
    const empty = new Hud(host);
    const contexts: HudContext[] = [
      'exploration',
      'interaction',
      'dialogue',
      'cinematic',
      'menu',
    ];

    for (const context of contexts) {
      empty.setContext(context);
      for (const group of ALL_GROUPS) {
        expect(empty.isGroupVisible(group)).toBe(false);
      }
    }

    empty.dispose();
  });
});

describe('Hud interaction prompt', () => {
  it('renders the key name on the keyboard path', () => {
    hud.setInteractionPrompt(KEYBOARD_PROMPT);

    expect(query('.hud__prompt-key').hidden).toBe(false);
    expect(query('.hud__prompt-key-text').textContent).toBe('E');
    expect(query('.hud__prompt-verb').textContent).toBe('Turn');
    expect(query('.hud__prompt-label').textContent).toBe('Valve V-12');
    expect(query('.hud__prompt-touch').hidden).toBe(true);
    expect(hud.element.querySelector('.hud__prompt')?.getAttribute('data-family')).toBe(
      'keyboard',
    );
  });

  it('renders a glyph name on the gamepad path', () => {
    hud.setInteractionPrompt({
      ...KEYBOARD_PROMPT,
      input: { family: 'gamepad', glyph: 'A' },
    });

    expect(query('.hud__prompt-key-text').textContent).toBe('A');
    expect(query('.hud__prompt-key').classList.contains('hud__prompt-key--gamepad')).toBe(
      true,
    );
  });

  it('uses the highlight path on touch and prints no key', () => {
    hud.setInteractionPrompt(TOUCH_PROMPT);

    expect(query('.hud__prompt-touch').hidden).toBe(false);
    expect(query('.hud__prompt-touch-text').textContent).toBe('ACT');
    // The key cue is emptied, not just hidden: hidden-but-populated is one CSS
    // mistake away from "Press E" on a phone.
    expect(query('.hud__prompt-key').hidden).toBe(true);
    expect(query('.hud__prompt-key-text').textContent).toBe('');
    expect(hud.touchHighlight).toBe('interact');
  });

  it('leaves no keyboard key behind when the device changes mid-target', () => {
    hud.setInteractionPrompt({
      ...KEYBOARD_PROMPT,
      input: { family: 'keyboard', keyLabel: DISTINCTIVE_KEY },
    });
    expect(query('.hud__prompt').textContent).toContain(DISTINCTIVE_KEY);

    hud.setInteractionPrompt(TOUCH_PROMPT);

    expect(query('.hud__prompt').textContent).not.toContain(DISTINCTIVE_KEY);
  });

  it('publishes the touch highlight on change only', () => {
    const highlighted = vi.fn();
    hud.on('touch-highlight', highlighted);

    hud.setInteractionPrompt(TOUCH_PROMPT);
    expect(highlighted).toHaveBeenCalledTimes(1);
    expect(highlighted.mock.calls[0][0]).toEqual({
      controlId: 'interact',
      verb: 'turn',
      label: 'Valve V-12',
    });

    // Same control, same prompt: the touch layer does not need telling twice.
    hud.setInteractionPrompt(TOUCH_PROMPT);
    expect(highlighted).toHaveBeenCalledTimes(1);
  });

  it('clears the touch highlight when a cinematic hides the prompt', () => {
    const highlighted = vi.fn();
    hud.setInteractionPrompt(TOUCH_PROMPT);
    hud.on('touch-highlight', highlighted);

    hud.setContext('cinematic');

    // Otherwise a touch button keeps glowing over a composed shot.
    expect(hud.touchHighlight).toBeNull();
    expect(highlighted).toHaveBeenCalledWith({ controlId: null, verb: null, label: '' });
  });

  it('emits no touch highlight for a keyboard prompt', () => {
    const highlighted = vi.fn();
    hud.on('touch-highlight', highlighted);

    hud.setInteractionPrompt(KEYBOARD_PROMPT);

    expect(hud.touchHighlight).toBeNull();
    expect(highlighted).not.toHaveBeenCalled();
  });

  it('hides the hold indicator for an instant interaction', () => {
    hud.setInteractionPrompt({
      verb: 'take',
      label: 'Spare Battery',
      holdDuration: 0,
      input: { family: 'keyboard', keyLabel: 'E' },
    });

    expect(query('.hud__prompt-hold').hidden).toBe(true);
  });

  it('shows the hold indicator when the interaction must be held', () => {
    hud.setInteractionPrompt(KEYBOARD_PROMPT);

    const hold = query('.hud__prompt-hold');
    expect(hold.hidden).toBe(false);
    expect(hold.getAttribute('role')).toBe('progressbar');
    expect(hold.getAttribute('aria-valuenow')).toBe('0');
  });

  it('clears everything on null', () => {
    hud.setInteractionPrompt(TOUCH_PROMPT);
    hud.setInteractionPrompt(null);

    expect(hud.isGroupVisible('prompt')).toBe(false);
    expect(query('.hud__prompt-verb').textContent).toBe('');
    expect(query('.hud__prompt-label').textContent).toBe('');
    expect(query('.hud__prompt-touch-text').textContent).toBe('');
    expect(hud.touchHighlight).toBeNull();
  });
});

describe('Hud hold progress', () => {
  beforeEach(() => {
    hud.setInteractionPrompt(KEYBOARD_PROMPT);
  });

  it('advances the fill and the aria value', () => {
    hud.setHoldProgress(0.5);

    expect(query('.hud__prompt-hold-fill').style.width).toBe('50%');
    expect(query('.hud__prompt-hold').getAttribute('aria-valuenow')).toBe('50');
    expect(hud.holdProgressValue).toBe(0.5);
  });

  it('clamps out-of-range values', () => {
    hud.setHoldProgress(4);
    expect(query('.hud__prompt-hold-fill').style.width).toBe('100%');

    hud.setHoldProgress(-2);
    expect(query('.hud__prompt-hold-fill').style.width).toBe('0%');
  });

  it('does not rewrite the aria value for a sub-percent change', () => {
    hud.setHoldProgress(0.5);
    const setAttribute = vi.spyOn(query('.hud__prompt-hold'), 'setAttribute');

    hud.setHoldProgress(0.501);

    // Hold progress advances by a fraction of a percent per frame; announcing
    // that to a screen reader sixty times a second is noise, not information.
    expect(setAttribute).not.toHaveBeenCalled();
    expect(query('.hud__prompt-hold-fill').style.width).toBe('50%');
  });

  it('is ignored for an instant interaction', () => {
    hud.setInteractionPrompt({
      verb: 'take',
      label: 'Spare Battery',
      holdDuration: 0,
      input: { family: 'keyboard', keyLabel: 'E' },
    });

    hud.setHoldProgress(0.8);

    expect(hud.holdProgressValue).toBe(0);
    expect(query('.hud__prompt-hold-fill').style.width).toBe('0%');
  });

  it('resets when a new prompt carries no progress', () => {
    hud.setHoldProgress(0.7);
    hud.setInteractionPrompt({ ...KEYBOARD_PROMPT, label: 'Valve V-13' });

    expect(query('.hud__prompt-hold-fill').style.width).toBe('0%');
  });

  it('accepts progress supplied with the prompt', () => {
    hud.setInteractionPrompt({ ...KEYBOARD_PROMPT, holdProgress: 0.25 });
    expect(query('.hud__prompt-hold-fill').style.width).toBe('25%');
  });
});

describe('Hud readouts', () => {
  it('prints the tool, its state and any detail', () => {
    hud.setToolStatus({ tool: 'Multimeter', state: 'busy', detail: 'breaker 4B' });

    expect(query('.hud__tool-name').textContent).toBe('Multimeter');
    expect(query('.hud__tool-state').textContent).toBe('busy');
    expect(query('.hud__tool-detail').textContent).toBe('breaker 4B');
    expect(query('.hud__status').dataset.toolState).toBe('busy');
    expect(hud.isGroupVisible('tool')).toBe(true);
  });

  it('shows the recovery row only when there is recovery state', () => {
    expect(query('.hud__recovery').hidden).toBe(true);

    hud.setRecoveryStatus({
      label: 'Pump Cluster B',
      value: '2 / 4 online',
      state: 'working',
    });

    expect(query('.hud__recovery').hidden).toBe(false);
    expect(query('.hud__recovery-value').textContent).toBe('2 / 4 online');
    expect(query('.hud__recovery').dataset.state).toBe('working');
    // Recovery alone is enough to justify the rail.
    expect(hud.isGroupVisible('tool')).toBe(true);
  });

  it('hides the rail when both readouts are cleared', () => {
    hud.setToolStatus({ tool: 'Multimeter', state: 'ready' });
    hud.setRecoveryStatus({ label: 'Pump Cluster B', value: 'offline', state: 'fault' });

    hud.setToolStatus(null);
    hud.setRecoveryStatus(null);

    expect(hud.isGroupVisible('tool')).toBe(false);
  });

  it('hides condition at full health', () => {
    hud.setHealth({ current: 100, max: 100 });

    // A permanent health bar promises a combat game this campaign is not.
    expect(hud.isGroupVisible('health')).toBe(false);
  });

  it('shows condition below full, quietly', () => {
    hud.setHealth({ current: 80, max: 100 });

    expect(hud.isGroupVisible('health')).toBe(true);
    expect(query('.hud__health-value').textContent).toBe('80%');
    expect(query('.hud__health-fill').style.width).toBe('80%');
    expect(query('.hud__health').classList.contains('hud__health--critical')).toBe(false);
    expect(query('.hud__health').getAttribute('aria-live')).toBe('off');
  });

  it('becomes prominent and announced when it matters', () => {
    hud.setHealth({ current: 20, max: 100 });

    expect(query('.hud__health').classList.contains('hud__health--critical')).toBe(true);
    expect(query('.hud__health').getAttribute('aria-live')).toBe('polite');
  });

  it('honours a custom critical threshold', () => {
    const strict = new Hud(host, { criticalHealthRatio: 0.75 });
    strict.setHealth({ current: 70, max: 100 });

    const node = strict.element.querySelector('.hud__health');
    expect(node?.classList.contains('hud__health--critical')).toBe(true);
    strict.dispose();
  });

  it('survives a zero maximum without dividing by it', () => {
    hud.setHealth({ current: 0, max: 0 });

    expect(hud.isGroupVisible('health')).toBe(false);
    expect(query('.hud__health-value').textContent).toBe('');
  });
});

describe('Hud change-gated writes', () => {
  it('does not rewrite the objective when it is unchanged', () => {
    hud.setObjective('Restore power to Pump Station 12');
    const { spy, restore } = trackTextWrites(query('.hud__objective-text'));

    hud.setObjective('Restore power to Pump Station 12');
    expect(spy).not.toHaveBeenCalled();

    hud.setObjective('Cross the service bridge');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('Cross the service bridge');

    restore();
  });

  it('does not rewrite the prompt label when re-targeting the same object', () => {
    hud.setInteractionPrompt(KEYBOARD_PROMPT);
    const { spy, restore } = trackTextWrites(query('.hud__prompt-label'));

    // The interaction system re-emits a target whenever the verb changes; the
    // label often stays the same and must not be rewritten sixty times a
    // second while the player stands in front of the valve.
    hud.setInteractionPrompt({ ...KEYBOARD_PROMPT, verb: 'inspect' });

    expect(spy).not.toHaveBeenCalled();
    expect(query('.hud__prompt-verb').textContent).toBe('Inspect');

    restore();
  });

  it('does not rewrite condition text for an unchanged reading', () => {
    hud.setHealth({ current: 60, max: 100 });
    const { spy, restore } = trackTextWrites(query('.hud__health-value'));

    // Called from the render loop, so this is the frame-rate-sensitive case.
    hud.setHealth({ current: 60, max: 100 });
    hud.setHealth({ current: 60.2, max: 100 });

    expect(spy).not.toHaveBeenCalled();

    hud.setHealth({ current: 45, max: 100 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('45%');

    restore();
  });

  it('does not rewrite the tool readout when the state repeats', () => {
    hud.setToolStatus({ tool: 'Multimeter', state: 'ready' });
    const { spy, restore } = trackTextWrites(query('.hud__tool-state'));

    hud.setToolStatus({ tool: 'Multimeter', state: 'ready' });
    expect(spy).not.toHaveBeenCalled();

    hud.setToolStatus({ tool: 'Multimeter', state: 'fault' });
    expect(spy).toHaveBeenCalledTimes(1);

    restore();
  });
});

describe('Hud lifecycle', () => {
  it('reset clears every readout', () => {
    populateAllGroups();
    hud.setRecoveryStatus({ label: 'Pump Cluster B', value: 'offline', state: 'fault' });

    hud.reset();

    expect(visibleGroups()).toEqual([]);
    expect(hud.objectiveLabel).toBeNull();
    expect(hud.touchHighlight).toBeNull();
    expect(query('.hud__health').classList.contains('hud__health--critical')).toBe(false);
  });

  it('dispose detaches the root and stops emitting', () => {
    const highlighted = vi.fn();
    hud.on('touch-highlight', highlighted);
    const root = hud.element;

    hud.dispose();

    expect(root.parentElement).toBeNull();
    hud.setInteractionPrompt(TOUCH_PROMPT);
    expect(highlighted).not.toHaveBeenCalled();
  });

  it('ignores a non-advancing tick', () => {
    recreate({ objectiveHoldSeconds: 1 });
    hud.setObjective('Restart Pump Cluster B');

    hud.tick(0);
    hud.tick(Number.NaN);
    hud.tick(-5);

    expect(hud.isGroupVisible('objective')).toBe(true);
  });
});
