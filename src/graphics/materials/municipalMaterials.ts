/**
 * Municipal surface library.
 *
 * Every surface Morrow Quay is built from, as a small set of named PBR node
 * materials written in TSL. Procedural for now: there are no texture binaries
 * in the repository yet, so base colour, roughness and metalness variation are
 * generated in-shader from a hand-written value noise.
 *
 * Art direction (spec §10.1/§10.2): coastal municipal. Wet concrete, oxidised
 * steel, painted safety markings, rubber, ceramic tile, plastic housings,
 * sodium/amber practical light. Cloudy daylight, grey-green water. Technology
 * that looks maintained, labelled and bolted down by several contractors over
 * several decades. Explicitly not cyberpunk: no neon, no emissive trim, and
 * — per spec §10.2 — *not everything is reflective*. Metalness is non-zero on
 * bare and oxidised steel only. Concrete, rubber, tile, paint and plastic are
 * dielectrics and stay at 0.
 *
 * Cost is driven by the quality preset:
 *
 *   tier 0   no noise at all. Palette, roughness and cheap deterministic
 *            gradients/patterns only. Flat, but still art-directed.
 *   tier 1   1 noise octave, single world-space slice
 *   tier 2   2 octaves, single slice
 *   tier 3   2 octaves, triplanar (3 slices)
 *   tier 4   3 octaves, triplanar
 *
 * The tier is the preset's `textureTier`. Three other preset dimensions feed
 * in as well:
 *
 *   wetness      enables the tide line: surfaces below the standing water
 *                level darken and gloss up, with a damp splash band above it.
 *   shadowTier   when 0 there are no shadow maps and no AO, so a mild
 *                ground-contact grade is baked into base colour instead. It is
 *                a stand-in for missing occlusion, not an extra effect.
 *   anisotropy   with no texture maps there is nothing to filter
 *                anisotropically, so the preset's anisotropy budget is spent
 *                on the equivalent problem for procedural detail: how far from
 *                camera fine detail survives before it is faded out to stop it
 *                shimmering. Higher budget, longer detail distance.
 *
 * Materials are registered on creation so `disposeAll()` can release them on
 * shutdown or a renderer restart.
 */

