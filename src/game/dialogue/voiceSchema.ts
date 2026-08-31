/**
 * Voice cast and VO manifest data model (spec 20.4, 20.6, 62, 73).
 *
 * Two authored/generated artefacts are described here:
 *
 *   `content/voices/cast.json`            hand-edited voice direction, one entry
 *                                         per character
 *   `content/dialogue/vo-manifest.json`   generated ledger of what was
 *                                         synthesised from what
 *
 * The pipeline that consumes them is Python (`scripts/vo/generate_vo.py`),
 * because `edge-tts` is a Python client. That split is deliberate rather than
 * accidental: the *configuration* and the *manifest* are language-neutral JSON,
 * validated here so a typo is caught by `pnpm test` rather than surfacing as a
 * silent voice swap three hundred lines into a generation run. Spec 20.5 requires
 * the speech provider to stay replaceable, and a schema that describes the
 * artefacts rather than the tool is what makes swapping the tool cheap.
 *
 * ## Why the cast configuration is validated at all
 *
 * A dialogue node names a speaker; a speaker maps to a voice. If that mapping is
 * wrong, nothing throws — the line is simply spoken by the wrong person, which is
 * the single most expensive class of content bug to notice late, because it
 * requires a human to listen to it. So the invariants a schema *can* check are
 * checked here and asserted against the shipped file in
 * `tests/unit/voiceCast.test.ts`:
 *
 *   - every `SpeakerId` has an entry, so no line can ship silent
 *   - no two characters share a voice id, so nobody is confusable with anybody
 *   - every referenced channel exists
 *   - rate/pitch/volume are in the signed-offset form the backend requires
 *
 * ## What this module deliberately does not do
 *
 * It does not read the manifest at runtime to play audio. Dialogue playback is
 * `DialogueSystem`'s job and is wired through `AudioEngine`'s `dialogue` bus; the
 * manifest is a build artefact and a content-authoring gate. It is typed here so
 * the eventual runtime loader has one description to conform to instead of
 * inventing a second.
 */

import { z } from 'zod';
import { SPEAKER_IDS, speakerIdSchema, type SpeakerId } from './dialogueSchema';

// ---------------------------------------------------------------------------
// Backend-parameter formats
// ---------------------------------------------------------------------------

/**
 * Signed percentage offsets, e.g. `-3%`, `+7%`, `+0%`.
 *
 * The sign is mandatory even for zero. The backend treats these as *offsets from
 * the voice's natural delivery*, and an unsigned `0%` is rejected by the service
 * rather than interpreted, so requiring the sign here turns a silent
 * whole-character failure into a load-time error.
 */
const SIGNED_PERCENT = /^[+-]\d{1,3}%$/;
/** Signed hertz offsets, e.g. `-10Hz`, `+2Hz`. Same reasoning as above. */
const SIGNED_HERTZ = /^[+-]\d{1,3}Hz$/;

export const signedPercentSchema = z
  .string()
  .regex(SIGNED_PERCENT, 'must be a signed percentage such as "-3%" or "+0%"');

export const signedHertzSchema = z
  .string()
  .regex(SIGNED_HERTZ, 'must be a signed hertz offset such as "-10Hz" or "+0Hz"');

/**
 * Loudness trim per character, in dB, applied to the normalisation *target*.
 *
 * Bounded tightly on purpose. Spec 74 warns against over-processing, and a
 * character trimmed more than a couple of dB from the dialogue bed either
 * disappears under the ambience or jumps out of the mix. Anything larger is a
 * mixing decision that belongs to the audio bus, not to a voice.
 */
export const loudnessOffsetSchema = z.number().min(-3).max(3);

// ---------------------------------------------------------------------------
// Cast configuration
// ---------------------------------------------------------------------------

export const VOICE_CAST_SCHEMA_VERSION = 1;

/** Delivery path. `direct` is in the room; `radio` is over a handheld channel. */
export const DELIVERY_CHANNELS = ['direct', 'radio'] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];
export const deliveryChannelSchema = z.enum(DELIVERY_CHANNELS);

