/**
 * RenderContext lifecycle, sizing and teardown tests.
 *
 * RenderContext is the first thing the next milestone wires, so an untested
 * renderer makes every future black screen ambiguous between renderer, loop
 * and scene. These tests pin the contract the rest of the engine codes
 * against:
 *
 *   - two-phase construction (sync constructor, async idempotent `init`)
 *   - `render()` before `init()` fails loudly instead of drawing nothing
 *   - buffer size == cssSize * min(devicePixelRatio, maxPixelRatio) * renderScale
 *   - `dispose()` removes EVERY listener it registered, including the
 *     orientationchange handler that used to outlive the context
 *
 * jsdom has neither WebGL2 nor WebGPU, so the GPU is mocked at exactly one
 * boundary: the `three/webgpu` renderer class. Everything under test —
 * sizing maths, clamping, camera updates, backend read-back, listener
 * bookkeeping — is the real RenderContext code. `devicePixelRatio` and the
 * host element's rect are driven explicitly because jsdom reports 1 and a
 * zero-size rect respectively.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Shared state between the tests and the hoisted `three/webgpu` mock.
 * `vi.hoisted` runs before `vi.mock`, which is what makes this legal.
 */
const gpu = vi.hoisted(() => ({
  /** Every renderer the mock has constructed, in order. */
  instances: [] as any[],
  /** Which backend `init()` should report coming up. */
  backendKind: 'webgpu' as 'webgpu' | 'webgl2',
  /** Optional WebGPU adapter info for the diagnostics path. */
  adapterInfo: null as { vendor?: string; architecture?: string; device?: string } | null,
  reset(): void {
    this.instances = [];
    this.backendKind = 'webgpu';
    this.adapterInfo = null;
  },
}));

vi.mock('three/webgpu', () => {
  class FakeWebGPURenderer {
    readonly domElement: HTMLCanvasElement = document.createElement('canvas');
    readonly parameters: Record<string, unknown>;

    backend: Record<string, unknown> = {};
    // Fields RenderContext assigns during construction.
    toneMapping = 0;
    toneMappingExposure = 0;
    outputColorSpace = '';
    shadowMap: { enabled: boolean; type: number } = { enabled: false, type: -1 };
    info = {
      render: { drawCalls: 7, triangles: 1234, lines: 2, points: 3, calls: 11 },
      memory: { geometries: 5, textures: 9 },
    };

    initCalls = 0;
    disposeCalls = 0;
    renderCalls = 0;
    setSizeCalls: Array<{ width: number; height: number; updateStyle: boolean }> = [];
    private pixelRatio = 1;

    constructor(parameters: Record<string, unknown>) {
      this.parameters = parameters;
      gpu.instances.push(this);
    }

    async init(): Promise<void> {
      this.initCalls += 1;
      // A microtask, so a caller that forgets to await really is mid-flight.
      await Promise.resolve();
      this.backend =
        gpu.backendKind === 'webgpu'
          ? { isWebGPUBackend: true, adapter: gpu.adapterInfo ? { info: gpu.adapterInfo } : undefined }
          : { isWebGLBackend: true };
    }

    setPixelRatio(ratio: number): void {
      this.pixelRatio = ratio;
    }

    getPixelRatio(): number {
      return this.pixelRatio;
    }

    setSize(width: number, height: number, updateStyle: boolean): void {
      this.setSizeCalls.push({ width, height, updateStyle });
    }

    render(): void {
      this.renderCalls += 1;
    }

    dispose(): void {
      this.disposeCalls += 1;
    }
  }

  return { WebGPURenderer: FakeWebGPURenderer };
});

// Imported after the mock is declared; vi.mock is hoisted above this anyway.
import { RenderContext } from '../../src/engine/render/RenderContext';

/** The mock instance backing a context, typed loosely on purpose. */
function fakeRenderer(ctx: RenderContext): any {
  return ctx.renderer as unknown as any;
}

let host: HTMLElement;
let hostRect = { width: 800, height: 600 };

/** Records every window listener add/remove so leaks are provable. */
interface Registration {
  type: string;
  handler: unknown;
}
let added: Registration[] = [];
let removed: Registration[] = [];

function setHostSize(width: number, height: number): void {
  hostRect = { width, height };
}

function setDevicePixelRatio(value: number): void {
  Object.defineProperty(window, 'devicePixelRatio', {
    configurable: true,
    writable: true,
    value,
  });
}

