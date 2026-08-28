/**
 * Campaign save persistence.
 *
 * IndexedDB via Dexie, deliberately separate from settings: settings are small
 * and must be readable synchronously during boot, saves are larger and only the
 * game session needs them.
 *
 * The design assumption is that a save will eventually be damaged — a write
 * interrupted by a backgrounded tab, a browser that evicted part of the object
 * store, a build that changed a shape without a migration. So:
 *
 * - A damaged row is copied into a `backups` table and LEFT IN PLACE. Nothing
 *   here deletes a player's only save to recover from a read failure.
 * - Autosaves are a rolling ring rather than one overwritable slot, so a single
 *   bad write cannot take the campaign with it.
 * - Every load runs parse -> validate -> migrate -> verify the checkpoint
 *   reference. A save that points at a checkpoint the build no longer knows is
 *   treated as damaged, not as a spawn at the world origin.
 * - When IndexedDB is unavailable (private browsing, locked-down webview) the
 *   store falls back to an in-memory backend and reports it. The game stays
 *   playable; it just will not survive a reload.
 */

import Dexie, { type DexieOptions, type Table } from 'dexie';
import { Emitter } from '../engine/events';
import {
  AUTOSAVE_RING_SIZE,
  MAX_AUTOSAVE_SLOTS,
  SAVE_SCHEMA_VERSION,
  actTitle,
  migrateSave,
  parseSlotKey,
  saveSchema,
  slotKey,
  type ActId,
  type Save,
  type SaveSlot,
  type SaveSlotType,
} from './saveSchema';

const DATABASE_NAME = 'tidelock-saves';

/** Why a row was copied into the backup table. */
export type BackupReason = 'corrupt' | 'overwrite-guard' | 'import';

interface SaveRow {
  /** `slotKey(slot)`. Primary key. */
  slotId: string;
  /** Indexed so the autosave ring can be queried without scanning every row. */
  slotType: SaveSlotType;
  /** Indexed so the load menu and Continue can read in savedAt order. */
  savedAt: number;
  /** Raw, unvalidated save payload. Validated on read, never trusted. */
  data: unknown;
}

interface BackupRow {
  id?: number;
  slotId: string;
  createdAt: number;
  reason: BackupReason;
  /** The original payload exactly as it was stored. */
  raw: unknown;
}

class SaveDatabase extends Dexie {
  declare saves: Table<SaveRow, string>;
  declare backups: Table<BackupRow, number>;

  constructor(name: string, options?: DexieOptions) {
    super(name, options);
    this.version(1).stores({
      saves: '&slotId, slotType, savedAt',
      backups: '++id, slotId, createdAt',
    });
  }
}

/**
 * Answers "does this checkpoint still exist in this build?".
 *
 * Injected rather than imported so persistence stays independent of mission
 * content. The default only requires a non-empty id; the game passes a resolver
 * backed by the loaded mission data.
 */
export type CheckpointResolver = (checkpointId: string, actId: ActId) => boolean;

const defaultCheckpointResolver: CheckpointResolver = (checkpointId) =>
  checkpointId.trim().length > 0;

export interface SaveStoreOptions {
  databaseName?: string;
  autosaveRingSize?: number;
  /**
   * IndexedDB factory. Pass `null` to simulate an environment without
   * IndexedDB (private browsing) and exercise the in-memory fallback.
   * Defaults to `globalThis.indexedDB`.
   */
  indexedDb?: IDBFactory | null;
  idbKeyRange?: typeof IDBKeyRange;
  checkpointResolver?: CheckpointResolver;
  /** Injectable clock so tests do not depend on wall time. */
  now?: () => number;
}

/** Reason a row failed validation, surfaced for diagnostics and bug reports. */
export type CorruptionReason = 'unreadable' | 'schema' | 'checkpoint' | 'slot-mismatch';

export type SaveResult =
  | { status: 'ok'; slotId: string; savedAt: number; durable: boolean }
  | { status: 'invalid'; message: string }
  | { status: 'error'; message: string };

