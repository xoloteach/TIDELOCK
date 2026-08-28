/**
 * Quality system tests.
 *
 * The system layers a preset ceiling, the player's explicit overrides and the
 * dynamic scaler's reductions. The rule that matters is directional: the
 * scaler may only ever reduce. These tests push adaptive values above the
 * ceiling and below the floor and assert they are clamped, because a scaler
 * that can raise quality would silently overrule the graphics menu.
 *
 * `RenderContext` is passed as null throughout: there is no GPU in a unit
 * test, and everything asserted here is state, not renderer calls.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QualitySystem } from '../../src/graphics/quality/QualitySystem';
import { getPreset } from '../../src/graphics/quality/presets';
import { SettingsStore } from '../../src/persistence/SettingsStore';
import type { GraphicsSettings } from '../../src/persistence/settingsSchema';

/**
 * Builds a store plus system, optionally with graphics settings already in
 * place so they are read by the constructor rather than applied afterwards.
 */
function createSystem(graphics: Partial<GraphicsSettings> = {}): {
  settings: SettingsStore;
  quality: QualitySystem;
} {
  const settings = new SettingsStore();
  if (Object.keys(graphics).length > 0) settings.update('graphics', graphics);
  return { settings, quality: new QualitySystem(settings, null) };
}

const HIGH = getPreset('high');
const MEDIUM = getPreset('medium');
const ULTRA = getPreset('ultra');

