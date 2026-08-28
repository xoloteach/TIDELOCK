/**
 * Touch input source.
 *
 * Translates finger contacts into named game actions. Touch is a first-class
 * platform here, not a keyboard HUD with buttons drawn on it: the left thumb
 * gets an analogue stick, the opposite half of the screen is drag-to-look, and
 * named action buttons live in between. Everything above the input layer reads
 * `moveX` / `lookY` / `interact` and never learns that a finger was involved.
 *
 * ## Why Pointer Events and not TouchEvent
 *
 * `TouchEvent` gives a whole-document snapshot on every event, so every handler
 * has to diff `event.touches` against its own bookkeeping to work out which
 * contact changed. Pointer Events deliver one contact per event with a stable
 * `pointerId`, which is exactly the ownership model this source needs, and the
 * same code path then also covers stylus input. `touch-action: none` on the
 * surface suppresses the browser's scroll/pinch/double-tap-zoom gestures so a
 * drag is a camera drag rather than a page scroll.
 *
 * ## Why not nipplejs
 *
 * `nipplejs` is a dependency of this project and it is competent at what it
 * does, but it owns its own DOM nodes, its own visual state and its own
 * lifecycle. Using it would mean a second source of truth for where a control
 * is (it decides), what a control looks like (its CSS), and when a contact is
 * claimed (its internal listeners) — while this file still has to own the look
 * region, the action buttons and multi-touch arbitration between all three. The
 * joystick maths that nipplejs would contribute is roughly fifteen lines; the
 * integration cost of a second owner of pointer state is much larger than that,
 * and multi-touch arbitration is precisely the part that must not be split in
 * two. So pointer handling is implemented directly here, and the library is
 * left unused rather than half-used.
 *
 * ## Ownership rule
 *
 * Every pointer is claimed by exactly one region at `pointerdown` — button,
 * stick, or look — and that claim is never transferred. A thumb that starts on
 * the stick and slides into the right-hand half keeps driving the stick; a
 * thumb that starts on the `interact` button contributes zero camera motion no
 * matter how much it wobbles. Both of those are the difference between "touch
 * controls" and "touch controls that fight the player".
 *
 * ## What this file does not do
 *
 * It owns *mechanics*, not pixels. It computes and publishes the rect of every
 * control (`getLayout`) and emits press/release events, but it never creates a
 * DOM node. The HUD draws the controls, the layout editor moves them, and the
 * tutorial highlights them — all from the published rects.
 */

import { Emitter } from '../events';
import type { AxisAction, ButtonAction, InputFamily } from './actions';

/**
 * Family this source reports as, for prompt glyphs and HUD layout.
 *
 * Exported because the sink below is family-agnostic on purpose: the caller
 * binds the family once when wiring the source into the input state, exactly as
 * it does for the keyboard/mouse and gamepad sources.
 */
export const TOUCH_FAMILY: InputFamily = 'touch';

/**
 * Baseline look speed, in radians of camera rotation per CSS pixel of drag,
 * before `cameraSensitivity` / `aimSensitivity` is applied.
 *
 * Chosen so a swipe across the width of a typical phone (~700 CSS px in
 * landscape) turns the camera a little over half a turn, which is the range
 * mobile players are trained to expect. Higher than the mouse constant because
 * a thumb travels far less distance than a hand on a desk.
 *
 * Same units caveat as the mouse: a drag is a *displacement*, not a rate, so
 * the camera should add `lookDeltaRadians` directly rather than multiplying
 * `lookX` by a turn rate and the frame step. `InputState.activeFamily` says
 * which kind of input produced the current values.
 */
export const TOUCH_LOOK_RADIANS_PER_PIXEL = 0.0045;

/**
 * Gyro contribution, in radians of camera rotation per degree of device
 * rotation, before sensitivity.
 *
 * 1:1 — rotating the phone 10° turns the view 10°. Anything else feels like the
 * world is sliding.
 */
export const TOUCH_GYRO_RADIANS_PER_DEGREE = Math.PI / 180;

/**
 * Device rotation below this many degrees per event is discarded as sensor
 * noise. Without it a phone lying on a table slowly rotates the camera.
 */
export const TOUCH_GYRO_NOISE_DEGREES = 0.06;

/** A deadzone of 1 would divide by zero; the settings schema caps at 0.4. */
const MAX_DEADZONE = 0.95;

/**
 * Gameplay contexts. The on-screen control set is a function of this, because
 * permanently covering a phone screen with every possible action is how mobile
 * ports get their reputation.
 */
export const TOUCH_CONTEXTS = ['exploration', 'tool', 'dialogue', 'puzzle', 'cutscene'] as const;

export type TouchContext = (typeof TOUCH_CONTEXTS)[number];

export type TouchControlKind = 'stick' | 'look' | 'button';

/** Pixel rect in viewport coordinates. What the HUD draws and the editor moves. */
export interface TouchRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Normalised rect inside the safe area, 0..1 on both axes. */
export interface NormalisedRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TouchInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface TouchViewport {
  readonly width: number;
  readonly height: number;
}

/**
 * A control this source knows how to claim pointers for.
 *
 * Positions are authored for the *right-handed* layout and mirrored for
 * left-handed players, so there is one table rather than two that drift.
 */
export interface TouchControlDefinition {
  readonly id: string;
  readonly kind: TouchControlKind;
  /** Buttons only. A press sets this action; a tap pulses it. */
  readonly action?: ButtonAction;
  /** Centre of the control, normalised inside the safe area. */
  readonly anchor: { readonly x: number; readonly y: number };
  /** Base diameter in CSS px, before viewport and settings scaling. */
  readonly size: number;
  /**
   * Where a `pointerdown` claims this control, normalised inside the safe area.
   * Sticks and look regions own a whole screen region; buttons are hit-tested
   * against their circle instead and leave this undefined.
   */
  readonly zone?: NormalisedRect;
  /** Contexts in which the control exists at all. */
  readonly contexts: readonly TouchContext[];
  /** Short label for the HUD, the layout editor and screen readers. */
  readonly label: string;
}

/** A control's resolved state for the current viewport, context and settings. */
export interface TouchControlState {
  readonly id: string;
  readonly kind: TouchControlKind;
  readonly action: ButtonAction | null;
  readonly label: string;
  /** What to draw. For a floating stick this follows the thumb while held. */
  readonly rect: TouchRect;
  /** Radius of the round hit/draw shape. 0 for the look region. */
  readonly radius: number;
  /** Pointer claim region, or null for buttons (which use `rect` + padding). */
  readonly zone: TouchRect | null;
  readonly pressed: boolean;
  readonly visible: boolean;
  /** False for the look region, which the layout editor must not drag around. */
  readonly movable: boolean;
}

