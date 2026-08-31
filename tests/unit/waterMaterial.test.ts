/**
 * Water surface material tests.
 *
 * SCOPE, HONESTLY STATED: these run under jsdom with no GPU, no renderer and
 * no NodeBuilder, so no TSL graph here is ever compiled to WGSL or GLSL.
 * Nothing below can tell you what the water *looks* like, and the shader is
 * never proven to compile on either backend.
 *
 * What IS observable without a device, and is therefore asserted:
 *   - material state per tier (roughness, metalness, transparency, opacity)
 *   - which node slots are wired per tier — the tier ladder is structural,
 *     not cosmetic: tier 0 must leave `positionNode`/`normalNode` unset
 *   - the octave count in the built graph, counted as `sin` nodes, which is
 *     the whole point of the tier ladder documented in the module header
 *   - that the amplitude/speed uniforms are the same live objects the graph
 *     references, so a runtime quality change really does reach the shader
 *   - preset → tier → uniform plumbing for every shipping quality preset
 *   - disposal
 *
 * Deliberately NOT attempted: `getNodeType()`, `setup()`, `generate()` and
 * `build()` all require a NodeBuilder and throw without a renderer, and
 * `getCacheKey()` is salted with a global node id so two identical graphs
 * hash differently — it is useless as a structural fingerprint. Shader
 * compilation on both backends belongs to `tests/browser`, and whether the
 * result reads as grey-green floodwater rather than pea soup belongs to
 * `tests/visual`.
 */

import { describe, it, expect, vi } from 'vitest';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  createWaterMaterial,
  waterOptionsForTier,
  type WaterMaterial,
  type WaterMaterialOptions,
  type WaterTier,
} from '../../src/graphics/water/waterMaterial';
import { QUALITY_PRESET_NAMES, getPreset } from '../../src/graphics/quality/presets';

const TIERS: WaterTier[] = [0, 1, 2, 3];

/** Tiers that actually displace vertices. Tier 0 is the flat/static path. */
const MOVING_TIERS: WaterTier[] = [1, 2, 3];

/**
 * The plausible band for calm standing floodwater, hard-coded rather than
 * imported. Importing the module's own numbers would make the assertion
 * circular: widening an amplitude in the source would silently widen the test.
 */
const MAX_PLAUSIBLE_AMPLITUDE_M = 0.1;

/**
 * Minimal structural view of a TSL node.
 *
 * `@types/three` types nodes by GPU type string and exposes none of the
 * runtime introspection this file relies on, so the graph is walked through
 * this shape instead. Everything named here was verified to exist at runtime
 * on three 0.185: `traverse` needs no builder, and `method`/`isUniformNode`/
 * `value` are set in the node constructors.
 */
interface NodeLike {
  readonly isUniformNode?: boolean;
  readonly method?: string;
  value?: unknown;
  traverse(callback: (node: NodeLike) => void): void;
}

function asNode(value: unknown): NodeLike | null {
  return (value ?? null) as NodeLike | null;
}

/**
 * Every distinct node reachable from a root.
 *
 * `Node.traverse` re-walks shared subgraphs because the graph is a DAG, so
 * results are de-duplicated by identity. Its cycle guard only covers direct
 * self-reference, so the walk is capped: a future graph mistake should fail
 * the suite rather than hang vitest.
 */
function graphNodes(root: unknown): NodeLike[] {
  const node = asNode(root);
  if (!node) return [];

  const seen = new Set<NodeLike>();
  let visits = 0;
  node.traverse((child) => {
    visits += 1;
    if (visits > 20_000) {
      throw new Error('water material node graph did not terminate (cycle?)');
    }
    seen.add(child);
  });
  return [...seen];
}

/** Distinct nodes reachable from any of the material's wired slots. */
function allGraphNodes(water: WaterMaterial): NodeLike[] {
  const { material } = water;
  const seen = new Set<NodeLike>();
  for (const root of [material.positionNode, material.normalNode, material.colorNode]) {
    for (const node of graphNodes(root)) seen.add(node);
  }
  return [...seen];
}

