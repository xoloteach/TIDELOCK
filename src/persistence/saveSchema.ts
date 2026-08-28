/**
 * Campaign save schema, defaults and migrations.
 *
 * Campaign saves live in IndexedDB via Dexie (see `SaveStore`), deliberately
 * separate from settings: settings must be readable synchronously during boot
 * and are small, while a save is a larger blob that only the game session
 * needs. Nothing here touches localStorage.
 *
 * Every field is validated with Zod on read and the schema is versioned, so a
 * save written by an older build is migrated field-by-field rather than
 * crashing the game. `migrateSave` never throws.
 *
 * This module intentionally imports nothing from `src/game` or `content`.
 * Mission, dialogue, evidence and tutorial ids are authored content and stay
 * open strings here, so adding a conversation or an objective never requires a
 * schema bump.
 */

import { z } from 'zod';

/**
 * Bumped whenever a stored shape changes. Each bump needs an upgrade step in
 * `normalizeLegacyShape` and a test proving an old blob still loads.
 *
 * v1 -> v2: flat `player.x/y/z` became `player.position`; top-level
 * `act`/`checkpoint` moved under `progress`; `completedTutorials` and
 * `tutorialResetVersion` moved under `tutorial`; `dialogue.choices` changed
 * from an array of `{ sceneId, nodeId }` pairs to a record.
 */
export const SAVE_SCHEMA_VERSION = 2;

/** Campaign acts, in play order. Used for the Continue/Load menu. */
export const ACT_IDS = ['prologue', 'act1', 'act2', 'act3', 'finale', 'epilogue'] as const;

export type ActId = (typeof ACT_IDS)[number];

/** Display names for the load menu. Derived, never stored, so it cannot drift. */
export const ACT_TITLES: Record<ActId, string> = {
  prologue: 'Before the Waterline',
  act1: 'High Water',
  act2: 'The Quiet Floor',
  act3: 'Thirty-Seven Minutes',
  finale: 'Open Gate',
  epilogue: 'Epilogue',
};

export const OBJECTIVE_STATUSES = ['inactive', 'active', 'complete', 'failed'] as const;

export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];

/** The three finale choices. None is good, bad or true. */
export const ENDING_CHOICES = ['publish_now', 'restore_first', 'withhold_resident_data'] as const;

export type EndingChoice = (typeof ENDING_CHOICES)[number];

export const SLOT_TYPES = ['autosave', 'checkpoint', 'manual'] as const;

export type SaveSlotType = (typeof SLOT_TYPES)[number];

/**
 * How many autosave slots the rolling ring keeps by default.
 *
 * This is policy, not a storage limit — see `MAX_AUTOSAVE_SLOTS`. Keeping them
 * separate means raising the ring size is a behaviour change, not a change that
 * makes previously-legal writes fail validation.
 */
export const AUTOSAVE_RING_SIZE = 3;

/** Largest autosave index the schema will store. Bounds the ring size. */
export const MAX_AUTOSAVE_SLOTS = 16;

/**
 * Tutorial completion is keyed by this version. Bumping it re-arms every
 * tutorial for existing saves, which is what we want when a control scheme
 * changes and the old prompts would teach the wrong thing.
 */
export const TUTORIAL_RESET_VERSION = 1;

const actId = z.enum(ACT_IDS);
const objectiveStatus = z.enum(OBJECTIVE_STATUSES);
const endingChoice = z.enum(ENDING_CHOICES);

/**
 * Slot identity as a discriminated union.
 *
 * Autosaves are a ring of indexed slots, checkpoints are keyed by the
 * checkpoint they were taken at (so an act transition cannot silently replace
 * a mid-act checkpoint), and manual slots carry a player-visible label.
 */
export const saveSlotSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('autosave'),
    index: z.number().int().min(0).max(MAX_AUTOSAVE_SLOTS - 1),
  }),
  z.object({
    type: z.literal('checkpoint'),
    checkpointId: z.string().min(1).max(120),
  }),
  z.object({
    type: z.literal('manual'),
    index: z.number().int().min(0).max(31),
    label: z.string().max(64),
  }),
]);

