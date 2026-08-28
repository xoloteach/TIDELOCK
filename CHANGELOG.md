# Changelog

All notable changes to TIDELOCK. Each entry records what was typechecked,
tested, built and exercised in a browser at the time it was written, with the
measured numbers rather than intentions. Counts in older entries are historical
and are not restated as current;
[`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) always holds the
current measurements.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project is pre-1.0 and the save schema may change between milestones until
the campaign is content-complete.

## [Unreleased]

Entries are newest first. Nothing in this section has shipped: the deployed build
is the title screen, and every milestone below describes subsystems that are
tested in isolation and not reachable from `src/main.ts`. See
[`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) for the measured
account.

### Wave 1 — verified-defect fixes and the sequence subsystem

**Added**

- Sequence and cutscene subsystem. `sequenceSchema.ts` — previously a 0-byte
  file — now defines authored cinematic sequences (tracks, camera shots, easing,
  skip and resume policy) in 1,129 lines, and `SequenceSystem.ts` plays them on
  the fixed-timestep clock across 1,194 lines. The system reaches the world only
  through injected camera, actor, audio, subtitle, world and control ports, so it
  can be driven without a renderer. 85 tests cover validation, schedule
  construction, start, per-step dispatch, skip, suspend/resume, snapshot/restore
  and cleanup. `tests/unit/sequenceSystem.test.ts` loads the committed
  `content/sequences/prologue_cold_open.json` rather than retyping it — the first
  test in the project to exercise a shipped content file.
- `tests/unit/renderContext.test.ts` — 34 tests covering two-phase construction,
  `init()` idempotence, loud render-before-init, buffer sizing as
  `cssSize × min(devicePixelRatio, maxPixelRatio) × renderScale`, render-scale
  clamping, the pixel-ratio cap, fov and draw-distance application, camera aspect,
  backend read-back, the `ResizeObserver`-versus-window-resize fallback, and
  complete listener teardown. The GPU is mocked only at the `three/webgpu`
  boundary. `RenderContext` was previously the largest module in the project with
  no test of any kind.

**Fixed**

- `RenderContext.dispose()` leaked the `orientationchange` listener it
  registered. `observeSize()` held the handler in a local closure and never
  stored it, while `dispose()` removed only the separate resize fallback, so every
  disposed context — and the renderer it owned — stayed reachable from `window`
  for the lifetime of the page. That is a GPU-resource leak that grows with each
  renderer restart, which is what a preset change or a WebGPU→WebGL2 fallback
  does. All window listeners are now recorded on registration and drained on
  dispose, and dispose is idempotent because the teardown paths overlap.
- `RenderContext.render()` returned silently when called before `init()`, turning
  a wiring mistake into a black screen with an empty console. It now throws once,
  naming the missing `await init()`, and stays quiet afterwards so a render loop
  neither throws nor logs per frame. The flag resets on a successful `init()` so
  a render-after-dispose reports again.
- Boot could not distinguish a first run from an unreadable settings store. Both
  produced `false`, so in a storage-denied context — private browsing, embedded
  webviews, blocked storage — the capability-suggested quality preset was
  re-applied on every launch, silently discarding whatever the player had chosen
  that session. Storage state is now tri-valued (`present` / `absent` /
  `unavailable`); only `absent` adopts a suggestion, and a failed read is logged
  with its cause.
- `StreamingSystem`'s persistent-state clone fallback swallowed the error that
  forced it. The shallow-copy fallback leaves nested objects shared with the
  store, so a sector unload could mutate state the save system believed it had
  already captured — and the non-serialisable value responsible was invisible. It
  now reports the failure and names the offending keys.
- The `android-phone-landscape` Playwright project matched both
  `browser/mobile/**` and `browser/**`, and the second glob already subsumes the
  first, so every browser spec ran twice in that project. This doubled E2E
  runtime and inflated the pass count so coverage looked about twice as broad as
  it was. Mobile specs are still included and `visual/**` is still excluded.

**Verification**

Typecheck clean. 1,426 Vitest tests pass across 28 files, up from 1,307 across 26.
`pnpm lint:assets` reports 0 errors and 1 warning. Production build succeeds at
96.26 kB JS (gzip 27.39 kB) and 14.97 kB CSS (gzip 3.60 kB). Playwright: 47
declared, 41 pass, 6 skip — the skips are the live-Pages specs, which pass 3/3
when run with `PAGES_URL` set against the deployment. Six screenshots captured
and reviewed; the boot suite's "no fatal console errors" assertion holds on both
desktop Chromium and Pixel 7 landscape emulation.