export interface VoiceDirection {
  /** Backend voice id, e.g. `en-GB-SoniaNeural`. */
  voice: string;
  rate: string;
  pitch: string;
  volume: string;
  channel: DeliveryChannel;
  loudnessOffsetDb: number;
  /**
   * Prose note on why this voice and these settings.
   *
   * Required, not optional. This file is voice *direction* — the reason a
   * character sounds the way they do is the most valuable thing in it, and an
   * undocumented `-6%` is a number nobody will dare change later.
   */
  direction: string;
  /** Character-specific pronunciation overrides, merged over the global map. */
  pronunciations?: Record<string, string>;
}

/**
 * Note keys are stripped before validation.
 *
 * The shipped JSON carries `note` fields inside otherwise-typed objects so the
 * documentation sits next to what it documents. They are not part of the data
 * model, and the Python pipeline strips them before hashing so that rewording a
 * comment cannot invalidate a cache and re-synthesise the campaign.
 */
function stripNotes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNotes);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (key.toLowerCase().startsWith('note')) continue;
    out[key] = stripNotes(inner);
  }
  return out;
}

export const voiceDirectionSchema = z.strictObject({
  voice: z.string().min(1),
  rate: signedPercentSchema,
  pitch: signedHertzSchema,
  volume: signedPercentSchema,
  channel: deliveryChannelSchema,
  loudnessOffsetDb: loudnessOffsetSchema,
  direction: z.string().min(40, 'voice direction must actually explain the choice'),
  pronunciations: z.record(z.string().min(1), z.string().min(1)).optional(),
});

export interface VoiceOutputConfig {
  container: 'mp3' | 'ogg';
  codec: string;
  bitrate: string;
  sampleRate: number;
  channels: number;
}

export const voiceOutputSchema = z.strictObject({
  container: z.enum(['mp3', 'ogg']),
  codec: z.string().min(1),
  bitrate: z.string().regex(/^\d{1,3}k$/, 'bitrate looks like "48k"'),
  sampleRate: z.number().int().min(16000).max(48000),
  // Dialogue is mono. A stereo voice clip doubles the payload and cannot be
  // positioned by the panner, which is what makes it spatial in the first place.
  channels: z.literal(1),
});

export const voiceLoudnessSchema = z.strictObject({
  // Broadcast-adjacent range. Above -14 leaves no headroom under the music bed;
  // below -24 disappears on a phone speaker in a room with other people in it.
  targetLufs: z.number().min(-24).max(-14),
  truePeakDb: z.number().min(-3).max(-0.5),
  loudnessRange: z.number().min(1).max(20),
});

export const voiceSilenceSchema = z.strictObject({
  trimThresholdDb: z.number().min(-80).max(-20),
  leadInMs: z.number().int().min(0).max(500),
  tailMs: z.number().int().min(0).max(1000),
  interruptedTailMs: z.number().int().min(0).max(1000),
});

export const voiceTransformsSchema = z.strictObject({
  stripLeadingDash: z.boolean(),
  stripTrailingDash: z.boolean(),
  ellipsisToComma: z.boolean(),
  emDashToComma: z.boolean(),
});

export const channelDefinitionSchema = z.strictObject({
  /** ffmpeg filter chain, or null for an unprocessed channel. */
  filter: z.string().min(1).nullable(),
});

export interface VoiceCast {
  version: number;
  backend: string;
  output: VoiceOutputConfig;
  loudness: z.infer<typeof voiceLoudnessSchema>;
  silence: z.infer<typeof voiceSilenceSchema>;
  textTransforms: z.infer<typeof voiceTransformsSchema>;
  channels: Record<string, { filter: string | null }>;
  pronunciations: Record<string, string>;
  sceneChannelOverrides: Record<string, Partial<Record<SpeakerId, DeliveryChannel>>>;
  cast: Record<SpeakerId, VoiceDirection>;
}

export const voiceCastSchema = z.strictObject({
  version: z.number().int().positive(),
  backend: z.string().min(1),
  output: voiceOutputSchema,
  loudness: voiceLoudnessSchema,
  silence: voiceSilenceSchema,
  textTransforms: voiceTransformsSchema,
  channels: z.record(z.string().min(1), channelDefinitionSchema),
  pronunciations: z.record(z.string().min(1), z.string().min(1)),
  // `partialRecord`, not `record`: Zod treats an enum-keyed record as
  // exhaustive, and an override map naturally names only the one or two
  // characters whose delivery a scene changes.
  sceneChannelOverrides: z.record(
    z.string().min(1),
    z.partialRecord(speakerIdSchema, deliveryChannelSchema),
  ),
  cast: z.record(speakerIdSchema, voiceDirectionSchema),
});