/**
 * Sine calls in the graph.
 *
 * Each swell octave is one `sin`, and the tier >= 1 path evaluates the swell
 * three times (height, +x sample, +z sample) to derive normals, so the count
 * is 3 x octaves. This is the readable, intent-level proof that a higher tier
 * costs more rather than merely looking different.
 */
function sinCount(water: WaterMaterial): number {
  return allGraphNodes(water).filter((node) => node.method === 'sin').length;
}

/** Uniform values wired into a specific slot's graph. */
function uniformValuesIn(root: unknown): unknown[] {
  return graphNodes(root)
    .filter((node) => node.isUniformNode === true)
    .map((node) => node.value);
}

function create(tier: WaterTier, extra: Partial<WaterMaterialOptions> = {}): WaterMaterial {
  return createWaterMaterial({ tier, ...extra });
}

describe('createWaterMaterial material state', () => {
  it('builds a standard node material at every tier', () => {
    for (const tier of TIERS) {
      const water = create(tier);
      expect(water.material, `tier ${tier}`).toBeInstanceOf(MeshStandardNodeMaterial);
      expect(water.material.isMeshStandardNodeMaterial).toBe(true);
      water.dispose();
    }
  });

  it('gives every tier a fresh material and fresh uniforms', () => {
    const a = create(2);
    const b = create(2);

    expect(a.material).not.toBe(b.material);
    expect(a.uniforms.amplitude).not.toBe(b.uniforms.amplitude);

    // TitleBackdrop builds its own water per backdrop; a shared uniform would
    // make one backdrop's quality change silently move another's surface.
    a.uniforms.amplitude.value = 0.5;
    expect(b.uniforms.amplitude.value).not.toBe(0.5);

    a.dispose();
    b.dispose();
  });

  it('roughens the flat tier and keeps every moving tier at one sheen value', () => {
    const flat = create(0);
    expect(flat.material.roughness).toBe(0.55);
    flat.dispose();

    for (const tier of MOVING_TIERS) {
      const water = create(tier);
      expect(water.material.roughness, `tier ${tier}`).toBe(0.28);
      water.dispose();
    }
  });

  it('keeps water dielectric and part-transparent at every tier', () => {
    for (const tier of TIERS) {
      const water = create(tier);
      // Water is not a metal; a non-zero metalness here would kill the diffuse
      // term and read as a chrome floor under overcast light.
      expect(water.material.metalness, `tier ${tier}`).toBe(0);
      expect(water.material.transparent, `tier ${tier}`).toBe(true);
      expect(water.material.opacity, `tier ${tier}`).toBe(0.9);
      water.dispose();
    }
  });
});

describe('createWaterMaterial tier ladder', () => {
  it('leaves the flat tier with no vertex motion and no derived normals', () => {
    const water = create(0);

    // Unset node slots are null on NodeMaterial, so this is the real "the
    // cheap path is genuinely cheaper" assertion: no displacement shader, no
    // normal shader, and therefore no per-vertex work at all.
    expect(water.material.positionNode).toBeNull();
    expect(water.material.normalNode).toBeNull();
    // Colour is always authored, otherwise the surface would render as the
    // material's default white.
    expect(water.material.colorNode).not.toBeNull();

    water.dispose();
  });

  it('wires displacement and normals on every moving tier', () => {
    for (const tier of MOVING_TIERS) {
      const water = create(tier);
      expect(water.material.positionNode, `tier ${tier}`).not.toBeNull();
      expect(water.material.normalNode, `tier ${tier}`).not.toBeNull();
      expect(water.material.colorNode, `tier ${tier}`).not.toBeNull();
      water.dispose();
    }
  });

  it('adds exactly one wave octave per tier above the flat path', () => {
    // 3 swell evaluations per material (height + two finite-difference
    // samples), so each additional octave costs 3 more sine calls.
    const expected: Record<WaterTier, number> = { 0: 0, 1: 3, 2: 6, 3: 9 };

    for (const tier of TIERS) {
      const water = create(tier);
      expect(sinCount(water), `tier ${tier} sine calls`).toBe(expected[tier]);
      water.dispose();
    }
  });

  it('grows the node graph strictly with the tier', () => {
    const sizes = TIERS.map((tier) => {
      const water = create(tier);
      const size = allGraphNodes(water).length;
      water.dispose();
      return size;
    });

    // Absolute counts are three.js internals and will drift on an upgrade, so
    // only the ordering is asserted — that is what "cost scales with the
    // quality tier" actually means.
    for (let i = 1; i < sizes.length; i += 1) {
      expect(sizes[i], `tier ${i} vs tier ${i - 1}: ${sizes.join(' < ')}`).toBeGreaterThan(
        sizes[i - 1],
      );
    }
  });
});

