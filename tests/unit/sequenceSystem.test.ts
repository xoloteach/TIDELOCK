/**
 * Cutscene runtime and content tests.
 *
 * Two things are under test and neither is mocked: the schema that parses
 * authored cutscenes, and the system that plays them. The committed
 * `content/sequences/prologue_cold_open.json` is imported rather than retyped,
 * because the point of the schema is that the file the game ships actually
 * loads — a hand-written copy in a test would keep passing after someone edits
 * the real one.
 *
 * Only the effect sinks are mocked. They are the seam: the system's whole job
 * is to turn a timestamped track into an ordered series of calls on a camera, a
 * set of actors, an audio bus, a subtitle line, the world and the control lock,
 * so the calls those ports receive *are* the behaviour.
 *
 * The invariants that matter most here are the ones a player notices when they
 * break: a skipped cutscene must not leave control locked, the letterbox down
 * or a fade half-applied, and a cutscene interrupted by a save must not replay
 * the half of itself the player already watched.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import coldOpenRaw from '../../content/sequences/prologue_cold_open.json';
import {
  createMemoryCampaignState,
  type MemoryCampaignState,
  type ObjectivePort,
} from '../../src/game/dialogue/DialogueSystem';
import {
  ACTOR_MOVE_SPEEDS,
  FADE_ENDPOINTS,
  SEQUENCE_EASINGS,
  SEQUENCE_RESUME_POLICIES,
  SEQUENCE_TRACK_KINDS,
  buildSchedule,
  effectKey,
  parseSequence,
  referencedMarks,
  referencedObjectives,
  sequenceActors,
  sequenceDuration,
  sequenceSchema,
  validateSequence,
  type Sequence,
  type SequenceEventKind,
  type SequenceIssueCode,
  type SequenceValidationResult,
} from '../../src/game/sequences/sequenceSchema';
import {
  SEQUENCE_SETTLE_SECONDS,
  SequenceSystem,
  type SequenceEvents,
  type SequenceSystemOptions,
} from '../../src/game/sequences/SequenceSystem';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The committed cutscene, parsed. Nothing here rewrites it. */
function coldOpen(): Sequence {
  return parseSequence(coldOpenRaw);
}

/**
 * A short, structurally complete cutscene: locks and releases control, raises
 * and lifts the letterbox, fades in, moves one actor, plays one sting and one
 * world event, and mirrors its completion effects into `onSkip`.
 */
function tinySequence(over: Record<string, unknown> = {}): Sequence {
  return parseSequence({
    id: 'test_sting',
    mode: 'cinematic',
    skippable: true,
    resumePolicy: 'safe-end',
    tracks: [
      {
        kind: 'presentation',
        events: [
          { at: 0, kind: 'controlLock', locked: true },
          { at: 0, kind: 'letterbox', visible: true, duration: 0.4 },
          { at: 0, kind: 'fade', from: 'black', to: 'scene', duration: 1 },
          { at: 8, kind: 'letterbox', visible: false, duration: 0.4 },
          { at: 9, kind: 'controlLock', locked: false },
        ],
      },
      {
        kind: 'camera',
        events: [
          {
            at: 0,
            kind: 'cameraCut',
            position: { x: 1, y: 2, z: 3 },
            lookAt: { x: 4, y: 5, z: 6 },
            fov: 40,
          },
          { at: 8, kind: 'cameraBlend', target: 'gameplay', duration: 1.5, easing: 'damped' },
        ],
      },
      {
        kind: 'actor',
        actor: 'mara',
        events: [
          { at: 1, kind: 'actorMoveTo', mark: 'pump12.breaker_panel', speed: 'walk' },
          { at: 5, kind: 'actorAnimation', clip: 'pull_breaker' },
        ],
      },
      {
        kind: 'audio',
        events: [{ at: 2, kind: 'sfxCue', cue: 'breaker_thunk' }],
      },
      {
        kind: 'world',
        events: [{ at: 6, kind: 'worldStateEvent', event: 'pump.cluster_b_online' }],
      },
    ],
    onComplete: [
      { kind: 'setFlag', flag: 'cluster_b_online', value: true },
      { kind: 'advanceObjective', objectiveId: 'act1.restart-cluster-b' },
    ],
    onSkip: [
      { kind: 'setFlag', flag: 'cluster_b_online', value: true },
      { kind: 'advanceObjective', objectiveId: 'act1.restart-cluster-b' },
    ],
    ...over,
  });
}

// ---------------------------------------------------------------------------
// Mocked effect sinks
// ---------------------------------------------------------------------------

function makePorts() {
  return {
    camera: {
      cut: vi.fn(),
      blendTo: vi.fn(),
      handOff: vi.fn(),
      lookAtActor: vi.fn(),
      release: vi.fn(),
    },
    actors: {
      moveTo: vi.fn(),
      placeAt: vi.fn(),
      playAnimation: vi.fn(),
      playGesture: vi.fn(),
      lookAt: vi.fn(),
      turnTo: vi.fn(),
      release: vi.fn(),
    },
    audio: {
      ambience: vi.fn(),
      sfx: vi.fn(),
      stopSequenceCues: vi.fn(),
    },
    subtitles: {
      show: vi.fn(),
      clear: vi.fn(),
    },
    world: {
      worldStateEvent: vi.fn(),
      lightCue: vi.fn(),
    },
    control: {
      setControlLocked: vi.fn(),
      setLetterbox: vi.fn(),
      fade: vi.fn(),
    },
    missions: { advanceObjective: vi.fn() } satisfies ObjectivePort,
  };
}

type Ports = ReturnType<typeof makePorts>;

interface Harness {
  system: SequenceSystem;
  ports: Ports;
  campaign: MemoryCampaignState;
  /** Every dispatched schedule entry, in the order the system dispatched it. */
  dispatched: SequenceEvents['sequence-event'][];
  ended: SequenceEvents['sequence-ended'][];
  suppressed: SequenceEvents['sequence-suppressed'][];
  checkpoints: SequenceEvents['checkpoint-requested'][];
}

function harness(
  sequences: readonly Sequence[],
  options: Partial<SequenceSystemOptions> = {},
): Harness {
  const ports = makePorts();
  const campaign = createMemoryCampaignState();
  const system = new SequenceSystem({ sequences, state: campaign, ...ports, ...options });

  const dispatched: SequenceEvents['sequence-event'][] = [];
  const ended: SequenceEvents['sequence-ended'][] = [];
  const suppressed: SequenceEvents['sequence-suppressed'][] = [];
  const checkpoints: SequenceEvents['checkpoint-requested'][] = [];
  system.on('sequence-event', (payload) => dispatched.push(payload));
  system.on('sequence-ended', (payload) => ended.push(payload));
  system.on('sequence-suppressed', (payload) => suppressed.push(payload));
  system.on('checkpoint-requested', (payload) => checkpoints.push(payload));

  return { system, ports, campaign, dispatched, ended, suppressed, checkpoints };
}

// ---------------------------------------------------------------------------
// Fixed-step driving
// ---------------------------------------------------------------------------

/** The project's simulation step. Nothing here ever uses a frame delta. */
const STEP = 1 / 60;

