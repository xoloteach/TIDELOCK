import { el, append, remove } from './dom';
import { Emitter, type Handler, type Unsubscribe } from '../engine/events';
import type { InteractionVerb } from '../engine/ecs/components';
import type { InputFamily } from '../engine/input/actions';

import './styles/hud.css';

/**
 * Gameplay HUD.
 *
 * The HUD is mostly absent. Morrow Quay is read through the world — signage,
 * gate lamps, pump noise, water level — so a permanent quest log and a
 * permanent health bar would both cover the thing the player is supposed to be
 * looking at and remove the reason to look at it. Every group here is therefore
 * either transient (the objective card, which appears on change and fades) or
 * conditional (the interaction prompt, the tool readout, the condition bar,
 * which appear only when they carry information).
 *
 * Three rules shape the implementation:
 *
 *   1. **The DOM is built once.** Nodes are created in the constructor and only
 *      ever have text, classes and the `hidden` attribute written afterwards.
 *      A HUD that rebuilds elements every frame allocates garbage on a phone
 *      and destroys focus/aria continuity.
 *   2. **Writes are change-gated.** `textContent` and inline styles are only
 *      written when the value actually differs (see {@link TextSlot}). At 60fps
 *      an ungated write is 60 layout invalidations per second per readout for
 *      a string that changed once.
 *   3. **Prompts are device-appropriate by construction.** {@link HudPromptInput}
 *      is a discriminated union, so a touch device cannot be handed a keyboard
 *      key name — the compiler rejects it, and the touch case has its own
 *      render path that asks the on-screen control layer to highlight the
 *      relevant control instead of naming a key that does not exist.
 *
 * The HUD is a sink. It reads nothing and polls nothing: the interaction,
 * mission, tool and dialogue systems push into it. The one thing it emits is
 * `touch-highlight`, because "which on-screen button should glow" is a decision
 * only the prompt owner can make and only the touch layer can execute.
 */

// ---------------------------------------------------------------------------
// Contexts and groups
// ---------------------------------------------------------------------------

/**
 * What currently owns the screen.
 *
 * Not a game state machine — a presentation mode. `interaction` means a
 * sustained interaction surface (a terminal, a breaker panel) is open, so the
 * objective card would be noise on top of it.
 */
export type HudContext =
  | 'exploration'
  | 'interaction'
  | 'dialogue'
  | 'cinematic'
  | 'menu';

/** The independently-hideable blocks of the HUD. */
export type HudGroup = 'objective' | 'prompt' | 'tool' | 'health';

/**
 * Which groups each context permits.
 *
 * A single table rather than branches scattered through the setters, so
 * "what does the HUD look like during a cutscene" has exactly one answer.
 *
 * - `cinematic` allows nothing. A cutscene is a composed shot; a floating
 *   objective card in the corner is the fastest way to make it look cheap.
 *   Subtitles are a separate layer and deliberately stay visible.
 * - `dialogue` keeps only `health`, so a conversation held while a containment
 *   unit is closing in still shows the thing that can kill you.
 * - `menu` allows nothing; the menu is opaque over the world anyway.
 *
 * Permission is necessary but not sufficient — a group also has to have
 * something to say. See {@link Hud.applyVisibility}.
 */
const CONTEXT_POLICY: Readonly<Record<HudContext, ReadonlySet<HudGroup>>> = {
  exploration: new Set<HudGroup>(['objective', 'prompt', 'tool', 'health']),
  interaction: new Set<HudGroup>(['prompt', 'tool', 'health']),
  dialogue: new Set<HudGroup>(['health']),
  cinematic: new Set<HudGroup>(),
  menu: new Set<HudGroup>(),
};

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/**
 * How the active input device should be told to act.
 *
 * A discriminated union, not `{ family, label }`, because the failure this
 * guards against is specific and has been shipped by other games many times:
 * a phone player being told to "Press E". With a union there is no field to
 * put a key name in on the touch branch, so the mistake is a type error rather
 * than a QA finding.
 *
 * - `keyboard` carries the *resolved* key name ('E', 'F', 'Space'). Resolution
 *   belongs to the input layer, which owns the rebinding table; the HUD prints
 *   whatever it is handed.
 * - `gamepad` carries a glyph *name* ('A', 'Cross', 'RB'). Names rather than
 *   pictographs: the icon font is a later art task and a wrong glyph is worse
 *   than a correct word.
 * - `touch` carries the id of the on-screen control to highlight, plus that
 *   control's own printed label if it has one. No key, ever.
 */
