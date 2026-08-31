/**
 * Developer diagnostics overlay tests.
 *
 * SCOPE, HONESTLY STATED: these run under jsdom. There is no GPU, no renderer
 * and no layout — jsdom computes no geometry, and vitest is not configured to
 * process CSS, so nothing here can assert that the panel is *visible*, legible
 * or correctly positioned. Visibility is therefore asserted at the level the
 * overlay actually controls: the `diag--hidden` class and the state classes on
 * each value. Whether `.diag--hidden` truly hides anything is a stylesheet
 * question and belongs to `tests/browser`.
 *
 * Everything else about this overlay IS observable without a device, because
 * it reads the engine exclusively through injected provider callbacks. So the
 * contracts pinned below are the real ones:
 *
 *   - a section exists only when its provider does, so a partially wired
 *     overlay shows less rather than showing zeros that look like readings
 *   - every provider value is displayed, formatted and colour-stated correctly
 *   - refresh runs at ~5 Hz, not per frame, and skips unchanged DOM writes
 *   - show/hide/toggle drive the profiling hook exactly once per transition
 *   - the text report is correct even if the panel was never shown
 *   - clipboard failure falls back rather than silently doing nothing
 *   - dispose is terminal: no timer, no listener and no profiling left live
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DiagnosticsOverlay,
  type DiagnosticsQualityView,
  type DiagnosticsSources,
} from '../../src/diagnostics/DiagnosticsOverlay';
import { BUILD_INFO, formatBuildIdentity } from '../../src/app/buildInfo';
import type { GraphicsCapabilities } from '../../src/engine/render/Capabilities';
import type { FrameSnapshot } from '../../src/engine/render/FrameStats';
import type { BackendReport, RenderStats } from '../../src/engine/render/RenderContext';
import type { SystemTiming } from '../../src/engine/ecs/GameWorld';
import type { ScalerState } from '../../src/graphics/quality/DynamicScaler';
import type { LoopStats } from '../../src/engine/time/FixedStepLoop';

/** Matches REFRESH_INTERVAL_MS in the source. Duplicated on purpose: */
/** importing it would let a cadence regression widen the test with it. */
const REFRESH_MS = 200;
const STATUS_CLEAR_MS = 2600;
const MISSING = '—';

/** One frame at 60 Hz, in the seconds unit `update()` takes. */
const FRAME_S = 1 / 60;

// ---- Fixtures -----------------------------------------------------------

/**
 * Mutable readings shared with the providers, so a test can change a value
 * and then prove the panel picked it up on the next refresh.
 */
interface Live {
  frame: FrameSnapshot;
  loop: LoopStats;
  render: RenderStats;
  backend: BackendReport;
  adapter: string | null;
  buffer: { width: number; height: number };
  css: { width: number; height: number };
  renderScale: number;
  quality: DiagnosticsQualityView;
  overrides: object | null;
  scaler: ScalerState;
  ecs: Record<string, number>;
  timings: SystemTiming[];
  caps: GraphicsCapabilities | null;
}

function liveDefaults(): Live {
  return {
    frame: {
      fps: 59.4,
      averageFps: 58.25,
      frameMs: 16.84,
      averageFrameMs: 17.16,
      onePercentLowFps: 41.5,
      longFrames: 3,
      worstFrameMs: 48.125,
      totalFrames: 12_345,
      hasStableSample: true,
    },
    loop: {
      stepsLastFrame: 2,
      droppedTime: 0.125,
      overloadFrames: 4,
      totalSteps: 24_680,
      totalFrames: 12_345,
      elapsed: 411.5,
    },
    render: {
      drawCalls: 480,
      triangles: 250_000,
      lines: 12,
      points: 7,
      renderCalls: 98_765,
      geometries: 143,
      textures: 88,
    },
    backend: { requested: 'webgpu', actual: 'webgpu', forcedByUser: false },
    adapter: 'Test Vendor · rdna3 · Test Device',
    buffer: { width: 1920, height: 1080 },
    css: { width: 1280, height: 720 },
    renderScale: 0.875,
    quality: {
      preset: 'high',
      targetFps: 60,
      renderScale: 0.9,
      shadowTier: 3,
      textureTier: 4,
      drawCallBudget: 960,
      triangleBudget: 500_000,
    },
    overrides: null,
    scaler: {
      level: 0,
      maxLevel: 4,
      currentLabel: null,
      deficitSeconds: 0,
      headroomSeconds: 1.5,
      enabled: true,
      decisions: 6,
    },
    ecs: { entities: 1240, meshes: 310 },
    timings: [
      { name: 'physics', fixedMs: 2.5, renderMs: 0 },
      { name: 'render', fixedMs: 0, renderMs: 4.25 },
    ],
    caps: {
      webgpuAvailable: true,
      webgpuUnavailableReason: null,
      webgl2Available: true,
      deviceClass: 'desktop',
      devicePixelRatio: 2,
      gpuRenderer: 'Test GPU',
      gpuVendor: 'Test Vendor',
      maxTextureSize: 16_384,
      cpuThreads: 8,
      deviceMemoryGb: 8,
      touchCapable: false,
      secureContext: true,
      supportsKtx2Etc: true,
      supportsKtx2Astc: false,
      supportsKtx2Bc7: true,
    },
  };
}

/** How many times each provider was invoked, so laziness is provable. */
type CallCounts = Record<string, number>;

interface Fixture {
  live: Live;
  calls: CallCounts;
  profiling: ReturnType<typeof vi.fn>;
  sources: DiagnosticsSources;
}

