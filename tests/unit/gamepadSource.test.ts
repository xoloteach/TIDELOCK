/**
 * Gamepad source tests.
 *
 * The Gamepad API cannot be driven from jsdom, so these build fake `Gamepad`
 * snapshots and feed them through an injected provider (plus one test that
 * proves the real `navigator.getGamepads` path is used by default).
 *
 * The centrepiece is the radial deadzone: several tests exist purely to prove
 * the stick's *direction* survives deadzone rescaling, because the per-axis
 * alternative silently snaps diagonal movement to cardinal directions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  GamepadSource,
  applyRadialDeadzone,
  clampToUnitCircle,
  detectGamepadStyle,
  GAMEPAD_BUTTON_BINDINGS,
  GAMEPAD_FAMILY,
  TRIGGER_PRESS_THRESHOLD,
  TRIGGER_RELEASE_THRESHOLD,
  type GamepadInputSink,
  type GamepadProvider,
  type GamepadTuning,
} from '../../src/engine/input/GamepadSource';
import { createDefaultSettings } from '../../src/persistence/settingsSchema';

// ---- Fixtures -----------------------------------------------------------

interface FakePadOptions {
  index?: number;
  id?: string;
  mapping?: string;
  axes?: number[];
  /** Sparse map of button index -> analogue value (or boolean shorthand). */
  buttons?: Record<number, number | boolean>;
  buttonCount?: number;
  connected?: boolean;
  vibrationActuator?: unknown;
}

/**
 * Builds a structurally faithful `Gamepad`.
 *
 * A standard pad reports 4 axes and 17 buttons; `buttonCount` lets a test
 * model a cheap non-standard pad that reports fewer.
 */
function makePad(options: FakePadOptions = {}): Gamepad {
  const count = options.buttonCount ?? 17;
  const source = options.buttons ?? {};
  const buttons = Array.from({ length: count }, (_unused, index) => {
    const raw = source[index] ?? 0;
    const value = typeof raw === 'boolean' ? (raw ? 1 : 0) : raw;
    return { pressed: value >= 0.5, touched: value > 0, value };
  });

  return {
    index: options.index ?? 0,
    id: options.id ?? 'Xbox 360 Controller (XInput STANDARD GAMEPAD)',
    mapping: options.mapping ?? 'standard',
    connected: options.connected ?? true,
    timestamp: 0,
    axes: options.axes ?? [0, 0, 0, 0],
    buttons,
    hapticActuators: [],
    vibrationActuator: options.vibrationActuator ?? null,
  } as unknown as Gamepad;
}

