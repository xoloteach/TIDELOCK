/**
 * Mission and objective data model (spec §39).
 *
 * A mission is a chain of objectives. Each objective declares when it becomes
 * active, when it is complete, where the player should look, whether reaching
 * it writes a checkpoint, and a stable test hook id so story smoke tests can
 * assert "Act II checkpoint boots with a valid objective" without reading
 * private state.
 *
 * Activation and completion are conditions from the shared narrative AST, not
 * callbacks — so a mission is inspectable data, survives save/reload by id
 * alone, and can be linted before the game runs.
 *
 * `validateMissionGraph` is the linter: it catches the failure modes that only
 * show up an hour into a playthrough — an objective nothing can reach, a chain
 * that loops forever, a `next` pointing at an id that was renamed.
 */

import { z } from 'zod';
import type { Vec3 } from '../../engine/ecs/components';
import {
  evaluateCondition,
  narrativeConditionSchema,
  narrativeEffectSchema,
  storyActSchema,
  findPlaceholderMarkers,
  type IssueSeverity,
  type NarrativeCondition,
  type NarrativeEffect,
  type NarrativeState,
  type ObjectiveId,
  type StoryAct,
  type ValidationIssue,
  type ValidationResult,
} from '../dialogue/dialogueSchema';

export type MissionId = string;
export type TestHookId = string;

// ---------------------------------------------------------------------------
// Objective pieces
// ---------------------------------------------------------------------------

/**
 * Primary objectives form the mission's spine. Optional objectives are side
 * work — an extra archival recording, a pump nobody asked her to restart —
 * and hang off the spine via `branchFrom`.
 */
export const OBJECTIVE_KINDS = ['primary', 'optional'] as const;
export type ObjectiveKind = (typeof OBJECTIVE_KINDS)[number];

/**
 * Checkpoint behaviour. The spec wants saves at act transitions, after major
 * puzzles, before the final sequence and after major conversations — all of
 * which are objective boundaries, so the objective declares it.
 */
export const CHECKPOINT_BEHAVIOURS = [
  'none',
  'on-activate',
  'on-complete',
  'both',
] as const;
export type CheckpointBehaviour = (typeof CHECKPOINT_BEHAVIOURS)[number];

/** World-space marker the HUD may point at. */
export interface ObjectiveMarker {
  position: Vec3;
  /** Short diegetic label, e.g. "Breaker 4B" — not "Objective marker". */
  label: string;
  /** Sector that owns the marker, so it can be hidden while unloaded. */
  sectorId?: string;
  /** Metres from the marker at which it counts as reached. */
  radius?: number;
}

/**
 * Escalating nudge for a stuck player.
 *
 * `afterSeconds` is time spent on the objective, not wall clock, so pausing to
 * read a notice board does not trigger a hint.
 */
export interface ObjectiveHint {
  text: string;
  afterSeconds: number;
}

const vec3Schema = z.strictObject({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

export const objectiveMarkerSchema = z.strictObject({
  position: vec3Schema,
  label: z.string().min(1),
  sectorId: z.string().min(1).optional(),
  radius: z.number().positive().optional(),
});

export const objectiveHintSchema = z.strictObject({
  text: z.string().min(1),
  afterSeconds: z.number().min(0),
});

// ---------------------------------------------------------------------------
// Objective
// ---------------------------------------------------------------------------

export interface Objective {
  id: ObjectiveId;
  /** Shown in the HUD and journal. Imperative and concrete. */
  title: string;
  /** Journal detail. May restate context the HUD line has no room for. */
  description: string;
  kind: ObjectiveKind;
  /**
   * When this objective may become active. Evaluated only once its predecessor
   * completes, so it gates rather than schedules.
   */
  activation: NarrativeCondition;
  completion: NarrativeCondition;
  markers: ObjectiveMarker[];
  hints?: ObjectiveHint[];
  /** Next objective in the chain. `null` ends the chain. */
  next: ObjectiveId | null;
  /**
   * For optional objectives only: the objective from which this side branch
   * becomes available. Without it a side objective is unreachable.
   */
  branchFrom?: ObjectiveId;
  checkpoint: CheckpointBehaviour;
  /**
   * Stable handle for automated tests and the developer overlay. Unique within
   * a mission; renaming one is a test-visible change on purpose.
   */
  testHook: TestHookId;
  /** Applied when the objective completes. */
  onComplete?: NarrativeEffect[];
}

export const objectiveSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  kind: z.enum(OBJECTIVE_KINDS),
  activation: narrativeConditionSchema,
  completion: narrativeConditionSchema,
  markers: z.array(objectiveMarkerSchema),
  hints: z.array(objectiveHintSchema).optional(),
  next: z.string().min(1).nullable(),
  branchFrom: z.string().min(1).optional(),
  checkpoint: z.enum(CHECKPOINT_BEHAVIOURS),
  testHook: z.string().min(1),
  onComplete: z.array(narrativeEffectSchema).optional(),
});

