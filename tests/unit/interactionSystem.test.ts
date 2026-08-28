/**
 * Interaction targeting and activation tests.
 *
 * One action interacts with everything (spec 8.2), which means the only thing
 * standing between the player and the wrong door is the selection rule. That
 * rule is not "nearest": it is view-centredness first, proximity second, inside
 * a yaw cone, with a hysteresis margin so the prompt cannot flicker between two
 * adjacent objects. Each of those clauses is a behaviour a player would notice
 * breaking and none of them is visible to a typecheck, so they are pinned here.
 *
 * Activation is the other half: a hold must ring up and fire once, an early
 * release must fire nothing, and a one-shot pickup must not be takeable twice.
 *
 * The system is driven directly rather than through `GameWorld.fixedUpdate`, so
 * a throw fails the test instead of being swallowed by the scheduler's error
 * isolation.
 */

import { describe, it, expect } from 'vitest';
import { GameWorld } from '../../src/engine/ecs/GameWorld';
import {
  createTransform,
  vec3,
  type Entity,
  type Interactable,
  type InteractionVerb,
  type Vec3,
} from '../../src/engine/ecs/components';
import {
  InteractionSystem,
  forwardFromYaw,
  type HoldCancelReason,
  type InteractionInputPort,
  type InteractionSystemOptions,
  type InteractionTarget,
} from '../../src/game/interactions/InteractionSystem';
import type { ButtonAction } from '../../src/engine/input/actions';

const DT = 1 / 60;
const DEG = Math.PI / 180;

/**
 * The system's default eye height, restated so the arithmetic in these tests is
 * readable. Prompt anchors are placed at the same height, which makes every
 * distance below the horizontal one the test names — the eye offset itself is
 * checked separately.
 */
const EYE_HEIGHT = 1.6;

// ---------------------------------------------------------------------------
// Fakes and fixtures
// ---------------------------------------------------------------------------

/**
 * Stands in for the input layer.
 *
 * `wasPressed` is true for exactly one step per press, which is what the real
 * `InputState` guarantees and what stops a held button from re-firing a
 * repeatable switch. `endStep` is the edge clear the input layer performs at
 * the end of every frame.
 */
class FakeInput implements InteractionInputPort {
  private readonly down = new Set<ButtonAction>();
  private readonly pressed = new Set<ButtonAction>();

  isDown(action: ButtonAction): boolean {
    return this.down.has(action);
  }

  wasPressed(action: ButtonAction): boolean {
    return this.pressed.has(action);
  }

  press(action: ButtonAction = 'interact'): void {
    this.down.add(action);
    this.pressed.add(action);
  }

  release(action: ButtonAction = 'interact'): void {
    this.down.delete(action);
  }

  endStep(): void {
    this.pressed.clear();
  }
}

function interactable(overrides: Partial<Interactable> = {}): Interactable {
  return {
    verb: 'turn',
    label: 'Valve 4B',
    range: 3,
    holdDuration: 0,
    enabled: true,
    event: 'pump:valve-turned',
    promptOffset: vec3(0, EYE_HEIGHT, 0),
    repeatable: false,
    ...overrides,
  };
}

interface Recorded {
  targetChanged: { target: InteractionTarget | null; previous: InteractionTarget | null }[];
  holdStarted: { entity: Entity; label: string; holdDuration: number }[];
  holdCancelled: { entity: Entity; progress: number; reason: HoldCancelReason }[];
  completed: {
    entity: Entity;
    event: string;
    verb: InteractionVerb;
    label: string;
    heldFor: number;
  }[];
}

interface Harness {
  world: GameWorld;
  system: InteractionSystem;
  input: FakeInput;
  /** The player's live transform, so a test can walk or turn her. */
  playerTransform: ReturnType<typeof createTransform>;
  events: Recorded;
  /** One fixed step, followed by the input layer's end-of-frame edge clear. */
  step(dt?: number): void;
}

