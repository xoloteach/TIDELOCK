/**
 * Kinematic player character controller.
 *
 * Mara's movement is *authored*, not simulated. The capsule is a
 * position-based kinematic body: this controller decides where the player is
 * allowed to be each fixed step and writes that pose with
 * `setNextKinematicPosition`. No force, impulse or velocity is ever applied to
 * it. A dynamic body would give us bouncing off kerbs, sliding down ramps under
 * gravity and a character that can be shoved by debris — none of which is
 * acceptable for a game where the player has to stand on a wet gantry and turn
 * a valve.
 *
 * ## Fixed timestep, and why the tests care
 *
 * `fixedUpdate(dt)` is the only entry point that moves anything, and `dt` is
 * always `FixedStepLoop.stepSeconds`. Nothing here reads a render delta. Spec
 * §66 lists "different movement speed with FPS" as a failure condition, so
 * distance travelled is asserted equal at 30 Hz and 60 Hz in
 * `tests/unit/playerController.test.ts`.
 *
 * Integration is chosen to make that true rather than approximately true:
 * horizontal displacement uses the mean of the pre- and post-acceleration
 * velocity, and vertical motion uses `v·dt + ½a·dt²`. Both are exact for
 * piecewise-constant acceleration, so jump apex, fall distance and travel
 * distance do not drift with the step size the way plain semi-implicit Euler
 * does.
 *
 * ## Collision is done here, with casts
 *
 * Rapier does not resolve collisions *for* a position-based kinematic body —
 * it will happily place it inside a wall — and `PhysicsWorld` deliberately
 * exposes no shape cast. So movement is a classic collide-and-slide built on
 * `PhysicsWorld.raycast`: the capsule is approximated by a small fan of rays
 * (three heights × three lateral offsets, each corrected for how far the
 * capsule surface actually protrudes at that offset). That is cheap enough to
 * run for one entity per step and honest about what it can see.
 *
 * Two consequences worth stating rather than discovering later:
 *
 *   - Scene queries reflect the world as of the last `PhysicsWorld.step()`.
 *     Geometry streamed in this step is invisible to the controller until the
 *     next one (`PhysicsWorld.queriesStale` says so).
 *   - Ray fans can miss geometry thinner than the gap between samples. Level
 *     collision is authored as solid slabs, not wires, so this is a tolerable
 *     trade for not writing a GJK sweep by hand.
 *
 * ## Stairs, slopes and the step envelope
 *
 * While grounded, horizontal casts start at `stepHeight` above the feet, so
 * kerbs, thresholds and stair treads are simply not obstacles — that is what
 * stops the snagging spec §66 calls out. The feet are then placed by a
 * downward probe that also starts at `stepHeight`, which is what lifts the
 * player onto the tread. Because those two heights match, there is no band in
 * which a step both blocks movement and fails to lift the player.
 *
 * A step-up is only accepted onto *walkable* ground with headroom, so the same
 * envelope cannot be used to ratchet up a 55° ramp: on steeper-than-max ground
 * the uphill component of velocity is projected out and a downhill slide
 * acceleration is applied instead.
 *
 * ## Crouching and the immutable collider
 *
 * Rapier collider shapes are fixed at creation and `PhysicsWorld` offers no
 * resize, so the capsule is built once at standing size. Crouching lowers the
 * capsule *centre* instead, keeping its top exactly at the crouched head
 * height. The part that ends up below the floor is inert: static geometry
 * never pushes a kinematic body, and machine line-of-sight rays therefore see
 * a correctly short player when she ducks under a duct.
 *
 * ## What this file does not own
 *
 * Look direction belongs to `PlayerCamera` — this controller asks for a yaw
 * through `getYaw()` and moves relative to it. Animation, audio and the HUD
 * read {@link PlayerController.snapshot} or subscribe to the events; none of
 * them are referenced here.
 */

import type { System } from '../../engine/ecs/GameWorld';
import {
  CollisionLayer,
  type Transform,
  type Vec3,
} from '../../engine/ecs/components';
import { Emitter, type Handler, type Unsubscribe } from '../../engine/events';
import type { AxisAction, ButtonAction } from '../../engine/input/actions';
import type { BodyHandle, PhysicsWorld } from '../../engine/physics/PhysicsWorld';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * The slice of the input layer movement needs.
 *
 * Declared structurally so the real `InputState` satisfies it without this
 * file importing it, and so tests can drive the controller with a plain fake
 * without faking the whole input stack.
 */
export interface PlayerInputPort {
  /** Axis value in [-1,1] for this step. */
  getAxis(action: AxisAction): number;
  /** Held right now. */
  isDown(action: ButtonAction): boolean;
  /** Went down during this step. True for exactly one step per press. */
  wasPressed(action: ButtonAction): boolean;
}

/**
 * Control preferences read every step, so changing them in the pause menu
 * takes effect without rebuilding the controller.
 *
 * Structurally satisfied by `Settings['controls']`.
 */
export interface PlayerControlPreferences {
  readonly holdToSprint: boolean;
  readonly holdToCrouch: boolean;
}

const DEFAULT_PREFERENCES: PlayerControlPreferences = {
  holdToSprint: true,
  holdToCrouch: true,
};

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * Movement state, for animation selection and for the camera.
 *
 * `land` is a short recovery window after a hard landing; it does not restrict
 * control. `vault` is fully scripted — input is ignored for its duration.
 */
export type PlayerMoveState =
  | 'walk'
  | 'sprint'
  | 'crouch'
  | 'jump'
  | 'air'
  | 'land'
  | 'vault';

/** Everything animation, audio, the HUD and the camera need. A snapshot. */
export interface PlayerSnapshot {
  /** Feet position in world space. */
  position: Vec3;
  /** Eye/camera pivot position in world space. */
  eyePosition: Vec3;
  velocity: Vec3;
  /** Horizontal speed in m/s. Vertical motion excluded. */
  horizontalSpeed: number;
  /** Direction the character model faces, radians. */
  facingYaw: number;
  state: PlayerMoveState;
  grounded: boolean;
  crouched: boolean;
  sprinting: boolean;
  /** Current capsule height in metres — animates between stand and crouch. */
  height: number;
  groundNormal: Vec3;
  /** Metres of water above the feet, as reported by the world. */
  waterDepth: number;
  /** Seconds since the player last left the ground. 0 while grounded. */
  airTime: number;
  /** Downward speed at the most recent landing, m/s. For impact audio/FX. */
  lastLandingImpact: number;
}

export type PlayerControllerEvents = {
  jumped: { position: Vec3 };
  /** `impactSpeed` is the downward speed at touchdown, in m/s. */
  landed: { position: Vec3; impactSpeed: number };
  stateChanged: { state: PlayerMoveState; previous: PlayerMoveState };
  vaultStarted: { from: Vec3; to: Vec3 };
};

/**
 * Movement tuning. Every number that decides how the player feels lives here
 * and nowhere else, so tuning is one table to read and one table to change.
 */
export interface PlayerControllerTuning {
  /** Capsule radius. Also the shoulder half-width for wall casts. */
  radius: number;
  /** Total standing capsule height, caps included. */
  standHeight: number;
  crouchHeight: number;
  /** Metres per second the capsule height moves between stand and crouch. */
  heightChangeSpeed: number;

  walkSpeed: number;
  sprintSpeed: number;
  crouchSpeed: number;
  /** Multiplier applied when the move input points behind the camera. */
  backpedalScale: number;

