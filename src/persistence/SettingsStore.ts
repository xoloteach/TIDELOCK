/**
 * Settings persistence and change notification.
 *
 * Reads/writes localStorage synchronously so the renderer can apply the
 * graphics preset during boot without awaiting a database. Writes are
 * debounced because sliders emit continuously while dragging.
 */

import { Emitter } from '../engine/events';
import {
  createDefaultSettings,
  migrateSettings,
  settingsSchema,
  type Settings,
} from './settingsSchema';

const STORAGE_KEY = 'tidelock:settings:v1';
const WRITE_DEBOUNCE_MS = 250;

/**
 * Declared as a type alias, not an interface: TypeScript only infers an
 * implicit index signature for aliases, which the `EventMap` constraint needs.
 */
type SettingsEvents = {
  /** Emitted after any successful mutation, with the full new settings. */
  changed: { settings: Settings; sections: readonly SettingsSection[] };
};

export type SettingsSection = keyof Omit<Settings, 'version'>;

export class SettingsStore {
  private settings: Settings;
  private readonly emitter = new Emitter<SettingsEvents>();
  private writeTimer: number | null = null;
  private storageAvailable: boolean;

  constructor() {
    this.storageAvailable = testStorage();
    this.settings = this.load();
  }

  private load(): Settings {
    if (!this.storageAvailable) {
      console.warn('[settings] localStorage unavailable; settings will not persist');
      return createDefaultSettings();
    }

    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      console.warn('[settings] read failed', error);
      return createDefaultSettings();
    }

    if (!raw) return createDefaultSettings();

    try {
      const migrated = migrateSettings(JSON.parse(raw));
      if (migrated) return migrated;
    } catch (error) {
      console.warn('[settings] stored settings were not valid JSON', error);
    }

    return createDefaultSettings();
  }

  /** Current settings. Treat as immutable; mutate via `update`. */
  get current(): Readonly<Settings> {
    return this.settings;
  }

  on = this.emitter.on.bind(this.emitter);

  /**
   * Applies a partial update to one section.
   *
   * Section-scoped so subscribers can cheaply decide whether they care
   * (the graphics system should not re-apply presets when a volume changes).
   */
  update<S extends SettingsSection>(section: S, patch: Partial<Settings[S]>): void {
    const next: Settings = {
      ...this.settings,
      [section]: { ...this.settings[section], ...patch },
    };

    const parsed = settingsSchema.safeParse(next);
    if (!parsed.success) {
      // Reject invalid input rather than persisting a broken blob.
      console.error('[settings] rejected invalid update', section, patch, parsed.error.issues);
      return;
    }

    this.settings = parsed.data;
    this.emitter.emit('changed', { settings: this.settings, sections: [section] });
    this.scheduleWrite();
  }

  /** Replaces all settings, e.g. when importing or resetting. */
  replace(settings: Settings): void {
    const parsed = settingsSchema.safeParse(settings);
    if (!parsed.success) {
      console.error('[settings] rejected invalid replacement', parsed.error.issues);
      return;
    }
    this.settings = parsed.data;
    this.emitter.emit('changed', {
      settings: this.settings,
      sections: ['graphics', 'display', 'audio', 'controls', 'accessibility', 'gameplay'],
    });
    this.scheduleWrite();
  }

  /** Resets one section to defaults, leaving the rest untouched. */
  resetSection(section: SettingsSection): void {
    const defaults = createDefaultSettings();
    this.settings = { ...this.settings, [section]: defaults[section] };
    this.emitter.emit('changed', { settings: this.settings, sections: [section] });
    this.scheduleWrite();
  }

  resetAll(): void {
    this.replace(createDefaultSettings());
  }

  private scheduleWrite(): void {
    if (!this.storageAvailable) return;
    if (this.writeTimer !== null) window.clearTimeout(this.writeTimer);
    this.writeTimer = window.setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, WRITE_DEBOUNCE_MS);
  }

  /** Writes immediately. Call before navigating away. */
  flush(): void {
    if (!this.storageAvailable) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch (error) {
      // Quota exceeded or private-mode restriction. Degrade, do not crash.
      console.warn('[settings] write failed', error);
      this.storageAvailable = false;
    }
  }

  /** Serialised settings for the diagnostics export. */
  export(): string {
    return JSON.stringify(this.settings, null, 2);
  }
}

function testStorage(): boolean {
  if (typeof window === 'undefined' || !('localStorage' in window)) return false;
  try {
    const probe = '__tidelock_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    // Safari private mode and some embedded webviews throw on write.
    return false;
  }
}
