/**
 * Dialogue runtime tests.
 *
 * What can go wrong here is not a crash. It is Ivo's briefing replaying every
 * time the player walks past him, a choice appearing that the player has no
 * business seeing yet, a flag lost because a pump interrupted the line that set
 * it, or a save that reloads into a conversation the player already had. None of
 * that is visible to a typecheck, so each one is a test.
 *
 * The system is deliberately headless: nothing below touches the DOM, and the
 * presentation assertions are made against emitted events, which is the only
 * contract the HUD has.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  DIALOGUE_MIN_LINE_SECONDS,
  DialogueSystem,
  createMemoryCampaignState,
  estimateLineDuration,
  lineDuration,
  applyNarrativeEffect,
  type DialogueEvents,
  type MemoryCampaignState,
} from '../../src/game/dialogue/DialogueSystem';
import {
  parseDialogueScene,
  validateDialogueScene,
  type DialogueScene,
} from '../../src/game/dialogue/dialogueSchema';
import { createNewSave, saveSchema } from '../../src/persistence/saveSchema';

const DT = 1 / 60;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HANDOVER = 'prologue_depot_handover';
const RADIO = 'prologue_radio_dispatch';

/**
 * Ivo's handover at the depot.
 *
 * Put through `parseDialogueScene` so the fixture is proven to be something the
 * content loader accepts. It is a hub conversation — `n_ask` returns to the
 * choice node — which is both a common authoring pattern and the shape that
 * makes "effects applied exactly once" a real question rather than a formality.
 */
function handoverScene(): DialogueScene {
  return parseDialogueScene({
    sceneId: HANDOVER,
    title: 'Depot handover',
    act: 'prologue',
    tier: 'focused',
    participants: ['mara', 'ivo'],
    entry: 'n_count',
    once: true,
    skippable: true,
    onEnd: [{ kind: 'adjustTrust', character: 'ivo', delta: 1 }],
    nodes: [
      {
        id: 'n_count',
        speaker: 'ivo',
        text: 'Six oxygen units, four batteries. That is the clinic until somebody reopens a gate.',
        duration: 4,
        next: 'n_which',
      },
      {
        id: 'n_which',
        speaker: 'mara',
        text: 'Which gate.',
        duration: 1.5,
        next: 'n_dax_aside',
      },
      {
        // Skipped entirely unless Dax has already turned up.
        id: 'n_dax_aside',
        speaker: 'ivo',
        text: 'Your reporter friend asked the same thing. I told him nothing.',
        duration: 3,
        condition: { kind: 'flagSet', flag: 'dax_made_contact' },
        next: 'n_twelve',
      },
      {
        id: 'n_twelve',
        speaker: 'ivo',
        text: 'Twelve. It is on your old rounds.',
        duration: 2.5,
        next: 'n_hub',
        interrupts: [{ event: 'pump.desync', target: 'n_cluster_b', earliest: 1 }],
      },
      {
        id: 'n_hub',
        speaker: 'mara',
        text: 'Then I need the service bridge key.',
        duration: 2,
        effects: [{ kind: 'adjustTrust', character: 'ivo', delta: 1 }],
        choices: [
          {
            id: 'c_now',
            text: 'I will go now.',
            target: 'n_go',
            effects: [{ kind: 'setFlag', flag: 'depot_gate_open', value: true }],
          },
          {
            id: 'c_after_power',
            text: 'After your power is stable.',
            condition: { kind: 'flagSet', flag: 'clinic_power_stabilized' },
            target: 'n_wait',
          },
          {
            id: 'c_who',
            text: 'Who is on the other side?',
            target: 'n_ask',
          },
        ],
      },
      {
        id: 'n_ask',
        speaker: 'ivo',
        text: 'Contractors. A warden who will not leave. Nobody with a key.',
        duration: 3,
        next: 'n_hub',
      },
      {
        id: 'n_wait',
        speaker: 'ivo',
        text: 'It will not be stable tonight.',
        duration: 2,
        next: 'n_go',
      },
      {
        id: 'n_go',
        speaker: 'mara',
        text: 'Twelve first. Then the annex.',
        duration: 2,
        effects: [{ kind: 'setFlag', flag: 'ivo_briefed_mara', value: true }],
        next: null,
      },
      {
        id: 'n_cluster_b',
        speaker: 'ivo',
        text: 'That is Cluster B again.',
        duration: 2,
        effects: [{ kind: 'setFlag', flag: 'heard_cluster_b', value: true }],
        next: null,
      },
    ],
  });
}

