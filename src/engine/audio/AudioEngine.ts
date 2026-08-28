/**
 * Web Audio bus graph, buffer cache and positional emitters.
 *
 * Built directly on the Web Audio API rather than Three's `Audio`/
 * `PositionalAudio` helpers. Three's helpers each own a private GainNode wired
 * straight to `AudioContext.destination` (via `THREE.AudioListener`), which
 * gives no place to hang a shared Music/Ambience/Dialogue/Effects/UI bus, no
 * single insert point for the night-mode compressor, and no way to duck one
 * category under another. Explicit bus routing is the whole point of this
 * file, so we own the graph.
 *
 * Graph shape:
 *
 *   voice ──▶ voiceGain ──▶ [panner] ──▶ categoryBus ──▶ masterBus ──▶ dest
 *                                                            │
 *                                              (nightMode) ──┴──▶ compressor ──▶ dest
 *
 * Everything platform-facing is expressed through the small `*Like` interfaces
 * below and constructed through an injectable factory, so the engine is
 * testable under jsdom (which has no Web Audio implementation at all) without
 * mocking the engine itself.
 *
 * This file knows nothing about TIDELOCK's story or content. Clip ids are
 * opaque strings supplied by the caller.
 */

import { Emitter } from '../events';
import type { AudioBus, Vec3 } from '../ecs/components';
import type { AudioSettings } from '../../persistence/settingsSchema';
import type { SettingsStore } from '../../persistence/SettingsStore';

// ---------------------------------------------------------------------------
// Platform surface (only what this engine actually touches)
// ---------------------------------------------------------------------------

export interface AudioParamLike {
  value: number;
  setTargetAtTime?(target: number, startTime: number, timeConstant: number): unknown;
  linearRampToValueAtTime?(value: number, endTime: number): unknown;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
  disconnect(): unknown;
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}

export interface AudioBufferLike {
  readonly duration: number;
}

export interface AudioBufferSourceNodeLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  loop: boolean;
  readonly playbackRate: AudioParamLike;
  onended: (() => void) | null;
  start(when?: number, offset?: number): unknown;
  stop(when?: number): unknown;
}

export interface PannerNodeLike extends AudioNodeLike {
  panningModel: string;
  distanceModel: string;
  refDistance: number;
  maxDistance: number;
  rolloffFactor: number;
  /** Modern AudioParam interface. Absent on older WebKit. */
  readonly positionX?: AudioParamLike;
  readonly positionY?: AudioParamLike;
  readonly positionZ?: AudioParamLike;
  /** @deprecated legacy fallback, see `writePannerPosition`. */
  setPosition?(x: number, y: number, z: number): unknown;
}

export interface DynamicsCompressorNodeLike extends AudioNodeLike {
  readonly threshold: AudioParamLike;
  readonly knee: AudioParamLike;
  readonly ratio: AudioParamLike;
  readonly attack: AudioParamLike;
  readonly release: AudioParamLike;
}

export interface AudioListenerLike {
  readonly positionX?: AudioParamLike;
  readonly positionY?: AudioParamLike;
  readonly positionZ?: AudioParamLike;
  readonly forwardX?: AudioParamLike;
  readonly forwardY?: AudioParamLike;
  readonly forwardZ?: AudioParamLike;
  readonly upX?: AudioParamLike;
  readonly upY?: AudioParamLike;
  readonly upZ?: AudioParamLike;
  /** @deprecated legacy fallback, see `updateListener`. */
  setPosition?(x: number, y: number, z: number): unknown;
  /** @deprecated legacy fallback, see `updateListener`. */
  setOrientation?(
    x: number,
    y: number,
    z: number,
    upX: number,
    upY: number,
    upZ: number,
  ): unknown;
}

export type AudioContextStateLike = 'suspended' | 'running' | 'closed';

export interface AudioContextLike {
  readonly state: AudioContextStateLike;
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: AudioNodeLike;
  readonly listener: AudioListenerLike;
  createGain(): GainNodeLike;
  createPanner(): PannerNodeLike;
  createBufferSource(): AudioBufferSourceNodeLike;
  createDynamicsCompressor(): DynamicsCompressorNodeLike;
  createBuffer?(channels: number, length: number, sampleRate: number): AudioBufferLike;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
  resume(): Promise<void>;
  suspend?(): Promise<void>;
  close(): Promise<void>;
}

/** Minimal event-target surface. `window` and `document` both satisfy it. */
export interface EventTargetLike {
  addEventListener(type: string, listener: () => void, options?: unknown): void;
  removeEventListener(type: string, listener: () => void, options?: unknown): void;
}

export interface VisibilityTargetLike extends EventTargetLike {
  readonly hidden: boolean;
}

export type FetchLike = (url: string) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Category buses plus the master sum. `AudioBus` is the ECS component type. */
export type AudioBusName = AudioBus | 'master';

export const CATEGORY_BUSES: readonly AudioBus[] = [
  'music',
  'ambience',
  'dialogue',
  'effects',
  'ui',
];

export const ALL_BUSES: readonly AudioBusName[] = ['master', ...CATEGORY_BUSES];

