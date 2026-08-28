/**
 * Sector data model (spec §9.2).
 *
 * The world is not one scene. It is four dense districts cut into sectors, and
 * a sector owns everything needed to make its part of Morrow Quay exist: render
 * assets, a baked collision mesh, a navmesh, audio zones, interactables, NPC
 * and machine spawns, triggers, baked light/probe data and LOD metadata. It
 * also declares its neighbours and a bounding volume, which together are the
 * only inputs the streaming system needs to decide what is resident.
 *
 * Two deliberate constraints:
 *
 *  - **Data, not code.** A sector is authored JSON. Adding a room must not
 *    require touching a system, and the whole set can be linted before the
 *    game runs.
 *  - **No scene state.** Nothing here references a `Object3D`, a Rapier body or
 *    a texture. Assets are *references*; the streaming loader resolves them.
 *    That is what lets gameplay state persist independently of loaded scene
 *    objects.
 *
 * `validateSectorGraph` is the linter. It catches the failures that otherwise
 * surface as a hole in the floor an hour into a playthrough: a neighbour id
 * that was renamed, adjacency declared in one direction only, two unrelated
 * sectors claiming the same volume (so "which sector am I in" has no answer),
 * and missing asset references.
 */

import { z } from 'zod';
import {
  CollisionLayer,
  type AudioBus,
  type CollisionLayerName,
  type InteractionVerb,
  type MachineKind,
  type MachineState,
  type Vec3,
} from '../../engine/ecs/components';
import type {
  IssueSeverity,
  ValidationIssue,
  ValidationResult,
} from '../dialogue/dialogueSchema';

export type SectorId = string;

export const SECTOR_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Enum plumbing
// ---------------------------------------------------------------------------

/**
 * Turns an exhaustive key map into a tuple for `z.enum`.
 *
 * `components.ts` declares these unions as types, so there is no runtime list
 * to derive from. Writing the literal as `Record<Union, true>` means adding a
 * member to the union without adding it here fails to compile, instead of
 * silently rejecting valid authored data at load time.
 */
function exhaustiveKeys<T extends string>(map: Record<T, true>): [T, ...T[]] {
  const keys = Object.keys(map) as T[];
  const [first, ...rest] = keys;
  if (first === undefined) throw new Error('exhaustiveKeys: empty map');
  return [first, ...rest];
}

const interactionVerbSchema = z.enum(
  exhaustiveKeys<InteractionVerb>({
    open: true,
    close: true,
    use: true,
    take: true,
    inspect: true,
    talk: true,
    turn: true,
    connect: true,
    climb: true,
    read: true,
  }),
);

const machineKindSchema = z.enum(
  exhaustiveKeys<MachineKind>({
    'inspection-unit': true,
    'repair-crawler': true,
    'containment-unit': true,
    'gate-frame': true,
  }),
);

const machineStateSchema = z.enum(
  exhaustiveKeys<MachineState>({
    dormant: true,
    patrol: true,
    inspect: true,
    suspicious: true,
    alert: true,
    search: true,
    pursue: true,
    recover: true,
    disabled: true,
  }),
);

const audioBusSchema = z.enum(
  exhaustiveKeys<AudioBus>({
    music: true,
    ambience: true,
    dialogue: true,
    effects: true,
    ui: true,
  }),
);

/** Derived from the runtime layer table, so it can never drift. */
const collisionLayerNameSchema = z.enum(
  Object.keys(CollisionLayer) as [CollisionLayerName, ...CollisionLayerName[]],
);

/** ORs layer names into a Rapier membership/filter mask. */
export function collisionMask(names: readonly CollisionLayerName[]): number {
  return names.reduce((mask, name) => mask | CollisionLayer[name], 0);
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const vec3Schema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});

/** sRGB hex, e.g. `#ffb45a` for a sodium work light. */
const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb');

/** Axis-aligned bounding volume, in world metres. */
export interface SectorBounds {
  min: Vec3;
  max: Vec3;
}

