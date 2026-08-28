/**
 * Subtitle band tests.
 *
 * The band exists because TIDELOCK is mostly overlapping radio traffic
 * delivered while the player is walking, so the two failure modes that matter
 * are timing, not styling: a line overwritten mid-read, and a line that
 * outlives its scene. Both are queue behaviour, and both are asserted here with
 * an explicit clock rather than timers — `tick` takes a delta, so a test can
 * step 1.5 seconds and know exactly what should be on screen.
 *
 * Settings come from `createDefaultSettings().accessibility`, not a hand-rolled
 * object, so a schema change that adds a field cannot leave these tests passing
 * against a shape the game no longer uses.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Subtitles, type SubtitleLine } from '../../src/ui/Subtitles';
import { createDefaultSettings } from '../../src/persistence/settingsSchema';
import type { AccessibilitySettings } from '../../src/persistence/settingsSchema';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let host: HTMLElement;
let subs: Subtitles;

function settings(overrides: Partial<AccessibilitySettings> = {}): AccessibilitySettings {
  return { ...createDefaultSettings().accessibility, ...overrides };
}

function query(selector: string): HTMLElement {
  const found = subs.element.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`missing subtitle node: ${selector}`);
  return found;
}

/** Replaces the shared band with one built from different settings. */
function recreate(
  accessibility: AccessibilitySettings,
  options?: ConstructorParameters<typeof Subtitles>[2],
): void {
  subs.dispose();
  subs = new Subtitles(host, accessibility, options);
}

const SERA_LINE: SubtitleLine = {
  id: 'act1.sera.pump12.01',
  speaker: 'Sera Holt',
  text: 'Cluster B is drawing forty amps over spec. Do not close the breaker yet.',
  duration: 4,
};

const MARA_LINE: SubtitleLine = {
  id: 'act1.mara.pump12.02',
  speaker: 'Mara Venn',
  text: 'Then something upstream is wrong.',
  duration: 2,
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  subs = new Subtitles(host, settings());
});

afterEach(() => {
  subs.dispose();
  host.remove();
});

// ---------------------------------------------------------------------------

describe('Subtitles construction', () => {
  it('attaches a passthrough root to the host', () => {
    expect(subs.element.parentElement).toBe(host);
    // The band sits over the world and over the touch controls; it must never
    // intercept a tap aimed at either.
    expect(subs.element.classList.contains('layer-passthrough')).toBe(true);
  });

  it('is an aria-live region announced as a unit', () => {
    expect(subs.element.getAttribute('aria-live')).toBe('polite');
    expect(subs.element.getAttribute('aria-atomic')).toBe('true');
    expect(subs.element.getAttribute('role')).toBe('status');
  });

  it('starts empty', () => {
    expect(subs.isVisible).toBe(false);
    expect(subs.visibleText).toBe('');
    expect(subs.queueLength).toBe(0);
    expect(query('.subtitles__cue').hidden).toBe(true);
  });
});

describe('Subtitles queue', () => {
  it('presents a line immediately when the band is free', () => {
    subs.show(SERA_LINE);

    expect(subs.isVisible).toBe(true);
    expect(subs.currentLine).toBe(SERA_LINE);
    expect(subs.visibleText).toBe(SERA_LINE.text);
    expect(query('.subtitles__text').textContent).toBe(SERA_LINE.text);
    expect(subs.remainingSeconds).toBe(4);
  });

  it('queues a second line instead of overwriting the first', () => {
    subs.show(SERA_LINE);
    subs.show(MARA_LINE);

    // The whole reason the queue exists: Sera is still mid-sentence.
    expect(subs.currentLine).toBe(SERA_LINE);
    expect(subs.queueLength).toBe(1);
  });

  it('presents queued lines in order', () => {
    subs.show(SERA_LINE);
    subs.show(MARA_LINE);

    subs.tick(4);

    expect(subs.currentLine).toBe(MARA_LINE);
    expect(subs.visibleText).toBe(MARA_LINE.text);
    expect(subs.queueLength).toBe(0);
  });

  it('empties the band when the last line expires', () => {
    subs.show(MARA_LINE);

    subs.tick(2.5);

    expect(subs.isVisible).toBe(false);
    expect(subs.currentLine).toBeNull();
    expect(query('.subtitles__text').textContent).toBe('');
  });

  it('queues a whole scene in order', () => {
    subs.showAll([SERA_LINE, MARA_LINE]);

    expect(subs.currentLine).toBe(SERA_LINE);
    expect(subs.queueLength).toBe(1);
  });
});

