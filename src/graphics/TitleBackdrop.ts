/**
 * The live scene behind the title screen.
 *
 * A flooded Morrow Quay street at overcast midday, looked down from kerb
 * height: standing grey-green water, blocks receding into fog, a service
 * gantry crossing overhead, a handful of amber work lights that nobody has
 * come back for. Slow camera drift, no cuts, no titles in the 3D scene.
 *
 * The composition is deliberately built from simple masses. Fog does the work:
 * at the densities used here only the nearest two rows resolve as surfaces and
 * everything behind them reads as silhouette, so the shapes describe a street
 * rather than announcing themselves as boxes. Every surface comes from the
 * municipal material library, so the backdrop is lit and shaded by the same
 * rules as the campaign rather than being a separate art path.
 *
 * Everything scales with the quality preset: material detail tier, water tier,
 * how many rows of blocks exist, how many dynamic lights are lit, whether the
 * sun casts a shadow, and fog density (denser fog is both the cheaper and the
 * more atmospheric option, which is a rare and welcome alignment).
 *
 * The backdrop borrows the caller's scene and camera and is expected to give
 * them back unchanged: fog, background and camera transform are captured on
 * `build()` and restored on `dispose()`.
 */

import {
  BoxGeometry,
  Color,
  DirectionalLight,
  FogExp2,
  Group,
  HemisphereLight,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Quaternion,
  Scene,
  Vector3,
  type BufferGeometry,
} from 'three';
import type { MeshStandardNodeMaterial } from 'three/webgpu';
import { createWaterMaterial, waterOptionsForTier, type WaterMaterial } from './water/waterMaterial';
import {
  createMunicipalMaterialSet,
  disposeMunicipalMaterialSet,
  emergencyLed,
  disposeSurface,
  municipalOptionsFromPreset,
  MUNICIPAL_TIDE_LINE,
  type MunicipalMaterialSet,
} from './materials/municipalMaterials';
import type { QualityPreset } from './quality/presets';

/**
 * What the backdrop needs from the renderer.
 *
 * Structural rather than a `RenderContext` import: `RenderContext` satisfies
 * this, but depending on the type only would still drag the WebGPU renderer
 * into any test that wants to build the scene.
 */
export interface TitleBackdropTarget {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
}

export interface TitleBackdropOptions {
  readonly target: TitleBackdropTarget;
  readonly quality: QualityPreset;
}

/** Overcast coastal daylight. Matches `RenderContext`'s clear colour family. */
const SKY = 0x8a969b;
const GROUND_BOUNCE = 0x2f332f;
const SUN = 0xc8ccc9;
/** Sodium/amber work light. The only warm colour in the scene. */
const WORK_LIGHT = 0xffa84d;

/** Street geometry, in metres. */
const STREET_HALF_WIDTH = 5.5;
const ROW_SPACING = 9;
const STREET_LENGTH = 320;

interface WorkLight {
  readonly light: PointLight;
  /** Phase offset so the lights do not wander in unison. */
  readonly phase: number;
  readonly baseIntensity: number;
}