export interface PlayOptions {
  bus?: AudioBus;
  /** 0..1 pre-bus voice volume. Curved the same way bus volumes are. */
  volume?: number;
  /** Playback rate multiplier. Also shifts pitch, as with any sample. */
  rate?: number;
  /** Seconds of fade-in. 0 starts at full level. */
  fadeIn?: number;
}

export interface PlaybackHandle {
  readonly id: number;
  readonly clipId: string;
  /** Clip length in seconds, before rate. Useful for subtitle timing. */
  readonly duration: number;
  readonly stopped: boolean;
  /** Stops with an optional fade-out to avoid a click on a loud tail. */
  stop(fadeOut?: number): void;
  setVolume(volume: number): void;
}

export interface EmitterOptions {
  clipId: string;
  position: Vec3;
  bus?: AudioBus;
  /** Distance at which attenuation begins. */
  refDistance?: number;
  /** Distance at which attenuation stops getting worse. */
  maxDistance?: number;
  loop?: boolean;
  volume?: number;
  rate?: number;
  /**
   * Higher wins when the emitter budget is exceeded. A pump that a mission
   * objective depends on should outrank incidental dripping.
   */
  priority?: number;
}

export interface EmitterHandle {
  readonly id: number;
  readonly clipId: string;
  /** False once stopped or finished. */
  readonly alive: boolean;
  /** True while the budget has this emitter silenced. */
  readonly culled: boolean;
  setPosition(position: Vec3): void;
  setVolume(volume: number): void;
  stop(): void;
}

export interface AudioDiagnostics {
  contextState: AudioContextStateLike | 'unavailable';
  unlocked: boolean;
  /** Emitters currently holding a live source. */
  activeEmitters: number;
  /** Registered emitters silenced by the budget. */
  culledEmitters: number;
  emitterBudget: number;
  activeVoices: number;
  loadedBuffers: number;
  pendingLoads: number;
  failedLoads: number;
  nightMode: boolean;
}

export interface AudioEngineOptions {
  /** Drives bus volumes and reapplies them live on change. */
  settings?: SettingsStore;
  /** Used when no `settings` store is supplied. */
  initialAudio?: AudioSettings;
  /** Injected for tests; defaults to a real `AudioContext`. */
  createContext?: () => AudioContextLike;
  /** Injected for tests; defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  /** From the quality preset's `audioEmitterBudget`. */
  emitterBudget?: number;
  /** Where the autoplay-unlock gesture listeners attach. Defaults to `window`. */
  gestureTarget?: EventTargetLike | null;
  /** Where visibility changes are observed. Defaults to `document`. */
  visibilityTarget?: VisibilityTargetLike | null;
  /** Suspend the context while the tab is hidden. Default true. */
  suspendWhenHidden?: boolean;
}

type AudioEngineEvents = {
  unlocked: { via: 'gesture' | 'explicit' | 'already-running' };
  stateChanged: { state: AudioContextStateLike };
  loadFailed: { clipId: string; url: string; reason: string };
  /** Emitted when the platform has no usable Web Audio implementation. */
  unavailable: { reason: string };
};

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/**
 * Time constant for gain ramps.
 *
 * `setTargetAtTime` reaches ~95% of the target after 3× this, so 0.04s settles
 * in ~120ms: fast enough to feel instant on a slider, slow enough that the
 * per-sample gain change is inaudible.
 */
const GAIN_RAMP_TIME_CONSTANT = 0.04;

/** Panner position ramp. Slightly longer; teleporting a source pops. */
const PAN_RAMP_TIME_CONSTANT = 0.06;

/**
 * Default concurrent positional emitters. The real value comes from the
 * selected quality preset (`audioEmitterBudget`) via `setEmitterBudget`; this
 * is only what we use before quality has been applied.
 */
const DEFAULT_EMITTER_BUDGET = 16;

/**
 * Cull hysteresis. An already-audible emitter is ranked as if it were 15%
 * nearer than it is, so an emitter hovering at the budget boundary does not
 * stutter on and off as the player sways.
 */
const AUDIBLE_STICKINESS = 0.85;

const DEFAULT_REF_DISTANCE = 2;
const DEFAULT_MAX_DISTANCE = 40;

/** Fallback settings when neither a store nor explicit values are supplied. */
const NEUTRAL_AUDIO: AudioSettings = {
  master: 1,
  music: 1,
  ambience: 1,
  dialogue: 1,
  effects: 1,
  ui: 1,
  nightMode: false,
};

const GESTURE_EVENTS = ['pointerdown', 'keydown', 'touchstart'] as const;

// ---------------------------------------------------------------------------
// Volume curve
// ---------------------------------------------------------------------------

/**
 * Maps a 0..1 slider position to a linear gain multiplier.
 *
 * A raw slider value used directly as gain feels wrong: loudness perception is
 * roughly logarithmic, so halving the amplitude (1.0 → 0.5, i.e. −6 dB) is
 * heard as only a modest drop. The result is a slider where the top third does
 * almost nothing audible and the bottom third collapses to silence too late.
 *
 * Squaring the value gives −12 dB at the midpoint, which lands much closer to
 * "half as loud" and spreads useful control across the whole travel. It also
 * keeps the endpoints exact (0 → silence, 1 → unity) which a dB mapping does
 * not without special-casing 0.
 */