export const sectorBoundsSchema = z
  .strictObject({ min: vec3Schema, max: vec3Schema })
  .refine(
    (bounds) =>
      bounds.max.x > bounds.min.x &&
      bounds.max.y > bounds.min.y &&
      bounds.max.z > bounds.min.z,
    { message: 'bounds max must exceed min on every axis' },
  );

/**
 * A file the streaming loader must fetch.
 *
 * `bytes` is the compressed on-disk size recorded by the build. It is what the
 * memory estimate and the asset budget checks (spec §60) are measured against —
 * a budget nobody can measure is not a budget.
 */
export interface AssetRef {
  id: string;
  /** Path under `public/assets`, e.g. `models/pump_12.glb`. */
  url: string;
  bytes: number;
}

export const assetRefSchema = z.strictObject({
  id: z.string().min(1),
  url: z.string().min(1),
  bytes: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Sector contents
// ---------------------------------------------------------------------------

export interface SectorRenderAssets {
  models: AssetRef[];
  textures: AssetRef[];
}

export const sectorRenderAssetsSchema = z.strictObject({
  models: z.array(assetRefSchema),
  textures: z.array(assetRefSchema),
});

export interface SectorCollision {
  asset: AssetRef;
  /** Layers the baked geometry belongs to. Almost always `['World']`. */
  membership: CollisionLayerName[];
  /**
   * True only when the export's triangle winding has been verified. It enables
   * internal-edge fixing (characters stop catching on coplanar seams) at the
   * cost of making back faces non-solid — a single flipped triangle then
   * becomes an invisible hole in the floor.
   */
  orientedMesh: boolean;
}

export const sectorCollisionSchema = z.strictObject({
  asset: assetRefSchema,
  membership: z.array(collisionLayerNameSchema).min(1),
  orientedMesh: z.boolean(),
});

export interface SectorLight {
  id: string;
  kind: 'point' | 'spot' | 'rect';
  position: Vec3;
  colorHex: string;
  intensity: number;
  /** Metres of influence. Used for culling against the preset light budget. */
  range: number;
  /** Higher survives when the preset's `maxDynamicLights` is exceeded. */
  priority: number;
  castsShadow: boolean;
  /** Unstable backup power and emergency LEDs. Omit for steady lights. */
  flicker?: { hz: number; amount: number };
}

export const sectorLightSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(['point', 'spot', 'rect']),
  position: vec3Schema,
  colorHex: hexColorSchema,
  intensity: z.number().nonnegative(),
  range: z.number().positive(),
  priority: z.number().int(),
  castsShadow: z.boolean(),
  flicker: z
    .strictObject({ hz: z.number().positive(), amount: z.number().min(0).max(1) })
    .optional(),
});

export interface SectorLighting {
  /** Baked irradiance probe volume. */
  probes: AssetRef | null;
  lightmap: AssetRef | null;
  lights: SectorLight[];
  /** Ambient/fog tint for the sector, sRGB hex. */
  ambientHex: string;
}

export const sectorLightingSchema = z.strictObject({
  probes: assetRefSchema.nullable(),
  lightmap: assetRefSchema.nullable(),
  lights: z.array(sectorLightSchema),
  ambientHex: hexColorSchema,
});

export interface SectorAudioZone {
  id: string;
  clipId: string;
  bus: AudioBus;
  bounds: SectorBounds;
  gain: number;
  /** Cross-fade seconds as the listener enters or leaves. */
  fadeSeconds: number;
  /** Reverb preset id, e.g. `concrete-underpass`. */
  reverb: string | null;
}

export const sectorAudioZoneSchema = z.strictObject({
  id: z.string().min(1),
  clipId: z.string().min(1),
  bus: audioBusSchema,
  bounds: sectorBoundsSchema,
  gain: z.number().min(0).max(2),
  fadeSeconds: z.number().nonnegative(),
  reverb: z.string().min(1).nullable(),
});

export interface SectorInteractable {
  id: string;
  verb: InteractionVerb;
  /** Short diegetic label, e.g. `Breaker 4B`. */
  label: string;
  position: Vec3;
  yaw: number;
  range: number;
  holdDuration: number;
  /** Emitted on the game bus when the interaction completes. */
  event: string;
  repeatable: boolean;
  /** Model to instance, or null for a pure interaction volume. */
  model: string | null;
  /**
   * Set when this object's state must outlive its sector — a valve left open
   * stays open after the player walks two districts away and back.
   */
  persistentId?: string;
}