/**
 * Deterministic PRNG (mulberry32).
 *
 * The title screen must look the same every launch — a backdrop that
 * reshuffles itself is both distracting and impossible to screenshot-test.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class TitleBackdrop {
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private quality: QualityPreset;

  private root: Group | null = null;
  private materials: MunicipalMaterialSet | null = null;
  private water: WaterMaterial | null = null;
  private lampMaterial: MeshStandardNodeMaterial | null = null;

  /** Geometries this backdrop owns, for disposal. Meshes share them. */
  private geometries: BufferGeometry[] = [];
  private workLights: WorkLight[] = [];
  private sun: DirectionalLight | null = null;
  private sky: HemisphereLight | null = null;

  /** Scene/camera state captured on build and restored on dispose. */
  private previousFog: Scene['fog'] = null;
  private previousBackground: Scene['background'] = null;
  private readonly cameraHome = new Vector3();
  private readonly cameraHomeQuaternion = new Quaternion();
  private cameraHomeFov = 70;

  private elapsed = 0;
  private readonly lookTarget = new Vector3();

  constructor(options: TitleBackdropOptions) {
    this.scene = options.target.scene;
    this.camera = options.target.camera;
    this.quality = options.quality;
  }

  isBuilt(): boolean {
    return this.root !== null;
  }

  /** Builds the scene and adds a single group to the caller's scene. */
  build(): void {
    if (this.root !== null) return;

    this.previousFog = this.scene.fog;
    this.previousBackground = this.scene.background;
    this.cameraHome.copy(this.camera.position);
    this.cameraHomeQuaternion.copy(this.camera.quaternion);
    this.cameraHomeFov = this.camera.fov;

    const preset = this.quality;
    const surfaceOptions = {
      ...municipalOptionsFromPreset(preset),
      tideLine: MUNICIPAL_TIDE_LINE,
    };

    this.materials = createMunicipalMaterialSet(surfaceOptions);
    this.water = createWaterMaterial(waterOptionsForTier(preset.waterTier));
    // The lamp heads are the one place a separate emissive instance is worth
    // it: they are always dry, so they skip the tide-line branch entirely.
    this.lampMaterial = emergencyLed({ ...surfaceOptions, wetness: false, colour: 'amber' });

    const root = new Group();
    root.name = 'title-backdrop';
    this.root = root;

    // Denser fog on cheaper presets: it hides the shorter draw distance and
    // happens to be the stronger image. Atmosphere tier 0 would be flat, so
    // the floor is still a real exponential fog.
    const fogDensity = preset.atmosphereTier >= 2 ? 0.036 : preset.atmosphereTier === 1 ? 0.055 : 0.07;
    this.scene.fog = new FogExp2(SKY, fogDensity);
    this.scene.background = new Color(SKY);

    const unitBox = new BoxGeometry(1, 1, 1);
    const unitPlane = new PlaneGeometry(1, 1);
    this.geometries.push(unitBox, unitPlane);

    this.buildGround(root, unitPlane);
    this.buildStreet(root, unitBox);
    this.buildGantry(root, unitBox);
    this.buildLighting(root, unitBox);

    this.scene.add(root);
    this.elapsed = 0;
    this.applyCameraDrift();
  }

  /** Road surface and the standing water sitting on it. */
  private buildGround(root: Group, unitPlane: PlaneGeometry): void {
    const materials = this.materials as MunicipalMaterialSet;
    const water = this.water as WaterMaterial;

    const road = new Mesh(unitPlane, materials.wetConcrete);
    road.name = 'backdrop-road';
    road.rotation.x = -Math.PI / 2;
    road.scale.set(STREET_HALF_WIDTH * 6, STREET_LENGTH, 1);
    road.position.set(0, 0, -STREET_LENGTH / 2 + 20);
    road.receiveShadow = this.quality.shadowTier > 0;
    root.add(road);

    const flood = new Mesh(unitPlane, water.material);
    flood.name = 'backdrop-water';
    flood.rotation.x = -Math.PI / 2;
    flood.scale.set(STREET_HALF_WIDTH * 6, STREET_LENGTH, 1);
    flood.position.set(0, MUNICIPAL_TIDE_LINE, -STREET_LENGTH / 2 + 20);
    root.add(flood);
  }

  /**
   * Blocks either side of the street, receding into the fog.
   *
   * Each block is a mass, a parapet, a downpipe and — nearest the camera — a
   * hazard-striped barrier. Four parts is enough that the silhouette has a
   * profile; more would be spent on detail the fog eats.
   */
  private buildStreet(root: Group, unitBox: BoxGeometry): void {
    const materials = this.materials as MunicipalMaterialSet;
    const preset = this.quality;
    const rows =
      preset.drawDistance >= 400 ? 8 : preset.drawDistance >= 250 ? 6 : preset.drawDistance >= 150 ? 5 : 4;
    const castShadows = preset.shadowTier > 0;
    const random = makeRandom(0x71de10c);

    for (let row = 0; row < rows; row += 1) {
      const z = -8 - row * ROW_SPACING;

      for (const side of [-1, 1] as const) {
        const depth = 6 + random() * 3;
        const width = 5 + random() * 3.5;
        const height = 4.5 + random() * 5.5;
        const x = side * (STREET_HALF_WIDTH + width / 2);

        const mass = new Mesh(unitBox, materials.wetConcrete);
        mass.name = `backdrop-block-${row}-${side}`;
        mass.scale.set(width, height, depth);
        mass.position.set(x, height / 2, z + (random() - 0.5) * 2);
        mass.castShadow = castShadows;
        mass.receiveShadow = castShadows;
        root.add(mass);

        // Parapet: a thin painted cap that breaks the roofline silhouette.
        const parapet = new Mesh(unitBox, materials.paintedSteel);
        parapet.scale.set(width + 0.25, 0.32, depth + 0.25);
        parapet.position.set(mass.position.x, height + 0.16, mass.position.z);
        parapet.castShadow = castShadows;
        root.add(parapet);

        // Downpipe on the street face. Vertical lines stop the masses reading
        // as untextured slabs even when only their silhouette is visible.
        const pipe = new Mesh(unitBox, materials.oxidisedSteel);
        pipe.scale.set(0.16, height * 0.92, 0.16);
        pipe.position.set(
          x - side * (width / 2 + 0.08),
          (height * 0.92) / 2,
          mass.position.z + (random() - 0.5) * depth * 0.5,
        );
        root.add(pipe);

        // Ground-floor equipment cabinet, on the closer rows only.
        if (row < 3 && random() > 0.4) {
          const cabinet = new Mesh(unitBox, materials.plasticHousing);
          cabinet.scale.set(0.7, 1.1, 0.4);
          cabinet.position.set(x - side * (width / 2 + 0.2), 0.55, mass.position.z + 1.4);
          cabinet.castShadow = castShadows;
          root.add(cabinet);
        }
      }

      // Kerb strip. Hazard paint on the near rows, plain concrete beyond,
      // because painted markings should not be legible through heavy fog.
      for (const side of [-1, 1] as const) {
        const kerb = new Mesh(
          unitBox,
          row < 2 ? materials.safetyMarking : materials.wetConcrete,
        );
        kerb.scale.set(0.45, 0.22, ROW_SPACING - 0.4);
        kerb.position.set(side * STREET_HALF_WIDTH, 0.11, z);
        root.add(kerb);
      }
    }

    // Foreground: a barrier the evacuation left across the kerb, and the
    // rubber matting on the walkway the camera is standing on.
    const barrier = new Mesh(unitBox, materials.safetyMarking);
    barrier.name = 'backdrop-barrier';
    barrier.scale.set(2.4, 0.12, 0.1);
    barrier.position.set(-2.1, 1.05, -3.4);
    barrier.rotation.z = 0.06;
    barrier.castShadow = this.quality.shadowTier > 0;
    root.add(barrier);

    for (const legX of [-3.2, -1]) {
      const leg = new Mesh(unitBox, materials.paintedSteel);
      leg.scale.set(0.08, 1.1, 0.08);
      leg.position.set(legX, 0.55, -3.4);
      root.add(leg);
    }

    const matting = new Mesh(unitBox, materials.rubberMatting);
    matting.name = 'backdrop-matting';
    matting.scale.set(3.2, 0.04, 2.2);
    matting.position.set(0, 0.02, 4.2);
    root.add(matting);
  }

  /**
   * The service gantry crossing the street.
   *
   * The prologue ends with Mara crossing a service bridge into the sealed
   * zone, so the title image puts one overhead: a horizontal band that gives
   * the fog something to be measured against.
   */
  private buildGantry(root: Group, unitBox: BoxGeometry): void {
    const materials = this.materials as MunicipalMaterialSet;
    const z = -26;

    const deck = new Mesh(unitBox, materials.paintedSteel);
    deck.name = 'backdrop-gantry';
    deck.scale.set(STREET_HALF_WIDTH * 2 + 3, 0.45, 1.8);
    deck.position.set(0, 6.4, z);
    deck.castShadow = this.quality.shadowTier > 0;
    root.add(deck);

    // Tiled underside, seen from below as the player looks up the street.
    const soffit = new Mesh(unitBox, materials.ceramicTile);
    soffit.scale.set(STREET_HALF_WIDTH * 2 + 2.6, 0.06, 1.6);
    soffit.position.set(0, 6.14, z);
    root.add(soffit);

    for (const side of [-1, 1] as const) {
      const leg = new Mesh(unitBox, materials.oxidisedSteel);
      leg.scale.set(0.5, 6.4, 0.5);
      leg.position.set(side * (STREET_HALF_WIDTH + 0.5), 3.2, z);
      leg.castShadow = this.quality.shadowTier > 0;
      root.add(leg);
    }
  }

  /**
   * Sky bounce, one weak sun, and the amber work lights.
   *
   * Overcast light comes almost entirely from the sky dome, so the hemisphere
   * light dominates and the directional light exists mainly to give the masses
   * a readable light and dark side. The budget from the preset is spent on the
   * practical lights instead, which are what actually place the viewer in the
   * street.
   */
  private buildLighting(root: Group, unitBox: BoxGeometry): void {
    const preset = this.quality;

    this.sky = new HemisphereLight(SKY, GROUND_BOUNCE, 1.15);
    root.add(this.sky);

    // Under cloud there is no hard sun, so the directional light is weak and
    // rakes down the street from the viewer's side. Without that raking angle
    // the street-facing walls receive nothing but sky bounce and read black.
    this.sun = new DirectionalLight(SUN, 0.5);
    this.sun.position.set(6, 15, 11);
    if (preset.shadowTier > 0 && preset.maxShadowCastingLights > 0) {
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.setScalar(Math.min(preset.shadowMapSize, 2048));
      this.sun.shadow.camera.far = Math.max(40, preset.shadowDistance);
      this.sun.shadow.bias = -0.0006;
    }
    root.add(this.sun);

    // Hemisphere and sun already occupy the budget conceptually; reserve two
    // slots and spend the rest on practicals, capped at four so the amber
    // never takes over an overcast image.
    const lampCount = Math.max(1, Math.min(4, preset.maxDynamicLights - 2));
    const lampPositions: readonly (readonly [number, number, number])[] = [
      [-STREET_HALF_WIDTH + 0.4, 2.6, -12],
      [STREET_HALF_WIDTH - 0.4, 3.1, -21],
      [-STREET_HALF_WIDTH + 0.4, 2.4, -33],
      [STREET_HALF_WIDTH - 0.4, 2.9, -45],
    ];

    for (let i = 0; i < lampCount; i += 1) {
      const [x, y, z] = lampPositions[i];

      // Visible source. An unmotivated pool of light on the water reads as a
      // bug, so every practical gets a fixture.
      const head = new Mesh(unitBox, this.lampMaterial as MeshStandardNodeMaterial);
      head.name = `backdrop-lamp-${i}`;
      head.scale.set(0.26, 0.16, 0.12);
      head.position.set(x, y, z);
      root.add(head);

      const stem = new Mesh(unitBox, (this.materials as MunicipalMaterialSet).paintedSteel);
      stem.scale.set(0.07, y, 0.07);
      stem.position.set(x, y / 2, z);
      root.add(stem);

      const light = new PointLight(WORK_LIGHT, 6.5, 14, 2);
      light.position.set(x, y - 0.1, z);
      root.add(light);
      this.workLights.push({ light, phase: i * 1.7, baseIntensity: 6.5 });
    }
  }

  /**
   * Advances the drift and the work light flicker.
   *
   * Driven by the caller's delta rather than reading a clock, so the title
   * screen animates at whatever rate the app is stepping and pauses when the
   * app does.
   */
  update(dt: number): void {
    if (this.root === null) return;

    this.elapsed += dt;
    this.applyCameraDrift();

    // Backup power in the borough is unstable; the practicals sag and recover
    // rather than flickering like a fault light.
    for (const entry of this.workLights) {
      const wander =
        Math.sin(this.elapsed * 0.9 + entry.phase) * 0.06 +
        Math.sin(this.elapsed * 3.7 + entry.phase * 2.3) * 0.025;
      entry.light.intensity = entry.baseIntensity * (1 + wander);
    }
  }

  /**
   * Slow orbital drift.
   *
   * Wide, slow and unequal periods so the motion never visibly loops. Small
   * enough that the camera stays behind the foreground barrier.
   */
  private applyCameraDrift(): void {
    const t = this.elapsed;
    this.camera.position.set(
      -0.6 + Math.sin(t * 0.062) * 1.05,
      1.72 + Math.sin(t * 0.041) * 0.14,
      5.2 + Math.cos(t * 0.035) * 0.55,
    );
    this.lookTarget.set(Math.sin(t * 0.029) * 1.4, 2.5 + Math.sin(t * 0.05) * 0.25, -26);
    this.camera.lookAt(this.lookTarget);
  }

  /** Rebuilds at a new preset. Called when the player changes graphics. */
  setQuality(preset: QualityPreset): void {
    if (preset.name === this.quality.name && this.root !== null) {
      this.quality = preset;
      return;
    }

    const wasBuilt = this.root !== null;
    const elapsed = this.elapsed;
    if (wasBuilt) this.dispose();
    this.quality = preset;
    if (wasBuilt) {
      this.build();
      // Keep the drift phase so the change is not a visible jump cut.
      this.elapsed = elapsed;
      this.applyCameraDrift();
    }
  }

  /**
   * Removes everything and hands the scene and camera back untouched.
   *
   * Fog, background and camera transform are restored because they belong to
   * the caller: leaving heavy title fog behind would silently change the look
   * of the first gameplay sector.
   */
  dispose(): void {
    const root = this.root;
    if (root === null) return;

    for (const entry of this.workLights) {
      entry.light.dispose();
    }
    this.workLights = [];

    this.sun?.dispose();
    this.sky?.dispose();
    this.sun = null;
    this.sky = null;

    root.clear();
    this.scene.remove(root);
    this.root = null;

    for (const geometry of this.geometries) {
      geometry.dispose();
    }
    this.geometries = [];

    if (this.materials !== null) {
      disposeMunicipalMaterialSet(this.materials);
      this.materials = null;
    }
    if (this.lampMaterial !== null) {
      disposeSurface(this.lampMaterial);
      this.lampMaterial = null;
    }
    this.water?.dispose();
    this.water = null;

    // Hand the caller's atmosphere back.
    this.scene.fog = this.previousFog;
    this.scene.background = this.previousBackground;
    this.previousFog = null;
    this.previousBackground = null;

    this.camera.position.copy(this.cameraHome);
    this.camera.quaternion.copy(this.cameraHomeQuaternion);
    if (this.camera.fov !== this.cameraHomeFov) {
      this.camera.fov = this.cameraHomeFov;
      this.camera.updateProjectionMatrix();
    }

    this.elapsed = 0;
  }
}