export function perceptualGain(sliderValue: number): number {
  // NaN carries no direction, so it fails safe to silence. ±Infinity does
  // carry one and is clamped like any other out-of-range value.
  if (Number.isNaN(sliderValue)) return 0;
  if (sliderValue <= 0) return 0;
  if (sliderValue >= 1) return 1;
  return sliderValue * sliderValue;
}

// ---------------------------------------------------------------------------
// Internal records
// ---------------------------------------------------------------------------

interface Voice {
  id: number;
  clipId: string;
  bus: AudioBus;
  source: AudioBufferSourceNodeLike;
  gain: GainNodeLike;
  volume: number;
  duration: number;
  stopped: boolean;
}

interface EmitterRecord {
  id: number;
  clipId: string;
  bus: AudioBus;
  buffer: AudioBufferLike;
  position: Vec3;
  refDistance: number;
  maxDistance: number;
  loop: boolean;
  volume: number;
  rate: number;
  priority: number;
  /** Live nodes exist only while audible. Culling tears them down. */
  gain: GainNodeLike | null;
  panner: PannerNodeLike | null;
  source: AudioBufferSourceNodeLike | null;
  audible: boolean;
  alive: boolean;
}

// ---------------------------------------------------------------------------
// AudioEngine
// ---------------------------------------------------------------------------

export class AudioEngine {
  private readonly emitter = new Emitter<AudioEngineEvents>();

  private readonly ctx: AudioContextLike | null;
  private readonly fetchImpl: FetchLike | null;

  private masterBus: GainNodeLike | null = null;
  private readonly categoryBuses = new Map<AudioBus, GainNodeLike>();
  private compressor: DynamicsCompressorNodeLike | null = null;

  private readonly buffers = new Map<string, AudioBufferLike>();
  /** In-flight loads, keyed by clip id, so a clip is never fetched twice. */
  private readonly pending = new Map<string, Promise<AudioBufferLike | null>>();
  private readonly failed = new Set<string>();

  private readonly voices = new Map<number, Voice>();
  private readonly emitters = new Map<number, EmitterRecord>();
  private nextId = 1;

  private audio: AudioSettings;
  private readonly busTargets = new Map<AudioBusName, number>();
  private nightModeOn = false;

  private emitterBudget: number;
  private listenerPosition: Vec3 = { x: 0, y: 0, z: 0 };

  private unlockedFlag = false;
  private disposed = false;

  private readonly gestureTarget: EventTargetLike | null;
  private readonly visibilityTarget: VisibilityTargetLike | null;
  private readonly suspendWhenHidden: boolean;
  private gestureListener: (() => void) | null = null;
  private visibilityListener: (() => void) | null = null;
  private unsubscribeSettings: (() => void) | null = null;

  constructor(options: AudioEngineOptions = {}) {
    this.audio = options.settings?.current.audio ?? options.initialAudio ?? NEUTRAL_AUDIO;
    this.emitterBudget = normaliseBudget(options.emitterBudget, DEFAULT_EMITTER_BUDGET);
    this.fetchImpl = options.fetch ?? defaultFetch();
    this.suspendWhenHidden = options.suspendWhenHidden !== false;

    this.gestureTarget =
      options.gestureTarget !== undefined ? options.gestureTarget : defaultGestureTarget();
    this.visibilityTarget =
      options.visibilityTarget !== undefined
        ? options.visibilityTarget
        : defaultVisibilityTarget();

    this.ctx = this.createContext(options.createContext);

    if (this.ctx) {
      this.buildBusGraph();
      this.applyAudioSettings(this.audio, true);
      this.installGestureListeners();
      this.installVisibilityListener();
      if (this.ctx.state === 'running') this.unlockedFlag = true;
    }

    if (options.settings) {
      this.unsubscribeSettings = options.settings.on('changed', ({ settings, sections }) => {
        if (!sections.includes('audio')) return;
        this.applyAudioSettings(settings.audio);
      });
    }
  }

  on = this.emitter.on.bind(this.emitter);

  // -- lifecycle ----------------------------------------------------------

  /**
   * Constructs the context.
   *
   * Missing Web Audio is not fatal for the game — the campaign is playable
   * silently — so we log it loudly and continue with every method degrading to
   * a no-op rather than throwing during boot.
   */
  private createContext(factory: (() => AudioContextLike) | undefined): AudioContextLike | null {
    try {
      if (factory) return factory();
      const Ctor = resolveAudioContextConstructor();
      if (!Ctor) {
        const reason = 'AudioContext is not available in this environment';
        console.error(`[audio] ${reason}; the game will run without sound`);
        this.emitter.emit('unavailable', { reason });
        return null;
      }
      // The platform type carries far more surface than we use, and its
      // handler signatures are stricter than our port. Bridge it once, here.
      return new Ctor() as unknown as AudioContextLike;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error('[audio] could not create an AudioContext; running silent', error);
      this.emitter.emit('unavailable', { reason });
      return null;
    }
  }

  private buildBusGraph(): void {
    const ctx = this.ctx;
    if (!ctx) return;

    this.masterBus = ctx.createGain();
    for (const name of CATEGORY_BUSES) {
      const bus = ctx.createGain();
      bus.connect(this.masterBus);
      this.categoryBuses.set(name, bus);
    }
    // Master → destination. `setNightMode` re-routes through the compressor.
    this.masterBus.connect(ctx.destination);
  }

