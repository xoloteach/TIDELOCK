/**
 * Campaign save schema, migration and persistence tests.
 *
 * `fake-indexeddb/auto` is a test-only dependency, and a justified one: Dexie
 * talks to the real IndexedDB API and jsdom ships no implementation at all, so
 * without it there is nothing for the store to talk to. It substitutes the
 * *browser API*, not the code under test — SaveStore, Dexie, the Zod schema,
 * every migration step and the whole corruption-recovery path run for real
 * against a spec-compliant in-process database. The only thing mocked is the
 * platform.
 *
 * "Never crash because an old save is missing a field" is the load-bearing
 * requirement here, so migration is tested against truncated, legacy, corrupt
 * and future-shaped inputs rather than only the happy path.
 */

import 'fake-indexeddb/auto';

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  ACT_IDS,
  ACT_TITLES,
  AUTOSAVE_RING_SIZE,
  KNOWN_WORLD_FLAGS,
  MAX_AUTOSAVE_SLOTS,
  SAVE_SCHEMA_VERSION,
  TUTORIAL_RESET_VERSION,
  actTitle,
  createNewSave,
  migrateSave,
  parseSlotKey,
  recordEndingChoice,
  saveSchema,
  slotKey,
  type Save,
  type SaveSlot,
} from '../../src/persistence/saveSchema';
import { SaveStore, type SaveStoreOptions } from '../../src/persistence/SaveStore';

/** Unique database per store so tests cannot leak state into each other. */
let databaseCounter = 0;
const openStores: SaveStore[] = [];

function makeStore(options: SaveStoreOptions = {}): SaveStore {
  databaseCounter += 1;
  const store = new SaveStore({
    databaseName: `tidelock-saves-test-${databaseCounter}`,
    ...options,
  });
  openStores.push(store);
  return store;
}

/** A save with every section populated, so nothing passes by being empty. */
function makeSave(overrides: Partial<Save> = {}): Save {
  const base = createNewSave();
  return {
    ...base,
    savedAt: 1_700_000_000_000,
    playtimeSeconds: 1234.5,
    buildCommit: 'abc1234',
    buildVersion: '0.4.2',
    progress: {
      actId: 'act2',
      checkpointId: 'act2_relay_annex_entry',
      sectorId: 'relay_annex_lower',
    },
    player: {
      position: { x: 12.5, y: 3.25, z: -48 },
      yaw: 1.5707,
      health: 82,
    },
    missions: {
      activeMissionId: 'act2_the_quiet_floor',
      activeObjectiveId: 'restore_annex_feed',
      objectives: {
        reach_underpass: 'complete',
        restore_annex_feed: 'active',
        recover_partial_audit: 'inactive',
        keep_valve_dry: 'failed',
      },
    },
    worldFlags: {
      crossed_service_bridge: true,
      pump12_restarted: true,
      rescued_resident_act1: true,
      clinic_power_stabilized: false,
      dax_trust_high: true,
      dax_trust: 3,
      found_manual_valve_log: true,
      sera_optional_context_heard: 'partial',
    },
    dialogue: {
      seenNodeIds: ['act1_pump12_priority:s1', 'act1_pump12_priority:s2'],
      completedSceneIds: ['act1_pump12_priority'],
      choices: {
        act1_pump12_priority: 's2_press',
        act2_underpass_dax: 's4_wait',
      },
    },
    evidenceIds: ['audit_fragment_0214', 'manual_valve_log_12'],
    inventory: [
      { id: 'pulse_tool_cell', count: 2 },
      { id: 'relay_fuse', count: 1 },
    ],
    upgrades: ['scan_range_1', 'quiet_wading'],
    tutorial: {
      completedIds: ['tut_move', 'tut_interact', 'tut_scan'],
      resetVersion: TUTORIAL_RESET_VERSION,
    },
    cinematics: {
      seenIds: ['cin_prologue_depot'],
      skippedIds: ['cin_act1_bridge'],
    },
    ending: {
      choice: null,
      flags: {},
    },
    ...overrides,
  };
}

/**
 * A blob shaped the way v1 wrote it: flat player transform, top-level act and
 * checkpoint, tutorial completion at the root, dialogue choices as pairs,
 * `evidence` instead of `evidenceIds`, a bare slot string and an ISO timestamp.
 */
function makeV1Blob(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    slot: 'checkpoint:act1_pump12_restart',
    savedAt: '2024-11-14T22:13:20.000Z',
    playtimeSeconds: 900,
    buildCommit: 'old0001',
    buildVersion: '0.1.0',
    act: 'act1',
    checkpoint: 'act1_pump12_restart',
    sector: 'residential_edge',
    player: { x: 4, y: 1.5, z: 9, yaw: 0.75, health: 64 },
    missions: {
      activeMissionId: 'act1_high_water',
      activeObjectiveId: 'restart_pump_12',
      objectives: { reach_pump_12: 'complete', restart_pump_12: 'active' },
    },
    worldFlags: { crossed_service_bridge: true, rescued_resident_act1: true, dax_trust: 2 },
    dialogue: {
      seenNodes: ['prologue_depot:s1'],
      choices: [
        { sceneId: 'prologue_depot', nodeId: 's3_ask_ivo' },
        { sceneId: 'act1_pump12_priority', chosenNodeId: 's2_press' },
        { sceneId: 'broken_entry' },
      ],
    },
    evidence: ['manual_valve_log_12'],
    inventory: [{ id: 'relay_fuse', count: 1 }],
    upgrades: ['scan_range_1'],
    completedTutorials: ['tut_move', 'tut_interact'],
    tutorialResetVersion: 1,
    cinematics: { seenIds: ['cin_prologue_depot'], skippedIds: [] },
    // v1 had no `ending` section at all.
  };
}

