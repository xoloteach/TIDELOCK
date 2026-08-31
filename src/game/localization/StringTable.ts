/**
 * Runtime string lookup (spec §75).
 *
 * The half of localization that runs while the player is walking. It resolves a
 * message id to text, substitutes named placeholders, and breaks a line to fit
 * the subtitle band. It holds one bundle, optionally over a fallback bundle, and
 * it never reaches the network or the disk — loading is the content loader's
 * job, so this class is synchronous and trivially testable.
 *
 * ## Missing-key policy
 *
 * A missing key is a content bug. It is also, at the moment it happens, one
 * prompt out of a two-hour campaign — so the policy is deliberately asymmetric:
 *
 *   1. **Never throw in the game.** `get()` on an unknown id returns a
 *      sentinel, `⟦tutorial.vault⟧`. The player loses one line of text; they do
 *      not lose the session, and a QA screenshot shows exactly which id is
 *      missing rather than an empty rectangle that could be anything.
 *   2. **Be loud, once.** The first miss for an id is reported through
 *      `onMissing` (default: `console.error`) and recorded in
 *      {@link StringTable.missingKeys}. Subsequent misses for the same id are
 *      silent. The HUD calls into this class every frame; a report per frame is
 *      a report nobody reads and a stall on a phone. This mirrors
 *      `RenderContext.render()`, which reports a missing `init()` once and then
 *      stays quiet for the same reason.
 *   3. **Fail loudly at build time instead.** `strict: true` makes a miss
 *      throw. That mode is for tests and content tooling, where a missing key
 *      *should* stop everything — never for the shipped game. The asymmetry is
 *      the point: the gate belongs in CI, not in the player's session.
 *
 * A missing *placeholder argument* follows the same rule: the token is left
 * visible, the miss is reported once, and nothing renders the word `undefined`.
 *
 * ## Line breaking
 *
 * Greedy word wrap against the locale's own budget, with a hard split for a
 * token longer than one line so no single word can overflow the band. The
 * budget comes from the bundle rather than from this file because it is a
 * property of the language — see `localizationSchema.ts`. `paginate()` groups
 * wrapped lines into cue-sized blocks, which is the shape `src/ui/Subtitles.ts`
 * consumes: consecutive cues, not one tall block that would cover the touch
 * controls.
 */

import {
  variantFallbackChain,
  type LocaleBundle,
  type LocaleMessage,
  type MessageId,
  type MessageVariantLevel,
} from './localizationSchema';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** Values substituted into named placeholders. Scalars only, so `String()` is total. */
export type MessageParams = Readonly<Record<string, string | number>>;

export type MissingKind =
  /** No bundle in the chain has this message id. */
  | 'message'
  /** The message exists, but a `{name}` in it had no argument supplied. */
  | 'placeholder';

export interface MissingReport {
  readonly kind: MissingKind;
  /** The message id that was asked for. */
  readonly id: MessageId;
  /** The placeholder name, for `kind: 'placeholder'`. */
  readonly placeholder?: string;
  readonly locale: string;
  /** Human-readable, already assembled. Safe to log verbatim. */
  readonly message: string;
}

export interface StringTableOptions {
  /**
   * Consulted when the primary bundle has no entry. One level deep only: a
   * chain of fallbacks hides which bundle a string actually came from.
   */
  readonly fallback?: LocaleBundle;
  /**
   * Throw on a miss instead of returning a sentinel.
   *
   * For tests and build-time content validation. Never enable it in a shipped
   * build — a missing prompt is not worth a crash to a player.
   */
  readonly strict?: boolean;
  /**
   * Where a first-time miss is reported. Defaults to `console.error`.
   *
   * Injectable so a test can assert loudness without spying on the console, and
   * so the diagnostics overlay can surface misses on-screen.
   */
  readonly onMissing?: (report: MissingReport) => void;
}

export interface LineBreakOptions {
  /** Overrides the locale budget and any per-message override. */
  readonly maxLineChars?: number;
  /** Overrides the locale's lines-per-cue. Used by `paginate`. */
  readonly maxLines?: number;
}

/**
 * Wraps a missing id so it is visible in a screenshot and greppable in a bug
 * report. Corner brackets rather than `[` or `<` because neither appears in
 * authored copy, so a sentinel can never be mistaken for text somebody wrote.
 */
export function missingKeySentinel(id: MessageId): string {
  return `\u27e6${id}\u27e7`;
}

const PLACEHOLDER_PATTERN = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

/** Sentinel for `{{` and `}}` while placeholders are being substituted. */
const ESCAPED_OPEN = '\u0000{';
const ESCAPED_CLOSE = '\u0000}';

