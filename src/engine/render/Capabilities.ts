/**
 * Device and graphics capability probing.
 *
 * Used to pick a renderer backend and a sensible starting quality preset.
 * Deliberately conservative: user-agent strings and GPU databases are hints,
 * not truth. The runtime performance measurement (DynamicScaler) always wins
 * over anything guessed here.
 */

import type { QualityPresetName } from '../../graphics/quality/presets';

export type RendererBackend = 'webgpu' | 'webgl2';

export type DeviceClass = 'phone' | 'tablet' | 'desktop';

export interface GraphicsCapabilities {
  /** WebGPU adapter obtainable in this context. */
  readonly webgpuAvailable: boolean;
  /** Reason WebGPU is unavailable, for diagnostics. */
  readonly webgpuUnavailableReason: string | null;
  readonly webgl2Available: boolean;
  readonly deviceClass: DeviceClass;
  /** Raw devicePixelRatio, before any preset clamp. */
  readonly devicePixelRatio: number;
  /** Unmasked GPU renderer string when the browser exposes it. */
  readonly gpuRenderer: string | null;
  readonly gpuVendor: string | null;
  readonly maxTextureSize: number;
  /** navigator.hardwareConcurrency, or null when not exposed. */
  readonly cpuThreads: number | null;
  /** navigator.deviceMemory in GB, or null. Chrome-only, coarse. */
  readonly deviceMemoryGb: number | null;
  readonly touchCapable: boolean;
  /** True when the page is in a secure context (required by WebGPU). */
  readonly secureContext: boolean;
  readonly supportsKtx2Etc: boolean;
  readonly supportsKtx2Astc: boolean;
  readonly supportsKtx2Bc7: boolean;
}

/** Detects touch support without relying on user-agent sniffing. */
function detectTouch(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    'ontouchstart' in window ||
    (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
  );
}

/**
 * Classifies the device.
 *
 * Uses coarse-pointer + screen size rather than UA parsing, because UA
 * strings lie and change. A touch device with a large logical viewport is
 * treated as a tablet, which is the distinction that actually matters for
 * HUD layout and quality defaults.
 */
function detectDeviceClass(touchCapable: boolean): DeviceClass {
  if (typeof window === 'undefined') return 'desktop';

  const coarsePointer =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;

  if (!touchCapable && !coarsePointer) return 'desktop';

  // Longest logical edge in CSS pixels: phones land well under ~900.
  const longEdge = Math.max(window.screen?.width ?? 0, window.screen?.height ?? 0);
  if (longEdge >= 900) return 'tablet';
  return 'phone';
}

interface Webgl2Probe {
  available: boolean;
  gpuRenderer: string | null;
  gpuVendor: string | null;
  maxTextureSize: number;
  supportsKtx2Etc: boolean;
  supportsKtx2Astc: boolean;
  supportsKtx2Bc7: boolean;
}

/**
 * Probes WebGL2 using a throwaway context.
 *
 * The context is explicitly released via WEBGL_lose_context: browsers cap
 * live WebGL contexts (often ~8-16) and leaking probe contexts can prevent
 * the real renderer from getting one.
 */