describe('createWaterMaterial uniforms', () => {
  it('defaults amplitude and speed when the caller omits them', () => {
    const water = create(2);
    expect(water.uniforms.amplitude.value).toBe(0.055);
    expect(water.uniforms.speed.value).toBe(1);
    water.dispose();
  });

  it('honours an explicit zero rather than treating it as absent', () => {
    // `??` not `||`: tier 0's preset options are amplitude 0 / speed 0, and a
    // truthiness check here would silently restore full motion.
    const water = create(0, { amplitude: 0, speed: 0 });
    expect(water.uniforms.amplitude.value).toBe(0);
    expect(water.uniforms.speed.value).toBe(0);
    water.dispose();
  });

  it('passes explicit amplitude and speed straight through', () => {
    const water = create(3, { amplitude: 0.0125, speed: 2.5 });
    expect(water.uniforms.amplitude.value).toBe(0.0125);
    expect(water.uniforms.speed.value).toBe(2.5);
    water.dispose();
  });

  it('exposes the live uniform objects the displacement graph actually reads', () => {
    const water = create(2, { amplitude: 0.04, speed: 1.5 });

    // The handles are cast through `unknown` in the source, so this checks the
    // cast is honest: the returned boxes are the very nodes in the graph, not
    // copies. Writing new values must be visible inside positionNode.
    water.uniforms.amplitude.value = 0.321;
    water.uniforms.speed.value = 4.75;

    const wired = uniformValuesIn(water.material.positionNode);
    expect(wired).toContain(0.321);
    expect(wired).toContain(4.75);

    water.dispose();
  });

  it('feeds both uniforms into the derived normals as well as the silhouette', () => {
    const water = create(3, { amplitude: 0.06, speed: 0.5 });

    const inNormals = uniformValuesIn(water.material.normalNode);
    expect(inNormals).toContain(0.06);
    expect(inNormals).toContain(0.5);

    water.dispose();
  });

  it('reads uniform mutation back without a renderer', () => {
    const water = create(1);
    water.uniforms.speed.value = 0;
    expect(water.uniforms.speed.value).toBe(0);
    water.uniforms.amplitude.value = 0.2;
    expect(water.uniforms.amplitude.value).toBe(0.2);
    water.dispose();
  });

  it('does not wire the uniforms into the flat tier, which has no motion to scale', () => {
    // Stated plainly rather than asserted as a virtue: at tier 0 the uniforms
    // exist but reach no node, so the "motion changes are free" contract does
    // not apply there. Tier 0's preset options are already 0/0, so nothing is
    // broken by this — but a caller must not expect amplitude to do anything.
    const water = create(0, { amplitude: 0.9, speed: 9 });
    expect(uniformValuesIn(water.material.colorNode)).not.toContain(0.9);
    expect(water.material.positionNode).toBeNull();
    water.dispose();
  });
});

