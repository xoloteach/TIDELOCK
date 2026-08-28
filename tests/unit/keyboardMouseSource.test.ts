/**
 * Keyboard + mouse input source tests.
 *
 * Real KeyboardEvent/MouseEvent/WheelEvent objects are dispatched on window
 * rather than calling handlers directly, so listener registration, bubbling,
 * `preventDefault` and detach are all exercised the way the browser does it.
 *
 * The sink is a local recorder that throws when an action was never written:
 * a sample that silently forgets to report `crouch` is a bug, not a pass.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  KeyboardMouseSource,
  MOUSE_LOOK_RADIANS_PER_PIXEL,
  isMouseCode,
  mouseButtonCode,
} from '../../src/engine/input/KeyboardMouseSource';
import { SettingsStore } from '../../src/persistence/SettingsStore';
import { DEFAULT_KEY_BINDINGS } from '../../src/persistence/settingsSchema';

class RecordingSink {
  readonly axes = new Map<string, number>();
  readonly buttons = new Map<string, boolean>();

  setAxis(action: string, value: number): void {
    this.axes.set(action, value);
  }

  setButton(action: string, down: boolean): void {
    this.buttons.set(action, down);
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

let store: SettingsStore;
let source: KeyboardMouseSource;
/** Tracks the simulated cursor so successive drags do not snap back. */
let cursorX = 200;
let cursorY = 200;

function keyDown(code: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { code, cancelable: true, bubbles: true, ...init });
  window.dispatchEvent(event);
  return event;
}

function keyUp(code: string): KeyboardEvent {
  const event = new KeyboardEvent('keyup', { code, cancelable: true, bubbles: true });
  window.dispatchEvent(event);
  return event;
}

function mouseDown(button: number): MouseEvent {
  const event = new MouseEvent('mousedown', { button, cancelable: true, bubbles: true });
  window.dispatchEvent(event);
  return event;
}

function mouseUp(button: number): MouseEvent {
  const event = new MouseEvent('mouseup', { button, cancelable: true, bubbles: true });
  window.dispatchEvent(event);
  return event;
}

function mouseMove(clientX: number, clientY: number): MouseEvent {
  const event = new MouseEvent('mousemove', { clientX, clientY, cancelable: true, bubbles: true });
  window.dispatchEvent(event);
  return event;
}

/**
 * Moves the cursor by a delta.
 *
 * jsdom does not populate `movementX/Y`, so the source's cursor-difference
 * fallback is what runs here. The leading move at the current position is a
 * no-op that establishes the baseline on the first call of a test.
 */
function dragBy(dx: number, dy: number): void {
  mouseMove(cursorX, cursorY);
  cursorX += dx;
  cursorY += dy;
  mouseMove(cursorX, cursorY);
}

function sample(): RecordingSink {
  const sink = new RecordingSink();
  source.sample(sink);
  return sink;
}

function setLockElement(element: Element | null): void {
  Object.defineProperty(document, 'pointerLockElement', {
    value: element,
    configurable: true,
    writable: true,
  });
  document.dispatchEvent(new Event('pointerlockchange'));
}

/** Full binding table with one action remapped; the schema requires every key. */
function bindingsWith(patch: Partial<typeof DEFAULT_KEY_BINDINGS>): typeof DEFAULT_KEY_BINDINGS {
  return { ...DEFAULT_KEY_BINDINGS, ...patch };
}

beforeEach(() => {
  window.localStorage.clear();
  cursorX = 200;
  cursorY = 200;
  store = new SettingsStore();
  source = new KeyboardMouseSource(store);
  source.attach();
});

afterEach(() => {
  source.detach();
  Reflect.deleteProperty(document, 'pointerLockElement');
  Reflect.deleteProperty(document, 'visibilityState');
});

describe('code encoding helpers', () => {
  it('encodes mouse buttons into the binding namespace', () => {
    expect(mouseButtonCode(0)).toBe('Mouse0');
    expect(mouseButtonCode(2)).toBe('Mouse2');
  });

  it('distinguishes mouse codes from keyboard codes', () => {
    expect(isMouseCode('Mouse0')).toBe(true);
    expect(isMouseCode('Mouse11')).toBe(true);
    expect(isMouseCode('KeyE')).toBe(false);
    // A key whose name merely starts with "Mouse" is not a button index.
    expect(isMouseCode('MouseWheel')).toBe(false);
  });
});

