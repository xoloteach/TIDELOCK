/**
 * Third-person over-the-shoulder player camera.
 *
 * Owns look direction. `PlayerController` asks this class for its yaw and moves
 * relative to it, so this system must be registered *before* the controller:
 * look is integrated from this step's input, while the follow position uses the
 * player's pose from the end of the previous step. That one-step offset is the
 * camera trailing the character, which is what a chase camera should do anyway.
 *
 * Produces a {@link CameraPose} — plain numbers, no Three.js types. Whatever
 * owns the `PerspectiveCamera` copies the pose onto it during render sync. That
 * keeps this file testable in a plain unit test and keeps renderer concerns out
 * of gameplay.
 *
 * ## The look input convention (read this before wiring input)
 *
 * `lookX`/`lookY` carry different *units* depending on the device, and that is
 * documented at the source: `KeyboardMouseSource` writes a **displacement in
 * radians** (mouse look has to be 1:1 with the hand), while `GamepadSource` and
 * the touch driver write a **rate in [-1,1]**. Multiplying a mouse
 * displacement by a turn rate and the step time feels dead; integrating a stick
 * rate as if it were radians turns the camera into a twitch.
 *
 * As the camera owns look, the decision is made here:
 *
 *   - Axes are interpreted **per active input family**, using
 *     {@link DEFAULT_LOOK_AXIS_MODES}: `keyboard` (which includes the mouse) is
 *     `radians`, `gamepad` and `touch` are `rate`. `InputState.activeFamily`
 *     says which one produced the current values. Override with
 *     `axisModes` if a project ever changes a driver's units.
 *   - {@link PlayerCamera.addLookDelta} is an additive channel for callers that
 *     have an exact radian displacement in hand (a pointer-lock handler reading
 *     `KeyboardMouseSource.lookDeltaRadians`, a gyro source). It is consumed by
 *     the next `fixedUpdate` and is independent of the axis mode, so using both
 *     at once double-counts — pick one per device.
 *
 * Per-device sensitivity and Y inversion are applied by the drivers, which is
 * where the settings for them live; `lookSensitivity` here is a single global
 * trim, not a substitute for them.
 *
 * ## Deliberately absent
 *
 * No idle sway, no head bob, no motion blur hook, no shake on ordinary
 * interactions (spec §67). Shake exists, is explicit, and is scaled by
 * `display.cameraShake` — where 0 means no camera shake at all, not a little.
 */

import type { System } from '../../engine/ecs/GameWorld';
import { CollisionLayer, type Vec3 } from '../../engine/ecs/components';
import type { AxisAction, InputFamily } from '../../engine/input/actions';
import type { BodyHandle, PhysicsWorld } from '../../engine/physics/PhysicsWorld';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * How a look axis should be read.
 *
 * `rate` — value is a fraction of the maximum turn speed, integrated over dt.
 * `radians` — value is an angular displacement already, applied as-is.
 */
export type LookAxisMode = 'rate' | 'radians';

/** Units each input family writes to `lookX`/`lookY`. */
export const DEFAULT_LOOK_AXIS_MODES: Readonly<Record<InputFamily, LookAxisMode>> = {
  keyboard: 'radians',
  gamepad: 'rate',
  touch: 'rate',
};

/** The slice of the input layer the camera needs. `InputState` satisfies it. */
export interface CameraInputPort {
  getAxis(action: AxisAction): number;
  readonly activeFamily: InputFamily;
}

/**
 * What the camera follows. `PlayerController` satisfies this structurally, so
 * no adapter is needed, and tests can follow a plain object.
 */
export interface CameraFollowTarget {
  /** Feet position. */
  readonly position: Vec3;
  /** Current capsule height, so the pivot ducks when the player crouches. */
  readonly height: number;
  readonly horizontalSpeed: number;
}

/**
 * Display preferences read every step. Satisfied by `Settings['display']`.
 *
 * `cameraShake` is a 0..1 scale where 0 disables shake entirely.
 */
export interface CameraDisplayPreferences {
  readonly fov: number;
  readonly cameraShake: number;
}