  groundAcceleration: number;
  groundDeceleration: number;
  /** Reduced but deliberately non-zero, so an air trajectory is steerable. */
  airAcceleration: number;
  /** Radians per second the character model turns toward its heading. */
  turnRate: number;

  /** Downward acceleration, m/s². Higher than 9.81 for a snappier arc. */
  gravity: number;
  /** Apex height of a standing jump on flat ground, metres. */
  jumpHeight: number;
  /** Downward speed clamp. Bounds the per-step sweep length. */
  terminalVelocity: number;

  /** Steepest ground that counts as standable. */
  maxSlopeDegrees: number;
  /** Obstacles below this are stepped over rather than collided with. */
  stepHeight: number;
  /** How far the feet are pulled down to stay glued to a descending slope. */
  snapDistance: number;
  /** Gap kept between the capsule surface and geometry. */
  skin: number;
  /** Downhill acceleration applied on steeper-than-max ground. */
  steepSlideAcceleration: number;
  /** Speed cap on a slide, m/s. Without it a long ramp becomes a catapult. */
  maxSlideSpeed: number;

  /** Grace period after walking off a ledge during which jump still works. */
  coyoteTime: number;
  /** How early a jump press is remembered and fired on landing. */
  jumpBufferTime: number;
  /** Grounding is suppressed for this long after a jump. */
  jumpGroundLockout: number;
  /** Duration of the `land` state after a hard landing. */
  landRecovery: number;
  /** Impact speed above which a landing counts as hard, m/s. */
  landImpactThreshold: number;

  /** Eye pivot distance below the top of the capsule. */
  eyeInset: number;

  /** Depth below which water does not slow the player at all. */
  waterAnkleDepth: number;
  /** Depth at which the water slowdown reaches its floor. */
  waterWaistDepth: number;
  /** Speed multiplier at or beyond `waterWaistDepth`. */
  waterDeepMultiplier: number;
  /** Sprinting is refused in water deeper than this. */
  waterSprintDepth: number;

  vaultEnabled: boolean;
  /** Tallest obstacle that can be vaulted, measured from the feet. */
  vaultMaxHeight: number;
  /** How far in front of the capsule surface an obstacle may be. */
  vaultReach: number;
  /** Distance past the capsule centre where the landing spot is looked for. */
  vaultLanding: number;
  vaultDuration: number;
  /** Extra clearance added over the obstacle top during the vault arc. */
  vaultClearance: number;
}

/**
 * Defaults tuned for a 1.8 m adult in wet municipal infrastructure: brisk but
 * not floaty, no bunny-hopping, no ice-skating stops.
 */
export const DEFAULT_PLAYER_TUNING: PlayerControllerTuning = {
  radius: 0.32,
  standHeight: 1.8,
  crouchHeight: 1.15,
  heightChangeSpeed: 4.5,

  walkSpeed: 3.1,
  sprintSpeed: 5.5,
  crouchSpeed: 1.35,
  backpedalScale: 0.72,

  groundAcceleration: 28,
  groundDeceleration: 34,
  airAcceleration: 8,
  turnRate: 12,

  gravity: 22,
  jumpHeight: 1.05,
  terminalVelocity: 45,

  maxSlopeDegrees: 48,
  stepHeight: 0.4,
  snapDistance: 0.45,
  skin: 0.02,
  steepSlideAcceleration: 12,
  maxSlideSpeed: 7,

  coyoteTime: 0.12,
  jumpBufferTime: 0.15,
  jumpGroundLockout: 0.08,
  landRecovery: 0.16,
  landImpactThreshold: 2.5,

  eyeInset: 0.12,

  waterAnkleDepth: 0.15,
  waterWaistDepth: 0.95,
  waterDeepMultiplier: 0.42,
  waterSprintDepth: 0.4,

  vaultEnabled: true,
  vaultMaxHeight: 1.2,
  vaultReach: 0.55,
  vaultLanding: 1.05,
  vaultDuration: 0.42,
  vaultClearance: 0.22,
};

export interface PlayerControllerOptions {
  physics: PhysicsWorld;
  input: PlayerInputPort;
  /**
   * Camera yaw in radians, read once per step. Movement is camera-relative, so
   * the camera must update its look *before* this system runs.
   */
  getYaw: () => number;
  /** Feet position to spawn at. */
  spawn?: Vec3;
  /**
   * Initial facing, radians. Defaults to 0 (facing -Z).
   *
   * Deliberately *not* read from `getYaw()`: the camera and the controller
   * reference each other, and calling into the camera from this constructor
   * would mean whichever is built second wins. Facing is authored with the
   * spawn point, and `getYaw()` is only ever called from `fixedUpdate`.
   */
  spawnYaw?: number;
  tuning?: Partial<PlayerControllerTuning>;
  /** Read every step so pause-menu changes apply immediately. */
  preferences?: () => PlayerControlPreferences;
  /**
   * Layers the capsule collides against.
   * Defaults to `World | Interactable` — water volumes are gameplay state, not
   * collision, and machines are pushed rather than climbed.
   */
  collisionLayers?: number;
  /** ECS transform kept in sync with the resolved pose. */
  transform?: Transform;
  debugName?: string;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const DOWN: Vec3 = { x: 0, y: -1, z: 0 };
const UP: Vec3 = { x: 0, y: 1, z: 0 };

/** Lateral fan offsets for ground/headroom probes, as a fraction of radius. */
const PROBE_SPREAD = 0.6;

/** Lateral fan offset for wall sweeps, as a fraction of radius. */
const SWEEP_SPREAD = 0.7;

/** A hit closer than this is treated as "origin is inside solid geometry". */
const INSIDE_EPSILON = 1e-4;

interface GroundInfo {
  grounded: boolean;
  /** World Y of the surface the feet should rest on. Only valid when hit. */
  groundY: number;
  normal: Vec3;
  /** True when a surface was found at all, walkable or not. */
  hit: boolean;
  /** False when the closest surface is steeper than `maxSlopeDegrees`. */
  walkable: boolean;
}

interface SweepResult {
  /** Metres the capsule may travel before its surface touches geometry. */
  allowed: number;
  normal: Vec3;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

// ---------------------------------------------------------------------------
// PlayerController
// ---------------------------------------------------------------------------

export class PlayerController implements System {
  static readonly SYSTEM_NAME = 'player-controller';

  readonly name = PlayerController.SYSTEM_NAME;

  readonly tuning: PlayerControllerTuning;

  private readonly physics: PhysicsWorld;
  private readonly input: PlayerInputPort;
  private readonly getYaw: () => number;
  private readonly readPreferences: () => PlayerControlPreferences;
  private readonly collisionLayers: number;
  private readonly transform: Transform | undefined;
  private readonly emitter = new Emitter<PlayerControllerEvents>();

  private readonly handle: BodyHandle;
  /** Half the standing capsule height. The collider never changes size. */
  private readonly standHalfHeight: number;
  private readonly cosMaxSlope: number;

  // ---- Simulation state -------------------------------------------------
  private readonly positionValue: Vec3;
  private readonly previousPositionValue: Vec3;
  private readonly velocityValue: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly groundNormalValue: Vec3 = { x: 0, y: 1, z: 0 };
  private readonly carryVelocity: Vec3 = { x: 0, y: 0, z: 0 };

  private heightValue: number;
  private facingYawValue: number;
  private stateValue: PlayerMoveState = 'air';

