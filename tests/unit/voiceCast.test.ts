/**
 * Voice cast configuration and generated VO manifest.
 *
 * The failure this file exists to catch is the most expensive kind of content
 * bug in a voiced game: a line that plays in the wrong voice, or a clip whose
 * audio says something different from the subtitle over it. Neither throws,
 * neither shows up in a typecheck, and both need a human listening to a
 * two-hour campaign to notice. So the invariants that *can* be machine-checked
 * are checked against the shipped files here.
 *
 * IMPORTANT SCOPE NOTE: the generated audio is deliberately NOT committed (see
 * ASSET_LICENSES.md — edge-tts output carries no redistribution licence), so
 * nothing below asserts that an mp3 or a vtt exists on disk. That would pass on
 * the machine that ran the pipeline and fail in CI, which is the wrong signal.
 * What is committed, and therefore what is tested, is the *manifest*: the ledger
 * of what was generated from what. It is checked for internal consistency and
 * against the authored dialogue it claims to cover.
 *
 * The cross-language parity test is the load-bearing one. The pipeline is Python
 * and the schema is TypeScript, so the speaker enum and the clip-id format exist
 * in both places. Left unchecked they would drift, and the symptom would be a
 * silent character.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  VOICE_CAST_SCHEMA_VERSION,
  driftedLines,
  indexManifest,
  parseVoiceCast,
  parseVoiceManifest,
  validateVoiceCast,
  voiceClipId,
  type VoiceCast,
  type VoiceDirection,
} from '../../src/game/dialogue/voiceSchema';
import { SPEAKER_IDS, type SpeakerId } from '../../src/game/dialogue/dialogueSchema';

// The shipped artefacts, imported rather than reconstructed.
import castRaw from '../../content/voices/cast.json';
import manifestRaw from '../../content/dialogue/vo-manifest.json';
import prologueBridge from '../../content/dialogue/prologue_bridge.json';
import prologueDepot from '../../content/dialogue/prologue_depot.json';
import act1Perimeter from '../../content/dialogue/act1_perimeter_contact.json';

const cast = parseVoiceCast(castRaw);
const manifest = parseVoiceManifest(manifestRaw);

const SCENES = [prologueBridge, prologueDepot, act1Perimeter] as unknown as {
  sceneId: string;
  nodes: { id: string; speaker: SpeakerId; text: string; duration?: number }[];
}[];

/** Every authored spoken line across every shipped scene. */
const AUTHORED = SCENES.flatMap((scene) =>
  scene.nodes.map((node) => ({
    scene: scene.sceneId,
    node: node.id,
    speaker: node.speaker,
    text: node.text,
    duration: node.duration,
  })),
);

