/**
 * Gamepad input source.
 *
 * Translates a physical controller into named game actions. Gameplay never
 * sees a button index — it reads `interact`, `moveX`, `lookY` and so on, which
 * is what makes remapping and the touch/keyboard sources interchangeable.
 *
 * ## Why this polls
 *
 * The Gamepad API has *no* events for axes or button values. `gamepadconnected`
 * and `gamepaddisconnected` are the only events it fires; everything else must
 * be read from a fresh `navigator.getGamepads()` snapshot each frame. That is
 * why the public entry point is `sample(sink)` and why the `Gamepad` object is
 * never cached: in Chromium the objects returned by `getGamepads()` are
 * immutable snapshots, so a held reference silently stops updating.
 *
 * ## Mapping
 *
 * The W3C "standard" mapping is the happy path. Non-standard pads report
 * arbitrary index layouts, so every read is bounds-guarded and the awkward
 * cases (right stick, D-pad hat) fall back to documented heuristics rather
 * than assuming a brand. Remapping in the controls menu is the escape hatch
 * when a heuristic guesses wrong — no controller brand is ever required.
 *
 * ## Sign conventions
 *
 * In the standard mapping a stick pushed *up* reports a *negative* Y axis.
 * This source normalises that away:
 *   - `moveY` positive = forward
 *   - `lookY` positive = look up (before `gamepadInvertY` is applied)
 * Move axes are clamped to the unit circle. Look axes are deliberately *not*
 * clamped here: `gamepadSensitivity` may reach 3, and clamping in the driver
 * would silently discard the setting's effect above full deflection with no
 * way for the camera to recover it. Whoever wires this source into the input
 * state owns that decision — see the note on `sample`.
 */

import { Emitter } from '../events';
import type { AxisAction, ButtonAction, InputFamily } from './actions';

/**
 * Family this source reports as, for prompt glyphs and HUD layout.
 *
 * Exported because the sink below is family-agnostic on purpose: the caller
 * binds the family once when wiring the source into the input state, exactly
 * as it does for the keyboard/mouse source.
 */
export const GAMEPAD_FAMILY: InputFamily = 'gamepad';

/**
 * Controller family used to pick prompt glyphs.
 *
 * Derived from `gamepad.id` substring matching, which is a *heuristic*: the id
 * string is browser- and OS-specific and has no schema. It is good enough to
 * choose between an A/X/□ glyph set and never used for anything mechanical.
 */
export type GamepadStyle = 'xbox' | 'playstation' | 'nintendo' | 'generic';

/**
 * The slice of `ControlsSettings` this source reads.
 *
 * Declared structurally rather than importing the persistence type so the
 * engine layer keeps no dependency on `src/persistence`. `ControlsSettings`
 * satisfies it by shape (asserted in the unit tests).
 */
export interface GamepadTuning {
  /** Multiplier on look axes only. Movement always reaches full speed. */
  readonly gamepadSensitivity: number;
  readonly gamepadInvertY: boolean;
  /** Radial deadzone radius, 0..0.4 per the settings schema. */
  readonly gamepadDeadzone: number;
  readonly gamepadHaptics: boolean;
}

/**
 * Where sampled values are written.
 *
 * Structurally identical to the keyboard/mouse source's sink, so one adapter
 * wires both into the input state. Declared locally rather than imported from
 * a sibling driver: drivers should not depend on each other.
 *
 * Absolute state is pushed every sample rather than edges — it is idempotent,
 * so a dropped frame cannot leave an action stuck on. Axes and buttons are
 * kept apart by the compiler, so a continuous action can never be delivered as
 * a digital one.
 */
export interface GamepadInputSink {
  setAxis(action: AxisAction, value: number): void;
  setButton(action: ButtonAction, down: boolean): void;
}

/** Indirection over `navigator` so tests can supply fake pads. */
export interface GamepadProvider {
  getGamepads(): ReadonlyArray<Gamepad | null>;
}

export interface GamepadSourceOptions {
  /** Called every sample; returns the current controls settings slice. */
  getTuning(): GamepadTuning;
  /** Defaults to `navigator` when it exposes `getGamepads`. */
  readonly provider?: GamepadProvider | null;
  /** Defaults to `window`. Where connect/disconnect events are listened for. */
  readonly target?: EventTarget | null;
}

