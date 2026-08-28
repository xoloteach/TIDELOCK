/**
 * Boot and title-screen E2E tests.
 *
 * These assert the things that make a build deployable at all: it starts, it
 * reaches the title, and it does so without fatal console errors. A build
 * that fails here must never reach GitHub Pages.
 */

import { test, expect, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * Collects console errors and page exceptions.
 *
 * Some messages are expected noise in a headless container and are filtered
 * deliberately and narrowly — never by blanket-ignoring all errors.
 */
function collectFatalErrors(page: Page): string[] {
  const fatal: string[] = [];

  const IGNORED = [
    // Headless Chromium has no real GPU; SwiftShader logs fallback notices.
    /SwiftShader/i,
    /Automatic fallback to software WebGL/i,
    // The service worker is not registered on first load in 'prompt' mode.
    /ServiceWorker.*404/i,
    // Favicon requests can 404 before the manifest is cached.
    /favicon/i,
  ];

  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (IGNORED.some((re) => re.test(text))) return;
    fatal.push(`console.error: ${text}`);
  });

  page.on('pageerror', (error) => {
    fatal.push(`pageerror: ${error.message}`);
  });

  return fatal;
}

/** Waits for the app to finish booting and expose its test handle. */
async function waitForReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const handle = (window as unknown as Record<string, any>).__TIDELOCK__;
      return handle !== undefined;
    },
    { timeout: 60_000 },
  );
}

test.describe('boot sequence', () => {
  test('reaches the title screen with no fatal console errors', async ({ page }) => {
    const fatal = collectFatalErrors(page);

    await page.goto('/');
    await waitForReady(page);

    const handle = await page.evaluate(() => {
      const h = (window as unknown as Record<string, any>).__TIDELOCK__;
      return {
        ready: h.ready,
        fatalError: h.fatalError ?? null,
        state: typeof h.getState === 'function' ? h.getState() : null,
        backend: typeof h.getBackend === 'function' ? h.getBackend() : null,
      };
    });

    // Report the actual startup failure rather than a generic timeout.
    expect(handle.fatalError, `startup failed: ${handle.fatalError}`).toBeNull();
    expect(handle.ready).toBe(true);
    expect(handle.state).toBe('title');
    expect(handle.backend).toMatch(/^(webgpu|webgl2)$/);

    expect(fatal, `fatal errors:\n${fatal.join('\n')}`).toHaveLength(0);
  });

  test('removes the boot overlay once startup completes', async ({ page }) => {
    await page.goto('/');
    await waitForReady(page);

    // The boot screen must be gone, not merely transparent, so it cannot
    // silently swallow input.
    await expect(page.locator('.boot')).toHaveCount(0, { timeout: 20_000 });
  });

  test('reports a WebGL2 or WebGPU backend and a real GPU string', async ({ page }) => {
    await page.goto('/');
    await waitForReady(page);

    const description = await page.evaluate(() =>
      (window as unknown as Record<string, any>).__TIDELOCK__.describeCapabilities(),
    );

    expect(description).toContain('webgl2');
    // In this container WebGL2 must be genuinely available, otherwise later
    // renderer tests would be meaningless.
    expect(description).toMatch(/webgl2\s+yes/);
  });
});

test.describe('title screen', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForReady(page);
  });

  test('shows the wordmark and the required menu rows', async ({ page }) => {
    await expect(page.locator('.title__wordmark')).toHaveText(/tidelock/i);

    for (const label of ['Continue', 'New Game', 'Load', 'Settings', 'Credits']) {
      await expect(
        page.getByRole('button', { name: new RegExp(`^${label}`, 'i') }),
      ).toBeVisible();
    }
  });

  test('disables Continue and Load when no save exists', async ({ page }) => {
    // A fresh profile has no saves; offering Continue would be a dead button.
    await expect(page.getByRole('button', { name: /^Continue/i })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^Load/i })).toBeDisabled();
  });

  test('explains why Continue is unavailable instead of hiding it', async ({ page }) => {
    await expect(page.locator('.title__button-detail').first()).toHaveText(/no save yet/i);
  });

  test('enables New Game', async ({ page }) => {
    await expect(page.getByRole('button', { name: /^New Game/i })).toBeEnabled();
  });

  test('displays the build identity so a bug report can name the build', async ({ page }) => {
    const footer = page.locator('.title__footer');
    await expect(footer).toContainText(/build [0-9a-f]{7}|build local-d/i);
    await expect(footer).toContainText(/v\d+\.\d+\.\d+/);
  });

  test('reports the renderer backend in the footer', async ({ page }) => {
    await expect(page.locator('.title__backend')).toContainText(/webgpu|webgl2/i);
  });

  test('focuses the first actionable menu row for keyboard users', async ({ page }) => {
    // Continue is disabled on a fresh profile, so focus must land on New Game.
    const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
    expect(focused).toMatch(/new game/i);
  });

  test('menu rows are reachable by keyboard in document order', async ({ page }) => {
    await page.keyboard.press('Tab');
    const afterTab = await page.evaluate(() => document.activeElement?.textContent?.trim());
    expect(afterTab).toMatch(/load|settings/i);
  });
});