/**
 * Runs the fixed clock until at least `target` seconds have been simulated, or
 * the sequence ends.
 *
 * A step count computed from `target / STEP` would land a floating-point hair
 * short of an event authored on a round second, so this drives to a condition
 * rather than a count.
 */
function advanceTo(system: SequenceSystem, target: number, step = STEP): void {
  let guard = 0;
  while (system.isRunning && !system.isSuspended && system.elapsed < target) {
    system.fixedUpdate(step);
    guard += 1;
    if (guard > 100_000) throw new Error(`advanceTo(${target}) never reached its target`);
  }
}

/** Runs until the sequence ends, or fails rather than looping forever. */
function runToEnd(system: SequenceSystem, step = STEP): number {
  let steps = 0;
  while (system.isRunning && !system.isSuspended) {
    system.fixedUpdate(step);
    steps += 1;
    if (steps > 100_000) throw new Error('sequence never ended');
  }
  return steps;
}

function kindsOf(events: readonly SequenceEvents['sequence-event'][]): SequenceEventKind[] {
  return events.map((entry) => entry.event.kind);
}

function ordersOf(events: readonly SequenceEvents['sequence-event'][]): number[] {
  return events.map((entry) => entry.order);
}

function codes(result: SequenceValidationResult): SequenceIssueCode[] {
  return [...result.errors, ...result.warnings].map((issue) => issue.code);
}

/** Mutates parsed content past what the schema allows, to lint the shape. */
function bent<T>(value: unknown): T {
  return value as T;
}

// ---------------------------------------------------------------------------
// The authored cutscene
// ---------------------------------------------------------------------------

