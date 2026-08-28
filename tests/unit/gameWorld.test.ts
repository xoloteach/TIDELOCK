/**
 * ECS world and system scheduler tests.
 *
 * Two things here are load-bearing for the whole game and are therefore
 * tested rather than assumed: systems must run in the order they were
 * registered (input before movement before physics before render sync), and a
 * single throwing system must not stop the loop. A frozen frame is a crash the
 * player cannot recover from, so the isolation behaviour gets its own tests
 * for both phases.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Object3D } from 'three';
import { GameWorld, type System } from '../../src/engine/ecs/GameWorld';
import {
  createTransform,
  distance,
  distanceSquared,
  planarDistanceSquared,
  vec3,
  type AudioEmitter,
  type Entity,
  type Interactable,
  type MachineAi,
  type NavAgent,
  type NpcBehaviour,
  type Perception,
  type Renderable,
} from '../../src/engine/ecs/components';

const DT = 1 / 60;

// ---------------------------------------------------------------------------
// Component fixtures
// ---------------------------------------------------------------------------

/**
 * The scheduler never dereferences the scene node, so a marker object is
 * enough. Instantiating a real Object3D would drag the renderer into a unit
 * test without adding coverage.
 */
function fakeRenderable(): Renderable {
  return {
    object: { name: 'stub' } as unknown as Object3D,
    visible: true,
    cullDistance: 0,
    static: false,
  };
}

function fakeMachineAi(): MachineAi {
  return {
    kind: 'inspection-unit',
    state: 'patrol',
    stateTime: 0,
    awareness: 0,
    lastKnownPlayerPosition: null,
    patrolRoute: [],
    patrolIndex: 0,
    perceptionCooldown: 0,
  };
}

function fakePerception(): Perception {
  return {
    visionHalfAngle: 0.6,
    visionRange: 18,
    proximityRange: 3,
    hearingRange: 12,
    timeToDetect: 1.5,
    eyeOffset: vec3(0, 1.4, 0),
  };
}

function fakeNpc(characterId: string): NpcBehaviour {
  return {
    characterId,
    state: 'idle',
    stateTime: 0,
    homePosition: vec3(),
    lookTarget: null,
    activityTag: 'idle',
  };
}

function fakeNavAgent(): NavAgent {
  return {
    destination: null,
    path: [],
    pathIndex: 0,
    speed: 1.4,
    radius: 0.35,
    repathCooldown: 0,
    arrived: true,
  };
}

function fakeInteractable(label: string): Interactable {
  return {
    verb: 'use',
    label,
    range: 2,
    holdDuration: 0,
    enabled: true,
    event: 'test:interacted',
    promptOffset: vec3(0, 1, 0),
    repeatable: false,
  };
}

function fakeAudioEmitter(): AudioEmitter {
  return {
    clipId: 'pump-hum',
    bus: 'ambience',
    loop: true,
    volume: 0.5,
    maxDistance: 20,
    refDistance: 2,
    playing: false,
    priority: 1,
  };
}

// ---------------------------------------------------------------------------
// System fixtures
// ---------------------------------------------------------------------------

/** A system that appends `name:phase` to a shared log for every callback. */
function loggingSystem(name: string, log: string[]): System {
  return {
    name,
    init: () => {
      log.push(`${name}:init`);
    },
    fixedUpdate: () => {
      log.push(`${name}:fixed`);
    },
    render: () => {
      log.push(`${name}:render`);
    },
    dispose: () => {
      log.push(`${name}:dispose`);
    },
  };
}

/**
 * Consumes real wall time. The scheduler measures with `performance.now()`,
 * so a system has to actually spend time for a non-zero timing to mean
 * anything — a trivial system can legitimately measure 0 ms.
 */
function spin(ms: number): void {
  const start = performance.now();
  while (performance.now() - start < ms) {
    /* busy wait */
  }
}

// ---------------------------------------------------------------------------