/** Everything the HUD and the layout editor need for one frame. */
export interface TouchLayoutSnapshot {
  readonly viewport: TouchViewport;
  readonly safeArea: TouchInsets;
  /** Viewport-derived size multiplier already folded into every rect. */
  readonly scale: number;
  readonly opacity: number;
  readonly handedness: 'left' | 'right';
  readonly context: TouchContext;
  readonly controls: readonly TouchControlState[];
}

/**
 * The slice of `TouchSettings` this source reads.
 *
 * Declared structurally rather than importing the persistence type so the
 * engine layer keeps no dependency on `src/persistence`. `TouchSettings`
 * satisfies it by shape (asserted in the unit tests).
 */
export interface TouchTuning {
  readonly handedness: 'left' | 'right';
  readonly joystickMode: 'fixed' | 'floating';
  readonly joystickSize: number;
  /** Radial deadzone radius, 0..0.4 per the settings schema. */
  readonly joystickDeadzone: number;
  readonly cameraSensitivity: number;
  /** Applied instead of `cameraSensitivity` while `setAiming(true)`. */
  readonly aimSensitivity: number;
  readonly invertY: boolean;
  readonly buttonScale: number;
  readonly opacity: number;
  readonly vibration: boolean;
  readonly gyroAim: boolean;
  /** Per-control overrides from the layout editor, keyed by control id. */
  readonly layout: Readonly<
    Record<string, { x: number; y: number; scale: number; visible: boolean }>
  >;
}

/**
 * Where sampled values are written.
 *
 * Structurally compatible with the keyboard/mouse and gamepad sinks, so one
 * adapter wires all three into the input state. Declared locally rather than
 * imported from a sibling driver: drivers should not depend on each other.
 *
 * `pulseButton` is optional and is what makes a fast tap survive. A press and
 * release that both land between two samples would otherwise be latched as
 * "never happened" — see `sample`.
 */
export interface TouchInputSink {
  setAxis(action: AxisAction, value: number): void;
  setButton(action: ButtonAction, down: boolean): void;
  pulseButton?(action: ButtonAction): void;
}

export interface TouchSourceOptions {
  /** Called every sample; returns the current touch settings slice. */
  getTuning(): TouchTuning;
  /**
   * Element that receives `pointerdown` and has its touch gestures suppressed.
   * Normally the render canvas or its wrapper. Defaults to `document.body`.
   */
  readonly surface?: HTMLElement | null;
  /**
   * Where move/up/cancel are listened for. Defaults to `window`, deliberately:
   * a thumb that slides off the canvas must keep steering, and jsdom plus a few
   * mobile browsers do not implement `setPointerCapture`.
   */
  readonly target?: EventTarget | null;
  /** Overrides viewport measurement. Defaults to the surface rect, then window. */
  readonly getViewport?: (() => TouchViewport) | null;
  /**
   * Overrides safe-area measurement. The default reads the
   * `--safe-area-inset-*` custom properties the app sets from `env()`.
   */
  readonly getSafeAreaInsets?: (() => TouchInsets) | null;
  /** Initial control table. Defaults to `DEFAULT_TOUCH_CONTROLS`. */
  readonly controls?: readonly TouchControlDefinition[];
  readonly initialContext?: TouchContext;
  /**
   * Accept `pointerType: 'mouse'`. Off by default: a desktop click must not
   * claim the touch family and swap every prompt to an on-screen glyph. Useful
   * for testing the touch layout in a desktop browser.
   */
  readonly allowMouse?: boolean;
}

export type TouchSourceEvents = {
  /**
   * A control was pressed. The tutorial system listens for this so it can
   * highlight the control the player actually used rather than telling a phone
   * player to "press E".
   */
  controlPressed: {
    id: string;
    kind: TouchControlKind;
    action: ButtonAction | null;
    pointerId: number;
    rect: TouchRect;
  };
  controlReleased: {
    id: string;
    kind: TouchControlKind;
    action: ButtonAction | null;
    pointerId: number;
    durationMs: number;
    /** True when the contact ended before any sample observed it as held. */
    tap: boolean;
  };
  /** Viewport, safe area, handedness or the control table changed. Re-render. */
  layoutChanged: { viewport: TouchViewport; safeArea: TouchInsets };
  contextChanged: { context: TouchContext; previous: TouchContext };
};

interface StickClaim {
  kind: 'stick';
  controlId: string;
  originX: number;
  originY: number;
  radius: number;
}

interface LookClaim {
  kind: 'look';
  controlId: string;
  lastX: number;
  lastY: number;
}

interface ButtonClaim {
  kind: 'button';
  controlId: string;
  action: ButtonAction;
  downAtMs: number;
  /** Set by `sample`. Drives the tap-versus-hold decision on release. */
  sampledAsDown: boolean;
}

/** What a live pointer is driving. A claim is made once and never moved. */
type PointerClaim = StickClaim | LookClaim | ButtonClaim;

/** Public, read-only view of a claim, for diagnostics and tests. */
export type TouchPointerClaim = PointerClaim & { readonly pointerId: number };

/**
 * Base control layout, authored right-handed.
 *
 * The stick and the look region split the screen at 42%: enough room for a
 * thumb arc on the left without eating the half a player swipes to look. Action
 * buttons sit *inside* the look region and take priority over it, which is why
 * a button press cannot become a camera drag.
 */
