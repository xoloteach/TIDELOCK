/**
 * Mission runtime.
 *
 * Owns objective status for the active mission: which objective the HUD points
 * at, which side objectives are available, what has been completed or failed,
 * and where the markers are. It evaluates the authored activation and
 * completion conditions from `missionSchema` against a campaign-state port and
 * advances the chain — it does not contain the chain. Adding an objective is a
 * content change.
 *
 * Two properties matter more than anything else here:
 *
 *   1. It survives save/reload. `serialise()` produces exactly the shape
 *      `saveSchema.missions` accepts and `restore()` consumes it, so a
 *      checkpoint taken at Act II boots with the right objective active and the
 *      right markers on screen.
 *   2. It reads the world through a port. No `SaveStore` import, no ECS query,
 *      no DOM. That is what lets a story smoke test drive a whole act in
 *      milliseconds.
 *
 * The shared effect ports live in `../dialogue/DialogueSystem` for the same
 * reason `missionSchema` imports the condition AST from `dialogueSchema`: one
 * implementation of "what does `setFlag` mean", not two.
 */

import type { System } from '../../engine/ecs/GameWorld';
import { Emitter } from '../../engine/events';
import type { MissionState, ObjectiveStatus } from '../../persistence/saveSchema';
import {
  applyNarrativeEffect,
  type CampaignStatePort,
  type CinematicUnlockPort,
  type ObjectivePort,
} from '../dialogue/DialogueSystem';
import type { NarrativeState, ObjectiveId } from '../dialogue/dialogueSchema';
import {
  canActivateObjective,
  isMissionUnlocked,
  isObjectiveComplete,
  sideObjectivesOf,
  validateMissionGraph,
  writesCheckpointOnActivate,
  writesCheckpointOnComplete,
  type Mission,
  type MissionId,
  type Objective,
  type ObjectiveKind,
  type ObjectiveMarker,
} from './missionSchema';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Seconds between condition scans.
 *
 * Cost decision: a scan composes a `NarrativeState` snapshot — a flag record
 * copy plus four Sets — and then walks the activation or completion AST of
 * every active and pending objective. The AST walk is trivial; the snapshot is
 * not, because it allocates every time and campaign flags grow across the
 * campaign. At 60 Hz that is 60 snapshots a second to notice a pump restarting,
 * which no player can perceive happening faster than a couple of hundred
 * milliseconds. At 5 Hz the worst-case latency is 200 ms and the work drops by
 * ~92%.
 *
 * Latency is not the failure mode it looks like, because the systems that
 * *cause* a condition to become true — interaction, dialogue effects, machine
 * state — call `evaluateNow()`. The interval only covers conditions nothing
 * announced, such as an objective completed by walking into a marker radius.
 *
 * Snapshots are built once per pass and shared by every condition in that pass,
 * so adding objectives to a mission costs AST walks, not snapshots.
 */
export const MISSION_EVALUATION_INTERVAL_S = 0.2;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** A marker the HUD may draw, tagged with the objective that owns it. */
export interface ActiveObjectiveMarker extends ObjectiveMarker {
  readonly objectiveId: ObjectiveId;
  readonly kind: ObjectiveKind;
}

/** Why a checkpoint was requested. The save layer decides whether to honour it. */
export type CheckpointTrigger = 'on-activate' | 'on-complete';

export type MissionEvents = {
  'mission-started': { missionId: MissionId; entryObjectiveId: ObjectiveId };
  'mission-completed': { missionId: MissionId; finalObjectiveId: ObjectiveId };
  'objective-activated': {
    missionId: MissionId;
    objectiveId: ObjectiveId;
    kind: ObjectiveKind;
    title: string;
  };
  'objective-completed': {
    missionId: MissionId;
    objectiveId: ObjectiveId;
    kind: ObjectiveKind;
  };
  'objective-failed': {
    missionId: MissionId;
    objectiveId: ObjectiveId;
    kind: ObjectiveKind;
    /** Authored or systemic reason, for the journal and for bug reports. */
    reason: string;
  };
  /** The objective the HUD points at. Null between objectives and after a fail. */
  'active-objective-changed': {
    missionId: MissionId | null;
    objectiveId: ObjectiveId | null;
    previousObjectiveId: ObjectiveId | null;
  };
  'markers-changed': { markers: readonly ActiveObjectiveMarker[] };
  'checkpoint-requested': {
    missionId: MissionId;
    objectiveId: ObjectiveId;
    trigger: CheckpointTrigger;
    /** Stable id derived from the objective's test hook. */
    checkpointId: string;
  };
};