function harness(options: Omit<Partial<InteractionSystemOptions>, 'world' | 'input'> = {}): Harness {
  const world = new GameWorld();
  const playerTransform = createTransform();
  world.spawn({ isPlayer: true, transform: playerTransform, debugName: 'mara' });

  const input = new FakeInput();
  const system = new InteractionSystem({ world, input, ...options });

  const events: Recorded = {
    targetChanged: [],
    holdStarted: [],
    holdCancelled: [],
    completed: [],
  };
  system.on('target-changed', (payload) => events.targetChanged.push(payload));
  system.on('hold-started', (payload) => events.holdStarted.push(payload));
  system.on('hold-cancelled', (payload) => events.holdCancelled.push(payload));
  system.on('completed', (payload) => events.completed.push(payload));

  return {
    world,
    system,
    input,
    playerTransform,
    events,
    step: (dt = DT) => {
      system.fixedUpdate(dt);
      input.endStep();
    },
  };
}

function spawnInteractable(
  world: GameWorld,
  position: Vec3,
  overrides: Partial<Interactable> = {},
): { entity: Entity; transform: ReturnType<typeof createTransform>; interactable: Interactable } {
  const transform = createTransform(position);
  const component = interactable(overrides);
  const entity = world.spawn({ transform, interactable: component, debugName: component.label });
  return { entity, transform, interactable: component };
}

/** A point `metres` away at `degrees` off the player's default facing (-Z). */
function offAxis(degrees: number, metres: number): Vec3 {
  const angle = degrees * DEG;
  return vec3(-Math.sin(angle) * metres, 0, -Math.cos(angle) * metres);
}

// ---------------------------------------------------------------------------

describe('forwardFromYaw', () => {
  it('looks down -Z at yaw zero', () => {
    const forward = forwardFromYaw(0);

    // Three.js convention. Sharing it with the audio listener's default forward
    // is why prompts and panning never disagree.
    expect(forward.x).toBeCloseTo(0);
    expect(forward.z).toBeCloseTo(-1);
  });

  it('rotates toward -X at a positive quarter turn', () => {
    const forward = forwardFromYaw(Math.PI / 2);

    expect(forward.x).toBeCloseTo(-1);
    expect(forward.z).toBeCloseTo(0);
  });

  it('stays horizontal at every yaw', () => {
    for (const yaw of [-Math.PI, -1, 0, 0.3, Math.PI / 2, Math.PI, 7]) {
      // Vertical aim never selects; it only frames the shot.
      expect(forwardFromYaw(yaw).y, `yaw ${yaw}`).toBe(0);
    }
  });
});