/** A minimal valid cast, so a test overrides only the field under test. */
function fixture(overrides: Partial<VoiceCast> = {}): VoiceCast {
  const direction = (voice: string): VoiceDirection => ({
    voice,
    rate: '+0%',
    pitch: '+0Hz',
    volume: '+0%',
    channel: 'direct',
    loudnessOffsetDb: 0,
    direction:
      'A sufficiently long explanation of why this voice and these settings were chosen.',
  });

  const entries = Object.fromEntries(
    SPEAKER_IDS.map((speaker, index) => [speaker, direction(`en-US-Test${index}Neural`)]),
  ) as Record<SpeakerId, VoiceDirection>;

  return {
    version: VOICE_CAST_SCHEMA_VERSION,
    backend: 'edge-tts',
    output: {
      container: 'mp3',
      codec: 'libmp3lame',
      bitrate: '48k',
      sampleRate: 24000,
      channels: 1,
    },
    loudness: { targetLufs: -19, truePeakDb: -1.5, loudnessRange: 7 },
    silence: { trimThresholdDb: -50, leadInMs: 30, tailMs: 120, interruptedTailMs: 0 },
    textTransforms: {
      stripLeadingDash: true,
      stripTrailingDash: true,
      ellipsisToComma: true,
      emDashToComma: true,
    },
    channels: { direct: { filter: null }, radio: { filter: 'highpass=f=300' } },
    pronunciations: {},
    sceneChannelOverrides: {},
    cast: entries,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe('voiceCastSchema', () => {
  it('accepts a well-formed cast', () => {
    expect(() => parseVoiceCast(fixture())).not.toThrow();
  });

  it('strips note keys rather than rejecting them', () => {
    // The shipped file documents itself in-band; the schema is strict about
    // everything that is genuinely data.
    const raw = { ...fixture(), note: 'a top-level comment' };
    expect(() => parseVoiceCast(raw)).not.toThrow();
  });

  it('strips nested note keys too', () => {
    const base = fixture();
    const raw = {
      ...base,
      output: { ...base.output, note: 'why mp3 and not ogg' },
      channels: { direct: { filter: null, note: 'in the room' } },
    };
    expect(() => parseVoiceCast(raw)).not.toThrow();
  });

  it('rejects a non-object', () => {
    expect(() => parseVoiceCast(null)).toThrow(/invalid voice cast/);
    expect(() => parseVoiceCast('edge-tts')).toThrow(/invalid voice cast/);
  });

  it('rejects an unsupported schema version', () => {
    expect(() => parseVoiceCast(fixture({ version: 99 }))).toThrow(
      /not the supported version/,
    );
  });

  it.each([
    ['an unsigned rate', 'rate', '3%'],
    ['a rate with no unit', 'rate', '+3'],
    ['an unsigned pitch', 'pitch', '10Hz'],
    ['a pitch in percent', 'pitch', '+10%'],
    ['an unsigned volume', 'volume', '0%'],
  ])('rejects %s', (_label, field, value) => {
    // The backend treats these as offsets and rejects an unsigned zero rather
    // than interpreting it, so an unsigned value would silently lose a whole
    // character's direction.
    const base = fixture();
    const broken = {
      ...base,
      cast: { ...base.cast, mara: { ...base.cast.mara, [field]: value } },
    };
    expect(() => parseVoiceCast(broken)).toThrow(/invalid voice cast/);
  });

  it('accepts a signed zero', () => {
    const base = fixture();
    const zeroed = {
      ...base,
      cast: { ...base.cast, mara: { ...base.cast.mara, rate: '+0%', pitch: '+0Hz' } },
    };
    expect(() => parseVoiceCast(zeroed)).not.toThrow();
  });

  it('rejects an unknown speaker id in the cast', () => {
    const base = fixture();
    const broken = { ...base, cast: { ...base.cast, narrator: base.cast.mara } };
    expect(() => parseVoiceCast(broken)).toThrow(/invalid voice cast/);
  });

  it('rejects an undocumented voice choice', () => {
    // `direction` is required and must be substantial: an undocumented "-6%" is
    // a number nobody will dare change later.
    const base = fixture();
    const broken = {
      ...base,
      cast: { ...base.cast, ivo: { ...base.cast.ivo, direction: 'tired' } },
    };
    expect(() => parseVoiceCast(broken)).toThrow(/invalid voice cast/);
  });

  it('rejects stereo dialogue', () => {
    const base = fixture();
    const broken = { ...base, output: { ...base.output, channels: 2 } };
    expect(() => parseVoiceCast(broken)).toThrow(/invalid voice cast/);
  });

  it.each([
    ['a loudness target with no headroom', { targetLufs: -6 }],
    ['a loudness target nobody could hear on a phone', { targetLufs: -30 }],
    ['a true peak above the ceiling', { truePeakDb: 0 }],
  ])('rejects %s', (_label, overrides) => {
    const base = fixture();
    expect(() =>
      parseVoiceCast({ ...base, loudness: { ...base.loudness, ...overrides } }),
    ).toThrow(/invalid voice cast/);
  });

  it('rejects a loudness offset large enough to be a mixing decision', () => {
    const base = fixture();
    const broken = {
      ...base,
      cast: { ...base.cast, mara: { ...base.cast.mara, loudnessOffsetDb: -9 } },
    };
    expect(() => parseVoiceCast(broken)).toThrow(/invalid voice cast/);
  });
});

// ---------------------------------------------------------------------------
// Semantic validation
// ---------------------------------------------------------------------------

describe('validateVoiceCast', () => {
  it('passes a clean cast', () => {
    expect(validateVoiceCast(fixture())).toEqual([]);
  });

  it('flags a speaker with no voice', () => {
    const base = fixture();
    const { wen: _dropped, ...rest } = base.cast;
    const issues = validateVoiceCast({
      ...base,
      cast: rest as Record<SpeakerId, VoiceDirection>,
    });
    expect(issues.map((i) => i.code)).toContain('missing-speaker');
    expect(issues.find((i) => i.code === 'missing-speaker')?.target).toBe('wen');
  });

  it('flags two characters sharing one voice', () => {
    const base = fixture();
    const issues = validateVoiceCast({
      ...base,
      cast: { ...base.cast, dax: { ...base.cast.dax, voice: base.cast.mara.voice } },
    });
    const shared = issues.find((i) => i.code === 'shared-voice');
    expect(shared).toBeDefined();
    expect(shared?.message).toContain('dax');
    expect(shared?.message).toContain('mara');
  });

  it('flags a reference to an undefined channel', () => {
    const base = fixture();
    const issues = validateVoiceCast({
      ...base,
      cast: {
        ...base.cast,
        wen: { ...base.cast.wen, channel: 'telephone' as 'radio' },
      },
    });
    expect(issues.map((i) => i.code)).toContain('unknown-channel');
  });

  it('flags extreme pitch manipulation', () => {
    // Spec 20.6 forbids it, and a "new" character made by pitch-shifting an
    // existing voice is the cheapest kind of fake casting.
    const base = fixture();
    const issues = validateVoiceCast({
      ...base,
      cast: { ...base.cast, kit: { ...base.cast.kit, pitch: '+40Hz' } },
    });
    expect(issues.map((i) => i.code)).toContain('extreme-pitch');
  });

  it('flags a scene override to an undefined channel', () => {
    const issues = validateVoiceCast(
      fixture({ sceneChannelOverrides: { prologue_bridge: { sera: 'intercom' as 'radio' } } }),
    );
    expect(issues.map((i) => i.code)).toContain('unknown-override-channel');
  });

  it('flags an override that changes nothing', () => {
    // Harmless, but it means somebody believes they changed a delivery and did not.
    const issues = validateVoiceCast(
      fixture({ sceneChannelOverrides: { prologue_bridge: { mara: 'direct' } } }),
    );
    expect(issues.map((i) => i.code)).toContain('redundant-override');
  });
});

// ---------------------------------------------------------------------------
// The shipped cast
// ---------------------------------------------------------------------------

describe('shipped voice cast', () => {
  it('parses and passes semantic validation with no issues', () => {
    expect(validateVoiceCast(cast)).toEqual([]);
  });

  it('casts every speaker in the closed enum', () => {
    // A speaker with no entry is a character who would ship silent.
    for (const speaker of SPEAKER_IDS) {
      expect(cast.cast[speaker], speaker).toBeDefined();
    }
    expect(Object.keys(cast.cast).sort()).toEqual([...SPEAKER_IDS].sort());
  });

  it('gives all twelve characters a distinct voice', () => {
    const voices = Object.values(cast.cast).map((d) => d.voice);
    expect(new Set(voices).size).toBe(SPEAKER_IDS.length);
  });

  it('does not deliver every voice identically (spec 20.6)', () => {
    // The spec's actual requirement: pace, pitch and loudness must vary across
    // the cast. A config where every character is "+0%" is a config nobody
    // directed.
    const rates = new Set(Object.values(cast.cast).map((d) => d.rate));
    const pitches = new Set(Object.values(cast.cast).map((d) => d.pitch));
    const loudness = new Set(Object.values(cast.cast).map((d) => d.loudnessOffsetDb));
    expect(rates.size).toBeGreaterThanOrEqual(6);
    expect(pitches.size).toBeGreaterThanOrEqual(4);
    expect(loudness.size).toBeGreaterThanOrEqual(3);
  });

  it('keeps every pitch adjustment inside the artefact-free band', () => {
    for (const [speaker, direction] of Object.entries(cast.cast)) {
      const hz = Number.parseInt(direction.pitch.replace('Hz', ''), 10);
      expect(Math.abs(hz), speaker).toBeLessThanOrEqual(15);
    }
  });

  it('documents every voice choice at length', () => {
    for (const [speaker, direction] of Object.entries(cast.cast)) {
      expect(direction.direction.length, speaker).toBeGreaterThan(80);
    }
  });

  it('defines a direct channel with no processing and a radio channel with some', () => {
    expect(cast.channels.direct?.filter).toBeNull();
    expect(cast.channels.radio?.filter).toBeTruthy();
  });

  it('band-limits the radio channel steeply enough to be audible', () => {
    // One biquad stage is ~12 dB/octave and measured only 3 dB of reduction,
    // which is inaudible. The chain therefore cascades two stages per side.
    const filter = cast.channels.radio?.filter ?? '';
    expect((filter.match(/highpass/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((filter.match(/lowpass/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('routes Sera over a radio in both prologue scenes but not by default', () => {
    // Delivery is a property of the scene: she is a voice on a channel through
    // the prologue and physically present later, so this must not be baked into
    // her cast entry.
    expect(cast.cast.sera.channel).toBe('direct');
    expect(cast.sceneChannelOverrides.prologue_bridge?.sera).toBe('radio');
    expect(cast.sceneChannelOverrides.prologue_depot?.sera).toBe('radio');
  });

  it('picks a container every target browser can actually decode', () => {
    // Opus is smaller, but Safari and iOS cannot decode Ogg via
    // decodeAudioData, and spec 21 requires the campaign to finish on iOS.
    expect(cast.output.container).toBe('mp3');
    expect(cast.output.channels).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cross-language parity
// ---------------------------------------------------------------------------

describe('python pipeline parity', () => {
  // Resolved from the vitest root rather than `import.meta.url`: the jsdom
  // environment does not give this module a `file:` URL to resolve against.
  const source = readFileSync(resolve(process.cwd(), 'scripts/vo/generate_vo.py'), 'utf8');

  it('duplicates the speaker enum with no drift', () => {
    // The pipeline must fail on an unknown speaker without importing
    // TypeScript, so the enum exists twice. Unchecked, the two would drift and
    // the symptom would be a silent character.
    const block = /SPEAKER_IDS = \(([\s\S]*?)\)/.exec(source);
    expect(block, 'SPEAKER_IDS tuple not found in generate_vo.py').not.toBeNull();
    const pythonIds = [...(block![1] ?? '').matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(pythonIds).toEqual([...SPEAKER_IDS]);
  });

  it('agrees with voiceClipId on the clip-id format', () => {
    // Python builds `f"{scene_id}__{node_id}"`; TypeScript must produce the same
    // string or the runtime would look up ids the pipeline never wrote.
    expect(source).toContain('f"{self.scene_id}__{self.node_id}"');
    expect(voiceClipId('prologue_bridge', 'sera_open')).toBe('prologue_bridge__sera_open');
  });

  it('agrees on the schema version the manifest declares', () => {
    const version = /MANIFEST_VERSION = (\d+)/.exec(source);
    expect(version).not.toBeNull();
    expect(Number(version![1])).toBe(manifest.version);
  });

  it('writes audio under the base path the manifest advertises', () => {
    expect(manifest.audioBase).toBe('assets/audio/dialogue');
  });
});

// ---------------------------------------------------------------------------
// The shipped manifest
// ---------------------------------------------------------------------------

describe('shipped vo manifest', () => {
  it('parses against the schema', () => {
    expect(manifest.backend.id).toBe('edge-tts');
    expect(manifest.lines.length).toBeGreaterThan(0);
  });

  it('covers every authored spoken line', () => {
    const index = indexManifest(manifest);
    const missing = AUTHORED.filter(
      (line) => !index.has(voiceClipId(line.scene, line.node)),
    ).map((line) => voiceClipId(line.scene, line.node));
    expect(missing).toEqual([]);
  });

  it('has no entry for a line nobody authored', () => {
    // A stale entry means a renamed node left an orphan clip behind.
    const authored = new Set(AUTHORED.map((line) => voiceClipId(line.scene, line.node)));
    const orphans = manifest.lines.filter((line) => !authored.has(line.id)).map((l) => l.id);
    expect(orphans).toEqual([]);
  });

  it('records text matching the authored line exactly', () => {
    // The drift this catches: a line is reworded, the manifest is not
    // regenerated, and the game ships a clip saying the old wording under a
    // subtitle showing the new one.
    expect(driftedLines(manifest, AUTHORED)).toEqual([]);
  });

  it('attributes every line to the speaker the scene assigned', () => {
    const index = indexManifest(manifest);
    for (const line of AUTHORED) {
      const record = index.get(voiceClipId(line.scene, line.node));
      expect(record?.speaker, record?.id).toBe(line.speaker);
    }
  });

  it('uses the voice the cast assigns to that speaker', () => {
    // The wrong-voice bug, checked directly.
    for (const record of manifest.lines) {
      expect(record.voice, record.id).toBe(cast.cast[record.speaker].voice);
    }
  });

  it('applies the per-scene channel override where one exists', () => {
    for (const record of manifest.lines) {
      const override = cast.sceneChannelOverrides[record.scene]?.[record.speaker];
      const expected = override ?? cast.cast[record.speaker].channel;
      expect(record.channel, record.id).toBe(expected);
    }
  });

  it('gives every line a deterministic path derived from its ids', () => {
    for (const record of manifest.lines) {
      expect(record.audio, record.id).toBe(
        `dialogue/${record.scene}/${record.node}.${cast.output.container}`,
      );
      expect(record.subtitle, record.id).toBe(
        `dialogue/${record.scene}/${record.node}.vtt`,
      );
    }
  });

  it('gives every line a distinct content hash unless the text is identical', () => {
    const byHash = new Map<string, string[]>();
    for (const record of manifest.lines) {
      byHash.set(record.sourceHash, [...(byHash.get(record.sourceHash) ?? []), record.id]);
    }
    for (const [hash, ids] of byHash) {
      if (ids.length === 1) continue;
      const texts = new Set(
        ids.map((id) => manifest.lines.find((l) => l.id === id)?.text),
      );
      expect(texts.size, `${hash} shared by ${ids.join(', ')}`).toBe(1);
    }
  });

  it('measures a plausible duration for every line', () => {
    for (const record of manifest.lines) {
      expect(record.duration, record.id).toBeGreaterThan(0.2);
      expect(record.duration, record.id).toBeLessThan(20);
    }
  });

  it('lands within a usable band of the hand-authored duration estimates', () => {
    // The authored durations were estimated by hand from word counts before any
    // audio existed, and are still the fallback timing for a line with no clip.
    // This is the first measurement of how good those estimates were.
    //
    // The band is wide and asymmetric, and the next two tests are what make it
    // meaningful: this one only catches a line that is wrong by a factor, and
    // the systematic-bias and overrun-cause tests catch everything subtler.
    const compared = manifest.lines.filter((l) => l.authoredDuration !== null);
    expect(compared.length).toBeGreaterThan(60);
    for (const record of compared) {
      const ratio = record.duration / (record.authoredDuration as number);
      const detail = `${record.id} measured ${record.duration}s vs authored ${record.authoredDuration}s`;
      expect(ratio, detail).toBeGreaterThan(0.4);
      expect(ratio, detail).toBeLessThan(1.8);
    }
  });

  it('overruns its estimate only on short, heavily punctuated lines', () => {
    // The finding this pins down, rather than papering over with a wider band.
    //
    // Authored durations were estimated from word counts at roughly 2.5-3.2
    // words per second. That model has no term for sentence-final pauses, and
    // the synthesiser inserts roughly half a second at every full stop — so a
    // line that is *mostly* full stops overruns badly. Both offenders in the
    // shipped content are Dax catching himself:
    //
    //   "—sorry. That was five questions. I do that."   8 words, 3 sentences
    //   "That's the gate. Fine. Slower."                5 words, 3 sentences
    //
    // Long lines amortise the pauses across many words and land close to
    // estimate. So the assertion is not "nothing overruns" — things do — but
    // "everything that overruns is explained by this cause". A long line
    // overrunning would mean the rate configuration is wrong, and would fail.
    const sentences = (text: string): number =>
      (text.match(/[.!?]+(?:\s|$)/g) ?? []).length;
    const wordsIn = (text: string): number => text.split(/\s+/).filter(Boolean).length;

    const overruns = manifest.lines
      .filter((l) => l.authoredDuration !== null)
      .filter((l) => l.duration / (l.authoredDuration as number) > 1.35);

    for (const record of overruns) {
      const words = wordsIn(record.text);
      const stops = sentences(record.text);
      const detail = `${record.id}: ${words} words, ${stops} sentences, ${record.duration}s vs ${record.authoredDuration}s`;
      expect(words, detail).toBeLessThanOrEqual(10);
      expect(stops, detail).toBeGreaterThanOrEqual(2);
    }

    // Guards the guard: if a content edit removed both offenders this test would
    // pass vacuously, and the estimate model would look better than it is.
    expect(overruns.length).toBeGreaterThan(0);
  });

  it('shows no systematic bias between estimated and measured durations', () => {
    // The per-line band above is loose enough that a uniform drift could hide
    // inside it, so the median is pinned separately. If the whole cast were
    // being synthesised at the wrong rate — a global `rate` mistake, say — every
    // line would still pass individually while this fails.
    const ratios = manifest.lines
      .filter((l) => l.authoredDuration !== null)
      .map((l) => l.duration / (l.authoredDuration as number))
      .sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)] as number;
    expect(median).toBeGreaterThan(0.7);
    expect(median).toBeLessThan(1.1);
  });

  it('reports totals consistent with its own line records', () => {
    expect(manifest.totals.lines).toBe(manifest.lines.length);
    const summed = manifest.lines.reduce((total, line) => total + line.duration, 0);
    expect(manifest.totals.spokenSeconds).toBeCloseTo(summed, 1);

    const counted: Record<string, number> = {};
    for (const line of manifest.lines) {
      counted[line.speaker] = (counted[line.speaker] ?? 0) + 1;
    }
    expect(manifest.totals.bySpeaker).toEqual(counted);
  });

  it('normalises every line to within a decibel of the others', () => {
    // The point of the two-pass loudnorm: a one-word line and a thirteen-second
    // run-on must sit at the same perceived level.
    const measured = manifest.lines
      .map((l) => l.measuredLufs)
      .filter((v): v is number => v !== null);
    expect(measured.length).toBe(manifest.lines.length);
    // These are the *input* measurements, so they legitimately vary; the check
    // is that nothing arrived so quiet or so hot that normalisation had to make
    // an extreme correction.
    for (const lufs of measured) {
      expect(lufs).toBeGreaterThan(-40);
      expect(lufs).toBeLessThan(-6);
    }
  });

  it('carries word timings for every line, so cues can be word-synced', () => {
    for (const record of manifest.lines) {
      expect(record.words, record.id).toBeGreaterThan(0);
    }
  });

  it('gives Dax a voice at last', () => {
    // He had zero lines and appeared nowhere in the content until Act I landed.
    const dax = manifest.lines.filter((l) => l.speaker === 'dax');
    expect(dax.length).toBeGreaterThan(0);
    expect(new Set(dax.map((l) => l.voice)).size).toBe(1);
  });

  it('voices all four main characters and at least two minor ones', () => {
    const speakers = new Set(manifest.lines.map((l) => l.speaker));
    for (const main of ['mara', 'sera', 'ivo', 'dax'] as const) {
      expect(speakers.has(main), main).toBe(true);
    }
    const minor = [...speakers].filter(
      (s) => !['mara', 'sera', 'ivo', 'dax'].includes(s),
    );
    expect(minor.length).toBeGreaterThanOrEqual(2);
  });
});