import { Color } from 'three';
import { MeshStandardNodeMaterial, type Node } from 'three/webgpu';
import {
  abs,
  cameraPosition,
  distance,
  dot,
  float,
  floor,
  fract,
  mix,
  normalWorld,
  oneMinus,
  positionWorld,
  sin,
  smoothstep,
  time,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import type { QualityPreset, ShadowTier, TextureTier } from '../quality/presets';

/**
 * TSL node aliases. `@types/three` types nodes by GPU type string, so a float
 * expression and a vec3 expression are distinct types and a bad swizzle is a
 * compile error rather than a runtime shader failure.
 */
type FloatNode = Node<'float'>;
type Vec2Node = Node<'vec2'>;
type Vec3Node = Node<'vec3'>;

/** Detail tier. Same range as `QualityPreset.textureTier`. */
export type MunicipalTier = TextureTier;

export const MUNICIPAL_MATERIAL_KINDS = [
  'wetConcrete',
  'paintedSteel',
  'oxidisedSteel',
  'safetyMarking',
  'rubberMatting',
  'ceramicTile',
  'plasticHousing',
  'emergencyLed',
] as const;

export type MunicipalMaterialKind = (typeof MUNICIPAL_MATERIAL_KINDS)[number];

/**
 * Roughness stays inside this band for every material at every tier.
 *
 * Nothing in a flooded borough is a mirror and nothing is a perfect diffuser.
 * The lower bound is wet glazed tile; the upper bound is dry rubber matting.
 */
export const MUNICIPAL_ROUGHNESS_BAND = Object.freeze({ min: 0.12, max: 0.96 });

export interface MunicipalSurfaceOptions {
  /** Detail tier, from `QualityPreset.textureTier`. */
  readonly tier: MunicipalTier;
  /** Enables the tide line and damp band. From `QualityPreset.wetness`. */
  readonly wetness?: boolean;
  /** From `QualityPreset.shadowTier`. 0 bakes a contact grade into albedo. */
  readonly shadowTier?: ShadowTier;
  /** From `QualityPreset.anisotropy`. Sets the procedural detail distance. */
  readonly anisotropy?: number;
  /**
   * World Y of the standing water surface, in metres. Surfaces below this read
   * as submerged; a damp band extends above it.
   */
  readonly tideLine?: number;
}

export interface SafetyMarkingOptions extends MunicipalSurfaceOptions {
  /** Stripe pitch in metres. Municipal hazard paint is roughly 15–25 cm. */
  readonly stripePitch?: number;
  /** `chevron` skews stripes into a V; `stripes` are straight diagonals. */
  readonly pattern?: 'stripes' | 'chevron';
}

/** Emergency indicator colours. Amber is the municipal default. */
export type LedColour = 'amber' | 'red' | 'green';

export interface EmergencyLedOptions extends MunicipalSurfaceOptions {
  readonly colour?: LedColour;
  /** Emissive multiplier. Kept low so bloom does not blow the lens out. */
  readonly intensity?: number;
  /** Slow brightness wander, as an unstable backup supply would produce. */
  readonly pulse?: boolean;
}

/**
 * What a created material actually does, recorded at construction.
 *
 * Not debug decoration: once `colorNode`/`roughnessNode` are assigned, the
 * scalar `material.roughness` is no longer what shades the surface. The ranges
 * below are the analytic bounds of the expressions that *are* used, which is
 * what the tests and the diagnostics overlay need to see.
 */
export interface MunicipalSurfaceInfo {
  readonly kind: MunicipalMaterialKind;
  readonly tier: MunicipalTier;
  /** Nominal base colour as authored, sRGB hex. */
  readonly baseColourHex: number;
  /** Min/max roughness the shading expression can produce. */
  readonly roughnessRange: readonly [number, number];
  /** Min/max metalness the shading expression can produce. */
  readonly metalnessRange: readonly [number, number];
  /** Value-noise octaves per slice. 0 means no noise node exists. */
  readonly noiseOctaves: number;
  /** True when noise is sampled on three axis planes instead of one. */
  readonly triplanar: boolean;
  /** Total value-noise evaluations per fragment. 0 on the flat path. */
  readonly noiseSamples: number;
  /** Node slots this material drives, e.g. `colorNode`, `roughnessNode`. */
  readonly nodeSlots: readonly string[];
  /** Tide line response is active. */
  readonly wet: boolean;
  /** A ground-contact grade is baked into albedo because `shadowTier` is 0. */
  readonly contactGrade: boolean;
  /** Shading depends on `time`, so the surface animates without input. */
  readonly animated: boolean;
  /** Distance in metres at which procedural detail is fully faded out. */
  readonly detailFadeDistance: number;
  /** Live uniforms, where the material exposes any. */
  readonly uniforms?: Readonly<Record<string, { value: number }>>;
}

// ---- Palette --------------------------------------------------------------

/**
 * Authored sRGB hex values. `Color` converts to the renderer's working colour
 * space on construction, so `linear()` below yields the value the shader
 * should actually see rather than the raw sRGB triple.
 */
const PALETTE = {
  concrete: 0x8b8c86,
  concreteWet: 0x3d423f,
  paint: 0x4a5a56,
  paintFaded: 0x6d7a74,
  steel: 0x5d5f60,
  rust: 0x7a4a2e,
  rustDark: 0x40281a,
  safetyYellow: 0xd6a520,
  safetyDark: 0x1d1c19,
  rubber: 0x2b2c2a,
  tile: 0xc2c7bd,
  grout: 0x6f736a,
  plastic: 0xa9aaa4,
  plasticYellowed: 0xb3ac96,
  ledAmber: 0xff9a3c,
  ledRed: 0xff3b30,
  ledGreen: 0x39d353,
} as const;

const LED_COLOURS: Record<LedColour, number> = {
  amber: PALETTE.ledAmber,
  red: PALETTE.ledRed,
  green: PALETTE.ledGreen,
};

const scratchColour = new Color();

/** Authored sRGB hex as a working-space vec3 literal. */
function linear(hex: number): Vec3Node {
  scratchColour.setHex(hex);
  return vec3(scratchColour.r, scratchColour.g, scratchColour.b);
}

// ---- Procedural noise -----------------------------------------------------

/**
 * Hash of a 2D cell to [0,1).
 *
 * The classic `fract(sin(dot(...)) * large)` trick. Written out rather than
 * pulled from a dependency: it is four instructions and adding a noise library
 * for it would violate the dependency rule.
 */
function hash21(p: Vec2Node): FloatNode {
  return fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453123));
}

/** Bilinear value noise with Hermite interpolation. Four hashes per call. */
function valueNoise(p: Vec2Node): FloatNode {
  const cell = floor(p);
  const frac = fract(p);
  // Hermite weights: 3t² − 2t³, avoiding the visible grid of linear blending.
  const weight = frac.mul(frac).mul(vec2(3, 3).sub(frac.mul(2)));

  const a = hash21(cell);
  const b = hash21(cell.add(vec2(1, 0)));
  const c = hash21(cell.add(vec2(0, 1)));
  const d = hash21(cell.add(vec2(1, 1)));

  return mix(mix(a, b, weight.x), mix(c, d, weight.x), weight.y);
}

/**
 * Fractional Brownian motion, normalised to [0,1].
 *
 * `octaves` is a plain TypeScript number, so the loop unrolls at shader build
 * time. A tier-1 material genuinely emits one noise evaluation, not three with
 * two multiplied by zero.
 */
function fbm(p: Vec2Node, octaves: number): FloatNode {
  let sum: FloatNode = float(0);
  let amplitude = 0.5;
  let frequency = 1;
  let total = 0;

  for (let i = 0; i < octaves; i += 1) {
    sum = sum.add(valueNoise(p.mul(frequency)).mul(amplitude));
    total += amplitude;
    // Non-integer lacunarity so octaves do not align into a visible grid.
    frequency *= 2.07;
    amplitude *= 0.5;
  }

  return sum.div(total);
}

interface DetailPlan {
  readonly octaves: number;
  readonly triplanar: boolean;
  readonly noiseSamples: number;
  readonly fadeDistance: number;
}

/** Noise budget for a tier, and the distance detail survives to. */
function detailPlan(tier: MunicipalTier, anisotropy: number, allowTriplanar: boolean): DetailPlan {
  const octaves = tier === 0 ? 0 : tier === 1 ? 1 : tier === 4 ? 3 : 2;
  const triplanar = allowTriplanar && tier >= 3;
  return {
    octaves,
    triplanar,
    noiseSamples: octaves * (triplanar ? 3 : 1),
    // Anisotropy 1 → 14 m, 16 → 52 m. Beyond this, detail is gone rather than
    // aliasing into sparkle.
    fadeDistance: 12 + Math.max(1, anisotropy) * 2.5,
  };
}