describe('InteractionSystem selection', () => {
  it('selects nothing before the first step', () => {
    const h = harness();
    spawnInteractable(h.world, vec3(0, 0, -1.5));

    expect(h.system.target).toBeNull();
  });

  it('selects nothing when the only interactable is out of range', () => {
    const h = harness();
    spawnInteractable(h.world, vec3(0, 0, -5), { range: 2 });

    h.step();

    expect(h.system.target).toBeNull();
    // No prompt appeared, so the HUD is told nothing at all.
    expect(h.events.targetChanged).toHaveLength(0);
  });

  it('selects an interactable in reach and in view', () => {
    const h = harness();
    const valve = spawnInteractable(h.world, vec3(0, 0, -1.5), { range: 2 });

    h.step();

    expect(h.system.target?.entity).toBe(valve.entity);
    expect(h.system.target?.verb).toBe('turn');
    expect(h.system.target?.label).toBe('Valve 4B');
    expect(h.system.target?.distance).toBeCloseTo(1.5);
    expect(h.system.target?.anchor).toEqual({ x: 0, y: EYE_HEIGHT, z: -1.5 });
  });

  it('picks up a target as the player walks into range', () => {
    const h = harness();
    const breaker = spawnInteractable(h.world, vec3(0, 0, -4), { range: 2 });

    h.step();
    expect(h.system.target).toBeNull();

    h.playerTransform.position.z = -2.5;
    h.step();

    expect(h.system.target?.entity).toBe(breaker.entity);
    expect(h.system.target?.distance).toBeCloseTo(1.5);
  });

  it('prefers the nearer of two equally centred candidates', () => {
    const h = harness();
    const near = spawnInteractable(h.world, vec3(0, 0, -1.5), { range: 4, label: 'Breaker 4B' });
    spawnInteractable(h.world, vec3(0, 0, -2.5), { range: 4, label: 'Breaker 4C' });

    h.step();

    // The proximity term is monotonic in metres, so between two equally
    // centred objects the nearer always wins.
    expect(h.system.target?.label).toBe('Breaker 4B');
    expect(h.system.target?.entity).toBe(near.entity);
  });

  it('prefers a centred candidate over a slightly nearer off-centre one', () => {
    const h = harness();
    // 45° off her facing: well inside the 60° cone, so this is a legitimate
    // candidate rather than one the cone rejects.
    const doorframe = spawnInteractable(h.world, offAxis(45, 2.5), {
      range: 4,
      label: 'Doorframe',
    });

    h.step();
    expect(h.system.target?.entity).toBe(doorframe.entity);

    const breaker = spawnInteractable(h.world, vec3(0, 0, -3), { range: 4, label: 'Breaker 4B' });
    h.step();

    // Standing between a breaker panel and a doorframe, "nearest" would hand
    // the prompt to whichever happens to be closer regardless of where she is
    // looking. Half a metre of extra distance loses to being looked at.
    expect(h.system.target?.entity).toBe(breaker.entity);
  });

  it('rejects an interactable behind the player', () => {
    const h = harness();
    const behind = spawnInteractable(h.world, vec3(0, 0, 2), { range: 3 });

    h.step();
    expect(h.system.target).toBeNull();

    h.playerTransform.yaw = Math.PI;
    h.step();

    // Turning round is all it takes: selection is a yaw cone, not a raycast.
    expect(h.system.target?.entity).toBe(behind.entity);
  });

  it('rejects a candidate outside the selection cone', () => {
    const h = harness();
    spawnInteractable(h.world, offAxis(70, 2), { range: 3 });

    h.step();

    // 70° is past the 60° half-angle. Generous, but still a cone.
    expect(h.system.target).toBeNull();
  });

  it('accepts a candidate just inside the selection cone', () => {
    const h = harness();
    const valve = spawnInteractable(h.world, offAxis(55, 2), { range: 3 });

    h.step();

    // A tight cone reads as the game ignoring you, so the edge is forgiving.
    expect(h.system.target?.entity).toBe(valve.entity);
  });

  it('selects an interactable the player is standing on', () => {
    const h = harness();
    const hatch = spawnInteractable(h.world, vec3(0, 0, 0), {
      range: 3,
      promptOffset: vec3(),
      label: 'Floor Hatch',
    });

    h.step();

    // Facing stops being meaningful at zero planar separation, so it is treated
    // as dead centre instead of producing a direction from numerical noise.
    expect(h.system.target?.entity).toBe(hatch.entity);
    // Range is measured from the eye, so the distance is the eye height.
    expect(h.system.target?.distance).toBeCloseTo(EYE_HEIGHT);
  });

  it('ignores a disabled interactable until it is enabled', () => {
    const h = harness();
    const gate = spawnInteractable(h.world, vec3(0, 0, -1.5), { enabled: false });

    h.step();
    expect(h.system.target).toBeNull();

    gate.interactable.enabled = true;
    h.step();

    expect(h.system.target?.entity).toBe(gate.entity);
  });

  it('drops the target when the interactable despawns', () => {
    const h = harness();
    const crate = spawnInteractable(h.world, vec3(0, 0, -1.5));
    h.step();
    expect(h.system.target?.entity).toBe(crate.entity);

    h.world.despawn(crate.entity);
    h.step();

    expect(h.system.target).toBeNull();
    expect(h.events.targetChanged).toHaveLength(2);
    expect(h.events.targetChanged[1]?.target).toBeNull();
  });

  it('drops the target when the player despawns', () => {
    const h = harness();
    spawnInteractable(h.world, vec3(0, 0, -1.5));
    h.step();
    expect(h.system.target).not.toBeNull();

    h.world.despawn(h.world.player!);
    h.step();

    expect(h.system.target).toBeNull();
  });
});