/** Listeners the context added but never removed. */
function leakedListeners(): Registration[] {
  const leaked: Registration[] = [];
  const outstanding = [...removed];
  for (const registration of added) {
    const index = outstanding.findIndex(
      (r) => r.type === registration.type && r.handler === registration.handler,
    );
    if (index === -1) leaked.push(registration);
    else outstanding.splice(index, 1);
  }
  return leaked;
}

function createContext(
  options: { forceWebgl2?: boolean; antialias?: boolean } = {},
): RenderContext {
  return new RenderContext({
    host,
    forceWebgl2: options.forceWebgl2 ?? false,
    antialias: options.antialias ?? true,
  });
}

async function createInitialised(
  options: { forceWebgl2?: boolean; antialias?: boolean } = {},
): Promise<RenderContext> {
  const ctx = createContext(options);
  await ctx.init();
  return ctx;
}

beforeEach(() => {
  gpu.reset();
  added = [];
  removed = [];
  setDevicePixelRatio(1);
  setHostSize(800, 600);

  host = document.createElement('div');
  document.body.appendChild(host);
  // jsdom has no layout, so the host would otherwise measure 0x0.
  host.getBoundingClientRect = () =>
    ({
      width: hostRect.width,
      height: hostRect.height,
      top: 0,
      left: 0,
      right: hostRect.width,
      bottom: hostRect.height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;

  // Bound copies of the real methods: jsdom rejects `Window.prototype.*.call`
  // because its global object is not the branded EventTarget instance, so the
  // ledger wraps the originals instead of re-entering the prototype.
  const realAdd = window.addEventListener.bind(window);
  const realRemove = window.removeEventListener.bind(window);

  vi.spyOn(window, 'addEventListener').mockImplementation(((
    type: string,
    handler: unknown,
    opts?: unknown,
  ) => {
    added.push({ type, handler });
    realAdd(type as any, handler as any, opts as any);
  }) as typeof window.addEventListener);

  vi.spyOn(window, 'removeEventListener').mockImplementation(((
    type: string,
    handler: unknown,
    opts?: unknown,
  ) => {
    removed.push({ type, handler });
    realRemove(type as any, handler as any, opts as any);
  }) as typeof window.removeEventListener);

  // The orientation handler re-applies size on the next frame; run it inline
  // so the test does not depend on jsdom's frame scheduling.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
});

afterEach(() => {
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('RenderContext construction', () => {
  it('constructs synchronously without touching the GPU', () => {
    const ctx = createContext();

    // Two-phase: the constructor may not acquire a device or attach a canvas.
    expect(fakeRenderer(ctx).initCalls).toBe(0);
    expect(host.children.length).toBe(0);
    expect(ctx.canvas).toBe(fakeRenderer(ctx).domElement);
    ctx.dispose();
  });

  it('passes antialias and the forced backend through to the renderer', () => {
    const ctx = createContext({ forceWebgl2: true, antialias: false });

    expect(fakeRenderer(ctx).parameters).toMatchObject({
      antialias: false,
      alpha: false,
      forceWebGL: true,
      powerPreference: 'high-performance',
    });
    ctx.dispose();
  });

  it('builds a scene and camera with the coastal fog defaults', () => {
    const ctx = createContext();

    expect(ctx.scene.fog).not.toBeNull();
    expect(ctx.camera.fov).toBe(70);
    expect(ctx.camera.near).toBeCloseTo(0.1, 6);
    expect(ctx.camera.far).toBe(600);
    // Shadows are configured up front rather than by the first quality apply.
    expect(fakeRenderer(ctx).shadowMap.enabled).toBe(true);
    ctx.dispose();
  });
});

describe('RenderContext.init', () => {
  it('acquires the device, attaches the canvas and hides it from a11y', async () => {
    const ctx = await createInitialised();

    expect(fakeRenderer(ctx).initCalls).toBe(1);
    expect(host.children.length).toBe(1);
    expect(host.firstElementChild).toBe(ctx.canvas);
    expect(ctx.canvas.getAttribute('aria-hidden')).toBe('true');
    ctx.dispose();
  });

  it('is idempotent: a second init does not re-acquire or re-attach', async () => {
    const ctx = createContext();

    await ctx.init();
    await ctx.init();
    await ctx.init();

    expect(fakeRenderer(ctx).initCalls).toBe(1);
    expect(host.children.length).toBe(1);
    ctx.dispose();
  });

  it('reports the backend that actually came up, not the one requested', async () => {
    gpu.backendKind = 'webgl2';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const ctx = await createInitialised({ forceWebgl2: false });

    const report = ctx.getBackendReport();
    expect(report.requested).toBe('webgpu');
    expect(report.actual).toBe('webgl2');
    expect(report.forcedByUser).toBe(false);
    expect(ctx.backend).toBe('webgl2');
    // The fallback is announced rather than passed off as WebGPU.
    expect(info).toHaveBeenCalled();
    ctx.dispose();
  });

  it('reports webgpu when the WebGPU backend comes up', async () => {
    gpu.backendKind = 'webgpu';
    const ctx = await createInitialised();

    expect(ctx.getBackendReport().actual).toBe('webgpu');
    expect(ctx.backend).toBe('webgpu');
    ctx.dispose();
  });

  it('marks a user-forced WebGL2 request as forced and not a fallback', async () => {
    gpu.backendKind = 'webgl2';
    const ctx = await createInitialised({ forceWebgl2: true });

    expect(ctx.getBackendReport()).toEqual({
      requested: 'webgl2',
      actual: 'webgl2',
      forcedByUser: true,
    });
    ctx.dispose();
  });
});

describe('RenderContext.render', () => {
  it('throws on the first call before init instead of drawing a black frame', () => {
    const ctx = createContext();

    expect(() => ctx.render()).toThrowError(/before init\(\)/);
    expect(fakeRenderer(ctx).renderCalls).toBe(0);
    ctx.dispose();
  });

  it('does not throw or log once per frame after the first report', () => {
    const ctx = createContext();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => ctx.render()).toThrow();
    // A render loop must not raise every frame, nor spam the console.
    for (let i = 0; i < 120; i += 1) expect(() => ctx.render()).not.toThrow();

    expect(fakeRenderer(ctx).renderCalls).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    ctx.dispose();
  });

  it('renders the scene with the camera once initialised', async () => {
    const ctx = await createInitialised();

    ctx.render();
    ctx.render();

    expect(fakeRenderer(ctx).renderCalls).toBe(2);
    ctx.dispose();
  });

  it('reports loudly again if render is called after dispose', async () => {
    const ctx = await createInitialised();
    ctx.render();
    ctx.dispose();

    // A disposed context has no device either, so silence would be the same
    // black-screen bug in a different shape.
    expect(() => ctx.render()).toThrowError(/before init\(\)/);
  });
});

describe('RenderContext sizing', () => {
  it('sizes the buffer as cssSize x min(dpr, maxPixelRatio) x renderScale', async () => {
    setDevicePixelRatio(3);
    setHostSize(800, 600);

    const ctx = await createInitialised();

    // dpr 3 clamped to the default max of 2 => buffer is 2x CSS size.
    expect(ctx.getCssSize()).toEqual({ width: 800, height: 600 });
    expect(ctx.getBufferSize()).toEqual({ width: 1600, height: 1200 });
    expect(fakeRenderer(ctx).getPixelRatio()).toBeCloseTo(2, 6);

    ctx.setRenderScale(0.5);
    // Render scale folds into the pixel ratio: 2 * 0.5 => 1.
    expect(ctx.getBufferSize()).toEqual({ width: 800, height: 600 });
    expect(ctx.getCssSize()).toEqual({ width: 800, height: 600 });
    ctx.dispose();
  });

  it('does not upscale past the device ratio when it is below the cap', async () => {
    setDevicePixelRatio(1);
    const ctx = await createInitialised();

    expect(ctx.getBufferSize()).toEqual({ width: 800, height: 600 });

    ctx.setMaxPixelRatio(4);
    // min(1, 4) is still 1: the cap is a ceiling, not a target.
    expect(ctx.getBufferSize()).toEqual({ width: 800, height: 600 });
    ctx.dispose();
  });

  it('applies a lowered max pixel ratio immediately', async () => {
    setDevicePixelRatio(4);
    const ctx = await createInitialised();
    expect(ctx.getBufferSize()).toEqual({ width: 1600, height: 1200 });

    ctx.setMaxPixelRatio(1);

    expect(ctx.getBufferSize()).toEqual({ width: 800, height: 600 });
    ctx.dispose();
  });

  it('keeps the canvas element at CSS size while the buffer scales', async () => {
    setDevicePixelRatio(2);
    const ctx = await createInitialised();

    expect(ctx.canvas.style.width).toBe('100%');
    expect(ctx.canvas.style.height).toBe('100%');
    // setSize must not rewrite the element style itself.
    const last = fakeRenderer(ctx).setSizeCalls.at(-1);
    expect(last).toEqual({ width: 800, height: 600, updateStyle: false });
    ctx.dispose();
  });

  it('clamps render scale to 0.3..2', async () => {
    const ctx = await createInitialised();

    ctx.setRenderScale(9);
    expect(ctx.getRenderScale()).toBe(2);

    ctx.setRenderScale(0.01);
    expect(ctx.getRenderScale()).toBe(0.3);

    ctx.setRenderScale(-5);
    expect(ctx.getRenderScale()).toBe(0.3);

    ctx.setRenderScale(1);
    expect(ctx.getRenderScale()).toBe(1);
    ctx.dispose();
  });

  it('ignores a render scale change smaller than the epsilon', async () => {
    const ctx = await createInitialised();
    const before = fakeRenderer(ctx).setSizeCalls.length;

    ctx.setRenderScale(1.0005);

    expect(ctx.getRenderScale()).toBe(1);
    expect(fakeRenderer(ctx).setSizeCalls.length).toBe(before);
    ctx.dispose();
  });

  it('updates camera aspect from the host rect on applySize', async () => {
    setHostSize(1600, 400);
    const ctx = await createInitialised();
    expect(ctx.camera.aspect).toBeCloseTo(4, 6);

    setHostSize(600, 900);
    ctx.applySize();

    expect(ctx.camera.aspect).toBeCloseTo(600 / 900, 6);
    expect(ctx.getCssSize()).toEqual({ width: 600, height: 900 });
    ctx.dispose();
  });

  it('floors fractional layout sizes and never sizes to zero', async () => {
    setHostSize(800.7, 600.9);
    const ctx = await createInitialised();
    expect(ctx.getCssSize()).toEqual({ width: 800, height: 600 });

    // A host measured mid-layout must not produce a 0-width buffer or a NaN
    // aspect ratio.
    setHostSize(0, 0);
    ctx.applySize();

    expect(ctx.getCssSize()).toEqual({ width: 1, height: 1 });
    expect(ctx.camera.aspect).toBe(1);
    expect(Number.isFinite(ctx.camera.aspect)).toBe(true);
    ctx.dispose();
  });

  it('treats a missing devicePixelRatio as 1', async () => {
    setDevicePixelRatio(0);
    const ctx = await createInitialised();

    expect(ctx.getBufferSize()).toEqual({ width: 800, height: 600 });
    ctx.dispose();
  });
});

describe('RenderContext camera settings', () => {
  it('applies fov and rebuilds the projection matrix', async () => {
    const ctx = await createInitialised();
    const update = vi.spyOn(ctx.camera, 'updateProjectionMatrix');

    ctx.setFov(55);

    expect(ctx.camera.fov).toBe(55);
    expect(update).toHaveBeenCalledTimes(1);

    // A no-op change must not rebuild the matrix every frame.
    ctx.setFov(55.001);
    expect(update).toHaveBeenCalledTimes(1);
    ctx.dispose();
  });

  it('applies draw distance to the far plane', async () => {
    const ctx = await createInitialised();
    const update = vi.spyOn(ctx.camera, 'updateProjectionMatrix');

    ctx.setDrawDistance(180);
    expect(ctx.camera.far).toBe(180);
    expect(update).toHaveBeenCalledTimes(1);

    ctx.setDrawDistance(180.2);
    expect(ctx.camera.far).toBe(180);
    expect(update).toHaveBeenCalledTimes(1);
    ctx.dispose();
  });
});

describe('RenderContext reporting', () => {
  it('maps renderer info into stats', async () => {
    const ctx = await createInitialised();

    expect(ctx.getStats()).toEqual({
      drawCalls: 7,
      triangles: 1234,
      lines: 2,
      points: 3,
      renderCalls: 11,
      geometries: 5,
      textures: 9,
    });
    ctx.dispose();
  });

  it('describes the WebGPU adapter when the browser exposes one', async () => {
    gpu.adapterInfo = { vendor: 'testcorp', architecture: 'sim-1', device: 'swiftshader' };
    const ctx = await createInitialised();

    expect(ctx.getAdapterInfo()).toBe('testcorp sim-1 swiftshader');
    ctx.dispose();
  });

  it('returns null rather than inventing an adapter name', async () => {
    gpu.adapterInfo = null;
    const ctx = await createInitialised();

    expect(ctx.getAdapterInfo()).toBeNull();
    ctx.dispose();
  });
});

describe('RenderContext size observation', () => {
  it('uses ResizeObserver when available and disconnects it on dispose', async () => {
    const disconnect = vi.fn();
    const observe = vi.fn();
    class FakeResizeObserver {
      constructor(readonly cb: ResizeObserverCallback) {}
      observe = observe;
      unobserve = vi.fn();
      disconnect = disconnect;
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);

    const ctx = await createInitialised();

    expect(observe).toHaveBeenCalledWith(host);
    // With ResizeObserver present the window resize fallback is not needed.
    expect(added.filter((r) => r.type === 'resize')).toHaveLength(0);

    ctx.dispose();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('falls back to a window resize listener without ResizeObserver', async () => {
    // jsdom provides no ResizeObserver, which is the fallback path itself.
    expect(typeof (globalThis as any).ResizeObserver).toBe('undefined');

    const ctx = await createInitialised();
    expect(added.filter((r) => r.type === 'resize')).toHaveLength(1);

    setHostSize(1024, 768);
    window.dispatchEvent(new Event('resize'));
    expect(ctx.getCssSize()).toEqual({ width: 1024, height: 768 });
    ctx.dispose();
  });

  it('re-applies size on orientationchange, twice, to beat stale dimensions', async () => {
    const ctx = await createInitialised();
    const before = fakeRenderer(ctx).setSizeCalls.length;

    setHostSize(2000, 1000);
    window.dispatchEvent(new Event('orientationchange'));

    expect(ctx.getCssSize()).toEqual({ width: 2000, height: 1000 });
    // Once immediately, once on the next frame.
    expect(fakeRenderer(ctx).setSizeCalls.length).toBe(before + 2);
    ctx.dispose();
  });
});

describe('RenderContext.dispose', () => {
  it('removes every window listener it registered, orientationchange included', async () => {
    const ctx = await createInitialised();

    expect(added.map((r) => r.type).sort()).toEqual(['orientationchange', 'resize']);

    ctx.dispose();

    // The regression this test exists for: dispose used to remove only the
    // resize fallback, leaving orientationchange holding the dead context.
    expect(leakedListeners()).toEqual([]);
    expect(removed.map((r) => r.type).sort()).toEqual(['orientationchange', 'resize']);
  });

  it('leaves a disposed context deaf to orientationchange', async () => {
    const ctx = await createInitialised();
    ctx.dispose();
    const after = fakeRenderer(ctx).setSizeCalls.length;

    setHostSize(1234, 567);
    window.dispatchEvent(new Event('orientationchange'));

    // A live handler here would resize a renderer that no longer has a device.
    expect(fakeRenderer(ctx).setSizeCalls.length).toBe(after);
    expect(ctx.getCssSize()).not.toEqual({ width: 1234, height: 567 });
  });

  it('leaks nothing across repeated create/dispose cycles', async () => {
    for (let i = 0; i < 5; i += 1) {
      const ctx = await createInitialised();
      ctx.dispose();
    }

    expect(added).toHaveLength(10);
    expect(leakedListeners()).toEqual([]);
  });

  it('releases the renderer and detaches the canvas', async () => {
    const ctx = await createInitialised();
    const renderer = fakeRenderer(ctx);
    expect(host.children.length).toBe(1);

    ctx.dispose();

    expect(renderer.disposeCalls).toBe(1);
    expect(host.children.length).toBe(0);
    expect(ctx.canvas.parentElement).toBeNull();
  });

  it('is safe to call twice', async () => {
    const ctx = await createInitialised();

    ctx.dispose();
    expect(() => ctx.dispose()).not.toThrow();

    // The second call must not double-release the device or re-remove
    // listeners, which would make the leak ledger lie.
    expect(fakeRenderer(ctx).disposeCalls).toBe(1);
    expect(removed).toHaveLength(2);
    expect(leakedListeners()).toEqual([]);
  });
});