  private groundedValue = false;
  private crouchedValue = false;
  private sprintingValue = false;
  private sprintLatch = false;
  private crouchLatch = false;

  private coyoteTimer = 0;
  private jumpBufferTimer = 0;
  private groundLockout = 0;
  private landTimer = 0;
  private airTimeValue = 0;
  private jumpedThisAirtime = false;
  private lastLandingImpactValue = 0;

  private waterDepthValue = 0;
  private movementEnabled = true;

  private vaultActive = false;
  private vaultElapsed = 0;
  private readonly vaultFrom: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly vaultTo: Vec3 = { x: 0, y: 0, z: 0 };
  private vaultLift = 0;

  // ---- Scratch ----------------------------------------------------------
  // One controller exists, but it runs 60 times a second forever; allocating
  // here would be pure GC pressure on a phone.
  private readonly scratchOrigin: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly scratchDir: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly scratchGround: GroundInfo = {
    grounded: false,
    groundY: 0,
    normal: { x: 0, y: 1, z: 0 },
    hit: false,
    walkable: false,
  };
  private readonly scratchSweep: SweepResult = {
    allowed: 0,
    normal: { x: 0, y: 0, z: 0 },
  };

  constructor(options: PlayerControllerOptions) {
    this.tuning = { ...DEFAULT_PLAYER_TUNING, ...options.tuning };
    this.physics = options.physics;
    this.input = options.input;
    this.getYaw = options.getYaw;
    this.readPreferences = options.preferences ?? (() => DEFAULT_PREFERENCES);
    this.collisionLayers =
      options.collisionLayers ?? (CollisionLayer.World | CollisionLayer.Interactable);
    this.transform = options.transform;

    const spawn = options.spawn ?? { x: 0, y: 0, z: 0 };
    this.positionValue = { x: spawn.x, y: spawn.y, z: spawn.z };
    this.previousPositionValue = { x: spawn.x, y: spawn.y, z: spawn.z };
    this.heightValue = this.tuning.standHeight;
    this.facingYawValue = options.spawnYaw ?? 0;

    this.standHalfHeight = this.tuning.standHeight / 2;
    this.cosMaxSlope = Math.cos((this.tuning.maxSlopeDegrees * Math.PI) / 180);

    const capsuleHalf = this.standHalfHeight - this.tuning.radius;
    if (capsuleHalf <= 0) {
      throw new Error(
        `[player] standHeight ${this.tuning.standHeight} is too short for radius ${this.tuning.radius}`,
      );
    }

    this.handle = this.physics.addKinematicCapsule(capsuleHalf, this.tuning.radius, {
      position: { x: spawn.x, y: spawn.y + this.standHalfHeight, z: spawn.z },
      membership: CollisionLayer.Player,
      debugName: options.debugName ?? 'player',
    });

    this.syncOutputs();
  }

  // -------------------------------------------------------------------------
  // Subscription
  // -------------------------------------------------------------------------

