/**
 * Dynamic quality scaler tests.
 *
 * The spec's hard requirement for adaptive quality is that it must not
 * oscillate: a scaler that drops render scale, restores it, and drops it again
 * every few seconds is worse than no scaler at all. Three mechanisms are meant
 * to prevent that, and each one is asserted here:
 *
 *   - asymmetric timing (5s to reduce, 16s to restore)
 *   - a dead band around the target frame time, so jitter does nothing
 *   - a cooldown plus a frame-history reset after every decision
 *
 * The scaler is driven exactly as the render loop drives it — record a frame
 * time, then update with the same delta — rather than by poking private state,
 * so the timing assertions describe real behaviour.
 *
 * All timing tests use DEFAULT_SCALER_CONFIG. The default preset is 'medium'
 * (targetFps 45 => 22.22ms budget), which puts the thresholds at:
 *   deficit  > 22.22 * 1.10 = 24.44ms
 *   headroom < 22.22 * 0.72 = 16.00ms
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FrameStats } from '../../src/engine/render/FrameStats';
import {
  DynamicScaler,
  DEFAULT_SCALER_CONFIG,
} from '../../src/graphics/quality/DynamicScaler';
import { QualitySystem } from '../../src/graphics/quality/QualitySystem';
import { getPreset } from '../../src/graphics/quality/presets';
import { SettingsStore } from '../../src/persistence/SettingsStore';

/** The default preset, and therefore the ceiling in every test below. */
const MEDIUM = getPreset('medium');

/** Comfortably over the 24.44ms deficit threshold. */
const DEFICIT_MS = 30;
/** Comfortably under the 16.00ms restore threshold. */
const HEADROOM_MS = 12;
/** Between the two thresholds: the frame time of a device that is coping. */
const DEAD_BAND_MS = 22;

interface Harness {
  quality: QualitySystem;
  stats: FrameStats;
  scaler: DynamicScaler;
}

function createHarness(enabled = true): Harness {
  // Cleared immediately before construction: SettingsStore reads localStorage
  // in its constructor and its writes are debounced, so a write scheduled by
  // an earlier test must not leak a preset into this one.
  window.localStorage.clear();
  const settings = new SettingsStore();
  // No RenderContext in a unit test. QualitySystem accepts null and skips the
  // renderer push; every quality decision is still observable through
  // `quality.quality` and the 'changed' event.
  const quality = new QualitySystem(settings, null);
  const stats = new FrameStats();
  const scaler = new DynamicScaler(quality, stats, enabled);
  return { quality, stats, scaler };
}

interface DriveResult {
  frames: number;
  /** Simulated wall-clock seconds consumed. */
  seconds: number;
}

/** Feeds `count` frames of `frameMs` through stats and scaler, in loop order. */
function drive(h: Harness, frameMs: number, count: number): DriveResult {
  const frameSeconds = frameMs / 1000;
  for (let i = 0; i < count; i += 1) {
    h.stats.record(frameSeconds);
    h.scaler.update(frameSeconds);
  }
  return { frames: count, seconds: count * frameSeconds };
}

/**
 * Drives frames until `done()` or `maxFrames`, returning how long it took.
 *
 * Callers assert the outcome themselves, so a scaler that never acts fails on
 * the state assertion rather than on a helper throwing.
 */
function driveUntil(
  h: Harness,
  frameMs: number,
  done: () => boolean,
  maxFrames = 40_000,
): DriveResult {
  const frameSeconds = frameMs / 1000;
  let frames = 0;
  while (frames < maxFrames && !done()) {
    h.stats.record(frameSeconds);
    h.scaler.update(frameSeconds);
    frames += 1;
  }
  return { frames, seconds: frames * frameSeconds };
}

