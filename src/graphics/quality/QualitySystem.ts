/**
 * Quality state and application.
 *
 * The single place that decides what the effective quality is. Systems
 * subscribe to changes rather than reading the preset table directly, so
 * quality logic never gets scattered across the codebase.
 *
 * Three layers combine, in increasing precedence:
 *   1. the named preset (the ceiling)
 *   2. the player's explicit overrides from the graphics menu
 *   3. the dynamic scaler's adaptive reductions
 *
 * The scaler may only ever *reduce* below the preset. It cannot exceed the
 * ceiling the player selected.
 */

import { Emitter } from '../../engine/events';
import type { RenderContext } from '../../engine/render/RenderContext';
import type { SettingsStore } from '../../persistence/SettingsStore';
import type { GraphicsSettings } from '../../persistence/settingsSchema';
import {
  applyOverrides,
  getPreset,
  type EffectiveQuality,
  type QualityOverrides,
  type QualityPresetName,
} from './presets';

type QualityEvents = {
  /** Emitted whenever the effective quality changes for any reason. */
  changed: {
    quality: EffectiveQuality;
    preset: QualityPresetName;
    /** True when the change came from the dynamic scaler, not the player. */
    fromScaler: boolean;
    /**
     * True when the named preset itself changed. Adaptive state was cleared, so
     * anything tracking its own reduction ladder must reset alongside it.
     */
    presetChanged: boolean;
  };
};

export class QualitySystem {
  private readonly emitter = new Emitter<QualityEvents>();

  private presetName: QualityPresetName;
  /** Overrides the player set in the graphics menu. */
  private userOverrides: QualityOverrides = {};
  /** Reductions applied by the dynamic scaler. Never exceeds the preset. */
  private adaptiveOverrides: QualityOverrides = {};

  private effective: EffectiveQuality;

  constructor(
    private readonly settings: SettingsStore,
    private readonly render: RenderContext | null = null,
  ) {
    this.presetName = settings.current.graphics.preset;
    this.userOverrides = extractOverrides(settings.current.graphics);
    this.effective = this.compute();

    // React to graphics settings changes from the menu.
    settings.on('changed', ({ settings: next, sections }) => {
      if (!sections.includes('graphics') && !sections.includes('display')) return;

      const presetChanged = next.graphics.preset !== this.presetName;
      this.presetName = next.graphics.preset;
      this.userOverrides = extractOverrides(next.graphics);

      // A preset change resets adaptive state: reductions chosen for the old
      // ceiling are meaningless against a new one.
      if (presetChanged) this.adaptiveOverrides = {};

      this.recompute(false, presetChanged);
    });
  }

  get quality(): EffectiveQuality {
    return this.effective;
  }

  get preset(): QualityPresetName {
    return this.presetName;
  }

  on = this.emitter.on.bind(this.emitter);

  private compute(): EffectiveQuality {
    const base = getPreset(this.presetName);
    const withUser = applyOverrides(base, this.userOverrides);
    return applyOverrides(withUser, this.adaptiveOverrides);
  }

  private recompute(fromScaler: boolean, presetChanged = false): void {
    this.effective = this.compute();
    this.applyToRenderer();
    this.emitter.emit('changed', {
      quality: this.effective,
      preset: this.presetName,
      fromScaler,
      presetChanged,
    });
  }

  /** Pushes renderer-level values. Other systems react via the event. */
  private applyToRenderer(): void {
    if (!this.render) return;

    const q = this.effective;
    this.render.setMaxPixelRatio(q.maxPixelRatio);
    this.render.setRenderScale(q.renderScale);
    this.render.setDrawDistance(q.drawDistance);

    // Shadow maps off entirely at tier 0: the blob-shadow fallback handles
    // ground contact, and enabling the shadow pass with no casters still costs
    // a render target.
    const shadowsEnabled = q.shadowTier > 0 && q.maxShadowCastingLights > 0;
    if (this.render.renderer.shadowMap.enabled !== shadowsEnabled) {
      this.render.renderer.shadowMap.enabled = shadowsEnabled;
    }

    // FOV comes from display settings, not the quality preset.
    this.render.setFov(this.settings.current.display.fov);
  }

