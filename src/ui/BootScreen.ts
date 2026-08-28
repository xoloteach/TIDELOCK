import { el, clear, requireElement } from './dom';
import { BUILD_INFO } from '../app/buildInfo';

/**
 * Boot screen with named, observable stages.
 *
 * Every boot stage is listed up front and transitions pending → active →
 * done/failed. This makes a stalled or failed boot diagnosable from a single
 * phone screenshot, which matters because the primary test device is Android
 * and the primary test channel is GitHub Pages.
 */

export type BootStageState = 'pending' | 'active' | 'done' | 'failed';

export interface BootStageDef {
  readonly id: string;
  readonly label: string;
}

export interface BootStage extends BootStageDef {
  state: BootStageState;
}

export class BootScreen {
  private readonly root: HTMLElement;
  private readonly stageList: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly metaRow: HTMLElement;
  private readonly stages: BootStage[];
  private readonly stageNodes = new Map<string, HTMLElement>();
  private dismissed = false;

  /**
   * @param stages The stages this build actually performs. Declared by the
   *   caller so the screen never advertises work that does not happen.
   */
  constructor(stages: readonly BootStageDef[], host: HTMLElement = requireElement('#ui-root')) {
    if (stages.length === 0) throw new Error('BootScreen requires at least one stage');
    this.stages = stages.map((s) => ({ ...s, state: 'pending' as const }));

    this.stageList = el('div', { class: 'boot__status' });
    this.fill = el('div', { class: 'boot__fill' });
    this.metaRow = el('div', { class: 'boot__meta' });

    this.root = el('div', {
      class: 'boot',
      attrs: {
        role: 'status',
        'aria-live': 'polite',
        'aria-label': 'Loading TIDELOCK',
      },
      children: [
        el('div', {
          class: 'boot__identity',
          children: [
            el('h1', { class: 'boot__wordmark', text: 'Tidelock' }),
            el('div', { class: 'boot__rule' }),
            el('p', {
              class: 'boot__subtitle',
              text: 'Morrow Quay · Flood Control Recovery',
            }),
          ],
        }),
        el('div', {
          class: 'boot__panel',
          children: [
            this.stageList,
            el('div', { class: 'boot__track', children: [this.fill] }),
            this.metaRow,
          ],
        }),
      ],
    });

    this.renderStages();
    this.renderMeta();
    host.appendChild(this.root);
  }

  private renderStages(): void {
    clear(this.stageList);
    this.stageNodes.clear();

    this.stages.forEach((stage, index) => {
      const stateLabel = el('span', {
        class: 'boot__stage-state',
        text: stateText(stage.state),
      });

      const node = el('div', {
        class: ['boot__stage', `boot__stage--${stage.state}`],
        children: [
          el('span', {
            class: 'boot__stage-index',
            text: String(index + 1).padStart(2, '0'),
          }),
          el('span', { class: 'boot__stage-label', text: stage.label }),
          stateLabel,
        ],
      });

      this.stageNodes.set(stage.id, node);
      this.stageList.appendChild(node);
    });
  }

  private renderMeta(): void {
    clear(this.metaRow);
    this.metaRow.append(
      el('span', { text: `BUILD ${BUILD_INFO.shortCommit}` }),
      el('span', { text: `V${BUILD_INFO.version}` }),
      el('span', { text: BUILD_INFO.mode.toUpperCase() }),
    );
  }

  /** Marks a stage active and everything before it done. */
  beginStage(id: string): void {
    const index = this.stages.findIndex((s) => s.id === id);
    if (index < 0) {
      console.warn(`[boot] unknown stage "${id}"`);
      return;
    }
    for (let i = 0; i < index; i += 1) {
      if (this.stages[i].state === 'pending' || this.stages[i].state === 'active') {
        this.setStageState(this.stages[i].id, 'done');
      }
    }
    this.setStageState(id, 'active');
  }

  completeStage(id: string): void {
    this.setStageState(id, 'done');
  }

  failStage(id: string): void {
    this.setStageState(id, 'failed');
  }

  private setStageState(id: string, state: BootStageState): void {
    const stage = this.stages.find((s) => s.id === id);
    const node = this.stageNodes.get(id);
    if (!stage || !node) return;

    stage.state = state;
    node.className = `boot__stage boot__stage--${state}`;
    const stateEl = node.querySelector('.boot__stage-state');
    if (stateEl) stateEl.textContent = stateText(state);

    this.updateProgress();
  }

  private updateProgress(): void {
    const done = this.stages.filter((s) => s.state === 'done').length;
    const pct = Math.round((done / this.stages.length) * 100);
    this.fill.style.width = `${pct}%`;
  }

  /**
   * Replaces the boot content with a readable failure report.
   *
   * Fatal init errors must never be swallowed; the player and any bug report
   * need the actual message.
   */
  showFatalError(summary: string, error: unknown): void {
    const detail =
      error instanceof Error
        ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
        : String(error);

    const failing = this.stages.find((s) => s.state === 'active');
    if (failing) this.failStage(failing.id);

    clear(this.stageList);
    this.stageList.appendChild(
      el('div', {
        class: 'boot__error',
        attrs: { role: 'alert' },
        children: [
          el('div', { class: 'boot__error-title', text: 'Startup failed' }),
          el('div', { class: 'boot__error-detail', text: `${summary}\n\n${detail}` }),
          el('p', {
            class: 'boot__error-hint',
            text:
              'This build could not start on this device or browser. A WebGL2-capable browser is required. Reloading may help if the failure was a network timeout.',
          }),
          el('button', {
            class: 'btn btn--primary',
            text: 'Reload',
            attrs: { type: 'button' },
            on: { click: () => window.location.reload() },
          }),
        ],
      }),
    );
  }

  /** Fades out and removes the boot screen from the DOM. */
  async dismiss(): Promise<void> {
    if (this.dismissed) return;
    this.dismissed = true;

    for (const stage of this.stages) {
      if (stage.state !== 'failed') this.setStageState(stage.id, 'done');
    }

    this.root.classList.add('boot--dismissed');
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      this.root.addEventListener('transitionend', done, { once: true });
      // Guard: if the transition is disabled (reduced motion) there is no
      // transitionend event, so resolve on a timer as well.
      window.setTimeout(done, 500);
    });
    this.root.remove();
  }

  get isDismissed(): boolean {
    return this.dismissed;
  }
}

function stateText(state: BootStageState): string {
  switch (state) {
    case 'pending':
      return 'waiting';
    case 'active':
      return 'working';
    case 'done':
      return 'ok';
    case 'failed':
      return 'fault';
  }
}