/**
 * World-space procedural detail in [0,1], or `null` on the flat path.
 *
 * Single-slice mode shears the XZ sample by world height so vertical surfaces
 * still vary instead of streaking. Triplanar mode blends three axis slices by
 * the world normal, which costs three times as much and is why it only appears
 * from tier 3.
 */
function surfaceDetail(plan: DetailPlan, scale: number): FloatNode | null {
  if (plan.octaves === 0) return null;

  const p = positionWorld.mul(scale);

  if (!plan.triplanar) {
    const sheared = vec2(p.x.add(p.y.mul(0.7)), p.z.sub(p.y.mul(0.7)));
    return fbm(sheared, plan.octaves);
  }

  const axisWeight = abs(normalWorld);
  const weightSum = axisWeight.x.add(axisWeight.y).add(axisWeight.z).max(0.0001);

  return fbm(p.xz, plan.octaves)
    .mul(axisWeight.y)
    .add(fbm(p.xy, plan.octaves).mul(axisWeight.z))
    .add(fbm(p.zy, plan.octaves).mul(axisWeight.x))
    .div(weightSum);
}

/** Fades procedural detail out with camera distance. 1 near, 0 far. */
function detailFalloff(plan: DetailPlan): FloatNode {
  return oneMinus(
    smoothstep(plan.fadeDistance * 0.45, plan.fadeDistance, distance(cameraPosition, positionWorld)),
  );
}

// ---- Shared surface terms -------------------------------------------------

const DEFAULT_TIDE_LINE = 0.34;
const TIDE_FADE = 0.1;
/** Capillary rise and splash reach above the waterline. */
const SPLASH_HEIGHT = 0.85;

/**
 * World Y of the standing water surface used when a caller does not override
 * it. Exported so scenes can place their water plane at exactly the height the
 * materials darken to; a mismatch shows up as a floating tide line.
 */
export const MUNICIPAL_TIDE_LINE = DEFAULT_TIDE_LINE;

/**
 * How submerged/damp a fragment is, 0 dry to 1 under water.
 *
 * Height-based rather than texture-driven: the flood level is a world fact, so
 * every surface picks up the same waterline without authoring per-asset masks.
 */
function dampness(tideLine: number): FloatNode {
  const submerged = oneMinus(smoothstep(tideLine, tideLine + TIDE_FADE, positionWorld.y));
  const splash = oneMinus(
    smoothstep(tideLine + TIDE_FADE, tideLine + SPLASH_HEIGHT, positionWorld.y),
  ).mul(0.45);
  return submerged.max(splash);
}

/**
 * Grime rising from the floor. Deterministic, no noise, so it is available on
 * the flat path where it does most of its work — a tier-0 concrete wall needs
 * *something* breaking up the field.
 */
function grimeGradient(height: number): FloatNode {
  return oneMinus(smoothstep(0, height, positionWorld.y));
}

/**
 * A repeating seam along one world axis, 1 in the joint and 0 elsewhere.
 *
 * `pitch` is the spacing in metres, `width` the joint half-width as a fraction
 * of the pitch.
 */
function axisSeam(coord: FloatNode, pitch: number, width: number): FloatNode {
  // Distance to the nearest multiple of `pitch`, in pitch units.
  const toSeam = float(0.5).sub(abs(fract(coord.div(pitch)).sub(0.5)));
  return oneMinus(smoothstep(0, width, toSeam));
}

/**
 * Form-work seams in poured concrete: horizontal lift lines where successive
 * pours met, and vertical panel joints from the shuttering.
 *
 * Deterministic, so it survives to tier 0 — this is what stops a large flat
 * wall reading as an untextured box when there is no noise budget, and it is
 * the single most recognisable feature of municipal cast concrete.
 *
 * Each axis is weighted by how *perpendicular* the surface is to it. Without
 * that, a wall face at a constant X would either be entirely inside a vertical
 * joint or entirely outside one, and would flip between the two as it moved.
 */
function formworkSeams(): FloatNode {
  const axis = abs(normalWorld);
  const lift = axisSeam(positionWorld.y, 1.2, 0.012).mul(oneMinus(axis.y));
  const panelX = axisSeam(positionWorld.x, 2.4, 0.006).mul(oneMinus(axis.x));
  const panelZ = axisSeam(positionWorld.z, 2.4, 0.006).mul(oneMinus(axis.z));
  return lift.max(panelX).max(panelZ);
}

/**
 * Mild darkening near the ground, applied only when `shadowTier` is 0.
 *
 * Potato has no shadow maps and no AO. Without a contact cue, floors and the
 * walls meeting them merge into one flat value and traversal edges stop
 * reading, which spec §10.3 treats as a failure. This is the cheapest possible
 * stand-in, not an added effect.
 */
function contactGrade(shadowTier: ShadowTier): FloatNode | null {
  if (shadowTier !== 0) return null;
  return mix(float(0.74), float(1), smoothstep(0, 0.5, positionWorld.y));
}