describe('Subtitles duration advancement', () => {
  it('counts the delta down', () => {
    subs.show(SERA_LINE);

    subs.tick(1.5);

    expect(subs.remainingSeconds).toBeCloseTo(2.5, 6);
    expect(subs.currentLine).toBe(SERA_LINE);
  });

  it('rolls surplus time into the next line', () => {
    subs.show({ ...MARA_LINE, duration: 1 });
    subs.show({ ...SERA_LINE, duration: 3 });

    subs.tick(1.5);

    // A long frame must not silently add half a second to every remaining line
    // of the conversation.
    expect(subs.visibleText).toBe(SERA_LINE.text);
    expect(subs.remainingSeconds).toBeCloseTo(2.5, 6);
  });

  it('ignores a non-advancing delta', () => {
    subs.show(MARA_LINE);

    subs.tick(0);
    subs.tick(-3);
    subs.tick(Number.NaN);

    expect(subs.remainingSeconds).toBe(2);
    expect(subs.currentLine).toBe(MARA_LINE);
  });

  it('does nothing when the band is already empty', () => {
    expect(() => subs.tick(10)).not.toThrow();
    expect(subs.currentLine).toBeNull();
  });

  it('caps how many cues one absurd frame can drain', () => {
    const lines: SubtitleLine[] = Array.from({ length: 12 }, (_, index) => ({
      speaker: 'Dispatch',
      text: `Sector ${index + 1} sealed.`,
      duration: 0.1,
    }));
    subs.showAll(lines);

    subs.tick(100);

    // Rolling surplus forward must not let one stalled frame flush a whole
    // conversation the player never saw.
    expect(subs.visibleText).toBe('Sector 9 sealed.');
    expect(subs.queueLength).toBe(3);
  });

  it('estimates a duration when the line has none', () => {
    subs.show({ speaker: null, text: 'Gate 3 is still sealed.', duration: 0 });

    // A line with missing audio metadata must be readable, not a single frame.
    expect(subs.remainingSeconds).toBeGreaterThan(1);
  });
});

describe('Subtitles skipping and clearing', () => {
  it('advanceCue moves to the next line immediately', () => {
    subs.show(SERA_LINE);
    subs.show(MARA_LINE);

    subs.advanceCue();

    expect(subs.currentLine).toBe(MARA_LINE);
    expect(subs.remainingSeconds).toBe(2);
  });

  it('advanceCue on the last line empties the band', () => {
    subs.show(MARA_LINE);

    subs.advanceCue();

    expect(subs.currentLine).toBeNull();
    expect(subs.isVisible).toBe(false);
  });

  it('clear force-drops the current line and the whole queue', () => {
    subs.show(SERA_LINE);
    subs.show(MARA_LINE);

    subs.clear();

    // Anything less than a full clear leaves the skipped scene's lines
    // appearing over the next one.
    expect(subs.currentLine).toBeNull();
    expect(subs.queueLength).toBe(0);
    expect(subs.visibleText).toBe('');
    expect(query('.subtitles__text').textContent).toBe('');
    expect(query('.subtitles__speaker').textContent).toBe('');
  });

  it('clear on an empty band emits nothing', () => {
    const changed = vi.fn();
    subs.on('cue-changed', changed);

    subs.clear();

    expect(changed).not.toHaveBeenCalled();
  });

  it('reports cue changes', () => {
    const changed = vi.fn();
    subs.on('cue-changed', changed);

    subs.show(MARA_LINE);
    expect(changed).toHaveBeenCalledWith({ line: MARA_LINE, text: MARA_LINE.text });

    subs.tick(2);
    expect(changed).toHaveBeenLastCalledWith({ line: null, text: '' });
  });
});

