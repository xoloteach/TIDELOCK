import { el, remove } from './dom';
import { Emitter, type Handler, type Unsubscribe } from '../engine/events';
import type { AccessibilitySettings } from '../persistence/settingsSchema';

import './styles/subtitles.css';

/**
 * Subtitle band.
 *
 * TIDELOCK is 300+ voiced lines of overlapping radio traffic and half-finished
 * sentences, most of it delivered while the player is walking, wading or
 * turning a valve. That makes subtitles load-bearing rather than an
 * accessibility afterthought, and it produces two requirements that shape this
 * class:
 *
 *   1. **Consecutive lines queue.** Dialogue lines arrive back-to-back and
 *      sometimes overlap. Writing each new line straight into the band would
 *      wipe the previous one mid-read. Lines are therefore queued with their
 *      own durations and presented in order.
 *   2. **The band never covers the controls.** On a phone the bottom corners
 *      belong to the joystick and the action buttons, and the interaction
 *      prompt sits directly above them. The band is positioned in the gap
 *      between the prompt and the touch zone — see `subtitles.css`, where the
 *      arithmetic and the reservation are written down.
 *
 * Long lines are split into consecutive cues rather than wrapped into a block:
 * the cap is tuned to the narrowest supported viewport (667×375 phone
 * landscape), so a cue that fits there fits everywhere and the same authored
 * timing works on every device.
 *
 * Timing is advanced by {@link Subtitles.tick} from the render loop rather than
 * by `setTimeout`. Timers drift under load, cannot be paused with the game, and
 * make tests depend on wall-clock behaviour.
 */

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface SubtitleLine {
  /** Stable id from the authored dialogue node. Optional for system lines. */
  readonly id?: string;
  /**
   * Display name of the speaker, or null for unattributed audio — a PA
   * announcement, a recovered archive recording, a radio with no callsign.
   */
  readonly speaker: string | null;
  readonly text: string;
  /**
   * Seconds on screen. Non-positive or non-finite values fall back to a
   * reading-speed estimate, so a line with missing audio metadata is still
   * readable instead of flashing for one frame.
   */
  readonly duration: number;
}

/** A cue actually on screen: one segment of a possibly-split line. */
interface SubtitleCue {
  readonly line: SubtitleLine;
  readonly text: string;
  readonly duration: number;
}

export interface SubtitlesOptions {
  /** Characters per rendered line. Tuned for 667×375 landscape. */
  readonly maxLineChars?: number;
  /** Rendered lines per cue. Two keeps the band short enough to stay clear. */
  readonly maxLines?: number;
  /** Characters per second used when a line has no usable duration. */
  readonly readingCharsPerSecond?: number;
  /** Floor for an estimated duration, in seconds. */
  readonly minEstimatedSeconds?: number;
}

/**
 * Declared as a type alias, not an interface, so TypeScript infers the implicit
 * index signature the `EventMap` constraint needs.
 */