export const sectorInteractableSchema = z.strictObject({
  id: z.string().min(1),
  verb: interactionVerbSchema,
  label: z.string().min(1),
  position: vec3Schema,
  yaw: z.number(),
  range: z.number().positive(),
  holdDuration: z.number().nonnegative(),
  event: z.string().min(1),
  repeatable: z.boolean(),
  model: z.string().min(1).nullable(),
  persistentId: z.string().min(1).optional(),
});

export interface SectorNpcSpawn {
  id: string;
  characterId: string;
  position: Vec3;
  yaw: number;
  /** Named idle/work animation set, e.g. `clinic-triage`. */
  activityTag: string;
  /** Narrative gate: spawned only while this flag is set. */
  requiresFlag?: string;
}

export const sectorNpcSpawnSchema = z.strictObject({
  id: z.string().min(1),
  characterId: z.string().min(1),
  position: vec3Schema,
  yaw: z.number(),
  activityTag: z.string().min(1),
  requiresFlag: z.string().min(1).optional(),
});

export interface SectorMachineSpawn {
  id: string;
  kind: MachineKind;
  position: Vec3;
  yaw: number;
  patrolRoute: Vec3[];
  initialState: MachineState;
}

export const sectorMachineSpawnSchema = z.strictObject({
  id: z.string().min(1),
  kind: machineKindSchema,
  position: vec3Schema,
  yaw: z.number(),
  patrolRoute: z.array(vec3Schema),
  initialState: machineStateSchema,
});

export interface SectorTrigger {
  id: string;
  event: string;
  bounds: SectorBounds;
  /** Layers permitted to trip it. Usually `['Player']`. */
  filter: CollisionLayerName[];
  once: boolean;
  requiresFlag?: string;
}

export const sectorTriggerSchema = z.strictObject({
  id: z.string().min(1),
  event: z.string().min(1),
  bounds: sectorBoundsSchema,
  filter: z.array(collisionLayerNameSchema).min(1),
  once: z.boolean(),
  requiresFlag: z.string().min(1).optional(),
});

export interface SectorLodMeta {
  /** Authored switch distances in metres, nearest first. */
  distances: number[];
  /** Triangles at LOD0, checked against the preset triangle budget. */
  triangleBudget: number;
  /** Metres beyond which the sector draws as one impostor. 0 disables. */
  impostorDistance: number;
}

export const sectorLodMetaSchema = z.strictObject({
  distances: z.array(z.number().positive()),
  triangleBudget: z.number().int().positive(),
  impostorDistance: z.number().nonnegative(),
});

export interface SectorBudget {
  /** Ceiling on the sum of the sector's asset `bytes` (spec §60). */
  maxCompressedBytes: number;
  /** Expected bytes resident once decoded. Drives the memory estimate. */
  estimatedResidentBytes: number;
  maxResidentTextures: number;
}

export const sectorBudgetSchema = z.strictObject({
  maxCompressedBytes: z.number().int().positive(),
  estimatedResidentBytes: z.number().int().positive(),
  maxResidentTextures: z.number().int().positive(),
});

// ---------------------------------------------------------------------------
// Sector
// ---------------------------------------------------------------------------

/**
 * `transition` marks a bridge, stairwell, lift or service corridor whose only
 * job is to join two playable sectors. The streaming system expands residency
 * one extra hop through them, so the far side of a short bridge is already
 * loaded when the player steps onto it (spec §59, traversal masking).
 */
export const SECTOR_KINDS = ['playable', 'transition'] as const;
export type SectorKind = (typeof SECTOR_KINDS)[number];

