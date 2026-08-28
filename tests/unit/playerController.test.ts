/**
 * Player controller and camera tests.
 *
 * These run a **real** `PhysicsWorld` against **real** collision geometry.
 * Nothing about physics is mocked, because a mocked physics engine would only
 * prove that the controller calls methods — not that the player climbs a 15°
 * ramp, refuses a 55° one, keeps her speed at 30 FPS, or fails to fall through
 * a floor from 200 metres up. Every failure condition in spec §66 is a claim
 * about the solver's answers, so it is asserted against the solver.
 *
 * Input is a fake, deliberately: `PlayerInputPort` is a documented seam and the
 * fake reproduces `InputState`'s edge semantics (a press is visible for exactly
 * one step). Preferences and display settings are plain objects, which is what
 * the real settings store hands over anyway.
 *
 * Fixtures assert their own shape before being used. A slope test that silently
 * built a flat slab would pass for the wrong reason, so each ramp is probed
 * once and its height checked against the analytic surface.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  PhysicsWorld,
  type BodyHandle,
} from '@/engine/physics/PhysicsWorld';
import { CollisionLayer, type Vec3 } from '@/engine/ecs/components';
import type { AxisAction, ButtonAction, InputFamily } from '@/engine/input/actions';
import {
  DEFAULT_PLAYER_TUNING,
  PlayerController,
  type PlayerControlPreferences,
  type PlayerMoveState,
} from '@/game/player/PlayerController';
import {
  DEFAULT_CAMERA_TUNING,
  PlayerCamera,
  type CameraDisplayPreferences,
  type CameraFollowTarget,
} from '@/game/player/PlayerCamera';

const HZ = 60;
const STEP_60 = 1 / 60;
const STEP_30 = 1 / 30;
const T = DEFAULT_PLAYER_TUNING;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const openWorlds: PhysicsWorld[] = [];

afterEach(() => {
  for (const world of openWorlds.splice(0)) {
    if (!world.isDisposed) world.dispose();
  }
});

/**
 * A world whose broad phase is already built.
 *
 * Newly added colliders are invisible to scene queries until the next
 * `step()` (`PhysicsWorld.queriesStale`), so fixtures are added and then the
 * world is stepped once before any controller looks at them.
 */
async function makeWorld(): Promise<PhysicsWorld> {
  const world = await PhysicsWorld.create({ hz: HZ });
  openWorlds.push(world);
  return world;
}

/** Mirrors `InputState`'s contract closely enough to drive movement. */
class FakeInput {
  private readonly axes = new Map<AxisAction, number>();
  private readonly held = new Set<ButtonAction>();
  private readonly pressed = new Set<ButtonAction>();

  activeFamily: InputFamily = 'keyboard';

  getAxis(action: AxisAction): number {
    return this.axes.get(action) ?? 0;
  }

  isDown(action: ButtonAction): boolean {
    return this.held.has(action);
  }

  wasPressed(action: ButtonAction): boolean {
    return this.pressed.has(action);
  }

  setAxis(action: AxisAction, value: number): void {
    this.axes.set(action, value);
  }

  /** Presses and keeps holding. The press edge lasts one step, as it should. */
  hold(action: ButtonAction): void {
    if (!this.held.has(action)) this.pressed.add(action);
    this.held.add(action);
  }

  release(action: ButtonAction): void {
    this.held.delete(action);
  }

  /** A press and release inside one step, like a real tap. */
  tap(action: ButtonAction): void {
    this.pressed.add(action);
  }

  /** Clears this step's edges. Called after every `fixedUpdate`. */
  endStep(): void {
    this.pressed.clear();
  }

  clear(): void {
    this.axes.clear();
    this.held.clear();
    this.pressed.clear();
  }
}

interface DriveOptions {
  /** Called before each step. Return false to stop early. */
  before?: (step: number) => void | boolean;
  /** Called after each step. */
  after?: (step: number) => void;
  /** Step the physics world too, as the real loop does. Default true. */
  stepWorld?: boolean;
}

function drive(
  controller: PlayerController,
  input: FakeInput,
  world: PhysicsWorld,
  steps: number,
  dt: number,
  options: DriveOptions = {},
): void {
  for (let i = 0; i < steps; i += 1) {
    if (options.before?.(i) === false) return;
    controller.fixedUpdate(dt);
    input.endStep();
    if (options.stepWorld !== false) world.step();
    options.after?.(i);
  }
}

interface Rig {
  world: PhysicsWorld;
  input: FakeInput;
  controller: PlayerController;
  preferences: { holdToSprint: boolean; holdToCrouch: boolean };
  yaw: { value: number };
}

function makeRig(
  world: PhysicsWorld,
  spawn: Vec3,
  overrides: Partial<PlayerControlPreferences> = {},
): Rig {
  const input = new FakeInput();
  const preferences = { holdToSprint: true, holdToCrouch: true, ...overrides };
  const yaw = { value: 0 };
  const controller = new PlayerController({
    physics: world,
    input,
    getYaw: () => yaw.value,
    spawn,
    preferences: () => preferences,
  });
  return { world, input, controller, preferences, yaw };
}

/** Walk forward (toward -Z at yaw 0) at full deflection. */
function walkForward(input: FakeInput): void {
  input.setAxis('moveY', 1);
}

function planarDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A 40 × 40 slab whose top surface is exactly y = 0. */
function addFlatFloor(world: PhysicsWorld): BodyHandle {
  return world.addStaticCuboid(
    { x: 20, y: 0.5, z: 20 },
    {
      position: { x: 0, y: -0.5, z: 0 },
      membership: CollisionLayer.World,
      friction: 0.9,
      debugName: 'floor',
    },
  );
}

/** A floor whose top is y = 0, spanning z ∈ [0, 40]. Leaves z < 0 empty. */
function addHalfFloor(world: PhysicsWorld): BodyHandle {
  return world.addStaticCuboid(
    { x: 20, y: 0.5, z: 20 },
    {
      position: { x: 0, y: -0.5, z: 20 },
      membership: CollisionLayer.World,
      friction: 0.9,
      debugName: 'half-floor',
    },
  );
}

function rampHeightAt(z: number, degrees: number): number {
  return -z * Math.tan((degrees * Math.PI) / 180);
}

