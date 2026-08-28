/**
 * Resolved input for the current simulation step.
 *
 * `InputState` is the boundary between devices and gameplay. Device drivers
 * (keyboard/mouse, gamepad, touch) push into it; every system above reads
 * named actions out of it. Nothing above this file knows what a keycode is.
 *
 * ## Frame contract
 *
 * Exactly one `beginFrame(dt)` / `endFrame()` pair per fixed simulation step:
 *
 * ```
 * input.beginFrame(dt);   // latch device state, derive edges, accrue holds
 *   ...all gameplay systems read actions here, seeing identical values...
 * input.endFrame();       // clear this step's edges
 * ```
 *
 * Reads are **latched**, not live. Drivers mutate raw device state whenever the
 * browser dispatches an event, which can be mid-step; if systems read that
 * directly, the first system in a step could see a press the last one misses.
 * `beginFrame` takes one snapshot and everything in the step reads that.
 *
 * Edges are only ever *set* by `beginFrame` and only ever *cleared* by
 * `endFrame`, so calling `endFrame` on its own — or reading between steps —
 * cannot manufacture a press that never happened. This matters more than it
 * sounds: an `interact` that fires every frame instead of once turns a door
 * into a strobe light.
 *
 * ## Multiple simultaneous sources
 *
 * A player may hold a key, rest a thumb on a stick and have a touch HUD
 * mounted, all at once. Contributions combine rather than overwrite:
 *
 *   - **Axes** take the contribution with the largest magnitude, so an idle
 *     keyboard reporting 0 never zeroes a live gamepad stick.
 *   - **Buttons** are OR-ed, so any source can hold an action down.
 *
 * Raw device state persists across steps: a keyboard driver sets `sprint` down
 * on keydown and up on keyup and says nothing in between, which is exactly
 * what held-until-released should mean.
 */

import { Emitter, type Handler, type Unsubscribe } from '../events';
import {
  AXIS_ACTIONS,
  BUTTON_ACTIONS,
  INPUT_FAMILIES,
  type AxisAction,
  type ButtonAction,
  type InputFamily,
} from './actions';

const AXIS_COUNT = AXIS_ACTIONS.length;
const BUTTON_COUNT = BUTTON_ACTIONS.length;

/** Name → dense array index. Built from the exported order, never by hand. */
function buildIndex<T extends string>(names: readonly T[]): Readonly<Record<T, number>> {
  const out = {} as Record<T, number>;
  names.forEach((name, index) => {
    out[name] = index;
  });
  return out;
}

const AXIS_INDEX = buildIndex(AXIS_ACTIONS);
const BUTTON_INDEX = buildIndex(BUTTON_ACTIONS);

export type InputStateEvents = {
  /**
   * The player switched device family. Prompts and HUD must swap immediately —
   * a controller player being told to "press E" is a bug report.
   */
  familyChanged: { family: InputFamily; previous: InputFamily };
};

export interface InputStateOptions {
  /**
   * Axis magnitude a family must exceed to claim `activeFamily`.
   *
   * Worn analogue sticks idle around 0.05–0.15, and without a floor that drift
   * would fight the keyboard for ownership of the prompts every step. This is
   * *only* for family attribution — movement deadzones belong to the gamepad
   * and touch drivers, which apply the player's configured values.
   */
  readonly familyDeadzone?: number;
  /**
   * Family assumed before any input arrives. Boot should pass 'touch' on a
   * touch-primary device so the first frame already shows the right HUD.
   */
  readonly initialFamily?: InputFamily;
}

/**
 * Raw, unresolved state for one device family.
 *
 * Held state lives here and survives across steps. Pulses are the exception:
 * see `pulseButton`.
 */
interface FamilySource {
  /** Latest axis values from this family, each clamped to [-1,1]. */
  readonly axes: Float64Array;
  /** Currently held buttons, as reported by the driver. */
  readonly down: Uint8Array;
  /** Resolved-for-this-family held state at the previous latch. */
  readonly downAtLastLatch: Uint8Array;
  /** Taps queued since the last latch, waiting to be shown to gameplay. */
  readonly pendingPulses: Uint8Array;
  /** Taps held open for exactly the current step. */
  readonly activePulses: Uint8Array;
}