afterEach(async () => {
  while (openStores.length > 0) {
    const store = openStores.pop();
    await store?.close();
  }
  vi.restoreAllMocks();
});

describe('save schema', () => {
  it('produces a new save that satisfies its own schema', () => {
    expect(saveSchema.safeParse(createNewSave()).success).toBe(true);
  });

  it('stamps a new save with the current schema version', () => {
    expect(createNewSave().schemaVersion).toBe(SAVE_SCHEMA_VERSION);
  });

  it('returns a fresh object each call so callers cannot share mutable state', () => {
    const a = createNewSave();
    const b = createNewSave();
    expect(a).not.toBe(b);
    a.worldFlags.pump12_restarted = true;
    a.tutorial.completedIds.push('tut_move');
    expect(b.worldFlags.pump12_restarted).toBeUndefined();
    expect(b.tutorial.completedIds).toEqual([]);
  });

  it('starts a new game in the prologue with full health and no progress', () => {
    const save = createNewSave();
    expect(save.progress.actId).toBe('prologue');
    expect(save.player.health).toBe(100);
    expect(save.evidenceIds).toEqual([]);
    expect(save.ending.choice).toBeNull();
    expect(save.tutorial.resetVersion).toBe(TUTORIAL_RESET_VERSION);
  });

  it('names every act', () => {
    for (const id of ACT_IDS) {
      expect(actTitle(id), id).toBe(ACT_TITLES[id]);
      expect(ACT_TITLES[id].length).toBeGreaterThan(0);
    }
  });

  it('lists narrative world flags without closing the flag map', () => {
    // The list documents what the campaign reads; the stored map stays open so
    // authored content can add a flag without a schema bump.
    expect(KNOWN_WORLD_FLAGS).toContain('rescued_resident_act1');
    expect(KNOWN_WORLD_FLAGS).toContain('clinic_power_stabilized');
    expect(KNOWN_WORLD_FLAGS).toContain('found_priority_policy');
    expect(KNOWN_WORLD_FLAGS).toContain('found_manual_valve_log');
    expect(KNOWN_WORLD_FLAGS).toContain('sera_optional_context_heard');
    expect(KNOWN_WORLD_FLAGS).toContain('ending_choice');

    const withUnlistedFlag = makeSave();
    withUnlistedFlag.worldFlags.some_future_content_flag = true;
    expect(saveSchema.safeParse(withUnlistedFlag).success).toBe(true);
  });

  it('accepts boolean, numeric and string world flags but not objects', () => {
    const save = makeSave();
    save.worldFlags = { a: true, b: 7, c: 'partial' };
    expect(saveSchema.safeParse(save).success).toBe(true);

    const bad = makeSave() as unknown as { worldFlags: Record<string, unknown> };
    bad.worldFlags = { a: { nested: true } };
    expect(saveSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown objective status', () => {
    const bad = makeSave();
    bad.missions.objectives.reach_underpass = 'halfway' as never;
    expect(saveSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects out-of-range health and a non-integer autosave index', () => {
    const overHealth = makeSave();
    overHealth.player.health = 120;
    expect(saveSchema.safeParse(overHealth).success).toBe(false);

    const badSlot = makeSave({ slot: { type: 'autosave', index: 1.5 } as SaveSlot });
    expect(saveSchema.safeParse(badSlot).success).toBe(false);
  });

  it('rejects an autosave index the store could never address', () => {
    const save = makeSave({ slot: { type: 'autosave', index: MAX_AUTOSAVE_SLOTS } });
    expect(saveSchema.safeParse(save).success).toBe(false);
    // The default ring is well inside the storable range, so raising the ring
    // size is a behaviour change rather than a validation failure.
    expect(AUTOSAVE_RING_SIZE).toBeLessThan(MAX_AUTOSAVE_SLOTS);
    const withinRing = makeSave({ slot: { type: 'autosave', index: AUTOSAVE_RING_SIZE } });
    expect(saveSchema.safeParse(withinRing).success).toBe(true);
  });

  it('rejects an unknown act', () => {
    const bad = makeSave() as unknown as { progress: { actId: string } };
    bad.progress.actId = 'act4';
    expect(saveSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an empty checkpoint reference', () => {
    const bad = makeSave();
    bad.progress.checkpointId = '';
    expect(saveSchema.safeParse(bad).success).toBe(false);
  });
});

describe('slot keys', () => {
  it('round-trips every slot type', () => {
    expect(slotKey({ type: 'autosave', index: 2 })).toBe('autosave:2');
    expect(slotKey({ type: 'checkpoint', checkpointId: 'act3_archive' })).toBe(
      'checkpoint:act3_archive',
    );
    expect(slotKey({ type: 'manual', index: 4, label: 'before the gate' })).toBe('manual:4');

    expect(parseSlotKey('autosave:2')).toEqual({ type: 'autosave', index: 2 });
    expect(parseSlotKey('checkpoint:act3_archive')).toEqual({
      type: 'checkpoint',
      checkpointId: 'act3_archive',
    });
    expect(parseSlotKey('manual:4')).toEqual({ type: 'manual', index: 4, label: '' });
  });

  it('returns null for keys it does not recognise', () => {
    expect(parseSlotKey('')).toBeNull();
    expect(parseSlotKey('autosave')).toBeNull();
    expect(parseSlotKey('autosave:')).toBeNull();
    expect(parseSlotKey('autosave:x')).toBeNull();
    expect(parseSlotKey('autosave:-1')).toBeNull();
    expect(parseSlotKey(':2')).toBeNull();
    expect(parseSlotKey('quicksave:1')).toBeNull();
  });

  it('keeps a checkpoint id containing a colon intact', () => {
    const slot: SaveSlot = { type: 'checkpoint', checkpointId: 'act3:tunnel:02' };
    expect(parseSlotKey(slotKey(slot))).toEqual(slot);
  });
});

describe('recordEndingChoice', () => {
  it('mirrors the canonical choice into the world flag dialogue conditions read', () => {
    const save = recordEndingChoice(makeSave(), 'withhold_resident_data');
    expect(save.ending.choice).toBe('withhold_resident_data');
    expect(save.worldFlags.ending_choice).toBe('withhold_resident_data');
    expect(saveSchema.safeParse(save).success).toBe(true);
  });

  it('does not mutate the input save', () => {
    const original = makeSave();
    recordEndingChoice(original, 'publish_now');
    expect(original.ending.choice).toBeNull();
    expect(original.worldFlags.ending_choice).toBeUndefined();
  });
});

describe('migrateSave', () => {
  it('returns a current save unchanged', () => {
    const save = makeSave();
    expect(migrateSave(structuredClone(save))).toEqual(save);
  });

  it('returns null for values that are not objects', () => {
    for (const value of [null, undefined, 42, 'save', true, []]) {
      expect(migrateSave(value), String(value)).toBeNull();
    }
  });

  it('rejects an object that carries no save identity instead of returning a new game', () => {
    // Merging garbage onto defaults would produce a valid-looking save and
    // present the player with a fresh prologue as if the load had worked.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const value of [
      {},
      { hello: 'world' },
      { schemaVersion: SAVE_SCHEMA_VERSION, junk: true },
      { nonsense: [1, 2, 3] },
      { slot: { type: 'autosave', index: 0 }, savedAt: 5 },
      { slot: { type: 'autosave', index: 0 }, progress: { checkpointId: 'x' } },
      {
        slot: { type: 'autosave', index: 0 },
        savedAt: 5,
        progress: { checkpointId: '   ' },
      },
    ]) {
      expect(migrateSave(value), JSON.stringify(value)).toBeNull();
    }
    expect(warn).toHaveBeenCalled();
  });

  it('fills missing sections from a new save instead of throwing', () => {
    const truncated = {
      schemaVersion: SAVE_SCHEMA_VERSION,
      slot: { type: 'autosave', index: 0 },
      savedAt: 5,
      progress: { actId: 'act1', checkpointId: 'act1_pump12_restart', sectorId: 'edge' },
    };
    const migrated = migrateSave(truncated);
    expect(migrated).not.toBeNull();
    expect(migrated!.progress.actId).toBe('act1');
    expect(migrated!.player.health).toBe(100);
    expect(migrated!.tutorial.resetVersion).toBe(TUTORIAL_RESET_VERSION);
    expect(migrated!.cinematics.seenIds).toEqual([]);
    expect(migrated!.ending.choice).toBeNull();
  });

  it('drops fields the current build no longer understands', () => {
    const withJunk = { ...structuredClone(makeSave()), retiredField: 'gone', anotherOne: 12 };
    const migrated = migrateSave(withJunk);
    expect(migrated).not.toBeNull();
    expect(migrated as unknown as Record<string, unknown>).not.toHaveProperty('retiredField');
    expect(saveSchema.safeParse(migrated).success).toBe(true);
  });

  it('preserves entries in open maps rather than filtering them against defaults', () => {
    // A key-filtered merge would silently wipe these, because a new save starts
    // them empty and nothing in a stored blob would match a "known" key.
    const migrated = migrateSave(structuredClone(makeSave()));
    expect(migrated!.worldFlags.dax_trust).toBe(3);
    expect(Object.keys(migrated!.missions.objectives)).toHaveLength(4);
    expect(migrated!.missions.objectives.keep_valve_dry).toBe('failed');
    expect(migrated!.dialogue.choices.act2_underpass_dax).toBe('s4_wait');
  });

  it('stamps the current version onto an older blob', () => {
    const migrated = migrateSave(makeV1Blob());
    expect(migrated).not.toBeNull();
    expect(migrated!.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
  });

  it('loads a v1 blob without throwing and relocates every moved field', () => {
    const migrated = migrateSave(makeV1Blob());
    expect(migrated).not.toBeNull();
    const save = migrated!;

    // Slot string -> discriminated slot.
    expect(save.slot).toEqual({ type: 'checkpoint', checkpointId: 'act1_pump12_restart' });
    // ISO timestamp -> epoch ms.
    expect(save.savedAt).toBe(Date.parse('2024-11-14T22:13:20.000Z'));
    // Top-level act/checkpoint/sector -> progress.
    expect(save.progress).toEqual({
      actId: 'act1',
      checkpointId: 'act1_pump12_restart',
      sectorId: 'residential_edge',
    });
    // Flat transform -> position vector, with yaw and health carried over.
    expect(save.player.position).toEqual({ x: 4, y: 1.5, z: 9 });
    expect(save.player.yaw).toBe(0.75);
    expect(save.player.health).toBe(64);
    // Root tutorial fields -> tutorial section.
    expect(save.tutorial.completedIds).toEqual(['tut_move', 'tut_interact']);
    expect(save.tutorial.resetVersion).toBe(1);
    // Choice pairs -> record, with the malformed pair skipped, not fatal.
    expect(save.dialogue.choices).toEqual({
      prologue_depot: 's3_ask_ivo',
      act1_pump12_priority: 's2_press',
    });
    expect(save.dialogue.choices.broken_entry).toBeUndefined();
    // Renamed collections.
    expect(save.dialogue.seenNodeIds).toEqual(['prologue_depot:s1']);
    expect(save.evidenceIds).toEqual(['manual_valve_log_12']);
    // A section v1 never had.
    expect(save.ending).toEqual({ choice: null, flags: {} });
    // And the result is a legal current save.
    expect(saveSchema.safeParse(save).success).toBe(true);
  });

  it('rejects a blob whose values are out of range instead of silently clamping', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = structuredClone(makeSave()) as unknown as Record<string, unknown>;
    (bad.player as Record<string, unknown>).health = -5;
    expect(migrateSave(bad)).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('rejects a v1 blob whose slot string is unrecognisable', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blob = makeV1Blob();
    blob.slot = 'quicksave';
    expect(migrateSave(blob)).toBeNull();
  });

  it('accepts a blob from a future version by dropping what it cannot use', () => {
    const future = {
      ...structuredClone(makeSave()),
      schemaVersion: SAVE_SCHEMA_VERSION + 5,
      photoMode: { rolls: 3 },
    };
    const migrated = migrateSave(future);
    expect(migrated).not.toBeNull();
    expect(migrated!.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(migrated!.progress.actId).toBe('act2');
  });
});

describe('SaveStore round trip', () => {
  it('saves and loads a slot with every field intact', async () => {
    const store = makeStore();
    const slot: SaveSlot = { type: 'checkpoint', checkpointId: 'act2_relay_annex_entry' };
    const save = makeSave({ slot });

    const result = await store.save(slot, save);
    expect(result.status).toBe('ok');
    expect(result).toMatchObject({ slotId: 'checkpoint:act2_relay_annex_entry', durable: true });

    const loaded = await store.load('checkpoint:act2_relay_annex_entry');
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') throw new Error('expected a clean load');
    expect(loaded.migrated).toBe(false);
    expect(loaded.save).toEqual(save);
  });

  it('persists across a fresh store instance on the same database', async () => {
    const databaseName = `tidelock-saves-persist-${Date.now()}`;
    const slot: SaveSlot = { type: 'manual', index: 1, label: 'before the gate' };

    const first = makeStore({ databaseName });
    await first.save(slot, makeSave({ slot }));
    await first.close();

    const second = makeStore({ databaseName });
    const loaded = await second.load('manual:1');
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') throw new Error('expected a clean load');
    expect(loaded.save.slot).toEqual(slot);
  });

  it('reports the slot it wrote through the saved event', async () => {
    const store = makeStore();
    const seen: string[] = [];
    store.on('saved', ({ slotId }) => seen.push(slotId));

    await store.autosave(makeSave());
    await store.save({ type: 'manual', index: 0, label: 'depot' }, makeSave());
    expect(seen).toEqual(['autosave:0', 'manual:0']);
  });

  it('refuses to write an invalid payload rather than storing a broken blob', async () => {
    const store = makeStore();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = makeSave();
    broken.player.health = 999;

    const result = await store.save({ type: 'autosave', index: 0 }, broken);
    expect(result.status).toBe('invalid');
    expect(error).toHaveBeenCalled();
    expect(await store.listSaves()).toEqual([]);
  });

  it('hands back a copy, so mutating a loaded save cannot corrupt the store', async () => {
    const store = makeStore();
    const slot: SaveSlot = { type: 'autosave', index: 0 };
    await store.save(slot, makeSave({ slot }));

    const first = await store.load('autosave:0');
    if (first.status !== 'ok') throw new Error('expected a clean load');
    first.save.player.health = 1;
    first.save.worldFlags.pump12_restarted = false;

    const second = await store.load('autosave:0');
    if (second.status !== 'ok') throw new Error('expected a clean load');
    expect(second.save.player.health).toBe(82);
    expect(second.save.worldFlags.pump12_restarted).toBe(true);
  });

  it('stamps savedAt from the clock when the caller left it unset', async () => {
    const store = makeStore({ now: () => 999_000 });
    const save = makeSave({ savedAt: 0 });
    const result = await store.save({ type: 'autosave', index: 0 }, save);
    expect(result).toMatchObject({ status: 'ok', savedAt: 999_000 });
  });

  it('reports an empty result for a slot that was never written', async () => {
    const store = makeStore();
    expect(await store.load('manual:7')).toEqual({ status: 'empty' });
    expect(await store.loadMostRecent()).toEqual({ status: 'empty' });
  });
});

describe('listSaves metadata', () => {
  it('returns menu metadata newest first', async () => {
    const store = makeStore();
    const checkpointSlot: SaveSlot = { type: 'checkpoint', checkpointId: 'act2_relay_annex_entry' };
    const manualSlot: SaveSlot = { type: 'manual', index: 2, label: 'before the tunnel' };

    await store.save(
      checkpointSlot,
      makeSave({ slot: checkpointSlot, savedAt: 1000, playtimeSeconds: 600 }),
    );
    await store.save(
      manualSlot,
      makeSave({
        slot: manualSlot,
        savedAt: 5000,
        playtimeSeconds: 3600,
        buildCommit: 'deadbee',
        buildVersion: '0.5.0',
        progress: { actId: 'act3', checkpointId: 'act3_flooded_tunnel', sectorId: 'tunnel_west' },
      }),
    );

    const list = await store.listSaves();
    expect(list.map((entry) => entry.slotId)).toEqual([
      'manual:2',
      'checkpoint:act2_relay_annex_entry',
    ]);

    expect(list[0]).toEqual({
      slotId: 'manual:2',
      slotType: 'manual',
      savedAt: 5000,
      valid: true,
      actId: 'act3',
      actName: 'Thirty-Seven Minutes',
      checkpointId: 'act3_flooded_tunnel',
      playtimeSeconds: 3600,
      buildCommit: 'deadbee',
      buildVersion: '0.5.0',
      label: 'before the tunnel',
    });

    expect(list[1]).toMatchObject({
      slotType: 'checkpoint',
      actId: 'act2',
      actName: 'The Quiet Floor',
      playtimeSeconds: 600,
      label: null,
    });
  });

  it('lists a damaged save as invalid instead of hiding it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeStore();
    await store.save({ type: 'autosave', index: 0 }, makeSave());
    await corrupt(store, 'autosave:0', { schemaVersion: SAVE_SCHEMA_VERSION, junk: true });

    const list = await store.listSaves();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      slotId: 'autosave:0',
      valid: false,
      actId: null,
      actName: null,
      playtimeSeconds: null,
    });
  });
});

