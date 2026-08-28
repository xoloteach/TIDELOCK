/**
 * Rapier physics world wrapper.
 *
 * Owns the single Rapier `World` and every rigid body in it. Nothing else in
 * the codebase imports Rapier: gameplay refers to bodies through opaque
 * numeric handles, so the physics backend stays replaceable and the ECS
 * (`PhysicsBody.handle`) never carries a WASM object.
 *
 * ## Fixed timestep
 *
 * `step()` advances the simulation by exactly one fixed step. There is
 * deliberately no `step(dt)` overload — Rapier integrates by
 * `world.timestep`, which is written once at construction from the same Hz as
 * `FixedStepLoop`. Passing a render delta here would make the simulation
 * frame-rate dependent and destroy determinism, which is the entire reason
 * the fixed-step design exists. If you find yourself wanting to vary the
 * timestep, call `step()` a different number of times instead.
 *
 * ## Handles
 *
 * Rapier's own handles are `u64`s reinterpreted as doubles, so they surface in
 * JS as denormals like `5e-324`. They compare correctly but are useless in a
 * diagnostics overlay or a save file. We therefore mint our own monotonically
 * increasing integer handles and keep a reverse index from Rapier's handle
 * back to ours for query results. Our handles are never reused, so a stale
 * handle always reads as "gone" rather than silently addressing a new body.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import type { Collider, RigidBody, World } from '@dimforge/rapier3d-compat';
import { CollisionLayer, type Vec3 } from '../ecs/components';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Opaque body identifier. Stable for the lifetime of the world. */
export type BodyHandle = number;

/** Quaternion. `components.ts` only models yaw, so physics carries its own. */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export type BodyKind = 'static' | 'dynamic' | 'kinematic';

export interface BodyTransform {
  position: Vec3;
  rotation: Quat;
}

export interface RaycastHit {
  /** The body that owns the hit collider, or `null` for a parentless collider. */
  handle: BodyHandle | null;
  /** World-space hit position. */
  point: Vec3;
  /** Surface normal at the hit point. */
  normal: Vec3;
  /** Distance along the ray, in metres. */
  distance: number;
}

export interface PhysicsCounters {
  /** Every rigid body, regardless of kind. */
  bodies: number;
  /** Bodies the island manager currently considers active. */
  awake: number;
  /** `bodies - awake`. Static bodies are never active, so they count here. */
  sleeping: number;
  colliders: number;
  /** Dynamic bodies this class explicitly put to sleep for being far away. */
  farAsleep: number;
}

export interface SleepUpdateResult {
  slept: number;
  woken: number;
}

/** Shared placement + filtering options for every body helper. */
export interface BodyOptions {
  position?: Vec3;
  rotation?: Quat;
  /**
   * Layers this body *is*, from `CollisionLayer`. Required: defaulting it
   * would silently put level geometry and the player on the same layer.
   */
  membership: number;
  /** Layers this body collides with. Defaults to every layer. */
  filter?: number;
  /** Debug label surfaced by diagnostics. */
  debugName?: string;
}

export interface ShapeMaterial {
  /** 0 = frictionless, 1 = high grip. Rapier's default is 0.5. */
  friction?: number;
  /** 0 = no bounce (default for this project), 1 = perfectly elastic. */
  restitution?: number;
}

export interface DynamicBodyOptions extends BodyOptions, ShapeMaterial {
  /** Explicit mass in kg. Omit to let Rapier derive it from shape density. */
  mass?: number;
  linearDamping?: number;
  angularDamping?: number;
  /** Continuous collision detection. Costly; reserve it for fast debris. */
  ccd?: boolean;
  /** Set false for bodies that must keep simulating while off-screen. */
  canSleep?: boolean;
}

export interface PhysicsWorldOptions {
  /** Simulation frequency. Must match `FixedStepLoop`'s Hz. */
  hz?: number;
  /** Gravity on Y. Positive values would make things fall upwards. */
  gravityY?: number;
  /**
   * Distance from the focus point beyond which dynamic bodies are slept.
   * Drive this from the active quality preset's `physicsFarDistance`
   * (22 on potato, 110 on cinematic) via `setFarSleepDistance`.
   */
  farSleepDistance?: number;
  /** Solver iterations. Higher is more rigid and more expensive. */
  numSolverIterations?: number;
}