export type HudPromptInput =
  | { readonly family: 'keyboard'; readonly keyLabel: string }
  | { readonly family: 'gamepad'; readonly glyph: string }
  | {
      readonly family: 'touch';
      /** Control id understood by the touch control layer, e.g. 'interact'. */
      readonly controlId: string;
      /** The control's printed label, e.g. 'ACT'. Omit for an unlabelled pad. */
      readonly controlLabel?: string;
    };

type PromptFamily = HudPromptInput['family'];

/**
 * Build guard: every input family must have a prompt render path.
 *
 * Adding a fourth family to `INPUT_FAMILIES` without adding a branch to
 * {@link HudPromptInput} fails the build here rather than silently falling back
 * to the keyboard path and printing a key name on a device with no keys.
 */
type Extends<Sub extends Super, Super> = Sub extends Super ? true : never;
export type PromptFamiliesCoverInputFamilies = Extends<InputFamily, PromptFamily>;

/**
 * Everything needed to draw one prompt.
 *
 * Structurally a subset of `InteractionTarget` plus the device binding, so the
 * caller can spread a target and add `input` without a translation layer.
 */
export interface HudInteractionPrompt {
  readonly verb: InteractionVerb;
  /** Concrete object name, e.g. 'Breaker 4B'. Never a sentence. */
  readonly label: string;
  /** Seconds the action must be held. 0 = instant, and no hold indicator. */
  readonly holdDuration: number;
  /** 0..1. Ignored when `holdDuration` is 0. */
  readonly holdProgress?: number;
  readonly input: HudPromptInput;
}

/** Imperative labels. Uppercasing is the stylesheet's job, not the string's. */
const VERB_LABELS: Readonly<Record<InteractionVerb, string>> = {
  open: 'Open',
  close: 'Close',
  use: 'Use',
  take: 'Take',
  inspect: 'Inspect',
  talk: 'Talk',
  turn: 'Turn',
  connect: 'Connect',
  climb: 'Climb',
  read: 'Read',
};

// ---------------------------------------------------------------------------
// Readouts
// ---------------------------------------------------------------------------

/** Held tool state. `unavailable` covers "left it at the depot". */
export type HudToolState = 'ready' | 'busy' | 'fault' | 'unavailable';

export interface HudToolStatus {
  /** Tool name as printed on the tool, e.g. 'Multimeter'. */
  readonly tool: string;
  readonly state: HudToolState;
  /** Optional specifics: 'breaker 4B', '2 of 4 leads'. */
  readonly detail?: string;
}

/** Borough recovery progress for the system the player is currently working. */
export interface HudRecoveryStatus {
  /** The physical thing, e.g. 'Pump Cluster B'. */
  readonly label: string;
  /** Its state as a short readout, e.g. '2 / 4 online'. */
  readonly value: string;
  readonly state: 'nominal' | 'working' | 'fault';
}

/** Structural subset of the ECS `Health` component. */
export interface HudHealth {
  readonly current: number;
  readonly max: number;
}

// ---------------------------------------------------------------------------
// Options and events
// ---------------------------------------------------------------------------

export interface HudOptions {
  readonly context?: HudContext;
  /** Seconds the objective card stays revealed after a change. */
  readonly objectiveHoldSeconds?: number;
  /** Health ratio at or below which the condition bar becomes prominent. */
  readonly criticalHealthRatio?: number;
}

/**
 * Declared as a type alias, not an interface, so TypeScript infers the implicit
 * index signature the `EventMap` constraint needs.
 */
type HudEvents = {
  /**
   * Which on-screen touch control the prompt refers to, or null when there is
   * no touch prompt. Fires only on change. The touch layer owns the highlight
   * animation; the HUD only knows which control the world is asking for.
   */
  'touch-highlight': {
    controlId: string | null;
    verb: InteractionVerb | null;
    label: string;
  };
};

