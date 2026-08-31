/**
 * Locale bundle data model (spec §75).
 *
 * Every string a player reads lives in `content/localization/<locale>.json` and
 * is addressed by a stable message id. Nothing in `src/` may hold player-facing
 * prose: a tutorial definition carries a `messageKey`, a HUD element carries an
 * id, and the text arrives from a bundle at load time. That is the whole point
 * of §75 — the release language is English, but English is *content*, not code.
 *
 * The bundle is deliberately more than a flat `Record<string, string>`, and each
 * extra field pays for itself:
 *
 *   `placeholders`   Declared named slots. The linter cross-checks them against
 *                    the `{name}` tokens actually present, so a typo becomes a
 *                    load-time error instead of a `{acton}` rendered to a
 *                    player. It is also the contract a translator needs: which
 *                    tokens must survive translation, and which are prose.
 *   `note`           Translator context. A terse municipal instruction cannot
 *                    be translated correctly without knowing what object it is
 *                    pointing at.
 *   `voice`          The §75 "future voice mapping" hook: a message id may name
 *                    a voice/clip id so the Edge-TTS pipeline can bind a spoken
 *                    take to a localised line without a second index.
 *   `maxLineChars`   Per-message override of the locale's line budget, for the
 *                    rare string that must not break where the default would
 *                    break it.
 *
 * Escalation and input family are *not* variant fields on a message. Escalation
 * uses flat sibling ids (`tutorial.vault`, `tutorial.vault.strong`,
 * `tutorial.vault.hint`) so every level is independently addressable and stable,
 * and input family is resolved by the renderer from the live keymap (spec §86.4)
 * rather than authored three times per locale.
 *
 * Two layers of checking, deliberately separate — the same split as
 * `dialogueSchema.ts`:
 *
 *   `localeBundleSchema`   — shape validation (Zod). Rejects malformed data at
 *                            load time. Objects are strict, so a typo like
 *                            `placeholder` fails loudly instead of being
 *                            dropped and silently ignored.
 *   `validateLocaleBundle` — authoring lint over an already-typed bundle.
 *                            Errors are structural bugs (a placeholder that is
 *                            declared but absent, a variant with no base id).
 *                            Warnings are the tone and layout signals: an
 *                            exclamation mark, trailer-speak, a line that will
 *                            not fit the subtitle band on a phone.
 */

import { z } from 'zod';
import {
  findBannedPhrases,
  findPlaceholderMarkers,
  type IssueSeverity,
  type ValidationIssue,
  type ValidationResult,
} from '../dialogue/dialogueSchema';

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** Stable authored message id, e.g. `tutorial.vault`. Aliased for readability. */
export type MessageId = string;

/** BCP-47-ish locale code, e.g. `en` or `pt-BR`. */
export type LocaleCode = string;

export const LOCALIZATION_SCHEMA_VERSION = 1;

/**
 * Message ids must be namespaced — at least one dot.
 *
 * The namespace is load-bearing, not cosmetic: `tutorialSchema.validateTutorials`
 * already rejects a `messageKey` that does not start with `tutorial.`, and the
 * same rule is what lets tooling ask "which strings does the HUD own" without a
 * hand-maintained list.
 */
const MESSAGE_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-zA-Z0-9-]+)+$/;

export const messageIdSchema = z
  .string()
  .regex(MESSAGE_ID_PATTERN, 'message id must be namespaced, e.g. "tutorial.vault"');

/** `en`, `en-GB`, `pt-BR`. Case is part of the convention, so it is enforced. */
const LOCALE_CODE_PATTERN = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;

export const localeCodeSchema = z
  .string()
  .regex(LOCALE_CODE_PATTERN, 'locale must look like "en" or "pt-BR"');

// ---------------------------------------------------------------------------
// Escalation variants (spec §86.6)
// ---------------------------------------------------------------------------

/**
 * Suffixes for the escalation ladder a tutorial climbs when the player keeps
 * failing: normal prompt, stronger prompt, hint.
 *
 * Level 1 is the bare id, so the common case — a tutorial the player clears
 * immediately — needs exactly one authored string.
 */
export const MESSAGE_VARIANT_SUFFIXES = {
  1: '',
  2: '.strong',
  3: '.hint',
} as const;