export const DEFAULT_TOUCH_CONTROLS: readonly TouchControlDefinition[] = [
  {
    id: 'moveStick',
    kind: 'stick',
    anchor: { x: 0.17, y: 0.74 },
    size: 150,
    zone: { x: 0, y: 0, width: 0.42, height: 1 },
    contexts: ['exploration', 'tool'],
    label: 'Move',
  },
  {
    id: 'lookArea',
    kind: 'look',
    anchor: { x: 0.71, y: 0.5 },
    size: 0,
    zone: { x: 0.42, y: 0, width: 0.58, height: 1 },
    contexts: ['exploration', 'tool'],
    label: 'Look',
  },
  {
    id: 'interact',
    kind: 'button',
    action: 'interact',
    anchor: { x: 0.9, y: 0.78 },
    size: 88,
    contexts: ['exploration', 'dialogue'],
    label: 'Interact',
  },
  {
    id: 'jump',
    kind: 'button',
    action: 'jump',
    anchor: { x: 0.755, y: 0.7 },
    size: 72,
    contexts: ['exploration', 'tool'],
    label: 'Vault',
  },
  {
    id: 'crouch',
    kind: 'button',
    action: 'crouch',
    anchor: { x: 0.9, y: 0.56 },
    size: 72,
    contexts: ['exploration', 'tool'],
    label: 'Crouch',
  },
  {
    id: 'sprint',
    kind: 'button',
    action: 'sprint',
    anchor: { x: 0.62, y: 0.88 },
    size: 68,
    contexts: ['exploration', 'tool'],
    label: 'Sprint',
  },
  {
    id: 'scan',
    kind: 'button',
    action: 'scan',
    anchor: { x: 0.755, y: 0.46 },
    size: 68,
    contexts: ['exploration', 'tool'],
    label: 'Survey',
  },
  {
    id: 'toolAction',
    kind: 'button',
    action: 'toolAction',
    anchor: { x: 0.9, y: 0.78 },
    size: 88,
    contexts: ['tool', 'puzzle'],
    label: 'Use',
  },
  {
    id: 'toolAlt',
    kind: 'button',
    action: 'toolAlt',
    anchor: { x: 0.755, y: 0.7 },
    size: 72,
    contexts: ['tool'],
    label: 'Alternate',
  },
  {
    id: 'cancel',
    kind: 'button',
    action: 'cancel',
    anchor: { x: 0.9, y: 0.3 },
    size: 68,
    contexts: ['dialogue', 'puzzle', 'cutscene'],
    label: 'Back',
  },
  {
    id: 'journal',
    kind: 'button',
    action: 'journal',
    anchor: { x: 0.82, y: 0.07 },
    size: 56,
    contexts: ['exploration', 'tool'],
    label: 'Objectives',
  },
  {
    id: 'pause',
    kind: 'button',
    action: 'pause',
    anchor: { x: 0.95, y: 0.07 },
    size: 52,
    contexts: ['exploration', 'tool', 'dialogue', 'puzzle', 'cutscene'],
    label: 'Pause',
  },
];

/**
 * Extra hit radius around a button, in base px.
 *
 * Fingers are imprecise and a 44pt target is the accessibility floor, so the
 * touchable circle is larger than the drawn one. The padding is invisible and
 * deliberately generous.
 */
const BUTTON_HIT_PADDING = 10;

/** Keeps every control clear of the safe-area edge, in base px. */
const EDGE_MARGIN = 8;

/** Shorter viewport edge, in CSS px, that the base sizes were authored against. */
const REFERENCE_SHORT_EDGE = 400;