export type GamepadSourceEvents = {
  connected: {
    index: number;
    id: string;
    style: GamepadStyle;
    mapping: string;
    /** True when this pad became the one being read. */
    active: boolean;
  };
  disconnected: { index: number; id: string; wasActive: boolean };
  /** Fired when the pad being read changes, including to none. Drives glyph switching. */
  activeChanged: { index: number | null; id: string; style: GamepadStyle };
};

export interface ActiveGamepadInfo {
  readonly index: number;
  readonly id: string;
  readonly mapping: string;
  readonly style: GamepadStyle;
  readonly axisCount: number;
  readonly buttonCount: number;
  readonly hapticsSupported: boolean;
}

export interface GamepadSourceStatus {
  readonly attached: boolean;
  readonly connectedCount: number;
  readonly activeIndex: number | null;
  readonly style: GamepadStyle;
  /** True once a haptics call failed, so diagnostics can say so honestly. */
  readonly hapticsFailed: boolean;
}

// ---- Bindings -----------------------------------------------------------

/**
 * Axis action names, kept as data so a typo is a compile error rather than a
 * silently dead axis.
 */
const AXIS_ACTION = {
  moveX: 'moveX',
  moveY: 'moveY',
  lookX: 'lookX',
  lookY: 'lookY',
} as const satisfies Record<string, AxisAction>;

const AXIS_ACTION_LIST = [
  AXIS_ACTION.moveX,
  AXIS_ACTION.moveY,
  AXIS_ACTION.lookX,
  AXIS_ACTION.lookY,
] as const;

/**
 * Action -> standard-mapping button indices. Multiple indices are an OR.
 *
 * Standard mapping reference: 0/1/2/3 bottom/right/left/top face, 4/5
 * shoulders, 6/7 triggers, 8 view/share, 9 menu/options, 10/11 stick clicks,
 * 12–15 D-pad.
 *
 * Two actions share index 0 (`jump`, `dialogueSelect`) and two share index 1
 * (`crouch`, `cancel`). That is intentional, not a collision: the contexts are
 * mutually exclusive — the action map routes to dialogue/menu handling or to
 * gameplay, never both at once — and it keeps the universal console habits
 * (bottom face confirms, right face backs out).
 */
export const GAMEPAD_BUTTON_BINDINGS = {
  jump: [0],
  dialogueSelect: [0],
  crouch: [1],
  cancel: [1],
  interact: [2],
  scan: [3, 5],
  journal: [4, 8],
  pause: [9],
  sprint: [10],
  toolAlt: [6],
  toolAction: [7],
} as const satisfies Partial<Record<ButtonAction, readonly number[]>>;

export type GamepadButtonAction = keyof typeof GAMEPAD_BUTTON_BINDINGS;

const BUTTON_ACTION_LIST = Object.keys(GAMEPAD_BUTTON_BINDINGS) as readonly GamepadButtonAction[];

/** Indices that are analogue in the standard mapping. */
const ANALOGUE_TRIGGER_BUTTONS: ReadonlySet<number> = new Set([6, 7]);

/** A trigger must be pulled this far to count as pressed. */
export const TRIGGER_PRESS_THRESHOLD = 0.5;
/**
 * ...and must fall back below this to count as released.
 *
 * The gap is hysteresis. A single threshold makes a trigger held near it
 * chatter on and off every frame, which fires an action repeatedly.
 */
export const TRIGGER_RELEASE_THRESHOLD = 0.35;

/** Digital buttons that report a value instead of a boolean. */
const DIGITAL_PRESS_THRESHOLD = 0.5;

/** Hat axis magnitude that counts as a D-pad direction. */
const HAT_THRESHOLD = 0.5;

/** A deadzone of 1 would divide by zero; the schema caps at 0.4 anyway. */
const MAX_DEADZONE = 0.95;

const MAX_VIBRATION_MS = 5000;

