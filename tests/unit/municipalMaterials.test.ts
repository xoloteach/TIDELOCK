/**
 * Municipal material library and title backdrop tests.
 *
 * SCOPE, HONESTLY STATED: these run under jsdom with no GPU and no renderer.
 * No node material is ever compiled here, so nothing below can tell you what
 * the surfaces *look* like. What is asserted is construction and
 * configuration: that every factory builds at every tier without throwing,
 * that the cost ladder between tiers is real rather than cosmetic, that the
 * physical rules the art direction depends on hold (metalness only on steel,
 * roughness inside a believable band), and that disposal releases everything.
 *
 * Shader compilation on both backends, and whether the result actually reads
 * as wet concrete rather than grey plastic, belong to `tests/browser` and
 * `tests/visual` respectively.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { BufferGeometry, Light, Mesh, PerspectiveCamera, PointLight, Scene, FogExp2 } from 'three';
import {
  MUNICIPAL_MATERIAL_KINDS,
  MUNICIPAL_TIDE_LINE,
  ceramicTile,
  createMunicipalMaterialSet,
  describeSurface,
  disposeAll,
  disposeMunicipalMaterialSet,
  disposeSurface,
  emergencyLed,
  municipalOptionsFromPreset,
  oxidisedSteel,
  paintedSteel,
  plasticHousing,
  registeredSurfaceCount,
  rubberMatting,
  safetyMarking,
  wetConcrete,
  type MunicipalMaterialKind,
  type MunicipalSurfaceInfo,
  type MunicipalSurfaceOptions,
  type MunicipalTier,
  type EmergencyLedOptions,
  type SafetyMarkingOptions,
} from '../../src/graphics/materials/municipalMaterials';
import { TitleBackdrop } from '../../src/graphics/TitleBackdrop';
import { getPreset } from '../../src/graphics/quality/presets';

/**
 * The believable band, hard-coded here rather than imported.
 *
 * Importing the library's own constant would make this assertion circular:
 * widening the band in the source would silently widen the test.
 */
const ROUGHNESS_MIN = 0.12;
const ROUGHNESS_MAX = 0.96;

const TIERS: MunicipalTier[] = [0, 1, 2, 3, 4];

/** Only steel is allowed a non-zero metalness. Everything else is dielectric. */
const STEEL_KINDS: MunicipalMaterialKind[] = ['paintedSteel', 'oxidisedSteel'];

/**
 * The union of every factory's option shape, so one table can hold them all.
 * The kind-specific extras (`pulse`, `pattern`) are optional everywhere.
 */
type AnyMunicipalOptions = MunicipalSurfaceOptions &
  Partial<Omit<EmergencyLedOptions, 'tier'>> &
  Partial<Omit<SafetyMarkingOptions, 'tier'>>;

type Factory = (
  options: AnyMunicipalOptions,
) => import('three/webgpu').MeshStandardNodeMaterial;

const FACTORIES: Readonly<Record<MunicipalMaterialKind, Factory>> = {
  wetConcrete,
  paintedSteel,
  oxidisedSteel,
  safetyMarking,
  rubberMatting,
  ceramicTile,
  plasticHousing,
  emergencyLed,
};

/**
 * Fixed reference options so that varying `tier` varies only the tier.
 * Wetness and a real shadow tier are on, which is the common campaign case.
 */
function baseOptions(tier: MunicipalTier): MunicipalSurfaceOptions {
  return { tier, wetness: true, shadowTier: 3, anisotropy: 8 };
}

function infoFor(kind: MunicipalMaterialKind, options: AnyMunicipalOptions): MunicipalSurfaceInfo {
  const material = FACTORIES[kind](options);
  const info = describeSurface(material);
  expect(info, `${kind} was not registered`).toBeDefined();
  return info as MunicipalSurfaceInfo;
}

afterEach(() => {
  disposeAll();
  vi.restoreAllMocks();
});

