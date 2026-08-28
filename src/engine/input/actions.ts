/**
 * The unified action map.
 *
 * Gameplay reads *named actions* — never `KeyE`, never gamepad button index 2,
 * never a touch identifier. Devices are translated into this vocabulary by the
 * per-family drivers (keyboard/mouse, gamepad, touch) and everything above the
 * input layer only ever sees the names below. That is what makes rebinding,
 * touch controls and controller prompts possible without touching gameplay.
 *
 * Actions come in two shapes and they behave differently enough that the
 * compiler keeps them apart:
 *
 *   - **Axes** are continuous, live in [-1,1], and are read every frame.
 *     Multiple sources are resolved by largest magnitude.
 *   - **Buttons** are digital and have edges (pressed/released) plus a hold
 *     duration. Multiple sources are OR-ed.
 *
 * `InputState` takes `AxisAction` where an axis is required and `ButtonAction`
 * where a button is required, so "call getAxis on interact" is a type error
 * rather than a silent zero.
 */

// A compile-time-only reference: `import type` means nothing from persistence
// is pulled into the engine bundle. It exists purely so the guard at the
// bottom of this file fails the build if the rebindable list in the settings
// schema and the action map here ever drift apart.
import type { REBINDABLE_ACTIONS } from '../../persistence/settingsSchema';

// ---------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------

/**
 * Where input came from.
 *
 * Drives prompt glyphs ("Hold E" vs "Hold ⓐ" vs an on-screen button) and HUD
 * layout. Mouse is part of `keyboard`: they are one desktop family and a
 * player alternating between them must not see prompts flicker.
 */
export const INPUT_FAMILIES = ['keyboard', 'gamepad', 'touch'] as const;

export type InputFamily = (typeof INPUT_FAMILIES)[number];

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Continuous axes, each normalised to [-1,1].
 *
 * `moveY` is +1 forward. `lookY` is +1 looking up; inversion settings are
 * applied by the driver so gameplay never has to know.
 */
export const AXIS_ACTIONS = ['moveX', 'moveY', 'lookX', 'lookY'] as const;

export type AxisAction = (typeof AXIS_ACTIONS)[number];

/** Digital actions. These have press/release edges and a hold duration. */
export const BUTTON_ACTIONS = [
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
] as const;

export type ButtonAction = (typeof BUTTON_ACTIONS)[number];

/** Every action the game understands. */
export type GameAction = AxisAction | ButtonAction;

/** Axes first, then buttons. Stable order: UI listings depend on it. */
export const GAME_ACTIONS: readonly GameAction[] = [...AXIS_ACTIONS, ...BUTTON_ACTIONS];

// Sets rather than `Array.includes` so a per-frame guard is O(1) and the
// membership test cannot fall out of sync with the exported arrays.
const AXIS_ACTION_SET: ReadonlySet<string> = new Set<string>(AXIS_ACTIONS);
const BUTTON_ACTION_SET: ReadonlySet<string> = new Set<string>(BUTTON_ACTIONS);

/** Narrows a known action to an axis. */
export function isAxisAction(action: GameAction): action is AxisAction {
  return AXIS_ACTION_SET.has(action);
}

/** Narrows a known action to a button. */
export function isButtonAction(action: GameAction): action is ButtonAction {
  return BUTTON_ACTION_SET.has(action);
}

/**
 * Validates an untrusted string — a stored rebinding, a URL flag, a save blob.
 * Returns false rather than throwing so a stale config degrades to defaults.
 */
export function isGameAction(value: string): value is GameAction {
  return AXIS_ACTION_SET.has(value) || BUTTON_ACTION_SET.has(value);
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/**
 * Labels for the rebinding screen, the control diagram and the touch layout
 * editor.
 *
 * Deliberately terse and physical — a player scanning a bindings list reads
 * nouns, not sentences. Axes are included because the controls screen shows
 * them as non-rebindable rows and the touch editor labels the sticks.
 *
 * These are the English source strings; localisation replaces them by key.
 */
export const ACTION_DISPLAY_NAMES: Readonly<Record<GameAction, string>> = {
  moveX: 'Move Sideways',
  moveY: 'Move Forward',
  lookX: 'Look Horizontal',
  lookY: 'Look Vertical',
  interact: 'Interact',
  sprint: 'Sprint',
  crouch: 'Crouch',
  jump: 'Jump',
  toolAction: 'Use Tool',
  toolAlt: 'Tool Alternate',
  scan: 'Survey',
  pause: 'Pause',
  journal: 'Journal',
  dialogueSelect: 'Choose Reply',
  cancel: 'Back',
};

export function actionDisplayName(action: GameAction): string {
  return ACTION_DISPLAY_NAMES[action];
}

// ---------------------------------------------------------------------------
// Cross-layer guards
// ---------------------------------------------------------------------------

/** Actions the player may rebind, as declared by the settings schema. */
export type RebindableAction = (typeof REBINDABLE_ACTIONS)[number];

/**
 * Fails the build if the two lists drift.
 *
 * `REBINDABLE_ACTIONS` in the settings schema must stay a subset of the
 * buttons here: a stored binding for an action the input layer does not know
 * about would be silently dead, and that is exactly the class of bug that
 * produces a menu toggle which does nothing.
 */
type Extends<Sub extends Super, Super> = Sub extends Super ? true : never;
export type RebindableActionsAreButtons = Extends<RebindableAction, ButtonAction>;