describe('Subtitles settings', () => {
  it('renders the speaker name when enabled', () => {
    subs.show(SERA_LINE);

    expect(subs.visibleSpeaker).toBe('Sera Holt');
    expect(query('.subtitles__speaker').hidden).toBe(false);
  });

  it('omits the speaker name when disabled', () => {
    recreate(settings({ subtitleSpeakerNames: false }));
    subs.show(SERA_LINE);

    expect(subs.visibleSpeaker).toBe('');
    expect(query('.subtitles__speaker').hidden).toBe(true);
    // The line itself is unaffected.
    expect(subs.visibleText).toBe(SERA_LINE.text);
  });

  it('omits the speaker for unattributed audio even when names are on', () => {
    // PA announcements and recovered archive recordings have no speaker.
    subs.show({ speaker: null, text: 'Flood gate four: manual override refused.', duration: 3 });

    expect(subs.visibleSpeaker).toBe('');
    expect(query('.subtitles__speaker').hidden).toBe(true);
  });

  it('applies the speaker setting to a line already on screen', () => {
    subs.show(SERA_LINE);

    subs.applySettings(settings({ subtitleSpeakerNames: false }));

    expect(subs.visibleSpeaker).toBe('');
    expect(subs.visibleText).toBe(SERA_LINE.text);
  });

  it('writes the scale as a local custom property', () => {
    recreate(settings({ subtitleScale: 1.6 }));

    // Local, not the global --a11y-subtitle-scale token: if both were written
    // from the same setting the scale would be squared.
    expect(subs.element.style.getPropertyValue('--sub-scale')).toBe('1.6');
  });

  it('reflects each background mode as a class', () => {
    recreate(settings({ subtitleBackground: 'none' }));
    expect(subs.element.classList.contains('subtitles--bg-none')).toBe(true);
    expect(subs.element.classList.contains('subtitles--bg-solid')).toBe(false);

    subs.applySettings(settings({ subtitleBackground: 'solid' }));
    expect(subs.element.classList.contains('subtitles--bg-solid')).toBe(true);
    expect(subs.element.classList.contains('subtitles--bg-none')).toBe(false);

    subs.applySettings(settings({ subtitleBackground: 'shadow' }));
    expect(subs.element.classList.contains('subtitles--bg-shadow')).toBe(true);
  });

  it('reflects high contrast as a class', () => {
    recreate(settings({ highContrastSubtitles: true }));
    expect(subs.element.classList.contains('subtitles--contrast')).toBe(true);
  });

  it('hides the band and drops lines when subtitles are off', () => {
    recreate(settings({ subtitles: false }));

    const cues = subs.show(SERA_LINE);

    expect(cues).toBe(0);
    expect(subs.element.hidden).toBe(true);
    expect(subs.currentLine).toBeNull();
    expect(subs.queueLength).toBe(0);
  });

  it('clears the backlog when subtitles are switched off mid-scene', () => {
    subs.show(SERA_LINE);
    subs.show(MARA_LINE);

    subs.applySettings(settings({ subtitles: false }));

    // Re-enabling must not dump lines whose audio already played.
    expect(subs.currentLine).toBeNull();
    expect(subs.queueLength).toBe(0);

    subs.applySettings(settings({ subtitles: true }));
    expect(subs.currentLine).toBeNull();
    expect(subs.element.hidden).toBe(false);
  });
});