/**
 * Style hints, evaluated in order — order is load-bearing.
 *
 * Chrome reports a DualShock 4 as "Wireless Controller", but an Xbox pad can
 * report "Xbox Wireless Controller", so the weak "wireless controller" needle
 * has to be tried *after* the strong Xbox and Nintendo needles. Four-digit
 * needles are USB vendor ids: 045e Microsoft, 054c Sony, 057e Nintendo.
 */
const STYLE_HINTS: readonly { readonly style: GamepadStyle; readonly needles: readonly string[] }[] = [
  { style: 'xbox', needles: ['xbox', 'x-box', 'xinput', '045e'] },
  { style: 'nintendo', needles: ['nintendo', 'switch', 'joy-con', 'joycon', 'pro controller', '057e'] },
  {
    style: 'playstation',
    needles: ['playstation', 'dualshock', 'dualsense', 'ps3', 'ps4', 'ps5', '054c'],
  },
  { style: 'playstation', needles: ['wireless controller'] },
];

/**
 * Best-effort controller family from the id string.
 *
 * Unknown pads return 'generic' rather than a guess — a wrong glyph is worse
 * than a neutral one.
 */
export function detectGamepadStyle(id: string): GamepadStyle {
  const haystack = id.toLowerCase();
  if (haystack.length === 0) return 'generic';
  for (const hint of STYLE_HINTS) {
    for (const needle of hint.needles) {
      if (haystack.includes(needle)) return hint.style;
    }
  }
  return 'generic';
}

/**
 * Radial deadzone.
 *
 * The stick's *magnitude* is tested against the deadzone, then rescaled so the
 * output ramps from 0 at the deadzone edge to 1 at full deflection. The result
 * is always a positive scalar multiple of the input, so the direction the
 * player is pushing survives exactly.
 *
 * Do not replace this with a per-axis deadzone (`if (Math.abs(x) < dz) x = 0`).
 * That is the classic snapping bug: pushing the stick diagonally at a shallow
 * angle zeroes the smaller axis and the character veers to a cardinal
 * direction. It also makes diagonals reach full speed sooner than cardinals,
 * because each axis is rescaled independently.
 */
export function applyRadialDeadzone(
  x: number,
  y: number,
  deadzone: number,
): { x: number; y: number } {
  const rawX = Number.isFinite(x) ? x : 0;
  const rawY = Number.isFinite(y) ? y : 0;
  const dz = clamp(Number.isFinite(deadzone) ? deadzone : 0, 0, MAX_DEADZONE);

  const magnitude = Math.hypot(rawX, rawY);
  if (magnitude <= dz || magnitude === 0) return { x: 0, y: 0 };

  // Sticks can report slightly past 1 on a diagonal, which would otherwise
  // rescale to >1 and outrun the movement system's assumptions.
  const clampedMagnitude = Math.min(1, magnitude);
  const ramped = (clampedMagnitude - dz) / (1 - dz);

  // Divide by the *original* magnitude so (x, y) is scaled uniformly; the
  // output magnitude then equals `ramped` and the angle is untouched.
  const scale = ramped / magnitude;
  return { x: rawX * scale, y: rawY * scale };
}

/** Keeps a summed movement vector inside the unit circle without changing its direction. */
export function clampToUnitCircle(x: number, y: number): { x: number; y: number } {
  const magnitude = Math.hypot(x, y);
  if (magnitude <= 1 || magnitude === 0) return { x, y };
  return { x: x / magnitude, y: y / magnitude };
}

/** Minimal shape of `GamepadHapticActuator`, so this compiles on any lib.dom vintage. */
interface HapticActuatorLike {
  playEffect?(type: string, params: Record<string, number>): Promise<unknown> | undefined;
  reset?(): Promise<unknown> | undefined;
}

export class GamepadSource {
  private readonly emitter = new Emitter<GamepadSourceEvents>();
  private readonly options: GamepadSourceOptions;
  private readonly provider: GamepadProvider | null;
  private readonly target: EventTarget | null;

  private attached = false;

  /**
   * Connected pad indices in connection order. The active pad is the first
   * entry, i.e. the first pad that connected and is still present.
   */
  private readonly connectedPads: number[] = [];
  private readonly padInfo = new Map<number, { id: string; mapping: string; style: GamepadStyle }>();