export type LoadResult =
  /** Loaded cleanly. `migrated` is true when an older schema was upgraded. */
  | { status: 'ok'; save: Save; slotId: string; migrated: boolean }
  /**
   * The requested save was damaged. The original is preserved as backup
   * `backupId` and an earlier save is offered instead.
   */
  | {
      status: 'recovered';
      save: Save;
      slotId: string;
      failedSlotId: string;
      backupId: number | null;
      reason: CorruptionReason;
    }
  /** Damaged with nothing to fall back to. The original is still preserved. */
  | { status: 'corrupt'; failedSlotId: string; backupId: number | null; reason: CorruptionReason }
  | { status: 'empty' };

export interface SaveMetadata {
  slotId: string;
  slotType: SaveSlotType;
  savedAt: number;
  /** False for rows that fail validation. The menu shows them as damaged. */
  valid: boolean;
  actId: ActId | null;
  /** Display name for the act, derived from `actId`. Null when unreadable. */
  actName: string | null;
  checkpointId: string | null;
  playtimeSeconds: number | null;
  buildCommit: string | null;
  buildVersion: string | null;
  /** Player-supplied name for manual slots. */
  label: string | null;
}

export interface BackupMetadata {
  id: number;
  slotId: string;
  createdAt: number;
  reason: BackupReason;
}

export const SAVE_EXPORT_KIND = 'tidelock-save-export';
export const SAVE_EXPORT_FORMAT_VERSION = 1;

export interface SaveExportBundle {
  kind: typeof SAVE_EXPORT_KIND;
  formatVersion: number;
  exportedAt: number;
  schemaVersion: number;
  saves: Save[];
  /** Slots that exist but could not be serialised, so the export is honest. */
  damagedSlotIds: string[];
}

export type ImportResult =
  | { status: 'ok'; imported: number; slotIds: string[] }
  | { status: 'invalid-json'; message: string }
  | { status: 'invalid-save'; message: string };

/**
 * Declared as a type alias, not an interface: TypeScript only infers an
 * implicit index signature for aliases, which the `EventMap` constraint needs.
 */
type SaveStoreEvents = {
  saved: { slotId: string; slot: SaveSlot; savedAt: number; durable: boolean };
  deleted: { slotId: string };
  cleared: { saves: number; backups: number };
  /** A damaged row was preserved and an earlier save substituted. */
  recovered: { failedSlotId: string; recoveredSlotId: string; reason: CorruptionReason };
  /** A damaged row was preserved and nothing could replace it. */
  corrupted: { slotId: string; backupId: number | null; reason: CorruptionReason };
  /** Persistence is not durable this session. */
  degraded: { reason: string };
};

/** Storage operations SaveStore needs, so the fallback is not a special case. */
interface SaveBackend {
  readonly durable: boolean;
  get(slotId: string): Promise<SaveRow | undefined>;
  put(row: SaveRow): Promise<void>;
  /** Newest first. */
  allByRecency(): Promise<SaveRow[]>;
  byType(slotType: SaveSlotType): Promise<SaveRow[]>;
  count(): Promise<number>;
  delete(slotId: string): Promise<boolean>;
  clear(): Promise<{ saves: number; backups: number }>;
  putBackup(row: BackupRow): Promise<number | null>;
  allBackups(): Promise<BackupRow[]>;
  close(): Promise<void>;
}

class DexieBackend implements SaveBackend {
  readonly durable = true;

  constructor(private readonly db: SaveDatabase) {}

  async get(slotId: string): Promise<SaveRow | undefined> {
    return this.db.saves.get(slotId);
  }

  async put(row: SaveRow): Promise<void> {
    await this.db.saves.put(row);
  }

  async allByRecency(): Promise<SaveRow[]> {
    return this.db.saves.orderBy('savedAt').reverse().toArray();
  }

  async byType(slotType: SaveSlotType): Promise<SaveRow[]> {
    return this.db.saves.where('slotType').equals(slotType).toArray();
  }

