/**
 * Application orchestrator.
 *
 * Owns the boot sequence, the top-level state machine, and the lifetime of
 * engine services. Deliberately thin: it wires systems together and does not
 * implement gameplay itself.
 */

import { requireElement } from '../ui/dom';
import { BootScreen, type BootStageDef } from '../ui/BootScreen';
import { TitleScreen } from '../ui/TitleScreen';
import { AppStateMachine, type AppStateName } from './AppState';
import { SettingsStore } from '../persistence/SettingsStore';
import {
  detectCapabilities,
  selectBackend,
  suggestInitialPreset,
  describeCapabilities,
  type GraphicsCapabilities,
  type RendererBackend,
} from '../engine/render/Capabilities';
import { BUILD_INFO } from './buildInfo';
import { hasQueryFlag } from './flags';

/** Boot stages this build actually performs, in order. */
export const BOOT_STAGES: readonly BootStageDef[] = [
  { id: 'settings', label: 'Read stored settings' },
  { id: 'capabilities', label: 'Probe graphics capabilities' },
  { id: 'title', label: 'Present title' },
];

/** Mirrors SettingsStore's key; boot needs it before the store is consulted. */
const SETTINGS_STORAGE_KEY = 'tidelock:settings:v1';

/**
 * Result of looking for stored settings. 'unavailable' is deliberately not
 * folded into 'absent' — see `storedSettingsState`.
 */
type StoredSettingsState = 'present' | 'absent' | 'unavailable';


export interface AppOptions {
  /** Pre-created boot screen, so main.ts can show it before App exists. */
  readonly boot?: BootScreen;
}

/**
 * Stable surface exposed on `window.__TIDELOCK__` for Playwright and
 * diagnostics. Kept explicit so tests do not reach into private internals.
 */
export interface TestHandle {
  readonly ready: boolean;
  readonly build: typeof BUILD_INFO;
  getState(): AppStateName;
  getCapabilities(): GraphicsCapabilities | null;
  getBackend(): RendererBackend | null;
  getSettings(): unknown;
  describeCapabilities(): string;
}

export class App {
  private readonly state = new AppStateMachine();
  private readonly boot: BootScreen;
  private readonly uiRoot: HTMLElement;

  private settingsStore: SettingsStore | null = null;
  private capabilities: GraphicsCapabilities | null = null;
  private backend: RendererBackend | null = null;
  private titleScreen: TitleScreen | null = null;
  private ready = false;

  constructor(options: AppOptions = {}) {
    this.uiRoot = requireElement('#ui-root');
    this.boot = options.boot ?? new BootScreen(BOOT_STAGES, this.uiRoot);
  }

  async start(): Promise<void> {
    await this.stageSettings();
    await this.stageCapabilities();
    await this.stageTitle();

    // The title screen is only present in the 'title' state. Driving this from
    // the state machine keeps show/hide in one place as more screens land.
    this.state.onChange(({ to }) => {
      if (to === 'title') this.titleScreen?.show();
      else this.titleScreen?.hide();
    });

    this.ready = true;

    // Test/review seam: `?holdBoot=1` keeps the boot overlay on screen so its
    // staged progress can be inspected or captured deterministically.
    if (!hasQueryFlag('holdBoot')) {
      await this.boot.dismiss();
    }
  }

  // ---- Boot stages -------------------------------------------------------

  private async stageSettings(): Promise<void> {
    this.boot.beginStage('settings');
    this.settingsStore = new SettingsStore();
    this.applyAccessibilityCssVars();
    this.settingsStore.on('changed', ({ sections }) => {
      if (sections.includes('accessibility')) this.applyAccessibilityCssVars();
    });
    this.boot.completeStage('settings');
  }