describe('loadMostRecent', () => {
  it('picks the newest save regardless of slot type', async () => {
    const store = makeStore();
    const older: SaveSlot = { type: 'checkpoint', checkpointId: 'act1_pump12_restart' };
    const newest: SaveSlot = { type: 'autosave', index: 1 };

    await store.save(older, makeSave({ slot: older, savedAt: 2000 }));
    await store.save(
      newest,
      makeSave({
        slot: newest,
        savedAt: 9000,
        progress: { actId: 'finale', checkpointId: 'finale_gate_control', sectorId: 'barrier' },
      }),
    );
    await store.save(
      { type: 'manual', index: 0, label: 'mid' },
      makeSave({ slot: { type: 'manual', index: 0, label: 'mid' }, savedAt: 4000 }),
    );

    const loaded = await store.loadMostRecent();
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') throw new Error('expected a clean load');
    expect(loaded.slotId).toBe('autosave:1');
    expect(loaded.save.progress.actId).toBe('finale');
  });

  it('reports a migration when the newest save came from an older build', async () => {
    const store = makeStore();
    await seedRaw(store, 'checkpoint:act1_pump12_restart', 'checkpoint', 100, makeV1Blob());

    const loaded = await store.loadMostRecent();
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') throw new Error('expected a clean load');
    expect(loaded.migrated).toBe(true);
    expect(loaded.save.progress.actId).toBe('act1');
  });

  it('skips a damaged newest save and offers the one behind it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeStore();
    await store.save(
      { type: 'autosave', index: 0 },
      makeSave({ slot: { type: 'autosave', index: 0 }, savedAt: 1000 }),
    );
    await store.save(
      { type: 'autosave', index: 1 },
      makeSave({ slot: { type: 'autosave', index: 1 }, savedAt: 2000 }),
    );
    await corrupt(store, 'autosave:1', { garbage: true }, 2000);

    const loaded = await store.loadMostRecent();
    expect(loaded.status).toBe('recovered');
    if (loaded.status !== 'recovered') throw new Error('expected a recovery');
    expect(loaded.failedSlotId).toBe('autosave:1');
    expect(loaded.slotId).toBe('autosave:0');
    expect(loaded.save.savedAt).toBe(1000);
    expect(loaded.backupId).not.toBeNull();
  });
});

