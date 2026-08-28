/**
 * Mission runtime tests.
 *
 * The failures this system exists to prevent are all invisible to a typecheck:
 * an objective that never activates because the flag it waits on was set before
 * anyone was listening, a side objective that quietly blocks the finale, a
 * checkpoint that reloads pointing at an objective the player already finished.
 * So the properties tested here are the ones a player would actually notice —
 * the chain advances, optional work stays optional, a failure stalls loudly
 * rather than silently, and a save reloads into the state it was written from.
 *
 * Time is the fixed simulation clock, driven with explicit steps. Nothing here
 * mocks `Date.now`, because the system never reads it.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MISSION_EVALUATION_INTERVAL_S,
  MissionSystem,
  missionCheckpointId,
  type MissionEvents,
} from '../../src/game/missions/MissionSystem';
import {
  parseMission,
  validateMissionGraph,
  type Mission,
} from '../../src/game/missions/missionSchema';
import {
  createMemoryCampaignState,
  type CampaignStatePort,
  type MemoryCampaignState,
} from '../../src/game/dialogue/DialogueSystem';
import type { NarrativeCondition } from '../../src/game/dialogue/dialogueSchema';
import { createNewSave, saveSchema } from '../../src/persistence/saveSchema';

const DT = 1 / 60;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MISSION_ID = 'prologue_before_the_waterline';

const CLINIC = 'pro_check_clinic_power';
const BRIEF = 'pro_talk_to_ivo';
const BRIDGE = 'pro_cross_service_bridge';
const BATTERY = 'pro_log_battery_count';

/**
 * The prologue spine, plus one side objective.
 *
 * Written as raw data and put through `parseMission` so the fixture is proven
 * to be something the content loader would accept — a test that passes against
 * a shape the game would reject is worse than no test.
 *
 * `pro_cross_service_bridge` gates on a nested condition on purpose: it is the
 * shape real content uses (the conversation happened *and* the gate is open) and
 * it exercises the AST through the runtime rather than in isolation.
 */
function prologueMission(): Mission {
  return parseMission({
    id: MISSION_ID,
    title: 'Before the Waterline',
    act: 'prologue',
    summary: 'Mara stabilises the depot clinic, takes Ivo\u2019s briefing and crosses into the sealed zone.',
    entryObjective: CLINIC,
    objectives: [
      {
        id: CLINIC,
        title: 'Restore the clinic feed',
        description: 'The depot clinic is running on backup. Bring the transfer switch back onto mains.',
        kind: 'primary',
        activation: { kind: 'always' },
        completion: { kind: 'flagSet', flag: 'clinic_power_stabilized' },
        markers: [
          { position: { x: 4, y: 0, z: -12 }, label: 'Transfer switch', sectorId: 'depot_platform' },
        ],
        next: BRIEF,
        checkpoint: 'on-activate',
        testHook: 'prologue.clinic_power',
      },
      {
        id: BRIEF,
        title: 'Take Ivo\u2019s handover',
        description: 'Ivo has the count of what the clinic has left and which gate is still shut.',
        kind: 'primary',
        activation: { kind: 'objectiveComplete', objectiveId: CLINIC },
        completion: { kind: 'flagSet', flag: 'ivo_briefed_mara' },
        markers: [{ position: { x: -2, y: 0, z: 3 }, label: 'Clinic bay' }],
        next: BRIDGE,
        checkpoint: 'none',
        testHook: 'prologue.ivo_brief',
        onComplete: [{ kind: 'setFlag', flag: 'gate_procedure_learned', value: true }],
      },
      {
        id: BRIDGE,
        title: 'Cross the service bridge',
        description: 'The bridge is the only way into the sealed district that is not under water.',
        kind: 'primary',
        activation: {
          kind: 'and',
          all: [
            { kind: 'objectiveComplete', objectiveId: BRIEF },
            { kind: 'flagSet', flag: 'depot_gate_open' },
          ],
        },
        completion: { kind: 'flagSet', flag: 'crossed_service_bridge' },
        markers: [{ position: { x: 30, y: 6, z: 0 }, label: 'Service bridge' }],
        next: null,
        checkpoint: 'both',
        testHook: 'prologue.bridge',
        hints: [
          { text: 'The bridge stair is behind the ticket hall.', afterSeconds: 45 },
          { text: 'Ivo said the west stair is dry. Try the west stair.', afterSeconds: 90 },
        ],
      },
      {
        id: BATTERY,
        title: 'Log the clinic battery count',
        description: 'Ivo will want the count written down before anyone asks him for it twice.',
        kind: 'optional',
        activation: { kind: 'always' },
        completion: { kind: 'flagSet', flag: 'battery_count_logged' },
        markers: [{ position: { x: -3, y: 0, z: 5 }, label: 'Supply crate' }],
        next: null,
        branchFrom: BRIEF,
        checkpoint: 'none',
        testHook: 'prologue.battery_log',
      },
    ],
  });
}

