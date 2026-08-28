/**
 * Touch input source tests.
 *
 * Real `PointerEvent` objects are dispatched — jsdom 30 implements the
 * constructor and populates `pointerId`, `pointerType`, `clientX` and
 * `clientY`, so no polyfill is needed here. (It does *not* implement
 * `setPointerCapture`, which is why the source listens for move/up/cancel on
 * the shared target instead of capturing.) Events go through the DOM rather
 * than into the handlers directly, so listener registration, the surface/window
 * split, `preventDefault` and detach are all exercised the way a browser does
 * it.
 *
 * The viewport and safe area are injected rather than measured: jsdom's
 * `getBoundingClientRect` returns zeros, and a test that silently fell back to
 * a 1280x720 default would be asserting against numbers nobody chose.
 *
 * Two tests exist purely to prove pointers are never stolen — a thumb that
 * started on the joystick must not become a camera drag, and a button press
 * must produce exactly zero camera motion. Those are the bugs that make a
 * mobile port unplayable, and they are invisible to static review.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TouchSource,
  applyRadialDeadzone,
  DEFAULT_TOUCH_CONTROLS,
  TOUCH_FAMILY,
  TOUCH_LOOK_RADIANS_PER_PIXEL,
  type TouchControlState,
  type TouchInputSink,
  type TouchTuning,
} from '../../src/engine/input/TouchSource';
import { createDefaultSettings, type TouchSettings } from '../../src/persistence/settingsSchema';

// ---- Fixtures -----------------------------------------------------------

/** Landscape phone-ish. Chosen so the viewport scale is exactly 1. */
const VIEWPORT = { width: 800, height: 400 };

/**
 * Records what the source wrote.
 *
 * Reads throw when an action was never written: a sample that silently forgets
 * to report `interact` is a bug, not a pass.
 */
class RecordingSink implements TouchInputSink {
  readonly axes = new Map<string, number>();
  readonly buttons = new Map<string, boolean>();
  readonly pulses: string[] = [];

  setAxis(action: string, value: number): void {
    this.axes.set(action, value);
  }

  setButton(action: string, down: boolean): void {
    this.buttons.set(action, down);
  }

  pulseButton(action: string): void {
    this.pulses.push(action);
  }

  axis(name: string): number {
    const value = this.axes.get(name);
    if (value === undefined) throw new Error(`axis "${name}" was never written by sample()`);
    return value;
  }

  button(name: string): boolean {
    const value = this.buttons.get(name);
    if (value === undefined) throw new Error(`button "${name}" was never written by sample()`);
    return value;
  }
}

/** A sink with no pulse support, to exercise the one-sample-hold fallback. */
class PulselessSink {
  readonly buttons = new Map<string, boolean>();
  setAxis(): void {
    /* axes are irrelevant to the fallback path */
  }
  setButton(action: string, down: boolean): void {
    this.buttons.set(action, down);
  }
}

let surface: HTMLDivElement;
let source: TouchSource;
let tuning: TouchTuning;

/**
 * Base tuning is the real shipped default, which also proves `TouchSettings`
 * satisfies `TouchTuning` structurally — the engine declares the shape it needs
 * instead of importing the persistence type.
 */
function defaultTouchSettings(): TouchSettings {
  return createDefaultSettings().controls.touch;
}

function makeSource(patch: Partial<TouchTuning> = {}, options: { allowMouse?: boolean } = {}) {
  tuning = { ...defaultTouchSettings(), ...patch };
  const created = new TouchSource({
    getTuning: () => tuning,
    surface,
    getViewport: () => VIEWPORT,
    getSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
    allowMouse: options.allowMouse === true,
  });
  created.attach();
  return created;
}

function pointerEvent(
  type: string,
  pointerId: number,
  x: number,
  y: number,
  pointerType = 'touch',
): PointerEvent {
  return new PointerEvent(type, {
    pointerId,
    pointerType,
    clientX: x,
    clientY: y,
    cancelable: true,
    bubbles: true,
  });
}

/** `pointerdown` lands on the surface, exactly as the browser delivers it. */
function down(pointerId: number, x: number, y: number, pointerType = 'touch'): PointerEvent {
  const event = pointerEvent('pointerdown', pointerId, x, y, pointerType);
  surface.dispatchEvent(event);
  return event;
}

/** Move/up/cancel land on window: a thumb may leave the canvas mid-drag. */
function move(pointerId: number, x: number, y: number): PointerEvent {
  const event = pointerEvent('pointermove', pointerId, x, y);
  window.dispatchEvent(event);
  return event;
}

function up(pointerId: number, x: number, y: number): PointerEvent {
  const event = pointerEvent('pointerup', pointerId, x, y);
  window.dispatchEvent(event);
  return event;
}

function cancel(pointerId: number, x: number, y: number): PointerEvent {
  const event = pointerEvent('pointercancel', pointerId, x, y);
  window.dispatchEvent(event);
  return event;
}

function sample(): RecordingSink {
  const sink = new RecordingSink();
  source.sample(sink);
  return sink;
}

function control(id: string): TouchControlState {
  const found = source.getControls().find((entry) => entry.id === id);
  if (!found) throw new Error(`control "${id}" is not present in context "${source.context}"`);
  return found;
}

