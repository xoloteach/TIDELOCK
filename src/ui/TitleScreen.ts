import { el, remove } from './dom';
import { BUILD_INFO } from '../app/buildInfo';
import type { RendererBackend } from '../engine/render/Capabilities';

/**
 * Title screen.
 *
 * Menu rows are real buttons in document order so keyboard and screen-reader
 * navigation work without extra wiring. Rows that are not yet actionable
 * (Continue with no save) are disabled with a reason rather than hidden, so
 * the player understands why.
 */

export interface TitleScreenActions {
  onContinue: () => void;
  onNewGame: () => void;
  onLoad: () => void;
  onSettings: () => void;
  onCredits: () => void;
}

export interface TitleScreenStatus {
  /** Populated when a resumable save exists. */
  readonly continueLabel: string | null;
  readonly hasSaves: boolean;
  readonly backend: RendererBackend | null;
  /** True when WebGPU was requested/available but we ran WebGL2 instead. */
  readonly usingFallback: boolean;
}

export class TitleScreen {
  private readonly root: HTMLElement;
  private readonly continueButton: HTMLButtonElement;
  private readonly continueDetail: HTMLElement;
  private readonly loadButton: HTMLButtonElement;
  private readonly backendLabel: HTMLElement;
  private readonly backendLamp: HTMLElement;

  constructor(
    private readonly host: HTMLElement,
    actions: TitleScreenActions,
    status: TitleScreenStatus,
  ) {
    this.continueDetail = el('span', { class: 'title__button-detail' });

    this.continueButton = el('button', {
      class: 'title__button',
      attrs: { type: 'button' },
      children: [el('span', { text: 'Continue' }), this.continueDetail],
      on: { click: actions.onContinue },
    });

    this.loadButton = el('button', {
      class: 'title__button',
      attrs: { type: 'button' },
      text: 'Load',
      on: { click: actions.onLoad },
    });

    this.backendLamp = el('span', { class: 'title__lamp' });
    this.backendLabel = el('span', { text: 'renderer pending' });

    this.root = el('div', {
      class: 'title',
      attrs: { role: 'region', 'aria-label': 'Main menu' },
      children: [
        el('div', {
          class: 'title__main',
          children: [
            el('div', {
              class: 'title__brand',
              children: [
                el('h1', { class: 'title__wordmark', text: 'Tidelock' }),
                el('div', { class: 'title__rule' }),
                el('p', {
                  class: 'title__tagline',
                  text: 'Morrow Quay · Borough flood control · Manual recovery',
                }),
              ],
            }),
            el('nav', {
              children: [
                el('ul', {
                  class: 'title__menu',
                  children: [
                    el('li', { class: 'title__item', children: [this.continueButton] }),
                    el('li', {
                      class: 'title__item',
                      children: [
                        el('button', {
                          class: 'title__button',
                          attrs: { type: 'button' },
                          text: 'New Game',
                          on: { click: actions.onNewGame },
                        }),
                      ],
                    }),
                    el('li', { class: 'title__item', children: [this.loadButton] }),
                    el('li', {
                      class: 'title__item',
                      children: [
                        el('button', {
                          class: 'title__button',
                          attrs: { type: 'button' },
                          text: 'Settings',
                          on: { click: actions.onSettings },
                        }),
                      ],
                    }),
                    el('li', {
                      class: 'title__item',
                      children: [
                        el('button', {
                          class: 'title__button',
                          attrs: { type: 'button' },
                          text: 'Credits',
                          on: { click: actions.onCredits },
                        }),
                      ],
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
        el('div', {
          class: 'title__footer',
          children: [
            el('span', {
              class: 'title__backend',
              children: [this.backendLamp, this.backendLabel],
            }),
            el('span', { class: 'title__footer-spacer' }),
            el('span', { text: `build ${BUILD_INFO.shortCommit}` }),
            el('span', { text: `v${BUILD_INFO.version}` }),
          ],
        }),
      ],
    });

    this.setStatus(status);
    host.appendChild(this.root);

    // Move focus to the first actionable row so keyboard/controller users can
    // act immediately without a blind Tab press.
    const firstEnabled = this.continueButton.disabled
      ? this.root.querySelector<HTMLButtonElement>('.title__button:not(:disabled)')
      : this.continueButton;
    firstEnabled?.focus({ preventScroll: true });
  }

  setStatus(status: TitleScreenStatus): void {
    const canContinue = status.continueLabel !== null;
    this.continueButton.disabled = !canContinue;
    this.continueButton.setAttribute(
      'aria-describedby',
      canContinue ? '' : 'title-continue-reason',
    );
    this.continueDetail.textContent = canContinue
      ? status.continueLabel
      : 'no save yet';

    this.loadButton.disabled = !status.hasSaves;

    if (status.backend) {
      this.backendLabel.textContent =
        status.backend === 'webgpu' ? 'webgpu' : 'webgl2 compatibility';
      this.backendLamp.className = `title__lamp${
        status.usingFallback ? ' title__lamp--fallback' : ''
      }`;
    } else {
      this.backendLabel.textContent = 'renderer unavailable';
      this.backendLamp.className = 'title__lamp title__lamp--fault';
    }
  }

  show(): void {
    if (!this.root.parentNode) this.host.appendChild(this.root);
  }

  hide(): void {
    remove(this.root);
  }

  destroy(): void {
    remove(this.root);
  }
}