describe('binding lookup uses event.code, not event.key', () => {
  it('fires interact for the bound physical code', () => {
    keyDown('KeyE');
    expect(sample().button('interact')).toBe(true);
  });

  it('ignores a matching event.key on a different physical key', () => {
    // On AZERTY the "e" character sits elsewhere; binding on event.key would
    // fire interact from the wrong physical position.
    keyDown('Semicolon', { key: 'e' });
    expect(sample().button('interact')).toBe(false);
  });

  it('does not fire for the right character on an unbound code', () => {
    keyDown('KeyZ', { key: 'w' });
    const sink = sample();
    expect(sink.axis('moveY')).toBe(0);
    expect(sink.button('interact')).toBe(false);
  });

  it('releases the action on keyup', () => {
    keyDown('KeyE');
    keyUp('KeyE');
    expect(sample().button('interact')).toBe(false);
  });

  it('honours both bindings of a two-code action', () => {
    keyDown('ShiftRight');
    expect(sample().button('sprint')).toBe(true);
    keyUp('ShiftRight');
    keyDown('ShiftLeft');
    expect(sample().button('sprint')).toBe(true);
  });

  it('picks up a rebind without reattaching', () => {
    store.update('controls', { keyBindings: bindingsWith({ interact: ['KeyF'] }) });

    keyDown('KeyF');
    expect(sample().button('interact')).toBe(true);

    keyUp('KeyF');
    keyDown('KeyE');
    expect(sample().button('interact')).toBe(false);
  });

  it('re-reads bindings changed while detached', () => {
    source.detach();
    store.update('controls', { keyBindings: bindingsWith({ interact: ['KeyF'] }) });
    source.attach();

    keyDown('KeyF');
    expect(sample().button('interact')).toBe(true);
  });

  it('reports every rebindable action on every sample', () => {
    // The recorder throws on a missing action, so this asserts completeness.
    const sink = sample();
    for (const action of Object.keys(DEFAULT_KEY_BINDINGS)) {
      expect(sink.button(action)).toBe(false);
    }
  });
});

describe('movement composite axis', () => {
  it('maps WASD to unit axes', () => {
    keyDown('KeyW');
    expect(sample().axis('moveY')).toBe(1);
    keyUp('KeyW');

    keyDown('KeyS');
    expect(sample().axis('moveY')).toBe(-1);
    keyUp('KeyS');

    keyDown('KeyD');
    expect(sample().axis('moveX')).toBe(1);
    keyUp('KeyD');

    keyDown('KeyA');
    expect(sample().axis('moveX')).toBe(-1);
  });

  it('maps the arrow keys to the same axes', () => {
    // Pressed one at a time: together they are a diagonal and get normalised.
    keyDown('ArrowUp');
    expect(sample().axis('moveY')).toBe(1);
    keyUp('ArrowUp');

    keyDown('ArrowDown');
    expect(sample().axis('moveY')).toBe(-1);
    keyUp('ArrowDown');

    keyDown('ArrowRight');
    expect(sample().axis('moveX')).toBe(1);
    keyUp('ArrowRight');

    keyDown('ArrowLeft');
    expect(sample().axis('moveX')).toBe(-1);
  });

  it('normalises diagonals so they are not faster than straight lines', () => {
    keyDown('KeyW');
    keyDown('KeyD');
    const sink = sample();

    expect(sink.axis('moveX')).toBeCloseTo(Math.SQRT1_2, 10);
    expect(sink.axis('moveY')).toBeCloseTo(Math.SQRT1_2, 10);
    expect(Math.hypot(sink.axis('moveX'), sink.axis('moveY'))).toBeCloseTo(1, 10);
  });

  it('normalises every diagonal quadrant', () => {
    for (const [a, b] of [
      ['KeyW', 'KeyA'],
      ['KeyS', 'KeyD'],
      ['ArrowDown', 'ArrowLeft'],
    ] as const) {
      source.releaseAll();
      keyDown(a);
      keyDown(b);
      const sink = sample();
      expect(Math.hypot(sink.axis('moveX'), sink.axis('moveY'))).toBeCloseTo(1, 10);
    }
  });

  it('cancels opposing keys instead of favouring one', () => {
    keyDown('KeyW');
    keyDown('KeyS');
    keyDown('KeyA');
    keyDown('KeyD');
    const sink = sample();
    expect(sink.axis('moveX')).toBe(0);
    expect(sink.axis('moveY')).toBe(0);
  });

  it('keeps full magnitude when a cancelled pair leaves one axis', () => {
    keyDown('KeyW');
    keyDown('KeyA');
    keyDown('KeyD');
    const sink = sample();
    expect(sink.axis('moveX')).toBe(0);
    expect(sink.axis('moveY')).toBe(1);
  });
});