/** A one-objective mission whose activation is the condition under test. */
function gatedMission(activation: NarrativeCondition): Mission {
  return parseMission({
    id: 'gate_probe',
    title: 'Gate probe',
    act: 'act1',
    summary: 'Single-objective fixture used to drive one activation condition.',
    entryObjective: 'probe',
    objectives: [
      {
        id: 'probe',
        title: 'Open Valve 4B',
        description: 'Bring the manual valve back into service.',
        kind: 'primary',
        activation,
        completion: { kind: 'flagSet', flag: 'probe_done' },
        markers: [{ position: { x: 0, y: 0, z: 0 }, label: 'Valve 4B' }],
        next: null,
        checkpoint: 'none',
        testHook: 'probe.valve',
      },
    ],
  });
}

interface Harness {
  system: MissionSystem;
  campaign: MemoryCampaignState;
  events: RecordedEvent[];
  /** Advances the clock far enough that a throttled scan definitely ran. */
  tick(seconds?: number): void;
}

type RecordedEvent =
  | { type: 'activated'; payload: MissionEvents['objective-activated'] }
  | { type: 'completed'; payload: MissionEvents['objective-completed'] }
  | { type: 'failed'; payload: MissionEvents['objective-failed'] }
  | { type: 'active-changed'; payload: MissionEvents['active-objective-changed'] }
  | { type: 'markers'; payload: MissionEvents['markers-changed'] }
  | { type: 'checkpoint'; payload: MissionEvents['checkpoint-requested'] }
  | { type: 'mission-completed'; payload: MissionEvents['mission-completed'] };

function harness(
  missions: readonly Mission[] = [prologueMission()],
  campaign: MemoryCampaignState = createMemoryCampaignState(),
): Harness {
  const system = new MissionSystem({ missions, state: campaign });
  const events: RecordedEvent[] = [];

  system.on('objective-activated', (payload) => events.push({ type: 'activated', payload }));
  system.on('objective-completed', (payload) => events.push({ type: 'completed', payload }));
  system.on('objective-failed', (payload) => events.push({ type: 'failed', payload }));
  system.on('active-objective-changed', (payload) =>
    events.push({ type: 'active-changed', payload }),
  );
  system.on('markers-changed', (payload) => events.push({ type: 'markers', payload }));
  system.on('checkpoint-requested', (payload) => events.push({ type: 'checkpoint', payload }));
  system.on('mission-completed', (payload) =>
    events.push({ type: 'mission-completed', payload }),
  );

  return {
    system,
    campaign,
    events,
    tick(seconds = MISSION_EVALUATION_INTERVAL_S) {
      // One step past the requested time. Accumulating `1/60` twelve times
      // lands a hair under 0.2 in binary floating point, and a harness whose
      // job is "advance far enough that a scan definitely ran" must not depend
      // on which side of the boundary the rounding falls.
      const steps = Math.ceil(seconds / DT) + 1;
      for (let i = 0; i < steps; i += 1) system.fixedUpdate(DT);
    },
  };
}