function makeProvider(initial: (Gamepad | null)[] = []) {
  const state: { pads: (Gamepad | null)[] } = { pads: initial };
  const provider: GamepadProvider = { getGamepads: () => state.pads };
  return { provider, state };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

function makeTuning(patch: Partial<GamepadTuning> = {}): GamepadTuning {
  return {
    gamepadSensitivity: 1,
    gamepadInvertY: false,
    gamepadDeadzone: 0,
    gamepadHaptics: true,
    ...patch,
  };
}

function makeRecorder() {
  const axes: Record<string, number> = {};
  const buttons: Record<string, boolean> = {};
  let axisCalls = 0;
  let buttonCalls = 0;

  const sink: GamepadInputSink = {
    setAxis(action, value) {
      axes[action] = value;
      axisCalls += 1;
    },
    setButton(action, down) {
      buttons[action] = down;
      buttonCalls += 1;
    },
  };

  return {
    sink,
    axes,
    buttons,
    get axisCalls() {
      return axisCalls;
    },
    get buttonCalls() {
      return buttonCalls;
    },
    get totalCalls() {
      return axisCalls + buttonCalls;
    },
    resetCounts() {
      axisCalls = 0;
      buttonCalls = 0;
    },
  };
}

/**
 * A fresh EventTarget stands in for `window` so each test's listeners are
 * isolated and `removeEventListener` can be spied on.
 */
function makeTarget(): EventTarget {
  return new EventTarget();
}

function dispatchPadEvent(target: EventTarget, type: string, pad: Gamepad | null): void {
  const event = new Event(type) as Event & { gamepad?: Gamepad | null };
  event.gamepad = pad;
  target.dispatchEvent(event);
}

/** The naive implementation this module exists to avoid, for comparison. */
function perAxisDeadzone(x: number, y: number, deadzone: number): { x: number; y: number } {
  const axis = (value: number): number => {
    if (Math.abs(value) <= deadzone) return 0;
    return Math.sign(value) * ((Math.abs(value) - deadzone) / (1 - deadzone));
  };
  return { x: axis(x), y: axis(y) };
}

// ---- Radial deadzone ----------------------------------------------------

describe('applyRadialDeadzone', () => {
  it('keeps a 45-degree push at exactly 45 degrees', () => {
    // The anti-snapping proof: the output must be a positive scalar multiple
    // of the input, so the angle is bit-for-bit unchanged.
    const result = applyRadialDeadzone(0.5, 0.5, 0.2);

    expect(result.x).toBe(result.y);
    expect(Math.atan2(result.y, result.x)).toBeCloseTo(Math.PI / 4, 12);
    expect(result.x).toBeGreaterThan(0);
  });

  it('preserves the angle of an asymmetric push whose smaller axis is inside the deadzone', () => {
    // (0.30, 0.15) is 26.57 degrees, magnitude 0.335 — outside a 0.2 deadzone,
    // but its Y component alone is inside it.
    const radial = applyRadialDeadzone(0.3, 0.15, 0.2);
    const naive = perAxisDeadzone(0.3, 0.15, 0.2);

    const originalAngle = Math.atan2(0.15, 0.3);
    expect(Math.atan2(radial.y, radial.x)).toBeCloseTo(originalAngle, 12);

    // The per-axis version zeroes Y entirely and snaps the player to due east.
    expect(naive.y).toBe(0);
    expect(Math.atan2(naive.y, naive.x)).toBe(0);
    expect(radial.y).toBeGreaterThan(0);
  });

  it('does not let diagonals reach full deflection sooner than cardinals', () => {
    // Per-axis rescaling inflates each component independently, so a diagonal
    // ends up with a magnitude above 1.
    const radial = applyRadialDeadzone(1, 1, 0.2);
    const naive = perAxisDeadzone(1, 1, 0.2);

    expect(Math.hypot(radial.x, radial.y)).toBeCloseTo(1, 12);
    expect(Math.hypot(naive.x, naive.y)).toBeGreaterThan(1);
  });

  it('rejects small stick drift inside the deadzone', () => {
    for (const [x, y] of [
      [0.05, 0.0],
      [0.0, -0.09],
      [0.08, 0.08],
      [-0.1, 0.05],
    ] as const) {
      const result = applyRadialDeadzone(x, y, 0.15);
      expect(result).toEqual({ x: 0, y: 0 });
    }
  });

  it('rejects a push whose magnitude sits exactly on the deadzone edge', () => {
    expect(applyRadialDeadzone(0.25, 0, 0.25)).toEqual({ x: 0, y: 0 });
  });

  it('ramps from 0 at the deadzone edge to 1 at full deflection', () => {
    const deadzone = 0.25;

    expect(magnitudeOf(applyRadialDeadzone(0.25, 0, deadzone))).toBe(0);
    // Just past the edge must be near zero, not a jump to a usable value.
    expect(magnitudeOf(applyRadialDeadzone(0.2501, 0, deadzone))).toBeLessThan(0.001);
    // Halfway between the edge and full travel.
    expect(magnitudeOf(applyRadialDeadzone(0.625, 0, deadzone))).toBeCloseTo(0.5, 10);
    expect(magnitudeOf(applyRadialDeadzone(1, 0, deadzone))).toBeCloseTo(1, 10);
  });

  it('ramps monotonically', () => {
    let previous = -1;
    for (let travel = 0.2; travel <= 1.0001; travel += 0.05) {
      const value = magnitudeOf(applyRadialDeadzone(travel, 0, 0.2));
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    expect(previous).toBeCloseTo(1, 10);
  });

  it('clamps overshoot from pads that report past 1 on a diagonal', () => {
    const result = applyRadialDeadzone(1.1, 1.1, 0.1);
    expect(magnitudeOf(result)).toBeCloseTo(1, 10);
    expect(result.x).toBe(result.y);
  });

  it('passes values straight through when the deadzone is zero', () => {
    const result = applyRadialDeadzone(0.4, -0.3, 0);
    expect(result.x).toBeCloseTo(0.4, 12);
    expect(result.y).toBeCloseTo(-0.3, 12);
  });

  it('never divides by zero for an absurd deadzone', () => {
    const result = applyRadialDeadzone(1, 0, 1);
    expect(Number.isFinite(result.x)).toBe(true);
    expect(Number.isFinite(result.y)).toBe(true);
  });

  it('treats non-finite axis readings as centred', () => {
    expect(applyRadialDeadzone(Number.NaN, 0.5, 0.1).x).toBe(0);
    expect(applyRadialDeadzone(0.5, Number.POSITIVE_INFINITY, 0.1).y).toBe(0);
  });
});

describe('clampToUnitCircle', () => {
  it('leaves vectors inside the circle alone', () => {
    expect(clampToUnitCircle(0.5, -0.5)).toEqual({ x: 0.5, y: -0.5 });
  });

  it('scales an overlong vector without turning it', () => {
    const result = clampToUnitCircle(1, 1);
    expect(magnitudeOf(result)).toBeCloseTo(1, 12);
    expect(Math.atan2(result.y, result.x)).toBeCloseTo(Math.PI / 4, 12);
  });

  it('handles the zero vector', () => {
    expect(clampToUnitCircle(0, 0)).toEqual({ x: 0, y: 0 });
  });
});

// ---- Style detection ---------------------------------------------------

describe('detectGamepadStyle', () => {
  // Real id strings as reported by shipping browsers. This is heuristic
  // matching, so the interesting cases are the ambiguous ones.
  const cases: readonly [string, string][] = [
    ['Xbox 360 Controller (XInput STANDARD GAMEPAD)', 'xbox'],
    ['045e-028e-Microsoft X-Box 360 pad', 'xbox'],
    ['Xbox Wireless Controller Extended Gamepad', 'xbox'],
    ['Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)', 'playstation'],
    ['DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', 'playstation'],
    ['054c-05c4-Sony Computer Entertainment Wireless Controller', 'playstation'],
    ['Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)', 'nintendo'],
    ['Joy-Con L+R (STANDARD GAMEPAD Vendor: 057e Product: 200e)', 'nintendo'],
    ['Logitech Dual Action (Vendor: 046d Product: c216)', 'generic'],
    ['Unknown Gamepad', 'generic'],
    ['', 'generic'],
  ];

  for (const [id, expected] of cases) {
    it(`maps ${id === '' ? '(empty id)' : id} to ${expected}`, () => {
      expect(detectGamepadStyle(id)).toBe(expected);
    });
  }

  it('does not mistake an Xbox pad for PlayStation because of "Wireless Controller"', () => {
    // Order-dependent: the weak Sony needle must lose to the strong Xbox one.
    expect(detectGamepadStyle('Xbox Wireless Controller')).toBe('xbox');
  });

  it('is case insensitive', () => {
    expect(detectGamepadStyle('DUALSHOCK 4')).toBe('playstation');
    expect(detectGamepadStyle('nintendo switch pro controller')).toBe('nintendo');
  });
});

// ---- Axis sampling -----------------------------------------------------

describe('GamepadSource axis sampling', () => {
  it('maps the left stick to movement with positive Y as forward', () => {
    // Raw axis 1 is negative when the stick is pushed up/forward. (0.6, -0.8)
    // is a real diagonal: magnitude exactly 1, as a physical stick gate gives.
    const { provider } = makeProvider([makePad({ axes: [0.6, -0.8, 0, 0] })]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });
    source.attach();

    const recorder = makeRecorder();
    source.sample(recorder.sink);

    expect(recorder.axes.moveX).toBeCloseTo(0.6, 10);
    expect(recorder.axes.moveY).toBeCloseTo(0.8, 10);
  });

  it('reports full forward travel as moveY 1', () => {
    const { provider } = makeProvider([makePad({ axes: [0, -1, 0, 0] })]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });
    source.attach();

    const recorder = makeRecorder();
    source.sample(recorder.sink);

    expect(recorder.axes.moveY).toBeCloseTo(1, 10);
    expect(recorder.axes.moveX).toBe(0);
  });

  it('clamps a square-gate pad that reports a full diagonal', () => {
    // Some cheap pads report (1, 1) at the corner. Left unclamped that is a
    // 1.41x speed boost for running diagonally.
    const { provider } = makeProvider([makePad({ axes: [1, -1, 0, 0] })]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });
    source.attach();

    const recorder = makeRecorder();
    source.sample(recorder.sink);

    expect(magnitudeOf({ x: recorder.axes.moveX!, y: recorder.axes.moveY! })).toBeCloseTo(1, 10);
    expect(recorder.axes.moveX).toBeCloseTo(recorder.axes.moveY!, 12);
  });

  it('maps the right stick to look with positive Y as up', () => {
    const { provider } = makeProvider([makePad({ axes: [0, 0, 0.5, -0.5] })]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });
    source.attach();

    const recorder = makeRecorder();
    source.sample(recorder.sink);

    expect(recorder.axes.lookX).toBeCloseTo(0.5, 10);
    expect(recorder.axes.lookY).toBeCloseTo(0.5, 10);
  });

  it('inverts only the look Y axis when gamepadInvertY is set', () => {
    const { provider } = makeProvider([makePad({ axes: [0, -1, 0, -1] })]);
    const source = new GamepadSource({
      getTuning: () => makeTuning({ gamepadInvertY: true }),
      provider,
      target: makeTarget(),
    });
    source.attach();

    const recorder = makeRecorder();
    source.sample(recorder.sink);

    expect(recorder.axes.lookY).toBeCloseTo(-1, 10);
    // Movement is not affected by look inversion.
    expect(recorder.axes.moveY).toBeCloseTo(1, 10);
  });

  it('applies sensitivity to look axes only', () => {
    const { provider } = makeProvider([makePad({ axes: [0.5, -0.5, 0.5, -0.5] })]);
    const source = new GamepadSource({
      getTuning: () => makeTuning({ gamepadSensitivity: 2 }),
      provider,
      target: makeTarget(),
    });
    source.attach();

    const recorder = makeRecorder();
    source.sample(recorder.sink);

    // Look is a rate, so sensitivity is allowed to exceed 1.
    expect(recorder.axes.lookX).toBeCloseTo(1, 10);
    expect(recorder.axes.lookY).toBeCloseTo(1, 10);
    // Movement stays normalised regardless of sensitivity.
    expect(recorder.axes.moveX).toBeCloseTo(0.5, 10);
    expect(recorder.axes.moveY).toBeCloseTo(0.5, 10);
  });

  it('leaves a sensitivity-scaled look rate above 1 unclamped', () => {
    // Pinning the documented seam: the driver does not silently discard the
    // top of the sensitivity range. A sink that clamps axes to [-1,1] will
    // flatten this, which is a decision for the wiring layer, not a surprise.
    const { provider } = makeProvider([makePad({ axes: [0, 0, 1, 0] })]);
    const source = new GamepadSource({
      getTuning: () => makeTuning({ gamepadSensitivity: 3 }),
      provider,
      target: makeTarget(),
    });
    source.attach();

    const recorder = makeRecorder();
    source.sample(recorder.sink);

    expect(recorder.axes.lookX).toBeCloseTo(3, 10);
  });

  it('reads sensitivity fresh on every sample so a slider applies immediately', () => {
    const tuning = makeTuning();
    let sensitivity = 1;
    const { provider } = makeProvider([makePad({ axes: [0, 0, 0.5, 0] })]);
    const source = new GamepadSource({
      getTuning: () => ({ ...tuning, gamepadSensitivity: sensitivity }),
      provider,
      target: makeTarget(),
    });
    source.attach();

    const recorder = makeRecorder();
    source.sample(recorder.sink);
    expect(recorder.axes.lookX).toBeCloseTo(0.5, 10);

    sensitivity = 3;
    source.sample(recorder.sink);
    expect(recorder.axes.lookX).toBeCloseTo(1.5, 10);
  });

  it('applies the configured deadzone radially to both sticks', () => {
    const { provider } = makeProvider([makePad({ axes: [0.1, 0.05, 0.1, 0.05] })]);
    const source = new GamepadSource({
      getTuning: () => makeTuning({ gamepadDeadzone: 0.2 }),
      provider,
      target: makeTarget(),
    });
    source.attach();

    const recorder = makeRecorder();
    source.sample(recorder.sink);

    expect(recorder.axes.moveX).toBe(0);
    expect(recorder.axes.moveY).toBe(0);
    expect(recorder.axes.lookX).toBe(0);
    expect(recorder.axes.lookY).toBe(0);
  });

  it('drives movement from the D-pad', () => {
    // Buttons 12 up, 13 down, 14 left, 15 right.
    const { provider, state } = makeProvider([makePad({ buttons: { 12: true } })]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });
    source.attach();

    const recorder = makeRecorder();
    source.sample(recorder.sink);
    expect(recorder.axes.moveY).toBe(1);
    expect(recorder.axes.moveX).toBe(0);

    state.pads = [makePad({ buttons: { 13: true, 14: true } })];
    source.sample(recorder.sink);
    expect(magnitudeOf({ x: recorder.axes.moveX!, y: recorder.axes.moveY! })).toBeCloseTo(1, 10);
    expect(recorder.axes.moveX!).toBeLessThan(0);
    expect(recorder.axes.moveY!).toBeLessThan(0);
  });

  it('bypasses the deadzone for the D-pad, which is digital', () => {
    const { provider } = makeProvider([makePad({ buttons: { 15: true } })]);
    const source = new GamepadSource({
      getTuning: () => makeTuning({ gamepadDeadzone: 0.4 }),
      provider,
      target: makeTarget(),
    });
    source.attach();

    const recorder = makeRecorder();
    source.sample(recorder.sink);

    expect(recorder.axes.moveX).toBe(1);
  });

  it('keeps a combined stick and D-pad push inside the unit circle', () => {
    const { provider } = makeProvider([
      makePad({ axes: [1, -1, 0, 0], buttons: { 12: true, 15: true } }),
    ]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });
    source.attach();

    const recorder = makeRecorder();
    source.sample(recorder.sink);

    const magnitude = magnitudeOf({ x: recorder.axes.moveX!, y: recorder.axes.moveY! });
    expect(magnitude).toBeLessThanOrEqual(1.0000001);
    expect(magnitude).toBeCloseTo(1, 6);
  });

  it('reports zero look on a non-standard pad that exposes only two axes', () => {
    const { provider } = makeProvider([
      makePad({ mapping: '', axes: [0.6, -0.8], buttonCount: 12 }),
    ]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });
    source.attach();

    const recorder = makeRecorder();
    source.sample(recorder.sink);

    expect(recorder.axes.moveX).toBeCloseTo(0.6, 10);
    expect(recorder.axes.moveY).toBeCloseTo(0.8, 10);
    expect(recorder.axes.lookX).toBe(0);
    expect(recorder.axes.lookY).toBe(0);
  });

  it('reads a non-standard D-pad exposed as a hat on axes 6 and 7', () => {
    const { provider } = makeProvider([
      makePad({
        mapping: '',
        // Hat Y is negative-up, matching the sticks.
        axes: [0, 0, 0, 0, 0, 0, -1, -1],
        buttonCount: 12,
      }),
    ]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });
    source.attach();

    const recorder = makeRecorder();
    source.sample(recorder.sink);

    expect(recorder.axes.moveX).toBeLessThan(0);
    expect(recorder.axes.moveY).toBeGreaterThan(0);
  });

  it('does not treat a standard pad as having a hat', () => {
    // A standard pad reports 4 axes, so the hat fallback must never fire.
    const { provider } = makeProvider([makePad({ axes: [0, 0, 0, 0] })]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });
    source.attach();

    const recorder = makeRecorder();
    source.sample(recorder.sink);

    expect(recorder.axes.moveX).toBe(0);
    expect(recorder.axes.moveY).toBe(0);
  });
});

