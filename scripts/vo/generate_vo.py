#!/usr/bin/env python3
"""Build-time voice-over generation for TIDELOCK (spec 20.4).

Turns `content/dialogue/*.json` into normalised speech files, timed subtitle
cues, and a manifest that records exactly what was generated from what. Runs at
asset-generation time and never at runtime: the shipped game loads files, it does
not call a speech service (spec 20.4, 20.5).

The six stages the spec asks for, in order:

  1. validate dialogue      every scene is parsed and every speaker checked
                            against the cast before a single request is made
  2. synthesize voice       through `SpeechBackend`, so the provider is swappable
  3. subtitle timing        WebVTT cues from the backend's word boundaries
  4. loudness/format pass   ffmpeg: trim, channel colouring, EBU R128 two-pass
  5. emit runtime file      mono MP3 under public/assets/audio/dialogue/
  6. update manifest        content/dialogue/vo-manifest.json

## Why the provider sits behind an adapter

Spec 20.5 is blunt about `edge-tts`: it is an unofficial client for Microsoft
Edge's online speech service, it grants no commercial voice-output licence, and
it must be replaceable by an offline model before release. So nothing outside
`EdgeTtsBackend` knows the provider exists. A replacement implements `synthesize`
and returns audio bytes plus word timings; everything downstream — trimming,
normalisation, cue generation, hashing, the manifest — is provider-agnostic.

## Why regeneration is content-addressed

Spec 73 says regenerate only when the text changes, the voice settings change, or
the tool version changes intentionally. Each line's `sourceHash` covers exactly
those inputs, so a re-run after editing one line of dialogue re-synthesises one
line. Spec section on CI is equally blunt that `build` must not secretly
regenerate hundreds of files, which is why this is a separate opt-in script and
why `--check` exists: it verifies freshness with no network access at all, so CI
can assert the manifest matches the content without synthesising anything.

Usage:

    pnpm generate:vo                      # synthesize whatever is stale
    pnpm generate:vo --force              # re-synthesize everything
    pnpm generate:vo --only prologue_bridge
    pnpm generate:vo --speaker dax
    pnpm vo:check                         # offline freshness gate, no network
    python scripts/vo/generate_vo.py --list-voices
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

ROOT = Path(__file__).resolve().parents[2]
CAST_FILE = ROOT / "content" / "voices" / "cast.json"
DIALOGUE_DIR = ROOT / "content" / "dialogue"
MANIFEST_FILE = DIALOGUE_DIR / "vo-manifest.json"
AUDIO_ROOT = ROOT / "public" / "assets" / "audio"
VO_SUBDIR = "dialogue"

MANIFEST_VERSION = 1

# edge-tts reports offsets in 100-nanosecond ticks.
TICKS_PER_SECOND = 10_000_000

# The closed speaker enum, mirroring MAIN_CAST_IDS + MINOR_CAST_IDS in
# src/game/dialogue/dialogueSchema.ts. Duplicated deliberately: this script must
# fail on an unknown speaker without importing TypeScript, and
# tests/unit/voiceCast.test.ts asserts the two lists have not drifted apart.
SPEAKER_IDS = (
    "mara",
    "sera",
    "ivo",
    "dax",
    "noor",
    "teo",
    "luz",
    "abe",
    "kit",
    "renna",
    "paulo",
    "wen",
)


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class PipelineError(RuntimeError):
    """A fatal, actionable configuration or content problem."""


# ---------------------------------------------------------------------------
# Word timing and the backend seam
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class WordTiming:
    """One spoken word and where it lands, in seconds from clip start."""

    text: str
    start: float
    end: float


@dataclass
class Synthesis:
    """Raw provider output: encoded audio plus whatever timing it offered."""

    audio: bytes
    words: List[WordTiming] = field(default_factory=list)

    @property
    def spoken_seconds(self) -> float:
        """End of the last word. 0.0 when the provider gave no timings."""
        return max((w.end for w in self.words), default=0.0)


class SpeechBackend:
    """The provider seam required by spec 20.5.

    Deliberately tiny. A replacement — an offline Kokoro-class model, or a
    licensed commercial service — needs to produce encoded audio and, ideally,
    word timings. Word timings are optional: without them the pipeline still
    produces audio and falls back to proportional cue timing, which is worse but
    not broken.
    """

    #: Recorded in the manifest so a backend upgrade invalidates every hash.
    id = "abstract"
    version = "0"

    async def synthesize(self, text: str, voice: "VoiceConfig") -> Synthesis:
        raise NotImplementedError

    async def list_voices(self) -> List[Tuple[str, str, str]]:
        raise NotImplementedError


class EdgeTtsBackend(SpeechBackend):
    """`edge-tts` adapter. The only place in the repo that knows the provider."""

    id = "edge-tts"

    def __init__(self) -> None:
        try:
            import edge_tts  # noqa: PLC0415  (optional build-time dependency)
        except ImportError as exc:  # pragma: no cover - environment problem
            raise PipelineError(
                "edge-tts is not installed. Run:\n"
                "  python -m pip install -r scripts/vo/requirements.txt"
            ) from exc
        self._edge_tts = edge_tts
        self.version = _package_version("edge-tts")

    async def synthesize(self, text: str, voice: "VoiceConfig") -> Synthesis:
        communicate = self._edge_tts.Communicate(
            text,
            voice.voice,
            rate=voice.rate,
            pitch=voice.pitch,
            volume=voice.volume,
            # 7.x defaults to SentenceBoundary. Word boundaries are what make
            # per-word subtitle cues possible, so they are requested explicitly.
            boundary="WordBoundary",
        )

        audio = bytearray()
        words: List[WordTiming] = []
        async for chunk in communicate.stream():
            kind = chunk.get("type")
            if kind == "audio":
                data = chunk.get("data")
                if data:
                    audio.extend(data)
            elif kind == "WordBoundary":
                offset = int(chunk.get("offset", 0))
                duration = int(chunk.get("duration", 0))
                words.append(
                    WordTiming(
                        text=str(chunk.get("text", "")),
                        start=offset / TICKS_PER_SECOND,
                        end=(offset + duration) / TICKS_PER_SECOND,
                    )
                )

        if not audio:
            raise PipelineError(
                f"the speech service returned no audio for voice {voice.voice!r}"
            )
        return Synthesis(audio=bytes(audio), words=words)

    async def list_voices(self) -> List[Tuple[str, str, str]]:
        found = await self._edge_tts.list_voices()
        return sorted(
            (v["ShortName"], v.get("Gender", "?"), v.get("Locale", "?")) for v in found
        )


def _package_version(name: str) -> str:
    try:
        from importlib.metadata import version

        return version(name)
    except Exception:  # pragma: no cover - defensive
        return "unknown"


# ---------------------------------------------------------------------------
# Cast configuration
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VoiceConfig:
    """Everything that determines how one line of one character sounds.

    Frozen and hashable because it *is* the cache key: `signature()` feeds the
    per-line `sourceHash`, so changing a rate or a channel re-synthesises exactly
    the lines it affects and nothing else.
    """

    speaker: str
    voice: str
    rate: str
    pitch: str
    volume: str
    channel: str
    loudness_offset_db: float
    pronunciations: Tuple[Tuple[str, str], ...]

    def signature(self) -> str:
        return json.dumps(
            {
                "speaker": self.speaker,
                "voice": self.voice,
                "rate": self.rate,
                "pitch": self.pitch,
                "volume": self.volume,
                "channel": self.channel,
                "loudnessOffsetDb": self.loudness_offset_db,
                "pronunciations": list(self.pronunciations),
            },
            sort_keys=True,
            separators=(",", ":"),
        )


@dataclass(frozen=True)
class OutputConfig:
    container: str
    codec: str
    bitrate: str
    sample_rate: int
    channels: int


@dataclass(frozen=True)
class LoudnessConfig:
    target_lufs: float
    true_peak_db: float
    loudness_range: float


@dataclass(frozen=True)
class SilenceConfig:
    trim_threshold_db: float
    lead_in_ms: int
    tail_ms: int
    interrupted_tail_ms: int


@dataclass(frozen=True)
class TextTransforms:
    strip_leading_dash: bool
    strip_trailing_dash: bool
    ellipsis_to_comma: bool
    em_dash_to_comma: bool


@dataclass
class CastConfig:
    version: int
    output: OutputConfig
    loudness: LoudnessConfig
    silence: SilenceConfig
    transforms: TextTransforms
    channels: Dict[str, Optional[str]]
    global_pronunciations: Dict[str, str]
    scene_channel_overrides: Dict[str, Dict[str, str]]
    voices: Dict[str, VoiceConfig]

    def signature(self) -> str:
        """Hash input for settings that affect every line equally."""
        return json.dumps(
            {
                "version": self.version,
                "output": self.output.__dict__,
                "loudness": self.loudness.__dict__,
                "silence": self.silence.__dict__,
                "transforms": self.transforms.__dict__,
                "channels": self.channels,
                "globalPronunciations": self.global_pronunciations,
            },
            sort_keys=True,
            separators=(",", ":"),
        )

    def voice_for(self, speaker: str, scene_id: str) -> VoiceConfig:
        """The character's voice, with any per-scene channel override applied."""
        base = self.voices[speaker]
        override = self.scene_channel_overrides.get(scene_id, {}).get(speaker)
        if override is None or override == base.channel:
            return base
        if override not in self.channels:
            raise PipelineError(
                f"scene {scene_id!r} overrides {speaker!r} to unknown channel {override!r}"
            )
        # dataclasses.replace would work, but this keeps the frozen type explicit.
        return VoiceConfig(
            speaker=base.speaker,
            voice=base.voice,
            rate=base.rate,
            pitch=base.pitch,
            volume=base.volume,
            channel=override,
            loudness_offset_db=base.loudness_offset_db,
            pronunciations=base.pronunciations,
        )


