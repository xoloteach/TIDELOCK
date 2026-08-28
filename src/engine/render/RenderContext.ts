/**
 * Renderer creation, sizing and lifecycle.
 *
 * Uses Three's `WebGPURenderer`, which prefers WebGPU and falls back to its
 * WebGL2 backend. `forceWebGL` gives us the explicit compatibility mode the
 * spec requires, and the *actual* backend is read back after init rather than
 * assumed — the requested and resulting backend can differ.
 *
 * Sizing is separated into three concerns that are easy to conflate:
 *   - CSS size:      the element's layout size in CSS pixels
 *   - pixel ratio:   device DPR, clamped by the quality preset
 *   - render scale:  the preset's internal resolution multiplier
 * The drawing buffer is `cssSize * min(dpr, maxPixelRatio) * renderScale`.
 */

import {
  Scene,
  PerspectiveCamera,
  Color,
  FogExp2,
  ACESFilmicToneMapping,
  SRGBColorSpace,
  PCFSoftShadowMap,
  type ToneMapping,
} from 'three';
import { WebGPURenderer } from 'three/webgpu';
import type { RendererBackend } from './Capabilities';

export interface RenderContextOptions {
  /** Element the canvas is inserted into. */
  readonly host: HTMLElement;
  /** Request the WebGL2 backend explicitly. */
  readonly forceWebgl2: boolean;
  /** Antialiasing. Disabled on cheap presets in favour of render scale. */
  readonly antialias: boolean;
}

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  lines: number;
  points: number;
  /** Cumulative render calls since start. */
  renderCalls: number;
  geometries: number;
  textures: number;
}

/** Reason the WebGPU path was not used, for honest diagnostics reporting. */
export interface BackendReport {
  readonly requested: RendererBackend;
  readonly actual: RendererBackend;
  readonly forcedByUser: boolean;
}

export class RenderContext {
  readonly renderer: WebGPURenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;

  private backendReport: BackendReport;
  private initialised = false;

  /** CSS pixel size of the host element. */
  private cssWidth = 1;
  private cssHeight = 1;

  private maxPixelRatio = 2;
  private renderScale = 1;

  private resizeObserver: ResizeObserver | null = null;
  private orientationHandler: (() => void) | null = null;

  constructor(private readonly options: RenderContextOptions) {
    this.renderer = new WebGPURenderer({
      antialias: options.antialias,
      alpha: false,
      forceWebGL: options.forceWebgl2,
      // Ask for the discrete GPU on hybrid machines.
      powerPreference: 'high-performance',
    });

    this.canvas = this.renderer.domElement;

    // Requested backend; the actual one is confirmed after init().
    this.backendReport = {
      requested: options.forceWebgl2 ? 'webgl2' : 'webgpu',
      actual: options.forceWebgl2 ? 'webgl2' : 'webgpu',
      forcedByUser: options.forceWebgl2,
    };

    this.scene = new Scene();
    // Overcast coastal daylight. Fog colour matches the clear colour so the
    // horizon dissolves instead of showing a hard band at the far plane.
    this.scene.background = new Color(0x8a969b);
    this.scene.fog = new FogExp2(0x8a969b, 0.012);

    this.camera = new PerspectiveCamera(70, 1, 0.1, 600);
    this.camera.position.set(0, 2, 6);

    this.renderer.toneMapping = ACESFilmicToneMapping as ToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
  }

  /**
   * Initialises the GPU device and attaches the canvas.
   *
   * Must be awaited: WebGPU device acquisition is asynchronous, and rendering
   * before it resolves produces an empty frame or throws.
   */
  async init(): Promise<void> {
    if (this.initialised) return;

    await this.renderer.init();

    // Read back which backend actually came up. Requesting WebGPU does not
    // guarantee getting it, and reporting the request as the result would be
    // a lie in the diagnostics panel.
    const backend = this.renderer.backend as unknown as {
      isWebGPUBackend?: boolean;
      isWebGLBackend?: boolean;
    };
    const actual: RendererBackend = backend?.isWebGPUBackend ? 'webgpu' : 'webgl2';

    this.backendReport = { ...this.backendReport, actual };

    if (this.backendReport.requested === 'webgpu' && actual === 'webgl2') {
      console.info('[render] WebGPU was requested but the WebGL2 backend is in use');
    }

    this.canvas.setAttribute('aria-hidden', 'true');
    this.options.host.appendChild(this.canvas);

    this.observeSize();
    this.applySize();

    this.initialised = true;
  }

  // ---- Sizing -----------------------------------------------------------