function probeWebgl2(): Webgl2Probe {
  const fail: Webgl2Probe = {
    available: false,
    gpuRenderer: null,
    gpuVendor: null,
    maxTextureSize: 0,
    supportsKtx2Etc: false,
    supportsKtx2Astc: false,
    supportsKtx2Bc7: false,
  };

  if (typeof document === 'undefined') return fail;

  let gl: WebGL2RenderingContext | null = null;
  try {
    const canvas = document.createElement('canvas');
    gl = canvas.getContext('webgl2', {
      failIfMajorPerformanceCaveat: false,
      powerPreference: 'high-performance',
    });
  } catch {
    return fail;
  }

  if (!gl) return fail;

  try {
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const gpuRenderer = debugInfo
      ? (gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as string | null)
      : null;
    const gpuVendor = debugInfo
      ? (gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) as string | null)
      : null;

    return {
      available: true,
      gpuRenderer: gpuRenderer ?? null,
      gpuVendor: gpuVendor ?? null,
      maxTextureSize: (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) ?? 0,
      // KTX2/Basis transcode targets available on this GPU.
      supportsKtx2Etc: gl.getExtension('WEBGL_compressed_texture_etc') !== null,
      supportsKtx2Astc: gl.getExtension('WEBGL_compressed_texture_astc') !== null,
      supportsKtx2Bc7:
        gl.getExtension('EXT_texture_compression_bptc') !== null ||
        gl.getExtension('WEBGL_compressed_texture_s3tc') !== null,
    };
  } finally {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

/**
 * Checks whether a WebGPU adapter can actually be acquired.
 *
 * `'gpu' in navigator` is not sufficient: the API can be present while
 * adapter request fails (no hardware support, blocklisted driver, insecure
 * context). We request an adapter so the answer reflects reality.
 */
async function probeWebgpu(): Promise<{ available: boolean; reason: string | null }> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
    return { available: false, reason: 'navigator.gpu is not present' };
  }
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return { available: false, reason: 'WebGPU requires a secure context (HTTPS)' };
  }

  try {
    const gpu = (navigator as Navigator & { gpu: GPU }).gpu;
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { available: false, reason: 'no WebGPU adapter returned' };
    return { available: true, reason: null };
  } catch (error) {
    return {
      available: false,
      reason: `adapter request threw: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export async function detectCapabilities(): Promise<GraphicsCapabilities> {
  const touchCapable = detectTouch();
  const gl = probeWebgl2();
  const webgpu = await probeWebgpu();

  const nav = typeof navigator !== 'undefined' ? navigator : undefined;

  return {
    webgpuAvailable: webgpu.available,
    webgpuUnavailableReason: webgpu.reason,
    webgl2Available: gl.available,
    deviceClass: detectDeviceClass(touchCapable),
    devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
    gpuRenderer: gl.gpuRenderer,
    gpuVendor: gl.gpuVendor,
    maxTextureSize: gl.maxTextureSize,
    cpuThreads: nav?.hardwareConcurrency ?? null,
    deviceMemoryGb:
      (nav as (Navigator & { deviceMemory?: number }) | undefined)?.deviceMemory ?? null,
    touchCapable,
    secureContext: typeof window !== 'undefined' ? window.isSecureContext : false,
    supportsKtx2Etc: gl.supportsKtx2Etc,
    supportsKtx2Astc: gl.supportsKtx2Astc,
    supportsKtx2Bc7: gl.supportsKtx2Bc7,
  };
}

/** Chooses the renderer backend. WebGPU preferred, WebGL2 as fallback. */
export function selectBackend(
  caps: GraphicsCapabilities,
  forceWebgl2: boolean,
): RendererBackend {
  if (forceWebgl2) return 'webgl2';
  return caps.webgpuAvailable ? 'webgpu' : 'webgl2';
}

/**
 * Picks a starting quality preset from static capability hints.
 *
 * This is only the opening guess shown before the player touches anything;
 * the runtime scaler corrects it within seconds of gameplay. Kept
 * intentionally pessimistic on mobile so a weak phone never opens on a
 * preset that makes the title screen stutter.
 */
export function suggestInitialPreset(caps: GraphicsCapabilities): QualityPresetName {
  if (!caps.webgl2Available) return 'potato';

  const threads = caps.cpuThreads ?? 4;
  const memory = caps.deviceMemoryGb;

  if (caps.deviceClass === 'phone') {
    // Strong recent phones handle 'medium'; anything modest starts at 'low'.
    if (caps.webgpuAvailable && threads >= 8 && (memory === null || memory >= 6)) {
      return 'medium';
    }
    if (threads >= 6) return 'low';
    return 'potato';
  }

  if (caps.deviceClass === 'tablet') {
    if (caps.webgpuAvailable && threads >= 8) return 'medium';
    return 'low';
  }

  // Desktop. Integrated GPUs are common, so 'high' requires real signals.
  const renderer = (caps.gpuRenderer ?? '').toLowerCase();
  const looksIntegrated =
    renderer.includes('intel') ||
    renderer.includes('uhd graphics') ||
    renderer.includes('llvmpipe') ||
    renderer.includes('swiftshader') ||
    renderer.includes('software');

  if (renderer.includes('swiftshader') || renderer.includes('llvmpipe')) {
    // Software rasteriser: this is CI or a browser without GPU access.
    return 'potato';
  }

  if (looksIntegrated) return 'medium';
  if (caps.webgpuAvailable && threads >= 8) return 'high';
  return 'medium';
}

/** Human-readable summary for the diagnostics overlay and bug reports. */
export function describeCapabilities(caps: GraphicsCapabilities): string {
  const lines = [
    `device        ${caps.deviceClass}${caps.touchCapable ? ' (touch)' : ''}`,
    `webgpu        ${caps.webgpuAvailable ? 'yes' : `no — ${caps.webgpuUnavailableReason}`}`,
    `webgl2        ${caps.webgl2Available ? 'yes' : 'no'}`,
    `gpu           ${caps.gpuRenderer ?? 'unknown'}`,
    `vendor        ${caps.gpuVendor ?? 'unknown'}`,
    `max texture   ${caps.maxTextureSize || 'unknown'}`,
    `dpr           ${caps.devicePixelRatio}`,
    `cpu threads   ${caps.cpuThreads ?? 'unknown'}`,
    `device memory ${caps.deviceMemoryGb !== null ? `${caps.deviceMemoryGb} GB` : 'unknown'}`,
    `ktx2 targets  ${
      [
        caps.supportsKtx2Astc && 'astc',
        caps.supportsKtx2Etc && 'etc',
        caps.supportsKtx2Bc7 && 'bc7',
      ]
        .filter(Boolean)
        .join(', ') || 'none'
    }`,
  ];
  return lines.join('\n');
}
