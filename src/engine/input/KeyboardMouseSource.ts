/**
 * Keyboard + mouse input source.
 *
 * Produces named actions, never raw keys: gameplay asks for `interact`, not
 * `KeyE`. This file is the only place in the engine that knows what a physical
 * key is.
 *
 * Bindings are read from `SettingsStore.controls.keyBindings` and re-read when
 * settings change, so rebinding takes effect immediately without reattaching.
 * Mouse buttons share the same binding namespace, encoded as `Mouse0`,
 * `Mouse1`, `Mouse2` (see `mouseButtonCode`), which lets `toolAction` be bound
 * to left-click or to a key with no branching at the call site.
 */

import { Emitter, type Unsubscribe } from '../events';
import type { SettingsStore } from '../../persistence/SettingsStore';
import {
  DEFAULT_KEY_BINDINGS,
  REBINDABLE_ACTIONS,
  type ControlsSettings,
} from '../../persistence/settingsSchema';
import type { AxisAction, ButtonAction, InputFamily, RebindableAction } from './actions';

/**
 * Where sampled values are written.
 *
 * Deliberately minimal: this source must not depend on the concrete input
 * state container, only on the two calls it needs. Axes and buttons are kept
 * apart by the compiler, so a continuous action can never be delivered as a
 * digital one.
 */
export interface InputSink {
  setAxis(action: AxisAction, value: number): void;
  setButton(action: ButtonAction, down: boolean): void;
}

/** Resolved bindings: every rebindable action maps to zero or more codes. */
type BindingTable = Record<RebindableAction, readonly string[]>;

export interface KeyboardMouseSourceOptions {
  /**
   * Element that receives pointer lock. Normally the render canvas. Pointer
   * lock is skipped entirely when this is null, and mouse look falls back to
   * drag-to-look.
   */
  readonly pointerLockTarget?: HTMLElement | null;
  /** Request pointer lock automatically on the first click. Default true. */
  readonly autoPointerLock?: boolean;
  /**
   * Look with the mouse while a button is held when pointer lock is
   * unavailable or denied. Default true — the game must stay playable.
   */
  readonly dragLookWhenUnlocked?: boolean;
  /**
   * Which input family this source reports as. Mouse and keyboard are one
   * desktop family, so this is `'keyboard'` unless a caller overrides it.
   */
  readonly family?: InputFamily;
}

type KeyboardMouseEvents = {
  pointerLockChanged: { locked: boolean };
  /** Lock could not be acquired. The caller should keep drag-look available. */
  pointerLockFailed: { reason: string };
};

/**
 * Baseline mouse look, in radians of camera rotation per CSS pixel of motion,
 * before `controls.mouseSensitivity` is applied. Exported so camera code and
 * tests share one number instead of duplicating a magic constant.
 *
 * Sign convention matches the action map: `lookY` positive is looking *up*,
 * so moving the mouse away from the player (negative client Y) is positive.
 *
 * Units caveat, stated rather than hidden: a stick reports a *rate* in
 * [-1,1], while a mouse reports a *displacement*. Both land on the same axis.
 * A camera that multiplies `lookX` by a turn rate and the frame step will feel
 * dead under the mouse, so the player camera should add `lookDeltaRadians`
 * directly while rate-integrating stick input. `InputState.activeFamily` says
 * which one produced the current values.
 */
export const MOUSE_LOOK_RADIANS_PER_PIXEL = 0.0022;

/** Prefix that distinguishes a mouse button from a keyboard `event.code`. */
export const MOUSE_CODE_PREFIX = 'Mouse';

/** Encodes a `MouseEvent.button` index into the binding namespace. */
export function mouseButtonCode(button: number): string {
  return `${MOUSE_CODE_PREFIX}${button}`;
}

/** True when a binding string refers to a mouse button rather than a key. */
export function isMouseCode(code: string): boolean {
  return code.startsWith(MOUSE_CODE_PREFIX) && /^\d+$/.test(code.slice(MOUSE_CODE_PREFIX.length));
}

/**
 * Movement is a composite axis, not a rebindable action: WASD and the arrow
 * keys both drive it, and the settings schema documents it as excluded from
 * the single-action map.
 */
const MOVE_FORWARD_CODES = ['KeyW', 'ArrowUp'] as const;
const MOVE_BACK_CODES = ['KeyS', 'ArrowDown'] as const;
const MOVE_LEFT_CODES = ['KeyA', 'ArrowLeft'] as const;
const MOVE_RIGHT_CODES = ['KeyD', 'ArrowRight'] as const;

