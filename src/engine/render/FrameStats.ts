/**
 * Frame timing statistics.
 *
 * Feeds both the diagnostics overlay and the dynamic quality scaler. Uses a
 * ring buffer so sampling costs nothing per frame and there is no allocation
 * churn in the hot path.
 *
 * The scaler needs a *stable* signal, not an instantaneous one, so this
 * exposes windowed averages and a 1%-low approximation rather than the raw
 * last-frame value.
 */

const HISTORY_SIZE = 240; // ~4 seconds at 60 FPS, ~8 at 30.

export interface FrameSnapshot {
  /** Instantaneous FPS from the last frame. Noisy; for display only. */
  readonly fps: number;
  /** Averaged FPS over the whole history window. */
  readonly averageFps: number;
  /** Last frame's CPU time in milliseconds. */
  readonly frameMs: number;
  /** Averaged frame time over the history window. */
  readonly averageFrameMs: number;
  /**
   * 1%-low FPS approximation: the mean of the worst 1% of frames in the
   * window. Catches stutter that an average hides.
   */
  readonly onePercentLowFps: number;
  /** Frames in the window that took more than twice the target budget. */
  readonly longFrames: number;
  /** Worst frame time seen in the window. */
  readonly worstFrameMs: number;
  /** Total frames measured since reset. */
  readonly totalFrames: number;
  /** True once the window holds enough samples to be meaningful. */
  readonly hasStableSample: boolean;
}

export class FrameStats {
  private readonly history = new Float32Array(HISTORY_SIZE);
  private writeIndex = 0;
  private samples = 0;
  private totalFrames = 0;

  private lastFrameMs = 0;
  private runningSum = 0;

  /** Frame-time budget in ms derived from the current target FPS. */
  private budgetMs = 1000 / 60;

  /** Scratch array for the 1%-low calculation, reused to avoid allocation. */
  private readonly sortScratch = new Float32Array(HISTORY_SIZE);

  setTargetFps(targetFps: number): void {
    this.budgetMs = 1000 / Math.max(1, targetFps);
  }

  /** Records one frame. Call once per animation frame. */
  record(frameSeconds: number): void {
    const ms = frameSeconds * 1000;
    // A NaN or negative sample would poison the running sum permanently, since
    // NaN propagates through every subsequent addition and subtraction.
    if (!Number.isFinite(ms) || ms < 0) return;

    this.lastFrameMs = ms;
    this.totalFrames += 1;

    // Maintain a running sum so the average is O(1) rather than O(n).
    if (this.samples === HISTORY_SIZE) {
      // Subtract the stored Float32 value, not the original double, so the sum
      // stays exactly consistent with what the buffer holds and cannot drift.
      this.runningSum -= this.history[this.writeIndex];
    } else {
      this.samples += 1;
    }

    this.history[this.writeIndex] = ms;
    // Read back the rounded value so additions and subtractions use identical
    // quantities over the buffer's lifetime.
    this.runningSum += this.history[this.writeIndex];
    this.writeIndex = (this.writeIndex + 1) % HISTORY_SIZE;
  }

  snapshot(): FrameSnapshot {
    if (this.samples === 0) {
      return {
        fps: 0,
        averageFps: 0,
        frameMs: 0,
        averageFrameMs: 0,
        onePercentLowFps: 0,
        longFrames: 0,
        worstFrameMs: 0,
        totalFrames: 0,
        hasStableSample: false,
      };
    }

    const averageFrameMs = this.runningSum / this.samples;

    // Single pass for worst frame and long-frame count.
    let worst = 0;
    let longFrames = 0;
    const longThreshold = this.budgetMs * 2;
    for (let i = 0; i < this.samples; i += 1) {
      const ms = this.history[i];
      if (ms > worst) worst = ms;
      if (ms > longThreshold) longFrames += 1;
    }

    return {
      fps: this.lastFrameMs > 0 ? 1000 / this.lastFrameMs : 0,
      averageFps: averageFrameMs > 0 ? 1000 / averageFrameMs : 0,
      frameMs: this.lastFrameMs,
      averageFrameMs,
      onePercentLowFps: this.computeOnePercentLow(),
      longFrames,
      worstFrameMs: worst,
      totalFrames: this.totalFrames,
      // 60 samples is ~1s at 60 FPS, ~2s at 30 — enough to act on.
      hasStableSample: this.samples >= 60,
    };
  }

  /**
   * Mean of the slowest 1% of frames, expressed as FPS.
   *
   * Partial selection sort over the tail: for a 240-sample window we only
   * need the worst ~3 values, so a full sort would be wasteful.
   */
  private computeOnePercentLow(): number {
    const count = this.samples;
    if (count < 20) return 0;

    const worstCount = Math.max(1, Math.floor(count * 0.01));

    this.sortScratch.set(this.history.subarray(0, count));
    const scratch = this.sortScratch;

    let sum = 0;
    for (let picked = 0; picked < worstCount; picked += 1) {
      let maxIndex = picked;
      for (let i = picked + 1; i < count; i += 1) {
        if (scratch[i] > scratch[maxIndex]) maxIndex = i;
      }
      const tmp = scratch[picked];
      scratch[picked] = scratch[maxIndex];
      scratch[maxIndex] = tmp;
      sum += scratch[picked];
    }

    const meanWorstMs = sum / worstCount;
    return meanWorstMs > 0 ? 1000 / meanWorstMs : 0;
  }

  /**
   * Average frame time over the most recent `seconds` of history.
   *
   * The scaler uses this rather than the full window so it reacts to the
   * current situation instead of being dragged by a stall from 4 seconds ago.
   */
  recentAverageFrameMs(seconds: number): number {
    if (this.samples === 0) return 0;

    let accumulated = 0;
    let total = 0;
    let counted = 0;
    const limitMs = seconds * 1000;

    // Walk backwards from the newest sample.
    for (let i = 0; i < this.samples; i += 1) {
      const index = (this.writeIndex - 1 - i + HISTORY_SIZE) % HISTORY_SIZE;
      const ms = this.history[index];
      total += ms;
      counted += 1;
      accumulated += ms;
      if (accumulated >= limitMs) break;
    }

    return counted > 0 ? total / counted : 0;
  }

  /** Clears history. Call after a quality change so old samples do not mislead. */
  reset(): void {
    this.history.fill(0);
    this.writeIndex = 0;
    this.samples = 0;
    this.runningSum = 0;
    this.lastFrameMs = 0;
  }
}