export interface SectorDefinition {
  version: number;
  id: SectorId;
  /** Authoring label. Not player-facing. */
  name: string;
  kind: SectorKind;
  /** District grouping, for loading copy and per-district asset budgets. */
  district: string;
  bounds: SectorBounds;
  /** Adjacency. Must be symmetric; the validator enforces it. */
  neighbours: SectorId[];
  /**
   * Non-adjacent sectors this one is permitted to overlap — a flooded tunnel
   * running under a street it has no connection to. Without the exemption the
   * validator treats a shared volume as an authoring error.
   */
  overlapsAllowedWith?: SectorId[];
  render: SectorRenderAssets;
  /** Null only for sectors the player can never stand in. */
  collision: SectorCollision | null;
  /** Null when nothing navigates here. */
  navmesh: AssetRef | null;
  lighting: SectorLighting;
  audioZones: SectorAudioZone[];
  interactables: SectorInteractable[];
  npcSpawns: SectorNpcSpawn[];
  machineSpawns: SectorMachineSpawn[];
  triggers: SectorTrigger[];
  lod: SectorLodMeta;
  budget: SectorBudget;
  /** Author-pinned: kept resident regardless of distance. */
  alwaysResident: boolean;
}

export const sectorSchema = z.strictObject({
  version: z.number().int().positive(),
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(SECTOR_KINDS),
  district: z.string().min(1),
  bounds: sectorBoundsSchema,
  neighbours: z.array(z.string().min(1)),
  overlapsAllowedWith: z.array(z.string().min(1)).optional(),
  render: sectorRenderAssetsSchema,
  collision: sectorCollisionSchema.nullable(),
  navmesh: assetRefSchema.nullable(),
  lighting: sectorLightingSchema,
  audioZones: z.array(sectorAudioZoneSchema),
  interactables: z.array(sectorInteractableSchema),
  npcSpawns: z.array(sectorNpcSpawnSchema),
  machineSpawns: z.array(sectorMachineSpawnSchema),
  triggers: z.array(sectorTriggerSchema),
  lod: sectorLodMetaSchema,
  budget: sectorBudgetSchema,
  alwaysResident: z.boolean(),
});

/**
 * Parses one authored sector, throwing on malformed input.
 *
 * A sector that fails to parse is a chunk of the borough the player cannot
 * reach, so this is fatal rather than a warning.
 */