describe('DynamicScaler', () => {
  /** Scaler decisions are logged via console.info; captured, not silenced. */
  let infoLogs: string[];

  beforeEach(() => {
    window.localStorage.clear();
    infoLogs = [];
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      infoLogs.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('starts at the full preset ceiling with no reductions applied', () => {
    const h = createHarness();

    expect(h.quality.preset).toBe('medium');
    expect(h.quality.quality).toEqual(MEDIUM);
    expect(h.quality.getAdaptiveOverrides()).toEqual({});

    const state = h.scaler.getState();
    expect(state.level).toBe(0);
    expect(state.maxLevel).toBe(8);
    expect(state.currentLabel).toBeNull();
    expect(state.decisions).toBe(0);
    expect(state.enabled).toBe(true);
  });

  it('never changes quality while disabled, however bad frames get', () => {
    const h = createHarness(false);

    // 60ms frames are nearly three times the budget: far past any threshold.
    drive(h, 60, 3000);

    const state = h.scaler.getState();
    expect(state.enabled).toBe(false);
    expect(state.level).toBe(0);
    expect(state.decisions).toBe(0);
    expect(state.deficitSeconds).toBe(0);
    expect(h.quality.getAdaptiveOverrides()).toEqual({});
    expect(h.quality.quality).toEqual(MEDIUM);
    expect(infoLogs).toHaveLength(0);
  });

  it('reduces quality after sustained frame times over budget', () => {
    const h = createHarness();

    driveUntil(h, DEFICIT_MS, () => h.scaler.getState().level > 0);

    const state = h.scaler.getState();
    expect(state.level).toBe(1);
    expect(state.decisions).toBe(1);
    // Render scale goes first: cheapest to change, least visible.
    expect(state.currentLabel).toBe('render scale -10%');
    expect(h.quality.quality.renderScale).toBeLessThan(MEDIUM.renderScale);
    expect(h.quality.quality.renderScale).toBeCloseTo(MEDIUM.renderScale * 0.9, 10);
    // Nothing else has been sacrificed yet.
    expect(h.quality.quality.shadowDistance).toBe(MEDIUM.shadowDistance);
    expect(h.quality.quality.particleMultiplier).toBe(MEDIUM.particleMultiplier);
    expect(infoLogs.some((line) => line.includes('reducing quality'))).toBe(true);
  });

  it('does not react to a one-second deficit', () => {
    const h = createHarness();

    // 60 frames of warm-up to satisfy hasStableSample, then ~1s of deficit.
    // downgradeAfterSeconds is 5, so nothing may happen yet: this is the
    // anti-oscillation guarantee, and the most important assertion here.
    drive(h, DEFICIT_MS, 94);

    const state = h.scaler.getState();
    expect(state.level).toBe(0);
    expect(state.decisions).toBe(0);
    expect(h.quality.quality).toEqual(MEDIUM);
    // The deficit timer is running, so this is a scaler that is watching and
    // waiting rather than one that is simply not working.
    expect(state.deficitSeconds).toBeGreaterThan(0.9);
    expect(state.deficitSeconds).toBeLessThan(DEFAULT_SCALER_CONFIG.downgradeAfterSeconds);
  });

  it('ignores frame times inside the dead band in both directions', () => {
    const h = createHarness();

    // 44 seconds at 22ms: over the 16s upgrade threshold and the 5s downgrade
    // threshold, but inside the dead band, so neither timer may accumulate.
    const run = drive(h, DEAD_BAND_MS, 2000);
    expect(run.seconds).toBeGreaterThan(DEFAULT_SCALER_CONFIG.upgradeAfterSeconds);

    const state = h.scaler.getState();
    expect(state.level).toBe(0);
    expect(state.decisions).toBe(0);
    expect(state.deficitSeconds).toBe(0);
    expect(state.headroomSeconds).toBe(0);
    expect(h.quality.quality).toEqual(MEDIUM);
    expect(infoLogs).toHaveLength(0);
  });

  it('walks down the ladder in priority order under continued deficit', () => {
    const h = createHarness();

    driveUntil(h, DEFICIT_MS, () => h.scaler.getState().level >= 1);
    expect(h.scaler.getState().currentLabel).toBe('render scale -10%');

    driveUntil(h, DEFICIT_MS, () => h.scaler.getState().level >= 2);
    expect(h.scaler.getState().currentLabel).toBe('shadow distance -35%');
    expect(h.quality.quality.shadowDistance).toBeCloseTo(MEDIUM.shadowDistance * 0.65, 10);
    // Level 1's reduction is recomputed from the ceiling, not lost.
    expect(h.quality.quality.renderScale).toBeCloseTo(MEDIUM.renderScale * 0.9, 10);

    driveUntil(h, DEFICIT_MS, () => h.scaler.getState().level >= 3);
    expect(h.scaler.getState().currentLabel).toBe('render scale -20%');
    // Each level recomputes from the ceiling, so level 3 replaces level 1's
    // render scale rather than compounding on top of it.
    expect(h.quality.quality.renderScale).toBeCloseTo(MEDIUM.renderScale * 0.8, 10);
    expect(h.scaler.getState().decisions).toBe(3);
  });

  it('takes far longer to restore quality than it took to give it up', () => {
    const h = createHarness();

    const down = driveUntil(h, DEFICIT_MS, () => h.scaler.getState().level > 0);
    expect(h.scaler.getState().level).toBe(1);

    const up = driveUntil(h, HEADROOM_MS, () => h.scaler.getState().level === 0);
    expect(h.scaler.getState().level).toBe(0);
    expect(h.scaler.getState().decisions).toBe(2);

    // The asymmetry is the anti-oscillation guarantee: going down is cheap,
    // coming back up is deliberately expensive. upgradeAfterSeconds is 16 and
    // downgradeAfterSeconds is 5, so restoring must cost multiples of the
    // reduction even after the shared warm-up and cooldown overheads.
    expect(up.seconds).toBeGreaterThan(down.seconds * 2);
    expect(up.seconds).toBeGreaterThanOrEqual(DEFAULT_SCALER_CONFIG.upgradeAfterSeconds);
    expect(down.seconds).toBeLessThan(DEFAULT_SCALER_CONFIG.upgradeAfterSeconds);

    // A completed restore returns the player's chosen preset exactly.
    expect(h.quality.quality).toEqual(MEDIUM);
    expect(h.quality.getAdaptiveOverrides()).toEqual({});
  });

  it('never raises quality above the preset ceiling, however much headroom there is', () => {
    const h = createHarness();

    const emittedRenderScales: number[] = [];
    h.quality.on('changed', ({ quality }) => {
      emittedRenderScales.push(quality.renderScale);
    });

    h.scaler.forceLevel(4);
    expect(h.quality.quality.renderScale).toBeLessThan(MEDIUM.renderScale);

    // Restore all four levels, then keep feeding headroom well past level 0.
    driveUntil(h, HEADROOM_MS, () => h.scaler.getState().level === 0);
    expect(h.scaler.getState().level).toBe(0);

    const decisionsAtCeiling = h.scaler.getState().decisions;
    drive(h, HEADROOM_MS, 3000);

    // 36 further seconds of headroom must produce no further decisions: there
    // is nothing above the ceiling to restore.
    expect(h.scaler.getState().level).toBe(0);
    expect(h.scaler.getState().decisions).toBe(decisionsAtCeiling);
    expect(h.quality.quality).toEqual(MEDIUM);

    expect(emittedRenderScales.length).toBeGreaterThan(0);
    for (const renderScale of emittedRenderScales) {
      expect(renderScale).toBeLessThanOrEqual(MEDIUM.renderScale);
    }
  });

  it('never drops render scale below the preset minimum at full ladder depth', () => {
    const h = createHarness();

    h.scaler.forceLevel(8);

    const state = h.scaler.getState();
    expect(state.level).toBe(8);
    expect(state.currentLabel).toBe('shadow distance -70%');

    const q = h.quality.quality;
    // 0.85 * 0.7 = 0.595 would breach the floor, so it is pinned at 0.6.
    expect(q.renderScale).toBeGreaterThanOrEqual(MEDIUM.minRenderScale);
    expect(q.renderScale).toBeCloseTo(MEDIUM.minRenderScale, 10);
    // Every other ladder dimension is at its deepest reduction.
    expect(q.shadowDistance).toBeCloseTo(MEDIUM.shadowDistance * 0.3, 10);
    expect(q.particleMultiplier).toBeCloseTo(MEDIUM.particleMultiplier * 0.5, 10);
    expect(q.foliageDensity).toBeCloseTo(MEDIUM.foliageDensity * 0.5, 10);
    expect(q.reflectionTier).toBe(0);
  });

  it('clamps forceLevel to the ladder bounds', () => {
    const h = createHarness();

    h.scaler.forceLevel(999);
    expect(h.scaler.getState().level).toBe(8);

    h.scaler.forceLevel(-5);
    expect(h.scaler.getState().level).toBe(0);
    expect(h.quality.quality).toEqual(MEDIUM);
  });

  it('restores the full preset when adaptive scaling is switched off', () => {
    const h = createHarness();

    // Level 5 is the fifth rung: render scale, shadow distance, render scale
    // again, particles, then foliage.
    h.scaler.forceLevel(5);
    expect(h.scaler.getState().currentLabel).toBe('foliage -50%');
    expect(h.quality.getAdaptiveOverrides()).not.toEqual({});
    expect(h.quality.quality.foliageDensity).toBeCloseTo(MEDIUM.foliageDensity * 0.5, 10);
    expect(h.quality.quality.renderScale).toBeLessThan(MEDIUM.renderScale);

    h.scaler.setEnabled(false);

    const state = h.scaler.getState();
    expect(state.enabled).toBe(false);
    expect(state.level).toBe(0);
    expect(state.currentLabel).toBeNull();
    // The player asked for 'medium'; switching the scaler off must give all of
    // it back, not just stop reducing further.
    expect(h.quality.getAdaptiveOverrides()).toEqual({});
    expect(h.quality.quality).toEqual(MEDIUM);

    // And it stays off under sustained deficit.
    drive(h, DEFICIT_MS, 1000);
    expect(h.scaler.getState().level).toBe(0);
    expect(h.quality.quality).toEqual(MEDIUM);
  });

  it('returns exactly to the ceiling after repeated ladder movement', () => {
    const h = createHarness();

    h.scaler.forceLevel(2);
    const firstPassRenderScale = h.quality.quality.renderScale;
    const firstPassShadowDistance = h.quality.quality.shadowDistance;

    // Overrides are rebuilt from the ceiling each time rather than mutated, so
    // walking the ladder up and down repeatedly must not accumulate drift.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      for (let level = 0; level <= 8; level += 1) h.scaler.forceLevel(level);
      for (let level = 8; level >= 0; level -= 1) h.scaler.forceLevel(level);
    }

    h.scaler.forceLevel(0);
    expect(h.quality.quality).toEqual(MEDIUM);
    expect(h.quality.getAdaptiveOverrides()).toEqual({});

    // Exact equality, not toBeCloseTo: the same level must produce bit-identical
    // values after 50 transitions.
    h.scaler.forceLevel(2);
    expect(h.quality.quality.renderScale).toBe(firstPassRenderScale);
    expect(h.quality.quality.shadowDistance).toBe(firstPassShadowDistance);
  });

  it('clears adaptive reductions when the player changes preset', () => {
    const h = createHarness();

    h.scaler.forceLevel(3);
    expect(h.quality.getAdaptiveOverrides()).not.toEqual({});

    h.quality.setPreset('potato');

    // Reductions chosen against the old ceiling are meaningless against a new
    // one, so the new preset is applied whole.
    expect(h.quality.preset).toBe('potato');
    expect(h.quality.getAdaptiveOverrides()).toEqual({});
    expect(h.quality.quality).toEqual(getPreset('potato'));
  });

  it('resets its ladder position when the preset changes', () => {
    const h = createHarness();

    h.scaler.forceLevel(3);
    h.quality.setPreset('potato');

    // QualitySystem clears adaptive overrides on a preset change, and the
    // scaler subscribes so its ladder position is reconciled with them. If the
    // two desynced, the next restore would re-apply rungs against cleared
    // state and *lower* quality instead of raising it.
    expect(h.scaler.getState().level).toBe(0);
    expect(h.quality.getAdaptiveOverrides()).toEqual({});
    expect(h.quality.quality.renderScale).toBe(getPreset('potato').renderScale);

    // With nothing left to restore, sustained comfort must not push quality
    // below the new preset. 'potato' targets 30fps, so 12ms frames are ample.
    // 40 seconds is well past the 16s restore timer.
    drive(h, HEADROOM_MS, Math.ceil(40 / (HEADROOM_MS / 1000)));

    expect(h.scaler.getState().level).toBe(0);
    expect(h.quality.quality.renderScale).toBe(getPreset('potato').renderScale);
  });

  it('resets frame history after a decision so the next one needs fresh evidence', () => {
    const h = createHarness();

    driveUntil(h, DEFICIT_MS, () => h.scaler.getState().level > 0);

    // The decision wiped the window: samples describing the old quality level
    // would otherwise immediately justify another reduction.
    expect(h.stats.snapshot().hasStableSample).toBe(false);
    expect(h.stats.snapshot().averageFrameMs).toBe(0);

    // And the cooldown swallows the next few seconds entirely.
    drive(h, DEFICIT_MS, 60);
    expect(h.scaler.getState().deficitSeconds).toBe(0);
    expect(h.scaler.getState().level).toBe(1);
  });
});