// ---------------------------------------------------------------------------
// Collision groups
// ---------------------------------------------------------------------------

/** Every layer in `CollisionLayer`, for "collides with anything". */
export const ALL_LAYERS: number = Object.values(CollisionLayer).reduce(
  (mask, bit) => mask | bit,
  0,
);

/** Low 16 bits of a Rapier interaction-group word. */
const FILTER_MASK = 0xffff;

/**
 * Packs a membership/filter pair into Rapier's single-u32 interaction group.
 *
 * Rapier stores **membership in the high 16 bits and the filter in the low
 * 16 bits** of one u32. Two colliders `a` and `b` interact only when
 * *both* directions agree:
 *
 * ```
 * ((a >> 16) & b) != 0 && ((b >> 16) & a) != 0
 * ```
 *
 * i.e. a's membership must intersect b's filter *and* b's membership must
 * intersect a's filter. Passing the two halves in the wrong order, or
 * forgetting the shift, produces a word that silently disables collisions
 * with no error — hence one helper and no ad-hoc bit twiddling elsewhere.
 *
 * The `>>> 0` matters: `(0x8000 << 16)` is negative as a signed int32, and a
 * negative number is not a valid u32 for the WASM boundary.
 */
export function interactionGroups(membership: number, filter: number): number {
  return (((membership & FILTER_MASK) << 16) | (filter & FILTER_MASK)) >>> 0;
}

/** Extracts the membership half of a packed interaction group. */
export function groupMembership(groups: number): number {
  return (groups >>> 16) & FILTER_MASK;
}

/** Extracts the filter half of a packed interaction group. */
export function groupFilter(groups: number): number {
  return groups & FILTER_MASK;
}

/**
 * Mirrors Rapier's interaction test. Exported so tests and tooling can assert
 * a layer setup without instantiating a world.
 */
export function groupsInteract(a: number, b: number): boolean {
  return (groupMembership(a) & groupFilter(b)) !== 0
    && (groupMembership(b) & groupFilter(a)) !== 0;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface BodyRecord {
  handle: BodyHandle;
  body: RigidBody;
  colliders: Collider[];
  kind: BodyKind;
  groups: number;
  debugName: string | undefined;
}

/**
 * Rapier's `init()` loads and instantiates the inlined WASM module. It is
 * memoised here so creating several worlds (or several test cases) does not
 * re-instantiate it.
 */
let initPromise: Promise<void> | null = null;

function initRapier(): Promise<void> {
  initPromise ??= RAPIER.init();
  return initPromise;
}

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };
const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };

// ---------------------------------------------------------------------------
// PhysicsWorld
// ---------------------------------------------------------------------------

export class PhysicsWorld {
  /** Seconds per simulation step. Never varies. */
  readonly stepSeconds: number;
  readonly hz: number;

  private readonly world: World;
  private readonly records = new Map<BodyHandle, BodyRecord>();
  /** Rapier rigid-body handle -> our handle, for mapping query results back. */
  private readonly byRapierHandle = new Map<number, BodyHandle>();
  /** Dynamic bodies only, so sleep management does not walk static geometry. */
  private readonly dynamicHandles = new Set<BodyHandle>();
  /**
   * Bodies *this class* slept for being far from the focus point.
   *
   * Tracked separately from `RigidBody.isSleeping()` so distance-based waking
   * never disturbs a body Rapier slept on its own because it came to rest.
   * Waking resting crates every update would undo the optimisation entirely.
   */
  private readonly farAsleep = new Set<BodyHandle>();