const DEFAULT_DISPLAY: CameraDisplayPreferences = { fov: 70, cameraShake: 0.6 };

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** Everything needed to drive a perspective camera for one frame. */
export interface CameraPose {
  /** World position of the camera, shake included. */
  position: Vec3;
  /** Point the camera looks at, shake included. */
  target: Vec3;
  yaw: number;
  pitch: number;
  /** Vertical field of view in degrees. */
  fov: number;
  /** Current boom length after collision pull-in, metres. */
  distance: number;
}

export interface PlayerCameraTuning {
  /** Boom length outdoors. */
  distance: number;
  /** Boom length when a ceiling is detected. Tighter spaces need a tighter camera. */
  indoorDistance: number;
  /** Lateral offset of the shoulder framing. Positive is the player's right. */
  shoulderOffset: number;
  /** Pivot distance below the top of the capsule. */
  pivotInset: number;
  /** Extra lift added to the pivot while moving fast, for a sense of speed. */
  sprintLift: number;

  minPitch: number;
  maxPitch: number;
  /** Radians per second of yaw at full stick deflection. */
  yawRate: number;
  pitchRate: number;
  /** Global trim on look input. Per-device sensitivity lives in the drivers. */
  lookSensitivity: number;

  /** Follow time constant outdoors, seconds. Smaller is more responsive. */
  followTau: number;
  /** Follow time constant indoors. Tighter, so walls do not swing into frame. */
  indoorFollowTau: number;
  /** Gap kept between the camera and geometry it was pulled in by. */
  collisionMargin: number;
  /** Closest the camera may get to the pivot. Keeps it out of the head. */
  minDistance: number;
  /** Metres per second the boom is allowed to extend after being pulled in. */
  returnSpeed: number;
  /** A ceiling within this distance counts as indoors. */
  indoorProbeHeight: number;
  /** Steps between indoor re-checks. The answer changes slowly. */
  indoorProbeInterval: number;

  /** Peak positional shake displacement at amplitude 1, metres. */
  shakeScale: number;
}

export const DEFAULT_CAMERA_TUNING: PlayerCameraTuning = {
  distance: 3.2,
  indoorDistance: 2.1,
  shoulderOffset: 0.55,
  pivotInset: 0.22,
  sprintLift: 0.1,

  minPitch: -1.2,
  maxPitch: 0.95,
  yawRate: 2.6,
  pitchRate: 1.9,
  lookSensitivity: 1,

  followTau: 0.09,
  indoorFollowTau: 0.05,
  collisionMargin: 0.14,
  minDistance: 0.5,
  returnSpeed: 3.5,
  indoorProbeHeight: 4,
  indoorProbeInterval: 6,

  shakeScale: 0.075,
};

export interface PlayerCameraOptions {
  input: CameraInputPort;
  /** Read every step, so respawn into a new body needs no rewiring. */
  target: () => CameraFollowTarget;
  /**
   * Optional. Without it there is no collision avoidance and no indoor
   * detection — acceptable for menu backdrops, not for gameplay.
   */
  physics?: PhysicsWorld;
  /** Body excluded from camera casts. The player's own capsule. */
  excludeBody?: BodyHandle;
  /** Layers the camera collides with. Defaults to `World | Interactable`. */
  collisionLayers?: number;
  display?: () => CameraDisplayPreferences;
  tuning?: Partial<PlayerCameraTuning>;
  axisModes?: Partial<Record<InputFamily, LookAxisMode>>;
  initialYaw?: number;
  initialPitch?: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

// ---------------------------------------------------------------------------
// PlayerCamera
// ---------------------------------------------------------------------------

export class PlayerCamera implements System {
  static readonly SYSTEM_NAME = 'player-camera';

  readonly name = PlayerCamera.SYSTEM_NAME;

  readonly tuning: PlayerCameraTuning;