  private activeIndex: number | null = null;
  private activeStyle: GamepadStyle = 'generic';
  private activeId = '';

  private readonly buttonState = new Map<GamepadButtonAction, boolean>();
  private readonly buttonValues = new Map<GamepadButtonAction, number>();
  private readonly axisValues = new Map<AxisAction, number>();

  /**
   * Set once live values have been pushed. When the pad then goes away the
   * next sample pushes an explicit neutral frame — otherwise the sink keeps
   * the last gamepad-family values forever and the player walks into a wall
   * because a battery died mid-stride.
   */
  private neutralPending = false;

  private hapticsFailed = false;

  private readonly onGamepadConnected = (event: Event): void => {
    const pad = readEventGamepad(event);
    if (pad) this.registerPad(pad);
    // Some browsers fire the event before the pad appears in getGamepads();
    // the next sample's lazy discovery covers that case.
  };

  private readonly onGamepadDisconnected = (event: Event): void => {
    const pad = readEventGamepad(event);
    if (pad) this.unregisterPad(pad.index);
  };

  constructor(options: GamepadSourceOptions) {
    this.options = options;
    this.provider = options.provider ?? null;
    this.target = options.target ?? (typeof window !== 'undefined' ? window : null);
  }

  on = this.emitter.on.bind(this.emitter);

  // ---- Lifecycle --------------------------------------------------------

  attach(): void {
    if (this.attached) return;
    this.attached = true;

    this.target?.addEventListener('gamepadconnected', this.onGamepadConnected);
    this.target?.addEventListener('gamepaddisconnected', this.onGamepadDisconnected);

    // A pad can already be plugged in when we attach (page reload, or the
    // player connected it on the title screen before this source existed).
    this.discoverPads();
  }

  /**
   * Removes the DOM listeners and forgets all pad state.
   *
   * Emits `activeChanged` with a null index first, so anything showing
   * controller glyphs stops showing them. Emitter subscriptions deliberately
   * survive: they belong to the consumer, not to this source, so re-attaching
   * resumes reporting to them. Use `dispose` to drop those too.
   */
  detach(): void {
    if (!this.attached) return;

    this.stopVibration();

    this.target?.removeEventListener('gamepadconnected', this.onGamepadConnected);
    this.target?.removeEventListener('gamepaddisconnected', this.onGamepadDisconnected);

    this.attached = false;
    this.setActive(null);

    this.connectedPads.length = 0;
    this.padInfo.clear();
    this.buttonState.clear();
    this.buttonValues.clear();
    this.axisValues.clear();
    this.neutralPending = false;
    this.hapticsFailed = false;
  }

  dispose(): void {
    this.detach();
    this.emitter.clear();
  }

  // ---- Sampling ---------------------------------------------------------

  /**
   * Reads the active pad once and pushes every action to the sink.
   *
   * Call once per fixed step. Values are absolute, so calling it twice in a
   * step is harmless (just wasteful).
   *
   * Caveat worth stating rather than hiding: `lookX`/`lookY` carry
   * `gamepadSensitivity` already applied, so at sensitivity 3 a fully
   * deflected stick reports 3. A sink that clamps axes to [-1,1] will
   * therefore flatten the top of the range. Either the sink accepts a look
   * rate above 1, or the sensitivity multiplier belongs on the camera's turn
   * rate instead — but not both, and not silently.
   */
  sample(sink: GamepadInputSink): void {
    if (!this.attached) return;

    const pad = this.resolveActivePad();
    if (!pad) {
      if (this.neutralPending) {
        this.neutralPending = false;
        this.emitNeutral(sink);
      }
      return;
    }

    const tuning = this.options.getTuning();
    const deadzone = clamp(numberOr(tuning.gamepadDeadzone, 0), 0, MAX_DEADZONE);
    const sensitivity = clamp(numberOr(tuning.gamepadSensitivity, 1), 0.05, 10);

    // ---- Movement: left stick + D-pad ----
    const stick = applyRadialDeadzone(readAxis(pad, 0), readAxis(pad, 1), deadzone);
    const dpad = readDpad(pad);
    // Flip Y: raw negative is up/forward.
    const move = clampToUnitCircle(stick.x + dpad.x, -stick.y + dpad.y);

    // ---- Look: right stick ----
    // Absent on pads that expose fewer than four axes; those read as 0.
    const look = applyRadialDeadzone(readAxis(pad, 2), readAxis(pad, 3), deadzone);
    // Base convention is +Y = up, hence the flip; invert Y undoes it.
    const lookY = (tuning.gamepadInvertY ? look.y : -look.y) * sensitivity;

    this.pushAxis(sink, AXIS_ACTION.moveX, move.x);
    this.pushAxis(sink, AXIS_ACTION.moveY, move.y);
    this.pushAxis(sink, AXIS_ACTION.lookX, look.x * sensitivity);
    this.pushAxis(sink, AXIS_ACTION.lookY, lookY);

    for (const action of BUTTON_ACTION_LIST) {
      const { pressed, value } = this.readBinding(pad, action);
      this.buttonState.set(action, pressed);
      this.buttonValues.set(action, value);
      sink.setButton(action, pressed);
    }

    this.neutralPending = true;
  }