export type SaveSlot = z.infer<typeof saveSlotSchema>;

const vec3 = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

export type Vec3 = z.infer<typeof vec3>;

const progressState = z.object({
  actId,
  /**
   * The checkpoint this save resumes from. `SaveStore` verifies this reference
   * resolves before handing the save to the game; an unresolvable checkpoint
   * is treated as corruption, not as a spawn at the origin.
   */
  checkpointId: z.string().min(1).max(120),
  /** Streaming sector to load first. */
  sectorId: z.string().min(1).max(120),
});

const playerState = z.object({
  position: vec3,
  /** Radians. Pitch is deliberately not persisted; the camera recentres. */
  yaw: z.number(),
  health: z.number().min(0).max(100),
});

const missionState = z.object({
  activeMissionId: z.string().nullable(),
  /** The objective the HUD points at. Null between objectives. */
  activeObjectiveId: z.string().nullable(),
  /** Objective id -> status. Open map: content owns objective ids. */
  objectives: z.record(z.string(), objectiveStatus),
});

/**
 * World flag values.
 *
 * Booleans cover "did this happen", numbers cover trust/stability counters,
 * strings cover small enumerations that dialogue conditions compare against.
 */
const worldFlagValue = z.union([z.boolean(), z.number(), z.string().max(200)]);

export type WorldFlagValue = z.infer<typeof worldFlagValue>;

/**
 * Flags the campaign actually reads. The stored map stays open (`z.record`) so
 * authored content can add flags without a schema bump — this list exists for
 * autocomplete and so a typo in a mission file is easy to spot in review.
 */
export const KNOWN_WORLD_FLAGS = [
  // Prologue
  'crossed_service_bridge',
  'ivo_briefed_mara',
  // Act I — residential edge, Pump Station 12
  'pump12_restarted',
  'pump_cluster_b_resynced',
  'audit_gap_discovered',
  'rescued_resident_act1',
  'dax_made_contact',
  'found_manual_valve_log',
  // Act II — commercial underpass, Civic Relay Annex
  'relay_annex_powered',
  'partial_audit_recovered',
  'sera_override_found',
  'found_priority_policy',
  // Act III — elevated rail, operations archive, flooded tunnel
  'flooded_tunnel_drained',
  'full_audit_timeline_recovered',
  'resident_risk_dataset_recovered',
  'sera_confrontation_complete',
  'sera_optional_context_heard',
  // Finale — main flood barrier control complex
  'gate_procedure_learned',
  'manual_authority_restored',
  'gates_stable',
  // Optional / relationship state
  'clinic_power_stabilized',
  'dax_trust_high',
  'dax_trust',
  'ivo_trust',
  'sera_trust',
  /** Mirror of `ending.choice`; see `recordEndingChoice`. */
  'ending_choice',
] as const;

export type KnownWorldFlag = (typeof KNOWN_WORLD_FLAGS)[number];

const dialogueState = z.object({
  /** Node ids already played, for replay protection and "already asked" gating. */
  seenNodeIds: z.array(z.string()),
  /** Scene ids that have run to completion, so one-shot scenes stay one-shot. */
  completedSceneIds: z.array(z.string()),
  /** sceneId -> chosen node id. */
  choices: z.record(z.string(), z.string()),
});

const inventoryItem = z.object({
  id: z.string().min(1),
  count: z.number().int().min(1).max(99),
});

export type InventoryItem = z.infer<typeof inventoryItem>;

const tutorialState = z.object({
  completedIds: z.array(z.string()),
  /**
   * The `TUTORIAL_RESET_VERSION` in force when these completions were
   * recorded. The tutorial system re-arms everything when it differs.
   */
  resetVersion: z.number().int().min(0),
});

const cinematicState = z.object({
  seenIds: z.array(z.string()),
  /** Skipped separately from seen: story logic may still want to know. */
  skippedIds: z.array(z.string()),
});