  async count(): Promise<number> {
    return this.db.saves.count();
  }

  async delete(slotId: string): Promise<boolean> {
    const existing = await this.db.saves.get(slotId);
    if (!existing) return false;
    await this.db.saves.delete(slotId);
    return true;
  }

  async clear(): Promise<{ saves: number; backups: number }> {
    const saves = await this.db.saves.count();
    const backups = await this.db.backups.count();
    await this.db.saves.clear();
    await this.db.backups.clear();
    return { saves, backups };
  }

  async putBackup(row: BackupRow): Promise<number | null> {
    return this.db.backups.add(row);
  }

  async allBackups(): Promise<BackupRow[]> {
    return this.db.backups.orderBy('createdAt').reverse().toArray();
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/**
 * Fallback used when IndexedDB is unavailable.
 *
 * Keeps the session playable — checkpoints still work, the load menu still
 * lists them — but nothing survives a reload, and `durable` says so.
 */
class MemoryBackend implements SaveBackend {
  readonly durable = false;
  private readonly rows = new Map<string, SaveRow>();
  private readonly backups: BackupRow[] = [];
  private nextBackupId = 1;

  async get(slotId: string): Promise<SaveRow | undefined> {
    return this.rows.get(slotId);
  }

  async put(row: SaveRow): Promise<void> {
    this.rows.set(row.slotId, row);
  }

  async allByRecency(): Promise<SaveRow[]> {
    return [...this.rows.values()].sort((a, b) => b.savedAt - a.savedAt);
  }

  async byType(slotType: SaveSlotType): Promise<SaveRow[]> {
    return [...this.rows.values()].filter((row) => row.slotType === slotType);
  }

  async count(): Promise<number> {
    return this.rows.size;
  }

  async delete(slotId: string): Promise<boolean> {
    return this.rows.delete(slotId);
  }

  async clear(): Promise<{ saves: number; backups: number }> {
    const counts = { saves: this.rows.size, backups: this.backups.length };
    this.rows.clear();
    this.backups.length = 0;
    return counts;
  }

  async putBackup(row: BackupRow): Promise<number | null> {
    const id = this.nextBackupId++;
    this.backups.push({ ...row, id });
    return id;
  }

  async allBackups(): Promise<BackupRow[]> {
    return [...this.backups].sort((a, b) => b.createdAt - a.createdAt);
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}

type Validated =
  | { ok: true; save: Save; migrated: boolean }
  | { ok: false; reason: CorruptionReason };

export class SaveStore {
  private readonly emitter = new Emitter<SaveStoreEvents>();
  private readonly databaseName: string;
  private readonly ringSize: number;
  private readonly checkpointResolver: CheckpointResolver;
  private readonly now: () => number;
  private readonly options: SaveStoreOptions;
  private backend: SaveBackend | null = null;
  private opening: Promise<SaveBackend> | null = null;

  constructor(options: SaveStoreOptions = {}) {
    this.options = options;
    this.databaseName = options.databaseName ?? DATABASE_NAME;
    // Clamped to what the schema can store, so a misconfigured ring size
    // degrades to fewer autosaves rather than to writes that fail validation.
    this.ringSize = Math.min(
      MAX_AUTOSAVE_SLOTS,
      Math.max(1, Math.floor(options.autosaveRingSize ?? AUTOSAVE_RING_SIZE)),
    );
    this.checkpointResolver = options.checkpointResolver ?? defaultCheckpointResolver;
    this.now = options.now ?? (() => Date.now());
  }

  on = this.emitter.on.bind(this.emitter);

  /** How many autosave slots the ring keeps. */
  get autosaveRingSize(): number {
    return this.ringSize;
  }

  /**
   * True once the store knows persistence survives a reload.
   *
   * Null before the first access, because availability is only known after an
   * open attempt. Call `open()` during boot to resolve it.
   */
  get durable(): boolean | null {
    return this.backend === null ? null : this.backend.durable;
  }

  /** Opens the database. Safe to call repeatedly; never rejects. */
  async open(): Promise<boolean> {
    const backend = await this.ensureBackend();
    return backend.durable;
  }

  private async ensureBackend(): Promise<SaveBackend> {
    if (this.backend) return this.backend;
    if (!this.opening) {
      this.opening = this.openBackend().then((backend) => {
        this.backend = backend;
        this.opening = null;
        return backend;
      });
    }
    return this.opening;
  }

  private async openBackend(): Promise<SaveBackend> {
    const factory =
      this.options.indexedDb !== undefined
        ? this.options.indexedDb
        : ((globalThis as { indexedDB?: IDBFactory }).indexedDB ?? null);

    if (!factory) {
      const reason = 'IndexedDB is unavailable; progress will not survive a reload';
      console.warn(`[saves] ${reason}`);
      this.emitter.emit('degraded', { reason });
      return new MemoryBackend();
    }

    const keyRange =
      this.options.idbKeyRange ??
      (globalThis as { IDBKeyRange?: typeof IDBKeyRange }).IDBKeyRange;

    try {
      const db = new SaveDatabase(this.databaseName, {
        indexedDB: factory,
        IDBKeyRange: keyRange,
      });
      await db.open();
      return new DexieBackend(db);
    } catch (error) {
      // A blocked or quota-denied open is not fatal to the session, but it is
      // not something to swallow either.
      const reason = `IndexedDB could not be opened: ${describeError(error)}`;
      console.warn(`[saves] ${reason}`);
      this.emitter.emit('degraded', { reason });
      return new MemoryBackend();
    }
  }

  /**
   * Writes a save to an explicit slot.
   *
   * Rejects an invalid payload rather than persisting a broken blob, and backs
   * up the row it is about to replace when that row is the only save present —
   * a failed write must never be able to leave the player with nothing.
   */
  async save(slot: SaveSlot, data: Save): Promise<SaveResult> {
    const candidate: Save = {
      ...data,
      slot,
      schemaVersion: SAVE_SCHEMA_VERSION,
      savedAt: data.savedAt > 0 ? data.savedAt : this.now(),
    };

    const parsed = saveSchema.safeParse(candidate);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      console.error('[saves] refused to write an invalid save', message);
      return { status: 'invalid', message };
    }

    const slotId = slotKey(slot);
    const backend = await this.ensureBackend();

    try {
      const existing = await backend.get(slotId);
      if (existing && (await backend.count()) === 1) {
        await this.preserve(existing, 'overwrite-guard');
      }

      await backend.put({
        slotId,
        slotType: slot.type,
        savedAt: parsed.data.savedAt,
        data: clone(parsed.data),
      });
    } catch (error) {
      const message = describeError(error);
      console.error('[saves] write failed', message);
      return { status: 'error', message };
    }

    this.emitter.emit('saved', {
      slotId,
      slot,
      savedAt: parsed.data.savedAt,
      durable: backend.durable,
    });
    return {
      status: 'ok',
      slotId,
      savedAt: parsed.data.savedAt,
      durable: backend.durable,
    };
  }

  /**
   * Writes an autosave into the rolling ring.
   *
   * Fills unused indices first, then replaces the oldest, so the last N
   * autosaves are always on disk and a corrupt newest one is not the end of the
   * run.
   */
  async autosave(data: Save): Promise<SaveResult> {
    const backend = await this.ensureBackend();
    let rows: SaveRow[];
    try {
      rows = await backend.byType('autosave');
    } catch (error) {
      return { status: 'error', message: describeError(error) };
    }

    // Drop slots outside the ring, e.g. after the ring size was reduced.
    for (const row of rows) {
      const slot = parseSlotKey(row.slotId);
      if (slot?.type === 'autosave' && slot.index >= this.ringSize) {
        await backend.delete(row.slotId);
      }
    }

    const inRing = rows.filter((row) => {
      const slot = parseSlotKey(row.slotId);
      return slot?.type === 'autosave' && slot.index < this.ringSize;
    });

    const used = new Map<number, SaveRow>();
    for (const row of inRing) {
      const slot = parseSlotKey(row.slotId);
      if (slot?.type === 'autosave') used.set(slot.index, row);
    }

    let index = 0;
    let free = -1;
    for (let i = 0; i < this.ringSize; i += 1) {
      if (!used.has(i)) {
        free = i;
        break;
      }
    }

    if (free >= 0) {
      index = free;
    } else {
      let oldest = Number.POSITIVE_INFINITY;
      for (const [slotIndex, row] of used) {
        if (row.savedAt < oldest) {
          oldest = row.savedAt;
          index = slotIndex;
        }
      }
    }

    return this.save({ type: 'autosave', index }, data);
  }

  /**
   * Reads one slot, repairing what it can.
   *
   * On failure the original row is copied to the backup table and left in
   * place, then the newest earlier autosave is offered.
   */
  async load(slotId: string): Promise<LoadResult> {
    const backend = await this.ensureBackend();

    let row: SaveRow | undefined;
    try {
      row = await backend.get(slotId);
    } catch (error) {
      console.warn('[saves] read failed', describeError(error));
      return { status: 'empty' };
    }
    if (!row) return { status: 'empty' };

    const validated = this.validate(row);
    if (validated.ok) {
      return { status: 'ok', save: validated.save, slotId, migrated: validated.migrated };
    }

    const backupId = await this.preserve(row, 'corrupt');
    const fallback = await this.findFallback(slotId);

    if (fallback) {
      this.emitter.emit('recovered', {
        failedSlotId: slotId,
        recoveredSlotId: fallback.row.slotId,
        reason: validated.reason,
      });
      return {
        status: 'recovered',
        save: fallback.save,
        slotId: fallback.row.slotId,
        failedSlotId: slotId,
        backupId,
        reason: validated.reason,
      };
    }

    this.emitter.emit('corrupted', { slotId, backupId, reason: validated.reason });
    return { status: 'corrupt', failedSlotId: slotId, backupId, reason: validated.reason };
  }

  /**
   * Backs the Continue button.
   *
   * Walks saves newest first and returns the first that survives validation,
   * preserving every damaged row it passes.
   */
  async loadMostRecent(): Promise<LoadResult> {
    const backend = await this.ensureBackend();

    let rows: SaveRow[];
    try {
      rows = await backend.allByRecency();
    } catch (error) {
      console.warn('[saves] read failed', describeError(error));
      return { status: 'empty' };
    }
    if (rows.length === 0) return { status: 'empty' };

    let firstFailure: { slotId: string; backupId: number | null; reason: CorruptionReason } | null =
      null;

    for (const row of rows) {
      const validated = this.validate(row);
      if (validated.ok) {
        if (!firstFailure) {
          return { status: 'ok', save: validated.save, slotId: row.slotId, migrated: validated.migrated };
        }
        this.emitter.emit('recovered', {
          failedSlotId: firstFailure.slotId,
          recoveredSlotId: row.slotId,
          reason: firstFailure.reason,
        });
        return {
          status: 'recovered',
          save: validated.save,
          slotId: row.slotId,
          failedSlotId: firstFailure.slotId,
          backupId: firstFailure.backupId,
          reason: firstFailure.reason,
        };
      }

      const backupId = await this.preserve(row, 'corrupt');
      if (!firstFailure) {
        firstFailure = { slotId: row.slotId, backupId, reason: validated.reason };
      }
    }

    // Every row is damaged. All of them are preserved; none were deleted.
    const failure = firstFailure!;
    this.emitter.emit('corrupted', {
      slotId: failure.slotId,
      backupId: failure.backupId,
      reason: failure.reason,
    });
    return {
      status: 'corrupt',
      failedSlotId: failure.slotId,
      backupId: failure.backupId,
      reason: failure.reason,
    };
  }

  /**
   * Metadata for the Continue/Load menu, newest first.
   *
   * Damaged rows are included with `valid: false` rather than hidden, so a
   * player can see that a save exists and is broken instead of watching it
   * vanish.
   */
  async listSaves(): Promise<SaveMetadata[]> {
    const backend = await this.ensureBackend();

    let rows: SaveRow[];
    try {
      rows = await backend.allByRecency();
    } catch (error) {
      console.warn('[saves] list failed', describeError(error));
      return [];
    }

    return rows.map((row) => {
      const validated = this.validate(row);
      if (!validated.ok) {
        return {
          slotId: row.slotId,
          slotType: row.slotType,
          savedAt: row.savedAt,
          valid: false,
          actId: null,
          actName: null,
          checkpointId: null,
          playtimeSeconds: null,
          buildCommit: null,
          buildVersion: null,
          label: null,
        };
      }

      const save = validated.save;
      return {
        slotId: row.slotId,
        slotType: row.slotType,
        savedAt: save.savedAt,
        valid: true,
        actId: save.progress.actId,
        actName: actTitle(save.progress.actId),
        checkpointId: save.progress.checkpointId,
        playtimeSeconds: save.playtimeSeconds,
        buildCommit: save.buildCommit,
        buildVersion: save.buildVersion,
        label: save.slot.type === 'manual' ? save.slot.label : null,
      };
    });
  }

  async deleteSlot(slotId: string): Promise<boolean> {
    const backend = await this.ensureBackend();
    const deleted = await backend.delete(slotId);
    if (deleted) this.emitter.emit('deleted', { slotId });
    return deleted;
  }

  /** Reset option: removes every save and every preserved backup. */
  async clearAll(): Promise<{ saves: number; backups: number }> {
    const backend = await this.ensureBackend();
    const counts = await backend.clear();
    this.emitter.emit('cleared', counts);
    return counts;
  }

  async listBackups(): Promise<BackupMetadata[]> {
    const backend = await this.ensureBackend();
    const rows = await backend.allBackups();
    return rows
      .filter((row): row is BackupRow & { id: number } => typeof row.id === 'number')
      .map((row) => ({
        id: row.id,
        slotId: row.slotId,
        createdAt: row.createdAt,
        reason: row.reason,
      }));
  }

  /** Raw preserved payload, for the developer menu and bug reports. */
  async readBackup(id: number): Promise<unknown | null> {
    const backend = await this.ensureBackend();
    const rows = await backend.allBackups();
    return rows.find((row) => row.id === id)?.raw ?? null;
  }

  /**
   * Serialises saves for the developer menu.
   *
   * With a slot id, exports just that slot; without, every readable save.
   * Slots that cannot be serialised are named in `damagedSlotIds` instead of
   * being silently omitted.
   */
  async exportJson(slotId?: string): Promise<string> {
    const backend = await this.ensureBackend();
    const rows = await backend.allByRecency();
    const selected = slotId === undefined ? rows : rows.filter((row) => row.slotId === slotId);

    const saves: Save[] = [];
    const damagedSlotIds: string[] = [];
    for (const row of selected) {
      const validated = this.validate(row);
      if (validated.ok) saves.push(validated.save);
      else damagedSlotIds.push(row.slotId);
    }

    const bundle: SaveExportBundle = {
      kind: SAVE_EXPORT_KIND,
      formatVersion: SAVE_EXPORT_FORMAT_VERSION,
      exportedAt: this.now(),
      schemaVersion: SAVE_SCHEMA_VERSION,
      saves,
      damagedSlotIds,
    };
    return JSON.stringify(bundle, null, 2);
  }

  /**
   * Restores from an exported bundle or a single save object.
   *
   * Everything is migrated and validated before it touches the database, and
   * any row it replaces is preserved first.
   */
  async importJson(json: string, slot?: SaveSlot): Promise<ImportResult> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      return { status: 'invalid-json', message: describeError(error) };
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { status: 'invalid-save', message: 'expected a save object or an export bundle' };
    }

    const container = parsed as Record<string, unknown>;
    const isBundle = container.kind === SAVE_EXPORT_KIND;
    if (isBundle && !Array.isArray(container.saves)) {
      return { status: 'invalid-save', message: 'export bundle has no saves array' };
    }

    const candidates: unknown[] = isBundle ? (container.saves as unknown[]) : [container];
    if (candidates.length === 0) {
      return { status: 'invalid-save', message: 'export bundle contained no saves' };
    }
    if (slot !== undefined && candidates.length > 1) {
      return {
        status: 'invalid-save',
        message: 'cannot import a multi-save bundle into a single slot',
      };
    }

    const migrated: Save[] = [];
    for (const candidate of candidates) {
      const save = migrateSave(candidate);
      if (!save) {
        return { status: 'invalid-save', message: 'save failed schema validation' };
      }
      migrated.push(slot === undefined ? save : { ...save, slot });
    }

    const backend = await this.ensureBackend();
    const slotIds: string[] = [];
    for (const save of migrated) {
      const targetSlot = save.slot;
      const targetId = slotKey(targetSlot);
      const existing = await backend.get(targetId);
      if (existing) await this.preserve(existing, 'import');

      const result = await this.save(targetSlot, save);
      if (result.status !== 'ok') {
        return { status: 'invalid-save', message: `writing ${targetId} failed` };
      }
      slotIds.push(targetId);
    }

    return { status: 'ok', imported: slotIds.length, slotIds };
  }