interface SurfaceContext {
  readonly plan: DetailPlan;
  /** Noise in [0,1] already faded by distance, or null on the flat path. */
  readonly detail: FloatNode | null;
  readonly damp: FloatNode | null;
  readonly contact: FloatNode | null;
  readonly tier: MunicipalTier;
  readonly wet: boolean;
}

function prepare(
  options: MunicipalSurfaceOptions,
  noiseScale: number,
  allowTriplanar = true,
): SurfaceContext {
  const plan = detailPlan(options.tier, options.anisotropy ?? 1, allowTriplanar);
  const raw = surfaceDetail(plan, noiseScale);
  const wet = options.wetness === true;

  return {
    plan,
    // Fading toward 0.5 rather than 0 keeps distant surfaces at their mean
    // value instead of drifting darker as detail drops out.
    detail: raw === null ? null : mix(float(0.5), raw, detailFalloff(plan)),
    damp: wet ? dampness(options.tideLine ?? DEFAULT_TIDE_LINE) : null,
    contact: contactGrade(options.shadowTier ?? 3),
    tier: options.tier,
    wet,
  };
}

// ---- Registry -------------------------------------------------------------

const registry = new Map<MeshStandardNodeMaterial, MunicipalSurfaceInfo>();

function register(
  material: MeshStandardNodeMaterial,
  info: MunicipalSurfaceInfo,
): MeshStandardNodeMaterial {
  material.name = `municipal:${info.kind}:t${info.tier}`;
  registry.set(material, info);
  return material;
}

/** Configuration recorded for a material created by this library. */
export function describeSurface(
  material: MeshStandardNodeMaterial,
): MunicipalSurfaceInfo | undefined {
  return registry.get(material);
}

/** Number of live materials this library is holding. */
export function registeredSurfaceCount(): number {
  return registry.size;
}

/** Disposes one material and drops it from the registry. */
export function disposeSurface(material: MeshStandardNodeMaterial): void {
  material.dispose();
  registry.delete(material);
}

/** Disposes every material this library created. Call on renderer teardown. */
export function disposeAll(): void {
  for (const material of registry.keys()) {
    material.dispose();
  }
  registry.clear();
}

// ---- Materials ------------------------------------------------------------

/**
 * Poured concrete: kerbs, stair cores, pump station walls, service bridges.
 *
 * Large-scale mottling from form-work and patching, fine aggregate grain in
 * roughness, grime rising from the floor, and a hard darkening below the
 * waterline where it is saturated. Dielectric — concrete is never metallic,
 * and wet concrete gets glossier, not shinier in the metallic sense.
 */
export function wetConcrete(options: MunicipalSurfaceOptions): MeshStandardNodeMaterial {
  const ctx = prepare(options, 0.35);
  const material = new MeshStandardNodeMaterial();
  const slots: string[] = [];

  const dryRoughness = 0.86;
  const wetRoughness = 0.34;
  const roughnessVariation = 0.07;

  material.color.setHex(PALETTE.concrete);
  material.roughness = dryRoughness;
  material.metalness = 0;

  let colour: Vec3Node = linear(PALETTE.concrete);

  // Patching and water staining: broad value shift, not a pattern.
  if (ctx.detail !== null) {
    colour = colour.mul(mix(float(0.78), float(1.18), ctx.detail));
  }

  // Form-work seams and floor grime work at every tier, noise or not.
  const seams = formworkSeams();
  colour = colour.mul(mix(float(1), float(0.82), seams));
  colour = colour.mul(mix(float(1), float(0.78), grimeGradient(1.4)));

  if (ctx.contact !== null) colour = colour.mul(ctx.contact);

  let roughness: FloatNode = float(dryRoughness);
  if (ctx.detail !== null) {
    roughness = roughness.add(ctx.detail.sub(0.5).mul(roughnessVariation * 2));
    slots.push('roughnessNode');
  }

  if (ctx.damp !== null) {
    colour = mix(colour, linear(PALETTE.concreteWet), ctx.damp.mul(0.85));
    roughness = mix(roughness, float(wetRoughness), ctx.damp);
    if (!slots.includes('roughnessNode')) slots.push('roughnessNode');
  }

  material.colorNode = colour;
  slots.unshift('colorNode');
  if (slots.includes('roughnessNode')) material.roughnessNode = roughness;

  const minRoughness = ctx.wet ? wetRoughness - roughnessVariation : dryRoughness - roughnessVariation;

  return register(material, {
    kind: 'wetConcrete',
    tier: ctx.tier,
    baseColourHex: PALETTE.concrete,
    roughnessRange: [minRoughness, dryRoughness + roughnessVariation],
    metalnessRange: [0, 0],
    noiseOctaves: ctx.plan.octaves,
    triplanar: ctx.plan.triplanar,
    noiseSamples: ctx.plan.noiseSamples,
    nodeSlots: slots,
    wet: ctx.wet,
    contactGrade: ctx.contact !== null,
    animated: false,
    detailFadeDistance: ctx.plan.fadeDistance,
  });
}

/**
 * Painted steel: handrails, cabinet doors, gate frames, pipe runs.
 *
 * Intact paint is a dielectric coating, so metalness is 0 across most of the
 * surface and only rises where the coating has failed and bare or oxidised
 * steel is exposed. That is the whole reason this is a separate material from
 * `oxidisedSteel`: getting it wrong is how everything ends up reflective.
 */