describe('GameWorld entities', () => {
  it('spawn returns the entity and increases the count', () => {
    const world = new GameWorld();
    expect(world.entityCount).toBe(0);

    const entity = world.spawn({ debugName: 'valve-4b', transform: createTransform() });

    // miniplex adds the same object rather than a copy, so callers can keep
    // the reference they passed in.
    expect(world.entityCount).toBe(1);
    expect(entity.debugName).toBe('valve-4b');
  });

  it('despawn decreases the count', () => {
    const world = new GameWorld();
    const a = world.spawn({ debugName: 'a' });
    world.spawn({ debugName: 'b' });

    world.despawn(a);

    expect(world.entityCount).toBe(1);
  });

  it('despawning an entity twice is harmless', () => {
    const world = new GameWorld();
    const a = world.spawn({ debugName: 'a' });

    world.despawn(a);
    world.despawn(a);

    expect(world.entityCount).toBe(0);
  });

  describe('standing queries', () => {
    it('matches an entity that has every queried component', () => {
      const world = new GameWorld();
      const drawn = world.spawn({
        transform: createTransform(vec3(1, 0, 2)),
        renderable: fakeRenderable(),
      });

      expect(world.renderables.entities).toContain(drawn);
    });

    it('excludes an entity missing one of the queried components', () => {
      const world = new GameWorld();
      const invisible = world.spawn({ transform: createTransform() });

      expect(world.renderables.entities).not.toContain(invisible);
      expect(world.renderables.entities).toHaveLength(0);
    });

    it('picks up an entity when a component is added later', () => {
      const world = new GameWorld();
      const entity = world.spawn({ transform: createTransform() });
      expect(world.renderables.entities).toHaveLength(0);

      world.ecs.addComponent(entity, 'renderable', fakeRenderable());

      // The query index has to be rebuilt on component add, otherwise a mesh
      // attached after spawn would never be synced to its transform.
      expect(world.renderables.entities).toEqual([entity]);
    });

    it('drops an entity when a queried component is removed', () => {
      const world = new GameWorld();
      const entity = world.spawn({
        transform: createTransform(),
        renderable: fakeRenderable(),
      });
      expect(world.renderables.entities).toEqual([entity]);

      world.ecs.removeComponent(entity, 'renderable');

      expect(world.renderables.entities).toHaveLength(0);
      // The entity itself survives; only the query membership changed.
      expect(world.entityCount).toBe(1);
    });

    it('keeps unrelated queries independent', () => {
      const world = new GameWorld();
      const mover = world.spawn({
        transform: createTransform(),
        velocity: { linear: vec3(0, 0, 1), angular: 0 },
      });
      const agent = world.spawn({ transform: createTransform(), navAgent: fakeNavAgent() });

      expect(world.moving.entities).toEqual([mover]);
      expect(world.navAgents.entities).toEqual([agent]);
    });
  });

  describe('player', () => {
    it('returns the entity tagged isPlayer', () => {
      const world = new GameWorld();
      world.spawn({ transform: createTransform(), debugName: 'crate' });
      const mara = world.spawn({ isPlayer: true, transform: createTransform(vec3(0, 0, 4)) });

      expect(world.player).toBe(mara);
    });

    it('returns undefined when no player exists', () => {
      const world = new GameWorld();
      world.spawn({ transform: createTransform() });

      expect(world.player).toBeUndefined();
    });

    it('goes back to undefined after the player is despawned', () => {
      const world = new GameWorld();
      const mara = world.spawn({ isPlayer: true, transform: createTransform() });
      expect(world.player).toBe(mara);

      world.despawn(mara);

      // A query rather than a cached reference, so respawn/transition cannot
      // leave a dangling player.
      expect(world.player).toBeUndefined();
    });
  });
});