  private pushAxis(sink: GamepadInputSink, action: AxisAction, value: number): void {
    // Collapse -0 to 0: harmless arithmetically, but it shows up as "-0" in the
    // diagnostics overlay and makes equality checks in consumers surprising.
    const normalised = value === 0 ? 0 : value;
    this.axisValues.set(action, normalised);
    sink.setAxis(action, normalised);
  }

  /** Zeroes everything this source owns, exactly once, after the pad is lost. */
  private emitNeutral(sink: GamepadInputSink): void {
    for (const action of AXIS_ACTION_LIST) {
      this.axisValues.set(action, 0);
      sink.setAxis(action, 0);
    }
    for (const action of BUTTON_ACTION_LIST) {
      this.buttonState.set(action, false);
      this.buttonValues.set(action, 0);
      sink.setButton(action, false);
    }
  }

  private readBinding(
    pad: Gamepad,
    action: GamepadButtonAction,
  ): { pressed: boolean; value: number } {
    const wasPressed = this.buttonState.get(action) === true;
    let pressed = false;
    let magnitude = 0;

    for (const index of GAMEPAD_BUTTON_BINDINGS[action]) {
      const button = pad.buttons[index];
      if (!button) continue;

      // Some pads report `pressed` without a value; treat that as full travel
      // rather than losing the input.
      const raw = Number.isFinite(button.value) ? button.value : 0;
      const value = raw > 0 ? raw : button.pressed ? 1 : 0;
      magnitude = Math.max(magnitude, value);

      if (ANALOGUE_TRIGGER_BUTTONS.has(index)) {
        const threshold = wasPressed ? TRIGGER_RELEASE_THRESHOLD : TRIGGER_PRESS_THRESHOLD;
        if (value >= threshold) pressed = true;
      } else if (button.pressed || value >= DIGITAL_PRESS_THRESHOLD) {
        pressed = true;
      }
    }

    return { pressed, value: magnitude };
  }

  // ---- Pad tracking -----------------------------------------------------

  private currentPads(): ReadonlyArray<Gamepad | null> {
    const provider =
      this.provider ??
      (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function'
        ? navigator
        : null);
    if (!provider) return [];
    try {
      return provider.getGamepads() ?? [];
    } catch {
      // Permissions-Policy can block gamepad access in an iframe. Degrade to
      // "no controller" rather than taking the input layer down.
      return [];
    }
  }

  /**
   * Reconciles tracked pads with reality and returns the active snapshot.
   *
   * Lazy discovery matters: Chromium and Safari only fire `gamepadconnected`
   * after the first button press, and pads can vanish without a disconnect
   * event when the tab loses focus.
   */
  private resolveActivePad(): Gamepad | null {
    const pads = this.discoverPads();
    if (this.activeIndex === null) return null;
    return findPad(pads, this.activeIndex);
  }

  private discoverPads(): ReadonlyArray<Gamepad | null> {
    const pads = this.currentPads();

    for (const pad of pads) {
      if (pad && pad.connected && !this.padInfo.has(pad.index)) this.registerPad(pad);
    }
    for (const index of [...this.connectedPads]) {
      if (!findPad(pads, index)) this.unregisterPad(index);
    }

    return pads;
  }