export function parseSector(raw: unknown): SectorDefinition {
  const parsed = sectorSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid sector: ${detail}`);
  }
  if (parsed.data.version !== SECTOR_SCHEMA_VERSION) {
    throw new Error(
      `sector "${parsed.data.id}" is schema version ${parsed.data.version}, expected ${SECTOR_SCHEMA_VERSION}`,
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

export function boundsContain(bounds: SectorBounds, point: Vec3): boolean {
  return (
    point.x >= bounds.min.x &&
    point.x <= bounds.max.x &&
    point.y >= bounds.min.y &&
    point.y <= bounds.max.y &&
    point.z >= bounds.min.z &&
    point.z <= bounds.max.z
  );
}

/** Metres from a point to the nearest face of a box. 0 when inside. */
export function boundsDistance(bounds: SectorBounds, point: Vec3): number {
  const dx = Math.max(bounds.min.x - point.x, 0, point.x - bounds.max.x);
  const dy = Math.max(bounds.min.y - point.y, 0, point.y - bounds.max.y);
  const dz = Math.max(bounds.min.z - point.z, 0, point.z - bounds.max.z);
  return Math.hypot(dx, dy, dz);
}

export function boundsCenter(bounds: SectorBounds): Vec3 {
  return {
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
    z: (bounds.min.z + bounds.max.z) / 2,
  };
}

/**
 * True when two volumes share more than a face.
 *
 * `epsilon` exists so sectors authored to touch exactly — the usual case, one
 * ending where the next begins — are not reported as overlapping.
 */
export function boundsOverlap(
  a: SectorBounds,
  b: SectorBounds,
  epsilon = 1e-3,
): boolean {
  return (
    a.min.x < b.max.x - epsilon &&
    b.min.x < a.max.x - epsilon &&
    a.min.y < b.max.y - epsilon &&
    b.min.y < a.max.y - epsilon &&
    a.min.z < b.max.z - epsilon &&
    b.min.z < a.max.z - epsilon
  );
}

/** Authored LOD distances scaled by the active preset's `lodMultiplier`. */
export function scaleLodDistances(lod: SectorLodMeta, multiplier: number): number[] {
  return lod.distances.map((distance) => distance * multiplier);
}

/** Sum of every asset reference's compressed size. */
export function sectorAssetBytes(sector: SectorDefinition): number {
  let total = 0;
  for (const asset of sector.render.models) total += asset.bytes;
  for (const asset of sector.render.textures) total += asset.bytes;
  if (sector.collision) total += sector.collision.asset.bytes;
  if (sector.navmesh) total += sector.navmesh.bytes;
  if (sector.lighting.probes) total += sector.lighting.probes.bytes;
  if (sector.lighting.lightmap) total += sector.lighting.lightmap.bytes;
  return total;
}

/** Every asset the loader must fetch for this sector. */
export function sectorAssets(sector: SectorDefinition): AssetRef[] {
  const assets = [...sector.render.models, ...sector.render.textures];
  if (sector.collision) assets.push(sector.collision.asset);
  if (sector.navmesh) assets.push(sector.navmesh);
  if (sector.lighting.probes) assets.push(sector.lighting.probes);
  if (sector.lighting.lightmap) assets.push(sector.lighting.lightmap);
  return assets;
}

export function buildSectorIndex(
  sectors: readonly SectorDefinition[],
): Map<SectorId, SectorDefinition> {
  const index = new Map<SectorId, SectorDefinition>();
  for (const sector of sectors) {
    if (index.has(sector.id)) {
      throw new Error(`duplicate sector id "${sector.id}"`);
    }
    index.set(sector.id, sector);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Graph validation
// ---------------------------------------------------------------------------

export type SectorIssueCode =
  // Errors
  | 'duplicate-sector-id'
  | 'unsupported-version'
  | 'self-neighbour'
  | 'unknown-neighbour'
  | 'asymmetric-adjacency'
  | 'invalid-bounds'
  | 'overlapping-bounds'
  | 'missing-render-assets'
  | 'missing-collision'
  | 'missing-navmesh'
  | 'empty-asset-url'
  | 'duplicate-asset-id'
  | 'asset-budget-exceeded'
  | 'unreachable-sector'
  // Warnings
  | 'isolated-sector'
  | 'transition-degree'
  | 'content-outside-bounds';

export type SectorValidationResult = ValidationResult<SectorIssueCode>;

export interface SectorValidationOptions {
  /**
   * Where the campaign starts. When given, every sector must be reachable from
   * it through adjacency — an unreachable sector is content nobody will see.
   */
  entrySectorId?: SectorId;
}

function issue(
  code: SectorIssueCode,
  severity: IssueSeverity,
  message: string,
  target?: string,
): ValidationIssue<SectorIssueCode> {
  return target === undefined
    ? { code, severity, message }
    : { code, severity, message, target };
}

/**
 * Lints a whole sector set.
 *
 * Overlap rule: neighbouring sectors are *expected* to share a seam volume, so
 * overlap between them is fine. Overlap between sectors that are not adjacent
 * (and not explicitly exempted) is an error, because the streaming system has
 * to answer "which sector is the player in" from the bounds alone and two
 * unrelated claims on the same cubic metre make that answer arbitrary.
 */
export function validateSectorGraph(
  sectors: readonly SectorDefinition[],
  options: SectorValidationOptions = {},
): SectorValidationResult {
  const errors: ValidationIssue<SectorIssueCode>[] = [];
  const warnings: ValidationIssue<SectorIssueCode>[] = [];

  // --- identity ----------------------------------------------------------
  const byId = new Map<SectorId, SectorDefinition>();
  for (const sector of sectors) {
    if (byId.has(sector.id)) {
      errors.push(
        issue(
          'duplicate-sector-id',
          'error',
          `duplicate sector id "${sector.id}"`,
          sector.id,
        ),
      );
      continue; // First definition wins so the graph stays walkable.
    }
    byId.set(sector.id, sector);
  }

  // --- per-sector --------------------------------------------------------
  for (const sector of byId.values()) {
    if (sector.version !== SECTOR_SCHEMA_VERSION) {
      errors.push(
        issue(
          'unsupported-version',
          'error',
          `sector "${sector.id}" is schema version ${sector.version}, expected ${SECTOR_SCHEMA_VERSION}`,
          sector.id,
        ),
      );
    }

    validateBounds(sector, errors);
    validateAdjacency(sector, byId, errors, warnings);
    validateAssets(sector, errors);
    validateContentPlacement(sector, warnings);
  }

  // --- overlap ----------------------------------------------------------
  const ordered = [...byId.values()];
  for (let i = 0; i < ordered.length; i += 1) {
    const a = ordered[i]!;
    for (let j = i + 1; j < ordered.length; j += 1) {
      const b = ordered[j]!;
      if (a.neighbours.includes(b.id) || b.neighbours.includes(a.id)) continue;
      if (a.overlapsAllowedWith?.includes(b.id) || b.overlapsAllowedWith?.includes(a.id)) {
        continue;
      }
      if (!boundsOverlap(a.bounds, b.bounds)) continue;
      errors.push(
        issue(
          'overlapping-bounds',
          'error',
          `sectors "${a.id}" and "${b.id}" overlap but are not adjacent`,
          a.id,
        ),
      );
    }
  }

  // --- reachability -----------------------------------------------------
  const entry = options.entrySectorId;
  if (entry !== undefined && byId.has(entry)) {
    const reached = walkReachable(entry, byId);
    for (const id of byId.keys()) {
      if (reached.has(id)) continue;
      errors.push(
        issue(
          'unreachable-sector',
          'error',
          `sector "${id}" cannot be reached from entry sector "${entry}"`,
          id,
        ),
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function validateBounds(
  sector: SectorDefinition,
  errors: ValidationIssue<SectorIssueCode>[],
): void {
  const { min, max } = sector.bounds;
  if (max.x > min.x && max.y > min.y && max.z > min.z) return;
  errors.push(
    issue(
      'invalid-bounds',
      'error',
      `sector "${sector.id}" has bounds whose max does not exceed its min on every axis`,
      sector.id,
    ),
  );
}

function validateAdjacency(
  sector: SectorDefinition,
  byId: ReadonlyMap<SectorId, SectorDefinition>,
  errors: ValidationIssue<SectorIssueCode>[],
  warnings: ValidationIssue<SectorIssueCode>[],
): void {
  const seen = new Set<SectorId>();

  for (const neighbourId of sector.neighbours) {
    if (neighbourId === sector.id) {
      errors.push(
        issue(
          'self-neighbour',
          'error',
          `sector "${sector.id}" lists itself as a neighbour`,
          sector.id,
        ),
      );
      continue;
    }
    if (seen.has(neighbourId)) continue;
    seen.add(neighbourId);

    const neighbour = byId.get(neighbourId);
    if (!neighbour) {
      errors.push(
        issue(
          'unknown-neighbour',
          'error',
          `sector "${sector.id}" lists unknown neighbour "${neighbourId}"`,
          sector.id,
        ),
      );
      continue;
    }
    if (!neighbour.neighbours.includes(sector.id)) {
      errors.push(
        issue(
          'asymmetric-adjacency',
          'error',
          `sector "${sector.id}" lists "${neighbourId}" as a neighbour but not the other way round`,
          sector.id,
        ),
      );
    }
  }

  if (byId.size > 1 && sector.neighbours.length === 0) {
    warnings.push(
      issue(
        'isolated-sector',
        'warning',
        `sector "${sector.id}" has no neighbours and can only be reached by a scripted load`,
        sector.id,
      ),
    );
  }

  // A transition sector that does not join exactly two places is either a
  // dead-end corridor or a junction pretending to be one.
  if (sector.kind === 'transition' && sector.neighbours.length !== 2) {
    warnings.push(
      issue(
        'transition-degree',
        'warning',
        `transition sector "${sector.id}" joins ${sector.neighbours.length} sectors, expected 2`,
        sector.id,
      ),
    );
  }
}

function validateAssets(
  sector: SectorDefinition,
  errors: ValidationIssue<SectorIssueCode>[],
): void {
  const assets = sectorAssets(sector);

  if (sector.render.models.length === 0) {
    errors.push(
      issue(
        'missing-render-assets',
        'error',
        `sector "${sector.id}" declares no render models`,
        sector.id,
      ),
    );
  }

  if (sector.kind === 'playable' && sector.collision === null) {
    errors.push(
      issue(
        'missing-collision',
        'error',
        `playable sector "${sector.id}" has no collision mesh`,
        sector.id,
      ),
    );
  }

  const navigates = sector.npcSpawns.length > 0 || sector.machineSpawns.length > 0;
  if (navigates && sector.navmesh === null) {
    errors.push(
      issue(
        'missing-navmesh',
        'error',
        `sector "${sector.id}" spawns ${sector.npcSpawns.length} NPC(s) and ${sector.machineSpawns.length} machine(s) but has no navmesh`,
        sector.id,
      ),
    );
  }

  const seenAssetIds = new Set<string>();
  for (const asset of assets) {
    if (asset.url.trim().length === 0) {
      errors.push(
        issue(
          'empty-asset-url',
          'error',
          `sector "${sector.id}" asset "${asset.id}" has no url`,
          sector.id,
        ),
      );
    }
    if (seenAssetIds.has(asset.id)) {
      errors.push(
        issue(
          'duplicate-asset-id',
          'error',
          `sector "${sector.id}" declares asset id "${asset.id}" twice`,
          sector.id,
        ),
      );
      continue;
    }
    seenAssetIds.add(asset.id);
  }

  const total = sectorAssetBytes(sector);
  if (total > sector.budget.maxCompressedBytes) {
    errors.push(
      issue(
        'asset-budget-exceeded',
        'error',
        `sector "${sector.id}" assets total ${total} bytes, over its ${sector.budget.maxCompressedBytes} byte budget`,
        sector.id,
      ),
    );
  }
}

/**
 * Warns about authored content placed outside the sector that owns it.
 *
 * A warning rather than an error: seam props and a trigger volume that reaches
 * across a doorway are legitimate. But an interactable a hundred metres outside
 * its own bounds will be unloaded while visible, and that reads as a bug.
 */
function validateContentPlacement(
  sector: SectorDefinition,
  warnings: ValidationIssue<SectorIssueCode>[],
): void {
  const strays: string[] = [];

  for (const item of sector.interactables) {
    if (!boundsContain(sector.bounds, item.position)) strays.push(`interactable ${item.id}`);
  }
  for (const spawn of sector.npcSpawns) {
    if (!boundsContain(sector.bounds, spawn.position)) strays.push(`npc ${spawn.id}`);
  }
  for (const spawn of sector.machineSpawns) {
    if (!boundsContain(sector.bounds, spawn.position)) strays.push(`machine ${spawn.id}`);
  }
  for (const trigger of sector.triggers) {
    if (!boundsOverlap(sector.bounds, trigger.bounds)) strays.push(`trigger ${trigger.id}`);
  }
  for (const zone of sector.audioZones) {
    if (!boundsOverlap(sector.bounds, zone.bounds)) strays.push(`audio zone ${zone.id}`);
  }

  if (strays.length === 0) return;
  warnings.push(
    issue(
      'content-outside-bounds',
      'warning',
      `sector "${sector.id}" places content outside its own bounds: ${strays.join(', ')}`,
      sector.id,
    ),
  );
}

function walkReachable(
  entry: SectorId,
  byId: ReadonlyMap<SectorId, SectorDefinition>,
): Set<SectorId> {
  const reached = new Set<SectorId>([entry]);
  const stack: SectorId[] = [entry];

  while (stack.length > 0) {
    const current = stack.pop() as SectorId;
    for (const neighbourId of byId.get(current)?.neighbours ?? []) {
      if (reached.has(neighbourId) || !byId.has(neighbourId)) continue;
      reached.add(neighbourId);
      stack.push(neighbourId);
    }
  }

  return reached;
}