describe('GameWorld systems', () => {
  it('registers a system and calls init exactly once', () => {
    const world = new GameWorld();
    const init = vi.fn();
    world.addSystem({ name: 'input', init });

    expect(init).toHaveBeenCalledTimes(1);
    expect(world.getSystem('input')).toBeDefined();
    expect(world.systemNames).toEqual(['input']);
  });

  it('does not call init again on later updates', () => {
    const world = new GameWorld();
    const init = vi.fn();
    world.addSystem({ name: 'input', init, fixedUpdate: () => {} });

    world.fixedUpdate(DT);
    world.fixedUpdate(DT);

    expect(init).toHaveBeenCalledTimes(1);
  });

  it('throws on a duplicate system name', () => {
    const world = new GameWorld();
    world.addSystem({ name: 'movement' });

    // A silently ignored duplicate would double-step whichever system won.
    expect(() => world.addSystem({ name: 'movement' })).toThrow(/already registered/);
    expect(world.systemNames).toEqual(['movement']);
  });

  it('returns undefined for an unregistered system name', () => {
    const world = new GameWorld();
    expect(world.getSystem('physics')).toBeUndefined();
  });

  it('runs fixedUpdate in registration order', () => {
    const world = new GameWorld();
    const log: string[] = [];
    // Declared order is the contract: input reads intent, movement integrates
    // it, physics resolves, render sync copies the result out.
    for (const name of ['input', 'movement', 'physics', 'renderSync']) {
      world.addSystem({
        name,
        fixedUpdate: () => {
          log.push(name);
        },
      });
    }

    world.fixedUpdate(DT);

    expect(log).toEqual(['input', 'movement', 'physics', 'renderSync']);
  });

  it('preserves that order across repeated steps', () => {
    const world = new GameWorld();
    const log: string[] = [];
    world.addSystem({
      name: 'a',
      fixedUpdate: () => {
        log.push('a');
      },
    });
    world.addSystem({
      name: 'b',
      fixedUpdate: () => {
        log.push('b');
      },
    });

    world.fixedUpdate(DT);
    world.fixedUpdate(DT);

    expect(log).toEqual(['a', 'b', 'a', 'b']);
  });

  it('runs render in registration order', () => {
    const world = new GameWorld();
    const log: string[] = [];
    world.addSystem({
      name: 'camera',
      render: () => {
        log.push('camera');
      },
    });
    world.addSystem({
      name: 'animation',
      render: () => {
        log.push('animation');
      },
    });

    world.render(0.5, DT);

    expect(log).toEqual(['camera', 'animation']);
  });

  it('passes the fixed dt through unchanged', () => {
    const world = new GameWorld();
    const fixedUpdate = vi.fn();
    world.addSystem({ name: 'physics', fixedUpdate });

    world.fixedUpdate(DT);

    expect(fixedUpdate).toHaveBeenCalledWith(DT);
  });

  it('passes interpolation alpha and frame delta to render', () => {
    const world = new GameWorld();
    const render = vi.fn();
    world.addSystem({ name: 'interpolation', render });

    world.render(0.25, 0.016);

    expect(render).toHaveBeenCalledWith(0.25, 0.016);
  });

  it('calls only fixedUpdate during a simulation step', () => {
    const world = new GameWorld();
    const log: string[] = [];
    world.addSystem(loggingSystem('sim', log));

    world.fixedUpdate(DT);

    expect(log).toEqual(['sim:init', 'sim:fixed']);
  });

  it('calls only render during a frame', () => {
    const world = new GameWorld();
    const log: string[] = [];
    world.addSystem(loggingSystem('sim', log));

    world.render(1, DT);

    expect(log).toEqual(['sim:init', 'sim:render']);
  });

  it('skips systems that implement neither phase', () => {
    const world = new GameWorld();
    world.addSystem({ name: 'inert' });

    // No hook, no throw.
    expect(() => {
      world.fixedUpdate(DT);
      world.render(1, DT);
    }).not.toThrow();
  });
});