describe('mouse look', () => {
  beforeEach(() => {
    // Capture the pointer so look does not require a held button.
    setLockElement(document.body);
  });

  it('scales delta by the baseline radians-per-pixel', () => {
    dragBy(10, 0);
    expect(sample().axis('lookX')).toBeCloseTo(10 * MOUSE_LOOK_RADIANS_PER_PIXEL, 12);
  });

  it('looks down when the mouse moves down', () => {
    // lookY is positive upward, so downward cursor motion must be negative.
    dragBy(0, 10);
    expect(sample().axis('lookY')).toBeCloseTo(-10 * MOUSE_LOOK_RADIANS_PER_PIXEL, 12);
  });

  it('scales by mouseSensitivity', () => {
    store.update('controls', { mouseSensitivity: 2 });
    dragBy(10, 0);
    expect(sample().axis('lookX')).toBeCloseTo(20 * MOUSE_LOOK_RADIANS_PER_PIXEL, 12);
  });

  it('scales down for a low sensitivity', () => {
    store.update('controls', { mouseSensitivity: 0.5 });
    dragBy(0, 40);
    expect(sample().axis('lookY')).toBeCloseTo(-20 * MOUSE_LOOK_RADIANS_PER_PIXEL, 12);
  });

  it('inverts Y only when mouseInvertY is set', () => {
    dragBy(0, 10);
    const normal = sample().axis('lookY');
    expect(normal).toBeCloseTo(-10 * MOUSE_LOOK_RADIANS_PER_PIXEL, 12);

    store.update('controls', { mouseInvertY: true });
    dragBy(0, 10);
    expect(sample().axis('lookY')).toBeCloseTo(-normal, 12);
  });

  it('leaves X untouched when Y is inverted', () => {
    store.update('controls', { mouseInvertY: true });
    dragBy(10, 10);
    const sink = sample();
    expect(sink.axis('lookX')).toBeGreaterThan(0);
    // Inverted: pushing the mouse down now looks up.
    expect(sink.axis('lookY')).toBeGreaterThan(0);
  });

  it('exposes the same delta in radians for the camera', () => {
    dragBy(10, -20);
    const sink = sample();
    const delta = source.lookDeltaRadians;

    expect(delta.x).toBeCloseTo(sink.axis('lookX'), 12);
    expect(delta.y).toBeCloseTo(sink.axis('lookY'), 12);
    expect(delta.y).toBeCloseTo(20 * MOUSE_LOOK_RADIANS_PER_PIXEL, 12);
    // Reading it does not consume it.
    expect(source.lookDeltaRadians.x).toBeCloseTo(delta.x, 12);
  });

  it('accumulates several moves into one sample', () => {
    mouseMove(200, 200);
    mouseMove(205, 200);
    mouseMove(210, 200);
    expect(sample().axis('lookX')).toBeCloseTo(10 * MOUSE_LOOK_RADIANS_PER_PIXEL, 12);
  });

  it('clears the delta after sampling so it is not applied twice', () => {
    dragBy(10, 10);
    expect(sample().axis('lookX')).not.toBe(0);
    const second = sample();
    expect(second.axis('lookX')).toBe(0);
    expect(second.axis('lookY')).toBe(0);
  });

  it('treats the first move as a baseline rather than a jump', () => {
    source.releaseAll();
    mouseMove(640, 480);
    expect(sample().axis('lookX')).toBe(0);
  });
});

