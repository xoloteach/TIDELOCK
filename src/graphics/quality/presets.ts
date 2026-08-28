/**
 * Graphics quality presets.
 *
 * Six named tiers, each changing a *bundle* of real workload dimensions —
 * never resolution alone. A preset is a ceiling: the dynamic scaler may
 * reduce below it at runtime but never exceed it.
 *
 * Values here are the single source of truth. Systems subscribe to quality
 * changes rather than sprinkling `if (preset === 'potato')` across the code.
 */

export const QUALITY_PRESET_NAMES = [
  'potato',
  'low',
  'medium',
  'high',
  'ultra',
  'cinematic',
] as const;

export type QualityPresetName = (typeof QUALITY_PRESET_NAMES)[number];

export type TargetFps = 30 | 45 | 60;

/** Texture residency tier. Higher tiers permit larger variants. */
export type TextureTier = 0 | 1 | 2 | 3 | 4;

/** 0 disables real shadow maps and uses cheap blob contact shadows. */
export type ShadowTier = 0 | 1 | 2 | 3 | 4 | 5;

export interface QualityPreset {
  readonly name: QualityPresetName;
  /** Player-facing label. */
  readonly label: string;
  /** One-line description shown in the graphics menu. */
  readonly summary: string;

  // ---- Resolution -------------------------------------------------------
  /** Internal render scale relative to CSS pixel size. */
  readonly renderScale: number;
  /** Lowest render scale the dynamic scaler may fall to for this preset. */
  readonly minRenderScale: number;
  /** Device pixel ratio ceiling. Prevents 3x DPR phones melting. */
  readonly maxPixelRatio: number;
  readonly targetFps: TargetFps;

  // ---- Textures ---------------------------------------------------------
  readonly textureTier: TextureTier;
  /** Largest permitted texture edge in px for ordinary environment maps. */
  readonly maxTextureSize: number;
  /** Largest permitted texture edge for hero/close-up assets. */
  readonly maxHeroTextureSize: number;
  readonly anisotropy: number;

  // ---- Shadows ----------------------------------------------------------
  readonly shadowTier: ShadowTier;
  readonly shadowMapSize: number;
  /** World units beyond which shadows are not rendered. */
  readonly shadowDistance: number;
  /** Cheap projected contact shadows used when shadowTier is 0. */
  readonly blobShadows: boolean;

  // ---- Lights -----------------------------------------------------------
  readonly maxDynamicLights: number;
  readonly maxShadowCastingLights: number;

  // ---- Geometry / world detail -----------------------------------------
  /** Multiplies authored LOD switch distances. <1 swaps to cheap LODs sooner. */
  readonly lodMultiplier: number;
  /** World units at which sectors stop rendering. */
  readonly drawDistance: number;
  readonly foliageDensity: number;
  readonly decalMultiplier: number;

  // ---- Effects ----------------------------------------------------------
  readonly particleMultiplier: number;
  /** 0 flat shaded, 1 normal detail, 2 refraction+reflection approximation. */
  readonly waterTier: 0 | 1 | 2 | 3;
  /** 0 none, 1 cubemap approximation, 2 screen-space. */
  readonly reflectionTier: 0 | 1 | 2;
  /** 0 none, 1 height fog, 2 layered/volumetric approximation. */
  readonly atmosphereTier: 0 | 1 | 2;
  readonly ao: boolean;
  readonly bloom: boolean;
  readonly depthOfField: boolean;
  /** Rain/wetness surface response. */
  readonly wetness: boolean;

  // ---- Simulation budgets ----------------------------------------------
  /** AI tick rate for agents outside the near band, in Hz. */
  readonly aiFarUpdateHz: number;
  /** Distance beyond which dynamic physics bodies are allowed to sleep. */
  readonly physicsFarDistance: number;
  /** Concurrent positional audio emitters permitted. */
  readonly audioEmitterBudget: number;

  // ---- Budgets used by diagnostics + CI asset checks -------------------
  readonly drawCallBudget: number;
  readonly triangleBudget: number;
}

/**
 * Tier 1 — POTATO.
 * Goal: the complete campaign runs on weak WebGL2 phones. Still
 * art-directed: blob shadows and height fog preserve readability rather than
 * leaving the scene flat and unreadable.
 */