  on<K extends keyof PlayerControllerEvents>(
    event: K,
    handler: Handler<PlayerControllerEvents[K]>,
  ): Unsubscribe {
    return this.emitter.on(event, handler);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Physics handle of the capsule, for the ECS `PhysicsBody` component. */
  get bodyHandle(): BodyHandle {
    return this.handle;
  }

  /** Feet position. Live reference — treat as read-only. */
  get position(): Vec3 {
    return this.positionValue;
  }

  /** Feet position at the end of the previous step, for render interpolation. */
  get previousPosition(): Vec3 {
    return this.previousPositionValue;
  }

  /** Camera/eye pivot. Allocates; call it once per frame at most. */
  get eyePosition(): Vec3 {
    return {
      x: this.positionValue.x,
      y: this.positionValue.y + this.heightValue - this.tuning.eyeInset,
      z: this.positionValue.z,
    };
  }

  get velocity(): Vec3 {
    return this.velocityValue;
  }

  get horizontalSpeed(): number {
    return Math.hypot(this.velocityValue.x, this.velocityValue.z);
  }

  get state(): PlayerMoveState {
    return this.stateValue;
  }

  get grounded(): boolean {
    return this.groundedValue;
  }

  get crouched(): boolean {
    return this.crouchedValue;
  }

  get sprinting(): boolean {
    return this.sprintingValue;
  }

  /** Current capsule height, mid-transition included. */
  get height(): number {
    return this.heightValue;
  }

  get facingYaw(): number {
    return this.facingYawValue;
  }

  get groundNormal(): Vec3 {
    return this.groundNormalValue;
  }

  get waterDepth(): number {
    return this.waterDepthValue;
  }

  get airTime(): number {
    return this.airTimeValue;
  }

  get lastLandingImpact(): number {
    return this.lastLandingImpactValue;
  }

  /** Seconds of coyote grace left. 0 when grounded or expired. */
  get coyoteRemaining(): number {
    return this.coyoteTimer;
  }

  /** Seconds a buffered jump press stays live. 0 when none is pending. */
  get jumpBufferRemaining(): number {
    return this.jumpBufferTimer;
  }

  get vaulting(): boolean {
    return this.vaultActive;
  }

  /** True when there is headroom for the full standing capsule. */
  get canStandUp(): boolean {
    return (
      this.measureHeadroom(
        this.positionValue.x,
        this.positionValue.y,
        this.positionValue.z,
        this.tuning.standHeight + 4 * this.tuning.skin,
      ) >= this.tuning.standHeight + this.tuning.skin
    );
  }

  /** Fills and returns a snapshot. Pass `target` to avoid allocating. */
  snapshot(target?: PlayerSnapshot): PlayerSnapshot {
    const out: PlayerSnapshot = target ?? {
      position: { x: 0, y: 0, z: 0 },
      eyePosition: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      horizontalSpeed: 0,
      facingYaw: 0,
      state: 'walk',
      grounded: false,
      crouched: false,
      sprinting: false,
      height: 0,
      groundNormal: { x: 0, y: 1, z: 0 },
      waterDepth: 0,
      airTime: 0,
      lastLandingImpact: 0,
    };

    out.position.x = this.positionValue.x;
    out.position.y = this.positionValue.y;
    out.position.z = this.positionValue.z;
    out.eyePosition.x = this.positionValue.x;
    out.eyePosition.y = this.positionValue.y + this.heightValue - this.tuning.eyeInset;
    out.eyePosition.z = this.positionValue.z;
    out.velocity.x = this.velocityValue.x;
    out.velocity.y = this.velocityValue.y;
    out.velocity.z = this.velocityValue.z;
    out.horizontalSpeed = this.horizontalSpeed;
    out.facingYaw = this.facingYawValue;
    out.state = this.stateValue;
    out.grounded = this.groundedValue;
    out.crouched = this.crouchedValue;
    out.sprinting = this.sprintingValue;
    out.height = this.heightValue;
    out.groundNormal.x = this.groundNormalValue.x;
    out.groundNormal.y = this.groundNormalValue.y;
    out.groundNormal.z = this.groundNormalValue.z;
    out.waterDepth = this.waterDepthValue;
    out.airTime = this.airTimeValue;
    out.lastLandingImpact = this.lastLandingImpactValue;

    return out;
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Metres of water standing above the feet.
   *
   * Pushed in by the world/water system rather than sampled here: water height
   * is gameplay state and must not depend on a render shader (spec §68).
   */
  setWaterDepth(depth: number): void {
    this.waterDepthValue = Number.isFinite(depth) ? Math.max(0, depth) : 0;
  }

  /**
   * Velocity of the surface the player is standing on, m/s.
   *
   * Applied only while grounded, so stepping off a moving platform hands the
   * player back to plain ballistics. Fed by whichever system animates the
   * platform; zero when there is none.
   */
  setGroundCarryVelocity(velocity: Vec3): void {
    this.carryVelocity.x = Number.isFinite(velocity.x) ? velocity.x : 0;
    this.carryVelocity.y = Number.isFinite(velocity.y) ? velocity.y : 0;
    this.carryVelocity.z = Number.isFinite(velocity.z) ? velocity.z : 0;
  }

  /**
   * Suspends player agency without freezing the simulation.
   *
   * Dialogue, cutscenes and menus use this. Gravity still applies, so a
   * conversation that starts mid-air ends with the player on the floor rather
   * than hovering.
   */
  setMovementEnabled(enabled: boolean): void {
    this.movementEnabled = enabled;
    if (!enabled) {
      this.sprintLatch = false;
      this.jumpBufferTimer = 0;
    }
  }

  get movementIsEnabled(): boolean {
    return this.movementEnabled;
  }

  /**
   * Teleports the player: checkpoint restore, sector transition, spawn.
   *
   * Skips collision along the way by design, so the destination must be valid.
   * Velocity and all feel timers are cleared — a coyote grace carried across a
   * load would let the player jump out of a cutscene.
   */
  teleport(position: Vec3, yaw?: number): void {
    this.positionValue.x = position.x;
    this.positionValue.y = position.y;
    this.positionValue.z = position.z;
    this.previousPositionValue.x = position.x;
    this.previousPositionValue.y = position.y;
    this.previousPositionValue.z = position.z;

    this.velocityValue.x = 0;
    this.velocityValue.y = 0;
    this.velocityValue.z = 0;
    this.coyoteTimer = 0;
    this.jumpBufferTimer = 0;
    this.groundLockout = 0;
    this.landTimer = 0;
    this.airTimeValue = 0;
    this.jumpedThisAirtime = false;
    this.vaultActive = false;
    if (yaw !== undefined) this.facingYawValue = yaw;

    this.physics.setBodyPosition(this.handle, {
      x: position.x,
      y: position.y + this.standHalfHeight,
      z: position.z,
    });
    this.syncOutputs();
  }

  dispose(): void {
    this.physics.removeBody(this.handle);
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  fixedUpdate(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;

    this.previousPositionValue.x = this.positionValue.x;
    this.previousPositionValue.y = this.positionValue.y;
    this.previousPositionValue.z = this.positionValue.z;

    const previousState = this.stateValue;

    if (this.vaultActive) {
      this.advanceVault(dt);
      this.finishStep(previousState);
      return;
    }

    this.groundLockout = Math.max(0, this.groundLockout - dt);
    this.landTimer = Math.max(0, this.landTimer - dt);
    this.jumpBufferTimer = Math.max(0, this.jumpBufferTimer - dt);

    // ---- 1. Ground state at the start of the step -----------------------
    const wasGrounded = this.groundedValue;
    const ascending = this.velocityValue.y > 0.1;
    const ground = this.probeStanding();
    let grounded = ground.grounded && !ascending && this.groundLockout <= 0;

    if (grounded) {
      this.groundNormalValue.x = ground.normal.x;
      this.groundNormalValue.y = ground.normal.y;
      this.groundNormalValue.z = ground.normal.z;
      this.coyoteTimer = this.tuning.coyoteTime;
      this.airTimeValue = 0;
    } else {
      this.coyoteTimer = Math.max(0, this.coyoteTimer - dt);
      this.airTimeValue += dt;
    }

    // Touching ground that is too steep to stand on. Not standing, but not in
    // free fall either: she slides, and cannot push uphill.
    const steepContact = !grounded && ground.hit && !ground.walkable;
    if (steepContact) {
      this.groundNormalValue.x = ground.normal.x;
      this.groundNormalValue.y = ground.normal.y;
      this.groundNormalValue.z = ground.normal.z;
    }

    // ---- 2. Stance ------------------------------------------------------
    const prefs = this.readPreferences();
    const wantsCrouch = this.resolveCrouchIntent(prefs);
    const wantsSprint = this.resolveSprintIntent(prefs);
    this.updateStance(dt, wantsCrouch);

    // ---- 3. Desired direction -------------------------------------------
    const yaw = this.getYaw();
    let inputX = 0;
    let inputY = 0;
    if (this.movementEnabled) {
      inputX = clamp(this.input.getAxis('moveX'), -1, 1);
      inputY = clamp(this.input.getAxis('moveY'), -1, 1);
    }
    let inputMagnitude = Math.hypot(inputX, inputY);
    if (inputMagnitude > 1) {
      inputX /= inputMagnitude;
      inputY /= inputMagnitude;
      inputMagnitude = 1;
    }

    // yaw = 0 faces -Z, matching the renderer's default camera forward.
    const forwardX = -Math.sin(yaw);
    const forwardZ = -Math.cos(yaw);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);

    let wishX = forwardX * inputY + rightX * inputX;
    let wishZ = forwardZ * inputY + rightZ * inputX;
    const wishLength = Math.hypot(wishX, wishZ);
    if (wishLength > 1e-6) {
      wishX /= wishLength;
      wishZ /= wishLength;
    }

    // ---- 4. Jump / vault ------------------------------------------------
    if (this.movementEnabled && this.input.wasPressed('jump')) {
      this.jumpBufferTimer = this.tuning.jumpBufferTime;
    }

    if (this.jumpBufferTimer > 0 && (grounded || this.coyoteTimer > 0)) {
      if (
        grounded
        && inputMagnitude > 0.5
        && this.tryStartVault(wishX, wishZ)
      ) {
        this.jumpBufferTimer = 0;
        this.finishStep(previousState);
        return;
      }

      // Jumping out of a crouch is refused rather than silently standing the
      // player up into a duct.
      if (!this.crouchedValue || this.canStandUp) {
        this.velocityValue.y = Math.sqrt(
          2 * this.tuning.gravity * this.tuning.jumpHeight,
        );
        this.jumpBufferTimer = 0;
        this.coyoteTimer = 0;
        this.groundLockout = this.tuning.jumpGroundLockout;
        this.jumpedThisAirtime = true;
        grounded = false;
        this.landTimer = 0;
        this.emitter.emit('jumped', { position: { ...this.positionValue } });
      }
    }

    // ---- 5. Horizontal velocity -----------------------------------------
    const targetSpeed = this.targetSpeed(wantsSprint, inputX, inputY, inputMagnitude);
    this.sprintingValue =
      grounded && wantsSprint && !this.crouchedValue && targetSpeed > this.tuning.walkSpeed;

    const beforeX = this.velocityValue.x;
    const beforeZ = this.velocityValue.z;

    if (grounded) {
      this.accelerateGround(dt, wishX, wishZ, targetSpeed, inputMagnitude);
    } else {
      this.accelerateAir(dt, wishX, wishZ, targetSpeed, inputMagnitude);
      if (steepContact) {
        this.blockUphill(this.groundNormalValue);
        this.applySteepSlide(dt);
      }
    }

    // Mean-velocity integration: exact for piecewise-constant acceleration, so
    // distance travelled does not depend on the step size.
    let moveX = 0.5 * (beforeX + this.velocityValue.x) * dt;
    let moveZ = 0.5 * (beforeZ + this.velocityValue.z) * dt;

    if (grounded) {
      moveX += this.carryVelocity.x * dt;
      moveZ += this.carryVelocity.z * dt;
    }

    // ---- 6. Vertical velocity -------------------------------------------
    // The generous standing tolerance means a fast fall can read as grounded
    // one step before touchdown. Treating that as "resting" would zero the
    // descent velocity, swallow the impact and pop her up by up to the
    // tolerance, so it only counts as resting when she really is at rest.
    const priorDescent = Math.max(0, -this.velocityValue.y);
    const resting =
      grounded && this.velocityValue.y <= 0 && (wasGrounded || priorDescent < 0.5);

    let moveY: number;
    let descentSpeed: number;
    if (resting) {
      // No accumulated gravity, so a slope walk does not build up a hidden
      // 20 m/s of downward velocity. Vertical motion of a moving platform is
      // followed by the step/snap envelope below rather than by a carry term,
      // which keeps the player grounded throughout.
      this.velocityValue.y = 0;
      moveY = 0;
      descentSpeed = 0;
    } else {
      const vy = this.velocityValue.y;
      moveY = vy * dt - 0.5 * this.tuning.gravity * dt * dt;
      this.velocityValue.y = Math.max(
        vy - this.tuning.gravity * dt,
        -this.tuning.terminalVelocity,
      );
      descentSpeed = Math.max(0, -this.velocityValue.y);
    }

    // ---- 7. Move --------------------------------------------------------
    this.moveHorizontal(moveX, moveZ, grounded);
    grounded = this.resolveVertical(moveY, grounded, wasGrounded, descentSpeed);

    // ---- 8. Facing ------------------------------------------------------
    if (inputMagnitude > 0.05 && wishLength > 1e-6) {
      this.turnToward(Math.atan2(-wishX, -wishZ), dt);
    }

    this.groundedValue = grounded;
    this.resolveState(grounded);
    this.finishStep(previousState);
  }

  // -------------------------------------------------------------------------
  // Stance
  // -------------------------------------------------------------------------

  private resolveCrouchIntent(prefs: PlayerControlPreferences): boolean {
    if (!this.movementEnabled) return this.crouchedValue && !this.canStandUp;

    if (prefs.holdToCrouch) {
      this.crouchLatch = false;
      return this.input.isDown('crouch');
    }
    if (this.input.wasPressed('crouch')) this.crouchLatch = !this.crouchLatch;
    return this.crouchLatch;
  }

  private resolveSprintIntent(prefs: PlayerControlPreferences): boolean {
    if (!this.movementEnabled) return false;

    if (prefs.holdToSprint) {
      this.sprintLatch = false;
      return this.input.isDown('sprint');
    }
    if (this.input.wasPressed('sprint')) this.sprintLatch = !this.sprintLatch;
    return this.sprintLatch;
  }

  /**
   * Moves the capsule height toward the requested stance.
   *
   * Standing up is refused outright when the full standing capsule does not
   * fit — deliberately all-or-nothing. Partial heights would leave the player
   * in a stance with no animation and no clear rule about what she can walk
   * under.
   */
  private updateStance(dt: number, wantsCrouch: boolean): void {
    const target = wantsCrouch
      ? this.tuning.crouchHeight
      : this.canStandUp
        ? this.tuning.standHeight
        : this.tuning.crouchHeight;

    const step = this.tuning.heightChangeSpeed * dt;
    if (target > this.heightValue) {
      this.heightValue = Math.min(target, this.heightValue + step);
    } else if (target < this.heightValue) {
      this.heightValue = Math.max(target, this.heightValue - step);
    }

    this.crouchedValue = this.heightValue < this.tuning.standHeight - 0.02;
  }

  // -------------------------------------------------------------------------
  // Velocity
  // -------------------------------------------------------------------------

  private targetSpeed(
    wantsSprint: boolean,
    inputX: number,
    inputY: number,
    magnitude: number,
  ): number {
    if (magnitude < 0.02) return 0;

    let speed: number;
    if (this.crouchedValue) {
      speed = this.tuning.crouchSpeed;
    } else if (wantsSprint && this.waterDepthValue <= this.tuning.waterSprintDepth) {
      speed = this.tuning.sprintSpeed;
    } else {
      speed = this.tuning.walkSpeed;
    }

    // Backpedalling is slower, and a sideways-plus-back input scales between
    // the two rather than snapping at exactly 90°.
    if (inputY < 0) {
      const backness = -inputY / Math.max(1e-6, Math.hypot(inputX, inputY));
      speed *= 1 - (1 - this.tuning.backpedalScale) * backness;
    }

    return speed * Math.min(1, magnitude) * this.waterSpeedMultiplier();
  }

  /**
   * Shallow water drags: nothing at ankle depth, down to a floor multiplier at
   * waist depth. Deeper water is not swimmable in this game, so the multiplier
   * simply stays at its floor and level design keeps the player out.
   */
  private waterSpeedMultiplier(): number {
    const depth = this.waterDepthValue;
    const { waterAnkleDepth, waterWaistDepth, waterDeepMultiplier } = this.tuning;
    if (depth <= waterAnkleDepth) return 1;
    if (depth >= waterWaistDepth) return waterDeepMultiplier;
    const t = (depth - waterAnkleDepth) / (waterWaistDepth - waterAnkleDepth);
    return 1 + (waterDeepMultiplier - 1) * t;
  }

  private accelerateGround(
    dt: number,
    wishX: number,
    wishZ: number,
    targetSpeed: number,
    magnitude: number,
  ): void {
    const desiredX = wishX * targetSpeed;
    const desiredZ = wishZ * targetSpeed;
    const rate =
      magnitude > 0.02 ? this.tuning.groundAcceleration : this.tuning.groundDeceleration;

    this.approach(dt, desiredX, desiredZ, rate);
  }

  private accelerateAir(
    dt: number,
    wishX: number,
    wishZ: number,
    targetSpeed: number,
    magnitude: number,
  ): void {
    if (magnitude <= 0.02) return; // No air drag: a jump arc stays a parabola.
    this.approach(dt, wishX * targetSpeed, wishZ * targetSpeed, this.tuning.airAcceleration);
  }

  /** Moves horizontal velocity toward a target at a fixed rate. */
  private approach(dt: number, desiredX: number, desiredZ: number, rate: number): void {
    const dx = desiredX - this.velocityValue.x;
    const dz = desiredZ - this.velocityValue.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 1e-6) return;

    const change = Math.min(distance, rate * dt);
    this.velocityValue.x += (dx / distance) * change;
    this.velocityValue.z += (dz / distance) * change;
  }

  /**
   * On steeper-than-max ground, gravity wins: accelerate downhill, up to a cap.
   *
   * The cap matters. Unbounded slide acceleration on a long ramp is spec §66's
   * "random launch" — the player arrives at the bottom at 25 m/s and shoots off
   * the end.
   */
  private applySteepSlide(dt: number): void {
    const n = this.groundNormalValue;
    if (n.y >= this.cosMaxSlope) return;

    const horizontal = Math.hypot(n.x, n.z);
    if (horizontal < 1e-6) return;

    // The horizontal part of a surface normal points downhill.
    const dx = n.x / horizontal;
    const dz = n.z / horizontal;
    const along = this.velocityValue.x * dx + this.velocityValue.z * dz;
    if (along >= this.tuning.maxSlideSpeed) return;

    const add = Math.min(
      this.tuning.steepSlideAcceleration * dt,
      this.tuning.maxSlideSpeed - along,
    );
    this.velocityValue.x += dx * add;
    this.velocityValue.z += dz * add;
  }

  private turnToward(targetYaw: number, dt: number): void {
    let delta = targetYaw - this.facingYawValue;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;

    const maxStep = this.tuning.turnRate * dt;
    this.facingYawValue += clamp(delta, -maxStep, maxStep);
  }

  // -------------------------------------------------------------------------
  // Movement resolution
  // -------------------------------------------------------------------------

  /**
   * Collide-and-slide in the horizontal plane.
   *
   * Up to three passes: hit a wall, consume the travel up to it, project the
   * remainder onto the wall plane, try again. Three is enough for an inside
   * corner — the fourth pass would only ever be blocked again.
   */
  private moveHorizontal(moveX: number, moveZ: number, grounded: boolean): void {
    let remainingX = moveX;
    let remainingZ = moveZ;

    for (let pass = 0; pass < 3; pass += 1) {
      const length = Math.hypot(remainingX, remainingZ);
      if (length < 1e-7) return;

      const dirX = remainingX / length;
      const dirZ = remainingZ / length;

      const sweep = this.sweepHorizontal(dirX, dirZ, length, grounded);
      if (!sweep || sweep.allowed >= length) {
        this.positionValue.x += remainingX;
        this.positionValue.z += remainingZ;
        return;
      }

      const allowed = Math.max(0, sweep.allowed);
      this.positionValue.x += dirX * allowed;
      this.positionValue.z += dirZ * allowed;

      // Project both the leftover motion and the velocity onto the wall so the
      // player slides along it instead of stopping dead or storing up speed.
      const nx = sweep.normal.x;
      const nz = sweep.normal.z;
      const nLength = Math.hypot(nx, nz);
      if (nLength < 1e-6) return;

      const unx = nx / nLength;
      const unz = nz / nLength;

      const leftover = length - allowed;
      let restX = dirX * leftover;
      let restZ = dirZ * leftover;
      const into = restX * unx + restZ * unz;
      if (into < 0) {
        restX -= unx * into;
        restZ -= unz * into;
      }

      const vInto = this.velocityValue.x * unx + this.velocityValue.z * unz;
      if (vInto < 0) {
        this.velocityValue.x -= unx * vInto;
        this.velocityValue.z -= unz * vInto;
      }

      remainingX = restX;
      remainingZ = restZ;
    }
  }

  /**
   * Horizontal capsule sweep, approximated by a ray fan.
   *
   * While grounded the fan starts at `stepHeight`, so treads and kerbs are
   * invisible to it and the ground resolve lifts the player instead. In the
   * air it starts at the bottom cap, because there is nothing to step onto.
   */
  private sweepHorizontal(
    dirX: number,
    dirZ: number,
    distance: number,
    grounded: boolean,
  ): SweepResult | null {
    const { radius, skin, stepHeight } = this.tuning;
    const height = this.heightValue;
    const bottom = grounded ? stepHeight : radius;
    const top = Math.max(bottom, height - radius);
    const middle = clamp((bottom + top) * 0.5, bottom, top);

    // Perpendicular to the travel direction, in the horizontal plane.
    const perpX = dirZ;
    const perpZ = -dirX;
    const spread = radius * SWEEP_SPREAD;

    this.scratchDir.x = dirX;
    this.scratchDir.y = 0;
    this.scratchDir.z = dirZ;

    let best = Number.POSITIVE_INFINITY;
    let normalX = 0;
    let normalY = 0;
    let normalZ = 0;
    let found = false;

    for (let h = 0; h < 3; h += 1) {
      const localY = h === 0 ? bottom : h === 1 ? middle : top;
      if (h === 2 && top - bottom < 1e-3) break;

      for (let s = -1; s <= 1; s += 1) {
        const offset = spread * s;
        // How far the capsule surface protrudes along `dir` at this offset.
        const extent = Math.sqrt(Math.max(0, radius * radius - offset * offset));

        this.scratchOrigin.x = this.positionValue.x + perpX * offset;
        this.scratchOrigin.y = this.positionValue.y + localY;
        this.scratchOrigin.z = this.positionValue.z + perpZ * offset;

        const hit = this.physics.raycast(
          this.scratchOrigin,
          this.scratchDir,
          distance + extent + skin,
          { layers: this.collisionLayers, excludeBody: this.handle },
        );
        if (!hit) continue;

        const allowed = hit.distance - extent - skin;
        if (allowed < best) {
          best = allowed;
          normalX = hit.normal.x;
          normalY = hit.normal.y;
          normalZ = hit.normal.z;
          found = true;
        }
      }
    }

    if (!found) return null;

    this.scratchSweep.allowed = best;
    this.scratchSweep.normal.x = normalX;
    this.scratchSweep.normal.y = normalY;
    this.scratchSweep.normal.z = normalZ;
    return this.scratchSweep;
  }

  /**
   * Applies vertical motion, then places the feet.
   *
   * The downward probe is always at least as long as the fall this step, which
   * is what makes tunnelling impossible: at terminal velocity and a 30 Hz step
   * that is a 1.5 m sweep, and the floor is found inside it.
   *
   * While grounded the probe is extended by `snapDistance` so the feet stay
   * glued to a descending slope or a shallow step instead of leaving the
   * ground and falling again every step — spec §66's "vibrating".
   *
   * @returns whether the player is grounded after the move.
   */
  private resolveVertical(
    moveY: number,
    grounded: boolean,
    wasGrounded: boolean,
    descentSpeed: number,
  ): boolean {
    const { skin, stepHeight, snapDistance } = this.tuning;

    if (moveY > 0) {
      const clearance = this.measureHeadroom(
        this.positionValue.x,
        this.positionValue.y,
        this.positionValue.z,
        this.heightValue + moveY + skin * 2,
      );
      const allowed = Math.min(moveY, Math.max(0, clearance - this.heightValue - skin));
      if (allowed < moveY) this.velocityValue.y = 0;
      this.positionValue.y += allowed;
      return false;
    }

    const fall = -moveY;
    const snap = grounded && this.groundLockout <= 0 ? snapDistance : 0;
    const up = grounded ? stepHeight : Math.max(skin * 2, 0.06);
    const ground = this.castGround(up, fall + snap + skin);

    if (ground.hit && ground.walkable) {
      const rise = ground.groundY - this.positionValue.y;
      const canOccupy = rise <= 1e-3 || this.fitsAt(ground.groundY);

      if (rise <= stepHeight + 1e-3 && canOccupy) {
        this.positionValue.y = ground.groundY;
        this.velocityValue.y = 0;
        this.groundNormalValue.x = ground.normal.x;
        this.groundNormalValue.y = ground.normal.y;
        this.groundNormalValue.z = ground.normal.z;
        this.land(wasGrounded, descentSpeed);
        return true;
      }
    }

    if (ground.hit && !ground.walkable) {
      // Steep ground above us cannot be climbed: refuse the rise, drop the
      // uphill part of the velocity and let the slide acceleration take over.
      const rise = ground.groundY - this.positionValue.y;
      if (rise > 1e-3) {
        this.blockUphill(ground.normal);
        this.groundNormalValue.x = ground.normal.x;
        this.groundNormalValue.y = ground.normal.y;
        this.groundNormalValue.z = ground.normal.z;
        return false;
      }
      if (ground.groundY >= this.positionValue.y + moveY) {
        this.positionValue.y = ground.groundY;
        this.groundNormalValue.x = ground.normal.x;
        this.groundNormalValue.y = ground.normal.y;
        this.groundNormalValue.z = ground.normal.z;
        return false;
      }
    }

    this.positionValue.y += moveY;
    return false;
  }

  /**
   * Records a touchdown.
   *
   * `impactSpeed` is the descent speed as of this step's integration, captured
   * before the ground resolve zeroes it — otherwise every landing would report
   * an impact of zero. A settle with no descent at all (spawn, teleport,
   * checkpoint restore) updates the flags but emits nothing: the audio layer
   * must not thump on the first frame of a load.
   */
  private land(wasGrounded: boolean, impactSpeed: number): void {
    if (wasGrounded) return;

    this.lastLandingImpactValue = impactSpeed;
    this.jumpedThisAirtime = false;
    this.airTimeValue = 0;
    if (impactSpeed >= this.tuning.landImpactThreshold) {
      this.landTimer = this.tuning.landRecovery;
    }
    if (impactSpeed <= 0.01) return;
    this.emitter.emit('landed', {
      position: { ...this.positionValue },
      impactSpeed,
    });
  }

  private blockUphill(normal: Vec3): void {
    const horizontal = Math.hypot(normal.x, normal.z);
    if (horizontal < 1e-6) return;
    const unx = normal.x / horizontal;
    const unz = normal.z / horizontal;
    const into = this.velocityValue.x * unx + this.velocityValue.z * unz;
    if (into < 0) {
      this.velocityValue.x -= unx * into;
      this.velocityValue.z -= unz * into;
    }
  }

  // -------------------------------------------------------------------------
  // Probes
  // -------------------------------------------------------------------------

  /** Short probe answering "am I standing on something right now". */
  private probeStanding(): GroundInfo {
    const info = this.castGround(0.06, 0.06 + this.tuning.skin * 3);
    // Ground found *above* the feet by the standing probe means we are being
    // pushed out of a floor we sank into; still grounded.
    info.grounded = info.hit && info.walkable;
    return info;
  }

  /**
   * Downward ray fan.
   *
   * The centre ray decides the surface height, because a lateral ray on a
   * slope reports a higher surface and would float the capsule above the
   * ground by `radius · tan(slope)`. The lateral rays only provide ledge
   * tolerance — they can confirm grounding, never lift the player.
   *
   * Walkable hits are preferred over closer unwalkable ones: standing at the
   * foot of a steep ramp must not be reported as standing on the ramp.
   */
  private castGround(up: number, down: number): GroundInfo {
    const out = this.scratchGround;
    out.hit = false;
    out.walkable = false;
    out.grounded = false;
    out.groundY = this.positionValue.y;
    out.normal.x = 0;
    out.normal.y = 1;
    out.normal.z = 0;

    const originY = this.positionValue.y + up;
    const maxDistance = up + down;
    const spread = this.tuning.radius * PROBE_SPREAD;

    let centreFound = false;
    let lateralY = Number.NEGATIVE_INFINITY;
    let lateralNormal: Vec3 | null = null;
    let anyDistance = Number.POSITIVE_INFINITY;
    let anyY = 0;
    let anyNormal: Vec3 | null = null;

    for (let i = 0; i < 5; i += 1) {
      const offsetX = i === 1 ? spread : i === 2 ? -spread : 0;
      const offsetZ = i === 3 ? spread : i === 4 ? -spread : 0;

      this.scratchOrigin.x = this.positionValue.x + offsetX;
      this.scratchOrigin.y = originY;
      this.scratchOrigin.z = this.positionValue.z + offsetZ;

      const hit = this.physics.raycast(this.scratchOrigin, DOWN, maxDistance, {
        layers: this.collisionLayers,
        excludeBody: this.handle,
      });
      // distance ~0 means the origin is inside geometry. That is never valid
      // ground: accepting it would teleport the player up into a wall.
      if (!hit || hit.distance <= INSIDE_EPSILON) continue;

      const surfaceY = originY - hit.distance;
      const walkable = hit.normal.y >= this.cosMaxSlope;

      if (hit.distance < anyDistance) {
        anyDistance = hit.distance;
        anyY = surfaceY;
        anyNormal = hit.normal;
      }

      if (!walkable) continue;

      if (i === 0) {
        centreFound = true;
        out.hit = true;
        out.walkable = true;
        out.groundY = surfaceY;
        out.normal.x = hit.normal.x;
        out.normal.y = hit.normal.y;
        out.normal.z = hit.normal.z;
      } else if (surfaceY > lateralY) {
        lateralY = surfaceY;
        lateralNormal = hit.normal;
      }
    }

    if (centreFound) return out;

    // No walkable ground under the centre. A lateral sample can still hold the
    // player up, but only if it is at or below the feet — otherwise it would
    // lift her onto a surface her centre is not over.
    if (lateralNormal && lateralY <= this.positionValue.y + 0.02) {
      out.hit = true;
      out.walkable = true;
      out.groundY = Math.min(lateralY, this.positionValue.y);
      out.normal.x = lateralNormal.x;
      out.normal.y = lateralNormal.y;
      out.normal.z = lateralNormal.z;
      return out;
    }

    if (anyNormal) {
      out.hit = true;
      out.walkable = false;
      out.groundY = anyY;
      out.normal.x = anyNormal.x;
      out.normal.y = anyNormal.y;
      out.normal.z = anyNormal.z;
    }

    return out;
  }

  /**
   * Clearance above the feet at a position, in metres.
   *
   * `Infinity` when nothing is found inside `maxProbe`, so callers compare
   * against a required height rather than special-casing a miss.
   *
   * Two details that are easy to get wrong and produce a player who can never
   * stand up on a ramp:
   *
   *   - Lateral rays start at the height where the capsule's bottom cap
   *     actually is at that offset (`r - √(r² - o²)`), not at the feet. The
   *     capsule is a capsule: at 0.6 r out from the axis its surface is already
   *     6 cm above the ground.
   *   - A sample whose origin is inside geometry is discarded, not treated as
   *     zero clearance. On a slope or a stair tread the ground *beside* the
   *     player is above her feet; that is the floor, not a ceiling, and it says
   *     nothing about whether she can stand.
   */
  private measureHeadroom(x: number, y: number, z: number, maxProbe: number): number {
    const { skin, radius } = this.tuning;
    const spread = radius * PROBE_SPREAD;
    // Height of the capsule's lower surface at the lateral sample offset.
    const lift = radius - Math.sqrt(Math.max(0, radius * radius - spread * spread));
    let clearance = Number.POSITIVE_INFINITY;

    for (let i = 0; i < 5; i += 1) {
      const offsetX = i === 1 ? spread : i === 2 ? -spread : 0;
      const offsetZ = i === 3 ? spread : i === 4 ? -spread : 0;
      const base = i === 0 ? skin : lift + skin;

      this.scratchOrigin.x = x + offsetX;
      this.scratchOrigin.y = y + base;
      this.scratchOrigin.z = z + offsetZ;

      const hit = this.physics.raycast(this.scratchOrigin, UP, maxProbe, {
        layers: this.collisionLayers,
        excludeBody: this.handle,
      });
      if (!hit || hit.distance <= INSIDE_EPSILON) continue;
      clearance = Math.min(clearance, base + hit.distance);
    }

    return clearance;
  }

  /** True when the current capsule fits with its feet at `feetY`. */
  private fitsAt(feetY: number): boolean {
    return (
      this.measureHeadroom(
        this.positionValue.x,
        feetY,
        this.positionValue.z,
        this.heightValue + this.tuning.skin * 2,
      ) >= this.heightValue - this.tuning.skin
    );
  }

  // -------------------------------------------------------------------------
  // Vault
  // -------------------------------------------------------------------------

  /**
   * Contextual vault over a waist-high obstacle.
   *
   * Everything is verified before the animation starts — obstacle top,
   * landing surface, headroom — so the scripted arc can ignore collision
   * without ever putting the player inside geometry.
   */
  private tryStartVault(dirX: number, dirZ: number): boolean {
    const t = this.tuning;
    if (!t.vaultEnabled || this.crouchedValue) return false;

    const length = Math.hypot(dirX, dirZ);
    if (length < 1e-6) return false;
    const ux = dirX / length;
    const uz = dirZ / length;

    // 1. Something waist-high directly ahead.
    this.scratchOrigin.x = this.positionValue.x;
    this.scratchOrigin.y = this.positionValue.y + t.stepHeight + 0.05;
    this.scratchOrigin.z = this.positionValue.z;
    this.scratchDir.x = ux;
    this.scratchDir.y = 0;
    this.scratchDir.z = uz;

    const front = this.physics.raycast(
      this.scratchOrigin,
      this.scratchDir,
      t.radius + t.vaultReach,
      { layers: this.collisionLayers, excludeBody: this.handle },
    );
    if (!front) return false;

    // 2. Its top must be between step height and vault height.
    const topProbeY = this.positionValue.y + t.vaultMaxHeight + 0.4;
    this.scratchOrigin.x = this.positionValue.x + ux * (t.radius + 0.3);
    this.scratchOrigin.y = topProbeY;
    this.scratchOrigin.z = this.positionValue.z + uz * (t.radius + 0.3);
    const top = this.physics.raycast(
      this.scratchOrigin,
      DOWN,
      t.vaultMaxHeight + 0.45,
      { layers: this.collisionLayers, excludeBody: this.handle },
    );
    if (!top || top.distance <= INSIDE_EPSILON) return false;

    const topY = topProbeY - top.distance;
    const rise = topY - this.positionValue.y;
    if (rise <= t.stepHeight + 0.02 || rise > t.vaultMaxHeight) return false;
    if (top.normal.y < 0.5) return false;

    // 3. Somewhere to land on the far side.
    const landX = this.positionValue.x + ux * (t.radius + t.vaultLanding);
    const landZ = this.positionValue.z + uz * (t.radius + t.vaultLanding);
    const landProbeY = topY + 0.3;
    this.scratchOrigin.x = landX;
    this.scratchOrigin.y = landProbeY;
    this.scratchOrigin.z = landZ;
    const landing = this.physics.raycast(
      this.scratchOrigin,
      DOWN,
      0.3 + t.vaultMaxHeight + 1.5,
      { layers: this.collisionLayers, excludeBody: this.handle },
    );
    if (!landing || landing.distance <= INSIDE_EPSILON) return false;
    if (landing.normal.y < this.cosMaxSlope) return false;

    const landY = landProbeY - landing.distance;
    // A surface at or above the obstacle top means the wall carries on; there
    // is nothing to vault *onto*.
    if (landY > topY + 0.02) return false;

    // 4. Room to stand where we are going.
    if (
      this.measureHeadroom(landX, landY, landZ, t.crouchHeight + 0.1) < t.crouchHeight
    ) {
      return false;
    }

    this.vaultFrom.x = this.positionValue.x;
    this.vaultFrom.y = this.positionValue.y;
    this.vaultFrom.z = this.positionValue.z;
    this.vaultTo.x = landX;
    this.vaultTo.y = landY;
    this.vaultTo.z = landZ;
    this.vaultLift =
      Math.max(0, topY - Math.max(this.vaultFrom.y, this.vaultTo.y)) + t.vaultClearance;
    this.vaultElapsed = 0;
    this.vaultActive = true;
    this.velocityValue.x = 0;
    this.velocityValue.y = 0;
    this.velocityValue.z = 0;
    this.groundedValue = false;
    this.stateValue = 'vault';
    this.turnToward(Math.atan2(-ux, -uz), 1);

    this.emitter.emit('vaultStarted', {
      from: { ...this.vaultFrom },
      to: { ...this.vaultTo },
    });
    return true;
  }

  private advanceVault(dt: number): void {
    this.vaultElapsed += dt;
    const t = clamp(this.vaultElapsed / this.tuning.vaultDuration, 0, 1);

    this.positionValue.x = this.vaultFrom.x + (this.vaultTo.x - this.vaultFrom.x) * t;
    this.positionValue.z = this.vaultFrom.z + (this.vaultTo.z - this.vaultFrom.z) * t;
    this.positionValue.y =
      this.vaultFrom.y
      + (this.vaultTo.y - this.vaultFrom.y) * t
      + this.vaultLift * 4 * t * (1 - t);

    if (t < 1) {
      this.stateValue = 'vault';
      return;
    }

    this.vaultActive = false;
    this.groundedValue = true;
    this.airTimeValue = 0;
    this.jumpedThisAirtime = false;
    this.velocityValue.y = 0;
    // Exits with a little momentum in the vault direction so the landing does
    // not feel like hitting a wall.
    const dx = this.vaultTo.x - this.vaultFrom.x;
    const dz = this.vaultTo.z - this.vaultFrom.z;
    const length = Math.hypot(dx, dz);
    if (length > 1e-6) {
      const exit = this.tuning.walkSpeed * 0.5;
      this.velocityValue.x = (dx / length) * exit;
      this.velocityValue.z = (dz / length) * exit;
    }
    this.stateValue = 'walk';
  }

  // -------------------------------------------------------------------------
  // State & output
  // -------------------------------------------------------------------------

  private resolveState(grounded: boolean): void {
    if (this.vaultActive) {
      this.stateValue = 'vault';
      return;
    }
    if (!grounded) {
      this.stateValue =
        this.jumpedThisAirtime && this.velocityValue.y > 0 ? 'jump' : 'air';
      return;
    }
    if (this.landTimer > 0) {
      this.stateValue = 'land';
      return;
    }
    if (this.crouchedValue) {
      this.stateValue = 'crouch';
      return;
    }
    if (this.sprintingValue && this.horizontalSpeed > this.tuning.walkSpeed * 1.02) {
      this.stateValue = 'sprint';
      return;
    }
    this.stateValue = 'walk';
  }

  private finishStep(previousState: PlayerMoveState): void {
    this.syncOutputs();
    if (this.stateValue !== previousState) {
      this.emitter.emit('stateChanged', {
        state: this.stateValue,
        previous: previousState,
      });
    }
  }

  /**
   * Publishes the resolved pose.
   *
   * The capsule keeps its authored standing size, so crouching lowers its
   * centre rather than shrinking it: the top of the capsule tracks the head,
   * and the surplus below the feet sits inside the floor where nothing can be
   * affected by it.
   */
  private syncOutputs(): void {
    this.physics.setNextKinematicPosition(this.handle, {
      x: this.positionValue.x,
      y: this.positionValue.y + this.heightValue - this.standHalfHeight,
      z: this.positionValue.z,
    });

    if (this.transform) {
      this.transform.position.x = this.positionValue.x;
      this.transform.position.y = this.positionValue.y;
      this.transform.position.z = this.positionValue.z;
      this.transform.yaw = this.facingYawValue;
    }
  }
}
