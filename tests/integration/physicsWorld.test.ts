/**
 * PhysicsWorld integration tests.
 *
 * These run the real Rapier WASM module — nothing here is mocked. A mocked
 * physics engine would assert that our wrapper calls methods, not that bodies
 * fall, rest, filter or reproduce. The whole point of the fixed-timestep
 * design is deterministic simulation, so that is asserted against the actual
 * solver or not at all.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  PhysicsWorld,
  interactionGroups,
  groupMembership,
  groupFilter,
  groupsInteract,
  ALL_LAYERS,
  type BodyHandle,
} from '@/engine/physics/PhysicsWorld';
import { CollisionLayer } from '@/engine/ecs/components';

const HZ = 60;
const STEP = 1 / HZ;
const GRAVITY = -9.81;

/** Worlds are freed after every test so WASM allocations do not accumulate. */
const openWorlds: PhysicsWorld[] = [];

async function makeWorld(
  options: Parameters<typeof PhysicsWorld.create>[0] = {},
): Promise<PhysicsWorld> {
  const world = await PhysicsWorld.create({ hz: HZ, ...options });
  openWorlds.push(world);
  return world;
}

afterEach(() => {
  for (const world of openWorlds.splice(0)) {
    if (!world.isDisposed) world.dispose();
  }
});

/** A 20x20 floor slab whose top surface sits at y = 0.5. */
function addFloor(world: PhysicsWorld, layer = CollisionLayer.World): BodyHandle {
  return world.addStaticCuboid(
    { x: 10, y: 0.5, z: 10 },
    { position: { x: 0, y: 0, z: 0 }, membership: layer, debugName: 'floor' },
  );
}

const FLOOR_TOP = 0.5;

function stepN(world: PhysicsWorld, n: number): void {
  for (let i = 0; i < n; i += 1) world.step();
}