function createFamilySource(): FamilySource {
  return {
    axes: new Float64Array(AXIS_COUNT),
    down: new Uint8Array(BUTTON_COUNT),
    downAtLastLatch: new Uint8Array(BUTTON_COUNT),
    pendingPulses: new Uint8Array(BUTTON_COUNT),
    activePulses: new Uint8Array(BUTTON_COUNT),
  };
}

export class InputState {
  private readonly emitter = new Emitter<InputStateEvents>();

  private readonly familyDeadzone: number;

  private readonly sources: Readonly<Record<InputFamily, FamilySource>> = {
    keyboard: createFamilySource(),
    gamepad: createFamilySource(),
    touch: createFamilySource(),
  };

  // ---- Latched state, valid for the whole step -------------------------
  private readonly axes = new Float64Array(AXIS_COUNT);
  private readonly down = new Uint8Array(BUTTON_COUNT);
  private readonly previousDown = new Uint8Array(BUTTON_COUNT);
  private readonly pressed = new Uint8Array(BUTTON_COUNT);
  private readonly released = new Uint8Array(BUTTON_COUNT);
  private readonly holdSeconds = new Float64Array(BUTTON_COUNT);

  private family: InputFamily;
  private frameOpen = false;

  constructor(options: InputStateOptions = {}) {
    this.familyDeadzone = clampDeadzone(options.familyDeadzone ?? 0.2);
    this.family = options.initialFamily ?? 'keyboard';
  }

  // -------------------------------------------------------------------------
  // Subscription
  // -------------------------------------------------------------------------

  on<K extends keyof InputStateEvents>(
    event: K,
    handler: Handler<InputStateEvents[K]>,
  ): Unsubscribe {
    return this.emitter.on(event, handler);
  }

  // -------------------------------------------------------------------------
  // Driver-facing writes
  // -------------------------------------------------------------------------

  /**
   * Reports an axis value for one family. Non-finite input is treated as 0
   * rather than poisoning the axis: a single NaN from a flaky gamepad would
   * otherwise propagate into the player's position and never recover.
   */
  setAxis(family: InputFamily, action: AxisAction, value: number): void {
    const clamped = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
    this.sources[family].axes[AXIS_INDEX[action]] = clamped;
  }

  /**
   * Reports held state for one family. State persists until changed, so a
   * driver sets it on keydown/keyup and stays quiet in between.
   *
   * A press and release that both land inside a single step would be latched
   * as "never happened". Drivers that can see that — touch taps, or a fast
   * click at 30 Hz — must use `pulseButton` instead.
   */
  setButton(family: InputFamily, action: ButtonAction, down: boolean): void {
    this.sources[family].down[BUTTON_INDEX[action]] = down ? 1 : 0;
  }

  /**
   * Queues a tap: one guaranteed press edge, held for exactly one step and
   * released on the next, regardless of how briefly the real contact lasted.
   *
   * Latched at the *next* `beginFrame`, so a tap arriving mid-step is shown to
   * gameplay on the following step rather than dropped.
   */
  pulseButton(family: InputFamily, action: ButtonAction): void {
    this.sources[family].pendingPulses[BUTTON_INDEX[action]] = 1;
  }

  // -------------------------------------------------------------------------
  // Frame lifecycle
  // -------------------------------------------------------------------------