  private registerPad(pad: Gamepad): void {
    if (this.padInfo.has(pad.index)) return;

    const id = pad.id ?? '';
    const mapping = pad.mapping ?? '';
    const style = detectGamepadStyle(id);

    this.connectedPads.push(pad.index);
    this.padInfo.set(pad.index, { id, mapping, style });

    const becameActive = this.activeIndex === null;
    this.emitter.emit('connected', { index: pad.index, id, style, mapping, active: becameActive });
    if (becameActive) this.setActive(pad.index);
  }

  private unregisterPad(index: number): void {
    const info = this.padInfo.get(index);
    if (!info) return;

    const position = this.connectedPads.indexOf(index);
    if (position >= 0) this.connectedPads.splice(position, 1);
    this.padInfo.delete(index);

    const wasActive = this.activeIndex === index;
    this.emitter.emit('disconnected', { index, id: info.id, wasActive });

    // Promote the next pad in connection order, if the player has two plugged in.
    if (wasActive) this.setActive(this.connectedPads[0] ?? null);
  }

  private setActive(index: number | null): void {
    if (this.activeIndex === index) return;

    this.activeIndex = index;
    const info = index === null ? null : this.padInfo.get(index);
    this.activeId = info?.id ?? '';
    this.activeStyle = info?.style ?? 'generic';

    // A different pad's button history is meaningless, and trigger hysteresis
    // would otherwise carry over.
    this.buttonState.clear();
    this.buttonValues.clear();
    this.hapticsFailed = false;

    this.emitter.emit('activeChanged', { index, id: this.activeId, style: this.activeStyle });
  }

  // ---- Haptics ----------------------------------------------------------

  private activeActuator(): HapticActuatorLike | null {
    if (this.activeIndex === null) return null;
    const pad = findPad(this.currentPads(), this.activeIndex);
    if (!pad) return null;
    const actuator = (pad as unknown as { vibrationActuator?: HapticActuatorLike | null })
      .vibrationActuator;
    return actuator ?? null;
  }

  /**
   * Plays a dual-rumble effect.
   *
   * Returns whether an effect was actually started. Haptics are optional
   * polish: an unsupported pad, a disabled setting or a browser that rejects
   * the effect must all be silent no-ops, never an exception on a gameplay
   * code path.
   */
  vibrate(durationMs: number, strong = 1, weak = 0.4): boolean {
    if (!this.attached) return false;
    if (!this.options.getTuning().gamepadHaptics) return false;

    const duration = clamp(numberOr(durationMs, 0), 0, MAX_VIBRATION_MS);
    if (duration <= 0) return false;

    const actuator = this.activeActuator();
    if (!actuator || typeof actuator.playEffect !== 'function') return false;

    try {
      const result = actuator.playEffect('dual-rumble', {
        startDelay: 0,
        duration,
        strongMagnitude: clamp(numberOr(strong, 0), 0, 1),
        weakMagnitude: clamp(numberOr(weak, 0), 0, 1),
      });
      // Pads that advertise an actuator but cannot play 'dual-rumble' reject
      // the promise. An unhandled rejection would show up as a console error,
      // which the browser E2E suite treats as a failure, so swallow it and
      // record the fact for diagnostics.
      if (isPromiseLike(result)) {
        result.catch(() => {
          this.hapticsFailed = true;
        });
      }
      return true;
    } catch {
      this.hapticsFailed = true;
      return false;
    }
  }

  stopVibration(): void {
    const actuator = this.activeActuator();
    if (!actuator || typeof actuator.reset !== 'function') return;
    try {
      const result = actuator.reset();
      if (isPromiseLike(result)) result.catch(() => undefined);
    } catch {
      this.hapticsFailed = true;
    }
  }

  /** Whether the active pad can vibrate right now. False when the setting is off. */
  isHapticsSupported(): boolean {
    if (!this.options.getTuning().gamepadHaptics) return false;
    if (this.hapticsFailed) return false;
    const actuator = this.activeActuator();
    return !!actuator && typeof actuator.playEffect === 'function';
  }

  // ---- Reporting --------------------------------------------------------