/**
 * A slab rotated about X so that its top surface is the plane
 * `y = -z · tan(degrees)`: it passes through the origin and rises toward -Z.
 *
 * Derived rather than eyeballed — the centre offset is `-halfY / cos(a)`, which
 * is what puts the rotated face through y = 0 at z = 0 — and then verified with
 * a raycast by {@link expectRampSurface}.
 */
function addRamp(world: PhysicsWorld, degrees: number): BodyHandle {
  const a = (degrees * Math.PI) / 180;
  const halfY = 0.5;
  return world.addStaticCuboid(
    { x: 6, y: halfY, z: 9 },
    {
      position: { x: 0, y: -halfY / Math.cos(a), z: 0 },
      rotation: { x: Math.sin(a / 2), y: 0, z: 0, w: Math.cos(a / 2) },
      membership: CollisionLayer.World,
      friction: 0.9,
      debugName: `ramp-${degrees}`,
    },
  );
}

/** Fails the test if the ramp fixture is not the surface the test assumes. */
function expectRampSurface(world: PhysicsWorld, degrees: number, z: number): void {
  const expected = rampHeightAt(z, degrees);
  const hit = world.raycast({ x: 0, y: expected + 3, z }, { x: 0, y: -1, z: 0 }, 6, {
    layers: CollisionLayer.World,
  });
  expect(hit).not.toBeNull();
  expect(expected + 3 - hit!.distance).toBeCloseTo(expected, 3);
  // Normal of a slope rising toward -Z tilts toward +Z.
  expect(hit!.normal.y).toBeCloseTo(Math.cos((degrees * Math.PI) / 180), 3);
}

/** A solid block occupying z ∈ [-depth, 0] with its top at `topY`. */
function addLedge(world: PhysicsWorld, topY: number, depth = 6): BodyHandle {
  const halfY = (topY + 2) / 2;
  return world.addStaticCuboid(
    { x: 6, y: halfY, z: depth / 2 },
    {
      position: { x: 0, y: topY - halfY, z: -depth / 2 },
      membership: CollisionLayer.World,
      friction: 0.9,
      debugName: `ledge-${topY}`,
    },
  );
}

const STAIR_RISE = 0.18;
const STAIR_RUN = 0.32;
const STAIR_COUNT = 6;
const STAIR_TOP_Y = STAIR_RISE * STAIR_COUNT;

/** Six treads climbing toward -Z from z = 0, then a landing platform. */
function addStairs(world: PhysicsWorld): void {
  for (let i = 0; i < STAIR_COUNT; i += 1) {
    const topY = STAIR_RISE * (i + 1);
    const halfY = (topY + 2) / 2;
    world.addStaticCuboid(
      { x: 3, y: halfY, z: STAIR_RUN / 2 },
      {
        position: { x: 0, y: topY - halfY, z: -STAIR_RUN * i - STAIR_RUN / 2 },
        membership: CollisionLayer.World,
        friction: 0.9,
        debugName: `stair-${i}`,
      },
    );
  }

  const halfY = (STAIR_TOP_Y + 2) / 2;
  world.addStaticCuboid(
    { x: 3, y: halfY, z: 3 },
    {
      position: {
        x: 0,
        y: STAIR_TOP_Y - halfY,
        z: -STAIR_RUN * STAIR_COUNT - 3,
      },
      membership: CollisionLayer.World,
      friction: 0.9,
      debugName: 'stair-landing',
    },
  );
}

/** A soffit over z ∈ [-8, 0] whose underside is at `bottomY`. */
function addCeiling(world: PhysicsWorld, bottomY: number): BodyHandle {
  return world.addStaticCuboid(
    { x: 6, y: 0.5, z: 4 },
    {
      position: { x: 0, y: bottomY + 0.5, z: -4 },
      membership: CollisionLayer.World,
      debugName: `ceiling-${bottomY}`,
    },
  );
}

// ---------------------------------------------------------------------------
// Flat ground
// ---------------------------------------------------------------------------

describe('PlayerController on flat ground', () => {
  it('walks in the camera-relative direction at the authored speed', async () => {
    const world = await makeWorld();
    addFlatFloor(world);
    world.step();

    const { controller, input } = makeRig(world, { x: 0, y: 0, z: 0 });
    walkForward(input);
    drive(controller, input, world, 60, STEP_60);

    // yaw 0 faces -Z, so forward input must travel -Z and nothing else.
    expect(controller.position.z).toBeLessThan(-2.5);
    expect(controller.position.x).toBeCloseTo(0, 6);
    expect(controller.position.y).toBeCloseTo(0, 4);
    expect(controller.grounded).toBe(true);
    expect(controller.state).toBe('walk');
    expect(controller.horizontalSpeed).toBeCloseTo(T.walkSpeed, 2);
  });

  it('moves relative to camera yaw rather than world axes', async () => {
    const world = await makeWorld();
    addFlatFloor(world);
    world.step();

    const rig = makeRig(world, { x: 0, y: 0, z: 0 });
    rig.yaw.value = Math.PI / 2; // Facing -X.
    walkForward(rig.input);
    drive(rig.controller, rig.input, world, 60, STEP_60);

    expect(rig.controller.position.x).toBeLessThan(-2.5);
    expect(rig.controller.position.z).toBeCloseTo(0, 4);
  });

  it('sprints, crouches and stops at the authored speeds', async () => {
    const world = await makeWorld();
    addFlatFloor(world);
    world.step();

    const { controller, input } = makeRig(world, { x: 0, y: 0, z: 0 });
    walkForward(input);
    input.hold('sprint');
    drive(controller, input, world, 60, STEP_60);
    expect(controller.horizontalSpeed).toBeCloseTo(T.sprintSpeed, 2);
    expect(controller.state).toBe('sprint');

    input.release('sprint');
    input.hold('crouch');
    drive(controller, input, world, 90, STEP_60);
    expect(controller.height).toBeCloseTo(T.crouchHeight, 4);
    expect(controller.crouched).toBe(true);
    expect(controller.horizontalSpeed).toBeCloseTo(T.crouchSpeed, 2);
    expect(controller.state).toBe('crouch');

    input.release('crouch');
    input.setAxis('moveY', 0);
    drive(controller, input, world, 60, STEP_60);
    expect(controller.height).toBeCloseTo(T.standHeight, 4);
    expect(controller.horizontalSpeed).toBeCloseTo(0, 5);
    expect(controller.grounded).toBe(true);
  });

  it('honours toggle sprint and toggle crouch', async () => {
    const world = await makeWorld();
    addFlatFloor(world);
    world.step();

    const rig = makeRig(world, { x: 0, y: 0, z: 0 }, {
      holdToSprint: false,
      holdToCrouch: false,
    });
    walkForward(rig.input);

    rig.input.tap('sprint');
    drive(rig.controller, rig.input, world, 60, STEP_60);
    // Nothing is held any more, yet sprint latched on.
    expect(rig.controller.sprinting).toBe(true);
    expect(rig.controller.horizontalSpeed).toBeCloseTo(T.sprintSpeed, 2);

    rig.input.tap('sprint');
    drive(rig.controller, rig.input, world, 60, STEP_60);
    expect(rig.controller.sprinting).toBe(false);
    expect(rig.controller.horizontalSpeed).toBeCloseTo(T.walkSpeed, 2);

    rig.input.tap('crouch');
    drive(rig.controller, rig.input, world, 90, STEP_60);
    expect(rig.controller.crouched).toBe(true);

    rig.input.tap('crouch');
    drive(rig.controller, rig.input, world, 90, STEP_60);
    expect(rig.controller.crouched).toBe(false);
  });

  it('does not vibrate while standing still on the ground', async () => {
    const world = await makeWorld();
    addFlatFloor(world);
    world.step();

    const { controller, input } = makeRig(world, { x: 0, y: 0, z: 0 });
    drive(controller, input, world, 5, STEP_60);
    const settled = controller.position.y;

    let maxDrift = 0;
    drive(controller, input, world, 120, STEP_60, {
      after: () => {
        maxDrift = Math.max(maxDrift, Math.abs(controller.position.y - settled));
        expect(controller.grounded).toBe(true);
      },
    });
    // Spec §66 failure condition: vibrating. Sub-millimetre or it is a bug.
    expect(maxDrift).toBeLessThan(0.001);
  });
});

