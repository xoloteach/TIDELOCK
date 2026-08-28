/**
 * URL query flags.
 *
 * Deliberate, documented seams for testing, diagnostics and benchmarking —
 * not hidden cheats. They are read once at startup so a flag cannot change
 * behaviour halfway through a session.
 *
 * Supported flags:
 *   ?holdBoot=1     keep the boot overlay visible after startup completes
 *   ?benchmark=1    run the benchmark route instead of the normal campaign
 *   ?diagnostics=1  open the developer diagnostics overlay immediately
 *   ?webgl2=1       force the WebGL2 backend, ignoring WebGPU availability
 */

const params: URLSearchParams = (() => {
  if (typeof window === 'undefined') return new URLSearchParams();
  try {
    return new URLSearchParams(window.location.search);
  } catch {
    return new URLSearchParams();
  }
})();

/**
 * True when the flag is present and not explicitly disabled.
 *
 * `?flag`, `?flag=1` and `?flag=true` all enable; `?flag=0` and `?flag=false`
 * disable, so a flag can be turned off without editing the rest of the URL.
 */
export function hasQueryFlag(name: string): boolean {
  if (!params.has(name)) return false;
  const value = params.get(name);
  if (value === null || value === '') return true;
  return value !== '0' && value.toLowerCase() !== 'false';
}

export function getQueryValue(name: string): string | null {
  return params.get(name);
}

/** Numeric flag value, or null when absent/unparseable. */
export function getQueryNumber(name: string): number | null {
  const raw = params.get(name);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