// ---- Button sampling ---------------------------------------------------

describe('GamepadSource button sampling', () => {
  const expectations: readonly [string, number][] = [
    ['jump', 0],
    ['dialogueSelect', 0],
    ['crouch', 1],
    ['cancel', 1],
    ['interact', 2],
    ['scan', 3],
    ['journal', 4],
    ['scan', 5],
    ['toolAlt', 6],
    ['toolAction', 7],
    ['journal', 8],
    ['pause', 9],
    ['sprint', 10],
  ];

  for (const [action, index] of expectations) {
    it(`maps button ${index} to ${action}`, () => {
      const { provider } = makeProvider([makePad({ buttons: { [index]: 1 } })]);
      const source = new GamepadSource({
        getTuning: () => makeTuning(),
        provider,
        target: makeTarget(),
      });
      source.attach();

      const recorder = makeRecorder();
      source.sample(recorder.sink);

      expect(recorder.buttons[action]).toBe(true);
    });
  }

  it('reports every bound action on each sample, pressed or not', () => {
    const { provider } = makeProvider([makePad()]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });
    source.attach();

    const recorder = makeRecorder();
    source.sample(recorder.sink);

    const bound = Object.keys(GAMEPAD_BUTTON_BINDINGS);
    expect(Object.keys(recorder.buttons).sort()).toEqual([...bound].sort());
    for (const action of bound) {
      expect(recorder.buttons[action], action).toBe(false);
    }
  });

  it('leaves unrelated actions unpressed when one button is down', () => {
    const { provider } = makeProvider([makePad({ buttons: { 2: 1 } })]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });
    source.attach();

    const recorder = makeRecorder();
    source.sample(recorder.sink);

    expect(recorder.buttons.interact).toBe(true);
    expect(recorder.buttons.jump).toBe(false);
    expect(recorder.buttons.crouch).toBe(false);
    expect(recorder.buttons.pause).toBe(false);
  });

  it('honours a pad that reports pressed without a value', () => {
    const pad = makePad();
    // Some drivers set the flag and leave value at 0.
    (pad.buttons[2] as unknown as { pressed: boolean; value: number }).pressed = true;
    (pad.buttons[2] as unknown as { pressed: boolean; value: number }).value = 0;
    const { provider } = makeProvider([pad]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });
    source.attach();

    const recorder = makeRecorder();
    source.sample(recorder.sink);

    expect(recorder.buttons.interact).toBe(true);
  });

  it('ignores button indices a cheap pad does not report', () => {
    const { provider } = makeProvider([makePad({ buttonCount: 4, mapping: '' })]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });
    source.attach();

    const recorder = makeRecorder();
    // Must not throw on the missing indices 6-10.
    expect(() => source.sample(recorder.sink)).not.toThrow();
    expect(recorder.buttons.sprint).toBe(false);
    expect(recorder.buttons.toolAction).toBe(false);
  });

  describe('analogue triggers', () => {
    function triggerRig(initial: number) {
      const { provider, state } = makeProvider([makePad({ buttons: { 7: initial } })]);
      const source = new GamepadSource({
        getTuning: () => makeTuning(),
        provider,
        target: makeTarget(),
      });
      source.attach();
      const recorder = makeRecorder();
      const pull = (value: number): void => {
        state.pads = [makePad({ buttons: { 7: value } })];
        source.sample(recorder.sink);
      };
      return { source, recorder, pull };
    }

    it('does not fire below the press threshold', () => {
      const { recorder, pull } = triggerRig(0);
      pull(TRIGGER_PRESS_THRESHOLD - 0.01);
      expect(recorder.buttons.toolAction).toBe(false);
    });

    it('fires at the press threshold', () => {
      const { recorder, pull } = triggerRig(0);
      pull(TRIGGER_PRESS_THRESHOLD);
      expect(recorder.buttons.toolAction).toBe(true);
    });

    it('stays pressed between the release and press thresholds (hysteresis)', () => {
      const { recorder, pull } = triggerRig(0);
      pull(0.9);
      expect(recorder.buttons.toolAction).toBe(true);

      // Below the press threshold but above the release threshold: a single
      // threshold would chatter here and fire the action repeatedly.
      pull((TRIGGER_PRESS_THRESHOLD + TRIGGER_RELEASE_THRESHOLD) / 2);
      expect(recorder.buttons.toolAction).toBe(true);
    });

    it('releases below the release threshold', () => {
      const { recorder, pull } = triggerRig(0);
      pull(0.9);
      pull(TRIGGER_RELEASE_THRESHOLD - 0.01);
      expect(recorder.buttons.toolAction).toBe(false);
    });

    it('exposes the analogue travel of a trigger', () => {
      const { source, pull } = triggerRig(0);
      pull(0.72);
      expect(source.getButtonValue('toolAction')).toBeCloseTo(0.72, 10);
      expect(source.isPressed('toolAction')).toBe(true);
    });

    it('treats the left trigger the same way', () => {
      const { provider, state } = makeProvider([makePad({ buttons: { 6: 0.2 } })]);
      const source = new GamepadSource({
        getTuning: () => makeTuning(),
        provider,
        target: makeTarget(),
      });
      source.attach();
      const recorder = makeRecorder();

      source.sample(recorder.sink);
      expect(recorder.buttons.toolAlt).toBe(false);

      state.pads = [makePad({ buttons: { 6: 0.8 } })];
      source.sample(recorder.sink);
      expect(recorder.buttons.toolAlt).toBe(true);
    });
  });
});

