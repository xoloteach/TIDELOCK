/**
 * ECS world and system scheduler.
 *
 * Wraps miniplex with the queries and lifecycle this game needs. Systems are
 * plain objects with an `update` method, registered in explicit order — the
 * order matters (input before movement, movement before physics, physics
 * before render sync) so it is declared rather than inferred.
 */

import { World } from 'miniplex';
import type { Entity } from './components';

/**
 * A system advances part of the simulation.
 *
 * `fixedUpdate` runs on the fixed timestep and is where all gameplay and
 * physics belong. `render` runs once per animation frame and may only do
 * presentation work (interpolation, camera, animation sampling).
 */
export interface System {
  readonly name: string;
  /** Fixed-timestep simulation. `dt` is always the same value. */
  fixedUpdate?(dt: number): void;
  /**
   * Per-frame presentation work.
   * @param alpha Interpolation factor between the previous and current step.
   * @param frameDelta Real seconds since the previous frame.
   */
  render?(alpha: number, frameDelta: number): void;
  /** Called once when the system is registered. */
  init?(): void;
  /** Called when the world is torn down. Release GPU/native resources here. */
  dispose?(): void;
}

/** Per-system timing, surfaced in the diagnostics overlay. */
export interface SystemTiming {
  name: string;
  /** Milliseconds spent in the most recent fixedUpdate. */
  fixedMs: number;
  /** Milliseconds spent in the most recent render. */
  renderMs: number;
}

export class GameWorld {
  readonly ecs = new World<Entity>();

  private readonly systems: System[] = [];
  private readonly timings = new Map<string, SystemTiming>();
  private profilingEnabled = false;

  // ---- Standing queries -------------------------------------------------
  // Created once and reused. Building a query per frame would rebuild the
  // index every time.

  /** Entities whose scene node must follow their transform. */
  readonly renderables = this.ecs.with('transform', 'renderable');
  /** Entities that move under physics or scripted velocity. */
  readonly moving = this.ecs.with('transform', 'velocity');
  /** Entities with LOD levels to evaluate against camera distance. */
  readonly lodEntities = this.ecs.with('transform', 'lod');
  /** Skinned/animated entities needing mixer updates. */
  readonly animated = this.ecs.with('animation');
  /** Machines with perception, for the AI and perception systems. */
  readonly machines = this.ecs.with('transform', 'machineAi', 'perception');
  /** Human NPCs. */
  readonly npcs = this.ecs.with('transform', 'npc');
  /** Anything following a navmesh path. */
  readonly navAgents = this.ecs.with('transform', 'navAgent');
  /** Candidates for the interaction prompt. */
  readonly interactables = this.ecs.with('transform', 'interactable');
  /** Positional audio sources. */
  readonly audioEmitters = this.ecs.with('transform', 'audioEmitter');
  /** Entities whose state is written into saves. */
  readonly persistent = this.ecs.with('persistent');
  /** Entities owned by a streaming sector. */
  readonly sectorMembers = this.ecs.with('sector');
  /** Entities that expire. */
  readonly ephemeral = this.ecs.with('lifetime');

  /**
   * The player entity.
   *
   * A query rather than a stored reference so it stays correct across respawn
   * and sector transitions.
   */
  readonly playerQuery = this.ecs.with('isPlayer', 'transform');

  get player(): Entity | undefined {
    return this.playerQuery.entities[0];
  }

  // ---- Systems ----------------------------------------------------------

  /** Registers a system. Execution order follows registration order. */
  addSystem(system: System): void {
    if (this.systems.some((s) => s.name === system.name)) {
      throw new Error(`System "${system.name}" is already registered`);
    }
    this.systems.push(system);
    this.timings.set(system.name, { name: system.name, fixedMs: 0, renderMs: 0 });
    system.init?.();
  }

  getSystem(name: string): System | undefined {
    return this.systems.find((s) => s.name === name);
  }

  /**
   * Runs every system's fixedUpdate in registration order.
   *
   * A throwing system is reported and skipped for this step rather than
   * killing the loop — one broken AI system must not freeze the whole game.
   */
  fixedUpdate(dt: number): void {
    for (const system of this.systems) {
      if (!system.fixedUpdate) continue;

      if (this.profilingEnabled) {
        const start = performance.now();
        this.runFixed(system, dt);
        const timing = this.timings.get(system.name);
        if (timing) timing.fixedMs = performance.now() - start;
      } else {
        this.runFixed(system, dt);
      }
    }
  }

  private runFixed(system: System, dt: number): void {
    try {
      system.fixedUpdate!(dt);
    } catch (error) {
      console.error(`[ecs] system "${system.name}" threw in fixedUpdate`, error);
    }
  }

  render(alpha: number, frameDelta: number): void {
    for (const system of this.systems) {
      if (!system.render) continue;

      if (this.profilingEnabled) {
        const start = performance.now();
        this.runRender(system, alpha, frameDelta);
        const timing = this.timings.get(system.name);
        if (timing) timing.renderMs = performance.now() - start;
      } else {
        this.runRender(system, alpha, frameDelta);
      }
    }
  }

  private runRender(system: System, alpha: number, frameDelta: number): void {
    try {
      system.render!(alpha, frameDelta);
    } catch (error) {
      console.error(`[ecs] system "${system.name}" threw in render`, error);
    }
  }

  /**
   * Per-system timing is off by default: `performance.now()` twice per system
   * per frame is measurable overhead on a weak phone. The diagnostics overlay
   * enables it while open.
   */
  setProfiling(enabled: boolean): void {
    this.profilingEnabled = enabled;
    if (!enabled) {
      for (const timing of this.timings.values()) {
        timing.fixedMs = 0;
        timing.renderMs = 0;
      }
    }
  }

  getTimings(): SystemTiming[] {
    return [...this.timings.values()];
  }

  get systemNames(): string[] {
    return this.systems.map((s) => s.name);
  }

  // ---- Entity helpers ---------------------------------------------------

  spawn(entity: Entity): Entity {
    return this.ecs.add(entity);
  }

  despawn(entity: Entity): void {
    this.ecs.remove(entity);
  }

  /** Removes every entity belonging to a sector. Used by streaming unload. */
  despawnSector(sectorId: string): number {
    // Copy first: removing while iterating a live query mutates it underneath.
    const doomed = this.sectorMembers.entities.filter(
      (e) => e.sector.sectorId === sectorId && !e.isPersistentAcrossSectors,
    );
    for (const entity of doomed) this.ecs.remove(entity);
    return doomed.length;
  }

  /** Finds a persistent entity by its authored id. */
  findPersistent(id: string): Entity | undefined {
    return this.persistent.entities.find((e) => e.persistent.id === id);
  }

  get entityCount(): number {
    return this.ecs.entities.length;
  }

  /** Counts used by the diagnostics overlay. */
  getCounts(): Record<string, number> {
    return {
      entities: this.entityCount,
      renderables: this.renderables.entities.length,
      machines: this.machines.entities.length,
      npcs: this.npcs.entities.length,
      navAgents: this.navAgents.entities.length,
      interactables: this.interactables.entities.length,
      audioEmitters: this.audioEmitters.entities.length,
      persistent: this.persistent.entities.length,
    };
  }

  dispose(): void {
    // Dispose in reverse registration order so systems tear down after their
    // dependencies are still valid.
    for (const system of [...this.systems].reverse()) {
      try {
        system.dispose?.();
      } catch (error) {
        console.error(`[ecs] system "${system.name}" threw in dispose`, error);
      }
    }
    this.systems.length = 0;
    this.timings.clear();
    this.ecs.clear();
  }
}
