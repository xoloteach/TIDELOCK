/**
 * Input state tests.
 *
 * The two things that break gameplay silently are edge detection and source
 * mixing: an `interact` that reports pressed every frame turns one door into
 * a strobe, and an idle keyboard that overwrites a live stick makes a
 * controller feel broken. Both are driven here at step granularity with a
 * fixed dt, never real timing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InputState } from '../../src/engine/input/InputState';
import {
  ACTION_DISPLAY_NAMES,
  AXIS_ACTIONS,
  BUTTON_ACTIONS,
  GAME_ACTIONS,
  INPUT_FAMILIES,
  actionDisplayName,
  isAxisAction,
  isButtonAction,
  isGameAction,
  type ButtonAction,
  type GameAction,
} from '../../src/engine/input/actions';

/** The project's fixed simulation step. */
const STEP = 1 / 60;

/** What gameplay would observe for one action inside a single step. */
interface Observed {
  down: boolean;
  pressed: boolean;
  released: boolean;
  hold: number;
}

/**
 * Runs exactly one step and captures the values while the frame is open.
 *
 * Reading after `endFrame` would always report no edges, which would make an
 * assertion pass for the wrong reason.
 */
function step(input: InputState, action: ButtonAction, dt = STEP): Observed {
  input.beginFrame(dt);
  const observed: Observed = {
    down: input.isDown(action),
    pressed: input.wasPressed(action),
    released: input.wasReleased(action),
    hold: input.getHoldDuration(action),
  };
  input.endFrame();
  return observed;
}