/**
 * Radial deadzone.
 *
 * The stick's *magnitude* is tested against the deadzone, then rescaled so the
 * output ramps from 0 at the deadzone edge to 1 at full deflection. The result
 * is always a positive scalar multiple of the input, so the direction the thumb
 * is pushing survives exactly.
 *
 * Do not replace this with a per-axis deadzone (`if (Math.abs(x) < dz) x = 0`).
 * That is the classic snapping bug: a shallow diagonal has its smaller axis
 * zeroed and the character veers to a cardinal direction, and diagonals reach
 * full speed sooner than cardinals because each axis rescales independently.
 *
 * Duplicated from `GamepadSource` on purpose: the documented dependency rule is
 * that drivers do not import from each other, and a shared `engine/input/`
 * maths module is the right home for it the moment a third consumer appears.
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

  // A thumb dragged past the ring reports >1; clamp before rescaling so the
  // stick cannot outrun the movement system's assumptions.
  const clampedMagnitude = Math.min(1, magnitude);
  const ramped = (clampedMagnitude - dz) / (1 - dz);

  // Divide by the *original* magnitude so (x, y) is scaled uniformly; the
  // output magnitude then equals `ramped` and the angle is untouched.
  const scale = ramped / magnitude;
  return { x: rawX * scale, y: rawY * scale };
}

export class TouchSource {
  private readonly emitter = new Emitter<TouchSourceEvents>();
  private readonly options: TouchSourceOptions;
  private readonly target: EventTarget | null;

  private surface: HTMLElement | null;
  private definitions: readonly TouchControlDefinition[];
  private currentContext: TouchContext;

  private attached = false;
  private aiming = false;

  /** Live contacts, keyed by `pointerId`. One claim each, never reassigned. */
  private readonly pointers = new Map<number, PointerClaim>();

  /** Stick output in [-1,1], y already flipped so +1 is forward. */
  private moveX = 0;
  private moveY = 0;

  /** Look delta accumulated since the last `sample`, in radians. */
  private lookDeltaX = 0;
  private lookDeltaY = 0;

  /** The delta the most recent `sample` reported. Not consumed by reading. */
  private sampledLookX = 0;
  private sampledLookY = 0;

  /**
   * Actions whose contact began and ended between two samples. Held state alone
   * would show these as "never pressed", so they are replayed as pulses.
   */
  private readonly pendingPulses = new Set<ButtonAction>();
  /**
   * Pulses being held down for one sample because the sink cannot pulse. Kept
   * separate from `pendingPulses` so a tap is visible for exactly one sample.
   */
  private readonly latchedPulses = new Set<ButtonAction>();

  private viewportWidth = 0;
  private viewportHeight = 0;
  private insets: TouchInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private insetOverride: TouchInsets | null = null;

  /** Cached tuning, refreshed by `sample` and by every layout query. */
  private tuning: TouchTuning;

  /** Where a floating stick was spawned, so the HUD can draw the ring there. */
  private floatingStick: { x: number; y: number; radius: number } | null = null;

  private previousTouchAction: string | null = null;
  private previousUserSelect: string | null = null;
  private gyroAttached = false;
  private gyroAlpha: number | null = null;
  private gyroBeta: number | null = null;

  constructor(options: TouchSourceOptions) {
    this.options = options;
    this.target = options.target ?? (typeof window !== 'undefined' ? window : null);
    this.surface =
      options.surface ?? (typeof document !== 'undefined' ? document.body : null);
    this.definitions = options.controls ?? DEFAULT_TOUCH_CONTROLS;
    this.currentContext = options.initialContext ?? 'exploration';
    this.tuning = options.getTuning();
    this.measure();
  }

  on = this.emitter.on.bind(this.emitter);

  // ---- Lifecycle --------------------------------------------------------

  attach(): void {
    if (this.attached) return;
    this.attached = true;

    this.tuning = this.options.getTuning();
    this.measure();

    const surface = this.surface;
    if (surface) {
      // Without this the browser owns the gesture: a look drag becomes a page
      // scroll and a double tap becomes a zoom.
      this.previousTouchAction = surface.style.touchAction;
      this.previousUserSelect = surface.style.userSelect;
      surface.style.touchAction = 'none';
      surface.style.userSelect = 'none';
      surface.addEventListener('pointerdown', this.onPointerDown);
      surface.addEventListener('contextmenu', this.onContextMenu);
    }

    // Move/up/cancel on the shared target, not the surface: a thumb that slides
    // past the canvas edge must keep steering, and `setPointerCapture` is
    // missing in jsdom and unreliable in older mobile WebViews.
    this.target?.addEventListener('pointermove', this.onPointerMove);
    this.target?.addEventListener('pointerup', this.onPointerUp);
    this.target?.addEventListener('pointercancel', this.onPointerCancel);
    this.target?.addEventListener('resize', this.onViewportChange);
    this.target?.addEventListener('orientationchange', this.onViewportChange);

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }

    this.syncGyro(this.tuning.gyroAim);
  }

  /** Removes every listener added by `attach` and releases every contact. */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;

    const surface = this.surface;
    if (surface) {
      surface.removeEventListener('pointerdown', this.onPointerDown);
      surface.removeEventListener('contextmenu', this.onContextMenu);
      surface.style.touchAction = this.previousTouchAction ?? '';
      surface.style.userSelect = this.previousUserSelect ?? '';
      this.previousTouchAction = null;
      this.previousUserSelect = null;
    }

    this.target?.removeEventListener('pointermove', this.onPointerMove);
    this.target?.removeEventListener('pointerup', this.onPointerUp);
    this.target?.removeEventListener('pointercancel', this.onPointerCancel);
    this.target?.removeEventListener('resize', this.onViewportChange);
    this.target?.removeEventListener('orientationchange', this.onViewportChange);

    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }

    this.syncGyro(false);
    this.releaseAll();
    // The source is going away; a queued tap has nothing left to deliver it to.
    this.pendingPulses.clear();
    this.latchedPulses.clear();
  }

  /** Detaches and drops event subscriptions, which `detach` deliberately keeps. */
  dispose(): void {
    this.detach();
    this.emitter.clear();
  }

  /**
   * Drops every contact and pending delta.
   *
   * Required on `pointercancel` and on tab switches: a finger lifted while the
   * page is hidden never delivers its `pointerup`, so the player would come
   * back to a character walking into a wall with `sprint` stuck down.
   *
   * Contacts released this way are treated as *cancelled*, so a button that was
   * touched but never sampled does not queue a tap. An interrupted gesture is
   * not a deliberate press, and a phantom `interact` is worse than a missed one.
   * Taps that completed normally and are still waiting to be sampled survive.
   */
  releaseAll(): void {
    for (const [pointerId, claim] of [...this.pointers]) {
      this.pointers.delete(pointerId);
      this.finishClaim(pointerId, claim, true);
    }
    this.moveX = 0;
    this.moveY = 0;
    this.lookDeltaX = 0;
    this.lookDeltaY = 0;
    this.floatingStick = null;
    this.gyroAlpha = null;
    this.gyroBeta = null;
  }

  // ---- Sampling ---------------------------------------------------------

  /**
   * Writes the current state into `sink`. Call once per fixed step.
   *
   * Movement axes are absolute. Look axes are *relative*: the drag accumulated
   * since the previous sample, cleared here, so calling sample twice in one
   * step reports the second look as zero rather than turning the camera twice.
   *
   * Taps are the interesting case. A finger that touches and lifts between two
   * samples was never held when anything looked, so it is delivered through
   * `sink.pulseButton` (one guaranteed press edge). If the sink has no pulse
   * support the action is held for exactly this one sample instead, which is
   * less precise but still cannot be missed.
   */
  sample(sink: TouchInputSink): void {
    this.tuning = this.options.getTuning();
    this.syncGyro(this.tuning.gyroAim);

    sink.setAxis('moveX', this.moveX);
    sink.setAxis('moveY', this.moveY);

    sink.setAxis('lookX', this.lookDeltaX);
    sink.setAxis('lookY', this.lookDeltaY);
    this.sampledLookX = this.lookDeltaX;
    this.sampledLookY = this.lookDeltaY;
    this.lookDeltaX = 0;
    this.lookDeltaY = 0;

    const held = new Set<ButtonAction>();
    for (const claim of this.pointers.values()) {
      if (claim.kind !== 'button') continue;
      claim.sampledAsDown = true;
      held.add(claim.action);
    }

    const canPulse = typeof sink.pulseButton === 'function';
    for (const action of this.buttonActions()) {
      let down = held.has(action);

      if (this.pendingPulses.has(action)) {
        if (canPulse) {
          sink.pulseButton?.(action);
        } else {
          down = true;
          this.latchedPulses.add(action);
        }
      } else if (this.latchedPulses.has(action)) {
        // The latch lasted its one sample. Release it now so a single tap
        // cannot read as a hold.
        this.latchedPulses.delete(action);
      }

      sink.setButton(action, down);
    }

    this.pendingPulses.clear();
  }

  /**
   * Exact scaled look delta in radians, as reported by the most recent
   * `sample`. Reading does not consume it.
   *
   * The player camera should add this directly rather than treating `lookX` /
   * `lookY` as a rate: a drag has to be 1:1 with the thumb, and the axis write
   * is additionally clamped to [-1,1] downstream.
   */
  get lookDeltaRadians(): { x: number; y: number } {
    return { x: this.sampledLookX, y: this.sampledLookY };
  }

  // ---- Configuration ----------------------------------------------------

  get isAttached(): boolean {
    return this.attached;
  }

  get family(): InputFamily {
    return TOUCH_FAMILY;
  }

  get context(): TouchContext {
    return this.currentContext;
  }

  /**
   * Switches the visible control set.
   *
   * Contacts on controls that the new context removes are released, otherwise a
   * button hidden mid-press would stay down with nothing left to lift it.
   */
  setContext(context: TouchContext): void {
    if (context === this.currentContext) return;
    const previous = this.currentContext;
    this.currentContext = context;

    for (const [pointerId, claim] of [...this.pointers]) {
      if (this.isControlActive(claim.controlId)) continue;
      this.pointers.delete(pointerId);
      this.finishClaim(pointerId, claim, true);
    }

    this.emitter.emit('contextChanged', { context, previous });
    this.emitLayoutChanged();
  }

  /** Replaces the control table. Live contacts are released first. */
  setControls(controls: readonly TouchControlDefinition[]): void {
    const seen = new Set<string>();
    for (const control of controls) {
      if (seen.has(control.id)) {
        throw new Error(`[touch] duplicate control id "${control.id}"`);
      }
      seen.add(control.id);
      if (control.kind === 'button' && !control.action) {
        throw new Error(`[touch] button control "${control.id}" has no action`);
      }
    }

    this.releaseAll();
    this.definitions = [...controls];
    this.emitLayoutChanged();
  }

  getControlDefinitions(): readonly TouchControlDefinition[] {
    return this.definitions;
  }

  /** Where look sensitivity comes from. Aiming uses its own setting. */
  setAiming(aiming: boolean): void {
    this.aiming = aiming;
  }

  get isAiming(): boolean {
    return this.aiming;
  }

  /** Points `pointerdown` at a different element. Re-binds listeners if attached. */
  setSurface(surface: HTMLElement | null): void {
    if (surface === this.surface) return;
    const wasAttached = this.attached;
    if (wasAttached) this.detach();
    this.surface = surface;
    if (wasAttached) this.attach();
  }

  /**
   * Overrides the measured safe-area insets, or clears the override with null.
   *
   * The default measurement reads CSS custom properties, which is the only way
   * to see `env(safe-area-inset-*)` from script. A host that already knows the
   * cutout geometry can push it here instead.
   */
  setSafeAreaInsets(insets: TouchInsets | null): void {
    this.insetOverride = insets;
    this.refreshLayout();
  }

  get safeArea(): TouchInsets {
    return this.insets;
  }

  get viewport(): TouchViewport {
    return { width: this.viewportWidth, height: this.viewportHeight };
  }

  /** Re-measures the viewport and safe area, and emits `layoutChanged`. */
  refreshLayout(): void {
    this.tuning = this.options.getTuning();
    this.measure();
    this.emitLayoutChanged();
  }

  // ---- Reporting --------------------------------------------------------

  /**
   * Every control in the current context with its resolved rect.
   *
   * This is the whole contract with the HUD, the layout editor and the tutorial
   * highlighter: they render from these rects and this file never touches DOM.
   */
  getLayout(): TouchLayoutSnapshot {
    this.tuning = this.options.getTuning();
    const controls: TouchControlState[] = [];
    for (const definition of this.definitions) {
      if (!definition.contexts.includes(this.currentContext)) continue;
      controls.push(this.resolveControl(definition));
    }

    return {
      viewport: this.viewport,
      safeArea: this.insets,
      scale: this.viewportScale(),
      opacity: clamp(numberOr(this.tuning.opacity, 1), 0, 1),
      handedness: this.tuning.handedness === 'left' ? 'left' : 'right',
      context: this.currentContext,
      controls,
    };
  }

  getControls(): readonly TouchControlState[] {
    return this.getLayout().controls;
  }

  /** Resolved rect for one control, or null when it is not in this context. */
  getControlRect(id: string): TouchRect | null {
    const definition = this.definitions.find((entry) => entry.id === id);
    if (!definition || !definition.contexts.includes(this.currentContext)) return null;
    this.tuning = this.options.getTuning();
    return this.resolveControl(definition).rect;
  }

  /** Pointer claim regions, for diagnostics and the layout editor's guides. */
  getRegions(): { stick: TouchRect | null; look: TouchRect | null } {
    this.tuning = this.options.getTuning();
    let stick: TouchRect | null = null;
    let look: TouchRect | null = null;
    for (const definition of this.definitions) {
      if (!definition.contexts.includes(this.currentContext)) continue;
      if (definition.kind === 'stick') stick = this.resolveControl(definition).zone;
      else if (definition.kind === 'look') look = this.resolveControl(definition).zone;
    }
    return { stick, look };
  }

  isControlPressed(id: string): boolean {
    for (const claim of this.pointers.values()) {
      if (claim.controlId === id) return true;
    }
    return false;
  }

  /** Live contacts. Three is the number that has to work. */
  get activePointerCount(): number {
    return this.pointers.size;
  }

  /** Read-only view of every live claim, for the diagnostics overlay. */
  getActiveClaims(): readonly TouchPointerClaim[] {
    const out: TouchPointerClaim[] = [];
    for (const [pointerId, claim] of this.pointers) {
      out.push({ ...claim, pointerId });
    }
    return out;
  }

  /** Last stick vector, +y forward. Matches what `sample` reported. */
  getMoveVector(): { x: number; y: number } {
    return { x: this.moveX, y: this.moveY };
  }

  /**
   * Fires a short haptic tap.
   *
   * Optional polish: a disabled setting, a browser without `navigator.vibrate`
   * (every iOS browser, at the time of writing) and a rejected call must all be
   * silent no-ops rather than an exception on an input code path.
   */
  vibrate(durationMs: number): boolean {
    if (!this.tuning.vibration) return false;
    if (typeof navigator === 'undefined') return false;
    const vibrator = (navigator as Navigator & { vibrate?: (pattern: number) => boolean }).vibrate;
    if (typeof vibrator !== 'function') return false;
    const duration = clamp(numberOr(durationMs, 0), 0, 200);
    if (duration <= 0) return false;
    try {
      return vibrator.call(navigator, duration);
    } catch {
      return false;
    }
  }

  // ---- Pointer handlers -------------------------------------------------

  private readonly onPointerDown = (event: Event): void => {
    const pointer = asPointerEvent(event);
    if (!pointer || !this.acceptsPointerType(pointer.pointerType)) return;
    // A second event for a pointer we already track would overwrite its claim.
    if (this.pointers.has(pointer.pointerId)) return;
    // DOM UI drawn over the surface owns its own presses; the joystick must not
    // claim a tap on a menu button that happened to bubble up here.
    if (isPassthroughTarget(pointer.target)) return;

    const claimed = this.claimPointer(pointer);
    if (!claimed) return;

    // Only once a region has taken the contact: cancelling an unclaimed press
    // would break scrolling in any DOM overlay above the surface.
    if (pointer.cancelable) pointer.preventDefault();
  };

  private readonly onPointerMove = (event: Event): void => {
    const pointer = asPointerEvent(event);
    if (!pointer) return;
    const claim = this.pointers.get(pointer.pointerId);
    if (!claim) return;

    const x = pointer.clientX;
    const y = pointer.clientY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    if (claim.kind === 'stick') {
      this.updateStick(claim, x, y);
    } else if (claim.kind === 'look') {
      const dx = x - claim.lastX;
      const dy = y - claim.lastY;
      claim.lastX = x;
      claim.lastY = y;
      this.accumulateLook(dx, dy);
    }
    // Buttons ignore movement entirely. That is the whole reason a press cannot
    // become a camera jump: the contact is not a look pointer, so its motion is
    // never read.

    if (pointer.cancelable) pointer.preventDefault();
  };

  private readonly onPointerUp = (event: Event): void => {
    const pointer = asPointerEvent(event);
    if (!pointer) return;
    const claim = this.pointers.get(pointer.pointerId);
    if (!claim) return;
    this.pointers.delete(pointer.pointerId);
    this.finishClaim(pointer.pointerId, claim, false);
  };

  private readonly onPointerCancel = (event: Event): void => {
    const pointer = asPointerEvent(event);
    if (!pointer) {
      // A cancel we cannot attribute is still a cancel; dropping everything is
      // the safe reading, because the alternative is a stuck control.
      this.releaseAll();
      return;
    }
    const claim = this.pointers.get(pointer.pointerId);
    if (!claim) return;
    this.pointers.delete(pointer.pointerId);
    this.finishClaim(pointer.pointerId, claim, true);
  };

  private readonly onContextMenu = (event: Event): void => {
    // A long press on a phone opens the selection/context menu, which steals
    // the contact mid-drag.
    if (event.cancelable) event.preventDefault();
  };

  private readonly onVisibilityChange = (): void => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'hidden') this.releaseAll();
  };

  private readonly onViewportChange = (): void => {
    // Rotating the device changes every rect. Contacts are deliberately kept:
    // the player's thumb is still on the glass.
    this.tuning = this.options.getTuning();
    this.measure();
    this.emitLayoutChanged();
  };

  private readonly onDeviceOrientation = (event: Event): void => {
    const orientation = event as DeviceOrientationEvent;
    const alpha = orientation.alpha;
    const beta = orientation.beta;
    if (typeof alpha !== 'number' || typeof beta !== 'number') return;
    if (!Number.isFinite(alpha) || !Number.isFinite(beta)) return;

    if (this.gyroAlpha === null || this.gyroBeta === null) {
      // First reading is the reference frame only. Treating an absolute
      // heading as a delta would snap the camera to wherever north is.
      this.gyroAlpha = alpha;
      this.gyroBeta = beta;
      return;
    }

    const yaw = shortestAngleDelta(this.gyroAlpha, alpha);
    const pitch = beta - this.gyroBeta;
    this.gyroAlpha = alpha;
    this.gyroBeta = beta;

    const scale = TOUCH_GYRO_RADIANS_PER_DEGREE * this.lookSensitivity();
    if (Math.abs(yaw) > TOUCH_GYRO_NOISE_DEGREES) {
      // Compass alpha increases counter-clockwise; lookX is positive to the
      // right, hence the flip.
      this.lookDeltaX += -yaw * scale;
    }
    if (Math.abs(pitch) > TOUCH_GYRO_NOISE_DEGREES) {
      this.lookDeltaY += pitch * scale * (this.tuning.invertY ? -1 : 1);
    }
  };

  // ---- Claiming ---------------------------------------------------------

  /**
   * Assigns a contact to exactly one region, or ignores it.
   *
   * Priority is buttons, then the stick, then the look region. Buttons win
   * because they are drawn inside the look half; the look region is last
   * because it is the biggest and least specific target.
   *
   * A region that already owns a contact does not take a second one. That is
   * what "never stolen" means in the other direction: a second thumb in the
   * left half while the stick is held does nothing rather than teleporting the
   * stick origin out from under the first thumb.
   */
  private claimPointer(pointer: PointerLike): boolean {
    const x = pointer.clientX;
    const y = pointer.clientY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;

    this.tuning = this.options.getTuning();

    const buttons: TouchControlState[] = [];
    let stick: { state: TouchControlState; definition: TouchControlDefinition } | null = null;
    let look: TouchControlState | null = null;

    for (const definition of this.definitions) {
      if (!definition.contexts.includes(this.currentContext)) continue;
      const state = this.resolveControl(definition);
      if (!state.visible) continue;
      if (definition.kind === 'button') buttons.push(state);
      else if (definition.kind === 'stick') stick = { state, definition };
      else look = state;
    }

    // Smallest button first: overlapping hit padding should resolve to the
    // control the thumb is actually nearest to.
    buttons.sort((a, b) => a.radius - b.radius);
    const padding = BUTTON_HIT_PADDING * this.viewportScale();
    for (const button of buttons) {
      if (!button.action) continue;
      const hitRadius = button.radius + padding;
      if (Math.hypot(x - centreX(button.rect), y - centreY(button.rect)) > hitRadius) continue;

      // A second finger on a button already held is swallowed, not passed on.
      // Letting it fall through would hand it to the look region the buttons
      // are drawn inside, and the camera would jump on a double-press.
      if (this.isControlPressed(button.id)) return true;

      this.pointers.set(pointer.pointerId, {
        kind: 'button',
        controlId: button.id,
        action: button.action,
        downAtMs: nowMs(),
        sampledAsDown: false,
      });
      this.emitter.emit('controlPressed', {
        id: button.id,
        kind: 'button',
        action: button.action,
        pointerId: pointer.pointerId,
        rect: button.rect,
      });
      if (this.tuning.vibration) this.vibrate(12);
      return true;
    }

    if (stick && stick.state.zone && rectContains(stick.state.zone, x, y)) {
      if (!this.isControlPressed(stick.state.id)) {
        const radius = stick.state.radius;
        const floating = this.tuning.joystickMode === 'floating';
        const originX = floating ? x : centreX(stick.state.rect);
        const originY = floating ? y : centreY(stick.state.rect);

        if (floating) {
          // The ring is drawn where the thumb landed. Deliberately not clamped
          // into the safe area: moving the origin would register movement the
          // player never asked for, and the thumb is already at that spot.
          this.floatingStick = { x: originX, y: originY, radius };
        }

        const claim: StickClaim = {
          kind: 'stick',
          controlId: stick.state.id,
          originX,
          originY,
          radius,
        };
        this.pointers.set(pointer.pointerId, claim);
        this.emitter.emit('controlPressed', {
          id: stick.state.id,
          kind: 'stick',
          action: null,
          pointerId: pointer.pointerId,
          rect: this.resolveControl(stick.definition).rect,
        });
        // Fixed mode: the contact starts off-centre, so the stick is already
        // deflected. Floating mode: origin equals the touch, so this is zero.
        this.updateStick(claim, x, y);
      }
      return true;
    }

    if (look && look.zone && rectContains(look.zone, x, y)) {
      if (!this.isControlPressed(look.id)) {
        this.pointers.set(pointer.pointerId, {
          kind: 'look',
          controlId: look.id,
          lastX: x,
          lastY: y,
        });
        this.emitter.emit('controlPressed', {
          id: look.id,
          kind: 'look',
          action: null,
          pointerId: pointer.pointerId,
          rect: look.rect,
        });
        // No delta on touchdown. Reporting the absolute position would snap the
        // camera by half a screen every time the player put a thumb down.
      }
      return true;
    }

    return false;
  }

  /** Releases a claim: zeroes its contribution and emits `controlReleased`. */
  private finishClaim(pointerId: number, claim: PointerClaim, cancelled: boolean): void {
    let tap = false;
    let durationMs = 0;

    if (claim.kind === 'stick') {
      this.moveX = 0;
      this.moveY = 0;
      this.floatingStick = null;
    } else if (claim.kind === 'button') {
      durationMs = Math.max(0, nowMs() - claim.downAtMs);
      // Never observed as held: the press has to be replayed as a pulse or the
      // player's tap is silently discarded. A cancelled contact is exempt —
      // the browser took the gesture, the player did not finish a press.
      tap = !cancelled && !claim.sampledAsDown;
      if (tap) this.pendingPulses.add(claim.action);
    }

    this.emitter.emit('controlReleased', {
      id: claim.controlId,
      kind: claim.kind,
      action: claim.kind === 'button' ? claim.action : null,
      pointerId,
      durationMs,
      tap,
    });
  }

  private updateStick(claim: StickClaim, x: number, y: number): void {
    const radius = claim.radius > 0 ? claim.radius : 1;
    const rawX = (x - claim.originX) / radius;
    // Screen Y grows downward; moveY is positive forward.
    const rawY = -(y - claim.originY) / radius;

    const deadzone = clamp(numberOr(this.tuning.joystickDeadzone, 0), 0, MAX_DEADZONE);
    const vector = applyRadialDeadzone(rawX, rawY, deadzone);
    this.moveX = vector.x;
    this.moveY = vector.y;
  }

  private accumulateLook(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    const scale = TOUCH_LOOK_RADIANS_PER_PIXEL * this.lookSensitivity();
    this.lookDeltaX += dx * scale;
    // Client Y grows downward but lookY is positive upward, hence the flip;
    // invertY undoes it for players who want plane-style pitch.
    this.lookDeltaY += -dy * scale * (this.tuning.invertY ? -1 : 1);
  }

  private lookSensitivity(): number {
    const raw = this.aiming ? this.tuning.aimSensitivity : this.tuning.cameraSensitivity;
    return clamp(numberOr(raw, 1), 0.05, 10);
  }

  private acceptsPointerType(pointerType: string): boolean {
    if (pointerType === 'mouse') return this.options.allowMouse === true;
    // Empty is not "unknown device", it is "a runtime that does not populate
    // pointerType" — jsdom, and a few old WebViews. Those are touch-only, so
    // treating it as touch is the useful reading.
    return pointerType === 'touch' || pointerType === 'pen' || pointerType === '';
  }

  private isControlActive(id: string): boolean {
    const definition = this.definitions.find((entry) => entry.id === id);
    return !!definition && definition.contexts.includes(this.currentContext);
  }

  private buttonActions(): readonly ButtonAction[] {
    // Every button in the *table*, not just the current context: a control that
    // a context switch removed must still be reported as released.
    const actions = new Set<ButtonAction>();
    for (const definition of this.definitions) {
      if (definition.kind === 'button' && definition.action) actions.add(definition.action);
    }
    return [...actions];
  }

  // ---- Layout -----------------------------------------------------------

  private measure(): void {
    const viewport = this.options.getViewport?.() ?? this.measureViewport();
    this.viewportWidth = viewport.width > 0 ? viewport.width : 1280;
    this.viewportHeight = viewport.height > 0 ? viewport.height : 720;
    this.insets = this.insetOverride ?? this.options.getSafeAreaInsets?.() ?? this.measureInsets();
  }

  private measureViewport(): TouchViewport {
    const surface = this.surface;
    if (surface && typeof surface.getBoundingClientRect === 'function') {
      const rect = surface.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return { width: rect.width, height: rect.height };
    }
    if (typeof window !== 'undefined') {
      // visualViewport is the honest size on mobile: it shrinks when the URL
      // bar or the on-screen keyboard is showing, innerHeight often does not.
      const visual = window.visualViewport;
      if (visual && visual.width > 0 && visual.height > 0) {
        return { width: visual.width, height: visual.height };
      }
      if (window.innerWidth > 0 && window.innerHeight > 0) {
        return { width: window.innerWidth, height: window.innerHeight };
      }
    }
    return { width: 0, height: 0 };
  }

  /**
   * Reads the safe-area insets the app publishes as CSS custom properties.
   *
   * `env(safe-area-inset-*)` is not readable from script, so the convention is
   * that the stylesheet copies it into `--safe-area-inset-top` and friends on
   * `:root`. Missing properties read as 0, which is correct for a device
   * without a cutout.
   */
  private measureInsets(): TouchInsets {
    if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
      return { top: 0, right: 0, bottom: 0, left: 0 };
    }
    const style = getComputedStyle(document.documentElement);
    return {
      top: readPx(style, '--safe-area-inset-top'),
      right: readPx(style, '--safe-area-inset-right'),
      bottom: readPx(style, '--safe-area-inset-bottom'),
      left: readPx(style, '--safe-area-inset-left'),
    };
  }

  /**
   * Size multiplier from the viewport's shorter edge.
   *
   * A 200 px joystick is right on a 400 px-wide phone and comical on a tablet,
   * so controls scale with the device. Clamped tightly: a huge tablet should
   * not get huge buttons, it should get the same buttons with more space.
   */
  private viewportScale(): number {
    const shortEdge = Math.min(this.viewportWidth, this.viewportHeight);
    if (shortEdge <= 0) return 1;
    return clamp(shortEdge / REFERENCE_SHORT_EDGE, 0.8, 1.25);
  }

  /** The safe box: the viewport minus the insets. All anchors are relative to it. */
  private safeBox(): TouchRect {
    const left = Math.max(0, this.insets.left);
    const top = Math.max(0, this.insets.top);
    const width = Math.max(1, this.viewportWidth - left - Math.max(0, this.insets.right));
    const height = Math.max(1, this.viewportHeight - top - Math.max(0, this.insets.bottom));
    return { x: left, y: top, width, height };
  }

  private resolveControl(definition: TouchControlDefinition): TouchControlState {
    const box = this.safeBox();
    const scale = this.viewportScale();
    const mirrored = this.tuning.handedness === 'left';
    const override = this.tuning.layout?.[definition.id];

    let anchorX = definition.anchor.x;
    const anchorY = definition.anchor.y;
    // Mirror first, then apply the override: the player edited the layout they
    // could see, so their position is absolute in their chosen handedness.
    if (mirrored) anchorX = 1 - anchorX;
    if (override) {
      anchorX = clamp(numberOr(override.x, anchorX), 0, 1);
    }
    const resolvedY = override ? clamp(numberOr(override.y, anchorY), 0, 1) : anchorY;

    const sizeScale =
      definition.kind === 'stick'
        ? clamp(numberOr(this.tuning.joystickSize, 1), 0.5, 2)
        : clamp(numberOr(this.tuning.buttonScale, 1), 0.5, 2);
    const overrideScale = override ? clamp(numberOr(override.scale, 1), 0.5, 2) : 1;
    const diameter = definition.size * scale * sizeScale * overrideScale;
    const radius = diameter / 2;

    const zone = definition.zone ? this.resolveZone(definition.zone, box, mirrored) : null;

    let rect: TouchRect;
    if (definition.kind === 'look') {
      // The look region has no ring; its rect *is* its zone so the HUD can dim
      // it in the layout editor.
      rect = zone ?? box;
    } else if (definition.kind === 'stick' && this.floatingStick) {
      const stick = this.floatingStick;
      rect = {
        x: stick.x - stick.radius,
        y: stick.y - stick.radius,
        width: stick.radius * 2,
        height: stick.radius * 2,
      };
    } else {
      // Clamp so the whole control stays inside the safe box: this is what
      // keeps a button out from under a notch or the browser's chrome.
      const margin = EDGE_MARGIN * scale;
      const minCentreX = box.x + radius + margin;
      const maxCentreX = box.x + box.width - radius - margin;
      const minCentreY = box.y + radius + margin;
      const maxCentreY = box.y + box.height - radius - margin;
      const centreXPx = clampRange(box.x + anchorX * box.width, minCentreX, maxCentreX);
      const centreYPx = clampRange(box.y + resolvedY * box.height, minCentreY, maxCentreY);
      rect = {
        x: centreXPx - radius,
        y: centreYPx - radius,
        width: diameter,
        height: diameter,
      };
    }

    return {
      id: definition.id,
      kind: definition.kind,
      action: definition.action ?? null,
      label: definition.label,
      rect,
      radius: definition.kind === 'look' ? 0 : radius,
      zone,
      pressed: this.isControlPressed(definition.id),
      visible: override ? override.visible !== false : true,
      movable: definition.kind !== 'look',
    };
  }

  private resolveZone(zone: NormalisedRect, box: TouchRect, mirrored: boolean): TouchRect {
    // Mirroring a region reflects its far edge, not its origin, so the left
    // 42% becomes the right 42% rather than sliding off the screen.
    const x = mirrored ? 1 - zone.x - zone.width : zone.x;
    return {
      x: box.x + x * box.width,
      y: box.y + zone.y * box.height,
      width: zone.width * box.width,
      height: zone.height * box.height,
    };
  }

  private emitLayoutChanged(): void {
    this.emitter.emit('layoutChanged', { viewport: this.viewport, safeArea: this.insets });
  }

  // ---- Gyro -------------------------------------------------------------

  /**
   * Attaches or detaches the gyro listener to match the setting.
   *
   * Honest limitation: iOS requires `DeviceOrientationEvent.requestPermission()`
   * from a user gesture, which belongs in the settings UI, not here. Without
   * that grant no events arrive and gyro aim is simply inert. This path has not
   * been validated on real hardware.
   */
  private syncGyro(enabled: boolean): void {
    const want = enabled && this.attached;
    if (want === this.gyroAttached) return;

    if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) {
      this.gyroAttached = false;
      return;
    }

    if (want) {
      window.addEventListener('deviceorientation', this.onDeviceOrientation);
    } else {
      window.removeEventListener('deviceorientation', this.onDeviceOrientation);
      this.gyroAlpha = null;
      this.gyroBeta = null;
    }
    this.gyroAttached = want;
  }
}