describe('municipal material library', () => {
  it('exposes one factory per declared kind', () => {
    expect(Object.keys(FACTORIES).sort()).toEqual([...MUNICIPAL_MATERIAL_KINDS].sort());
    expect(MUNICIPAL_MATERIAL_KINDS).toHaveLength(8);
  });

  it('builds every material at every tier without throwing', () => {
    for (const kind of MUNICIPAL_MATERIAL_KINDS) {
      for (const tier of TIERS) {
        const material = FACTORIES[kind](baseOptions(tier));
        expect(material.isMeshStandardNodeMaterial, `${kind} t${tier}`).toBe(true);
        expect(describeSurface(material)?.kind).toBe(kind);
        expect(describeSurface(material)?.tier).toBe(tier);
        // Named so the material is identifiable in a GPU capture.
        expect(material.name).toBe(`municipal:${kind}:t${tier}`);
      }
    }
    expect(registeredSurfaceCount()).toBe(MUNICIPAL_MATERIAL_KINDS.length * TIERS.length);
  });

  it('also builds with the minimum options object', () => {
    for (const kind of MUNICIPAL_MATERIAL_KINDS) {
      expect(() => FACTORIES[kind]({ tier: 0 })).not.toThrow();
      expect(() => FACTORIES[kind]({ tier: 4 })).not.toThrow();
    }
  });

  describe('cost ladder', () => {
    it('evaluates no noise at all on tier 0', () => {
      for (const kind of MUNICIPAL_MATERIAL_KINDS) {
        const info = infoFor(kind, baseOptions(0));
        expect(info.noiseOctaves, kind).toBe(0);
        expect(info.noiseSamples, kind).toBe(0);
        expect(info.triplanar, kind).toBe(false);
      }
    });

    it('gives every material real procedural detail by tier 3', () => {
      for (const kind of MUNICIPAL_MATERIAL_KINDS) {
        const info = infoFor(kind, baseOptions(3));
        expect(info.noiseOctaves, kind).toBeGreaterThan(0);
        expect(info.noiseSamples, kind).toBeGreaterThan(0);
      }
    });

    it('costs strictly less at tier 0 than at tier 3', () => {
      for (const kind of MUNICIPAL_MATERIAL_KINDS) {
        const cheap = infoFor(kind, baseOptions(0));
        const rich = infoFor(kind, baseOptions(3));

        expect(cheap.noiseSamples, kind).toBeLessThan(rich.noiseSamples);
        expect(cheap.nodeSlots.length, kind).toBeLessThanOrEqual(rich.nodeSlots.length);
      }
    });

    it('increases noise evaluations monotonically across tiers', () => {
      for (const kind of MUNICIPAL_MATERIAL_KINDS) {
        const samples = TIERS.map((tier) => infoFor(kind, baseOptions(tier)).noiseSamples);
        for (let i = 1; i < samples.length; i += 1) {
          expect(samples[i], `${kind} t${i} vs t${i - 1}`).toBeGreaterThanOrEqual(samples[i - 1]);
        }
        // The top tier must be measurably more expensive than tier 1, not just
        // different — otherwise the upper presets are decorative.
        expect(samples[4], kind).toBeGreaterThan(samples[1]);
      }
    });

    it('only pays for triplanar sampling from tier 3, and only where it helps', () => {
      // Flat painted planes and small lenses do not benefit from triplanar
      // projection, so they must not be charged for it at any tier.
      const singleSliceOnly: MunicipalMaterialKind[] = [
        'safetyMarking',
        'rubberMatting',
        'emergencyLed',
      ];

      for (const kind of MUNICIPAL_MATERIAL_KINDS) {
        for (const tier of TIERS) {
          const info = infoFor(kind, baseOptions(tier));
          if (singleSliceOnly.includes(kind) || tier < 3) {
            expect(info.triplanar, `${kind} t${tier}`).toBe(false);
            expect(info.noiseSamples, `${kind} t${tier}`).toBe(info.noiseOctaves);
          } else {
            expect(info.triplanar, `${kind} t${tier}`).toBe(true);
            expect(info.noiseSamples, `${kind} t${tier}`).toBe(info.noiseOctaves * 3);
          }
        }
      }
    });

    it('drives fewer node slots on the flat path than at the top tier', () => {
      const cheap = infoFor('wetConcrete', { tier: 0, wetness: false, shadowTier: 3 });
      const rich = infoFor('wetConcrete', { tier: 4, wetness: true, shadowTier: 3 });

      expect(cheap.nodeSlots).not.toContain('roughnessNode');
      expect(rich.nodeSlots).toContain('roughnessNode');
      expect(cheap.nodeSlots.length).toBeLessThan(rich.nodeSlots.length);
    });
  });

  describe('metalness is physical', () => {
    it('keeps every dielectric surface at exactly zero, at every tier', () => {
      for (const kind of MUNICIPAL_MATERIAL_KINDS) {
        if (STEEL_KINDS.includes(kind)) continue;

        for (const tier of TIERS) {
          const material = FACTORIES[kind](baseOptions(tier));
          const info = describeSurface(material) as MunicipalSurfaceInfo;

          expect(material.metalness, `${kind} t${tier} scalar`).toBe(0);
          // A metalness node would override the scalar, so its absence is the
          // assertion that actually matters.
          expect(material.metalnessNode, `${kind} t${tier} node`).toBeNull();
          expect(info.metalnessRange, `${kind} t${tier} range`).toEqual([0, 0]);
        }
      }
    });

    it('makes oxidised steel metallic at every tier, but never a mirror', () => {
      for (const tier of TIERS) {
        const info = infoFor('oxidisedSteel', baseOptions(tier));
        expect(info.metalnessRange[1], `t${tier}`).toBeGreaterThan(0);
        // Iron oxide is largely dielectric: fully metallic rust is wrong.
        expect(info.metalnessRange[1], `t${tier}`).toBeLessThanOrEqual(0.7);
        expect(info.metalnessRange[0], `t${tier}`).toBeGreaterThanOrEqual(0);
      }
    });

    it('exposes metal on painted steel only where the coating has failed', () => {
      // Tier 0 has no chip mask, so the surface is entirely intact paint and
      // correctly has no metallic region at all.
      const flat = infoFor('paintedSteel', baseOptions(0));
      expect(flat.metalnessRange).toEqual([0, 0]);

      for (const tier of [1, 2, 3, 4] as MunicipalTier[]) {
        const material = paintedSteel(baseOptions(tier));
        const info = describeSurface(material) as MunicipalSurfaceInfo;
        expect(info.metalnessRange[1], `t${tier}`).toBeGreaterThan(0);
        expect(info.metalnessRange[0], `t${tier}`).toBe(0);
        expect(material.metalnessNode, `t${tier}`).not.toBeNull();
        // Nominal value stays at intact paint.
        expect(material.metalness, `t${tier}`).toBe(0);
      }
    });

    it('never reports a metalness above bare steel', () => {
      for (const kind of MUNICIPAL_MATERIAL_KINDS) {
        for (const tier of TIERS) {
          const info = infoFor(kind, baseOptions(tier));
          expect(info.metalnessRange[1], `${kind} t${tier}`).toBeLessThanOrEqual(1);
          expect(info.metalnessRange[0], `${kind} t${tier}`).toBeLessThanOrEqual(
            info.metalnessRange[1],
          );
        }
      }
    });
  });

  describe('roughness stays believable', () => {
    it('keeps the shading range inside the band for every material and tier', () => {
      for (const kind of MUNICIPAL_MATERIAL_KINDS) {
        for (const tier of TIERS) {
          for (const wetness of [false, true]) {
            const material = FACTORIES[kind]({ ...baseOptions(tier), wetness });
            const info = describeSurface(material) as MunicipalSurfaceInfo;
            const label = `${kind} t${tier} wet=${wetness}`;

            const [low, high] = info.roughnessRange;
            expect(low, `${label} low`).toBeGreaterThanOrEqual(ROUGHNESS_MIN);
            expect(high, `${label} high`).toBeLessThanOrEqual(ROUGHNESS_MAX);
            expect(low, `${label} ordering`).toBeLessThanOrEqual(high);

            // The scalar is the nominal value and must also be plausible: it
            // is what shades the surface wherever no roughness node is set.
            expect(material.roughness, `${label} scalar`).toBeGreaterThanOrEqual(ROUGHNESS_MIN);
            expect(material.roughness, `${label} scalar`).toBeLessThanOrEqual(ROUGHNESS_MAX);
          }
        }
      }
    });

    it('orders the surfaces the way the materials physically should', () => {
      const options = baseOptions(3);
      const rubber = infoFor('rubberMatting', options);
      const concrete = infoFor('wetConcrete', options);
      const tile = infoFor('ceramicTile', options);

      // Glazed tile is the smoothest thing in the borough; rubber matting the
      // roughest. Concrete sits between them.
      expect(tile.roughnessRange[0]).toBeLessThan(concrete.roughnessRange[1]);
      expect(rubber.roughnessRange[1]).toBeGreaterThan(concrete.roughnessRange[0]);
      expect(tile.roughnessRange[0]).toBeLessThan(rubber.roughnessRange[0]);
    });
  });

  describe('preset response', () => {
    it('maps the four preset dimensions the materials care about', () => {
      const potato = municipalOptionsFromPreset(getPreset('potato'));
      expect(potato).toEqual({ tier: 0, wetness: false, shadowTier: 0, anisotropy: 1 });

      const ultra = municipalOptionsFromPreset(getPreset('ultra'));
      expect(ultra).toEqual({ tier: 4, wetness: true, shadowTier: 4, anisotropy: 16 });
    });

    it('bakes a contact grade only when there are no shadow maps', () => {
      expect(infoFor('wetConcrete', { tier: 2, shadowTier: 0 }).contactGrade).toBe(true);
      expect(infoFor('wetConcrete', { tier: 2, shadowTier: 1 }).contactGrade).toBe(false);
      expect(infoFor('wetConcrete', { tier: 2, shadowTier: 4 }).contactGrade).toBe(false);
    });

    it('spends a larger anisotropy budget on a longer detail distance', () => {
      const low = infoFor('wetConcrete', { tier: 3, anisotropy: 1 });
      const high = infoFor('wetConcrete', { tier: 3, anisotropy: 16 });
      expect(high.detailFadeDistance).toBeGreaterThan(low.detailFadeDistance);
      // Still a finite, sane distance rather than "the whole draw distance".
      expect(high.detailFadeDistance).toBeLessThan(120);
      expect(low.detailFadeDistance).toBeGreaterThan(5);
    });

    it('reports the tide line response as following the wetness setting', () => {
      expect(infoFor('wetConcrete', { tier: 2, wetness: true }).wet).toBe(true);
      expect(infoFor('wetConcrete', { tier: 2, wetness: false }).wet).toBe(false);
      // Default is dry: a caller that forgets the flag gets the cheap path.
      expect(infoFor('wetConcrete', { tier: 2 }).wet).toBe(false);
    });

    it('builds identical configurations from identical options', () => {
      const a = infoFor('paintedSteel', baseOptions(3));
      const b = infoFor('paintedSteel', baseOptions(3));
      expect(a).toEqual(b);
    });
  });

  describe('material specifics', () => {
    it('keeps hazard stripes readable on the flat path', () => {
      // A tier-0 hazard edge must still be striped: the pattern is a
      // readability feature, not decoration.
      const info = infoFor('safetyMarking', baseOptions(0));
      expect(info.nodeSlots).toContain('colorNode');
      expect(info.noiseSamples).toBe(0);
    });

    it('keeps the tile grid on the flat path', () => {
      const info = infoFor('ceramicTile', baseOptions(0));
      expect(info.nodeSlots).toContain('colorNode');
      expect(info.nodeSlots).toContain('roughnessNode');
      expect(info.noiseSamples).toBe(0);
    });

    it('caps emergency LED emissive so bloom cannot blow the lens out', () => {
      const asked = emergencyLed({ tier: 3, intensity: 40 });
      expect(asked.emissiveIntensity).toBeLessThanOrEqual(2.2);

      const defaulted = emergencyLed({ tier: 3 });
      expect(defaulted.emissiveIntensity).toBeGreaterThan(0);
      expect(defaulted.emissiveIntensity).toBeLessThanOrEqual(2.2);
      // The lens body is plastic, not chrome.
      expect(defaulted.metalness).toBe(0);
    });

    it('exposes a live intensity uniform on the LED for power failures', () => {
      const material = emergencyLed({ tier: 3, intensity: 1.4 });
      const uniforms = describeSurface(material)?.uniforms;
      expect(uniforms?.intensity.value).toBeCloseTo(1.4, 5);
      uniforms!.intensity.value = 0;
      expect(uniforms?.intensity.value).toBe(0);
    });

    it('gives each LED colour its own authored value', () => {
      const amber = describeSurface(emergencyLed({ tier: 2, colour: 'amber' }))?.baseColourHex;
      const red = describeSurface(emergencyLed({ tier: 2, colour: 'red' }))?.baseColourHex;
      const green = describeSurface(emergencyLed({ tier: 2, colour: 'green' }))?.baseColourHex;
      expect(new Set([amber, red, green]).size).toBe(3);
    });

    it('animates the LED only when the pulse is affordable and wanted', () => {
      // Tier 0 is fully static: no time dependency, no noise, no nodes at all.
      expect(infoFor('emergencyLed', { tier: 0 }).nodeSlots).toEqual([]);
      expect(infoFor('emergencyLed', { tier: 0 }).animated).toBe(false);

      expect(infoFor('emergencyLed', { tier: 1 }).animated).toBe(true);
      expect(infoFor('emergencyLed', { tier: 1 }).nodeSlots).toContain('emissiveNode');

      // Opting out of the pulse removes the time dependency, but the lens is
      // still dirty, so the emissive node itself remains.
      const still = infoFor('emergencyLed', { tier: 3, pulse: false });
      expect(still.animated).toBe(false);
      expect(still.nodeSlots).toContain('emissiveNode');
      expect(emergencyLed({ tier: 0, pulse: false }).emissiveNode).toBeNull();
    });

    it('leaves every other surface static', () => {
      for (const kind of MUNICIPAL_MATERIAL_KINDS) {
        if (kind === 'emergencyLed') continue;
        for (const tier of TIERS) {
          expect(infoFor(kind, baseOptions(tier)).animated, `${kind} t${tier}`).toBe(false);
        }
      }
    });

    it('accepts a chevron or straight stripe pattern', () => {
      expect(() => safetyMarking({ tier: 3, pattern: 'stripes', stripePitch: 0.25 })).not.toThrow();
      expect(() => safetyMarking({ tier: 3, pattern: 'chevron' })).not.toThrow();
    });
  });

  describe('disposal', () => {
    it('disposes every registered material and empties the registry', () => {
      const created = MUNICIPAL_MATERIAL_KINDS.map((kind) => FACTORIES[kind](baseOptions(2)));
      const spies = created.map((material) => vi.spyOn(material, 'dispose'));

      expect(registeredSurfaceCount()).toBe(created.length);
      disposeAll();

      for (const [index, spy] of spies.entries()) {
        expect(spy, MUNICIPAL_MATERIAL_KINDS[index]).toHaveBeenCalledTimes(1);
      }
      expect(registeredSurfaceCount()).toBe(0);
      for (const material of created) {
        expect(describeSurface(material)).toBeUndefined();
      }
    });

    it('is safe to call twice', () => {
      wetConcrete(baseOptions(1));
      disposeAll();
      expect(() => disposeAll()).not.toThrow();
      expect(registeredSurfaceCount()).toBe(0);
    });

    it('releases a single material without touching the others', () => {
      const kept = wetConcrete(baseOptions(1));
      const dropped = rubberMatting(baseOptions(1));
      const droppedSpy = vi.spyOn(dropped, 'dispose');

      disposeSurface(dropped);

      expect(droppedSpy).toHaveBeenCalledTimes(1);
      expect(registeredSurfaceCount()).toBe(1);
      expect(describeSurface(kept)).toBeDefined();
      expect(describeSurface(dropped)).toBeUndefined();
    });

    it('builds and releases a whole set', () => {
      const set = createMunicipalMaterialSet(baseOptions(3));
      expect(registeredSurfaceCount()).toBe(MUNICIPAL_MATERIAL_KINDS.length);
      for (const kind of MUNICIPAL_MATERIAL_KINDS) {
        expect(describeSurface(set[kind])?.kind).toBe(kind);
      }

      const spies = MUNICIPAL_MATERIAL_KINDS.map((kind) => vi.spyOn(set[kind], 'dispose'));
      disposeMunicipalMaterialSet(set);

      for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
      expect(registeredSurfaceCount()).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------

/** Collects the geometries actually attached to meshes under an object. */
function collectGeometries(scene: Scene): BufferGeometry[] {
  const found = new Set<BufferGeometry>();
  scene.traverse((object) => {
    if (object instanceof Mesh) found.add(object.geometry as BufferGeometry);
  });
  return [...found];
}

function countMeshes(scene: Scene): number {
  let count = 0;
  scene.traverse((object) => {
    if (object instanceof Mesh) count += 1;
  });
  return count;
}

function countLights(scene: Scene): number {
  let count = 0;
  scene.traverse((object) => {
    if (object instanceof Light) count += 1;
  });
  return count;
}

function makeTarget(): { scene: Scene; camera: PerspectiveCamera } {
  const scene = new Scene();
  const camera = new PerspectiveCamera(70, 16 / 9, 0.1, 600);
  camera.position.set(0, 2, 6);
  return { scene, camera };
}

describe('TitleBackdrop', () => {
  afterEach(() => {
    disposeAll();
    vi.restoreAllMocks();
  });

  it('adds a single group and populates it', () => {
    const target = makeTarget();
    const before = target.scene.children.length;

    const backdrop = new TitleBackdrop({ target, quality: getPreset('high') });
    expect(backdrop.isBuilt()).toBe(false);

    backdrop.build();

    expect(backdrop.isBuilt()).toBe(true);
    expect(target.scene.children.length).toBe(before + 1);
    expect(countMeshes(target.scene)).toBeGreaterThan(20);
    expect(countLights(target.scene)).toBeGreaterThan(2);

    backdrop.dispose();
  });

  it('builds every surface from the municipal library', () => {
    const target = makeTarget();
    const backdrop = new TitleBackdrop({ target, quality: getPreset('high') });
    backdrop.build();

    // Eight kinds in the shared set plus the dedicated dry lamp lens.
    expect(registeredSurfaceCount()).toBe(MUNICIPAL_MATERIAL_KINDS.length + 1);

    backdrop.dispose();
  });

  it('is idempotent: a second build does not duplicate the scene', () => {
    const target = makeTarget();
    const backdrop = new TitleBackdrop({ target, quality: getPreset('medium') });

    backdrop.build();
    const children = target.scene.children.length;
    const meshes = countMeshes(target.scene);

    backdrop.build();

    expect(target.scene.children.length).toBe(children);
    expect(countMeshes(target.scene)).toBe(meshes);

    backdrop.dispose();
  });

  it('removes everything on dispose and leaves no geometry, material or light behind', () => {
    const target = makeTarget();
    const childrenBefore = target.scene.children.length;

    const backdrop = new TitleBackdrop({ target, quality: getPreset('ultra') });
    backdrop.build();

    const geometries = collectGeometries(target.scene);
    expect(geometries.length).toBeGreaterThan(0);
    const geometrySpies = geometries.map((geometry) => vi.spyOn(geometry, 'dispose'));

    const lights: Light[] = [];
    target.scene.traverse((object) => {
      if (object instanceof Light) lights.push(object);
    });
    const lightSpies = lights.map((light) => vi.spyOn(light, 'dispose'));

    backdrop.dispose();

    expect(backdrop.isBuilt()).toBe(false);
    expect(target.scene.children.length).toBe(childrenBefore);
    expect(countMeshes(target.scene)).toBe(0);
    expect(countLights(target.scene)).toBe(0);

    for (const spy of geometrySpies) expect(spy).toHaveBeenCalledTimes(1);
    for (const spy of lightSpies) expect(spy).toHaveBeenCalledTimes(1);

    // Every material the backdrop created has been released.
    expect(registeredSurfaceCount()).toBe(0);
  });

  it('shares geometry between meshes instead of allocating one per box', () => {
    const target = makeTarget();
    const backdrop = new TitleBackdrop({ target, quality: getPreset('ultra') });
    backdrop.build();

    const geometries = collectGeometries(target.scene);
    // A unit box and a unit plane, scaled per instance. World-space procedural
    // materials make per-mesh UVs unnecessary, so this is safe.
    expect(geometries.length).toBeLessThanOrEqual(3);
    expect(countMeshes(target.scene)).toBeGreaterThan(geometries.length * 5);

    backdrop.dispose();
  });

  it('hands the scene atmosphere and the camera back untouched', () => {
    const target = makeTarget();
    const originalFog = target.scene.fog;
    const originalBackground = target.scene.background;
    const originalPosition = target.camera.position.clone();
    const originalQuaternion = target.camera.quaternion.clone();

    const backdrop = new TitleBackdrop({ target, quality: getPreset('high') });
    backdrop.build();

    expect(target.scene.fog).toBeInstanceOf(FogExp2);
    expect(target.scene.background).not.toBe(originalBackground);
    expect(target.camera.position.equals(originalPosition)).toBe(false);

    backdrop.dispose();

    expect(target.scene.fog).toBe(originalFog);
    expect(target.scene.background).toBe(originalBackground);
    expect(target.camera.position.distanceTo(originalPosition)).toBeLessThan(1e-6);
    expect(target.camera.quaternion.angleTo(originalQuaternion)).toBeLessThan(1e-6);
  });

  it('is safe to dispose without building, or twice', () => {
    const target = makeTarget();
    const backdrop = new TitleBackdrop({ target, quality: getPreset('low') });

    expect(() => backdrop.dispose()).not.toThrow();
    backdrop.build();
    backdrop.dispose();
    expect(() => backdrop.dispose()).not.toThrow();
    expect(target.scene.children).toHaveLength(0);
  });

  it('drifts the camera when updated', () => {
    const target = makeTarget();
    const backdrop = new TitleBackdrop({ target, quality: getPreset('high') });
    backdrop.build();

    const start = target.camera.position.clone();
    for (let i = 0; i < 300; i += 1) backdrop.update(1 / 60);
    const drifted = target.camera.position.clone();

    expect(drifted.distanceTo(start)).toBeGreaterThan(0.05);
    // Drift, not a fly-through: the camera must stay in the same spot.
    expect(drifted.distanceTo(start)).toBeLessThan(4);

    backdrop.dispose();
  });

  it('does nothing on update before build', () => {
    const target = makeTarget();
    const backdrop = new TitleBackdrop({ target, quality: getPreset('high') });
    const start = target.camera.position.clone();

    backdrop.update(1);

    expect(target.camera.position.equals(start)).toBe(true);
  });

  describe('quality response', () => {
    it('draws fewer objects and fewer lights on the cheapest preset', () => {
      const potatoTarget = makeTarget();
      const potato = new TitleBackdrop({ target: potatoTarget, quality: getPreset('potato') });
      potato.build();
      const potatoMeshes = countMeshes(potatoTarget.scene);
      const potatoPointLights = countPointLights(potatoTarget.scene);
      potato.dispose();

      const ultraTarget = makeTarget();
      const ultra = new TitleBackdrop({ target: ultraTarget, quality: getPreset('ultra') });
      ultra.build();
      const ultraMeshes = countMeshes(ultraTarget.scene);
      const ultraPointLights = countPointLights(ultraTarget.scene);
      ultra.dispose();

      expect(potatoMeshes).toBeLessThan(ultraMeshes);
      expect(potatoPointLights).toBeLessThan(ultraPointLights);
    });

    it('stays inside the preset dynamic light budget', () => {
      for (const name of ['potato', 'low', 'medium', 'high', 'ultra', 'cinematic'] as const) {
        const target = makeTarget();
        const preset = getPreset(name);
        const backdrop = new TitleBackdrop({ target, quality: preset });
        backdrop.build();

        expect(countLights(target.scene), name).toBeLessThanOrEqual(preset.maxDynamicLights);

        backdrop.dispose();
      }
    });

    it('casts no shadows when the preset has no shadow maps', () => {
      const target = makeTarget();
      const backdrop = new TitleBackdrop({ target, quality: getPreset('potato') });
      backdrop.build();

      let casters = 0;
      target.scene.traverse((object) => {
        if (object.castShadow) casters += 1;
      });
      expect(casters).toBe(0);

      backdrop.dispose();
    });

    it('casts shadows and sizes the map from the preset when shadows exist', () => {
      const target = makeTarget();
      const preset = getPreset('high');
      const backdrop = new TitleBackdrop({ target, quality: preset });
      backdrop.build();

      let shadowCastingLights = 0;
      target.scene.traverse((object) => {
        if (!(object instanceof Light) || !object.castShadow) return;
        shadowCastingLights += 1;
        // Only some light types carry a shadow, and the shadow-casting light
        // here is the sun, so this must resolve rather than be skipped.
        const shadow = (object as Light & { shadow?: { mapSize: { x: number } } }).shadow;
        expect(shadow).toBeDefined();
        expect((shadow as { mapSize: { x: number } }).mapSize.x).toBeLessThanOrEqual(
          preset.shadowMapSize,
        );
      });
      expect(shadowCastingLights).toBeGreaterThan(0);
      expect(shadowCastingLights).toBeLessThanOrEqual(preset.maxShadowCastingLights);

      backdrop.dispose();
    });

    it('uses denser fog where the draw distance is shorter', () => {
      const potatoTarget = makeTarget();
      const potato = new TitleBackdrop({ target: potatoTarget, quality: getPreset('potato') });
      potato.build();
      const potatoDensity = (potatoTarget.scene.fog as FogExp2).density;
      potato.dispose();

      const ultraTarget = makeTarget();
      const ultra = new TitleBackdrop({ target: ultraTarget, quality: getPreset('ultra') });
      ultra.build();
      const ultraDensity = (ultraTarget.scene.fog as FogExp2).density;
      ultra.dispose();

      expect(potatoDensity).toBeGreaterThan(ultraDensity);
      expect(ultraDensity).toBeGreaterThan(0);
    });

    it('builds materials at the preset detail tier', () => {
      const target = makeTarget();
      const backdrop = new TitleBackdrop({ target, quality: getPreset('potato') });
      backdrop.build();

      const tiers = new Set<number>();
      target.scene.traverse((object) => {
        if (object instanceof Mesh && !Array.isArray(object.material)) {
          const info = describeSurface(
            object.material as import('three/webgpu').MeshStandardNodeMaterial,
          );
          if (info) tiers.add(info.tier);
        }
      });

      expect(tiers).toEqual(new Set([getPreset('potato').textureTier]));

      backdrop.dispose();
    });

    it('rebuilds on a quality change without leaking or jumping', () => {
      const target = makeTarget();
      const backdrop = new TitleBackdrop({ target, quality: getPreset('potato') });
      backdrop.build();
      for (let i = 0; i < 120; i += 1) backdrop.update(1 / 60);

      const before = countMeshes(target.scene);
      backdrop.setQuality(getPreset('ultra'));

      expect(target.scene.children).toHaveLength(1);
      expect(countMeshes(target.scene)).toBeGreaterThan(before);
      expect(registeredSurfaceCount()).toBe(MUNICIPAL_MATERIAL_KINDS.length + 1);

      backdrop.dispose();
      expect(registeredSurfaceCount()).toBe(0);
    });

    it('does not rebuild when the same preset is reapplied', () => {
      const target = makeTarget();
      const backdrop = new TitleBackdrop({ target, quality: getPreset('high') });
      backdrop.build();

      const geometries = collectGeometries(target.scene);
      backdrop.setQuality(getPreset('high'));

      expect(collectGeometries(target.scene)).toEqual(geometries);

      backdrop.dispose();
    });
  });

  it('places the water surface exactly on the material tide line', () => {
    const target = makeTarget();
    const backdrop = new TitleBackdrop({ target, quality: getPreset('high') });
    backdrop.build();

    const water = target.scene.getObjectByName('backdrop-water');
    expect(water).toBeDefined();
    // A mismatch here shows up in game as a tide line floating above or below
    // the water surface.
    expect(water?.position.y).toBeCloseTo(MUNICIPAL_TIDE_LINE, 6);

    backdrop.dispose();
  });
});

function countPointLights(scene: Scene): number {
  let count = 0;
  scene.traverse((object) => {
    if (object instanceof PointLight) count += 1;
  });
  return count;
}