  /**
   * Watches the host element for size changes.
   *
   * ResizeObserver is used rather than a window resize listener because mobile
   * browser chrome collapsing changes the element size without firing a
   * meaningful window resize, and because it also catches CSS-driven changes.
   */
  private observeSize(): void {
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.applySize());
      this.resizeObserver.observe(this.options.host);
    } else {
      // Fallback for environments without ResizeObserver.
      this.orientationHandler = () => this.applySize();
      window.addEventListener('resize', this.orientationHandler);
    }

    // Orientation change can report stale dimensions if read immediately, so
    // re-apply on the next frame as well.
    const onOrientation = (): void => {
      this.applySize();
      requestAnimationFrame(() => this.applySize());
    };
    window.addEventListener('orientationchange', onOrientation);
  }

  /** Recomputes the drawing buffer size from CSS size, DPR and render scale. */
  applySize(): void {
    const rect = this.options.host.getBoundingClientRect();
    // Guard against a zero-size host during layout; a 0-width buffer throws.
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));

    this.cssWidth = width;
    this.cssHeight = height;

    const deviceRatio = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);
    const effectiveRatio = deviceRatio * this.renderScale;

    // setSize takes CSS pixels and setPixelRatio multiplies to get the buffer,
    // so render scale folds into the pixel ratio.
    this.renderer.setPixelRatio(effectiveRatio);
    this.renderer.setSize(width, height, false);

    // The canvas element itself must stay at CSS size; only the buffer scales.
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  setRenderScale(scale: number): void {
    const clamped = Math.max(0.3, Math.min(2, scale));
    if (Math.abs(clamped - this.renderScale) < 0.001) return;
    this.renderScale = clamped;
    this.applySize();
  }

  getRenderScale(): number {
    return this.renderScale;
  }

  setMaxPixelRatio(ratio: number): void {
    if (Math.abs(ratio - this.maxPixelRatio) < 0.001) return;
    this.maxPixelRatio = ratio;
    this.applySize();
  }

  setFov(fov: number): void {
    if (Math.abs(this.camera.fov - fov) < 0.01) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  /** Far plane, driven by the preset's draw distance. */
  setDrawDistance(distance: number): void {
    if (Math.abs(this.camera.far - distance) < 0.5) return;
    this.camera.far = distance;
    this.camera.updateProjectionMatrix();
  }

  // ---- Rendering --------------------------------------------------------

  render(): void {
    if (!this.initialised) return;
    this.renderer.render(this.scene, this.camera);
  }

  // ---- Reporting --------------------------------------------------------

  getBackendReport(): BackendReport {
    return this.backendReport;
  }

  get backend(): RendererBackend {
    return this.backendReport.actual;
  }

  /**
   * Drawing buffer dimensions in device pixels.
   * Distinct from CSS size whenever DPR or render scale is not 1.
   */
  getBufferSize(): { width: number; height: number } {
    return {
      width: Math.round(this.cssWidth * this.renderer.getPixelRatio()),
      height: Math.round(this.cssHeight * this.renderer.getPixelRatio()),
    };
  }

  getCssSize(): { width: number; height: number } {
    return { width: this.cssWidth, height: this.cssHeight };
  }

  getStats(): RenderStats {
    const info = this.renderer.info;
    return {
      drawCalls: info.render.drawCalls,
      triangles: info.render.triangles,
      lines: info.render.lines,
      points: info.render.points,
      renderCalls: info.render.calls,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
    };
  }

  /** GPU/adapter description when the backend exposes one. */
  getAdapterInfo(): string | null {
    const backend = this.renderer.backend as unknown as Record<string, any>;

    // WebGPU: adapter info when the browser exposes it.
    const adapter = backend?.adapter as GPUAdapter | undefined;
    const adapterInfo = (adapter as unknown as { info?: GPUAdapterInfo })?.info;
    if (adapterInfo) {
      const parts = [adapterInfo.vendor, adapterInfo.architecture, adapterInfo.device]
        .filter((p) => typeof p === 'string' && p.length > 0)
        .join(' ');
      if (parts.length > 0) return parts;
    }

    // WebGL2: unmasked renderer string via the debug extension.
    const gl = backend?.gl as WebGL2RenderingContext | undefined;
    if (gl) {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
        if (typeof renderer === 'string' && renderer.length > 0) return renderer;
      }
    }

    return null;
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    if (this.orientationHandler) {
      window.removeEventListener('resize', this.orientationHandler);
      this.orientationHandler = null;
    }

    this.renderer.dispose();
    this.canvas.remove();
    this.initialised = false;
  }
}
