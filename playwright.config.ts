import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration.
 *
 * Tests run against the production build via `vite preview` so what is tested
 * is what ships, including the PWA service worker and chunk splitting.
 *
 * Browsers are launched with GPU-adjacent flags because a headless container
 * has no real GPU: SwiftShader gives us a working WebGL2 context so renderer
 * and scene tests are meaningful rather than skipped.
 */

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/** Chromium flags that make WebGL2 available in a headless container. */
const GL_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  // Deterministic sizing for visual comparisons.
  '--hide-scrollbars',
  '--mute-audio',
];

export default defineConfig({
  testDir: './tests',
  testMatch: ['browser/**/*.spec.ts', 'visual/**/*.spec.ts'],
  // A slow first paint on a cold container should not read as a failure.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]]
    : [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'desktop-chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
        launchOptions: { args: GL_ARGS },
      },
    },
    {
      // Primary human test device is Android, so a phone-landscape profile is
      // a first-class target rather than an afterthought.
      name: 'android-phone-landscape',
      testMatch: ['browser/mobile/**/*.spec.ts', 'browser/**/*.spec.ts'],
      use: {
        ...devices['Pixel 7 landscape'],
        launchOptions: { args: GL_ARGS },
      },
    },
  ],

  webServer: {
    command: 'pnpm build && pnpm preview --port 4173 --strictPort',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