const POTATO: QualityPreset = {
  name: 'potato',
  label: 'Potato',
  summary: 'Lowest cost. Targets weak mobile hardware at 30 FPS.',
  renderScale: 0.55,
  minRenderScale: 0.4,
  maxPixelRatio: 1,
  targetFps: 30,
  textureTier: 0,
  maxTextureSize: 512,
  maxHeroTextureSize: 1024,
  anisotropy: 1,
  shadowTier: 0,
  shadowMapSize: 0,
  shadowDistance: 0,
  blobShadows: true,
  maxDynamicLights: 3,
  maxShadowCastingLights: 0,
  lodMultiplier: 0.5,
  drawDistance: 110,
  foliageDensity: 0.15,
  decalMultiplier: 0.2,
  particleMultiplier: 0.15,
  waterTier: 0,
  reflectionTier: 0,
  atmosphereTier: 1,
  ao: false,
  bloom: false,
  depthOfField: false,
  wetness: false,
  aiFarUpdateHz: 2,
  physicsFarDistance: 22,
  audioEmitterBudget: 8,
  drawCallBudget: 180,
  triangleBudget: 180_000,
};

/** Tier 2 — LOW. One shadow source returns; basic fog and light particles. */
const LOW: QualityPreset = {
  name: 'low',
  label: 'Low',
  summary: 'One shadow source and simple water. Modest mobile hardware.',
  renderScale: 0.7,
  minRenderScale: 0.5,
  maxPixelRatio: 1.25,
  targetFps: 30,
  textureTier: 1,
  maxTextureSize: 1024,
  maxHeroTextureSize: 1024,
  anisotropy: 2,
  shadowTier: 1,
  shadowMapSize: 1024,
  shadowDistance: 32,
  blobShadows: true,
  maxDynamicLights: 5,
  maxShadowCastingLights: 1,
  lodMultiplier: 0.7,
  drawDistance: 150,
  foliageDensity: 0.3,
  decalMultiplier: 0.4,
  particleMultiplier: 0.35,
  waterTier: 1,
  reflectionTier: 0,
  atmosphereTier: 1,
  ao: false,
  bloom: false,
  depthOfField: false,
  wetness: false,
  aiFarUpdateHz: 4,
  physicsFarDistance: 30,
  audioEmitterBudget: 12,
  drawCallBudget: 280,
  triangleBudget: 350_000,
};

/** Tier 3 — MEDIUM. Full PBR material set, real water normals, cheap AO. */
const MEDIUM: QualityPreset = {
  name: 'medium',
  label: 'Medium',
  summary: 'Full PBR materials, moderate shadows, ambient occlusion.',
  renderScale: 0.85,
  minRenderScale: 0.6,
  maxPixelRatio: 1.5,
  targetFps: 45,
  textureTier: 2,
  maxTextureSize: 1024,
  maxHeroTextureSize: 2048,
  anisotropy: 4,
  shadowTier: 2,
  shadowMapSize: 1536,
  shadowDistance: 55,
  blobShadows: false,
  maxDynamicLights: 8,
  maxShadowCastingLights: 2,
  lodMultiplier: 1,
  drawDistance: 220,
  foliageDensity: 0.55,
  decalMultiplier: 0.7,
  particleMultiplier: 0.6,
  waterTier: 1,
  reflectionTier: 1,
  atmosphereTier: 1,
  ao: true,
  bloom: false,
  depthOfField: false,
  wetness: true,
  aiFarUpdateHz: 6,
  physicsFarDistance: 45,
  audioEmitterBudget: 18,
  drawCallBudget: 450,
  triangleBudget: 700_000,
};

/** Tier 4 — HIGH. The intended "designed" look. WebGPU preferred. */
const HIGH: QualityPreset = {
  name: 'high',
  label: 'High',
  summary: 'Reference look. Reflections, bloom, wetness, 60 FPS target.',
  renderScale: 1,
  minRenderScale: 0.7,
  maxPixelRatio: 2,
  targetFps: 60,
  textureTier: 3,
  maxTextureSize: 2048,
  maxHeroTextureSize: 2048,
  anisotropy: 8,
  shadowTier: 3,
  shadowMapSize: 2048,
  shadowDistance: 80,
  blobShadows: false,
  maxDynamicLights: 12,
  maxShadowCastingLights: 3,
  lodMultiplier: 1.3,
  drawDistance: 300,
  foliageDensity: 0.8,
  decalMultiplier: 1,
  particleMultiplier: 1,
  waterTier: 2,
  reflectionTier: 1,
  atmosphereTier: 2,
  ao: true,
  bloom: true,
  depthOfField: false,
  wetness: true,
  aiFarUpdateHz: 10,
  physicsFarDistance: 60,
  audioEmitterBudget: 24,
  drawCallBudget: 700,
  triangleBudget: 1_400_000,
};

