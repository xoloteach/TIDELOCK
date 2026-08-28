/**
 * TIDELOCK entry point.
 *
 * Responsibilities kept deliberately small: install global error reporting,
 * construct the App, and surface any fatal startup failure on screen instead
 * of leaving the player at a black rectangle.
 */

import './ui/styles/tokens.css';
import './ui/styles/base.css';
import './ui/styles/controls.css';
import './ui/styles/boot.css';
import './ui/styles/title.css';

import { BootScreen } from './ui/BootScreen';
import { App, BOOT_STAGES } from './app/App';
import { formatBuildIdentity } from './app/buildInfo';

async function main(): Promise<void> {
  // Log identity first so any console captured from a phone identifies the build.
  console.info(`[tidelock] ${formatBuildIdentity()}`);

  const boot = new BootScreen(BOOT_STAGES);

  // Fatal-error reporting must be installed before anything can throw.
  // Errors are shown, not swallowed.
  const onError = (event: ErrorEvent): void => {
    console.error('[tidelock] uncaught error', event.error ?? event.message);
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    console.error('[tidelock] unhandled rejection', event.reason);
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  try {
    const app = new App({ boot });
    await app.start();

    // Expose the app for Playwright/E2E and developer diagnostics. This is a
    // deliberate test seam, not accidental global leakage.
    (window as unknown as Record<string, unknown>).__TIDELOCK__ = app.getTestHandle();
  } catch (error) {
    console.error('[tidelock] fatal startup failure', error);
    boot.showFatalError('The game could not initialise.', error);
    // Re-expose a minimal handle so E2E can assert on the failure state
    // rather than timing out with no information.
    (window as unknown as Record<string, unknown>).__TIDELOCK__ = {
      ready: false,
      fatalError: error instanceof Error ? error.message : String(error),
    };
  }
}

void main();