describe('mouse look without pointer lock', () => {
  it('ignores cursor motion when no button is held', () => {
    dragBy(25, 25);
    const sink = sample();
    expect(sink.axis('lookX')).toBe(0);
    expect(sink.axis('lookY')).toBe(0);
  });

  it('falls back to drag-to-look so the game stays playable', () => {
    mouseDown(0);
    dragBy(25, 0);
    expect(sample().axis('lookX')).toBeCloseTo(25 * MOUSE_LOOK_RADIANS_PER_PIXEL, 12);
  });

  it('stops looking when the drag ends', () => {
    mouseDown(0);
    dragBy(25, 0);
    sample();
    mouseUp(0);
    dragBy(25, 0);
    expect(sample().axis('lookX')).toBe(0);
  });

  it('honours dragLookWhenUnlocked: false', () => {
    source.detach();
    source = new KeyboardMouseSource(store, { dragLookWhenUnlocked: false });
    source.attach();

    mouseDown(0);
    dragBy(25, 0);
    expect(sample().axis('lookX')).toBe(0);
  });
});

describe('mouse buttons', () => {
  it('routes button 0 and 2 through their default bindings', () => {
    mouseDown(0);
    expect(sample().button('toolAction')).toBe(true);

    mouseDown(2);
    const sink = sample();
    expect(sink.button('toolAlt')).toBe(true);
    expect(sink.button('toolAction')).toBe(true);
  });

  it('releases on mouseup', () => {
    mouseDown(0);
    mouseUp(0);
    expect(sample().button('toolAction')).toBe(false);
  });

  it('supports rebinding an action to the middle button', () => {
    store.update('controls', { keyBindings: bindingsWith({ scan: ['Mouse1'] }) });

    mouseDown(1);
    expect(sample().button('scan')).toBe(true);
    mouseUp(1);
    expect(sample().button('scan')).toBe(false);

    // The replaced key binding no longer fires.
    keyDown('KeyQ');
    expect(source.pressedCodes.has('KeyQ')).toBe(true);
    expect(sample().button('scan')).toBe(false);
  });

  it('leaves an unbound button inert', () => {
    mouseDown(3);
    const sink = sample();
    expect(sink.button('toolAction')).toBe(false);
    expect(sink.button('toolAlt')).toBe(false);
  });

  it('suppresses the context menu while bound to toolAlt', () => {
    const event = new MouseEvent('contextmenu', { cancelable: true, bubbles: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('restores the context menu when a menu asks for it', () => {
    source.setContextMenuSuppressed(false);
    const event = new MouseEvent('contextmenu', { cancelable: true, bubbles: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('wheel', () => {
  it('accumulates and clears on consume', () => {
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, cancelable: true }));
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, cancelable: true }));

    expect(source.consumeWheel()).toBe(80);
    expect(source.consumeWheel()).toBe(0);
  });

  it('only blocks page scroll while the pointer is captured', () => {
    const unlocked = new WheelEvent('wheel', { deltaY: 120, cancelable: true });
    window.dispatchEvent(unlocked);
    expect(unlocked.defaultPrevented).toBe(false);

    setLockElement(document.body);
    const locked = new WheelEvent('wheel', { deltaY: 120, cancelable: true });
    window.dispatchEvent(locked);
    expect(locked.defaultPrevented).toBe(true);
  });
});

describe('hold versus toggle', () => {
  it('holds sprint by default', () => {
    keyDown('ShiftLeft');
    expect(sample().button('sprint')).toBe(true);
    keyUp('ShiftLeft');
    expect(sample().button('sprint')).toBe(false);
  });

  it('latches sprint in toggle mode', () => {
    store.update('controls', { holdToSprint: false });

    keyDown('ShiftLeft');
    expect(sample().button('sprint')).toBe(true);

    keyUp('ShiftLeft');
    expect(sample().button('sprint')).toBe(true);

    keyDown('ShiftLeft');
    keyUp('ShiftLeft');
    expect(sample().button('sprint')).toBe(false);
  });

  it('ignores auto-repeat so a held key does not strobe the latch', () => {
    store.update('controls', { holdToSprint: false });

    keyDown('ShiftLeft');
    keyDown('ShiftLeft', { repeat: true });
    keyDown('ShiftLeft', { repeat: true });
    keyDown('ShiftLeft', { repeat: true });

    expect(sample().button('sprint')).toBe(true);
  });

  it('latches crouch independently of sprint', () => {
    store.update('controls', { holdToCrouch: false });

    keyDown('KeyC');
    keyUp('KeyC');
    const sink = sample();
    expect(sink.button('crouch')).toBe(true);
    expect(sink.button('sprint')).toBe(false);
  });

  it('drops the latch when the player switches back to hold', () => {
    store.update('controls', { holdToSprint: false });
    keyDown('ShiftLeft');
    keyUp('ShiftLeft');
    expect(sample().button('sprint')).toBe(true);

    store.update('controls', { holdToSprint: true });

    // Otherwise the player sprints forever with no key to release.
    expect(sample().button('sprint')).toBe(false);
  });

  it('keeps a latch across focus loss, since it is a mode and not a key', () => {
    store.update('controls', { holdToCrouch: false });
    keyDown('KeyC');
    keyUp('KeyC');

    window.dispatchEvent(new Event('blur'));

    expect(sample().button('crouch')).toBe(true);
  });
});

describe('focus loss releases held input', () => {
  it('clears keys on window blur', () => {
    keyDown('KeyW');
    keyDown('KeyE');
    expect(sample().axis('moveY')).toBe(1);

    // Without this, a key held during a tab switch never delivers keyup and
    // the character runs forever.
    window.dispatchEvent(new Event('blur'));

    const sink = sample();
    expect(sink.axis('moveY')).toBe(0);
    expect(sink.button('interact')).toBe(false);
    expect(source.pressedCodes.size).toBe(0);
  });

  it('clears mouse buttons on blur too', () => {
    mouseDown(0);
    window.dispatchEvent(new Event('blur'));
    expect(sample().button('toolAction')).toBe(false);
  });

  it('clears keys when the document becomes hidden', () => {
    keyDown('KeyW');
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(sample().axis('moveY')).toBe(0);
  });

  it('keeps keys when the document becomes visible again', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    keyDown('KeyW');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(sample().axis('moveY')).toBe(1);
  });

  it('drops pending look delta on blur', () => {
    setLockElement(document.body);
    dragBy(50, 50);
    window.dispatchEvent(new Event('blur'));
    expect(sample().axis('lookX')).toBe(0);
  });
});

describe('preventDefault is narrow', () => {
  it('blocks the keys whose default breaks the game', () => {
    // Space scrolls, Tab moves focus off the canvas, arrows scroll.
    for (const code of ['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      expect(keyDown(code).defaultPrevented, code).toBe(true);
      keyUp(code);
    }
  });

  it('leaves ordinary bound keys alone', () => {
    for (const code of ['KeyW', 'KeyE', 'KeyQ', 'KeyC', 'ShiftLeft', 'Escape']) {
      expect(keyDown(code).defaultPrevented, code).toBe(false);
      keyUp(code);
    }
  });

  it('leaves unbound keys alone', () => {
    expect(keyDown('KeyZ').defaultPrevented).toBe(false);
    expect(keyDown('F5').defaultPrevented).toBe(false);
  });

  it('never blocks a browser shortcut', () => {
    expect(keyDown('Space', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(keyDown('Tab', { altKey: true }).defaultPrevented).toBe(false);
  });
});

describe('modifier and text-field handling', () => {
  it('ignores Cmd/Win combinations', () => {
    keyDown('KeyE', { metaKey: true });
    expect(sample().button('interact')).toBe(false);
  });

  it('still delivers actions while Ctrl is held, because Ctrl is crouch', () => {
    keyDown('ControlLeft', { ctrlKey: true });
    keyDown('KeyE', { ctrlKey: true });
    const sink = sample();
    expect(sink.button('crouch')).toBe(true);
    expect(sink.button('interact')).toBe(true);
  });

  it('ignores keys typed into a text field', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true }),
      );
      input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));

      const sink = sample();
      expect(sink.button('jump')).toBe(false);
      expect(sink.axis('moveY')).toBe(0);
    } finally {
      input.remove();
    }
  });

  it('still accepts keyup from a text field so nothing sticks', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      keyDown('KeyW');
      // Focus moved into a field mid-hold; the release must still count.
      input.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }));
      expect(sample().axis('moveY')).toBe(0);
    } finally {
      input.remove();
    }
  });
});