describe('InteractionSystem hysteresis', () => {
  /**
   * The margin is stated here rather than read from the system, so retuning the
   * default cannot silently change what these tests mean.
   */
  const MARGIN = 0.08;

  function twoNearEqual(hysteresisScoreBonus: number) {
    const h = harness({ hysteresisScoreBonus });
    const a = spawnInteractable(h.world, vec3(0, 0, -2), { range: 4, label: 'Breaker 4B' });
    const b = spawnInteractable(h.world, vec3(0, 0, -2.2), { range: 4, label: 'Breaker 4C' });
    return { h, a, b };
  }

  it('keeps the current target when a challenger wins by less than the margin', () => {
    const { h, a, b } = twoNearEqual(MARGIN);
    h.step();
    expect(h.system.target?.entity).toBe(a.entity);

    // b is now 10 cm nearer than a, which is worth about 0.004 of score.
    b.transform.position.z = -1.9;
    h.step();

    expect(h.system.target?.entity).toBe(a.entity);
    // Sub-degree camera noise while the player stands still must not make the
    // HUD rebuild the prompt.
    expect(h.events.targetChanged).toHaveLength(1);
  });

  it('switches when a challenger wins by more than the margin', () => {
    const { h, a, b } = twoNearEqual(MARGIN);
    h.step();
    expect(h.system.target?.entity).toBe(a.entity);

    b.transform.position.z = -0.5;
    h.step();

    // Hysteresis is a margin, not a lock: a decisively better candidate wins.
    expect(h.system.target?.entity).toBe(b.entity);
    expect(h.events.targetChanged).toHaveLength(2);
  });

  it('is the margin that retains the incumbent, not the raw score', () => {
    const { h, a, b } = twoNearEqual(0);
    h.step();
    expect(h.system.target?.entity).toBe(a.entity);

    b.transform.position.z = -1.9;
    h.step();

    // Identical geometry to the first test. With no margin the prompt flickers,
    // which is the failure the margin exists to prevent.
    expect(h.system.target?.entity).toBe(b.entity);
  });

  it('gives the incumbent a little extra reach', () => {
    const h = harness({ hysteresisRangeSlack: 0.2 });
    const valve = spawnInteractable(h.world, vec3(0, 0, -1.95), { range: 2 });
    h.step();
    expect(h.system.target?.entity).toBe(valve.entity);

    // A step past the edge of its declared range.
    valve.transform.position.z = -2.1;
    h.step();
    expect(h.system.target?.entity).toBe(valve.entity);

    valve.transform.position.z = -2.3;
    h.step();

    // Slack, not immunity.
    expect(h.system.target).toBeNull();
  });
});