/**
 * Parses the cast configuration, throwing on malformed input.
 *
 * Strips `note*` keys first, so the shipped file can stay self-documenting while
 * the schema stays strict about everything that is actually data.
 */
export function parseVoiceCast(raw: unknown): VoiceCast {
  const parsed = voiceCastSchema.safeParse(stripNotes(raw));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid voice cast: ${detail}`);
  }
  if (parsed.data.version !== VOICE_CAST_SCHEMA_VERSION) {
    throw new Error(
      `invalid voice cast: version ${parsed.data.version} is not the supported version ${VOICE_CAST_SCHEMA_VERSION}`,
    );
  }
  return parsed.data as VoiceCast;
}

// ---------------------------------------------------------------------------
// Cast validation
// ---------------------------------------------------------------------------

export type VoiceCastIssueCode =
  | 'missing-speaker'
  | 'shared-voice'
  | 'unknown-channel'
  | 'unknown-override-channel'
  | 'redundant-override'
  | 'extreme-pitch';

export interface VoiceCastIssue {
  code: VoiceCastIssueCode;
  message: string;
  target?: string;
}

/**
 * Semantic checks the schema cannot express.
 *
 * Every one of these is a bug whose only other symptom is a human noticing that
 * a line sounds wrong.
 */
export function validateVoiceCast(cast: VoiceCast): VoiceCastIssue[] {
  const issues: VoiceCastIssue[] = [];

  for (const speaker of SPEAKER_IDS) {
    if (cast.cast[speaker] === undefined) {
      issues.push({
        code: 'missing-speaker',
        message: `speaker "${speaker}" has no voice; every line they speak would ship silent`,
        target: speaker,
      });
    }
  }

  const byVoice = new Map<string, SpeakerId[]>();
  for (const [speaker, direction] of Object.entries(cast.cast) as [
    SpeakerId,
    VoiceDirection,
  ][]) {
    const existing = byVoice.get(direction.voice) ?? [];
    existing.push(speaker);
    byVoice.set(direction.voice, existing);

    if (cast.channels[direction.channel] === undefined) {
      issues.push({
        code: 'unknown-channel',
        message: `speaker "${speaker}" uses channel "${direction.channel}", which is not defined`,
        target: speaker,
      });
    }

    // Spec 20.6: do not use extreme pitch manipulation. Beyond roughly a
    // semitone the neural voices develop artefacts, and a "different" character
    // produced by pitch-shifting one voice is the cheapest kind of fake casting.
    const hz = Number.parseInt(direction.pitch.replace('Hz', ''), 10);
    if (Number.isFinite(hz) && Math.abs(hz) > 15) {
      issues.push({
        code: 'extreme-pitch',
        message: `speaker "${speaker}" is pitched ${direction.pitch}; beyond ±15Hz the voice artefacts (spec 20.6)`,
        target: speaker,
      });
    }
  }

  for (const [voice, speakers] of byVoice) {
    if (speakers.length > 1) {
      issues.push({
        code: 'shared-voice',
        message: `voice "${voice}" is used by ${speakers.sort().join(' and ')}; two characters must not be confusable`,
        target: voice,
      });
    }
  }

  for (const [scene, overrides] of Object.entries(cast.sceneChannelOverrides)) {
    for (const [speaker, channel] of Object.entries(overrides) as [
      SpeakerId,
      DeliveryChannel,
    ][]) {
      if (cast.channels[channel] === undefined) {
        issues.push({
          code: 'unknown-override-channel',
          message: `scene "${scene}" overrides "${speaker}" to undefined channel "${channel}"`,
          target: `${scene}:${speaker}`,
        });
        continue;
      }
      if (cast.cast[speaker]?.channel === channel) {
        // Harmless, but it means somebody believes they changed something.
        issues.push({
          code: 'redundant-override',
          message: `scene "${scene}" overrides "${speaker}" to "${channel}", which is already their default`,
          target: `${scene}:${speaker}`,
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Generated manifest
// ---------------------------------------------------------------------------

export const VO_MANIFEST_VERSION = 1;

export interface VoiceLineRecord {
  /** `<sceneId>__<nodeId>`. Deterministic, per spec 73. */
  id: string;
  scene: string;
  node: string;
  speaker: SpeakerId;
  /** The authored line, copied so a manifest is diffable without the scene file. */
  text: string;
  voice: string;
  rate: string;
  pitch: string;
  channel: DeliveryChannel;
  /** sha256 over text + voice settings + backend version (spec 73). */
  sourceHash: string;
  /** Path relative to `public/assets/audio`. */
  audio: string;
  /** WebVTT cue file, same base. */
  subtitle: string;
  /** Measured length of the shipped file, in seconds. */
  duration: number;
  /** The hand-authored estimate this take was measured against, if any. */
  authoredDuration: number | null;
  words: number;
  bytes: number;
  measuredLufs: number | null;
}

export const voiceLineRecordSchema = z.strictObject({
  id: z.string().min(1),
  scene: z.string().min(1),
  node: z.string().min(1),
  speaker: speakerIdSchema,
  text: z.string().min(1),
  voice: z.string().min(1),
  rate: signedPercentSchema,
  pitch: signedHertzSchema,
  channel: deliveryChannelSchema,
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/, 'sourceHash must be a sha256 hex digest'),
  audio: z.string().min(1),
  subtitle: z.string().min(1),
  duration: z.number().positive(),
  authoredDuration: z.number().positive().nullable(),
  words: z.number().int().min(0),
  bytes: z.number().int().positive(),
  measuredLufs: z.number().nullable(),
});

export interface VoiceManifest {
  version: number;
  backend: { id: string; version: string };
  castSignature: string;
  audioBase: string;
  totals: {
    lines: number;
    spokenSeconds: number;
    bySpeaker: Record<string, number>;
  };
  lines: VoiceLineRecord[];
}

export const voiceManifestSchema = z.object({
  version: z.number().int().positive(),
  backend: z.strictObject({ id: z.string().min(1), version: z.string().min(1) }),
  castSignature: z.string().min(1),
  audioBase: z.string().min(1),
  totals: z.strictObject({
    lines: z.number().int().min(0),
    spokenSeconds: z.number().min(0),
    bySpeaker: z.record(z.string(), z.number().int().min(0)),
  }),
  lines: z.array(voiceLineRecordSchema),
});

export function parseVoiceManifest(raw: unknown): VoiceManifest {
  const parsed = voiceManifestSchema.safeParse(stripNotes(raw));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid vo manifest: ${detail}`);
  }
  return parsed.data as VoiceManifest;
}