  private readonly input: CameraInputPort;
  private readonly readTarget: () => CameraFollowTarget;
  private readonly readDisplay: () => CameraDisplayPreferences;
  private readonly physics: PhysicsWorld | undefined;
  private readonly excludeBody: BodyHandle | undefined;
  private readonly collisionLayers: number;
  private readonly axisModes: Readonly<Record<InputFamily, LookAxisMode>>;

  private yawValue: number;
  private pitchValue: number;

  /** Additive look displacement in radians, consumed next step. */
  private pendingYaw = 0;
  private pendingPitch = 0;

  private boom: number;
  private fovValue: number;

  private readonly pivot: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly focus: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly positionValue: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly shakeOffsetValue: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly scratchDir: Vec3 = { x: 0, y: 0, z: 0 };

  private shakeAmplitude = 0;
  private shakeRemaining = 0;
  private shakeDuration = 0;
  private shakeClock = 0;

  private indoorValue = false;
  private indoorOverride: boolean | null = null;
  private indoorCountdown = 0;

  private initialised = false;

  constructor(options: PlayerCameraOptions) {
    this.tuning = { ...DEFAULT_CAMERA_TUNING, ...options.tuning };
    this.input = options.input;
    this.readTarget = options.target;
    this.readDisplay = options.display ?? (() => DEFAULT_DISPLAY);
    this.physics = options.physics;
    this.excludeBody = options.excludeBody;
    this.collisionLayers =
      options.collisionLayers ?? (CollisionLayer.World | CollisionLayer.Interactable);
    this.axisModes = { ...DEFAULT_LOOK_AXIS_MODES, ...options.axisModes };

    this.yawValue = options.initialYaw ?? 0;
    this.pitchValue = clamp(
      options.initialPitch ?? -0.12,
      this.tuning.minPitch,
      this.tuning.maxPitch,
    );
    this.boom = this.tuning.distance;
    this.fovValue = this.readDisplay().fov;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  get yaw(): number {
    return this.yawValue;
  }

  get pitch(): number {
    return this.pitchValue;
  }

  /** Camera world position, shake included. Live reference; read-only. */
  get position(): Vec3 {
    return this.positionValue;
  }

  /** Point the camera is aimed at, shake included. Live reference. */
  get target(): Vec3 {
    return this.focus;
  }

  get fov(): number {
    return this.fovValue;
  }

  /** Boom length after collision pull-in. */
  get distance(): number {
    return this.boom;
  }

  /**
   * Current shake displacement. Exactly `{0,0,0}` when `display.cameraShake`
   * is 0 — the accessibility guarantee, asserted in the tests.
   */
  get shakeOffset(): Vec3 {
    return this.shakeOffsetValue;
  }

  get indoor(): boolean {
    return this.indoorValue;
  }

  get shaking(): boolean {
    return this.shakeRemaining > 0;
  }

  /** Fills and returns a pose. Pass `out` to avoid allocating per frame. */
  getPose(out?: CameraPose): CameraPose {
    const pose: CameraPose = out ?? {
      position: { x: 0, y: 0, z: 0 },
      target: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      fov: 70,
      distance: 0,
    };
    pose.position.x = this.positionValue.x;
    pose.position.y = this.positionValue.y;
    pose.position.z = this.positionValue.z;
    pose.target.x = this.focus.x;
    pose.target.y = this.focus.y;
    pose.target.z = this.focus.z;
    pose.yaw = this.yawValue;
    pose.pitch = this.pitchValue;
    pose.fov = this.fovValue;
    pose.distance = this.boom;
    return pose;
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Adds an exact look displacement in radians.
   *
   * Signs follow the action map, not the internal angles: `rightRadians` turns
   * the view to the right, `upRadians` raises it. Accumulates until the next
   * `fixedUpdate` consumes it, so several mouse events inside one step are
   * summed rather than the last one winning.
   */
  addLookDelta(rightRadians: number, upRadians: number): void {
    if (Number.isFinite(rightRadians)) this.pendingYaw -= rightRadians;
    if (Number.isFinite(upRadians)) this.pendingPitch += upRadians;
  }

  /** Points the camera at an absolute orientation. For scripted handoff. */
  setOrientation(yaw: number, pitch?: number): void {
    this.yawValue = yaw;
    if (pitch !== undefined) {
      this.pitchValue = clamp(pitch, this.tuning.minPitch, this.tuning.maxPitch);
    }
    this.pendingYaw = 0;
    this.pendingPitch = 0;
  }

  /**
   * Starts a shake.
   *
   * @param amplitude 0..1, scaled by `display.cameraShake`.
   * @param duration Seconds. The shake decays linearly to nothing.
   * @returns false when shake is disabled or the arguments are unusable, so
   *   callers can tell the difference between "shook" and "ignored".
   */
  shake(amplitude: number, duration: number): boolean {
    const scale = this.shakeScale();
    if (scale <= 0) return false;
    if (!Number.isFinite(amplitude) || !Number.isFinite(duration)) return false;
    if (amplitude <= 0 || duration <= 0) return false;

    // A stronger shake overrides a weaker one in progress instead of summing;
    // two overlapping events must not add up to a seizure.
    const strength = Math.min(1, amplitude);
    if (strength * duration < this.shakeAmplitude * this.shakeRemaining) return false;

    this.shakeAmplitude = strength;
    this.shakeDuration = duration;
    this.shakeRemaining = duration;
    return true;
  }

  /** Cancels any shake immediately. Used on cutscene entry and teleport. */
  clearShake(): void {
    this.shakeRemaining = 0;
    this.shakeAmplitude = 0;
    this.shakeOffsetValue.x = 0;
    this.shakeOffsetValue.y = 0;
    this.shakeOffsetValue.z = 0;
  }

  /**
   * Forces indoor framing on or off. `null` restores automatic detection by
   * ceiling probe.
   */
  setIndoorOverride(indoor: boolean | null): void {
    this.indoorOverride = indoor;
    if (indoor !== null) this.indoorValue = indoor;
    this.indoorCountdown = 0;
  }

  /**
   * Places the camera at its ideal pose with no smoothing.
   *
   * Call after a teleport, spawn or sector transition — otherwise the camera
   * flies across the level, sweeping through every wall on the way.
   */
  snapToTarget(): void {
    const target = this.readTarget();
    this.indoorCountdown = 0;
    this.updateIndoor(target);
    this.updatePivot(target, 0, true);
    this.boom = this.desiredDistance();
    this.applyCollision(true);
    this.clearShake();
    this.composePosition();
    this.initialised = true;
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  fixedUpdate(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;

    const display = this.readDisplay();
    this.fovValue = Number.isFinite(display.fov) ? display.fov : DEFAULT_DISPLAY.fov;

    this.applyLook(dt);

    if (!this.initialised) {
      this.snapToTarget();
      return;
    }

    const target = this.readTarget();
    this.updateIndoor(target);
    this.updatePivot(target, dt, false);
    this.updateBoom(dt);
    this.applyCollision(false);
    this.updateShake(dt);
    this.composePosition();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private applyLook(dt: number): void {
    const mode = this.axisModes[this.input.activeFamily];
    const sensitivity = this.tuning.lookSensitivity;

    const axisX = this.input.getAxis('lookX');
    const axisY = this.input.getAxis('lookY');

    let deltaYaw = this.pendingYaw;
    let deltaPitch = this.pendingPitch;
    this.pendingYaw = 0;
    this.pendingPitch = 0;

    if (mode === 'radians') {
      // Already a displacement: applying dt here would make mouse look depend
      // on frame rate, which is exactly the bug the seam exists to prevent.
      deltaYaw -= axisX * sensitivity;
      deltaPitch += axisY * sensitivity;
    } else {
      deltaYaw -= axisX * this.tuning.yawRate * sensitivity * dt;
      deltaPitch += axisY * this.tuning.pitchRate * sensitivity * dt;
    }

    this.yawValue = wrapAngle(this.yawValue + deltaYaw);
    this.pitchValue = clamp(
      this.pitchValue + deltaPitch,
      this.tuning.minPitch,
      this.tuning.maxPitch,
    );
  }

  /** Ceiling probe, throttled: the answer changes at walking pace. */
  private updateIndoor(target: CameraFollowTarget): void {
    if (this.indoorOverride !== null) {
      this.indoorValue = this.indoorOverride;
      return;
    }
    if (!this.physics) {
      this.indoorValue = false;
      return;
    }
    if (this.indoorCountdown > 0) {
      this.indoorCountdown -= 1;
      return;
    }
    this.indoorCountdown = Math.max(1, Math.round(this.tuning.indoorProbeInterval));

    const hit = this.physics.raycast(
      { x: target.position.x, y: target.position.y + target.height, z: target.position.z },
      { x: 0, y: 1, z: 0 },
      this.tuning.indoorProbeHeight,
      { layers: this.collisionLayers, excludeBody: this.excludeBody },
    );
    this.indoorValue = hit !== null;
  }

  /**
   * Pivot and focus.
   *
   * The pivot sits just below the top of the capsule, so crouching lowers the
   * camera with the player instead of leaving it hovering, and it *follows*
   * rather than tracks: an exponential approach with a time constant, tightened
   * indoors so walls do not swing into frame. Smoothing the follow point rather
   * than the final camera position is what lets collision avoidance stay exact
   * — a smoothed final position would lag straight into the wall it was just
   * pulled out of.
   *
   * The focus adds the shoulder offset. Camera and aim point shift together,
   * which frames the player off-centre without aiming the view past her.
   */
  private updatePivot(target: CameraFollowTarget, dt: number, snap: boolean): void {
    const speedLift =
      this.tuning.sprintLift * clamp(target.horizontalSpeed / 5.5, 0, 1);

    const desiredX = target.position.x;
    const desiredY = target.position.y + target.height - this.tuning.pivotInset + speedLift;
    const desiredZ = target.position.z;

    if (snap) {
      this.pivot.x = desiredX;
      this.pivot.y = desiredY;
      this.pivot.z = desiredZ;
    } else {
      const tau = this.indoorValue ? this.tuning.indoorFollowTau : this.tuning.followTau;
      const k = smoothing(dt, tau);
      this.pivot.x += (desiredX - this.pivot.x) * k;
      this.pivot.y += (desiredY - this.pivot.y) * k;
      this.pivot.z += (desiredZ - this.pivot.z) * k;
    }

    // Right vector for yaw where 0 faces -Z.
    const rightX = Math.cos(this.yawValue);
    const rightZ = -Math.sin(this.yawValue);
    this.focus.x = this.pivot.x + rightX * this.tuning.shoulderOffset;
    this.focus.y = this.pivot.y;
    this.focus.z = this.pivot.z + rightZ * this.tuning.shoulderOffset;
  }

  private desiredDistance(): number {
    return this.indoorValue ? this.tuning.indoorDistance : this.tuning.distance;
  }

  /**
   * Extends the boom back toward its target length at a limited rate.
   *
   * Rate-limited outward, instant inward (see {@link applyCollision}): the
   * camera must leave a wall gently but must never wait to get out of one.
   */
  private updateBoom(dt: number): void {
    const desired = this.desiredDistance();
    if (this.boom < desired) {
      this.boom = Math.min(desired, this.boom + this.tuning.returnSpeed * dt);
    } else if (this.boom > desired) {
      // Tightening indoors is a framing change, so it eases rather than snaps.
      const tau = this.indoorValue ? this.tuning.indoorFollowTau : this.tuning.followTau;
      this.boom += (desired - this.boom) * smoothing(dt, tau);
    }
  }

  /**
   * Pulls the boom in when geometry is in the way.
   *
   * Cast runs from the pivot — a point guaranteed to be inside the player's own
   * free space — out along the boom. On a hit the boom is shortened
   * immediately, with no smoothing, because a smoothed pull-in *is* the camera
   * spending frames inside the wall.
   *
   * The result is floored at `minDistance` so the camera cannot reach the
   * player's head. In a space tighter than that the floor wins and the camera
   * may graze geometry: being briefly close to a wall is a smaller failure than
   * rendering the inside of Mara's skull.
   */
  private applyCollision(snap: boolean): void {
    if (!this.physics) return;

    const dir = this.boomDirection();
    const probe = this.boom + this.tuning.collisionMargin;
    const hit = this.physics.raycast(this.pivot, dir, probe, {
      layers: this.collisionLayers,
      excludeBody: this.excludeBody,
    });
    if (!hit) return;

    const allowed = Math.max(
      this.tuning.minDistance,
      hit.distance - this.tuning.collisionMargin,
    );
    if (snap || allowed < this.boom) this.boom = allowed;
  }

  /** Unit vector from the focus toward where the camera wants to sit. */
  private boomDirection(): Vec3 {
    const cosPitch = Math.cos(this.pitchValue);
    const sinPitch = Math.sin(this.pitchValue);
    // Forward for yaw where 0 faces -Z; the boom runs backwards along it.
    this.scratchDir.x = Math.sin(this.yawValue) * cosPitch;
    this.scratchDir.y = -sinPitch;
    this.scratchDir.z = Math.cos(this.yawValue) * cosPitch;
    return this.scratchDir;
  }

  /**
   * Shake displacement.
   *
   * Deterministic sines rather than random noise: a fixed-step simulation
   * should produce the same frame twice, and random jitter reads as a dropped
   * frame. Zero — exactly — when the player has turned shake off.
   */
  private updateShake(dt: number): void {
    const scale = this.shakeScale();
    if (scale <= 0 || this.shakeRemaining <= 0) {
      this.shakeOffsetValue.x = 0;
      this.shakeOffsetValue.y = 0;
      this.shakeOffsetValue.z = 0;
      if (scale <= 0) this.shakeRemaining = 0;
      return;
    }

    this.shakeRemaining = Math.max(0, this.shakeRemaining - dt);
    this.shakeClock += dt;

    const decay = this.shakeDuration > 0 ? this.shakeRemaining / this.shakeDuration : 0;
    const strength = this.shakeAmplitude * scale * decay * this.tuning.shakeScale;

    this.shakeOffsetValue.x = Math.sin(this.shakeClock * 37.1) * strength;
    this.shakeOffsetValue.y = Math.sin(this.shakeClock * 29.3 + 1.7) * strength * 0.8;
    this.shakeOffsetValue.z = Math.sin(this.shakeClock * 41.7 + 3.1) * strength * 0.7;
  }

  private shakeScale(): number {
    const value = this.readDisplay().cameraShake;
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.min(1, value);
  }

  /**
   * Writes the final camera position.
   *
   * The boom already resolved collision this step, so the position is composed
   * directly from it — all smoothing lives in the pivot follow. Shake is added
   * last: smoothing a shake filters out exactly the frequencies that make it
   * read as an impact.
   */
  private composePosition(): void {
    const dir = this.boomDirection();
    this.positionValue.x = this.focus.x + dir.x * this.boom + this.shakeOffsetValue.x;
    this.positionValue.y = this.focus.y + dir.y * this.boom + this.shakeOffsetValue.y;
    this.positionValue.z = this.focus.z + dir.z * this.boom + this.shakeOffsetValue.z;

    // The aim point takes a fraction of the shake so the whole frame moves
    // together instead of the camera orbiting a rigidly fixed point.
    this.focus.x += this.shakeOffsetValue.x * 0.35;
    this.focus.y += this.shakeOffsetValue.y * 0.35;
    this.focus.z += this.shakeOffsetValue.z * 0.35;
  }
}

/** Frame-rate independent smoothing factor for a time constant `tau`. */
function smoothing(dt: number, tau: number): number {
  if (tau <= 1e-6) return 1;
  return 1 - Math.exp(-dt / tau);
}

/** Keeps yaw in (-π, π] so it never grows without bound over a long session. */
function wrapAngle(angle: number): number {
  let value = angle;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value <= -Math.PI) value += Math.PI * 2;
  return value;
}