// ---------------------------------------------------------------------------
// Frame-rate independence
// ---------------------------------------------------------------------------

describe('PlayerController frame-rate independence', () => {
  it('travels the same distance in two seconds at 30 and 60 steps per second', async () => {
    const world = await makeWorld();
    addFlatFloor(world);
    world.step();

    // Far apart and on the Player layer, so the two capsules cannot see each
    // other; the world is stepped once and the geometry never changes.
    const fast = makeRig(world, { x: -6, y: 0, z: 0 });
    const slow = makeRig(world, { x: 6, y: 0, z: 0 });
    walkForward(fast.input);
    walkForward(slow.input);

    const fastStart = { ...fast.controller.position };
    const slowStart = { ...slow.controller.position };

    drive(fast.controller, fast.input, world, 120, STEP_60, { stepWorld: false });
    drive(slow.controller, slow.input, world, 60, STEP_30, { stepWorld: false });

    const fastDistance = planarDistance(fast.controller.position, fastStart);
    const slowDistance = planarDistance(slow.controller.position, slowStart);

    // Absolute sanity: two seconds of walking, less the acceleration ramp.
    const rampLoss = (T.walkSpeed * T.walkSpeed) / (2 * T.groundAcceleration);
    const ideal = T.walkSpeed * 2 - rampLoss;
    expect(fastDistance).toBeCloseTo(ideal, 2);

    // Spec §66 failure condition: different movement speed with FPS. The only
    // permitted difference comes from the single step in which acceleration
    // clamps to top speed; a dt bug shows up as tens of percent, not tenths.
    const error = Math.abs(fastDistance - slowDistance) / fastDistance;
    expect(error).toBeLessThan(0.005);
  });

  it('reaches the same jump apex at 30 and 60 steps per second', async () => {
    const world = await makeWorld();
    addFlatFloor(world);
    world.step();

    const apexAt = (steps: number, dt: number, x: number): number => {
      const rig = makeRig(world, { x, y: 0, z: 0 });
      let apex = 0;
      drive(rig.controller, rig.input, world, steps, dt, {
        before: (i) => {
          if (i === 2) rig.input.tap('jump');
        },
        after: () => {
          apex = Math.max(apex, rig.controller.position.y);
        },
        stepWorld: false,
      });
      rig.controller.dispose();
      return apex;
    };

    const apex60 = apexAt(60, STEP_60, -8);
    const apex30 = apexAt(30, STEP_30, 8);

    expect(apex60).toBeCloseTo(T.jumpHeight, 2);
    expect(apex30).toBeCloseTo(T.jumpHeight, 2);
    expect(Math.abs(apex60 - apex30)).toBeLessThan(0.01);
  });
});

// ---------------------------------------------------------------------------
// Slopes
// ---------------------------------------------------------------------------