/** Tier 5 — ULTRA. Longer detail distance, denser effects, more lights. */
const ULTRA: QualityPreset = {
  name: 'ultra',
  label: 'Ultra',
  summary: 'Extended draw distance, denser effects, higher-quality water.',
  renderScale: 1,
  minRenderScale: 0.8,
  maxPixelRatio: 2,
  targetFps: 60,
  textureTier: 4,
  maxTextureSize: 2048,
  maxHeroTextureSize: 4096,
  anisotropy: 16,
  shadowTier: 4,
  shadowMapSize: 3072,
  shadowDistance: 120,
  blobShadows: false,
  maxDynamicLights: 18,
  maxShadowCastingLights: 4,
  lodMultiplier: 1.7,
  drawDistance: 420,
  foliageDensity: 1,
  decalMultiplier: 1.3,
  particleMultiplier: 1.4,
  waterTier: 3,
  reflectionTier: 2,
  atmosphereTier: 2,
  ao: true,
  bloom: true,
  depthOfField: false,
  wetness: true,
  aiFarUpdateHz: 15,
  physicsFarDistance: 85,
  audioEmitterBudget: 32,
  drawCallBudget: 950,
  triangleBudget: 2_200_000,
};

/**
 * Tier 6 — CINEMATIC. Not a default; for screenshots and strong desktops.
 * Supersampling is permitted here and only here. Depth of field is enabled
 * but must be tuned so interactables stay readable — gameplay is identical.
 */
const CINEMATIC: QualityPreset = {
  name: 'cinematic',
  label: 'Cinematic',
  summary: 'Maximum fidelity with supersampling. For screenshots and showcases.',
  renderScale: 1.25,
  minRenderScale: 0.9,
  maxPixelRatio: 2,
  targetFps: 30,
  textureTier: 4,
  maxTextureSize: 4096,
  maxHeroTextureSize: 4096,
  anisotropy: 16,
  shadowTier: 5,
  shadowMapSize: 4096,
  shadowDistance: 180,
  blobShadows: false,
  maxDynamicLights: 24,
  maxShadowCastingLights: 6,
  lodMultiplier: 2.2,
  drawDistance: 600,
  foliageDensity: 1,
  decalMultiplier: 1.6,
  particleMultiplier: 1.8,
  waterTier: 3,
  reflectionTier: 2,
  atmosphereTier: 2,
  ao: true,
  bloom: true,
  depthOfField: true,
  wetness: true,
  aiFarUpdateHz: 15,
  physicsFarDistance: 110,
  audioEmitterBudget: 40,
  drawCallBudget: 1400,
  triangleBudget: 3_500_000,
};

export const QUALITY_PRESETS: Readonly<Record<QualityPresetName, QualityPreset>> =
  Object.freeze({
    potato: POTATO,
    low: LOW,
    medium: MEDIUM,
    high: HIGH,
    ultra: ULTRA,
    cinematic: CINEMATIC,
  });

export function getPreset(name: QualityPresetName): QualityPreset {
  return QUALITY_PRESETS[name];
}

export function isQualityPresetName(value: unknown): value is QualityPresetName {
  return (
    typeof value === 'string' &&
    (QUALITY_PRESET_NAMES as readonly string[]).includes(value)
  );
}

/** Ordered list for menus and stepper controls (cheapest first). */
export const QUALITY_PRESET_ORDER: readonly QualityPresetName[] = QUALITY_PRESET_NAMES;

/**
 * Dimensions the dynamic scaler is allowed to reduce, in the order it should
 * sacrifice them. Render scale is cheapest to change and least noticeable;
 * reflections and AO are given up before gameplay-readable geometry.
 */
export const ADAPTIVE_DIMENSIONS = [
  'renderScale',
  'shadowDistance',
  'particleMultiplier',
  'foliageDensity',
  'reflectionTier',
] as const;

export type AdaptiveDimension = (typeof ADAPTIVE_DIMENSIONS)[number];

/**
 * Runtime overrides applied on top of the selected preset.
 * `null` means "follow the preset".
 */
export interface QualityOverrides {
  renderScale?: number | null;
  shadowDistance?: number | null;
  particleMultiplier?: number | null;
  foliageDensity?: number | null;
  reflectionTier?: 0 | 1 | 2 | null;
  shadowTier?: ShadowTier | null;
  textureTier?: TextureTier | null;
  ao?: boolean | null;
  bloom?: boolean | null;
  depthOfField?: boolean | null;
  drawDistance?: number | null;
  targetFps?: TargetFps | null;
}

/** Preset merged with user + adaptive overrides. What systems actually read. */
export type EffectiveQuality = QualityPreset;

export function applyOverrides(
  preset: QualityPreset,
  overrides: QualityOverrides | undefined,
): EffectiveQuality {
  if (!overrides) return preset;

  const merged: Record<string, unknown> = { ...preset };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== null && value !== undefined) {
      merged[key] = value;
    }
  }
  return merged as unknown as EffectiveQuality;
}
