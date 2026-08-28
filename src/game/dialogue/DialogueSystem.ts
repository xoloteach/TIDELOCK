/**
 * Dialogue runtime.
 *
 * Plays the authored scenes described by `dialogueSchema`. It walks a node
 * graph, filters choices, applies effects, honours interrupts and records what
 * the player has already seen. It renders nothing: presentation arrives at the
 * HUD as events carrying speaker, text, audio path, subtitle cue file and line
 * duration, and the HUD decides what that looks like. There is no DOM access in
 * this file and there must never be one — the same system runs under Vitest with
 * no document at all.
 *
 * Everything is deterministic. No `Math.random`, no `Date.now`, no runtime text
 * generation: the same scene plus the same campaign state plus the same choices
 * always produces the same traversal, which is the only reason a story smoke
 * test can assert an act is completable.
 *
 * This module also hosts the shared *ports* the narrative systems write
 * through — `CampaignStatePort`, `ObjectivePort`, `CinematicUnlockPort` — and
 * the single `applyNarrativeEffect` implementation. `MissionSystem` imports
 * them from here for the same reason `missionSchema` imports the condition AST
 * from `dialogueSchema`: dialogue is the heaviest consumer, and one
 * implementation of "what does `setFlag` mean" is better than two that drift.
 * If a third domain needs them, lift them into
 * `src/game/progression/effects.ts` rather than duplicating.
 */

import type { System } from '../../engine/ecs/GameWorld';
import { Emitter } from '../../engine/events';
import type { DialogueState } from '../../persistence/saveSchema';
import {
  availableChoices,
  canPlayScene,
  countSpokenWords,
  createNarrativeState,
  evaluateCondition,
  type ChoiceId,
  type DialogueChoice,
  type DialogueNode,
  type DialogueScene,
  type EvidenceId,
  type FlagName,
  type FlagValue,
  type NarrativeEffect,
  type NarrativeState,
  type NodeId,
  type ObjectiveId,
  type PresentationTier,
  type SceneId,
  type SequenceId,
  type SpeakerId,
} from './dialogueSchema';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * Campaign progress, as far as the narrative systems are concerned.
 *
 * A port, not the save store: this file must be usable with an in-memory
 * implementation, and importing `SaveStore` would drag IndexedDB into every
 * dialogue test. The real adapter is a thin wrapper over the in-memory save
 * blob that `SaveStore` writes on its own schedule.
 *
 * `narrativeState()` is called at every gate, so it must be cheap.
 */
export interface CampaignStatePort {
  /** Snapshot the condition AST is evaluated against. */
  narrativeState(): NarrativeState;
  setFlag(flag: FlagName, value: FlagValue): void;
  grantEvidence(evidenceId: EvidenceId): void;
  adjustTrust(character: SpeakerId, delta: number): void;
  /**
   * Optional write-backs for state another system owns.
   *
   * The mission system owns objective statuses and this system owns played
   * scenes, and each overlays its own view onto `narrativeState()` before
   * evaluating. These hooks exist so a single store can also see the other
   * system's progress without a wiring layer; an adapter that derives them
   * from the owning system can omit both.
   */
  markObjectiveComplete?(objectiveId: ObjectiveId): void;
  markSceneSeen?(sceneId: SceneId): void;
}

/** The mission system, seen from a dialogue effect. */
export interface ObjectivePort {
  advanceObjective(objectiveId: ObjectiveId): void;
}

/** The sequence system, seen from a dialogue effect. */
export interface CinematicUnlockPort {
  unlockCinematic(sequenceId: SequenceId): void;
}

/** Where each effect kind is written. Missing sinks are reported, never silent. */
export interface NarrativeEffectSinks {
  state: CampaignStatePort;
  missions?: ObjectivePort | null;
  cinematics?: CinematicUnlockPort | null;
}

/**
 * Applies one authored effect.
 *
 * Total over `NarrativeEffect` — the switch is exhaustive, so adding an effect
 * kind to the schema is a compile error here rather than an effect that
 * silently does nothing at runtime.
 */