  /** True once the context is confirmed running. */
  get isUnlocked(): boolean {
    return this.unlockedFlag && this.ctx?.state === 'running';
  }

  get state(): AudioContextStateLike | 'unavailable' {
    return this.ctx?.state ?? 'unavailable';
  }

  /** True when a usable context exists. False means every call is a no-op. */
  get available(): boolean {
    return this.ctx !== null && !this.disposed;
  }

  /**
   * Resumes the context. Must be reachable from a real user gesture.
   *
   * Browsers create the context `suspended` and only allow `resume()` to
   * succeed inside (or shortly after) a gesture. Anything that starts audio
   * before that gesture fails silently, which is exactly the failure mode this
   * project treats as unacceptable — so unlocking is explicit, observable via
   * `isUnlocked`, and never throws.
   */
  async unlock(): Promise<boolean> {
    const ctx = this.ctx;
    if (!ctx || this.disposed) return false;
    if (ctx.state === 'closed') return false;

    if (ctx.state === 'running') {
      this.markUnlocked('already-running');
      return true;
    }

    try {
      await ctx.resume();
    } catch (error) {
      // A resume outside a gesture rejects. Keep the listeners installed so
      // the next real gesture tries again.
      console.warn('[audio] resume() was rejected; waiting for a user gesture', error);
      return false;
    }

    // Read through a helper: `state` is declared readonly but the browser
    // mutates it, so the compiler's narrowing from the checks above is stale
    // by this point.
    const resumedState = readState(ctx);
    if (resumedState !== 'running') {
      console.warn(`[audio] resume() resolved but state is "${resumedState}"`);
      return false;
    }

    this.primeSilentSource();
    this.markUnlocked('explicit');
    return true;
  }

  /**
   * Starts a one-sample silent source.
   *
   * Some WebKit builds only truly release the audio hardware once a source has
   * been started inside the gesture, even after `resume()` resolves.
   */
  private primeSilentSource(): void {
    const ctx = this.ctx;
    if (!ctx || typeof ctx.createBuffer !== 'function') return;
    try {
      const buffer = ctx.createBuffer(1, 1, ctx.sampleRate || 44100);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
    } catch (error) {
      // Purely a workaround; failing it must not block unlocking.
      console.warn('[audio] silent priming source failed', error);
    }
  }

  private markUnlocked(via: AudioEngineEvents['unlocked']['via']): void {
    const wasUnlocked = this.unlockedFlag;
    this.unlockedFlag = true;
    this.removeGestureListeners();
    if (!wasUnlocked) {
      this.emitter.emit('unlocked', { via });
      this.emitter.emit('stateChanged', { state: this.ctx?.state ?? 'closed' });
    }
  }

  private installGestureListeners(): void {
    const target = this.gestureTarget;
    if (!target || this.ctx?.state === 'running') return;

    const listener = (): void => {
      // Never rejects (unlock catches internally); the guard is future-proofing.
      this.unlock().catch(() => undefined);
    };
    this.gestureListener = listener;
    for (const type of GESTURE_EVENTS) {
      // Passive: these are observation-only and must not delay scrolling.
      target.addEventListener(type, listener, { passive: true });
    }
  }

  /** Self-removing: called from `markUnlocked` and from `dispose`. */
  private removeGestureListeners(): void {
    const target = this.gestureTarget;
    const listener = this.gestureListener;
    if (!target || !listener) return;
    for (const type of GESTURE_EVENTS) target.removeEventListener(type, listener);
    this.gestureListener = null;
  }

  /**
   * Suspends while the tab is hidden and resumes on return.
   *
   * Browsers may suspend a backgrounded context themselves, but not
   * consistently, and an unsuspended context keeps the audio thread and the
   * device's speaker path awake. Doing it explicitly makes the behaviour the
   * same everywhere and keeps `state` honest.
   */
  private installVisibilityListener(): void {
    const target = this.visibilityTarget;
    if (!target) return;

    const listener = (): void => {
      const ctx = this.ctx;
      if (!ctx || this.disposed || ctx.state === 'closed') return;

      if (target.hidden) {
        if (!this.suspendWhenHidden || ctx.state !== 'running') return;
        void Promise.resolve(ctx.suspend?.()).catch((error: unknown) => {
          console.warn('[audio] suspend on hide failed', error);
        });
        return;
      }

      // Only resume what we previously unlocked. Resuming a never-unlocked
      // context here would be a gesture-less resume, which browsers reject.
      if (!this.unlockedFlag || ctx.state !== 'suspended') return;
      ctx.resume().catch((error: unknown) => {
        console.warn('[audio] resume on show failed', error);
      });
    };

    this.visibilityListener = listener;
    target.addEventListener('visibilitychange', listener);
  }

  // -- settings -----------------------------------------------------------

  /**
   * Applies bus volumes and night mode.
   *
   * `immediate` is only used during construction: the graph is silent and the
   * gain nodes still sit at their default 1.0, so ramping would schedule an
   * audible slide from the wrong level the moment the first clip plays.
   */
  applyAudioSettings(audio: AudioSettings, immediate = false): void {
    this.audio = audio;
    if (!this.ctx) return;

    this.setBusVolume('master', audio.master, immediate);
    for (const name of CATEGORY_BUSES) {
      this.setBusVolume(name, audio[name], immediate);
    }
    this.setNightMode(audio.nightMode);
  }

