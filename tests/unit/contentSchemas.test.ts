/**
 * Content schema tests.
 *
 * These cover the two things authored content can get wrong: a shape the game
 * cannot load, and a shape it loads happily but which strands the player —
 * an objective nothing reaches, a conversation whose only choice points at a
 * node someone renamed.
 *
 * The anti-slop warnings are tested with the same rigour as the structural
 * errors. A banned trailer phrase reaching a committed scene is the failure
 * mode the quality rules exist to prevent, so the check has to actually fire.
 */

import { describe, it, expect } from 'vitest';
import {
  ALWAYS,
  BANNED_PHRASES,
  MAIN_CAST_IDS,
  MAX_CHOICES_PER_NODE,
  MAX_SPOKEN_WORDS_PER_NODE,
  MINOR_CAST_IDS,
  MIN_CHOICES_PER_NODE,
  PLACEHOLDER_MARKERS,
  PRESENTATION_TIERS,
  SPEAKER_IDS,
  STORY_ACTS,
  availableChoices,
  canPlayScene,
  countSpokenWords,
  createNarrativeState,
  dialogueSceneSchema,
  evaluateCondition,
  findBannedPhrases,
  findPlaceholderMarkers,
  hasIssue,
  isSpeakerId,
  issuesWithCode,
  narrativeConditionSchema,
  parseDialogueScene,
  validateDialogueScene,
  type DialogueChoice,
  type DialogueIssueCode,
  type DialogueNode,
  type DialogueScene,
  type NarrativeCondition,
} from '../../src/game/dialogue/dialogueSchema';
import {
  CHECKPOINT_BEHAVIOURS,
  OBJECTIVE_KINDS,
  canActivateObjective,
  findObjective,
  isMissionUnlocked,
  isObjectiveComplete,
  missionSchema,
  parseMission,
  sideObjectivesOf,
  validateMissionGraph,
  writesCheckpointOnActivate,
  writesCheckpointOnComplete,
  type Mission,
  type MissionIssueCode,
  type Objective,
} from '../../src/game/missions/missionSchema';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function node(over: Partial<DialogueNode> & Pick<DialogueNode, 'id'>): DialogueNode {
  return {
    speaker: 'mara',
    text: 'Station Twelve has two priority tables.',
    duration: 2.5,
    ...over,
  };
}

/**
 * A small but structurally complete scene: two speakers, a conditional line, a
 * two-option choice, an interrupt, and every pointer resolving.
 */
function validScene(over: Partial<DialogueScene> = {}): DialogueScene {
  return {
    sceneId: 'act1_pump12_priority',
    title: 'Pump 12 — two tables',
    act: 'act1',
    tier: 'focused',
    participants: ['mara', 'sera'],
    entry: 's1',
    once: true,
    skippable: false,
    nodes: [
      node({
        id: 's1',
        speaker: 'mara',
        text: 'Station Twelve has two priority tables.',
        audio: 'dlg/act1/s1.ogg',
        next: 's2',
        interrupts: [{ event: 'pump.cluster-b.desync', target: 's_interrupted', earliest: 0.8 }],
      }),
      node({
        id: 's2',
        speaker: 'sera',
        text: 'One is the published one.',
        audio: 'dlg/act1/s2.ogg',
        next: 's3',
      }),
      node({
        id: 's3',
        speaker: 'mara',
        text: 'And the other one runs the pumps.',
        audio: 'dlg/act1/s3.ogg',
        choices: [
          { id: 'c_press', text: 'Who signed the second table?', target: 's4' },
          { id: 'c_drop', text: 'Later. Cluster B first.', target: 's5' },
        ],
      }),
      node({
        id: 's4',
        speaker: 'sera',
        text: 'I did. In April.',
        audio: 'dlg/act1/s4.ogg',
        effects: [{ kind: 'setFlag', flag: 'sera_admitted_table', value: true }],
        next: null,
      }),
      node({
        id: 's5',
        speaker: 'sera',
        text: 'Cluster B. Agreed.',
        audio: 'dlg/act1/s5.ogg',
        next: null,
      }),
      node({
        id: 's_interrupted',
        speaker: 'sera',
        text: 'Hold — Cluster B just dropped sync.',
        audio: 'dlg/act1/s_int.ogg',
        next: null,
      }),
    ],
    ...over,
  };
}

function objective(over: Partial<Objective> & Pick<Objective, 'id' | 'testHook'>): Objective {
  return {
    title: 'Reach Pump Station 12',
    description: 'Cross the service bridge and get eyes on Cluster B.',
    kind: 'primary',
    activation: ALWAYS,
    completion: { kind: 'flagSet', flag: 'reached_pump12' },
    markers: [{ position: { x: 12, y: 0.5, z: -40 }, label: 'Service bridge', sectorId: 'residential-edge' }],
    next: null,
    checkpoint: 'none',
    ...over,
  };
}