export type MessageVariantLevel = 1 | 2 | 3;

/** Every suffix except the level-1 empty string. Used to spot orphan variants. */
export const VARIANT_SUFFIXES: readonly string[] = ['.strong', '.hint'];

/**
 * The id for a message at an escalation level.
 *
 * Callers resolve the returned chain with a fallback, not a single lookup — see
 * {@link variantFallbackChain}. A tutorial that never needed a stronger wording
 * should not have to author one to avoid a missing-key report.
 */
export function variantMessageId(base: MessageId, level: MessageVariantLevel): MessageId {
  return `${base}${MESSAGE_VARIANT_SUFFIXES[level]}`;
}

/**
 * Ids to try, most specific first, for a message at an escalation level.
 *
 * Level 3 falls back through level 2 to the base: a hint is a better thing to
 * show than a sentinel, and the base line is a better thing to show than a
 * hint that was never written.
 */
export function variantFallbackChain(
  base: MessageId,
  level: MessageVariantLevel,
): readonly MessageId[] {
  const chain: MessageId[] = [];
  for (let l = level; l >= 1; l -= 1) {
    chain.push(variantMessageId(base, l as MessageVariantLevel));
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

/**
 * Named placeholders only: `{action}`, never `{0}`.
 *
 * Positional slots reorder wrongly the moment a translator moves a clause, and
 * they carry no meaning for whoever is translating. `{{` escapes a literal
 * brace, which is why the pattern refuses one.
 */
const PLACEHOLDER_PATTERN = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

export const placeholderNameSchema = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'placeholder names are identifiers, not positions');

/** Placeholder names appearing in a string, in first-use order, deduplicated. */
export function extractPlaceholders(text: string): string[] {
  const found: string[] = [];
  // Braces doubled to escape a literal brace must not read as a placeholder.
  const scannable = text.replace(/\{\{|\}\}/g, '');
  for (const match of scannable.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1] as string;
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Bundle shape
// ---------------------------------------------------------------------------

export interface LocaleMessage {
  /** The player-visible string. The only required field. */
  text: string;
  /**
   * Named slots the text must contain. Absent means "no slots"; an empty array
   * says the same thing explicitly and is accepted so generated bundles need no
   * special case.
   */
  placeholders?: string[];
  /** Context for whoever translates this. Never shown to a player. */
  note?: string;
  /** Overrides the locale's `lineBudget.maxLineChars` for this message alone. */
  maxLineChars?: number;
  /** Voice or clip id for a spoken take of this line (spec §75, §73). */
  voice?: string;
}

export const localeMessageSchema = z.strictObject({
  text: z.string().min(1),
  placeholders: z.array(placeholderNameSchema).optional(),
  note: z.string().min(1).optional(),
  maxLineChars: z.number().int().positive().optional(),
  voice: z.string().min(1).optional(),
});

/**
 * The layout budget a locale is authored against.
 *
 * Tuned to the narrowest supported viewport rather than the widest, so a string
 * that fits on a 667×375 phone in landscape fits everywhere and one authored
 * timing works on every device — the same reasoning, and the same numbers, as
 * `src/ui/Subtitles.ts`. It lives in the bundle because it is a property of the
 * *language*: a locale whose words run longer legitimately needs a different
 * break point.
 */
export interface LocaleLineBudget {
  /** Characters per rendered line before the line breaker splits. */
  maxLineChars: number;
  /** Rendered lines per cue. Two keeps the subtitle band clear of touch zones. */
  maxLines: number;
}

export const localeLineBudgetSchema = z.strictObject({
  maxLineChars: z.number().int().min(16),
  maxLines: z.number().int().min(1).max(4),
});

export interface LocaleBundle {
  version: number;
  locale: LocaleCode;
  /** Endonym, shown in the language picker. `Deutsch`, not `German`. */
  displayName: string;
  /** English exonym, for bug reports and tooling. */
  englishName: string;
  textDirection: 'ltr' | 'rtl';
  /**
   * Fraction of the source locale's message set that is translated, 0–1.
   *
   * Authored rather than computed so a partially-translated bundle can ship and
   * declare itself as such. The language picker uses it to warn; the string
   * table uses it for nothing, because a missing key is handled by policy
   * whatever the headline number claims.
   */
  completeness: number;
  /** Locale to consult for a missing key. Null for a source locale. */
  fallbackLocale: LocaleCode | null;
  /**
   * How much longer this locale's strings run than the source, as a multiplier
   * (spec §75 "UI expansion"). Layout reserves space with it, so a German
   * bundle declaring 1.35 does not clip its own buttons.
   */
  expansionAllowance: number;
  lineBudget: LocaleLineBudget;
  messages: Record<MessageId, LocaleMessage>;
}

export const localeBundleSchema = z.strictObject({
  version: z.number().int().positive(),
  locale: localeCodeSchema,
  displayName: z.string().min(1),
  englishName: z.string().min(1),
  textDirection: z.enum(['ltr', 'rtl']),
  completeness: z.number().min(0).max(1),
  fallbackLocale: localeCodeSchema.nullable(),
  expansionAllowance: z.number().min(1).max(3),
  lineBudget: localeLineBudgetSchema,
  messages: z.record(messageIdSchema, localeMessageSchema),
});

/**
 * Parses authored locale data, throwing on malformed input.
 *
 * Content loading is a fatal path: a bundle that fails to parse means a game
 * whose every prompt is a sentinel, so it must not be swallowed. Note what this
 * does *not* do — a bundle that parses but is missing a key the game asks for
 * later is a runtime concern, handled by the string table's missing-key policy,
 * because losing one prompt must not cost the player their session.
 */
export function parseLocaleBundle(raw: unknown): LocaleBundle {
  const parsed = localeBundleSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid locale bundle: ${detail}`);
  }
  if (parsed.data.version !== LOCALIZATION_SCHEMA_VERSION) {
    throw new Error(
      `invalid locale bundle: version ${parsed.data.version} is not the supported version ${LOCALIZATION_SCHEMA_VERSION}`,
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Bundle validation
// ---------------------------------------------------------------------------

export type LocalizationIssueCode =
  // Errors
  | 'undeclared-placeholder'
  | 'missing-declared-placeholder'
  | 'duplicate-declared-placeholder'
  | 'unbalanced-brace'
  | 'placeholder-text'
  | 'orphan-variant'
  | 'self-fallback'
  // Warnings
  | 'over-line-budget'
  | 'exclamation-mark'
  | 'banned-phrase'
  | 'completeness-overstated';

export type LocalizationValidationResult = ValidationResult<LocalizationIssueCode>;

function issue(
  code: LocalizationIssueCode,
  severity: IssueSeverity,
  message: string,
  target?: string,
): ValidationIssue<LocalizationIssueCode> {
  return target === undefined
    ? { code, severity, message }
    : { code, severity, message, target };
}

/**
 * A brace that is neither part of a placeholder nor escaped.
 *
 * Caught explicitly because the failure is invisible: `{action` renders
 * literally, so a player sees a stray brace and the interpolation silently
 * never happens.
 */
function hasUnbalancedBrace(text: string): boolean {
  const stripped = text.replace(/\{\{|\}\}/g, '').replace(PLACEHOLDER_PATTERN, '');
  return stripped.includes('{') || stripped.includes('}');
}

/**
 * Lints an authored bundle.
 *
 * Takes the typed `LocaleBundle` rather than raw data on purpose: shape is the
 * schema's job, and this way the linter can be pointed at a bundle built in a
 * test or produced by a future translation-management export.
 *
 * The tone warnings are not style policing. TIDELOCK's copy is terse, physical
 * and municipal; an exclamation mark in a tutorial prompt is the exact tell of
 * generic game-tutorial voice, and the shared `BANNED_PHRASES` list catches the
 * trailer-speak that makes a grounded infrastructure drama sound like a teaser.
 * Both are warnings rather than errors because a translator may have a
 * legitimate reason, and a warning is a conversation.
 */
export function validateLocaleBundle(bundle: LocaleBundle): LocalizationValidationResult {
  const errors: ValidationIssue<LocalizationIssueCode>[] = [];
  const warnings: ValidationIssue<LocalizationIssueCode>[] = [];

  // --- bundle-level -------------------------------------------------------
  if (bundle.fallbackLocale === bundle.locale) {
    errors.push(
      issue(
        'self-fallback',
        'error',
        `locale "${bundle.locale}" declares itself as its own fallback, which cannot resolve anything`,
        bundle.locale,
      ),
    );
  }

  const ids = Object.keys(bundle.messages);

  if (bundle.completeness === 1 && bundle.fallbackLocale !== null) {
    warnings.push(
      issue(
        'completeness-overstated',
        'warning',
        `locale "${bundle.locale}" claims full completeness but still declares a fallback locale`,
        bundle.locale,
      ),
    );
  }

  // --- per-message --------------------------------------------------------
  for (const id of ids) {
    const message = bundle.messages[id] as LocaleMessage;
    const used = extractPlaceholders(message.text);
    const declared = message.placeholders ?? [];

    const seenDeclared = new Set<string>();
    for (const name of declared) {
      if (seenDeclared.has(name)) {
        errors.push(
          issue(
            'duplicate-declared-placeholder',
            'error',
            `"${id}" declares placeholder "${name}" twice`,
            id,
          ),
        );
      }
      seenDeclared.add(name);
    }

    for (const name of used) {
      if (!seenDeclared.has(name)) {
        errors.push(
          issue(
            'undeclared-placeholder',
            'error',
            `"${id}" uses {${name}} but does not declare it — an undeclared slot is one a translator may delete`,
            id,
          ),
        );
      }
    }

    for (const name of seenDeclared) {
      if (!used.includes(name)) {
        errors.push(
          issue(
            'missing-declared-placeholder',
            'error',
            `"${id}" declares placeholder "${name}" but the text has no {${name}}`,
            id,
          ),
        );
      }
    }

    if (hasUnbalancedBrace(message.text)) {
      errors.push(
        issue(
          'unbalanced-brace',
          'error',
          `"${id}" has a stray brace — escape a literal one as {{ or }}`,
          id,
        ),
      );
    }

    const placeholders = findPlaceholderMarkers(message.text);
    if (placeholders.length > 0) {
      errors.push(
        issue(
          'placeholder-text',
          'error',
          `"${id}" was never written (${placeholders.join(', ')})`,
          id,
        ),
      );
    }

    // --- variant structure ---
    for (const suffix of VARIANT_SUFFIXES) {
      if (!id.endsWith(suffix)) continue;
      const base = id.slice(0, -suffix.length);
      if (bundle.messages[base] === undefined) {
        errors.push(
          issue(
            'orphan-variant',
            'error',
            `"${id}" escalates "${base}", which is not in this bundle — the fallback chain would end at a sentinel`,
            id,
          ),
        );
      }
    }

    // --- tone ---
    if (message.text.includes('!')) {
      warnings.push(
        issue(
          'exclamation-mark',
          'warning',
          `"${id}" uses an exclamation mark; TIDELOCK copy is terse and physical, not cheerful`,
          id,
        ),
      );
    }

    for (const phrase of findBannedPhrases(message.text)) {
      warnings.push(
        issue('banned-phrase', 'warning', `"${id}" uses the banned phrase "${phrase}"`, id),
      );
    }

    // --- layout ---
    // Measured on the authored text, with placeholders standing in for their
    // eventual values. An approximation: `{action}` expands to something longer
    // at runtime, which is what `expansionAllowance` reserves room for.
    const maxLineChars = message.maxLineChars ?? bundle.lineBudget.maxLineChars;
    const budget = maxLineChars * bundle.lineBudget.maxLines;
    if (message.text.length > budget) {
      warnings.push(
        issue(
          'over-line-budget',
          'warning',
          `"${id}" is ${message.text.length} characters, over the ${budget}-character budget (${bundle.lineBudget.maxLines} lines of ${maxLineChars})`,
          id,
        ),
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Message ids present in `expected` but absent from the bundle.
 *
 * The coverage gate: hand it the `messageKey`s of every authored tutorial and it
 * answers whether the shipped bundle can render them. Returned sorted so a
 * failure message is stable and diffable.
 */
export function missingMessageIds(
  bundle: LocaleBundle,
  expected: Iterable<MessageId>,
): MessageId[] {
  const missing = new Set<MessageId>();
  for (const id of expected) {
    if (bundle.messages[id] === undefined) missing.add(id);
  }
  return [...missing].sort();
}