// ---- Connection lifecycle ----------------------------------------------

describe('GamepadSource connection handling', () => {
  it('emits connected when a gamepadconnected event arrives', () => {
    const target = makeTarget();
    const { provider, state } = makeProvider();
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target });
    const events: unknown[] = [];
    source.on('connected', (payload) => events.push(payload));
    source.attach();

    const pad = makePad({ index: 3, id: 'DualSense Wireless Controller' });
    state.pads = [null, null, null, pad];
    dispatchPadEvent(target, 'gamepadconnected', pad);

    expect(events).toEqual([
      {
        index: 3,
        id: 'DualSense Wireless Controller',
        style: 'playstation',
        mapping: 'standard',
        active: true,
      },
    ]);
    expect(source.isConnected).toBe(true);
    expect(source.style).toBe('playstation');
  });

  it('emits activeChanged so glyphs can switch', () => {
    const target = makeTarget();
    const { provider, state } = makeProvider();
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target });
    const events: unknown[] = [];
    source.on('activeChanged', (payload) => events.push(payload));
    source.attach();

    const pad = makePad({ index: 0, id: 'Pro Controller (Vendor: 057e Product: 2009)' });
    state.pads = [pad];
    dispatchPadEvent(target, 'gamepadconnected', pad);

    expect(events).toEqual([
      { index: 0, id: 'Pro Controller (Vendor: 057e Product: 2009)', style: 'nintendo' },
    ]);
  });

  it('discovers a pad that was already plugged in at attach time', () => {
    // Chromium withholds gamepadconnected until the first button press.
    const { provider } = makeProvider([makePad({ id: 'Xbox Wireless Controller' })]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });
    const events: unknown[] = [];
    source.on('connected', (payload) => events.push(payload));

    source.attach();

    expect(events).toHaveLength(1);
    expect(source.style).toBe('xbox');
  });

  it('discovers a pad that appears during sampling without an event', () => {
    const { provider, state } = makeProvider();
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });
    const events: unknown[] = [];
    source.on('connected', (payload) => events.push(payload));
    source.attach();
    expect(events).toHaveLength(0);

    state.pads = [makePad()];
    source.sample(makeRecorder().sink);

    expect(events).toHaveLength(1);
    expect(source.isConnected).toBe(true);
  });

  it('registers a pad exactly once even if the event and the poll both see it', () => {
    const target = makeTarget();
    const pad = makePad();
    const { provider } = makeProvider([pad]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target });
    const events: unknown[] = [];
    source.on('connected', (payload) => events.push(payload));
    source.attach();

    dispatchPadEvent(target, 'gamepadconnected', pad);
    source.sample(makeRecorder().sink);

    expect(events).toHaveLength(1);
    expect(source.getConnectedIndices()).toEqual([0]);
  });

  it('tracks several pads but keeps reading the first one', () => {
    const target = makeTarget();
    const first = makePad({ index: 0, id: 'Xbox Wireless Controller', axes: [1, 0, 0, 0] });
    const second = makePad({ index: 1, id: 'DualShock 4', axes: [-1, 0, 0, 0] });
    const { provider, state } = makeProvider([first]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target });
    source.attach();

    state.pads = [first, second];
    dispatchPadEvent(target, 'gamepadconnected', second);

    expect(source.getConnectedIndices()).toEqual([0, 1]);
    expect(source.style).toBe('xbox');

    const recorder = makeRecorder();
    source.sample(recorder.sink);
    // The second pad pushes the stick the other way; the reading must be the
    // first pad's.
    expect(recorder.axes.moveX).toBeCloseTo(1, 10);
  });

  it('promotes the next pad when the active one disconnects', () => {
    const target = makeTarget();
    const first = makePad({ index: 0, id: 'Xbox Wireless Controller' });
    const second = makePad({ index: 1, id: 'DualShock 4' });
    const { provider, state } = makeProvider([first, second]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target });
    source.attach();
    expect(source.style).toBe('xbox');

    const disconnects: unknown[] = [];
    const actives: unknown[] = [];
    source.on('disconnected', (payload) => disconnects.push(payload));
    source.on('activeChanged', (payload) => actives.push(payload));

    state.pads = [null, second];
    dispatchPadEvent(target, 'gamepaddisconnected', first);

    expect(disconnects).toEqual([{ index: 0, id: 'Xbox Wireless Controller', wasActive: true }]);
    expect(actives).toEqual([{ index: 1, id: 'DualShock 4', style: 'playstation' }]);
    expect(source.style).toBe('playstation');
    expect(source.getConnectedIndices()).toEqual([1]);
  });

  it('does not change the active pad when a spare disconnects', () => {
    const target = makeTarget();
    const first = makePad({ index: 0 });
    const second = makePad({ index: 1, id: 'DualShock 4' });
    const { provider, state } = makeProvider([first, second]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target });
    source.attach();

    const actives: unknown[] = [];
    source.on('activeChanged', (payload) => actives.push(payload));

    state.pads = [first, null];
    dispatchPadEvent(target, 'gamepaddisconnected', second);

    expect(actives).toEqual([]);
    expect(source.getConnectedIndices()).toEqual([0]);
  });

  it('notices a pad that vanishes without a disconnect event', () => {
    const { provider, state } = makeProvider([makePad()]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });
    source.attach();
    const disconnects: unknown[] = [];
    source.on('disconnected', (payload) => disconnects.push(payload));

    state.pads = [];
    source.sample(makeRecorder().sink);

    expect(disconnects).toHaveLength(1);
    expect(source.isConnected).toBe(false);
  });

  it('pushes one neutral frame after the pad is lost, then goes quiet', () => {
    // Otherwise the sink keeps the last gamepad values and the player keeps
    // walking after the batteries die.
    const { provider, state } = makeProvider([makePad({ axes: [1, 0, 0, 0], buttons: { 0: 1 } })]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });
    source.attach();

    const recorder = makeRecorder();
    source.sample(recorder.sink);
    expect(recorder.axes.moveX).toBeCloseTo(1, 10);
    expect(recorder.buttons.jump).toBe(true);

    state.pads = [];
    recorder.resetCounts();
    source.sample(recorder.sink);

    expect(recorder.axes.moveX).toBe(0);
    expect(recorder.axes.moveY).toBe(0);
    expect(recorder.axes.lookX).toBe(0);
    expect(recorder.axes.lookY).toBe(0);
    expect(recorder.buttons.jump).toBe(false);
    expect(recorder.totalCalls).toBeGreaterThan(0);

    recorder.resetCounts();
    source.sample(recorder.sink);
    // Silence now: a disconnected pad must not stomp the keyboard or touch
    // families every frame.
    expect(recorder.totalCalls).toBe(0);
  });

  it('emits nothing at all when no pad has ever been connected', () => {
    const { provider } = makeProvider([]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });
    source.attach();

    const recorder = makeRecorder();
    source.sample(recorder.sink);

    expect(recorder.totalCalls).toBe(0);
  });

  it('ignores a connect event with no gamepad payload', () => {
    const target = makeTarget();
    const { provider } = makeProvider();
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target });
    source.attach();

    expect(() => dispatchPadEvent(target, 'gamepadconnected', null)).not.toThrow();
    expect(source.isConnected).toBe(false);
  });

  it('reports active pad details for the diagnostics overlay', () => {
    const { provider } = makeProvider([
      makePad({ index: 2, id: 'DualSense Wireless Controller', axes: [0, 0, 0, 0] }),
    ]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });
    source.attach();

    expect(source.getActiveInfo()).toEqual({
      index: 2,
      id: 'DualSense Wireless Controller',
      mapping: 'standard',
      style: 'playstation',
      axisCount: 4,
      buttonCount: 17,
      hapticsSupported: false,
    });
    expect(source.getStatus()).toEqual({
      attached: true,
      connectedCount: 1,
      activeIndex: 2,
      style: 'playstation',
      hapticsFailed: false,
    });
  });

  it('returns no active info when nothing is connected', () => {
    const { provider } = makeProvider([]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });
    source.attach();
    expect(source.getActiveInfo()).toBeNull();
    expect(source.style).toBe('generic');
  });

  it('survives a provider that throws, as a blocked iframe would', () => {
    const provider: GamepadProvider = {
      getGamepads: () => {
        throw new DOMException('blocked by Permissions-Policy');
      },
    };
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });

    expect(() => source.attach()).not.toThrow();
    expect(() => source.sample(makeRecorder().sink)).not.toThrow();
    expect(source.isConnected).toBe(false);
  });
});