// ---- Helpers ------------------------------------------------------------

/** The pointer fields this source reads. Keeps the handlers testable. */
interface PointerLike {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly clientX: number;
  readonly clientY: number;
  readonly cancelable: boolean;
  readonly target: EventTarget | null;
  preventDefault(): void;
}

/**
 * Narrows an `Event` to the pointer fields used here without assuming
 * `PointerEvent` exists as a global constructor.
 */
function asPointerEvent(event: Event): PointerLike | null {
  const candidate = event as Event & Partial<PointerLike>;
  if (typeof candidate.pointerId !== 'number') return null;
  if (typeof candidate.clientX !== 'number' || typeof candidate.clientY !== 'number') return null;
  return {
    pointerId: candidate.pointerId,
    pointerType: typeof candidate.pointerType === 'string' ? candidate.pointerType : '',
    clientX: candidate.clientX,
    clientY: candidate.clientY,
    cancelable: event.cancelable,
    target: event.target,
    preventDefault: () => event.preventDefault(),
  };
}

/**
 * True when the press landed on real DOM UI drawn above the game surface.
 *
 * `data-touch-passthrough` is the explicit opt-out for HUD panels; the element
 * list covers the ordinary controls a menu is built from.
 */
function isPassthroughTarget(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof Element)) return false;
  if (typeof target.closest !== 'function') return false;
  return (
    target.closest(
      '[data-touch-passthrough], button, input, select, textarea, a[href], [role="button"]',
    ) !== null
  );
}

function rectContains(rect: TouchRect, x: number, y: number): boolean {
  return (
    x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
  );
}

function centreX(rect: TouchRect): number {
  return rect.x + rect.width / 2;
}

function centreY(rect: TouchRect): number {
  return rect.y + rect.height / 2;
}

/** Shortest signed difference between two compass angles, in degrees. */
function shortestAngleDelta(from: number, to: number): number {
  let delta = (to - from) % 360;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

function readPx(style: CSSStyleDeclaration, property: string): number {
  const raw = style.getPropertyValue(property).trim();
  if (raw === '') return 0;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function numberOr(value: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Like `clamp`, but tolerates min > max (a control wider than its safe box). */
function clampRange(value: number, min: number, max: number): number {
  if (min > max) return (min + max) / 2;
  return Math.min(max, Math.max(min, value));
}