describe('Subtitles line length', () => {
  const CAPACITY = 56 * 2;

  const LONG_LINE: SubtitleLine = {
    speaker: 'Dax Ren',
    text:
      'You told me the archive was split across three departments in March, ' +
      'and then you told the borough council it was a technical failure report, ' +
      'so which of those two statements do you want on the record tonight?',
    duration: 12,
  };

  /** Drains the band, collecting every cue text and duration in order. */
  function drain(): { texts: string[]; durations: number[] } {
    const texts: string[] = [];
    const durations: number[] = [];
    while (subs.currentLine !== null) {
      texts.push(subs.visibleText);
      durations.push(subs.remainingSeconds);
      subs.advanceCue();
    }
    return { texts, durations };
  }

  it('keeps a short line as a single cue', () => {
    expect(subs.show(MARA_LINE)).toBe(1);
  });

  it('splits a long line into consecutive cues', () => {
    const cues = subs.show(LONG_LINE);

    expect(cues).toBeGreaterThan(1);
    expect(subs.queueLength).toBe(cues - 1);
  });

  it('keeps every cue inside the band capacity', () => {
    subs.show(LONG_LINE);

    const { texts } = drain();

    for (const text of texts) {
      // Overflow either clips the line or pushes the band down over the touch
      // controls. Both are worse than splitting into another cue.
      expect(text.length).toBeLessThanOrEqual(CAPACITY);
    }
  });

  it('loses no words when splitting', () => {
    subs.show(LONG_LINE);

    const { texts } = drain();

    expect(texts.join(' ')).toBe(LONG_LINE.text);
  });

  it('divides the authored duration across the cues', () => {
    subs.show(LONG_LINE);

    const { durations } = drain();
    const total = durations.reduce((sum, value) => sum + value, 0);

    // The cues must sum to the voice clip's length or the band drifts out of
    // sync with the audio.
    expect(total).toBeCloseTo(LONG_LINE.duration, 6);
    for (const duration of durations) expect(duration).toBeGreaterThan(0);
  });

  it('hard-splits a single token longer than the band', () => {
    const token = 'A'.repeat(CAPACITY + 30);
    const cues = subs.show({ speaker: null, text: token, duration: 4 });

    expect(cues).toBe(2);
    const { texts } = drain();
    expect(texts[0].length).toBe(CAPACITY);
    expect(texts.join('')).toBe(token);
  });

  it('honours a configured cap', () => {
    recreate(settings(), { maxLineChars: 20, maxLines: 1 });

    const cues = subs.show(SERA_LINE);

    expect(cues).toBeGreaterThan(3);
    const { texts } = drain();
    for (const text of texts) expect(text.length).toBeLessThanOrEqual(20);
  });

  it('ignores an empty line', () => {
    expect(subs.show({ speaker: 'Ivo Saye', text: '   ', duration: 2 })).toBe(0);
    expect(subs.currentLine).toBeNull();
  });
});

describe('Subtitles change-gated writes', () => {
  const TEXT_CONTENT_DESCRIPTOR = Object.getOwnPropertyDescriptor(
    Node.prototype,
    'textContent',
  );

  function trackTextWrites(node: Node): {
    spy: ReturnType<typeof vi.fn<(value: string) => void>>;
    restore: () => void;
  } {
    const getter = TEXT_CONTENT_DESCRIPTOR?.get;
    const setter = TEXT_CONTENT_DESCRIPTOR?.set;
    if (!getter || !setter) {
      throw new Error('textContent is not an accessor in this environment');
    }

    const spy = vi.fn<(value: string) => void>();
    Object.defineProperty(node, 'textContent', {
      configurable: true,
      get: () => getter.call(node) as string,
      set: (value: string) => {
        spy(value);
        setter.call(node, value);
      },
    });

    return { spy, restore: () => void Reflect.deleteProperty(node, 'textContent') };
  }

  it('does not rewrite the visible line when only an unrelated setting changed', () => {
    subs.show(SERA_LINE);
    const { spy, restore } = trackTextWrites(query('.subtitles__text'));

    subs.applySettings(settings({ subtitleBackground: 'solid' }));

    // The band is an aria-live region: rewriting identical text makes a screen
    // reader repeat a line the player is still reading.
    expect(spy).not.toHaveBeenCalled();
    expect(subs.visibleText).toBe(SERA_LINE.text);

    restore();
  });

  it('does not rewrite the speaker when consecutive lines share one', () => {
    subs.show(SERA_LINE);
    const { spy, restore } = trackTextWrites(query('.subtitles__speaker'));

    subs.show({ ...SERA_LINE, id: 'act1.sera.pump12.03', text: 'Give me the amp reading.' });
    subs.advanceCue();

    expect(subs.visibleText).toBe('Give me the amp reading.');
    expect(spy).not.toHaveBeenCalled();

    restore();
  });

  it('writes the line exactly once per cue change', () => {
    subs.show(SERA_LINE);
    subs.show(MARA_LINE);
    const { spy, restore } = trackTextWrites(query('.subtitles__text'));

    subs.advanceCue();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(MARA_LINE.text);

    restore();
  });
});

describe('Subtitles lifecycle', () => {
  it('dispose detaches the root and stops emitting', () => {
    const changed = vi.fn();
    subs.on('cue-changed', changed);
    const root = subs.element;

    subs.dispose();

    expect(root.parentElement).toBeNull();
    subs.show(SERA_LINE);
    expect(changed).not.toHaveBeenCalled();
  });
});