The bundle grew 0.31 kB despite 2,323 new lines of source, because the sequence
subsystem is not reachable from `src/main.ts` and therefore is not in the
artefact. Grepping the production bundle finds no trace of Three.js, Rapier,
miniplex, Dexie, recast, `SequenceSystem` or `RenderContext`.

**Known limitations**

- Still no gameplay. All five title menu rows call `notImplemented()`.
  `state.transition('playing')` is never called; seven of nine declared app
  states are unreachable.
- `SequenceSystem` has never moved a real camera, played a real sound or shown a
  real subtitle. Every one of its ports is a test double.
- `pnpm test:story` and `pnpm test:mobile` fail with "No tests found" — their
  directories are empty. They fail loudly rather than passing vacuously, which is
  the correct signal, but the coverage `.kiro/steering/testing.md` requires does
  not exist.
- WebGPU remains unverified: no adapter in this container, so that render path
  has never executed anywhere.
- Whether the new renderer tests fail against the pre-fix source was reported by
  the implementing agent but is not independently reproduced here.

### M2/M3 — Engine core, input, physics, audio, saves and content schemas

**Added**

- ECS world and system scheduler on miniplex, with registration-order execution,
  per-phase throw isolation, and sector despawn that spares the player.
- `FrameStats` — FPS, 1% low and a ring buffer over a recency window, with
  wraparound proven against an all-time average.
- `RenderContext` — WebGPU with a WebGL2 backend fallback, and device-pixel-ratio
  kept separate from render scale so the two can be tuned independently.
- `QualitySystem` layering preset, user override and adaptive scaling, with the
  clamp proven so the scaler can never exceed the player's own choice.
- `DynamicScaler` — a hysteresis ladder with asymmetric timing (5 s down, 16 s
  up), a dead band, and no oscillation.
- `DiagnosticsOverlay` — budgets against the active preset, throttled to 5 Hz,
  writing only changed DOM nodes.
- TSL water material serving both WebGPU and WebGL2 from one source definition.
- Unified action map and `InputState`, with edge detection lasting exactly one
  frame, multi-source axis resolution by magnitude, and active-input-family
  switching gated by a deadzone.
- `KeyboardMouseSource` using `event.code` rather than `event.key`, with diagonal
  normalisation, pointer-lock failure that never breaks play, and blur releasing
  stuck keys.
- `GamepadSource` with a **radial** deadzone — anti-snapping proven against a
  per-axis implementation — trigger hysteresis, and deterministic style-detection
  ordering.
- `PhysicsWorld` on Rapier, tested against the real WASM rather than a mock, with
  bit-identical determinism across two worlds over 300 steps, `u32`
  collision-group packing, and far-sleep with hysteresis.
- `AudioEngine` on a raw Web Audio bus graph, with the bus topology asserted
  through real `connect()` edges, autoplay unlock, emitter-budget culling and a
  perceptual volume curve.
- Save system on Dexie and Zod, versioned with a v1→v2 migration, corruption
  recovery that preserves the original as a backup, an autosave ring, and
  export/import.
- `NavigationSystem` on Recast/Detour, tested against the real library.
- Mission and dialogue schemas with a condition AST and validators, including
  anti-slop checks that flag banned phrases, exposition dumps and dangling
  pointers.
- `TutorialSystem`, `InteractionSystem`, `PerceptionSystem`, `MachineAiSystem`,
  `PlayerController`, `PlayerCamera`, `StreamingSystem`, `sectorSchema`,
  `municipalMaterials`, `TitleBackdrop`, `Hud` and `Subtitles`.
- Authored prologue content: two dialogue scenes (42 nodes), one mission
  (7 objectives), one sequence (8 tracks) and nine tutorial prompts.

**Fixed**

Defects found by tests during the wave and fixed in the source, not by weakening
an assertion:

- `QualitySystem.applyAdaptive` could raise render scale above the player's
  choice. When a user override pushed `renderScale` below the preset's
  `minRenderScale` — the schema permits 0.3 on every preset — the clamp bounds
  inverted, and clamping *up* to the stale floor exceeded the explicit setting.
  Fixed by deriving the floor from the ceiling.
- `DynamicScaler`'s ladder desynced from `QualitySystem` on a preset change. The
  system cleared adaptive overrides while the scaler kept its ladder position, so
  the next *restore* re-applied rungs against cleared state and **lowered**
  quality. Fixed with a `presetChanged` event the scaler subscribes to.