function ids(events: RecordedEvent[], type: RecordedEvent['type']): string[] {
  return events
    .filter((event) => event.type === type)
    .map((event) =>
      'objectiveId' in event.payload ? String(event.payload.objectiveId) : '',
    );
}

// ---------------------------------------------------------------------------
// Fixture integrity
// ---------------------------------------------------------------------------

describe('mission fixtures', () => {
  it('the prologue fixture is a valid objective graph', () => {
    const result = validateMissionGraph(prologueMission());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('rejects a mission whose graph cannot be finished', () => {
    const broken = prologueMission();
    // Every primary now points at something, so nothing ends the chain.
    broken.objectives[2].next = CLINIC;

    expect(() => new MissionSystem({ missions: [broken], state: createMemoryCampaignState() }))
      .toThrow(/invalid objective graph/);
  });
});

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

describe('MissionSystem activation', () => {
  it('activates the entry objective as soon as the mission starts', () => {
    const { system, events } = harness();
    system.startMission(MISSION_ID);

    expect(system.activeObjectiveId).toBe(CLINIC);
    expect(system.statusOf(CLINIC)).toBe('active');
    expect(ids(events, 'activated')).toEqual([CLINIC]);
  });

  it('holds an objective pending until its condition becomes true', () => {
    const { system, campaign, tick } = harness();
    system.startMission(MISSION_ID);

    campaign.setFlag('clinic_power_stabilized', true);
    campaign.setFlag('ivo_briefed_mara', true);
    tick();

    // The bridge needs the conversation *and* an open gate. Only one is true.
    expect(system.statusOf(BRIDGE)).toBe('inactive');
    expect(system.pendingObjectiveIds).toContain(BRIDGE);
    expect(system.activeObjectiveId).toBeNull();

    campaign.setFlag('depot_gate_open', true);
    tick();

    expect(system.activeObjectiveId).toBe(BRIDGE);
    expect(system.statusOf(BRIDGE)).toBe('active');
  });

  it('publishes markers for the active objective and only when they change', () => {
    const { system, campaign, events, tick } = harness();
    system.startMission(MISSION_ID);

    const first = events.filter((event) => event.type === 'markers');
    expect(first).toHaveLength(1);
    expect(first[0].payload.markers.map((marker) => marker.label)).toEqual([
      'Transfer switch',
    ]);
    expect(first[0].payload.markers[0].objectiveId).toBe(CLINIC);

    // A scan that changes nothing must not churn the HUD.
    tick();
    tick();
    expect(events.filter((event) => event.type === 'markers')).toHaveLength(1);

    campaign.setFlag('clinic_power_stabilized', true);
    tick();

    const labels = events
      .filter((event) => event.type === 'markers')
      .at(-1)!
      .payload.markers.map((marker) => marker.label);
    expect(labels).toEqual(['Clinic bay', 'Supply crate']);
  });

  it('refuses to start a mission whose unlock gate has not passed', () => {
    const locked = prologueMission();
    locked.unlockedBy = { kind: 'flagSet', flag: 'prologue_available' };
    const { system, campaign } = harness([locked]);

    expect(system.isUnlocked(MISSION_ID)).toBe(false);
    expect(() => system.startMission(MISSION_ID)).toThrow(/not unlocked/);

    campaign.setFlag('prologue_available', true);
    expect(system.isUnlocked(MISSION_ID)).toBe(true);
    expect(() => system.startMission(MISSION_ID)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

describe('MissionSystem condition evaluation', () => {
  /** Drives one activation condition and reports whether it let the objective in. */
  function activates(
    activation: NarrativeCondition,
    prepare: (campaign: MemoryCampaignState) => void = () => {},
  ): boolean {
    const campaign = createMemoryCampaignState();
    prepare(campaign);
    const system = new MissionSystem({
      missions: [gatedMission(activation)],
      state: campaign,
    });
    system.startMission('gate_probe');
    return system.activeObjectiveId === 'probe';
  }

  it('handles nested and / or / not', () => {
    const nested: NarrativeCondition = {
      kind: 'and',
      all: [
        {
          kind: 'or',
          any: [
            { kind: 'flagSet', flag: 'pump12_restarted' },
            { kind: 'evidenceCollected', evidenceId: 'manual_valve_log' },
          ],
        },
        { kind: 'not', condition: { kind: 'flagSet', flag: 'flooded_tunnel_drained' } },
      ],
    };

    expect(activates(nested)).toBe(false);

    // Left branch of the or.
    expect(activates(nested, (c) => c.setFlag('pump12_restarted', true))).toBe(true);
    // Right branch of the or.
    expect(activates(nested, (c) => c.grantEvidence('manual_valve_log'))).toBe(true);
    // The not still vetoes it.
    expect(
      activates(nested, (c) => {
        c.setFlag('pump12_restarted', true);
        c.setFlag('flooded_tunnel_drained', true);
      }),
    ).toBe(false);
  });

  it('treats a flag explicitly set to false as unset', () => {
    // Saves initialise known flags to false rather than omitting them, so
    // "present in the record" must not count as set.
    expect(
      activates({ kind: 'flagSet', flag: 'gates_stable' }, (c) => c.setFlag('gates_stable', false)),
    ).toBe(false);
    expect(
      activates({ kind: 'flagUnset', flag: 'gates_stable' }, (c) =>
        c.setFlag('gates_stable', false),
      ),
    ).toBe(true);
  });

  it('reads trust and flag equality through the port', () => {
    expect(
      activates({ kind: 'trustAtLeast', character: 'dax', value: 2 }, (c) =>
        c.adjustTrust('dax', 1),
      ),
    ).toBe(false);
    expect(
      activates({ kind: 'trustAtLeast', character: 'dax', value: 2 }, (c) => {
        c.adjustTrust('dax', 1);
        c.adjustTrust('dax', 1);
      }),
    ).toBe(true);
    expect(
      activates({ kind: 'flagEquals', flag: 'ending_choice', value: 'restore_first' }, (c) =>
        c.setFlag('ending_choice', 'restore_first'),
      ),
    ).toBe(true);
  });

  it('sees objectives this system completed itself', () => {
    // `BRIEF` gates on `objectiveComplete(CLINIC)`, and nothing outside the
    // mission system ever told the port that CLINIC finished.
    const port: CampaignStatePort = {
      narrativeState: () => ({
        flags: { clinic_power_stabilized: true },
        evidence: new Set<string>(),
        completedObjectives: new Set<string>(),
        seenScenes: new Set<string>(),
        trust: {},
      }),
      setFlag: () => {},
      grantEvidence: () => {},
      adjustTrust: () => {},
    };

    const system = new MissionSystem({ missions: [prologueMission()], state: port });
    system.startMission(MISSION_ID);
    system.evaluateNow();

    expect(system.statusOf(CLINIC)).toBe('complete');
    expect(system.activeObjectiveId).toBe(BRIEF);
  });
});

// ---------------------------------------------------------------------------
// Completion and the chain
// ---------------------------------------------------------------------------

describe('MissionSystem chain', () => {
  it('advances to the next objective when the current one completes', () => {
    const { system, campaign, events, tick } = harness();
    system.startMission(MISSION_ID);

    campaign.setFlag('clinic_power_stabilized', true);
    tick();

    expect(system.statusOf(CLINIC)).toBe('complete');
    expect(system.activeObjectiveId).toBe(BRIEF);
    expect(ids(events, 'completed')).toEqual([CLINIC]);
    // BATTERY branches from BRIEF and its activation is unconditional, so it
    // comes in on the same evaluation. The spine objective is still the one the
    // HUD points at.
    expect(ids(events, 'activated')).toEqual([CLINIC, BRIEF, BATTERY]);
  });

  it('applies onComplete effects through the port', () => {
    const { system, campaign, tick } = harness();
    system.startMission(MISSION_ID);

    campaign.setFlag('clinic_power_stabilized', true);
    tick();
    campaign.setFlag('ivo_briefed_mara', true);
    tick();

    expect(campaign.flags.gate_procedure_learned).toBe(true);
    expect(campaign.completedObjectives.has(BRIEF)).toBe(true);
  });

  it('offers side objectives at their branch point, not before', () => {
    const { system, campaign, tick } = harness();
    system.startMission(MISSION_ID);

    expect(system.pendingObjectiveIds).not.toContain(BATTERY);
    expect(system.activeOptionalObjectiveIds).toEqual([]);

    campaign.setFlag('clinic_power_stabilized', true);
    tick();

    // BATTERY branches from BRIEF and activates unconditionally once reachable.
    expect(system.activeOptionalObjectiveIds).toEqual([BATTERY]);
    expect(system.activeObjectiveIds).toEqual([BRIEF, BATTERY]);
  });

  it('completes the mission with an optional objective still outstanding', () => {
    const { system, campaign, events, tick } = harness();
    system.startMission(MISSION_ID);

    campaign.setFlag('clinic_power_stabilized', true);
    tick();
    campaign.setFlag('ivo_briefed_mara', true);
    campaign.setFlag('depot_gate_open', true);
    tick();
    campaign.setFlag('crossed_service_bridge', true);
    tick();

    expect(system.statusOf(BATTERY)).toBe('active');
    expect(system.missionComplete).toBe(true);
    expect(system.activeObjectiveId).toBeNull();
    expect(events.filter((event) => event.type === 'mission-completed')).toHaveLength(1);
  });

  it('advances one objective per pass but chains them in a single evaluation', () => {
    // Both spine flags are already true when the mission starts, so the whole
    // prologue spine should resolve without waiting for three separate scans.
    const campaign = createMemoryCampaignState({
      flags: {
        clinic_power_stabilized: true,
        ivo_briefed_mara: true,
        depot_gate_open: true,
        crossed_service_bridge: true,
      },
    });
    const { system, events } = harness([prologueMission()], campaign);
    system.startMission(MISSION_ID);

    expect(system.missionComplete).toBe(true);
    expect(ids(events, 'completed')).toEqual([CLINIC, BRIEF, BRIDGE]);
  });
});

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

describe('MissionSystem failure', () => {
  it('stalls the mission when a primary objective fails', () => {
    const { system, campaign, events, tick } = harness();
    system.startMission(MISSION_ID);

    expect(system.failObjective(CLINIC, 'transfer switch burned out')).toBe(true);

    expect(system.statusOf(CLINIC)).toBe('failed');
    expect(system.activeObjectiveId).toBeNull();
    expect(system.stalled).toBe(true);

    const failure = events.find((event) => event.type === 'failed');
    expect(failure?.payload).toMatchObject({
      objectiveId: CLINIC,
      kind: 'primary',
      reason: 'transfer switch burned out',
    });

    // A failed objective does not quietly resume when its condition becomes
    // true later.
    campaign.setFlag('clinic_power_stabilized', true);
    tick();
    expect(system.statusOf(CLINIC)).toBe('failed');
    expect(system.activeObjectiveId).toBeNull();
  });

  it('lets the spine finish when an optional objective fails', () => {
    const { system, campaign, tick } = harness();
    system.startMission(MISSION_ID);

    campaign.setFlag('clinic_power_stabilized', true);
    tick();
    expect(system.failObjective(BATTERY, 'crate was under water')).toBe(true);
    expect(system.stalled).toBe(false);

    campaign.setFlag('ivo_briefed_mara', true);
    campaign.setFlag('depot_gate_open', true);
    tick();
    campaign.setFlag('crossed_service_bridge', true);
    tick();

    expect(system.statusOf(BATTERY)).toBe('failed');
    expect(system.missionComplete).toBe(true);
  });

  it('refuses to fail an objective the player never reached', () => {
    const { system } = harness();
    system.startMission(MISSION_ID);

    expect(system.failObjective(BRIDGE)).toBe(false);
    expect(system.statusOf(BRIDGE)).toBe('inactive');
  });
});

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

describe('MissionSystem checkpoints', () => {
  it('requests checkpoints according to the objective behaviour', () => {
    const mission = prologueMission();
    const { system, campaign, events, tick } = harness([mission]);
    system.startMission(MISSION_ID);

    const clinic = mission.objectives[0];
    const bridge = mission.objectives[2];

    // CLINIC is on-activate.
    expect(events.filter((event) => event.type === 'checkpoint')).toHaveLength(1);
    expect(events.find((event) => event.type === 'checkpoint')!.payload).toMatchObject({
      objectiveId: CLINIC,
      trigger: 'on-activate',
      checkpointId: missionCheckpointId(MISSION_ID, clinic),
    });

    campaign.setFlag('clinic_power_stabilized', true);
    tick();
    // BRIEF is `none` — completing CLINIC and activating BRIEF adds nothing.
    expect(events.filter((event) => event.type === 'checkpoint')).toHaveLength(1);

    campaign.setFlag('ivo_briefed_mara', true);
    campaign.setFlag('depot_gate_open', true);
    tick();
    campaign.setFlag('crossed_service_bridge', true);
    tick();

    // BRIDGE is `both`.
    const triggers = events
      .filter((event) => event.type === 'checkpoint')
      .map((event) => `${event.payload.objectiveId}:${event.payload.trigger}`);
    expect(triggers).toEqual([
      `${CLINIC}:on-activate`,
      `${BRIDGE}:on-activate`,
      `${BRIDGE}:on-complete`,
    ]);
    expect(missionCheckpointId(MISSION_ID, bridge)).toBe(`${MISSION_ID}:prologue.bridge`);
  });
});

// ---------------------------------------------------------------------------
// Throttling
// ---------------------------------------------------------------------------

describe('MissionSystem evaluation throttling', () => {
  it('does not react within a single frame but reaches the right state', () => {
    const { system, campaign } = harness();
    system.startMission(MISSION_ID);

    campaign.setFlag('clinic_power_stabilized', true);
    system.fixedUpdate(DT);

    // One frame in, the scan has not run yet.
    expect(system.statusOf(CLINIC)).toBe('active');

    // Drive past the interval and the same state is reached.
    const steps = Math.ceil(MISSION_EVALUATION_INTERVAL_S / DT);
    for (let i = 0; i < steps; i += 1) system.fixedUpdate(DT);

    expect(system.statusOf(CLINIC)).toBe('complete');
    expect(system.activeObjectiveId).toBe(BRIEF);
  });

  it('evaluates immediately when a caller says the world changed', () => {
    const { system, campaign } = harness();
    system.startMission(MISSION_ID);

    campaign.setFlag('clinic_power_stabilized', true);
    system.evaluateNow();

    expect(system.statusOf(CLINIC)).toBe('complete');
    expect(system.activeObjectiveId).toBe(BRIEF);
  });

  it('accumulates hint time on the active objective only', () => {
    const { system, campaign, tick } = harness();
    system.startMission(MISSION_ID);

    campaign.setFlag('clinic_power_stabilized', true);
    campaign.setFlag('ivo_briefed_mara', true);
    campaign.setFlag('depot_gate_open', true);
    tick();

    expect(system.activeObjectiveId).toBe(BRIDGE);
    expect(system.activeHint).toBeNull();

    tick(46);
    expect(system.activeHint).toBe('The bridge stair is behind the ticket hall.');

    tick(46);
    expect(system.activeHint).toBe('Ivo said the west stair is dry. Try the west stair.');
  });
});

// ---------------------------------------------------------------------------
// Effects driving the chain
// ---------------------------------------------------------------------------

describe('MissionSystem advanceObjective', () => {
  it('completes the active objective and moves the chain on', () => {
    const { system, events } = harness();
    system.startMission(MISSION_ID);

    system.advanceObjective(CLINIC);

    expect(system.statusOf(CLINIC)).toBe('complete');
    expect(system.activeObjectiveId).toBe(BRIEF);
    expect(ids(events, 'completed')).toEqual([CLINIC]);
  });

  it('ignores an objective the player has not reached', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { system } = harness();
    system.startMission(MISSION_ID);

    system.advanceObjective(BRIDGE);

    expect(system.statusOf(BRIDGE)).toBe('inactive');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('is idempotent on an already-completed objective', () => {
    const { system, events } = harness();
    system.startMission(MISSION_ID);

    system.advanceObjective(CLINIC);
    system.advanceObjective(CLINIC);

    expect(ids(events, 'completed')).toEqual([CLINIC]);
  });
});

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

describe('MissionSystem jumpToObjective', () => {
  it('puts the campaign at an objective with the preceding flags set', () => {
    const { system, campaign, events } = harness();

    system.jumpToObjective(BRIDGE);

    expect(system.activeObjectiveId).toBe(BRIDGE);
    expect(system.statusOf(CLINIC)).toBe('complete');
    expect(system.statusOf(BRIEF)).toBe('complete');
    // The flag Act I would read was set by replaying BRIEF's onComplete.
    expect(campaign.flags.gate_procedure_learned).toBe(true);
    expect(campaign.completedObjectives.has(CLINIC)).toBe(true);
    // Side content attached to a passed point is on offer, not auto-granted.
    expect(system.pendingObjectiveIds).toContain(BATTERY);
    expect(events.filter((event) => event.type === 'markers').at(-1)!.payload.markers
      .map((marker) => marker.label)).toEqual(['Service bridge']);
  });

  it('never writes a checkpoint', () => {
    // A smoke test or a developer jump must not touch the player's saves.
    const { system, events } = harness();
    system.jumpToObjective(BRIDGE);
    expect(events.filter((event) => event.type === 'checkpoint')).toEqual([]);
  });

  it('bypasses the activation condition it jumps to', () => {
    const { system, campaign } = harness();
    system.jumpToObjective(BRIDGE);

    // `depot_gate_open` was never set; the jump activated BRIDGE anyway.
    expect(campaign.flags.depot_gate_open).toBeUndefined();
    expect(system.statusOf(BRIDGE)).toBe('active');
  });

  it('can skip effect replay for gating tests', () => {
    const { system, campaign } = harness();
    system.jumpToObjective(BRIDGE, { applyEffects: false });

    expect(system.statusOf(BRIEF)).toBe('complete');
    expect(campaign.flags.gate_procedure_learned).toBeUndefined();
  });

  it('resolves objectives by their authored test hook', () => {
    const { system } = harness();
    expect(system.findByTestHook('prologue.bridge')?.id).toBe(BRIDGE);
    expect(system.findByTestHook('prologue.nothing')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('MissionSystem persistence', () => {
  it('serialises a shape the save schema accepts', () => {
    const { system, campaign, tick } = harness();
    system.startMission(MISSION_ID);
    campaign.setFlag('clinic_power_stabilized', true);
    tick();

    const save = { ...createNewSave(), missions: system.serialise() };
    const parsed = saveSchema.safeParse(save);
    expect(parsed.success).toBe(true);
    expect(system.serialise()).toEqual({
      activeMissionId: MISSION_ID,
      activeObjectiveId: BRIEF,
      objectives: {
        [CLINIC]: 'complete',
        [BRIEF]: 'active',
        [BATTERY]: 'active',
      },
    });
  });

  it('round-trips mid-mission state through a fresh system', () => {
    const first = harness();
    first.system.startMission(MISSION_ID);
    first.campaign.setFlag('clinic_power_stabilized', true);
    first.tick();
    first.campaign.setFlag('battery_count_logged', true);
    first.tick();

    const stored = first.system.serialise();

    // A different system instance, as after a reload.
    const second = harness([prologueMission()], first.campaign);
    second.system.restore(stored);

    expect(second.system.serialise()).toEqual(stored);
    expect(second.system.activeMissionId).toBe(MISSION_ID);
    expect(second.system.activeObjectiveId).toBe(BRIEF);
    expect(second.system.statusOf(CLINIC)).toBe('complete');
    expect(second.system.statusOf(BATTERY)).toBe('complete');
    expect(second.system.activeMarkers.map((marker) => marker.label)).toEqual(['Clinic bay']);
    expect(second.system.missionComplete).toBe(false);

    // And it keeps playing from there.
    second.campaign.setFlag('ivo_briefed_mara', true);
    second.campaign.setFlag('depot_gate_open', true);
    second.tick();
    second.campaign.setFlag('crossed_service_bridge', true);
    second.tick();
    expect(second.system.missionComplete).toBe(true);
  });

  it('round-trips a completed mission', () => {
    const first = harness();
    first.system.startMission(MISSION_ID);
    first.campaign.setFlag('clinic_power_stabilized', true);
    first.campaign.setFlag('ivo_briefed_mara', true);
    first.campaign.setFlag('depot_gate_open', true);
    first.campaign.setFlag('crossed_service_bridge', true);
    first.tick();

    const stored = first.system.serialise();
    const second = harness([prologueMission()], first.campaign);
    second.system.restore(stored);

    expect(second.system.serialise()).toEqual(stored);
    expect(second.system.missionComplete).toBe(true);
    expect(second.system.activeObjectiveId).toBeNull();
  });

  it('round-trips a failed primary objective as still failed', () => {
    const first = harness();
    first.system.startMission(MISSION_ID);
    first.system.failObjective(CLINIC, 'transfer switch burned out');

    const stored = first.system.serialise();
    expect(stored.objectives[CLINIC]).toBe('failed');

    const second = harness([prologueMission()], first.campaign);
    second.system.restore(stored);

    expect(second.system.serialise()).toEqual(stored);
    expect(second.system.statusOf(CLINIC)).toBe('failed');
    expect(second.system.stalled).toBe(true);
  });

  it('starts a New Game save at the entry objective', () => {
    const mission = prologueMission();
    mission.id = createNewSave().missions.activeMissionId as string;
    const { system, events } = harness([mission]);

    system.restore(createNewSave().missions);
    system.evaluateNow();

    expect(system.activeObjectiveId).toBe(CLINIC);
    expect(ids(events, 'activated')).toEqual([CLINIC]);
  });

  it('drops statuses for objectives that no longer exist', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { system } = harness();

    system.restore({
      activeMissionId: MISSION_ID,
      activeObjectiveId: CLINIC,
      objectives: { [CLINIC]: 'active', pro_objective_cut_in_review: 'complete' },
    });

    expect(system.serialise().objectives).toEqual({ [CLINIC]: 'active' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('pro_objective_cut_in_review'),
    );
    warn.mockRestore();
  });

  it('falls back to the active primary when the stored pointer is stale', () => {
    const { system } = harness();

    system.restore({
      activeMissionId: MISSION_ID,
      // Points at an objective that is recorded as finished.
      activeObjectiveId: CLINIC,
      objectives: { [CLINIC]: 'complete', [BRIEF]: 'active' },
    });

    expect(system.activeObjectiveId).toBe(BRIEF);
  });

  it('clears itself for a save with no active mission', () => {
    const { system, events } = harness();
    system.startMission(MISSION_ID);
    events.length = 0;

    system.restore({ activeMissionId: null, activeObjectiveId: null, objectives: {} });

    expect(system.activeMissionId).toBeNull();
    expect(system.activeObjectiveId).toBeNull();
    expect(system.activeMarkers).toEqual([]);
    expect(events.filter((event) => event.type === 'active-changed')).toHaveLength(1);
  });
});