  async close(): Promise<void> {
    if (this.backend) await this.backend.close();
    this.backend = null;
    this.opening = null;
  }

  /**
   * parse -> migrate -> verify the checkpoint reference -> verify slot identity.
   *
   * A save whose checkpoint the build no longer knows is damaged: resuming it
   * would drop the player into an unloaded sector, which is worse than telling
   * them the save is broken.
   */
  private validate(row: SaveRow): Validated {
    if (row.data === null || typeof row.data !== 'object') {
      return { ok: false, reason: 'unreadable' };
    }

    const storedVersion = (row.data as Record<string, unknown>).schemaVersion;
    const save = migrateSave(row.data);
    if (!save) return { ok: false, reason: 'schema' };

    if (!this.checkpointResolver(save.progress.checkpointId, save.progress.actId)) {
      return { ok: false, reason: 'checkpoint' };
    }

    if (slotKey(save.slot) !== row.slotId) {
      return { ok: false, reason: 'slot-mismatch' };
    }

    return {
      ok: true,
      save,
      migrated: storedVersion !== SAVE_SCHEMA_VERSION,
    };
  }

  /**
   * Copies a row into the backup table, leaving the original in place.
   *
   * Returns null when the backup itself could not be written; the caller still
   * reports the corruption rather than pretending the read succeeded.
   */
  private async preserve(row: SaveRow, reason: BackupReason): Promise<number | null> {
    try {
      const backend = await this.ensureBackend();
      return await backend.putBackup({
        slotId: row.slotId,
        createdAt: this.now(),
        reason,
        raw: clone(row.data),
      });
    } catch (error) {
      console.warn('[saves] could not preserve a backup', describeError(error));
      return null;
    }
  }

  /**
   * Finds the best save to offer after a failed read.
   *
   * Autosaves first, newest to oldest — the ring exists precisely for this —
   * then any other valid save.
   */
  private async findFallback(
    excludeSlotId: string,
  ): Promise<{ row: SaveRow; save: Save } | null> {
    const backend = await this.ensureBackend();
    const rows = (await backend.allByRecency()).filter((row) => row.slotId !== excludeSlotId);
    const ordered = [
      ...rows.filter((row) => row.slotType === 'autosave'),
      ...rows.filter((row) => row.slotType !== 'autosave'),
    ];

    for (const row of ordered) {
      const validated = this.validate(row);
      if (validated.ok) return { row, save: validated.save };
    }
    return null;
  }
}

/**
 * Deep-copies through JSON.
 *
 * Saves are plain JSON by construction, so this is sufficient, and it
 * guarantees callers cannot mutate stored state through a returned reference —
 * which the in-memory backend would otherwise allow.
 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