describe('InteractionSystem hold activation', () => {
  it('ramps hold progress and fires only at completion', () => {
    const h = harness();
    const valve = spawnInteractable(h.world, vec3(0, 0, -1.5), {
      holdDuration: 0.5,
      repeatable: true,
    });
    h.step();
    expect(h.system.target?.holdDuration).toBe(0.5);
    expect(h.system.isHolding).toBe(false);

    h.input.press();
    h.step(0.1);

    // The press starts the hold; no time has been accumulated against it yet.
    expect(h.system.isHolding).toBe(true);
    expect(h.system.holdProgress).toBe(0);
    expect(h.events.holdStarted).toHaveLength(1);
    expect(h.events.holdStarted[0]?.entity).toBe(valve.entity);
    expect(h.events.holdStarted[0]?.holdDuration).toBe(0.5);
    expect(h.events.completed).toHaveLength(0);

    h.step(0.1);
    h.step(0.1);
    expect(h.system.holdProgress).toBeCloseTo(0.4);
    expect(h.system.target?.holdProgress).toBeCloseTo(0.4);
    expect(h.events.completed).toHaveLength(0);

    h.step(0.1);
    h.step(0.1);
    expect(h.system.holdProgress).toBeCloseTo(0.8);
    expect(h.events.completed).toHaveLength(0);

    h.step(0.1);

    expect(h.events.completed).toHaveLength(1);
    expect(h.events.completed[0]?.event).toBe('pump:valve-turned');
    expect(h.events.completed[0]?.verb).toBe('turn');
    expect(h.events.completed[0]?.heldFor).toBeCloseTo(0.5);
    expect(h.system.isHolding).toBe(false);
    expect(h.system.holdProgress).toBe(0);
  });

  it('cancels without firing when the player lets go early', () => {
    const h = harness();
    spawnInteractable(h.world, vec3(0, 0, -1.5), { holdDuration: 0.5, repeatable: true });
    h.step();

    h.input.press();
    h.step(0.1);
    h.step(0.1);
    h.step(0.1);
    expect(h.system.holdProgress).toBeCloseTo(0.4);

    h.input.release();
    h.step(0.1);

    expect(h.events.completed).toHaveLength(0);
    expect(h.events.holdCancelled).toHaveLength(1);
    expect(h.events.holdCancelled[0]?.reason).toBe('released');
    // The HUD needs the progress it got to, so the ring can unwind from there.
    expect(h.events.holdCancelled[0]?.progress).toBeCloseTo(0.4);
    expect(h.system.isHolding).toBe(false);
  });

  it('fires immediately when the hold duration is zero', () => {
    const h = harness();
    const note = spawnInteractable(h.world, vec3(0, 0, -1.5), {
      holdDuration: 0,
      verb: 'read',
      label: 'Shift Note',
      event: 'evidence:shift-note',
    });
    h.step();

    h.input.press();
    h.step();

    // Nothing to ring up, so no hold is announced.
    expect(h.events.holdStarted).toHaveLength(0);
    expect(h.events.completed).toHaveLength(1);
    expect(h.events.completed[0]?.entity).toBe(note.entity);
    expect(h.events.completed[0]?.event).toBe('evidence:shift-note');
    expect(h.events.completed[0]?.heldFor).toBe(0);
    expect(h.system.holdProgress).toBe(0);
  });

  it('locks the target for the duration of a hold', () => {
    const h = harness();
    const far = spawnInteractable(h.world, vec3(0, 0, -2), {
      holdDuration: 0.5,
      range: 4,
      label: 'Breaker 4B',
      repeatable: true,
    });
    h.step();
    expect(h.system.target?.entity).toBe(far.entity);

    h.input.press();
    h.step(0.1);

    // A much better candidate appears mid-hold: nearer and dead centre.
    const near = spawnInteractable(h.world, vec3(0, 0, -0.6), {
      holdDuration: 0.5,
      range: 4,
      label: 'Breaker 4C',
      repeatable: true,
    });
    h.step(0.1);
    h.step(0.1);

    // Retargeting mid-hold would let a camera twitch spend the player's held
    // press on the wrong object.
    expect(h.system.target?.entity).toBe(far.entity);
    expect(h.system.target?.entity).not.toBe(near.entity);

    h.step(0.1);
    h.step(0.1);
    h.step(0.1);

    expect(h.events.completed).toHaveLength(1);
    expect(h.events.completed[0]?.label).toBe('Breaker 4B');
  });

  it('kills a hold whose target leaves reach, and does not fire it', () => {
    const h = harness();
    const cart = spawnInteractable(h.world, vec3(0, 0, -1.5), { holdDuration: 0.5, range: 2 });
    h.step();

    h.input.press();
    h.step(0.1);
    h.step(0.1);

    cart.transform.position.z = -9;
    h.step(0.1);

    expect(h.events.holdCancelled).toHaveLength(1);
    expect(h.events.holdCancelled[0]?.reason).toBe('target-lost');
    expect(h.system.target).toBeNull();

    // Still holding the button, but there is nothing left to spend it on.
    h.step(0.1);
    h.step(0.1);
    h.step(0.1);
    h.step(0.1);
    expect(h.events.completed).toHaveLength(0);
  });

  it('cancels a hold when the player despawns mid-hold', () => {
    const h = harness();
    spawnInteractable(h.world, vec3(0, 0, -1.5), { holdDuration: 0.5 });
    h.step();

    h.input.press();
    h.step(0.1);
    h.world.despawn(h.world.player!);
    h.step(0.1);

    expect(h.events.holdCancelled[0]?.reason).toBe('target-lost');
    expect(h.events.completed).toHaveLength(0);
  });

  it('does not start a hold from a button that was already down', () => {
    const h = harness();
    // Held before anything is in view, and never re-pressed.
    h.input.press();
    h.step();
    h.input.endStep();
    spawnInteractable(h.world, vec3(0, 0, -1.5), { holdDuration: 0.5 });

    h.step();
    h.step();
    h.step();

    // A player walking around with interact held must not get a free
    // activation the moment an object comes into view.
    expect(h.system.isHolding).toBe(false);
    expect(h.events.holdStarted).toHaveLength(0);
    expect(h.events.completed).toHaveLength(0);
  });

  it('reset drops the target and the hold without firing', () => {
    const h = harness();
    spawnInteractable(h.world, vec3(0, 0, -1.5), { holdDuration: 0.5 });
    h.step();
    h.input.press();
    h.step(0.1);
    h.step(0.1);

    h.system.reset();

    expect(h.events.holdCancelled).toHaveLength(1);
    expect(h.events.holdCancelled[0]?.reason).toBe('reset');
    expect(h.system.target).toBeNull();
    expect(h.events.completed).toHaveLength(0);
  });
});