  /** Applies renderer state for the first time. Call after RenderContext.init(). */
  applyInitial(): void {
    this.applyToRenderer();
    this.emitter.emit('changed', {
      quality: this.effective,
      preset: this.presetName,
      fromScaler: false,
      presetChanged: true,
    });
  }

  // ---- Player-facing changes -------------------------------------------

  /** Selects a preset and persists it. */
  setPreset(name: QualityPresetName): void {
    if (name === this.presetName) return;
    // Persisting triggers the settings listener, which recomputes.
    this.settings.update('graphics', { preset: name });
  }

  // ---- Dynamic scaler interface ---------------------------------------

  /**
   * Applies an adaptive reduction.
   *
   * Values are clamped against the preset ceiling here rather than trusting
   * the caller, so no scaler bug can push quality above what the player chose.
   *
   * @param replace When true (the default) the supplied set becomes the whole
   *   adaptive state. The scaler rebuilds its full ladder on every decision, so
   *   replacing avoids the stale-key drift that merging would leave behind, and
   *   avoids the spurious "back to full ceiling" event that a separate
   *   clearAdaptive() call would emit first.
   */
  applyAdaptive(overrides: QualityOverrides, replace = true): void {
    const ceiling = applyOverrides(getPreset(this.presetName), this.userOverrides);
    const clamped: QualityOverrides = {};

    if (overrides.renderScale !== undefined && overrides.renderScale !== null) {
      // The floor must never sit above the ceiling. A user override can lower
      // renderScale below the preset's own minRenderScale (the settings schema
      // permits 0.3 on every preset), and clamping up to that stale floor would
      // *raise* render scale above the player's explicit choice.
      const floor = Math.min(ceiling.minRenderScale, ceiling.renderScale);
      clamped.renderScale = Math.max(floor, Math.min(ceiling.renderScale, overrides.renderScale));
    }
    if (overrides.shadowDistance !== undefined && overrides.shadowDistance !== null) {
      clamped.shadowDistance = Math.max(0, Math.min(ceiling.shadowDistance, overrides.shadowDistance));
    }
    if (overrides.particleMultiplier !== undefined && overrides.particleMultiplier !== null) {
      clamped.particleMultiplier = Math.max(
        0,
        Math.min(ceiling.particleMultiplier, overrides.particleMultiplier),
      );
    }
    if (overrides.foliageDensity !== undefined && overrides.foliageDensity !== null) {
      clamped.foliageDensity = Math.max(0, Math.min(ceiling.foliageDensity, overrides.foliageDensity));
    }
    if (overrides.reflectionTier !== undefined && overrides.reflectionTier !== null) {
      clamped.reflectionTier = Math.max(
        0,
        Math.min(ceiling.reflectionTier, overrides.reflectionTier),
      ) as 0 | 1 | 2;
    }

    this.adaptiveOverrides = replace ? clamped : { ...this.adaptiveOverrides, ...clamped };
    this.recompute(true);
  }

  /** Current adaptive reductions, for the diagnostics overlay. */
  getAdaptiveOverrides(): Readonly<QualityOverrides> {
    return this.adaptiveOverrides;
  }

  /** Drops all adaptive reductions and returns to the preset ceiling. */
  clearAdaptive(): void {
    if (Object.keys(this.adaptiveOverrides).length === 0) return;
    this.adaptiveOverrides = {};
    this.recompute(true);
  }

  /** The ceiling: preset plus user overrides, without adaptive reductions. */
  getCeiling(): EffectiveQuality {
    return applyOverrides(getPreset(this.presetName), this.userOverrides);
  }
}

/**
 * Maps stored graphics settings onto the override shape.
 *
 * Nulls mean "follow the preset" and are passed through unchanged so
 * `applyOverrides` skips them.
 */
function extractOverrides(graphics: GraphicsSettings): QualityOverrides {
  return {
    renderScale: graphics.renderScale,
    shadowTier: graphics.shadowTier as QualityOverrides['shadowTier'],
    textureTier: graphics.textureTier as QualityOverrides['textureTier'],
    ao: graphics.ao,
    bloom: graphics.bloom,
    depthOfField: graphics.depthOfField,
    reflectionTier: graphics.reflectionTier as QualityOverrides['reflectionTier'],
    foliageDensity: graphics.foliageDensity,
    particleMultiplier: graphics.particleMultiplier,
    drawDistance: graphics.drawDistance,
    targetFps: graphics.targetFps,
  };
}