describe('action map', () => {
  it('exposes every action exactly once across the axis and button lists', () => {
    expect(AXIS_ACTIONS).toEqual(['moveX', 'moveY', 'lookX', 'lookY']);
    expect(BUTTON_ACTIONS).toEqual([
      'interact',
      'sprint',
      'crouch',
      'jump',
      'toolAction',
      'toolAlt',
      'scan',
      'pause',
      'journal',
      'dialogueSelect',
      'cancel',
    ]);

    expect(GAME_ACTIONS).toHaveLength(15);
    expect(new Set(GAME_ACTIONS).size).toBe(15);
    expect(GAME_ACTIONS).toEqual([...AXIS_ACTIONS, ...BUTTON_ACTIONS]);
  });

  it('separates axes from buttons with mutually exclusive guards', () => {
    for (const action of GAME_ACTIONS) {
      expect(isAxisAction(action)).toBe(!isButtonAction(action));
    }
    for (const action of AXIS_ACTIONS) expect(isAxisAction(action)).toBe(true);
    for (const action of BUTTON_ACTIONS) expect(isButtonAction(action)).toBe(true);
  });

  it('rejects strings that are not actions', () => {
    expect(isGameAction('interact')).toBe(true);
    expect(isGameAction('moveX')).toBe(true);
    expect(isGameAction('KeyE')).toBe(false);
    expect(isGameAction('')).toBe(false);
    expect(isGameAction('toString')).toBe(false);
  });

  it('names every action for the rebinding UI', () => {
    for (const action of GAME_ACTIONS) {
      const name = actionDisplayName(action);
      expect(name.length).toBeGreaterThan(0);
      expect(name).toBe(ACTION_DISPLAY_NAMES[action]);
    }
    // Distinct labels: two rows reading the same thing is a UI bug.
    const labels = GAME_ACTIONS.map((a) => ACTION_DISPLAY_NAMES[a]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('declares the three input families', () => {
    expect(INPUT_FAMILIES).toEqual(['keyboard', 'gamepad', 'touch']);
  });
});

describe('InputState — button edges', () => {
  let input: InputState;

  beforeEach(() => {
    input = new InputState();
  });

  it('reports nothing before any frame has run', () => {
    input.setButton('keyboard', 'interact', true);
    expect(input.isDown('interact')).toBe(false);
    expect(input.wasPressed('interact')).toBe(false);
    expect(input.wasReleased('interact')).toBe(false);
    expect(input.getHoldDuration('interact')).toBe(0);
    expect(input.frameIsOpen).toBe(false);
  });

  it('walks press, hold and release across separate steps', () => {
    // Idle.
    expect(step(input, 'interact')).toEqual({
      down: false,
      pressed: false,
      released: false,
      hold: 0,
    });

    input.setButton('keyboard', 'interact', true);

    const pressFrame = step(input, 'interact');
    expect(pressFrame.down).toBe(true);
    expect(pressFrame.pressed).toBe(true);
    expect(pressFrame.released).toBe(false);

    const holdFrame = step(input, 'interact');
    expect(holdFrame.down).toBe(true);
    expect(holdFrame.pressed).toBe(false);
    expect(holdFrame.released).toBe(false);

    input.setButton('keyboard', 'interact', false);

    const releaseFrame = step(input, 'interact');
    expect(releaseFrame.down).toBe(false);
    expect(releaseFrame.pressed).toBe(false);
    expect(releaseFrame.released).toBe(true);

    const idleFrame = step(input, 'interact');
    expect(idleFrame.down).toBe(false);
    expect(idleFrame.pressed).toBe(false);
    expect(idleFrame.released).toBe(false);
  });

  it('reports wasPressed for exactly one step of a long hold', () => {
    input.setButton('keyboard', 'interact', true);

    const pressedPerFrame: boolean[] = [];
    for (let i = 0; i < 10; i += 1) {
      pressedPerFrame.push(step(input, 'interact').pressed);
    }

    expect(pressedPerFrame.filter(Boolean)).toHaveLength(1);
    expect(pressedPerFrame[0]).toBe(true);
  });

  it('reports wasReleased for exactly one step of a long release', () => {
    input.setButton('keyboard', 'jump', true);
    step(input, 'jump');
    step(input, 'jump');
    input.setButton('keyboard', 'jump', false);

    const releasedPerFrame: boolean[] = [];
    for (let i = 0; i < 8; i += 1) {
      releasedPerFrame.push(step(input, 'jump').released);
    }

    expect(releasedPerFrame.filter(Boolean)).toHaveLength(1);
    expect(releasedPerFrame[0]).toBe(true);
  });

  it('separates a rapid press-release-press into two distinct presses', () => {
    input.setButton('keyboard', 'toolAction', true);
    expect(step(input, 'toolAction').pressed).toBe(true);

    input.setButton('keyboard', 'toolAction', false);
    expect(step(input, 'toolAction').released).toBe(true);

    input.setButton('keyboard', 'toolAction', true);
    const second = step(input, 'toolAction');
    expect(second.pressed).toBe(true);
    expect(second.released).toBe(false);
  });

  it('keeps edges out of unrelated actions', () => {
    input.setButton('keyboard', 'sprint', true);
    input.beginFrame(STEP);
    expect(input.wasPressed('sprint')).toBe(true);
    for (const action of BUTTON_ACTIONS) {
      if (action === 'sprint') continue;
      expect(input.wasPressed(action)).toBe(false);
      expect(input.isDown(action)).toBe(false);
    }
    input.endFrame();
  });

  it('answers anyPressed only on the step a press lands', () => {
    input.beginFrame(STEP);
    expect(input.anyPressed()).toBe(false);
    input.endFrame();

    input.setButton('gamepad', 'journal', true);
    input.beginFrame(STEP);
    expect(input.anyPressed()).toBe(true);
    input.endFrame();

    input.beginFrame(STEP);
    expect(input.anyPressed()).toBe(false);
    input.endFrame();
  });
});

describe('InputState — frame lifecycle', () => {
  let input: InputState;

  beforeEach(() => {
    input = new InputState();
  });

  it('tracks whether a frame is open', () => {
    expect(input.frameIsOpen).toBe(false);
    input.beginFrame(STEP);
    expect(input.frameIsOpen).toBe(true);
    input.endFrame();
    expect(input.frameIsOpen).toBe(false);
  });

  it('cannot produce a phantom edge from endFrame alone', () => {
    input.setButton('keyboard', 'interact', true);

    // No beginFrame: nothing has been latched, so there is nothing to report.
    input.endFrame();
    expect(input.wasPressed('interact')).toBe(false);
    expect(input.wasReleased('interact')).toBe(false);
    expect(input.isDown('interact')).toBe(false);

    // Repeating it must not accumulate into a press either.
    for (let i = 0; i < 5; i += 1) input.endFrame();
    expect(input.wasPressed('interact')).toBe(false);
    expect(input.isDown('interact')).toBe(false);
    expect(input.getHoldDuration('interact')).toBe(0);
  });

  it('clears edges but keeps held state after endFrame', () => {
    input.setButton('keyboard', 'sprint', true);
    input.beginFrame(STEP);
    expect(input.wasPressed('sprint')).toBe(true);
    input.endFrame();

    expect(input.wasPressed('sprint')).toBe(false);
    expect(input.wasReleased('sprint')).toBe(false);
    // Held state and hold time are step-spanning, not per-frame signals.
    expect(input.isDown('sprint')).toBe(true);
    expect(input.getHoldDuration('sprint')).toBeCloseTo(STEP, 10);
  });

  it('does not let a second endFrame resurrect an edge', () => {
    input.setButton('keyboard', 'cancel', true);
    input.beginFrame(STEP);
    input.endFrame();
    input.endFrame();
    expect(input.wasPressed('cancel')).toBe(false);
  });

  it('warns and drops stale edges when beginFrame is called twice', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    input.setButton('keyboard', 'pause', true);
    input.beginFrame(STEP);
    expect(input.wasPressed('pause')).toBe(true);

    // Contract violation: the previous step's press was never consumed.
    input.beginFrame(STEP);
    expect(warn).toHaveBeenCalledTimes(1);
    // The button is still held, but the press edge belonged to the lost step.
    expect(input.isDown('pause')).toBe(true);
    expect(input.wasPressed('pause')).toBe(false);

    input.endFrame();
    warn.mockRestore();
  });
});

describe('InputState — hold duration', () => {
  let input: InputState;

  beforeEach(() => {
    input = new InputState();
  });

  it('accumulates fixed steps while held', () => {
    input.setButton('keyboard', 'interact', true);

    // The step in which the press is latched counts, so after n steps the
    // total is n * dt — what a hold-to-interact progress ring divides by.
    expect(step(input, 'interact').hold).toBeCloseTo(STEP, 10);
    expect(step(input, 'interact').hold).toBeCloseTo(2 * STEP, 10);
    expect(step(input, 'interact').hold).toBeCloseTo(3 * STEP, 10);

    // 3 steps done; 26 more, then the 30th is the one under assertion.
    for (let i = 0; i < 26; i += 1) step(input, 'interact');
    input.beginFrame(STEP);
    expect(input.getHoldDuration('interact')).toBeCloseTo(30 * STEP, 10);
    expect(input.getHoldDuration('interact')).toBeCloseTo(0.5, 10);
    input.endFrame();
  });

  it('crosses a hold-to-interact threshold at the expected step', () => {
    const threshold = 0.8;
    input.setButton('keyboard', 'interact', true);

    let steps = 0;
    let completed = false;
    while (steps < 200 && !completed) {
      input.beginFrame(STEP);
      steps += 1;
      completed = input.getHoldDuration('interact') >= threshold;
      input.endFrame();
    }

    expect(completed).toBe(true);
    expect(steps).toBe(Math.ceil(threshold / STEP));
  });

  it('resets to zero on release and restarts on the next press', () => {
    input.setButton('keyboard', 'scan', true);
    step(input, 'scan');
    step(input, 'scan');
    step(input, 'scan');

    input.setButton('keyboard', 'scan', false);
    expect(step(input, 'scan').hold).toBe(0);

    input.setButton('keyboard', 'scan', true);
    expect(step(input, 'scan').hold).toBeCloseTo(STEP, 10);
  });

  it('does not accumulate when the action is up', () => {
    for (let i = 0; i < 20; i += 1) step(input, 'crouch');
    input.beginFrame(STEP);
    expect(input.getHoldDuration('crouch')).toBe(0);
    input.endFrame();
  });

  it('survives a non-finite or negative dt without poisoning the hold', () => {
    input.setButton('keyboard', 'interact', true);

    input.beginFrame(Number.NaN);
    expect(input.isDown('interact')).toBe(true);
    expect(input.getHoldDuration('interact')).toBe(0);
    input.endFrame();

    input.beginFrame(-1);
    expect(input.getHoldDuration('interact')).toBe(0);
    input.endFrame();

    input.beginFrame(STEP);
    expect(input.getHoldDuration('interact')).toBeCloseTo(STEP, 10);
    input.endFrame();
  });

  it('keeps holding across a source handover', () => {
    // Keyboard starts the hold, gamepad takes over mid-hold: the action never
    // went up, so the hold must not restart.
    input.setButton('keyboard', 'interact', true);
    step(input, 'interact');
    step(input, 'interact');

    input.setButton('gamepad', 'interact', true);
    input.setButton('keyboard', 'interact', false);

    const handover = step(input, 'interact');
    expect(handover.down).toBe(true);
    expect(handover.pressed).toBe(false);
    expect(handover.released).toBe(false);
    expect(handover.hold).toBeCloseTo(3 * STEP, 10);
  });
});

describe('InputState — axes', () => {
  let input: InputState;

  beforeEach(() => {
    input = new InputState();
  });

  it('starts at zero on every axis', () => {
    input.beginFrame(STEP);
    for (const axis of AXIS_ACTIONS) expect(input.getAxis(axis)).toBe(0);
    input.endFrame();
  });

  it('clamps values into [-1,1]', () => {
    input.setAxis('gamepad', 'moveX', 5);
    input.setAxis('gamepad', 'moveY', -5);
    input.beginFrame(STEP);
    expect(input.getAxis('moveX')).toBe(1);
    expect(input.getAxis('moveY')).toBe(-1);
    input.endFrame();
  });

  it('treats non-finite values as zero rather than propagating them', () => {
    input.setAxis('gamepad', 'lookX', Number.NaN);
    input.setAxis('gamepad', 'lookY', Number.POSITIVE_INFINITY);
    input.beginFrame(STEP);
    expect(input.getAxis('lookX')).toBe(0);
    // Infinity would clamp to 1 numerically; a broken device must read as idle.
    expect(input.getAxis('lookY')).toBe(0);
    input.endFrame();
  });

  it('holds an axis value until the driver changes it', () => {
    input.setAxis('gamepad', 'moveY', 0.6);
    input.beginFrame(STEP);
    expect(input.getAxis('moveY')).toBeCloseTo(0.6, 10);
    input.endFrame();

    input.beginFrame(STEP);
    expect(input.getAxis('moveY')).toBeCloseTo(0.6, 10);
    input.endFrame();

    input.setAxis('gamepad', 'moveY', 0);
    input.beginFrame(STEP);
    expect(input.getAxis('moveY')).toBe(0);
    input.endFrame();
  });

  it('does not let an idle keyboard zero a live gamepad stick', () => {
    // The keyboard driver reports 0 every step because no key is held. That
    // must not overwrite the stick.
    input.setAxis('keyboard', 'moveY', 0);
    input.setAxis('gamepad', 'moveY', 0.42);
    input.beginFrame(STEP);
    expect(input.getAxis('moveY')).toBeCloseTo(0.42, 10);
    input.endFrame();
  });

  it('resolves competing sources by largest magnitude', () => {
    input.setAxis('keyboard', 'moveX', 1);
    input.setAxis('gamepad', 'moveX', 0.4);
    input.beginFrame(STEP);
    expect(input.getAxis('moveX')).toBe(1);
    input.endFrame();

    input.setAxis('keyboard', 'moveX', -0.3);
    input.setAxis('gamepad', 'moveX', 0.8);
    input.beginFrame(STEP);
    expect(input.getAxis('moveX')).toBeCloseTo(0.8, 10);
    input.endFrame();

    // Sign is preserved: the larger magnitude wins, not the larger number.
    input.setAxis('keyboard', 'moveX', -0.9);
    input.setAxis('gamepad', 'moveX', 0.2);
    input.beginFrame(STEP);
    expect(input.getAxis('moveX')).toBeCloseTo(-0.9, 10);
    input.endFrame();
  });

  it('resolves three simultaneous sources', () => {
    input.setAxis('keyboard', 'lookX', 0.2);
    input.setAxis('gamepad', 'lookX', -0.5);
    input.setAxis('touch', 'lookX', 0.35);
    input.beginFrame(STEP);
    expect(input.getAxis('lookX')).toBeCloseTo(-0.5, 10);
    input.endFrame();
  });

  it('breaks an exact magnitude tie toward the active family', () => {
    // Establish the gamepad as the active family.
    input.setAxis('gamepad', 'moveX', 1);
    input.beginFrame(STEP);
    input.endFrame();
    expect(input.activeFamily).toBe('gamepad');

    // Opposing sources at identical magnitude: follow the device in use.
    input.setAxis('keyboard', 'moveX', -1);
    input.beginFrame(STEP);
    expect(input.getAxis('moveX')).toBe(1);
    input.endFrame();
  });

  it('keeps each axis independent', () => {
    input.setAxis('gamepad', 'moveX', 0.7);
    input.beginFrame(STEP);
    expect(input.getAxis('moveX')).toBeCloseTo(0.7, 10);
    expect(input.getAxis('moveY')).toBe(0);
    expect(input.getAxis('lookX')).toBe(0);
    expect(input.getAxis('lookY')).toBe(0);
    input.endFrame();
  });
});

describe('InputState — button OR across sources', () => {
  let input: InputState;

  beforeEach(() => {
    input = new InputState();
  });

  it('holds the action while any single source holds it', () => {
    input.setButton('touch', 'interact', true);
    expect(step(input, 'interact').down).toBe(true);

    input.setButton('touch', 'interact', false);
    expect(step(input, 'interact').released).toBe(true);
  });

  it('stays down until the last source releases', () => {
    input.setButton('keyboard', 'sprint', true);
    input.setButton('gamepad', 'sprint', true);
    expect(step(input, 'sprint').pressed).toBe(true);

    input.setButton('keyboard', 'sprint', false);
    const stillHeld = step(input, 'sprint');
    expect(stillHeld.down).toBe(true);
    expect(stillHeld.released).toBe(false);

    input.setButton('gamepad', 'sprint', false);
    expect(step(input, 'sprint').released).toBe(true);
  });

  it('emits one press when a second source joins an already-held action', () => {
    input.setButton('keyboard', 'toolAlt', true);
    expect(step(input, 'toolAlt').pressed).toBe(true);

    input.setButton('touch', 'toolAlt', true);
    const joined = step(input, 'toolAlt');
    expect(joined.down).toBe(true);
    expect(joined.pressed).toBe(false);
  });
});

describe('InputState — taps', () => {
  let input: InputState;

  beforeEach(() => {
    input = new InputState();
  });

  it('turns a contact shorter than a step into one press and one release', () => {
    input.pulseButton('touch', 'dialogueSelect');

    const pressFrame = step(input, 'dialogueSelect');
    expect(pressFrame.pressed).toBe(true);
    expect(pressFrame.down).toBe(true);

    const releaseFrame = step(input, 'dialogueSelect');
    expect(releaseFrame.released).toBe(true);
    expect(releaseFrame.down).toBe(false);

    expect(step(input, 'dialogueSelect').down).toBe(false);
  });

  it('does not drop a tap that arrives while a frame is open', () => {
    input.beginFrame(STEP);
    // Contact lands after the latch, e.g. a touchend during the same step.
    input.pulseButton('touch', 'dialogueSelect');
    expect(input.wasPressed('dialogueSelect')).toBe(false);
    input.endFrame();

    expect(step(input, 'dialogueSelect').pressed).toBe(true);
  });

  it('does not release an action a driver is genuinely still holding', () => {
    input.setButton('touch', 'interact', true);
    input.pulseButton('touch', 'interact');

    expect(step(input, 'interact').pressed).toBe(true);
    const next = step(input, 'interact');
    expect(next.down).toBe(true);
    expect(next.released).toBe(false);
  });
});

describe('InputState — active family', () => {
  let input: InputState;

  beforeEach(() => {
    input = new InputState();
  });

  it('defaults to keyboard and honours an explicit initial family', () => {
    expect(input.activeFamily).toBe('keyboard');
    expect(new InputState({ initialFamily: 'touch' }).activeFamily).toBe('touch');
  });

  it('switches on a button press and announces it', () => {
    const changes: { family: string; previous: string }[] = [];
    input.on('familyChanged', (payload) => changes.push(payload));

    input.setButton('gamepad', 'interact', true);
    input.beginFrame(STEP);
    input.endFrame();

    expect(input.activeFamily).toBe('gamepad');
    expect(changes).toEqual([{ family: 'gamepad', previous: 'keyboard' }]);
  });

  it('announces the change before systems read, inside beginFrame', () => {
    let familyAtEmit: string | null = null;
    input.on('familyChanged', ({ family }) => {
      familyAtEmit = family;
    });

    input.setButton('touch', 'jump', true);
    input.beginFrame(STEP);
    // Already switched by the time the frame is open, so prompts drawn this
    // step are correct rather than one step stale.
    expect(input.activeFamily).toBe('touch');
    input.endFrame();

    expect(familyAtEmit).toBe('touch');
  });

  it('ignores stick drift below the deadzone', () => {
    const changes: string[] = [];
    input.on('familyChanged', ({ family }) => changes.push(family));

    input.setAxis('gamepad', 'lookX', 0.08);
    input.setAxis('gamepad', 'lookY', -0.15);
    input.beginFrame(STEP);
    input.endFrame();

    expect(input.activeFamily).toBe('keyboard');
    expect(changes).toEqual([]);

    // A deliberate push clears the floor.
    input.setAxis('gamepad', 'lookX', 0.75);
    input.beginFrame(STEP);
    input.endFrame();

    expect(input.activeFamily).toBe('gamepad');
    expect(changes).toEqual(['gamepad']);
  });

  it('honours a configured deadzone', () => {
    const strict = new InputState({ familyDeadzone: 0.6 });

    strict.setAxis('gamepad', 'moveX', 0.5);
    strict.beginFrame(STEP);
    strict.endFrame();
    expect(strict.activeFamily).toBe('keyboard');

    strict.setAxis('gamepad', 'moveX', 0.65);
    strict.beginFrame(STEP);
    strict.endFrame();
    expect(strict.activeFamily).toBe('gamepad');
  });

  it('lets a fresh press outrank another family at full stick deflection', () => {
    const pad = new InputState({ initialFamily: 'gamepad' });
    pad.setAxis('gamepad', 'moveY', 1);
    pad.beginFrame(STEP);
    pad.endFrame();
    expect(pad.activeFamily).toBe('gamepad');

    // Hand moves to the keyboard while the stick is still pushed.
    pad.setButton('keyboard', 'interact', true);
    pad.beginFrame(STEP);
    pad.endFrame();
    expect(pad.activeFamily).toBe('keyboard');
  });

  it('does not let a held key keep ownership away from a moving stick', () => {
    input.setButton('keyboard', 'sprint', true);
    input.beginFrame(STEP);
    input.endFrame();
    expect(input.activeFamily).toBe('keyboard');

    // Key still held — no new press — while the stick is pushed.
    input.setAxis('gamepad', 'moveY', 0.9);
    input.beginFrame(STEP);
    expect(input.activeFamily).toBe('gamepad');
    // And the stick value is intact: sharing a step did not zero it.
    expect(input.getAxis('moveY')).toBeCloseTo(0.9, 10);
    expect(input.isDown('sprint')).toBe(true);
    input.endFrame();
  });

  it('emits only on change, not on every step of continued input', () => {
    const changes: string[] = [];
    input.on('familyChanged', ({ family }) => changes.push(family));

    input.setAxis('gamepad', 'moveX', 0.9);
    for (let i = 0; i < 10; i += 1) {
      input.beginFrame(STEP);
      input.endFrame();
    }

    expect(changes).toEqual(['gamepad']);
  });

  it('keeps the current family when two sources tie exactly', () => {
    input.setAxis('gamepad', 'moveX', 0.9);
    input.beginFrame(STEP);
    input.endFrame();
    expect(input.activeFamily).toBe('gamepad');

    // Equal deflection on both: no reason to flip, so do not flicker prompts.
    input.setAxis('touch', 'moveX', 0.9);
    for (let i = 0; i < 5; i += 1) {
      input.beginFrame(STEP);
      input.endFrame();
    }
    expect(input.activeFamily).toBe('gamepad');
  });

  it('lets a listener unsubscribe', () => {
    const changes: string[] = [];
    const off = input.on('familyChanged', ({ family }) => changes.push(family));

    input.setAxis('gamepad', 'moveX', 0.9);
    input.beginFrame(STEP);
    input.endFrame();
    expect(changes).toEqual(['gamepad']);

    off();
    input.setButton('touch', 'jump', true);
    input.beginFrame(STEP);
    input.endFrame();

    expect(input.activeFamily).toBe('touch');
    expect(changes).toEqual(['gamepad']);
  });

  it('attributes a tap to its family', () => {
    input.pulseButton('touch', 'dialogueSelect');
    input.beginFrame(STEP);
    input.endFrame();
    expect(input.activeFamily).toBe('touch');
  });
});

describe('InputState — reset', () => {
  let input: InputState;

  beforeEach(() => {
    input = new InputState();
  });

  it('clears held state so an unseen keyup cannot strand a key down', () => {
    input.setButton('keyboard', 'sprint', true);
    input.setAxis('keyboard', 'moveY', 1);
    input.beginFrame(STEP);
    input.endFrame();
    expect(input.isDown('sprint')).toBe(true);

    // Window blur: the keyup will never arrive.
    input.reset();

    expect(input.isDown('sprint')).toBe(false);
    expect(input.getHoldDuration('sprint')).toBe(0);
    expect(input.getAxis('moveY')).toBe(0);
    expect(input.frameIsOpen).toBe(false);

    input.beginFrame(STEP);
    expect(input.isDown('sprint')).toBe(false);
    expect(input.getAxis('moveY')).toBe(0);
    // No phantom release either: the hold was interrupted, not completed.
    expect(input.wasReleased('sprint')).toBe(false);
    expect(input.wasPressed('sprint')).toBe(false);
    input.endFrame();
  });

  it('clears every source, not just the one that was active', () => {
    input.setButton('keyboard', 'interact', true);
    input.setButton('gamepad', 'jump', true);
    input.setButton('touch', 'scan', true);
    input.setAxis('gamepad', 'lookX', 0.8);
    input.setAxis('touch', 'moveX', -0.7);
    input.beginFrame(STEP);
    input.endFrame();

    input.reset();
    input.beginFrame(STEP);
    for (const action of BUTTON_ACTIONS) {
      expect(input.isDown(action)).toBe(false);
      expect(input.getHoldDuration(action)).toBe(0);
    }
    for (const axis of AXIS_ACTIONS) expect(input.getAxis(axis)).toBe(0);
    input.endFrame();
  });

  it('discards queued taps', () => {
    input.pulseButton('touch', 'dialogueSelect');
    input.reset();
    expect(step(input, 'dialogueSelect').pressed).toBe(false);
  });

  it('closes an open frame and clears its edges', () => {
    input.setButton('keyboard', 'pause', true);
    input.beginFrame(STEP);
    expect(input.wasPressed('pause')).toBe(true);

    input.reset();
    expect(input.frameIsOpen).toBe(false);
    expect(input.wasPressed('pause')).toBe(false);
  });

  it('keeps the active family so prompts do not flip on focus loss', () => {
    const changes: string[] = [];
    input.setButton('gamepad', 'interact', true);
    input.beginFrame(STEP);
    input.endFrame();
    expect(input.activeFamily).toBe('gamepad');

    input.on('familyChanged', ({ family }) => changes.push(family));
    input.reset();

    expect(input.activeFamily).toBe('gamepad');
    expect(changes).toEqual([]);
  });

  it('accepts input normally again after a reset', () => {
    input.setButton('keyboard', 'interact', true);
    step(input, 'interact');
    input.reset();

    input.setButton('keyboard', 'interact', true);
    const afterReset = step(input, 'interact');
    expect(afterReset.pressed).toBe(true);
    expect(afterReset.hold).toBeCloseTo(STEP, 10);
  });
});

describe('InputState — a realistic hold-to-interact sequence', () => {
  it('fires once, tracks the hold, and completes without repeating', () => {
    const input = new InputState();
    const holdRequired = 0.6;

    let promptsShown = 0;
    let completions = 0;
    let cancelled = 0;
    let progress = 0;

    const simulate = (steps: number): void => {
      for (let i = 0; i < steps; i += 1) {
        input.beginFrame(STEP);
        if (input.wasPressed('interact')) promptsShown += 1;
        if (input.isDown('interact')) {
          progress = Math.min(1, input.getHoldDuration('interact') / holdRequired);
          if (progress >= 1) completions += 1;
        }
        if (input.wasReleased('interact') && progress < 1) cancelled += 1;
        input.endFrame();
      }
    };

    // Tap and let go early: one prompt, one cancel, no completion.
    input.setButton('keyboard', 'interact', true);
    simulate(6);
    input.setButton('keyboard', 'interact', false);
    simulate(1);

    expect(promptsShown).toBe(1);
    expect(completions).toBe(0);
    expect(cancelled).toBe(1);

    // Hold it properly this time.
    progress = 0;
    input.setButton('keyboard', 'interact', true);
    simulate(Math.ceil(holdRequired / STEP));

    expect(promptsShown).toBe(2);
    expect(completions).toBe(1);
    expect(cancelled).toBe(1);
  });
});

describe('InputState — typed surface', () => {
  it('accepts a narrowed action from the guards', () => {
    const input = new InputState();
    input.setButton('keyboard', 'interact', true);
    input.setAxis('gamepad', 'moveX', 0.5);
    input.beginFrame(STEP);

    // What a rebinding screen does: iterate GameAction and branch on shape.
    const seen: string[] = [];
    for (const action of GAME_ACTIONS as readonly GameAction[]) {
      if (isAxisAction(action)) {
        seen.push(`${action}=${input.getAxis(action).toFixed(2)}`);
      } else if (isButtonAction(action)) {
        seen.push(`${action}=${input.isDown(action) ? 'down' : 'up'}`);
      }
    }
    input.endFrame();

    expect(seen).toHaveLength(15);
    expect(seen).toContain('moveX=0.50');
    expect(seen).toContain('interact=down');
    expect(seen).toContain('jump=up');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
