/**
 * AudioEngine tests.
 *
 * jsdom has no Web Audio implementation at all — no AudioContext, no GainNode,
 * nothing. Rather than mocking AudioEngine (which would test nothing), this
 * file implements a small fake of the exact platform surface AudioEngine
 * declares and injects it through `createContext`. The fake records every
 * connect/disconnect/ramp/start/stop, so assertions are made against the real
 * graph the engine builds, not against a stub of the engine's own methods.
 *
 * The bits most likely to break silently, and therefore the bits with the
 * strictest assertions:
 *   - bus topology: a category wired straight to the destination would still
 *     make sound, but the master slider and night mode would not affect it
 *   - ramps vs direct `gain.value` writes: a direct write is audible as a
 *     click, and nothing in a functional test would notice
 *   - autoplay unlock: audio failing before the first gesture is an explicit
 *     project rejection condition
 *   - emitter budget: over-budget spatialisation is a mobile frame-rate cliff
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AudioEngine,
  perceptualGain,
  CATEGORY_BUSES,
  ALL_BUSES,
  type AudioBufferLike,
  type AudioBufferSourceNodeLike,
  type AudioContextLike,
  type AudioContextStateLike,
  type AudioListenerLike,
  type AudioNodeLike,
  type AudioParamLike,
  type DynamicsCompressorNodeLike,
  type EventTargetLike,
  type FetchLike,
  type GainNodeLike,
  type PannerNodeLike,
  type VisibilityTargetLike,
} from '../../src/engine/audio/AudioEngine';
import type { AudioSettings } from '../../src/persistence/settingsSchema';
import { SettingsStore } from '../../src/persistence/SettingsStore';

// ---------------------------------------------------------------------------
// Fake Web Audio
// ---------------------------------------------------------------------------

/**
 * Records how its value was changed.
 *
 * `directAssignments` only increments through the property setter, so a ramp
 * that writes the backing field is distinguishable from `param.value = x`.
 */
class FakeAudioParam implements AudioParamLike {
  private stored: number;
  directAssignments = 0;
  targetCalls: { value: number; startTime: number; timeConstant: number }[] = [];

  constructor(initial = 1) {
    this.stored = initial;
  }

  get value(): number {
    return this.stored;
  }

  set value(next: number) {
    this.directAssignments += 1;
    this.stored = next;
  }

  setTargetAtTime(target: number, startTime: number, timeConstant: number): void {
    this.targetCalls.push({ value: target, startTime, timeConstant });
    this.stored = target;
  }

  get lastTarget(): { value: number; startTime: number; timeConstant: number } | undefined {
    return this.targetCalls[this.targetCalls.length - 1];
  }
}

class FakeNode implements AudioNodeLike {
  /** Current outgoing edges. Cleared by `disconnect`. */
  readonly outputs: FakeNode[] = [];
  /** Every connect ever made, including ones later disconnected. */
  readonly connectHistory: FakeNode[] = [];
  disconnectCount = 0;

  constructor(readonly kind: string) {}

  connect(destination: AudioNodeLike): AudioNodeLike {
    const node = destination as FakeNode;
    this.outputs.push(node);
    this.connectHistory.push(node);
    return destination;
  }

  disconnect(): void {
    this.disconnectCount += 1;
    this.outputs.length = 0;
  }
}

class FakeGainNode extends FakeNode implements GainNodeLike {
  readonly gain = new FakeAudioParam(1);
  constructor() {
    super('gain');
  }
}

class FakePannerNode extends FakeNode implements PannerNodeLike {
  panningModel = 'equalpower';
  distanceModel = 'inverse';
  refDistance = 1;
  maxDistance = 10000;
  rolloffFactor = 1;
  readonly positionX = new FakeAudioParam(0);
  readonly positionY = new FakeAudioParam(0);
  readonly positionZ = new FakeAudioParam(0);
  constructor() {
    super('panner');
  }
}

class FakeBufferSource extends FakeNode implements AudioBufferSourceNodeLike {
  buffer: AudioBufferLike | null = null;
  loop = false;
  readonly playbackRate = new FakeAudioParam(1);
  onended: (() => void) | null = null;
  startCalls: (number | undefined)[] = [];
  stopCalls: (number | undefined)[] = [];

  constructor() {
    super('source');
  }

  start(when?: number): void {
    this.startCalls.push(when);
  }

  stop(when?: number): void {
    this.stopCalls.push(when);
  }

  /** Simulates the browser firing onended after the clip runs out. */
  finish(): void {
    this.onended?.();
  }
}

class FakeCompressor extends FakeNode implements DynamicsCompressorNodeLike {
  readonly threshold = new FakeAudioParam(-24);
  readonly knee = new FakeAudioParam(30);
  readonly ratio = new FakeAudioParam(12);
  readonly attack = new FakeAudioParam(0.003);
  readonly release = new FakeAudioParam(0.25);
  constructor() {
    super('compressor');
  }
}

/** Modern listener: nine AudioParams, no deprecated setters. */
class ModernFakeListener implements AudioListenerLike {
  readonly positionX = new FakeAudioParam(0);
  readonly positionY = new FakeAudioParam(0);
  readonly positionZ = new FakeAudioParam(0);
  readonly forwardX = new FakeAudioParam(0);
  readonly forwardY = new FakeAudioParam(0);
  readonly forwardZ = new FakeAudioParam(-1);
  readonly upX = new FakeAudioParam(0);
  readonly upY = new FakeAudioParam(1);
  readonly upZ = new FakeAudioParam(0);
}

/** Older WebKit: only the deprecated setters exist. */
class LegacyFakeListener implements AudioListenerLike {
  positionCalls: [number, number, number][] = [];
  orientationCalls: [number, number, number, number, number, number][] = [];

  setPosition(x: number, y: number, z: number): void {
    this.positionCalls.push([x, y, z]);
  }

  setOrientation(
    x: number,
    y: number,
    z: number,
    upX: number,
    upY: number,
    upZ: number,
  ): void {
    this.orientationCalls.push([x, y, z, upX, upY, upZ]);
  }
}

interface FakeContextOptions {
  state?: AudioContextStateLike;
  legacyListener?: boolean;
  /** Makes `resume()` reject, as a gesture-less resume does. */
  resumeRejects?: boolean;
  /** Makes `resume()` resolve without actually running (some webviews). */
  resumeStaysSuspended?: boolean;
  decodedDuration?: number;
  decodeRejects?: boolean;
}

class FakeAudioContext implements AudioContextLike {
  state: AudioContextStateLike;
  currentTime = 0;
  sampleRate = 48000;
  readonly destination = new FakeNode('destination');
  readonly listener: AudioListenerLike;

  readonly gains: FakeGainNode[] = [];
  readonly panners: FakePannerNode[] = [];
  readonly sources: FakeBufferSource[] = [];
  readonly compressors: FakeCompressor[] = [];

  resumeCalls = 0;
  suspendCalls = 0;
  closeCalls = 0;
  decodeCalls = 0;
  createBufferCalls = 0;