/** Radio chatter. Recurring, unskippable, and must never take control away. */
function radioScene(): DialogueScene {
  return parseDialogueScene({
    sceneId: RADIO,
    act: 'prologue',
    tier: 'ambient',
    participants: ['wen', 'mara'],
    entry: 'r1',
    once: false,
    skippable: false,
    nodes: [
      {
        id: 'r1',
        speaker: 'wen',
        text: 'Depot, dispatch. Still no answer from Twelve.',
        duration: 3,
        next: 'r2',
      },
      { id: 'r2', speaker: 'mara', text: 'Copy.', duration: 1, next: null },
    ],
  });
}

interface Harness {
  system: DialogueSystem;
  campaign: MemoryCampaignState;
  events: RecordedEvent[];
  tick(seconds: number): void;
}

type RecordedEvent =
  | { type: 'scene-started'; payload: DialogueEvents['scene-started'] }
  | { type: 'scene-ended'; payload: DialogueEvents['scene-ended'] }
  | { type: 'line-started'; payload: DialogueEvents['line-started'] }
  | { type: 'line-ended'; payload: DialogueEvents['line-ended'] }
  | { type: 'choices-offered'; payload: DialogueEvents['choices-offered'] }
  | { type: 'choice-taken'; payload: DialogueEvents['choice-taken'] }
  | { type: 'scene-suppressed'; payload: DialogueEvents['scene-suppressed'] };

function harness(
  options: {
    scenes?: readonly DialogueScene[];
    autoAdvance?: boolean;
    campaign?: MemoryCampaignState;
  } = {},
): Harness {
  const campaign = options.campaign ?? createMemoryCampaignState();
  const system = new DialogueSystem({
    scenes: options.scenes ?? [handoverScene(), radioScene()],
    state: campaign,
    autoAdvance: options.autoAdvance ?? false,
  });

  const events: RecordedEvent[] = [];
  system.on('scene-started', (payload) => events.push({ type: 'scene-started', payload }));
  system.on('scene-ended', (payload) => events.push({ type: 'scene-ended', payload }));
  system.on('line-started', (payload) => events.push({ type: 'line-started', payload }));
  system.on('line-ended', (payload) => events.push({ type: 'line-ended', payload }));
  system.on('choices-offered', (payload) =>
    events.push({ type: 'choices-offered', payload }),
  );
  system.on('choice-taken', (payload) => events.push({ type: 'choice-taken', payload }));
  system.on('scene-suppressed', (payload) =>
    events.push({ type: 'scene-suppressed', payload }),
  );

  return {
    system,
    campaign,
    events,
    tick(seconds) {
      const steps = Math.max(1, Math.ceil(seconds / DT));
      for (let i = 0; i < steps; i += 1) system.fixedUpdate(DT);
    },
  };
}

function nodeIds(events: RecordedEvent[]): string[] {
  return events
    .filter((event) => event.type === 'line-started')
    .map((event) => event.payload.nodeId);
}

// ---------------------------------------------------------------------------
// Fixture integrity
// ---------------------------------------------------------------------------

describe('dialogue fixtures', () => {
  it('are valid authored scenes', () => {
    for (const scene of [handoverScene(), radioScene()]) {
      const result = validateDialogueScene(scene);
      expect(result.errors).toEqual([]);
    }
  });

  it('rejects a duplicate scene id at registration', () => {
    const { system } = harness();
    expect(() => system.register(handoverScene())).toThrow(/Duplicate dialogue scene/);
  });
});

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