const DEFAULT_OBJECTIVE_HOLD_SECONDS = 6;
const DEFAULT_CRITICAL_HEALTH_RATIO = 0.35;

// ---------------------------------------------------------------------------
// Change-gated writers
// ---------------------------------------------------------------------------

/**
 * A text node whose content is only written when it changes.
 *
 * The gate is the whole point. `setHealth` and `setHoldProgress` are called
 * from the render loop, so an ungated `textContent =` would dirty layout every
 * frame for a string that changes once every few seconds. Assigning
 * `textContent` also replaces the node's children, which throws away anything
 * a screen reader or a CSS transition was tracking.
 */
class TextSlot {
  private last: string | null = null;

  constructor(readonly node: HTMLElement) {}

  /** Returns true when the DOM was actually written. */
  set(value: string): boolean {
    if (value === this.last) return false;
    this.last = value;
    this.node.textContent = value;
    return true;
  }

  /** Forgets the cached value so the next `set` always writes. */
  invalidate(): void {
    this.last = null;
  }
}

/**
 * Percentage-width fill whose style and aria value are only written when the
 * rounded percentage changes.
 *
 * Quantising to whole percent is deliberate: hold progress advances by a
 * fraction of a percent per frame, and neither a 1/60th-percent width change
 * nor the accompanying `aria-valuenow` announcement is information.
 */
class FillSlot {
  private lastPercent = -1;

  constructor(private readonly node: HTMLElement) {}

  set(progress: number): boolean {
    const percent = Math.round(clamp01(progress) * 100);
    if (percent === this.lastPercent) return false;
    this.lastPercent = percent;
    this.node.style.width = `${percent}%`;
    return true;
  }