/**
 * Checkpoint id for an objective boundary.
 *
 * Built from the objective's `testHook` rather than its id: the hook is already
 * required to be unique within a mission and is explicitly the stable handle
 * that automated tests and saves refer to, so renaming an internal objective id
 * does not orphan a player's checkpoint.
 */
export function missionCheckpointId(missionId: MissionId, objective: Objective): string {
  return `${missionId}:${objective.testHook}`;
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export interface MissionSystemOptions {
  /** Authored missions, already parsed. */
  missions: readonly Mission[];
  state: CampaignStatePort;
  cinematics?: CinematicUnlockPort | null;
  /** Defaults to `MISSION_EVALUATION_INTERVAL_S`. */
  evaluationInterval?: number;
  /**
   * Lint every mission graph at construction. On by default: an unreachable
   * objective or a chain that loops is a chunk of campaign the player cannot
   * finish, and it must fail at boot rather than an hour in.
   */
  validate?: boolean;
}

export interface JumpOptions {
  /**
   * Replay the `onComplete` effects of the objectives being skipped.
   *
   * On by default so a jump lands in a state a real playthrough could produce —
   * the flags Act II reads were set by Act I's objectives completing. Turn it
   * off to test activation gating in isolation.
   */
  applyEffects?: boolean;
}

export class MissionSystem implements System, ObjectivePort {
  readonly name = 'missions';

  private readonly emitter = new Emitter<MissionEvents>();
  private readonly missions = new Map<MissionId, Mission>();
  /** Objective lookup across every registered mission. */
  private readonly objectivesById = new Map<ObjectiveId, { mission: Mission; objective: Objective }>();
  private readonly campaign: CampaignStatePort;
  private readonly cinematics: CinematicUnlockPort | null;
  private readonly evaluationInterval: number;

  private mission: Mission | null = null;
  private readonly statuses = new Map<ObjectiveId, ObjectiveStatus>();
  /** Currently active, primary and optional alike. */
  private readonly activeIds = new Set<ObjectiveId>();
  /** Reached but still waiting for their activation condition. */
  private readonly pendingIds = new Set<ObjectiveId>();
  private primaryId: ObjectiveId | null = null;

  private markers: readonly ActiveObjectiveMarker[] = [];
  private markerKey = '';

  private sinceScan = 0;
  /** Seconds on the active primary objective, for escalating hints. */
  private objectiveSeconds = 0;
  private complete = false;

  constructor(options: MissionSystemOptions) {
    this.campaign = options.state;
    this.cinematics = options.cinematics ?? null;
    this.evaluationInterval = options.evaluationInterval ?? MISSION_EVALUATION_INTERVAL_S;

    for (const mission of options.missions) {
      if (this.missions.has(mission.id)) {
        throw new Error(`Duplicate mission id "${mission.id}"`);
      }

      if (options.validate !== false) {
        const result = validateMissionGraph(mission);
        if (!result.ok) {
          const detail = result.errors.map((issue) => issue.message).join('; ');
          throw new Error(`mission "${mission.id}" has an invalid objective graph: ${detail}`);
        }
      }

      this.missions.set(mission.id, mission);
      for (const objective of mission.objectives) {
        if (this.objectivesById.has(objective.id)) {
          // Objective ids are the keys in `saveSchema.missions.objectives`, so
          // two missions sharing one would make a save ambiguous.
          throw new Error(
            `Objective id "${objective.id}" is used by more than one mission`,
          );
        }
        this.objectivesById.set(objective.id, { mission, objective });
      }
    }
  }

  on = this.emitter.on.bind(this.emitter);
  off = this.emitter.off.bind(this.emitter);

  // ---- Public state -----------------------------------------------------

  get activeMissionId(): MissionId | null {
    return this.mission?.id ?? null;
  }

  get activeMission(): Mission | null {
    return this.mission;
  }

  /** The primary objective the HUD points at. Null between objectives. */
  get activeObjectiveId(): ObjectiveId | null {
    return this.primaryId;
  }

  get activeObjective(): Objective | null {
    return this.primaryId ? this.objectiveOf(this.primaryId) : null;
  }

  /** Every active objective id, primary first, then optional in authored order. */
  get activeObjectiveIds(): readonly ObjectiveId[] {
    if (!this.mission) return [];
    return this.mission.objectives
      .filter((objective) => this.activeIds.has(objective.id))
      .sort((a, b) => rankKind(a.kind) - rankKind(b.kind))
      .map((objective) => objective.id);
  }

  /** Optional objectives currently available. */
  get activeOptionalObjectiveIds(): readonly ObjectiveId[] {
    return this.activeObjectiveIds.filter(
      (id) => this.objectiveOf(id)?.kind === 'optional',
    );
  }

  /** Objectives reached but whose activation condition has not passed yet. */
  get pendingObjectiveIds(): readonly ObjectiveId[] {
    return [...this.pendingIds];
  }

  statusOf(objectiveId: ObjectiveId): ObjectiveStatus {
    return this.statuses.get(objectiveId) ?? 'inactive';
  }

  get activeMarkers(): readonly ActiveObjectiveMarker[] {
    return this.markers;
  }

  /** True once a primary objective with `next: null` completed. */
  get missionComplete(): boolean {
    return this.complete;
  }

  /**
   * True when the spine has nowhere to go: the primary objective failed and
   * nothing is active or pending. The mission cannot finish without a reload.
   */
  get stalled(): boolean {
    if (!this.mission || this.complete) return false;
    if (this.primaryId !== null) return false;
    for (const id of this.activeIds) {
      if (this.objectiveOf(id)?.kind === 'primary') return false;
    }
    for (const id of this.pendingIds) {
      if (this.objectiveOf(id)?.kind === 'primary') return false;
    }
    return true;
  }

  get secondsOnActiveObjective(): number {
    return this.objectiveSeconds;
  }

  /**
   * The strongest hint earned on the active primary objective, or null.
   *
   * Polled by the HUD rather than pushed as an event: it changes at most a
   * handful of times per objective and the HUD is already redrawing.
   */
  get activeHint(): string | null {
    const objective = this.activeObjective;
    if (!objective?.hints?.length) return null;

    let text: string | null = null;
    for (const hint of objective.hints) {
      if (this.objectiveSeconds >= hint.afterSeconds) text = hint.text;
    }
    return text;
  }

  // ---- Mission lifecycle ------------------------------------------------

  /**
   * Starts a mission at its entry objective.
   *
   * Throws when the mission's `unlockedBy` gate fails: starting a locked
   * mission is a wiring bug, and silently refusing would look like the campaign
   * quietly ending.
   */
  startMission(missionId: MissionId): void {
    const mission = this.missions.get(missionId);
    if (!mission) throw new Error(`Unknown mission "${missionId}"`);
    if (!isMissionUnlocked(mission, this.campaign.narrativeState())) {
      throw new Error(`Mission "${missionId}" is not unlocked yet`);
    }

    this.clear();
    this.mission = mission;
    this.pendingIds.add(mission.entryObjective);

    this.emitter.emit('mission-started', {
      missionId: mission.id,
      entryObjectiveId: mission.entryObjective,
    });

    // Players expect the first objective on screen immediately, not 200 ms
    // after the fade-in.
    this.evaluateNow();
  }

  /** Whether a mission's unlock gate currently passes. */
  isUnlocked(missionId: MissionId): boolean {
    const mission = this.missions.get(missionId);
    if (!mission) return false;
    return isMissionUnlocked(mission, this.campaign.narrativeState());
  }

  // ---- Simulation -------------------------------------------------------

  fixedUpdate(dt: number): void {
    if (!this.mission) return;

    if (this.primaryId !== null) this.objectiveSeconds += dt;

    this.sinceScan += dt;
    if (this.sinceScan < this.evaluationInterval) return;
    this.sinceScan = 0;
    this.evaluate();
  }

  /**
   * Evaluates immediately, bypassing the scan interval.
   *
   * Called by whatever just changed the world — an interaction that restarted a
   * pump, a dialogue effect that granted evidence — so a condition the game
   * already knows became true does not wait for the next scan.
   */
  evaluateNow(): void {
    if (!this.mission) return;
    this.sinceScan = 0;
    this.evaluate();
  }

  /**
   * Runs transitions until the world stops producing them.
   *
   * One transition per pass with the state snapshot rebuilt each pass, so a
   * chain of objectives whose activation is `always` advances in a single
   * evaluation instead of one per scan — which is what makes a story smoke test
   * finish in milliseconds. Bounded because a transition that re-enables itself
   * would otherwise spin forever; the graph linter forbids cycles, but a
   * hand-built mission in a test should fail loudly rather than hang.
   */
  private evaluate(): void {
    const budget = (this.mission?.objectives.length ?? 0) * 2 + 2;

    for (let pass = 0; pass < budget; pass += 1) {
      if (!this.evaluatePass()) return;
    }

    console.warn(
      `[missions] mission "${this.mission?.id}" exceeded its transition budget in one evaluation`,
    );
  }

  /** One transition, if any is available. Returns whether something changed. */
  private evaluatePass(): boolean {
    const mission = this.mission;
    if (!mission) return false;

    const state = this.composeState();

    // Completions first: finishing an objective is what makes the next one
    // reachable, and doing it in the same pass would use a stale snapshot.
    for (const id of this.activeObjectiveIds) {
      const objective = this.objectiveOf(id);
      if (objective && isObjectiveComplete(objective, state)) {
        this.completeObjective(objective, mission);
        return true;
      }
    }

    for (const id of orderedIds(mission, this.pendingIds)) {
      const objective = this.objectiveOf(id);
      if (objective && canActivateObjective(objective, state)) {
        this.activateObjective(objective, mission);
        return true;
      }
    }

    return false;
  }

  // ---- Transitions ------------------------------------------------------

  private activateObjective(objective: Objective, mission: Mission): void {
    this.pendingIds.delete(objective.id);
    this.activeIds.add(objective.id);
    this.statuses.set(objective.id, 'active');

    if (objective.kind === 'primary') {
      const previous = this.primaryId;
      this.primaryId = objective.id;
      this.objectiveSeconds = 0;
      this.emitActivated(objective, mission);
      this.emitter.emit('active-objective-changed', {
        missionId: mission.id,
        objectiveId: objective.id,
        previousObjectiveId: previous,
      });
    } else {
      this.emitActivated(objective, mission);
    }

    // Side objectives hang off the objective they branch from, so they only
    // become reachable once the player is actually there.
    for (const side of sideObjectivesOf(mission, objective.id)) {
      if (this.statusOf(side.id) === 'inactive') this.pendingIds.add(side.id);
    }

    if (writesCheckpointOnActivate(objective)) {
      this.requestCheckpoint(objective, mission, 'on-activate');
    }

    this.refreshMarkers();
  }

  private emitActivated(objective: Objective, mission: Mission): void {
    this.emitter.emit('objective-activated', {
      missionId: mission.id,
      objectiveId: objective.id,
      kind: objective.kind,
      title: objective.title,
    });
  }

  private completeObjective(objective: Objective, mission: Mission): void {
    this.activeIds.delete(objective.id);
    this.pendingIds.delete(objective.id);
    this.statuses.set(objective.id, 'complete');
    this.campaign.markObjectiveComplete?.(objective.id);

    for (const effect of objective.onComplete ?? []) {
      applyNarrativeEffect(effect, {
        state: this.campaign,
        missions: this,
        cinematics: this.cinematics,
      });
    }

    this.emitter.emit('objective-completed', {
      missionId: mission.id,
      objectiveId: objective.id,
      kind: objective.kind,
    });

    if (writesCheckpointOnComplete(objective)) {
      this.requestCheckpoint(objective, mission, 'on-complete');
    }

    if (objective.kind === 'primary') {
      const previous = this.primaryId;
      this.primaryId = null;
      this.objectiveSeconds = 0;

      if (objective.next === null) {
        this.complete = true;
        this.emitter.emit('active-objective-changed', {
          missionId: mission.id,
          objectiveId: null,
          previousObjectiveId: previous,
        });
        this.emitter.emit('mission-completed', {
          missionId: mission.id,
          finalObjectiveId: objective.id,
        });
      } else {
        if (this.statusOf(objective.next) === 'inactive') this.pendingIds.add(objective.next);
        this.emitter.emit('active-objective-changed', {
          missionId: mission.id,
          objectiveId: null,
          previousObjectiveId: previous,
        });
      }
    }

    this.refreshMarkers();
  }

  /**
   * Marks an objective failed.
   *
   * Called by whatever detected the failure — a rescue timer expiring, a pump
   * burning out. A failed *optional* objective is side content the player lost
   * and the spine is untouched. A failed *primary* objective stalls the mission:
   * the runtime does not invent a recovery path, because the authored graph does
   * not have one, and pretending otherwise would silently drop the player into
   * an unfinishable campaign.
   */
  failObjective(objectiveId: ObjectiveId, reason = 'unspecified'): boolean {
    const mission = this.mission;
    if (!mission) return false;

    const objective = this.objectiveOf(objectiveId);
    if (!objective) return false;

    const status = this.statusOf(objectiveId);
    if (status !== 'active' && status !== 'inactive') return false;
    if (status === 'inactive' && !this.pendingIds.has(objectiveId)) return false;

    this.activeIds.delete(objectiveId);
    this.pendingIds.delete(objectiveId);
    this.statuses.set(objectiveId, 'failed');

    this.emitter.emit('objective-failed', {
      missionId: mission.id,
      objectiveId,
      kind: objective.kind,
      reason,
    });

    if (objective.kind === 'primary' && this.primaryId === objectiveId) {
      this.primaryId = null;
      this.objectiveSeconds = 0;
      this.emitter.emit('active-objective-changed', {
        missionId: mission.id,
        objectiveId: null,
        previousObjectiveId: objectiveId,
      });
    }

    this.refreshMarkers();
    return true;
  }

  /**
   * `ObjectivePort`: completes an objective because a dialogue or objective
   * effect said so.
   *
   * A pending objective is activated first so its `objective-activated` event
   * still fires — the journal should show it happened, not skip from nothing to
   * done.
   */
  advanceObjective(objectiveId: ObjectiveId): void {
    const mission = this.mission;
    if (!mission) return;

    const objective = this.objectiveOf(objectiveId);
    if (!objective || this.objectivesById.get(objectiveId)?.mission.id !== mission.id) {
      console.warn(
        `[missions] advanceObjective("${objectiveId}") is not part of mission "${mission.id}"`,
      );
      return;
    }

    const status = this.statusOf(objectiveId);
    if (status === 'complete') return;
    if (status === 'failed') {
      console.warn(`[missions] advanceObjective("${objectiveId}") on a failed objective`);
      return;
    }

    if (status === 'inactive') {
      if (!this.pendingIds.has(objectiveId)) {
        console.warn(
          `[missions] advanceObjective("${objectiveId}") on an objective the player has not reached`,
        );
        return;
      }
      this.activateObjective(objective, mission);
    }

    this.completeObjective(objective, mission);

    // The completion may have unlocked the next objective outright.
    this.evaluate();
  }

  /**
   * Test hook: puts the campaign at `objectiveId`.
   *
   * Walks the primary spine from the mission entry, marking each objective
   * before the target complete and — by default — replaying its `onComplete`
   * effects, so the flags a later act reads are actually set. The target is then
   * force-activated: its activation condition is *not* evaluated, because a jump
   * exists precisely to reach states the preceding gameplay would have produced.
   *
   * Deliberately silent about checkpoints. A debug jump or a smoke test must
   * never overwrite a player's saves, so no `checkpoint-requested` is emitted
   * for the objectives it passes through or for the target.
   */
  jumpToObjective(objectiveId: ObjectiveId, options: JumpOptions = {}): void {
    const entry = this.objectivesById.get(objectiveId);
    if (!entry) throw new Error(`Unknown objective "${objectiveId}"`);

    const { mission, objective: target } = entry;
    const applyEffects = options.applyEffects !== false;

    this.clear();
    this.mission = mission;

    // Walk the spine, stopping at the target. Bounded by the objective count so
    // a malformed chain cannot hang a test run.
    let cursor: ObjectiveId | null = mission.entryObjective;
    const skipped: Objective[] = [];
    for (let step = 0; step <= mission.objectives.length; step += 1) {
      if (cursor === null || cursor === target.id) break;
      const objective = this.objectiveOf(cursor);
      if (!objective) break;
      skipped.push(objective);
      cursor = objective.next;
    }

    for (const objective of skipped) {
      this.statuses.set(objective.id, 'complete');
      this.campaign.markObjectiveComplete?.(objective.id);
      if (!applyEffects) continue;
      for (const effect of objective.onComplete ?? []) {
        applyNarrativeEffect(effect, {
          state: this.campaign,
          missions: null,
          cinematics: this.cinematics,
        });
      }
    }

    // Side objectives attached to points the jump passed through become
    // *pending*, not active: the player reached that part of the borough, so the
    // side work is on offer, but it still has to pass its own activation
    // condition. Derived with the same code a load uses, so a jump and a
    // checkpoint restored at the same objective produce identical state.
    this.activeIds.add(target.id);
    this.statuses.set(target.id, 'active');
    this.objectiveSeconds = 0;

    const previous = this.primaryId;
    if (target.kind === 'primary') this.primaryId = target.id;

    this.derivePending(mission);

    this.emitActivated(target, mission);
    this.emitter.emit('active-objective-changed', {
      missionId: mission.id,
      objectiveId: this.primaryId,
      previousObjectiveId: previous,
    });

    this.refreshMarkers();
  }

  /** Test hook: the objective wearing this authored test hook id. */
  findByTestHook(testHook: string): Objective | null {
    for (const { objective } of this.objectivesById.values()) {
      if (objective.testHook === testHook) return objective;
    }
    return null;
  }

  private requestCheckpoint(
    objective: Objective,
    mission: Mission,
    trigger: CheckpointTrigger,
  ): void {
    this.emitter.emit('checkpoint-requested', {
      missionId: mission.id,
      objectiveId: objective.id,
      trigger,
      checkpointId: missionCheckpointId(mission.id, objective),
    });
  }

  // ---- Markers ----------------------------------------------------------

  /**
   * Recomputes the marker list and emits only when it actually changed.
   *
   * Compared by a composed key rather than by identity: the HUD rebuilds its
   * marker elements on this event, and emitting an unchanged list every
   * transition would make it churn.
   */
  private refreshMarkers(): void {
    const mission = this.mission;
    const markers: ActiveObjectiveMarker[] = [];

    if (mission) {
      for (const id of this.activeObjectiveIds) {
        const objective = this.objectiveOf(id);
        if (!objective) continue;
        for (const marker of objective.markers) {
          markers.push({ ...marker, objectiveId: objective.id, kind: objective.kind });
        }
      }
    }

    const key = markers
      .map((m) => `${m.objectiveId}|${m.label}|${m.position.x},${m.position.y},${m.position.z}`)
      .join(';');
    if (key === this.markerKey) return;

    this.markerKey = key;
    this.markers = markers;
    this.emitter.emit('markers-changed', { markers });
  }

  // ---- State composition -------------------------------------------------

  /**
   * Campaign state with this system's own objective statuses overlaid.
   *
   * Unioned with the port's view rather than replacing it: the save may already
   * record objectives completed in an earlier mission, and a condition in Act
   * III legitimately reads one from Act I.
   */
  private composeState(): NarrativeState {
    const base = this.campaign.narrativeState();
    const completedObjectives = new Set(base.completedObjectives);
    let added = false;
    for (const [id, status] of this.statuses) {
      if (status !== 'complete' || completedObjectives.has(id)) continue;
      completedObjectives.add(id);
      added = true;
    }
    return added ? { ...base, completedObjectives } : base;
  }

  private objectiveOf(objectiveId: ObjectiveId): Objective | null {
    const entry = this.objectivesById.get(objectiveId);
    if (!entry) return null;
    if (this.mission && entry.mission.id !== this.mission.id) return null;
    return entry.objective;
  }

  private clear(): void {
    this.mission = null;
    this.statuses.clear();
    this.activeIds.clear();
    this.pendingIds.clear();
    this.primaryId = null;
    this.objectiveSeconds = 0;
    this.sinceScan = 0;
    this.complete = false;
  }

  dispose(): void {
    this.clear();
    this.markers = [];
    this.markerKey = '';
    this.emitter.clear();
  }

  // ---- Persistence ------------------------------------------------------

  /**
   * The `missions` slice of a save, exactly as `saveSchema.missions` expects.
   *
   * Only non-`inactive` statuses are written. `inactive` is the default every
   * objective starts at, so storing it would double the size of the map for no
   * information — and it gives the format one canonical form, which is what
   * makes `restore(serialise())` an identity rather than an approximation.
   */
  serialise(): MissionState {
    const objectives: Record<string, ObjectiveStatus> = {};
    if (this.mission) {
      for (const objective of this.mission.objectives) {
        const status = this.statuses.get(objective.id);
        if (status === undefined || status === 'inactive') continue;
        objectives[objective.id] = status;
      }
    }

    return {
      activeMissionId: this.mission?.id ?? null,
      activeObjectiveId: this.primaryId,
      objectives,
    };
  }

  /**
   * Adopts a stored mission slice — at boot, at a checkpoint load, or when a
   * different save is loaded mid-session.
   *
   * Pending objectives are *derived* rather than stored: an objective is
   * pending when the spine reached it and its activation condition has not
   * passed yet, which is a function of the statuses plus the authored graph.
   * Storing it would be a second source of truth able to disagree with the
   * chain after a content change.
   *
   * A fresh save names a mission with no statuses at all, which is exactly the
   * New Game case: the entry objective becomes pending and the next evaluation
   * activates it.
   */
  restore(state: MissionState): void {
    const previous = this.primaryId;
    this.clear();

    if (state.activeMissionId === null) {
      this.refreshMarkers();
      this.emitter.emit('active-objective-changed', {
        missionId: null,
        objectiveId: null,
        previousObjectiveId: previous,
      });
      return;
    }

    const mission = this.missions.get(state.activeMissionId);
    if (!mission) {
      // Content the save refers to is gone. Loud, and left empty rather than
      // guessing a mission — the save layer decides whether that is fatal.
      console.warn(
        `[missions] stored save names unknown mission "${state.activeMissionId}"`,
      );
      this.refreshMarkers();
      this.emitter.emit('active-objective-changed', {
        missionId: null,
        objectiveId: null,
        previousObjectiveId: previous,
      });
      return;
    }

    this.mission = mission;

    const known = new Set(mission.objectives.map((objective) => objective.id));
    for (const [id, status] of Object.entries(state.objectives)) {
      if (!known.has(id)) {
        // Objectives removed since the save was written are dropped rather than
        // carried forward forever.
        console.warn(`[missions] dropping status for unknown objective "${id}"`);
        continue;
      }
      if (status === 'inactive') continue;
      this.statuses.set(id, status);
      if (status === 'active') this.activeIds.add(id);
    }

    this.derivePending(mission);

    // Trust the stored active objective only if it is genuinely active; a
    // corrupted or stale pointer falls back to the active primary rather than
    // pointing the HUD at an objective the player already finished.
    const stored = state.activeObjectiveId;
    if (stored !== null && this.statuses.get(stored) === 'active') {
      this.primaryId = stored;
    } else {
      this.primaryId =
        mission.objectives.find(
          (objective) => objective.kind === 'primary' && this.activeIds.has(objective.id),
        )?.id ?? null;
    }

    this.complete = mission.objectives.some(
      (objective) =>
        objective.kind === 'primary' &&
        objective.next === null &&
        this.statuses.get(objective.id) === 'complete',
    );

    // The HUD has to redraw after a load, so the change is announced even when
    // the objective id happens to match what was on screen before.
    this.refreshMarkers();
    this.emitter.emit('active-objective-changed', {
      missionId: mission.id,
      objectiveId: this.primaryId,
      previousObjectiveId: previous,
    });
  }

  /** Objectives the spine has reached that are still waiting to activate. */
  private derivePending(mission: Mission): void {
    const nothingTouched = this.statuses.size === 0;
    if (nothingTouched) {
      this.pendingIds.add(mission.entryObjective);
      return;
    }

    if (this.statusOf(mission.entryObjective) === 'inactive') {
      this.pendingIds.add(mission.entryObjective);
    }

    for (const objective of mission.objectives) {
      const status = this.statusOf(objective.id);

      // The next link after a completed primary.
      if (
        objective.kind === 'primary' &&
        status === 'complete' &&
        objective.next !== null &&
        this.statusOf(objective.next) === 'inactive'
      ) {
        this.pendingIds.add(objective.next);
      }

      // Side branches off anything the player has reached.
      if (status === 'active' || status === 'complete') {
        for (const side of sideObjectivesOf(mission, objective.id)) {
          if (this.statusOf(side.id) === 'inactive') this.pendingIds.add(side.id);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Primary before optional, so the HUD's first marker is the one that matters. */
function rankKind(kind: ObjectiveKind): number {
  return kind === 'primary' ? 0 : 1;
}

/** Ids from a set in authored mission order, so evaluation is deterministic. */
function orderedIds(mission: Mission, ids: ReadonlySet<ObjectiveId>): ObjectiveId[] {
  return mission.objectives
    .filter((objective) => ids.has(objective.id))
    .map((objective) => objective.id);
}