describe('DialogueSystem traversal', () => {
  it('walks next pointers and ends on a node with nowhere to go', () => {
    const { system, events } = harness({ scenes: [radioScene()] });

    expect(system.start(RADIO)).toBe(true);
    expect(system.activeNodeId).toBe('r1');

    system.advance();
    expect(system.activeNodeId).toBe('r2');

    system.advance();
    expect(system.isRunning).toBe(false);
    expect(nodeIds(events)).toEqual(['r1', 'r2']);
    expect(events.at(-1)).toMatchObject({
      type: 'scene-ended',
      payload: { sceneId: RADIO, reason: 'completed' },
    });
  });

  it('emits everything the subtitle layer needs and nothing more', () => {
    const scene = parseDialogueScene({
      ...radioScene(),
      sceneId: 'voiced_probe',
      nodes: [
        {
          id: 'v1',
          speaker: 'wen',
          text: 'Depot, dispatch.',
          audio: 'dlg/prologue/v1.ogg',
          subtitles: 'dlg/prologue/v1.json',
          duration: 2.25,
          next: null,
        },
      ],
      entry: 'v1',
    });
    const { system, events } = harness({ scenes: [scene] });

    system.start('voiced_probe');

    const line = events.find((event) => event.type === 'line-started')!.payload;
    expect(line).toEqual({
      sceneId: 'voiced_probe',
      nodeId: 'v1',
      speaker: 'wen',
      text: 'Depot, dispatch.',
      audio: 'dlg/prologue/v1.ogg',
      subtitles: 'dlg/prologue/v1.json',
      duration: 2.25,
      tier: 'ambient',
      skippable: false,
    });
  });

  it('omits audio and subtitle keys for a line with no recording', () => {
    const { system, events } = harness({ scenes: [radioScene()] });
    system.start(RADIO);

    const line = events.find((event) => event.type === 'line-started')!.payload;
    expect('audio' in line).toBe(false);
    expect('subtitles' in line).toBe(false);
  });

  it('skips a node whose condition fails and continues past it', () => {
    const { system } = harness();
    system.start(HANDOVER);

    system.advance(); // n_count -> n_which
    expect(system.activeNodeId).toBe('n_which');
    system.advance(); // n_dax_aside is gated out

    expect(system.activeNodeId).toBe('n_twelve');
    expect(system.hasSeenNode('n_dax_aside')).toBe(false);
  });

  it('plays a gated node once its condition holds', () => {
    const campaign = createMemoryCampaignState({ flags: { dax_made_contact: true } });
    const { system } = harness({ campaign });
    system.start(HANDOVER);

    system.advance();
    system.advance();

    expect(system.activeNodeId).toBe('n_dax_aside');
  });

  it('auto-advances a line once its duration elapses', () => {
    const { system, tick } = harness({ scenes: [radioScene()], autoAdvance: true });
    system.start(RADIO);

    tick(2);
    expect(system.activeNodeId).toBe('r1');

    tick(1.1);
    expect(system.activeNodeId).toBe('r2');
  });

  it('estimates a duration for a line with no authored timing', () => {
    const short = { id: 'x', speaker: 'mara', text: 'Copy.' } as const;
    expect(lineDuration(short)).toBe(DIALOGUE_MIN_LINE_SECONDS);
    // Ten words at the authored speaking rate, not the floor.
    expect(estimateLineDuration('one two three four five six seven eight nine ten')).toBeCloseTo(
      10 / 2.6,
      5,
    );
  });

  it('refuses to start a second scene over a running one', () => {
    const { system, events } = harness();
    system.start(HANDOVER);

    expect(system.start(RADIO)).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'scene-suppressed',
      payload: { sceneId: RADIO, reason: 'busy' },
    });
    expect(system.activeSceneId).toBe(HANDOVER);
  });

  it('is deterministic: the same inputs produce the same traversal', () => {
    const run = () => {
      const { system, events } = harness();
      system.start(HANDOVER);
      system.advance();
      system.advance();
      system.advance();
      system.choose('c_who');
      system.advance();
      system.choose('c_now');
      system.advance();
      return { path: nodeIds(events), state: system.serialise() };
    };

    const first = run();
    const second = run();
    expect(second.path).toEqual(first.path);
    expect(second.state).toEqual(first.state);
  });
});

// ---------------------------------------------------------------------------
// Choices
// ---------------------------------------------------------------------------