/**
 * Builds a source bag containing only the requested providers.
 *
 * `frameStats` is always present because the source treats it as required.
 * Every other key is opt-in, which is exactly how the section gating is
 * exercised.
 */
function fixture(
  include: Array<keyof DiagnosticsSources> = [
    'loop',
    'render',
    'backend',
    'adapterInfo',
    'bufferSize',
    'cssSize',
    'renderScale',
    'quality',
    'adaptiveOverrides',
    'scaler',
    'ecsCounts',
    'systemTimings',
    'capabilities',
    'onProfilingChange',
  ],
): Fixture {
  const live = liveDefaults();
  const calls: CallCounts = {};
  const profiling = vi.fn();

  const count = <T>(key: string, read: () => T): (() => T) => {
    return () => {
      calls[key] = (calls[key] ?? 0) + 1;
      return read();
    };
  };

  const wanted = new Set(include);
  const sources: DiagnosticsSources = {
    frameStats: count('frameStats', () => live.frame),
  };

  if (wanted.has('loop')) sources.loop = count('loop', () => live.loop);
  if (wanted.has('render')) sources.render = count('render', () => live.render);
  if (wanted.has('backend')) sources.backend = count('backend', () => live.backend);
  if (wanted.has('adapterInfo')) sources.adapterInfo = count('adapterInfo', () => live.adapter);
  if (wanted.has('bufferSize')) sources.bufferSize = count('bufferSize', () => live.buffer);
  if (wanted.has('cssSize')) sources.cssSize = count('cssSize', () => live.css);
  if (wanted.has('renderScale')) {
    sources.renderScale = count('renderScale', () => live.renderScale);
  }
  if (wanted.has('quality')) sources.quality = count('quality', () => live.quality);
  if (wanted.has('adaptiveOverrides')) {
    sources.adaptiveOverrides = count('adaptiveOverrides', () => live.overrides);
  }
  if (wanted.has('scaler')) sources.scaler = count('scaler', () => live.scaler);
  if (wanted.has('ecsCounts')) sources.ecsCounts = count('ecsCounts', () => live.ecs);
  if (wanted.has('systemTimings')) {
    sources.systemTimings = count('systemTimings', () => live.timings);
  }
  if (wanted.has('capabilities')) sources.capabilities = count('capabilities', () => live.caps);
  if (wanted.has('onProfilingChange')) sources.onProfilingChange = profiling;

  return { live, calls, profiling, sources };
}

// ---- DOM readers --------------------------------------------------------

let host: HTMLElement;
let uiRoot: HTMLElement;
let overlays: DiagnosticsOverlay[] = [];

function build(sources: DiagnosticsSources, explicitHost: HTMLElement = host) {
  const overlay = new DiagnosticsOverlay(sources, explicitHost);
  overlays.push(overlay);
  return overlay;
}

/** Constructs with no host argument, exercising the `#ui-root` default. */
function buildDefaultHost(sources: DiagnosticsSources) {
  const overlay = new DiagnosticsOverlay(sources);
  overlays.push(overlay);
  return overlay;
}

/**
 * The width jsdom reports back for a meter fill.
 *
 * The source writes `toFixed(1)` percentages, but jsdom's CSS serialiser drops
 * a trailing `.0`, so `50.0%` reads back as `50%`. Asserted as jsdom reports it
 * rather than as the source wrote it.
 */
function meterWidth(index: number): string {
  return meterFills()[index].style.width;
}

/**
 * Ledger of the overlay's status timeouts, so a leak is provable.
 *
 * A raw `vi.getTimerCount()` cannot be used: jsdom arms its own timers for the
 * `focus()` and `select()` calls on the fallback textarea, so the only way to
 * isolate the overlay's timer is to key on its distinctive delay. Modelled on
 * the listener ledger in `renderContext.test.ts`.
 */
interface TimerLedger {
  readonly armed: number[];
  readonly cleared: number[];
}

function trackStatusTimers(): TimerLedger {
  const armed: number[] = [];
  const cleared: number[] = [];
  const realSet = window.setTimeout.bind(window);
  const realClear = window.clearTimeout.bind(window);

  vi.spyOn(window, 'setTimeout').mockImplementation(((
    handler: TimerHandler,
    delay?: number,
    ...rest: unknown[]
  ) => {
    const id = realSet(handler as never, delay as never, ...(rest as never[]));
    if (delay === STATUS_CLEAR_MS) armed.push(id as unknown as number);
    return id;
  }) as typeof window.setTimeout);

  vi.spyOn(window, 'clearTimeout').mockImplementation(((id?: number) => {
    if (id !== undefined && armed.includes(id)) cleared.push(id);
    realClear(id as never);
  }) as typeof window.clearTimeout);

  return { armed, cleared };
}

/** Status timeouts that were armed and never cleared. */
function pendingStatusTimers(ledger: TimerLedger): number[] {
  return ledger.armed.filter((id) => !ledger.cleared.includes(id));
}

function panel(within: HTMLElement = host): HTMLElement {
  const found = within.querySelector<HTMLElement>('.diag');
  if (!found) throw new Error('diagnostics panel was not appended to the host');
  return found;
}

function sectionTitles(root: HTMLElement = panel()): string[] {
  return [...root.querySelectorAll('.diag__section-title')].map((n) => n.textContent ?? '');
}

/** The value element of the first row carrying `label`. */
function valueEl(label: string, root: HTMLElement = panel()): HTMLElement {
  for (const row of root.querySelectorAll('.diag__row')) {
    if (row.querySelector('.diag__label')?.textContent === label) {
      return row.querySelector<HTMLElement>('.diag__value')!;
    }
  }
  throw new Error(
    `no diagnostics row labelled "${label}" (present: ${labels(root).join(', ') || 'none'})`,
  );
}

