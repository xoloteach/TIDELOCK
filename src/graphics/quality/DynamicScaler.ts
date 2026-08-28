/**
 * Adaptive quality scaler.
 *
 * Watches frame time and gives up quality when the device cannot hold the
 * target, then restores it when there is sustained headroom.
 *
 * The hard requirement is *not oscillating*. A scaler that drops render scale,
 * recovers, drops again every two seconds is worse than no scaler: the
 * flickering resolution is more distracting than a stable lower one. Three
 * mechanisms prevent that:
 *
 *   - Asymmetric timing: reductions happen after ~5s of deficit, restore
 *     attempts only after ~16s of comfort. Going down is cheap, coming back up
 *     is not.
 *   - A tolerance band: frame times within 10% of target count as acceptable,
 *     so normal jitter does nothing.
 *   - A cooldown plus a frame-history reset after every decision, so the
 *     samples that justified one change cannot immediately justify the next.
 *
 * Restoration deliberately does not require measurably *better* than target
 * frame times. Presented frame time is vsync-quantised, so a 60 Hz display
 * cannot report better than 16.67 ms; requiring positive headroom would make
 * restoration unreachable and the scaler would only ever ratchet downward.
 *
 * Only one dimension changes per decision, in a fixed priority order: render
 * scale first (cheapest to change, least visible), then shadow distance,
 * particles, foliage, and reflections last.
 */

import type { FrameStats } from '../../engine/render/FrameStats';
import type { QualitySystem } from './QualitySystem';
import type { QualityOverrides } from './presets';

/** One reduction step. Applied in array order; reversed when restoring. */
interface ScaleLevel {
  readonly id: string;
  /** Human-readable, shown in diagnostics. */
  readonly label: string;
  /** Produces the override for this level given the current ceiling. */
  readonly apply: (ceiling: ScalerCeiling) => QualityOverrides;
}

interface ScalerCeiling {
  renderScale: number;
  minRenderScale: number;
  shadowDistance: number;
  particleMultiplier: number;
  foliageDensity: number;
  reflectionTier: number;
}

export interface ScalerConfig {
  /** Seconds of sustained deficit before reducing. */
  readonly downgradeAfterSeconds: number;
  /** Seconds of sustained comfort before attempting a restore. */
  readonly upgradeAfterSeconds: number;
  /**
   * Fractional tolerance above the target frame time. 0.1 means frame times
   * within 10% of budget are acceptable and do not count as a deficit.
   */
  readonly deadBand: number;
  /** Minimum seconds between any two decisions. */
  readonly decisionCooldownSeconds: number;
}

export const DEFAULT_SCALER_CONFIG: ScalerConfig = {
  downgradeAfterSeconds: 5,
  upgradeAfterSeconds: 16,
  deadBand: 0.1,
  decisionCooldownSeconds: 3,
};

/**
 * Reduction ladder, cheapest-to-sacrifice first.
 *
 * Render scale appears three times because it is the most effective and least
 * objectionable lever; each entry takes it a step lower before we start
 * removing world detail the player might read as gameplay information.
 */
const LEVELS: readonly ScaleLevel[] = [
  {
    id: 'render-scale-1',
    label: 'render scale -10%',
    apply: (c) => ({ renderScale: clampScale(c.renderScale * 0.9, c) }),
  },
  {
    id: 'shadow-distance-1',
    label: 'shadow distance -35%',
    apply: (c) => ({ shadowDistance: c.shadowDistance * 0.65 }),
  },
  {
    id: 'render-scale-2',
    label: 'render scale -20%',
    apply: (c) => ({ renderScale: clampScale(c.renderScale * 0.8, c) }),
  },
  {
    id: 'particles-1',
    label: 'particles -50%',
    apply: (c) => ({ particleMultiplier: c.particleMultiplier * 0.5 }),
  },
  {
    id: 'foliage-1',
    label: 'foliage -50%',
    apply: (c) => ({ foliageDensity: c.foliageDensity * 0.5 }),
  },
  {
    id: 'reflections-off',
    label: 'reflections off',
    apply: () => ({ reflectionTier: 0 }),
  },
  {
    id: 'render-scale-3',
    label: 'render scale -30%',
    apply: (c) => ({ renderScale: clampScale(c.renderScale * 0.7, c) }),
  },
  {
    id: 'shadow-distance-2',
    label: 'shadow distance -70%',
    apply: (c) => ({ shadowDistance: c.shadowDistance * 0.3 }),
  },
];