describe('DialogueSystem choices', () => {
  /** Runs the handover to its choice node. */
  function toHub(campaign?: MemoryCampaignState): Harness {
    const h = harness(campaign ? { campaign } : {});
    h.system.start(HANDOVER);
    h.system.advance();
    h.system.advance();
    h.system.advance();
    return h;
  }

  it('offers only choices whose conditions pass', () => {
    const { system, events } = toHub();

    expect(system.activeNodeId).toBe('n_hub');
    const offered = events.find((event) => event.type === 'choices-offered')!.payload;
    expect(offered.choices.map((choice) => choice.id)).toEqual(['c_now', 'c_who']);
    expect(system.offeredChoices.map((choice) => choice.id)).toEqual(['c_now', 'c_who']);
  });

  it('reveals a gated choice once its condition holds', () => {
    const campaign = createMemoryCampaignState({ flags: { clinic_power_stabilized: true } });
    const { system } = toHub(campaign);

    expect(system.offeredChoices.map((choice) => choice.id)).toEqual([
      'c_now',
      'c_after_power',
      'c_who',
    ]);
  });

  it('rejects a choice that is not on offer', () => {
    const { system } = toHub();
    expect(() => system.choose('c_after_power')).toThrow(/not available/);
    expect(() => system.choose('c_nonexistent')).toThrow(/not available/);
    expect(system.activeNodeId).toBe('n_hub');
  });

  it('applies choice effects and follows the branch', () => {
    const { system, campaign, events } = toHub();

    system.choose('c_now');

    expect(campaign.flags.depot_gate_open).toBe(true);
    expect(system.activeNodeId).toBe('n_go');
    expect(events.some((event) => event.type === 'choice-taken')).toBe(true);
    expect(
      events.find((event) => event.type === 'choice-taken')!.payload,
    ).toMatchObject({ choiceId: 'c_now', nodeId: 'n_hub', target: 'n_go' });
  });

  it('ignores advance() while a choice is waiting', () => {
    const { system } = toHub();
    expect(system.advance()).toBe(false);
    expect(system.activeNodeId).toBe('n_hub');
  });

  it('applies a node\u2019s effects exactly once even when the hub is revisited', () => {
    const { system, campaign } = toHub();

    // n_hub grants Ivo a point of trust. Going out to n_ask and back must not
    // grant it twice.
    system.choose('c_who');
    expect(system.activeNodeId).toBe('n_ask');
    expect(campaign.trust.ivo).toBe(1);

    system.advance();
    expect(system.activeNodeId).toBe('n_hub');

    system.choose('c_now');
    expect(campaign.trust.ivo).toBe(1);

    system.advance(); // n_go ends the scene, and onEnd adds the second point.
    expect(system.isRunning).toBe(false);
    expect(campaign.trust.ivo).toBe(2);
  });

  it('records the branch taken in the save slice', () => {
    const { system } = toHub();
    system.choose('c_who');
    expect(system.chosenBranchOf(HANDOVER)).toBe('n_ask');

    system.advance();
    system.choose('c_now');
    expect(system.chosenBranchOf(HANDOVER)).toBe('n_go');
  });
});

// ---------------------------------------------------------------------------
// Interrupts
// ---------------------------------------------------------------------------