// ---------------------------------------------------------------------------
// Line breaking
// ---------------------------------------------------------------------------

/**
 * Greedy word wrap. Pure, exported for the UI layer and for tooling.
 *
 * A token longer than `maxLineChars` is hard-split rather than allowed to
 * overflow: an asset path or a compound German noun must not push the subtitle
 * band into the touch zone. Existing newlines in the source are honoured as
 * deliberate breaks, because an author who typed one meant it.
 */
export function breakLines(text: string, maxLineChars: number): string[] {
  if (!Number.isFinite(maxLineChars) || maxLineChars < 1) return [text.trim()];

  const out: string[] = [];

  for (const paragraph of text.split('\n')) {
    const words = paragraph.trim().split(/\s+/).filter((w) => w.length > 0);
    let line = '';

    const flush = (): void => {
      if (line.length > 0) out.push(line);
      line = '';
    };

    for (const word of words) {
      if (word.length > maxLineChars) {
        flush();
        for (let i = 0; i < word.length; i += maxLineChars) {
          const chunk = word.slice(i, i + maxLineChars);
          if (chunk.length === maxLineChars) out.push(chunk);
          else line = chunk;
        }
        continue;
      }

      const candidate = line.length === 0 ? word : `${line} ${word}`;
      if (candidate.length <= maxLineChars) line = candidate;
      else {
        flush();
        line = word;
      }
    }

    flush();
  }

  return out.length > 0 ? out : [''];
}

/**
 * Groups wrapped lines into cue-sized blocks.
 *
 * Two lines per cue and consecutive cues, rather than one tall block: the band
 * sits in a narrow gap between the interaction prompt and the touch controls,
 * and growing it downward is what §90 fails a build for.
 */
export function paginate(lines: readonly string[], maxLines: number): string[] {
  if (!Number.isFinite(maxLines) || maxLines < 1) return [lines.join(' ')];
  const pages: string[] = [];
  for (let i = 0; i < lines.length; i += maxLines) {
    pages.push(lines.slice(i, i + maxLines).join('\n'));
  }
  return pages.length > 0 ? pages : [''];
}

// ---------------------------------------------------------------------------
// StringTable
// ---------------------------------------------------------------------------

export class StringTable {
  private readonly bundle: LocaleBundle;
  private readonly fallback: LocaleBundle | undefined;
  private readonly strict: boolean;
  private readonly report: (report: MissingReport) => void;

  /** Ids already reported, so a per-frame caller reports once and not sixty times. */
  private readonly reported = new Set<string>();
  /** Every distinct miss, in first-seen order. Drives the diagnostics overlay. */
  private readonly missing = new Set<MessageId>();

  constructor(bundle: LocaleBundle, options: StringTableOptions = {}) {
    this.bundle = bundle;
    this.fallback = options.fallback;
    this.strict = options.strict ?? false;
    this.report =
      options.onMissing ??
      ((report) => {
        console.error(`[localization] ${report.message}`);
      });
  }

  // ---- Metadata --------------------------------------------------------

  get locale(): string {
    return this.bundle.locale;
  }

  get displayName(): string {
    return this.bundle.displayName;
  }

  get completeness(): number {
    return this.bundle.completeness;
  }

  get textDirection(): 'ltr' | 'rtl' {
    return this.bundle.textDirection;
  }

  /** Layout multiplier for reserving space in this locale (spec §75 UI expansion). */
  get expansionAllowance(): number {
    return this.bundle.expansionAllowance;
  }

  // ---- Lookup ----------------------------------------------------------

  /** Whether an id resolves, in the primary bundle or the fallback. Never reports. */
  has(id: MessageId): boolean {
    return this.lookup(id) !== undefined;
  }

  /**
   * Resolves an id and substitutes its placeholders.
   *
   * Applies the missing-key policy documented on this class: a sentinel and one
   * report, or a throw under `strict`.
   */
  get(id: MessageId, params: MessageParams = {}): string {
    const message = this.lookup(id);
    if (!message) {
      this.reportMissing({
        kind: 'message',
        id,
        locale: this.bundle.locale,
        message: `no message "${id}" in locale "${this.bundle.locale}"`,
      });
      return missingKeySentinel(id);
    }
    return this.interpolate(id, message.text, params);
  }