const MOVEMENT_CODES: ReadonlySet<string> = new Set<string>([
  ...MOVE_FORWARD_CODES,
  ...MOVE_BACK_CODES,
  ...MOVE_LEFT_CODES,
  ...MOVE_RIGHT_CODES,
]);

/**
 * Codes whose browser default would fight the game: Tab moves focus off the
 * canvas, Space and the arrows scroll the page. Everything else keeps its
 * default — blanket `preventDefault()` breaks keyboard accessibility, browser
 * shortcuts and devtools.
 */
const SCROLL_OR_FOCUS_CODES: ReadonlySet<string> = new Set([
  'Tab',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

/**
 * Modifier keys are legitimate bindings (ControlLeft is a default crouch), so
 * they must not be mistaken for "the user is pressing a browser shortcut".
 */
const MODIFIER_CODES: ReadonlySet<string> = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
]);

export class KeyboardMouseSource {
  private readonly emitter = new Emitter<KeyboardMouseEvents>();

  /**
   * Physical codes currently held, including encoded mouse buttons. Physical
   * `event.code` rather than `event.key`: on AZERTY, Dvorak or a Cyrillic
   * layout `event.key` for the WASD positions is not "w"/"a"/"s"/"d", so a
   * key-based binding would silently break movement for those players.
   */
  private readonly pressed = new Set<string>();

  private controls: ControlsSettings;
  private bindings: BindingTable;

  /** Latched state for toggle-style sprint/crouch. */
  private sprintLatched = false;
  private crouchLatched = false;

  /** Look delta accumulated since the last `sample`, in radians. */
  private lookDeltaX = 0;
  private lookDeltaY = 0;

  /** The delta the most recent `sample` reported. Not consumed by reading. */
  private sampledLookX = 0;
  private sampledLookY = 0;

  /** Wheel delta accumulated since the last `consumeWheel`. */
  private wheelDelta = 0;

  /** Dialogue option chosen with a number key, 0 when none. Consumed by sample. */
  private pendingDialogueSelect = 0;
  private sampledDialogueSelect = 0;

  private lastClientX = 0;
  private lastClientY = 0;
  private hasPointerBaseline = false;

  private locked = false;
  private attached = false;
  private pointerLockTarget: HTMLElement | null;
  private pointerLockEnabled: boolean;
  private readonly dragLookWhenUnlocked: boolean;
  private readonly familyName: InputFamily;
  private contextMenuSuppressed = true;
  private unsubscribeSettings: Unsubscribe | null = null;

  constructor(
    private readonly settings: SettingsStore,
    options: KeyboardMouseSourceOptions = {},
  ) {
    this.controls = settings.current.controls;
    this.bindings = resolveBindings(this.controls);
    this.pointerLockTarget = options.pointerLockTarget ?? null;
    this.pointerLockEnabled = options.autoPointerLock ?? true;
    this.dragLookWhenUnlocked = options.dragLookWhenUnlocked ?? true;
    this.familyName = options.family ?? 'keyboard';
  }

  on = this.emitter.on.bind(this.emitter);

  get isAttached(): boolean {
    return this.attached;
  }

  /** True while the mouse is captured. UI uses it to show a "click to look" hint. */
  get isPointerLocked(): boolean {
    return this.locked;
  }

  get family(): InputFamily {
    return this.familyName;
  }

  /**
   * Exact scaled look delta in radians, as reported by the most recent
   * `sample`. Reading does not consume it.
   *
   * The player camera should add this directly rather than treating `lookX`/
   * `lookY` as a rate: mouse look has to be 1:1 with the hand, and the axis
   * write is additionally clamped to [-1,1] downstream.
   */
  get lookDeltaRadians(): { x: number; y: number } {
    return { x: this.sampledLookX, y: this.sampledLookY };
  }

  /**
   * Dialogue reply chosen by number key during the most recent `sample`,
   * 1-based, or 0 when none. Pairs with the `dialogueSelect` button: the
   * button is the edge, this is which reply.
   */
  get dialogueOption(): number {
    return this.sampledDialogueSelect;
  }

  /** Held codes, for the rebinding screen and the diagnostics overlay. */
  get pressedCodes(): ReadonlySet<string> {
    return this.pressed;
  }

  // ---- Lifecycle --------------------------------------------------------

  attach(): void {
    if (this.attached) return;
    this.attached = true;

    // Re-snapshot: settings may have changed while detached.
    this.controls = this.settings.current.controls;
    this.bindings = resolveBindings(this.controls);
    this.unsubscribeSettings = this.settings.on('changed', this.onSettingsChanged);

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    // Not passive: page scroll during captured gameplay has to be suppressed,
    // and a passive listener may not call preventDefault().
    window.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('pointerlockerror', this.onPointerLockError);
  }