describe('createWaterMaterial disposal', () => {
  it('releases the material', () => {
    const water = create(2);
    const disposed = vi.fn();
    water.material.addEventListener('dispose', disposed);

    water.dispose();

    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it('survives a second dispose', () => {
    // three's Material.dispose is not event-idempotent (it re-dispatches), so
    // only the "safe to call again" contract TitleBackdrop's teardown needs is
    // pinned here, not the event count.
    const water = create(1);
    water.dispose();
    expect(() => water.dispose()).not.toThrow();
  });

  it('leaves the uniform handles usable after disposal', () => {
    // The uniforms hold no GPU resource, so dispose deliberately does not
    // touch them; a quality change arriving one frame late must not crash.
    const water = create(3);
    water.dispose();
    expect(() => {
      water.uniforms.amplitude.value = 0.01;
    }).not.toThrow();
    expect(water.uniforms.amplitude.value).toBe(0.01);
  });
});

describe('waterOptionsForTier', () => {
  it('maps every tier to a defined option set that echoes the tier', () => {
    for (const tier of TIERS) {
      const options = waterOptionsForTier(tier);
      expect(options, `tier ${tier}`).toBeDefined();
      expect(options.tier).toBe(tier);
    }
  });

  it('makes the flat tier completely static', () => {
    // Potato must not pay for animation it cannot display: zero speed means
    // the time uniform stops mattering even if a future tier-0 path uses it.
    expect(waterOptionsForTier(0)).toEqual({ tier: 0, amplitude: 0, speed: 0 });
  });

  it('raises amplitude and speed monotonically with the tier', () => {
    const amplitudes = TIERS.map((tier) => waterOptionsForTier(tier).amplitude ?? 0);
    const speeds = TIERS.map((tier) => waterOptionsForTier(tier).speed ?? 0);

    for (let i = 1; i < TIERS.length; i += 1) {
      expect(amplitudes[i], `amplitude ${amplitudes.join(' -> ')}`).toBeGreaterThan(
        amplitudes[i - 1],
      );
      expect(speeds[i], `speed ${speeds.join(' -> ')}`).toBeGreaterThan(speeds[i - 1]);
    }
  });

  it('keeps every tier inside a calm-floodwater amplitude band', () => {
    for (const tier of TIERS) {
      const amplitude = waterOptionsForTier(tier).amplitude ?? 0;
      // Swell above ~10 cm reads as open sea, not a flooded street.
      expect(amplitude, `tier ${tier}`).toBeLessThanOrEqual(MAX_PLAUSIBLE_AMPLITUDE_M);
      expect(amplitude, `tier ${tier}`).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('quality preset responsiveness', () => {
  it('builds working water for every shipping preset', () => {
    for (const name of QUALITY_PRESET_NAMES) {
      const preset = getPreset(name);
      const options = waterOptionsForTier(preset.waterTier);

      // waterOptionsForTier's switch has no default: a preset carrying a tier
      // outside 0..3 would return undefined and crash TitleBackdrop's build.
      expect(options, `${name} waterTier ${preset.waterTier}`).toBeDefined();

      const water = createWaterMaterial(options);
      expect(water.uniforms.amplitude.value).toBe(options.amplitude);
      expect(water.uniforms.speed.value).toBe(options.speed);
      expect(water.material.colorNode).not.toBeNull();
      water.dispose();
    }
  });

  it('gives the cheapest preset a static surface and the richest preset the most octaves', () => {
    const potato = createWaterMaterial(waterOptionsForTier(getPreset('potato').waterTier));
    const cinematic = createWaterMaterial(waterOptionsForTier(getPreset('cinematic').waterTier));

    expect(potato.material.positionNode).toBeNull();
    expect(sinCount(potato)).toBe(0);

    expect(cinematic.material.positionNode).not.toBeNull();
    expect(sinCount(cinematic)).toBe(9);
    expect(allGraphNodes(cinematic).length).toBeGreaterThan(allGraphNodes(potato).length);

    potato.dispose();
    cinematic.dispose();
  });

  it('lets a preset change be applied by uniform write alone between moving tiers', () => {
    // The reason the uniforms are exposed at all: dropping High -> Low must
    // not rebuild the shader, only rescale the motion.
    const water = createWaterMaterial(waterOptionsForTier(2));
    const graphBefore = allGraphNodes(water).length;
    const sinBefore = sinCount(water);

    const low = waterOptionsForTier(1);
    water.uniforms.amplitude.value = low.amplitude ?? 0;
    water.uniforms.speed.value = low.speed ?? 0;

    expect(water.uniforms.amplitude.value).toBe(0.045);
    expect(water.uniforms.speed.value).toBe(0.85);
    expect(allGraphNodes(water).length).toBe(graphBefore);
    expect(sinCount(water)).toBe(sinBefore);

    water.dispose();
  });
});