  /** Sets one bus's slider value (0..1). Curved and ramped. */
  setBusVolume(bus: AudioBusName, sliderValue: number, immediate = false): void {
    const node = bus === 'master' ? this.masterBus : this.categoryBuses.get(bus);
    if (!node) return;

    const gain = perceptualGain(sliderValue);
    this.busTargets.set(bus, gain);

    if (immediate) {
      // Documented exception; see applyAudioSettings.
      node.gain.value = gain;
      return;
    }
    this.rampParam(node.gain, gain, GAIN_RAMP_TIME_CONSTANT);
  }

  /** The curved gain currently targeted for a bus. For tests/diagnostics. */
  busGain(bus: AudioBusName): number {
    return this.busTargets.get(bus) ?? 0;
  }

  /**
   * Inserts or removes a compressor on the master bus.
   *
   * Phone speakers cannot reproduce a wide dynamic range: quiet dialogue
   * disappears under room noise while a pump start clips. Compressing the
   * master sum trades headroom for intelligibility, which is the right trade
   * on a handset and the wrong one on headphones — hence a setting.
   */
  setNightMode(enabled: boolean): void {
    const ctx = this.ctx;
    const master = this.masterBus;
    if (!ctx || !master) return;
    if (enabled === this.nightModeOn) return;

    if (enabled) {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -20;
      comp.knee.value = 12;
      comp.ratio.value = 6;
      comp.attack.value = 0.005;
      comp.release.value = 0.25;
      master.disconnect();
      master.connect(comp);
      comp.connect(ctx.destination);
      this.compressor = comp;
    } else {
      master.disconnect();
      this.compressor?.disconnect();
      this.compressor = null;
      master.connect(ctx.destination);
    }
    this.nightModeOn = enabled;
  }

  get nightMode(): boolean {
    return this.nightModeOn;
  }

  /** Sets the concurrent emitter ceiling, then re-ranks immediately. */
  setEmitterBudget(budget: number): void {
    const next = normaliseBudget(budget, this.emitterBudget);
    if (next === this.emitterBudget) return;
    this.emitterBudget = next;
    this.reconcileEmitterBudget();
  }

  get budget(): number {
    return this.emitterBudget;
  }

  // -- buffer cache -------------------------------------------------------