describe('corruption recovery', () => {
  it('preserves a damaged row as a backup and offers the previous autosave', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeStore({ now: () => 4242 });
    const recovered: string[] = [];
    store.on('recovered', ({ failedSlotId, recoveredSlotId }) =>
      recovered.push(`${failedSlotId}->${recoveredSlotId}`),
    );

    await store.save(
      { type: 'autosave', index: 0 },
      makeSave({ slot: { type: 'autosave', index: 0 }, savedAt: 1000 }),
    );
    const target: SaveSlot = { type: 'checkpoint', checkpointId: 'act3_flooded_tunnel' };
    await store.save(target, makeSave({ slot: target, savedAt: 3000 }));
    await corrupt(store, 'checkpoint:act3_flooded_tunnel', { nonsense: [1, 2, 3] }, 3000);

    const result = await store.load('checkpoint:act3_flooded_tunnel');
    expect(result.status).toBe('recovered');
    if (result.status !== 'recovered') throw new Error('expected a recovery');
    expect(result.reason).toBe('schema');
    expect(result.failedSlotId).toBe('checkpoint:act3_flooded_tunnel');
    expect(result.slotId).toBe('autosave:0');
    expect(result.save.savedAt).toBe(1000);
    expect(recovered).toEqual(['checkpoint:act3_flooded_tunnel->autosave:0']);

    // The original was copied, not destroyed.
    const backups = await store.listBackups();
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({
      slotId: 'checkpoint:act3_flooded_tunnel',
      reason: 'corrupt',
      createdAt: 4242,
    });
    expect(await store.readBackup(backups[0]!.id)).toEqual({ nonsense: [1, 2, 3] });
  });

  it('leaves the damaged row in place so nothing is destroyed to recover', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeStore();
    await store.save({ type: 'autosave', index: 0 }, makeSave());
    await store.save(
      { type: 'autosave', index: 1 },
      makeSave({ slot: { type: 'autosave', index: 1 }, savedAt: 3000 }),
    );
    await corrupt(store, 'autosave:1', { broken: true }, 3000);

    await store.load('autosave:1');

    const list = await store.listSaves();
    expect(list.map((entry) => entry.slotId).sort()).toEqual(['autosave:0', 'autosave:1']);
    expect(list.find((entry) => entry.slotId === 'autosave:1')!.valid).toBe(false);
  });

  it('reports corruption when there is nothing to fall back to', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeStore();
    const corrupted: unknown[] = [];
    store.on('corrupted', (payload) => corrupted.push(payload));

    await store.save({ type: 'autosave', index: 0 }, makeSave());
    await corrupt(store, 'autosave:0', 'not even an object');

    const result = await store.load('autosave:0');
    expect(result.status).toBe('corrupt');
    if (result.status !== 'corrupt') throw new Error('expected corruption');
    expect(result.reason).toBe('unreadable');
    expect(result.backupId).not.toBeNull();
    expect(corrupted).toHaveLength(1);

    // Still preserved, and still listed.
    expect(await store.listBackups()).toHaveLength(1);
    expect(await store.listSaves()).toHaveLength(1);
  });

  it('treats a checkpoint the build no longer knows as damage, not as a spawn at the origin', async () => {
    const store = makeStore({
      checkpointResolver: (checkpointId) => checkpointId !== 'act2_cut_checkpoint',
    });

    const stale: SaveSlot = { type: 'checkpoint', checkpointId: 'act2_cut_checkpoint' };
    await store.save(
      stale,
      makeSave({
        slot: stale,
        savedAt: 6000,
        progress: {
          actId: 'act2',
          checkpointId: 'act2_cut_checkpoint',
          sectorId: 'relay_annex_lower',
        },
      }),
    );
    await store.save(
      { type: 'autosave', index: 0 },
      makeSave({ slot: { type: 'autosave', index: 0 }, savedAt: 1000 }),
    );

    const result = await store.load('checkpoint:act2_cut_checkpoint');
    expect(result.status).toBe('recovered');
    if (result.status !== 'recovered') throw new Error('expected a recovery');
    expect(result.reason).toBe('checkpoint');
    expect(result.slotId).toBe('autosave:0');
  });

  it('detects a row whose payload belongs to a different slot', async () => {
    const store = makeStore();
    const foreign = makeSave({ slot: { type: 'manual', index: 3, label: 'elsewhere' } });
    await seedRaw(store, 'autosave:0', 'autosave', foreign.savedAt, foreign);

    const result = await store.load('autosave:0');
    expect(result.status).toBe('corrupt');
    if (result.status !== 'corrupt') throw new Error('expected corruption');
    expect(result.reason).toBe('slot-mismatch');
  });

  it('backs up the only existing save before overwriting it', async () => {
    const store = makeStore();
    const slot: SaveSlot = { type: 'autosave', index: 0 };
    await store.save(slot, makeSave({ slot, savedAt: 1000, playtimeSeconds: 10 }));
    await store.save(slot, makeSave({ slot, savedAt: 2000, playtimeSeconds: 20 }));

    const backups = await store.listBackups();
    expect(backups).toHaveLength(1);
    expect(backups[0]!.reason).toBe('overwrite-guard');
    const preserved = (await store.readBackup(backups[0]!.id)) as Save;
    expect(preserved.playtimeSeconds).toBe(10);

    // Once more than one save exists, the guard stops firing — the ring covers it.
    await store.save(
      { type: 'autosave', index: 1 },
      makeSave({ slot: { type: 'autosave', index: 1 }, savedAt: 3000 }),
    );
    await store.save(slot, makeSave({ slot, savedAt: 4000 }));
    expect(await store.listBackups()).toHaveLength(1);
  });
});