  /**
   * Opens a step: latches device state, derives press/release edges, accrues
   * hold durations and re-evaluates the active family.
   *
   * @param dt Seconds this step covers — the fixed step, never a render delta.
   */
  beginFrame(dt: number): void {
    if (this.frameOpen) {
      // Two opens without a close means the caller's ordering is wrong and a
      // step's edges were never read. Say so instead of hiding it.
      console.warn(
        '[input] beginFrame called twice without endFrame; the previous step\'s edges were dropped',
      );
    }

    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;

    // Advance pulses first: last step's taps expire now, this step's become
    // visible. Anything queued after this point waits for the next latch.
    for (const familyName of INPUT_FAMILIES) {
      const source = this.sources[familyName];
      source.activePulses.set(source.pendingPulses);
      source.pendingPulses.fill(0);
    }

    for (let i = 0; i < AXIS_COUNT; i += 1) {
      this.axes[i] = this.resolveAxis(i);
    }

    this.previousDown.set(this.down);

    for (let i = 0; i < BUTTON_COUNT; i += 1) {
      const isDown = this.resolveButton(i);
      this.down[i] = isDown ? 1 : 0;
      this.pressed[i] = isDown && this.previousDown[i] === 0 ? 1 : 0;
      this.released[i] = !isDown && this.previousDown[i] === 1 ? 1 : 0;
      // Hold time counts the step in which the press was observed, so after n
      // steps of holding the value is n * dt.
      this.holdSeconds[i] = isDown ? this.holdSeconds[i] + step : 0;
    }

    this.updateActiveFamily();

    // Per-family latch snapshot, taken after family attribution has used the
    // previous one to spot fresh presses.
    for (const familyName of INPUT_FAMILIES) {
      const source = this.sources[familyName];
      for (let i = 0; i < BUTTON_COUNT; i += 1) {
        source.downAtLastLatch[i] = source.down[i] === 1 || source.activePulses[i] === 1 ? 1 : 0;
      }
    }

    this.frameOpen = true;
  }

  /**
   * Closes the step and clears its edges.
   *
   * Held state, axes and hold durations survive — only the one-frame-only
   * signals are dropped, which is what keeps `wasPressed` true for exactly one
   * step. Safe to call without a matching `beginFrame`; it can only ever clear.
   */
  endFrame(): void {
    this.pressed.fill(0);
    this.released.fill(0);
    this.frameOpen = false;
  }

  /** True between `beginFrame` and `endFrame`. For diagnostics and asserts. */
  get frameIsOpen(): boolean {
    return this.frameOpen;
  }

  // -------------------------------------------------------------------------
  // Gameplay-facing reads
  // -------------------------------------------------------------------------

  /** Axis value in [-1,1] for this step. */
  getAxis(action: AxisAction): number {
    return this.axes[AXIS_INDEX[action]];
  }

  /** Held right now, whether it started this step or twenty steps ago. */
  isDown(action: ButtonAction): boolean {
    return this.down[BUTTON_INDEX[action]] === 1;
  }

  /** Went down during this step. True for exactly one step per press. */
  wasPressed(action: ButtonAction): boolean {
    return this.pressed[BUTTON_INDEX[action]] === 1;
  }

  /** Came up during this step. True for exactly one step per release. */
  wasReleased(action: ButtonAction): boolean {
    return this.released[BUTTON_INDEX[action]] === 1;
  }

  /**
   * Seconds the action has been continuously held, 0 when it is up.
   *
   * Counts the step the press was latched in, so it reaches `n * dt` after n
   * steps. Drives hold-to-interact progress rings and hold-to-skip.
   */
  getHoldDuration(action: ButtonAction): number {
    return this.holdSeconds[BUTTON_INDEX[action]];
  }

  /** Any button pressed this step. For "press anything to continue" screens. */
  anyPressed(): boolean {
    for (let i = 0; i < BUTTON_COUNT; i += 1) {
      if (this.pressed[i] === 1) return true;
    }
    return false;
  }

  /**
   * The family that most recently produced deliberate input.
   *
   * Deliberate means a fresh button press or an axis past `familyDeadzone`;
   * stick drift and a leaning thumb do not count.
   */
  get activeFamily(): InputFamily {
    return this.family;
  }

  // -------------------------------------------------------------------------
  // Reset
  // -------------------------------------------------------------------------