  private nextHandle = 1;
  private stepIndex = 0;
  /**
   * True when a body has been added since the last `step()`.
   *
   * Rapier rebuilds the broad-phase BVH inside `step()`, so a *newly added*
   * collider is invisible to `raycast`/`intersectingBodies` until the next
   * step. Removals apply immediately (verified in the integration tests), and
   * only insertions are affected.
   *
   * This is not worked around by sneaking in a zero-length step: measurement
   * showed a `timestep = 0` step leaves positions untouched but still
   * perturbs velocities and contact caches, so two otherwise identical worlds
   * diverge within ~100 steps afterwards. Silently trading determinism for
   * query freshness would defeat the whole fixed-timestep design, so the
   * constraint is surfaced here instead of hidden.
   */
  private staleQueries = false;
  private farSleepDistance: number;
  /**
   * Hysteresis band, in metres. A body sleeps past `farSleepDistance` and only
   * wakes once it is this much closer, so a focus point hovering on the
   * boundary does not sleep/wake the same body every step.
   */
  private sleepHysteresis = 4;
  private disposed = false;

  /**
   * Scratch direction vector for raycasts.
   *
   * Safe to reuse because it is only live between normalisation and the
   * synchronous `castRayAndGetNormal` call — no user callback observes it.
   */
  private readonly scratchVec: Vec3 = { x: 0, y: 0, z: 0 };

  private constructor(options: PhysicsWorldOptions) {
    this.hz = options.hz ?? 60;
    this.stepSeconds = 1 / this.hz;
    this.farSleepDistance = options.farSleepDistance ?? 60;

    this.world = new RAPIER.World({ x: 0, y: options.gravityY ?? -9.81, z: 0 });

    // The integration timestep is pinned here and never touched again.
    // `world.step()` takes no dt; it always integrates by this value.
    this.world.timestep = this.stepSeconds;

    if (options.numSolverIterations !== undefined) {
      this.world.numSolverIterations = options.numSolverIterations;
    }
  }

  /**
   * Loads the Rapier WASM module and returns a ready world.
   *
   * The async work lives here rather than in the constructor so construction
   * stays synchronous and a half-initialised instance can never exist.
   */
  static async create(options: PhysicsWorldOptions = {}): Promise<PhysicsWorld> {
    await initRapier();
    return new PhysicsWorld(options);
  }

  // ---- Simulation -------------------------------------------------------

  /**
   * Advances the simulation by exactly one fixed step.
   *
   * Call this from `FixedStepLoop`'s fixedUpdate. Never scale it by, or pass
   * in, a render delta.
   */
  step(): void {
    this.assertLive();
    this.world.step();
    this.stepIndex += 1;
    // The broad and narrow phases were just rebuilt, so scene queries and
    // sensor intersections are current again.
    this.staleQueries = false;
  }

  /**
   * True if a body was added since the last `step()`.
   *
   * Scene queries reflect the world as of that step, so a body added this
   * frame will not be raycast against until the next one. In the normal loop
   * order (`step()` then gameplay systems) this is always false; if a system
   * spawns a body and immediately raycasts for it, this flag is why the hit is
   * missing.
   */
  get queriesStale(): boolean {
    return this.staleQueries;
  }

  /** Number of steps executed. Useful for determinism checks and replays. */
  get stepCount(): number {
    return this.stepIndex;
  }

  get gravityY(): number {
    return this.world.gravity.y;
  }

  // ---- Body creation ----------------------------------------------------

  /**
   * Level collision geometry. Baked per sector, never moves.
   *
   * By default the mesh is treated as unoriented, so triangle winding does not
   * matter. That is deliberate: a single flipped triangle in an exported
   * collision mesh would otherwise become an invisible hole in the floor, and
   * that bug is very hard to find from a bug report. Set `orientedMesh` only
   * for meshes with verified outward winding — it enables Rapier's internal
   * edge fixing, which stops characters catching on the seams between coplanar
   * triangles, but it makes back faces non-solid.
   */
  addStaticTrimesh(
    vertices: Float32Array,
    indices: Uint32Array,
    options: BodyOptions & { orientedMesh?: boolean },
  ): BodyHandle {
    if (indices.length % 3 !== 0) {
      throw new Error(
        `[physics] trimesh index count ${indices.length} is not a multiple of 3`,
      );
    }
    const flags = options.orientedMesh
      ? RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES
      : RAPIER.TriMeshFlags.MERGE_DUPLICATE_VERTICES
        | RAPIER.TriMeshFlags.DELETE_DEGENERATE_TRIANGLES;
    const desc = RAPIER.ColliderDesc.trimesh(vertices, indices, flags);
    return this.build('static', RAPIER.RigidBodyDesc.fixed(), [desc], options);
  }