describe('autosave ring', () => {
  it('fills unused slots before replacing anything', async () => {
    const store = makeStore();
    for (let i = 0; i < AUTOSAVE_RING_SIZE; i += 1) {
      const result = await store.autosave(makeSave({ savedAt: 1000 + i }));
      expect(result).toMatchObject({ status: 'ok', slotId: `autosave:${i}` });
    }
  });

  it('keeps the last N autosaves and evicts the oldest', async () => {
    const ringSize = 3;
    const store = makeStore({ autosaveRingSize: ringSize });

    for (let i = 0; i < ringSize + 2; i += 1) {
      await store.autosave(makeSave({ savedAt: 1000 + i * 10, playtimeSeconds: i }));
    }

    const list = await store.listSaves();
    expect(list).toHaveLength(ringSize);
    // The two oldest writes are gone; the newest three remain, newest first.
    expect(list.map((entry) => entry.playtimeSeconds)).toEqual([4, 3, 2]);
    expect(list.map((entry) => entry.slotId).sort()).toEqual([
      'autosave:0',
      'autosave:1',
      'autosave:2',
    ]);
  });

  it('wraps to the oldest slot rather than always overwriting index 0', async () => {
    const store = makeStore({ autosaveRingSize: 3 });
    for (let i = 0; i < 3; i += 1) await store.autosave(makeSave({ savedAt: 1000 + i * 10 }));

    const fourth = await store.autosave(makeSave({ savedAt: 2000 }));
    expect(fourth).toMatchObject({ slotId: 'autosave:0' });
    const fifth = await store.autosave(makeSave({ savedAt: 2010 }));
    expect(fifth).toMatchObject({ slotId: 'autosave:1' });
  });

  it('leaves checkpoint and manual slots untouched', async () => {
    const store = makeStore({ autosaveRingSize: 2 });
    const checkpointSlot: SaveSlot = { type: 'checkpoint', checkpointId: 'act1_pump12_restart' };
    await store.save(checkpointSlot, makeSave({ slot: checkpointSlot, savedAt: 500 }));

    for (let i = 0; i < 6; i += 1) await store.autosave(makeSave({ savedAt: 1000 + i }));

    const list = await store.listSaves();
    expect(list.filter((entry) => entry.slotType === 'autosave')).toHaveLength(2);
    expect(list.some((entry) => entry.slotId === 'checkpoint:act1_pump12_restart')).toBe(true);
  });

  it('clamps a ring size larger than the store can address', async () => {
    const store = makeStore({ autosaveRingSize: 99 });
    expect(store.autosaveRingSize).toBe(MAX_AUTOSAVE_SLOTS);
    // Every write still lands in a storable slot rather than failing validation.
    for (let i = 0; i < MAX_AUTOSAVE_SLOTS + 2; i += 1) {
      const result = await store.autosave(makeSave({ savedAt: 1000 + i }));
      expect(result.status, `write ${i}`).toBe('ok');
    }
    expect(await store.listSaves()).toHaveLength(MAX_AUTOSAVE_SLOTS);
  });

  it('prunes autosave slots left over from a larger ring', async () => {
    const databaseName = `tidelock-saves-ring-${Date.now()}`;
    const wide = makeStore({ databaseName, autosaveRingSize: 3 });
    for (let i = 0; i < 3; i += 1) await wide.autosave(makeSave({ savedAt: 1000 + i }));
    expect(await wide.listSaves()).toHaveLength(3);
    await wide.close();

    const narrow = makeStore({ databaseName, autosaveRingSize: 2 });
    await narrow.autosave(makeSave({ savedAt: 5000 }));
    const list = await narrow.listSaves();
    expect(list.map((entry) => entry.slotId).sort()).toEqual(['autosave:0', 'autosave:1']);
  });
});