  /**
   * Fetches and decodes a clip, caching by id.
   *
   * Concurrent requests for the same id share one in-flight promise, so a
   * sector that references the same drip loop from twelve emitters still
   * performs exactly one fetch and one decode.
   *
   * Returns null on failure. A missing sound effect degrades the scene; it
   * does not stop the campaign.
   */
  load(clipId: string, url: string): Promise<AudioBufferLike | null> {
    const cached = this.buffers.get(clipId);
    if (cached) return Promise.resolve(cached);

    const inFlight = this.pending.get(clipId);
    if (inFlight) return inFlight;

    const ctx = this.ctx;
    const fetchImpl = this.fetchImpl;
    if (!ctx || !fetchImpl) {
      return Promise.resolve(null);
    }

    const task = (async (): Promise<AudioBufferLike | null> => {
      try {
        const response = await fetchImpl(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const bytes = await response.arrayBuffer();
        const buffer = await ctx.decodeAudioData(bytes);
        if (this.disposed) return null;
        this.buffers.set(clipId, buffer);
        this.failed.delete(clipId);
        return buffer;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[audio] failed to load "${clipId}" from ${url}: ${reason}`);
        this.failed.add(clipId);
        this.emitter.emit('loadFailed', { clipId, url, reason });
        return null;
      } finally {
        this.pending.delete(clipId);
      }
    })();

    this.pending.set(clipId, task);
    return task;
  }

  has(clipId: string): boolean {
    return this.buffers.has(clipId);
  }

  /** Drops a decoded buffer, e.g. when its sector unloads. */
  unload(clipId: string): void {
    this.buffers.delete(clipId);
    this.failed.delete(clipId);
  }

  // -- non-positional playback -------------------------------------------

  /** Plays a clip once. Returns null when the clip is not loaded. */
  playOneShot(clipId: string, options: PlayOptions = {}): PlaybackHandle | null {
    return this.startVoice(clipId, options, false);
  }

  /** Plays a clip on repeat until the handle is stopped. */
  playLoop(clipId: string, options: PlayOptions = {}): PlaybackHandle | null {
    return this.startVoice(clipId, options, true);
  }

  private startVoice(
    clipId: string,
    options: PlayOptions,
    loop: boolean,
  ): PlaybackHandle | null {
    const ctx = this.ctx;
    if (!ctx || this.disposed) return null;

    const buffer = this.buffers.get(clipId);
    if (!buffer) {
      console.warn(`[audio] "${clipId}" is not loaded; nothing played`);
      return null;
    }

    const busName = options.bus ?? 'effects';
    const bus = this.categoryBuses.get(busName);
    if (!bus) return null;

    const volume = clamp01(options.volume ?? 1);
    const gain = ctx.createGain();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    // Fresh, unstarted node: no output yet, so a direct write cannot click.
    source.playbackRate.value = positiveRate(options.rate);

    const fadeIn = options.fadeIn ?? 0;
    if (fadeIn > 0) {
      gain.gain.value = 0;
      this.rampParam(gain.gain, perceptualGain(volume), fadeIn / 3);
    } else {
      gain.gain.value = perceptualGain(volume);
    }

    source.connect(gain);
    gain.connect(bus);

    const id = this.nextId++;
    const voice: Voice = {
      id,
      clipId,
      bus: busName,
      source,
      gain,
      volume,
      duration: buffer.duration,
      stopped: false,
    };
    this.voices.set(id, voice);

    source.onended = () => {
      this.teardownVoice(voice);
    };
    source.start(0);

    const engine = this;
    return {
      id,
      clipId,
      duration: buffer.duration,
      get stopped() {
        return voice.stopped;
      },
      stop(fadeOut = 0) {
        engine.stopVoice(voice, fadeOut);
      },
      setVolume(next: number) {
        voice.volume = clamp01(next);
        engine.rampParam(voice.gain.gain, perceptualGain(voice.volume), GAIN_RAMP_TIME_CONSTANT);
      },
    };
  }

  private stopVoice(voice: Voice, fadeOut: number): void {
    if (voice.stopped) return;
    if (fadeOut > 0) {
      this.rampParam(voice.gain.gain, 0, fadeOut / 3);
      try {
        voice.source.stop(this.now() + fadeOut);
      } catch {
        // Already stopped by the browser; the teardown below still runs.
      }
      voice.stopped = true;
      return;
    }
    try {
      voice.source.stop();
    } catch {
      // Stopping a finished source throws in some browsers. Harmless.
    }
    this.teardownVoice(voice);
  }

  private teardownVoice(voice: Voice): void {
    voice.stopped = true;
    voice.source.onended = null;
    safeDisconnect(voice.source);
    safeDisconnect(voice.gain);
    this.voices.delete(voice.id);
  }

  /** Stops every voice and emitter. Used on scene teardown. */
  stopAll(): void {
    for (const voice of [...this.voices.values()]) this.stopVoice(voice, 0);
    for (const record of [...this.emitters.values()]) this.destroyEmitter(record);
  }

  // -- positional audio ---------------------------------------------------

  /**
   * Registers a positional emitter.
   *
   * The clip must already be loaded — sector load is the place to await
   * `load()`. An unloaded clip returns an inert handle rather than throwing.
   */
  createEmitter(options: EmitterOptions): EmitterHandle {
    const ctx = this.ctx;
    const buffer = this.buffers.get(options.clipId);

    if (!ctx || this.disposed || !buffer) {
      if (ctx && !buffer) {
        console.warn(`[audio] emitter for "${options.clipId}" skipped: clip not loaded`);
      }
      return inertEmitterHandle(this.nextId++, options.clipId);
    }

    const record: EmitterRecord = {
      id: this.nextId++,
      clipId: options.clipId,
      bus: options.bus ?? 'effects',
      buffer,
      position: { ...options.position },
      refDistance: positiveOr(options.refDistance, DEFAULT_REF_DISTANCE),
      maxDistance: positiveOr(options.maxDistance, DEFAULT_MAX_DISTANCE),
      loop: options.loop ?? true,
      volume: clamp01(options.volume ?? 1),
      rate: positiveRate(options.rate),
      priority: options.priority ?? 0,
      gain: null,
      panner: null,
      source: null,
      audible: false,
      alive: true,
    };
    this.emitters.set(record.id, record);
    this.reconcileEmitterBudget();

    const engine = this;
    return {
      id: record.id,
      clipId: record.clipId,
      get alive() {
        return record.alive;
      },
      get culled() {
        return record.alive && !record.audible;
      },
      setPosition(position: Vec3) {
        if (!record.alive) return;
        record.position.x = position.x;
        record.position.y = position.y;
        record.position.z = position.z;
        if (record.panner) engine.writePannerPosition(record.panner, record.position);
      },
      setVolume(next: number) {
        record.volume = clamp01(next);
        if (record.gain) {
          engine.rampParam(
            record.gain.gain,
            perceptualGain(record.volume),
            GAIN_RAMP_TIME_CONSTANT,
          );
        }
      },
      stop() {
        engine.destroyEmitter(record);
      },
    };
  }

  /**
   * Updates the listener pose and re-ranks emitters against the budget.
   *
   * Call once per rendered frame from the camera. `forward` and `up` are
   * normalised here so callers can hand over raw basis vectors.
   */
  updateListener(position: Vec3, forward: Vec3, up: Vec3): void {
    const ctx = this.ctx;
    if (!ctx || this.disposed) return;

    this.listenerPosition = { ...position };

    const fwd = normalise(forward, { x: 0, y: 0, z: -1 });
    const upv = normalise(up, { x: 0, y: 1, z: 0 });
    const listener = ctx.listener;

    if (listener.positionX && listener.forwardX && listener.upX) {
      // Modern AudioParam interface: sample-accurate and rampable, so the
      // listener does not jump between frames.
      this.rampParam(listener.positionX, position.x, PAN_RAMP_TIME_CONSTANT);
      this.rampParam(listener.positionY!, position.y, PAN_RAMP_TIME_CONSTANT);
      this.rampParam(listener.positionZ!, position.z, PAN_RAMP_TIME_CONSTANT);
      this.rampParam(listener.forwardX, fwd.x, PAN_RAMP_TIME_CONSTANT);
      this.rampParam(listener.forwardY!, fwd.y, PAN_RAMP_TIME_CONSTANT);
      this.rampParam(listener.forwardZ!, fwd.z, PAN_RAMP_TIME_CONSTANT);
      this.rampParam(listener.upX, upv.x, PAN_RAMP_TIME_CONSTANT);
      this.rampParam(listener.upY!, upv.y, PAN_RAMP_TIME_CONSTANT);
      this.rampParam(listener.upZ!, upv.z, PAN_RAMP_TIME_CONSTANT);
    } else {
      // Older WebKit exposes only the deprecated setters. They snap rather
      // than ramp, which is why they are the fallback and not the default.
      listener.setPosition?.(position.x, position.y, position.z);
      listener.setOrientation?.(fwd.x, fwd.y, fwd.z, upv.x, upv.y, upv.z);
    }

    this.reconcileEmitterBudget();
  }

  private writePannerPosition(panner: PannerNodeLike, position: Vec3): void {
    if (panner.positionX) {
      this.rampParam(panner.positionX, position.x, PAN_RAMP_TIME_CONSTANT);
      this.rampParam(panner.positionY!, position.y, PAN_RAMP_TIME_CONSTANT);
      this.rampParam(panner.positionZ!, position.z, PAN_RAMP_TIME_CONSTANT);
      return;
    }
    // Same deprecated fallback as the listener, for the same browsers.
    panner.setPosition?.(position.x, position.y, position.z);
  }

  /**
   * Enforces the emitter budget.
   *
   * Ranking is priority first, then distance, with a stickiness bonus for
   * emitters that are already audible. Emitters beyond the budget have their
   * nodes torn down entirely rather than being left connected at zero gain —
   * a silent PannerNode still costs a spatialisation pass per block, which is
   * exactly the cost the budget exists to avoid.
   */
  private reconcileEmitterBudget(): void {
    if (!this.ctx || this.disposed) return;

    const records = [...this.emitters.values()].filter((r) => r.alive);
    if (records.length === 0) return;

    if (records.length <= this.emitterBudget) {
      for (const record of records) if (!record.audible) this.startEmitterVoice(record);
      return;
    }

    const ranked = records
      .map((record) => ({
        record,
        score: this.cullScore(record),
      }))
      .sort((a, b) => {
        if (b.record.priority !== a.record.priority) {
          return b.record.priority - a.record.priority;
        }
        return a.score - b.score;
      });

    for (let i = 0; i < ranked.length; i += 1) {
      const { record } = ranked[i]!;
      const keep = i < this.emitterBudget;
      if (keep && !record.audible) this.startEmitterVoice(record);
      else if (!keep && record.audible) this.cullEmitterVoice(record);
    }
  }

  /** Effective distance used for ranking. Lower is more deserving. */
  private cullScore(record: EmitterRecord): number {
    const dx = record.position.x - this.listenerPosition.x;
    const dy = record.position.y - this.listenerPosition.y;
    const dz = record.position.z - this.listenerPosition.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return record.audible ? dist * AUDIBLE_STICKINESS : dist;
  }

  private startEmitterVoice(record: EmitterRecord): void {
    const ctx = this.ctx;
    const bus = this.categoryBuses.get(record.bus);
    if (!ctx || !bus || !record.alive || record.audible) return;

    const gain = ctx.createGain();
    gain.gain.value = perceptualGain(record.volume);

    const panner = ctx.createPanner();
    // equalpower rather than HRTF: HRTF convolves per source and is the single
    // most expensive spatialisation option on a phone, for a cue the player
    // reads as "left/right/behind" either way.
    panner.panningModel = 'equalpower';
    // Inverse is the physically-motivated model and the one whose refDistance
    // and rolloffFactor behave predictably for machinery in a corridor.
    panner.distanceModel = 'inverse';
    panner.refDistance = record.refDistance;
    panner.maxDistance = record.maxDistance;
    panner.rolloffFactor = 1;
    this.writePannerPosition(panner, record.position);

    const source = ctx.createBufferSource();
    source.buffer = record.buffer;
    source.loop = record.loop;
    source.playbackRate.value = record.rate;

    source.connect(gain);
    gain.connect(panner);
    panner.connect(bus);

    source.onended = () => {
      // A finished one-shot emitter is done for good.
      if (!record.loop) this.destroyEmitter(record);
    };
    source.start(0);

    record.gain = gain;
    record.panner = panner;
    record.source = source;
    record.audible = true;
  }

  /**
   * Silences an emitter without unregistering it.
   *
   * Looping emitters can be revived later — restarting a loop mid-phase is
   * inaudible. A culled one-shot is destroyed instead, because reviving it
   * would replay the whole clip from the start at the wrong moment.
   */
  private cullEmitterVoice(record: EmitterRecord): void {
    if (!record.loop) {
      this.destroyEmitter(record);
      return;
    }
    this.releaseEmitterNodes(record);
  }

  private releaseEmitterNodes(record: EmitterRecord): void {
    if (record.source) {
      record.source.onended = null;
      try {
        record.source.stop();
      } catch {
        // Already finished. Disconnect below still applies.
      }
      safeDisconnect(record.source);
    }
    safeDisconnect(record.gain);
    safeDisconnect(record.panner);
    record.source = null;
    record.gain = null;
    record.panner = null;
    record.audible = false;
  }

  private destroyEmitter(record: EmitterRecord): void {
    if (!record.alive) return;
    this.releaseEmitterNodes(record);
    record.alive = false;
    this.emitters.delete(record.id);
    // A freed slot may let a culled emitter back in.
    if (!this.disposed) this.reconcileEmitterBudget();
  }

  // -- diagnostics --------------------------------------------------------

  diagnostics(): AudioDiagnostics {
    let active = 0;
    let culled = 0;
    for (const record of this.emitters.values()) {
      if (!record.alive) continue;
      if (record.audible) active += 1;
      else culled += 1;
    }
    return {
      contextState: this.state,
      unlocked: this.isUnlocked,
      activeEmitters: active,
      culledEmitters: culled,
      emitterBudget: this.emitterBudget,
      activeVoices: this.voices.size,
      loadedBuffers: this.buffers.size,
      pendingLoads: this.pending.size,
      failedLoads: this.failed.size,
      nightMode: this.nightModeOn,
    };
  }

  // -- teardown -----------------------------------------------------------

  /** Stops everything, detaches listeners and closes the context. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.removeGestureListeners();
    if (this.visibilityTarget && this.visibilityListener) {
      this.visibilityTarget.removeEventListener('visibilitychange', this.visibilityListener);
      this.visibilityListener = null;
    }
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;

    for (const voice of [...this.voices.values()]) this.stopVoice(voice, 0);
    this.voices.clear();
    for (const record of [...this.emitters.values()]) {
      this.releaseEmitterNodes(record);
      record.alive = false;
    }
    this.emitters.clear();

    for (const bus of this.categoryBuses.values()) safeDisconnect(bus);
    this.categoryBuses.clear();
    safeDisconnect(this.compressor);
    safeDisconnect(this.masterBus);
    this.compressor = null;
    this.masterBus = null;

    this.buffers.clear();
    this.pending.clear();
    this.failed.clear();
    this.emitter.clear();

    const ctx = this.ctx;
    if (ctx && ctx.state !== 'closed') {
      ctx.close().catch((error: unknown) => {
        console.warn('[audio] close() failed', error);
      });
    }
  }

  // -- helpers ------------------------------------------------------------

  private now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /**
   * Moves an AudioParam toward a value over time.
   *
   * Assigning `gain.value` directly steps the parameter between render quanta,
   * which is audible as a click or, while a slider is dragged, as zipper
   * noise. `setTargetAtTime` schedules a smooth exponential approach on the
   * audio thread instead. Direct assignment is only used where documented:
   * initial graph setup and freshly created, unstarted nodes.
   */
  private rampParam(param: AudioParamLike, value: number, timeConstant: number): void {
    if (typeof param.setTargetAtTime === 'function') {
      param.setTargetAtTime(value, this.now(), Math.max(timeConstant, 0.001));
      return;
    }
    if (typeof param.linearRampToValueAtTime === 'function') {
      param.linearRampToValueAtTime(value, this.now() + Math.max(timeConstant, 0.001) * 3);
      return;
    }
    // No scheduling available at all. Better a click than silence.
    param.value = value;
  }
}

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

type AudioContextCtor = new () => unknown;

/** Defeats stale control-flow narrowing of the mutable-but-readonly `state`. */
function readState(ctx: AudioContextLike): AudioContextStateLike {
  return ctx.state;
}

function resolveAudioContextConstructor(): AudioContextCtor | null {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

function defaultFetch(): FetchLike | null {
  if (typeof globalThis.fetch !== 'function') return null;
  return (url: string) => globalThis.fetch(url);
}

function defaultGestureTarget(): EventTargetLike | null {
  if (typeof window === 'undefined') return null;
  return window as unknown as EventTargetLike;
}

function defaultVisibilityTarget(): VisibilityTargetLike | null {
  if (typeof document === 'undefined') return null;
  return document as unknown as VisibilityTargetLike;
}

function inertEmitterHandle(id: number, clipId: string): EmitterHandle {
  return {
    id,
    clipId,
    alive: false,
    culled: false,
    setPosition() {},
    setVolume() {},
    stop() {},
  };
}

function safeDisconnect(node: AudioNodeLike | null): void {
  if (!node) return;
  try {
    node.disconnect();
  } catch {
    // Disconnecting an already-detached node throws in some browsers.
  }
}

function clamp01(value: number): number {
  // Same convention as perceptualGain: NaN → silence, ±Infinity clamps.
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function positiveRate(rate: number | undefined): number {
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) return 1;
  return rate;
}

function positiveOr(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function normaliseBudget(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalise(v: Vec3, fallback: Vec3): Vec3 {
  const length = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (!Number.isFinite(length) || length < 1e-6) return { ...fallback };
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}
