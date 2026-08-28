import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Resolve the commit SHA so a deployed build can be tied to exact source.
 * CI provides GITHUB_SHA; locally we ask git; if neither works we say so
 * rather than inventing a value.
 */
function resolveCommit(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

function resolveVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Derive the deployment base path.
 *
 * Locally this is '/'. On GitHub Actions we build for GitHub Pages project
 * pages, which are served from '/<repo>/'. The repository name is read from
 * GITHUB_REPOSITORY so no account or repo name is hardcoded.
 */
function resolveBase(): string {
  if (!process.env.GITHUB_ACTIONS) return '/';
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
  return repo ? `/${repo}/` : '/';
}

export default defineConfig({
  base: resolveBase(),
  define: {
    __BUILD_COMMIT__: JSON.stringify(resolveCommit()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __APP_VERSION__: JSON.stringify(resolveVersion()),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@content': fileURLToPath(new URL('./content', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        // Function form: keeps working across Rollup and Rolldown, and lets us
        // split by module path rather than maintaining an entry list.
        manualChunks(id: string) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('node_modules/@dimforge')) return 'rapier';
          if (id.includes('recast-navigation')) return 'nav';
          return undefined;
        },
      },
    },
  },
  worker: { format: 'es' },
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  plugins: [
    VitePWA({
      // 'prompt' so a service-worker update never swaps chunks mid-session.
      registerType: 'prompt',
      injectRegister: 'auto',
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2,json}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        cleanupOutdatedCaches: true,
      },
      manifest: {
        name: 'TIDELOCK',
        short_name: 'TIDELOCK',
        description:
          'A narrative action-adventure set in the flooded borough of Morrow Quay.',
        theme_color: '#0d1519',
        background_color: '#0d1519',
        orientation: 'landscape',
        display: 'fullscreen',
        icons: [
          { src: 'pwa/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'pwa/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
});
