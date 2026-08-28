/**
 * Fixed-timestep simulation loop with render interpolation.
 *
 * Gameplay and physics advance in constant-size steps so behaviour is
 * identical at 30, 60 or 144 FPS. Rendering happens once per animation frame
 * using an interpolation alpha between the last two simulation states.
 *
 * Catch-up steps are capped: if the tab was backgrounded for 10 seconds we
 * must not attempt 600 physics steps in one frame (the "spiral of death").
 * Excess time is discarded and reported so systems can react if they care.
 */

export interface FixedStepLoopOptions {
  /** Simulation frequency in Hz. 60 is the project default. */
  readonly hz?: number;
  /**
   * Maximum simulation steps executed in a single animation frame.
   * Beyond this, remaining accumulated time is dropped.
   */
  readonly maxStepsPerFrame?: number;
  /**
   * Longest real frame delta accepted, in seconds. Larger gaps (tab
   * backgrounded, device sleep) are clamped rather than simulated.
   */
  readonly maxFrameDelta?: number;
}

/** Advances gameplay/physics by exactly `dt` seconds. */
export type FixedUpdateFn = (dt: number, stepIndex: number) => void;

/**
 * Renders one frame.
 * @param alpha Interpolation factor in [0,1] between previous and current
 *   simulation state. Use it to smooth transform interpolation.
 * @param frameDelta Real elapsed wall-clock seconds since the previous render,
 *   for animation/UI that is intentionally frame-rate driven.
 */
export type RenderFn = (alpha: number, frameDelta: number) => void;

export interface LoopStats {
  /** Simulation steps performed in the most recent frame. */
  stepsLastFrame: number;
  /** Seconds discarded because the catch-up cap was hit. */
  droppedTime: number;
  /** Number of frames in which the catch-up cap was hit. */
  overloadFrames: number;
  /** Total simulation steps since the loop started. */
  totalSteps: number;
  /** Total rendered frames since the loop started. */
  totalFrames: number;
  /** Wall-clock seconds the loop has been running (excluding paused time). */
  elapsed: number;
}

export class FixedStepLoop {
  readonly stepSeconds: number;
  readonly hz: number;

  private readonly maxStepsPerFrame: number;
  private readonly maxFrameDelta: number;

  private accumulator = 0;
  private lastTime = 0;
  private rafHandle: number | null = null;
  private running = false;
  private paused = false;

  private fixedUpdate: FixedUpdateFn = () => {};
  private render: RenderFn = () => {};

  private readonly stats: LoopStats = {
    stepsLastFrame: 0,
    droppedTime: 0,
    overloadFrames: 0,
    totalSteps: 0,
    totalFrames: 0,
    elapsed: 0,
  };

  constructor(options: FixedStepLoopOptions = {}) {
    this.hz = options.hz ?? 60;
    this.stepSeconds = 1 / this.hz;
    this.maxStepsPerFrame = options.maxStepsPerFrame ?? 5;
    this.maxFrameDelta = options.maxFrameDelta ?? 0.25;
  }

  setFixedUpdate(fn: FixedUpdateFn): void {
    this.fixedUpdate = fn;
  }

  setRender(fn: RenderFn): void {
    this.render = fn;
  }

  getStats(): Readonly<LoopStats> {
    return this.stats;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  /**
   * Pauses simulation while continuing to render.
   *
   * Menus and dialogue still need frames drawn, but the world must not
   * advance. The accumulator is cleared on resume so paused wall-clock time
   * is never simulated as a burst.
   */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.lastTime = performance.now();
    this.accumulator = 0;
  }

  private schedule(): void {
    this.rafHandle = requestAnimationFrame(this.tick);
  }

  private readonly tick = (now: number): void => {
    if (!this.running) return;

    let frameDelta = (now - this.lastTime) / 1000;
    this.lastTime = now;

    // Guard against negative/NaN deltas from clock adjustments.
    if (!Number.isFinite(frameDelta) || frameDelta < 0) frameDelta = 0;

    // Clamp long stalls instead of simulating them.
    if (frameDelta > this.maxFrameDelta) {
      this.stats.droppedTime += frameDelta - this.maxFrameDelta;
      frameDelta = this.maxFrameDelta;
    }

    let steps = 0;

    if (!this.paused) {
      this.stats.elapsed += frameDelta;
      this.accumulator += frameDelta;

      while (this.accumulator >= this.stepSeconds && steps < this.maxStepsPerFrame) {
        this.fixedUpdate(this.stepSeconds, this.stats.totalSteps);
        this.accumulator -= this.stepSeconds;
        steps += 1;
        this.stats.totalSteps += 1;
      }

      // Catch-up cap reached: discard the backlog so we do not fall
      // permanently behind and compound the problem next frame.
      if (this.accumulator >= this.stepSeconds) {
        this.stats.droppedTime += this.accumulator;
        this.stats.overloadFrames += 1;
        this.accumulator = 0;
      }
    }

    this.stats.stepsLastFrame = steps;
    this.stats.totalFrames += 1;

    const alpha = this.paused ? 1 : this.accumulator / this.stepSeconds;
    this.render(alpha, frameDelta);

    this.schedule();
  };
}