describe('PlayerController on slopes', () => {
  it('walks up a 15 degree slope and stays glued to the surface', async () => {
    const world = await makeWorld();
    addRamp(world, 15);
    world.step();
    expectRampSurface(world, 15, -2);

    const spawnZ = 2;
    const { controller, input } = makeRig(world, {
      x: 0,
      y: rampHeightAt(spawnZ, 15),
      z: spawnZ,
    });
    walkForward(input);

    let leftGround = 0;
    let worstError = 0;
    drive(controller, input, world, 120, STEP_60, {
      after: (i) => {
        if (i < 3) return; // Settle onto the surface first.
        if (!controller.grounded) leftGround += 1;
        worstError = Math.max(
          worstError,
          Math.abs(controller.position.y - rampHeightAt(controller.position.z, 15)),
        );
      },
    });

    expect(controller.position.z).toBeLessThan(-3);
    expect(controller.position.y).toBeGreaterThan(1);
    // Snap-to-ground: never bounces off the ramp on the way up.
    expect(leftGround).toBe(0);
    expect(worstError).toBeLessThan(0.05);
  });

  it('walks down a 15 degree slope without leaving the ground', async () => {
    const world = await makeWorld();
    addRamp(world, 15);
    world.step();

    const spawnZ = -4;
    const { controller, input } = makeRig(world, {
      x: 0,
      y: rampHeightAt(spawnZ, 15),
      z: spawnZ,
    });
    input.setAxis('moveY', -1); // Backpedal downhill, still facing uphill.

    let leftGround = 0;
    drive(controller, input, world, 120, STEP_60, {
      after: (i) => {
        if (i >= 3 && !controller.grounded) leftGround += 1;
      },
    });

    expect(controller.position.z).toBeGreaterThan(-2.5);
    expect(controller.position.y).toBeLessThan(rampHeightAt(spawnZ, 15) - 0.3);
    expect(leftGround).toBe(0);
    expect(controller.position.y).toBeCloseTo(
      rampHeightAt(controller.position.z, 15),
      1,
    );
  });

  it('refuses to climb a slope steeper than the authored maximum', async () => {
    const steep = 58;
    expect(steep).toBeGreaterThan(T.maxSlopeDegrees);

    const world = await makeWorld();
    addHalfFloor(world);
    addRamp(world, steep);
    world.step();
    expectRampSurface(world, steep, -2);

    const { controller, input } = makeRig(world, { x: 0, y: 0, z: 3 });
    walkForward(input);
    drive(controller, input, world, 240, STEP_60);

    // Pressed against the ramp for four seconds and got nowhere up it. The
    // step-up envelope must not become a ratchet for unwalkable ground.
    expect(controller.position.y).toBeLessThan(0.1);
    expect(controller.position.z).toBeGreaterThan(-0.5);
  });

  it('slides back down when standing on unwalkable ground', async () => {
    const world = await makeWorld();
    addRamp(world, 58);
    world.step();

    const startZ = -3;
    const startY = rampHeightAt(startZ, 58);
    const { controller, input } = makeRig(world, { x: 0, y: startY, z: startZ });
    drive(controller, input, world, 60, STEP_60);

    // No input at all: gravity and the slide term take her downhill (+Z).
    expect(controller.position.z).toBeGreaterThan(startZ + 0.4);
    expect(controller.position.y).toBeLessThan(startY - 0.5);
    expect(controller.grounded).toBe(false);
    // Capped, so a long ramp is not a catapult.
    expect(controller.horizontalSpeed).toBeLessThanOrEqual(T.maxSlideSpeed + 0.5);
  });
});

// ---------------------------------------------------------------------------
// Steps and stairs
// ---------------------------------------------------------------------------

