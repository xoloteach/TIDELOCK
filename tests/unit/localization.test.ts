/**
 * Locale bundle and runtime string table tests.
 *
 * The failure this layer exists to prevent is the one the repository shipped
 * with until now: nine authored tutorial `messageKey`s pointing at a string
 * table that did not exist, so every prompt in the prologue resolved to nothing.
 * A typecheck cannot see that — the key is a `string` and the bundle is JSON — so
 * the coverage assertion here loads the *shipped* `content/tutorials/prologue.json`
 * and the *shipped* `content/localization/en.json` and checks them against each
 * other. Inline fixtures would pass forever while the game rendered blanks.
 *
 * Everything else is deliberately fixture-driven: schema rejection, the
 * missing-key policy, interpolation and line breaking are properties of the code,
 * and pinning them to authored copy would make a rewording break the suite.
 *
 * The missing-key policy has two halves that pull in opposite directions — loud
 * in development, never fatal in the game — so both are asserted directly: a
 * report is emitted, and the call still returns a usable string.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  LOCALIZATION_SCHEMA_VERSION,
  extractPlaceholders,
  localeBundleSchema,
  missingMessageIds,
  parseLocaleBundle,
  validateLocaleBundle,
  variantFallbackChain,
  variantMessageId,
  type LocaleBundle,
  type LocaleMessage,
} from '../../src/game/localization/localizationSchema';
import {
  StringTable,
  breakLines,
  missingKeySentinel,
  paginate,
  type MissingReport,
} from '../../src/game/localization/StringTable';
import { TUTORIALS, validateTutorials } from '../../src/game/tutorial/tutorialSchema';
import { ACTION_DISPLAY_NAMES, type GameAction } from '../../src/engine/input/actions';

// The shipped content, imported rather than reconstructed. These two assertions
// are the reason this file exists.
import enBundleRaw from '../../content/localization/en.json';
import prologueTutorialsRaw from '../../content/tutorials/prologue.json';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A minimal valid bundle. Tests override exactly the field under test, so a
 * failure names one property rather than "the fixture is wrong somewhere".
 */
function bundle(overrides: Partial<LocaleBundle> = {}): LocaleBundle {
  return {
    version: LOCALIZATION_SCHEMA_VERSION,
    locale: 'en',
    displayName: 'English',
    englishName: 'English',
    textDirection: 'ltr',
    completeness: 1,
    fallbackLocale: null,
    expansionAllowance: 1,
    lineBudget: { maxLineChars: 56, maxLines: 2 },
    messages: {
      'tutorial.move': { text: 'The platform runs west. {action}.', placeholders: ['action'] },
    },
    ...overrides,
  };
}

/** A bundle holding exactly the messages given, with everything else defaulted. */
function bundleWith(messages: Record<string, LocaleMessage>): LocaleBundle {
  return bundle({ messages });
}

interface Recorded {
  reports: MissingReport[];
  table: StringTable;
}

/**
 * A table whose misses are captured instead of logged.
 *
 * Injected rather than spied on the console: the policy is "report through the
 * seam", and asserting the seam is what proves a diagnostics overlay could show
 * the same information.
 */
function recording(
  target: LocaleBundle,
  options: { fallback?: LocaleBundle; strict?: boolean } = {},
): Recorded {
  const reports: MissingReport[] = [];
  const table = new StringTable(target, {
    ...options,
    onMissing: (report) => reports.push(report),
  });
  return { reports, table };
}