describe('delete and clear', () => {
  it('deletes a single slot and reports whether anything was removed', async () => {
    const store = makeStore();
    const deleted: string[] = [];
    store.on('deleted', ({ slotId }) => deleted.push(slotId));

    await store.autosave(makeSave());
    expect(await store.deleteSlot('autosave:0')).toBe(true);
    expect(await store.deleteSlot('autosave:0')).toBe(false);
    expect(deleted).toEqual(['autosave:0']);
    expect(await store.listSaves()).toEqual([]);
  });

  it('clears every save and every preserved backup', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeStore();
    const cleared: unknown[] = [];
    store.on('cleared', (payload) => cleared.push(payload));

    await store.autosave(makeSave());
    await store.save(
      { type: 'manual', index: 0, label: 'depot' },
      makeSave({ slot: { type: 'manual', index: 0, label: 'depot' } }),
    );
    await corrupt(store, 'autosave:0', { broken: true });
    await store.load('autosave:0');
    expect((await store.listBackups()).length).toBeGreaterThan(0);

    const counts = await store.clearAll();
    expect(counts.saves).toBe(2);
    expect(counts.backups).toBeGreaterThan(0);
    expect(cleared).toEqual([counts]);
    expect(await store.listSaves()).toEqual([]);
    expect(await store.listBackups()).toEqual([]);
    expect(await store.loadMostRecent()).toEqual({ status: 'empty' });
  });
});