describe('PlayerController step-up and stairs', () => {
  it('steps up over a ledge below the step height', async () => {
    const ledgeY = 0.25;
    expect(ledgeY).toBeLessThan(T.stepHeight);

    const world = await makeWorld();
    addHalfFloor(world);
    addLedge(world, ledgeY);
    world.step();

    const { controller, input } = makeRig(world, { x: 0, y: 0, z: 2 });
    walkForward(input);
    drive(controller, input, world, 120, STEP_60);

    expect(controller.position.y).toBeCloseTo(ledgeY, 2);
    expect(controller.position.z).toBeLessThan(-1);
    expect(controller.grounded).toBe(true);
  });

  it('is blocked by an obstacle above the step height', async () => {
    const wallY = 0.75;
    expect(wallY).toBeGreaterThan(T.stepHeight);

    const world = await makeWorld();
    addHalfFloor(world);
    addLedge(world, wallY);
    world.step();

    const rig = makeRig(world, { x: 0, y: 0, z: 2 }, {});
    walkForward(rig.input);
    drive(rig.controller, rig.input, world, 180, STEP_60);

    expect(rig.controller.position.y).toBeCloseTo(0, 3);
    // Stopped a capsule radius short of the face, give or take the skin.
    expect(rig.controller.position.z).toBeGreaterThan(0.2);
    expect(rig.controller.position.z).toBeLessThan(0.45);
    expect(rig.controller.grounded).toBe(true);
  });

  it('climbs stairs without snagging', async () => {
    const world = await makeWorld();
    addHalfFloor(world);
    addStairs(world);
    world.step();

    const { controller, input } = makeRig(world, { x: 0, y: 0, z: 2 });
    walkForward(input);

    const start = { ...controller.position };
    let leftGround = 0;
    const seconds = 2;
    drive(controller, input, world, seconds * 60, STEP_60, {
      after: (i) => {
        if (i >= 3 && !controller.grounded) leftGround += 1;
      },
    });

    expect(controller.position.y).toBeCloseTo(STAIR_TOP_Y, 2);
    expect(controller.grounded).toBe(true);
    expect(leftGround).toBe(0);

    // Spec §66 failure condition: stair snagging. Treads must not cost speed,
    // so the horizontal distance covered has to stay close to flat-ground
    // travel over the same time.
    const travelled = planarDistance(controller.position, start);
    const rampLoss = (T.walkSpeed * T.walkSpeed) / (2 * T.groundAcceleration);
    const ideal = T.walkSpeed * seconds - rampLoss;
    expect(travelled / ideal).toBeGreaterThan(0.92);
  });

  it('descends stairs without leaving the ground', async () => {
    const world = await makeWorld();
    addHalfFloor(world);
    addStairs(world);
    world.step();

    const { controller, input } = makeRig(world, {
      x: 0,
      y: STAIR_TOP_Y,
      z: -STAIR_RUN * STAIR_COUNT - 1,
    });
    input.setAxis('moveY', -1); // Walk back toward +Z, down the steps.

    let leftGround = 0;
    drive(controller, input, world, 150, STEP_60, {
      after: (i) => {
        if (i >= 3 && !controller.grounded) leftGround += 1;
      },
    });

    expect(controller.position.z).toBeGreaterThan(0.5);
    expect(controller.position.y).toBeCloseTo(0, 2);
    expect(leftGround).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Crouch and headroom
// ---------------------------------------------------------------------------

describe('PlayerController crouch and headroom', () => {
  it('refuses to stand up under a ceiling and stands once clear', async () => {
    const ceilingY = 1.4;
    expect(ceilingY).toBeGreaterThan(T.crouchHeight);
    expect(ceilingY).toBeLessThan(T.standHeight);

    const world = await makeWorld();
    addFlatFloor(world);
    addCeiling(world, ceilingY);
    world.step();

    const { controller, input } = makeRig(world, { x: 0, y: 0, z: 2 });

    // Crouch first, then walk under: a standing capsule is correctly blocked
    // by the soffit's leading face.
    input.hold('crouch');
    drive(controller, input, world, 60, STEP_60);
    expect(controller.height).toBeCloseTo(T.crouchHeight, 4);

    walkForward(input);
    drive(controller, input, world, 180, STEP_60);
    expect(controller.position.z).toBeLessThan(-1);
    expect(controller.canStandUp).toBe(false);

    // Release crouch under the soffit. Standing up must be refused outright.
    input.release('crouch');
    input.setAxis('moveY', 0);
    drive(controller, input, world, 120, STEP_60, {
      after: () => {
        expect(controller.height).toBeCloseTo(T.crouchHeight, 4);
        expect(controller.crouched).toBe(true);
      },
    });

    // Back out into the open and she stands.
    input.setAxis('moveY', -1);
    drive(controller, input, world, 180, STEP_60);
    expect(controller.position.z).toBeGreaterThan(0.5);
    expect(controller.height).toBeCloseTo(T.standHeight, 4);
    expect(controller.crouched).toBe(false);
  });

  it('does not jump out of a crouch when there is no headroom', async () => {
    const world = await makeWorld();
    addFlatFloor(world);
    addCeiling(world, 1.4);
    world.step();

    const { controller, input } = makeRig(world, { x: 0, y: 0, z: -2 });
    input.hold('crouch');
    drive(controller, input, world, 60, STEP_60);
    expect(controller.canStandUp).toBe(false);

    input.tap('jump');
    drive(controller, input, world, 30, STEP_60, {
      after: () => {
        expect(controller.position.y).toBeCloseTo(0, 3);
      },
    });
    expect(controller.grounded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Jumping
// ---------------------------------------------------------------------------

describe('PlayerController jumping', () => {
  it('reaches the authored apex and reports the landing', async () => {
    const world = await makeWorld();
    addFlatFloor(world);
    world.step();

    const { controller, input } = makeRig(world, { x: 0, y: 0, z: 0 });
    const landings: number[] = [];
    const states: PlayerMoveState[] = [];
    controller.on('landed', ({ impactSpeed }) => landings.push(impactSpeed));
    controller.on('stateChanged', ({ state }) => states.push(state));

    let apex = 0;
    drive(controller, input, world, 120, STEP_60, {
      before: (i) => {
        if (i === 5) input.tap('jump');
      },
      after: () => {
        apex = Math.max(apex, controller.position.y);
      },
    });

    expect(apex).toBeCloseTo(T.jumpHeight, 2);
    expect(controller.grounded).toBe(true);
    expect(controller.position.y).toBeCloseTo(0, 3);

    // Landing impact must match the ballistic arc, not be reported as zero.
    // Settling onto the spawn point is not a landing and emits nothing.
    const expectedImpact = Math.sqrt(2 * T.gravity * T.jumpHeight);
    expect(landings.length).toBe(1);
    expect(landings[0]).toBeCloseTo(expectedImpact, 1);
    expect(controller.lastLandingImpact).toBeCloseTo(expectedImpact, 1);

    expect(states).toContain('jump');
    expect(states).toContain('air');
    expect(states).toContain('land');
    expect(states[states.length - 1]).toBe('walk');
  });

  it('keeps reduced but non-zero air control', async () => {
    const world = await makeWorld();
    addFlatFloor(world);
    world.step();

    const rig = makeRig(world, { x: 0, y: 0, z: 0 });
    drive(rig.controller, rig.input, world, 5, STEP_60);
    rig.input.tap('jump');
    rig.controller.fixedUpdate(STEP_60);
    rig.input.endStep();
    expect(rig.controller.grounded).toBe(false);

    // Steer sideways only while airborne.
    rig.input.setAxis('moveX', 1);
    drive(rig.controller, rig.input, world, 20, STEP_60);

    const sideways = rig.controller.position.x;
    expect(sideways).toBeGreaterThan(0.02);
    // Reduced: 20 steps of air control cannot reach full walking speed.
    expect(rig.controller.horizontalSpeed).toBeLessThan(T.walkSpeed);
    expect(rig.controller.horizontalSpeed).toBeGreaterThan(0);
  });

  it('allows a jump within the coyote window after walking off a ledge', async () => {
    const world = await makeWorld();
    world.addStaticCuboid(
      { x: 3, y: 0.5, z: 0.5 },
      { position: { x: 0, y: -0.5, z: 0 }, membership: CollisionLayer.World },
    );
    world.step();

    const { controller, input } = makeRig(world, { x: 0, y: 0, z: 0.3 });
    drive(controller, input, world, 5, STEP_60);
    expect(controller.grounded).toBe(true);

    // Walk until the ledge runs out; stop on the first airborne step.
    walkForward(input);
    drive(controller, input, world, 120, STEP_60, {
      before: () => controller.grounded,
    });
    expect(controller.grounded).toBe(false);
    expect(controller.coyoteRemaining).toBeGreaterThan(0);

    input.tap('jump');
    controller.fixedUpdate(STEP_60);
    input.endStep();

    expect(controller.velocity.y).toBeGreaterThan(3);
    expect(controller.state).toBe('jump');
  });

  it('refuses a jump once the coyote window has expired', async () => {
    const world = await makeWorld();
    world.addStaticCuboid(
      { x: 3, y: 0.5, z: 0.5 },
      { position: { x: 0, y: -0.5, z: 0 }, membership: CollisionLayer.World },
    );
    world.step();

    const { controller, input } = makeRig(world, { x: 0, y: 0, z: 0.3 });
    walkForward(input);
    drive(controller, input, world, 300, STEP_60, {
      before: () => controller.airTime <= T.coyoteTime + 0.1,
    });

    expect(controller.grounded).toBe(false);
    expect(controller.coyoteRemaining).toBe(0);

    const before = controller.velocity.y;
    input.tap('jump');
    controller.fixedUpdate(STEP_60);
    input.endStep();

    // Still falling, and falling faster than before: no free mid-air jump.
    expect(controller.velocity.y).toBeLessThan(before);
    expect(controller.velocity.y).toBeLessThan(0);
  });

  it('fires a buffered jump on landing', async () => {
    const world = await makeWorld();
    addFlatFloor(world);
    world.step();

    /**
     * Drops from 1.5 m and, on the step where she first passes 0.25 m while
     * still airborne, optionally presses jump. The press edge lasts a single
     * step, so any height above that point afterwards can only come from the
     * buffer surviving until touchdown. The `press = false` run arms at the
     * same instant and is a true control.
     */
    const peakAfterArming = (press: boolean, x: number): number => {
      const rig = makeRig(world, { x, y: 1.5, z: 0 });
      let armed = false;
      let peak = 0;
      drive(rig.controller, rig.input, world, 180, STEP_60, {
        before: () => {
          if (!armed && !rig.controller.grounded && rig.controller.position.y < 0.25) {
            if (press) rig.input.tap('jump');
            armed = true;
          }
        },
        after: () => {
          if (armed) peak = Math.max(peak, rig.controller.position.y);
        },
        stepWorld: false,
      });
      expect(armed).toBe(true);
      rig.controller.dispose();
      return peak;
    };

    const control = peakAfterArming(false, 8);
    const buffered = peakAfterArming(true, -8);

    // Control: falling to rest never rises again.
    expect(control).toBeLessThan(0.25);
    // Buffered: the press below 0.25 m produced a full jump after touchdown.
    expect(buffered).toBeGreaterThan(T.jumpHeight * 0.8);
  });

  it('does not tunnel through the floor after a long fall', async () => {
    const world = await makeWorld();
    addFlatFloor(world);
    world.step();

    // 30 Hz makes each step 1.5 m at terminal velocity — the case that breaks
    // naive controllers.
    const { controller, input } = makeRig(world, { x: 0, y: 200, z: 0 });

    let lowest = Number.POSITIVE_INFINITY;
    let fastest = 0;
    drive(controller, input, world, 300, STEP_30, {
      after: () => {
        lowest = Math.min(lowest, controller.position.y);
        fastest = Math.max(fastest, -controller.velocity.y);
      },
    });

    expect(controller.grounded).toBe(true);
    expect(controller.position.y).toBeCloseTo(0, 3);
    expect(lowest).toBeGreaterThan(-0.001);
    expect(fastest).toBeLessThanOrEqual(T.terminalVelocity + 1e-9);
    expect(fastest).toBeCloseTo(T.terminalVelocity, 5);
  });
});

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

describe('PlayerController in shallow water', () => {
  it('slows by the authored amount and blocks sprinting when deep enough', async () => {
    const world = await makeWorld();
    addFlatFloor(world);
    world.step();

    interface Run {
      distance: number;
      speed: number;
    }

    const measure = (depth: number, sprint: boolean, x: number): Run => {
      const rig = makeRig(world, { x, y: 0, z: 0 });
      rig.controller.setWaterDepth(depth);
      walkForward(rig.input);
      if (sprint) rig.input.hold('sprint');
      const start = { ...rig.controller.position };
      drive(rig.controller, rig.input, world, 120, STEP_60, { stepWorld: false });
      const run = {
        distance: planarDistance(rig.controller.position, start),
        speed: rig.controller.horizontalSpeed,
      };
      rig.controller.dispose();
      return run;
    };

    const dry = measure(0, false, -12);
    const wet = measure(0.6, false, 0);

    const depth = 0.6;
    const t = (depth - T.waterAnkleDepth) / (T.waterWaistDepth - T.waterAnkleDepth);
    const expected = 1 + (T.waterDeepMultiplier - 1) * t;

    expect(dry.speed).toBeCloseTo(T.walkSpeed, 6);
    expect(wet.distance).toBeLessThan(dry.distance);
    // Steady-state speed is exact; distance also carries the acceleration ramp.
    expect(wet.speed / dry.speed).toBeCloseTo(expected, 6);

    // Ankle-deep water must not be a tax on ordinary walking.
    const puddle = measure(T.waterAnkleDepth, false, 12);
    expect(puddle.speed).toBeCloseTo(T.walkSpeed, 6);

    // Sprinting is refused past the wading depth.
    const sprintDeep = measure(T.waterSprintDepth + 0.1, true, 24);
    const walkDeep = measure(T.waterSprintDepth + 0.1, false, 36);
    expect(sprintDeep.speed).toBeCloseTo(walkDeep.speed, 6);
    expect(sprintDeep.speed).toBeLessThan(T.walkSpeed);

    // But it still works in a puddle.
    const sprintShallow = measure(0.1, true, -24);
    expect(sprintShallow.speed).toBeCloseTo(T.sprintSpeed, 6);
  });
});

// ---------------------------------------------------------------------------
// Vault, platforms, suspension
// ---------------------------------------------------------------------------

describe('PlayerController contextual actions', () => {
  it('vaults over a waist-high obstacle', async () => {
    const world = await makeWorld();
    addFlatFloor(world);
    // A 0.9 m parapet, 0.4 m thick, at z ∈ [-1.4, -1.0].
    world.addStaticCuboid(
      { x: 4, y: 0.45, z: 0.2 },
      { position: { x: 0, y: 0.45, z: -1.2 }, membership: CollisionLayer.World },
    );
    world.step();

    const { controller, input } = makeRig(world, { x: 0, y: 0, z: 1 });
    walkForward(input);
    drive(controller, input, world, 60, STEP_60);

    // Walked into it and stopped: too tall to step over.
    expect(controller.position.z).toBeGreaterThan(-1);
    const before = controller.position.z;

    input.tap('jump');
    drive(controller, input, world, 60, STEP_60);

    expect(controller.position.z).toBeLessThan(-1.4);
    expect(controller.position.z).toBeLessThan(before - 0.5);
    expect(controller.position.y).toBeCloseTo(0, 2);
    expect(controller.grounded).toBe(true);
    expect(controller.vaulting).toBe(false);
  });

  it('is carried by ground velocity only while grounded', async () => {
    const world = await makeWorld();
    addFlatFloor(world);
    world.step();

    const { controller, input } = makeRig(world, { x: 0, y: 0, z: 0 });
    controller.setGroundCarryVelocity({ x: 2, y: 0, z: 0 });
    drive(controller, input, world, 60, STEP_60);

    expect(controller.position.x).toBeCloseTo(2, 1);
    // Carried, not accelerated: the player's own velocity stays zero.
    expect(controller.horizontalSpeed).toBeCloseTo(0, 5);

    const carriedTo = controller.position.x;
    input.tap('jump');
    drive(controller, input, world, 10, STEP_60);
    expect(controller.grounded).toBe(false);
    expect(controller.position.x).toBeCloseTo(carriedTo, 3);
  });

  it('drops player agency but not gravity when movement is disabled', async () => {
    const world = await makeWorld();
    addFlatFloor(world);
    world.step();

    const { controller, input } = makeRig(world, { x: 0, y: 2, z: 0 });
    controller.setMovementEnabled(false);
    walkForward(input);
    input.hold('sprint');
    input.tap('jump');
    drive(controller, input, world, 90, STEP_60);

    expect(controller.position.z).toBeCloseTo(0, 4);
    expect(controller.position.y).toBeCloseTo(0, 3);
    expect(controller.grounded).toBe(true);
  });

  it('clears feel timers on teleport', async () => {
    const world = await makeWorld();
    addFlatFloor(world);
    world.step();

    const { controller, input } = makeRig(world, { x: 0, y: 0, z: 0 });
    walkForward(input);
    drive(controller, input, world, 60, STEP_60);
    expect(controller.horizontalSpeed).toBeGreaterThan(1);

    controller.teleport({ x: 5, y: 0, z: 5 }, 1.2);
    expect(controller.position).toEqual({ x: 5, y: 0, z: 5 });
    expect(controller.horizontalSpeed).toBe(0);
    expect(controller.coyoteRemaining).toBe(0);
    expect(controller.jumpBufferRemaining).toBe(0);
    expect(controller.facingYaw).toBeCloseTo(1.2, 6);
  });
});

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

function makeCameraRig(
  world: PhysicsWorld | undefined,
  target: CameraFollowTarget,
  display: CameraDisplayPreferences,
) {
  const input = new FakeInput();
  const camera = new PlayerCamera({
    input,
    target: () => target,
    physics: world,
    display: () => display,
  });
  return { input, camera };
}

describe('PlayerCamera', () => {
  const standing: CameraFollowTarget = {
    position: { x: 0, y: 0, z: 0 },
    height: DEFAULT_PLAYER_TUNING.standHeight,
    horizontalSpeed: 0,
  };

  it('sits behind and over the shoulder, never in front of the player', async () => {
    const world = await makeWorld();
    addFlatFloor(world);
    world.step();

    const { camera } = makeCameraRig(world, standing, { fov: 70, cameraShake: 0 });
    camera.fixedUpdate(STEP_60);

    // yaw 0 looks toward -Z, so the camera must be on the +Z side.
    expect(camera.position.z).toBeGreaterThan(1);
    expect(camera.position.x).toBeCloseTo(DEFAULT_CAMERA_TUNING.shoulderOffset, 1);
    expect(camera.distance).toBeCloseTo(DEFAULT_CAMERA_TUNING.distance, 3);
    expect(camera.fov).toBe(70);
  });

  it('pulls in on a wall and never ends up inside geometry', async () => {
    const world = await makeWorld();
    addFlatFloor(world);
    // A wall 1.2 m behind the player, right where the boom wants to be.
    world.addStaticCuboid(
      { x: 8, y: 3, z: 0.25 },
      { position: { x: 0, y: 3, z: 1.45 }, membership: CollisionLayer.World },
    );
    world.step();

    const { camera } = makeCameraRig(world, standing, { fov: 70, cameraShake: 0 });
    for (let i = 0; i < 60; i += 1) camera.fixedUpdate(STEP_60);

    expect(camera.distance).toBeLessThan(DEFAULT_CAMERA_TUNING.distance);
    expect(camera.distance).toBeGreaterThanOrEqual(DEFAULT_CAMERA_TUNING.minDistance);
    expect(camera.position.z).toBeLessThan(1.2);

    // The real assertion: an unobstructed line from the player's head to the
    // camera. If the camera were inside the wall this cast would hit it.
    const pivot = {
      x: standing.position.x,
      y: standing.position.y + standing.height - DEFAULT_CAMERA_TUNING.pivotInset,
      z: standing.position.z,
    };
    const toCamera = {
      x: camera.position.x - pivot.x,
      y: camera.position.y - pivot.y,
      z: camera.position.z - pivot.z,
    };
    const length = Math.hypot(toCamera.x, toCamera.y, toCamera.z);
    const blocked = world.raycast(pivot, toCamera, length + 0.001, {
      layers: CollisionLayer.World,
    });
    expect(blocked).toBeNull();

    // And it never climbs inside the player's own capsule.
    const radial = Math.hypot(
      camera.position.x - standing.position.x,
      camera.position.z - standing.position.z,
    );
    expect(radial).toBeGreaterThan(DEFAULT_PLAYER_TUNING.radius);
  });

  it('extends back out at a limited rate once the wall is gone', async () => {
    const world = await makeWorld();
    addFlatFloor(world);
    const wall = world.addStaticCuboid(
      { x: 8, y: 3, z: 0.25 },
      { position: { x: 0, y: 3, z: 1.45 }, membership: CollisionLayer.World },
    );
    world.step();

    const { camera } = makeCameraRig(world, standing, { fov: 70, cameraShake: 0 });
    for (let i = 0; i < 30; i += 1) camera.fixedUpdate(STEP_60);
    const pulledIn = camera.distance;
    expect(pulledIn).toBeLessThan(DEFAULT_CAMERA_TUNING.distance);

    world.removeBody(wall);
    world.step();

    camera.fixedUpdate(STEP_60);
    const afterOneStep = camera.distance;
    // Eases out rather than snapping.
    expect(afterOneStep - pulledIn).toBeLessThan(
      DEFAULT_CAMERA_TUNING.returnSpeed * STEP_60 + 1e-6,
    );

    for (let i = 0; i < 120; i += 1) camera.fixedUpdate(STEP_60);
    expect(camera.distance).toBeCloseTo(DEFAULT_CAMERA_TUNING.distance, 3);
  });

  it('tightens indoors', async () => {
    const world = await makeWorld();
    addFlatFloor(world);
    world.addStaticCuboid(
      { x: 8, y: 0.25, z: 8 },
      { position: { x: 0, y: 2.6, z: 0 }, membership: CollisionLayer.World },
    );
    world.step();

    const { camera } = makeCameraRig(world, standing, { fov: 70, cameraShake: 0 });
    for (let i = 0; i < 120; i += 1) camera.fixedUpdate(STEP_60);

    expect(camera.indoor).toBe(true);
    expect(camera.distance).toBeLessThanOrEqual(
      DEFAULT_CAMERA_TUNING.indoorDistance + 1e-6,
    );

    camera.setIndoorOverride(false);
    expect(camera.indoor).toBe(false);
  });

  it('integrates a stick as a rate and a mouse as radians', async () => {
    const gamepad = makeCameraRig(undefined, standing, { fov: 70, cameraShake: 0 });
    gamepad.input.activeFamily = 'gamepad';
    gamepad.input.setAxis('lookX', 1);
    for (let i = 0; i < 60; i += 1) gamepad.camera.fixedUpdate(STEP_60);
    // One second at full deflection turns exactly one yawRate, to the right.
    expect(gamepad.camera.yaw).toBeCloseTo(-DEFAULT_CAMERA_TUNING.yawRate, 5);

    // The mouse writes a displacement, so the same axis value must produce the
    // same rotation regardless of step size. This is the documented seam.
    const mouseAt = (steps: number, dt: number): number => {
      const rig = makeCameraRig(undefined, standing, { fov: 70, cameraShake: 0 });
      rig.input.activeFamily = 'keyboard';
      rig.input.setAxis('lookX', 0.1);
      for (let i = 0; i < steps; i += 1) rig.camera.fixedUpdate(dt);
      return rig.camera.yaw;
    };
    expect(mouseAt(10, STEP_60)).toBeCloseTo(-1, 6);
    expect(mouseAt(10, STEP_30)).toBeCloseTo(-1, 6);
  });

  it('consumes an additive look delta exactly once and clamps pitch', async () => {
    const { camera } = makeCameraRig(undefined, standing, { fov: 70, cameraShake: 0 });
    camera.setOrientation(0, 0);

    camera.addLookDelta(0.2, 0.1);
    camera.addLookDelta(0.1, 0.1);
    camera.fixedUpdate(STEP_60);
    expect(camera.yaw).toBeCloseTo(-0.3, 6);
    expect(camera.pitch).toBeCloseTo(0.2, 6);

    camera.fixedUpdate(STEP_60);
    expect(camera.yaw).toBeCloseTo(-0.3, 6);
    expect(camera.pitch).toBeCloseTo(0.2, 6);

    camera.addLookDelta(0, 99);
    camera.fixedUpdate(STEP_60);
    expect(camera.pitch).toBeCloseTo(DEFAULT_CAMERA_TUNING.maxPitch, 6);

    camera.addLookDelta(0, -99);
    camera.fixedUpdate(STEP_60);
    expect(camera.pitch).toBeCloseTo(DEFAULT_CAMERA_TUNING.minPitch, 6);
  });

  it('shakes when allowed and produces exactly zero offset when disabled', async () => {
    const enabled = makeCameraRig(undefined, standing, { fov: 70, cameraShake: 1 });
    enabled.camera.fixedUpdate(STEP_60);
    const baseline = { ...enabled.camera.position };
    expect(enabled.camera.shake(1, 0.5)).toBe(true);

    let moved = 0;
    for (let i = 0; i < 20; i += 1) {
      enabled.camera.fixedUpdate(STEP_60);
      moved = Math.max(
        moved,
        Math.hypot(
          enabled.camera.position.x - baseline.x,
          enabled.camera.position.y - baseline.y,
          enabled.camera.position.z - baseline.z,
        ),
      );
    }
    expect(moved).toBeGreaterThan(0.005);

    // Accessibility: 0 means no shake at all, not a small one.
    const display = { fov: 70, cameraShake: 0 };
    const off = makeCameraRig(undefined, standing, display);
    off.camera.fixedUpdate(STEP_60);
    const still = { ...off.camera.position };

    expect(off.camera.shake(1, 0.5)).toBe(false);
    for (let i = 0; i < 20; i += 1) {
      off.camera.fixedUpdate(STEP_60);
      expect(off.camera.shakeOffset.x).toBe(0);
      expect(off.camera.shakeOffset.y).toBe(0);
      expect(off.camera.shakeOffset.z).toBe(0);
      expect(off.camera.position.x).toBe(still.x);
      expect(off.camera.position.y).toBe(still.y);
      expect(off.camera.position.z).toBe(still.z);
    }
    expect(off.camera.shaking).toBe(false);
  });

  it('reads FOV from settings on every step', async () => {
    const display = { fov: 70, cameraShake: 0 };
    const { camera } = makeCameraRig(undefined, standing, display);
    camera.fixedUpdate(STEP_60);
    expect(camera.getPose().fov).toBe(70);

    display.fov = 88;
    camera.fixedUpdate(STEP_60);
    expect(camera.getPose().fov).toBe(88);
  });

  it('drives the controller: the player walks where the camera looks', async () => {
    const world = await makeWorld();
    addFlatFloor(world);
    world.step();

    const input = new FakeInput();
    const preferences = { holdToSprint: true, holdToCrouch: true };
    const controller: PlayerController = new PlayerController({
      physics: world,
      input,
      // Safe as a closure: the controller only calls this from fixedUpdate,
      // which is why its constructor takes `spawnYaw` instead.
      getYaw: (): number => camera.yaw,
      spawn: { x: 0, y: 0, z: 0 },
      preferences: () => preferences,
    });
    const camera: PlayerCamera = new PlayerCamera({
      input,
      target: () => controller,
      physics: world,
      excludeBody: controller.bodyHandle,
    });

    // Turn 90° left with the mouse channel, then walk forward.
    camera.addLookDelta(-Math.PI / 2, 0);
    camera.fixedUpdate(STEP_60);
    expect(camera.yaw).toBeCloseTo(Math.PI / 2, 6);

    input.setAxis('moveY', 1);
    for (let i = 0; i < 60; i += 1) {
      camera.fixedUpdate(STEP_60);
      controller.fixedUpdate(STEP_60);
      input.endStep();
      world.step();
    }

    // Yaw +π/2 faces -X.
    expect(controller.position.x).toBeLessThan(-2.5);
    expect(controller.position.z).toBeCloseTo(0, 3);
    // The camera trails on the +X side and keeps out of the player.
    expect(camera.position.x).toBeGreaterThan(controller.position.x);
  });
});