  invalidate(): void {
    this.lastPercent = -1;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

// ---------------------------------------------------------------------------
// Hud
// ---------------------------------------------------------------------------

export class Hud {
  private readonly emitter = new Emitter<HudEvents>();

  private readonly root: HTMLElement;

  // Objective card.
  private readonly objectiveGroup: HTMLElement;
  private readonly objectiveKicker: TextSlot;
  private readonly objectiveText: TextSlot;

  // Right rail: tool + recovery readouts, then condition.
  private readonly toolGroup: HTMLElement;
  private readonly toolName: TextSlot;
  private readonly toolState: TextSlot;
  private readonly toolDetail: TextSlot;
  private readonly recoveryRow: HTMLElement;
  private readonly recoveryLabel: TextSlot;
  private readonly recoveryValue: TextSlot;

  private readonly healthGroup: HTMLElement;
  private readonly healthFill: FillSlot;
  private readonly healthValue: TextSlot;

  // Interaction prompt.
  private readonly promptGroup: HTMLElement;
  private readonly promptKeyCue: HTMLElement;
  private readonly promptKeyText: TextSlot;
  private readonly promptTouchCue: HTMLElement;
  private readonly promptTouchText: TextSlot;
  private readonly promptVerb: TextSlot;
  private readonly promptLabel: TextSlot;
  private readonly promptHold: HTMLElement;
  private readonly promptHoldFill: FillSlot;

  private readonly objectiveHoldSeconds: number;
  private readonly criticalHealthRatio: number;

  private currentContext: HudContext;

  private objective: { text: string; kicker: string } | null = null;
  /** Seconds of reveal left. 0 = faded back out. */
  private objectiveRemaining = 0;

  private prompt: HudInteractionPrompt | null = null;
  private holdProgress = 0;
  private tool: HudToolStatus | null = null;
  private recovery: HudRecoveryStatus | null = null;
  private health: HudHealth | null = null;

  /** Last emitted highlight, so the event fires on change only. */
  private emittedHighlight: string | null = null;

  private lastAriaHoldPercent = -1;

  constructor(host: HTMLElement, options: HudOptions = {}) {
    this.objectiveHoldSeconds =
      options.objectiveHoldSeconds ?? DEFAULT_OBJECTIVE_HOLD_SECONDS;
    this.criticalHealthRatio =
      options.criticalHealthRatio ?? DEFAULT_CRITICAL_HEALTH_RATIO;
    this.currentContext = options.context ?? 'exploration';

    // ---- Objective card -------------------------------------------------
    // aria-live on the card itself: the objective changing is exactly the kind
    // of event a screen reader user must hear, and it changes rarely.
    this.objectiveKicker = new TextSlot(el('span', { class: 'hud__objective-kicker' }));
    this.objectiveText = new TextSlot(el('span', { class: 'hud__objective-text' }));
    this.objectiveGroup = el('div', {
      class: 'hud__objective',
      attrs: { role: 'status', 'aria-live': 'polite' },
      children: [this.objectiveKicker.node, this.objectiveText.node],
    });

    // ---- Tool + recovery readouts ---------------------------------------
    this.toolName = new TextSlot(el('span', { class: 'hud__tool-name' }));
    this.toolState = new TextSlot(el('span', { class: 'hud__tool-state' }));
    this.toolDetail = new TextSlot(el('span', { class: 'hud__tool-detail' }));
    this.recoveryLabel = new TextSlot(el('span', { class: 'hud__recovery-label' }));
    this.recoveryValue = new TextSlot(el('span', { class: 'hud__recovery-value' }));

    this.recoveryRow = el('div', {
      class: 'hud__recovery',
      children: [this.recoveryLabel.node, this.recoveryValue.node],
    });
    // Hidden until there is recovery state: the row carries a top border and
    // padding, so an empty one reads as a broken readout rather than nothing.
    this.recoveryRow.hidden = true;

    this.toolGroup = el('div', {
      class: 'hud__status',
      children: [
        el('div', {
          class: 'hud__tool',
          children: [this.toolName.node, this.toolState.node, this.toolDetail.node],
        }),
        this.recoveryRow,
      ],
    });

    // ---- Condition ------------------------------------------------------
    const healthFillNode = el('div', { class: 'hud__health-fill' });
    this.healthFill = new FillSlot(healthFillNode);
    this.healthValue = new TextSlot(el('span', { class: 'hud__health-value' }));
    this.healthGroup = el('div', {
      class: 'hud__health',
      attrs: { role: 'status', 'aria-live': 'off' },
      children: [
        el('span', { class: 'hud__health-label', text: 'Condition' }),
        el('div', { class: 'hud__health-track', children: [healthFillNode] }),
        this.healthValue.node,
      ],
    });

    // ---- Interaction prompt ---------------------------------------------
    // Both cue nodes exist from the start and are shown/hidden. Two nodes
    // rather than one repurposed node so the key path can never leave a key
    // name behind in the touch path, and so their styling has nothing in
    // common beyond position.
    this.promptKeyText = new TextSlot(el('span', { class: 'hud__prompt-key-text' }));
    this.promptKeyCue = el('span', {
      class: 'hud__prompt-key',
      children: [this.promptKeyText.node],
    });
    this.promptTouchText = new TextSlot(el('span', { class: 'hud__prompt-touch-text' }));
    this.promptTouchCue = el('span', {
      class: 'hud__prompt-touch',
      children: [this.promptTouchText.node],
    });
    this.promptKeyCue.hidden = true;
    this.promptTouchCue.hidden = true;

    this.promptVerb = new TextSlot(el('span', { class: 'hud__prompt-verb' }));
    this.promptLabel = new TextSlot(el('span', { class: 'hud__prompt-label' }));

    const promptHoldFillNode = el('div', { class: 'hud__prompt-hold-fill' });
    this.promptHoldFill = new FillSlot(promptHoldFillNode);
    this.promptHold = el('div', {
      class: 'hud__prompt-hold',
      attrs: {
        role: 'progressbar',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': '0',
        'aria-label': 'Hold progress',
      },
      children: [promptHoldFillNode],
    });
    this.promptHold.hidden = true;

    this.promptGroup = el('div', {
      class: 'hud__prompt',
      children: [
        this.promptKeyCue,
        this.promptTouchCue,
        el('span', {
          class: 'hud__prompt-copy',
          children: [this.promptVerb.node, this.promptLabel.node],
        }),
        this.promptHold,
      ],
    });

    // The rail keeps the two equipment readouts on one edge so they read as a
    // single panel rather than two floating widgets.
    const rail = el('div', {
      class: 'hud__rail',
      children: [this.toolGroup, this.healthGroup],
    });

    // `layer-passthrough` from base.css: the HUD reports state, it never eats
    // a tap. Every touchable control belongs to the touch control layer.
    this.root = el('div', {
      class: 'hud layer-passthrough',
      attrs: { 'aria-label': 'Status' },
    });
    append(this.root, this.objectiveGroup, rail, this.promptGroup);

    this.root.dataset.context = this.currentContext;
    this.applyVisibility();
    host.appendChild(this.root);
  }

  // ---- Subscription -----------------------------------------------------

  on<K extends keyof HudEvents>(event: K, handler: Handler<HudEvents[K]>): Unsubscribe {
    return this.emitter.on(event, handler);
  }

  off<K extends keyof HudEvents>(event: K, handler: Handler<HudEvents[K]>): void {
    this.emitter.off(event, handler);
  }

  // ---- Read model (wiring + tests) --------------------------------------

  get element(): HTMLElement {
    return this.root;
  }

  get context(): HudContext {
    return this.currentContext;
  }

  /** True when the group is both permitted by context and has content. */
  isGroupVisible(group: HudGroup): boolean {
    return !this.groupNode(group).hidden;
  }

  get objectiveLabel(): string | null {
    return this.objective?.text ?? null;
  }

  /** True while the objective card is in its revealed window. */
  get isObjectiveRevealed(): boolean {
    return this.objectiveRemaining > 0;
  }

  /** The on-screen control the current touch prompt points at, or null. */
  get touchHighlight(): string | null {
    return this.emittedHighlight;
  }

  // ---- Context ----------------------------------------------------------

  setContext(context: HudContext): void {
    if (context === this.currentContext) return;
    this.currentContext = context;
    this.root.dataset.context = context;

    // A cutscene or menu can start while the objective card is mid-reveal.
    // Cancel the reveal rather than resuming a stale one on the way out.
    if (!CONTEXT_POLICY[context].has('objective')) this.objectiveRemaining = 0;

    this.applyVisibility();
  }

  // ---- Objective --------------------------------------------------------

  /**
   * Sets the current objective, revealing the card when the text changes.
   *
   * "On change" is literal: re-setting the same objective (a save load, a
   * sector reload, a mission system that pushes state every step) must not
   * re-flash the card. {@link revealObjective} exists for the deliberate case.
   */
  setObjective(text: string | null, kicker = 'Objective'): void {
    if (text === null) {
      this.objective = null;
      this.objectiveRemaining = 0;
      this.objectiveText.set('');
      this.objectiveKicker.set('');
      this.applyVisibility();
      return;
    }

    const unchanged =
      this.objective !== null &&
      this.objective.text === text &&
      this.objective.kicker === kicker;

    this.objective = { text, kicker };
    this.objectiveKicker.set(kicker);
    this.objectiveText.set(text);

    if (!unchanged) this.reveal();
    else this.applyVisibility();
  }

  /** Re-reveals the current objective without changing it. */
  revealObjective(): void {
    if (!this.objective) return;
    this.reveal();
  }

  private reveal(): void {
    this.objectiveRemaining = this.objectiveHoldSeconds;
    this.applyVisibility();
  }

  // ---- Interaction prompt ----------------------------------------------

  /**
   * Shows or clears the interaction prompt.
   *
   * Dispatches on `input.family` to one of three render paths. The touch path
   * writes no key name anywhere and instead publishes which on-screen control
   * should be highlighted.
   */
  setInteractionPrompt(prompt: HudInteractionPrompt | null): void {
    this.prompt = prompt;

    if (!prompt) {
      // Clear both cues so a stale key name cannot survive into a touch
      // prompt (or the reverse) if the same object is re-targeted.
      this.clearPromptCues();
      this.promptVerb.set('');
      this.promptLabel.set('');
      this.holdProgress = 0;
      this.promptHold.hidden = true;
      this.applyVisibility();
      return;
    }

    this.promptVerb.set(VERB_LABELS[prompt.verb]);
    this.promptLabel.set(prompt.label);

    switch (prompt.input.family) {
      case 'keyboard':
        this.renderKeyCue(prompt.input.keyLabel, 'keyboard');
        break;
      case 'gamepad':
        this.renderKeyCue(prompt.input.glyph, 'gamepad');
        break;
      case 'touch':
        this.renderTouchCue(prompt.input.controlLabel ?? '');
        break;
    }

    const holdable = prompt.holdDuration > 0;
    this.promptHold.hidden = !holdable;
    this.holdProgress = holdable ? clamp01(prompt.holdProgress ?? 0) : 0;
    this.writeHold(this.holdProgress);

    this.applyVisibility();
  }

  /**
   * Keyboard and gamepad path: print the binding on a physical-looking cap.
   *
   * Shared because the two are the same idea — a named control the player can
   * see on the hardware in their hands. The family sits in a class so the cap
   * can be shaped differently per device without a second DOM branch.
   */
  private renderKeyCue(label: string, family: 'keyboard' | 'gamepad'): void {
    this.promptTouchCue.hidden = true;
    this.promptTouchText.set('');

    this.promptKeyText.set(label);
    this.promptKeyCue.classList.toggle('hud__prompt-key--gamepad', family === 'gamepad');
    this.promptKeyCue.hidden = false;
    this.promptGroup.dataset.family = family;
  }

  /**
   * Touch path: point at the on-screen control, never at a key.
   *
   * There is no keyboard on a phone, so "Press E" is not a shortcut, it is
   * wrong. The prompt instead shows the control's own printed label (when it
   * has one) and publishes `touch-highlight` so the touch control layer can
   * light up the actual button the player's thumb is already near.
   */
  private renderTouchCue(controlLabel: string): void {
    this.promptKeyCue.hidden = true;
    this.promptKeyText.set('');

    this.promptTouchText.set(controlLabel);
    this.promptTouchCue.hidden = false;
    this.promptGroup.dataset.family = 'touch';
  }

  private clearPromptCues(): void {
    this.promptKeyCue.hidden = true;
    this.promptKeyText.set('');
    this.promptTouchCue.hidden = true;
    this.promptTouchText.set('');
    delete this.promptGroup.dataset.family;
  }

  /**
   * Updates hold completion. Called from the render loop, so both the width
   * and the aria value are quantised to whole percent before being written.
   */
  setHoldProgress(progress: number): void {
    if (!this.prompt || this.prompt.holdDuration <= 0) return;
    this.holdProgress = clamp01(progress);
    this.writeHold(this.holdProgress);
  }

  get holdProgressValue(): number {
    return this.holdProgress;
  }

  private writeHold(progress: number): void {
    if (!this.promptHoldFill.set(progress)) return;
    const percent = Math.round(clamp01(progress) * 100);
    if (percent === this.lastAriaHoldPercent) return;
    this.lastAriaHoldPercent = percent;
    this.promptHold.setAttribute('aria-valuenow', String(percent));
  }

  // ---- Readouts ---------------------------------------------------------

  setToolStatus(status: HudToolStatus | null): void {
    this.tool = status;
    if (status) {
      this.toolName.set(status.tool);
      this.toolState.set(status.state);
      this.toolDetail.set(status.detail ?? '');
      this.toolGroup.dataset.toolState = status.state;
    } else {
      this.toolName.set('');
      this.toolState.set('');
      this.toolDetail.set('');
      delete this.toolGroup.dataset.toolState;
    }
    this.applyVisibility();
  }

  setRecoveryStatus(status: HudRecoveryStatus | null): void {
    this.recovery = status;
    if (status) {
      this.recoveryLabel.set(status.label);
      this.recoveryValue.set(status.value);
      this.recoveryRow.dataset.state = status.state;
      this.recoveryRow.hidden = false;
    } else {
      this.recoveryLabel.set('');
      this.recoveryValue.set('');
      delete this.recoveryRow.dataset.state;
      this.recoveryRow.hidden = true;
    }
    this.applyVisibility();
  }

  /**
   * Sets the condition readout.
   *
   * Hidden entirely at full health and dim below it; only at or under
   * {@link HudOptions.criticalHealthRatio} does it become prominent. Mara is a
   * technician in a flooded borough, not a soldier — a permanent health bar
   * would promise a combat game the campaign does not deliver.
   */
  setHealth(health: HudHealth | null): void {
    this.health = health;
    if (!health || health.max <= 0) {
      this.healthValue.set('');
      this.healthFill.set(0);
      this.healthGroup.classList.remove('hud__health--critical');
      this.healthGroup.setAttribute('aria-live', 'off');
      this.applyVisibility();
      return;
    }

    const ratio = clamp01(health.current / health.max);
    this.healthFill.set(ratio);
    this.healthValue.set(`${Math.round(ratio * 100)}%`);
    this.healthGroup.classList.toggle(
      'hud__health--critical',
      ratio <= this.criticalHealthRatio,
    );
    // Only a critical reading is worth interrupting a screen reader for.
    this.healthGroup.setAttribute(
      'aria-live',
      ratio <= this.criticalHealthRatio ? 'polite' : 'off',
    );
    this.applyVisibility();
  }

  // ---- Presentation clock ----------------------------------------------

  /**
   * Advances presentation-only timers.
   *
   * Fed the render delta, not the fixed step: the only thing it drives is how
   * long the objective card stays revealed. Nothing gameplay-relevant reads
   * this, which is why a variable delta is acceptable here and nowhere in
   * `game/` or `engine/physics`.
   */
  tick(dtSeconds: number): void {
    if (this.objectiveRemaining <= 0) return;
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return;

    this.objectiveRemaining -= dtSeconds;
    if (this.objectiveRemaining > 0) return;
    this.objectiveRemaining = 0;
    this.applyVisibility();
  }

  // ---- Visibility -------------------------------------------------------

  /**
   * Single place where "is this group on screen" is decided.
   *
   * Two independent conditions: the context must permit the group, and the
   * group must have something to show. Keeping them in one function is what
   * stops a cutscene from leaving a prompt behind because one setter forgot to
   * re-check the context.
   */
  private applyVisibility(): void {
    const allowed = CONTEXT_POLICY[this.currentContext];

    const objectiveVisible =
      allowed.has('objective') && this.objective !== null && this.objectiveRemaining > 0;
    const promptVisible = allowed.has('prompt') && this.prompt !== null;
    const toolVisible =
      allowed.has('tool') && (this.tool !== null || this.recovery !== null);
    const healthVisible =
      allowed.has('health') &&
      this.health !== null &&
      this.health.max > 0 &&
      this.health.current < this.health.max;

    this.objectiveGroup.hidden = !objectiveVisible;
    this.promptGroup.hidden = !promptVisible;
    this.toolGroup.hidden = !toolVisible;
    this.healthGroup.hidden = !healthVisible;

    this.publishTouchHighlight(promptVisible);
  }

  /**
   * Emits the touch highlight, keyed off *effective* prompt visibility.
   *
   * A cutscene hiding the prompt must also drop the highlight, otherwise a
   * touch button keeps glowing over a composed shot.
   */
  private publishTouchHighlight(promptVisible: boolean): void {
    const input = this.prompt?.input;
    const controlId =
      promptVisible && input?.family === 'touch' ? input.controlId : null;

    if (controlId === this.emittedHighlight) return;
    this.emittedHighlight = controlId;
    this.emitter.emit('touch-highlight', {
      controlId,
      verb: controlId ? (this.prompt?.verb ?? null) : null,
      label: controlId ? (this.prompt?.label ?? '') : '',
    });
  }

  private groupNode(group: HudGroup): HTMLElement {
    switch (group) {
      case 'objective':
        return this.objectiveGroup;
      case 'prompt':
        return this.promptGroup;
      case 'tool':
        return this.toolGroup;
      case 'health':
        return this.healthGroup;
    }
  }

  // ---- Lifecycle --------------------------------------------------------

  /** Clears every readout. For sector transitions and save loads. */
  reset(): void {
    this.setInteractionPrompt(null);
    this.setObjective(null);
    this.setToolStatus(null);
    this.setRecoveryStatus(null);
    this.setHealth(null);
    // Drop the write caches too: a reset is followed by a fresh push of the
    // same values as often as not, and those writes must reach the DOM.
    this.objectiveKicker.invalidate();
    this.objectiveText.invalidate();
    this.healthFill.invalidate();
    this.promptHoldFill.invalidate();
    this.lastAriaHoldPercent = -1;
  }

  dispose(): void {
    this.emitter.clear();
    remove(this.root);
  }
}