export function applyNarrativeEffect(
  effect: NarrativeEffect,
  sinks: NarrativeEffectSinks,
): void {
  switch (effect.kind) {
    case 'setFlag':
      sinks.state.setFlag(effect.flag, effect.value);
      return;
    case 'grantEvidence':
      sinks.state.grantEvidence(effect.evidenceId);
      return;
    case 'adjustTrust':
      sinks.state.adjustTrust(effect.character, effect.delta);
      return;
    case 'advanceObjective':
      if (!sinks.missions) {
        console.warn(
          `[narrative] effect advanceObjective("${effect.objectiveId}") had no mission sink`,
        );
        return;
      }
      sinks.missions.advanceObjective(effect.objectiveId);
      return;
    case 'unlockCinematic':
      if (!sinks.cinematics) {
        console.warn(
          `[narrative] effect unlockCinematic("${effect.sequenceId}") had no sequence sink`,
        );
        return;
      }
      sinks.cinematics.unlockCinematic(effect.sequenceId);
      return;
  }
}

// ---------------------------------------------------------------------------
// Reference in-memory campaign state
// ---------------------------------------------------------------------------

export interface MemoryCampaignState extends CampaignStatePort {
  readonly flags: Record<FlagName, FlagValue>;
  readonly evidence: Set<EvidenceId>;
  readonly completedObjectives: Set<ObjectiveId>;
  readonly seenScenes: Set<SceneId>;
  readonly trust: Record<string, number>;
}

/**
 * A campaign store held in a plain object.
 *
 * Used by tests and by a session that has not written a save yet. Mutations are
 * visible through `narrativeState()` immediately, which is what makes a
 * condition become true mid-scene.
 */
export function createMemoryCampaignState(
  init: {
    flags?: Record<FlagName, FlagValue>;
    evidence?: Iterable<EvidenceId>;
    completedObjectives?: Iterable<ObjectiveId>;
    seenScenes?: Iterable<SceneId>;
    trust?: Record<string, number>;
  } = {},
): MemoryCampaignState {
  const flags: Record<FlagName, FlagValue> = { ...(init.flags ?? {}) };
  const evidence = new Set<EvidenceId>(init.evidence ?? []);
  const completedObjectives = new Set<ObjectiveId>(init.completedObjectives ?? []);
  const seenScenes = new Set<SceneId>(init.seenScenes ?? []);
  const trust: Record<string, number> = { ...(init.trust ?? {}) };

  return {
    flags,
    evidence,
    completedObjectives,
    seenScenes,
    trust,
    // Rebuilt per call so a caller cannot mutate campaign progress through a
    // state snapshot it was handed for reading.
    narrativeState: () =>
      createNarrativeState({ flags, evidence, completedObjectives, seenScenes, trust }),
    setFlag: (flag, value) => {
      flags[flag] = value;
    },
    grantEvidence: (evidenceId) => {
      evidence.add(evidenceId);
    },
    adjustTrust: (character, delta) => {
      trust[character] = (trust[character] ?? 0) + delta;
    },
    markObjectiveComplete: (objectiveId) => {
      completedObjectives.add(objectiveId);
    },
    markSceneSeen: (sceneId) => {
      seenScenes.add(sceneId);
    },
  };
}

// ---------------------------------------------------------------------------
// Line timing
// ---------------------------------------------------------------------------

/**
 * Speaking rate used when a line has no authored `duration`.
 *
 * Deliberately slower than a newsreader: Mara and Sera are working, cold and
 * talking over machinery. Authored `duration` always wins, and a recorded line
 * should carry one — this is the floor that keeps subtitle timing and interrupt
 * windows meaningful for lines whose audio has not been cut yet.
 */
export const DIALOGUE_WORDS_PER_SECOND = 2.6;

/** No line is on screen for less than this, however short it is. */
export const DIALOGUE_MIN_LINE_SECONDS = 1.2;

/** Deterministic fallback duration for a line with no authored timing. */
export function estimateLineDuration(text: string): number {
  const seconds = countSpokenWords(text) / DIALOGUE_WORDS_PER_SECOND;
  return Math.max(DIALOGUE_MIN_LINE_SECONDS, seconds);
}