  addStaticCuboid(halfExtents: Vec3, options: BodyOptions & ShapeMaterial): BodyHandle {
    const desc = RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z);
    applyMaterial(desc, options);
    return this.build('static', RAPIER.RigidBodyDesc.fixed(), [desc], options);
  }

  addDynamicCuboid(halfExtents: Vec3, options: DynamicBodyOptions): BodyHandle {
    const desc = RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z);
    applyMaterial(desc, options);
    if (options.mass !== undefined) desc.setMass(options.mass);
    return this.build('dynamic', this.dynamicDesc(options), [desc], options);
  }

  addDynamicBall(radius: number, options: DynamicBodyOptions): BodyHandle {
    const desc = RAPIER.ColliderDesc.ball(radius);
    applyMaterial(desc, options);
    if (options.mass !== undefined) desc.setMass(options.mass);
    return this.build('dynamic', this.dynamicDesc(options), [desc], options);
  }

  /**
   * The player capsule.
   *
   * Position-based kinematic: movement is authored by the controller and
   * written with `setNextKinematicPosition`, so the player never gets shoved
   * by physics but still sweeps against colliders.
   *
   * `halfHeight` excludes the end caps — total height is
   * `2 * halfHeight + 2 * radius`.
   */
  addKinematicCapsule(
    halfHeight: number,
    radius: number,
    options: BodyOptions,
  ): BodyHandle {
    const desc = RAPIER.ColliderDesc.capsule(halfHeight, radius);
    return this.build(
      'kinematic',
      RAPIER.RigidBodyDesc.kinematicPositionBased(),
      [desc],
      options,
    );
  }

  /**
   * A trigger volume. Reports overlaps but never blocks movement.
   *
   * Query it with `intersectingBodies(handle)` after `step()`.
   */
  addSensorCuboid(halfExtents: Vec3, options: BodyOptions): BodyHandle {
    const desc = RAPIER.ColliderDesc
      .cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
      .setSensor(true);
    return this.build('static', RAPIER.RigidBodyDesc.fixed(), [desc], options);
  }

  private dynamicDesc(options: DynamicBodyOptions): RAPIER.RigidBodyDesc {
    const desc = RAPIER.RigidBodyDesc.dynamic();
    if (options.linearDamping !== undefined) desc.setLinearDamping(options.linearDamping);
    if (options.angularDamping !== undefined) {
      desc.setAngularDamping(options.angularDamping);
    }
    if (options.ccd) desc.setCcdEnabled(true);
    if (options.canSleep === false) desc.setCanSleep(false);
    return desc;
  }

  private build(
    kind: BodyKind,
    bodyDesc: RAPIER.RigidBodyDesc,
    colliderDescs: RAPIER.ColliderDesc[],
    options: BodyOptions,
  ): BodyHandle {
    this.assertLive();

    const position = options.position ?? ORIGIN;
    const rotation = options.rotation ?? IDENTITY;
    bodyDesc.setTranslation(position.x, position.y, position.z);
    bodyDesc.setRotation(rotation);

    const groups = interactionGroups(options.membership, options.filter ?? ALL_LAYERS);

    const body = this.world.createRigidBody(bodyDesc);
    const colliders = colliderDescs.map((desc) => {
      desc.setCollisionGroups(groups);
      // Solver groups mirror collision groups: a pair that is not allowed to
      // generate contacts must not generate contact *forces* either.
      desc.setSolverGroups(groups);
      return this.world.createCollider(desc, body);
    });

    const handle = this.nextHandle++;
    this.records.set(handle, {
      handle,
      body,
      colliders,
      kind,
      groups,
      debugName: options.debugName,
    });
    this.byRapierHandle.set(body.handle, handle);
    if (kind === 'dynamic') this.dynamicHandles.add(handle);
    // New colliders enter the broad-phase BVH on the next step.
    this.staleQueries = true;

    return handle;
  }

  // ---- Body lifetime ----------------------------------------------------

  has(handle: BodyHandle): boolean {
    return this.records.has(handle);
  }

  /**
   * Frees a body and every collider attached to it.
   *
   * Returns false for an unknown handle rather than throwing: sector unload
   * legitimately races with gameplay removing the same body.
   */
  removeBody(handle: BodyHandle): boolean {
    this.assertLive();
    const record = this.records.get(handle);
    if (!record) return false;

    // removeRigidBody also removes the body's colliders and joints and wakes
    // anything that was touching it, so the colliders need no separate pass.
    this.world.removeRigidBody(record.body);

    this.records.delete(handle);
    this.byRapierHandle.delete(record.body.handle);
    this.dynamicHandles.delete(handle);
    this.farAsleep.delete(handle);
    return true;
  }

  /** Kind of an existing body, or `undefined` if the handle is stale. */
  getBodyKind(handle: BodyHandle): BodyKind | undefined {
    return this.records.get(handle)?.kind;
  }

  /** Packed interaction group of an existing body. */
  getBodyGroups(handle: BodyHandle): number | undefined {
    return this.records.get(handle)?.groups;
  }

  getDebugName(handle: BodyHandle): string | undefined {
    return this.records.get(handle)?.debugName;
  }

  // ---- Transforms -------------------------------------------------------

  /**
   * Reads a body's world transform so render sync can follow it.
   *
   * Pass `target` to reuse an object — this runs once per visible dynamic
   * body per frame, and allocating two objects each time is real GC pressure
   * on a phone.
   */
  getBodyTransform(handle: BodyHandle, target?: BodyTransform): BodyTransform | null {
    const record = this.records.get(handle);
    if (!record) return null;

    const t = record.body.translation();
    const r = record.body.rotation();
    const out = target ?? { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
    out.position.x = t.x;
    out.position.y = t.y;
    out.position.z = t.z;
    out.rotation.x = r.x;
    out.rotation.y = r.y;
    out.rotation.z = r.z;
    out.rotation.w = r.w;
    return out;
  }

  /** Position only. Cheaper than a full transform read for distance checks. */
  getBodyPosition(handle: BodyHandle, target?: Vec3): Vec3 | null {
    const record = this.records.get(handle);
    if (!record) return null;
    const t = record.body.translation();
    const out = target ?? { x: 0, y: 0, z: 0 };
    out.x = t.x;
    out.y = t.y;
    out.z = t.z;
    return out;
  }

  /** Linear velocity of a dynamic body. Zero for static bodies. */
  getLinearVelocity(handle: BodyHandle, target?: Vec3): Vec3 | null {
    const record = this.records.get(handle);
    if (!record) return null;
    const v = record.body.linvel();
    const out = target ?? { x: 0, y: 0, z: 0 };
    out.x = v.x;
    out.y = v.y;
    out.z = v.z;
    return out;
  }

  /**
   * Sets the target pose of a position-based kinematic body.
   *
   * Rapier interpolates to it during the next step, generating the velocity
   * needed to push dynamic bodies out of the way. Writing `setBodyPosition`
   * instead would teleport and miss contacts.
   */
  setNextKinematicPosition(handle: BodyHandle, position: Vec3, rotation?: Quat): boolean {
    const record = this.records.get(handle);
    if (!record || record.kind !== 'kinematic') return false;
    record.body.setNextKinematicTranslation(position);
    if (rotation) record.body.setNextKinematicRotation(rotation);
    return true;
  }

  /**
   * Teleports a body, skipping collision along the way.
   *
   * For checkpoint restore and spawn placement only — never for movement.
   */
  setBodyPosition(handle: BodyHandle, position: Vec3, wake = true): boolean {
    const record = this.records.get(handle);
    if (!record) return false;
    record.body.setTranslation(position, wake);
    if (wake) this.farAsleep.delete(handle);
    return true;
  }

  setLinearVelocity(handle: BodyHandle, velocity: Vec3, wake = true): boolean {
    const record = this.records.get(handle);
    if (!record || record.kind !== 'dynamic') return false;
    record.body.setLinvel(velocity, wake);
    if (wake) this.farAsleep.delete(handle);
    return true;
  }

  // ---- Sleep management -------------------------------------------------

  /**
   * Distance beyond which dynamic bodies are slept.
   *
   * Wire this to the quality system's `physicsFarDistance`. Lowering it wakes
   * nothing and sleeps more on the next `updateSleepStates` call; raising it
   * wakes bodies we previously slept as they fall back inside the band.
   */
  setFarSleepDistance(distance: number): void {
    if (!Number.isFinite(distance) || distance <= 0) {
      throw new Error(`[physics] farSleepDistance must be > 0, got ${distance}`);
    }
    this.farSleepDistance = distance;
    // Keep the hysteresis band proportional but never wider than the radius.
    this.sleepHysteresis = Math.min(4, distance * 0.25);
  }

  getFarSleepDistance(): number {
    return this.farSleepDistance;
  }

  /**
   * Sleeps dynamic bodies beyond `farSleepDistance` from `focus` and wakes
   * them when they come back inside the hysteresis band.
   *
   * A sleeping body is skipped entirely by the solver, so on a phone this is
   * the difference between simulating a whole sector's debris and simulating
   * the room the player is standing in. Call it a few times a second from the
   * fixed step, not every step — the set changes slowly.
   *
   * Only bodies slept *by this method* are woken by it: bodies Rapier slept
   * because they came to rest are left alone and will be woken by contact,
   * which is what should happen.
   */
  updateSleepStates(focus: Vec3): SleepUpdateResult {
    this.assertLive();

    const sleepAt = this.farSleepDistance * this.farSleepDistance;
    const wakeInside = Math.max(0, this.farSleepDistance - this.sleepHysteresis);
    const wakeAt = wakeInside * wakeInside;

    let slept = 0;
    let woken = 0;

    for (const handle of this.dynamicHandles) {
      const record = this.records.get(handle);
      if (!record) continue;

      const t = record.body.translation();
      const dx = t.x - focus.x;
      const dy = t.y - focus.y;
      const dz = t.z - focus.z;
      const d2 = dx * dx + dy * dy + dz * dz;

      if (d2 > sleepAt) {
        if (!this.farAsleep.has(handle) && !record.body.isSleeping()) {
          record.body.sleep();
          this.farAsleep.add(handle);
          slept += 1;
        }
      } else if (d2 < wakeAt && this.farAsleep.has(handle)) {
        record.body.wakeUp();
        this.farAsleep.delete(handle);
        woken += 1;
      }
    }

    return { slept, woken };
  }

  isSleeping(handle: BodyHandle): boolean | undefined {
    return this.records.get(handle)?.body.isSleeping();
  }

  /** True if this class slept the body for distance, not Rapier for rest. */
  isFarAsleep(handle: BodyHandle): boolean {
    return this.farAsleep.has(handle);
  }

  wakeBody(handle: BodyHandle): boolean {
    const record = this.records.get(handle);
    if (!record) return false;
    record.body.wakeUp();
    this.farAsleep.delete(handle);
    return true;
  }

  // ---- Queries ----------------------------------------------------------

  /**
   * Closest hit along a ray.
   *
   * `direction` is normalised internally so the returned `distance` is in
   * metres regardless of the caller's vector length — Rapier's raw
   * time-of-impact is only a distance when the direction is unit length, and
   * that is an easy bug to ship.
   *
   * `layers` is a `CollisionLayer` mask of what the ray may hit. It is packed
   * so the ray is a member of every layer (any collider willing to be hit is
   * hit) while only accepting the requested layers back.
   *
   * Reflects the world as of the last `step()`; see `queriesStale`.
   */
  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
    options: {
      layers?: number;
      /** false treats shapes as hollow, so a ray starting inside one exits it. */
      solid?: boolean;
      excludeBody?: BodyHandle;
    } = {},
  ): RaycastHit | null {
    this.assertLive();

    const length = Math.hypot(direction.x, direction.y, direction.z);
    if (length === 0 || !Number.isFinite(length) || maxDistance <= 0) return null;

    const dir = this.scratchVec;
    dir.x = direction.x / length;
    dir.y = direction.y / length;
    dir.z = direction.z / length;

    const ray = new RAPIER.Ray(origin, dir);
    const groups = interactionGroups(ALL_LAYERS, options.layers ?? ALL_LAYERS);
    const exclude = options.excludeBody !== undefined
      ? this.records.get(options.excludeBody)?.body
      : undefined;

    const hit = this.world.castRayAndGetNormal(
      ray,
      maxDistance,
      options.solid ?? true,
      undefined,
      groups,
      undefined,
      exclude,
    );
    if (!hit) return null;

    // Unit direction, so timeOfImpact is the distance in metres.
    const distance = hit.timeOfImpact;
    const parent = hit.collider.parent();

    return {
      handle: parent ? this.byRapierHandle.get(parent.handle) ?? null : null,
      point: {
        x: origin.x + dir.x * distance,
        y: origin.y + dir.y * distance,
        z: origin.z + dir.z * distance,
      },
      normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z },
      distance,
    };
  }

  /**
   * Bodies currently overlapping a sensor body.
   *
   * The narrow phase produces these pairs during `step()`, so this must be
   * read after stepping — before the first step it is always empty.
   */
  intersectingBodies(sensorHandle: BodyHandle): BodyHandle[] {
    this.assertLive();
    const record = this.records.get(sensorHandle);
    if (!record) return [];

    const found: BodyHandle[] = [];
    for (const collider of record.colliders) {
      this.world.intersectionPairsWith(collider, (other) => {
        const parent = other.parent();
        if (!parent) return;
        const handle = this.byRapierHandle.get(parent.handle);
        if (handle !== undefined && !found.includes(handle)) found.push(handle);
      });
    }
    return found;
  }

  /** True if the body's first collider is a sensor. */
  isSensor(handle: BodyHandle): boolean {
    const record = this.records.get(handle);
    return record ? record.colliders.some((c) => c.isSensor()) : false;
  }

  // ---- Diagnostics ------------------------------------------------------

  /**
   * Body/collider counts for the diagnostics overlay.
   *
   * `awake` is read from the island manager rather than tallied by polling
   * `isSleeping()` on every body, which would be O(n) over static geometry.
   */
  getCounters(): PhysicsCounters {
    if (this.disposed) {
      return { bodies: 0, awake: 0, sleeping: 0, colliders: 0, farAsleep: 0 };
    }

    let awake = 0;
    this.world.islands.forEachActiveRigidBodyHandle(() => {
      awake += 1;
    });

    const bodies = this.world.bodies.len();
    return {
      bodies,
      awake,
      sleeping: Math.max(0, bodies - awake),
      colliders: this.world.colliders.len(),
      farAsleep: this.farAsleep.size,
    };
  }

  /** Number of bodies this wrapper is tracking. Matches Rapier's own count. */
  get bodyCount(): number {
    return this.records.size;
  }

  get dynamicBodyCount(): number {
    return this.dynamicHandles.size;
  }

  /**
   * Snapshot of the whole simulation, for deterministic replay and debugging.
   *
   * Not the save format: it contains no gameplay state and is tied to this
   * exact Rapier build.
   */
  takeSnapshot(): Uint8Array {
    this.assertLive();
    return this.world.takeSnapshot();
  }

  // ---- Teardown ---------------------------------------------------------

  /**
   * Frees the Rapier world and every WASM allocation it owns.
   *
   * Idempotent, because sector teardown and app shutdown can both reach it.
   * Using the instance afterwards throws rather than reading freed WASM
   * memory, which would otherwise fault or return garbage.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.records.clear();
    this.byRapierHandle.clear();
    this.dynamicHandles.clear();
    this.farAsleep.clear();

    // Frees the bodies, colliders, pipelines and integration parameters too.
    this.world.free();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new Error('[physics] PhysicsWorld used after dispose()');
    }
  }
}

function applyMaterial(desc: RAPIER.ColliderDesc, material: ShapeMaterial): void {
  if (material.friction !== undefined) desc.setFriction(material.friction);
  // Default to no bounce: wet concrete and steel plate, not rubber.
  desc.setRestitution(material.restitution ?? 0);
}

/** Re-exported so callers can build layer masks without a second import. */
export { CollisionLayer };