export function paintedSteel(options: MunicipalSurfaceOptions): MeshStandardNodeMaterial {
  const ctx = prepare(options, 0.9);
  const material = new MeshStandardNodeMaterial();
  const slots: string[] = [];

  const paintRoughness = 0.52;
  const exposedRoughness = 0.9;
  const exposedMetalness = 0.75;

  material.color.setHex(PALETTE.paint);
  material.roughness = paintRoughness;
  // Nominal: intact paint. `metalnessNode` raises this only where chipped.
  material.metalness = 0;

  // Paint fades unevenly with sun and salt before it fails.
  let colour: Vec3Node =
    ctx.detail === null
      ? linear(PALETTE.paint)
      : mix(linear(PALETTE.paint), linear(PALETTE.paintFaded), ctx.detail.mul(0.5));

  let roughness: FloatNode = float(paintRoughness);
  let metalness: FloatNode | null = null;
  let maxMetalness = 0;

  if (ctx.detail !== null) {
    // Chips are the top of the noise range only, so they read as isolated
    // failures rather than an even rust wash.
    const chipped = smoothstep(0.62, 0.78, ctx.detail);
    colour = mix(colour, mix(linear(PALETTE.steel), linear(PALETTE.rust), 0.6), chipped);
    roughness = mix(roughness, float(exposedRoughness), chipped);
    metalness = chipped.mul(exposedMetalness);
    maxMetalness = exposedMetalness;
    slots.push('roughnessNode', 'metalnessNode');
  }

  colour = colour.mul(mix(float(1), float(0.85), grimeGradient(1.1)));
  if (ctx.contact !== null) colour = colour.mul(ctx.contact);

  if (ctx.damp !== null) {
    colour = colour.mul(mix(float(1), float(0.7), ctx.damp));
    roughness = mix(roughness, float(0.38), ctx.damp);
    if (!slots.includes('roughnessNode')) slots.push('roughnessNode');
  }

  material.colorNode = colour;
  slots.unshift('colorNode');
  if (slots.includes('roughnessNode')) material.roughnessNode = roughness;
  if (metalness !== null) material.metalnessNode = metalness;

  const minRoughness = ctx.wet ? 0.38 : paintRoughness;

  return register(material, {
    kind: 'paintedSteel',
    tier: ctx.tier,
    baseColourHex: PALETTE.paint,
    roughnessRange: [minRoughness, exposedRoughness],
    // The flat path has no chip mask, so the surface is entirely intact paint
    // and genuinely not metallic anywhere. Higher tiers expose the steel.
    metalnessRange: [0, maxMetalness],
    noiseOctaves: ctx.plan.octaves,
    triplanar: ctx.plan.triplanar,
    noiseSamples: ctx.plan.noiseSamples,
    nodeSlots: slots,
    wet: ctx.wet,
    contactGrade: ctx.contact !== null,
    animated: false,
    detailFadeDistance: ctx.plan.fadeDistance,
  });
}

/**
 * Bare steel that has been weathering: bollards, gate hardware, brackets,
 * ladder rungs, anything whose coating gave up years ago.
 *
 * Iron oxide is largely dielectric, so metalness stays modest and only climbs
 * on the patches still down to metal. A fully metallic rust material is the
 * single most common way this look goes wrong.
 */
export function oxidisedSteel(options: MunicipalSurfaceOptions): MeshStandardNodeMaterial {
  const ctx = prepare(options, 1.6);
  const material = new MeshStandardNodeMaterial();
  const slots: string[] = [];

  const nominalMetalness = 0.35;
  const minMetalness = 0.12;
  const maxMetalness = 0.6;
  const nominalRoughness = 0.78;
  const minRoughnessDry = 0.66;
  const maxRoughness = 0.94;

  material.color.setHex(PALETTE.rust);
  material.roughness = nominalRoughness;
  material.metalness = nominalMetalness;

  let colour: Vec3Node = linear(PALETTE.rust);
  let roughness: FloatNode = float(nominalRoughness);

  if (ctx.detail !== null) {
    // Deep pitting through to dark oxide, bright metal on the wear points.
    const pitting = smoothstep(0.15, 0.55, ctx.detail);
    colour = mix(linear(PALETTE.rustDark), colour, pitting);
    const polished = smoothstep(0.82, 0.95, ctx.detail);
    colour = mix(colour, linear(PALETTE.steel), polished.mul(0.7));

    roughness = mix(float(maxRoughness), float(minRoughnessDry), polished);
    material.metalnessNode = mix(float(minMetalness), float(maxMetalness), polished);
    slots.push('roughnessNode', 'metalnessNode');
  }

  colour = colour.mul(mix(float(1), float(0.88), grimeGradient(0.9)));
  if (ctx.contact !== null) colour = colour.mul(ctx.contact);

  if (ctx.damp !== null) {
    // Wet rust goes very dark and slightly glossy.
    colour = colour.mul(mix(float(1), float(0.6), ctx.damp));
    roughness = mix(roughness, float(0.45), ctx.damp);
    if (!slots.includes('roughnessNode')) slots.push('roughnessNode');
  }

  material.colorNode = colour;
  slots.unshift('colorNode');
  if (slots.includes('roughnessNode')) material.roughnessNode = roughness;

  const lowRoughness = ctx.wet ? 0.45 : ctx.detail === null ? nominalRoughness : minRoughnessDry;

  return register(material, {
    kind: 'oxidisedSteel',
    tier: ctx.tier,
    baseColourHex: PALETTE.rust,
    roughnessRange: [lowRoughness, ctx.detail === null ? nominalRoughness : maxRoughness],
    metalnessRange:
      ctx.detail === null ? [nominalMetalness, nominalMetalness] : [minMetalness, maxMetalness],
    noiseOctaves: ctx.plan.octaves,
    triplanar: ctx.plan.triplanar,
    noiseSamples: ctx.plan.noiseSamples,
    nodeSlots: slots,
    wet: ctx.wet,
    contactGrade: ctx.contact !== null,
    animated: false,
    detailFadeDistance: ctx.plan.fadeDistance,
  });
}