export function lineDuration(node: DialogueNode): number {
  return node.duration ?? estimateLineDuration(node.text);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Everything the subtitle/HUD layer needs to draw a line. It gets nothing else. */
export interface DialogueLinePresentation {
  readonly sceneId: SceneId;
  readonly nodeId: NodeId;
  readonly speaker: SpeakerId;
  readonly text: string;
  /** Path under `public/assets/audio`, when the line is recorded. */
  readonly audio?: string;
  /** Timed cue file, for lines needing word-level sync. */
  readonly subtitles?: string;
  /** Seconds. Authored duration, or a deterministic estimate. */
  readonly duration: number;
  readonly tier: PresentationTier;
  readonly skippable: boolean;
}

export interface OfferedChoice {
  readonly id: ChoiceId;
  readonly text: string;
  readonly target: NodeId;
}

export type DialogueLineEndReason =
  /** The line played out, or the player advanced it. */
  | 'advanced'
  /** A world event cut it off. */
  | 'interrupted'
  /** The player skipped ahead. */
  | 'skipped'
  /** A choice was taken from this node. */
  | 'chosen'
  /** The scene finished on this line. */
  | 'scene-ended';

export type DialogueSceneEndReason =
  /** Reached a node with nowhere to go. */
  | 'completed'
  /** An interrupt targeted `null`. */
  | 'interrupted'
  /** The player skipped a skippable scene to its end. */
  | 'skipped'
  /** Torn down from outside — save loaded, player died, sector unloaded. */
  | 'aborted';

export type DialogueEvents = {
  'scene-started': { sceneId: SceneId; tier: PresentationTier; blocksGameplay: boolean };
  'scene-ended': { sceneId: SceneId; reason: DialogueSceneEndReason };
  'line-started': DialogueLinePresentation;
  'line-ended': { sceneId: SceneId; nodeId: NodeId; reason: DialogueLineEndReason };
  'choices-offered': {
    sceneId: SceneId;
    nodeId: NodeId;
    choices: readonly OfferedChoice[];
  };
  'choice-taken': {
    sceneId: SceneId;
    nodeId: NodeId;
    choiceId: ChoiceId;
    target: NodeId;
  };
  /** A `once` scene was asked to play again, or its gate failed. */
  'scene-suppressed': { sceneId: SceneId; reason: 'already-seen' | 'unavailable' | 'busy' };
};

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export interface DialogueSystemOptions {
  /** Authored scenes, already parsed. */
  scenes?: readonly DialogueScene[];
  state: CampaignStatePort;
  missions?: ObjectivePort | null;
  cinematics?: CinematicUnlockPort | null;
  /**
   * Whether a line advances on its own once its duration elapses. True is the
   * shipping behaviour — a voiced line that has finished should not wait for a
   * button. Tests that want to hold a line switch it off.
   */
  autoAdvance?: boolean;
}

interface RunningScene {
  readonly scene: DialogueScene;
  nodeId: NodeId | null;
  /** Seconds the current line has been on screen. Fixed-step clock. */
  lineElapsed: number;
  /** Nodes whose effects have already been applied during this run. */
  readonly effectsApplied: Set<NodeId>;
  /** True once choices have been emitted for the current node. */
  choicesOffered: boolean;
}

export class DialogueSystem implements System {
  readonly name = 'dialogue';

  private readonly emitter = new Emitter<DialogueEvents>();
  private readonly scenes = new Map<SceneId, DialogueScene>();
  private readonly sinks: NarrativeEffectSinks;
  private readonly autoAdvance: boolean;

  /** Persisted: node ids in the order they were first played. */
  private readonly seenNodeIds: string[] = [];
  private readonly seenNodeSet = new Set<NodeId>();
  /** Persisted: scenes that reached an end, for `once` protection. */
  private readonly completedSceneIds: string[] = [];
  private readonly completedSceneSet = new Set<SceneId>();
  /**
   * Persisted: scene id -> node the player's last choice in that scene led to.
   *
   * The save schema stores one node id per scene (`dialogue.choices`), so this
   * records the branch taken rather than the choice id. The branch is what the
   * epilogue and later scenes actually read, and the choice that produced it is
   * recoverable from the scene graph.
   */
  private readonly chosenBranch = new Map<SceneId, NodeId>();

  private running: RunningScene | null = null;

  constructor(options: DialogueSystemOptions) {
    this.sinks = {
      state: options.state,
      missions: options.missions ?? null,
      cinematics: options.cinematics ?? null,
    };
    this.autoAdvance = options.autoAdvance ?? true;

    for (const scene of options.scenes ?? []) this.register(scene);
  }

  on = this.emitter.on.bind(this.emitter);
  off = this.emitter.off.bind(this.emitter);

  /**
   * Adds a scene to the registry.
   *
   * Duplicate ids are fatal at registration: two scenes sharing an id makes
   * `start()` ambiguous and silently plays whichever loaded last.
   */
  register(scene: DialogueScene): void {
    if (this.scenes.has(scene.sceneId)) {
      throw new Error(`Duplicate dialogue scene id "${scene.sceneId}"`);
    }
    this.scenes.set(scene.sceneId, scene);
  }

  getScene(sceneId: SceneId): DialogueScene | undefined {
    return this.scenes.get(sceneId);
  }

  // ---- Public state -----------------------------------------------------

  get activeSceneId(): SceneId | null {
    return this.running?.scene.sceneId ?? null;
  }

  get activeNodeId(): NodeId | null {
    return this.running?.nodeId ?? null;
  }

  get activeTier(): PresentationTier | null {
    return this.running?.scene.tier ?? null;
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  /**
   * Whether the player's control should be taken away.
   *
   * `ambient` never blocks: radio chatter and a passing resident play over
   * normal movement, which is the whole point of the tier. `focused` and
   * `cinematic` may, so this is the single question the player controller and
   * the input layer ask.
   */
  get blocksGameplay(): boolean {
    return this.running !== null && this.running.scene.tier !== 'ambient';
  }

  /** Seconds the current line has been on screen. */
  get lineElapsed(): number {
    return this.running?.lineElapsed ?? 0;
  }

  /** Choices currently on offer, condition-filtered. Empty when none. */
  get offeredChoices(): readonly OfferedChoice[] {
    const node = this.currentNode();
    if (!node || !this.running?.choicesOffered) return [];
    return availableChoices(node, this.state()).map(toOffered);
  }

  hasSeenNode(nodeId: NodeId): boolean {
    return this.seenNodeSet.has(nodeId);
  }

  hasCompletedScene(sceneId: SceneId): boolean {
    return this.completedSceneSet.has(sceneId);
  }

  /** The branch a scene's last choice led to, or null if it had no choice. */
  chosenBranchOf(sceneId: SceneId): NodeId | null {
    return this.chosenBranch.get(sceneId) ?? null;
  }

  /** Whether `sceneId` could start right now. Does not start it. */
  canStart(sceneId: SceneId): boolean {
    const scene = this.scenes.get(sceneId);
    if (!scene || this.running) return false;
    return canPlayScene(scene, this.state());
  }

  // ---- Scene lifecycle --------------------------------------------------

  /**
   * Starts a scene. Returns false when it was suppressed, with a
   * `scene-suppressed` event explaining why.
   *
   * Replay protection is checked here rather than at the trigger site so every
   * caller gets it — a trigger volume the player walks through twice, a radio
   * line fired by a pump event, a manual debug start.
   */
  start(sceneId: SceneId): boolean {
    const scene = this.scenes.get(sceneId);
    if (!scene) throw new Error(`Unknown dialogue scene "${sceneId}"`);

    if (this.running) {
      this.emitter.emit('scene-suppressed', { sceneId, reason: 'busy' });
      return false;
    }

    const state = this.state();
    if (scene.once && state.seenScenes.has(sceneId)) {
      this.emitter.emit('scene-suppressed', { sceneId, reason: 'already-seen' });
      return false;
    }
    if (scene.availableWhen && !evaluateCondition(scene.availableWhen, state)) {
      this.emitter.emit('scene-suppressed', { sceneId, reason: 'unavailable' });
      return false;
    }

    this.running = {
      scene,
      nodeId: null,
      lineElapsed: 0,
      effectsApplied: new Set(),
      choicesOffered: false,
    };

    this.emitter.emit('scene-started', {
      sceneId,
      tier: scene.tier,
      blocksGameplay: scene.tier !== 'ambient',
    });

    this.enterNode(scene.entry, { emit: true });
    return true;
  }

  /**
   * Finishes the current line and follows its `next` pointer.
   *
   * A node with choices ignores this: the player has to answer. Returns false
   * when there was nothing to advance.
   */
  advance(): boolean {
    const run = this.running;
    const node = this.currentNode();
    if (!run || !node) return false;
    if (run.choicesOffered) return false;

    this.applyNodeEffects(node);
    const next = node.next ?? null;

    if (next === null) {
      this.emitter.emit('line-ended', {
        sceneId: run.scene.sceneId,
        nodeId: node.id,
        reason: 'scene-ended',
      });
      this.endScene('completed');
      return true;
    }

    this.emitter.emit('line-ended', {
      sceneId: run.scene.sceneId,
      nodeId: node.id,
      reason: 'advanced',
    });
    this.enterNode(next, { emit: true });
    return true;
  }

  /**
   * Takes a choice by id.
   *
   * Throws when the id is not currently on offer. A choice hidden by its
   * condition is not a choice the player could have clicked, so accepting it
   * would mean the UI and the runtime disagree about what is on screen — that
   * is a bug worth surfacing, not one to route around.
   */
  choose(choiceId: ChoiceId): void {
    const run = this.running;
    const node = this.currentNode();
    if (!run || !node) throw new Error('choose() called with no dialogue running');
    if (!run.choicesOffered) {
      throw new Error(`node "${node.id}" is not offering choices`);
    }

    const choice = availableChoices(node, this.state()).find((c) => c.id === choiceId);
    if (!choice) {
      throw new Error(`choice "${choiceId}" is not available on node "${node.id}"`);
    }

    // Node effects first, then the choice's: the line finished before the
    // player answered it, and an authored choice may depend on a flag the line
    // set.
    this.applyNodeEffects(node);
    for (const effect of choice.effects ?? []) applyNarrativeEffect(effect, this.sinks);

    this.chosenBranch.set(run.scene.sceneId, choice.target);
    run.choicesOffered = false;

    this.emitter.emit('choice-taken', {
      sceneId: run.scene.sceneId,
      nodeId: node.id,
      choiceId: choice.id,
      target: choice.target,
    });
    this.emitter.emit('line-ended', {
      sceneId: run.scene.sceneId,
      nodeId: node.id,
      reason: 'chosen',
    });

    this.enterNode(choice.target, { emit: true });
  }

  /**
   * A world event that may cut the current line short.
   *
   * Called by whatever knows the event happened — a pump losing sync, a gate
   * finishing its travel. Returns true when it actually interrupted, so the
   * caller can tell a swallowed event from an honoured one.
   *
   * `earliest` is respected: a line the player has heard none of is not
   * interrupted, it is queued behind by the caller trying again.
   */
  notifyEvent(event: string): boolean {
    const run = this.running;
    const node = this.currentNode();
    if (!run || !node) return false;

    const interrupt = (node.interrupts ?? []).find(
      (candidate) =>
        candidate.event === event && run.lineElapsed >= (candidate.earliest ?? 0),
    );
    if (!interrupt) return false;

    // The line still counts as finished, so its effects land. Cutting Sera off
    // mid-sentence must not lose the flag her line set.
    this.applyNodeEffects(node);
    run.choicesOffered = false;

    this.emitter.emit('line-ended', {
      sceneId: run.scene.sceneId,
      nodeId: node.id,
      reason: 'interrupted',
    });

    if (interrupt.target === null) {
      this.endScene('interrupted');
      return true;
    }

    this.enterNode(interrupt.target, { emit: true });
    return true;
  }

  /**
   * Skips a skippable scene.
   *
   * Fast-forwards along `next` pointers applying effects rather than jumping
   * straight to the end, because a skipped cinematic must leave the same
   * campaign state a watched one would. It stops at a choice — skipping the
   * presentation is not the same as declining to answer — and returns false
   * when the scene is not skippable.
   */
  skip(): boolean {
    const run = this.running;
    const node = this.currentNode();
    if (!run || !node) return false;
    if (!run.scene.skippable) return false;

    this.emitter.emit('line-ended', {
      sceneId: run.scene.sceneId,
      nodeId: node.id,
      reason: 'skipped',
    });

    // Bounded by the node count: a graph the linter passed has no cycles, and a
    // hand-built scene in a test should fail loudly rather than hang.
    const budget = run.scene.nodes.length + 1;
    let current: DialogueNode | null = node;

    for (let step = 0; step < budget; step += 1) {
      if (!current) break;
      this.applyNodeEffects(current);

      if (current.choices && current.choices.length > 0) {
        // Land on the choice node silently, then offer its options for real.
        run.nodeId = current.id;
        run.lineElapsed = lineDuration(current);
        this.offerChoices(current);
        return true;
      }

      const next = current.next ?? null;
      if (next === null) {
        this.endScene('skipped');
        return true;
      }

      const resolved = this.resolveNode(next);
      if (!resolved) {
        this.endScene('skipped');
        return true;
      }
      this.markSeen(resolved.id);
      current = resolved;
    }

    console.warn(`[dialogue] skip in scene "${run.scene.sceneId}" exceeded its node budget`);
    this.endScene('skipped');
    return true;
  }

  /**
   * Tears the scene down from outside — a save was loaded, the sector
   * unloaded, the player died mid-conversation.
   *
   * Deliberately does not apply the current node's effects or mark the scene
   * complete: nothing about it finished, and a `once` scene must still be
   * available when the player returns.
   */
  abort(): void {
    if (!this.running) return;
    const sceneId = this.running.scene.sceneId;
    this.running = null;
    this.emitter.emit('scene-ended', { sceneId, reason: 'aborted' });
  }

  // ---- Simulation -------------------------------------------------------

  /**
   * Advances the current line's clock.
   *
   * The fixed-step clock, not `Date.now()`: line timing pauses with the game
   * and is exactly reproducible in tests. Nothing else happens per step — there
   * is no condition scanning here, because a dialogue node's gates are only
   * ever evaluated at the moment the runtime moves onto it.
   */
  fixedUpdate(dt: number): void {
    const run = this.running;
    if (!run) return;

    const node = this.currentNode();
    if (!node) return;

    run.lineElapsed += dt;

    if (run.choicesOffered) return; // A choice waits as long as it takes.
    if (!this.autoAdvance) return;
    if (run.lineElapsed < lineDuration(node)) return;

    this.advance();
  }

  dispose(): void {
    this.running = null;
    this.emitter.clear();
  }

  // ---- Traversal --------------------------------------------------------

  private currentNode(): DialogueNode | null {
    const run = this.running;
    if (!run || run.nodeId === null) return null;
    return run.scene.nodes.find((node) => node.id === run.nodeId) ?? null;
  }

  /**
   * Moves onto a node, skipping any whose condition currently fails.
   *
   * A failing node is skipped *through* — the runtime follows its `next` — so a
   * conditional aside does not end the conversation when it does not apply.
   */
  private enterNode(nodeId: NodeId, options: { emit: boolean }): void {
    const run = this.running;
    if (!run) return;

    const node = this.resolveNode(nodeId);
    if (!node) {
      this.endScene('completed');
      return;
    }

    run.nodeId = node.id;
    run.lineElapsed = 0;
    run.choicesOffered = false;
    this.markSeen(node.id);

    if (options.emit) {
      this.emitter.emit('line-started', presentation(run.scene, node));
    }

    if (node.choices && node.choices.length > 0) this.offerChoices(node);
  }

  /**
   * Follows `next` from a node whose condition fails until one passes.
   *
   * Returns null when the chain of skipped nodes runs off the end of the
   * scene, which ends it.
   */
  private resolveNode(nodeId: NodeId): DialogueNode | null {
    const run = this.running;
    if (!run) return null;

    const budget = run.scene.nodes.length + 1;
    let currentId: NodeId | null = nodeId;

    for (let step = 0; step < budget; step += 1) {
      if (currentId === null) return null;
      const node = run.scene.nodes.find((candidate) => candidate.id === currentId);
      if (!node) {
        // The schema linter reports dangling pointers before the game runs; if
        // one reaches here the scene ends rather than freezing on a blank line.
        console.warn(
          `[dialogue] scene "${run.scene.sceneId}" points at unknown node "${currentId}"`,
        );
        return null;
      }
      if (!node.condition || evaluateCondition(node.condition, this.state())) return node;
      currentId = node.next ?? null;
    }

    console.warn(
      `[dialogue] resolving "${nodeId}" in scene "${run.scene.sceneId}" exceeded its node budget`,
    );
    return null;
  }

  private offerChoices(node: DialogueNode): void {
    const run = this.running;
    if (!run) return;

    const choices = availableChoices(node, this.state()).map(toOffered);
    run.choicesOffered = true;
    this.emitter.emit('choices-offered', {
      sceneId: run.scene.sceneId,
      nodeId: node.id,
      choices,
    });
  }

  /** Applies a node's effects at most once per scene run. */
  private applyNodeEffects(node: DialogueNode): void {
    const run = this.running;
    if (!run) return;
    if (run.effectsApplied.has(node.id)) return;
    run.effectsApplied.add(node.id);
    for (const effect of node.effects ?? []) applyNarrativeEffect(effect, this.sinks);
  }

  private endScene(reason: DialogueSceneEndReason): void {
    const run = this.running;
    if (!run) return;
    const { scene } = run;

    // Cleared before the effects run so that anything reacting to `scene-ended`
    // sees a settled system rather than one still nominally mid-scene.
    this.running = null;

    if (!this.completedSceneSet.has(scene.sceneId)) {
      this.completedSceneSet.add(scene.sceneId);
      this.completedSceneIds.push(scene.sceneId);
    }
    this.sinks.state.markSceneSeen?.(scene.sceneId);

    for (const effect of scene.onEnd ?? []) applyNarrativeEffect(effect, this.sinks);

    this.emitter.emit('scene-ended', { sceneId: scene.sceneId, reason });
  }

  private markSeen(nodeId: NodeId): void {
    if (this.seenNodeSet.has(nodeId)) return;
    this.seenNodeSet.add(nodeId);
    this.seenNodeIds.push(nodeId);
  }

  /**
   * Campaign state with this system's own scene history overlaid.
   *
   * Unioned rather than replaced: the port may already know about scenes from a
   * loaded save or another content pack, and this system only knows what it has
   * played since `restore`.
   */
  private state(): NarrativeState {
    const base = this.sinks.state.narrativeState();
    if (this.completedSceneSet.size === 0) return base;

    const seenScenes = new Set(base.seenScenes);
    for (const sceneId of this.completedSceneSet) seenScenes.add(sceneId);
    return { ...base, seenScenes };
  }

  // ---- Persistence ------------------------------------------------------

  /**
   * The `dialogue` slice of a save, exactly as `saveSchema` expects it.
   *
   * Arrays are copies in first-seen order, so two serialises of the same state
   * are deep-equal and a save diff is readable.
   */
  serialise(): DialogueState {
    const choices: Record<string, string> = {};
    for (const [sceneId, nodeId] of this.chosenBranch) choices[sceneId] = nodeId;

    return {
      seenNodeIds: [...this.seenNodeIds],
      completedSceneIds: [...this.completedSceneIds],
      choices,
    };
  }

  /**
   * Adopts a stored dialogue slice.
   *
   * Aborts anything running: the scene belonged to the session being replaced.
   * Ids for content that no longer exists are kept rather than dropped —
   * `seenNodeIds` is history, and forgetting that a line was heard would replay
   * it if the content came back.
   */
  restore(state: DialogueState): void {
    this.abort();

    this.seenNodeIds.length = 0;
    this.seenNodeSet.clear();
    for (const nodeId of state.seenNodeIds) {
      if (this.seenNodeSet.has(nodeId)) continue;
      this.seenNodeSet.add(nodeId);
      this.seenNodeIds.push(nodeId);
    }

    this.completedSceneIds.length = 0;
    this.completedSceneSet.clear();
    for (const sceneId of state.completedSceneIds) {
      if (this.completedSceneSet.has(sceneId)) continue;
      this.completedSceneSet.add(sceneId);
      this.completedSceneIds.push(sceneId);
    }

    this.chosenBranch.clear();
    for (const [sceneId, nodeId] of Object.entries(state.choices)) {
      this.chosenBranch.set(sceneId, nodeId);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toOffered(choice: DialogueChoice): OfferedChoice {
  return { id: choice.id, text: choice.text, target: choice.target };
}

function presentation(
  scene: DialogueScene,
  node: DialogueNode,
): DialogueLinePresentation {
  const line: DialogueLinePresentation = {
    sceneId: scene.sceneId,
    nodeId: node.id,
    speaker: node.speaker,
    text: node.text,
    duration: lineDuration(node),
    tier: scene.tier,
    skippable: scene.skippable,
  };
  // Spread conditionally so a line with no recording does not carry
  // `audio: undefined` into an event payload the HUD then has to test for.
  return {
    ...line,
    ...(node.audio !== undefined ? { audio: node.audio } : {}),
    ...(node.subtitles !== undefined ? { subtitles: node.subtitles } : {}),
  };
}