describe('InteractionSystem repeatability', () => {
  it('retires a one-shot interaction after it is used', () => {
    const h = harness();
    const pickup = spawnInteractable(h.world, vec3(0, 0, -1.5), {
      repeatable: false,
      verb: 'take',
      label: 'Depot Keycard',
    });
    h.step();

    h.input.press();
    h.step();

    expect(h.events.completed).toHaveLength(1);
    // A pickup that can be taken twice is a duplication bug, not generosity.
    expect(pickup.interactable.enabled).toBe(false);
    // And the prompt clears in the same step rather than lingering until the
    // next selection pass.
    expect(h.system.target).toBeNull();

    h.input.release();
    h.step();
    h.input.press();
    h.step();

    expect(h.events.completed).toHaveLength(1);
  });

  it('fires a repeatable interaction once per press', () => {
    const h = harness();
    spawnInteractable(h.world, vec3(0, 0, -1.5), { repeatable: true, holdDuration: 0 });
    h.step();

    h.input.press();
    h.step();
    expect(h.events.completed).toHaveLength(1);

    // Still held: one press is one interaction, and a held button must not
    // machine-gun a repeatable switch.
    h.step();
    h.step();
    expect(h.events.completed).toHaveLength(1);

    h.input.release();
    h.step();
    h.input.press();
    h.step();

    expect(h.events.completed).toHaveLength(2);
  });

  it('keeps the prompt on a repeatable interaction after firing', () => {
    const h = harness();
    const lever = spawnInteractable(h.world, vec3(0, 0, -1.5), {
      repeatable: true,
      holdDuration: 0,
    });
    h.step();

    h.input.press();
    h.step();

    expect(h.system.target?.entity).toBe(lever.entity);
    expect(lever.interactable.enabled).toBe(true);
  });
});

