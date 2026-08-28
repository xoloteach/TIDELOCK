/**
 * Fixed-step loop tests.
 *
 * "Physics tied to frame rate" is an automatic rejection condition, so these
 * tests drive the loop with controlled fake timestamps and assert that the
 * simulation advances by wall-clock time regardless of frame pacing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FixedStepLoop } from '../../src/engine/time/FixedStepLoop';

/**
 * Manual requestAnimationFrame driver.
 *
 * Lets a test say "deliver a frame at t=16.7ms" so loop behaviour is
 * deterministic rather than dependent on real timing.
 */
class FrameDriver {
  private queued: ((t: number) => void) | null = null;
  private now = 0;

  install(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void): number => {
      this.queued = cb;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', (): void => {
      this.queued = null;
    });
    vi.stubGlobal('performance', { now: () => this.now });
  }

  /** Advances the clock by `ms` and delivers exactly one frame. */
  frame(ms: number): void {
    this.now += ms;
    const cb = this.queued;
    this.queued = null;
    cb?.(this.now);
  }

  /** Delivers `count` frames of `ms` each. */
  frames(count: number, ms: number): void {
    for (let i = 0; i < count; i += 1) this.frame(ms);
  }

  get hasPendingFrame(): boolean {
    return this.queued !== null;
  }
}