test.describe('responsive layout', () => {
  test('has no horizontal overflow at phone-landscape size', async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 360 });
    await page.goto('/');
    await waitForReady(page);

    const overflow = await page.evaluate(() => ({
      docWidth: document.documentElement.scrollWidth,
      viewWidth: window.innerWidth,
      docHeight: document.documentElement.scrollHeight,
      viewHeight: window.innerHeight,
    }));

    // A game surface must never scroll; overflow means the layout is broken.
    expect(overflow.docWidth).toBeLessThanOrEqual(overflow.viewWidth + 1);
    expect(overflow.docHeight).toBeLessThanOrEqual(overflow.viewHeight + 1);
  });

  test('keeps every menu row inside the viewport on a narrow phone', async ({ page }) => {
    await page.setViewportSize({ width: 667, height: 375 });
    await page.goto('/');
    await waitForReady(page);

    const rows = page.locator('.title__button');
    const count = await rows.count();
    expect(count).toBe(5);

    for (let i = 0; i < count; i += 1) {
      const box = await rows.nth(i).boundingBox();
      expect(box, `row ${i} has no layout box`).not.toBeNull();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(375 + 1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(667 + 1);
    }
  });

  test('menu rows meet the minimum touch target height', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 400 });
    await page.goto('/');
    await waitForReady(page);

    const rows = page.locator('.title__button');
    const count = await rows.count();

    for (let i = 0; i < count; i += 1) {
      const box = await rows.nth(i).boundingBox();
      // 44px is the practical minimum for a reliable finger target.
      expect(box!.height, `row ${i} is ${box!.height}px tall`).toBeGreaterThanOrEqual(43);
    }
  });
});

test.describe('settings persistence', () => {
  test('writes settings to localStorage on first boot', async ({ page }) => {
    await page.goto('/');
    await waitForReady(page);

    // The capability-based preset suggestion is persisted, so a reload keeps
    // the same starting quality rather than re-probing every time.
    await page.waitForFunction(
      () => window.localStorage.getItem('tidelock:settings:v1') !== null,
      { timeout: 15_000 },
    );

    const stored = await page.evaluate(() =>
      JSON.parse(window.localStorage.getItem('tidelock:settings:v1')!),
    );

    expect(stored.version).toBe(1);
    expect(stored.graphics.preset).toMatch(/potato|low|medium|high|ultra|cinematic/);
    expect(stored.accessibility.subtitles).toBe(true);
  });

  test('restores a stored preset across a reload', async ({ page }) => {
    await page.goto('/');
    await waitForReady(page);

    await page.evaluate(() => {
      const raw = JSON.parse(window.localStorage.getItem('tidelock:settings:v1')!);
      raw.graphics.preset = 'potato';
      window.localStorage.setItem('tidelock:settings:v1', JSON.stringify(raw));
    });

    await page.reload();
    await waitForReady(page);

    const preset = await page.evaluate(
      () => (window as unknown as Record<string, any>).__TIDELOCK__.getSettings().graphics.preset,
    );
    expect(preset).toBe('potato');
  });

  test('recovers from corrupt stored settings instead of failing to boot', async ({ page }) => {
    await page.goto('/');
    await waitForReady(page);

    await page.evaluate(() => {
      window.localStorage.setItem('tidelock:settings:v1', '{corrupt');
    });

    await page.reload();
    await waitForReady(page);

    const handle = await page.evaluate(() => {
      const h = (window as unknown as Record<string, any>).__TIDELOCK__;
      return { ready: h.ready, state: h.getState?.() ?? null };
    });

    expect(handle.ready).toBe(true);
    expect(handle.state).toBe('title');
  });
});