describe('dialogue selection', () => {
  it('presses dialogueSelect and reports which reply, once', () => {
    keyDown('Digit2');
    expect(sample().button('dialogueSelect')).toBe(true);
    expect(source.dialogueOption).toBe(2);

    // Consumed: the reply must not be re-submitted next frame.
    expect(sample().button('dialogueSelect')).toBe(false);
    expect(source.dialogueOption).toBe(0);
  });

  it('accepts the numpad', () => {
    keyDown('Numpad3');
    expect(sample().button('dialogueSelect')).toBe(true);
    expect(source.dialogueOption).toBe(3);
  });

  it('reports no selection by default', () => {
    expect(sample().button('dialogueSelect')).toBe(false);
    expect(source.dialogueOption).toBe(0);
  });

  it('ignores Digit0', () => {
    keyDown('Digit0');
    expect(sample().button('dialogueSelect')).toBe(false);
    expect(source.dialogueOption).toBe(0);
  });

  it('keeps the last digit when several are pressed in one step', () => {
    keyDown('Digit1');
    keyDown('Digit4');
    sample();
    expect(source.dialogueOption).toBe(4);
  });
});

describe('pointer lock', () => {
  it('starts unlocked', () => {
    expect(source.isPointerLocked).toBe(false);
  });

  it('tracks lock state and reports it', () => {
    const seen: boolean[] = [];
    source.on('pointerLockChanged', ({ locked }) => seen.push(locked));

    setLockElement(document.body);
    expect(source.isPointerLocked).toBe(true);

    setLockElement(null);
    expect(source.isPointerLocked).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it('does not report a lock held by another element', () => {
    const canvas = document.createElement('canvas');
    source.setPointerLockTarget(canvas);
    setLockElement(document.body);
    expect(source.isPointerLocked).toBe(false);
  });

  it('reports failure instead of throwing when there is no target', () => {
    const failures: string[] = [];
    source.on('pointerLockFailed', ({ reason }) => failures.push(reason));

    expect(() => source.requestPointerLock()).not.toThrow();
    expect(failures).toEqual(['no-target']);
  });

  it('reports failure instead of throwing when the API is missing', () => {
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'requestPointerLock', { value: undefined, configurable: true });
    source.setPointerLockTarget(canvas);

    const failures: string[] = [];
    source.on('pointerLockFailed', ({ reason }) => failures.push(reason));

    expect(() => source.requestPointerLock()).not.toThrow();
    expect(failures).toEqual(['unsupported']);
    expect(source.isPointerLocked).toBe(false);
  });

  it('survives a synchronous throw from requestPointerLock', () => {
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'requestPointerLock', {
      configurable: true,
      value: () => {
        throw new Error('locked out');
      },
    });
    source.setPointerLockTarget(canvas);

    const failures: string[] = [];
    source.on('pointerLockFailed', ({ reason }) => failures.push(reason));

    expect(() => source.requestPointerLock()).not.toThrow();
    expect(failures).toEqual(['locked out']);
  });

  it('handles a rejected pointer lock promise', async () => {
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'requestPointerLock', {
      configurable: true,
      value: () => Promise.reject(new Error('user denied')),
    });
    source.setPointerLockTarget(canvas);

    const failures: string[] = [];
    source.on('pointerLockFailed', ({ reason }) => failures.push(reason));

    source.requestPointerLock();
    await Promise.resolve();
    await Promise.resolve();

    expect(failures).toEqual(['user denied']);
  });

  it('surfaces the pointerlockerror event', () => {
    const failures: string[] = [];
    source.on('pointerLockFailed', ({ reason }) => failures.push(reason));

    document.dispatchEvent(new Event('pointerlockerror'));

    expect(failures).toEqual(['pointerlockerror']);
  });

  it('keeps the game playable after a failed lock', () => {
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'requestPointerLock', { value: undefined, configurable: true });
    source.setPointerLockTarget(canvas);

    // A click that fails to capture must still register as toolAction, and
    // movement must still work.
    mouseDown(0);
    keyDown('KeyW');
    const sink = sample();
    expect(sink.button('toolAction')).toBe(true);
    expect(sink.axis('moveY')).toBe(1);

    // ...and drag-look still turns the camera.
    dragBy(10, 0);
    expect(sample().axis('lookX')).toBeCloseTo(10 * MOUSE_LOOK_RADIANS_PER_PIXEL, 12);
  });

  it('requests capture on click and can be disabled', () => {
    const canvas = document.createElement('canvas');
    const request = vi.fn(() => Promise.resolve());
    Object.defineProperty(canvas, 'requestPointerLock', { configurable: true, value: request });
    source.setPointerLockTarget(canvas);

    mouseDown(0);
    expect(request).toHaveBeenCalledTimes(1);

    mouseUp(0);
    source.setPointerLockEnabled(false);
    mouseDown(0);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('exits without throwing when the API is absent', () => {
    expect(() => source.exitPointerLock()).not.toThrow();
  });
});

