/**
 * Live GitHub Pages smoke test.
 *
 * Verifies the *deployed* build, not the local one. This catches the class of
 * failure that only appears in production: a wrong base path, a missing
 * hashed chunk, a stale service worker, or an asset 404.
 *
 * Skipped unless PAGES_URL is set, so the normal suite stays hermetic and does
 * not depend on the network.
 *
 *   PAGES_URL=https://xoloteach.github.io/TIDELOCK/ pnpm exec playwright test tests/browser/deployed.spec.ts
 */

import { test, expect } from '@playwright/test';

const PAGES_URL = process.env.PAGES_URL;

test.describe('deployed Pages build', () => {
  test.skip(!PAGES_URL, 'PAGES_URL is not set');

  test('boots to the title screen with no failed requests', async ({ page }) => {
    const failedRequests: string[] = [];
    const consoleErrors: string[] = [];

    page.on('requestfailed', (request) => {
      failedRequests.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText}`);
    });

    page.on('response', (response) => {
      // A 404 on a hashed chunk is the signature of a bad base path or a
      // stale service worker serving an old index.html.
      if (response.status() >= 400) {
        failedRequests.push(`HTTP ${response.status()} ${response.url()}`);
      }
    });

    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (/SwiftShader|software WebGL|favicon/i.test(text)) return;
      consoleErrors.push(text);
    });

    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

    await page.goto(PAGES_URL!, { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(
      () => (window as unknown as Record<string, any>).__TIDELOCK__ !== undefined,
      { timeout: 60_000 },
    );

    const handle = await page.evaluate(() => {
      const h = (window as unknown as Record<string, any>).__TIDELOCK__;
      return {
        ready: h.ready,
        fatalError: h.fatalError ?? null,
        state: h.getState?.() ?? null,
        backend: h.getBackend?.() ?? null,
        commit: h.build?.shortCommit ?? null,
      };
    });

    expect(handle.fatalError, `deployed build failed to start: ${handle.fatalError}`).toBeNull();
    expect(handle.ready).toBe(true);
    expect(handle.state).toBe('title');

    // The deployed build must report a real commit, not the dev placeholder.
    expect(handle.commit).not.toBe('local-d');
    expect(handle.commit).toMatch(/^[0-9a-f]{7}$/);

    await expect(page.locator('.title__wordmark')).toHaveText(/tidelock/i);

    expect(failedRequests, `failed requests:\n${failedRequests.join('\n')}`).toHaveLength(0);
    expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0);
  });

  test('serves the PWA manifest and icons from the correct base path', async ({ page }) => {
    await page.goto(PAGES_URL!, { waitUntil: 'domcontentloaded' });

    const manifestHref = await page
      .locator('link[rel="manifest"]')
      .getAttribute('href');
    expect(manifestHref, 'no manifest link in the document').not.toBeNull();

    const manifestUrl = new URL(manifestHref!, PAGES_URL!).toString();
    const manifestResponse = await page.request.get(manifestUrl);
    expect(manifestResponse.status(), `manifest at ${manifestUrl}`).toBe(200);

    const manifest = (await manifestResponse.json()) as {
      name: string;
      icons: { src: string }[];
    };
    expect(manifest.name).toBe('TIDELOCK');
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);

    // Every declared icon must actually resolve, or install prompts break.
    for (const icon of manifest.icons) {
      const iconUrl = new URL(icon.src, manifestUrl).toString();
      const response = await page.request.get(iconUrl);
      expect(response.status(), `icon ${iconUrl}`).toBe(200);
    }
  });

  test('renders the title screen on a phone-landscape viewport', async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 360 });
    await page.goto(PAGES_URL!, { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(
      () => (window as unknown as Record<string, any>).__TIDELOCK__ !== undefined,
      { timeout: 60_000 },
    );

    // No page scrolling: a game surface that scrolls on a phone is broken.
    const overflow = await page.evaluate(() => ({
      docWidth: document.documentElement.scrollWidth,
      viewWidth: window.innerWidth,
    }));
    expect(overflow.docWidth).toBeLessThanOrEqual(overflow.viewWidth + 1);

    await expect(page.getByRole('button', { name: /^New Game/i })).toBeVisible();
  });
});