// ---- Default provider --------------------------------------------------

describe('GamepadSource default provider', () => {
  afterEach(() => {
    delete (navigator as unknown as Record<string, unknown>).getGamepads;
  });

  it('reads navigator.getGamepads when no provider is injected', () => {
    const pad = makePad({ id: 'Xbox Wireless Controller' });
    const getGamepads = vi.fn(() => [pad]);
    Object.defineProperty(navigator, 'getGamepads', { value: getGamepads, configurable: true });

    const source = new GamepadSource({ getTuning: () => makeTuning(), target: makeTarget() });
    source.attach();

    expect(getGamepads).toHaveBeenCalled();
    expect(source.style).toBe('xbox');
  });

  it('degrades to no controller when the API is absent', () => {
    // jsdom has no getGamepads, which is also the state of older browsers.
    const source = new GamepadSource({ getTuning: () => makeTuning(), target: makeTarget() });
    source.attach();

    expect(source.isConnected).toBe(false);
    expect(() => source.sample(makeRecorder().sink)).not.toThrow();
  });
});

// ---- Haptics -----------------------------------------------------------

describe('GamepadSource.vibrate', () => {
  function hapticRig(actuator: unknown, tuning: Partial<GamepadTuning> = {}) {
    const { provider } = makeProvider([makePad({ vibrationActuator: actuator })]);
    const source = new GamepadSource({
      getTuning: () => makeTuning(tuning),
      provider,
      target: makeTarget(),
    });
    source.attach();
    return source;
  }

  it('plays a dual-rumble effect with clamped parameters', () => {
    const playEffect = vi.fn(() => Promise.resolve('complete'));
    const source = hapticRig({ playEffect });

    expect(source.vibrate(120, 0.8, 0.3)).toBe(true);
    expect(playEffect).toHaveBeenCalledWith('dual-rumble', {
      startDelay: 0,
      duration: 120,
      strongMagnitude: 0.8,
      weakMagnitude: 0.3,
    });
  });

  it('clamps magnitudes and duration to legal ranges', () => {
    const playEffect = vi.fn(() => Promise.resolve('complete'));
    const source = hapticRig({ playEffect });

    source.vibrate(999999, 5, -2);

    expect(playEffect).toHaveBeenCalledWith('dual-rumble', {
      startDelay: 0,
      duration: 5000,
      strongMagnitude: 1,
      weakMagnitude: 0,
    });
  });

  it('is a no-op when the pad has no vibration actuator', () => {
    const source = hapticRig(null);
    expect(() => source.vibrate(100)).not.toThrow();
    expect(source.vibrate(100)).toBe(false);
    expect(source.isHapticsSupported()).toBe(false);
  });

  it('is a no-op when the actuator cannot play effects', () => {
    // Older implementations exposed only `pulse`.
    const source = hapticRig({ pulse: () => undefined });
    expect(source.vibrate(100)).toBe(false);
    expect(source.isHapticsSupported()).toBe(false);
  });

  it('is a no-op when the player turned haptics off', () => {
    const playEffect = vi.fn(() => Promise.resolve('complete'));
    const source = hapticRig({ playEffect }, { gamepadHaptics: false });

    expect(source.vibrate(100)).toBe(false);
    expect(playEffect).not.toHaveBeenCalled();
    expect(source.isHapticsSupported()).toBe(false);
  });

  it('is a no-op when no pad is connected', () => {
    const { provider } = makeProvider([]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });
    source.attach();
    expect(source.vibrate(100)).toBe(false);
  });

  it('is a no-op before attach', () => {
    const playEffect = vi.fn(() => Promise.resolve('complete'));
    const { provider } = makeProvider([makePad({ vibrationActuator: { playEffect } })]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });

    expect(source.vibrate(100)).toBe(false);
    expect(playEffect).not.toHaveBeenCalled();
  });

  it('is a no-op for a zero or negative duration', () => {
    const playEffect = vi.fn(() => Promise.resolve('complete'));
    const source = hapticRig({ playEffect });

    expect(source.vibrate(0)).toBe(false);
    expect(source.vibrate(-50)).toBe(false);
    expect(playEffect).not.toHaveBeenCalled();
  });

  it('does not throw when playEffect throws synchronously', () => {
    const source = hapticRig({
      playEffect: () => {
        throw new TypeError('unsupported effect type');
      },
    });

    expect(() => source.vibrate(100)).not.toThrow();
    expect(source.vibrate(100)).toBe(false);
    expect(source.getStatus().hapticsFailed).toBe(true);
  });

  it('swallows a rejected playEffect promise instead of leaking an unhandled rejection', async () => {
    const source = hapticRig({ playEffect: () => Promise.reject(new Error('not supported')) });
    const onRejection = vi.fn();
    process.on('unhandledRejection', onRejection);

    expect(source.vibrate(100)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    process.off('unhandledRejection', onRejection);
    expect(onRejection).not.toHaveBeenCalled();
    expect(source.getStatus().hapticsFailed).toBe(true);
  });

  it('tolerates an actuator whose playEffect returns undefined', () => {
    const source = hapticRig({ playEffect: () => undefined });
    expect(source.vibrate(100)).toBe(true);
  });

  it('reports haptics support when the pad can rumble', () => {
    const source = hapticRig({ playEffect: () => Promise.resolve('complete') });
    expect(source.isHapticsSupported()).toBe(true);
  });

  it('resets the actuator on stopVibration and on detach', () => {
    const reset = vi.fn(() => Promise.resolve('complete'));
    const source = hapticRig({ playEffect: () => Promise.resolve('complete'), reset });

    source.stopVibration();
    expect(reset).toHaveBeenCalledTimes(1);

    source.detach();
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it('does not throw on stopVibration without an actuator', () => {
    const source = hapticRig(null);
    expect(() => source.stopVibration()).not.toThrow();
  });
});

// ---- attach / detach ---------------------------------------------------

describe('GamepadSource attach and detach', () => {
  it('subscribes to both connection events and removes both on detach', () => {
    const target = makeTarget();
    const add = vi.spyOn(target, 'addEventListener');
    const remove = vi.spyOn(target, 'removeEventListener');
    const { provider } = makeProvider();
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target });

    source.attach();
    expect(add.mock.calls.map((call) => call[0]).sort()).toEqual([
      'gamepadconnected',
      'gamepaddisconnected',
    ]);

    source.detach();
    expect(remove.mock.calls.map((call) => call[0]).sort()).toEqual([
      'gamepadconnected',
      'gamepaddisconnected',
    ]);
    // Same handler references, or the removal silently does nothing.
    for (const [type, handler] of remove.mock.calls) {
      const added = add.mock.calls.find((call) => call[0] === type);
      expect(handler).toBe(added?.[1]);
    }
  });

  it('does not double-subscribe on a repeated attach', () => {
    const target = makeTarget();
    const add = vi.spyOn(target, 'addEventListener');
    const { provider } = makeProvider();
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target });

    source.attach();
    source.attach();

    expect(add).toHaveBeenCalledTimes(2);
  });

  it('emits nothing before attach', () => {
    const { provider } = makeProvider([makePad({ axes: [1, 0, 0, 0] })]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });

    const recorder = makeRecorder();
    source.sample(recorder.sink);

    expect(recorder.totalCalls).toBe(0);
    expect(source.isAttached).toBe(false);
  });

  it('emits nothing and forgets its pads after detach', () => {
    const { provider } = makeProvider([makePad({ axes: [1, 0, 0, 0] })]);
    const target = makeTarget();
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target });
    source.attach();
    source.sample(makeRecorder().sink);
    expect(source.isConnected).toBe(true);

    source.detach();

    const recorder = makeRecorder();
    source.sample(recorder.sink);

    expect(recorder.totalCalls).toBe(0);
    expect(source.isConnected).toBe(false);
    expect(source.getConnectedIndices()).toEqual([]);
    expect(source.style).toBe('generic');
    expect(source.getStatus().attached).toBe(false);
  });

  it('stops reacting to connection events after detach', () => {
    const target = makeTarget();
    const { provider, state } = makeProvider();
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target });
    const events: unknown[] = [];
    source.on('connected', (payload) => events.push(payload));

    source.attach();
    source.detach();

    const pad = makePad();
    state.pads = [pad];
    dispatchPadEvent(target, 'gamepadconnected', pad);

    expect(events).toEqual([]);
  });

  it('clears stale axis readings on detach', () => {
    const { provider } = makeProvider([makePad({ axes: [1, 0, 0, 0] })]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });
    source.attach();
    source.sample(makeRecorder().sink);
    expect(source.getAxis('moveX')).toBeCloseTo(1, 10);

    source.detach();

    expect(source.getAxis('moveX')).toBe(0);
    expect(source.isPressed('jump')).toBe(false);
  });

  it('can be re-attached and rediscovers the pad', () => {
    const { provider } = makeProvider([makePad()]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });

    source.attach();
    source.detach();
    source.attach();

    expect(source.isConnected).toBe(true);

    // Emitter subscriptions survive detach, so a re-attach keeps reporting:
    // detach announces the pad is gone, attach announces it is back.
    const events: { index: number | null; style: string }[] = [];
    source.on('activeChanged', (payload) => events.push({ index: payload.index, style: payload.style }));
    source.detach();
    source.attach();

    expect(events).toEqual([
      { index: null, style: 'generic' },
      { index: 0, style: 'xbox' },
    ]);
  });

  it('drops emitter subscriptions on dispose', () => {
    const { provider } = makeProvider([makePad()]);
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });
    source.attach();
    const events: unknown[] = [];
    source.on('connected', (payload) => events.push(payload));

    source.dispose();
    source.attach();

    expect(events).toEqual([]);
  });

  it('is safe to detach without attaching', () => {
    const { provider } = makeProvider();
    const source = new GamepadSource({ getTuning: () => makeTuning(), provider, target: makeTarget() });
    expect(() => source.detach()).not.toThrow();
  });
});