describe('GameWorld system error isolation', () => {
  it('reports a throwing fixedUpdate and still runs the rest', () => {
    const world = new GameWorld();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log: string[] = [];

    world.addSystem({
      name: 'before',
      fixedUpdate: () => {
        log.push('before');
      },
    });
    world.addSystem({
      name: 'brokenAi',
      fixedUpdate: () => {
        throw new Error('navmesh query failed');
      },
    });
    world.addSystem({
      name: 'after',
      fixedUpdate: () => {
        log.push('after');
      },
    });

    expect(() => world.fixedUpdate(DT)).not.toThrow();

    // One broken AI system must not freeze the game, and must not vanish
    // silently either.
    expect(log).toEqual(['before', 'after']);
    expect(error).toHaveBeenCalled();
    expect(String(error.mock.calls[0]?.[0])).toContain('brokenAi');
    error.mockRestore();
  });

  it('keeps stepping on subsequent frames after a system throws', () => {
    const world = new GameWorld();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const survivor = vi.fn();

    world.addSystem({
      name: 'brokenAi',
      fixedUpdate: () => {
        throw new Error('still broken');
      },
    });
    world.addSystem({ name: 'movement', fixedUpdate: survivor });

    world.fixedUpdate(DT);
    world.fixedUpdate(DT);
    world.fixedUpdate(DT);

    expect(survivor).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledTimes(3);
    error.mockRestore();
  });

  it('leaves the world usable after a system throws', () => {
    const world = new GameWorld();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    world.addSystem({
      name: 'brokenAi',
      fixedUpdate: () => {
        throw new Error('boom');
      },
    });

    world.fixedUpdate(DT);
    const spawned = world.spawn({ transform: createTransform(), renderable: fakeRenderable() });

    expect(world.entityCount).toBe(1);
    expect(world.renderables.entities).toEqual([spawned]);
    error.mockRestore();
  });

  it('reports a throwing render and still runs the rest', () => {
    const world = new GameWorld();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log: string[] = [];

    world.addSystem({
      name: 'brokenPost',
      render: () => {
        throw new Error('uniform missing');
      },
    });
    world.addSystem({
      name: 'hud',
      render: () => {
        log.push('hud');
      },
    });

    expect(() => world.render(0.5, DT)).not.toThrow();

    expect(log).toEqual(['hud']);
    expect(String(error.mock.calls[0]?.[0])).toContain('brokenPost');
    error.mockRestore();
  });

  it('reports a throwing dispose and still disposes the rest', () => {
    const world = new GameWorld();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log: string[] = [];

    world.addSystem({
      name: 'first',
      dispose: () => {
        log.push('first');
      },
    });
    world.addSystem({
      name: 'brokenTeardown',
      dispose: () => {
        throw new Error('gpu buffer already freed');
      },
    });

    expect(() => world.dispose()).not.toThrow();

    expect(log).toEqual(['first']);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('GameWorld profiling', () => {
  it('has a timing entry per registered system', () => {
    const world = new GameWorld();
    world.addSystem({ name: 'input' });
    world.addSystem({ name: 'movement' });

    expect(world.getTimings().map((t) => t.name)).toEqual(['input', 'movement']);
  });

  it('leaves timings at zero while profiling is off', () => {
    const world = new GameWorld();
    world.addSystem({ name: 'slow', fixedUpdate: () => spin(2), render: () => spin(2) });

    world.fixedUpdate(DT);
    world.render(1, DT);

    // Two performance.now() calls per system per phase is measurable on a
    // weak phone, so measurement is opt-in.
    for (const timing of world.getTimings()) {
      expect(timing.fixedMs, timing.name).toBe(0);
      expect(timing.renderMs, timing.name).toBe(0);
    }
  });

  it('records real per-system timings once enabled', () => {
    const world = new GameWorld();
    world.addSystem({ name: 'slow', fixedUpdate: () => spin(2), render: () => spin(2) });
    world.setProfiling(true);

    world.fixedUpdate(DT);
    world.render(1, DT);

    const timing = world.getTimings().find((t) => t.name === 'slow');
    expect(timing).toBeDefined();
    expect(timing!.fixedMs).toBeGreaterThan(0);
    expect(timing!.renderMs).toBeGreaterThan(0);
  });

  it('zeroes timings when profiling is turned back off', () => {
    const world = new GameWorld();
    world.addSystem({ name: 'slow', fixedUpdate: () => spin(2), render: () => spin(2) });
    world.setProfiling(true);
    world.fixedUpdate(DT);
    world.render(1, DT);

    world.setProfiling(false);

    // Stale numbers in a closed overlay would be read as current.
    for (const timing of world.getTimings()) {
      expect(timing.fixedMs, timing.name).toBe(0);
      expect(timing.renderMs, timing.name).toBe(0);
    }
  });
});

describe('GameWorld sector streaming', () => {
  function worldWithSectors(): GameWorld {
    const world = new GameWorld();
    world.spawn({ debugName: 'pump-a', sector: { sectorId: 'pump-station-12' } });
    world.spawn({ debugName: 'pump-b', sector: { sectorId: 'pump-station-12' } });
    world.spawn({ debugName: 'bridge-rail', sector: { sectorId: 'service-bridge' } });
    return world;
  }

  it('removes only the entities belonging to the named sector', () => {
    const world = worldWithSectors();

    const removed = world.despawnSector('pump-station-12');

    expect(removed).toBe(2);
    expect(world.entityCount).toBe(1);
    expect(world.sectorMembers.entities.map((e) => e.debugName)).toEqual(['bridge-rail']);
  });

  it('spares entities tagged isPersistentAcrossSectors', () => {
    const world = worldWithSectors();
    const mara = world.spawn({
      isPlayer: true,
      isPersistentAcrossSectors: true,
      transform: createTransform(),
      sector: { sectorId: 'pump-station-12' },
    });

    const removed = world.despawnSector('pump-station-12');

    // Unloading the sector the player is standing in must not delete her.
    expect(removed).toBe(2);
    expect(world.player).toBe(mara);
  });

  it('leaves entities with no sector component untouched', () => {
    const world = worldWithSectors();
    world.spawn({ debugName: 'global-audio' });

    world.despawnSector('pump-station-12');

    expect(world.entityCount).toBe(2);
  });

  it('returns zero for a sector that was never loaded', () => {
    const world = worldWithSectors();

    expect(world.despawnSector('flooded-tunnel')).toBe(0);
    expect(world.entityCount).toBe(3);
  });

  it('removes every member when called twice', () => {
    const world = worldWithSectors();

    expect(world.despawnSector('pump-station-12')).toBe(2);
    // The query was mutated during the first pass; the second must see it empty.
    expect(world.despawnSector('pump-station-12')).toBe(0);
  });
});

describe('GameWorld persistent lookup', () => {
  it('finds a persistent entity by its authored id', () => {
    const world = new GameWorld();
    world.spawn({ persistent: { id: 'gate-04', state: { open: false } } });
    const breaker = world.spawn({ persistent: { id: 'breaker-4b', state: { thrown: true } } });

    expect(world.findPersistent('breaker-4b')).toBe(breaker);
  });

  it('returns undefined for an unknown id', () => {
    const world = new GameWorld();
    world.spawn({ persistent: { id: 'gate-04', state: {} } });

    expect(world.findPersistent('gate-99')).toBeUndefined();
  });

  it('ignores entities without a persistent component', () => {
    const world = new GameWorld();
    world.spawn({ debugName: 'gate-04' });

    expect(world.persistent.entities).toHaveLength(0);
    expect(world.findPersistent('gate-04')).toBeUndefined();
  });
});

describe('GameWorld getCounts', () => {
  it('reports the real size of each query', () => {
    const world = new GameWorld();
    world.spawn({ transform: createTransform(), renderable: fakeRenderable() });
    world.spawn({
      transform: createTransform(),
      renderable: fakeRenderable(),
      machineAi: fakeMachineAi(),
      perception: fakePerception(),
      navAgent: fakeNavAgent(),
      isMachine: true,
    });
    world.spawn({ transform: createTransform(), npc: fakeNpc('ivo'), isNpc: true });
    world.spawn({ transform: createTransform(), interactable: fakeInteractable('Breaker 4B') });
    world.spawn({ transform: createTransform(), audioEmitter: fakeAudioEmitter() });
    world.spawn({ persistent: { id: 'gate-04', state: {} } });

    expect(world.getCounts()).toEqual({
      entities: 6,
      renderables: 2,
      machines: 1,
      npcs: 1,
      navAgents: 1,
      interactables: 1,
      audioEmitters: 1,
      persistent: 1,
    });
  });

  it('reports zeros for an empty world', () => {
    const counts = new GameWorld().getCounts();

    expect(counts.entities).toBe(0);
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });

  it('follows despawns', () => {
    const world = new GameWorld();
    const entity = world.spawn({ transform: createTransform(), renderable: fakeRenderable() });
    expect(world.getCounts().renderables).toBe(1);

    world.despawn(entity);

    expect(world.getCounts().renderables).toBe(0);
  });
});

describe('GameWorld dispose', () => {
  it('disposes systems in reverse registration order', () => {
    const world = new GameWorld();
    const log: string[] = [];
    world.addSystem(loggingSystem('input', log));
    world.addSystem(loggingSystem('physics', log));
    world.addSystem(loggingSystem('render', log));

    world.dispose();

    // Reverse order so a system tears down while the systems it depends on
    // are still valid.
    expect(log.filter((entry) => entry.endsWith(':dispose'))).toEqual([
      'render:dispose',
      'physics:dispose',
      'input:dispose',
    ]);
  });

  it('clears entities, systems and timings', () => {
    const world = new GameWorld();
    world.addSystem({ name: 'input' });
    world.spawn({ transform: createTransform(), renderable: fakeRenderable() });
    world.spawn({ isPlayer: true, transform: createTransform() });

    world.dispose();

    expect(world.entityCount).toBe(0);
    expect(world.renderables.entities).toHaveLength(0);
    expect(world.player).toBeUndefined();
    expect(world.systemNames).toEqual([]);
    expect(world.getTimings()).toEqual([]);
  });

  it('does not call the disposed systems again', () => {
    const world = new GameWorld();
    const fixedUpdate = vi.fn();
    world.addSystem({ name: 'input', fixedUpdate });

    world.dispose();
    world.fixedUpdate(DT);

    expect(fixedUpdate).not.toHaveBeenCalled();
  });

  it('allows the same system name to be registered again after dispose', () => {
    const world = new GameWorld();
    world.addSystem({ name: 'input' });
    world.dispose();

    expect(() => world.addSystem({ name: 'input' })).not.toThrow();
  });
});

describe('component helpers', () => {
  describe('vec3', () => {
    it('defaults to the origin', () => {
      expect(vec3()).toEqual({ x: 0, y: 0, z: 0 });
    });

    it('keeps the components in x, y, z order', () => {
      expect(vec3(1, 2, 3)).toEqual({ x: 1, y: 2, z: 3 });
    });

    it('returns a fresh object each call', () => {
      const a = vec3(1, 1, 1);
      const b = vec3(1, 1, 1);
      expect(a).not.toBe(b);
    });
  });

  describe('createTransform', () => {
    it('defaults to origin, no rotation, unit scale', () => {
      expect(createTransform()).toEqual({
        position: { x: 0, y: 0, z: 0 },
        yaw: 0,
        pitch: 0,
        roll: 0,
        scale: 1,
      });
    });

    it('applies the supplied position and yaw', () => {
      const t = createTransform(vec3(3, 1, -2), Math.PI / 2);
      expect(t.position).toEqual({ x: 3, y: 1, z: -2 });
      expect(t.yaw).toBeCloseTo(Math.PI / 2);
    });

    it('copies the position instead of aliasing it', () => {
      const spawnPoint = vec3(5, 0, 5);
      const a = createTransform(spawnPoint);
      const b = createTransform(spawnPoint);

      a.position.x = 100;

      // A shared authored spawn point must not be dragged around by whichever
      // entity was spawned on it.
      expect(a.position).not.toBe(spawnPoint);
      expect(spawnPoint.x).toBe(5);
      expect(b.position.x).toBe(5);
    });
  });

  describe('distanceSquared', () => {
    it('is zero for identical points', () => {
      expect(distanceSquared(vec3(1, 2, 3), vec3(1, 2, 3))).toBe(0);
    });

    it('sums the squared component deltas', () => {
      expect(distanceSquared(vec3(0, 0, 0), vec3(1, 2, 2))).toBe(9);
    });

    it('is symmetric', () => {
      const a = vec3(-3, 4, 1);
      const b = vec3(2, -1, 6);
      expect(distanceSquared(a, b)).toBe(distanceSquared(b, a));
    });
  });

  describe('distance', () => {
    it('is the square root of distanceSquared', () => {
      const a = vec3(0, 0, 0);
      const b = vec3(1, 2, 2);
      expect(distance(a, b)).toBe(3);
      expect(distance(a, b)).toBeCloseTo(Math.sqrt(distanceSquared(a, b)));
    });

    it('is zero for identical points', () => {
      expect(distance(vec3(4, 4, 4), vec3(4, 4, 4))).toBe(0);
    });
  });

  describe('planarDistanceSquared', () => {
    it('ignores height entirely', () => {
      const ground = vec3(0, 0, 0);
      const overhead = vec3(3, 40, 4);

      // Interaction range is horizontal: a valve one storey up must not read
      // as "in reach" or "far away" because of its Y.
      expect(planarDistanceSquared(ground, overhead)).toBe(25);
      expect(planarDistanceSquared(ground, vec3(3, 0, 4))).toBe(25);
    });

    it('is zero for points on the same vertical line', () => {
      expect(planarDistanceSquared(vec3(2, 0, 7), vec3(2, 12, 7))).toBe(0);
    });

    it('is never greater than the full 3D squared distance', () => {
      const a = vec3(1, 5, 2);
      const b = vec3(-4, 9, 8);
      expect(planarDistanceSquared(a, b)).toBeLessThanOrEqual(distanceSquared(a, b));
    });
  });
});

describe('Entity typing', () => {
  it('allows a tag-only entity', () => {
    const world = new GameWorld();
    // Tags are presence-only markers; an entity may consist of nothing else.
    const marker: Entity = { isCheckpoint: true };
    world.spawn(marker);

    expect(world.entityCount).toBe(1);
  });
});