function yOf(world: PhysicsWorld, handle: BodyHandle): number {
  const position = world.getBodyPosition(handle);
  expect(position).not.toBeNull();
  return position!.y;
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

describe('PhysicsWorld initialisation', () => {
  it('loads Rapier and produces a usable world', async () => {
    const world = await makeWorld();

    expect(world.isDisposed).toBe(false);
    expect(world.stepSeconds).toBeCloseTo(STEP, 12);
    expect(world.hz).toBe(HZ);
    expect(world.gravityY).toBeCloseTo(GRAVITY, 6);
    expect(world.bodyCount).toBe(0);
    expect(world.stepCount).toBe(0);
  });

  it('shares one Rapier init across multiple worlds', async () => {
    const [a, b] = await Promise.all([makeWorld(), makeWorld()]);

    a.addDynamicBall(0.5, { position: { x: 0, y: 4, z: 0 }, membership: CollisionLayer.Debris });
    b.addDynamicBall(0.5, { position: { x: 0, y: 4, z: 0 }, membership: CollisionLayer.Debris });

    expect(a.bodyCount).toBe(1);
    expect(b.bodyCount).toBe(1);
  });

  it('advances exactly one fixed step per step() call', async () => {
    const world = await makeWorld();
    stepN(world, 7);
    expect(world.stepCount).toBe(7);
  });

  it('accepts a non-default simulation rate', async () => {
    const world = await makeWorld({ hz: 120 });
    expect(world.hz).toBe(120);
    expect(world.stepSeconds).toBeCloseTo(1 / 120, 12);
  });
});

// ---------------------------------------------------------------------------
// Gravity
// ---------------------------------------------------------------------------

describe('PhysicsWorld gravity', () => {
  it('makes a dynamic body fall', async () => {
    const world = await makeWorld();
    const ball = world.addDynamicBall(0.5, {
      position: { x: 0, y: 100, z: 0 },
      membership: CollisionLayer.Debris,
    });

    let previous = yOf(world, ball);
    expect(previous).toBe(100);

    // Monotonic descent, not just "ended up lower".
    for (let i = 0; i < 60; i += 1) {
      world.step();
      const y = yOf(world, ball);
      expect(y).toBeLessThan(previous);
      previous = y;
    }

    // Discrete integration overshoots the analytic solution slightly, so the
    // drop is compared as a ratio. This still fails if gravity or the timestep
    // is wrong by even 1%, without hard-coding Rapier's exact integrator.
    const seconds = 60 * STEP;
    const analyticDrop = 0.5 * -GRAVITY * seconds * seconds;
    const actualDrop = 100 - yOf(world, ball);
    expect(actualDrop / analyticDrop).toBeGreaterThan(0.99);
    expect(actualDrop / analyticDrop).toBeLessThan(1.01);

    const velocity = world.getLinearVelocity(ball);
    expect(velocity).not.toBeNull();
    expect(velocity!.y).toBeCloseTo(GRAVITY * seconds, 2);
    expect(velocity!.x).toBe(0);
    expect(velocity!.z).toBe(0);
  });

  it('honours a custom gravity value', async () => {
    const world = await makeWorld({ gravityY: 0 });
    const ball = world.addDynamicBall(0.5, {
      position: { x: 0, y: 10, z: 0 },
      membership: CollisionLayer.Debris,
    });

    stepN(world, 120);
    expect(yOf(world, ball)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Resting and tunnelling
// ---------------------------------------------------------------------------

describe('PhysicsWorld contacts', () => {
  it('rests a dynamic body on a static floor without tunnelling', async () => {
    const world = await makeWorld();
    const floor = addFloor(world);
    const radius = 0.5;
    const ball = world.addDynamicBall(radius, {
      position: { x: 0, y: 6, z: 0 },
      membership: CollisionLayer.Debris,
    });

    expect(world.getBodyKind(floor)).toBe('static');
    expect(world.getBodyKind(ball)).toBe('dynamic');

    // 3 simulated seconds: long enough to fall 5.5 m and settle.
    for (let i = 0; i < 180; i += 1) {
      world.step();
      // Never passes through the slab at any point in the trajectory.
      expect(yOf(world, ball)).toBeGreaterThan(FLOOR_TOP - 0.05);
    }

    const resting = yOf(world, ball);
    expect(resting).toBeGreaterThan(FLOOR_TOP);
    expect(resting).toBeCloseTo(FLOOR_TOP + radius, 1);

    // A settled body stops consuming solver time.
    expect(world.isSleeping(ball)).toBe(true);
    // ...but Rapier slept it for coming to rest, not us for being far away.
    expect(world.isFarAsleep(ball)).toBe(false);
  });

  it('does not tunnel a fast body through the floor when CCD is on', async () => {
    const world = await makeWorld();
    addFloor(world);
    const ball = world.addDynamicBall(0.15, {
      position: { x: 0, y: 30, z: 0 },
      membership: CollisionLayer.Debris,
      ccd: true,
    });
    // 300 m/s at 60 Hz is 5 m per step — far thicker than the 1 m slab.
    world.setLinearVelocity(ball, { x: 0, y: -300, z: 0 });

    for (let i = 0; i < 120; i += 1) {
      world.step();
      expect(yOf(world, ball)).toBeGreaterThan(FLOOR_TOP - 0.05);
    }
  });

  it('collides against a static trimesh floor regardless of winding', async () => {
    const world = await makeWorld();
    // A flat quad at y = 0. This winding gives downward-facing normals, which
    // is exactly the export mistake the unoriented default must tolerate.
    const vertices = new Float32Array([
      -10, 0, -10,
      10, 0, -10,
      10, 0, 10,
      -10, 0, 10,
    ]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const mesh = world.addStaticTrimesh(vertices, indices, {
      membership: CollisionLayer.World,
      debugName: 'sector-collision',
    });

    expect(world.getBodyKind(mesh)).toBe('static');
    expect(world.getDebugName(mesh)).toBe('sector-collision');

    const radius = 0.4;
    const ball = world.addDynamicBall(radius, {
      position: { x: 0, y: 4, z: 0 },
      membership: CollisionLayer.Debris,
    });

    stepN(world, 240);
    const resting = yOf(world, ball);
    expect(resting).toBeGreaterThan(0);
    expect(resting).toBeCloseTo(radius, 1);
  });

  it('collides against an oriented trimesh with outward winding', async () => {
    const world = await makeWorld();
    const vertices = new Float32Array([
      -10, 0, -10,
      10, 0, -10,
      10, 0, 10,
      -10, 0, 10,
    ]);
    // Reversed winding, so the face normals point up (+Y).
    const indices = new Uint32Array([0, 2, 1, 0, 3, 2]);
    world.addStaticTrimesh(vertices, indices, {
      membership: CollisionLayer.World,
      orientedMesh: true,
    });

    const radius = 0.4;
    const ball = world.addDynamicBall(radius, {
      position: { x: 0, y: 4, z: 0 },
      membership: CollisionLayer.Debris,
    });

    stepN(world, 240);
    expect(yOf(world, ball)).toBeCloseTo(radius, 1);
  });

  it('is raycastable as level geometry', async () => {
    const world = await makeWorld();
    const vertices = new Float32Array([
      -10, 0, -10,
      10, 0, -10,
      10, 0, 10,
      -10, 0, 10,
    ]);
    const mesh = world.addStaticTrimesh(vertices, new Uint32Array([0, 1, 2, 0, 2, 3]), {
      membership: CollisionLayer.World,
    });
    world.step();

    const hit = world.raycast({ x: 1, y: 6, z: -2 }, { x: 0, y: -1, z: 0 }, 20);
    expect(hit).not.toBeNull();
    expect(hit!.handle).toBe(mesh);
    expect(hit!.distance).toBeCloseTo(6, 4);
  });

  it('rejects a trimesh index buffer that is not triangles', async () => {
    const world = await makeWorld();
    expect(() =>
      world.addStaticTrimesh(
        new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
        new Uint32Array([0, 1]),
        { membership: CollisionLayer.World },
      ),
    ).toThrow(/multiple of 3/);
  });
});

// ---------------------------------------------------------------------------
// Determinism — the property the fixed timestep exists to guarantee
// ---------------------------------------------------------------------------

describe('PhysicsWorld determinism', () => {
  /** Identical scene construction, so two worlds must evolve identically. */
  function buildScene(world: PhysicsWorld): BodyHandle[] {
    addFloor(world);
    return [
      world.addDynamicBall(0.4, {
        position: { x: 0.13, y: 5, z: -0.07 },
        membership: CollisionLayer.Debris,
        friction: 0.7,
      }),
      world.addDynamicCuboid(
        { x: 0.3, y: 0.3, z: 0.3 },
        {
          position: { x: 0.2, y: 7.25, z: 0.11 },
          rotation: { x: 0.2, y: 0.1, z: 0.05, w: 0.9721 },
          membership: CollisionLayer.Debris,
          friction: 0.4,
        },
      ),
      world.addDynamicCuboid(
        { x: 0.25, y: 0.5, z: 0.25 },
        {
          position: { x: -0.4, y: 9.5, z: 0.3 },
          membership: CollisionLayer.Debris,
        },
      ),
    ];
  }

  it('produces bit-identical state in two separate worlds', async () => {
    const a = await makeWorld();
    const b = await makeWorld();

    const handlesA = buildScene(a);
    const handlesB = buildScene(b);

    // Handles are minted by us, so they must match too.
    expect(handlesA).toEqual(handlesB);

    stepN(a, 300);
    stepN(b, 300);

    for (let i = 0; i < handlesA.length; i += 1) {
      const ta = a.getBodyTransform(handlesA[i]!);
      const tb = b.getBodyTransform(handlesB[i]!);
      expect(ta).not.toBeNull();
      expect(tb).not.toBeNull();

      // Exact equality, not toBeCloseTo. Any drift here means the simulation
      // is not reproducible and replays/regression baselines are worthless.
      expect(tb!.position.x).toBe(ta!.position.x);
      expect(tb!.position.y).toBe(ta!.position.y);
      expect(tb!.position.z).toBe(ta!.position.z);
      expect(tb!.rotation.x).toBe(ta!.rotation.x);
      expect(tb!.rotation.y).toBe(ta!.rotation.y);
      expect(tb!.rotation.z).toBe(ta!.rotation.z);
      expect(tb!.rotation.w).toBe(ta!.rotation.w);
    }

    // The bodies actually moved and interacted, so the equality above is not
    // vacuously comparing untouched initial positions.
    expect(a.getBodyPosition(handlesA[0]!)!.y).toBeLessThan(5);
  });

  it('stays identical when the two worlds are stepped interleaved', async () => {
    const a = await makeWorld();
    const b = await makeWorld();
    const [ballA] = buildScene(a);
    const [ballB] = buildScene(b);

    for (let i = 0; i < 200; i += 1) {
      a.step();
      b.step();
    }

    expect(b.getBodyPosition(ballB!)).toEqual(a.getBodyPosition(ballA!));
  });

  it('diverges when the step count differs, proving the check has teeth', async () => {
    const a = await makeWorld();
    const b = await makeWorld();
    const [ballA] = buildScene(a);
    const [ballB] = buildScene(b);

    stepN(a, 40);
    stepN(b, 41);

    expect(b.getBodyPosition(ballB!)!.y).not.toBe(a.getBodyPosition(ballA!)!.y);
  });
});

// ---------------------------------------------------------------------------
// Collision groups
// ---------------------------------------------------------------------------

describe('interactionGroups packing', () => {
  it('puts membership in the high 16 bits and the filter in the low 16', () => {
    const groups = interactionGroups(CollisionLayer.Player, CollisionLayer.World);
    expect(groupMembership(groups)).toBe(CollisionLayer.Player);
    expect(groupFilter(groups)).toBe(CollisionLayer.World);
    expect(groups).toBe((CollisionLayer.Player << 16) | CollisionLayer.World);
  });

  it('stays an unsigned 32-bit value when bit 15 of membership is set', () => {
    const groups = interactionGroups(0x8000, 0x0001);
    expect(groups).toBeGreaterThan(0);
    expect(groups).toBe(0x80000001);
    expect(groupMembership(groups)).toBe(0x8000);
    expect(groupFilter(groups)).toBe(0x0001);
  });

  it('truncates anything above 16 bits rather than corrupting the other half', () => {
    const groups = interactionGroups(0x1_0001, 0x1_0002);
    expect(groupMembership(groups)).toBe(0x0001);
    expect(groupFilter(groups)).toBe(0x0002);
  });

  it('covers every declared layer in ALL_LAYERS', () => {
    for (const bit of Object.values(CollisionLayer)) {
      expect(ALL_LAYERS & bit).toBe(bit);
    }
  });

  it('requires agreement in both directions', () => {
    const world = interactionGroups(CollisionLayer.World, ALL_LAYERS);
    const mutual = interactionGroups(CollisionLayer.Debris, CollisionLayer.World);
    const oneWay = interactionGroups(CollisionLayer.Debris, CollisionLayer.Debris);

    expect(groupsInteract(mutual, world)).toBe(true);
    // Debris accepts only Debris, so World's membership is rejected even
    // though World's filter accepts Debris.
    expect(groupsInteract(oneWay, world)).toBe(false);
  });
});

describe('PhysicsWorld collision filtering', () => {
  it('collides bodies on interacting layers and passes through others', async () => {
    const world = await makeWorld();
    addFloor(world, CollisionLayer.World);

    // Filters World, so it stops on the slab.
    const blocked = world.addDynamicBall(0.4, {
      position: { x: -3, y: 5, z: 0 },
      membership: CollisionLayer.Debris,
      filter: CollisionLayer.World,
      debugName: 'blocked',
    });

    // Filters only Debris, so the floor's World membership is rejected.
    const passing = world.addDynamicBall(0.4, {
      position: { x: 3, y: 5, z: 0 },
      membership: CollisionLayer.Debris,
      filter: CollisionLayer.Debris,
      debugName: 'passing',
    });

    expect(world.getBodyGroups(blocked)).toBe(
      interactionGroups(CollisionLayer.Debris, CollisionLayer.World),
    );
    expect(world.getBodyGroups(passing)).toBe(
      interactionGroups(CollisionLayer.Debris, CollisionLayer.Debris),
    );

    stepN(world, 180);

    expect(yOf(world, blocked)).toBeGreaterThan(FLOOR_TOP);
    // The non-interacting body fell straight past the slab.
    expect(yOf(world, passing)).toBeLessThan(-2);
  });

  it('collides two dynamic bodies that share a layer', async () => {
    const world = await makeWorld();
    addFloor(world);

    const lower = world.addDynamicBall(0.5, {
      position: { x: 0, y: 1.0, z: 0 },
      membership: CollisionLayer.Debris,
      filter: CollisionLayer.World | CollisionLayer.Debris,
    });
    const upper = world.addDynamicBall(0.5, {
      position: { x: 0, y: 3.0, z: 0 },
      membership: CollisionLayer.Debris,
      filter: CollisionLayer.World | CollisionLayer.Debris,
    });

    stepN(world, 300);

    // Stacked, so the upper ball rests roughly a diameter above the lower one
    // instead of settling at the same height.
    const gap = yOf(world, upper) - yOf(world, lower);
    expect(gap).toBeGreaterThan(0.8);
    expect(yOf(world, lower)).toBeGreaterThan(FLOOR_TOP);
  });

  it('lets two bodies on mutually exclusive layers overlap', async () => {
    const world = await makeWorld({ gravityY: 0 });

    // Machine only collides with World; Debris only collides with World.
    // Neither accepts the other, so they can occupy the same space.
    const machine = world.addDynamicBall(0.5, {
      position: { x: 0, y: 5, z: 0 },
      membership: CollisionLayer.Machine,
      filter: CollisionLayer.World,
    });
    const debris = world.addDynamicBall(0.5, {
      position: { x: 0, y: 5, z: 0 },
      membership: CollisionLayer.Debris,
      filter: CollisionLayer.World,
    });

    stepN(world, 60);

    // With no gravity and no accepted contact, neither body is pushed away.
    expect(yOf(world, machine)).toBe(5);
    expect(yOf(world, debris)).toBe(5);
    expect(world.getBodyPosition(machine)!.x).toBe(0);
    expect(world.getBodyPosition(debris)!.x).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sensors
// ---------------------------------------------------------------------------

describe('PhysicsWorld sensors', () => {
  it('reports intersections without blocking movement', async () => {
    const world = await makeWorld();
    const sensor = world.addSensorCuboid(
      { x: 1, y: 1, z: 1 },
      {
        position: { x: 0, y: 5, z: 0 },
        membership: CollisionLayer.Trigger,
        debugName: 'gate-trigger',
      },
    );
    expect(world.isSensor(sensor)).toBe(true);

    const ball = world.addDynamicBall(0.2, {
      position: { x: 0, y: 9, z: 0 },
      membership: CollisionLayer.Debris,
    });
    expect(world.isSensor(ball)).toBe(false);

    world.step();
    expect(world.intersectingBodies(sensor)).toEqual([]);

    // Fall until the ball is inside the 4..6 band.
    let sawIntersection = false;
    let minY = Infinity;
    for (let i = 0; i < 300; i += 1) {
      world.step();
      const y = yOf(world, ball);
      minY = Math.min(minY, y);
      const inside = world.intersectingBodies(sensor);
      if (y < 5.5 && y > 4.5) {
        // Inside the volume: the sensor must see it.
        if (inside.includes(ball)) sawIntersection = true;
      }
    }

    expect(sawIntersection).toBe(true);
    // Not blocked: it carried on well below the sensor's lower face at y = 4.
    expect(minY).toBeLessThan(0);
    expect(world.intersectingBodies(sensor)).toEqual([]);
  });

  it('returns an empty list for a stale handle', async () => {
    const world = await makeWorld();
    const sensor = world.addSensorCuboid(
      { x: 1, y: 1, z: 1 },
      { position: { x: 0, y: 0, z: 0 }, membership: CollisionLayer.Trigger },
    );
    world.removeBody(sensor);
    expect(world.intersectingBodies(sensor)).toEqual([]);
    expect(world.isSensor(sensor)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Kinematic bodies
// ---------------------------------------------------------------------------

describe('PhysicsWorld kinematic bodies', () => {
  it('moves a kinematic capsule to its authored target and ignores gravity', async () => {
    const world = await makeWorld();
    addFloor(world);
    const player = world.addKinematicCapsule(0.8, 0.35, {
      position: { x: 0, y: 2, z: 0 },
      membership: CollisionLayer.Player,
      debugName: 'mara',
    });

    expect(world.getBodyKind(player)).toBe('kinematic');

    // Gravity does not apply to kinematic bodies.
    stepN(world, 60);
    expect(yOf(world, player)).toBe(2);

    world.setNextKinematicPosition(player, { x: 1.5, y: 2, z: -0.5 });
    world.step();

    const position = world.getBodyPosition(player)!;
    expect(position.x).toBeCloseTo(1.5, 5);
    expect(position.z).toBeCloseTo(-0.5, 5);
  });

  it('refuses a kinematic target on a non-kinematic body', async () => {
    const world = await makeWorld();
    const ball = world.addDynamicBall(0.5, {
      position: { x: 0, y: 5, z: 0 },
      membership: CollisionLayer.Debris,
    });
    expect(world.setNextKinematicPosition(ball, { x: 9, y: 9, z: 9 })).toBe(false);
    expect(world.setNextKinematicPosition(9999, { x: 0, y: 0, z: 0 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Raycasts
// ---------------------------------------------------------------------------

describe('PhysicsWorld raycast', () => {
  it('hits the floor at the expected distance with the correct normal', async () => {
    const world = await makeWorld();
    const floor = addFloor(world);
    world.step();

    const hit = world.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 50);
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeCloseTo(4.5, 5);
    expect(hit!.handle).toBe(floor);
    expect(hit!.point.y).toBeCloseTo(FLOOR_TOP, 5);
    expect(hit!.point.x).toBeCloseTo(0, 6);
    expect(hit!.normal.y).toBeCloseTo(1, 3);
  });

  it('normalises the direction so distance is in metres', async () => {
    const world = await makeWorld();
    addFloor(world);
    world.step();

    const unit = world.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 50);
    const scaled = world.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: -7.3, z: 0 }, 50);

    expect(unit).not.toBeNull();
    expect(scaled).not.toBeNull();
    expect(scaled!.distance).toBeCloseTo(unit!.distance, 5);
    expect(scaled!.distance).toBeCloseTo(4.5, 5);
  });

  it('misses when aimed away', async () => {
    const world = await makeWorld();
    addFloor(world);
    world.step();
    expect(world.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: 1, z: 0 }, 50)).toBeNull();
  });

  it('misses when the floor is beyond maxDistance', async () => {
    const world = await makeWorld();
    addFloor(world);
    world.step();
    expect(world.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 4)).toBeNull();
    expect(world.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 4.6)).not.toBeNull();
  });

  it('filters by collision layer', async () => {
    const world = await makeWorld();
    addFloor(world, CollisionLayer.World);
    world.step();
    const origin = { x: 0, y: 5, z: 0 };
    const down = { x: 0, y: -1, z: 0 };

    expect(world.raycast(origin, down, 50, { layers: CollisionLayer.World })).not.toBeNull();
    // The slab is not on the Machine layer, so a Machine-only cast misses it.
    expect(world.raycast(origin, down, 50, { layers: CollisionLayer.Machine })).toBeNull();
    // A mask covering both still hits.
    expect(
      world.raycast(origin, down, 50, {
        layers: CollisionLayer.Machine | CollisionLayer.World,
      }),
    ).not.toBeNull();
  });

  it('excludes a nominated body', async () => {
    const world = await makeWorld();
    const lower = addFloor(world);
    const upper = world.addStaticCuboid(
      { x: 10, y: 0.5, z: 10 },
      { position: { x: 0, y: 3, z: 0 }, membership: CollisionLayer.World },
    );
    world.step();

    const nearest = world.raycast({ x: 0, y: 8, z: 0 }, { x: 0, y: -1, z: 0 }, 50);
    expect(nearest!.handle).toBe(upper);

    const behind = world.raycast({ x: 0, y: 8, z: 0 }, { x: 0, y: -1, z: 0 }, 50, {
      excludeBody: upper,
    });
    expect(behind!.handle).toBe(lower);
  });

  it('returns null for a degenerate ray', async () => {
    const world = await makeWorld();
    addFloor(world);
    world.step();
    expect(world.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: 0, z: 0 }, 50)).toBeNull();
    expect(world.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 0)).toBeNull();
    expect(world.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: Number.NaN, z: 0 }, 50)).toBeNull();
  });

  it('reports the moving body it hits', async () => {
    const world = await makeWorld();
    addFloor(world);
    const ball = world.addDynamicBall(0.5, {
      position: { x: 0, y: 4, z: 0 },
      membership: CollisionLayer.Debris,
    });
    world.step();

    const hit = world.raycast({ x: 0, y: 8, z: 0 }, { x: 0, y: -1, z: 0 }, 20);
    expect(hit!.handle).toBe(ball);
  });
});

// ---------------------------------------------------------------------------
// Scene-query freshness contract
// ---------------------------------------------------------------------------

describe('PhysicsWorld query freshness', () => {
  /**
   * Rapier rebuilds its broad-phase BVH inside `step()`, so a body added since
   * the last step is not yet raycastable. This is asserted rather than merely
   * commented, because the tempting workaround — a zero-length step to refresh
   * the structures — was measured to perturb velocities and make two otherwise
   * identical worlds diverge, silently costing determinism.
   */
  it('makes a newly added body raycastable only after the next step', async () => {
    const world = await makeWorld();
    const floor = addFloor(world);

    expect(world.queriesStale).toBe(true);
    expect(world.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 50)).toBeNull();

    world.step();

    expect(world.queriesStale).toBe(false);
    expect(world.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 50)!.handle).toBe(floor);
  });

  it('applies removals to queries immediately, without a step', async () => {
    const world = await makeWorld();
    const lower = addFloor(world);
    const upper = world.addStaticCuboid(
      { x: 10, y: 0.5, z: 10 },
      { position: { x: 0, y: 3, z: 0 }, membership: CollisionLayer.World },
    );
    world.step();

    expect(world.raycast({ x: 0, y: 8, z: 0 }, { x: 0, y: -1, z: 0 }, 50)!.handle).toBe(upper);

    world.removeBody(upper);

    // No step in between: the removed slab is already gone from the query.
    const hit = world.raycast({ x: 0, y: 8, z: 0 }, { x: 0, y: -1, z: 0 }, 50);
    expect(hit!.handle).toBe(lower);
    expect(hit!.distance).toBeCloseTo(7.5, 5);
  });
});

// ---------------------------------------------------------------------------
// Sleep management
// ---------------------------------------------------------------------------

describe('PhysicsWorld far-distance sleep', () => {
  it('sleeps distant dynamic bodies and wakes them on approach', async () => {
    const world = await makeWorld({ farSleepDistance: 20 });
    expect(world.getFarSleepDistance()).toBe(20);

    const near = world.addDynamicBall(0.5, {
      position: { x: 0, y: 5, z: 0 },
      membership: CollisionLayer.Debris,
    });
    const far = world.addDynamicBall(0.5, {
      position: { x: 100, y: 5, z: 0 },
      membership: CollisionLayer.Debris,
    });

    const focusNear = { x: 0, y: 0, z: 0 };
    const first = world.updateSleepStates(focusNear);
    expect(first.slept).toBe(1);
    expect(first.woken).toBe(0);

    expect(world.isFarAsleep(far)).toBe(true);
    expect(world.isSleeping(far)).toBe(true);
    expect(world.isFarAsleep(near)).toBe(false);

    const farYBefore = yOf(world, far);
    stepN(world, 60);

    // A slept body is skipped by the solver, so it has not fallen at all.
    expect(yOf(world, far)).toBe(farYBefore);
    // The near body simulated normally.
    expect(yOf(world, near)).toBeLessThan(5);

    // Re-running with the same focus is idempotent.
    const repeat = world.updateSleepStates(focusNear);
    expect(repeat).toEqual({ slept: 0, woken: 0 });

    // Player walks over to it.
    const wake = world.updateSleepStates({ x: 100, y: 5, z: 0 });
    expect(wake.woken).toBe(1);
    expect(world.isFarAsleep(far)).toBe(false);
    expect(world.isSleeping(far)).toBe(false);

    stepN(world, 60);
    expect(yOf(world, far)).toBeLessThan(farYBefore);
  });

  it('applies hysteresis so a body on the boundary does not thrash', async () => {
    const world = await makeWorld({ farSleepDistance: 20, gravityY: 0 });
    const body = world.addDynamicBall(0.5, {
      position: { x: 21, y: 0, z: 0 },
      membership: CollisionLayer.Debris,
    });

    expect(world.updateSleepStates({ x: 0, y: 0, z: 0 }).slept).toBe(1);

    // Just inside the sleep radius but still within the hysteresis band
    // (wake happens only inside 20 - 4 = 16 m): stays asleep.
    expect(world.updateSleepStates({ x: 3, y: 0, z: 0 })).toEqual({ slept: 0, woken: 0 });
    expect(world.isFarAsleep(body)).toBe(true);

    // Past the inner threshold: wakes.
    expect(world.updateSleepStates({ x: 10, y: 0, z: 0 }).woken).toBe(1);
    expect(world.isFarAsleep(body)).toBe(false);
  });

  it('leaves bodies Rapier slept for resting alone', async () => {
    const world = await makeWorld({ farSleepDistance: 100 });
    addFloor(world);
    const ball = world.addDynamicBall(0.5, {
      position: { x: 0, y: 2, z: 0 },
      membership: CollisionLayer.Debris,
    });

    stepN(world, 240);
    expect(world.isSleeping(ball)).toBe(true);
    expect(world.isFarAsleep(ball)).toBe(false);

    // The focus is right on top of it, yet we must not wake a resting body.
    const result = world.updateSleepStates({ x: 0, y: 1, z: 0 });
    expect(result).toEqual({ slept: 0, woken: 0 });
    expect(world.isSleeping(ball)).toBe(true);
  });

  it('reacts to a lowered far distance from the quality system', async () => {
    const world = await makeWorld({ farSleepDistance: 100 });
    const body = world.addDynamicBall(0.5, {
      position: { x: 50, y: 5, z: 0 },
      membership: CollisionLayer.Debris,
    });

    expect(world.updateSleepStates({ x: 0, y: 0, z: 0 }).slept).toBe(0);

    // Dropping to the potato preset's physicsFarDistance.
    world.setFarSleepDistance(22);
    expect(world.getFarSleepDistance()).toBe(22);
    expect(world.updateSleepStates({ x: 0, y: 0, z: 0 }).slept).toBe(1);
    expect(world.isFarAsleep(body)).toBe(true);
  });

  it('rejects a nonsensical far distance instead of silently disabling sleep', async () => {
    const world = await makeWorld();
    expect(() => world.setFarSleepDistance(0)).toThrow(/must be > 0/);
    expect(() => world.setFarSleepDistance(-5)).toThrow(/must be > 0/);
    expect(() => world.setFarSleepDistance(Number.NaN)).toThrow(/must be > 0/);
  });

  it('only considers dynamic bodies', async () => {
    const world = await makeWorld({ farSleepDistance: 10 });
    world.addStaticCuboid(
      { x: 1, y: 1, z: 1 },
      { position: { x: 500, y: 0, z: 0 }, membership: CollisionLayer.World },
    );
    world.addKinematicCapsule(0.8, 0.35, {
      position: { x: 500, y: 0, z: 0 },
      membership: CollisionLayer.Player,
    });

    expect(world.dynamicBodyCount).toBe(0);
    expect(world.updateSleepStates({ x: 0, y: 0, z: 0 })).toEqual({ slept: 0, woken: 0 });
  });
});

// ---------------------------------------------------------------------------
// Counters and removal
// ---------------------------------------------------------------------------

describe('PhysicsWorld counters and removal', () => {
  it('counts bodies, colliders and awake/sleeping split', async () => {
    const world = await makeWorld();
    addFloor(world);
    world.addDynamicBall(0.5, {
      position: { x: 0, y: 8, z: 0 },
      membership: CollisionLayer.Debris,
    });
    world.addDynamicBall(0.5, {
      position: { x: 2, y: 8, z: 0 },
      membership: CollisionLayer.Debris,
    });

    world.step();
    const counters = world.getCounters();
    expect(counters.bodies).toBe(3);
    expect(counters.colliders).toBe(3);
    // Both falling balls are active; the static slab never is.
    expect(counters.awake).toBe(2);
    expect(counters.sleeping).toBe(1);
    expect(counters.farAsleep).toBe(0);
    expect(world.bodyCount).toBe(3);
    expect(world.dynamicBodyCount).toBe(2);
  });

  it('drops the count when a body is removed', async () => {
    const world = await makeWorld();
    addFloor(world);
    const ball = world.addDynamicBall(0.5, {
      position: { x: 0, y: 8, z: 0 },
      membership: CollisionLayer.Debris,
    });

    expect(world.getCounters().bodies).toBe(2);
    expect(world.has(ball)).toBe(true);

    expect(world.removeBody(ball)).toBe(true);

    expect(world.has(ball)).toBe(false);
    expect(world.bodyCount).toBe(1);
    expect(world.dynamicBodyCount).toBe(0);
    const after = world.getCounters();
    expect(after.bodies).toBe(1);
    expect(after.colliders).toBe(1);

    // Reads on a stale handle report absence rather than garbage.
    expect(world.getBodyTransform(ball)).toBeNull();
    expect(world.getBodyPosition(ball)).toBeNull();
    expect(world.getBodyKind(ball)).toBeUndefined();
    expect(world.isSleeping(ball)).toBeUndefined();

    // Removing twice is a no-op, not a crash or a double free.
    expect(world.removeBody(ball)).toBe(false);
    expect(world.removeBody(123456)).toBe(false);

    // The world still simulates after the removal.
    stepN(world, 30);
    expect(world.stepCount).toBe(30);
  });

  it('never reuses a handle', async () => {
    const world = await makeWorld();
    const first = world.addDynamicBall(0.5, {
      position: { x: 0, y: 1, z: 0 },
      membership: CollisionLayer.Debris,
    });
    world.removeBody(first);
    const second = world.addDynamicBall(0.5, {
      position: { x: 0, y: 1, z: 0 },
      membership: CollisionLayer.Debris,
    });

    expect(second).not.toBe(first);
    expect(world.has(first)).toBe(false);
    expect(world.has(second)).toBe(true);
  });

  it('tracks far-asleep bodies in the counters', async () => {
    const world = await makeWorld({ farSleepDistance: 10 });
    world.addDynamicBall(0.5, {
      position: { x: 100, y: 5, z: 0 },
      membership: CollisionLayer.Debris,
    });
    world.updateSleepStates({ x: 0, y: 0, z: 0 });
    expect(world.getCounters().farAsleep).toBe(1);
  });

  it('reads back a transform into a caller-owned target', async () => {
    const world = await makeWorld();
    const ball = world.addDynamicBall(0.5, {
      position: { x: 1, y: 2, z: 3 },
      membership: CollisionLayer.Debris,
    });

    const target = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    };
    const result = world.getBodyTransform(ball, target);

    expect(result).toBe(target);
    expect(target.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(target.rotation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });

  it('teleports a body for checkpoint restore', async () => {
    const world = await makeWorld();
    const ball = world.addDynamicBall(0.5, {
      position: { x: 0, y: 5, z: 0 },
      membership: CollisionLayer.Debris,
    });

    expect(world.setBodyPosition(ball, { x: -4, y: 12, z: 7 })).toBe(true);
    expect(world.getBodyPosition(ball)).toEqual({ x: -4, y: 12, z: 7 });
    expect(world.setBodyPosition(4242, { x: 0, y: 0, z: 0 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

describe('PhysicsWorld dispose', () => {
  it('frees the world without throwing and is idempotent', async () => {
    const world = await makeWorld();
    addFloor(world);
    world.addDynamicBall(0.5, {
      position: { x: 0, y: 5, z: 0 },
      membership: CollisionLayer.Debris,
    });
    stepN(world, 30);

    expect(() => world.dispose()).not.toThrow();
    expect(world.isDisposed).toBe(true);
    expect(() => world.dispose()).not.toThrow();

    expect(world.getCounters()).toEqual({
      bodies: 0,
      awake: 0,
      sleeping: 0,
      colliders: 0,
      farAsleep: 0,
    });
  });

  it('throws on use after dispose rather than reading freed memory', async () => {
    const world = await makeWorld();
    world.dispose();

    expect(() => world.step()).toThrow(/after dispose/);
    expect(() => world.updateSleepStates({ x: 0, y: 0, z: 0 })).toThrow(/after dispose/);
    expect(() => world.raycast({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }, 1))
      .toThrow(/after dispose/);
    expect(() =>
      world.addDynamicBall(1, { position: { x: 0, y: 0, z: 0 }, membership: CollisionLayer.Debris }),
    ).toThrow(/after dispose/);
    expect(() => world.takeSnapshot()).toThrow(/after dispose/);
  });

  it('leaves other worlds untouched when one is disposed', async () => {
    const a = await makeWorld();
    const b = await makeWorld();

    addFloor(b);
    const ball = b.addDynamicBall(0.5, {
      position: { x: 0, y: 5, z: 0 },
      membership: CollisionLayer.Debris,
    });

    a.dispose();

    stepN(b, 120);
    expect(b.isDisposed).toBe(false);
    expect(yOf(b, ball)).toBeGreaterThan(FLOOR_TOP);
  });
});