// ---- Settings compatibility -------------------------------------------

describe('settings compatibility', () => {
  it('accepts ControlsSettings directly as its tuning source', () => {
    // Compile-time proof that the engine-side structural interface matches the
    // persisted schema; if a field is renamed, typecheck fails here.
    const controls = createDefaultSettings().controls;
    const tuning: GamepadTuning = controls;

    expect(tuning.gamepadDeadzone).toBe(0.12);
    expect(tuning.gamepadSensitivity).toBe(1);
    expect(tuning.gamepadInvertY).toBe(false);
    expect(tuning.gamepadHaptics).toBe(true);
  });

  it('works end to end with the real default controls settings', () => {
    const controls = createDefaultSettings().controls;
    const { provider } = makeProvider([makePad({ axes: [0.05, 0.05, 1, 0] })]);
    const source = new GamepadSource({ getTuning: () => controls, provider, target: makeTarget() });
    source.attach();

    const recorder = makeRecorder();
    source.sample(recorder.sink);

    // 0.07 magnitude is inside the 0.12 default deadzone.
    expect(recorder.axes.moveX).toBe(0);
    expect(recorder.axes.lookX).toBeCloseTo(1, 10);
  });
});

// ---- Bindings sanity ---------------------------------------------------

describe('button bindings', () => {
  it('binds every action the controls schema expects to be rebindable', () => {
    const bound = new Set(Object.keys(GAMEPAD_BUTTON_BINDINGS));
    for (const action of [
      'interact',
      'sprint',
      'crouch',
      'jump',
      'toolAction',
      'toolAlt',
      'scan',
      'pause',
      'journal',
      'cancel',
      'dialogueSelect',
    ]) {
      expect(bound.has(action), action).toBe(true);
    }
  });

  it('binds only indices that exist in the standard mapping', () => {
    for (const [action, indices] of Object.entries(GAMEPAD_BUTTON_BINDINGS)) {
      expect(indices.length, action).toBeGreaterThan(0);
      for (const index of indices) {
        expect(Number.isInteger(index), action).toBe(true);
        expect(index, action).toBeGreaterThanOrEqual(0);
        expect(index, action).toBeLessThanOrEqual(16);
      }
    }
  });

  it('keeps the press threshold above the release threshold', () => {
    expect(TRIGGER_PRESS_THRESHOLD).toBeGreaterThan(TRIGGER_RELEASE_THRESHOLD);
  });

  it('reports the gamepad family so a caller can bind it once', () => {
    expect(GAMEPAD_FAMILY).toBe('gamepad');
  });
});

// ---- Helpers ----------------------------------------------------------

function magnitudeOf(vector: { x: number; y: number }): number {
  return Math.hypot(vector.x, vector.y);
}