describe('export and import', () => {
  it('round-trips a single slot through JSON', async () => {
    const store = makeStore({ now: () => 7777 });
    const slot: SaveSlot = { type: 'checkpoint', checkpointId: 'act3_flooded_tunnel' };
    const save = makeSave({ slot });
    await store.save(slot, save);

    const json = await store.exportJson('checkpoint:act3_flooded_tunnel');
    const bundle = JSON.parse(json);
    expect(bundle).toMatchObject({
      kind: 'tidelock-save-export',
      formatVersion: 1,
      exportedAt: 7777,
      schemaVersion: SAVE_SCHEMA_VERSION,
      damagedSlotIds: [],
    });
    expect(bundle.saves).toHaveLength(1);

    await store.clearAll();
    expect(await store.listSaves()).toEqual([]);

    const imported = await store.importJson(json);
    expect(imported).toEqual({
      status: 'ok',
      imported: 1,
      slotIds: ['checkpoint:act3_flooded_tunnel'],
    });

    const loaded = await store.load('checkpoint:act3_flooded_tunnel');
    if (loaded.status !== 'ok') throw new Error('expected a clean load');
    expect(loaded.save).toEqual(save);
  });

  it('exports every readable save when no slot is given', async () => {
    const store = makeStore();
    await store.autosave(makeSave({ savedAt: 1000 }));
    await store.save(
      { type: 'manual', index: 0, label: 'depot' },
      makeSave({ slot: { type: 'manual', index: 0, label: 'depot' }, savedAt: 2000 }),
    );

    const bundle = JSON.parse(await store.exportJson());
    expect(bundle.saves).toHaveLength(2);
    expect(bundle.saves.map((save: Save) => slotKey(save.slot)).sort()).toEqual([
      'autosave:0',
      'manual:0',
    ]);
  });

  it('names slots it could not serialise instead of quietly omitting them', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeStore();
    await store.autosave(makeSave({ savedAt: 1000 }));
    await store.save(
      { type: 'manual', index: 0, label: 'depot' },
      makeSave({ slot: { type: 'manual', index: 0, label: 'depot' }, savedAt: 2000 }),
    );
    await corrupt(store, 'autosave:0', { broken: true }, 1000);

    const bundle = JSON.parse(await store.exportJson());
    expect(bundle.saves).toHaveLength(1);
    expect(bundle.damagedSlotIds).toEqual(['autosave:0']);
  });

  it('accepts a bare save object as well as a bundle', async () => {
    const store = makeStore();
    const slot: SaveSlot = { type: 'manual', index: 2, label: 'quay' };
    const result = await store.importJson(JSON.stringify(makeSave({ slot })));
    expect(result).toMatchObject({ status: 'ok', imported: 1, slotIds: ['manual:2'] });
  });

  it('retargets an import into an explicit slot', async () => {
    const store = makeStore();
    const source = makeSave({ slot: { type: 'checkpoint', checkpointId: 'act1_pump12_restart' } });
    const target: SaveSlot = { type: 'manual', index: 5, label: 'imported' };

    const result = await store.importJson(JSON.stringify(source), target);
    expect(result).toMatchObject({ status: 'ok', slotIds: ['manual:5'] });

    const loaded = await store.load('manual:5');
    if (loaded.status !== 'ok') throw new Error('expected a clean load');
    expect(loaded.save.slot).toEqual(target);
    expect(loaded.save.progress.checkpointId).toBe('act2_relay_annex_entry');
  });

  it('migrates an old save on import', async () => {
    const store = makeStore();
    const result = await store.importJson(JSON.stringify(makeV1Blob()));
    expect(result).toMatchObject({ status: 'ok', slotIds: ['checkpoint:act1_pump12_restart'] });

    const loaded = await store.load('checkpoint:act1_pump12_restart');
    if (loaded.status !== 'ok') throw new Error('expected a clean load');
    expect(loaded.save.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(loaded.save.player.position).toEqual({ x: 4, y: 1.5, z: 9 });
  });

  it('preserves the row an import replaces', async () => {
    const store = makeStore();
    const slot: SaveSlot = { type: 'manual', index: 0, label: 'depot' };
    await store.save(slot, makeSave({ slot, playtimeSeconds: 11 }));

    await store.importJson(JSON.stringify(makeSave({ slot, playtimeSeconds: 99 })));

    const backups = await store.listBackups();
    expect(backups.some((backup) => backup.reason === 'import')).toBe(true);
    const preserved = backups.find((backup) => backup.reason === 'import')!;
    expect((await store.readBackup(preserved.id) as Save).playtimeSeconds).toBe(11);
  });

  it('rejects text that is not JSON', async () => {
    const store = makeStore();
    const result = await store.importJson('{ this is not json');
    expect(result.status).toBe('invalid-json');
    if (result.status !== 'invalid-json') throw new Error('expected invalid-json');
    expect(result.message.length).toBeGreaterThan(0);
    expect(await store.listSaves()).toEqual([]);
  });

  it('rejects JSON that is not a save', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeStore();

    expect((await store.importJson('[1,2,3]')).status).toBe('invalid-save');
    expect((await store.importJson('"a string"')).status).toBe('invalid-save');
    expect((await store.importJson('{"hello":"world"}')).status).toBe('invalid-save');
    expect(
      (await store.importJson('{"kind":"tidelock-save-export","formatVersion":1}')).status,
    ).toBe('invalid-save');
    expect(
      (await store.importJson('{"kind":"tidelock-save-export","saves":[]}')).status,
    ).toBe('invalid-save');
    expect(await store.listSaves()).toEqual([]);
  });

  it('rejects a save whose values are out of range', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeStore();
    const broken = makeSave();
    broken.player.health = -1;

    const result = await store.importJson(JSON.stringify(broken));
    expect(result.status).toBe('invalid-save');
    expect(await store.listSaves()).toEqual([]);
  });

  it('refuses to squeeze a multi-save bundle into one slot', async () => {
    const store = makeStore();
    await store.autosave(makeSave({ savedAt: 1000 }));
    await store.save(
      { type: 'manual', index: 0, label: 'depot' },
      makeSave({ slot: { type: 'manual', index: 0, label: 'depot' }, savedAt: 2000 }),
    );
    const json = await store.exportJson();

    const result = await store.importJson(json, { type: 'manual', index: 9, label: 'x' });
    expect(result.status).toBe('invalid-save');
  });
});