function value(label: string, root: HTMLElement = panel()): string {
  return valueEl(label, root).textContent ?? '';
}

function state(label: string, root: HTMLElement = panel()): string {
  const className = valueEl(label, root).className;
  const match = /diag__value--(\w+)/.exec(className);
  return match ? match[1] : 'none';
}

function labels(root: HTMLElement = panel()): string[] {
  return [...root.querySelectorAll('.diag__label')].map((n) => n.textContent ?? '');
}

function hasRow(label: string, root: HTMLElement = panel()): boolean {
  return labels(root).includes(label);
}

function meterFills(root: HTMLElement = panel()): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.diag__meter-fill')];
}

function button(text: string, root: HTMLElement = panel()): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((b) => b.textContent === text);
  if (!found) throw new Error(`no diagnostics button labelled "${text}"`);
  return found as HTMLButtonElement;
}

function statusEl(root: HTMLElement = panel()): HTMLElement {
  return root.querySelector<HTMLElement>('.diag__status')!;
}

function fallbackEl(root: HTMLElement = panel()): HTMLTextAreaElement {
  return root.querySelector<HTMLTextAreaElement>('.diag__fallback')!;
}

/** Shows the panel and drives one refresh. */
function shown(overlay: DiagnosticsOverlay): DiagnosticsOverlay {
  overlay.show();
  overlay.update(FRAME_S);
  return overlay;
}

/** Advances past the refresh interval and refreshes once. */
function advanceOneRefresh(overlay: DiagnosticsOverlay): void {
  overlay.update(REFRESH_MS / 1000);
}

// ---- Setup --------------------------------------------------------------

beforeEach(() => {
  uiRoot = document.createElement('div');
  uiRoot.id = 'ui-root';
  host = document.createElement('div');
  document.body.append(uiRoot, host);
  overlays = [];
});