describe('the committed prologue cold open', () => {
  it('parses', () => {
    const sequence = coldOpen();

    expect(sequence.id).toBe('prologue_cold_open');
    expect(sequence.mode).toBe('cinematic');
    expect(sequence.skippable).toBe(true);
    expect(sequence.resumePolicy).toBe('safe-end');
    expect(sequence.tracks).toHaveLength(8);
    expect(buildSchedule(sequence)).toHaveLength(30);
  });

  it('defaults the fields the authored file does not state', () => {
    const sequence = coldOpen();
    // A watched cutscene should not ambush the player again, and a cutscene
    // fired by a trigger volume needs no unlock ceremony.
    expect(sequence.once).toBe(true);
    expect(sequence.requiresUnlock).toBe(false);
    expect(sequence.duration).toBeUndefined();
  });

  it('carries every authored event kind, in the authored quantities', () => {
    const schedule = buildSchedule(coldOpen());
    const counts = new Map<SequenceEventKind, number>();
    for (const entry of schedule) {
      counts.set(entry.event.kind, (counts.get(entry.event.kind) ?? 0) + 1);
    }

    expect(Object.fromEntries(counts)).toEqual({
      controlLock: 2,
      fade: 1,
      letterbox: 2,
      checkpointCue: 1,
      cameraCut: 2,
      cameraBlend: 3,
      cameraLookTarget: 2,
      actorMoveTo: 2,
      actorAnimation: 2,
      actorLookAt: 1,
      actorTurnTo: 1,
      actorGesture: 1,
      ambienceCue: 2,
      sfxCue: 4,
      subtitleCue: 1,
      worldStateEvent: 1,
      lightCue: 2,
    });
  });

  it('lints with no errors and no warnings', () => {
    const result = validateSequence(coldOpen());
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('runs 32 seconds, ending on the checkpoint cue', () => {
    const sequence = coldOpen();
    expect(sequenceDuration(sequence)).toBe(32);

    const schedule = buildSchedule(sequence);
    const last = schedule[schedule.length - 1];
    expect(last.event.kind).toBe('checkpointCue');
    expect(last.at).toBe(32);
  });

  it('reports the actors, marks and objectives it references', () => {
    const sequence = coldOpen();
    expect(sequenceActors(sequence)).toEqual(['mara', 'ivo']);
    expect(referencedObjectives(sequence)).toEqual(['prologue.reach-clinic-bay']);
    expect(referencedMarks(sequence)).toEqual([
      'depot.overlook_rail',
      'district.flood_barrier',
      'depot.clinic_bay',
      'depot.platform_entry',
    ]);
  });

  it('accepts the whole authored borough of ids the pipeline would supply', () => {
    const result = validateSequence(coldOpen(), {
      knownActors: ['mara', 'ivo'],
      knownObjectives: ['prologue.reach-clinic-bay'],
      knownMarks: referencedMarks(coldOpen()),
      knownCheckpoints: ['prologue_depot_wake'],
    });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Schema shape
// ---------------------------------------------------------------------------

describe('sequence schema', () => {
  it('exposes the documented enumerations', () => {
    expect(SEQUENCE_TRACK_KINDS).toEqual([
      'presentation',
      'camera',
      'actor',
      'audio',
      'dialogue',
      'world',
    ]);
    expect(SEQUENCE_RESUME_POLICIES).toEqual(['restart', 'resume-exact', 'safe-end']);
    expect(FADE_ENDPOINTS).toEqual(['black', 'white', 'scene']);
    expect(ACTOR_MOVE_SPEEDS).toEqual(['stand', 'walk', 'run']);
    expect(SEQUENCE_EASINGS).toEqual(['linear', 'smooth', 'damped']);
  });

  it('rejects unknown keys so a typo is a failure, not a dropped field', () => {
    const raw = structuredClone(coldOpenRaw) as Record<string, unknown>;
    raw.skipable = true;
    expect(sequenceSchema.safeParse(raw).success).toBe(false);
  });

  it('rejects an unknown event kind, an unknown track kind and a negative time', () => {
    expect(
      sequenceSchema.safeParse({
        ...coldOpenRaw,
        tracks: [{ kind: 'weather', events: [] }],
      }).success,
    ).toBe(false);

    expect(
      sequenceSchema.safeParse({
        ...coldOpenRaw,
        tracks: [{ kind: 'world', events: [{ at: 1, kind: 'explode', force: 9 }] }],
      }).success,
    ).toBe(false);

    expect(
      sequenceSchema.safeParse({
        ...coldOpenRaw,
        tracks: [
          { kind: 'world', events: [{ at: -1, kind: 'worldStateEvent', event: 'x' }] },
        ],
      }).success,
    ).toBe(false);
  });

  it('requires an actor on an actor track and a cast member as the actor', () => {
    expect(
      sequenceSchema.safeParse({
        ...coldOpenRaw,
        tracks: [
          { kind: 'actor', events: [{ at: 0, kind: 'actorAnimation', clip: 'wave' }] },
        ],
      }).success,
    ).toBe(false);

    expect(
      sequenceSchema.safeParse({
        ...coldOpenRaw,
        tracks: [
          {
            kind: 'actor',
            actor: 'narrator',
            events: [{ at: 0, kind: 'actorAnimation', clip: 'wave' }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('requires at least one track', () => {
    expect(sequenceSchema.safeParse({ ...coldOpenRaw, tracks: [] }).success).toBe(false);
  });

  it('throws with a readable path when content is malformed', () => {
    expect(() => parseSequence({ id: 'x' })).toThrow(/invalid sequence/);
    expect(() => parseSequence({ ...coldOpenRaw, resumePolicy: 'whenever' })).toThrow(
      /resumePolicy/,
    );
  });

  it('keys effects structurally, so a repeated effect is recognisable', () => {
    expect(effectKey({ kind: 'setFlag', flag: 'a', value: true })).toBe(
      effectKey({ kind: 'setFlag', flag: 'a', value: true }),
    );
    expect(effectKey({ kind: 'setFlag', flag: 'a', value: true })).not.toBe(
      effectKey({ kind: 'setFlag', flag: 'a', value: false }),
    );
    expect(effectKey({ kind: 'advanceObjective', objectiveId: 'o1' })).not.toBe(
      effectKey({ kind: 'grantEvidence', evidenceId: 'o1' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------

describe('validateSequence', () => {
  function expectError(sequence: Sequence, code: SequenceIssueCode): void {
    const result = validateSequence(sequence);
    expect(result.ok).toBe(false);
    expect(result.errors.map((issue) => issue.code)).toContain(code);
  }

  it('flags a camera look target with no choreography track for that actor', () => {
    const sequence = coldOpen();
    // Dax is never in the depot; the linter has to notice before the camera
    // spends seven seconds framing nobody.
    const cameraTrack = sequence.tracks[2];
    if (cameraTrack.kind !== 'camera') throw new Error('fixture changed');
    cameraTrack.events[0] = { at: 14, kind: 'cameraLookTarget', actor: 'dax' };
    expectError(sequence, 'camera-look-target-not-in-sequence');
  });

  it('flags an objective, mark, actor or checkpoint the pipeline does not know', () => {
    const sequence = coldOpen();

    expect(
      codes(validateSequence(sequence, { knownObjectives: ['prologue.something-else'] })),
    ).toContain('unknown-objective');
    expect(codes(validateSequence(sequence, { knownMarks: ['depot.overlook_rail'] }))).toContain(
      'unknown-mark',
    );
    expect(codes(validateSequence(sequence, { knownActors: ['mara'] }))).toContain(
      'unknown-actor',
    );
    expect(codes(validateSequence(sequence, { knownCheckpoints: [] }))).toContain(
      'unknown-checkpoint',
    );
  });

  it('treats an omitted id table as "cannot check", not as "everything is fine"', () => {
    // No context at all: the authored file must still pass, and the dangling
    // checks must not silently pass content they never looked at.
    expect(validateSequence(coldOpen()).ok).toBe(true);
    expect(
      validateSequence(coldOpen(), { knownObjectives: [] }).errors.map((i) => i.code),
    ).toContain('unknown-objective');
  });

  it('flags a cutscene that never gives control back', () => {
    const sequence = tinySequence();
    const presentation = sequence.tracks[0];
    if (presentation.kind !== 'presentation') throw new Error('fixture changed');
    presentation.events = presentation.events.filter(
      (event) => !(event.kind === 'controlLock' && event.locked === false),
    );
    expectError(sequence, 'control-lock-never-released');
  });

  it('flags a letterbox that never lifts and a fade that ends on black', () => {
    const noLift = tinySequence();
    const a = noLift.tracks[0];
    if (a.kind !== 'presentation') throw new Error('fixture changed');
    a.events = a.events.filter((event) => !(event.kind === 'letterbox' && !event.visible));
    expectError(noLift, 'letterbox-never-lifted');

    const dark = tinySequence();
    const b = dark.tracks[0];
    if (b.kind !== 'presentation') throw new Error('fixture changed');
    b.events = b.events.map((event) =>
      event.kind === 'fade' ? { ...event, from: 'scene', to: 'black' } : event,
    );
    expectError(dark, 'fade-not-resolved');
  });

  it('flags a camera blend with no destination, or with two', () => {
    const nowhere = tinySequence();
    const a = nowhere.tracks[1];
    if (a.kind !== 'camera') throw new Error('fixture changed');
    a.events[1] = { at: 8, kind: 'cameraBlend', duration: 1.5 };
    expectError(nowhere, 'camera-blend-without-destination');

    const both = tinySequence();
    const b = both.tracks[1];
    if (b.kind !== 'camera') throw new Error('fixture changed');
    b.events[1] = {
      at: 8,
      kind: 'cameraBlend',
      target: 'gameplay',
      position: { x: 0, y: 1, z: 0 },
      lookAt: { x: 0, y: 1, z: 1 },
      duration: 1.5,
    };
    expectError(both, 'camera-blend-ambiguous-destination');

    const halfShot = tinySequence();
    const c = halfShot.tracks[1];
    if (c.kind !== 'camera') throw new Error('fixture changed');
    c.events[1] = {
      at: 8,
      kind: 'cameraBlend',
      position: { x: 0, y: 1, z: 0 },
      duration: 1.5,
    };
    expectError(halfShot, 'camera-blend-without-destination');
  });

  it('flags a skippable cutscene whose skip drops progress', () => {
    const sequence = tinySequence({ onSkip: [] });
    expectError(sequence, 'skip-drops-completion-effect');

    // An unskippable one has nothing to drop.
    expect(
      validateSequence(tinySequence({ skippable: false, onSkip: [] })).errors.map(
        (i) => i.code,
      ),
    ).not.toContain('skip-drops-completion-effect');
  });

  it('flags an empty track, a duplicated actor timeline and a sequence with no events', () => {
    const empty = tinySequence();
    const track = empty.tracks[3];
    if (track.kind !== 'audio') throw new Error('fixture changed');
    track.events = [];
    expectError(empty, 'empty-track');

    const twice = tinySequence();
    twice.tracks.push({
      kind: 'actor',
      actor: 'mara',
      events: [{ at: 3, kind: 'actorGesture', clip: 'shake_out_hand' }],
    });
    expectError(twice, 'duplicate-actor-track');

    const silent = tinySequence();
    for (const t of silent.tracks) t.events = [];
    expect(codes(validateSequence(silent))).toContain('no-events');
  });

  it('flags an event kind on the wrong track', () => {
    const sequence = tinySequence();
    const audio = sequence.tracks[3];
    if (audio.kind !== 'audio') throw new Error('fixture changed');
    // Only reachable by hand: the schema rejects this shape at load time.
    audio.events = bent([{ at: 2, kind: 'worldStateEvent', event: 'pump.online' }]);
    expectError(sequence, 'event-on-wrong-track');
  });

  it('flags an event past an authored duration', () => {
    expectError(tinySequence({ duration: 5 }), 'event-after-duration');
  });

  it('flags placeholder and trailer-speak subtitles', () => {
    const placeholder = tinySequence();
    placeholder.tracks.push({
      kind: 'dialogue',
      events: [
        { at: 3, kind: 'subtitleCue', text: 'TODO write this', duration: 2, speakerLabel: null },
      ],
    });
    expectError(placeholder, 'placeholder-text');

    const trailer = tinySequence();
    trailer.tracks.push({
      kind: 'dialogue',
      events: [
        {
          at: 3,
          kind: 'subtitleCue',
          text: 'This changes everything.',
          duration: 2,
          speakerLabel: 'Radio',
        },
      ],
    });
    const result = validateSequence(trailer);
    // A warning: it blocks nothing, but it must be visible.
    expect(result.ok).toBe(true);
    expect(result.warnings.map((i) => i.code)).toContain('banned-phrase');
  });

  it('warns about out-of-order authoring without rejecting it', () => {
    const sequence = tinySequence();
    const audio = sequence.tracks[3];
    if (audio.kind !== 'audio') throw new Error('fixture changed');
    audio.events = [
      { at: 4, kind: 'sfxCue', cue: 'breaker_thunk' },
      { at: 2, kind: 'sfxCue', cue: 'water_slap' },
    ];
    const result = validateSequence(sequence);
    expect(result.ok).toBe(true);
    expect(result.warnings.map((i) => i.code)).toContain('unordered-track-events');
  });

  it('warns about a checkpoint cued while control is still locked', () => {
    const sequence = tinySequence();
    const presentation = sequence.tracks[0];
    if (presentation.kind !== 'presentation') throw new Error('fixture changed');
    presentation.events.splice(3, 0, {
      at: 4,
      kind: 'checkpointCue',
      checkpointId: 'mid_cutscene',
    });
    const result = validateSequence(sequence);
    expect(result.ok).toBe(true);
    expect(result.warnings.map((i) => i.code)).toContain('checkpoint-during-control-lock');
  });

  it('warns about an unskippable cinematic', () => {
    const result = validateSequence(tinySequence({ skippable: false, onSkip: [] }));
    expect(result.warnings.map((i) => i.code)).toContain('unskippable-cinematic');
  });
});

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

describe('buildSchedule', () => {
  it('orders by time, then by authored track order, then by authored event order', () => {
    const sequence = parseSequence({
      id: 'tie_break',
      mode: 'ambient',
      skippable: false,
      resumePolicy: 'resume-exact',
      tracks: [
        {
          kind: 'world',
          events: [
            { at: 5, kind: 'worldStateEvent', event: 'first' },
            { at: 5, kind: 'worldStateEvent', event: 'second' },
          ],
        },
        { kind: 'audio', events: [{ at: 5, kind: 'sfxCue', cue: 'third' }] },
      ],
    });

    const schedule = buildSchedule(sequence);
    expect(schedule.map((entry) => entry.order)).toEqual([0, 1, 2]);
    expect(
      schedule.map((entry) =>
        entry.event.kind === 'worldStateEvent' ? entry.event.event : 'sfx',
      ),
    ).toEqual(['first', 'second', 'sfx']);
  });

  it('sorts events authored out of time order', () => {
    const sequence = parseSequence({
      id: 'unsorted',
      mode: 'ambient',
      skippable: false,
      resumePolicy: 'resume-exact',
      tracks: [
        {
          kind: 'world',
          events: [
            { at: 9, kind: 'worldStateEvent', event: 'late' },
            { at: 1, kind: 'worldStateEvent', event: 'early' },
          ],
        },
      ],
    });
    expect(buildSchedule(sequence).map((entry) => entry.at)).toEqual([1, 9]);
  });

  it('tags actor-track events with their actor', () => {
    const schedule = buildSchedule(coldOpen());
    const actorEvents = schedule.filter((entry) => entry.trackKind === 'actor');
    expect(actorEvents).toHaveLength(7);
    expect(actorEvents.every((entry) => entry.actor !== undefined)).toBe(true);
    expect(schedule.filter((entry) => entry.trackKind === 'audio')[0].actor).toBeUndefined();
  });

  it('derives the length from the last event that is still on screen', () => {
    // The subtitle runs 2s from t=9, past the last event's timestamp of 10.
    const sequence = parseSequence({
      id: 'trailing_subtitle',
      mode: 'ambient',
      skippable: false,
      resumePolicy: 'resume-exact',
      tracks: [
        {
          kind: 'dialogue',
          events: [
            { at: 9, kind: 'subtitleCue', text: '[radio]', duration: 2, speakerLabel: null },
          ],
        },
        { kind: 'world', events: [{ at: 10, kind: 'worldStateEvent', event: 'x' }] },
      ],
    });
    expect(sequenceDuration(sequence)).toBe(11);
  });
});

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

describe('SequenceSystem.start', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness([coldOpen()]);
  });

  it('applies the t=0 beats before the first simulation step', () => {
    expect(h.system.start('prologue_cold_open')).toBe(true);

    // Six events share t=0 across the presentation, camera, actor and audio
    // tracks. None of them may wait a step: the player would see one unfaded,
    // unlocked, un-letterboxed frame of the depot.
    expect(kindsOf(h.dispatched)).toEqual([
      'controlLock',
      'fade',
      'letterbox',
      'cameraCut',
      'actorMoveTo',
      'ambienceCue',
      'sfxCue',
    ]);
    expect(h.ports.control.setControlLocked).toHaveBeenCalledWith(true);
    expect(h.ports.control.fade).toHaveBeenCalledWith('black', 'scene', 1.8);
    expect(h.ports.control.setLetterbox).toHaveBeenCalledWith(true, 0.6);
    expect(h.ports.camera.cut).toHaveBeenCalledWith({
      position: { x: 24.4, y: 5.2, z: 13.6 },
      lookAt: { x: 26, y: -1.4, z: 16 },
      fov: 44,
    });
    expect(h.ports.actors.moveTo).toHaveBeenCalledWith('mara', 'depot.overlook_rail', 'stand');
    expect(h.ports.audio.ambience).toHaveBeenCalledWith('rain_on_steel_canopy', 1.2);
    expect(h.ports.audio.sfx).toHaveBeenCalledWith('runoff_into_standing_water', 0);
  });

  it('reports itself as running, blocking gameplay and holding control', () => {
    h.system.start('prologue_cold_open');
    expect(h.system.isRunning).toBe(true);
    expect(h.system.activeSequenceId).toBe('prologue_cold_open');
    expect(h.system.blocksGameplay).toBe(true);
    expect(h.system.isControlLocked).toBe(true);
    expect(h.system.isLetterboxVisible).toBe(true);
    expect(h.system.fadeState).toBe('scene');
  });

  it('leaves the player in control for an ambient sequence', () => {
    const ambient = harness([
      parseSequence({
        id: 'depot_radio',
        mode: 'ambient',
        skippable: false,
        resumePolicy: 'resume-exact',
        tracks: [{ kind: 'audio', events: [{ at: 0, kind: 'sfxCue', cue: 'radio_squelch' }] }],
      }),
    ]);
    ambient.system.start('depot_radio');
    expect(ambient.system.blocksGameplay).toBe(false);
  });

  it('throws on an unknown id rather than silently doing nothing', () => {
    expect(() => h.system.start('act9_the_secret')).toThrow(/Unknown sequence/);
  });

  it('refuses to start a second sequence over a running one', () => {
    const two = harness([coldOpen(), tinySequence()]);
    two.system.start('prologue_cold_open');
    expect(two.system.start('test_sting')).toBe(false);
    expect(two.suppressed).toEqual([{ sequenceId: 'test_sting', reason: 'busy' }]);
    expect(two.system.activeSequenceId).toBe('prologue_cold_open');
  });

  it('refuses to replay a once-only sequence', () => {
    h.system.start('prologue_cold_open');
    runToEnd(h.system);
    expect(h.system.hasSeen('prologue_cold_open')).toBe(true);
    expect(h.system.canStart('prologue_cold_open')).toBe(false);
    expect(h.system.start('prologue_cold_open')).toBe(false);
    expect(h.suppressed).toEqual([
      { sequenceId: 'prologue_cold_open', reason: 'already-seen' },
    ]);
  });

  it('replays a sequence authored as repeatable', () => {
    const repeatable = harness([tinySequence({ once: false })]);
    repeatable.system.start('test_sting');
    runToEnd(repeatable.system);
    expect(repeatable.system.start('test_sting')).toBe(true);
  });

  it('refuses a locked sequence until unlockCinematic arms it', () => {
    const locked = harness([tinySequence({ requiresUnlock: true })]);
    expect(locked.system.isUnlocked('test_sting')).toBe(false);
    expect(locked.system.start('test_sting')).toBe(false);
    expect(locked.suppressed).toEqual([{ sequenceId: 'test_sting', reason: 'locked' }]);

    // This is the port the dialogue system already writes through.
    locked.system.unlockCinematic('test_sting');
    expect(locked.system.isUnlocked('test_sting')).toBe(true);
    expect(locked.system.start('test_sting')).toBe(true);
  });

  it('rejects duplicate ids and invalid content at registration', () => {
    expect(() => new SequenceSystem({
      sequences: [tinySequence(), tinySequence()],
      state: createMemoryCampaignState(),
    })).toThrow(/Duplicate sequence id/);

    expect(() => new SequenceSystem({
      sequences: [tinySequence({ onSkip: [] })],
      state: createMemoryCampaignState(),
    })).toThrow(/is invalid/);

    // Explicitly opting out is how a test drives deliberately broken content.
    expect(() => new SequenceSystem({
      sequences: [tinySequence({ onSkip: [] })],
      state: createMemoryCampaignState(),
      validate: false,
    })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Fixed-step dispatch
// ---------------------------------------------------------------------------

describe('SequenceSystem fixed-timestep dispatch', () => {
  it('dispatches every event exactly once, in schedule order', () => {
    const h = harness([coldOpen()]);
    h.system.start('prologue_cold_open');
    runToEnd(h.system);

    const expected = buildSchedule(coldOpen()).map((entry) => entry.order);
    expect(ordersOf(h.dispatched)).toEqual(expected);
    expect(new Set(ordersOf(h.dispatched)).size).toBe(30);
  });

  it('fires nothing before its time, and everything on it', () => {
    const h = harness([coldOpen()]);
    h.system.start('prologue_cold_open');

    // The generator sting is authored at 4.0s.
    advanceTo(h.system, 3.5);
    expect(h.ports.audio.sfx).toHaveBeenCalledTimes(1);
    expect(h.ports.camera.blendTo).toHaveBeenCalledTimes(1); // the 3.5s blend

    advanceTo(h.system, 4);
    expect(h.ports.audio.sfx).toHaveBeenCalledTimes(2);
    expect(h.ports.audio.sfx).toHaveBeenLastCalledWith('depot_generator_loop', 2);
  });

  it('resolves two events on different tracks at the same timestamp by track order', () => {
    const worldFirst = parseSequence({
      id: 'same_instant',
      mode: 'ambient',
      skippable: false,
      resumePolicy: 'resume-exact',
      tracks: [
        { kind: 'world', events: [{ at: 2, kind: 'worldStateEvent', event: 'gate.closed' }] },
        { kind: 'audio', events: [{ at: 2, kind: 'sfxCue', cue: 'gate_clunk' }] },
      ],
    });
    const audioFirst = parseSequence({
      id: 'same_instant_swapped',
      mode: 'ambient',
      skippable: false,
      resumePolicy: 'resume-exact',
      tracks: [
        { kind: 'audio', events: [{ at: 2, kind: 'sfxCue', cue: 'gate_clunk' }] },
        { kind: 'world', events: [{ at: 2, kind: 'worldStateEvent', event: 'gate.closed' }] },
      ],
    });

    const a = harness([worldFirst]);
    a.system.start('same_instant');
    runToEnd(a.system);
    expect(kindsOf(a.dispatched)).toEqual(['worldStateEvent', 'sfxCue']);

    // Same timestamps, tracks authored the other way round: the order follows
    // the content, not the clock, and it is not left to chance.
    const b = harness([audioFirst]);
    b.system.start('same_instant_swapped');
    runToEnd(b.system);
    expect(kindsOf(b.dispatched)).toEqual(['sfxCue', 'worldStateEvent']);
  });

  it('produces the same traversal at 30 Hz as at 60 Hz', () => {
    const fast = harness([coldOpen()]);
    fast.system.start('prologue_cold_open');
    runToEnd(fast.system, 1 / 60);

    const slow = harness([coldOpen()]);
    slow.system.start('prologue_cold_open');
    runToEnd(slow.system, 1 / 30);

    expect(ordersOf(slow.dispatched)).toEqual(ordersOf(fast.dispatched));
  });

  it('does not advance when it is not stepped', () => {
    const h = harness([coldOpen()]);
    h.system.start('prologue_cold_open');
    const atStart = h.dispatched.length;
    // No fixedUpdate, no time. There is no wall clock in this system.
    expect(h.dispatched.length).toBe(atStart);
    expect(h.system.elapsed).toBe(0);
  });

  it('completes at the authored length, releasing everything it took', () => {
    const h = harness([coldOpen()]);
    h.system.start('prologue_cold_open');
    runToEnd(h.system);

    expect(h.system.isRunning).toBe(false);
    expect(h.system.blocksGameplay).toBe(false);
    expect(h.system.isControlLocked).toBe(false);
    expect(h.system.isLetterboxVisible).toBe(false);
    expect(h.system.fadeState).toBe('scene');
    expect(h.ports.control.setControlLocked).toHaveBeenLastCalledWith(false);
    expect(h.ports.camera.release).toHaveBeenCalled();
    expect(h.ports.actors.release).toHaveBeenCalled();
    expect(h.ended).toEqual([{ sequenceId: 'prologue_cold_open', reason: 'completed' }]);
  });

  it('applies the completion effects once, and only at the end', () => {
    const h = harness([coldOpen()]);
    h.system.start('prologue_cold_open');

    advanceTo(h.system, 31);
    expect(h.campaign.flags.prologue_cold_open_seen).toBeUndefined();
    expect(h.ports.missions.advanceObjective).not.toHaveBeenCalled();

    runToEnd(h.system);
    expect(h.campaign.flags.prologue_cold_open_seen).toBe(true);
    // onComplete and onSkip both advance it; a repeated effect lands once.
    expect(h.ports.missions.advanceObjective).toHaveBeenCalledTimes(1);
    expect(h.ports.missions.advanceObjective).toHaveBeenCalledWith(
      'prologue.reach-clinic-bay',
    );
  });

  it('requests the authored checkpoint', () => {
    const h = harness([coldOpen()]);
    h.system.start('prologue_cold_open');
    runToEnd(h.system);
    expect(h.checkpoints).toEqual([
      { sequenceId: 'prologue_cold_open', checkpointId: 'prologue_depot_wake' },
    ]);
  });

  it('does nothing when stepped with no sequence running', () => {
    const h = harness([coldOpen()]);
    expect(() => h.system.fixedUpdate(STEP)).not.toThrow();
    expect(h.dispatched).toEqual([]);
  });

  it('warns rather than throwing when a port is not wired', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const campaign = createMemoryCampaignState();
    const bare = new SequenceSystem({ sequences: [coldOpen()], state: campaign });

    bare.start('prologue_cold_open');
    let steps = 0;
    while (bare.isRunning && steps < 100_000) {
      bare.fixedUpdate(STEP);
      steps += 1;
    }

    // The cutscene still runs to its end and still writes its progress; the
    // missing wiring is loud instead of silent.
    expect(bare.isRunning).toBe(false);
    expect(campaign.flags.prologue_cold_open_seen).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// skip
// ---------------------------------------------------------------------------

describe('SequenceSystem.skip', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness([coldOpen()]);
    h.system.start('prologue_cold_open');
    advanceTo(h.system, 1);
  });

  it('ends the sequence and records it as both seen and skipped', () => {
    expect(h.system.skip()).toBe(true);
    expect(h.system.isRunning).toBe(false);
    expect(h.ended).toEqual([{ sequenceId: 'prologue_cold_open', reason: 'skipped' }]);
    expect(h.system.hasSeen('prologue_cold_open')).toBe(true);
    expect(h.system.hasSkipped('prologue_cold_open')).toBe(true);
    expect(h.system.serialise()).toEqual({
      seenIds: ['prologue_cold_open'],
      skippedIds: ['prologue_cold_open'],
    });
  });

  it('fully releases control, the letterbox and the fade', () => {
    h.system.skip();

    expect(h.system.isControlLocked).toBe(false);
    expect(h.system.isLetterboxVisible).toBe(false);
    expect(h.system.fadeState).toBe('scene');
    expect(h.ports.control.setControlLocked).toHaveBeenLastCalledWith(false);
    expect(h.ports.control.setLetterbox).toHaveBeenLastCalledWith(
      false,
      SEQUENCE_SETTLE_SECONDS,
    );
    expect(h.system.blocksGameplay).toBe(false);
  });

  it('leaves no fade half-applied when the content faded out and never back', () => {
    const dark = harness(
      [
        parseSequence({
          id: 'fade_out_only',
          mode: 'cinematic',
          skippable: true,
          resumePolicy: 'safe-end',
          tracks: [
            {
              kind: 'presentation',
              events: [
                { at: 0, kind: 'controlLock', locked: true },
                { at: 1, kind: 'fade', from: 'scene', to: 'black', duration: 0.5 },
              ],
            },
            { kind: 'world', events: [{ at: 8, kind: 'worldStateEvent', event: 'gate.stuck' }] },
          ],
        }),
      ],
      // Content the linter would reject: exactly the case the runtime must not
      // make unplayable.
      { validate: false },
    );

    dark.system.start('fade_out_only');
    advanceTo(dark.system, 2);
    expect(dark.system.fadeState).toBe('black');

    dark.system.skip();
    expect(dark.system.fadeState).toBe('scene');
    expect(dark.ports.control.fade).toHaveBeenLastCalledWith(
      'black',
      'scene',
      SEQUENCE_SETTLE_SECONDS,
    );
    expect(dark.system.isControlLocked).toBe(false);
  });

  it('applies the terminal effects of both lists, once each', () => {
    h.system.skip();
    expect(h.campaign.flags.prologue_cold_open_seen).toBe(true);
    expect(h.ports.missions.advanceObjective).toHaveBeenCalledTimes(1);
    expect(h.ports.missions.advanceObjective).toHaveBeenCalledWith(
      'prologue.reach-clinic-bay',
    );
  });

  it('still applies the world state the player skipped past', () => {
    h.system.skip();
    expect(h.ports.world.worldStateEvent).toHaveBeenCalledTimes(1);
    expect(h.ports.world.worldStateEvent).toHaveBeenCalledWith(
      'pump.cluster_b_discharge_drop',
    );
    // Both light cues land, so the clinic bay work light is on afterwards.
    expect(h.ports.world.lightCue.mock.calls).toEqual([
      ['district_window_flicker', 6],
      ['clinic_bay_worklight_on', null],
    ]);
  });

  it('settles the ambience bed instead of dropping it', () => {
    h.system.skip();
    // The bed is standing state: the depot should sound the way it would to
    // someone who watched the whole thing.
    expect(h.ports.audio.ambience).toHaveBeenLastCalledWith('depot_interior_voices_low', 1.5);
    expect(h.ports.audio.stopSequenceCues).not.toHaveBeenCalled();
  });

  it('drops the performance the player declined to watch', () => {
    h.system.skip();
    // One sting had already played at t=0; the three later ones do not fire.
    expect(h.ports.audio.sfx).toHaveBeenCalledTimes(1);
    expect(h.ports.actors.playAnimation).not.toHaveBeenCalled();
    expect(h.ports.actors.playGesture).not.toHaveBeenCalled();
    expect(h.ports.subtitles.show).not.toHaveBeenCalled();
    expect(h.ports.subtitles.clear).toHaveBeenCalled();
    expect(h.ports.camera.release).toHaveBeenCalled();
  });

  it('places the actors where the cutscene would have left them', () => {
    h.system.skip();
    // Not walked over six seconds nobody is watching.
    expect(h.ports.actors.placeAt).toHaveBeenCalledTimes(1);
    expect(h.ports.actors.placeAt).toHaveBeenCalledWith('mara', 'depot.platform_entry');
    expect(h.ports.actors.turnTo).toHaveBeenCalledWith('mara', 'depot.clinic_bay');
    expect(h.ports.actors.lookAt).toHaveBeenCalledWith('mara', 'district.flood_barrier');
    expect(h.ports.actors.release).toHaveBeenCalled();
    // The t=0 walk-on is the only travel that was actually played.
    expect(h.ports.actors.moveTo).toHaveBeenCalledTimes(1);
  });

  it('requests the checkpoint it skipped past, after the cutscene has ended', () => {
    const order: string[] = [];
    h.system.on('checkpoint-requested', () => order.push('checkpoint'));
    h.system.on('sequence-ended', () => order.push('ended'));

    h.system.skip();

    expect(h.checkpoints).toEqual([
      { sequenceId: 'prologue_cold_open', checkpointId: 'prologue_depot_wake' },
    ]);
    // A checkpoint written while the cutscene was still nominally running would
    // reload straight back into it.
    expect(order).toEqual(['checkpoint', 'ended']);
    expect(h.system.isRunning).toBe(false);
  });

  it('does not re-dispatch the events it settled', () => {
    const before = h.dispatched.length;
    h.system.skip();
    // Settling is not dispatching: nothing is announced as having played.
    expect(h.dispatched.length).toBe(before);
  });

  it('refuses to skip an unskippable sequence', () => {
    const stubborn = harness([tinySequence({ skippable: false, onSkip: [] })]);
    stubborn.system.start('test_sting');
    advanceTo(stubborn.system, 1);

    expect(stubborn.system.skip()).toBe(false);
    expect(stubborn.system.isRunning).toBe(true);
    expect(stubborn.campaign.flags.cluster_b_online).toBeUndefined();
  });

  it('returns false with nothing running', () => {
    h.system.skip();
    expect(h.system.skip()).toBe(false);
  });

  it('leaves the campaign in the same state a watched playthrough would', () => {
    const watched = harness([coldOpen()]);
    watched.system.start('prologue_cold_open');
    runToEnd(watched.system);

    h.system.skip();

    expect(h.campaign.flags).toEqual(watched.campaign.flags);
    expect(h.ports.missions.advanceObjective.mock.calls).toEqual(
      watched.ports.missions.advanceObjective.mock.calls,
    );
    expect(h.system.isControlLocked).toBe(watched.system.isControlLocked);
    expect(h.system.isLetterboxVisible).toBe(watched.system.isLetterboxVisible);
    expect(h.system.fadeState).toBe(watched.system.fadeState);
  });
});

// ---------------------------------------------------------------------------
// suspend / resume
// ---------------------------------------------------------------------------

describe('SequenceSystem suspend and resume', () => {
  it('stops the clock without giving anything back', () => {
    const h = harness([coldOpen()]);
    h.system.start('prologue_cold_open');
    advanceTo(h.system, 5);

    const dispatched = h.dispatched.length;
    expect(h.system.suspend()).toBe(true);
    expect(h.system.isSuspended).toBe(true);

    for (let i = 0; i < 600; i += 1) h.system.fixedUpdate(STEP);
    expect(h.dispatched.length).toBe(dispatched);
    // Still mid-cutscene: the pause menu is drawn over it, not instead of it.
    expect(h.system.isRunning).toBe(true);
    expect(h.system.isControlLocked).toBe(true);
    expect(h.system.isLetterboxVisible).toBe(true);
  });

  it('re-asserts standing presentation on resume without replaying one-shots', () => {
    const h = harness([coldOpen()]);
    h.system.start('prologue_cold_open');
    advanceTo(h.system, 12);
    h.system.suspend();

    h.ports.control.setControlLocked.mockClear();
    h.ports.control.setLetterbox.mockClear();
    h.ports.control.fade.mockClear();
    h.ports.camera.cut.mockClear();
    const sfxBefore = h.ports.audio.sfx.mock.calls.length;
    const dispatchedBefore = h.dispatched.length;

    expect(h.system.resume()).toBe(true);
    expect(h.system.isSuspended).toBe(false);

    expect(h.ports.control.setControlLocked).toHaveBeenCalledWith(true);
    expect(h.ports.control.setLetterbox).toHaveBeenCalledWith(true, 0);
    expect(h.ports.control.fade).toHaveBeenCalledWith('scene', 'scene', 0);
    // The camera is put back on the shot the 3.5s blend was travelling to.
    expect(h.ports.camera.cut).toHaveBeenCalledWith({
      position: { x: 21, y: 8.6, z: 12 },
      lookAt: { x: 38, y: 1, z: 46 },
      fov: 52,
    });
    // Nothing heard once is heard again.
    expect(h.ports.audio.sfx.mock.calls.length).toBe(sfxBefore);
    expect(h.dispatched.length).toBe(dispatchedBefore);
  });

  it('carries on to the end without dispatching anything twice', () => {
    const h = harness([coldOpen()]);
    h.system.start('prologue_cold_open');
    advanceTo(h.system, 12);
    h.system.suspend();
    h.system.resume();
    runToEnd(h.system);

    expect(ordersOf(h.dispatched)).toEqual(buildSchedule(coldOpen()).map((e) => e.order));
    expect(h.ports.missions.advanceObjective).toHaveBeenCalledTimes(1);
  });

  it('replays from the top under a restart policy', () => {
    const h = harness([tinySequence({ resumePolicy: 'restart' })]);
    h.system.start('test_sting');
    advanceTo(h.system, 3);
    const midway = h.dispatched.length;
    expect(midway).toBeGreaterThan(0);

    h.system.suspend();
    expect(h.system.resume()).toBe(true);
    expect(h.system.elapsed).toBe(0);
    // The t=0 beats fire again, because this cutscene is starting over.
    expect(h.dispatched.length).toBeGreaterThan(midway);
    expect(kindsOf(h.dispatched.slice(midway))).toEqual([
      'controlLock',
      'letterbox',
      'fade',
      'cameraCut',
    ]);
  });

  it('refuses to resume something that is not suspended', () => {
    const h = harness([coldOpen()]);
    expect(h.system.resume()).toBe(false);
    h.system.start('prologue_cold_open');
    expect(h.system.resume()).toBe(false);
  });

  it('refuses to suspend twice', () => {
    const h = harness([coldOpen()]);
    h.system.start('prologue_cold_open');
    expect(h.system.suspend()).toBe(true);
    expect(h.system.suspend()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Snapshot and restore
// ---------------------------------------------------------------------------

describe('SequenceSystem snapshot and restore', () => {
  it('serialises the save slice in first-seen order', () => {
    const h = harness([coldOpen(), tinySequence()]);
    h.system.start('test_sting');
    runToEnd(h.system);
    h.system.start('prologue_cold_open');
    advanceTo(h.system, 1);
    h.system.skip();

    expect(h.system.serialise()).toEqual({
      seenIds: ['test_sting', 'prologue_cold_open'],
      skippedIds: ['prologue_cold_open'],
    });
  });

  it('adopts a stored slice and keeps ids for content that is gone', () => {
    const h = harness([coldOpen()]);
    h.system.restore({ seenIds: ['act2_relay_annex', 'prologue_cold_open'], skippedIds: ['act2_relay_annex'] });

    expect(h.system.hasSeen('act2_relay_annex')).toBe(true);
    expect(h.system.hasSkipped('act2_relay_annex')).toBe(true);
    expect(h.system.canStart('prologue_cold_open')).toBe(false);
    expect(h.system.serialise()).toEqual({
      seenIds: ['act2_relay_annex', 'prologue_cold_open'],
      skippedIds: ['act2_relay_annex'],
    });
  });

  it('discards a running sequence without writing its effects into the arriving save', () => {
    const h = harness([coldOpen()]);
    h.system.start('prologue_cold_open');
    advanceTo(h.system, 10);

    h.system.restore({ seenIds: [], skippedIds: [] });

    expect(h.system.isRunning).toBe(false);
    expect(h.system.isControlLocked).toBe(false);
    expect(h.system.isLetterboxVisible).toBe(false);
    // The discarded run belonged to the session being replaced.
    expect(h.campaign.flags.prologue_cold_open_seen).toBeUndefined();
    expect(h.ports.missions.advanceObjective).not.toHaveBeenCalled();
    expect(h.ports.audio.stopSequenceCues).toHaveBeenCalled();
  });

  it('captures a cutscene caught mid-flight', () => {
    const h = harness([coldOpen()]);
    h.system.start('prologue_cold_open');
    advanceTo(h.system, 12);
    h.system.suspend();

    const snapshot = h.system.snapshot();
    expect(snapshot.active).not.toBeNull();
    expect(snapshot.active?.sequenceId).toBe('prologue_cold_open');
    expect(snapshot.active?.dispatched).toBe(h.dispatched.length);
    expect(snapshot.active?.elapsed).toBeGreaterThanOrEqual(12);
    expect(snapshot.cinematics).toEqual({ seenIds: [], skippedIds: [] });
  });

  it('restores mid-cutscene suspended, then resumes without double-firing', () => {
    const first = harness([coldOpen()]);
    first.system.start('prologue_cold_open');
    advanceTo(first.system, 12);
    first.system.suspend();
    const snapshot = first.system.snapshot();
    const alreadyPlayed = ordersOf(first.dispatched);

    const second = harness([coldOpen()]);
    second.system.restoreSnapshot(snapshot);

    // Suspended, not playing: the sector is still loading, and re-asserting a
    // camera into a half-built world is how a cutscene ends up looking at
    // nothing.
    expect(second.system.isRunning).toBe(true);
    expect(second.system.isSuspended).toBe(true);
    expect(second.dispatched).toEqual([]);
    expect(second.ports.control.setControlLocked).not.toHaveBeenCalled();
    // Derived from the dispatched prefix, not persisted.
    expect(second.system.isControlLocked).toBe(true);
    expect(second.system.isLetterboxVisible).toBe(true);
    expect(second.system.fadeState).toBe('scene');

    second.system.resume();
    runToEnd(second.system);

    const remaining = ordersOf(second.dispatched);
    expect(remaining.every((order) => !alreadyPlayed.includes(order))).toBe(true);
    expect([...alreadyPlayed, ...remaining]).toEqual(
      buildSchedule(coldOpen()).map((entry) => entry.order),
    );
    expect(second.ports.missions.advanceObjective).toHaveBeenCalledTimes(1);
    expect(second.campaign.flags.prologue_cold_open_seen).toBe(true);
  });

  it('round-trips the unlocked set', () => {
    const first = harness([tinySequence({ requiresUnlock: true })]);
    first.system.unlockCinematic('test_sting');
    first.system.unlockCinematic('act3_thirty_seven_minutes');

    const second = harness([tinySequence({ requiresUnlock: true })]);
    second.system.restoreSnapshot(first.system.snapshot());

    expect(second.system.isUnlocked('test_sting')).toBe(true);
    // An unlock for content that has not streamed in yet still survives.
    expect(second.system.isUnlocked('act3_thirty_seven_minutes')).toBe(true);
    expect(second.system.start('test_sting')).toBe(true);
  });

  it('reports and drops a snapshot of content that is no longer registered', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness([tinySequence()]);

    h.system.restoreSnapshot({
      cinematics: { seenIds: [], skippedIds: [] },
      unlockedIds: [],
      active: { sequenceId: 'act4_cut_from_the_game', elapsed: 3, dispatched: 2 },
    });

    expect(h.system.isRunning).toBe(false);
    // Presentation is left clean: a missing cutscene must not lock the player
    // out of their own game.
    expect(h.system.isControlLocked).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('clamps a snapshot whose cursor is past the end of changed content', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness([coldOpen()]);

    h.system.restoreSnapshot({
      cinematics: { seenIds: [], skippedIds: [] },
      unlockedIds: [],
      active: { sequenceId: 'prologue_cold_open', elapsed: 40, dispatched: 99 },
    });

    expect(h.system.dispatched).toBe(30);
    expect(warn).toHaveBeenCalled();

    // Everything already played, so resuming finishes it rather than hanging.
    h.system.resume();
    h.system.fixedUpdate(STEP);
    expect(h.system.isRunning).toBe(false);
    expect(h.campaign.flags.prologue_cold_open_seen).toBe(true);
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------

describe('SequenceSystem.cleanup', () => {
  it('gives back control, the letterbox, the camera, the actors and its audio', () => {
    const h = harness([coldOpen()]);
    h.system.start('prologue_cold_open');
    advanceTo(h.system, 15);

    expect(h.system.cleanup()).toBe(true);

    expect(h.system.isRunning).toBe(false);
    expect(h.system.activeSequenceId).toBeNull();
    expect(h.system.blocksGameplay).toBe(false);
    expect(h.system.isControlLocked).toBe(false);
    expect(h.system.isLetterboxVisible).toBe(false);
    expect(h.system.fadeState).toBe('scene');
    expect(h.ports.control.setControlLocked).toHaveBeenLastCalledWith(false);
    expect(h.ports.control.setLetterbox).toHaveBeenLastCalledWith(
      false,
      SEQUENCE_SETTLE_SECONDS,
    );
    expect(h.ports.camera.release).toHaveBeenCalled();
    expect(h.ports.actors.release).toHaveBeenCalled();
    expect(h.ports.audio.stopSequenceCues).toHaveBeenCalled();
    expect(h.ports.subtitles.clear).toHaveBeenCalled();
    expect(h.ended).toEqual([{ sequenceId: 'prologue_cold_open', reason: 'aborted' }]);
  });

  it('applies the terminal effects of a safe-end sequence on the way out', () => {
    const h = harness([coldOpen()]);
    h.system.start('prologue_cold_open');
    advanceTo(h.system, 15);
    h.system.cleanup();

    // The whole point of safe-end: quitting mid-cutscene must not leave the
    // story half-written.
    expect(h.campaign.flags.prologue_cold_open_seen).toBe(true);
    expect(h.ports.missions.advanceObjective).toHaveBeenCalledTimes(1);
    expect(h.system.hasSeen('prologue_cold_open')).toBe(true);
    expect(h.system.hasSkipped('prologue_cold_open')).toBe(false);
  });

  it('writes nothing and stays replayable under a resume-exact policy', () => {
    const h = harness([tinySequence({ resumePolicy: 'resume-exact' })]);
    h.system.start('test_sting');
    advanceTo(h.system, 3);
    h.system.cleanup();

    expect(h.campaign.flags.cluster_b_online).toBeUndefined();
    expect(h.ports.missions.advanceObjective).not.toHaveBeenCalled();
    expect(h.system.hasSeen('test_sting')).toBe(false);
    // Still available, because as far as the campaign is concerned it never ran.
    expect(h.system.canStart('test_sting')).toBe(true);
    expect(h.system.isControlLocked).toBe(false);
  });

  it('is idempotent and safe with nothing running', () => {
    const h = harness([coldOpen()]);
    expect(h.system.cleanup()).toBe(false);
    h.system.start('prologue_cold_open');
    expect(h.system.cleanup()).toBe(true);
    expect(h.system.cleanup()).toBe(false);
    expect(h.ended).toHaveLength(1);
  });

  it('lets another sequence start immediately afterwards', () => {
    const h = harness([coldOpen(), tinySequence()]);
    h.system.start('prologue_cold_open');
    advanceTo(h.system, 4);
    h.system.cleanup();
    expect(h.system.start('test_sting')).toBe(true);
  });

  it('drops its listeners on dispose', () => {
    const h = harness([coldOpen()]);
    h.system.start('prologue_cold_open');
    h.system.dispose();

    expect(h.system.isRunning).toBe(false);
    const endedAfterDispose = h.ended.length;
    // The emitter is cleared, so a second sequence cannot notify a torn-down UI.
    h.system.register(tinySequence());
    h.system.start('test_sting');
    runToEnd(h.system);
    expect(h.ended.length).toBe(endedAfterDispose);
  });

  it('advertises itself as an ECS system with a fixed-step update', () => {
    const h = harness([coldOpen()]);
    expect(h.system.name).toBe('sequences');
    expect(typeof h.system.fixedUpdate).toBe('function');
    // No render hook: a cutscene must never advance on a frame delta.
    expect((h.system as { render?: unknown }).render).toBeUndefined();
  });
});