/**
 * Painted hazard marking: the yellow-and-black municipal language on kerb
 * edges, gate thresholds, plant room floors and step nosings.
 *
 * The stripe pattern is deterministic, so it survives the flat path intact —
 * an unmarked tier-0 hazard edge would be a readability regression, not just a
 * cheaper look. Noise only adds the wear that stops it looking freshly
 * printed. Paint is a dielectric: metalness 0.
 */
export function safetyMarking(options: SafetyMarkingOptions): MeshStandardNodeMaterial {
  // Marking wear is a surface property of a painted plane, so single-slice
  // sampling is correct here and triplanar would just cost more.
  const ctx = prepare(options, 2.4, false);
  const material = new MeshStandardNodeMaterial();
  const slots: string[] = ['colorNode'];

  const pitch = options.stripePitch ?? 0.2;
  const chevron = (options.pattern ?? 'chevron') === 'chevron';

  const paintRoughness = 0.62;
  const scuffedRoughness = 0.84;

  material.color.setHex(PALETTE.safetyYellow);
  material.roughness = paintRoughness;
  material.metalness = 0;

  // Diagonal stripes; chevron mode folds the Z axis so they meet in a V.
  const across = chevron
    ? positionWorld.x.add(abs(positionWorld.z))
    : positionWorld.x.add(positionWorld.z);
  const phase = fract(across.div(pitch));
  // Smoothstep rather than step: a hard edge aliases badly at grazing angles,
  // which is exactly how hazard paint is usually viewed.
  const stripe = smoothstep(0.46, 0.54, phase);

  let colour: Vec3Node = mix(linear(PALETTE.safetyDark), linear(PALETTE.safetyYellow), stripe);
  let roughness: FloatNode = float(paintRoughness);

  if (ctx.detail !== null) {
    // Traffic wear: paint thins to the substrate on the walked line.
    const wear = smoothstep(0.55, 0.9, ctx.detail);
    colour = mix(colour, linear(PALETTE.concrete), wear.mul(0.55));
    roughness = mix(roughness, float(scuffedRoughness), wear);
    slots.push('roughnessNode');
  }

  if (ctx.contact !== null) colour = colour.mul(ctx.contact);

  if (ctx.damp !== null) {
    colour = colour.mul(mix(float(1), float(0.62), ctx.damp));
    roughness = mix(roughness, float(0.3), ctx.damp);
    if (!slots.includes('roughnessNode')) slots.push('roughnessNode');
  }

  material.colorNode = colour;
  if (slots.includes('roughnessNode')) material.roughnessNode = roughness;

  const minRoughness = ctx.wet ? 0.3 : paintRoughness;

  return register(material, {
    kind: 'safetyMarking',
    tier: ctx.tier,
    baseColourHex: PALETTE.safetyYellow,
    roughnessRange: [minRoughness, scuffedRoughness],
    metalnessRange: [0, 0],
    noiseOctaves: ctx.plan.octaves,
    triplanar: ctx.plan.triplanar,
    noiseSamples: ctx.plan.noiseSamples,
    nodeSlots: slots,
    wet: ctx.wet,
    contactGrade: ctx.contact !== null,
    animated: false,
    detailFadeDistance: ctx.plan.fadeDistance,
  });
}

/**
 * Ribbed rubber matting: depot walkways, plant room floors, stair treads.
 *
 * The darkest and roughest surface in the set, and the one that must never
 * pick up a highlight. Ribs live in roughness rather than base colour so they
 * read through the grazing light without needing normal maps.
 */
export function rubberMatting(options: MunicipalSurfaceOptions): MeshStandardNodeMaterial {
  const ctx = prepare(options, 3.2, false);
  const material = new MeshStandardNodeMaterial();
  const slots: string[] = ['colorNode'];

  const nominalRoughness = 0.9;
  const ribVariation = 0.05;

  material.color.setHex(PALETTE.rubber);
  material.roughness = nominalRoughness;
  material.metalness = 0;

  let colour: Vec3Node = linear(PALETTE.rubber);
  let roughness: FloatNode = float(nominalRoughness);

  if (ctx.detail !== null) {
    // Extruded ribs plus scuffing where boots land.
    const ribs = sin(positionWorld.x.mul(62)).mul(0.5).add(0.5);
    const scuff = ctx.detail;
    colour = colour.mul(mix(float(0.86), float(1.08), ribs.mul(0.6).add(scuff.mul(0.4))));
    roughness = roughness.sub(ribs.mul(ribVariation));
    slots.push('roughnessNode');
  }

  if (ctx.contact !== null) colour = colour.mul(ctx.contact);

  if (ctx.damp !== null) {
    // Wet rubber holds a thin film: darker, and the only gloss it ever gets.
    colour = colour.mul(mix(float(1), float(0.72), ctx.damp));
    roughness = mix(roughness, float(0.42), ctx.damp);
    if (!slots.includes('roughnessNode')) slots.push('roughnessNode');
  }

  material.colorNode = colour;
  if (slots.includes('roughnessNode')) material.roughnessNode = roughness;

  const minRoughness = ctx.wet ? 0.42 : nominalRoughness - ribVariation;

  return register(material, {
    kind: 'rubberMatting',
    tier: ctx.tier,
    baseColourHex: PALETTE.rubber,
    roughnessRange: [minRoughness, nominalRoughness],
    metalnessRange: [0, 0],
    noiseOctaves: ctx.plan.octaves,
    triplanar: ctx.plan.triplanar,
    noiseSamples: ctx.plan.noiseSamples,
    nodeSlots: slots,
    wet: ctx.wet,
    contactGrade: ctx.contact !== null,
    animated: false,
    detailFadeDistance: ctx.plan.fadeDistance,
  });
}

