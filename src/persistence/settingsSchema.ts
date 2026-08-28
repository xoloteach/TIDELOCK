/**
 * Settings schema and defaults.
 *
 * Settings live in localStorage rather than IndexedDB because the renderer
 * needs the graphics preset synchronously during boot, before an async
 * database connection is available. Campaign saves are separate and use
 * Dexie/IndexedDB.
 *
 * Every field is validated with Zod on read and the schema is versioned, so
 * an older stored blob is migrated rather than crashing the game.
 */

import { z } from 'zod';
import { QUALITY_PRESET_NAMES } from '../graphics/quality/presets';

export const SETTINGS_SCHEMA_VERSION = 1;

const qualityPresetName = z.enum(QUALITY_PRESET_NAMES);

const graphicsSettings = z.object({
  preset: qualityPresetName,
  /** null = follow the preset; a number overrides it. */
  renderScale: z.number().min(0.3).max(1.5).nullable(),
  dynamicScaling: z.boolean(),
  targetFps: z.union([z.literal(30), z.literal(45), z.literal(60)]).nullable(),
  /** Force the WebGL2 backend even when WebGPU is available. */
  forceWebgl2: z.boolean(),
  shadowTier: z.number().int().min(0).max(5).nullable(),
  textureTier: z.number().int().min(0).max(4).nullable(),
  ao: z.boolean().nullable(),
  bloom: z.boolean().nullable(),
  depthOfField: z.boolean().nullable(),
  reflectionTier: z.number().int().min(0).max(2).nullable(),
  foliageDensity: z.number().min(0).max(1).nullable(),
  particleMultiplier: z.number().min(0).max(2).nullable(),
  drawDistance: z.number().min(60).max(800).nullable(),
});

const displaySettings = z.object({
  /** Desktop-only. Touch/controller look sensitivity is under controls. */
  fov: z.number().min(55).max(95),
  /** 0 disables camera shake entirely (accessibility). */
  cameraShake: z.number().min(0).max(1),
  showFpsCounter: z.boolean(),
});

const audioSettings = z.object({
  master: z.number().min(0).max(1),
  music: z.number().min(0).max(1),
  ambience: z.number().min(0).max(1),
  dialogue: z.number().min(0).max(1),
  effects: z.number().min(0).max(1),
  ui: z.number().min(0).max(1),
  /** Compresses dynamic range for phone speakers. */
  nightMode: z.boolean(),
});

/** Actions that can be rebound. Mirrors the input action map. */
export const REBINDABLE_ACTIONS = [
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
] as const;

const keyBindings = z.record(z.enum(REBINDABLE_ACTIONS), z.array(z.string()));

const touchButtonLayout = z.object({
  /** Normalised 0..1 anchor within the safe area. */
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  /** Multiplier on the button's base size. */
  scale: z.number().min(0.6).max(1.8),
  visible: z.boolean(),
});

const touchSettings = z.object({
  handedness: z.enum(['right', 'left']),
  /** Fixed joystick sits at a set spot; floating spawns where the thumb lands. */
  joystickMode: z.enum(['fixed', 'floating']),
  joystickSize: z.number().min(0.7).max(1.6),
  joystickDeadzone: z.number().min(0).max(0.4),
  cameraSensitivity: z.number().min(0.2).max(3),
  aimSensitivity: z.number().min(0.2).max(3),
  invertY: z.boolean(),
  buttonScale: z.number().min(0.7).max(1.6),
  opacity: z.number().min(0.25).max(1),
  vibration: z.boolean(),
  gyroAim: z.boolean(),
  /** Per-control overrides from the layout editor, keyed by control id. */
  layout: z.record(z.string(), touchButtonLayout),
});

const controlsSettings = z.object({
  mouseSensitivity: z.number().min(0.2).max(3),
  mouseInvertY: z.boolean(),
  gamepadSensitivity: z.number().min(0.2).max(3),
  gamepadInvertY: z.boolean(),
  gamepadDeadzone: z.number().min(0).max(0.4),
  gamepadHaptics: z.boolean(),
  holdToSprint: z.boolean(),
  holdToCrouch: z.boolean(),
  keyBindings,
  touch: touchSettings,
});

const accessibilitySettings = z.object({
  subtitles: z.boolean(),
  subtitleScale: z.number().min(0.8).max(2),
  subtitleBackground: z.enum(['none', 'shadow', 'solid']),
  subtitleSpeakerNames: z.boolean(),
  highContrastSubtitles: z.boolean(),
  textScale: z.number().min(0.85).max(1.6),
  reduceMotion: z.boolean(),
  reduceFlashing: z.boolean(),
  /** Adds shape/label cues so objectives don't rely on hue alone. */
  colorBlindSafeMarkers: z.boolean(),
  interactionAssist: z.boolean(),
  autoPauseOnFocusLoss: z.boolean(),
});

const gameplaySettings = z.object({
  difficulty: z.enum(['story', 'standard', 'demanding']),
  tutorialsEnabled: z.boolean(),
  reducedTutorials: z.boolean(),
  /** Objective marker visibility. 'contextual' shows it only when relevant. */
  objectiveMarkers: z.enum(['always', 'contextual', 'off']),
  cameraAutoCenter: z.boolean(),
});