describe('InteractionSystem occlusion', () => {
  it('selects nothing while the only candidate is behind geometry', () => {
    const h = harness({ occlusion: { isOccluded: () => true } });
    spawnInteractable(h.world, vec3(0, 0, -1.5));

    h.step();

    expect(h.system.target).toBeNull();
  });

  it('falls through to a candidate that is not blocked', () => {
    const h = harness();
    spawnInteractable(h.world, vec3(0, 0, -1.5), { range: 4, label: 'Breaker 4B' });
    const far = spawnInteractable(h.world, vec3(0, 0, -3), { range: 4, label: 'Breaker 4C' });
    const segments: { from: Vec3; to: Vec3 }[] = [];

    h.system.setOcclusionPort({
      isOccluded: (from, to) => {
        segments.push({ from: { ...from }, to });
        // A dropped shutter across the near breaker only.
        return to.z > -2;
      },
    });
    h.step();

    expect(h.system.target?.entity).toBe(far.entity);
    // The ray starts at the eye, not the feet: a segment from the floor would
    // be blocked by every kerb.
    expect(segments[0]?.from).toEqual({ x: 0, y: EYE_HEIGHT, z: 0 });
    // One segment per candidate that got as far as the raycast, and each with
    // its own anchor object — a port is free to keep what it is handed rather
    // than reading a scratch vector that has since moved on. Candidate order is
    // the ECS query's business, so the anchors are compared as a set.
    expect(segments).toHaveLength(2);
    expect(segments[0]?.to).not.toBe(segments[1]?.to);
    expect(segments.map((segment) => segment.to.z).sort((x, y) => x - y)).toEqual([-3, -1.5]);
    expect(segments.every((segment) => segment.to.y === EYE_HEIGHT)).toBe(true);
  });

  it('skips the check entirely once the occlusion port is removed', () => {
    const h = harness({ occlusion: { isOccluded: () => true } });
    const valve = spawnInteractable(h.world, vec3(0, 0, -1.5));
    h.step();
    expect(h.system.target).toBeNull();

    h.system.setOcclusionPort(null);
    h.step();

    // Early sectors and unit tests run before a BVH exists, so no port means no
    // test — not a default of "blocked".
    expect(h.system.target?.entity).toBe(valve.entity);
  });

  it('re-tests occlusion during a hold and cancels when the line is broken', () => {
    let blocked = false;
    const h = harness({ occlusion: { isOccluded: () => blocked } });
    spawnInteractable(h.world, vec3(0, 0, -1.5), { holdDuration: 0.5 });
    h.step();

    h.input.press();
    h.step(0.1);
    h.step(0.1);

    blocked = true;
    h.step(0.1);

    // A shutter dropping between her and the panel ends the interaction.
    expect(h.events.holdCancelled[0]?.reason).toBe('target-lost');
    expect(h.events.completed).toHaveLength(0);
  });
});

describe('InteractionSystem suppression', () => {
  it('suppresses prompts and abandons a hold while something else owns the player', () => {
    const h = harness();
    spawnInteractable(h.world, vec3(0, 0, -1.5), { holdDuration: 0.5 });
    h.step();

    h.input.press();
    h.step(0.1);
    h.step(0.1);
    expect(h.system.isHolding).toBe(true);

    h.system.setCanInteract(() => false);
    h.step(0.1);

    expect(h.system.target).toBeNull();
    expect(h.events.holdCancelled).toHaveLength(1);
    expect(h.events.holdCancelled[0]?.reason).toBe('suppressed');

    // Holding the button through a whole conversation must not bank progress.
    h.step(0.1);
    h.step(0.1);
    h.step(0.1);
    h.step(0.1);
    h.step(0.1);
    expect(h.events.completed).toHaveLength(0);

    h.system.setCanInteract(() => true);
    h.step(0.1);

    expect(h.system.target).not.toBeNull();
    // The swallowed press is not resumed behind the UI; she has to press again.
    expect(h.system.isHolding).toBe(false);
    expect(h.events.completed).toHaveLength(0);
  });

  it('takes no prompt at all while suppressed from the start', () => {
    const h = harness({ canInteract: () => false });
    spawnInteractable(h.world, vec3(0, 0, -1.5));

    h.step();
    h.input.press();
    h.step();

    expect(h.system.target).toBeNull();
    expect(h.events.targetChanged).toHaveLength(0);
    expect(h.events.completed).toHaveLength(0);
  });
});