describe('attach and detach', () => {
  it('removes every listener it added', () => {
    source.detach();

    const windowAdds: string[] = [];
    const windowRemoves: string[] = [];
    const documentAdds: string[] = [];
    const documentRemoves: string[] = [];

    const addWin = vi
      .spyOn(window, 'addEventListener')
      .mockImplementation(((type: string) => windowAdds.push(type)) as never);
    const removeWin = vi
      .spyOn(window, 'removeEventListener')
      .mockImplementation(((type: string) => windowRemoves.push(type)) as never);
    const addDoc = vi
      .spyOn(document, 'addEventListener')
      .mockImplementation(((type: string) => documentAdds.push(type)) as never);
    const removeDoc = vi
      .spyOn(document, 'removeEventListener')
      .mockImplementation(((type: string) => documentRemoves.push(type)) as never);

    try {
      source.attach();
      source.detach();
    } finally {
      addWin.mockRestore();
      removeWin.mockRestore();
      addDoc.mockRestore();
      removeDoc.mockRestore();
    }

    expect(windowAdds.length).toBeGreaterThan(0);
    expect(documentAdds.length).toBeGreaterThan(0);
    expect([...windowRemoves].sort()).toEqual([...windowAdds].sort());
    expect([...documentRemoves].sort()).toEqual([...documentAdds].sort());
  });

  it('stops responding to events after detach', () => {
    source.detach();

    keyDown('KeyW');
    mouseDown(0);
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));

    const sink = sample();
    expect(sink.axis('moveY')).toBe(0);
    expect(sink.button('toolAction')).toBe(false);
    expect(source.consumeWheel()).toBe(0);
    expect(source.isAttached).toBe(false);
  });

  it('stops suppressing defaults after detach', () => {
    source.detach();
    expect(keyDown('Space').defaultPrevented).toBe(false);
  });

  it('is idempotent', () => {
    // Already attached by the outer beforeEach.
    source.attach();
    source.attach();

    keyDown('KeyW');
    // A doubled listener set would still report 1 here, so also check that
    // detaching once fully stops the source.
    expect(sample().axis('moveY')).toBe(1);

    source.detach();
    source.detach();
    keyDown('KeyD');
    expect(sample().axis('moveX')).toBe(0);
  });

  it('reattaches cleanly', () => {
    source.detach();
    source.attach();
    keyDown('KeyW');
    expect(sample().axis('moveY')).toBe(1);
    expect(source.isAttached).toBe(true);
  });

  it('reports the keyboard family, since mouse and keyboard are one family', () => {
    expect(source.family).toBe('keyboard');
  });

  it('lets a caller override the family', () => {
    source.detach();
    source = new KeyboardMouseSource(store, { family: 'touch' });
    expect(source.family).toBe('touch');
  });
});