const endingState = z.object({
  /** Null until the finale choice is committed. */
  choice: endingChoice.nullable(),
  /**
   * Consequence flags the epilogue reads to dress the depot — power state,
   * NPC placement, radio bulletin. Open map, booleans only.
   */
  flags: z.record(z.string(), z.boolean()),
});

export const saveSchema = z.object({
  schemaVersion: z.number().int(),
  slot: saveSlotSchema,
  /** Epoch milliseconds. */
  savedAt: z.number().int().min(0),
  playtimeSeconds: z.number().min(0),
  /** Commit and version the save was written by, for bug reports. */
  buildCommit: z.string(),
  buildVersion: z.string(),
  progress: progressState,
  player: playerState,
  missions: missionState,
  worldFlags: z.record(z.string(), worldFlagValue),
  dialogue: dialogueState,
  /** Evidence ids the player has collected. Content owns the ids. */
  evidenceIds: z.array(z.string()),
  inventory: z.array(inventoryItem),
  /** Unlocked capability ids. 5-7 across the campaign, not a stat grind. */
  upgrades: z.array(z.string()),
  tutorial: tutorialState,
  cinematics: cinematicState,
  ending: endingState,
});

export type Save = z.infer<typeof saveSchema>;
export type ProgressState = z.infer<typeof progressState>;
export type PlayerState = z.infer<typeof playerState>;
export type MissionState = z.infer<typeof missionState>;
export type DialogueState = z.infer<typeof dialogueState>;
export type TutorialState = z.infer<typeof tutorialState>;
export type CinematicState = z.infer<typeof cinematicState>;
export type EndingState = z.infer<typeof endingState>;

/** Stable string key for a slot. Used as the Dexie primary key. */
export function slotKey(slot: SaveSlot): string {
  switch (slot.type) {
    case 'autosave':
      return `autosave:${slot.index}`;
    case 'checkpoint':
      return `checkpoint:${slot.checkpointId}`;
    case 'manual':
      return `manual:${slot.index}`;
  }
}

/** Inverse of `slotKey`. Returns null for anything it does not recognise. */
export function parseSlotKey(key: string): SaveSlot | null {
  const separator = key.indexOf(':');
  if (separator <= 0) return null;

  const type = key.slice(0, separator);
  const rest = key.slice(separator + 1);
  if (rest.length === 0) return null;

  if (type === 'autosave' || type === 'manual') {
    const index = Number(rest);
    if (!Number.isInteger(index) || index < 0) return null;
    return type === 'autosave' ? { type: 'autosave', index } : { type: 'manual', index, label: '' };
  }
  if (type === 'checkpoint') return { type: 'checkpoint', checkpointId: rest };
  return null;
}

export function actTitle(id: ActId): string {
  return ACT_TITLES[id];
}

export interface NewSaveOptions {
  slot?: SaveSlot;
  savedAt?: number;
  buildCommit?: string;
  buildVersion?: string;
}

/**
 * A fresh New Game save.
 *
 * Also the merge target for `migrateSave`, which is why every field has a
 * concrete value: a missing key in a stored blob resolves to the New Game
 * value instead of `undefined`.
 */
export function createNewSave(options: NewSaveOptions = {}): Save {
  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    slot: options.slot ?? { type: 'autosave', index: 0 },
    savedAt: options.savedAt ?? 0,
    playtimeSeconds: 0,
    buildCommit: options.buildCommit ?? 'unknown',
    buildVersion: options.buildVersion ?? '0.0.0',
    progress: {
      actId: 'prologue',
      checkpointId: 'prologue_depot_wake',
      sectorId: 'depot_platform',
    },
    player: {
      position: { x: 0, y: 0, z: 0 },
      yaw: 0,
      health: 100,
    },
    missions: {
      activeMissionId: 'prologue_before_the_waterline',
      activeObjectiveId: null,
      objectives: {},
    },
    worldFlags: {},
    dialogue: {
      seenNodeIds: [],
      completedSceneIds: [],
      choices: {},
    },
    evidenceIds: [],
    inventory: [],
    upgrades: [],
    tutorial: {
      completedIds: [],
      resetVersion: TUTORIAL_RESET_VERSION,
    },
    cinematics: {
      seenIds: [],
      skippedIds: [],
    },
    ending: {
      choice: null,
      flags: {},
    },
  };
}

