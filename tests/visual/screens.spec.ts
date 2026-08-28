/**
 * Screenshot capture for visual review.
 *
 * These are not pixel-comparison tests. They produce artefacts a human (or a
 * later comparison job) can inspect for the failure modes that automated
 * assertions miss: missing materials, pink/black textures, overexposure,
 * clipped UI, unreadable text at phone sizes.
 *
 * Output goes to test-results/screens/ and is uploaded by CI.
 */

import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const OUT_DIR = 'test-results/screens';

/** Viewports covering the shapes the spec requires us to support. */
const VIEWPORTS = [
  { name: 'desktop-720p', width: 1280, height: 720 },
  { name: 'desktop-1080p', width: 1920, height: 1080 },
  { name: 'phone-landscape-narrow', width: 667, height: 375 },
  { name: 'phone-landscape-tall', width: 915, height: 412 },
  { name: 'tablet-landscape', width: 1180, height: 820 },
];

async function waitForReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as Record<string, any>).__TIDELOCK__ !== undefined,
    { timeout: 60_000 },
  );
  // Let the boot screen finish fading so the shot shows the real title frame.
  await page.waitForTimeout(900);
}

test.beforeAll(async () => {
  await mkdir(OUT_DIR, { recursive: true });
});

// Visual captures only run on the desktop project: the android project's
// testMatch in playwright.config.ts excludes tests/visual, so no skip is needed.
test.describe('title screen capture', () => {

  for (const vp of VIEWPORTS) {
    test(`title at ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');
      await waitForReady(page);

      await page.screenshot({ path: `${OUT_DIR}/title-${vp.name}.png` });

      // A capture is only useful if the frame actually rendered content.
      const wordmark = page.locator('.title__wordmark');
      await expect(wordmark).toBeVisible();

      // Guard against the classic "text rendered off-screen" failure.
      const box = await wordmark.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width + 1);
    });
  }

  test('boot screen shows real named stages', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });

    // `?holdBoot=1` keeps the overlay up after startup, so this capture is
    // deterministic instead of racing the boot sequence.
    await page.goto('/?holdBoot=1');
    await waitForReady(page);

    const boot = page.locator('.boot');
    await expect(boot).toBeVisible();
    await page.screenshot({ path: `${OUT_DIR}/boot.png` });

    // The boot screen must list real stages, not a bare spinner.
    const stages = page.locator('.boot__stage');
    await expect(stages).toHaveCount(3);

    // Every stage should have completed successfully by this point.
    await expect(page.locator('.boot__stage--done')).toHaveCount(3);
    await expect(page.locator('.boot__stage--failed')).toHaveCount(0);

    // Progress must reflect completion rather than sitting at zero.
    const width = await page.locator('.boot__fill').evaluate((n) => n.style.width);
    expect(width).toBe('100%');
  });

  test('forcing the WebGL2 backend works and is reported', async ({ page }) => {
    await page.goto('/?webgl2=1');
    await waitForReady(page);

    const backend = await page.evaluate(
      () => (window as unknown as Record<string, any>).__TIDELOCK__.getBackend(),
    );
    expect(backend).toBe('webgl2');

    await expect(page.locator('.title__backend')).toContainText(/webgl2/i);
  });
});
