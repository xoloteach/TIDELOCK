/**
 * Top-level application state machine.
 *
 * Screens and systems react to state rather than calling each other. Legal
 * transitions are declared explicitly so an invalid jump (e.g. Playing →
 * Booting) is caught at the point it happens instead of producing a
 * half-torn-down scene.
 */

export type AppStateName =
  | 'booting'
  | 'title'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'dialogue'
  | 'cinematic'
  | 'ending'
  | 'failed';

const TRANSITIONS: Readonly<Record<AppStateName, readonly AppStateName[]>> = {
  booting: ['title', 'failed'],
  title: ['loading', 'failed'],
  loading: ['playing', 'title', 'cinematic', 'failed'],
  // Gameplay can hand off to any presentation layer and get control back.
  playing: ['paused', 'dialogue', 'cinematic', 'loading', 'ending', 'title', 'failed'],
  paused: ['playing', 'title', 'loading', 'failed'],
  dialogue: ['playing', 'cinematic', 'paused', 'loading', 'failed'],
  cinematic: ['playing', 'dialogue', 'loading', 'ending', 'failed'],
  ending: ['title', 'loading', 'failed'],
  // Terminal: a fatal error requires a reload.
  failed: [],
};

export interface StateChange {
  readonly from: AppStateName;
  readonly to: AppStateName;
}

export class AppStateMachine {
  private state: AppStateName = 'booting';
  private readonly listeners = new Set<(change: StateChange) => void>();
  private readonly history: AppStateName[] = ['booting'];

  get current(): AppStateName {
    return this.state;
  }

  /** The state before the current one, for "resume what I was doing" logic. */
  get previous(): AppStateName | null {
    return this.history.length >= 2 ? this.history[this.history.length - 2] : null;
  }

  canTransition(to: AppStateName): boolean {
    return TRANSITIONS[this.state].includes(to);
  }

  /**
   * Transitions to a new state.
   * @throws when the transition is not declared legal.
   */
  transition(to: AppStateName): StateChange {
    if (to === this.state) {
      return { from: this.state, to };
    }
    if (!this.canTransition(to)) {
      throw new Error(`Illegal app state transition: ${this.state} → ${to}`);
    }

    const change: StateChange = { from: this.state, to };
    this.state = to;
    this.history.push(to);
    // Bound the history; only the immediate predecessor is ever needed.
    if (this.history.length > 16) this.history.shift();

    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (error) {
        console.error('[appstate] listener threw', error);
      }
    }

    return change;
  }

  onChange(listener: (change: StateChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** True while the world simulation should be advancing. */
  get isSimulating(): boolean {
    return this.state === 'playing' || this.state === 'dialogue' || this.state === 'cinematic';
  }

  /** True while the player directly controls Mara. */
  get hasPlayerControl(): boolean {
    return this.state === 'playing' || this.state === 'dialogue';
  }
}