/**
 * Runtime clip id for a dialogue node.
 *
 * The one place this string is spelled out in TypeScript. `AudioEngine.load`
 * takes an opaque clip id and a URL, so this is what binds a scene/node pair to
 * the file the pipeline produced — and it must stay byte-identical to
 * `Line.clip_id` in `scripts/vo/generate_vo.py`, which a test asserts against the
 * shipped manifest rather than trusting.
 */
export function voiceClipId(sceneId: string, nodeId: string): string {
  return `${sceneId}__${nodeId}`;
}

/** Indexes a manifest by clip id for O(1) lookup during scene load. */
export function indexManifest(manifest: VoiceManifest): Map<string, VoiceLineRecord> {
  return new Map(manifest.lines.map((line) => [line.id, line]));
}

/**
 * Manifest entries whose `text` no longer matches the authored line.
 *
 * The drift this catches is specific and nasty: a line is reworded, the manifest
 * is not regenerated, and the game ships a voice clip saying the old wording
 * under a subtitle showing the new one. The Python `--check` gate catches it by
 * hash; this is the same check available to a test, so it fails in `pnpm test`
 * without needing Python installed.
 */
export function driftedLines(
  manifest: VoiceManifest,
  authored: Iterable<{ scene: string; node: string; text: string }>,
): string[] {
  const index = indexManifest(manifest);
  const drifted: string[] = [];
  for (const line of authored) {
    const record = index.get(voiceClipId(line.scene, line.node));
    if (record && record.text !== line.text) drifted.push(record.id);
  }
  return drifted.sort();
}