- Quality restoration was unreachable on vsync-capped displays. Requiring frame
  times measurably *better* than target cannot be satisfied when the target FPS
  equals the refresh rate, so the scaler could only ever ratchet downward.
  Reworked to treat sustained comfort as grounds to attempt a restore, bounded by
  the 16 s/5 s asymmetry.
- A double `changed` emission per scaler decision (clear-then-apply) caused a
  spurious bounce to full ceiling resolution. `applyAdaptive` now replaces.
- `FrameStats.record(NaN)` permanently poisoned the running sum. Guarded.
- `migrateSave` accepted any object, so `{broken:true}` loaded as a pristine
  prologue and reported success — silently presenting a lost campaign as a working
  load. It now requires a slot, a `savedAt` and a checkpoint identity.
- `perceptualGain(+Infinity)` collapsed to silence instead of clamping to 1.
- `waterMaterial` imported a type that does not exist: `ShaderNodeObject` is not
  exported from `three/tsl` in 0.185. Replaced with properly-typed
  `Node<'float'>` and `Node<'vec3'>` aliases.

**Verification**

Typecheck clean. 1,307 Vitest tests across 26 files. Production build 95.95 kB JS
(gzip 27.26 kB). Rapier and Recast are exercised against their real WASM;
`fake-indexeddb` substitutes only the platform storage API.

**Known limitations**

- **Nothing in this milestone is imported by `src/main.ts`.** Every subsystem is
  proven correct in isolation and none of it runs in a browser. Because nearly
  every edge into these modules is an `import type`, TypeScript erases it and the
  modules are absent from the production bundle rather than dormant inside it —
  which is why 20 new modules did not move the bundle size at all.
- No content loader exists, so the authored prologue is validated at build time
  by `scripts/validate-assets.ts` and never loaded at runtime.
- `TutorialSystem` and `InteractionSystem` shipped without tests in this wave;
  tests were added subsequently. `sequenceSchema.ts` shipped as a 0-byte file.
- Dax Ren, one of the four main characters, has no authored lines.
- WebGPU, Android hardware, iOS Safari, non-Chromium desktop browsers and
  physical gamepads all remain unverified.

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
viewports from 667×375 to 1920×1080. (Counts as measured at M1.)

**Known limitations**

- No gameplay yet. The title screen menu rows are not wired to a game.
- WebGPU is unverified: no adapter is available in the CI container.
- Android, desktop browsers other than headless Chromium, and iOS Safari are
  unverified pending a real-device playtest.

### Wave 1 — verified-defect fixes and renderer test coverage

**Fixed**

- `RenderContext.dispose()` leaked the `orientationchange` listener it
  registered, keeping every disposed context (and its renderer) reachable from
  `window`. All window listeners are now recorded on registration and removed on
  dispose, and dispose is idempotent.
- `RenderContext.render()` returned silently when called before `init()`,
  turning a wiring mistake into an unexplained black screen. It now throws once,
  naming the missing `await init()`, without throwing or logging per frame.
- Boot could not tell a first run from an unreadable settings store, so in a
  storage-denied context it re-applied the capability-suggested quality preset
  on every launch over the player's explicit choice. Storage state is now
  tri-valued and read failures are logged.
- `StreamingSystem`'s persistent-state clone fallback swallowed the error that
  forced it. It now reports the failure and the offending keys.
- The `android-phone-landscape` Playwright project matched `browser/mobile/**`
  and `browser/**`, running every browser spec twice. Mobile specs are still
  included and `visual/**` is still excluded.

**Added**

- `tests/unit/renderContext.test.ts` — 34 tests covering two-phase
  construction, `init()` idempotence, loud render-before-init, buffer sizing as
  `cssSize × min(devicePixelRatio, maxPixelRatio) × renderScale`, render-scale
  clamping, pixel-ratio cap, fov/draw-distance application, camera aspect,
  backend read-back, `ResizeObserver` vs window-resize fallback, and complete
  listener teardown. The GPU is mocked only at the `three/webgpu` boundary.

**Verification**

Typecheck clean. 1341 Vitest tests pass across 27 files (was 1307/26). Build
succeeds at 96.26 kB JS / 14.97 kB CSS. 41 Playwright tests pass (6 live-Pages
specs skip without `PAGES_URL`) across desktop and Pixel 7 landscape, with the
boot suite's "no fatal console errors" assertion holding. Seven of the new
renderer tests were confirmed to fail against the pre-fix source.