function centre(id: string): { x: number; y: number } {
  const rect = control(id).rect;
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * Asserts a point is not inside any button's hit circle.
 *
 * Used before treating a point as "empty look area". Without it, a test that
 * claims to drive the camera could be silently pressing `sprint` instead, and
 * would keep passing after the layout moved.
 */
function expectNoButtonAt(x: number, y: number): void {
  for (const entry of source.getControls()) {
    if (entry.kind !== 'button') continue;
    const cx = entry.rect.x + entry.rect.width / 2;
    const cy = entry.rect.y + entry.rect.height / 2;
    const distance = Math.hypot(x - cx, y - cy);
    // Generous margin: comfortably outside the padded hit radius.
    expect(distance, `(${x},${y}) is inside the "${entry.id}" button`).toBeGreaterThan(
      entry.radius + 24,
    );
  }
}

function angleOf(x: number, y: number): number {
  return Math.atan2(y, x);
}

beforeEach(() => {
  surface = document.createElement('div');
  document.body.appendChild(surface);
});

afterEach(() => {
  source?.dispose();
  surface.remove();
});

// ---- Radial deadzone ----------------------------------------------------

describe('applyRadialDeadzone', () => {
  it('zeroes input inside the deadzone', () => {
    expect(applyRadialDeadzone(0.1, 0.1, 0.2)).toEqual({ x: 0, y: 0 });
  });

  it('rescales magnitude from the deadzone edge to full deflection', () => {
    // |(0.3, 0.4)| = 0.5 -> (0.5 - 0.2) / 0.8 = 0.375
    const result = applyRadialDeadzone(0.3, 0.4, 0.2);
    expect(Math.hypot(result.x, result.y)).toBeCloseTo(0.375, 10);
    expect(result.x).toBeCloseTo(0.225, 10);
    expect(result.y).toBeCloseTo(0.3, 10);
  });

  it('preserves direction exactly', () => {
    for (const angle of [0.1, 0.7, 1.9, 2.9, -1.2, -2.6]) {
      const x = Math.cos(angle) * 0.6;
      const y = Math.sin(angle) * 0.6;
      const result = applyRadialDeadzone(x, y, 0.25);
      expect(angleOf(result.x, result.y)).toBeCloseTo(angle, 10);
    }
  });

  it('does not zero an axis that is individually smaller than the deadzone', () => {
    // The per-axis alternative would zero x here and snap movement to straight
    // forward. This assertion is the whole reason the deadzone is radial.
    const result = applyRadialDeadzone(0.1, 0.5, 0.2);
    expect(result.x).not.toBe(0);
    expect(result.x).toBeGreaterThan(0);
    expect(angleOf(result.x, result.y)).toBeCloseTo(angleOf(0.1, 0.5), 10);
  });

  it('clamps a thumb dragged beyond the ring to unit magnitude', () => {
    const result = applyRadialDeadzone(3, 4, 0.1); // magnitude 5
    expect(Math.hypot(result.x, result.y)).toBeCloseTo(1, 10);
    expect(angleOf(result.x, result.y)).toBeCloseTo(angleOf(3, 4), 10);
  });
});

// ---- Joystick -----------------------------------------------------------

describe('TouchSource movement joystick', () => {
  it('reports full deflection at the ring edge, with screen-up as forward', () => {
    source = makeSource({ joystickDeadzone: 0 });
    const stick = control('moveStick');
    const origin = centre('moveStick');

    down(1, origin.x, origin.y);
    expect(sample().axis('moveX')).toBe(0);

    move(1, origin.x + stick.radius, origin.y);
    let sink = sample();
    expect(sink.axis('moveX')).toBeCloseTo(1, 10);
    expect(sink.axis('moveY')).toBeCloseTo(0, 10);

    move(1, origin.x, origin.y - stick.radius);
    sink = sample();
    expect(sink.axis('moveY')).toBeCloseTo(1, 10);
    expect(sink.axis('moveX')).toBeCloseTo(0, 10);

    move(1, origin.x, origin.y + stick.radius);
    expect(sample().axis('moveY')).toBeCloseTo(-1, 10);
  });

  it('applies the configured radial deadzone without bending the direction', () => {
    source = makeSource({ joystickDeadzone: 0.3 });
    const stick = control('moveStick');
    const origin = centre('moveStick');

    down(1, origin.x, origin.y);

    // Half a radius out on a 30-degree diagonal: inside nothing per-axis would
    // survive, but the radial deadzone keeps the angle.
    const angle = Math.PI / 6;
    const distance = stick.radius * 0.5;
    move(1, origin.x + Math.cos(angle) * distance, origin.y - Math.sin(angle) * distance);

    const sink = sample();
    const magnitude = Math.hypot(sink.axis('moveX'), sink.axis('moveY'));
    // (0.5 - 0.3) / 0.7
    expect(magnitude).toBeCloseTo(0.2857142857, 6);
    expect(angleOf(sink.axis('moveX'), sink.axis('moveY'))).toBeCloseTo(angle, 6);
  });

  it('clamps a drag past the ring to unit magnitude', () => {
    source = makeSource({ joystickDeadzone: 0 });
    const stick = control('moveStick');
    const origin = centre('moveStick');
    down(1, origin.x, origin.y);
    move(1, origin.x + stick.radius * 4, origin.y - stick.radius * 4);

    const sink = sample();
    expect(Math.hypot(sink.axis('moveX'), sink.axis('moveY'))).toBeCloseTo(1, 10);
  });

  it('honours joystickSize when sizing the ring', () => {
    source = makeSource({ joystickSize: 1.5 });
    const large = control('moveStick').radius;
    tuning = { ...tuning, joystickSize: 1 };
    const normal = control('moveStick').radius;
    expect(large).toBeCloseTo(normal * 1.5, 6);
  });

  it('zeroes movement when the thumb lifts', () => {
    source = makeSource({ joystickDeadzone: 0 });
    const stick = control('moveStick');
    const origin = centre('moveStick');
    down(1, origin.x, origin.y);
    move(1, origin.x + stick.radius, origin.y);
    expect(sample().axis('moveX')).toBeCloseTo(1, 10);

    up(1, origin.x + stick.radius, origin.y);
    const sink = sample();
    expect(sink.axis('moveX')).toBe(0);
    expect(sink.axis('moveY')).toBe(0);
    expect(source.activePointerCount).toBe(0);
  });
});

describe('TouchSource joystick mode', () => {
  it('fixed mode deflects immediately from the anchored centre', () => {
    source = makeSource({ joystickMode: 'fixed', joystickDeadzone: 0 });
    const stick = control('moveStick');
    const origin = centre('moveStick');

    down(1, origin.x + stick.radius, origin.y);

    const sink = sample();
    expect(sink.axis('moveX')).toBeCloseTo(1, 10);
    // The drawn ring stays where it was anchored.
    expect(centre('moveStick')).toEqual(origin);
  });

  it('floating mode spawns under the thumb and starts neutral', () => {
    source = makeSource({ joystickMode: 'floating', joystickDeadzone: 0 });
    const stick = control('moveStick');
    const anchored = centre('moveStick');
    const touchX = anchored.x + stick.radius;
    const touchY = anchored.y - 20;

    down(1, touchX, touchY);

    let sink = sample();
    expect(sink.axis('moveX')).toBe(0);
    expect(sink.axis('moveY')).toBe(0);

    // The ring follows the thumb so the HUD draws it where the finger is.
    const spawned = centre('moveStick');
    expect(spawned.x).toBeCloseTo(touchX, 6);
    expect(spawned.y).toBeCloseTo(touchY, 6);

    move(1, touchX + stick.radius, touchY);
    sink = sample();
    expect(sink.axis('moveX')).toBeCloseTo(1, 10);

    // Lifting returns the ring to its anchored home.
    up(1, touchX + stick.radius, touchY);
    expect(centre('moveStick').x).toBeCloseTo(anchored.x, 6);
  });
});

// ---- Camera -----------------------------------------------------------

describe('TouchSource drag-to-look', () => {
  function lookPoint(): { x: number; y: number } {
    const zone = source.getRegions().look;
    if (!zone) throw new Error('no look region in this context');
    // Upper middle of the look half: away from the bottom-right button cluster.
    const point = { x: zone.x + zone.width * 0.35, y: zone.y + zone.height * 0.28 };
    expectNoButtonAt(point.x, point.y);
    return point;
  }

  it('produces no delta on touchdown, then a scaled delta on drag', () => {
    source = makeSource({ cameraSensitivity: 1 });
    const start = lookPoint();

    down(2, start.x, start.y);
    let sink = sample();
    expect(sink.axis('lookX')).toBe(0);
    expect(sink.axis('lookY')).toBe(0);

    move(2, start.x + 40, start.y - 25);
    sink = sample();
    expect(sink.axis('lookX')).toBeCloseTo(40 * TOUCH_LOOK_RADIANS_PER_PIXEL, 10);
    // Dragging up looks up: lookY is positive upward, clientY grows downward.
    expect(sink.axis('lookY')).toBeCloseTo(25 * TOUCH_LOOK_RADIANS_PER_PIXEL, 10);
  });

  it('consumes the delta so one drag cannot turn the camera twice', () => {
    source = makeSource();
    const start = lookPoint();
    down(2, start.x, start.y);
    move(2, start.x + 30, start.y);

    expect(sample().axis('lookX')).toBeCloseTo(30 * TOUCH_LOOK_RADIANS_PER_PIXEL, 10);
    const second = sample();
    expect(second.axis('lookX')).toBe(0);
    expect(second.axis('lookY')).toBe(0);
  });

  it('scales by cameraSensitivity', () => {
    source = makeSource({ cameraSensitivity: 2.5 });
    const start = lookPoint();
    down(2, start.x, start.y);
    move(2, start.x + 20, start.y);
    expect(sample().axis('lookX')).toBeCloseTo(20 * TOUCH_LOOK_RADIANS_PER_PIXEL * 2.5, 10);
  });

  it('uses aimSensitivity while aiming', () => {
    source = makeSource({ cameraSensitivity: 2, aimSensitivity: 0.5 });
    source.setAiming(true);
    expect(source.isAiming).toBe(true);

    const start = lookPoint();
    down(2, start.x, start.y);
    move(2, start.x + 20, start.y);
    expect(sample().axis('lookX')).toBeCloseTo(20 * TOUCH_LOOK_RADIANS_PER_PIXEL * 0.5, 10);
  });

  it('honours invertY on the pitch axis only', () => {
    source = makeSource({ invertY: true });
    const start = lookPoint();
    down(2, start.x, start.y);
    move(2, start.x + 10, start.y - 30);

    const sink = sample();
    expect(sink.axis('lookX')).toBeCloseTo(10 * TOUCH_LOOK_RADIANS_PER_PIXEL, 10);
    expect(sink.axis('lookY')).toBeCloseTo(-30 * TOUCH_LOOK_RADIANS_PER_PIXEL, 10);
  });

  it('exposes the sampled delta in radians for the camera', () => {
    source = makeSource();
    const start = lookPoint();
    down(2, start.x, start.y);
    move(2, start.x + 15, start.y);
    sample();
    expect(source.lookDeltaRadians.x).toBeCloseTo(15 * TOUCH_LOOK_RADIANS_PER_PIXEL, 10);
    // Reading does not consume it.
    expect(source.lookDeltaRadians.x).toBeCloseTo(15 * TOUCH_LOOK_RADIANS_PER_PIXEL, 10);
  });
});

// ---- Multi-touch ------------------------------------------------------

describe('TouchSource multi-touch', () => {
  it('drives movement, camera and a button from three concurrent pointers', () => {
    source = makeSource({ joystickDeadzone: 0 });

    const stick = control('moveStick');
    const stickOrigin = centre('moveStick');
    const lookZone = source.getRegions().look;
    if (!lookZone) throw new Error('no look region');
    const lookStart = { x: lookZone.x + lookZone.width * 0.3, y: lookZone.y + lookZone.height * 0.2 };
    expectNoButtonAt(lookStart.x, lookStart.y);
    const button = centre('interact');

    // Left thumb on the stick, right thumb dragging the camera, and a third
    // contact on the interact button — all live at the same time.
    down(1, stickOrigin.x, stickOrigin.y);
    down(2, lookStart.x, lookStart.y);
    down(3, button.x, button.y);

    expect(source.activePointerCount).toBe(3);
    const kinds = source
      .getActiveClaims()
      .map((claim) => `${claim.pointerId}:${claim.kind}:${claim.controlId}`)
      .sort();
    expect(kinds).toEqual(['1:stick:moveStick', '2:look:lookArea', '3:button:interact']);

    move(1, stickOrigin.x, stickOrigin.y - stick.radius);
    move(2, lookStart.x + 50, lookStart.y);
    // The button contact wobbles, as a real thumb does.
    move(3, button.x + 3, button.y + 2);

    const sink = sample();
    expect(sink.axis('moveY')).toBeCloseTo(1, 10);
    expect(sink.axis('moveX')).toBeCloseTo(0, 10);
    expect(sink.axis('lookX')).toBeCloseTo(50 * TOUCH_LOOK_RADIANS_PER_PIXEL, 10);
    expect(sink.button('interact')).toBe(true);
    expect(source.isControlPressed('interact')).toBe(true);

    // And each contact releases independently.
    up(3, button.x, button.y);
    const afterButton = sample();
    expect(afterButton.button('interact')).toBe(false);
    expect(afterButton.axis('moveY')).toBeCloseTo(1, 10);
    expect(source.activePointerCount).toBe(2);
  });

  it('keeps a joystick pointer that slides into the camera region', () => {
    source = makeSource({ joystickDeadzone: 0 });
    const stickOrigin = centre('moveStick');
    const lookZone = source.getRegions().look;
    const stickZone = source.getRegions().stick;
    if (!lookZone || !stickZone) throw new Error('missing regions');

    down(1, stickOrigin.x, stickOrigin.y);
    // Well past the region boundary and into the look half.
    const farX = lookZone.x + lookZone.width * 0.5;
    expect(farX).toBeGreaterThan(stickZone.x + stickZone.width);
    move(1, farX, stickOrigin.y);

    const sink = sample();
    expect(sink.axis('lookX')).toBe(0);
    expect(sink.axis('lookY')).toBe(0);
    // Still steering, at full deflection because it was dragged past the ring.
    expect(sink.axis('moveX')).toBeCloseTo(1, 10);
    expect(source.getActiveClaims()[0]?.kind).toBe('stick');
  });

  it('does not let a second joystick-region contact become a camera drag', () => {
    source = makeSource({ joystickDeadzone: 0 });
    const stickOrigin = centre('moveStick');
    const stickZone = source.getRegions().stick;
    if (!stickZone) throw new Error('no stick region');

    down(1, stickOrigin.x, stickOrigin.y);
    down(4, stickZone.x + 10, stickZone.y + 10);
    expect(source.activePointerCount).toBe(1);

    move(4, stickZone.x + 120, stickZone.y + 120);
    const sink = sample();
    expect(sink.axis('lookX')).toBe(0);
    expect(sink.axis('moveX')).toBe(0);
  });

  it('produces zero camera motion from a button press inside the look region', () => {
    source = makeSource();
    const lookZone = source.getRegions().look;
    const button = centre('interact');
    if (!lookZone) throw new Error('no look region');

    // The assertion only means something if the button really does sit inside
    // the camera region, which is how the layout is authored.
    expect(button.x).toBeGreaterThan(lookZone.x);
    expect(button.x).toBeLessThan(lookZone.x + lookZone.width);

    down(3, button.x, button.y);
    move(3, button.x + 80, button.y - 60);
    move(3, button.x + 160, button.y - 120);

    const sink = sample();
    expect(sink.axis('lookX')).toBe(0);
    expect(sink.axis('lookY')).toBe(0);
    expect(source.lookDeltaRadians).toEqual({ x: 0, y: 0 });
    expect(sink.button('interact')).toBe(true);
  });

  it('swallows a second contact on an already-held button', () => {
    source = makeSource();
    const button = centre('interact');
    down(3, button.x, button.y);
    down(5, button.x + 2, button.y + 2);

    // Not handed on to the look region underneath.
    expect(source.activePointerCount).toBe(1);
    move(5, button.x + 90, button.y);
    expect(sample().axis('lookX')).toBe(0);
  });

  it('routes each button rect to its own action', () => {
    source = makeSource();
    const jump = centre('jump');
    const crouch = centre('crouch');

    down(6, jump.x, jump.y);
    down(7, crouch.x, crouch.y);

    const sink = sample();
    expect(sink.button('jump')).toBe(true);
    expect(sink.button('crouch')).toBe(true);
    expect(sink.button('scan')).toBe(false);
  });
});

// ---- Taps -------------------------------------------------------------

describe('TouchSource taps', () => {
  it('pulses an action whose contact began and ended between samples', () => {
    source = makeSource();
    const button = centre('interact');

    down(3, button.x, button.y);
    up(3, button.x, button.y);

    const sink = sample();
    expect(sink.pulses).toEqual(['interact']);
    // The pulse is the press. Held state stays false so nothing double-fires.
    expect(sink.button('interact')).toBe(false);

    // And it is not replayed.
    expect(sample().pulses).toEqual([]);
  });

  it('holds a tap for exactly one sample when the sink cannot pulse', () => {
    source = makeSource();
    const button = centre('interact');
    down(3, button.x, button.y);
    up(3, button.x, button.y);

    const first = new PulselessSink();
    source.sample(first);
    expect(first.buttons.get('interact')).toBe(true);

    const second = new PulselessSink();
    source.sample(second);
    expect(second.buttons.get('interact')).toBe(false);
  });

  it('does not pulse a press that was already sampled as held', () => {
    source = makeSource();
    const button = centre('interact');

    down(3, button.x, button.y);
    expect(sample().button('interact')).toBe(true);
    up(3, button.x, button.y);

    const sink = sample();
    expect(sink.button('interact')).toBe(false);
    expect(sink.pulses).toEqual([]);
  });

  it('reports tap versus hold on the release event', () => {
    source = makeSource();
    const released: { id: string; tap: boolean }[] = [];
    source.on('controlReleased', (payload) => {
      released.push({ id: payload.id, tap: payload.tap });
    });

    const jump = centre('jump');
    down(6, jump.x, jump.y);
    up(6, jump.x, jump.y);

    const crouch = centre('crouch');
    down(7, crouch.x, crouch.y);
    sample();
    up(7, crouch.x, crouch.y);

    expect(released).toEqual([
      { id: 'jump', tap: true },
      { id: 'crouch', tap: false },
    ]);
  });
});

// ---- Handedness -------------------------------------------------------

describe('TouchSource handedness', () => {
  it('mirrors regions and controls for a left-handed layout', () => {
    source = makeSource({ handedness: 'right' });
    const rightRegions = source.getRegions();
    const rightInteract = centre('interact');
    if (!rightRegions.stick || !rightRegions.look) throw new Error('missing regions');
    expect(rightRegions.stick.x).toBeCloseTo(0, 6);
    expect(rightRegions.look.x).toBeCloseTo(VIEWPORT.width * 0.42, 6);

    tuning = { ...tuning, handedness: 'left' };
    const leftRegions = source.getRegions();
    const leftInteract = centre('interact');
    if (!leftRegions.stick || !leftRegions.look) throw new Error('missing regions');

    // The stick half moves to the right edge, the look half to the left.
    expect(leftRegions.look.x).toBeCloseTo(0, 6);
    expect(leftRegions.stick.x + leftRegions.stick.width).toBeCloseTo(VIEWPORT.width, 6);
    expect(leftRegions.stick.width).toBeCloseTo(rightRegions.stick.width, 6);

    // Buttons mirror about the centre line.
    expect(leftInteract.x).toBeCloseTo(VIEWPORT.width - rightInteract.x, 6);
    expect(leftInteract.y).toBeCloseTo(rightInteract.y, 6);
  });

  it('claims the same screen point for different regions per handedness', () => {
    source = makeSource({ handedness: 'right', joystickDeadzone: 0 });
    const stickZone = source.getRegions().stick;
    if (!stickZone) throw new Error('no stick region');

    // Clear of every button in both mirrorings, so the only thing under test is
    // which *region* claims the contact.
    const point = { x: 250, y: 110 };
    expect(point.x).toBeGreaterThan(stickZone.x);
    expect(point.x).toBeLessThan(stickZone.x + stickZone.width);
    expectNoButtonAt(point.x, point.y);

    down(1, point.x, point.y);
    expect(source.getActiveClaims()[0]?.kind).toBe('stick');
    up(1, point.x, point.y);

    tuning = { ...tuning, handedness: 'left' };
    const mirroredLook = source.getRegions().look;
    if (!mirroredLook) throw new Error('no look region');
    expect(point.x).toBeLessThan(mirroredLook.x + mirroredLook.width);
    expectNoButtonAt(point.x, point.y);

    down(2, point.x, point.y);
    expect(source.getActiveClaims()[0]?.kind).toBe('look');

    move(2, point.x + 30, point.y);
    const sink = sample();
    expect(sink.axis('lookX')).toBeCloseTo(30 * TOUCH_LOOK_RADIANS_PER_PIXEL, 10);
    expect(sink.axis('moveX')).toBe(0);
  });
});

// ---- Cancellation and lifecycle --------------------------------------

describe('TouchSource cancellation', () => {
  it('releases a joystick contact on pointercancel', () => {
    source = makeSource({ joystickDeadzone: 0 });
    const stick = control('moveStick');
    const origin = centre('moveStick');
    down(1, origin.x, origin.y);
    move(1, origin.x + stick.radius, origin.y);
    expect(sample().axis('moveX')).toBeCloseTo(1, 10);

    cancel(1, origin.x + stick.radius, origin.y);

    const sink = sample();
    expect(sink.axis('moveX')).toBe(0);
    expect(sink.axis('moveY')).toBe(0);
    expect(source.activePointerCount).toBe(0);
  });

  it('releases a held button on pointercancel without inventing a tap', () => {
    source = makeSource();
    const button = centre('interact');
    down(3, button.x, button.y);
    cancel(3, button.x, button.y);

    const sink = sample();
    expect(sink.button('interact')).toBe(false);
    // An interrupted gesture is not a press. A phantom interact is worse than
    // a missed one.
    expect(sink.pulses).toEqual([]);
    expect(source.isControlPressed('interact')).toBe(false);
  });

  it('releases everything when the page is hidden', () => {
    source = makeSource({ joystickDeadzone: 0 });
    const stick = control('moveStick');
    const origin = centre('moveStick');
    const button = centre('interact');
    down(1, origin.x, origin.y);
    move(1, origin.x + stick.radius, origin.y);
    down(3, button.x, button.y);
    expect(source.activePointerCount).toBe(2);

    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    if (descriptor) Object.defineProperty(document, 'visibilityState', descriptor);
    else Reflect.deleteProperty(document as unknown as Record<string, unknown>, 'visibilityState');

    const sink = sample();
    expect(source.activePointerCount).toBe(0);
    expect(sink.axis('moveX')).toBe(0);
    expect(sink.button('interact')).toBe(false);
  });

  it('releases contacts whose control the new context removed', () => {
    source = makeSource({ joystickDeadzone: 0 });
    const stick = control('moveStick');
    const origin = centre('moveStick');
    down(1, origin.x, origin.y);
    move(1, origin.x + stick.radius, origin.y);
    expect(sample().axis('moveX')).toBeCloseTo(1, 10);

    source.setContext('cutscene');

    expect(source.activePointerCount).toBe(0);
    expect(sample().axis('moveX')).toBe(0);
  });
});

describe('TouchSource attach and detach', () => {
  it('suppresses browser touch gestures on the surface and restores them', () => {
    surface.style.touchAction = 'pan-y';
    source = makeSource();
    expect(surface.style.touchAction).toBe('none');
    expect(surface.style.userSelect).toBe('none');

    source.detach();
    expect(surface.style.touchAction).toBe('pan-y');
    expect(surface.style.userSelect).toBe('');
  });

  it('ignores pointer events after detach', () => {
    source = makeSource({ joystickDeadzone: 0 });
    const stick = control('moveStick');
    const origin = centre('moveStick');
    down(1, origin.x, origin.y);
    move(1, origin.x + stick.radius, origin.y);

    source.detach();
    expect(source.isAttached).toBe(false);
    expect(source.activePointerCount).toBe(0);
    expect(sample().axis('moveX')).toBe(0);

    // Fresh contacts land on nothing.
    down(2, origin.x, origin.y);
    move(2, origin.x + stick.radius, origin.y);
    const button = centre('interact');
    down(3, button.x, button.y);
    up(3, button.x, button.y);

    const sink = sample();
    expect(source.activePointerCount).toBe(0);
    expect(sink.axis('moveX')).toBe(0);
    expect(sink.axis('lookX')).toBe(0);
    expect(sink.button('interact')).toBe(false);
    expect(sink.pulses).toEqual([]);
  });

  it('does not double-register listeners when attached twice', () => {
    source = makeSource();
    source.attach();

    const presses: string[] = [];
    source.on('controlPressed', (payload) => presses.push(payload.id));
    const button = centre('interact');
    down(3, button.x, button.y);
    expect(presses).toEqual(['interact']);
  });

  it('re-attaches cleanly after detach', () => {
    source = makeSource({ joystickDeadzone: 0 });
    source.detach();
    source.attach();

    const stick = control('moveStick');
    const origin = centre('moveStick');
    down(1, origin.x, origin.y);
    move(1, origin.x + stick.radius, origin.y);
    expect(sample().axis('moveX')).toBeCloseTo(1, 10);
  });

  it('reports the touch family', () => {
    source = makeSource();
    expect(source.family).toBe(TOUCH_FAMILY);
    expect(TOUCH_FAMILY).toBe('touch');
  });
});

// ---- Pointer type and passthrough ------------------------------------

describe('TouchSource pointer filtering', () => {
  it('ignores mouse pointers by default', () => {
    source = makeSource({ joystickDeadzone: 0 });
    const origin = centre('moveStick');
    down(1, origin.x, origin.y, 'mouse');
    expect(source.activePointerCount).toBe(0);
  });

  it('accepts mouse pointers when explicitly allowed', () => {
    source = makeSource({ joystickDeadzone: 0 }, { allowMouse: true });
    const stick = control('moveStick');
    const origin = centre('moveStick');
    down(1, origin.x, origin.y, 'mouse');
    move(1, origin.x + stick.radius, origin.y);
    expect(sample().axis('moveX')).toBeCloseTo(1, 10);
  });

  it('accepts pen pointers', () => {
    source = makeSource({ joystickDeadzone: 0 });
    const origin = centre('moveStick');
    down(1, origin.x, origin.y, 'pen');
    expect(source.activePointerCount).toBe(1);
  });

  it('leaves presses on real DOM controls alone', () => {
    source = makeSource();
    const menuButton = document.createElement('button');
    surface.appendChild(menuButton);

    const origin = centre('moveStick');
    const event = pointerEvent('pointerdown', 1, origin.x, origin.y);
    menuButton.dispatchEvent(event);

    expect(source.activePointerCount).toBe(0);
    expect(event.defaultPrevented).toBe(false);
    menuButton.remove();
  });

  it('cancels the browser default only for claimed contacts', () => {
    source = makeSource();
    const origin = centre('moveStick');
    const claimed = down(1, origin.x, origin.y);
    expect(claimed.defaultPrevented).toBe(true);

    // Top-left corner: outside the button cluster and, in this layout, inside
    // the joystick region — so pick a point outside every region instead by
    // switching to a context that has neither.
    source.setContext('cutscene');
    const unclaimed = down(9, 5, VIEWPORT.height - 5);
    expect(unclaimed.defaultPrevented).toBe(false);
  });
});

// ---- Layout reporting ------------------------------------------------

describe('TouchSource layout reporting', () => {
  it('publishes every control in the current context with a usable rect', () => {
    source = makeSource();
    const layout = source.getLayout();

    expect(layout.viewport).toEqual(VIEWPORT);
    expect(layout.handedness).toBe('right');
    expect(layout.context).toBe('exploration');
    expect(layout.opacity).toBeCloseTo(defaultTouchSettings().opacity, 10);

    const ids = layout.controls.map((entry) => entry.id);
    expect(ids).toContain('moveStick');
    expect(ids).toContain('lookArea');
    expect(ids).toContain('interact');
    // Tool-only and cutscene-only controls are absent while exploring.
    expect(ids).not.toContain('toolAlt');
    expect(ids).not.toContain('cancel');

    for (const entry of layout.controls) {
      expect(entry.rect.width).toBeGreaterThan(0);
      expect(entry.rect.height).toBeGreaterThan(0);
      if (entry.kind === 'button') {
        expect(entry.action).not.toBeNull();
        // Accessibility floor for a touch target is 44 CSS px.
        expect(entry.rect.width).toBeGreaterThanOrEqual(44);
        expect(entry.movable).toBe(true);
      }
    }

    const look = layout.controls.find((entry) => entry.id === 'lookArea');
    expect(look?.movable).toBe(false);
    expect(look?.zone).not.toBeNull();
  });

  it('reflects presses in the published state, for the HUD and the tutorial', () => {
    source = makeSource();
    const button = centre('interact');
    down(3, button.x, button.y);
    expect(control('interact').pressed).toBe(true);
    up(3, button.x, button.y);
    expect(control('interact').pressed).toBe(false);
  });

  it('emits the pressed control and its rect so the tutorial can highlight it', () => {
    source = makeSource();
    const events: { id: string; action: string | null; rect: { x: number; width: number } }[] = [];
    source.on('controlPressed', (payload) => {
      events.push({ id: payload.id, action: payload.action, rect: payload.rect });
    });

    const button = centre('interact');
    down(3, button.x, button.y);

    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe('interact');
    expect(events[0]?.action).toBe('interact');
    expect(events[0]?.rect).toEqual(control('interact').rect);
  });

  it('keeps every control inside the safe area', () => {
    // Constructed without a safe-area override so the default measurement path
    // (CSS custom properties, absent here, therefore zero) runs at least once.
    tuning = defaultTouchSettings();
    source = new TouchSource({
      getTuning: () => tuning,
      surface,
      getViewport: () => VIEWPORT,
    });
    source.attach();
    expect(source.safeArea).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });

    const insets = { top: 44, right: 20, bottom: 34, left: 48 };
    const layoutEvents: number[] = [];
    source.on('layoutChanged', (payload) => layoutEvents.push(payload.safeArea.top));
    source.setSafeAreaInsets(insets);

    expect(source.safeArea).toEqual(insets);
    expect(layoutEvents).toEqual([44]);

    for (const entry of source.getControls()) {
      expect(entry.rect.x).toBeGreaterThanOrEqual(insets.left);
      expect(entry.rect.y).toBeGreaterThanOrEqual(insets.top);
      expect(entry.rect.x + entry.rect.width).toBeLessThanOrEqual(VIEWPORT.width - insets.right);
      expect(entry.rect.y + entry.rect.height).toBeLessThanOrEqual(
        VIEWPORT.height - insets.bottom,
      );
    }
  });

  it('swaps the control set with the gameplay context', () => {
    source = makeSource();
    const changes: string[] = [];
    source.on('contextChanged', (payload) => changes.push(payload.context));

    source.setContext('cutscene');
    expect(changes).toEqual(['cutscene']);
    expect(source.getControls().map((entry) => entry.id).sort()).toEqual(['cancel', 'pause']);
    // No stick or look region during a cutscene.
    expect(source.getRegions()).toEqual({ stick: null, look: null });

    source.setContext('puzzle');
    expect(source.getControls().map((entry) => entry.id).sort()).toEqual([
      'cancel',
      'pause',
      'toolAction',
    ]);
  });

  it('applies layout-editor overrides on top of the mirrored defaults', () => {
    source = makeSource({ handedness: 'right' });
    const before = control('interact');

    tuning = {
      ...tuning,
      layout: { interact: { x: 0.5, y: 0.5, scale: 1.5, visible: true } },
    };
    const after = control('interact');

    expect(after.rect.width).toBeCloseTo(before.rect.width * 1.5, 6);
    expect(after.rect.x + after.rect.width / 2).toBeCloseTo(VIEWPORT.width * 0.5, 6);
    expect(after.rect.y + after.rect.height / 2).toBeCloseTo(VIEWPORT.height * 0.5, 6);
  });

  it('does not claim a control the player hid', () => {
    source = makeSource({
      layout: { interact: { x: 0.9, y: 0.78, scale: 1, visible: false } },
    });
    const layout = source.getLayout();
    const interact = layout.controls.find((entry) => entry.id === 'interact');
    expect(interact?.visible).toBe(false);

    const rect = interact?.rect;
    if (!rect) throw new Error('interact rect missing');
    down(3, rect.x + rect.width / 2, rect.y + rect.height / 2);
    // Falls through to the look region the button was drawn on top of.
    expect(source.getActiveClaims()[0]?.kind).toBe('look');
  });

  it('scales controls with the viewport short edge', () => {
    const small = new TouchSource({
      getTuning: () => defaultTouchSettings(),
      surface,
      getViewport: () => ({ width: 640, height: 320 }),
      getSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
    });
    const large = new TouchSource({
      getTuning: () => defaultTouchSettings(),
      surface,
      getViewport: () => ({ width: 1600, height: 900 }),
      getSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
    });

    const smallStick = small.getControls().find((entry) => entry.id === 'moveStick');
    const largeStick = large.getControls().find((entry) => entry.id === 'moveStick');
    expect(smallStick?.radius).toBeLessThan(largeStick?.radius ?? 0);
    // Clamped, not proportional: a tablet gets more space, not giant buttons.
    expect(largeStick?.radius).toBeLessThan((smallStick?.radius ?? 0) * 2);

    small.dispose();
    large.dispose();
  });

  it('re-measures on orientation change', () => {
    let viewport = { width: 800, height: 400 };
    tuning = defaultTouchSettings();
    source = new TouchSource({
      getTuning: () => tuning,
      surface,
      getViewport: () => viewport,
      getSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
    });
    source.attach();

    const landscapeInteract = source.getControls().find((entry) => entry.id === 'interact');
    viewport = { width: 400, height: 800 };
    const events: number[] = [];
    source.on('layoutChanged', (payload) => events.push(payload.viewport.width));
    window.dispatchEvent(new Event('orientationchange'));

    expect(events).toEqual([400]);
    expect(source.viewport).toEqual({ width: 400, height: 800 });
    const portraitInteract = source.getControls().find((entry) => entry.id === 'interact');
    expect(portraitInteract?.rect.x).not.toBeCloseTo(landscapeInteract?.rect.x ?? 0, 3);
    // Still inside the viewport after rotating.
    expect((portraitInteract?.rect.x ?? 0) + (portraitInteract?.rect.width ?? 0)).toBeLessThanOrEqual(
      400,
    );
  });

  it('rejects a malformed control table instead of half-applying it', () => {
    source = makeSource();
    expect(() =>
      source.setControls([...DEFAULT_TOUCH_CONTROLS, DEFAULT_TOUCH_CONTROLS[0]!]),
    ).toThrow(/duplicate control id/);
    expect(() =>
      source.setControls([
        {
          id: 'broken',
          kind: 'button',
          anchor: { x: 0.5, y: 0.5 },
          size: 60,
          contexts: ['exploration'],
          label: 'Broken',
        },
      ]),
    ).toThrow(/no action/);
  });
});

// ---- Cross-layer shape ------------------------------------------------

describe('TouchSource settings contract', () => {
  it('accepts the persisted TouchSettings shape without adaptation', () => {
    // A compile-time check that also runs: if the settings schema grows a field
    // the source needs, or renames one it reads, this stops being assignable.
    const settings: TouchSettings = defaultTouchSettings();
    const asTuning: TouchTuning = settings;
    expect(asTuning.joystickMode).toBe('fixed');
    expect(asTuning.handedness).toBe('right');

    const built = new TouchSource({ getTuning: () => settings, surface });
    expect(built.family).toBe('touch');
    built.dispose();
  });

  it('maps every default button control to a known action', () => {
    const actions = DEFAULT_TOUCH_CONTROLS.filter((entry) => entry.kind === 'button').map(
      (entry) => entry.action,
    );
    expect(actions).toContain('interact');
    expect(actions).toContain('pause');
    expect(actions).toContain('journal');
    for (const action of actions) expect(action).toBeTruthy();
  });
});
