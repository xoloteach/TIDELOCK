/**
 * Build identity, surfaced in the About/diagnostics screen.
 *
 * Android bug reports must be traceable to an exact build, so the commit SHA
 * and build timestamp are injected at build time by Vite `define`. In dev
 * they fall back to obvious placeholder values rather than lying.
 */

declare const __BUILD_COMMIT__: string;
declare const __BUILD_TIME__: string;
declare const __APP_VERSION__: string;

function readDefine(read: () => string, fallback: string): string {
  try {
    const value = read();
    return value && value.length > 0 ? value : fallback;
  } catch {
    // The define is absent (e.g. running under Vitest without the plugin).
    return fallback;
  }
}

export interface BuildInfo {
  readonly version: string;
  readonly commit: string;
  readonly shortCommit: string;
  readonly buildTime: string;
  readonly mode: 'development' | 'production';
}

const commit = readDefine(() => __BUILD_COMMIT__, 'local-dev');

export const BUILD_INFO: BuildInfo = Object.freeze({
  version: readDefine(() => __APP_VERSION__, '0.0.0-dev'),
  commit,
  shortCommit: commit.slice(0, 7),
  buildTime: readDefine(() => __BUILD_TIME__, 'unbuilt'),
  mode: import.meta.env?.PROD ? 'production' : 'development',
});

/** Single-line identity string used in diagnostics copy-paste output. */
export function formatBuildIdentity(): string {
  return `TIDELOCK ${BUILD_INFO.version} · ${BUILD_INFO.shortCommit} · ${BUILD_INFO.buildTime}`;
}