describe('graceful degradation without IndexedDB', () => {
  it('reports the loss of durability, stays playable, and does not crash', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeStore({ indexedDb: null });
    const degraded: string[] = [];
    store.on('degraded', ({ reason }) => degraded.push(reason));

    expect(store.durable).toBeNull(); // Unknown until the first open attempt.
    expect(await store.open()).toBe(false);
    expect(store.durable).toBe(false);
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toMatch(/IndexedDB/);
    expect(warn).toHaveBeenCalled();

    // Everything still works for the length of the session.
    const slot: SaveSlot = { type: 'checkpoint', checkpointId: 'act1_pump12_restart' };
    const result = await store.save(slot, makeSave({ slot }));
    expect(result).toMatchObject({ status: 'ok', durable: false });

    const loaded = await store.load('checkpoint:act1_pump12_restart');
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') throw new Error('expected a clean load');
    expect(loaded.save.progress.actId).toBe('act2');

    await store.autosave(makeSave({ savedAt: 8000 }));
    expect((await store.listSaves()).length).toBe(2);
    expect((await store.loadMostRecent()).status).toBe('ok');
    expect(await store.deleteSlot('autosave:0')).toBe(true);
    await store.clearAll();
    expect(await store.listSaves()).toEqual([]);
  });

  it('still preserves damaged rows in memory so recovery behaves the same', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeStore({ indexedDb: null });
    await store.autosave(makeSave({ savedAt: 1000 }));
    await store.autosave(makeSave({ savedAt: 2000 }));
    await corrupt(store, 'autosave:1', { broken: true }, 2000);

    const result = await store.load('autosave:1');
    expect(result.status).toBe('recovered');
    expect(await store.listBackups()).toHaveLength(1);
  });

  it('falls back when opening the database throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exploding = {
      open() {
        throw new Error('user denied storage');
      },
    } as unknown as IDBFactory;

    const store = makeStore({ indexedDb: exploding });
    expect(await store.open()).toBe(false);
    expect(warn).toHaveBeenCalled();

    const result = await store.autosave(makeSave());
    expect(result).toMatchObject({ status: 'ok', durable: false });
  });
});

/**
 * Replaces a stored payload with garbage, simulating an interrupted write or a
 * partially evicted object store.
 *
 * Writes through Dexie directly rather than through SaveStore, because
 * SaveStore correctly refuses to persist an invalid save — the whole point of
 * the recovery path is handling rows it did not write.
 */
async function corrupt(
  store: SaveStore,
  slotId: string,
  payload: unknown,
  savedAt?: number,
): Promise<void> {
  const parsed = parseSlotKey(slotId);
  if (!parsed) throw new Error(`test wrote an unparseable slot id: ${slotId}`);
  const existing = await store.listSaves();
  const previous = existing.find((entry) => entry.slotId === slotId);
  await seedRaw(store, slotId, parsed.type, savedAt ?? previous?.savedAt ?? 0, payload);
}

/**
 * Writes a raw row straight into the backing store, bypassing validation.
 *
 * Reaches through `exportJson`-adjacent internals deliberately: there is no
 * public API for writing an invalid row, and there should not be.
 */
async function seedRaw(
  store: SaveStore,
  slotId: string,
  slotType: string,
  savedAt: number,
  data: unknown,
): Promise<void> {
  const backend = await (
    store as unknown as {
      ensureBackend(): Promise<{
        put(row: { slotId: string; slotType: string; savedAt: number; data: unknown }): Promise<void>;
      }>;
    }
  ).ensureBackend();
  await backend.put({ slotId, slotType, savedAt, data });
}