function clampScale(value: number, ceiling: ScalerCeiling): number {
  return Math.max(ceiling.minRenderScale, Math.min(ceiling.renderScale, value));
}

export interface ScalerState {
  /** How many ladder levels are currently applied. */
  readonly level: number;
  readonly maxLevel: number;
  /** Label of the deepest applied level, or null at level 0. */
  readonly currentLabel: string | null;
  /** Seconds of continuous deficit accumulated. */
  readonly deficitSeconds: number;
  /** Seconds of continuous headroom accumulated. */
  readonly headroomSeconds: number;
  readonly enabled: boolean;
  /** Total decisions made, for diagnostics. */
  readonly decisions: number;
}

export class DynamicScaler {
  private level = 0;
  private deficitSeconds = 0;
  private headroomSeconds = 0;
  private cooldownSeconds = 0;
  private decisions = 0;
  private enabled: boolean;
  private unsubscribeQuality: (() => void) | null = null;

  constructor(
    private readonly quality: QualitySystem,
    private readonly frameStats: FrameStats,
    enabled: boolean,
    private readonly config: ScalerConfig = DEFAULT_SCALER_CONFIG,
  ) {
    this.enabled = enabled;
    this.frameStats.setTargetFps(this.quality.quality.targetFps);

    /**
     * Track quality changes made elsewhere.
     *
     * A preset change clears adaptive overrides inside QualitySystem. Without
     * this the ladder position would survive while the overrides did not, and
     * the next restore would re-apply rungs against already-cleared state,
     * *lowering* quality instead of raising it.
     *
     * The target FPS also changes with the preset, and FrameStats needs it to
     * classify long frames against the right budget.
     */
    this.unsubscribeQuality = quality.on('changed', ({ presetChanged, quality: q }) => {
      this.frameStats.setTargetFps(q.targetFps);
      if (presetChanged && this.level !== 0) {
        this.level = 0;
        this.resetAccumulators();
      }
    });
  }

  /** Releases the quality subscription. */
  dispose(): void {
    this.unsubscribeQuality?.();
    this.unsubscribeQuality = null;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.resetAccumulators();
    if (!enabled) {
      // Give back everything so the player sees their chosen preset.
      this.level = 0;
      this.quality.clearAdaptive();
    }
  }