describe('InteractionSystem target-changed', () => {
  it('reports a change only when the prompt actually changes', () => {
    const h = harness();
    const door = spawnInteractable(h.world, vec3(0, 0, -1.5), {
      verb: 'open',
      label: 'Bay Door',
      range: 4,
    });

    h.step();
    h.step();
    h.step();

    // Distance changes every step and is read from `target`, never pushed —
    // otherwise this event would be useless as a "rebuild the prompt" signal.
    expect(h.events.targetChanged).toHaveLength(1);
    expect(h.events.targetChanged[0]?.previous).toBeNull();

    h.playerTransform.position.z = -0.5;
    h.step();
    expect(h.system.target?.distance).toBeCloseTo(1);
    expect(h.events.targetChanged).toHaveLength(1);

    door.interactable.verb = 'close';
    h.step();

    // The prompt itself changed, so the HUD has to rebuild it.
    //
    // Only the incoming side is asserted. `previous` is snapshotted from the
    // live `Interactable` component after it has already been mutated, so it
    // reports the *new* verb and label rather than the outgoing ones — reported
    // as a defect rather than pinned here as correct.
    expect(h.events.targetChanged).toHaveLength(2);
    expect(h.events.targetChanged[1]?.target?.verb).toBe('close');
    expect(h.events.targetChanged[1]?.target?.entity).toBe(door.entity);
    expect(h.events.targetChanged[1]?.previous?.entity).toBe(door.entity);

    door.interactable.label = 'Bay Door — Jammed';
    h.step();

    expect(h.events.targetChanged).toHaveLength(3);
    expect(h.events.targetChanged[2]?.target?.label).toBe('Bay Door — Jammed');
  });

  it('reports the outgoing target when the prompt is swapped', () => {
    const h = harness();
    const first = spawnInteractable(h.world, vec3(0, 0, -1.5), { range: 4, label: 'Breaker 4B' });
    h.step();

    const second = spawnInteractable(h.world, vec3(0, 0, -0.5), { range: 4, label: 'Breaker 4C' });
    h.step();

    expect(h.events.targetChanged).toHaveLength(2);
    expect(h.events.targetChanged[1]?.previous?.entity).toBe(first.entity);
    expect(h.events.targetChanged[1]?.target?.entity).toBe(second.entity);
  });

  it('reports the prompt clearing when the target is used up', () => {
    const h = harness();
    spawnInteractable(h.world, vec3(0, 0, -1.5), { repeatable: false });
    h.step();
    h.input.press();

    h.step();

    expect(h.events.targetChanged).toHaveLength(2);
    expect(h.events.targetChanged[1]?.target).toBeNull();
    expect(h.events.targetChanged[1]?.previous?.label).toBe('Valve 4B');
  });
});

describe('InteractionSystem accessibility assist', () => {
  it('extends reach when interaction assist is on', () => {
    const h = harness();
    const valve = spawnInteractable(h.world, vec3(0, 0, -2.4), { range: 2 });

    h.step();
    expect(h.system.target).toBeNull();

    h.system.setInteractionAssist(true);
    h.step();

    expect(h.system.target?.entity).toBe(valve.entity);
  });

  it('widens the selection cone when interaction assist is on', () => {
    const h = harness();
    const valve = spawnInteractable(h.world, offAxis(75, 2), { range: 3 });

    h.step();
    expect(h.system.target).toBeNull();

    h.system.setInteractionAssist(true);
    h.step();

    // Assist widens to nearly a hemisphere; it does not select behind her.
    expect(h.system.target?.entity).toBe(valve.entity);

    valve.transform.position = offAxis(110, 2);
    h.step();
    expect(h.system.target).toBeNull();
  });
});

describe('InteractionSystem configuration', () => {
  it('can be bound to a different activation action', () => {
    const h = harness({ action: 'toolAction' });
    spawnInteractable(h.world, vec3(0, 0, -1.5), { holdDuration: 0 });
    h.step();

    h.input.press('interact');
    h.step();
    // Gameplay reads named actions, so which one activates is configuration.
    expect(h.events.completed).toHaveLength(0);

    h.input.press('toolAction');
    h.step();

    expect(h.events.completed).toHaveLength(1);
  });

  it('measures range from a configured eye offset', () => {
    const h = harness({ eyeOffset: vec3(0, 0, 0) });
    const valve = spawnInteractable(h.world, vec3(0, 0, -1.5), { range: 3 });

    h.step();

    // Anchor is at 1.6 m, eye is now on the floor: 1.5 m out and 1.6 m up.
    expect(h.system.target?.entity).toBe(valve.entity);
    expect(h.system.target?.distance).toBeCloseTo(Math.hypot(1.5, EYE_HEIGHT));
  });

  it('stops emitting after dispose', () => {
    const h = harness();
    spawnInteractable(h.world, vec3(0, 0, -1.5), { holdDuration: 0 });
    h.step();
    expect(h.events.targetChanged).toHaveLength(1);

    h.system.dispose();
    h.input.press();
    h.step();

    expect(h.events.completed).toHaveLength(0);
    expect(h.events.targetChanged).toHaveLength(1);
  });
});