/**
 * Commits the finale choice.
 *
 * `ending.choice` is canonical; `worldFlags.ending_choice` is a mirror so that
 * data-driven dialogue and epilogue conditions can compare it like any other
 * flag without a special case in the condition evaluator.
 */
export function recordEndingChoice(save: Save, choice: EndingChoice): Save {
  return {
    ...save,
    ending: { ...save.ending, choice },
    worldFlags: { ...save.worldFlags, ending_choice: choice },
  };
}

/**
 * Paths whose value is an open map or array and must replace wholesale during
 * a merge.
 *
 * A key-filtered recursive merge would drop every entry from these, because
 * the New Game value is `{}` and nothing in a stored blob would match a known
 * key. A save always writes the complete map, so replacing is both correct and
 * simpler.
 */
const REPLACE_WHOLESALE_PATHS: ReadonlySet<string> = new Set([
  'slot',
  'worldFlags',
  'missions.objectives',
  'dialogue.choices',
  'ending.flags',
]);

/**
 * Migrates a stored save blob to the current version.
 *
 * Legacy shapes are normalised first, then merged onto a fresh save
 * field-by-field so a missing key never throws, then validated. Returns null
 * when the input is unusable, letting `SaveStore` preserve the original as a
 * backup and offer an earlier autosave instead of destroying progress.
 */
export function migrateSave(raw: unknown): Save | null {
  if (!isPlainObject(raw)) return null;

  const normalized = normalizeLegacyShape(raw);
  if (!hasSaveIdentity(normalized)) {
    console.warn('[saves] blob lacks save identity (slot, savedAt, progress.checkpointId)');
    return null;
  }

  const fresh = createNewSave();
  const merged = deepMergeSave(
    fresh as unknown as Record<string, unknown>,
    normalized,
    '',
  ) as unknown as Save;
  merged.schemaVersion = SAVE_SCHEMA_VERSION;

  const parsed = saveSchema.safeParse(merged);
  if (parsed.success) return parsed.data;

  console.warn('[saves] stored save failed validation', parsed.error.issues);
  return null;
}

/**
 * A save is identified by its slot, its timestamp and its checkpoint
 * reference.
 *
 * Without those three a blob is not a truncated save that can be topped up
 * from defaults — it is garbage. Merging it onto a fresh save would hand the
 * player a pristine New Game and call it a successful load, which is a worse
 * outcome than telling them the file is damaged and offering the previous
 * autosave.
 */
function hasSaveIdentity(raw: Record<string, unknown>): boolean {
  if (!isPlainObject(raw.slot)) return false;
  if (typeof raw.savedAt !== 'number' || !Number.isFinite(raw.savedAt)) return false;
  if (!isPlainObject(raw.progress)) return false;
  const checkpointId = raw.progress.checkpointId;
  return typeof checkpointId === 'string' && checkpointId.trim().length > 0;
}

/**
 * Rewrites known older shapes into the current one.
 *
 * Runs before the merge so that relocated fields land on the right key instead
 * of being dropped as unrecognised.
 */