describe('DialogueSystem interrupts', () => {
  /** Runs the handover to the interruptible line. */
  function toTwelve(): Harness {
    const h = harness();
    h.system.start(HANDOVER);
    h.system.advance();
    h.system.advance();
    return h;
  }

  it('cuts the line off and continues at the interrupt target', () => {
    const { system, campaign, events, tick } = toTwelve();
    expect(system.activeNodeId).toBe('n_twelve');

    tick(1.2);
    expect(system.notifyEvent('pump.desync')).toBe(true);

    expect(system.activeNodeId).toBe('n_cluster_b');
    expect(
      events.filter((event) => event.type === 'line-ended').at(-1)!.payload,
    ).toMatchObject({ nodeId: 'n_twelve', reason: 'interrupted' });
    // The interrupted line's own effects are not lost — n_twelve has none, but
    // the node the interrupt lands on runs normally.
    system.advance();
    expect(campaign.flags.heard_cluster_b).toBe(true);
  });

  it('respects the earliest window', () => {
    const { system, tick } = toTwelve();

    tick(0.5);
    expect(system.notifyEvent('pump.desync')).toBe(false);
    expect(system.activeNodeId).toBe('n_twelve');

    tick(0.6);
    expect(system.notifyEvent('pump.desync')).toBe(true);
  });

  it('ignores events the current line does not listen for', () => {
    const { system, tick } = toTwelve();
    tick(2);
    expect(system.notifyEvent('gate.closed')).toBe(false);
    expect(system.activeNodeId).toBe('n_twelve');
  });

  it('does not lose the effects of a line it interrupts', () => {
    const scene = parseDialogueScene({
      sceneId: 'interrupt_probe',
      act: 'act1',
      tier: 'focused',
      participants: ['sera', 'mara'],
      entry: 'i1',
      once: true,
      skippable: false,
      nodes: [
        {
          id: 'i1',
          speaker: 'sera',
          text: 'Cluster B is back on the optimiser. Do not touch the priority table.',
          duration: 5,
          effects: [{ kind: 'setFlag', flag: 'sera_override_found', value: true }],
          interrupts: [{ event: 'pump.desync', target: null }],
          next: 'i2',
        },
        { id: 'i2', speaker: 'mara', text: 'Understood.', duration: 1, next: null },
      ],
    });
    const { system, campaign, events } = harness({ scenes: [scene] });

    system.start('interrupt_probe');
    expect(system.notifyEvent('pump.desync')).toBe(true);

    expect(campaign.flags.sera_override_found).toBe(true);
    expect(system.isRunning).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'scene-ended',
      payload: { reason: 'interrupted' },
    });
  });

  it('ignores an interrupt when nothing is running', () => {
    const { system } = harness();
    expect(system.notifyEvent('pump.desync')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Presentation tiers
// ---------------------------------------------------------------------------

describe('DialogueSystem presentation tiers', () => {
  it('never blocks gameplay for an ambient scene', () => {
    const { system, events } = harness({ scenes: [radioScene()] });

    system.start(RADIO);
    expect(system.blocksGameplay).toBe(false);
    expect(system.activeTier).toBe('ambient');
    expect(events[0]).toMatchObject({
      type: 'scene-started',
      payload: { tier: 'ambient', blocksGameplay: false },
    });

    system.advance();
    expect(system.blocksGameplay).toBe(false);
  });

  it('blocks gameplay for a focused scene, and stops when it ends', () => {
    const { system } = harness();

    system.start(HANDOVER);
    expect(system.blocksGameplay).toBe(true);

    system.abort();
    expect(system.blocksGameplay).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Replay protection
// ---------------------------------------------------------------------------

describe('DialogueSystem replay protection', () => {
  function playRadioToEnd(h: Harness): void {
    h.system.start(RADIO);
    h.system.advance();
    h.system.advance();
  }

  it('runs a once scene only once', () => {
    const { system, events } = harness();

    system.start(HANDOVER);
    system.abort();
    // Aborting is not finishing: the conversation is still owed to the player.
    expect(system.start(HANDOVER)).toBe(true);

    system.advance();
    system.advance();
    system.advance();
    system.choose('c_now');
    system.advance();
    expect(system.isRunning).toBe(false);
    expect(system.hasCompletedScene(HANDOVER)).toBe(true);

    events.length = 0;
    expect(system.start(HANDOVER)).toBe(false);
    expect(events).toEqual([
      {
        type: 'scene-suppressed',
        payload: { sceneId: HANDOVER, reason: 'already-seen' },
      },
    ]);
  });

  it('lets a recurring scene play again', () => {
    const h = harness();
    playRadioToEnd(h);
    expect(h.system.hasCompletedScene(RADIO)).toBe(true);

    expect(h.system.start(RADIO)).toBe(true);
    expect(h.system.activeNodeId).toBe('r1');
  });

  it('honours a scene gate that has not passed', () => {
    const gated = parseDialogueScene({
      ...radioScene(),
      sceneId: 'gated_probe',
      availableWhen: { kind: 'flagSet', flag: 'pump12_restarted' },
    });
    const { system, campaign, events } = harness({ scenes: [gated] });

    expect(system.canStart('gated_probe')).toBe(false);
    expect(system.start('gated_probe')).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'scene-suppressed',
      payload: { reason: 'unavailable' },
    });

    campaign.setFlag('pump12_restarted', true);
    expect(system.canStart('gated_probe')).toBe(true);
    expect(system.start('gated_probe')).toBe(true);
  });

  it('records seen nodes without repeating them', () => {
    const { system } = harness();
    system.start(HANDOVER);
    system.advance();
    system.advance();
    system.advance();
    system.choose('c_who');
    system.advance(); // back to n_hub

    expect(system.serialise().seenNodeIds).toEqual([
      'n_count',
      'n_which',
      'n_twelve',
      'n_hub',
      'n_ask',
    ]);
  });

  it('throws on an unknown scene rather than silently doing nothing', () => {
    const { system } = harness();
    expect(() => system.start('no_such_scene')).toThrow(/Unknown dialogue scene/);
  });
});

// ---------------------------------------------------------------------------
// Skipping
// ---------------------------------------------------------------------------

describe('DialogueSystem skipping', () => {
  it('fast-forwards to the choice, keeping the effects it passes', () => {
    const { system, campaign } = harness();
    system.start(HANDOVER);

    expect(system.skip()).toBe(true);

    expect(system.activeNodeId).toBe('n_hub');
    expect(system.offeredChoices.map((choice) => choice.id)).toEqual(['c_now', 'c_who']);
    expect(campaign.trust.ivo).toBe(1);
  });

  it('runs a skipped scene to its end with its flags intact', () => {
    const { system, campaign, events } = harness();
    system.start(HANDOVER);
    system.skip();
    system.choose('c_now');

    expect(system.skip()).toBe(true);
    expect(system.isRunning).toBe(false);
    expect(campaign.flags.ivo_briefed_mara).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: 'scene-ended',
      payload: { reason: 'skipped' },
    });
  });

  it('refuses to skip an unskippable scene', () => {
    const { system } = harness({ scenes: [radioScene()] });
    system.start(RADIO);

    expect(system.skip()).toBe(false);
    expect(system.activeNodeId).toBe('r1');
  });
});

// ---------------------------------------------------------------------------
// Effects and ports
// ---------------------------------------------------------------------------

describe('narrative effects', () => {
  it('routes every effect kind to its sink', () => {
    const campaign = createMemoryCampaignState();
    const missions = { advanceObjective: vi.fn() };
    const cinematics = { unlockCinematic: vi.fn() };
    const sinks = { state: campaign, missions, cinematics };

    applyNarrativeEffect({ kind: 'setFlag', flag: 'gates_stable', value: true }, sinks);
    applyNarrativeEffect({ kind: 'grantEvidence', evidenceId: 'audit_fragment_a' }, sinks);
    applyNarrativeEffect({ kind: 'adjustTrust', character: 'sera', delta: -1 }, sinks);
    applyNarrativeEffect({ kind: 'advanceObjective', objectiveId: 'act1_pump12' }, sinks);
    applyNarrativeEffect({ kind: 'unlockCinematic', sequenceId: 'act1_pump_restart' }, sinks);

    expect(campaign.flags.gates_stable).toBe(true);
    expect(campaign.evidence.has('audit_fragment_a')).toBe(true);
    expect(campaign.trust.sera).toBe(-1);
    expect(missions.advanceObjective).toHaveBeenCalledWith('act1_pump12');
    expect(cinematics.unlockCinematic).toHaveBeenCalledWith('act1_pump_restart');
  });

  it('reports a missing sink instead of dropping the effect silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const campaign = createMemoryCampaignState();

    applyNarrativeEffect(
      { kind: 'advanceObjective', objectiveId: 'act1_pump12' },
      { state: campaign },
    );
    applyNarrativeEffect(
      { kind: 'unlockCinematic', sequenceId: 'act1_pump_restart' },
      { state: campaign },
    );

    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('drives a mission objective from a dialogue effect', () => {
    const campaign = createMemoryCampaignState();
    const missions = { advanceObjective: vi.fn() };
    const scene = parseDialogueScene({
      ...radioScene(),
      sceneId: 'effect_probe',
      nodes: [
        {
          id: 'e1',
          speaker: 'wen',
          text: 'Depot, dispatch. Twelve is yours.',
          duration: 2,
          effects: [{ kind: 'advanceObjective', objectiveId: 'pro_talk_to_ivo' }],
          next: null,
        },
      ],
      entry: 'e1',
    });

    const system = new DialogueSystem({
      scenes: [scene],
      state: campaign,
      missions,
      autoAdvance: false,
    });
    system.start('effect_probe');
    system.advance();

    expect(missions.advanceObjective).toHaveBeenCalledExactlyOnceWith('pro_talk_to_ivo');
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('DialogueSystem persistence', () => {
  it('serialises a shape the save schema accepts', () => {
    const { system } = harness();
    system.start(HANDOVER);
    system.advance();
    system.advance();
    system.advance();
    system.choose('c_now');
    system.advance();

    const slice = system.serialise();
    const parsed = saveSchema.safeParse({ ...createNewSave(), dialogue: slice });
    expect(parsed.success).toBe(true);
    expect(slice).toEqual({
      seenNodeIds: ['n_count', 'n_which', 'n_twelve', 'n_hub', 'n_go'],
      completedSceneIds: [HANDOVER],
      choices: { [HANDOVER]: 'n_go' },
    });
  });

  it('round-trips through a fresh system', () => {
    const first = harness();
    first.system.start(HANDOVER);
    first.system.advance();
    first.system.advance();
    first.system.advance();
    first.system.choose('c_who');
    first.system.advance();
    first.system.choose('c_now');
    first.system.advance();
    first.system.start(RADIO);
    first.system.advance();
    first.system.advance();

    const stored = first.system.serialise();

    const second = harness({ campaign: first.campaign });
    second.system.restore(stored);

    expect(second.system.serialise()).toEqual(stored);
    expect(second.system.hasCompletedScene(HANDOVER)).toBe(true);
    expect(second.system.hasSeenNode('n_ask')).toBe(true);
    expect(second.system.hasSeenNode('n_dax_aside')).toBe(false);
    expect(second.system.chosenBranchOf(HANDOVER)).toBe('n_go');
  });

  it('keeps a once scene suppressed after a reload', () => {
    const first = harness();
    first.system.start(HANDOVER);
    first.system.skip();
    first.system.choose('c_now');
    first.system.skip();

    const stored = first.system.serialise();

    // A brand new campaign store, so only the restored slice can suppress it.
    const second = harness();
    second.system.restore(stored);

    expect(second.system.start(HANDOVER)).toBe(false);
    expect(second.system.start(RADIO)).toBe(true);
  });

  it('aborts a running scene when a save is loaded over it', () => {
    const { system, events } = harness();
    system.start(HANDOVER);
    events.length = 0;

    system.restore(createNewSave().dialogue);

    expect(system.isRunning).toBe(false);
    expect(system.blocksGameplay).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'scene-ended',
      payload: { sceneId: HANDOVER, reason: 'aborted' },
    });
    // Aborted, not completed: the scene is still owed.
    expect(system.hasCompletedScene(HANDOVER)).toBe(false);
    expect(system.serialise()).toEqual(createNewSave().dialogue);
  });

  it('restores a New Game slice as an empty history', () => {
    const { system } = harness();
    system.restore(createNewSave().dialogue);

    expect(system.serialise()).toEqual({
      seenNodeIds: [],
      completedSceneIds: [],
      choices: {},
    });
    expect(system.canStart(HANDOVER)).toBe(true);
  });

  it('deduplicates a stored history without reordering it', () => {
    const { system } = harness();
    system.restore({
      seenNodeIds: ['n_count', 'n_which', 'n_count'],
      completedSceneIds: [RADIO, RADIO],
      choices: { [HANDOVER]: 'n_go' },
    });

    expect(system.serialise()).toEqual({
      seenNodeIds: ['n_count', 'n_which'],
      completedSceneIds: [RADIO],
      choices: { [HANDOVER]: 'n_go' },
    });
  });
});