afterEach(() => {
  for (const overlay of overlays) overlay.dispose();
  overlays = [];
  uiRoot.remove();
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---- Construction -------------------------------------------------------

describe('DiagnosticsOverlay construction', () => {
  it('mounts into #ui-root by default', () => {
    buildDefaultHost(fixture().sources);
    expect(uiRoot.querySelector('.diag')).not.toBeNull();
  });

  it('fails loudly when the default host is missing', () => {
    uiRoot.remove();
    // A silent no-mount would look like a broken hotkey later on.
    expect(() => buildDefaultHost(fixture().sources)).toThrow(/#ui-root/);
  });

  it('mounts hidden, labelled as a region, into an explicit host', () => {
    const overlay = build(fixture().sources);
    const root = panel();

    expect(root.parentElement).toBe(host);
    expect(root.classList.contains('diag--hidden')).toBe(true);
    expect(overlay.isVisible).toBe(false);
    expect(root.getAttribute('role')).toBe('region');
    expect(root.getAttribute('aria-label')).toBe('Developer diagnostics');
  });

  it('reads no provider during construction', () => {
    const f = fixture();
    build(f.sources);
    // Construction happens during boot, before the systems being measured are
    // necessarily safe to poll.
    expect(f.calls).toEqual({});
    expect(f.profiling).not.toHaveBeenCalled();
  });

  it('shows only Frame and Build with the minimum source bag', () => {
    build(fixture([]).sources);
    expect(sectionTitles()).toEqual(['Frame', 'Build']);
    // No zeros pretending to be readings.
    expect(hasRow('backend')).toBe(false);
    expect(hasRow('draw calls')).toBe(false);
    expect(hasRow('preset')).toBe(false);
    expect(hasRow('steps last frame')).toBe(false);
  });

  it('builds every section when every provider is present', () => {
    build(fixture().sources);
    expect(sectionTitles()).toEqual([
      'Frame',
      'Renderer',
      'Quality',
      'Budgets',
      'Loop',
      'World',
      'Systems',
      'Build',
    ]);
  });

  it.each<[keyof DiagnosticsSources, string[]]>([
    ['loop', ['Loop']],
    ['ecsCounts', ['World']],
    ['systemTimings', ['Systems']],
    ['render', ['Renderer', 'Budgets']],
    ['quality', ['Quality']],
    ['scaler', ['Quality']],
    ['backend', ['Renderer']],
    ['capabilities', ['Renderer']],
  ])('adds %s section(s) only when that provider exists', (provider, expected) => {
    build(fixture([provider]).sources);
    for (const title of expected) {
      expect(sectionTitles(), `${provider} should build ${title}`).toContain(title);
    }
  });

  it('populates the static build rows before the panel is ever shown', () => {
    build(fixture().sources);
    // These never change, so they are written once instead of at 5 Hz.
    expect(value('commit')).toBe(BUILD_INFO.commit);
    expect(value('version')).toBe(BUILD_INFO.version);
    expect(value('mode')).toBe(BUILD_INFO.mode);
    expect(value('built')).toBe(BUILD_INFO.buildTime);
    expect(panel().querySelector('.diag__identity')?.textContent).toBe(formatBuildIdentity());
  });

  it('starts every dynamic row blank rather than at zero', () => {
    build(fixture().sources);
    for (const label of ['fps', 'frame', 'backend', 'draw calls', 'preset']) {
      expect(value(label), label).toBe(MISSING);
      expect(state(label), label).toBe('neutral');
    }
  });

  it('warns in the Systems section when no profiling hook is wired', () => {
    build(fixture(['systemTimings']).sources);
    // GameWorld zeroes timings while profiling is off, and without the hook
    // this overlay cannot switch it on — so it says so instead of lying.
    expect(panel().querySelector('.diag__note')?.textContent).toMatch(/no profiling hook/);
  });

  it('omits the warning when the hook is present', () => {
    build(fixture(['systemTimings', 'onProfilingChange']).sources);
    expect(panel().querySelector('.diag__note')).toBeNull();
  });

  it('gives the adaptive overrides sub-list its own heading and summary row', () => {
    build(fixture(['adaptiveOverrides']).sources);
    expect(panel().querySelector('.diag__subhead')?.textContent).toBe('adaptive overrides');
    expect(hasRow('active')).toBe(true);
  });
});

// ---- Visibility ---------------------------------------------------------

describe('DiagnosticsOverlay visibility', () => {
  it('shows, hides and toggles, driving the profiling hook once per transition', () => {
    const f = fixture();
    const overlay = build(f.sources);
    const root = panel();

    overlay.show();
    expect(overlay.isVisible).toBe(true);
    expect(root.classList.contains('diag--hidden')).toBe(false);
    expect(f.profiling.mock.calls).toEqual([[true]]);

    overlay.show();
    // Idempotent: profiling must not be re-armed by a repeated hotkey press.
    expect(f.profiling.mock.calls).toEqual([[true]]);

    overlay.hide();
    expect(overlay.isVisible).toBe(false);
    expect(root.classList.contains('diag--hidden')).toBe(true);
    expect(f.profiling.mock.calls).toEqual([[true], [false]]);

    overlay.hide();
    expect(f.profiling.mock.calls).toEqual([[true], [false]]);

    overlay.toggle();
    expect(overlay.isVisible).toBe(true);
    overlay.toggle();
    expect(overlay.isVisible).toBe(false);
    expect(f.profiling.mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  it('does not switch profiling on for a hide that never had a show', () => {
    const f = fixture();
    build(f.sources).hide();
    expect(f.profiling).not.toHaveBeenCalled();
    expect(panel().classList.contains('diag--hidden')).toBe(true);
  });

  it('reads nothing at all while hidden', () => {
    const f = fixture();
    const overlay = build(f.sources);

    for (let i = 0; i < 60; i += 1) overlay.update(FRAME_S);

    // The panel must cost nothing when closed — this is measured on phones.
    expect(f.calls).toEqual({});
    expect(value('fps')).toBe(MISSING);
  });

  it('closes when the Close button is pressed', () => {
    const overlay = build(fixture().sources);
    overlay.show();
    button('Close').dispatchEvent(new MouseEvent('click'));
    expect(overlay.isVisible).toBe(false);
  });
});

// ---- Refresh cadence ----------------------------------------------------

describe('DiagnosticsOverlay refresh cadence', () => {
  it('paints immediately on the first frame after show', () => {
    const f = fixture();
    const overlay = build(f.sources);

    overlay.show();
    overlay.update(FRAME_S);

    // Primed accumulator: waiting up to 200 ms for the first reading would
    // make the panel look broken when opened.
    expect(f.calls.frameStats).toBe(1);
    expect(value('fps')).toBe('59.4');
  });

  it('holds a reading until the refresh interval has accumulated', () => {
    const f = fixture();
    const overlay = shown(build(f.sources));
    expect(f.calls.frameStats).toBe(1);

    f.live.frame = { ...f.live.frame, fps: 30 };
    // 150 ms of frames: still inside the interval.
    for (let i = 0; i < 3; i += 1) overlay.update(0.05);
    expect(f.calls.frameStats).toBe(1);
    expect(value('fps')).toBe('59.4');

    overlay.update(0.05);
    expect(f.calls.frameStats).toBe(2);
    expect(value('fps')).toBe('30.0');
  });

  it('refreshes once after a long stall instead of bursting catch-up refreshes', () => {
    const f = fixture();
    const overlay = shown(build(f.sources));
    const before = f.calls.frameStats ?? 0;

    overlay.update(2);

    expect(f.calls.frameStats).toBe(before + 1);
  });

  it('falls back to the clock when the caller has no frame delta', () => {
    const f = fixture();
    const overlay = build(f.sources);
    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(1000);

    overlay.show();
    overlay.update();
    expect(f.calls.frameStats).toBe(1);

    nowSpy.mockReturnValue(1100);
    overlay.update();
    expect(f.calls.frameStats).toBe(1);

    nowSpy.mockReturnValue(1301);
    overlay.update();
    expect(f.calls.frameStats).toBe(2);
  });

  it('writes to the DOM only when a formatted value actually changed', () => {
    const f = fixture();
    const overlay = shown(build(f.sources));

    // Count assignments on the live fps node: the panel is built once and only
    // changed strings are written, which is why it is cheap enough to leave on.
    const node = valueEl('fps');
    let text = node.textContent;
    let writes = 0;
    Object.defineProperty(node, 'textContent', {
      configurable: true,
      get: () => text,
      set: (next: string) => {
        writes += 1;
        text = next;
      },
    });

    advanceOneRefresh(overlay);
    expect(writes).toBe(0);

    f.live.frame = { ...f.live.frame, fps: 44.44 };
    advanceOneRefresh(overlay);
    expect(writes).toBe(1);
    expect(value('fps')).toBe('44.4');
  });
});

// ---- Displayed values ---------------------------------------------------

describe('DiagnosticsOverlay frame readings', () => {
  it('formats every frame figure to a fixed width', () => {
    shown(build(fixture().sources));

    expect(value('fps')).toBe('59.4');
    expect(value('average fps')).toBe('58.3');
    expect(value('1% low fps')).toBe('41.5');
    expect(value('frame')).toBe('16.84 ms');
    expect(value('average frame')).toBe('17.16 ms');
    expect(value('worst frame')).toBe('48.13 ms');
    expect(value('long frames')).toBe('3');
  });

  it('renders a non-finite reading as blank rather than NaN', () => {
    const f = fixture();
    f.live.frame = { ...f.live.frame, fps: Number.NaN, frameMs: Number.POSITIVE_INFINITY };
    shown(build(f.sources));

    expect(value('fps')).toBe(MISSING);
    expect(value('frame')).toBe(MISSING);
  });

  it('groups large counts with a device-independent separator', () => {
    const f = fixture();
    f.live.frame = { ...f.live.frame, longFrames: 1_234_567 };
    shown(build(f.sources));
    // Hand-grouped rather than toLocaleString, so pasted reports compare
    // across phones.
    expect(value('long frames')).toBe('1,234,567');
  });

  it.each([
    [60, 'nominal', 'holding target'],
    [58, 'nominal', 'within 5% of target'],
    [50, 'neutral', 'between the bands'],
    [40, 'fault', 'clearly below target'],
  ])('states fps %s as %s (%s)', (fps, expected) => {
    const f = fixture();
    f.live.frame = { ...f.live.frame, fps };
    shown(build(f.sources));
    expect(state('fps')).toBe(expected);
  });

  it('leaves fps unstated when no target is known', () => {
    const f = fixture(['onProfilingChange']);
    shown(build(f.sources));
    // No quality provider means no target, and colouring against a guess
    // would be worse than colouring against nothing.
    expect(state('fps')).toBe('neutral');
  });
});

describe('DiagnosticsOverlay renderer readings', () => {
  it('reports the backend that came up, not the one requested', () => {
    const f = fixture();
    f.live.backend = { requested: 'webgpu', actual: 'webgl2', forcedByUser: false };
    shown(build(f.sources));
    expect(value('backend')).toBe('webgl2 · fallback from webgpu');
  });

  it('marks a user-forced backend as forced', () => {
    const f = fixture();
    f.live.backend = { requested: 'webgl2', actual: 'webgl2', forcedByUser: true };
    shown(build(f.sources));
    expect(value('backend')).toBe('webgl2 · forced');
  });

  it('reports a plain backend when nothing unusual happened', () => {
    shown(build(fixture().sources));
    expect(value('backend')).toBe('webgpu');
  });

  it.each([
    ['a null adapter', null],
    ['an empty adapter string', ''],
  ])('shows "unknown" for %s', (_label, adapter) => {
    const f = fixture();
    f.live.adapter = adapter;
    shown(build(f.sources));
    expect(value('adapter')).toBe('unknown');
  });

  it('summarises the device from capabilities', () => {
    shown(build(fixture().sources));
    expect(value('device')).toBe('desktop · dpr 2.00 · 8t');
  });

  it('flags touch devices and unknown thread counts in the device summary', () => {
    const f = fixture();
    f.live.caps = {
      ...f.live.caps!,
      deviceClass: 'phone',
      touchCapable: true,
      devicePixelRatio: 2.625,
      cpuThreads: null,
    };
    shown(build(f.sources));
    expect(value('device')).toBe('phone · touch · dpr 2.63');
  });

  it('shows buffer and css sizes and the render scale', () => {
    shown(build(fixture().sources));
    expect(value('buffer')).toBe('1,920 × 1,080');
    expect(value('css size')).toBe('1,280 × 720');
    // The dedicated provider wins over the preset's nominal value.
    expect(value('render scale')).toBe('0.875');
  });

  it('shows render scale from the quality provider alone', () => {
    // Regression: the Renderer section gate omitted `quality`, so an overlay
    // wired with only frame stats and quality dropped a value it had computed
    // and formatted — while the copied text report still printed it.
    const f = fixture(['quality']);
    shown(build(f.sources));

    expect(hasRow('render scale')).toBe(true);
    expect(value('render scale')).toBe('0.900');
  });

  it('shows geometry and texture counts', () => {
    shown(build(fixture().sources));
    expect(value('geometries')).toBe('143');
    expect(value('textures')).toBe('88');
  });
});

describe('DiagnosticsOverlay quality and scaler readings', () => {
  it('shows the preset and its tiers', () => {
    shown(build(fixture().sources));
    expect(value('preset')).toBe('high');
    expect(value('target fps')).toBe('60');
    expect(value('shadow tier')).toBe('3');
    expect(value('texture tier')).toBe('4');
  });

  it('states a scaler sitting at the preset as nominal', () => {
    shown(build(fixture().sources));
    expect(value('scaler level')).toBe('0/4 at preset');
    expect(state('scaler level')).toBe('nominal');
    expect(value('deficit')).toBe('0.00 s');
    expect(value('headroom')).toBe('1.50 s');
    expect(value('decisions')).toBe('6');
  });

  it('states an engaged scaler as a fault and names the applied level', () => {
    const f = fixture();
    f.live.scaler = {
      ...f.live.scaler,
      level: 2,
      currentLabel: 'shadows off',
      deficitSeconds: 3.5,
    };
    shown(build(f.sources));
    // Reduced quality is a finding, not a normal state.
    expect(value('scaler level')).toBe('2/4 shadows off');
    expect(state('scaler level')).toBe('fault');
    expect(value('deficit')).toBe('3.50 s');
  });

  it('says so when dynamic scaling is switched off', () => {
    const f = fixture();
    f.live.scaler = { ...f.live.scaler, enabled: false };
    shown(build(f.sources));
    expect(value('scaler level')).toBe('disabled');
  });
});

describe('DiagnosticsOverlay adaptive overrides', () => {
  it('reads none when nothing is applied', () => {
    shown(build(fixture().sources));
    expect(value('active')).toBe('none');
  });

  it('lists each applied override as a fault and formats it by type', () => {
    const f = fixture();
    f.live.overrides = {
      shadowTier: 0,
      renderScale: 0.6666,
      ssao: false,
      triangleBudget: 120_000,
      // Nulls mean "follow the preset" and must not be listed as reductions.
      textureTier: null,
      targetFps: undefined,
    };
    shown(build(f.sources));

    expect(value('active')).toBe('4 applied');
    expect(value('shadowTier')).toBe('0');
    expect(value('renderScale')).toBe('0.667');
    expect(value('ssao')).toBe('off');
    expect(value('triangleBudget')).toBe('120,000');
    expect(state('shadowTier')).toBe('fault');
    expect(hasRow('textureTier')).toBe(false);
    expect(hasRow('targetFps')).toBe(false);
  });

  it('blanks a dropped override instead of removing its row', () => {
    const f = fixture();
    f.live.overrides = { shadowTier: 1 };
    const overlay = shown(build(f.sources));
    expect(value('shadowTier')).toBe('1');

    f.live.overrides = {};
    advanceOneRefresh(overlay);

    // Removing the node would make the panel jump as the scaler recovers.
    expect(hasRow('shadowTier')).toBe(true);
    expect(value('shadowTier')).toBe(MISSING);
    expect(state('shadowTier')).toBe('neutral');
    expect(value('active')).toBe('none');
  });

  it('reuses the same row when an override returns', () => {
    const f = fixture();
    f.live.overrides = { shadowTier: 1 };
    const overlay = shown(build(f.sources));
    const first = valueEl('shadowTier');

    f.live.overrides = {};
    advanceOneRefresh(overlay);
    f.live.overrides = { shadowTier: 0 };
    advanceOneRefresh(overlay);

    expect(valueEl('shadowTier')).toBe(first);
    expect(value('shadowTier')).toBe('0');
    expect(labels().filter((l) => l === 'shadowTier')).toHaveLength(1);
  });
});

describe('DiagnosticsOverlay budgets', () => {
  it('shows a within-budget reading as nominal with a proportional meter', () => {
    const f = fixture();
    f.live.render = { ...f.live.render, drawCalls: 480 };
    f.live.quality = { ...f.live.quality, drawCallBudget: 960 };
    shown(build(f.sources));

    expect(value('draw calls')).toBe('480 / 960');
    expect(state('draw calls')).toBe('nominal');
    expect(meterWidth(0)).toBe('50%');
    expect(meterFills()[0].className).toContain('diag__meter-fill--nominal');
  });

  it('flags an over-budget reading and clamps the meter', () => {
    const f = fixture();
    f.live.render = { ...f.live.render, triangles: 1_500_000 };
    shown(build(f.sources));

    expect(value('triangles')).toBe('1,500,000 / 500,000');
    expect(state('triangles')).toBe('fault');
    expect(meterWidth(1)).toBe('100%');
    expect(meterFills()[1].className).toContain('diag__meter-fill--fault');
  });

  it('shows a bare count with an empty meter when no budget is known', () => {
    const f = fixture(['render']);
    shown(build(f.sources));

    // Without a preset there is nothing to pass or fail against, so the panel
    // reports rather than judges.
    expect(value('draw calls')).toBe('480');
    expect(state('draw calls')).toBe('neutral');
    expect(meterWidth(0)).toBe('0%');
  });

  it('treats a zero budget as no budget', () => {
    const f = fixture();
    f.live.quality = { ...f.live.quality, drawCallBudget: 0 };
    shown(build(f.sources));
    expect(value('draw calls')).toBe('480');
    expect(state('draw calls')).toBe('neutral');
  });

  it('moves the meter as the reading changes', () => {
    const f = fixture();
    const overlay = shown(build(f.sources));
    expect(meterWidth(0)).toBe('50%');

    f.live.render = { ...f.live.render, drawCalls: 240 };
    advanceOneRefresh(overlay);
    expect(meterWidth(0)).toBe('25%');

    // A fractional ratio keeps one decimal, so the meter tracks small drifts.
    f.live.render = { ...f.live.render, drawCalls: 481 };
    advanceOneRefresh(overlay);
    expect(meterWidth(0)).toBe('50.1%');
  });
});

describe('DiagnosticsOverlay loop, world and systems', () => {
  it('shows loop counters and dropped time', () => {
    shown(build(fixture().sources));
    expect(value('steps last frame')).toBe('2');
    expect(value('total steps')).toBe('24,680');
    expect(value('dropped time')).toBe('0.13 s');
    expect(value('overload frames')).toBe('4');
  });

  it('creates a world row per ECS count, lazily', () => {
    const f = fixture();
    const overlay = shown(build(f.sources));
    expect(value('entities')).toBe('1,240');
    expect(value('meshes')).toBe('310');
    expect(hasRow('colliders')).toBe(false);

    f.live.ecs = { ...f.live.ecs, colliders: 42 };
    advanceOneRefresh(overlay);
    expect(value('colliders')).toBe('42');
  });

  it('shows fixed and render milliseconds per system plus their total', () => {
    shown(build(fixture().sources));
    expect(value('physics')).toBe('2.50 / 0.00 ms');
    expect(value('render')).toBe('0.00 / 4.25 ms');
    expect(value('total')).toBe('6.75 ms');
  });

  it('adds a row when a new system appears and keeps the total honest', () => {
    const f = fixture();
    const overlay = shown(build(f.sources));

    f.live.timings = [...f.live.timings, { name: 'audio', fixedMs: 0.5, renderMs: 0.25 }];
    advanceOneRefresh(overlay);

    expect(value('audio')).toBe('0.50 / 0.25 ms');
    expect(value('total')).toBe('7.50 ms');
  });
});

// ---- Text report --------------------------------------------------------

describe('DiagnosticsOverlay text report', () => {
  it('is correct without the panel ever having been shown', () => {
    const overlay = build(fixture().sources);
    const report = overlay.buildTextReport();

    // Providers are read directly rather than the DOM being scraped, so a
    // bug report can be captured from a hotkey without opening the panel.
    expect(report.startsWith(formatBuildIdentity())).toBe(true);
    expect(report).toContain('[frame]');
    expect(report).toMatch(/fps\s+59\.4/);
    expect(value('fps')).toBe(MISSING);
  });

  it('records build identity, capture time and environment', () => {
    const report = build(fixture().sources).buildTextReport();
    expect(report).toContain(`commit           ${BUILD_INFO.commit}`);
    expect(report).toContain(`mode             ${BUILD_INFO.mode}`);
    expect(report).toMatch(/captured\s+\d{4}-\d{2}-\d{2}T/);
    expect(report).toContain(navigator.userAgent);
    expect(report).toContain(location.href);
  });

  it('carries the readings the panel deliberately omits', () => {
    const report = build(fixture().sources).buildTextReport();

    // These are report-only by design: the panel is size-bounded, but a bug
    // report is not. Asserted so a future trim of the report is deliberate.
    expect(report).toMatch(/total frames\s+12,345/);
    expect(report).toMatch(/stable sample\s+yes/);
    expect(report).toMatch(/render calls\s+98,765/);
    expect(report).toMatch(/elapsed\s+411\.50 s/);
    expect(hasRow('total frames')).toBe(false);
    expect(hasRow('render calls')).toBe(false);
    expect(hasRow('elapsed')).toBe(false);
  });

  it('spells out whether each budget was met', () => {
    const f = fixture();
    f.live.render = { ...f.live.render, drawCalls: 480, triangles: 750_000 };
    const report = build(f.sources).buildTextReport();

    expect(report).toContain('480 / 960 (50%) under');
    expect(report).toContain('750,000 / 500,000 (150%) OVER');
  });

  it('appends the full capability dump', () => {
    const report = build(fixture().sources).buildTextReport();
    expect(report).toContain('[capabilities]');
    expect(report).toContain('gpu           Test GPU');
    expect(report).toContain('ktx2 targets  etc, bc7');
  });

  it('omits sections whose providers are absent', () => {
    const report = build(fixture([]).sources).buildTextReport();

    expect(report).toContain('[frame]');
    expect(report).not.toContain('[renderer]');
    expect(report).not.toContain('[quality]');
    expect(report).not.toContain('[scaler]');
    expect(report).not.toContain('[loop]');
    expect(report).not.toContain('[world]');
    expect(report).not.toContain('[adaptive]');
    expect(report).not.toContain('[capabilities]');
  });

  it('records an empty adaptive section as none rather than dropping it', () => {
    const report = build(fixture(['adaptiveOverrides']).sources).buildTextReport();
    expect(report).toContain('[adaptive]');
    expect(report).toMatch(/active\s+none/);
  });

  it('reflects live provider values, not a construction-time snapshot', () => {
    const f = fixture();
    const overlay = build(f.sources);
    f.live.frame = { ...f.live.frame, fps: 12.5 };
    expect(overlay.buildTextReport()).toMatch(/fps\s+12\.5/);
  });
});

// ---- Copy ---------------------------------------------------------------

describe('DiagnosticsOverlay copy', () => {
  function stubClipboard(writeText: (text: string) => Promise<void>): ReturnType<typeof vi.fn> {
    const spy = vi.fn(writeText);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: spy },
    });
    return spy;
  }

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('writes the report to the clipboard and confirms', async () => {
    const writeText = stubClipboard(() => Promise.resolve());
    const overlay = build(fixture().sources);
    overlay.show();

    button('Copy Diagnostics').dispatchEvent(new MouseEvent('click'));
    await vi.waitFor(() => expect(statusEl().textContent).toBe('copied to clipboard'));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('[frame]');
    expect(statusEl().className).toContain('diag__status--nominal');
    expect(fallbackEl().hidden).toBe(true);
  });

  it('falls back to a selectable textarea when there is no clipboard API', () => {
    // A phone on a LAN address is not a secure context, so this is the path
    // that actually runs during Android testing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const overlay = build(fixture().sources);
    overlay.show();

    button('Copy Diagnostics').dispatchEvent(new MouseEvent('click'));

    const fallback = fallbackEl();
    expect(fallback.hidden).toBe(false);
    expect(fallback.value).toContain('[frame]');
    expect(fallback.readOnly).toBe(true);
    expect(statusEl().textContent).toBe('clipboard unavailable — text selected, copy manually');
    expect(statusEl().className).toContain('diag__status--fault');
    warn.mockRestore();
  });

  it('falls back after a clipboard rejection and says why in the console', async () => {
    stubClipboard(() => Promise.reject(new Error('permission denied')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const overlay = build(fixture().sources);
    overlay.show();

    button('Copy Diagnostics').dispatchEvent(new MouseEvent('click'));
    await vi.waitFor(() => expect(fallbackEl().hidden).toBe(false));

    expect(warn).toHaveBeenCalled();
    expect(fallbackEl().value).toContain('[frame]');
  });

  it('reports a successful synchronous fallback copy', () => {
    vi.stubGlobal('document', document);
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });

    const overlay = build(fixture().sources);
    overlay.show();
    button('Copy Diagnostics').dispatchEvent(new MouseEvent('click'));

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(statusEl().textContent).toBe('copied (fallback)');
    expect(statusEl().className).toContain('diag__status--nominal');
    Reflect.deleteProperty(document, 'execCommand');
  });

  it('clears the status line after its display window', () => {
    vi.useFakeTimers();
    const overlay = build(fixture().sources);
    overlay.show();
    button('Copy Diagnostics').dispatchEvent(new MouseEvent('click'));
    expect(statusEl().textContent).not.toBe('');

    vi.advanceTimersByTime(STATUS_CLEAR_MS - 1);
    expect(statusEl().textContent).not.toBe('');

    vi.advanceTimersByTime(1);
    expect(statusEl().textContent).toBe('');
    expect(statusEl().className).toBe('diag__status');
    expect(fallbackEl().hidden).toBe(true);
  });

  it('does not leave a pending status timer when the panel is hidden', () => {
    vi.useFakeTimers();
    const timers = trackStatusTimers();
    const overlay = build(fixture().sources);
    overlay.show();
    button('Copy Diagnostics').dispatchEvent(new MouseEvent('click'));
    expect(timers.armed).toHaveLength(1);

    overlay.hide();

    expect(pendingStatusTimers(timers)).toEqual([]);
    expect(statusEl().textContent).toBe('');
    expect(fallbackEl().hidden).toBe(true);
  });
});

// ---- Teardown -----------------------------------------------------------

describe('DiagnosticsOverlay dispose', () => {
  it('removes the panel and switches profiling back off', () => {
    const f = fixture();
    const overlay = build(f.sources);
    const root = panel();
    overlay.show();

    overlay.dispose();

    expect(root.parentElement).toBeNull();
    expect(host.querySelector('.diag')).toBeNull();
    expect(overlay.isVisible).toBe(false);
    expect(f.profiling.mock.calls).toEqual([[true], [false]]);
  });

  it('does not touch profiling when disposing a panel that was never shown', () => {
    const f = fixture();
    build(f.sources).dispose();
    expect(f.profiling).not.toHaveBeenCalled();
  });

  it('clears a pending status timer', () => {
    vi.useFakeTimers();
    const timers = trackStatusTimers();
    const overlay = build(fixture().sources);
    overlay.show();
    button('Copy Diagnostics').dispatchEvent(new MouseEvent('click'));
    expect(timers.armed).toHaveLength(1);

    overlay.dispose();

    expect(pendingStatusTimers(timers)).toEqual([]);
  });

  it('reads no provider after disposal', () => {
    const f = fixture();
    const overlay = shown(build(f.sources));
    const before = { ...f.calls };

    overlay.dispose();
    for (let i = 0; i < 10; i += 1) overlay.update(FRAME_S);

    expect(f.calls).toEqual(before);
  });

  it('cannot be re-shown after disposal', () => {
    // Regression: show() had no post-dispose guard, so a stale hotkey handler
    // could switch per-system profiling back on with no panel on screen and
    // no owner left to switch it off again.
    const f = fixture();
    const overlay = shown(build(f.sources));
    overlay.dispose();
    f.profiling.mockClear();

    overlay.show();
    overlay.toggle();
    overlay.update(1);

    expect(overlay.isVisible).toBe(false);
    expect(f.profiling).not.toHaveBeenCalled();
  });

  it('does not regrow rows after disposal', () => {
    const f = fixture();
    const overlay = shown(build(f.sources));
    const root = panel();
    const rowCount = root.querySelectorAll('.diag__row').length;

    overlay.dispose();
    overlay.show();
    for (let i = 0; i < 5; i += 1) overlay.update(1);

    // The row map is cleared by dispose, so a live refresh would re-create
    // every world/system row into the detached tree on every pass.
    expect(root.querySelectorAll('.diag__row').length).toBe(rowCount);
  });

  it('arms no timer when the copy button is pressed after disposal', () => {
    // Regression: el() keeps no handle on the listeners it attaches and
    // remove() only detaches the node, so both head buttons stay live on the
    // detached tree. A post-dispose copy click armed a status timeout that
    // nothing would ever clear.
    vi.useFakeTimers();
    const timers = trackStatusTimers();
    const overlay = build(fixture().sources);
    overlay.show();
    const root = panel();
    const copy = button('Copy Diagnostics', root);

    overlay.dispose();
    copy.dispatchEvent(new MouseEvent('click'));

    // The panel is detached by now, so the ledger is the only witness: an
    // armed timeout here would be unreachable and never cleared.
    expect(timers.armed).toEqual([]);
    expect(statusEl(root).textContent).toBe('');
    expect(fallbackEl(root).hidden).toBe(true);
  });

  it('is safe to dispose twice', () => {
    const f = fixture();
    const overlay = shown(build(f.sources));

    overlay.dispose();
    expect(() => overlay.dispose()).not.toThrow();
    expect(f.profiling.mock.calls).toEqual([[true], [false]]);
  });
});
