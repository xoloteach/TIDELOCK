/**
 * Water surface material, written in TSL.
 *
 * TSL compiles to WGSL on the WebGPU backend and GLSL on the WebGL2 backend
 * from one definition, which is why the project prefers it over maintaining
 * two shader sources.
 *
 * The look being aimed at is grey-green standing floodwater in overcast
 * daylight: low contrast, broad slow swell, a faint sheen rather than a mirror.
 * Deliberately not blue, and never a clean reflective pool.
 *
 * Cost scales with the quality tier:
 *   tier 0  flat colour with a distance gradient, no vertex motion  (Potato)
 *   tier 1  + vertex swell and derived normals                      (Low/Medium)
 *   tier 2  + a second crossing wave octave                         (High)
 *   tier 3  + fine chop detail                                      (Ultra/Cinematic)
 */

import { MeshStandardNodeMaterial, type Node } from 'three/webgpu';
import {
  positionLocal,
  positionWorld,
  time,
  sin,
  vec3,
  float,
  mix,
  uniform,
  smoothstep,
  clamp,
  dot,
  normalize,
  cameraPosition,
} from 'three/tsl';

export type WaterTier = 0 | 1 | 2 | 3;

/**
 * TSL node aliases.
 *
 * `@types/three` types nodes by their GPU type string, so a float expression
 * and a vec3 expression are distinct types. Naming them here keeps the shader
 * helpers readable and lets the compiler catch a swizzle/type mistake that
 * would otherwise only show up as a shader compile failure at runtime.
 */
type FloatNode = Node<'float'>;
type Vec3Node = Node<'vec3'>;

export interface WaterMaterialOptions {
  readonly tier: WaterTier;
  /** Wave amplitude in metres. Floodwater is calm; keep this small. */
  readonly amplitude?: number;
  /** Overall motion speed multiplier. */
  readonly speed?: number;
}

export interface WaterMaterial {
  readonly material: MeshStandardNodeMaterial;
  /**
   * Live uniforms. Amplitude and speed can change without rebuilding the
   * shader, so quality changes that only scale motion are free.
   */
  readonly uniforms: {
    readonly amplitude: { value: number };
    readonly speed: { value: number };
  };
  dispose(): void;
}

/** Grey-green shallow water. */
const SHALLOW = vec3(0.29, 0.38, 0.36);
/** Colder and darker where the water reads as deep. */
const DEEP = vec3(0.09, 0.15, 0.16);
/** Overcast sky tint for the grazing-angle sheen. */
const SHEEN = vec3(0.62, 0.67, 0.68);

/**
 * Sums sine waves travelling in crossing directions.
 *
 * Crossed directions avoid the single-direction ripple that reads as a shader
 * demo. Octave count comes from the tier, so the cheap path is genuinely
 * cheaper rather than only visually simpler.
 *
 * Written as a plain TypeScript function rather than a TSL `Fn`: it is a short
 * expression called at most three times per material, so inlining it costs
 * nothing and avoids TSL's generic function typing.
 */
function swell(position: Vec3Node, speed: FloatNode, tier: WaterTier): FloatNode {
  const t = time.mul(speed);

  // Primary long swell.
  let height: FloatNode = sin(
    position.x.mul(0.22).add(position.z.mul(0.14)).add(t.mul(0.55)),
  ).mul(0.6);

  if (tier >= 2) {
    // Cross swell: different wavelength and angle.
    height = height.add(
      sin(position.x.mul(-0.31).add(position.z.mul(0.44)).add(t.mul(0.83))).mul(0.3),
    );
  }

  if (tier >= 3) {
    // Fine chop.
    height = height.add(
      sin(position.x.mul(1.15).sub(position.z.mul(0.92)).add(t.mul(1.7))).mul(0.12),
    );
  }

  return height;
}

export function createWaterMaterial(options: WaterMaterialOptions): WaterMaterial {
  const { tier } = options;

  const amplitude = uniform(options.amplitude ?? 0.055);
  const speed = uniform(options.speed ?? 1);

  const material = new MeshStandardNodeMaterial();
  material.roughness = tier === 0 ? 0.55 : 0.28;
  material.metalness = 0;
  // Slight transparency lets submerged geometry read through, which is what
  // sells "shallow flooding" rather than "solid green floor".
  material.transparent = true;
  material.opacity = 0.9;

  // Surface normal: the geometry normal on the flat path, or derived from the
  // wave gradient when the surface actually moves.
  let surfaceNormal: Vec3Node = vec3(0, 1, 0);

  if (tier >= 1) {
    const height = swell(positionLocal, speed, tier).mul(amplitude);

    // Displace vertices so the silhouette moves, not just the shading.
    material.positionNode = positionLocal.add(vec3(0, height, 0));

    /**
     * Normal from finite differences of the swell.
     *
     * Sampling at small offsets and differencing is cheaper here than deriving
     * true partial derivatives, and at this amplitude the difference is not
     * visible.
     */
    const epsilon = float(0.35);
    const alongX = swell(positionLocal.add(vec3(epsilon, 0, 0)), speed, tier).mul(amplitude);
    const alongZ = swell(positionLocal.add(vec3(0, 0, epsilon)), speed, tier).mul(amplitude);

    const slopeX = alongX.sub(height).div(epsilon);
    const slopeZ = alongZ.sub(height).div(epsilon);

    surfaceNormal = normalize(vec3(slopeX.negate(), 1, slopeZ.negate()));
    material.normalNode = surfaceNormal;
  }

  /**
   * Colour: a distance-based depth gradient plus a grazing-angle sheen.
   *
   * Flat-coloured water looks like painted concrete, and a true reflection is
   * both expensive and wrong for overcast light. A Fresnel-style sheen toward
   * the horizon gives the surface its read for very little cost.
   *
   * Camera distance stands in for depth: this material has no depth texture to
   * sample, and more distant water is reliably the deeper channel in the
   * scenes it is used for.
   */
  const viewVector = cameraPosition.sub(positionWorld);
  const depthMix = smoothstep(float(6), float(48), viewVector.length());
  const baseColour = mix(SHALLOW, DEEP, depthMix);

  if (tier === 0) {
    // Cheap path: gradient only, no view-dependent term.
    material.colorNode = baseColour;
  } else {
    const viewDirection = normalize(viewVector);
    // Grazing angles (view nearly parallel to the surface) get the most sheen.
    const facing = clamp(dot(surfaceNormal, viewDirection), 0, 1);
    const fresnel = float(1).sub(facing).pow(3).mul(0.55);
    material.colorNode = mix(baseColour, SHEEN, fresnel);
  }

  return {
    material,
    uniforms: {
      amplitude: amplitude as unknown as { value: number },
      speed: speed as unknown as { value: number },
    },
    dispose: () => material.dispose(),
  };
}

/** Maps a quality preset's waterTier onto amplitude/speed appropriate to it. */
export function waterOptionsForTier(tier: WaterTier): WaterMaterialOptions {
  switch (tier) {
    case 0:
      return { tier, amplitude: 0, speed: 0 };
    case 1:
      return { tier, amplitude: 0.045, speed: 0.85 };
    case 2:
      return { tier, amplitude: 0.055, speed: 1 };
    case 3:
      return { tier, amplitude: 0.065, speed: 1.05 };
  }
}