export const settingsSchema = z.object({
  version: z.number().int(),
  graphics: graphicsSettings,
  display: displaySettings,
  audio: audioSettings,
  controls: controlsSettings,
  accessibility: accessibilitySettings,
  gameplay: gameplaySettings,
});

export type Settings = z.infer<typeof settingsSchema>;
export type GraphicsSettings = z.infer<typeof graphicsSettings>;
export type AudioSettings = z.infer<typeof audioSettings>;
export type TouchSettings = z.infer<typeof touchSettings>;
export type ControlsSettings = z.infer<typeof controlsSettings>;
export type AccessibilitySettings = z.infer<typeof accessibilitySettings>;
export type GameplaySettings = z.infer<typeof gameplaySettings>;
export type DisplaySettings = z.infer<typeof displaySettings>;
export type TouchButtonLayout = z.infer<typeof touchButtonLayout>;

/**
 * Default key bindings.
 *
 * Arrays allow a primary and alternate binding per action. Movement uses
 * WASD plus arrows and is handled by the input layer as a composite axis, so
 * it is not part of the rebindable single-action map.
 */
export const DEFAULT_KEY_BINDINGS: Record<
  (typeof REBINDABLE_ACTIONS)[number],
  string[]
> = {
  interact: ['KeyE'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  crouch: ['KeyC', 'ControlLeft'],
  jump: ['Space'],
  toolAction: ['Mouse0'],
  toolAlt: ['Mouse2'],
  scan: ['KeyQ'],
  pause: ['Escape'],
  journal: ['Tab'],
  cancel: ['Escape'],
};

export function createDefaultSettings(): Settings {
  return {
    version: SETTINGS_SCHEMA_VERSION,
    graphics: {
      // 'medium' is a placeholder; App replaces it with the capability-based
      // suggestion on first run, then the player's choice is respected.
      preset: 'medium',
      renderScale: null,
      dynamicScaling: true,
      targetFps: null,
      forceWebgl2: false,
      shadowTier: null,
      textureTier: null,
      ao: null,
      bloom: null,
      depthOfField: null,
      reflectionTier: null,
      foliageDensity: null,
      particleMultiplier: null,
      drawDistance: null,
    },
    display: {
      fov: 70,
      cameraShake: 0.6,
      showFpsCounter: false,
    },
    audio: {
      master: 0.85,
      music: 0.6,
      ambience: 0.75,
      dialogue: 1,
      effects: 0.8,
      ui: 0.7,
      nightMode: false,
    },
    controls: {
      mouseSensitivity: 1,
      mouseInvertY: false,
      gamepadSensitivity: 1,
      gamepadInvertY: false,
      gamepadDeadzone: 0.12,
      gamepadHaptics: true,
      holdToSprint: true,
      holdToCrouch: true,
      keyBindings: { ...DEFAULT_KEY_BINDINGS },
      touch: {
        handedness: 'right',
        joystickMode: 'fixed',
        joystickSize: 1,
        joystickDeadzone: 0.12,
        cameraSensitivity: 1,
        aimSensitivity: 0.7,
        invertY: false,
        buttonScale: 1,
        opacity: 0.8,
        vibration: true,
        gyroAim: false,
        layout: {},
      },
    },
    accessibility: {
      subtitles: true,
      subtitleScale: 1,
      subtitleBackground: 'shadow',
      subtitleSpeakerNames: true,
      highContrastSubtitles: false,
      textScale: 1,
      reduceMotion: false,
      reduceFlashing: false,
      colorBlindSafeMarkers: false,
      interactionAssist: false,
      autoPauseOnFocusLoss: true,
    },
    gameplay: {
      difficulty: 'standard',
      tutorialsEnabled: true,
      reducedTutorials: false,
      objectiveMarkers: 'contextual',
      cameraAutoCenter: false,
    },
  };
}

/**
 * Migrates a stored settings blob to the current version.
 *
 * Unknown/older shapes are merged onto defaults field-by-field so a missing
 * key never throws. Returns null when the input is unusable, letting the
 * caller fall back to defaults instead of crashing.
 */
export function migrateSettings(raw: unknown): Settings | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const defaults = createDefaultSettings();
  const merged = deepMergeSettings(defaults, raw as Record<string, unknown>);
  merged.version = SETTINGS_SCHEMA_VERSION;

  const parsed = settingsSchema.safeParse(merged);
  if (parsed.success) return parsed.data;

  console.warn('[settings] stored settings failed validation, using defaults', parsed.error.issues);
  return null;
}

/**
 * Recursively merges stored values onto defaults.
 *
 * Only plain objects recurse. Arrays and primitives replace wholesale, which
 * is what we want for key bindings and scalar preferences.
 */
function deepMergeSettings(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(incoming)) {
    if (!(key in base)) continue; // Drop keys we no longer understand.
    const baseValue = base[key];

    if (isPlainObject(baseValue) && isPlainObject(value)) {
      out[key] = deepMergeSettings(baseValue, value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }

  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