  constructor(private readonly options: FakeContextOptions = {}) {
    this.state = options.state ?? 'running';
    this.listener = options.legacyListener ? new LegacyFakeListener() : new ModernFakeListener();
  }

  createGain(): GainNodeLike {
    const node = new FakeGainNode();
    this.gains.push(node);
    return node;
  }

  createPanner(): PannerNodeLike {
    const node = new FakePannerNode();
    this.panners.push(node);
    return node;
  }

  createBufferSource(): AudioBufferSourceNodeLike {
    const node = new FakeBufferSource();
    this.sources.push(node);
    return node;
  }

  createDynamicsCompressor(): DynamicsCompressorNodeLike {
    const node = new FakeCompressor();
    this.compressors.push(node);
    return node;
  }

  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike {
    this.createBufferCalls += 1;
    return { duration: length / (sampleRate * Math.max(channels, 1)) };
  }

  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike> {
    this.decodeCalls += 1;
    if (this.options.decodeRejects) {
      return Promise.reject(new Error('EncodingError'));
    }
    // Length is only used to prove the decoded bytes reached us.
    const duration = this.options.decodedDuration ?? Math.max(data.byteLength / 1000, 0.1);
    return Promise.resolve({ duration });
  }

  resume(): Promise<void> {
    this.resumeCalls += 1;
    if (this.options.resumeRejects) {
      return Promise.reject(new DOMException('not allowed', 'NotAllowedError'));
    }
    if (!this.options.resumeStaysSuspended) this.state = 'running';
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    this.suspendCalls += 1;
    this.state = 'suspended';
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    this.state = 'closed';
    return Promise.resolve();
  }

  // -- helpers for assertions --------------------------------------------

  /** Master is the first gain the engine creates. */
  get masterBus(): FakeGainNode {
    const master = this.gains[0];
    if (!master) throw new Error('no gain nodes were created');
    return master;
  }

  /** Category buses in CATEGORY_BUSES order, created right after master. */
  get categoryBusNodes(): FakeGainNode[] {
    return this.gains.slice(1, 1 + CATEGORY_BUSES.length);
  }

  get modernListener(): ModernFakeListener {
    if (!(this.listener instanceof ModernFakeListener)) {
      throw new Error('context was built with the legacy listener');
    }
    return this.listener;
  }

  get legacyListenerNode(): LegacyFakeListener {
    if (!(this.listener instanceof LegacyFakeListener)) {
      throw new Error('context was built with the modern listener');
    }
    return this.listener;
  }
}

/** Records add/remove so listener self-removal can be asserted directly. */
class RecordingEventTarget implements EventTargetLike {
  readonly added: { type: string; listener: () => void }[] = [];
  readonly removed: { type: string; listener: () => void }[] = [];

  addEventListener(type: string, listener: () => void): void {
    this.added.push({ type, listener });
  }

  removeEventListener(type: string, listener: () => void): void {
    this.removed.push({ type, listener });
  }

  /** Fires every listener registered for a type. */
  fire(type: string): void {
    for (const entry of this.added) {
      if (entry.type !== type) continue;
      if (this.removed.some((r) => r.type === type && r.listener === entry.listener)) continue;
      entry.listener();
    }
  }

  get activeTypes(): string[] {
    return this.added
      .filter((a) => !this.removed.some((r) => r.type === a.type && r.listener === a.listener))
      .map((a) => a.type);
  }
}

class FakeVisibilityTarget implements VisibilityTargetLike {
  hidden = false;
  private listeners: (() => void)[] = [];
  removeCount = 0;

  addEventListener(_type: string, listener: () => void): void {
    this.listeners.push(listener);
  }

  removeEventListener(_type: string, listener: () => void): void {
    this.removeCount += 1;
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    for (const listener of [...this.listeners]) listener();
  }