  private async stageCapabilities(): Promise<void> {
    this.boot.beginStage('capabilities');

    const caps = await detectCapabilities();
    this.capabilities = caps;

    if (!caps.webgl2Available && !caps.webgpuAvailable) {
      // Neither backend exists: there is no path to rendering the game.
      throw new Error(
        'No supported graphics backend. TIDELOCK requires WebGL2 or WebGPU. ' +
          `WebGPU: ${caps.webgpuUnavailableReason ?? 'unavailable'}`,
      );
    }

    const settings = this.requireSettings();
    // The URL flag is an override for compatibility testing; the stored
    // setting is the player's own choice.
    const forceWebgl2 = settings.current.graphics.forceWebgl2 || hasQueryFlag('webgl2');
    this.backend = selectBackend(caps, forceWebgl2);

    // First run only: adopt the capability-based preset suggestion. Once the
    // player has chosen a preset we never silently override it.
    const stored = this.storedSettingsState();
    if (stored === 'absent') {
      const suggested = suggestInitialPreset(caps);
      settings.update('graphics', { preset: suggested });
      console.info(`[app] initial quality preset suggested: ${suggested}`);
    } else if (stored === 'unavailable') {
      // A denied read is indistinguishable from a first run at the storage
      // level, so treating it as one would re-apply the suggested preset on
      // every launch and overwrite whatever the player picked this session.
      console.warn(
        '[app] settings storage is unreadable, so a first run cannot be told from a ' +
          'denied read; keeping the current preset instead of re-applying a suggestion',
      );
    }

    console.info(`[app] graphics capabilities\n${describeCapabilities(caps)}`);
    this.boot.completeStage('capabilities');
  }

  private async stageTitle(): Promise<void> {
    this.boot.beginStage('title');

    this.titleScreen = new TitleScreen(
      this.uiRoot,
      {
        onContinue: () => this.notImplemented('Continue'),
        onNewGame: () => this.notImplemented('New Game'),
        onLoad: () => this.notImplemented('Load'),
        onSettings: () => this.notImplemented('Settings'),
        onCredits: () => this.notImplemented('Credits'),
      },
      {
        // Save discovery arrives with the save system; no save can exist yet.
        continueLabel: null,
        hasSaves: false,
        backend: this.backend,
        usingFallback:
          this.backend === 'webgl2' && (this.capabilities?.webgpuAvailable ?? false),
      },
    );

    this.state.transition('title');
    this.boot.completeStage('title');
  }

  // ---- Helpers -----------------------------------------------------------

  /**
   * Mirrors accessibility scalars into CSS custom properties so stylesheets
   * scale text/subtitles without every component reading settings directly.
   */
  private applyAccessibilityCssVars(): void {
    const a11y = this.requireSettings().current.accessibility;
    const root = document.documentElement;
    root.style.setProperty('--a11y-text-scale', String(a11y.textScale));
    root.style.setProperty('--a11y-subtitle-scale', String(a11y.subtitleScale));
    root.classList.toggle('a11y-reduce-motion', a11y.reduceMotion);
    root.classList.toggle('a11y-high-contrast', a11y.highContrastSubtitles);
  }

  /**
   * Whether stored settings exist — and, crucially, whether we could even ask.
   *
   * 'absent' means a genuine first run. 'unavailable' means the read failed
   * (private mode, blocked storage, no `window.localStorage`), which is NOT the
   * same thing: conflating them re-applies the capability-suggested preset on
   * every boot and silently discards the player's own choice.
   */
  private storedSettingsState(): StoredSettingsState {
    try {
      return window.localStorage.getItem(SETTINGS_STORAGE_KEY) !== null ? 'present' : 'absent';
    } catch (error) {
      console.error('[app] could not read stored settings', error);
      return 'unavailable';
    }
  }

  private requireSettings(): SettingsStore {
    if (!this.settingsStore) throw new Error('Settings accessed before boot');
    return this.settingsStore;
  }

  /**
   * Placeholder handler for menu rows whose subsystem is not built yet.
   *
   * Logs loudly instead of silently doing nothing, so an unwired button is
   * visible during development rather than looking like a dead UI.
   */
  private notImplemented(label: string): void {
    console.warn(`[app] "${label}" is not implemented in this build yet`);
  }

  getTestHandle(): TestHandle {
    return {
      ready: this.ready,
      build: BUILD_INFO,
      getState: () => this.state.current,
      getCapabilities: () => this.capabilities,
      getBackend: () => this.backend,
      getSettings: () => this.settingsStore?.current ?? null,
      describeCapabilities: () =>
        this.capabilities ? describeCapabilities(this.capabilities) : 'not probed',
    };
  }
}
