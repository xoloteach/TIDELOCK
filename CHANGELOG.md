# Changelog

All notable changes to TIDELOCK. Each entry corresponds to a validated
milestone that was typechecked, tested, built, exercised in a browser, and
pushed.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project is pre-1.0 and the save schema may change between milestones until
the campaign is content-complete.

## [Unreleased]

### M1 — Project scaffold and bootable app shell

**Added**

- pnpm project with pinned exact dependency versions; TypeScript strict mode.
- Vite 8 build. The GitHub Pages base path is derived from `GITHUB_REPOSITORY`
  rather than hardcoded, so the same config works locally and on project pages.
- Build identity (commit SHA, timestamp, version) injected at build time and
  shown on the title screen, so an Android bug report can name the exact build.
- Directory structure matching the specification's repository layout.
- Municipal-infrastructure design token system: wet concrete surfaces, sodium
  amber accent, square corners, printed-label typography. No neon, gradients or
  glassmorphism.
- Boot screen with named observable stages that report `waiting` → `working` →
  `ok`/`fault`, plus a readable fatal-error panel. A failed startup states what
  failed instead of showing a black screen.
- Graphics capability probing: real WebGPU adapter request (not just a feature
  check), WebGL2 context probe with explicit context release, device
  classification from pointer/screen rather than user-agent parsing, and KTX2
  transcode target detection.
- Renderer backend selection with a WebGL2 compatibility path, overridable via
  the `?webgl2=1` flag or a graphics setting.
- Six data-driven quality presets from Potato to Cinematic. Each adjacent pair
  differs in at least four non-resolution workload dimensions.
- Versioned settings schema with Zod validation, field-by-field migration from
  older or truncated blobs, debounced localStorage writes, and graceful
  degradation when storage is unavailable or over quota.
- Fixed-timestep simulation loop with render interpolation, a catch-up cap to
  prevent the spiral of death, stall clamping for backgrounded tabs, and pause
  semantics that do not simulate paused wall-clock time on resume.
- Typed event emitter, app state machine with declared legal transitions, and
  typed DOM helpers (no UI framework).
- Title screen with authored layout, keyboard focus management, and rows that
  are disabled with a stated reason rather than hidden.
- PWA manifest and a reproducible generated icon set.
- Asset and content validation script covering file existence, size budgets,
  GLB/KTX2 container integrity, texture dimensions, licence records and
  placeholder text.
- Test infrastructure: Vitest (95 unit tests) and Playwright with desktop and
  Android-landscape projects, configured with SwiftShader so WebGL2 is genuinely
  available in headless CI.
- GitHub Actions: cross-platform CI (Ubuntu/Windows/macOS) and a Pages workflow
  gated on typecheck, tests, asset validation, build and a boot smoke test.
- Steering documents recording the quality, architecture, narrative and testing
  rules so they survive across sessions.

**Verification**

Typecheck clean. 95 unit tests pass. 17 browser E2E and 7 visual tests pass
against the production build in headless Chromium. Title screen reviewed at five
viewports from 667×375 to 1920×1080.

**Known limitations**

- No gameplay yet. The title screen menu rows are not wired to a game.
- WebGPU is unverified: no adapter is available in the CI container.
- Android, desktop browsers other than headless Chromium, and iOS Safari are
  unverified pending a real-device playtest.