  get listenerCount(): number {
    return this.listeners.length;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUDIO_DEFAULTS: AudioSettings = {
  master: 1,
  music: 1,
  ambience: 1,
  dialogue: 1,
  effects: 1,
  ui: 1,
  nightMode: false,
};

function audio(patch: Partial<AudioSettings> = {}): AudioSettings {
  return { ...AUDIO_DEFAULTS, ...patch };
}

/** Lets the microtask queue and one timer tick drain. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

interface CountingFetch {
  impl: FetchLike;
  calls: string[];
}

function countingFetch(options: { ok?: boolean; status?: number; rejects?: boolean } = {}): CountingFetch {
  const calls: string[] = [];
  const impl: FetchLike = (url: string) => {
    calls.push(url);
    if (options.rejects) return Promise.reject(new TypeError('NetworkError'));
    return Promise.resolve({
      ok: options.ok ?? true,
      status: options.status ?? 200,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(2048)),
    });
  };
  return { impl, calls };
}

interface Harness {
  ctx: FakeAudioContext;
  engine: AudioEngine;
  fetchCalls: string[];
}

function createEngine(
  options: {
    contextOptions?: FakeContextOptions;
    settings?: AudioSettings;
    emitterBudget?: number;
    gestureTarget?: EventTargetLike | null;
    visibilityTarget?: VisibilityTargetLike | null;
    suspendWhenHidden?: boolean;
    fetch?: CountingFetch;
  } = {},
): Harness {
  const ctx = new FakeAudioContext(options.contextOptions);
  const fetchImpl = options.fetch ?? countingFetch();
  const engine = new AudioEngine({
    createContext: () => ctx,
    initialAudio: options.settings ?? audio(),
    emitterBudget: options.emitterBudget,
    fetch: fetchImpl.impl,
    // Null by default so no test accidentally attaches to the shared jsdom
    // window and leaks a listener into the next test.
    gestureTarget: options.gestureTarget ?? null,
    visibilityTarget: options.visibilityTarget ?? null,
    suspendWhenHidden: options.suspendWhenHidden,
  });
  return { ctx, engine, fetchCalls: fetchImpl.calls };
}

async function loadClip(engine: AudioEngine, id: string): Promise<void> {
  const buffer = await engine.load(id, `/assets/audio/${id}.ogg`);
  expect(buffer).not.toBeNull();
}

// ---------------------------------------------------------------------------

describe('AudioEngine', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Failure paths are expected to log. Captured so the suite output stays
    // readable, and asserted on where the log *is* the required behaviour.
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  // -- bus graph ---------------------------------------------------------

  describe('bus graph', () => {
    it('routes every category bus into master and master into the destination', () => {
      const { ctx } = createEngine();

      // 1 master + 5 categories, and nothing else at construction.
      expect(ctx.gains).toHaveLength(1 + CATEGORY_BUSES.length);

      const master = ctx.masterBus;
      for (const bus of ctx.categoryBusNodes) {
        expect(bus.outputs).toEqual([master]);
      }
      expect(master.outputs).toEqual([ctx.destination]);
    });

    it('never connects a category bus straight to the destination', () => {
      const { ctx } = createEngine();

      for (const bus of ctx.categoryBusNodes) {
        // A direct edge here would bypass the master slider and night mode.
        expect(bus.connectHistory).not.toContain(ctx.destination);
      }
      expect(ctx.destination.outputs).toHaveLength(0);
    });

    it('maps each category bus to its own settings value', () => {
      // Distinct values per category pin the creation-order mapping: a swapped
      // pair would leave the topology valid but the sliders crossed.
      const { ctx, engine } = createEngine({
        settings: audio({
          master: 0.9,
          music: 0.1,
          ambience: 0.2,
          dialogue: 0.3,
          effects: 0.4,
          ui: 0.5,
        }),
      });

      const expected = [0.1, 0.2, 0.3, 0.4, 0.5];
      ctx.categoryBusNodes.forEach((node, index) => {
        expect(node.gain.value).toBeCloseTo(perceptualGain(expected[index]!), 10);
      });
      expect(ctx.masterBus.gain.value).toBeCloseTo(perceptualGain(0.9), 10);

      CATEGORY_BUSES.forEach((name, index) => {
        expect(engine.busGain(name)).toBeCloseTo(perceptualGain(expected[index]!), 10);
      });
      expect(engine.busGain('master')).toBeCloseTo(perceptualGain(0.9), 10);
      expect(ALL_BUSES).toHaveLength(6);
    });
  });

  // -- volume curve ------------------------------------------------------

  describe('volume curve', () => {
    it('maps the midpoint well below half gain', () => {
      // A linear slider is the bug this curve exists to fix: 0.5 linear is
      // -6dB and barely sounds quieter. Squared gives -12dB.
      expect(perceptualGain(0.5)).toBeCloseTo(0.25, 10);
      expect(perceptualGain(0.25)).toBeCloseTo(0.0625, 10);
    });

    it('keeps the endpoints exact', () => {
      expect(perceptualGain(0)).toBe(0);
      expect(perceptualGain(1)).toBe(1);
    });

    it('clamps out-of-range and non-finite input', () => {
      expect(perceptualGain(-0.5)).toBe(0);
      expect(perceptualGain(2)).toBe(1);
      expect(perceptualGain(Number.NaN)).toBe(0);
      expect(perceptualGain(Number.POSITIVE_INFINITY)).toBe(1);
      expect(perceptualGain(Number.NEGATIVE_INFINITY)).toBe(0);
    });

    it('applies the curve to bus gains rather than the raw slider value', () => {
      const { ctx } = createEngine({ settings: audio({ music: 0.5 }) });
      const music = ctx.categoryBusNodes[0]!;

      expect(music.gain.value).toBeCloseTo(0.25, 10);
      expect(music.gain.value).not.toBeCloseTo(0.5, 3);
    });
  });

  // -- ramps -------------------------------------------------------------

  describe('gain changes', () => {
    it('ramps instead of assigning gain.value when a volume changes', () => {
      const { ctx, engine } = createEngine({ settings: audio({ music: 1 }) });
      const music = ctx.categoryBusNodes[0]!;

      // Construction writes the initial level directly, once, by design: the
      // graph is silent and ramping from the node default would slide.
      expect(music.gain.directAssignments).toBe(1);
      expect(music.gain.targetCalls).toHaveLength(0);

      engine.applyAudioSettings(audio({ music: 0.5 }));

      expect(music.gain.directAssignments).toBe(1); // unchanged: no click
      expect(music.gain.targetCalls).toHaveLength(1);
      expect(music.gain.lastTarget?.value).toBeCloseTo(0.25, 10);
      expect(music.gain.lastTarget?.timeConstant).toBeGreaterThan(0);
    });

    it('ramps every bus on a settings change, including master', () => {
      const { ctx, engine } = createEngine();

      engine.applyAudioSettings(audio({ master: 0.4, music: 0.4, ui: 0.4 }));

      expect(ctx.masterBus.gain.targetCalls).toHaveLength(1);
      expect(ctx.masterBus.gain.lastTarget?.value).toBeCloseTo(0.16, 10);
      for (const bus of ctx.categoryBusNodes) {
        expect(bus.gain.targetCalls).toHaveLength(1);
      }
    });

    it('ramps a single bus through setBusVolume', () => {
      const { ctx, engine } = createEngine();
      const dialogue = ctx.categoryBusNodes[CATEGORY_BUSES.indexOf('dialogue')]!;

      engine.setBusVolume('dialogue', 0.6);

      expect(dialogue.gain.lastTarget?.value).toBeCloseTo(0.36, 10);
      expect(dialogue.gain.directAssignments).toBe(1);
      expect(engine.busGain('dialogue')).toBeCloseTo(0.36, 10);
    });

    it('follows a live SettingsStore change', () => {
      window.localStorage.clear();
      const store = new SettingsStore();
      const ctx = new FakeAudioContext();
      const engine = new AudioEngine({
        createContext: () => ctx,
        settings: store,
        gestureTarget: null,
        visibilityTarget: null,
      });

      // Seeded from the store, not from defaults.
      expect(engine.busGain('master')).toBeCloseTo(
        perceptualGain(store.current.audio.master),
        10,
      );

      store.update('audio', { music: 0.2 });

      expect(engine.busGain('music')).toBeCloseTo(0.04, 10);
      const music = ctx.categoryBusNodes[0]!;
      expect(music.gain.lastTarget?.value).toBeCloseTo(0.04, 10);

      engine.dispose();
      window.localStorage.clear();
    });

    it('stops following settings after dispose', () => {
      window.localStorage.clear();
      const store = new SettingsStore();
      const ctx = new FakeAudioContext();
      const engine = new AudioEngine({
        createContext: () => ctx,
        settings: store,
        gestureTarget: null,
        visibilityTarget: null,
      });

      engine.dispose();
      store.update('audio', { music: 0.1 });

      // Unsubscribed: the disposed engine must not touch a closed context.
      expect(engine.busGain('music')).not.toBeCloseTo(0.01, 5);
      window.localStorage.clear();
    });
  });

  // -- autoplay unlock ---------------------------------------------------

  describe('autoplay unlock', () => {
    it('starts locked when the context is suspended', () => {
      const { engine } = createEngine({ contextOptions: { state: 'suspended' } });

      expect(engine.state).toBe('suspended');
      expect(engine.isUnlocked).toBe(false);
    });

    it('resumes a suspended context on unlock()', async () => {
      const { ctx, engine } = createEngine({ contextOptions: { state: 'suspended' } });

      const unlocked = await engine.unlock();

      expect(unlocked).toBe(true);
      expect(ctx.resumeCalls).toBe(1);
      expect(ctx.state).toBe('running');
      expect(engine.isUnlocked).toBe(true);
    });

    it('starts a silent priming source inside the unlock', async () => {
      const { ctx, engine } = createEngine({ contextOptions: { state: 'suspended' } });

      await engine.unlock();

      // Some WebKit builds only release the hardware once a source has run.
      expect(ctx.createBufferCalls).toBe(1);
      expect(ctx.sources).toHaveLength(1);
      expect(ctx.sources[0]!.startCalls).toEqual([0]);
    });

    it('reports already-running contexts as unlocked without resuming', async () => {
      const { ctx, engine } = createEngine({ contextOptions: { state: 'running' } });

      expect(engine.isUnlocked).toBe(true);
      await expect(engine.unlock()).resolves.toBe(true);
      expect(ctx.resumeCalls).toBe(0);
    });

    it('never throws when resume() is rejected outside a gesture', async () => {
      const { ctx, engine } = createEngine({
        contextOptions: { state: 'suspended', resumeRejects: true },
      });

      await expect(engine.unlock()).resolves.toBe(false);
      expect(engine.isUnlocked).toBe(false);
      expect(ctx.state).toBe('suspended');
      // The failure is reported, not swallowed.
      expect(warn).toHaveBeenCalled();
    });

    it('stays locked when resume() resolves without running', async () => {
      const { engine } = createEngine({
        contextOptions: { state: 'suspended', resumeStaysSuspended: true },
      });

      await expect(engine.unlock()).resolves.toBe(false);
      expect(engine.isUnlocked).toBe(false);
      expect(warn).toHaveBeenCalled();
    });

    it('registers pointerdown, keydown and touchstart while suspended', () => {
      const target = new RecordingEventTarget();
      createEngine({ contextOptions: { state: 'suspended' }, gestureTarget: target });

      expect(target.activeTypes.sort()).toEqual(['keydown', 'pointerdown', 'touchstart']);
    });

    it('registers no gesture listeners when the context is already running', () => {
      const target = new RecordingEventTarget();
      createEngine({ contextOptions: { state: 'running' }, gestureTarget: target });

      expect(target.added).toHaveLength(0);
    });

    it('unlocks from a gesture and removes all three listeners', async () => {
      const target = new RecordingEventTarget();
      const { ctx, engine } = createEngine({
        contextOptions: { state: 'suspended' },
        gestureTarget: target,
      });

      target.fire('pointerdown');
      await flush();

      expect(ctx.resumeCalls).toBe(1);
      expect(engine.isUnlocked).toBe(true);
      // Self-removing: all three, by the same reference that was added.
      expect(target.activeTypes).toHaveLength(0);
      expect(target.removed.map((r) => r.type).sort()).toEqual([
        'keydown',
        'pointerdown',
        'touchstart',
      ]);

      target.fire('pointerdown');
      await flush();
      expect(ctx.resumeCalls).toBe(1);
    });

    it('unlocks from a real synthetic pointerdown on window', async () => {
      const ctx = new FakeAudioContext({ state: 'suspended' });
      const engine = new AudioEngine({
        createContext: () => ctx,
        initialAudio: audio(),
        gestureTarget: window as unknown as EventTargetLike,
        visibilityTarget: null,
      });

      expect(engine.isUnlocked).toBe(false);

      window.dispatchEvent(new Event('pointerdown'));
      await flush();

      expect(engine.isUnlocked).toBe(true);
      expect(ctx.resumeCalls).toBe(1);

      // Listeners really are off window, not just short-circuited internally.
      window.dispatchEvent(new Event('keydown'));
      await flush();
      expect(ctx.resumeCalls).toBe(1);

      engine.dispose();
    });

    it('keeps listening after a rejected gesture attempt', async () => {
      const target = new RecordingEventTarget();
      const { engine } = createEngine({
        contextOptions: { state: 'suspended', resumeRejects: true },
        gestureTarget: target,
      });

      target.fire('pointerdown');
      await flush();

      expect(engine.isUnlocked).toBe(false);
      // The next real gesture must get another chance.
      expect(target.activeTypes.sort()).toEqual(['keydown', 'pointerdown', 'touchstart']);
    });

    it('emits unlocked once', async () => {
      const { engine } = createEngine({ contextOptions: { state: 'suspended' } });
      const events: string[] = [];
      engine.on('unlocked', ({ via }) => events.push(via));

      await engine.unlock();
      await engine.unlock();

      expect(events).toEqual(['explicit']);
    });
  });

  // -- backgrounding -----------------------------------------------------

  describe('tab visibility', () => {
    it('suspends when hidden and resumes when visible again', async () => {
      const visibility = new FakeVisibilityTarget();
      const { ctx, engine } = createEngine({
        contextOptions: { state: 'suspended' },
        visibilityTarget: visibility,
      });
      await engine.unlock();
      expect(ctx.state).toBe('running');

      visibility.setHidden(true);
      await flush();
      expect(ctx.suspendCalls).toBe(1);
      expect(ctx.state).toBe('suspended');

      visibility.setHidden(false);
      await flush();
      expect(ctx.state).toBe('running');
      expect(ctx.resumeCalls).toBe(2); // unlock + return from background
    });

    it('does not resume a context that was never unlocked', async () => {
      const visibility = new FakeVisibilityTarget();
      const { ctx } = createEngine({
        contextOptions: { state: 'suspended' },
        visibilityTarget: visibility,
      });

      visibility.setHidden(true);
      visibility.setHidden(false);
      await flush();

      // Resuming without a gesture would be rejected by the browser.
      expect(ctx.resumeCalls).toBe(0);
      expect(ctx.state).toBe('suspended');
    });

    it('honours suspendWhenHidden=false', async () => {
      const visibility = new FakeVisibilityTarget();
      const { ctx, engine } = createEngine({
        contextOptions: { state: 'suspended' },
        visibilityTarget: visibility,
        suspendWhenHidden: false,
      });
      await engine.unlock();

      visibility.setHidden(true);
      await flush();

      expect(ctx.suspendCalls).toBe(0);
      expect(ctx.state).toBe('running');
    });
  });

  // -- buffer cache ------------------------------------------------------

  describe('buffer cache', () => {
    it('fetches and decodes once for two concurrent loads of the same id', async () => {
      const fetcher = countingFetch();
      const { ctx, engine } = createEngine({ fetch: fetcher });

      const a = engine.load('pump-hum', '/assets/audio/pump-hum.ogg');
      const b = engine.load('pump-hum', '/assets/audio/pump-hum.ogg');

      // Same in-flight promise, not two racing requests.
      expect(a).toBe(b);
      expect(engine.diagnostics().pendingLoads).toBe(1);

      const [first, second] = await Promise.all([a, b]);

      expect(fetcher.calls).toEqual(['/assets/audio/pump-hum.ogg']);
      expect(ctx.decodeCalls).toBe(1);
      expect(first).toBe(second);
      expect(engine.diagnostics().loadedBuffers).toBe(1);
      expect(engine.diagnostics().pendingLoads).toBe(0);
    });

    it('serves a cached buffer without re-fetching', async () => {
      const fetcher = countingFetch();
      const { ctx, engine } = createEngine({ fetch: fetcher });

      await engine.load('drip', '/assets/audio/drip.ogg');
      await engine.load('drip', '/assets/audio/drip.ogg');

      expect(fetcher.calls).toHaveLength(1);
      expect(ctx.decodeCalls).toBe(1);
      expect(engine.has('drip')).toBe(true);
    });

    it('still fetches distinct ids separately', async () => {
      const fetcher = countingFetch();
      const { engine } = createEngine({ fetch: fetcher });

      await Promise.all([
        engine.load('a', '/assets/audio/a.ogg'),
        engine.load('b', '/assets/audio/b.ogg'),
      ]);

      expect(fetcher.calls).toHaveLength(2);
      expect(engine.diagnostics().loadedBuffers).toBe(2);
    });

    it('returns null and reports a network failure without throwing', async () => {
      const fetcher = countingFetch({ rejects: true });
      const { engine } = createEngine({ fetch: fetcher });
      const failures: string[] = [];
      engine.on('loadFailed', ({ clipId, reason }) => failures.push(`${clipId}:${reason}`));

      await expect(engine.load('gone', '/assets/audio/gone.ogg')).resolves.toBeNull();

      expect(failures).toEqual(['gone:NetworkError']);
      expect(warn).toHaveBeenCalled();
      expect(engine.diagnostics().failedLoads).toBe(1);
      expect(engine.diagnostics().pendingLoads).toBe(0);
      expect(engine.has('gone')).toBe(false);
    });

    it('treats a non-ok response as a failure', async () => {
      const fetcher = countingFetch({ ok: false, status: 404 });
      const { engine } = createEngine({ fetch: fetcher });
      const reasons: string[] = [];
      engine.on('loadFailed', ({ reason }) => reasons.push(reason));

      await expect(engine.load('missing', '/assets/audio/missing.ogg')).resolves.toBeNull();

      expect(reasons).toEqual(['HTTP 404']);
    });

    it('treats an undecodable file as a failure', async () => {
      const { engine } = createEngine({ contextOptions: { decodeRejects: true } });

      await expect(engine.load('corrupt', '/assets/audio/corrupt.ogg')).resolves.toBeNull();
      expect(engine.diagnostics().failedLoads).toBe(1);
    });

    it('retries after a failure because the failed load is not cached', async () => {
      const calls: string[] = [];
      let shouldFail = true;
      const impl: FetchLike = (url: string) => {
        calls.push(url);
        if (shouldFail) return Promise.reject(new Error('offline'));
        return Promise.resolve({
          ok: true,
          status: 200,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(512)),
        });
      };
      const ctx = new FakeAudioContext();
      const engine = new AudioEngine({
        createContext: () => ctx,
        initialAudio: audio(),
        fetch: impl,
        gestureTarget: null,
        visibilityTarget: null,
      });

      await engine.load('later', '/assets/audio/later.ogg');
      shouldFail = false;
      await engine.load('later', '/assets/audio/later.ogg');

      expect(calls).toHaveLength(2);
      expect(engine.has('later')).toBe(true);
      expect(engine.diagnostics().failedLoads).toBe(0);
    });

    it('unload drops a decoded buffer', async () => {
      const { engine } = createEngine();
      await loadClip(engine, 'thump');

      engine.unload('thump');

      expect(engine.has('thump')).toBe(false);
      expect(engine.diagnostics().loadedBuffers).toBe(0);
    });
  });

  // -- playback ----------------------------------------------------------

  describe('playback', () => {
    it('routes a one-shot through its own gain into the requested bus', async () => {
      const { ctx, engine } = createEngine();
      await loadClip(engine, 'click');

      const handle = engine.playOneShot('click', { bus: 'ui', volume: 0.5 });

      expect(handle).not.toBeNull();
      const source = ctx.sources.at(-1)!;
      const voiceGain = ctx.gains.at(-1)!;
      const uiBus = ctx.categoryBusNodes[CATEGORY_BUSES.indexOf('ui')]!;

      expect(source.outputs).toEqual([voiceGain]);
      expect(voiceGain.outputs).toEqual([uiBus]);
      expect(voiceGain.gain.value).toBeCloseTo(0.25, 10);
      expect(source.loop).toBe(false);
      expect(source.startCalls).toHaveLength(1);
    });

    it('defaults to the effects bus', async () => {
      const { ctx, engine } = createEngine();
      await loadClip(engine, 'clang');

      engine.playOneShot('clang');

      const effectsBus = ctx.categoryBusNodes[CATEGORY_BUSES.indexOf('effects')]!;
      expect(ctx.gains.at(-1)!.outputs).toEqual([effectsBus]);
    });

    it('applies playback rate and exposes clip duration', async () => {
      const ctx = new FakeAudioContext({ decodedDuration: 3.5 });
      const engine = new AudioEngine({
        createContext: () => ctx,
        initialAudio: audio(),
        fetch: countingFetch().impl,
        gestureTarget: null,
        visibilityTarget: null,
      });
      await loadClip(engine, 'line-01');

      const handle = engine.playOneShot('line-01', { bus: 'dialogue', rate: 1.25 });

      expect(handle?.duration).toBeCloseTo(3.5, 10);
      expect(ctx.sources.at(-1)!.playbackRate.value).toBeCloseTo(1.25, 10);
    });

    it('loops and can be stopped through the handle', async () => {
      const { ctx, engine } = createEngine();
      await loadClip(engine, 'rain');

      const handle = engine.playLoop('rain', { bus: 'ambience' })!;
      const source = ctx.sources.at(-1)!;
      const voiceGain = ctx.gains.at(-1)!;

      expect(source.loop).toBe(true);
      expect(engine.diagnostics().activeVoices).toBe(1);

      handle.stop();

      expect(handle.stopped).toBe(true);
      expect(source.stopCalls).toHaveLength(1);
      expect(voiceGain.disconnectCount).toBe(1);
      expect(engine.diagnostics().activeVoices).toBe(0);
    });

    it('fades out rather than cutting when asked', async () => {
      const { ctx, engine } = createEngine();
      await loadClip(engine, 'siren');
      ctx.currentTime = 10;

      const handle = engine.playLoop('siren')!;
      const source = ctx.sources.at(-1)!;
      const voiceGain = ctx.gains.at(-1)!;

      handle.stop(0.5);

      expect(voiceGain.gain.lastTarget?.value).toBe(0);
      // Stop is scheduled at the end of the fade, not immediately.
      expect(source.stopCalls).toEqual([10.5]);
    });

    it('ramps a live voice volume change', async () => {
      const { ctx, engine } = createEngine();
      await loadClip(engine, 'hum');
      const handle = engine.playLoop('hum')!;
      const voiceGain = ctx.gains.at(-1)!;
      const before = voiceGain.gain.directAssignments;

      handle.setVolume(0.5);

      expect(voiceGain.gain.directAssignments).toBe(before);
      expect(voiceGain.gain.lastTarget?.value).toBeCloseTo(0.25, 10);
    });

    it('fades in from silence when asked', async () => {
      const { ctx, engine } = createEngine();
      await loadClip(engine, 'swell');

      engine.playOneShot('swell', { fadeIn: 0.6 });

      const voiceGain = ctx.gains.at(-1)!;
      expect(voiceGain.gain.targetCalls[0]?.value).toBeCloseTo(1, 10);
    });

    it('releases a voice when the browser reports it ended', async () => {
      const { ctx, engine } = createEngine();
      await loadClip(engine, 'thud');

      engine.playOneShot('thud');
      expect(engine.diagnostics().activeVoices).toBe(1);

      ctx.sources.at(-1)!.finish();

      expect(engine.diagnostics().activeVoices).toBe(0);
    });

    it('returns null for a clip that is not loaded, and warns', () => {
      const { ctx, engine } = createEngine();

      expect(engine.playOneShot('never-loaded')).toBeNull();
      expect(warn).toHaveBeenCalled();
      expect(ctx.sources).toHaveLength(0);
    });

    it('stopAll clears voices and emitters', async () => {
      const { engine } = createEngine();
      await loadClip(engine, 'a');
      engine.playLoop('a');
      engine.playLoop('a');
      const emitterHandle = engine.createEmitter({ clipId: 'a', position: { x: 0, y: 0, z: 0 } });

      engine.stopAll();

      const diag = engine.diagnostics();
      expect(diag.activeVoices).toBe(0);
      expect(diag.activeEmitters).toBe(0);
      expect(emitterHandle.alive).toBe(false);
    });
  });

  // -- positional audio --------------------------------------------------

  describe('positional emitters', () => {
    it('builds source -> gain -> panner -> bus with an inverse distance model', async () => {
      const { ctx, engine } = createEngine();
      await loadClip(engine, 'pump');

      engine.createEmitter({
        clipId: 'pump',
        bus: 'effects',
        position: { x: 3, y: 1, z: -4 },
        refDistance: 2.5,
        maxDistance: 30,
      });

      const panner = ctx.panners.at(-1)!;
      const source = ctx.sources.at(-1)!;
      const voiceGain = ctx.gains.at(-1)!;
      const effectsBus = ctx.categoryBusNodes[CATEGORY_BUSES.indexOf('effects')]!;

      expect(source.outputs).toEqual([voiceGain]);
      expect(voiceGain.outputs).toEqual([panner]);
      expect(panner.outputs).toEqual([effectsBus]);
      expect(panner.distanceModel).toBe('inverse');
      expect(panner.refDistance).toBeCloseTo(2.5, 10);
      expect(panner.maxDistance).toBeCloseTo(30, 10);
      expect(panner.positionX.value).toBeCloseTo(3, 10);
      expect(panner.positionY.value).toBeCloseTo(1, 10);
      expect(panner.positionZ.value).toBeCloseTo(-4, 10);
      expect(source.loop).toBe(true);
    });

    it('ramps a moved emitter instead of snapping it', async () => {
      const { ctx, engine } = createEngine();
      await loadClip(engine, 'pump');
      const handle = engine.createEmitter({ clipId: 'pump', position: { x: 0, y: 0, z: 0 } });
      const panner = ctx.panners.at(-1)!;
      const directBefore = panner.positionX.directAssignments;

      handle.setPosition({ x: 5, y: 0, z: 0 });

      expect(panner.positionX.directAssignments).toBe(directBefore);
      expect(panner.positionX.lastTarget?.value).toBeCloseTo(5, 10);
    });

    it('returns an inert handle for an unloaded clip instead of throwing', () => {
      const { ctx, engine } = createEngine();

      const handle = engine.createEmitter({ clipId: 'nope', position: { x: 0, y: 0, z: 0 } });

      expect(handle.alive).toBe(false);
      expect(() => {
        handle.setPosition({ x: 1, y: 1, z: 1 });
        handle.setVolume(0.5);
        handle.stop();
      }).not.toThrow();
      expect(ctx.panners).toHaveLength(0);
      expect(warn).toHaveBeenCalled();
    });

    it('tears down nodes when stopped', async () => {
      const { ctx, engine } = createEngine();
      await loadClip(engine, 'pump');
      const handle = engine.createEmitter({ clipId: 'pump', position: { x: 0, y: 0, z: 0 } });
      const panner = ctx.panners.at(-1)!;
      const source = ctx.sources.at(-1)!;

      handle.stop();

      expect(handle.alive).toBe(false);
      expect(source.stopCalls).toHaveLength(1);
      expect(panner.disconnectCount).toBe(1);
      expect(engine.diagnostics().activeEmitters).toBe(0);
    });
  });

  // -- emitter budget ----------------------------------------------------

  describe('emitter budget', () => {
    async function budgetHarness(budget: number): Promise<Harness> {
      const harness = createEngine({ emitterBudget: budget });
      await loadClip(harness.engine, 'pump');
      return harness;
    }

    it('never exceeds the budget', async () => {
      const { ctx, engine } = await budgetHarness(2);

      const handles = [1, 2, 50, 60].map((x) =>
        engine.createEmitter({ clipId: 'pump', position: { x, y: 0, z: 0 } }),
      );
      engine.updateListener({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 });

      const diag = engine.diagnostics();
      expect(diag.activeEmitters).toBe(2);
      expect(diag.culledEmitters).toBe(2);
      // Only the surviving emitters ever got a panner.
      expect(ctx.panners.filter((p) => p.outputs.length > 0)).toHaveLength(2);

      expect(handles.map((h) => h.culled)).toEqual([false, false, true, true]);
    });

    it('culls by distance, keeping the nearest', async () => {
      const { engine } = await budgetHarness(2);

      const near = engine.createEmitter({ clipId: 'pump', position: { x: 1, y: 0, z: 0 } });
      const mid = engine.createEmitter({ clipId: 'pump', position: { x: 8, y: 0, z: 0 } });
      const far = engine.createEmitter({ clipId: 'pump', position: { x: 90, y: 0, z: 0 } });

      engine.updateListener({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 });

      expect(near.culled).toBe(false);
      expect(mid.culled).toBe(false);
      expect(far.culled).toBe(true);
    });

    it('swaps audible emitters when the listener moves', async () => {
      const { engine } = await budgetHarness(2);

      const a = engine.createEmitter({ clipId: 'pump', position: { x: 1, y: 0, z: 0 } });
      const b = engine.createEmitter({ clipId: 'pump', position: { x: 2, y: 0, z: 0 } });
      const c = engine.createEmitter({ clipId: 'pump', position: { x: 50, y: 0, z: 0 } });
      const d = engine.createEmitter({ clipId: 'pump', position: { x: 60, y: 0, z: 0 } });

      engine.updateListener({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 });
      expect([a.culled, b.culled, c.culled, d.culled]).toEqual([false, false, true, true]);

      engine.updateListener({ x: 60, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 });

      expect([a.culled, b.culled, c.culled, d.culled]).toEqual([true, true, false, false]);
      expect(engine.diagnostics().activeEmitters).toBe(2);
    });

    it('does not thrash on a small listener wobble', async () => {
      const { ctx, engine } = await budgetHarness(1);

      const inside = engine.createEmitter({ clipId: 'pump', position: { x: 10, y: 0, z: 0 } });
      const outside = engine.createEmitter({ clipId: 'pump', position: { x: -10.5, y: 0, z: 0 } });
      engine.updateListener({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 });
      expect(inside.culled).toBe(false);
      const pannersAfterFirst = ctx.panners.length;

      // Sways so the other emitter is now marginally nearer. Stickiness must
      // keep the audible one audible rather than restarting both loops.
      engine.updateListener({ x: -0.4, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 });

      expect(inside.culled).toBe(false);
      expect(outside.culled).toBe(true);
      expect(ctx.panners).toHaveLength(pannersAfterFirst);
    });

    it('lets priority beat distance', async () => {
      const { engine } = await budgetHarness(1);

      const nearIncidental = engine.createEmitter({
        clipId: 'pump',
        position: { x: 1, y: 0, z: 0 },
        priority: 0,
      });
      const farImportant = engine.createEmitter({
        clipId: 'pump',
        position: { x: 80, y: 0, z: 0 },
        priority: 5,
      });

      engine.updateListener({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 });

      expect(farImportant.culled).toBe(false);
      expect(nearIncidental.culled).toBe(true);
    });

    it('revives culled loops when the budget grows', async () => {
      const { engine } = await budgetHarness(1);

      const a = engine.createEmitter({ clipId: 'pump', position: { x: 1, y: 0, z: 0 } });
      const b = engine.createEmitter({ clipId: 'pump', position: { x: 40, y: 0, z: 0 } });
      expect(b.culled).toBe(true);

      engine.setEmitterBudget(4);

      expect(a.culled).toBe(false);
      expect(b.culled).toBe(false);
      expect(engine.budget).toBe(4);
      expect(engine.diagnostics().activeEmitters).toBe(2);
    });

    it('revives a culled loop when an audible emitter is stopped', async () => {
      const { engine } = await budgetHarness(1);

      const a = engine.createEmitter({ clipId: 'pump', position: { x: 1, y: 0, z: 0 } });
      const b = engine.createEmitter({ clipId: 'pump', position: { x: 40, y: 0, z: 0 } });
      expect(b.culled).toBe(true);

      a.stop();

      expect(b.culled).toBe(false);
      expect(engine.diagnostics().activeEmitters).toBe(1);
    });

    it('destroys a culled one-shot instead of restarting it later', async () => {
      const { engine } = await budgetHarness(1);

      const oneShot = engine.createEmitter({
        clipId: 'pump',
        position: { x: 30, y: 0, z: 0 },
        loop: false,
      });
      expect(oneShot.alive).toBe(true);

      // Higher priority arrives and takes the only slot.
      engine.createEmitter({
        clipId: 'pump',
        position: { x: 1, y: 0, z: 0 },
        priority: 9,
      });

      // Reviving it later would replay the whole clip at the wrong moment.
      expect(oneShot.alive).toBe(false);
      expect(engine.diagnostics().culledEmitters).toBe(0);
      expect(engine.diagnostics().activeEmitters).toBe(1);
    });

    it('a budget of zero silences everything', async () => {
      const { engine } = await budgetHarness(2);
      const handle = engine.createEmitter({ clipId: 'pump', position: { x: 1, y: 0, z: 0 } });

      engine.setEmitterBudget(0);

      expect(handle.culled).toBe(true);
      expect(engine.diagnostics().activeEmitters).toBe(0);
    });

    it('ignores a non-finite budget rather than disabling audio', async () => {
      const { engine } = await budgetHarness(3);

      engine.setEmitterBudget(Number.NaN);

      expect(engine.budget).toBe(3);
    });
  });

  // -- listener ----------------------------------------------------------

  describe('listener', () => {
    it('uses the modern AudioParam interface and normalises the basis', async () => {
      const { ctx, engine } = createEngine();
      await loadClip(engine, 'pump');

      engine.updateListener(
        { x: 2, y: 1.6, z: -3 },
        { x: 0, y: 0, z: -4 },
        { x: 0, y: 9, z: 0 },
      );

      const listener = ctx.modernListener;
      expect(listener.positionX.lastTarget?.value).toBeCloseTo(2, 10);
      expect(listener.positionY.lastTarget?.value).toBeCloseTo(1.6, 10);
      expect(listener.positionZ.lastTarget?.value).toBeCloseTo(-3, 10);
      // Unit length, not the raw magnitudes handed in.
      expect(listener.forwardZ.lastTarget?.value).toBeCloseTo(-1, 10);
      expect(listener.upY.lastTarget?.value).toBeCloseTo(1, 10);
      // Ramped, never assigned.
      expect(listener.positionX.directAssignments).toBe(0);
    });

    it('falls back to the deprecated setters when AudioParams are absent', () => {
      const { ctx, engine } = createEngine({ contextOptions: { legacyListener: true } });

      engine.updateListener(
        { x: 5, y: 0, z: 1 },
        { x: 0, y: 0, z: -2 },
        { x: 0, y: 3, z: 0 },
      );

      const listener = ctx.legacyListenerNode;
      expect(listener.positionCalls).toEqual([[5, 0, 1]]);
      expect(listener.orientationCalls).toEqual([[0, 0, -1, 0, 1, 0]]);
    });

    it('falls back for panner positions too', async () => {
      // A panner without positionX is the same browser generation as a
      // listener without positionX, so the emitter path needs the fallback.
      const ctx = new FakeAudioContext();
      const legacyPanners: FakeNode[] = [];
      const patched: AudioContextLike = Object.assign(Object.create(ctx) as FakeAudioContext, {
        createPanner: (): PannerNodeLike => {
          const node = new FakeNode('legacy-panner') as FakeNode & {
            panningModel: string;
            distanceModel: string;
            refDistance: number;
            maxDistance: number;
            rolloffFactor: number;
            calls: [number, number, number][];
            setPosition(x: number, y: number, z: number): void;
          };
          node.panningModel = '';
          node.distanceModel = '';
          node.refDistance = 1;
          node.maxDistance = 1;
          node.rolloffFactor = 1;
          node.calls = [];
          node.setPosition = (x, y, z) => {
            node.calls.push([x, y, z]);
          };
          legacyPanners.push(node);
          return node as unknown as PannerNodeLike;
        },
      });

      const engine = new AudioEngine({
        createContext: () => patched,
        initialAudio: audio(),
        fetch: countingFetch().impl,
        gestureTarget: null,
        visibilityTarget: null,
      });
      await loadClip(engine, 'pump');

      engine.createEmitter({ clipId: 'pump', position: { x: 7, y: 2, z: -1 } });

      const panner = legacyPanners[0] as unknown as { calls: [number, number, number][] };
      expect(panner.calls).toEqual([[7, 2, -1]]);
    });

    it('substitutes a sane basis for degenerate vectors', () => {
      const { ctx, engine } = createEngine();

      engine.updateListener(
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
      );

      // A zero-length forward would make the panner produce NaN.
      expect(ctx.modernListener.forwardZ.lastTarget?.value).toBeCloseTo(-1, 10);
      expect(ctx.modernListener.upY.lastTarget?.value).toBeCloseTo(1, 10);
    });
  });

  // -- night mode --------------------------------------------------------

  describe('night mode', () => {
    it('inserts a compressor between master and the destination', () => {
      const { ctx, engine } = createEngine();
      const master = ctx.masterBus;

      engine.setNightMode(true);

      expect(ctx.compressors).toHaveLength(1);
      const comp = ctx.compressors[0]!;
      expect(master.disconnectCount).toBe(1);
      expect(master.outputs).toEqual([comp]);
      expect(comp.outputs).toEqual([ctx.destination]);
      expect(engine.nightMode).toBe(true);
      // Actually compressing, not a pass-through.
      expect(comp.ratio.value).toBeGreaterThan(1);
      expect(comp.threshold.value).toBeLessThan(0);
    });

    it('restores the direct master route when switched off', () => {
      const { ctx, engine } = createEngine();
      engine.setNightMode(true);
      const comp = ctx.compressors[0]!;

      engine.setNightMode(false);

      expect(ctx.masterBus.outputs).toEqual([ctx.destination]);
      expect(comp.disconnectCount).toBe(1);
      expect(engine.nightMode).toBe(false);
      expect(ctx.compressors).toHaveLength(1); // no extra node created
    });

    it('is idempotent', () => {
      const { ctx, engine } = createEngine();

      engine.setNightMode(true);
      engine.setNightMode(true);

      expect(ctx.compressors).toHaveLength(1);
      expect(ctx.masterBus.disconnectCount).toBe(1);
    });

    it('is driven by the audio settings', () => {
      const { ctx, engine } = createEngine({ settings: audio({ nightMode: true }) });

      // Applied during construction.
      expect(ctx.compressors).toHaveLength(1);
      expect(engine.nightMode).toBe(true);

      engine.applyAudioSettings(audio({ nightMode: false }));
      expect(engine.nightMode).toBe(false);
      expect(ctx.masterBus.outputs).toEqual([ctx.destination]);
    });
  });

  // -- diagnostics -------------------------------------------------------

  describe('diagnostics', () => {
    it('reports state, buffers, voices and emitters', async () => {
      const { engine } = createEngine({
        contextOptions: { state: 'suspended' },
        emitterBudget: 3,
      });

      expect(engine.diagnostics()).toMatchObject({
        contextState: 'suspended',
        unlocked: false,
        activeEmitters: 0,
        culledEmitters: 0,
        emitterBudget: 3,
        activeVoices: 0,
        loadedBuffers: 0,
        pendingLoads: 0,
        failedLoads: 0,
        nightMode: false,
      });

      await engine.unlock();
      await loadClip(engine, 'pump');
      engine.playLoop('pump');
      engine.createEmitter({ clipId: 'pump', position: { x: 0, y: 0, z: 0 } });

      expect(engine.diagnostics()).toMatchObject({
        contextState: 'running',
        unlocked: true,
        activeEmitters: 1,
        activeVoices: 1,
        loadedBuffers: 1,
      });
    });
  });

  // -- dispose -----------------------------------------------------------

  describe('dispose', () => {
    it('stops everything, detaches listeners and closes the context', async () => {
      const gesture = new RecordingEventTarget();
      const visibility = new FakeVisibilityTarget();
      const { ctx, engine } = createEngine({
        contextOptions: { state: 'suspended' },
        gestureTarget: gesture,
        visibilityTarget: visibility,
      });
      await loadClip(engine, 'pump');
      const voice = engine.playLoop('pump')!;
      const emitter = engine.createEmitter({ clipId: 'pump', position: { x: 0, y: 0, z: 0 } });
      const voiceSource = ctx.sources[0]!;
      const emitterSource = ctx.sources[1]!;
      const master = ctx.masterBus;

      engine.dispose();

      expect(ctx.closeCalls).toBe(1);
      expect(ctx.state).toBe('closed');
      expect(voiceSource.stopCalls).toHaveLength(1);
      expect(emitterSource.stopCalls).toHaveLength(1);
      expect(voice.stopped).toBe(true);
      expect(emitter.alive).toBe(false);
      expect(master.disconnectCount).toBeGreaterThan(0);
      for (const bus of ctx.categoryBusNodes) expect(bus.disconnectCount).toBe(1);
      expect(gesture.activeTypes).toHaveLength(0);
      expect(visibility.listenerCount).toBe(0);

      const diag = engine.diagnostics();
      expect(diag.activeVoices).toBe(0);
      expect(diag.activeEmitters).toBe(0);
      expect(diag.loadedBuffers).toBe(0);
      expect(diag.contextState).toBe('closed');
      expect(engine.available).toBe(false);
    });

    it('disposes the night-mode compressor too', () => {
      const { ctx, engine } = createEngine({ settings: audio({ nightMode: true }) });
      const comp = ctx.compressors[0]!;

      engine.dispose();

      expect(comp.disconnectCount).toBeGreaterThan(0);
    });

    it('is idempotent and leaves the engine inert', async () => {
      const { ctx, engine } = createEngine();
      await loadClip(engine, 'pump');

      engine.dispose();
      engine.dispose();

      expect(ctx.closeCalls).toBe(1);
      expect(engine.playOneShot('pump')).toBeNull();
      expect(engine.createEmitter({ clipId: 'pump', position: { x: 0, y: 0, z: 0 } }).alive).toBe(
        false,
      );
      await expect(engine.unlock()).resolves.toBe(false);
      expect(() =>
        engine.updateListener({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 }),
      ).not.toThrow();
    });

    it('survives a close() that rejects', async () => {
      const ctx = new FakeAudioContext();
      const rejecting: AudioContextLike = Object.assign(
        Object.create(ctx) as FakeAudioContext,
        { close: () => Promise.reject(new Error('InvalidStateError')) },
      );
      const engine = new AudioEngine({
        createContext: () => rejecting,
        initialAudio: audio(),
        gestureTarget: null,
        visibilityTarget: null,
      });

      expect(() => engine.dispose()).not.toThrow();
      await flush();
      expect(warn).toHaveBeenCalled();
    });
  });

  // -- unavailable platform ---------------------------------------------

  describe('when Web Audio is unavailable', () => {
    it('reports loudly and degrades to no-ops instead of throwing', async () => {
      // jsdom genuinely has no AudioContext, so no factory is injected here.
      const reasons: string[] = [];
      const engine = new AudioEngine({
        initialAudio: audio(),
        gestureTarget: null,
        visibilityTarget: null,
      });
      engine.on('unavailable', ({ reason }) => reasons.push(reason));

      expect(engine.available).toBe(false);
      expect(engine.state).toBe('unavailable');
      // Loud: a silent game is a real regression, even if not a fatal one.
      expect(error).toHaveBeenCalled();

      await expect(engine.unlock()).resolves.toBe(false);
      await expect(engine.load('x', '/x.ogg')).resolves.toBeNull();
      expect(engine.playOneShot('x')).toBeNull();
      expect(engine.playLoop('x')).toBeNull();
      expect(engine.createEmitter({ clipId: 'x', position: { x: 0, y: 0, z: 0 } }).alive).toBe(
        false,
      );
      expect(() => {
        engine.setBusVolume('music', 0.5);
        engine.setNightMode(true);
        engine.applyAudioSettings(audio({ master: 0.2 }));
        engine.updateListener({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 });
        engine.stopAll();
        engine.dispose();
      }).not.toThrow();
      expect(engine.diagnostics().contextState).toBe('unavailable');
    });

    it('surfaces a constructor throw as unavailable', () => {
      const engine = new AudioEngine({
        createContext: () => {
          throw new Error('hardware busy');
        },
        initialAudio: audio(),
        gestureTarget: null,
        visibilityTarget: null,
      });

      expect(engine.available).toBe(false);
      expect(error).toHaveBeenCalled();
    });
  });
});