function validMission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'act1_high_water',
    title: 'High Water',
    act: 'act1',
    summary: 'Restart Cluster B and find the audit gap.',
    entryObjective: 'o_cross',
    objectives: [
      objective({
        id: 'o_cross',
        testHook: 'act1.cross-bridge',
        next: 'o_restart',
        checkpoint: 'on-complete',
      }),
      objective({
        id: 'o_restart',
        testHook: 'act1.restart-cluster-b',
        title: 'Restart Pump Cluster B',
        description: 'Isolate breaker 4B, then bring the cluster up one pump at a time.',
        activation: { kind: 'flagSet', flag: 'reached_pump12' },
        completion: { kind: 'flagSet', flag: 'cluster_b_online' },
        next: 'o_audit',
        checkpoint: 'both',
        hints: [
          { text: 'The breaker panel is behind the pump gallery door.', afterSeconds: 90 },
          { text: 'Isolate 4B before standing in the water.', afterSeconds: 180 },
        ],
      }),
      objective({
        id: 'o_audit',
        testHook: 'act1.read-audit-gap',
        title: 'Read the pump log',
        description: 'The station log covers the night of the surge.',
        activation: { kind: 'flagSet', flag: 'cluster_b_online' },
        completion: { kind: 'evidenceCollected', evidenceId: 'pump12_log' },
        next: null,
        checkpoint: 'on-complete',
        onComplete: [{ kind: 'grantEvidence', evidenceId: 'audit_gap_notice' }],
      }),
      objective({
        id: 'o_side_recording',
        testHook: 'act1.optional-recording',
        title: 'Recover the maintenance recording',
        description: 'A handheld recorder left in the flooded lower gallery.',
        kind: 'optional',
        branchFrom: 'o_restart',
        activation: { kind: 'flagSet', flag: 'cluster_b_online' },
        completion: { kind: 'evidenceCollected', evidenceId: 'gallery_recording' },
        markers: [{ position: { x: 4, y: -2, z: -55 }, label: 'Lower gallery' }],
        next: null,
        checkpoint: 'none',
      }),
    ],
    ...over,
  };
}

/**
 * Escape hatch for testing rules the Zod schema also prevents (four choices,
 * empty text). The linter runs on the typed shape, so a deliberately broken
 * scene is built here rather than weakening the schema to allow it.
 */
function broken<T>(value: unknown): T {
  return value as T;
}

// ---------------------------------------------------------------------------
// Cast and constants
// ---------------------------------------------------------------------------

describe('cast', () => {
  it('restricts speakers to the four main characters plus named minor NPCs', () => {
    expect(MAIN_CAST_IDS).toEqual(['mara', 'sera', 'ivo', 'dax']);
    expect(MINOR_CAST_IDS.length).toBeGreaterThanOrEqual(6);
    expect(MINOR_CAST_IDS.length).toBeLessThanOrEqual(8);
    expect(SPEAKER_IDS).toHaveLength(MAIN_CAST_IDS.length + MINOR_CAST_IDS.length);
    expect(new Set(SPEAKER_IDS).size).toBe(SPEAKER_IDS.length);
  });

  it('rejects speaker ids outside the cast', () => {
    expect(isSpeakerId('sera')).toBe(true);
    expect(isSpeakerId('wen')).toBe(true);
    expect(isSpeakerId('narrator')).toBe(false);
    expect(isSpeakerId('Sera')).toBe(false);
    expect(isSpeakerId(undefined)).toBe(false);
  });

  it('exposes the three presentation tiers and six acts', () => {
    expect(PRESENTATION_TIERS).toEqual(['ambient', 'focused', 'cinematic']);
    expect(STORY_ACTS).toEqual(['prologue', 'act1', 'act2', 'act3', 'finale', 'epilogue']);
  });
});

// ---------------------------------------------------------------------------
// Condition AST
// ---------------------------------------------------------------------------