describe('FixedStepLoop', () => {
  let driver: FrameDriver;

  beforeEach(() => {
    driver = new FrameDriver();
    driver.install();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('derives step size from the configured frequency', () => {
    expect(new FixedStepLoop({ hz: 60 }).stepSeconds).toBeCloseTo(1 / 60, 10);
    expect(new FixedStepLoop({ hz: 30 }).stepSeconds).toBeCloseTo(1 / 30, 10);
  });

  it('runs no simulation steps before start', () => {
    const loop = new FixedStepLoop({ hz: 60 });
    const fixed = vi.fn();
    loop.setFixedUpdate(fixed);
    expect(fixed).not.toHaveBeenCalled();
    expect(loop.isRunning).toBe(false);
  });

  it('always passes exactly the fixed dt to fixedUpdate', () => {
    const loop = new FixedStepLoop({ hz: 60 });
    const deltas: number[] = [];
    loop.setFixedUpdate((dt) => deltas.push(dt));
    loop.start();

    // Deliberately irregular frame pacing.
    driver.frame(16);
    driver.frame(33);
    driver.frame(7);
    driver.frame(50);
    loop.stop();

    expect(deltas.length).toBeGreaterThan(0);
    for (const dt of deltas) {
      expect(dt).toBeCloseTo(1 / 60, 10);
    }
  });

  it('advances the same number of steps for the same elapsed time at different frame rates', () => {
    // 1 second of wall-clock time must be 60 steps at 60 Hz either way.
    const runAt = (frameMs: number, frameCount: number): number => {
      const localDriver = new FrameDriver();
      localDriver.install();
      const loop = new FixedStepLoop({ hz: 60, maxStepsPerFrame: 100 });
      let steps = 0;
      loop.setFixedUpdate(() => {
        steps += 1;
      });
      loop.start();
      localDriver.frames(frameCount, frameMs);
      loop.stop();
      return steps;
    };

    // ~60 FPS: 60 frames of 16.667ms. ~30 FPS: 30 frames of 33.333ms.
    const at60 = runAt(1000 / 60, 60);
    const at30 = runAt(1000 / 30, 30);

    expect(at60).toBeGreaterThanOrEqual(59);
    expect(at30).toBeGreaterThanOrEqual(59);
    // Allow a single step of accumulator rounding difference.
    expect(Math.abs(at60 - at30)).toBeLessThanOrEqual(1);
  });

  it('runs multiple catch-up steps when a frame is long', () => {
    const loop = new FixedStepLoop({ hz: 60, maxStepsPerFrame: 10 });
    let steps = 0;
    loop.setFixedUpdate(() => {
      steps += 1;
    });
    loop.start();

    // 100ms of accumulated time at 60 Hz is 6 whole steps.
    driver.frame(100);
    loop.stop();

    expect(steps).toBe(6);
  });

  it('caps catch-up steps and reports the overload instead of spiralling', () => {
    const loop = new FixedStepLoop({ hz: 60, maxStepsPerFrame: 3, maxFrameDelta: 10 });
    let steps = 0;
    loop.setFixedUpdate(() => {
      steps += 1;
    });
    loop.start();

    // 1 second would be 60 steps; the cap must hold it to 3.
    driver.frame(1000);
    loop.stop();

    expect(steps).toBe(3);
    const stats = loop.getStats();
    expect(stats.overloadFrames).toBe(1);
    expect(stats.droppedTime).toBeGreaterThan(0);
  });

  it('clamps an extreme stall so a backgrounded tab does not simulate the gap', () => {
    const loop = new FixedStepLoop({ hz: 60, maxStepsPerFrame: 100, maxFrameDelta: 0.25 });
    let steps = 0;
    loop.setFixedUpdate(() => {
      steps += 1;
    });
    loop.start();

    // 30 real seconds elapsed. Only 0.25s may be simulated => 15 steps.
    driver.frame(30_000);
    loop.stop();

    expect(steps).toBe(15);
    expect(loop.getStats().droppedTime).toBeGreaterThan(29);
  });

  it('renders once per frame even when no simulation step occurs', () => {
    const loop = new FixedStepLoop({ hz: 60 });
    let steps = 0;
    let renders = 0;
    loop.setFixedUpdate(() => {
      steps += 1;
    });
    loop.setRender(() => {
      renders += 1;
    });
    loop.start();

    // 5ms is well under one 16.67ms step: render, but do not simulate.
    driver.frame(5);
    expect(steps).toBe(0);
    expect(renders).toBe(1);

    driver.frame(5);
    expect(steps).toBe(0);
    expect(renders).toBe(2);

    // Accumulated 15ms + 5ms crosses the step boundary.
    driver.frame(10);
    expect(steps).toBe(1);
    expect(renders).toBe(3);

    loop.stop();
  });

  it('supplies an interpolation alpha within [0,1]', () => {
    const loop = new FixedStepLoop({ hz: 60 });
    const alphas: number[] = [];
    loop.setRender((alpha) => alphas.push(alpha));
    loop.start();

    driver.frame(4);
    driver.frame(4);
    driver.frame(20);
    driver.frame(9);
    loop.stop();

    expect(alphas.length).toBe(4);
    for (const alpha of alphas) {
      expect(alpha).toBeGreaterThanOrEqual(0);
      expect(alpha).toBeLessThanOrEqual(1);
    }
  });

  it('keeps rendering but stops simulating while paused', () => {
    const loop = new FixedStepLoop({ hz: 60 });
    let steps = 0;
    let renders = 0;
    loop.setFixedUpdate(() => {
      steps += 1;
    });
    loop.setRender(() => {
      renders += 1;
    });
    loop.start();

    driver.frame(33);
    const stepsBeforePause = steps;
    const rendersBeforePause = renders;
    expect(stepsBeforePause).toBeGreaterThan(0);

    loop.pause();
    driver.frames(10, 33);

    expect(steps).toBe(stepsBeforePause);
    expect(renders).toBe(rendersBeforePause + 10);

    loop.stop();
  });

  it('does not simulate paused wall-clock time as a burst on resume', () => {
    const loop = new FixedStepLoop({ hz: 60, maxStepsPerFrame: 100 });
    let steps = 0;
    loop.setFixedUpdate(() => {
      steps += 1;
    });
    loop.start();

    loop.pause();
    // 5 seconds spent in a pause menu.
    driver.frames(5, 1000);
    expect(steps).toBe(0);

    loop.resume();
    driver.frame(16);

    // At most one step for the single 16ms frame, never 300 for the pause.
    expect(steps).toBeLessThanOrEqual(1);

    loop.stop();
  });

  it('reports paused state accurately', () => {
    const loop = new FixedStepLoop();
    expect(loop.isPaused).toBe(false);
    loop.pause();
    expect(loop.isPaused).toBe(true);
    loop.resume();
    expect(loop.isPaused).toBe(false);
  });

  it('ignores a redundant start and stops cleanly', () => {
    const loop = new FixedStepLoop({ hz: 60 });
    loop.start();
    expect(loop.isRunning).toBe(true);
    loop.start(); // no-op
    expect(loop.isRunning).toBe(true);
    loop.stop();
    expect(loop.isRunning).toBe(false);
    expect(driver.hasPendingFrame).toBe(false);
  });

  it('survives a non-monotonic clock without simulating negative time', () => {
    const loop = new FixedStepLoop({ hz: 60 });
    let steps = 0;
    loop.setFixedUpdate(() => {
      steps += 1;
    });
    loop.start();

    // A backwards timestamp must not produce steps or corrupt the accumulator.
    driver.frame(-100);
    expect(steps).toBe(0);

    driver.frame(16.7);
    expect(steps).toBe(1);

    loop.stop();
  });

  it('tracks cumulative stats', () => {
    const loop = new FixedStepLoop({ hz: 60, maxStepsPerFrame: 100 });
    loop.setFixedUpdate(() => {});
    loop.start();
    driver.frames(6, 100);
    loop.stop();

    const stats = loop.getStats();
    expect(stats.totalFrames).toBe(6);
    expect(stats.totalSteps).toBe(36);
    expect(stats.elapsed).toBeCloseTo(0.6, 5);
    expect(stats.stepsLastFrame).toBe(6);
  });
});
