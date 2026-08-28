/**
 * Frame timing statistics tests.
 *
 * FrameStats feeds both the diagnostics overlay and the dynamic quality
 * scaler, so a wrong average here silently mis-tunes the whole adaptive
 * quality system. The ring buffer is the part most likely to break: it keeps
 * an O(1) running sum, which is only correct if every evicted sample is
 * subtracted exactly once. These tests push well past the 240-sample window
 * to prove the average reflects the window and not all-time history.
 *
 * Frame times are stored in a Float32Array, so numeric assertions use
 * toBeCloseTo rather than exact equality — the storage rounding is ~1e-6
 * relative, far below anything the scaler acts on.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FrameStats } from '../../src/engine/render/FrameStats';

/** Mirrors the private HISTORY_SIZE in FrameStats. Pinned by a test below. */
const HISTORY_SIZE = 240;

/** Samples required before FrameStats will call its window meaningful. */
const STABLE_SAMPLE_COUNT = 60;

/** record() takes seconds; tests are written in milliseconds for readability. */
function recordFrames(stats: FrameStats, count: number, frameMs: number): void {
  for (let i = 0; i < count; i += 1) stats.record(frameMs / 1000);
}

describe('FrameStats', () => {
  let stats: FrameStats;

  beforeEach(() => {
    stats = new FrameStats();
  });

  it('reports a zeroed snapshot before any frame is recorded', () => {
    const snap = stats.snapshot();

    expect(snap.fps).toBe(0);
    expect(snap.averageFps).toBe(0);
    expect(snap.frameMs).toBe(0);
    expect(snap.averageFrameMs).toBe(0);
    expect(snap.onePercentLowFps).toBe(0);
    expect(snap.longFrames).toBe(0);
    expect(snap.worstFrameMs).toBe(0);
    expect(snap.totalFrames).toBe(0);
    // Nothing may act on an empty window — least of all the scaler.
    expect(snap.hasStableSample).toBe(false);
  });

  it('reports fps and frame time for a known frame', () => {
    stats.record(0.02); // 20ms

    const snap = stats.snapshot();
    expect(snap.frameMs).toBeCloseTo(20, 6);
    expect(snap.fps).toBeCloseTo(50, 6);
    expect(snap.totalFrames).toBe(1);
  });

  it('reports the most recent frame, not the average, as fps', () => {
    recordFrames(stats, 100, 10);
    stats.record(0.05); // one 50ms hitch

    const snap = stats.snapshot();
    // fps is the instantaneous value: the hitch, not the healthy average.
    expect(snap.fps).toBeCloseTo(20, 4);
    expect(snap.averageFps).toBeGreaterThan(80);
  });

  it('averages frame time as a true mean across many samples', () => {
    // 120 frames alternating 10ms and 30ms: the mean is exactly 20ms.
    for (let i = 0; i < 60; i += 1) {
      stats.record(0.01);
      stats.record(0.03);
    }

    const snap = stats.snapshot();
    expect(snap.averageFrameMs).toBeCloseTo(20, 4);
    expect(snap.averageFps).toBeCloseTo(50, 3);
    expect(snap.totalFrames).toBe(120);
  });

  describe('sample stability gate', () => {
    it('is not stable below 60 samples', () => {
      recordFrames(stats, STABLE_SAMPLE_COUNT - 1, 16.667);
      expect(stats.snapshot().hasStableSample).toBe(false);
    });

    it('becomes stable at exactly 60 samples and stays stable', () => {
      recordFrames(stats, STABLE_SAMPLE_COUNT, 16.667);
      expect(stats.snapshot().hasStableSample).toBe(true);

      recordFrames(stats, 500, 16.667);
      expect(stats.snapshot().hasStableSample).toBe(true);
    });
  });

  describe('ring buffer wraparound', () => {
    /**
     * The highest-value test in this file.
     *
     * The running sum is maintained incrementally, so a missing or duplicated
     * eviction shows up as an average that drifts toward the all-time mean.
     * The numbers below are chosen so the windowed answer and the all-time
     * answer are far apart and cannot be confused.
     */
    it('averages only the last 240 samples, not all-time history', () => {
      recordFrames(stats, HISTORY_SIZE, 50);
      expect(stats.snapshot().averageFrameMs).toBeCloseTo(50, 3);

      // Window now holds 120 slow + 120 fast => 30ms.
      // All-time would be (240*50 + 120*10) / 360 = 36.67ms.
      recordFrames(stats, 120, 10);
      const half = stats.snapshot();
      expect(half.averageFrameMs).toBeCloseTo(30, 3);
      expect(half.averageFps).toBeCloseTo(1000 / 30, 2);
      expect(half.totalFrames).toBe(360);

      // 120 more fast frames evict every slow sample: the window is pure 10ms.
      recordFrames(stats, 120, 10);
      const full = stats.snapshot();
      expect(full.averageFrameMs).toBeCloseTo(10, 3);
      expect(full.averageFps).toBeCloseTo(100, 2);
      // The worst frame in the window proves the 50ms samples are really gone.
      expect(full.worstFrameMs).toBeCloseTo(10, 3);
    });

    it('holds exactly 240 samples, evicting the oldest on the 241st', () => {
      // Pins HISTORY_SIZE: one outlier followed by a full window of fast
      // frames. It must survive at sample 240 and vanish at sample 241.
      stats.record(0.5); // 500ms stall
      recordFrames(stats, HISTORY_SIZE - 1, 10);
      expect(stats.snapshot().worstFrameMs).toBeCloseTo(500, 2);

      recordFrames(stats, 1, 10);
      expect(stats.snapshot().worstFrameMs).toBeCloseTo(10, 3);
    });

    it('keeps the average stable when the same frame time repeats for many windows', () => {
      // 10x the window length. A running sum that fails to subtract would
      // grow without bound and report an absurd average.
      recordFrames(stats, HISTORY_SIZE * 10, 25);

      const snap = stats.snapshot();
      expect(snap.averageFrameMs).toBeCloseTo(25, 3);
      expect(snap.totalFrames).toBe(HISTORY_SIZE * 10);
    });
  });

  describe('1% low', () => {
    it('exposes stutter that the average hides', () => {
      // 197 healthy frames plus three 200ms stalls. The average stays
      // comfortable; the 1% low must not.
      recordFrames(stats, 197, 8);
      recordFrames(stats, 3, 200);

      const snap = stats.snapshot();
      // (197*8 + 3*200) / 200 = 10.88ms => ~92 fps average.
      expect(snap.averageFrameMs).toBeCloseTo(10.88, 2);
      expect(snap.averageFps).toBeGreaterThan(85);

      // At 200 samples the worst 1% is 2 frames, both 200ms => 5 fps.
      expect(snap.onePercentLowFps).toBeCloseTo(5, 2);
      // An order of magnitude worse than the average: the point of the metric.
      expect(snap.onePercentLowFps).toBeLessThan(snap.averageFps / 10);
    });

    it('reports the same value as the average when every frame is identical', () => {
      recordFrames(stats, 200, 20);

      const snap = stats.snapshot();
      expect(snap.onePercentLowFps).toBeCloseTo(50, 2);
      expect(snap.onePercentLowFps).toBeCloseTo(snap.averageFps, 2);
    });

    it('returns 0 below 20 samples rather than a meaningless figure', () => {
      // Documented behaviour: 19 samples is too small a population for a
      // percentile, so the metric abstains instead of guessing.
      recordFrames(stats, 19, 100);
      expect(stats.snapshot().onePercentLowFps).toBe(0);

      recordFrames(stats, 1, 100);
      expect(stats.snapshot().onePercentLowFps).toBeGreaterThan(0);
    });
  });

  describe('long frames', () => {
    it('counts frames over twice the target budget', () => {
      // Default budget is 1000/60 = 16.67ms, so the threshold is 33.33ms.
      recordFrames(stats, 50, 10);
      recordFrames(stats, 10, 40);

      const snap = stats.snapshot();
      expect(snap.longFrames).toBe(10);
      expect(snap.worstFrameMs).toBeCloseTo(40, 3);
    });

    it('moves the threshold when the target fps changes', () => {
      recordFrames(stats, 50, 10);
      recordFrames(stats, 10, 40);
      expect(stats.snapshot().longFrames).toBe(10);

      // 30 fps => 33.33ms budget => 66.67ms threshold. 40ms is fine now.
      stats.setTargetFps(30);
      expect(stats.snapshot().longFrames).toBe(0);

      // 240 fps => 4.17ms budget => 8.33ms threshold. Every frame is long.
      stats.setTargetFps(240);
      expect(stats.snapshot().longFrames).toBe(60);
    });

    it('survives a nonsensical target fps without dividing by zero', () => {
      recordFrames(stats, 60, 10);
      stats.setTargetFps(0);
      // Clamped to 1 fps => 1000ms budget => 2000ms threshold.
      expect(stats.snapshot().longFrames).toBe(0);
      expect(Number.isFinite(stats.snapshot().averageFrameMs)).toBe(true);
    });
  });

  it('reports the worst frame in the window', () => {
    recordFrames(stats, 30, 12);
    stats.record(0.083); // 83ms
    recordFrames(stats, 30, 12);

    expect(stats.snapshot().worstFrameMs).toBeCloseTo(83, 2);
  });

  describe('recentAverageFrameMs', () => {
    it('weights recent samples over the full window', () => {
      // 100 slow frames then 60 fast ones. The full window is dragged upward
      // by history the scaler should no longer be reacting to.
      recordFrames(stats, 100, 50);
      recordFrames(stats, 60, 10);

      const windowAverage = stats.snapshot().averageFrameMs;
      const recent = stats.recentAverageFrameMs(0.5);

      // (100*50 + 60*10) / 160 = 35ms across the whole window.
      expect(windowAverage).toBeCloseTo(35, 3);
      // 0.5s of history at 10ms is 50 frames, all of them fast.
      expect(recent).toBeCloseTo(10, 3);
      // The recent figure is much closer to the current reality than the
      // window average is — that is why the scaler uses it.
      expect(Math.abs(recent - 10)).toBeLessThan(Math.abs(windowAverage - 10));
    });

    it('falls back to the whole window when asked for more time than it holds', () => {
      recordFrames(stats, 100, 50);
      recordFrames(stats, 60, 10);

      // 160 samples total only 5.6s, so a 10s request returns the window mean.
      expect(stats.recentAverageFrameMs(10)).toBeCloseTo(35, 3);
    });

    it('reflects a slowdown that the last frame alone would overstate', () => {
      recordFrames(stats, 120, 10);
      recordFrames(stats, 100, 30);

      // 3s of 30ms frames is 100 samples, exactly the slow run.
      expect(stats.recentAverageFrameMs(3)).toBeCloseTo(30, 2);
    });

    it('returns 0 with no samples', () => {
      expect(stats.recentAverageFrameMs(3)).toBe(0);
      expect(stats.recentAverageFrameMs(0)).toBe(0);
    });
  });

  describe('reset', () => {
    it('clears the window and the stability flag', () => {
      recordFrames(stats, 300, 40);
      expect(stats.snapshot().hasStableSample).toBe(true);

      stats.reset();

      const snap = stats.snapshot();
      expect(snap.hasStableSample).toBe(false);
      expect(snap.averageFrameMs).toBe(0);
      expect(snap.worstFrameMs).toBe(0);
      expect(snap.fps).toBe(0);
      expect(stats.recentAverageFrameMs(3)).toBe(0);
    });

    it('does not resurrect pre-reset samples in later averages', () => {
      // The scaler resets after every quality decision; leaking the old
      // level's frame times would immediately justify another decision.
      recordFrames(stats, 300, 40);
      stats.reset();
      recordFrames(stats, 60, 10);

      const snap = stats.snapshot();
      expect(snap.averageFrameMs).toBeCloseTo(10, 3);
      expect(snap.worstFrameMs).toBeCloseTo(10, 3);
      expect(stats.recentAverageFrameMs(3)).toBeCloseTo(10, 3);
    });

    it('keeps counting totalFrames across a reset (documented, not ideal)', () => {
      // The FrameSnapshot doc comment calls totalFrames "total frames measured
      // since reset", but reset() deliberately clears only the window. This
      // test documents what the code ACTUALLY does so the diagnostics overlay
      // is written against real behaviour:
      //   - totalFrames is a lifetime counter, unaffected by reset()
      //   - the empty-state snapshot reports a hard-coded 0, so the value
      //     dips to 0 for exactly as long as the window is empty
      recordFrames(stats, 5, 16.667);
      expect(stats.snapshot().totalFrames).toBe(5);

      stats.reset();
      expect(stats.snapshot().totalFrames).toBe(0);

      recordFrames(stats, 1, 16.667);
      expect(stats.snapshot().totalFrames).toBe(6);
    });
  });
});