/**
 * Glazed institutional tile: transit depot walls, clinic floors, stair halls.
 *
 * The grout grid is deterministic and survives the flat path, because a
 * gridless pale wall stops reading as tile entirely. Glaze is the smoothest
 * surface in the library but still a dielectric — glossy is not metallic.
 */
export function ceramicTile(options: MunicipalSurfaceOptions): MeshStandardNodeMaterial {
  const ctx = prepare(options, 1.1);
  const material = new MeshStandardNodeMaterial();
  const slots: string[] = ['colorNode', 'roughnessNode'];

  const tileSize = 0.15;
  const groutWidth = 0.055;
  const glazeRoughness = 0.24;
  const groutRoughness = 0.85;
  const wetGlazeRoughness = 0.18;

  material.color.setHex(PALETTE.tile);
  material.roughness = glazeRoughness;
  material.metalness = 0;

  // Grid on the two dominant wall/floor axes. Distance to the nearest joint
  // in each axis, combined so corners read correctly.
  const gridX = abs(fract(positionWorld.x.div(tileSize)).sub(0.5));
  const gridY = abs(fract(positionWorld.y.div(tileSize)).sub(0.5));
  const gridZ = abs(fract(positionWorld.z.div(tileSize)).sub(0.5));
  const nearestJoint = gridX.min(gridY).min(gridZ);
  // 1 in the grout, 0 on the tile face.
  const grout = oneMinus(smoothstep(groutWidth * 0.6, groutWidth, nearestJoint));

  let colour: Vec3Node = mix(linear(PALETTE.tile), linear(PALETTE.grout), grout);
  let roughness: FloatNode = mix(float(glazeRoughness), float(groutRoughness), grout);

  if (ctx.detail !== null) {
    // Per-tile firing variation and staining held by the grout.
    colour = colour.mul(mix(float(0.9), float(1.06), ctx.detail));
  }

  colour = colour.mul(mix(float(1), float(0.8), grimeGradient(0.6)));
  if (ctx.contact !== null) colour = colour.mul(ctx.contact);

  if (ctx.damp !== null) {
    colour = colour.mul(mix(float(1), float(0.68), ctx.damp));
    roughness = mix(roughness, float(wetGlazeRoughness), ctx.damp);
  }

  material.colorNode = colour;
  material.roughnessNode = roughness;

  const minRoughness = ctx.wet ? wetGlazeRoughness : glazeRoughness;

  return register(material, {
    kind: 'ceramicTile',
    tier: ctx.tier,
    baseColourHex: PALETTE.tile,
    roughnessRange: [minRoughness, groutRoughness],
    metalnessRange: [0, 0],
    noiseOctaves: ctx.plan.octaves,
    triplanar: ctx.plan.triplanar,
    noiseSamples: ctx.plan.noiseSamples,
    nodeSlots: slots,
    wet: ctx.wet,
    contactGrade: ctx.contact !== null,
    animated: false,
    detailFadeDistance: ctx.plan.fadeDistance,
  });
}

/**
 * Moulded plastic enclosure: junction boxes, pump controllers, relay cabinets,
 * the grey boxes bolted to every municipal wall.
 *
 * Injection-moulded ABS: satin, slightly uneven, and yellowed unevenly by UV
 * where it has faced the weather longest. Dielectric.
 */
export function plasticHousing(options: MunicipalSurfaceOptions): MeshStandardNodeMaterial {
  const ctx = prepare(options, 4.5);
  const material = new MeshStandardNodeMaterial();
  const slots: string[] = ['colorNode'];

  const nominalRoughness = 0.44;
  const roughnessVariation = 0.09;

  material.color.setHex(PALETTE.plastic);
  material.roughness = nominalRoughness;
  material.metalness = 0;

  let colour: Vec3Node = linear(PALETTE.plastic);
  let roughness: FloatNode = float(nominalRoughness);

  if (ctx.detail !== null) {
    // Orange-peel from the mould, and uneven UV yellowing.
    colour = mix(colour, linear(PALETTE.plasticYellowed), ctx.detail.mul(0.35));
    roughness = roughness.add(ctx.detail.sub(0.5).mul(roughnessVariation * 2));
    slots.push('roughnessNode');
  }

  if (ctx.contact !== null) colour = colour.mul(ctx.contact);

  if (ctx.damp !== null) {
    colour = colour.mul(mix(float(1), float(0.78), ctx.damp));
    roughness = mix(roughness, float(0.26), ctx.damp);
    if (!slots.includes('roughnessNode')) slots.push('roughnessNode');
  }

  material.colorNode = colour;
  if (slots.includes('roughnessNode')) material.roughnessNode = roughness;

  const minRoughness = ctx.wet ? 0.26 : nominalRoughness - roughnessVariation;

  return register(material, {
    kind: 'plasticHousing',
    tier: ctx.tier,
    baseColourHex: PALETTE.plastic,
    roughnessRange: [minRoughness, nominalRoughness + roughnessVariation],
    metalnessRange: [0, 0],
    noiseOctaves: ctx.plan.octaves,
    triplanar: ctx.plan.triplanar,
    noiseSamples: ctx.plan.noiseSamples,
    nodeSlots: slots,
    wet: ctx.wet,
    contactGrade: ctx.contact !== null,
    animated: false,
    detailFadeDistance: ctx.plan.fadeDistance,
  });
}