describe('condition evaluation', () => {
  const state = createNarrativeState({
    flags: { pump12_restarted: true, gate_state: 'stuck', tide_hours: 4, archive_split_known: false },
    evidence: ['pump12_log'],
    completedObjectives: ['o_cross'],
    seenScenes: ['prologue_depot'],
    trust: { sera: 2, dax: -1 },
  });

  it('treats always as unconditional', () => {
    expect(evaluateCondition(ALWAYS, state)).toBe(true);
  });

  it('compares flag values strictly', () => {
    expect(evaluateCondition({ kind: 'flagEquals', flag: 'gate_state', value: 'stuck' }, state)).toBe(true);
    expect(evaluateCondition({ kind: 'flagEquals', flag: 'gate_state', value: 'open' }, state)).toBe(false);
    expect(evaluateCondition({ kind: 'flagEquals', flag: 'tide_hours', value: 4 }, state)).toBe(true);
    // No loose coercion: 4 is not '4'.
    expect(evaluateCondition({ kind: 'flagEquals', flag: 'tide_hours', value: '4' }, state)).toBe(false);
    expect(evaluateCondition({ kind: 'flagEquals', flag: 'absent_flag', value: true }, state)).toBe(false);
  });

  it('treats a flag stored as false as unset', () => {
    // Saves initialise known flags to false, so "present in the record" is not
    // a usable definition of set.
    expect(evaluateCondition({ kind: 'flagSet', flag: 'archive_split_known' }, state)).toBe(false);
    expect(evaluateCondition({ kind: 'flagUnset', flag: 'archive_split_known' }, state)).toBe(true);
    expect(evaluateCondition({ kind: 'flagSet', flag: 'pump12_restarted' }, state)).toBe(true);
    expect(evaluateCondition({ kind: 'flagUnset', flag: 'pump12_restarted' }, state)).toBe(false);
    expect(evaluateCondition({ kind: 'flagSet', flag: 'never_written' }, state)).toBe(false);
    expect(evaluateCondition({ kind: 'flagUnset', flag: 'never_written' }, state)).toBe(true);
  });

  it('counts a non-empty string or non-zero number as set', () => {
    expect(evaluateCondition({ kind: 'flagSet', flag: 'gate_state' }, state)).toBe(true);
    expect(evaluateCondition({ kind: 'flagSet', flag: 'tide_hours' }, state)).toBe(true);
  });

  it('reads evidence, objectives and seen scenes', () => {
    expect(evaluateCondition({ kind: 'evidenceCollected', evidenceId: 'pump12_log' }, state)).toBe(true);
    expect(evaluateCondition({ kind: 'evidenceCollected', evidenceId: 'relay_override' }, state)).toBe(false);
    expect(evaluateCondition({ kind: 'objectiveComplete', objectiveId: 'o_cross' }, state)).toBe(true);
    expect(evaluateCondition({ kind: 'objectiveComplete', objectiveId: 'o_audit' }, state)).toBe(false);
    expect(evaluateCondition({ kind: 'sceneSeen', sceneId: 'prologue_depot' }, state)).toBe(true);
    expect(evaluateCondition({ kind: 'sceneSeen', sceneId: 'act3_confrontation' }, state)).toBe(false);
  });

  it('defaults missing trust to zero', () => {
    expect(evaluateCondition({ kind: 'trustAtLeast', character: 'sera', value: 2 }, state)).toBe(true);
    expect(evaluateCondition({ kind: 'trustAtLeast', character: 'sera', value: 3 }, state)).toBe(false);
    expect(evaluateCondition({ kind: 'trustAtLeast', character: 'dax', value: 0 }, state)).toBe(false);
    expect(evaluateCondition({ kind: 'trustAtLeast', character: 'ivo', value: 0 }, state)).toBe(true);
    expect(evaluateCondition({ kind: 'trustAtLeast', character: 'ivo', value: 1 }, state)).toBe(false);
  });

  it('evaluates and / or / not', () => {
    const yes: NarrativeCondition = { kind: 'flagSet', flag: 'pump12_restarted' };
    const no: NarrativeCondition = { kind: 'flagSet', flag: 'archive_split_known' };

    expect(evaluateCondition({ kind: 'and', all: [yes, yes] }, state)).toBe(true);
    expect(evaluateCondition({ kind: 'and', all: [yes, no] }, state)).toBe(false);
    expect(evaluateCondition({ kind: 'or', any: [yes, no] }, state)).toBe(true);
    expect(evaluateCondition({ kind: 'or', any: [no, no] }, state)).toBe(false);
    expect(evaluateCondition({ kind: 'not', condition: no }, state)).toBe(true);
    expect(evaluateCondition({ kind: 'not', condition: yes }, state)).toBe(false);
  });

  it('evaluates deeply nested combinations', () => {
    // "Cluster B is up AND (I have the log OR Dax trusts me), but the archive
    // split is not public knowledge yet."
    const gate: NarrativeCondition = {
      kind: 'and',
      all: [
        { kind: 'flagSet', flag: 'pump12_restarted' },
        {
          kind: 'or',
          any: [
            { kind: 'evidenceCollected', evidenceId: 'pump12_log' },
            { kind: 'trustAtLeast', character: 'dax', value: 1 },
          ],
        },
        { kind: 'not', condition: { kind: 'flagSet', flag: 'archive_split_known' } },
      ],
    };
    expect(evaluateCondition(gate, state)).toBe(true);

    const afterDisclosure = createNarrativeState({
      flags: { pump12_restarted: true, archive_split_known: true },
      evidence: ['pump12_log'],
    });
    expect(evaluateCondition(gate, afterDisclosure)).toBe(false);
  });

  it('handles double negation and nesting under not', () => {
    const inner: NarrativeCondition = { kind: 'flagSet', flag: 'pump12_restarted' };
    expect(evaluateCondition({ kind: 'not', condition: { kind: 'not', condition: inner } }, state)).toBe(true);
    expect(
      evaluateCondition(
        {
          kind: 'not',
          condition: {
            kind: 'or',
            any: [
              { kind: 'flagSet', flag: 'archive_split_known' },
              { kind: 'sceneSeen', sceneId: 'act3_confrontation' },
            ],
          },
        },
        state,
      ),
    ).toBe(true);
  });

  it('starts empty when no initial state is supplied', () => {
    const empty = createNarrativeState();
    expect(evaluateCondition({ kind: 'flagSet', flag: 'anything' }, empty)).toBe(false);
    expect(evaluateCondition({ kind: 'evidenceCollected', evidenceId: 'anything' }, empty)).toBe(false);
    expect(evaluateCondition({ kind: 'trustAtLeast', character: 'sera', value: 1 }, empty)).toBe(false);
  });

  it('copies its inputs so later mutation of the source cannot rewrite history', () => {
    const flags: Record<string, boolean> = { pump12_restarted: true };
    const built = createNarrativeState({ flags, evidence: ['pump12_log'] });
    flags.pump12_restarted = false;
    expect(evaluateCondition({ kind: 'flagSet', flag: 'pump12_restarted' }, built)).toBe(true);
  });

  it('validates nested conditions through the schema', () => {
    const nested = {
      kind: 'and',
      all: [
        { kind: 'flagEquals', flag: 'gate_state', value: 'stuck' },
        { kind: 'not', condition: { kind: 'or', any: [{ kind: 'flagSet', flag: 'a' }] } },
      ],
    };
    const parsed = narrativeConditionSchema.safeParse(nested);
    expect(parsed.success).toBe(true);
  });

  it('rejects unknown condition kinds, unknown keys and empty operand lists', () => {
    expect(narrativeConditionSchema.safeParse({ kind: 'flagIsProbably', flag: 'a' }).success).toBe(false);
    expect(narrativeConditionSchema.safeParse({ kind: 'flagSet', flag: 'a', extra: 1 }).success).toBe(false);
    expect(narrativeConditionSchema.safeParse({ kind: 'and', all: [] }).success).toBe(false);
    expect(narrativeConditionSchema.safeParse({ kind: 'flagSet', flag: '' }).success).toBe(false);
    expect(
      narrativeConditionSchema.safeParse({ kind: 'trustAtLeast', character: 'narrator', value: 1 }).success,
    ).toBe(false);
    // A malformed child must fail the whole tree, not be silently dropped.
    expect(
      narrativeConditionSchema.safeParse({ kind: 'and', all: [{ kind: 'nope' }] }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dialogue schema
// ---------------------------------------------------------------------------

describe('dialogue scene schema', () => {
  it('accepts a well-formed scene', () => {
    const parsed = dialogueSceneSchema.safeParse(validScene());
    expect(parsed.success).toBe(true);
  });

  it('parses the shape from the spec example', () => {
    const scene = parseDialogueScene({
      sceneId: 'act1_pump12_priority',
      act: 'act1',
      tier: 'focused',
      participants: ['mara', 'sera'],
      entry: 's1',
      once: true,
      skippable: false,
      nodes: [
        {
          id: 's1',
          speaker: 'mara',
          text: 'Station Twelve has two priority tables.',
          audio: 'dlg/act1/s1.ogg',
          next: 's2',
        },
        { id: 's2', speaker: 'sera', text: 'One is the published one.', audio: 'dlg/act1/s2.ogg' },
      ],
    });
    expect(scene.nodes).toHaveLength(2);
    expect(scene.nodes[0]?.next).toBe('s2');
  });

  it('throws with a readable path when content is malformed', () => {
    expect(() => parseDialogueScene({ sceneId: 'x' })).toThrow(/invalid dialogue scene/);
    expect(() =>
      parseDialogueScene({ ...validScene(), participants: [] }),
    ).toThrow(/participants/);
  });

  it('rejects an unknown speaker at load time', () => {
    const scene = { ...validScene(), participants: ['mara', 'narrator'] };
    expect(dialogueSceneSchema.safeParse(scene).success).toBe(false);
  });

  it('rejects unknown keys so a typo is a failure, not a dropped field', () => {
    const scene = validScene();
    const withTypo = {
      ...scene,
      nodes: [{ ...scene.nodes[0], nextt: 's2' }, ...scene.nodes.slice(1)],
    };
    expect(dialogueSceneSchema.safeParse(withTypo).success).toBe(false);
  });

  it('rejects empty text and non-positive durations', () => {
    const scene = validScene();
    expect(
      dialogueSceneSchema.safeParse({
        ...scene,
        nodes: [{ ...scene.nodes[0], text: '' }, ...scene.nodes.slice(1)],
      }).success,
    ).toBe(false);
    expect(
      dialogueSceneSchema.safeParse({
        ...scene,
        nodes: [{ ...scene.nodes[0], duration: 0 }, ...scene.nodes.slice(1)],
      }).success,
    ).toBe(false);
  });

  it('caps choices at three and requires at least two', () => {
    const scene = validScene();
    const choiceNode = scene.nodes[2];
    const four: DialogueChoice[] = [
      { id: 'a', text: 'One', target: 's4' },
      { id: 'b', text: 'Two', target: 's5' },
      { id: 'c', text: 'Three', target: 's5' },
      { id: 'd', text: 'Four', target: 's5' },
    ];
    expect(
      dialogueSceneSchema.safeParse({
        ...scene,
        nodes: [...scene.nodes.slice(0, 2), { ...choiceNode, choices: four }, ...scene.nodes.slice(3)],
      }).success,
    ).toBe(false);
    expect(
      dialogueSceneSchema.safeParse({
        ...scene,
        nodes: [
          ...scene.nodes.slice(0, 2),
          { ...choiceNode, choices: [four[0]] },
          ...scene.nodes.slice(3),
        ],
      }).success,
    ).toBe(false);
    expect(MIN_CHOICES_PER_NODE).toBe(2);
    expect(MAX_CHOICES_PER_NODE).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Replay protection and choice gating
// ---------------------------------------------------------------------------

describe('replay protection', () => {
  it('blocks a once-only scene that has already played', () => {
    const scene = validScene({ once: true });
    expect(canPlayScene(scene, createNarrativeState())).toBe(true);
    expect(
      canPlayScene(scene, createNarrativeState({ seenScenes: [scene.sceneId] })),
    ).toBe(false);
  });

  it('lets a repeatable ambient line play again', () => {
    const scene = validScene({ sceneId: 'depot_chatter', once: false, tier: 'ambient' });
    expect(
      canPlayScene(scene, createNarrativeState({ seenScenes: ['depot_chatter'] })),
    ).toBe(true);
  });

  it('honours the scene availability gate independently of replay state', () => {
    const scene = validScene({
      once: false,
      availableWhen: { kind: 'flagSet', flag: 'crossed_bridge' },
    });
    expect(canPlayScene(scene, createNarrativeState())).toBe(false);
    expect(
      canPlayScene(scene, createNarrativeState({ flags: { crossed_bridge: true } })),
    ).toBe(true);
  });
});

describe('choice gating', () => {
  const gatedNode = node({
    id: 'g1',
    choices: [
      { id: 'c_open', text: 'Ask about the table.', target: 'g2' },
      {
        id: 'c_evidence',
        text: 'Show her the pump log.',
        condition: { kind: 'evidenceCollected', evidenceId: 'pump12_log' },
        target: 'g3',
      },
    ],
  });

  it('hides choices whose condition fails', () => {
    const withoutLog = availableChoices(gatedNode, createNarrativeState());
    expect(withoutLog.map((choice) => choice.id)).toEqual(['c_open']);
  });

  it('offers gated choices once the condition passes', () => {
    const withLog = availableChoices(gatedNode, createNarrativeState({ evidence: ['pump12_log'] }));
    expect(withLog.map((choice) => choice.id)).toEqual(['c_open', 'c_evidence']);
  });

  it('returns nothing for a node with no choices', () => {
    expect(availableChoices(node({ id: 'plain', next: null }), createNarrativeState())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dialogue linting — errors
// ---------------------------------------------------------------------------

describe('validateDialogueScene errors', () => {
  function expectError(scene: DialogueScene, code: DialogueIssueCode): void {
    const result = validateDialogueScene(scene);
    expect(result.ok).toBe(false);
    expect(result.errors.map((issue) => issue.code)).toContain(code);
  }

  it('passes a clean scene with no errors', () => {
    const result = validateDialogueScene(validScene());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('flags duplicate node ids', () => {
    const scene = validScene();
    scene.nodes.push(node({ id: 's2', speaker: 'sera', text: 'Say that again.', next: null }));
    expectError(scene, 'duplicate-node-id');
  });

  it('flags a dangling next pointer', () => {
    const scene = validScene();
    scene.nodes[1] = { ...scene.nodes[1], next: 's_missing' };
    expectError(scene, 'dangling-next-pointer');
  });

  it('flags a dangling choice target', () => {
    const scene = validScene();
    scene.nodes[2] = {
      ...scene.nodes[2],
      choices: [
        { id: 'c_press', text: 'Who signed it?', target: 's_renamed' },
        { id: 'c_drop', text: 'Later.', target: 's5' },
      ],
    };
    expectError(scene, 'dangling-choice-target');
  });

  it('flags a dangling interrupt target', () => {
    const scene = validScene();
    scene.nodes[0] = {
      ...scene.nodes[0],
      interrupts: [{ event: 'pump.desync', target: 's_gone' }],
    };
    expectError(scene, 'dangling-interrupt-target');
  });

  it('accepts an interrupt that ends the scene', () => {
    const scene = validScene();
    scene.nodes[0] = {
      ...scene.nodes[0],
      interrupts: [{ event: 'pump.desync', target: null }],
    };
    // s_interrupted was only reachable via the interrupt, so drop it too.
    scene.nodes = scene.nodes.filter((n) => n.id !== 's_interrupted');
    expect(validateDialogueScene(scene).errors).toEqual([]);
  });

  it('flags a missing entry node', () => {
    expectError(validScene({ entry: 's_nowhere' }), 'missing-entry-node');
  });

  it('flags an unreachable node', () => {
    const scene = validScene();
    scene.nodes.push(
      node({ id: 's_orphan', speaker: 'sera', text: 'Nobody hears this line.', next: null }),
    );
    const result = validateDialogueScene(scene);
    expect(result.ok).toBe(false);
    expect(issuesWithCode(result, 'unreachable-node').map((i) => i.target)).toEqual(['s_orphan']);
  });

  it('reaches nodes through choices and interrupts, not just next pointers', () => {
    // s4 and s5 are choice-only targets, s_interrupted is interrupt-only.
    const result = validateDialogueScene(validScene());
    expect(issuesWithCode(result, 'unreachable-node')).toEqual([]);
  });

  it('flags a node that has both choices and a next pointer', () => {
    const scene = validScene();
    scene.nodes[2] = { ...scene.nodes[2], next: 's5' };
    expectError(scene, 'choices-and-next');
  });

  it('flags more than three choices', () => {
    const scene = validScene();
    scene.nodes[2] = broken<DialogueNode>({
      ...scene.nodes[2],
      choices: [
        { id: 'a', text: 'Who signed it?', target: 's4' },
        { id: 'b', text: 'Later.', target: 's5' },
        { id: 'c', text: 'Show me the table.', target: 's4' },
        { id: 'd', text: 'One more question.', target: 's5' },
      ],
    });
    expectError(scene, 'too-many-choices');
  });

  it('flags a single-option choice as a fake choice', () => {
    const scene = validScene();
    scene.nodes[2] = broken<DialogueNode>({
      ...scene.nodes[2],
      choices: [{ id: 'a', text: 'Continue.', target: 's4' }],
    });
    const result = validateDialogueScene(scene);
    expect(result.errors.map((i) => i.code)).toContain('too-few-choices');
  });

  it('flags duplicate choice ids', () => {
    const scene = validScene();
    scene.nodes[2] = {
      ...scene.nodes[2],
      choices: [
        { id: 'c_press', text: 'Who signed it?', target: 's4' },
        { id: 'c_press', text: 'Later.', target: 's5' },
      ],
    };
    expectError(scene, 'duplicate-choice-id');
  });

  it('flags empty node and choice text', () => {
    const blankNode = validScene();
    blankNode.nodes[1] = broken<DialogueNode>({ ...blankNode.nodes[1], text: '   ' });
    expectError(blankNode, 'empty-text');

    const blankChoice = validScene();
    blankChoice.nodes[2] = broken<DialogueNode>({
      ...blankChoice.nodes[2],
      choices: [
        { id: 'c_press', text: '', target: 's4' },
        { id: 'c_drop', text: 'Later.', target: 's5' },
      ],
    });
    expectError(blankChoice, 'empty-text');
  });

  it('flags placeholder text in every documented form', () => {
    for (const marker of ['TODO: write this', 'Lorem ipsum dolor sit amet', 'placeholder line']) {
      const scene = validScene();
      scene.nodes[1] = { ...scene.nodes[1], text: marker };
      expectError(scene, 'placeholder-text');
    }
    expect(PLACEHOLDER_MARKERS).toContain('todo');
    expect(PLACEHOLDER_MARKERS).toContain('lorem ipsum');
    expect(PLACEHOLDER_MARKERS).toContain('placeholder');
  });

  it('flags placeholder text in a choice', () => {
    const scene = validScene();
    scene.nodes[2] = {
      ...scene.nodes[2],
      choices: [
        { id: 'c_press', text: 'TODO decide wording', target: 's4' },
        { id: 'c_drop', text: 'Later.', target: 's5' },
      ],
    };
    expectError(scene, 'placeholder-text');
  });

  it('does not treat a word merely containing a marker as a placeholder', () => {
    const scene = validScene();
    // "Todos" is not "TODO"; word-boundary matching keeps localised content usable.
    scene.nodes[1] = { ...scene.nodes[1], text: 'Todos the pump crew signed off on it.' };
    expect(findPlaceholderMarkers(scene.nodes[1].text)).toEqual([]);
    expect(validateDialogueScene(scene).errors.map((i) => i.code)).not.toContain('placeholder-text');
  });

  it('flags a line spoken by someone who is not in the scene', () => {
    const scene = validScene();
    scene.nodes[1] = { ...scene.nodes[1], speaker: 'dax' };
    expectError(scene, 'speaker-not-participant');
  });

  it('keeps validating the graph when a duplicate id is present', () => {
    const scene = validScene();
    scene.nodes.push(node({ id: 's2', speaker: 'sera', text: 'Duplicate.', next: 's_missing' }));
    const result = validateDialogueScene(scene);
    // The duplicate is reported, and the first definition still walks cleanly.
    expect(result.errors.map((i) => i.code)).toContain('duplicate-node-id');
    expect(result.errors.map((i) => i.code)).not.toContain('dangling-next-pointer');
  });
});

// ---------------------------------------------------------------------------
// Dialogue linting — anti-slop warnings
// ---------------------------------------------------------------------------

describe('validateDialogueScene anti-slop warnings', () => {
  it('flags a real banned phrase', () => {
    const scene = validScene();
    scene.nodes[1] = { ...scene.nodes[1], text: 'This changes everything.' };
    const result = validateDialogueScene(scene);
    // A warning, not an error: it blocks nothing but must be visible.
    expect(result.ok).toBe(true);
    const flagged = issuesWithCode(result, 'banned-phrase');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.message).toContain('this changes everything');
    expect(flagged[0]?.target).toBe('s2');
  });

  it('catches every banned phrase in the published list', () => {
    for (const phrase of BANNED_PHRASES) {
      const scene = validScene();
      scene.nodes[1] = { ...scene.nodes[1], text: `${phrase}.` };
      expect(hasIssue(validateDialogueScene(scene), 'banned-phrase')).toBe(true);
    }
  });

  it('matches banned phrases through case, curly apostrophes and punctuation', () => {
    expect(findBannedPhrases('THIS CHANGES EVERYTHING!')).toEqual(['this changes everything']);
    expect(findBannedPhrases('There\u2019s no going back, Mara.')).toEqual(["there's no going back"]);
    expect(findBannedPhrases('We are  running   out of time')).toEqual([]);
    expect(findBannedPhrases("Cluster B is losing sync. We're out of time.")).toEqual([
      "we're out of time",
    ]);
  });

  it('leaves grounded dialogue alone', () => {
    expect(findBannedPhrases('Breaker 4B is still closed. Isolate it before you step in.')).toEqual([]);
    expect(validateDialogueScene(validScene()).warnings.filter((w) => w.code === 'banned-phrase')).toEqual([]);
  });

  it('flags a node that has turned into a monologue', () => {
    const long = Array.from({ length: MAX_SPOKEN_WORDS_PER_NODE + 5 }, () => 'pump').join(' ');
    expect(countSpokenWords(long)).toBe(MAX_SPOKEN_WORDS_PER_NODE + 5);
    const scene = validScene();
    scene.nodes[1] = { ...scene.nodes[1], text: long };
    const flagged = issuesWithCode(validateDialogueScene(scene), 'monologue-length');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.message).toContain(String(MAX_SPOKEN_WORDS_PER_NODE + 5));
  });

  it('allows a line exactly at the word limit', () => {
    const atLimit = Array.from({ length: MAX_SPOKEN_WORDS_PER_NODE }, () => 'pump').join(' ');
    const scene = validScene();
    scene.nodes[1] = { ...scene.nodes[1], text: atLimit };
    expect(hasIssue(validateDialogueScene(scene), 'monologue-length')).toBe(false);
  });

  it('counts words without being fooled by extra whitespace', () => {
    expect(countSpokenWords('  Cluster   B.\nSync lost. ')).toBe(4);
    expect(countSpokenWords('   ')).toBe(0);
  });

  it('flags a two-person scene where only one person talks', () => {
    const scene = validScene({
      participants: ['mara', 'ivo'],
      entry: 'm1',
      nodes: [
        node({ id: 'm1', speaker: 'mara', text: 'Six oxygen units.', next: 'm2' }),
        node({ id: 'm2', speaker: 'mara', text: 'Four batteries.', next: 'm3' }),
        node({ id: 'm3', speaker: 'mara', text: 'That is not enough for tonight.', next: null }),
      ],
    });
    const flagged = issuesWithCode(validateDialogueScene(scene), 'single-speaker-scene');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.message).toContain('mara');
  });

  it('does not flag a deliberate single-participant scene', () => {
    const radio = validScene({
      participants: ['wen'],
      entry: 'r1',
      nodes: [
        node({ id: 'r1', speaker: 'wen', text: 'Dispatch, repeat your last.', next: 'r2' }),
        node({ id: 'r2', speaker: 'wen', text: 'Nothing. Line is dropping again.', next: null }),
      ],
    });
    expect(hasIssue(validateDialogueScene(radio), 'single-speaker-scene')).toBe(false);
  });

  it('flags a line with neither audio nor an explicit duration', () => {
    const scene = validScene();
    scene.nodes[1] = broken<DialogueNode>({
      id: 's2',
      speaker: 'sera',
      text: 'One is the published one.',
      next: 's3',
    });
    expect(hasIssue(validateDialogueScene(scene), 'missing-line-timing')).toBe(true);
  });

  it('separates warnings from errors', () => {
    const scene = validScene();
    scene.nodes[1] = { ...scene.nodes[1], text: 'You have no idea.' };
    const result = validateDialogueScene(scene);
    expect(result.errors).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.every((w) => w.severity === 'warning')).toBe(true);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mission schema
// ---------------------------------------------------------------------------

describe('mission schema', () => {
  it('accepts a well-formed mission', () => {
    expect(missionSchema.safeParse(validMission()).success).toBe(true);
  });

  it('exposes the documented objective kinds and checkpoint behaviours', () => {
    expect(OBJECTIVE_KINDS).toEqual(['primary', 'optional']);
    expect(CHECKPOINT_BEHAVIOURS).toEqual(['none', 'on-activate', 'on-complete', 'both']);
  });

  it('requires a test hook on every objective', () => {
    const mission = validMission();
    const withoutHook = {
      ...mission,
      objectives: [{ ...mission.objectives[0], testHook: undefined }, ...mission.objectives.slice(1)],
    };
    expect(missionSchema.safeParse(withoutHook).success).toBe(false);
  });

  it('throws with a readable path on malformed mission data', () => {
    expect(() => parseMission({ id: 'act1' })).toThrow(/invalid mission/);
    expect(() => parseMission({ ...validMission(), act: 'act9' })).toThrow(/act/);
  });

  it('rejects unknown keys', () => {
    expect(missionSchema.safeParse({ ...validMission(), chapter: 2 }).success).toBe(false);
  });

  it('round-trips through parseMission', () => {
    const mission = parseMission(validMission());
    expect(mission.objectives).toHaveLength(4);
    expect(findObjective(mission, 'o_restart')?.checkpoint).toBe('both');
    expect(findObjective(mission, 'nope')).toBeUndefined();
  });
});

describe('mission runtime helpers', () => {
  const mission = validMission();

  it('reports checkpoint behaviour', () => {
    const both = findObjective(mission, 'o_restart') as Objective;
    const onComplete = findObjective(mission, 'o_cross') as Objective;
    const none = findObjective(mission, 'o_side_recording') as Objective;

    expect(writesCheckpointOnActivate(both)).toBe(true);
    expect(writesCheckpointOnComplete(both)).toBe(true);
    expect(writesCheckpointOnActivate(onComplete)).toBe(false);
    expect(writesCheckpointOnComplete(onComplete)).toBe(true);
    expect(writesCheckpointOnActivate(none)).toBe(false);
    expect(writesCheckpointOnComplete(none)).toBe(false);
  });

  it('gates activation and completion on campaign state', () => {
    const restart = findObjective(mission, 'o_restart') as Objective;
    expect(canActivateObjective(restart, createNarrativeState())).toBe(false);
    expect(
      canActivateObjective(restart, createNarrativeState({ flags: { reached_pump12: true } })),
    ).toBe(true);
    expect(isObjectiveComplete(restart, createNarrativeState({ flags: { cluster_b_online: true } }))).toBe(true);
    expect(isObjectiveComplete(restart, createNarrativeState())).toBe(false);
  });

  it('treats a mission with no unlock condition as unlocked', () => {
    expect(isMissionUnlocked(mission, createNarrativeState())).toBe(true);
    const gated = validMission({ unlockedBy: { kind: 'objectiveComplete', objectiveId: 'p_cross_bridge' } });
    expect(isMissionUnlocked(gated, createNarrativeState())).toBe(false);
    expect(
      isMissionUnlocked(gated, createNarrativeState({ completedObjectives: ['p_cross_bridge'] })),
    ).toBe(true);
  });

  it('lists side objectives by their branch point', () => {
    expect(sideObjectivesOf(mission, 'o_restart').map((o) => o.id)).toEqual(['o_side_recording']);
    expect(sideObjectivesOf(mission, 'o_cross')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mission graph validation
// ---------------------------------------------------------------------------

describe('validateMissionGraph', () => {
  function expectError(mission: Mission, code: MissionIssueCode): void {
    const result = validateMissionGraph(mission);
    expect(result.ok).toBe(false);
    expect(result.errors.map((issue) => issue.code)).toContain(code);
  }

  it('passes a clean mission with a chain and a side branch', () => {
    const result = validateMissionGraph(validMission());
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('flags a dangling next pointer', () => {
    const mission = validMission();
    mission.objectives[0] = { ...mission.objectives[0], next: 'o_renamed' };
    const result = validateMissionGraph(mission);
    expect(result.errors.map((i) => i.code)).toContain('dangling-next-pointer');
  });

  it('flags unreachable objectives', () => {
    const mission = validMission();
    mission.objectives.push(
      objective({
        id: 'o_ghost',
        testHook: 'act1.ghost',
        title: 'Check the relay annex door',
        description: 'Left over from an earlier draft of the mission.',
        next: null,
      }),
    );
    const result = validateMissionGraph(mission);
    expect(result.ok).toBe(false);
    expect(issuesWithCode(result, 'unreachable-objective').map((i) => i.target)).toEqual(['o_ghost']);
  });

  it('treats a side objective with no branch point as unreachable', () => {
    const mission = validMission();
    mission.objectives[3] = broken<Objective>({ ...mission.objectives[3], branchFrom: undefined });
    expect(issuesWithCode(validateMissionGraph(mission), 'unreachable-objective').map((i) => i.target)).toEqual([
      'o_side_recording',
    ]);
  });

  it('flags a cycle in the objective chain', () => {
    const mission = validMission();
    mission.objectives[2] = { ...mission.objectives[2], next: 'o_cross' };
    const result = validateMissionGraph(mission);
    expect(result.ok).toBe(false);
    const cycles = issuesWithCode(result, 'cyclic-objective-chain');
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.message).toContain('o_cross');
    expect(cycles[0]?.message).toContain('o_audit');
  });

  it('flags a self-loop', () => {
    const mission = validMission();
    mission.objectives[1] = { ...mission.objectives[1], next: 'o_restart' };
    expectError(mission, 'cyclic-objective-chain');
  });

  it('reports each cycle once', () => {
    const mission = validMission({
      entryObjective: 'a',
      objectives: [
        objective({ id: 'a', testHook: 'h.a', next: 'b' }),
        objective({ id: 'b', testHook: 'h.b', next: 'c' }),
        objective({ id: 'c', testHook: 'h.c', next: 'a' }),
        objective({ id: 'd', testHook: 'h.d', next: null }),
      ],
    });
    const result = validateMissionGraph(mission);
    expect(issuesWithCode(result, 'cyclic-objective-chain')).toHaveLength(1);
  });

  it('flags a missing entry objective', () => {
    expectError(validMission({ entryObjective: 'o_nowhere' }), 'missing-entry-objective');
  });

  it('flags duplicate objective ids', () => {
    const mission = validMission();
    mission.objectives.push(
      objective({ id: 'o_restart', testHook: 'act1.duplicate', next: null }),
    );
    expectError(mission, 'duplicate-objective-id');
  });

  it('flags duplicate test hooks', () => {
    const mission = validMission();
    mission.objectives[1] = { ...mission.objectives[1], testHook: 'act1.cross-bridge' };
    const result = validateMissionGraph(mission);
    expect(result.errors.map((i) => i.code)).toContain('duplicate-test-hook');
    expect(issuesWithCode(result, 'duplicate-test-hook')[0]?.message).toContain('o_cross');
  });

  it('flags a branch point that does not exist', () => {
    const mission = validMission();
    mission.objectives[3] = { ...mission.objectives[3], branchFrom: 'o_deleted' };
    expectError(mission, 'dangling-branch-from');
  });

  it('flags a self-branch', () => {
    const mission = validMission();
    mission.objectives[3] = { ...mission.objectives[3], branchFrom: 'o_side_recording' };
    expectError(mission, 'self-branch');
  });

  it('flags branchFrom on a primary objective', () => {
    const mission = validMission();
    mission.objectives[1] = { ...mission.objectives[1], branchFrom: 'o_cross' };
    expectError(mission, 'branch-from-on-primary');
  });

  it('flags a mission that can never end', () => {
    const mission = validMission({
      entryObjective: 'a',
      objectives: [
        objective({ id: 'a', testHook: 'h.a', next: 'b' }),
        objective({
          id: 'b',
          testHook: 'h.b',
          kind: 'optional',
          branchFrom: 'a',
          next: null,
        }),
      ],
    });
    // The only terminal objective is optional, so the primary chain never closes.
    expectError(mission, 'no-terminal-objective');
  });

  it('does not claim a mission cannot end when the real fault is a broken pointer', () => {
    const mission = validMission({
      entryObjective: 'a',
      objectives: [objective({ id: 'a', testHook: 'h.a', next: 'b_typo' })],
    });
    const result = validateMissionGraph(mission);
    expect(result.errors.map((i) => i.code)).toContain('dangling-next-pointer');
    expect(result.errors.map((i) => i.code)).not.toContain('no-terminal-objective');
  });

  it('flags placeholder text in objective titles and descriptions', () => {
    const titled = validMission();
    titled.objectives[0] = { ...titled.objectives[0], title: 'TODO name this objective' };
    expectError(titled, 'placeholder-text');

    const described = validMission();
    described.objectives[0] = { ...described.objectives[0], description: 'Lorem ipsum dolor.' };
    expectError(described, 'placeholder-text');
  });

  it('warns when a primary objective has no world marker', () => {
    const mission = validMission();
    mission.objectives[1] = { ...mission.objectives[1], markers: [] };
    const result = validateMissionGraph(mission);
    expect(result.ok).toBe(true);
    expect(issuesWithCode(result, 'primary-objective-without-marker').map((i) => i.target)).toEqual([
      'o_restart',
    ]);
  });

  it('does not warn about a markerless optional objective', () => {
    const mission = validMission();
    mission.objectives[3] = { ...mission.objectives[3], markers: [] };
    expect(hasIssue(validateMissionGraph(mission), 'primary-objective-without-marker')).toBe(false);
  });

  it('warns about hints that are out of time order', () => {
    const mission = validMission();
    mission.objectives[1] = {
      ...mission.objectives[1],
      hints: [
        { text: 'Isolate 4B before standing in the water.', afterSeconds: 180 },
        { text: 'The breaker panel is behind the gallery door.', afterSeconds: 90 },
      ],
    };
    const result = validateMissionGraph(mission);
    expect(result.ok).toBe(true);
    expect(hasIssue(result, 'unordered-hints')).toBe(true);
  });

  it('accepts hints at equal times', () => {
    const mission = validMission();
    mission.objectives[1] = {
      ...mission.objectives[1],
      hints: [
        { text: 'Check the gallery door.', afterSeconds: 90 },
        { text: 'Then the breaker panel.', afterSeconds: 90 },
      ],
    };
    expect(hasIssue(validateMissionGraph(mission), 'unordered-hints')).toBe(false);
  });
});