// ---------------------------------------------------------------------------
// Mission
// ---------------------------------------------------------------------------

export interface Mission {
  id: MissionId;
  title: string;
  act: StoryAct;
  /** One or two lines of authoring context. Not player-facing. */
  summary: string;
  /** Gate on campaign progress before the mission can start. */
  unlockedBy?: NarrativeCondition;
  entryObjective: ObjectiveId;
  objectives: Objective[];
}

export const missionSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  act: storyActSchema,
  summary: z.string().min(1),
  unlockedBy: narrativeConditionSchema.optional(),
  entryObjective: z.string().min(1),
  objectives: z.array(objectiveSchema).min(1),
});

/**
 * Parses authored mission data, throwing on malformed input.
 *
 * A mission that fails to parse is a chunk of campaign the player cannot
 * reach, so this is a fatal path, never a warning.
 */
export function parseMission(raw: unknown): Mission {
  const parsed = missionSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid mission: ${detail}`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

export function findObjective(
  mission: Mission,
  objectiveId: ObjectiveId,
): Objective | undefined {
  return mission.objectives.find((objective) => objective.id === objectiveId);
}

export function isMissionUnlocked(mission: Mission, state: NarrativeState): boolean {
  return mission.unlockedBy === undefined || evaluateCondition(mission.unlockedBy, state);
}

export function canActivateObjective(
  objective: Objective,
  state: NarrativeState,
): boolean {
  return evaluateCondition(objective.activation, state);
}

export function isObjectiveComplete(
  objective: Objective,
  state: NarrativeState,
): boolean {
  return evaluateCondition(objective.completion, state);
}

export function writesCheckpointOnActivate(objective: Objective): boolean {
  return objective.checkpoint === 'on-activate' || objective.checkpoint === 'both';
}

export function writesCheckpointOnComplete(objective: Objective): boolean {
  return objective.checkpoint === 'on-complete' || objective.checkpoint === 'both';
}

/** Optional objectives available once `objectiveId` is reached. */
export function sideObjectivesOf(
  mission: Mission,
  objectiveId: ObjectiveId,
): Objective[] {
  return mission.objectives.filter(
    (objective) => objective.kind === 'optional' && objective.branchFrom === objectiveId,
  );
}

// ---------------------------------------------------------------------------
// Graph validation
// ---------------------------------------------------------------------------

export type MissionIssueCode =
  // Errors
  | 'duplicate-objective-id'
  | 'missing-entry-objective'
  | 'dangling-next-pointer'
  | 'dangling-branch-from'
  | 'self-branch'
  | 'branch-from-on-primary'
  | 'unreachable-objective'
  | 'cyclic-objective-chain'
  | 'duplicate-test-hook'
  | 'no-terminal-objective'
  | 'placeholder-text'
  // Warnings
  | 'primary-objective-without-marker'
  | 'unordered-hints';

export type MissionValidationResult = ValidationResult<MissionIssueCode>;

function issue(
  code: MissionIssueCode,
  severity: IssueSeverity,
  message: string,
  target?: string,
): ValidationIssue<MissionIssueCode> {
  return target === undefined
    ? { code, severity, message }
    : { code, severity, message, target };
}

/**
 * Lints a mission's objective graph.
 *
 * Edges are `next` pointers plus, for optional objectives, `branchFrom`
 * reversed (parent → side objective). Reachability and cycle detection both
 * run over that graph, so a side branch is only reachable if it is attached to
 * something the player will actually reach.
 */
export function validateMissionGraph(mission: Mission): MissionValidationResult {
  const errors: ValidationIssue<MissionIssueCode>[] = [];
  const warnings: ValidationIssue<MissionIssueCode>[] = [];

  // --- identity ------------------------------------------------------------
  const byId = new Map<ObjectiveId, Objective>();
  for (const objective of mission.objectives) {
    if (byId.has(objective.id)) {
      errors.push(
        issue(
          'duplicate-objective-id',
          'error',
          `duplicate objective id "${objective.id}"`,
          objective.id,
        ),
      );
      continue; // First definition wins so the graph stays walkable.
    }
    byId.set(objective.id, objective);
  }

  const hooks = new Map<TestHookId, ObjectiveId>();
  for (const objective of byId.values()) {
    const owner = hooks.get(objective.testHook);
    if (owner !== undefined) {
      errors.push(
        issue(
          'duplicate-test-hook',
          'error',
          `test hook "${objective.testHook}" is used by both "${owner}" and "${objective.id}"`,
          objective.id,
        ),
      );
    } else {
      hooks.set(objective.testHook, objective.id);
    }
  }

  // --- per-objective checks ------------------------------------------------
  for (const objective of byId.values()) {
    const placeholders = [
      ...findPlaceholderMarkers(objective.title),
      ...findPlaceholderMarkers(objective.description),
    ];
    if (placeholders.length > 0) {
      errors.push(
        issue(
          'placeholder-text',
          'error',
          `objective "${objective.id}" contains placeholder text (${[...new Set(placeholders)].join(', ')})`,
          objective.id,
        ),
      );
    }

    if (objective.next !== null && !byId.has(objective.next)) {
      errors.push(
        issue(
          'dangling-next-pointer',
          'error',
          `objective "${objective.id}" points at unknown objective "${objective.next}"`,
          objective.id,
        ),
      );
    }

    if (objective.branchFrom !== undefined) {
      if (objective.kind === 'primary') {
        errors.push(
          issue(
            'branch-from-on-primary',
            'error',
            `objective "${objective.id}" is primary but declares branchFrom; only optional objectives branch`,
            objective.id,
          ),
        );
      }
      if (objective.branchFrom === objective.id) {
        errors.push(
          issue(
            'self-branch',
            'error',
            `objective "${objective.id}" branches from itself`,
            objective.id,
          ),
        );
      } else if (!byId.has(objective.branchFrom)) {
        errors.push(
          issue(
            'dangling-branch-from',
            'error',
            `objective "${objective.id}" branches from unknown objective "${objective.branchFrom}"`,
            objective.id,
          ),
        );
      }
    }

    if (objective.kind === 'primary' && objective.markers.length === 0) {
      warnings.push(
        issue(
          'primary-objective-without-marker',
          'warning',
          `primary objective "${objective.id}" has no world marker`,
          objective.id,
        ),
      );
    }

    if (objective.hints && objective.hints.length > 1) {
      const ascending = objective.hints.every(
        (hint, index) => index === 0 || hint.afterSeconds >= (objective.hints as ObjectiveHint[])[index - 1].afterSeconds,
      );
      if (!ascending) {
        warnings.push(
          issue(
            'unordered-hints',
            'warning',
            `objective "${objective.id}" has hints out of time order`,
            objective.id,
          ),
        );
      }
    }
  }

  // --- graph ---------------------------------------------------------------
  const edges = buildEdges(byId);

  if (!byId.has(mission.entryObjective)) {
    errors.push(
      issue(
        'missing-entry-objective',
        'error',
        `mission entry "${mission.entryObjective}" is not one of its objectives`,
        mission.entryObjective,
      ),
    );
  } else {
    const reached = walkReachable(mission.entryObjective, edges);
    for (const id of byId.keys()) {
      if (!reached.has(id)) {
        errors.push(
          issue(
            'unreachable-objective',
            'error',
            `objective "${id}" cannot be reached from the mission entry`,
            id,
          ),
        );
      }
    }
  }

  for (const cycle of findCycles(byId, edges)) {
    errors.push(
      issue(
        'cyclic-objective-chain',
        'error',
        `objective chain loops: ${cycle.join(' -> ')}`,
        cycle[0],
      ),
    );
  }

  // A mission with no primary objective ending in `next: null` can never be
  // finished. Only meaningful when the pointers themselves are sound.
  const hasDanglingNext = errors.some((e) => e.code === 'dangling-next-pointer');
  const hasTerminal = [...byId.values()].some(
    (objective) => objective.kind === 'primary' && objective.next === null,
  );
  if (!hasTerminal && !hasDanglingNext) {
    errors.push(
      issue(
        'no-terminal-objective',
        'error',
        'mission has no primary objective that ends the chain',
      ),
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Adjacency: `next` chains plus optional objectives hanging off their parent. */
function buildEdges(
  byId: ReadonlyMap<ObjectiveId, Objective>,
): Map<ObjectiveId, ObjectiveId[]> {
  const edges = new Map<ObjectiveId, ObjectiveId[]>();
  for (const id of byId.keys()) edges.set(id, []);

  for (const objective of byId.values()) {
    if (objective.next !== null && byId.has(objective.next)) {
      edges.get(objective.id)?.push(objective.next);
    }
    if (
      objective.kind === 'optional' &&
      objective.branchFrom !== undefined &&
      objective.branchFrom !== objective.id &&
      byId.has(objective.branchFrom)
    ) {
      edges.get(objective.branchFrom)?.push(objective.id);
    }
  }

  return edges;
}

function walkReachable(
  entry: ObjectiveId,
  edges: ReadonlyMap<ObjectiveId, ObjectiveId[]>,
): Set<ObjectiveId> {
  const reached = new Set<ObjectiveId>([entry]);
  const stack: ObjectiveId[] = [entry];

  while (stack.length > 0) {
    const current = stack.pop() as ObjectiveId;
    for (const next of edges.get(current) ?? []) {
      if (reached.has(next)) continue;
      reached.add(next);
      stack.push(next);
    }
  }

  return reached;
}

/**
 * Finds cycles with an iterative depth-first walk.
 *
 * Iterative rather than recursive so a long authored chain cannot blow the
 * stack, and each cycle is reported once with the path that closes it.
 */
function findCycles(
  byId: ReadonlyMap<ObjectiveId, Objective>,
  edges: ReadonlyMap<ObjectiveId, ObjectiveId[]>,
): ObjectiveId[][] {
  const cycles: ObjectiveId[][] = [];
  const seenCycleKeys = new Set<string>();
  const finished = new Set<ObjectiveId>();

  for (const root of byId.keys()) {
    if (finished.has(root)) continue;

    const path: ObjectiveId[] = [];
    const onPath = new Set<ObjectiveId>();
    const stack: { id: ObjectiveId; childIndex: number }[] = [{ id: root, childIndex: 0 }];
    path.push(root);
    onPath.add(root);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const children = edges.get(frame.id) ?? [];

      if (frame.childIndex >= children.length) {
        finished.add(frame.id);
        onPath.delete(frame.id);
        path.pop();
        stack.pop();
        continue;
      }

      const child = children[frame.childIndex];
      frame.childIndex += 1;

      if (onPath.has(child)) {
        const start = path.indexOf(child);
        const cycle = [...path.slice(start), child];
        const key = canonicalCycleKey(cycle);
        if (!seenCycleKeys.has(key)) {
          seenCycleKeys.add(key);
          cycles.push(cycle);
        }
        continue;
      }

      if (finished.has(child)) continue;

      path.push(child);
      onPath.add(child);
      stack.push({ id: child, childIndex: 0 });
    }
  }

  return cycles;
}

/** Rotation-independent key so the same loop is not reported from two entries. */
function canonicalCycleKey(cycle: ObjectiveId[]): string {
  const members = [...new Set(cycle)].sort();
  return members.join('|');
}