def _strip_notes(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Drops the `note*` documentation keys so they never reach a signature.

    The config is heavily commented in-band because it is voice *direction* that
    a human edits. Those comments must not invalidate a hash, or rewording a
    note would re-synthesise the campaign.
    """
    return {k: v for k, v in raw.items() if not k.lower().startswith("note")}


def load_cast(path: Path = CAST_FILE) -> CastConfig:
    if not path.exists():
        raise PipelineError(f"missing cast configuration at {_rel(path)}")

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise PipelineError(f"{_rel(path)} is not valid JSON: {exc}") from exc

    if raw.get("version") != 1:
        raise PipelineError(
            f"{_rel(path)} declares version {raw.get('version')!r}; only 1 is supported"
        )

    out = _strip_notes(raw.get("output", {}))
    loud = _strip_notes(raw.get("loudness", {}))
    sil = _strip_notes(raw.get("silence", {}))
    tf = _strip_notes(raw.get("textTransforms", {}))

    channels: Dict[str, Optional[str]] = {}
    for name, spec in _strip_notes(raw.get("channels", {})).items():
        if not isinstance(spec, dict):
            raise PipelineError(f"channel {name!r} must be an object")
        channels[name] = spec.get("filter")
    if "direct" not in channels:
        raise PipelineError("cast configuration must define a 'direct' channel")

    cast_raw = _strip_notes(raw.get("cast", {}))
    global_pron = _strip_notes(raw.get("pronunciations", {}))

    voices: Dict[str, VoiceConfig] = {}
    for speaker, entry in cast_raw.items():
        if speaker not in SPEAKER_IDS:
            raise PipelineError(
                f"cast entry {speaker!r} is not a known speaker id; "
                f"expected one of {', '.join(SPEAKER_IDS)}"
            )
        if not isinstance(entry, dict) or "voice" not in entry:
            raise PipelineError(f"cast entry {speaker!r} must declare a 'voice'")

        channel = entry.get("channel", "direct")
        if channel not in channels:
            raise PipelineError(
                f"cast entry {speaker!r} uses unknown channel {channel!r}; "
                f"defined channels are {', '.join(sorted(channels))}"
            )

        merged = dict(global_pron)
        merged.update(_strip_notes(entry.get("pronunciations", {})))

        voices[speaker] = VoiceConfig(
            speaker=speaker,
            voice=str(entry["voice"]),
            rate=str(entry.get("rate", "+0%")),
            pitch=str(entry.get("pitch", "+0Hz")),
            volume=str(entry.get("volume", "+0%")),
            channel=channel,
            loudness_offset_db=float(entry.get("loudnessOffsetDb", 0.0)),
            pronunciations=tuple(sorted(merged.items())),
        )

    missing = [s for s in SPEAKER_IDS if s not in voices]
    if missing:
        # A speaker with no voice is a line that would ship silent, so this is
        # fatal rather than a warning.
        raise PipelineError(
            "every speaker needs a cast entry; missing: " + ", ".join(missing)
        )

    duplicates = _duplicate_voices(voices)
    if duplicates:
        raise PipelineError(
            "two characters may not share a voice id: "
            + "; ".join(f"{vid} used by {', '.join(names)}" for vid, names in duplicates)
        )

    return CastConfig(
        version=1,
        output=OutputConfig(
            container=str(out.get("container", "mp3")),
            codec=str(out.get("codec", "libmp3lame")),
            bitrate=str(out.get("bitrate", "48k")),
            sample_rate=int(out.get("sampleRate", 24000)),
            channels=int(out.get("channels", 1)),
        ),
        loudness=LoudnessConfig(
            target_lufs=float(loud.get("targetLufs", -19)),
            true_peak_db=float(loud.get("truePeakDb", -1.5)),
            loudness_range=float(loud.get("loudnessRange", 7)),
        ),
        silence=SilenceConfig(
            trim_threshold_db=float(sil.get("trimThresholdDb", -50)),
            lead_in_ms=int(sil.get("leadInMs", 30)),
            tail_ms=int(sil.get("tailMs", 120)),
            interrupted_tail_ms=int(sil.get("interruptedTailMs", 0)),
        ),
        transforms=TextTransforms(
            strip_leading_dash=bool(tf.get("stripLeadingDash", True)),
            strip_trailing_dash=bool(tf.get("stripTrailingDash", True)),
            ellipsis_to_comma=bool(tf.get("ellipsisToComma", True)),
            em_dash_to_comma=bool(tf.get("emDashToComma", True)),
        ),
        channels=channels,
        global_pronunciations=dict(global_pron),
        scene_channel_overrides={
            scene: dict(entries)
            for scene, entries in _strip_notes(
                raw.get("sceneChannelOverrides", {})
            ).items()
            if isinstance(entries, dict)
        },
        voices=voices,
    )


def _duplicate_voices(voices: Dict[str, VoiceConfig]) -> List[Tuple[str, List[str]]]:
    by_voice: Dict[str, List[str]] = {}
    for speaker, cfg in voices.items():
        by_voice.setdefault(cfg.voice, []).append(speaker)
    return [(v, sorted(n)) for v, n in sorted(by_voice.items()) if len(n) > 1]


# ---------------------------------------------------------------------------
# Dialogue input
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Line:
    """One dialogue node that needs a spoken take."""

    scene_id: str
    node_id: str
    speaker: str
    text: str
    authored_duration: Optional[float]
    source_file: str

    @property
    def clip_id(self) -> str:
        """Stable, deterministic id (spec 73: keep voice file naming deterministic)."""
        return f"{self.scene_id}__{self.node_id}"

    @property
    def interrupted(self) -> bool:
        """Whether the line is written as being cut off mid-sentence."""
        return self.text.rstrip().endswith(("\u2014", "-"))


def load_lines(
    dialogue_dir: Path = DIALOGUE_DIR,
    only: Optional[Sequence[str]] = None,
    speakers: Optional[Sequence[str]] = None,
) -> List[Line]:
    """Stage 1: read and validate every authored scene.

    Validation here is intentionally cheap and duplicated from the Zod schema.
    The full authoring lint lives in TypeScript and runs in `pnpm test`; this
    only needs to catch what would make synthesis produce garbage — an unknown
    speaker, an empty line, a duplicate id.
    """
    files = sorted(p for p in dialogue_dir.glob("*.json") if p.name != MANIFEST_FILE.name)
    if not files:
        raise PipelineError(f"no dialogue scenes found in {_rel(dialogue_dir)}")

    lines: List[Line] = []
    seen: Dict[str, str] = {}

    for path in files:
        try:
            scene = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise PipelineError(f"{_rel(path)} is not valid JSON: {exc}") from exc

        scene_id = scene.get("sceneId")
        if not isinstance(scene_id, str) or not scene_id:
            raise PipelineError(f"{_rel(path)} has no sceneId")

        nodes = scene.get("nodes")
        if not isinstance(nodes, list) or not nodes:
            raise PipelineError(f"{_rel(path)} has no nodes")

        for node in nodes:
            if not isinstance(node, dict):
                raise PipelineError(f"{_rel(path)} contains a non-object node")
            node_id = node.get("id")
            speaker = node.get("speaker")
            text = node.get("text")

            if not isinstance(node_id, str) or not node_id:
                raise PipelineError(f"{_rel(path)} contains a node with no id")
            if speaker not in SPEAKER_IDS:
                raise PipelineError(
                    f"{_rel(path)} node {node_id!r} has unknown speaker {speaker!r}"
                )
            if not isinstance(text, str) or not text.strip():
                raise PipelineError(f"{_rel(path)} node {node_id!r} has no text")

            key = f"{scene_id}:{node_id}"
            if key in seen:
                raise PipelineError(
                    f"duplicate dialogue node id {key!r} in {_rel(path)} and {seen[key]}"
                )
            seen[key] = _rel(path)

            duration = node.get("duration")
            lines.append(
                Line(
                    scene_id=scene_id,
                    node_id=node_id,
                    speaker=speaker,
                    text=text,
                    authored_duration=(
                        float(duration) if isinstance(duration, (int, float)) else None
                    ),
                    source_file=_rel(path),
                )
            )

    if only:
        wanted = set(only)
        lines = [l for l in lines if l.scene_id in wanted]
        unknown = wanted - {l.scene_id for l in lines}
        if unknown:
            raise PipelineError(f"no such scene(s): {', '.join(sorted(unknown))}")
    if speakers:
        lines = [l for l in lines if l.speaker in set(speakers)]

    return lines


# ---------------------------------------------------------------------------
# Text preparation
# ---------------------------------------------------------------------------

_ELLIPSIS = re.compile(r"\u2026|\.\.\.")
_EM_DASH = re.compile(r"\s*\u2014\s*")


def spoken_text(line: Line, voice: VoiceConfig, tf: TextTransforms) -> str:
    """The string handed to the synthesiser.

    Diverges from `line.text` only in punctuation and pronunciation, never in
    words: the authored text is what the player reads as a subtitle, so the two
    must not drift. Every transform here exists because the synthesiser reads
    punctuation literally and cannot read stage direction.
    """
    text = line.text.strip()

    # A leading em dash marks a cut-in — the character starting mid-sentence over
    # somebody else. It is punctuation for the reader, and silence for the voice.
    if tf.strip_leading_dash:
        text = re.sub(r"^[\u2014-]+\s*", "", text)
    # A trailing one marks being cut off. Dropping it stops the synthesiser
    # trailing away into a pause that the interrupt is going to cut anyway.
    if tf.strip_trailing_dash:
        text = re.sub(r"\s*[\u2014-]+$", "", text)

    if tf.ellipsis_to_comma:
        text = _ELLIPSIS.sub(",", text)
    # Interior em dash: a breath. A comma is the only pause edge-tts honours,
    # since it accepts plain text rather than SSML.
    if tf.em_dash_to_comma:
        text = _EM_DASH.sub(", ", text)

    for source, replacement in voice.pronunciations:
        if source and source in text:
            text = text.replace(source, replacement)

    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        raise PipelineError(
            f"{line.clip_id}: text reduced to nothing by transforms "
            f"(original: {line.text!r})"
        )
    return text


def source_hash(
    line: Line, voice: VoiceConfig, cast: CastConfig, backend: SpeechBackend
) -> str:
    """Content address for one take (spec 73).

    Covers precisely the three things the spec says should trigger regeneration:
    the authored text, the voice settings, and the tool version. Nothing else —
    notably not the authored `duration`, which is a timing hint the pipeline
    measures for itself and must not be a reason to re-synthesise.
    """
    digest = hashlib.sha256()
    for part in (
        line.text,
        voice.signature(),
        cast.signature(),
        f"{backend.id}@{backend.version}",
        str(MANIFEST_VERSION),
    ):
        digest.update(part.encode("utf-8"))
        digest.update(b"\x00")
    return digest.hexdigest()


# ---------------------------------------------------------------------------
# WebVTT
# ---------------------------------------------------------------------------


def format_timestamp(seconds: float) -> str:
    seconds = max(0.0, seconds)
    hours, rem = divmod(seconds, 3600)
    minutes, secs = divmod(rem, 60)
    return f"{int(hours):02d}:{int(minutes):02d}:{secs:06.3f}"


#: Characters per rendered subtitle line, matching the locale line budget in
#: content/localization/en.json and the band in src/ui/Subtitles.ts.
VTT_MAX_LINE_CHARS = 56
#: Rendered lines per cue. Two keeps the band clear of the touch controls.
VTT_MAX_LINES = 2
#: Longest a single cue may stay on screen. A six-second line held as one cue
#: reads as a wall of text; broken in two it reads as speech.
VTT_MAX_CUE_SECONDS = 3.6


def wrap_cue(text: str, max_line_chars: int = VTT_MAX_LINE_CHARS) -> str:
    """Greedy word wrap, so a cue arrives pre-broken and the runtime never re-wraps."""
    lines: List[str] = []
    current = ""
    for word in text.split():
        candidate = word if not current else f"{current} {word}"
        if len(candidate) <= max_line_chars:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return "\n".join(lines) if lines else text


def build_vtt(
    line: Line,
    words: Sequence[WordTiming],
    total: float,
    max_line_chars: int = VTT_MAX_LINE_CHARS,
    max_lines: int = VTT_MAX_LINES,
    max_cue_seconds: float = VTT_MAX_CUE_SECONDS,
) -> str:
    """Stage 3: word-timed WebVTT cues.

    Two things here are less obvious than they look.

    **Cue text comes from the authored line, not from the provider's tokens.**
    The word-boundary events carry bare words with the punctuation stripped, so
    reconstructing a cue from them yields "a work order They'll come" — no full
    stop, and a subtitle that silently disagrees with the script. The provider's
    tokens are used for *timing only*; the words the player reads are the authored
    ones, aligned positionally. If the two tokenisations disagree in length —
    which a pronunciation substitution like "KTX2" -> "K T X two" can cause — the
    alignment is unsafe, so it degrades to one cue carrying the whole authored
    line rather than mislabelling timings.

    **Cues are capped in time as well as in length.** Grouping purely by the
    56x2 character budget left a 6.9-second line as a single cue, which is
    legible but does not read as speech.

    With no word timings at all, one cue spanning the clip is emitted: still
    subtitled, just not synced.
    """
    header = ["WEBVTT", "", f"NOTE {line.clip_id} ({line.speaker})", ""]

    def single_cue() -> str:
        return "\n".join(
            header
            + [
                "1",
                f"{format_timestamp(0)} --> {format_timestamp(total)}",
                wrap_cue(line.text, max_line_chars),
                "",
            ]
        )

    display = line.text.split()
    if not words or len(words) != len(display):
        return single_cue()

    budget = max_line_chars * max_lines
    cues: List[Tuple[float, float, str]] = []
    chunk: List[Tuple[str, WordTiming]] = []
    length = 0

    def flush() -> None:
        nonlocal chunk, length
        if not chunk:
            return
        cues.append(
            (chunk[0][1].start, chunk[-1][1].end, " ".join(token for token, _ in chunk))
        )
        chunk = []
        length = 0

    for token, timing in zip(display, words):
        extra = len(token) + (1 if chunk else 0)
        too_long = chunk and length + extra > budget
        too_slow = chunk and (timing.end - chunk[0][1].start) > max_cue_seconds
        if too_long or too_slow:
            flush()
            extra = len(token)
        chunk.append((token, timing))
        length += extra
    flush()

    # The last cue runs to the end of the clip so the band does not blink out
    # before a trailing consonant has finished.
    if cues:
        start, end, text = cues[-1]
        cues[-1] = (start, max(total, end), text)

    body: List[str] = []
    for index, (start, end, text) in enumerate(cues, start=1):
        body += [
            str(index),
            f"{format_timestamp(start)} --> {format_timestamp(end)}",
            wrap_cue(text, max_line_chars),
            "",
        ]
    return "\n".join(header + body)


# ---------------------------------------------------------------------------
# ffmpeg
# ---------------------------------------------------------------------------


def resolve_ffmpeg() -> Tuple[str, str]:
    """Locates ffmpeg/ffprobe, preferring the system pair over the pip package."""
    system = shutil.which("ffmpeg")
    probe = shutil.which("ffprobe")
    if system and probe:
        return system, probe
    try:
        import ffmpeg as ffmpeg_binaries

        ffmpeg_binaries.init()
        return ffmpeg_binaries.FFMPEG_PATH, ffmpeg_binaries.FFPROBE_PATH
    except Exception as exc:
        raise PipelineError(
            "ffmpeg and ffprobe are required for the loudness and format pass.\n"
            "Install a system ffmpeg, or run:\n"
            "  python -m pip install -r scripts/vo/requirements.txt"
        ) from exc


_LOUDNORM_JSON = re.compile(r"\{[^{}]*input_i[^{}]*\}", re.S)


@dataclass
class Ffmpeg:
    ffmpeg: str
    ffprobe: str

    def _run(self, args: Sequence[str]) -> subprocess.CompletedProcess:
        return subprocess.run(
            [self.ffmpeg, "-hide_banner", "-nostdin", *args],
            capture_output=True,
            text=True,
            check=False,
        )

    def duration(self, path: Path) -> float:
        result = subprocess.run(
            [
                self.ffprobe, "-v", "error",
                "-show_entries", "format=duration",
                "-of", "csv=p=0", str(path),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        try:
            return round(float(result.stdout.strip()), 3)
        except ValueError:
            return 0.0

    def measure_loudness(self, source: Path, chain: str, loud: LoudnessConfig) -> Dict[str, str]:
        """Pass one of two-pass loudnorm: measure, do not alter.

        Single-pass loudnorm normalises adaptively across the file, which on a
        two-second line means it spends most of the clip still converging. Two
        passes apply one constant gain, which is what keeps a one-word line and a
        thirteen-second run-on at the same perceived level.
        """
        analysis = (
            f"{chain}," if chain else ""
        ) + (
            f"loudnorm=I={loud.target_lufs}:TP={loud.true_peak_db}"
            f":LRA={loud.loudness_range}:print_format=json"
        )
        result = self._run(["-i", str(source), "-af", analysis, "-f", "null", "-"])
        match = _LOUDNORM_JSON.search(result.stderr)
        if not match:
            raise PipelineError(
                "ffmpeg loudness measurement produced no report:\n"
                + result.stderr[-1200:]
            )
        return json.loads(match.group(0))

    def render(
        self,
        source: Path,
        destination: Path,
        chain: str,
        measured: Dict[str, str],
        loud: LoudnessConfig,
        offset_db: float,
        out: OutputConfig,
    ) -> None:
        """Stages 4 and 5: apply the measured correction and encode."""
        target = loud.target_lufs + offset_db
        filters = [chain] if chain else []
        filters.append(
            f"loudnorm=I={target}:TP={loud.true_peak_db}:LRA={loud.loudness_range}"
            f":measured_I={measured['input_i']}:measured_TP={measured['input_tp']}"
            f":measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}"
            f":offset={measured['target_offset']}:linear=true"
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        result = self._run(
            [
                "-y", "-i", str(source),
                "-af", ",".join(filters),
                "-ac", str(out.channels),
                "-ar", str(out.sample_rate),
                "-c:a", out.codec,
                "-b:a", out.bitrate,
                "-map_metadata", "-1",
                str(destination),
            ]
        )
        if result.returncode != 0 or not destination.exists():
            raise PipelineError(
                f"ffmpeg failed to encode {destination.name}:\n{result.stderr[-1200:]}"
            )


def build_filter_chain(
    cast: CastConfig, voice: VoiceConfig, interrupted: bool
) -> str:
    """Trim, pad and colour, in the order the signal should meet them.

    Trimming comes first so the padding that follows is exact, and the channel
    filter comes before loudness measurement so band-limiting cannot drag the
    measured level around afterwards.
    """
    sil = cast.silence
    parts = [
        f"silenceremove=start_periods=1:start_threshold={sil.trim_threshold_db}dB"
        f":start_silence=0.02:detection=peak",
        "areverse",
        f"silenceremove=start_periods=1:start_threshold={sil.trim_threshold_db}dB"
        f":start_silence=0.02:detection=peak",
        "areverse",
    ]

    tail_ms = sil.interrupted_tail_ms if interrupted else sil.tail_ms
    if sil.lead_in_ms > 0:
        parts.append(f"adelay=delays={sil.lead_in_ms}:all=1")
    if tail_ms > 0:
        parts.append(f"apad=pad_dur={tail_ms / 1000:.3f}")

    channel_filter = cast.channels.get(voice.channel)
    if channel_filter:
        parts.append(channel_filter)

    return ",".join(parts)


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------


def load_manifest(path: Path = MANIFEST_FILE) -> Dict[str, Dict[str, Any]]:
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise PipelineError(f"{_rel(path)} is not valid JSON: {exc}") from exc
    return {entry["id"]: entry for entry in raw.get("lines", []) if "id" in entry}


def write_manifest(
    entries: Dict[str, Dict[str, Any]],
    cast: CastConfig,
    backend: SpeechBackend,
    path: Path = MANIFEST_FILE,
) -> None:
    """Stage 6.

    Committed even though the audio is not. It is our own data, it is the ledger
    that makes regeneration incremental, and it carries the measured durations —
    which are useful on their own, since the authored `duration` fields were
    estimated by hand.
    """
    ordered = sorted(entries.values(), key=lambda e: (e["scene"], e["id"]))
    total = sum(e.get("duration", 0.0) for e in ordered)
    by_speaker: Dict[str, int] = {}
    for entry in ordered:
        by_speaker[entry["speaker"]] = by_speaker.get(entry["speaker"], 0) + 1

    document = {
        "version": MANIFEST_VERSION,
        "note": (
            "Generated by scripts/vo/generate_vo.py. Do not edit by hand. "
            "The audio and cue files this references are NOT committed - see "
            "ASSET_LICENSES.md - so regenerate them with `pnpm generate:vo`."
        ),
        "backend": {"id": backend.id, "version": backend.version},
        "castSignature": hashlib.sha256(cast.signature().encode("utf-8")).hexdigest()[:16],
        "audioBase": f"assets/audio/{VO_SUBDIR}",
        "totals": {
            "lines": len(ordered),
            "spokenSeconds": round(total, 2),
            "bySpeaker": dict(sorted(by_speaker.items())),
        },
        "lines": ordered,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def _rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def relative_audio_path(line: Line, container: str) -> str:
    """Path recorded in the manifest, relative to `public/assets/audio`.

    Matches the convention `dialogueSchema.ts` documents for a node's `audio`
    field, so a scene can point straight at one of these later.
    """
    return f"{VO_SUBDIR}/{line.scene_id}/{line.node_id}.{container}"


def is_fresh(entry: Optional[Dict[str, Any]], expected_hash: str, container: str) -> bool:
    if not entry or entry.get("sourceHash") != expected_hash:
        return False
    audio = AUDIO_ROOT / entry.get("audio", "")
    subtitle = AUDIO_ROOT / entry.get("subtitle", "")
    return audio.exists() and subtitle.exists()


async def generate(args: argparse.Namespace) -> int:
    cast = load_cast()
    lines = load_lines(dialogue_dir=DIALOGUE_DIR, only=args.only, speakers=args.speaker)
    manifest = load_manifest()

    backend: SpeechBackend
    if args.check:
        # --check must not touch the network, so the backend is never constructed
        # for synthesis; only its identity is needed to recompute hashes.
        backend = _manifest_backend_stub(manifest)
    else:
        backend = EdgeTtsBackend()

    planned: List[Tuple[Line, VoiceConfig, str]] = []
    for line in lines:
        voice = cast.voice_for(line.speaker, line.scene_id)
        planned.append((line, voice, source_hash(line, voice, cast, backend)))

    stale = [
        (line, voice, digest)
        for line, voice, digest in planned
        if args.force or not is_fresh(manifest.get(line.clip_id), digest, cast.output.container)
    ]

    print(f"TIDELOCK voice pipeline · backend {backend.id}@{backend.version}")
    print(
        f"  {len(lines)} line(s) across {len({l.scene_id for l in lines})} scene(s); "
        f"{len(stale)} stale, {len(lines) - len(stale)} up to date"
    )

    if args.check:
        return _report_check(stale, manifest)

    if args.dry_run:
        for line, voice, _ in stale:
            print(f"  would synthesize {line.clip_id:<44} {voice.voice} [{voice.channel}]")
        return 0

    if not stale:
        print("  nothing to do")
        return 0

    ff = Ffmpeg(*resolve_ffmpeg())
    scratch = ROOT / ".tts-cache"
    scratch.mkdir(parents=True, exist_ok=True)

    failures: List[str] = []
    for index, (line, voice, digest) in enumerate(stale, start=1):
        label = f"[{index}/{len(stale)}] {line.clip_id}"
        try:
            entry = await synthesize_line(line, voice, digest, cast, backend, ff, scratch)
        except PipelineError as exc:
            print(f"  {label}  FAILED: {exc}")
            failures.append(line.clip_id)
            continue
        manifest[line.clip_id] = entry
        drift = ""
        if line.authored_duration:
            delta = entry["duration"] - line.authored_duration
            drift = f"  authored {line.authored_duration:.1f}s ({delta:+.1f}s)"
        print(
            f"  {label:<58} {entry['duration']:>6.2f}s  "
            f"{entry['bytes'] / 1024:>6.1f} KB  {voice.voice}{drift}"
        )

    write_manifest(manifest, cast, backend)
    print(f"\n  manifest written to {_rel(MANIFEST_FILE)}")
    print(f"  audio under {_rel(AUDIO_ROOT / VO_SUBDIR)} (not committed)")

    if failures:
        print(f"\n  {len(failures)} line(s) failed: {', '.join(failures)}")
        return 1
    return 0


async def synthesize_line(
    line: Line,
    voice: VoiceConfig,
    digest: str,
    cast: CastConfig,
    backend: SpeechBackend,
    ff: Ffmpeg,
    scratch: Path,
) -> Dict[str, Any]:
    """Stages 2-5 for a single line."""
    text = spoken_text(line, voice, cast.transforms)
    result = await backend.synthesize(text, voice)

    raw = scratch / f"{line.clip_id}.raw.mp3"
    raw.write_bytes(result.audio)

    chain = build_filter_chain(cast, voice, line.interrupted)
    measured = ff.measure_loudness(raw, chain, cast.loudness)

    relative = relative_audio_path(line, cast.output.container)
    destination = AUDIO_ROOT / relative
    ff.render(
        raw, destination, chain, measured, cast.loudness, voice.loudness_offset_db, cast.output
    )

    duration = ff.duration(destination)

    # Word offsets are measured on the untrimmed clip, so they must be shifted by
    # however much silence the trim removed before they will line up with the
    # file that actually ships.
    shift = cast.silence.lead_in_ms / 1000 - _leading_silence(result.words)
    words = [
        WordTiming(w.text, max(0.0, w.start + shift), max(0.0, w.end + shift))
        for w in result.words
    ]

    subtitle_relative = relative.rsplit(".", 1)[0] + ".vtt"
    (AUDIO_ROOT / subtitle_relative).write_text(
        build_vtt(line, words, duration), encoding="utf-8"
    )

    raw.unlink(missing_ok=True)

    return {
        "id": line.clip_id,
        "scene": line.scene_id,
        "node": line.node_id,
        "speaker": line.speaker,
        "text": line.text,
        "voice": voice.voice,
        "rate": voice.rate,
        "pitch": voice.pitch,
        "channel": voice.channel,
        "sourceHash": digest,
        "audio": relative,
        "subtitle": subtitle_relative,
        "duration": duration,
        "authoredDuration": line.authored_duration,
        "words": len(words),
        "bytes": destination.stat().st_size,
        "measuredLufs": _as_float(measured.get("input_i")),
    }


def _leading_silence(words: Sequence[WordTiming]) -> float:
    return words[0].start if words else 0.0


def _as_float(value: Any) -> Optional[float]:
    try:
        return round(float(value), 2)
    except (TypeError, ValueError):
        return None


def _manifest_backend_stub(manifest: Dict[str, Dict[str, Any]]) -> SpeechBackend:
    """A backend identity read back from the manifest, for offline `--check`.

    `--check` recomputes hashes, and the backend id and version are part of a
    hash. Constructing the real backend would import the provider and could reach
    the network, which is exactly what the offline gate must not do — so the
    recorded identity is used instead. A genuine backend upgrade therefore shows
    up as staleness on the next real run, which is the intent.
    """
    document_backend = {"id": EdgeTtsBackend.id, "version": "unknown"}
    if MANIFEST_FILE.exists():
        try:
            raw = json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))
            document_backend.update(raw.get("backend", {}))
        except json.JSONDecodeError:
            pass

    stub = SpeechBackend()
    stub.id = str(document_backend.get("id", EdgeTtsBackend.id))
    stub.version = str(document_backend.get("version", "unknown"))
    return stub


def _report_check(
    stale: Sequence[Tuple[Line, VoiceConfig, str]], manifest: Dict[str, Dict[str, Any]]
) -> int:
    if not stale:
        print("  manifest is current for every authored line")
        return 0

    missing_entry = [l for l, _, _ in stale if l.clip_id not in manifest]
    changed = [l for l, _, _ in stale if l.clip_id in manifest]

    if missing_entry:
        print(f"\n  {len(missing_entry)} line(s) have no manifest entry:")
        for line in missing_entry[:20]:
            print(f"    {line.clip_id}  ({line.source_file})")
        if len(missing_entry) > 20:
            print(f"    ... and {len(missing_entry) - 20} more")
    if changed:
        print(f"\n  {len(changed)} line(s) changed since generation:")
        for line in changed[:20]:
            print(f"    {line.clip_id}")
        if len(changed) > 20:
            print(f"    ... and {len(changed) - 20} more")

    print("\n  Run `pnpm generate:vo` to bring the manifest up to date.")
    return 1


async def show_voices() -> int:
    voices = await EdgeTtsBackend().list_voices()
    english = [v for v in voices if v[0].startswith("en-")]
    print(f"{len(english)} English voices available ({len(voices)} total):\n")
    for short_name, gender, locale in english:
        print(f"  {short_name:<44} {gender:<7} {locale}")
    return 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="generate_vo",
        description="Generate TIDELOCK dialogue voice-over from authored content.",
    )
    parser.add_argument(
        "--force", action="store_true", help="re-synthesize every line, ignoring hashes"
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the manifest matches authored content and exit; no network access",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="list what would be synthesized"
    )
    parser.add_argument(
        "--only", action="append", metavar="SCENE_ID", help="limit to a scene (repeatable)"
    )
    parser.add_argument(
        "--speaker", action="append", metavar="SPEAKER", help="limit to a speaker (repeatable)"
    )
    parser.add_argument(
        "--list-voices", action="store_true", help="list the backend's available voices"
    )
    args = parser.parse_args(argv)

    try:
        if args.list_voices:
            return asyncio.run(show_voices())
        return asyncio.run(generate(args))
    except PipelineError as exc:
        print(f"\nvoice pipeline failed: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:  # pragma: no cover
        print("\ninterrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