  get isAttached(): boolean {
    return this.attached;
  }

  /** True when a pad is being read. */
  get isConnected(): boolean {
    return this.activeIndex !== null;
  }

  /** Active pad family, for prompt glyphs. 'generic' when nothing is connected. */
  get style(): GamepadStyle {
    return this.activeStyle;
  }

  getConnectedIndices(): readonly number[] {
    return [...this.connectedPads];
  }

  getActiveInfo(): ActiveGamepadInfo | null {
    if (this.activeIndex === null) return null;
    const pad = findPad(this.currentPads(), this.activeIndex);
    const info = this.padInfo.get(this.activeIndex);
    if (!info) return null;
    return {
      index: this.activeIndex,
      id: info.id,
      mapping: info.mapping,
      style: info.style,
      axisCount: pad?.axes.length ?? 0,
      buttonCount: pad?.buttons.length ?? 0,
      hapticsSupported: this.isHapticsSupported(),
    };
  }

  getStatus(): GamepadSourceStatus {
    return {
      attached: this.attached,
      connectedCount: this.connectedPads.length,
      activeIndex: this.activeIndex,
      style: this.activeStyle,
      hapticsFailed: this.hapticsFailed,
    };
  }

  /** Last sampled value for an axis action. */
  getAxis(action: AxisAction): number {
    return this.axisValues.get(action) ?? 0;
  }

  /** Last sampled digital state for a button action. */
  isPressed(action: GamepadButtonAction): boolean {
    return this.buttonState.get(action) === true;
  }

  /** Last sampled analogue travel, 0..1. Meaningful for the triggers. */
  getButtonValue(action: GamepadButtonAction): number {
    return this.buttonValues.get(action) ?? 0;
  }
}

// ---- Helpers ------------------------------------------------------------

function readAxis(pad: Gamepad, index: number): number {
  const value = pad.axes[index];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isDown(button: GamepadButton | undefined): boolean {
  if (!button) return false;
  const value = Number.isFinite(button.value) ? button.value : 0;
  return button.pressed || value >= DIGITAL_PRESS_THRESHOLD;
}

/**
 * D-pad as a movement vector.
 *
 * Standard mapping puts it on buttons 12–15. Many non-standard pads (Linux
 * evdev, Firefox) expose it as a hat on axes 6/7 instead — that fallback is a
 * heuristic, gated on the pad reporting at least 8 axes so it can never
 * misfire on a standard 4-axis pad.
 */
function readDpad(pad: Gamepad): { x: number; y: number } {
  if (pad.mapping === 'standard' || pad.buttons.length >= 16) {
    const x = (isDown(pad.buttons[15]) ? 1 : 0) - (isDown(pad.buttons[14]) ? 1 : 0);
    const y = (isDown(pad.buttons[12]) ? 1 : 0) - (isDown(pad.buttons[13]) ? 1 : 0);
    if (x !== 0 || y !== 0) return { x, y };
  }

  if (pad.mapping !== 'standard' && pad.axes.length >= 8) {
    const hatX = readAxis(pad, 6);
    const hatY = readAxis(pad, 7);
    return {
      x: Math.abs(hatX) >= HAT_THRESHOLD ? Math.sign(hatX) : 0,
      // Hat Y is negative-up like the sticks.
      y: Math.abs(hatY) >= HAT_THRESHOLD ? -Math.sign(hatY) : 0,
    };
  }

  return { x: 0, y: 0 };
}

function findPad(pads: ReadonlyArray<Gamepad | null>, index: number): Gamepad | null {
  for (const pad of pads) {
    if (pad && pad.connected && pad.index === index) return pad;
  }
  return null;
}

/**
 * Pulls the pad off a connect/disconnect event without assuming `GamepadEvent`
 * exists as a global (it does not in every test environment).
 */
function readEventGamepad(event: Event): Gamepad | null {
  const candidate = (event as Event & { gamepad?: unknown }).gamepad;
  if (!candidate || typeof candidate !== 'object') return null;
  const pad = candidate as Gamepad;
  return typeof pad.index === 'number' ? pad : null;
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    !!value &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as Promise<unknown>).catch === 'function'
  );
}

function numberOr(value: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