/**
 * Emergency indicator lens: gate status, pump run lights, exit markers.
 *
 * The only emissive material in the library, and deliberately dim. Emissive
 * intensity is capped around 2 so bloom picks it out without becoming a glow
 * effect — the spec treats "glowing every interactable" and excessive bloom as
 * rejection conditions, and these are indicator LEDs behind a scratched
 * polycarbonate lens, not set dressing.
 *
 * The lens body is a dielectric plastic; the light comes from `emissiveNode`.
 */
export function emergencyLed(options: EmergencyLedOptions): MeshStandardNodeMaterial {
  // A lens is small and flat-facing; triplanar sampling would be wasted.
  const ctx = prepare(options, 9, false);
  const material = new MeshStandardNodeMaterial();
  const slots: string[] = [];

  const hex = LED_COLOURS[options.colour ?? 'amber'];
  const lensRoughness = 0.28;
  const intensity = Math.min(options.intensity ?? 1.6, 2.2);
  const intensityUniform = uniform(intensity);

  material.color.setHex(hex);
  material.roughness = lensRoughness;
  material.metalness = 0;
  material.emissive.setHex(hex);
  material.emissiveIntensity = intensity;

  let emission: Vec3Node = linear(hex);
  let level: FloatNode = intensityUniform as unknown as FloatNode;
  let animated = false;

  if (options.pulse !== false && ctx.tier >= 1) {
    // Backup power is unstable (see the depot's supply). A slow, shallow
    // wander, not a strobe.
    const wander = sin(time.mul(1.7)).mul(0.06).add(sin(time.mul(0.41)).mul(0.04));
    level = level.mul(float(1).add(wander));
    slots.push('emissiveNode');
    animated = true;
  }

  if (ctx.detail !== null) {
    // Dust and scratches on the lens: a faint dimming, never brightening.
    level = level.mul(mix(float(0.82), float(1), ctx.detail));
    if (!slots.includes('emissiveNode')) slots.push('emissiveNode');
  }

  if (ctx.damp !== null) {
    // A submerged lens is read through water: dimmer and slightly greener.
    emission = emission.mul(mix(float(1), float(0.55), ctx.damp));
    if (!slots.includes('emissiveNode')) slots.push('emissiveNode');
  }

  if (slots.includes('emissiveNode')) {
    material.emissiveNode = emission.mul(level);
  }

  return register(material, {
    kind: 'emergencyLed',
    tier: ctx.tier,
    baseColourHex: hex,
    roughnessRange: [lensRoughness, lensRoughness],
    metalnessRange: [0, 0],
    noiseOctaves: ctx.plan.octaves,
    triplanar: ctx.plan.triplanar,
    noiseSamples: ctx.plan.noiseSamples,
    nodeSlots: slots,
    wet: ctx.wet,
    contactGrade: ctx.contact !== null,
    animated,
    detailFadeDistance: ctx.plan.fadeDistance,
    uniforms: { intensity: intensityUniform as unknown as { value: number } },
  });
}

// ---- Sets and preset plumbing --------------------------------------------

/** Options derived from a quality preset. */
export function municipalOptionsFromPreset(preset: QualityPreset): MunicipalSurfaceOptions {
  return {
    tier: preset.textureTier,
    wetness: preset.wetness,
    shadowTier: preset.shadowTier,
    anisotropy: preset.anisotropy,
  };
}

export type MunicipalMaterialSet = Readonly<
  Record<MunicipalMaterialKind, MeshStandardNodeMaterial>
>;

/**
 * One material of every kind, sharing a single configuration.
 *
 * Sectors should build one set and share instances across meshes: each
 * distinct node material is a separate shader program and a separate draw call
 * batch, so duplicating them per object is how the draw call budget goes.
 */
export function createMunicipalMaterialSet(
  options: MunicipalSurfaceOptions,
): MunicipalMaterialSet {
  return Object.freeze({
    wetConcrete: wetConcrete(options),
    paintedSteel: paintedSteel(options),
    oxidisedSteel: oxidisedSteel(options),
    safetyMarking: safetyMarking(options),
    rubberMatting: rubberMatting(options),
    ceramicTile: ceramicTile(options),
    plasticHousing: plasticHousing(options),
    emergencyLed: emergencyLed(options),
  });
}

/** Disposes a set built by `createMunicipalMaterialSet`. */
export function disposeMunicipalMaterialSet(set: MunicipalMaterialSet): void {
  for (const kind of MUNICIPAL_MATERIAL_KINDS) {
    disposeSurface(set[kind]);
  }
}