  /**
   * First id in `ids` that resolves.
   *
   * Reports only when *every* candidate misses, and reports the first — the most
   * specific one — because that is the id somebody meant to author. Walking a
   * chain is the normal case, not an error, so a miss on `tutorial.x.hint` that
   * falls through to `tutorial.x` must stay silent.
   */
  resolveFirst(ids: readonly MessageId[], params: MessageParams = {}): string {
    for (const id of ids) {
      const message = this.lookup(id);
      if (message) return this.interpolate(id, message.text, params);
    }
    const primary = ids[0] ?? '';
    this.reportMissing({
      kind: 'message',
      id: primary,
      locale: this.bundle.locale,
      message:
        ids.length > 1
          ? `no message for any of ${ids.map((i) => `"${i}"`).join(', ')} in locale "${this.bundle.locale}"`
          : `no message "${primary}" in locale "${this.bundle.locale}"`,
    });
    return missingKeySentinel(primary);
  }

  /**
   * A tutorial prompt at an escalation level (spec §86.6).
   *
   * Level 1 is the base id; 2 and 3 try `.strong` and `.hint` and fall back down
   * the ladder, so a tutorial only authors the stronger wordings that are worth
   * writing. This is the method `TutorialSystem`'s `TutorialPresentation` is
   * shaped for: it hands the HUD a `messageKey` and a `level`, and nothing else.
   */
  escalated(
    baseId: MessageId,
    level: MessageVariantLevel,
    params: MessageParams = {},
  ): string {
    return this.resolveFirst(variantFallbackChain(baseId, level), params);
  }

  // ---- Layout ----------------------------------------------------------

  /**
   * Resolved text, wrapped to the locale's line budget.
   *
   * The per-message `maxLineChars` override wins over the locale budget, and an
   * explicit option wins over both — a settings screen offering larger subtitles
   * needs to narrow the budget without editing content.
   */
  lines(id: MessageId, params: MessageParams = {}, options: LineBreakOptions = {}): string[] {
    const message = this.lookup(id);
    const text = this.get(id, params);
    const maxLineChars =
      options.maxLineChars ?? message?.maxLineChars ?? this.bundle.lineBudget.maxLineChars;
    return breakLines(text, maxLineChars);
  }

  /**
   * Resolved text, wrapped and grouped into cues of at most `maxLines` lines.
   *
   * One entry means the string fits the band in a single cue; more than one
   * means the UI must show them in sequence.
   */
  cues(id: MessageId, params: MessageParams = {}, options: LineBreakOptions = {}): string[] {
    const maxLines = options.maxLines ?? this.bundle.lineBudget.maxLines;
    return paginate(this.lines(id, params, options), maxLines);
  }

  // ---- Diagnostics -----------------------------------------------------

  /** Every distinct missing id seen so far, in first-seen order. */
  missingKeys(): MessageId[] {
    return [...this.missing];
  }

  /**
   * Forgets what has been reported, so the next miss is loud again.
   *
   * Called when the locale changes or a new sector's content is registered: the
   * dedupe exists to stop per-frame spam, not to hide a second genuine bug.
   */
  clearMissing(): void {
    this.reported.clear();
    this.missing.clear();
  }

  // ---- Internals -------------------------------------------------------

  private lookup(id: MessageId): LocaleMessage | undefined {
    return this.bundle.messages[id] ?? this.fallback?.messages[id];
  }

  /**
   * Substitutes `{name}` tokens.
   *
   * An unsupplied token is left in place rather than replaced with `undefined`
   * or an empty string: a visible `{binding}` tells a tester what failed, and an
   * empty string produces the sentence "Interact — " which reads like a
   * rendering bug with no clue attached.
   */
  private interpolate(id: MessageId, text: string, params: MessageParams): string {
    const escaped = text.replace(/\{\{/g, ESCAPED_OPEN).replace(/\}\}/g, ESCAPED_CLOSE);

    const substituted = escaped.replace(PLACEHOLDER_PATTERN, (token, name: string) => {
      const value = params[name];
      if (value === undefined) {
        this.reportMissing({
          kind: 'placeholder',
          id,
          placeholder: name,
          locale: this.bundle.locale,
          message: `message "${id}" needs placeholder "${name}", which was not supplied`,
        });
        return token;
      }
      return String(value);
    });

    return substituted.split(ESCAPED_OPEN).join('{').split(ESCAPED_CLOSE).join('}');
  }

  private reportMissing(report: MissingReport): void {
    if (report.kind === 'message') this.missing.add(report.id);

    if (this.strict) throw new Error(report.message);

    const dedupeKey =
      report.placeholder === undefined ? report.id : `${report.id}#${report.placeholder}`;
    if (this.reported.has(dedupeKey)) return;
    this.reported.add(dedupeKey);
    this.report(report);
  }
}