  /**
   * Drops all input state.
   *
   * Called on window blur, pointer-lock loss and state transitions. Without
   * it, a key held while alt-tabbing never sees its keyup and the player
   * sprints into a wall on return.
   *
   * `activeFamily` deliberately survives: losing focus is not a reason to
   * redraw every prompt as a keyboard key. No `familyChanged` is emitted.
   */
  reset(): void {
    for (const familyName of INPUT_FAMILIES) {
      const source = this.sources[familyName];
      source.axes.fill(0);
      source.down.fill(0);
      source.downAtLastLatch.fill(0);
      source.pendingPulses.fill(0);
      source.activePulses.fill(0);
    }

    this.axes.fill(0);
    this.down.fill(0);
    this.previousDown.fill(0);
    this.pressed.fill(0);
    this.released.fill(0);
    this.holdSeconds.fill(0);
    this.frameOpen = false;
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  /**
   * Largest-magnitude contribution wins.
   *
   * An exact tie — keyboard at -1 against a stick at +1 — resolves toward the
   * active family, so the answer follows the player's current device rather
   * than the declaration order of `INPUT_FAMILIES`.
   */
  private resolveAxis(index: number): number {
    let winner = 0;
    let bestMagnitude = 0;

    for (const familyName of INPUT_FAMILIES) {
      const value = this.sources[familyName].axes[index];
      const magnitude = Math.abs(value);
      if (magnitude > bestMagnitude) {
        bestMagnitude = magnitude;
        winner = value;
      }
    }

    if (bestMagnitude === 0) return 0;

    const activeValue = this.sources[this.family].axes[index];
    if (Math.abs(activeValue) === bestMagnitude) return activeValue;

    return winner;
  }

  /** OR across families, counting this step's pulses as held. */
  private resolveButton(index: number): boolean {
    for (const familyName of INPUT_FAMILIES) {
      const source = this.sources[familyName];
      if (source.down[index] === 1 || source.activePulses[index] === 1) return true;
    }
    return false;
  }

  /**
   * Picks the family that acted this step and emits on change.
   *
   * A fresh press outranks stick motion: pressing a key while a thumb rests on
   * a stick is an unambiguous statement of intent. Among axis-only claims the
   * largest magnitude wins, and a tie leaves the current family in place so
   * two devices at equal deflection cannot flap the prompts every step.
   */
  private updateActiveFamily(): void {
    let bestFamily: InputFamily | null = null;
    let bestScore = 0;

    for (const familyName of INPUT_FAMILIES) {
      const score = this.familyActivity(familyName);
      if (score <= 0) continue;
      if (score > bestScore) {
        bestScore = score;
        bestFamily = familyName;
      } else if (score === bestScore && familyName === this.family) {
        bestFamily = familyName;
      }
    }

    if (bestFamily === null || bestFamily === this.family) return;

    const previous = this.family;
    this.family = bestFamily;
    this.emitter.emit('familyChanged', { family: bestFamily, previous });
  }

  /**
   * How strongly a family is claiming ownership this step.
   *
   * Buttons score above any possible axis score so a press always wins.
   * Returns 0 when the family did nothing deliberate.
   */
  private familyActivity(familyName: InputFamily): number {
    const source = this.sources[familyName];

    for (let i = 0; i < BUTTON_COUNT; i += 1) {
      const isDown = source.down[i] === 1 || source.activePulses[i] === 1;
      // Only the down transition counts. A held key must not keep re-claiming
      // ownership while the player is steering with the other hand.
      if (isDown && source.downAtLastLatch[i] === 0) return 2;
    }

    let strongest = 0;
    for (let i = 0; i < AXIS_COUNT; i += 1) {
      const magnitude = Math.abs(source.axes[i]);
      if (magnitude > strongest) strongest = magnitude;
    }

    return strongest > this.familyDeadzone ? strongest : 0;
  }
}

/** Keeps the attribution deadzone inside a sane band. */
function clampDeadzone(value: number): number {
  if (!Number.isFinite(value)) return 0.2;
  return Math.max(0, Math.min(0.9, value));
}
