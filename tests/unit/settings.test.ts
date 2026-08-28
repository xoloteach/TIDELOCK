/**
 * Settings schema, migration and persistence tests.
 *
 * "Never crash because an old save is missing a field" applies to settings
 * too, so migration is tested against truncated, corrupt and future-shaped
 * inputs rather than only the happy path.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createDefaultSettings,
  migrateSettings,
  settingsSchema,
  SETTINGS_SCHEMA_VERSION,
  DEFAULT_KEY_BINDINGS,
  REBINDABLE_ACTIONS,
} from '../../src/persistence/settingsSchema';
import { SettingsStore } from '../../src/persistence/SettingsStore';

const STORAGE_KEY = 'tidelock:settings:v1';

describe('settings schema', () => {
  it('produces defaults that satisfy its own schema', () => {
    const result = settingsSchema.safeParse(createDefaultSettings());
    expect(result.success).toBe(true);
  });

  it('stamps defaults with the current schema version', () => {
    expect(createDefaultSettings().version).toBe(SETTINGS_SCHEMA_VERSION);
  });

  it('returns a fresh object each call so callers cannot share mutable state', () => {
    const a = createDefaultSettings();
    const b = createDefaultSettings();
    expect(a).not.toBe(b);
    a.audio.master = 0.1;
    expect(b.audio.master).not.toBe(0.1);
  });

  it('binds every rebindable action by default', () => {
    const defaults = createDefaultSettings();
    for (const action of REBINDABLE_ACTIONS) {
      expect(defaults.controls.keyBindings[action], action).toBeDefined();
      expect(defaults.controls.keyBindings[action]!.length).toBeGreaterThan(0);
    }
    expect(Object.keys(DEFAULT_KEY_BINDINGS).sort()).toEqual([...REBINDABLE_ACTIONS].sort());
  });

  it('defaults subtitles on, because dialogue carries the story', () => {
    expect(createDefaultSettings().accessibility.subtitles).toBe(true);
  });

  it('defaults tutorials on and dynamic scaling on', () => {
    const d = createDefaultSettings();
    expect(d.gameplay.tutorialsEnabled).toBe(true);
    expect(d.graphics.dynamicScaling).toBe(true);
  });

  it('leaves graphics overrides null so the preset is authoritative', () => {
    const g = createDefaultSettings().graphics;
    expect(g.renderScale).toBeNull();
    expect(g.shadowTier).toBeNull();
    expect(g.bloom).toBeNull();
    expect(g.targetFps).toBeNull();
  });

  describe('validation rejects out-of-range values', () => {
    it('rejects a volume above 1', () => {
      const bad = createDefaultSettings();
      bad.audio.master = 1.5;
      expect(settingsSchema.safeParse(bad).success).toBe(false);
    });

    it('rejects an unknown quality preset', () => {
      const bad = createDefaultSettings() as unknown as Record<string, any>;
      bad.graphics.preset = 'extreme';
      expect(settingsSchema.safeParse(bad).success).toBe(false);
    });

    it('rejects an unsupported target FPS', () => {
      const bad = createDefaultSettings() as unknown as Record<string, any>;
      bad.graphics.targetFps = 144;
      expect(settingsSchema.safeParse(bad).success).toBe(false);
    });

    it('rejects a negative touch opacity', () => {
      const bad = createDefaultSettings();
      bad.controls.touch.opacity = -1;
      expect(settingsSchema.safeParse(bad).success).toBe(false);
    });
  });
});

describe('migrateSettings', () => {
  it('rejects non-object input', () => {
    for (const bad of [null, undefined, 42, 'settings', true, []]) {
      // Arrays are objects but have no known keys, so they migrate to
      // defaults rather than throwing; primitives are rejected outright.
      const result = migrateSettings(bad);
      if (Array.isArray(bad)) expect(result).not.toBeNull();
      else expect(result).toBeNull();
    }
  });

  it('fills in every missing field from a nearly empty blob', () => {
    const migrated = migrateSettings({ version: 1 });
    expect(migrated).not.toBeNull();
    expect(settingsSchema.safeParse(migrated).success).toBe(true);
    expect(migrated!.audio.master).toBe(createDefaultSettings().audio.master);
  });

  it('preserves values the player actually set', () => {
    const migrated = migrateSettings({
      version: 1,
      graphics: { preset: 'potato' },
      audio: { music: 0.2 },
      accessibility: { subtitleScale: 1.5 },
    });

    expect(migrated!.graphics.preset).toBe('potato');
    expect(migrated!.audio.music).toBe(0.2);
    expect(migrated!.accessibility.subtitleScale).toBe(1.5);
    // Untouched siblings keep their defaults.
    expect(migrated!.audio.master).toBe(createDefaultSettings().audio.master);
  });

  it('recovers from a partially written nested object', () => {
    const migrated = migrateSettings({
      version: 1,
      controls: { touch: { handedness: 'left' } },
    });
    expect(migrated!.controls.touch.handedness).toBe('left');
    expect(migrated!.controls.touch.joystickSize).toBe(1);
    expect(migrated!.controls.mouseSensitivity).toBe(1);
  });

  it('drops keys the current schema no longer understands', () => {
    const migrated = migrateSettings({
      version: 1,
      graphics: { preset: 'high' },
      legacyRaytracing: { enabled: true },
      audio: { removedBus: 0.5, master: 0.4 },
    }) as unknown as Record<string, any>;

    expect(migrated).not.toBeNull();
    expect(migrated.legacyRaytracing).toBeUndefined();
    expect(migrated.audio.removedBus).toBeUndefined();
    expect(migrated.audio.master).toBe(0.4);
  });

  it('rewrites the version stamp to the current schema version', () => {
    const migrated = migrateSettings({ version: 0, audio: { master: 0.3 } });
    expect(migrated!.version).toBe(SETTINGS_SCHEMA_VERSION);
  });

  it('returns null when a preserved value is invalid, so the caller can fall back', () => {
    // An out-of-range value survives the merge but must fail validation
    // rather than being silently clamped into something the player didn't pick.
    const migrated = migrateSettings({ version: 1, audio: { master: 99 } });
    expect(migrated).toBeNull();
  });
});

describe('SettingsStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
  });

  it('starts from defaults when storage is empty', () => {
    const store = new SettingsStore();
    expect(store.current).toEqual(createDefaultSettings());
  });

  it('persists an update and reloads it in a new store', () => {
    const store = new SettingsStore();
    store.update('graphics', { preset: 'ultra' });
    store.flush();

    const reloaded = new SettingsStore();
    expect(reloaded.current.graphics.preset).toBe('ultra');
  });

  it('notifies subscribers with the changed section', () => {
    const store = new SettingsStore();
    const seen: string[][] = [];
    store.on('changed', ({ sections }) => seen.push([...sections]));

    store.update('audio', { music: 0.3 });
    store.update('gameplay', { difficulty: 'story' });

    expect(seen).toEqual([['audio'], ['gameplay']]);
  });

  it('reports the full new settings object to subscribers', () => {
    const store = new SettingsStore();
    let received: unknown = null;
    store.on('changed', ({ settings }) => (received = settings));

    store.update('display', { fov: 85 });

    expect((received as { display: { fov: number } }).display.fov).toBe(85);
  });

  it('rejects an invalid update and leaves current settings untouched', () => {
    const store = new SettingsStore();
    const before = store.current.audio.master;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    store.update('audio', { master: 42 });

    expect(store.current.audio.master).toBe(before);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does not emit a change event for a rejected update', () => {
    const store = new SettingsStore();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = vi.fn();
    store.on('changed', handler);

    store.update('audio', { master: -5 });

    expect(handler).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('merges a partial update rather than replacing the whole section', () => {
    const store = new SettingsStore();
    store.update('audio', { music: 0.1 });
    store.update('audio', { effects: 0.2 });

    expect(store.current.audio.music).toBe(0.1);
    expect(store.current.audio.effects).toBe(0.2);
    expect(store.current.audio.master).toBe(createDefaultSettings().audio.master);
  });

  it('resets one section without disturbing the others', () => {
    const store = new SettingsStore();
    store.update('audio', { master: 0.2 });
    store.update('graphics', { preset: 'potato' });

    store.resetSection('audio');

    expect(store.current.audio.master).toBe(createDefaultSettings().audio.master);
    expect(store.current.graphics.preset).toBe('potato');
  });

  it('resets everything on resetAll', () => {
    const store = new SettingsStore();
    store.update('audio', { master: 0.2 });
    store.update('graphics', { preset: 'potato' });

    store.resetAll();

    expect(store.current).toEqual(createDefaultSettings());
  });

  it('falls back to defaults when stored JSON is corrupt', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not valid json');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = new SettingsStore();

    expect(store.current).toEqual(createDefaultSettings());
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('falls back to defaults when stored settings fail validation', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, audio: { master: 99 } }),
    );
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = new SettingsStore();

    expect(store.current.audio.master).toBe(createDefaultSettings().audio.master);
    spy.mockRestore();
  });

  it('migrates a stored blob written by an older build', () => {
    // Simulates a build that had no touch settings at all.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, graphics: { preset: 'low' } }),
    );

    const store = new SettingsStore();

    expect(store.current.graphics.preset).toBe('low');
    expect(store.current.controls.touch.handedness).toBe('right');
    expect(settingsSchema.safeParse(store.current).success).toBe(true);
  });

  it('exports valid re-importable JSON', () => {
    const store = new SettingsStore();
    store.update('graphics', { preset: 'cinematic' });

    const exported = JSON.parse(store.export());

    expect(settingsSchema.safeParse(exported).success).toBe(true);
    expect(exported.graphics.preset).toBe('cinematic');
  });

  it('keeps working when localStorage writes throw', () => {
    const store = new SettingsStore();
    // Spy on the prototype: jsdom's localStorage is Proxy-backed, so an
    // instance-level spy is bypassed entirely.
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('QuotaExceededError');
      });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    store.update('audio', { master: 0.5 });
    store.flush();

    // The in-memory value still applies; only persistence degraded.
    expect(store.current.audio.master).toBe(0.5);
    expect(warn).toHaveBeenCalled();

    setItem.mockRestore();
    warn.mockRestore();
  });

  it('stops retrying writes after storage proves unavailable', () => {
    const store = new SettingsStore();
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('QuotaExceededError');
      });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    store.update('audio', { master: 0.5 });
    store.flush();
    const callsAfterFirstFailure = setItem.mock.calls.length;
    store.flush();
    store.flush();

    // Further flushes are skipped rather than throwing repeatedly.
    expect(setItem.mock.calls.length).toBe(callsAfterFirstFailure);

    setItem.mockRestore();
    warn.mockRestore();
  });

  it('debounces writes while a slider is being dragged', () => {
    vi.useFakeTimers();
    const store = new SettingsStore();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    for (let i = 0; i < 20; i += 1) {
      store.update('audio', { master: i / 20 });
    }

    // Nothing written yet: the debounce window has not elapsed.
    expect(setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);

    // 20 slider events collapse into a single write.
    expect(setItem).toHaveBeenCalledTimes(1);
    setItem.mockRestore();
    vi.useRealTimers();
  });
});