type SubtitleEvents = {
  /**
   * The visible cue changed, or went to null when the band emptied. The
   * sequence and dialogue systems use this to know the band is clear before
   * cutting a shot.
   */
  'cue-changed': { line: SubtitleLine | null; text: string };
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * 56 characters is what fits one line of the band at 667×375 with the side
 * insets that keep the corner touch zones clear. Desktop has more room, but
 * splitting on the phone budget everywhere means one authored timing.
 */
const DEFAULT_MAX_LINE_CHARS = 56;
const DEFAULT_MAX_LINES = 2;
/** ~15 char/s is a comfortable read; broadcast guidance sits near this. */
const DEFAULT_READING_CHARS_PER_SECOND = 15;
const DEFAULT_MIN_ESTIMATED_SECONDS = 1.2;

/**
 * Upper bound on cues drained in one `tick`. A frame that takes half a second
 * should roll through expired cues rather than stall the queue, but it must not
 * be able to flush an entire conversation unseen either.
 */
const MAX_DRAIN_PER_TICK = 8;

// ---------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------

export class Subtitles {
  private readonly emitter = new Emitter<SubtitleEvents>();

  private readonly root: HTMLElement;
  private readonly cueNode: HTMLElement;
  private readonly speakerNode: HTMLElement;
  private readonly textNode: HTMLElement;

  private readonly maxLineChars: number;
  private readonly maxLines: number;
  private readonly readingCharsPerSecond: number;
  private readonly minEstimatedSeconds: number;

  private settings: AccessibilitySettings;

  private queue: SubtitleCue[] = [];
  private current: SubtitleCue | null = null;
  private remaining = 0;

  /** Cached DOM values so unchanged text is never rewritten. */
  private lastSpeakerText = '';
  private lastCueText = '';

  constructor(
    host: HTMLElement,
    settings: AccessibilitySettings,
    options: SubtitlesOptions = {},
  ) {
    this.settings = settings;
    this.maxLineChars = options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.readingCharsPerSecond =
      options.readingCharsPerSecond ?? DEFAULT_READING_CHARS_PER_SECOND;
    this.minEstimatedSeconds =
      options.minEstimatedSeconds ?? DEFAULT_MIN_ESTIMATED_SECONDS;

    this.speakerNode = el('span', { class: 'subtitles__speaker' });
    this.textNode = el('span', { class: 'subtitles__text' });
    this.cueNode = el('p', {
      class: 'subtitles__cue',
      children: [this.speakerNode, this.textNode],
    });

    // The whole band is one polite live region with aria-atomic, so a screen
    // reader announces "Sera Holt: ..." as a unit instead of two fragments.
    // `layer-passthrough` guarantees the band cannot swallow a tap aimed at
    // the world or at a touch control underneath it.
    this.root = el('div', {
      class: 'subtitles layer-passthrough',
      attrs: {
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'true',
        'aria-label': 'Subtitles',
      },
      children: [this.cueNode],
    });

    this.applySettings(settings);
    this.renderCue();
    host.appendChild(this.root);
  }

  // ---- Subscription -----------------------------------------------------

  on<K extends keyof SubtitleEvents>(
    event: K,
    handler: Handler<SubtitleEvents[K]>,
  ): Unsubscribe {
    return this.emitter.on(event, handler);
  }

  off<K extends keyof SubtitleEvents>(
    event: K,
    handler: Handler<SubtitleEvents[K]>,
  ): void {
    this.emitter.off(event, handler);
  }

  // ---- Read model (wiring + tests) --------------------------------------

  get element(): HTMLElement {
    return this.root;
  }

  get isVisible(): boolean {
    return !this.root.hidden && this.current !== null;
  }

  /** The line currently on screen, or null. */
  get currentLine(): SubtitleLine | null {
    return this.current?.line ?? null;
  }

  /** Exactly what the band is showing, after splitting. */
  get visibleText(): string {
    return this.current?.text ?? '';
  }

  /** The speaker name as rendered, which is '' when names are switched off. */
  get visibleSpeaker(): string {
    return this.speakerNode.textContent ?? '';
  }

  /** Seconds left on the current cue. */
  get remainingSeconds(): number {
    return this.remaining;
  }

  /** Cues waiting behind the current one. */
  get queueLength(): number {
    return this.queue.length;
  }

  // ---- Settings ---------------------------------------------------------

  /**
   * Applies accessibility settings.
   *
   * Scale is written to a local custom property rather than the global
   * `--a11y-subtitle-scale` token: that token belongs to the accessibility
   * application layer, and if both wrote from the same setting the scale would
   * be applied twice.
   *
   * Turning subtitles off clears the queue. Keeping it would mean re-enabling
   * them mid-scene dumps a backlog of lines whose audio has already played.
   */
  applySettings(settings: AccessibilitySettings): void {
    this.settings = settings;

    this.root.hidden = !settings.subtitles;
    this.root.style.setProperty('--sub-scale', String(settings.subtitleScale));
    this.root.classList.toggle(
      'subtitles--bg-none',
      settings.subtitleBackground === 'none',
    );
    this.root.classList.toggle(
      'subtitles--bg-shadow',
      settings.subtitleBackground === 'shadow',
    );
    this.root.classList.toggle(
      'subtitles--bg-solid',
      settings.subtitleBackground === 'solid',
    );
    this.root.classList.toggle('subtitles--contrast', settings.highContrastSubtitles);

    if (!settings.subtitles) {
      this.clear();
      return;
    }

    // Speaker visibility can change while a line is on screen.
    this.renderCue();
  }

  // ---- Queue -----------------------------------------------------------

  /**
   * Queues a line, presenting it immediately when the band is free.
   *
   * Returns the number of cues the line became: more than one when it was too
   * long for the band and had to be split.
   */
  show(line: SubtitleLine): number {
    // Dropped rather than queued: the audio plays regardless, and a backlog of
    // lines the player chose not to read is worse than none.
    if (!this.settings.subtitles) return 0;

    const text = line.text.trim();
    if (text.length === 0) return 0;

    const duration = this.resolveDuration(line, text);
    const segments = this.splitToCues(text);
    const totalChars = segments.reduce((sum, segment) => sum + segment.length, 0);

    const cues: SubtitleCue[] = [];
    let allocated = 0;
    segments.forEach((segment, index) => {
      // Proportional to segment length, with the last segment absorbing the
      // rounding so the cues always sum to the authored duration and never
      // drift out of sync with the voice clip.
      const isLast = index === segments.length - 1;
      const share = isLast
        ? duration - allocated
        : (duration * segment.length) / totalChars;
      allocated += share;
      cues.push({ line, text: segment, duration: share });
    });

    this.queue.push(...cues);
    if (!this.current) this.advance();
    return cues.length;
  }

  /** Queues several lines in order. */
  showAll(lines: readonly SubtitleLine[]): void {
    for (const line of lines) this.show(line);
  }

  /**
   * Finishes the current cue immediately and presents the next.
   *
   * Used when the player advances dialogue faster than the timing allows.
   */
  advanceCue(): void {
    if (!this.current) return;
    this.advance();
  }

  /**
   * Force-clears the band: current cue and everything queued.
   *
   * Called on cutscene skip, dialogue abort, sector transition and save load.
   * Anything less than a full clear leaves lines from the skipped scene
   * appearing over the next one.
   */
  clear(): void {
    const had = this.current !== null || this.queue.length > 0;
    this.queue = [];
    this.current = null;
    this.remaining = 0;
    this.renderCue();
    if (had) this.emitter.emit('cue-changed', { line: null, text: '' });
  }

  // ---- Clock -----------------------------------------------------------

  /**
   * Advances cue timing. Fed the render delta; presentation only.
   *
   * Surplus time rolls into the next cue so a long frame does not silently add
   * latency to every remaining line of a conversation.
   */
  tick(dtSeconds: number): void {
    if (!this.current) return;
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return;

    this.remaining -= dtSeconds;

    let drained = 0;
    while (this.current && this.remaining <= 0 && drained < MAX_DRAIN_PER_TICK) {
      const carry = -this.remaining;
      this.advance();
      if (this.current) this.remaining -= carry;
      drained += 1;
    }
  }

  // ---- Internals -------------------------------------------------------

  /** Pops the next queued cue, or empties the band. */
  private advance(): void {
    const next = this.queue.shift() ?? null;
    this.current = next;
    this.remaining = next?.duration ?? 0;
    this.renderCue();
    this.emitter.emit('cue-changed', {
      line: next?.line ?? null,
      text: next?.text ?? '',
    });
  }

  /**
   * Writes the cue into the DOM, change-gated.
   *
   * `renderCue` runs on every advance and on every settings change, and the
   * band is inside an `aria-live` region: rewriting identical text would make a
   * screen reader repeat a line the player is still reading.
   */
  private renderCue(): void {
    const showSpeaker =
      this.settings.subtitleSpeakerNames && (this.current?.line.speaker ?? null) !== null;
    const speakerText = showSpeaker ? (this.current?.line.speaker ?? '') : '';
    const cueText = this.current?.text ?? '';

    if (speakerText !== this.lastSpeakerText) {
      this.lastSpeakerText = speakerText;
      this.speakerNode.textContent = speakerText;
    }

    if (cueText !== this.lastCueText) {
      this.lastCueText = cueText;
      this.textNode.textContent = cueText;
    }

    // Visibility is derived from the same values but cached separately: it has
    // to be established on the first render, when the cached text and the new
    // text are both '' and the writes above are correctly skipped.
    const speakerHidden = speakerText.length === 0;
    if (this.speakerNode.hidden !== speakerHidden) this.speakerNode.hidden = speakerHidden;

    const cueHidden = cueText.length === 0;
    if (this.cueNode.hidden !== cueHidden) this.cueNode.hidden = cueHidden;
  }

  private resolveDuration(line: SubtitleLine, text: string): number {
    if (Number.isFinite(line.duration) && line.duration > 0) return line.duration;
    return Math.max(
      this.minEstimatedSeconds,
      text.length / this.readingCharsPerSecond,
    );
  }

  /**
   * Splits text into cue-sized chunks, breaking on whitespace.
   *
   * Capacity is `maxLineChars * maxLines`. A single word longer than one
   * rendered line (a long asset id, a URL in a note) is hard-split rather than
   * allowed to overflow the band — CSS would either clip it or push the band
   * over the touch controls, and both are worse than a break mid-token.
   */
  private splitToCues(text: string): string[] {
    const capacity = this.maxLineChars * this.maxLines;
    if (text.length <= capacity) return [text];

    const chunks: string[] = [];
    let chunk = '';

    for (const word of text.split(/\s+/)) {
      let token = word;

      while (token.length > capacity) {
        if (chunk.length > 0) {
          chunks.push(chunk);
          chunk = '';
        }
        chunks.push(token.slice(0, capacity));
        token = token.slice(capacity);
      }

      const candidate = chunk.length === 0 ? token : `${chunk} ${token}`;
      if (candidate.length <= capacity) {
        chunk = candidate;
        continue;
      }
      if (chunk.length > 0) chunks.push(chunk);
      chunk = token;
    }

    if (chunk.length > 0) chunks.push(chunk);
    return chunks.length > 0 ? chunks : [text];
  }

  // ---- Lifecycle -------------------------------------------------------

  dispose(): void {
    this.emitter.clear();
    this.queue = [];
    this.current = null;
    remove(this.root);
  }
}