  /** Removes every listener added by `attach`. */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;

    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('pointerlockerror', this.onPointerLockError);

    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;

    this.releaseAll();
  }

  /**
   * Drops every held key and pending delta.
   *
   * Required on focus loss: a key held while the tab is switched never
   * delivers its keyup, so the player would return to a character sprinting
   * into a wall forever. Toggle latches survive — they are a chosen mode, not
   * a held key.
   */
  releaseAll(): void {
    this.pressed.clear();
    this.lookDeltaX = 0;
    this.lookDeltaY = 0;
    this.wheelDelta = 0;
    this.pendingDialogueSelect = 0;
    this.hasPointerBaseline = false;
  }

  // ---- Sampling ---------------------------------------------------------

  /**
   * Writes the current state into `sink`.
   *
   * Movement axes are absolute. Look axes are *relative*: the delta
   * accumulated since the previous sample, cleared here, so calling sample
   * twice in one simulation step reports the second look as zero rather than
   * applying the same motion to the camera twice.
   */
  sample(sink: InputSink): void {
    const { x, y } = this.readMoveAxes();
    sink.setAxis('moveX', x);
    sink.setAxis('moveY', y);

    sink.setAxis('lookX', this.lookDeltaX);
    sink.setAxis('lookY', this.lookDeltaY);
    this.sampledLookX = this.lookDeltaX;
    this.sampledLookY = this.lookDeltaY;
    this.lookDeltaX = 0;
    this.lookDeltaY = 0;

    for (const action of REBINDABLE_ACTIONS) {
      if (action === 'sprint' || action === 'crouch') continue;
      sink.setButton(action, this.isActionHeld(action));
    }

    sink.setButton('sprint', this.isSprintActive());
    sink.setButton('crouch', this.isCrouchActive());

    // A number key both presses `dialogueSelect` and records which reply it
    // was. Consumed here so one keypress cannot submit two replies.
    this.sampledDialogueSelect = this.pendingDialogueSelect;
    this.pendingDialogueSelect = 0;
    sink.setButton('dialogueSelect', this.sampledDialogueSelect !== 0);
  }

  /** Wheel movement since the last call, in raw deltaY units. */
  consumeWheel(): number {
    const delta = this.wheelDelta;
    this.wheelDelta = 0;
    return delta;
  }

  /** True when any code bound to `action` is currently held. */
  isActionHeld(action: RebindableAction): boolean {
    for (const code of this.bindings[action]) {
      if (this.pressed.has(code)) return true;
    }
    return false;
  }

  private isSprintActive(): boolean {
    return this.controls.holdToSprint ? this.isActionHeld('sprint') : this.sprintLatched;
  }

  private isCrouchActive(): boolean {
    return this.controls.holdToCrouch ? this.isActionHeld('crouch') : this.crouchLatched;
  }

  /**
   * Composite movement axes, normalised.
   *
   * Without the normalisation a diagonal input is (1,1), length 1.414, and the
   * player moves 41% faster diagonally than forward — the classic strafe-run
   * bug. Opposite keys cancel, so W+S is a standstill rather than the
   * last-pressed direction.
   */
  private readMoveAxes(): { x: number; y: number } {
    let x = 0;
    let y = 0;

    if (this.anyPressed(MOVE_RIGHT_CODES)) x += 1;
    if (this.anyPressed(MOVE_LEFT_CODES)) x -= 1;
    if (this.anyPressed(MOVE_FORWARD_CODES)) y += 1;
    if (this.anyPressed(MOVE_BACK_CODES)) y -= 1;

    const length = Math.hypot(x, y);
    if (length > 1) {
      x /= length;
      y /= length;
    }

    return { x, y };
  }

  private anyPressed(codes: readonly string[]): boolean {
    for (const code of codes) {
      if (this.pressed.has(code)) return true;
    }
    return false;
  }

  // ---- Pointer lock -----------------------------------------------------

  setPointerLockTarget(target: HTMLElement | null): void {
    this.pointerLockTarget = target;
  }

  /** Disables automatic capture, e.g. while a menu is open. */
  setPointerLockEnabled(enabled: boolean): void {
    this.pointerLockEnabled = enabled;
  }

  /** Right-click opens the OS menu unless suppressed; menus want it back. */
  setContextMenuSuppressed(suppressed: boolean): void {
    this.contextMenuSuppressed = suppressed;
  }

  /**
   * Attempts to capture the mouse. Never throws.
   *
   * Pointer lock can fail for reasons outside our control: no user
   * activation yet, an insecure context, an unfocused document, a sandboxed
   * iframe, or a user who dismissed the browser's permission prompt. In every
   * case the game must stay playable, so failure only reports and leaves
   * drag-to-look in charge.
   */
  requestPointerLock(): void {
    const target = this.pointerLockTarget;
    if (!target) {
      this.emitter.emit('pointerLockFailed', { reason: 'no-target' });
      return;
    }
    if (this.locked) return;

    if (typeof target.requestPointerLock !== 'function') {
      this.emitter.emit('pointerLockFailed', { reason: 'unsupported' });
      return;
    }

    try {
      // Older browsers return void, newer ones a promise that rejects when
      // the request is denied. Treat both without assuming either.
      const result: unknown = target.requestPointerLock();
      if (result instanceof Promise) {
        result.catch((error: unknown) => {
          this.emitter.emit('pointerLockFailed', { reason: describeError(error) });
        });
      }
    } catch (error) {
      this.emitter.emit('pointerLockFailed', { reason: describeError(error) });
    }
  }

  exitPointerLock(): void {
    if (typeof document.exitPointerLock !== 'function') return;
    try {
      document.exitPointerLock();
    } catch {
      // Already unlocked, or the document lost focus first. Nothing to undo:
      // pointerlockchange keeps `locked` honest either way.
    }
  }

  // ---- Handlers ---------------------------------------------------------

  private readonly onSettingsChanged = ({
    settings,
    sections,
  }: {
    settings: { controls: ControlsSettings };
    sections: readonly string[];
  }): void => {
    if (!sections.includes('controls')) return;

    const previous = this.controls;
    this.controls = settings.controls;
    this.bindings = resolveBindings(this.controls);

    // Switching hold/toggle while a latch is set would leave the player
    // permanently sprinting or crouched with no key to press to stop it.
    if (previous.holdToSprint !== this.controls.holdToSprint) this.sprintLatched = false;
    if (previous.holdToCrouch !== this.controls.holdToCrouch) this.crouchLatched = false;
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const code = event.code;
    if (!code) return; // Some IMEs and virtual keyboards report an empty code.
    if (isEditableTarget(event.target)) return; // Rebinding fields, dev overlay.

    // Cmd/Win combinations are OS-level shortcuts and are never game
    // bindings. Ctrl and Alt are left alone because ControlLeft is a default
    // crouch binding: Ctrl+E while crouching must still interact.
    if (event.metaKey && !MODIFIER_CODES.has(code)) return;

    const consumed = this.isConsumedCode(code);

    // Auto-repeat fires keydown continuously while a key is held. Held state
    // is already correct, and letting repeats through would flip a toggle
    // dozens of times a second.
    if (!event.repeat) {
      this.pressed.add(code);
      this.applyToggles(code);

      const option = dialogueOptionFromCode(code);
      if (option !== 0) this.pendingDialogueSelect = option;
    }

    // Suppress only the defaults that would break gameplay, and only when a
    // modifier is not held so Ctrl+T, Alt+Tab and friends still work.
    if (
      consumed &&
      SCROLL_OR_FOCUS_CODES.has(code) &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      event.preventDefault();
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    const code = event.code;
    if (!code) return;
    // No editable-target guard here: if focus moved into a text field while a
    // key was held, we still want the release, or the key stays stuck.
    this.pressed.delete(code);
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (isEditableTarget(event.target)) return;

    const code = mouseButtonCode(event.button);
    this.pressed.add(code);
    this.applyToggles(code);

    // A mousedown handler is a user-activation context, which is exactly what
    // pointer lock requires. Requesting it anywhere else is likely to fail.
    if (this.pointerLockEnabled && !this.locked) this.requestPointerLock();
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    this.pressed.delete(mouseButtonCode(event.button));
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    const { dx, dy } = this.readMouseDelta(event);
    if (dx === 0 && dy === 0) return;

    // Unlocked, mouse look only applies while dragging. Otherwise moving the
    // cursor across a menu would spin the camera.
    if (!this.locked) {
      if (!this.dragLookWhenUnlocked || !this.hasMouseButtonDown()) return;
    }

    const scale = MOUSE_LOOK_RADIANS_PER_PIXEL * this.controls.mouseSensitivity;
    this.lookDeltaX += dx * scale;
    // Client Y grows downward but lookY is positive upward, hence the flip;
    // mouseInvertY undoes it for players who want plane-style pitch.
    this.lookDeltaY += -dy * scale * (this.controls.mouseInvertY ? -1 : 1);
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (isEditableTarget(event.target)) return;
    this.wheelDelta += event.deltaY;
    // Only while captured: scrolling a settings page must keep working.
    if (this.locked) event.preventDefault();
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    if (!this.contextMenuSuppressed) return;
    if (isEditableTarget(event.target)) return;
    // Right-click is bound to toolAlt by default, so the OS menu would eat it.
    event.preventDefault();
  };

  private readonly onBlur = (): void => {
    this.releaseAll();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') this.releaseAll();
  };

  private readonly onPointerLockChange = (): void => {
    const element: Element | null = document.pointerLockElement ?? null;
    const target = this.pointerLockTarget;
    const locked = element !== null && (target === null || element === target);
    if (locked === this.locked) return;

    this.locked = locked;
    // Entering or leaving lock switches the delta source between
    // movementX/Y and cursor tracking, so the old baseline is meaningless.
    this.hasPointerBaseline = false;
    this.emitter.emit('pointerLockChanged', { locked });
  };

  private readonly onPointerLockError = (): void => {
    // The spec gives no reason on the error event; the promise rejection path
    // carries detail when the browser supports it.
    this.emitter.emit('pointerLockFailed', { reason: 'pointerlockerror' });
  };

  // ---- Internals --------------------------------------------------------

  /** Flips toggle latches when a bound code goes down in toggle mode. */
  private applyToggles(code: string): void {
    if (!this.controls.holdToSprint && this.bindings.sprint.includes(code)) {
      this.sprintLatched = !this.sprintLatched;
    }
    if (!this.controls.holdToCrouch && this.bindings.crouch.includes(code)) {
      this.crouchLatched = !this.crouchLatched;
    }
  }

  private isConsumedCode(code: string): boolean {
    if (MOVEMENT_CODES.has(code)) return true;
    if (dialogueOptionFromCode(code) !== 0) return true;
    for (const action of REBINDABLE_ACTIONS) {
      if (this.bindings[action].includes(code)) return true;
    }
    return false;
  }

  private hasMouseButtonDown(): boolean {
    for (const code of this.pressed) {
      if (isMouseCode(code)) return true;
    }
    return false;
  }

  /**
   * Mouse motion for this event.
   *
   * Under pointer lock the cursor does not move, so `movementX/Y` is the only
   * signal. Unlocked — or in environments that do not populate movement
   * deltas — the difference between successive cursor positions is used
   * instead. The first move after attaching or after a lock change only
   * establishes the baseline: reporting the absolute position as a delta
   * would snap the camera.
   */
  private readMouseDelta(event: MouseEvent): { dx: number; dy: number } {
    const mx = event.movementX;
    const my = event.movementY;
    if (Number.isFinite(mx) && Number.isFinite(my) && (mx !== 0 || my !== 0)) {
      return { dx: mx, dy: my };
    }

    const x = event.clientX;
    const y = event.clientY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { dx: 0, dy: 0 };

    if (!this.hasPointerBaseline) {
      this.lastClientX = x;
      this.lastClientY = y;
      this.hasPointerBaseline = true;
      return { dx: 0, dy: 0 };
    }

    const dx = x - this.lastClientX;
    const dy = y - this.lastClientY;
    this.lastClientX = x;
    this.lastClientY = y;
    return { dx, dy };
  }
}

/**
 * Resolves stored bindings into a complete table.
 *
 * A missing action falls back to its default so a settings blob written by an
 * older build cannot leave an action unreachable. An explicitly empty array is
 * respected: the player chose to unbind it.
 */
function resolveBindings(controls: ControlsSettings): BindingTable {
  const stored = controls.keyBindings as Partial<Record<RebindableAction, string[]>>;
  const table = {} as Record<RebindableAction, readonly string[]>;
  for (const action of REBINDABLE_ACTIONS) {
    table[action] = stored[action] ?? DEFAULT_KEY_BINDINGS[action];
  }
  return table;
}

/** Maps Digit1-9 and Numpad1-9 to a 1-based dialogue option, else 0. */
function dialogueOptionFromCode(code: string): number {
  let digits: string | null = null;
  if (code.startsWith('Digit')) digits = code.slice(5);
  else if (code.startsWith('Numpad')) digits = code.slice(6);
  if (digits === null || !/^[1-9]$/.test(digits)) return 0;
  return Number(digits);
}

/**
 * True when the event landed in a text field, so game bindings must not fire.
 *
 * Typing a save name or a rebind label should not also make the player jump.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}