/** Every `messageKey` in the shipped prologue tutorial file, in authored order. */
const SHIPPED_TUTORIAL_KEYS: string[] = (
  prologueTutorialsRaw as readonly { messageKey: string }[]
).map((def) => def.messageKey);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe('localeBundleSchema', () => {
  it('accepts a well-formed bundle', () => {
    expect(() => parseLocaleBundle(bundle())).not.toThrow();
  });

  it('returns the parsed bundle, not the raw input', () => {
    const parsed = parseLocaleBundle(bundle());
    expect(parsed.locale).toBe('en');
    expect(parsed.messages['tutorial.move']?.text).toContain('platform');
  });

  it('rejects a non-object', () => {
    expect(() => parseLocaleBundle(null)).toThrow(/invalid locale bundle/);
    expect(() => parseLocaleBundle('en')).toThrow(/invalid locale bundle/);
    expect(() => parseLocaleBundle([])).toThrow(/invalid locale bundle/);
  });

  it('names the offending path in the error', () => {
    expect(() => parseLocaleBundle(bundle({ locale: 'English' }))).toThrow(/locale/);
  });

  it('rejects an unknown top-level field rather than dropping it', () => {
    // strictObject: a typo must fail loudly, not be silently ignored, or a
    // mis-spelled `lineBudget` would leave every locale on the defaults.
    const raw = { ...bundle(), lineBudgetd: { maxLineChars: 40, maxLines: 2 } };
    expect(() => parseLocaleBundle(raw)).toThrow(/invalid locale bundle/);
  });

  it('rejects an unknown field on a message', () => {
    const raw = bundleWith({
      'tutorial.move': { text: 'West.', placeholder: ['action'] } as unknown as LocaleMessage,
    });
    expect(() => parseLocaleBundle(raw)).toThrow(/invalid locale bundle/);
  });

  it('rejects an empty message string', () => {
    expect(() => parseLocaleBundle(bundleWith({ 'tutorial.move': { text: '' } }))).toThrow(
      /invalid locale bundle/,
    );
  });

  it('rejects a message id that is not namespaced', () => {
    expect(() => parseLocaleBundle(bundleWith({ move: { text: 'West.' } }))).toThrow(
      /invalid locale bundle/,
    );
  });

  it('rejects a positional placeholder name', () => {
    const raw = bundleWith({
      'tutorial.move': { text: 'West {0}.', placeholders: ['0'] },
    });
    expect(() => parseLocaleBundle(raw)).toThrow(/invalid locale bundle/);
  });

  it.each([
    ['a malformed locale code', { locale: 'en_US' }],
    ['a completeness above 1', { completeness: 1.4 }],
    ['a negative completeness', { completeness: -0.1 }],
    ['an expansion allowance below 1', { expansionAllowance: 0.8 }],
    ['a non-integer version', { version: 1.5 }],
    ['an unknown text direction', { textDirection: 'ttb' as unknown as 'ltr' }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => parseLocaleBundle(bundle(overrides as Partial<LocaleBundle>))).toThrow(
      /invalid locale bundle/,
    );
  });

  it('rejects a line budget too narrow to hold a word', () => {
    expect(() => parseLocaleBundle(bundle({ lineBudget: { maxLineChars: 4, maxLines: 2 } }))).toThrow(
      /invalid locale bundle/,
    );
  });

  it('rejects a schema version it does not support', () => {
    expect(() => parseLocaleBundle(bundle({ version: 99 }))).toThrow(/not the supported version/);
  });

  it('accepts an explicit fallback locale and a partial completeness', () => {
    const parsed = parseLocaleBundle(
      bundle({ locale: 'pt-BR', fallbackLocale: 'en', completeness: 0.4 }),
    );
    expect(parsed.fallbackLocale).toBe('en');
    expect(parsed.completeness).toBeCloseTo(0.4);
  });

  it('exposes safeParse for callers that want the issues, not a throw', () => {
    const result = localeBundleSchema.safeParse(bundle({ completeness: 2 }));
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bundle linting
// ---------------------------------------------------------------------------

describe('validateLocaleBundle', () => {
  it('passes a clean bundle with no errors or warnings', () => {
    const result = validateLocaleBundle(bundle());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('errors on a placeholder used but not declared', () => {
    const result = validateLocaleBundle(
      bundleWith({ 'tutorial.move': { text: 'West. {action}.' } }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain('undeclared-placeholder');
  });

  it('errors on a placeholder declared but absent from the text', () => {
    const result = validateLocaleBundle(
      bundleWith({ 'tutorial.move': { text: 'West.', placeholders: ['action'] } }),
    );
    expect(result.errors.map((e) => e.code)).toContain('missing-declared-placeholder');
  });

  it('errors on a duplicated declaration', () => {
    const result = validateLocaleBundle(
      bundleWith({
        'tutorial.move': { text: 'West {action}.', placeholders: ['action', 'action'] },
      }),
    );
    expect(result.errors.map((e) => e.code)).toContain('duplicate-declared-placeholder');
  });

  it('errors on a stray brace, which would render literally', () => {
    const result = validateLocaleBundle(
      bundleWith({ 'tutorial.move': { text: 'West {action.', placeholders: [] } }),
    );
    expect(result.errors.map((e) => e.code)).toContain('unbalanced-brace');
  });

  it('accepts a doubled brace as an escaped literal', () => {
    const result = validateLocaleBundle(
      bundleWith({ 'tutorial.move': { text: 'Reads {{02:14}} on the panel.' } }),
    );
    expect(result.ok).toBe(true);
  });

  it('errors on copy that was never written', () => {
    const result = validateLocaleBundle(
      bundleWith({ 'tutorial.move': { text: 'TODO: write the move prompt' } }),
    );
    expect(result.errors.map((e) => e.code)).toContain('placeholder-text');
  });

  it('errors on an escalation variant whose base id is absent', () => {
    // Without the base, the fallback chain bottoms out at a sentinel — the exact
    // failure the chain exists to prevent.
    const result = validateLocaleBundle(
      bundleWith({ 'tutorial.vault.hint': { text: 'The handrail runs the whole span.' } }),
    );
    expect(result.errors.map((e) => e.code)).toContain('orphan-variant');
  });

  it('accepts a variant alongside its base', () => {
    const result = validateLocaleBundle(
      bundleWith({
        'tutorial.vault': { text: 'The walkway is out for two metres.' },
        'tutorial.vault.hint': { text: 'The handrail runs the whole span.' },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('errors when a locale names itself as its own fallback', () => {
    const result = validateLocaleBundle(bundle({ fallbackLocale: 'en' }));
    expect(result.errors.map((e) => e.code)).toContain('self-fallback');
  });

  it('warns on an exclamation mark, the tell of generic tutorial voice', () => {
    const result = validateLocaleBundle(
      bundleWith({ 'tutorial.move': { text: 'Press W to move forward!' } }),
    );
    expect(result.ok).toBe(true); // A warning does not block.
    expect(result.warnings.map((w) => w.code)).toContain('exclamation-mark');
  });

  it('warns on trailer-speak, using the shared banned-phrase list', () => {
    const result = validateLocaleBundle(
      bundleWith({ 'tutorial.move': { text: 'This changes everything.' } }),
    );
    expect(result.warnings.map((w) => w.code)).toContain('banned-phrase');
  });

  it('warns on a string over the locale line budget', () => {
    const result = validateLocaleBundle(
      bundleWith({ 'tutorial.move': { text: 'x'.repeat(56 * 2 + 1) } }),
    );
    expect(result.warnings.map((w) => w.code)).toContain('over-line-budget');
  });

  it('respects a per-message line budget override', () => {
    const long = 'x'.repeat(56 * 2 + 1);
    const withOverride = validateLocaleBundle(
      bundleWith({ 'tutorial.move': { text: long, maxLineChars: 200 } }),
    );
    expect(withOverride.warnings.map((w) => w.code)).not.toContain('over-line-budget');
  });

  it('scopes every issue to the message id that caused it', () => {
    const result = validateLocaleBundle(
      bundleWith({
        'tutorial.move': { text: 'West.' },
        'tutorial.look': { text: 'Look. {action}.' },
      }),
    );
    const undeclared = result.errors.filter((e) => e.code === 'undeclared-placeholder');
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0]?.target).toBe('tutorial.look');
  });
});

describe('extractPlaceholders', () => {
  it('finds named slots in first-use order', () => {
    expect(extractPlaceholders('{action} — {binding}')).toEqual(['action', 'binding']);
  });

  it('deduplicates a slot used twice', () => {
    expect(extractPlaceholders('{action} then {action}')).toEqual(['action']);
  });

  it('ignores an escaped brace pair', () => {
    expect(extractPlaceholders('Reads {{02:14}} on the panel.')).toEqual([]);
  });

  it('returns nothing for text with no slots', () => {
    expect(extractPlaceholders('The walkway is out for two metres.')).toEqual([]);
  });
});

describe('variant ids', () => {
  it('maps level 1 to the bare id', () => {
    expect(variantMessageId('tutorial.vault', 1)).toBe('tutorial.vault');
  });

  it('suffixes levels 2 and 3', () => {
    expect(variantMessageId('tutorial.vault', 2)).toBe('tutorial.vault.strong');
    expect(variantMessageId('tutorial.vault', 3)).toBe('tutorial.vault.hint');
  });

  it('walks the chain most specific first', () => {
    expect(variantFallbackChain('tutorial.vault', 3)).toEqual([
      'tutorial.vault.hint',
      'tutorial.vault.strong',
      'tutorial.vault',
    ]);
    expect(variantFallbackChain('tutorial.vault', 1)).toEqual(['tutorial.vault']);
  });
});

// ---------------------------------------------------------------------------
// Shipped content — the coverage gate
// ---------------------------------------------------------------------------

describe('shipped en locale bundle', () => {
  const en = parseLocaleBundle(enBundleRaw);

  it('parses against the schema', () => {
    expect(en.locale).toBe('en');
    expect(en.completeness).toBe(1);
    expect(en.fallbackLocale).toBeNull();
  });

  it('declares the locale metadata spec 75 requires', () => {
    expect(en.displayName.length).toBeGreaterThan(0);
    expect(en.englishName.length).toBeGreaterThan(0);
    expect(en.textDirection).toBe('ltr');
    expect(en.expansionAllowance).toBeGreaterThanOrEqual(1);
    expect(en.lineBudget.maxLineChars).toBeGreaterThan(0);
    expect(en.lineBudget.maxLines).toBeGreaterThan(0);
  });

  it('passes the authoring lint with no errors and no warnings', () => {
    const result = validateLocaleBundle(en);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('uses no exclamation marks anywhere', () => {
    // TIDELOCK copy is terse and physical. Asserted separately from the linter
    // so the shipped bundle is pinned even if the warning is ever relaxed.
    const offenders = Object.entries(en.messages)
      .filter(([, message]) => message.text.includes('!'))
      .map(([id]) => id);
    expect(offenders).toEqual([]);
  });

  it('never names a key or button in tutorial copy (spec 86.4)', () => {
    // "Press E" is the failure §90 fails a build for: a touch player would be
    // told to press a key they do not have. Copy names the action; the renderer
    // resolves the binding.
    const offenders = Object.entries(en.messages)
      .filter(([id]) => id.startsWith('tutorial.'))
      .filter(([, message]) => /\bpress\b|\bkey\b|\bbutton\b|\btap\b/i.test(message.text))
      .map(([id]) => id);
    expect(offenders).toEqual([]);
  });
});

describe('shipped tutorial messageKeys resolve against the shipped bundle', () => {
  const en = parseLocaleBundle(enBundleRaw);

  it('reads nine messageKeys out of content/tutorials/prologue.json', () => {
    // Guards the guard: if the tutorial file is restructured and this stops
    // finding keys, the coverage assertion below would pass vacuously.
    expect(SHIPPED_TUTORIAL_KEYS).toHaveLength(9);
    expect(new Set(SHIPPED_TUTORIAL_KEYS).size).toBe(9);
    expect(SHIPPED_TUTORIAL_KEYS.every((key) => key.startsWith('tutorial.'))).toBe(true);
  });

  it('covers every messageKey in the shipped prologue tutorial file', () => {
    expect(missingMessageIds(en, SHIPPED_TUTORIAL_KEYS)).toEqual([]);
  });

  it.each(SHIPPED_TUTORIAL_KEYS)('resolves %s to authored text, not a sentinel', (key) => {
    const { table, reports } = recording(en);
    const text = table.get(key, { action: 'Interact — E' });
    expect(text).not.toBe(missingKeySentinel(key));
    expect(text).not.toContain('\u27e6');
    expect(text.trim().length).toBeGreaterThan(0);
    expect(reports).toEqual([]);
  });

  it('covers every messageKey in the built-in tutorial registry too', () => {
    // `TUTORIALS` in tutorialSchema.ts declares more tutorials than the prologue
    // file authors. A bundle that only covered the nine would leave the registry
    // unresolved the moment a later act uses it.
    const registryKeys = TUTORIALS.map((def) => def.messageKey);
    expect(registryKeys.length).toBeGreaterThanOrEqual(SHIPPED_TUTORIAL_KEYS.length);
    expect(missingMessageIds(en, registryKeys)).toEqual([]);
  });

  it('keeps the registry itself valid, so the keys it declares are trustworthy', () => {
    expect(validateTutorials()).toEqual([]);
  });

  it('resolves every escalation level for every registry tutorial', () => {
    const { table, reports } = recording(en);
    for (const def of TUTORIALS) {
      for (const level of [1, 2, 3] as const) {
        const text = table.escalated(def.messageKey, level, { action: 'Interact — E' });
        expect(text).not.toContain('\u27e6');
      }
    }
    // A level with no authored variant falls back down the ladder silently; a
    // report here would mean the chain broke.
    expect(reports).toEqual([]);
  });

  it('covers every input action display name', () => {
    // ACTION_DISPLAY_NAMES documents itself as "the English source strings;
    // localisation replaces them by key". This is that replacement.
    const actionIds = (Object.keys(ACTION_DISPLAY_NAMES) as GameAction[]).map(
      (action) => `action.${action}`,
    );
    expect(missingMessageIds(en, actionIds)).toEqual([]);
  });

  it('matches the current English action labels exactly', () => {
    const { table } = recording(en);
    for (const [action, label] of Object.entries(ACTION_DISPLAY_NAMES)) {
      expect(table.get(`action.${action}`)).toBe(label);
    }
  });

  it('composes a desktop prompt from an action label and a live binding', () => {
    const { table, reports } = recording(en);
    const prompt = table.get('ui.prompt.keyboard', {
      action: table.get('action.interact'),
      binding: 'E',
    });
    expect(prompt).toBe('Interact — E');
    expect(reports).toEqual([]);
  });

  it('gives touch prompts no binding to name', () => {
    const { table } = recording(en);
    expect(table.get('ui.prompt.touch', { action: table.get('action.interact') })).toBe(
      'Interact',
    );
  });

  it('fits every tutorial prompt into the locale subtitle budget once interpolated', () => {
    const { table } = recording(en);
    const over: string[] = [];
    for (const id of Object.keys(en.messages)) {
      if (!id.startsWith('tutorial.')) continue;
      const cues = table.cues(id, { action: 'Look Horizontal — Mouse' });
      if (cues.length > 1) over.push(id);
    }
    expect(over).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// StringTable — lookup and interpolation
// ---------------------------------------------------------------------------

describe('StringTable lookup', () => {
  it('reports metadata from the bundle', () => {
    const table = new StringTable(
      bundle({ locale: 'pt-BR', displayName: 'Português', completeness: 0.6, expansionAllowance: 1.3 }),
    );
    expect(table.locale).toBe('pt-BR');
    expect(table.displayName).toBe('Português');
    expect(table.completeness).toBeCloseTo(0.6);
    expect(table.expansionAllowance).toBeCloseTo(1.3);
    expect(table.textDirection).toBe('ltr');
  });

  it('answers has() without reporting a miss', () => {
    const { table, reports } = recording(bundle());
    expect(table.has('tutorial.move')).toBe(true);
    expect(table.has('tutorial.nope')).toBe(false);
    expect(reports).toEqual([]);
  });

  it('falls through to a fallback bundle', () => {
    const { table } = recording(bundleWith({ 'tutorial.move': { text: 'Oeste.' } }), {
      fallback: bundleWith({ 'tutorial.look': { text: 'Look along the platform.' } }),
    });
    expect(table.get('tutorial.move')).toBe('Oeste.');
    expect(table.get('tutorial.look')).toBe('Look along the platform.');
  });

  it('prefers the primary bundle over the fallback', () => {
    const { table } = recording(bundleWith({ 'tutorial.move': { text: 'Oeste.' } }), {
      fallback: bundleWith({ 'tutorial.move': { text: 'West.' } }),
    });
    expect(table.get('tutorial.move')).toBe('Oeste.');
  });

  it('resolveFirst takes the first id that resolves', () => {
    const { table, reports } = recording(
      bundleWith({
        'tutorial.vault': { text: 'The walkway is out for two metres.' },
        'tutorial.vault.hint': { text: 'The handrail runs the whole span.' },
      }),
    );
    expect(table.resolveFirst(['tutorial.vault.hint', 'tutorial.vault'])).toBe(
      'The handrail runs the whole span.',
    );
    expect(table.resolveFirst(['tutorial.vault.strong', 'tutorial.vault'])).toBe(
      'The walkway is out for two metres.',
    );
    // Falling through a chain is normal, not a miss.
    expect(reports).toEqual([]);
  });

  it('escalated falls back down the ladder when a level is unauthored', () => {
    const { table, reports } = recording(
      bundleWith({ 'tutorial.sprint': { text: 'Nine hours to the first surge band.' } }),
    );
    expect(table.escalated('tutorial.sprint', 3)).toBe('Nine hours to the first surge band.');
    expect(reports).toEqual([]);
  });

  it('escalated prefers the most specific authored level', () => {
    const { table } = recording(
      bundleWith({
        'tutorial.vault': { text: 'Base.' },
        'tutorial.vault.strong': { text: 'Stronger.' },
        'tutorial.vault.hint': { text: 'Hint.' },
      }),
    );
    expect(table.escalated('tutorial.vault', 1)).toBe('Base.');
    expect(table.escalated('tutorial.vault', 2)).toBe('Stronger.');
    expect(table.escalated('tutorial.vault', 3)).toBe('Hint.');
  });
});

describe('StringTable interpolation', () => {
  it('substitutes a named placeholder', () => {
    const { table } = recording(
      bundleWith({ 'tutorial.move': { text: 'West. {action}.', placeholders: ['action'] } }),
    );
    expect(table.get('tutorial.move', { action: 'Move Forward — W' })).toBe(
      'West. Move Forward — W.',
    );
  });

  it('substitutes several distinct placeholders', () => {
    const { table } = recording(
      bundleWith({
        'ui.prompt.keyboard': { text: '{action} — {binding}', placeholders: ['action', 'binding'] },
      }),
    );
    expect(table.get('ui.prompt.keyboard', { action: 'Interact', binding: 'E' })).toBe(
      'Interact — E',
    );
  });

  it('substitutes every occurrence of a repeated placeholder', () => {
    const { table } = recording(
      bundleWith({ 'ui.test.repeat': { text: '{a} and {a}', placeholders: ['a'] } }),
    );
    expect(table.get('ui.test.repeat', { a: 'x' })).toBe('x and x');
  });

  it('accepts a number and stringifies it', () => {
    const { table } = recording(
      bundleWith({ 'ui.test.count': { text: '{n} batteries', placeholders: ['n'] } }),
    );
    expect(table.get('ui.test.count', { n: 4 })).toBe('4 batteries');
    expect(table.get('ui.test.count', { n: 0 })).toBe('0 batteries');
  });

  it('unescapes a doubled brace to a literal one', () => {
    const { table } = recording(
      bundleWith({ 'ui.test.literal': { text: 'Reads {{02:14}} on the panel.' } }),
    );
    expect(table.get('ui.test.literal')).toBe('Reads {02:14} on the panel.');
  });

  it('does not substitute inside an escaped brace pair', () => {
    const { table, reports } = recording(
      bundleWith({ 'ui.test.escaped': { text: '{{action}}' } }),
    );
    expect(table.get('ui.test.escaped', { action: 'Interact' })).toBe('{action}');
    expect(reports).toEqual([]);
  });

  it('ignores an extra argument nothing asked for', () => {
    const { table, reports } = recording(
      bundleWith({ 'tutorial.move': { text: 'West.' } }),
    );
    expect(table.get('tutorial.move', { action: 'unused' })).toBe('West.');
    expect(reports).toEqual([]);
  });

  it('leaves an unsupplied placeholder visible rather than printing undefined', () => {
    const { table, reports } = recording(
      bundleWith({ 'tutorial.move': { text: 'West. {action}.', placeholders: ['action'] } }),
    );
    const text = table.get('tutorial.move');
    expect(text).toBe('West. {action}.');
    expect(text).not.toContain('undefined');
    expect(reports).toHaveLength(1);
    expect(reports[0]?.kind).toBe('placeholder');
    expect(reports[0]?.placeholder).toBe('action');
  });
});

// ---------------------------------------------------------------------------
// StringTable — missing-key policy
// ---------------------------------------------------------------------------

describe('StringTable missing-key policy', () => {
  it('returns a visible sentinel instead of throwing', () => {
    const { table } = recording(bundle());
    expect(table.get('tutorial.nope')).toBe(missingKeySentinel('tutorial.nope'));
  });

  it('never crashes the caller for a missing key', () => {
    const { table } = recording(bundle());
    expect(() => table.get('tutorial.nope')).not.toThrow();
    expect(() => table.lines('tutorial.nope')).not.toThrow();
    expect(() => table.cues('tutorial.nope')).not.toThrow();
    expect(() => table.escalated('tutorial.nope', 3)).not.toThrow();
  });

  it('puts the id inside the sentinel so a screenshot names the bug', () => {
    const { table } = recording(bundle());
    expect(table.get('tutorial.nope')).toContain('tutorial.nope');
  });

  it('reports the miss loudly', () => {
    const { table, reports } = recording(bundle());
    table.get('tutorial.nope');
    expect(reports).toHaveLength(1);
    expect(reports[0]?.kind).toBe('message');
    expect(reports[0]?.id).toBe('tutorial.nope');
    expect(reports[0]?.locale).toBe('en');
    expect(reports[0]?.message).toContain('tutorial.nope');
  });

  it('reports once per id, however many times it is asked for', () => {
    // The HUD calls into this every frame. Sixty reports a second is a report
    // nobody reads and a stall on a phone.
    const { table, reports } = recording(bundle());
    for (let i = 0; i < 300; i += 1) table.get('tutorial.nope');
    expect(reports).toHaveLength(1);
  });

  it('reports each distinct missing id separately', () => {
    const { table, reports } = recording(bundle());
    table.get('tutorial.nope');
    table.get('tutorial.alsoNope');
    expect(reports.map((r) => r.id)).toEqual(['tutorial.nope', 'tutorial.alsoNope']);
  });

  it('accumulates missing ids for diagnostics, in first-seen order', () => {
    const { table } = recording(bundle());
    table.get('tutorial.b');
    table.get('tutorial.a');
    table.get('tutorial.b');
    expect(table.missingKeys()).toEqual(['tutorial.b', 'tutorial.a']);
  });

  it('does not record a hit as missing', () => {
    const { table } = recording(bundle());
    table.get('tutorial.move', { action: 'x' });
    expect(table.missingKeys()).toEqual([]);
  });

  it('goes loud again after clearMissing', () => {
    const { table, reports } = recording(bundle());
    table.get('tutorial.nope');
    table.clearMissing();
    table.get('tutorial.nope');
    expect(reports).toHaveLength(2);
    expect(table.missingKeys()).toEqual(['tutorial.nope']);
  });

  it('defaults to console.error when no handler is injected', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      new StringTable(bundle()).get('tutorial.nope');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0])).toContain('tutorial.nope');
    } finally {
      spy.mockRestore();
    }
  });

  it('throws under strict, which is the build-time gate', () => {
    const table = new StringTable(bundle(), { strict: true, onMissing: () => {} });
    expect(() => table.get('tutorial.nope')).toThrow(/tutorial\.nope/);
  });

  it('still records the miss when strict throws', () => {
    const table = new StringTable(bundle(), { strict: true, onMissing: () => {} });
    expect(() => table.get('tutorial.nope')).toThrow();
    expect(table.missingKeys()).toEqual(['tutorial.nope']);
  });

  it('throws under strict for an unsupplied placeholder too', () => {
    const table = new StringTable(
      bundleWith({ 'tutorial.move': { text: 'West {action}.', placeholders: ['action'] } }),
      { strict: true, onMissing: () => {} },
    );
    expect(() => table.get('tutorial.move')).toThrow(/action/);
  });

  it('reports every candidate when a whole chain misses', () => {
    const { table, reports } = recording(bundle());
    const text = table.escalated('tutorial.nope', 3);
    expect(text).toBe(missingKeySentinel('tutorial.nope.hint'));
    expect(reports).toHaveLength(1);
    expect(reports[0]?.message).toContain('tutorial.nope.hint');
    expect(reports[0]?.message).toContain('tutorial.nope');
  });
});

// ---------------------------------------------------------------------------
// Line breaking
// ---------------------------------------------------------------------------

describe('breakLines', () => {
  it('leaves a short line alone', () => {
    expect(breakLines('The walkway is out.', 56)).toEqual(['The walkway is out.']);
  });

  it('wraps on word boundaries, never mid-word', () => {
    const lines = breakLines('The walkway is out for two metres at the mouth.', 20);
    expect(lines.every((line) => line.length <= 20)).toBe(true);
    expect(lines.join(' ')).toBe('The walkway is out for two metres at the mouth.');
  });

  it('fills greedily rather than balancing', () => {
    expect(breakLines('aaa bbb ccc ddd', 7)).toEqual(['aaa bbb', 'ccc ddd']);
  });

  it('hard-splits a token longer than one line', () => {
    // A compound noun or an asset path must not push the band into the touch zone.
    const lines = breakLines('x'.repeat(25), 10);
    expect(lines).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx']);
  });

  it('hard-splits an over-long token without losing its neighbours', () => {
    const lines = breakLines(`start ${'y'.repeat(12)} end`, 6);
    expect(lines.join('')).toContain('yyyyyy');
    expect(lines.join(' ')).toContain('start');
    expect(lines.join(' ')).toContain('end');
  });

  it('collapses runs of whitespace', () => {
    expect(breakLines('  The   walkway  ', 56)).toEqual(['The walkway']);
  });

  it('honours an authored newline as a deliberate break', () => {
    expect(breakLines('Feeder Three\nreads 2.30', 56)).toEqual(['Feeder Three', 'reads 2.30']);
  });

  it('never emits a line over the budget for realistic prose', () => {
    const text =
      'Maintenance units read a survey pulse as a work order. They will come and stand next to her.';
    for (const width of [16, 24, 32, 40, 56, 80]) {
      const lines = breakLines(text, width);
      expect(lines.every((line) => line.length <= width)).toBe(true);
      expect(lines.join(' ')).toBe(text);
    }
  });

  it('returns a single entry for empty text rather than nothing', () => {
    expect(breakLines('', 56)).toEqual(['']);
  });

  it('degrades to the whole string on a nonsensical width', () => {
    expect(breakLines('The walkway is out.', 0)).toEqual(['The walkway is out.']);
    expect(breakLines('The walkway is out.', Number.NaN)).toEqual(['The walkway is out.']);
  });
});

describe('paginate', () => {
  it('groups lines into cues of at most maxLines', () => {
    expect(paginate(['a', 'b', 'c', 'd', 'e'], 2)).toEqual(['a\nb', 'c\nd', 'e']);
  });

  it('returns one cue when everything fits', () => {
    expect(paginate(['a', 'b'], 2)).toEqual(['a\nb']);
  });

  it('handles a single line per cue', () => {
    expect(paginate(['a', 'b'], 1)).toEqual(['a', 'b']);
  });

  it('returns a single entry for no lines', () => {
    expect(paginate([], 2)).toEqual(['']);
  });
});

describe('StringTable line breaking', () => {
  it('wraps a resolved message to the locale budget', () => {
    const { table } = recording(
      bundle({
        lineBudget: { maxLineChars: 20, maxLines: 2 },
        messages: {
          'tutorial.scan': {
            text: 'Maintenance units read a survey pulse as a work order.',
          },
        },
      }),
    );
    const lines = table.lines('tutorial.scan');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.length <= 20)).toBe(true);
  });

  it('wraps after interpolation, not before', () => {
    // Wrapping the template would break against the wrong length: {action}
    // is eight characters and its value is far longer.
    const { table } = recording(
      bundle({
        lineBudget: { maxLineChars: 16, maxLines: 2 },
        messages: {
          'tutorial.move': { text: 'West. {action}.', placeholders: ['action'] },
        },
      }),
    );
    const lines = table.lines('tutorial.move', { action: 'Move Forward — W' });
    expect(lines.every((line) => line.length <= 16)).toBe(true);
    expect(lines.join(' ')).toContain('Move Forward');
  });

  it('prefers a per-message override to the locale budget', () => {
    const { table } = recording(
      bundle({
        lineBudget: { maxLineChars: 10, maxLines: 2 },
        messages: {
          'tutorial.move': { text: 'The walkway is out for two metres.', maxLineChars: 40 },
        },
      }),
    );
    expect(table.lines('tutorial.move')).toEqual(['The walkway is out for two metres.']);
  });

  it('prefers an explicit option to both', () => {
    // A settings screen offering larger subtitles narrows the budget without
    // editing content.
    const { table } = recording(
      bundle({
        lineBudget: { maxLineChars: 56, maxLines: 2 },
        messages: { 'tutorial.move': { text: 'The walkway is out.', maxLineChars: 56 } },
      }),
    );
    const lines = table.lines('tutorial.move', {}, { maxLineChars: 10 });
    expect(lines.every((line) => line.length <= 10)).toBe(true);
  });

  it('groups wrapped lines into cues with the locale lines-per-cue', () => {
    const { table } = recording(
      bundle({
        lineBudget: { maxLineChars: 10, maxLines: 2 },
        messages: { 'ui.test.long': { text: 'aaa bbb ccc ddd eee fff ggg hhh' } },
      }),
    );
    const cues = table.cues('ui.test.long');
    expect(cues.length).toBeGreaterThan(1);
    for (const cue of cues) expect(cue.split('\n').length).toBeLessThanOrEqual(2);
  });

  it('wraps a sentinel like any other string rather than failing', () => {
    const { table } = recording(bundle());
    expect(table.lines('tutorial.nope')).toEqual([missingKeySentinel('tutorial.nope')]);
    expect(table.cues('tutorial.nope')).toEqual([missingKeySentinel('tutorial.nope')]);
  });
});