  /**
   * Called once per rendered frame.
   *
   * @param frameDelta Real seconds since the previous frame.
   */
  update(frameDelta: number): void {
    if (!this.enabled) return;

    if (this.cooldownSeconds > 0) {
      this.cooldownSeconds -= frameDelta;
      return;
    }

    const snapshot = this.frameStats.snapshot();
    // Do nothing until there is enough history to be confident. Acting on the
    // first few frames would react to shader compilation, not steady state.
    if (!snapshot.hasStableSample) return;

    const targetMs = 1000 / this.quality.quality.targetFps;
    // A 3-second window: long enough to ignore a single hitch, short enough to
    // reflect the current scene rather than the previous room.
    const recentMs = this.frameStats.recentAverageFrameMs(3);
    if (recentMs <= 0) return;

    const deficitThreshold = targetMs * (1 + this.config.deadBand);

    if (recentMs > deficitThreshold) {
      this.deficitSeconds += frameDelta;
      this.headroomSeconds = 0;

      if (
        this.deficitSeconds >= this.config.downgradeAfterSeconds &&
        this.level < LEVELS.length
      ) {
        this.downgrade();
      }
      return;
    }

    /**
     * Not in deficit, so accumulate toward a restore attempt.
     *
     * Note what this deliberately does *not* do: require frame time to be
     * measurably *better* than target. Presented frame time is vsync-quantised,
     * so a 60 Hz display can never report better than 16.67 ms. Demanding
     * positive headroom against a 60 FPS target would make restoration
     * unreachable on ordinary hardware, and the scaler would ratchet quality
     * down over a session and never give it back.
     *
     * Instead, sustained comfort is treated as reason to *try* one level back.
     * If that proves too expensive the deficit path removes it again. The cost
     * of a wrong guess is bounded by the asymmetry: 16 s to attempt a restore
     * versus 5 s to undo it, plus a 3 s cooldown and a history reset between
     * decisions, so this cannot visibly oscillate.
     */
    this.deficitSeconds = Math.max(0, this.deficitSeconds - frameDelta);

    // Only accumulate when there is actually something to give back.
    if (this.level === 0) {
      this.headroomSeconds = 0;
      return;
    }

    this.headroomSeconds += frameDelta;

    if (this.headroomSeconds >= this.config.upgradeAfterSeconds) {
      this.upgrade();
    }
  }

  private downgrade(): void {
    this.level += 1;
    this.applyLevels();
    const label = LEVELS[this.level - 1].label;
    console.info(
      `[scaler] reducing quality → level ${this.level}/${LEVELS.length} (${label})`,
    );
    this.afterDecision();
  }

  private upgrade(): void {
    this.level -= 1;
    this.applyLevels();
    console.info(`[scaler] restoring quality → level ${this.level}/${LEVELS.length}`);
    this.afterDecision();
  }

  /**
   * Rebuilds the override set from scratch for the current level.
   *
   * Recomputing from the ceiling rather than mutating incrementally means the
   * result cannot drift after repeated up/down movement, and a preset change
   * mid-session is handled correctly.
   *
   * `applyAdaptive` replaces rather than merges, so this is a single quality
   * change and a single event. Clearing first would emit a spurious jump back
   * to full ceiling resolution between the two.
   */
  private applyLevels(): void {
    if (this.level === 0) {
      this.quality.clearAdaptive();
      return;
    }

    const ceilingQuality = this.quality.getCeiling();
    const ceiling: ScalerCeiling = {
      renderScale: ceilingQuality.renderScale,
      minRenderScale: ceilingQuality.minRenderScale,
      shadowDistance: ceilingQuality.shadowDistance,
      particleMultiplier: ceilingQuality.particleMultiplier,
      foliageDensity: ceilingQuality.foliageDensity,
      reflectionTier: ceilingQuality.reflectionTier,
    };

    let combined: QualityOverrides = {};
    for (let i = 0; i < this.level; i += 1) {
      combined = { ...combined, ...LEVELS[i].apply(ceiling) };
    }

    this.quality.applyAdaptive(combined);
  }

  private afterDecision(): void {
    this.decisions += 1;
    this.resetAccumulators();
    this.cooldownSeconds = this.config.decisionCooldownSeconds;
    // Old samples describe the previous quality level and would immediately
    // justify another change in the same direction.
    this.frameStats.reset();
  }

  private resetAccumulators(): void {
    this.deficitSeconds = 0;
    this.headroomSeconds = 0;
  }

  getState(): ScalerState {
    return {
      level: this.level,
      maxLevel: LEVELS.length,
      currentLabel: this.level > 0 ? LEVELS[this.level - 1].label : null,
      deficitSeconds: this.deficitSeconds,
      headroomSeconds: this.headroomSeconds,
      enabled: this.enabled,
      decisions: this.decisions,
    };
  }

  /** Test/diagnostics seam: force a specific ladder level. */
  forceLevel(level: number): void {
    this.level = Math.max(0, Math.min(LEVELS.length, level));
    this.applyLevels();
    this.resetAccumulators();
  }
}
