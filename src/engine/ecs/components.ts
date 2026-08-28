/**
 * ECS component definitions.
 *
 * One `Entity` type with optional components. miniplex queries narrow that
 * type via `with(...)`, so a system that queries `with('transform', 'navAgent')`
 * receives an entity where those fields are non-optional — the compiler
 * enforces that a system cannot read a component it did not query for.
 *
 * Components are plain data. Behaviour lives in systems.
 */

import type { Object3D, AnimationMixer, AnimationClip } from 'three';

// ---------------------------------------------------------------------------
// Spatial
// ---------------------------------------------------------------------------

/** Plain 3-vector. Avoids allocating THREE.Vector3 for pure data. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Transform {
  position: Vec3;
  /** Yaw in radians. Most entities only rotate about Y. */
  yaw: number;
  pitch: number;
  roll: number;
  scale: number;
}

/**
 * Previous-step transform, kept so rendering can interpolate between fixed
 * simulation steps instead of snapping at low simulation rates.
 */
export interface PreviousTransform {
  position: Vec3;
  yaw: number;
}

export interface Velocity {
  linear: Vec3;
  /** Angular velocity about Y, radians/second. */
  angular: number;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface Renderable {
  /** The scene node. Systems write transforms into this during render sync. */
  object: Object3D;
  /** Set false to skip render sync without removing the entity. */
  visible: boolean;
  /** Distance beyond which this entity is not drawn. 0 = always draw. */
  cullDistance: number;
  /** Marks the object as never-moving so sync can skip it after the first pass. */
  static: boolean;
}

export interface LodLevels {
  /** Ordered cheapest-last: [{distance, object}] evaluated nearest-first. */
  levels: { distance: number; object: Object3D }[];
  activeIndex: number;
}

export interface AnimationState {
  mixer: AnimationMixer;
  clips: Map<string, AnimationClip>;
  current: string | null;
  /** Seconds to cross-fade when switching clips. */
  fadeDuration: number;
}

// ---------------------------------------------------------------------------
// Physics
// ---------------------------------------------------------------------------

/** Collision layers. Bitmask so a filter can express "world or machine". */
export const CollisionLayer = {
  World: 1 << 0,
  Player: 1 << 1,
  Machine: 1 << 2,
  Npc: 1 << 3,
  Interactable: 1 << 4,
  Trigger: 1 << 5,
  Debris: 1 << 6,
  Water: 1 << 7,
} as const;

export type CollisionLayerName = keyof typeof CollisionLayer;

export interface PhysicsBody {
  /** Rapier RigidBody handle. Typed loosely so ECS does not import Rapier. */
  handle: number;
  kind: 'static' | 'dynamic' | 'kinematic';
  layer: number;
  /** Sleeping bodies are skipped by the physics sync. */
  sleeping: boolean;
}

// ---------------------------------------------------------------------------
// Gameplay
// ---------------------------------------------------------------------------

export interface Health {
  current: number;
  max: number;
  /** Seconds of immunity remaining after taking damage. */
  invulnerableFor: number;
}

/** What the interaction prompt offers when the player looks at this entity. */
export type InteractionVerb =
  | 'open'
  | 'close'
  | 'use'
  | 'take'
  | 'inspect'
  | 'talk'
  | 'turn'
  | 'connect'
  | 'climb'
  | 'read';

export interface Interactable {
  verb: InteractionVerb;
  /** Short label shown next to the prompt, e.g. "Breaker 4B". */
  label: string;
  /** Max distance in metres at which the prompt appears. */
  range: number;
  /** Seconds the interact input must be held. 0 = instant. */
  holdDuration: number;
  enabled: boolean;
  /** Emitted on the event bus when the interaction completes. */
  event: string;
  /** Local offset from the transform where the prompt anchors. */
  promptOffset: Vec3;
  /** Set false once used, for one-shot interactions. */
  repeatable: boolean;
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export type MachineKind =
  | 'inspection-unit'
  | 'repair-crawler'
  | 'containment-unit'
  | 'gate-frame';

/** Machine AI states. Ordered roughly by escalation. */
export type MachineState =
  | 'dormant'
  | 'patrol'
  | 'inspect'
  | 'suspicious'
  | 'alert'
  | 'search'
  | 'pursue'
  | 'recover'
  | 'disabled';

export interface MachineAi {
  kind: MachineKind;
  state: MachineState;
  /** Seconds spent in the current state, for timeouts and de-escalation. */
  stateTime: number;
  /** 0..1 detection accumulator. Crossing 1 escalates. */
  awareness: number;
  /** Last position the machine believes the player occupied. */
  lastKnownPlayerPosition: Vec3 | null;
  /** Authored patrol route as world positions. */
  patrolRoute: Vec3[];
  patrolIndex: number;
  /** Seconds until the next perception evaluation. Throttled by distance. */
  perceptionCooldown: number;
}

export interface Perception {
  /** Half-angle of the vision cone in radians. */
  visionHalfAngle: number;
  visionRange: number;
  /** Range at which the machine notices the player regardless of facing. */
  proximityRange: number;
  hearingRange: number;
  /** Seconds of continuous sight required to fully escalate. */
  timeToDetect: number;
  /** Eye offset from the transform origin. */
  eyeOffset: Vec3;
}

/** Human NPC behaviour states. */
export type NpcState =
  | 'idle'
  | 'work'
  | 'walk-to'
  | 'observe'
  | 'converse'
  | 'react'
  | 'shelter'
  | 'scripted-task';

export interface NpcBehaviour {
  characterId: string;
  state: NpcState;
  stateTime: number;
  /** Authored anchor the NPC returns to when idle. */
  homePosition: Vec3;
  /** Entity or world position the NPC should face. */
  lookTarget: Vec3 | null;
  /** Named idle/work animation set for this NPC. */
  activityTag: string;
}

export interface NavAgent {
  destination: Vec3 | null;
  /** Current path as world positions, consumed front-first. */
  path: Vec3[];
  pathIndex: number;
  speed: number;
  radius: number;
  /** Seconds until the path may be recalculated. Throttles pathfinding. */
  repathCooldown: number;
  arrived: boolean;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export interface DialogueActor {
  characterId: string;
  /** Height above origin where speech audio and gaze originate. */
  headOffset: Vec3;
  speaking: boolean;
}

export type AudioBus = 'music' | 'ambience' | 'dialogue' | 'effects' | 'ui';

export interface AudioEmitter {
  clipId: string;
  bus: AudioBus;
  loop: boolean;
  volume: number;
  /** Distance at which the emitter reaches full attenuation. */
  maxDistance: number;
  refDistance: number;
  playing: boolean;
  /** Emitters outside the preset's budget are culled by distance. */
  priority: number;
}

// ---------------------------------------------------------------------------
// Persistence & lifetime
// ---------------------------------------------------------------------------

/**
 * Marks state that must survive a save/reload and sector unload.
 *
 * Gameplay state persists independently of loaded scene objects, so unloading
 * a sector must never lose progress.
 */
export interface Persistent {
  /** Stable authored id. Required: generated ids cannot be matched on reload. */
  id: string;
  /** Arbitrary serialisable state owned by whichever system manages it. */
  state: Record<string, unknown>;
}

/** Which sector owns this entity, for streaming unload. */
export interface SectorMember {
  sectorId: string;
}

/** Entities that should be despawned after a time, e.g. debris. */
export interface Lifetime {
  remaining: number;
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/** Zero-cost marker components. Presence is the whole signal. */
export interface Tags {
  isPlayer?: true;
  isCamera?: true;
  isMachine?: true;
  isNpc?: true;
  isWaterVolume?: true;
  isCheckpoint?: true;
  /** Excluded from streaming unload, e.g. the player. */
  isPersistentAcrossSectors?: true;
}

// ---------------------------------------------------------------------------
// Entity
// ---------------------------------------------------------------------------

/**
 * The complete entity shape. Every component is optional; queries narrow it.
 *
 * Kept as one flat interface rather than a union so miniplex's `with`/`without`
 * type narrowing works, and so adding a component does not require touching
 * every archetype.
 */
export interface Entity extends Tags {
  transform?: Transform;
  previousTransform?: PreviousTransform;
  velocity?: Velocity;

  renderable?: Renderable;
  lod?: LodLevels;
  animation?: AnimationState;

  body?: PhysicsBody;

  health?: Health;
  interactable?: Interactable;

  machineAi?: MachineAi;
  perception?: Perception;
  npc?: NpcBehaviour;
  navAgent?: NavAgent;

  dialogueActor?: DialogueActor;
  audioEmitter?: AudioEmitter;

  persistent?: Persistent;
  sector?: SectorMember;
  lifetime?: Lifetime;

  /** Human-readable name for debugging and diagnostics listings. */
  debugName?: string;
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function createTransform(
  position: Vec3 = vec3(),
  yaw = 0,
): Transform {
  return { position: { ...position }, yaw, pitch: 0, roll: 0, scale: 1 };
}

/** Squared distance. Avoids a sqrt in the common "is it within range" test. */
export function distanceSquared(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.sqrt(distanceSquared(a, b));
}

/** Horizontal distance, ignoring height. Used for most gameplay ranges. */
export function planarDistanceSquared(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}