function normalizeLegacyShape(raw: Record<string, unknown>): Record<string, unknown> {
  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1;
  if (version >= SAVE_SCHEMA_VERSION) return raw;

  const out: Record<string, unknown> = { ...raw };

  // v1 stored the slot as a bare string: 'autosave', 'manual', or a
  // 'checkpoint:<id>' key. Anything else is left alone so it fails validation
  // and the corruption path engages rather than being silently reinterpreted.
  if (typeof out.slot === 'string') {
    const parsedSlot = parseSlotKey(out.slot);
    if (parsedSlot) out.slot = parsedSlot;
    else if (out.slot === 'autosave') out.slot = { type: 'autosave', index: 0 };
    else if (out.slot === 'manual') out.slot = { type: 'manual', index: 0, label: '' };
  }

  // v1 stored savedAt as an ISO timestamp.
  if (typeof out.savedAt === 'string') {
    const parsedDate = Date.parse(out.savedAt);
    if (Number.isFinite(parsedDate)) out.savedAt = parsedDate;
  }

  // v1 stored the act and checkpoint at the top level.
  const progress: Record<string, unknown> = isPlainObject(out.progress) ? { ...out.progress } : {};
  if (typeof out.act === 'string' && progress.actId === undefined) progress.actId = out.act;
  if (typeof out.checkpoint === 'string' && progress.checkpointId === undefined) {
    progress.checkpointId = out.checkpoint;
  }
  if (typeof out.sector === 'string' && progress.sectorId === undefined) {
    progress.sectorId = out.sector;
  }
  if (Object.keys(progress).length > 0) out.progress = progress;
  delete out.act;
  delete out.checkpoint;
  delete out.sector;

  // v1 stored the player transform flat.
  if (isPlainObject(out.player)) {
    const player: Record<string, unknown> = { ...out.player };
    if (
      !isPlainObject(player.position) &&
      typeof player.x === 'number' &&
      typeof player.y === 'number' &&
      typeof player.z === 'number'
    ) {
      player.position = { x: player.x, y: player.y, z: player.z };
    }
    delete player.x;
    delete player.y;
    delete player.z;
    out.player = player;
  }

  // v1 stored tutorial completion at the top level.
  const tutorial: Record<string, unknown> = isPlainObject(out.tutorial) ? { ...out.tutorial } : {};
  if (Array.isArray(out.completedTutorials) && tutorial.completedIds === undefined) {
    tutorial.completedIds = out.completedTutorials;
  }
  if (typeof out.tutorialResetVersion === 'number' && tutorial.resetVersion === undefined) {
    tutorial.resetVersion = out.tutorialResetVersion;
  }
  if (Object.keys(tutorial).length > 0) out.tutorial = tutorial;
  delete out.completedTutorials;
  delete out.tutorialResetVersion;

  // v1 stored dialogue choices as an array of pairs.
  if (isPlainObject(out.dialogue)) {
    const dialogue: Record<string, unknown> = { ...out.dialogue };
    if (Array.isArray(dialogue.choices)) {
      const choices: Record<string, string> = {};
      for (const entry of dialogue.choices) {
        if (!isPlainObject(entry)) continue;
        const sceneId = entry.sceneId;
        const nodeId = entry.nodeId ?? entry.chosenNodeId;
        if (typeof sceneId === 'string' && typeof nodeId === 'string') choices[sceneId] = nodeId;
      }
      dialogue.choices = choices;
    }
    if (Array.isArray(dialogue.seenNodes) && dialogue.seenNodeIds === undefined) {
      dialogue.seenNodeIds = dialogue.seenNodes;
      delete dialogue.seenNodes;
    }
    out.dialogue = dialogue;
  }

  // v1 called the evidence list `evidence`.
  if (Array.isArray(out.evidence) && out.evidenceIds === undefined) {
    out.evidenceIds = out.evidence;
  }
  delete out.evidence;

  return out;
}

/**
 * Recursively merges stored values onto a fresh save.
 *
 * Only plain objects recurse, and only keys the current schema still knows
 * about survive, so a field removed in a later build is dropped rather than
 * failing validation. Paths in `REPLACE_WHOLESALE_PATHS` replace instead.
 */
function deepMergeSave(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(incoming)) {
    if (!(key in base)) continue; // Drop keys we no longer understand.
    if (value === undefined) continue;

    const childPath = path === '' ? key : `${path}.${key}`;
    const baseValue = base[key];

    if (
      !REPLACE_WHOLESALE_PATHS.has(childPath) &&
      isPlainObject(baseValue) &&
      isPlainObject(value)
    ) {
      out[key] = deepMergeSave(baseValue, value, childPath);
    } else {
      out[key] = value;
    }
  }

  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