describe('QualitySystem', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  describe('construction', () => {
    it('reflects the preset stored in settings', () => {
      // 'medium' is the schema default.
      const { quality } = createSystem();

      expect(quality.preset).toBe('medium');
      expect(quality.quality.name).toBe('medium');
      expect(quality.quality.renderScale).toBe(MEDIUM.renderScale);
    });

    it('reflects a non-default preset already persisted', () => {
      const { quality } = createSystem({ preset: 'potato' });

      expect(quality.preset).toBe('potato');
      expect(quality.quality.shadowTier).toBe(0);
      expect(quality.quality.drawCallBudget).toBe(getPreset('potato').drawCallBudget);
    });

    it('equals the raw preset when the player has set no overrides', () => {
      // Every graphics override defaults to null, so the preset must survive
      // the merge byte-for-byte.
      const { quality } = createSystem();

      expect(quality.quality).toEqual(MEDIUM);
    });
  });

  describe('setPreset', () => {
    it('changes the effective quality', () => {
      const { quality } = createSystem();

      quality.setPreset('ultra');

      expect(quality.preset).toBe('ultra');
      expect(quality.quality).toEqual(ULTRA);
    });

    it('persists the choice to settings', () => {
      const { settings, quality } = createSystem();

      quality.setPreset('low');

      // The menu is not the persistence layer; the system writes it itself.
      expect(settings.current.graphics.preset).toBe('low');
    });

    it('is a no-op when the preset is already selected', () => {
      const { quality } = createSystem();
      const changed = vi.fn();
      quality.on('changed', changed);

      quality.setPreset('medium');

      expect(changed).not.toHaveBeenCalled();
    });
  });

  describe('settings subscription', () => {
    it('follows a preset changed directly through settings', () => {
      const { settings, quality } = createSystem();

      settings.update('graphics', { preset: 'cinematic' });

      // The graphics menu writes settings, not the quality system.
      expect(quality.preset).toBe('cinematic');
      expect(quality.quality.depthOfField).toBe(true);
    });

    it('follows an override changed directly through settings', () => {
      const { settings, quality } = createSystem({ preset: 'high' });

      settings.update('graphics', { drawDistance: 150 });

      expect(quality.quality.drawDistance).toBe(150);
    });

    it('ignores changes to unrelated sections', () => {
      const { settings, quality } = createSystem();
      const changed = vi.fn();
      quality.on('changed', changed);

      settings.update('audio', { music: 0.2 });
      settings.update('gameplay', { difficulty: 'story' });

      // Turning down the music must not re-apply the whole graphics stack.
      expect(changed).not.toHaveBeenCalled();
    });

    it('reacts to display changes, which carry FOV through the same path', () => {
      const { settings, quality } = createSystem();
      const changed = vi.fn();
      quality.on('changed', changed);

      settings.update('display', { fov: 85 });

      expect(changed).toHaveBeenCalledTimes(1);
    });
  });

  describe('changed event', () => {
    it('reports fromScaler false for a player-driven change', () => {
      const { quality } = createSystem();
      const changed = vi.fn();
      quality.on('changed', changed);

      quality.setPreset('high');

      expect(changed).toHaveBeenCalledTimes(1);
      expect(changed.mock.calls[0][0]).toMatchObject({ preset: 'high', fromScaler: false });
    });

    it('reports fromScaler true for an adaptive change', () => {
      const { quality } = createSystem({ preset: 'high' });
      const changed = vi.fn();
      quality.on('changed', changed);

      quality.applyAdaptive({ renderScale: 0.8 });

      // The HUD/diagnostics distinguish "the player chose this" from "the
      // device could not keep up".
      expect(changed.mock.calls[0][0]).toMatchObject({ fromScaler: true });
    });

    it('carries the new effective quality in the payload', () => {
      const { quality } = createSystem({ preset: 'high' });
      const changed = vi.fn();
      quality.on('changed', changed);

      quality.applyAdaptive({ renderScale: 0.75 });

      expect(changed.mock.calls[0][0].quality.renderScale).toBe(0.75);
    });

    it('emits on applyInitial so subscribers get a first value', () => {
      const { quality } = createSystem();
      const changed = vi.fn();
      quality.on('changed', changed);

      quality.applyInitial();

      expect(changed).toHaveBeenCalledTimes(1);
      expect(changed.mock.calls[0][0]).toMatchObject({ fromScaler: false });
    });

    it('stops notifying after unsubscribe', () => {
      const { quality } = createSystem();
      const changed = vi.fn();
      const off = quality.on('changed', changed);

      off();
      quality.setPreset('low');

      expect(changed).not.toHaveBeenCalled();
    });
  });

  describe('user overrides', () => {
    it('win over the preset value', () => {
      const { quality } = createSystem({ preset: 'high', renderScale: 0.75 });

      expect(HIGH.renderScale).toBe(1);
      expect(quality.quality.renderScale).toBe(0.75);
    });

    it('apply an explicit false rather than skipping it', () => {
      // Guards against a truthiness check swallowing a deliberate "off".
      const { quality } = createSystem({ preset: 'high', bloom: false, ao: false });

      expect(HIGH.bloom).toBe(true);
      expect(HIGH.ao).toBe(true);
      expect(quality.quality.bloom).toBe(false);
      expect(quality.quality.ao).toBe(false);
    });

    it('treats null as "follow the preset"', () => {
      const { settings, quality } = createSystem({ preset: 'high', renderScale: 0.6 });
      expect(quality.quality.renderScale).toBe(0.6);

      settings.update('graphics', { renderScale: null, bloom: null });

      expect(quality.quality.renderScale).toBe(HIGH.renderScale);
      expect(quality.quality.bloom).toBe(HIGH.bloom);
    });

    it('survives a preset change', () => {
      const { quality } = createSystem({ preset: 'high', bloom: false });

      quality.setPreset('ultra');

      // The player switched tier, not their opinion about bloom.
      expect(quality.quality.name).toBe('ultra');
      expect(quality.quality.bloom).toBe(false);
    });

    it('leaves untouched dimensions on the preset', () => {
      const { quality } = createSystem({ preset: 'high', renderScale: 0.75 });

      expect(quality.quality.shadowMapSize).toBe(HIGH.shadowMapSize);
      expect(quality.quality.triangleBudget).toBe(HIGH.triangleBudget);
    });
  });

  describe('applyAdaptive clamping', () => {
    it('clamps render scale down to the preset ceiling', () => {
      const { quality } = createSystem({ preset: 'high' });

      quality.applyAdaptive({ renderScale: 1.4 });

      // The scaler exists to reduce load; it can never render above the tier
      // the player selected.
      expect(quality.quality.renderScale).toBe(HIGH.renderScale);
    });

    it('clamps render scale up to the preset floor', () => {
      const { quality } = createSystem({ preset: 'high' });

      quality.applyAdaptive({ renderScale: 0.1 });

      // Below minRenderScale the image stops being readable, which is worse
      // than a dropped frame.
      expect(quality.quality.renderScale).toBe(HIGH.minRenderScale);
    });

    it('accepts a value inside the permitted band unchanged', () => {
      const { quality } = createSystem({ preset: 'high' });

      quality.applyAdaptive({ renderScale: 0.85 });

      expect(quality.quality.renderScale).toBe(0.85);
    });

    it('cannot climb back above a render scale the player lowered', () => {
      // Ceiling = preset merged with user overrides, so a manual 0.85 on High
      // becomes the new maximum even though the preset allows 1.0.
      const { quality } = createSystem({ preset: 'high', renderScale: 0.85 });

      quality.applyAdaptive({ renderScale: 1 });

      expect(quality.quality.renderScale).toBe(0.85);
    });

    it('clamps shadow distance to the ceiling and never below zero', () => {
      const { quality } = createSystem({ preset: 'high' });

      quality.applyAdaptive({ shadowDistance: 500 });
      expect(quality.quality.shadowDistance).toBe(HIGH.shadowDistance);

      quality.applyAdaptive({ shadowDistance: -10 });
      expect(quality.quality.shadowDistance).toBe(0);
    });

    it('clamps particle and foliage multipliers into range', () => {
      const { quality } = createSystem({ preset: 'high' });

      quality.applyAdaptive({ particleMultiplier: 99, foliageDensity: -1 });

      expect(quality.quality.particleMultiplier).toBe(HIGH.particleMultiplier);
      expect(quality.quality.foliageDensity).toBe(0);
    });

    it('clamps reflection tier to the ceiling', () => {
      const { quality } = createSystem({ preset: 'high' });

      quality.applyAdaptive({ reflectionTier: 2 });

      expect(HIGH.reflectionTier).toBe(1);
      expect(quality.quality.reflectionTier).toBe(1);
    });

    it('ignores null and undefined dimensions', () => {
      const { quality } = createSystem({ preset: 'high' });

      quality.applyAdaptive({ renderScale: null, shadowDistance: undefined });

      expect(quality.getAdaptiveOverrides()).toEqual({});
      expect(quality.quality).toEqual(HIGH);
    });

    it('refuses dimensions the scaler is not allowed to touch', () => {
      const { quality } = createSystem({ preset: 'high' });

      quality.applyAdaptive({ bloom: false, textureTier: 0 });

      // Only the five adaptive dimensions are honoured; the scaler must not be
      // able to switch off effects or evict textures behind the player's back.
      expect(quality.quality.bloom).toBe(true);
      expect(quality.quality.textureTier).toBe(HIGH.textureTier);
      expect(quality.getAdaptiveOverrides()).toEqual({});
    });

    it('replaces the previous adaptive set rather than accumulating', () => {
      const { quality } = createSystem({ preset: 'high' });

      quality.applyAdaptive({ renderScale: 0.9 });
      quality.applyAdaptive({ particleMultiplier: 0.5 });

      // Replace, not merge. The scaler rebuilds its whole ladder on every
      // decision, so merging would strand keys from a deeper level that the
      // current level no longer includes. Replacing also means one quality
      // change and one event per decision, instead of a clear-then-apply pair
      // that briefly reports full ceiling resolution.
      expect(quality.quality.renderScale).toBe(HIGH.renderScale);
      expect(quality.quality.particleMultiplier).toBe(0.5);
      expect(quality.getAdaptiveOverrides()).toEqual({ particleMultiplier: 0.5 });
    });

    it('can merge explicitly when a caller asks for it', () => {
      const { quality } = createSystem({ preset: 'high' });

      quality.applyAdaptive({ renderScale: 0.9 });
      quality.applyAdaptive({ particleMultiplier: 0.5 }, false);

      expect(quality.quality.renderScale).toBe(0.9);
      expect(quality.quality.particleMultiplier).toBe(0.5);
    });

    it('never raises render scale above the player choice, even below minRenderScale', () => {
      // The settings schema allows renderScale down to 0.3 on every preset, so
      // a user override can legitimately sit below the preset's own
      // minRenderScale. Clamping up to that stale floor would raise resolution
      // above what the player explicitly chose.
      const { quality } = createSystem({ preset: 'high', renderScale: 0.5 });

      expect(quality.getCeiling().renderScale).toBe(0.5);
      expect(quality.getCeiling().minRenderScale).toBeGreaterThan(0.5);

      quality.applyAdaptive({ renderScale: 0.45 });

      expect(quality.quality.renderScale).toBeLessThanOrEqual(0.5);
    });
  });

  describe('getAdaptiveOverrides', () => {
    it('starts empty', () => {
      const { quality } = createSystem();
      expect(quality.getAdaptiveOverrides()).toEqual({});
    });

    it('reports the clamped values that were actually applied', () => {
      const { quality } = createSystem({ preset: 'high' });

      quality.applyAdaptive({ renderScale: 0.1, particleMultiplier: 0.4 });

      // The overlay should show what is in force, not what was requested.
      expect(quality.getAdaptiveOverrides()).toEqual({
        renderScale: HIGH.minRenderScale,
        particleMultiplier: 0.4,
      });
    });
  });

  describe('clearAdaptive', () => {
    it('returns every dimension to the ceiling', () => {
      const { quality } = createSystem({ preset: 'high' });
      quality.applyAdaptive({ renderScale: 0.7, shadowDistance: 20, reflectionTier: 0 });

      quality.clearAdaptive();

      expect(quality.getAdaptiveOverrides()).toEqual({});
      expect(quality.quality).toEqual(quality.getCeiling());
      expect(quality.quality.renderScale).toBe(HIGH.renderScale);
    });

    it('emits a scaler-sourced change', () => {
      const { quality } = createSystem({ preset: 'high' });
      quality.applyAdaptive({ renderScale: 0.7 });
      const changed = vi.fn();
      quality.on('changed', changed);

      quality.clearAdaptive();

      expect(changed).toHaveBeenCalledTimes(1);
      expect(changed.mock.calls[0][0]).toMatchObject({ fromScaler: true });
    });

    it('does nothing when there is nothing to clear', () => {
      const { quality } = createSystem({ preset: 'high' });
      const changed = vi.fn();
      quality.on('changed', changed);

      quality.clearAdaptive();

      // No event means no pointless re-application across every subscriber.
      expect(changed).not.toHaveBeenCalled();
    });
  });

  describe('getCeiling', () => {
    it('is the bare preset with no overrides at all', () => {
      const { quality } = createSystem({ preset: 'high' });

      expect(quality.getCeiling()).toEqual(HIGH);
    });

    it('includes user overrides', () => {
      const { quality } = createSystem({ preset: 'high', renderScale: 0.8, bloom: false });

      expect(quality.getCeiling().renderScale).toBe(0.8);
      expect(quality.getCeiling().bloom).toBe(false);
    });

    it('ignores adaptive reductions', () => {
      const { quality } = createSystem({ preset: 'high' });

      quality.applyAdaptive({ renderScale: 0.7, shadowDistance: 10 });

      expect(quality.quality.renderScale).toBe(0.7);
      // The ceiling is what the scaler is allowed to return to.
      expect(quality.getCeiling().renderScale).toBe(HIGH.renderScale);
      expect(quality.getCeiling().shadowDistance).toBe(HIGH.shadowDistance);
    });
  });

  describe('preset changes reset adaptive state', () => {
    it('drops adaptive overrides when the preset changes', () => {
      const { quality } = createSystem({ preset: 'high' });
      quality.applyAdaptive({ renderScale: 0.7, particleMultiplier: 0.3 });

      quality.setPreset('ultra');

      // A reduction chosen against the old ceiling means nothing against a
      // new one, so it is discarded rather than carried over.
      expect(quality.getAdaptiveOverrides()).toEqual({});
      expect(quality.quality).toEqual(ULTRA);
    });

    it('drops them when the preset changes through settings directly', () => {
      const { settings, quality } = createSystem({ preset: 'high' });
      quality.applyAdaptive({ renderScale: 0.7 });

      settings.update('graphics', { preset: 'potato' });

      expect(quality.getAdaptiveOverrides()).toEqual({});
      expect(quality.quality.renderScale).toBe(getPreset('potato').renderScale);
    });

    it('keeps adaptive overrides when only an override changes', () => {
      const { settings, quality } = createSystem({ preset: 'high' });
      quality.applyAdaptive({ renderScale: 0.8 });

      settings.update('graphics', { drawDistance: 200 });

      // Same ceiling tier, so the scaler's decision is still valid.
      expect(quality.getAdaptiveOverrides()).toEqual({ renderScale: 0.8 });
      expect(quality.quality.renderScale).toBe(0.8);
      expect(quality.quality.drawDistance).toBe(200);
    });
  });
});
