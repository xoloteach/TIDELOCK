# TIDELOCK — Implementation Status

Authoritative record of what actually works. Updated after every milestone.

**Last updated:** milestone M1 (project scaffold and bootable app shell)
**Latest verified commit:** see `git log` — this file is committed with the
milestone it describes.

A feature is only listed under **Complete** if it has been run and verified,
not merely written. Anything unverified is stated as unverified.

---

## Complete

### M1 — Project scaffold and bootable app shell

| Item | Evidence |
| --- | --- |
| pnpm project, pinned exact dependency versions | `pnpm install` clean; `package.json` |
| TypeScript strict config, path aliases | `pnpm typecheck` passes with 0 errors |
| Vite 8 build with GitHub Pages base derived from `GITHUB_REPOSITORY` | `pnpm build` produces `dist/`, 99 modules |
| Build identity injected (commit SHA, timestamp, version) | Visible in title footer: `build 1d348a5  v0.1.0` |
| Directory structure matching spec §28 | `src/{app,engine,game,graphics,ui,accessibility,persistence,diagnostics}`, `content/`, `tests/` |
| Design token system (municipal art direction) | `src/ui/styles/tokens.css` — no neon/gradient/glass |
| Boot screen with named, observable stages | Screenshot `test-results/screens/boot.png`; 3 stages all report `ok` |
| Fatal boot error reporting (no silent black screen) | `BootScreen.showFatalError`; E2E asserts `fatalError` is null on success |
| Graphics capability probing (WebGPU adapter request, WebGL2, device class, KTX2 targets) | E2E asserts `webgl2 yes`; `describeCapabilities()` output |
| Renderer backend selection with WebGL2 fallback + `?webgl2=1` force flag | E2E `forcing the WebGL2 backend works and is reported` |
| Six quality presets, data-driven, genuinely distinct | 46 unit tests incl. "differs in ≥4 non-resolution dimensions" per adjacent pair |
| Settings schema (Zod), versioned, with migration | 34 unit tests incl. corrupt JSON, truncated blobs, dropped unknown keys |
| Settings persistence + debounced writes + quota-failure degradation | Unit tests; E2E preset survives reload |
| Fixed-timestep loop with catch-up cap and pause semantics | 15 unit tests incl. "same steps at 30 vs 60 FPS", stall clamping |
| Typed event emitter | Used by `SettingsStore`; covered indirectly by settings tests |
| App state machine with declared legal transitions | `src/app/AppState.ts` |
| Title screen (authored layout, keyboard focus, disabled-with-reason rows) | Screenshots at 5 viewports; 11 E2E assertions |
| PWA manifest + generated icon set | `scripts/generate-icons.ts`; valid PNGs verified with `file` |
| Asset/content validation script | `pnpm lint:assets` passes (warnings only, no assets yet) |
| Playwright setup: desktop + Android-landscape projects, SwiftShader WebGL2 | 17 boot E2E + 7 visual tests pass |

**Verification run for M1**

```
pnpm typecheck   0 errors
pnpm test        95 tests passed (3 files)
pnpm lint:assets passed (0 errors, 2 warnings — no assets committed yet)
pnpm build       succeeded, dist 95.67 kB JS / 14.92 kB CSS (gzip 27.18 / 3.60)
playwright       17 passed (browser), 7 passed (visual)
```

Screenshots captured and visually reviewed: title at 1280×720, 1920×1080,
667×375, 915×412, 1180×820; boot screen.

---

## In Progress

Nothing. M1 is closed; M2 has not started.

---

## Blocked

Nothing currently blocked.

---

## Next 10 Tasks

Ordered by the spec's priority list (§46 "Priority order"). Each must end with
typecheck, tests, build, browser verification, status update, commit, push.

1. **M2 — Renderer + engine core.** `WebGPURenderer` with WebGL2 backend, canvas
   sizing/DPR handling, scene graph root, `QualitySystem` applying presets to the
   renderer, `DynamicScaler` with hysteresis, `stats-gl` instrumentation,
   diagnostics overlay (F1 / `?diagnostics=1`), ECS world via miniplex, wiring
   `FixedStepLoop` into the app.
2. **M3 — Input system.** Unified action map; keyboard/mouse with pointer lock
   and graceful fallback; Gamepad API; touch scheme (nipplejs joystick, camera
   swipe region, context-aware buttons); active-input-family detection driving
   prompt glyphs.
3. **M4 — Physics + player controller.** Rapier at fixed 60 Hz, capsule kinematic
   controller (slopes, stairs, step-up, snap-to-ground), third-person
   over-shoulder camera with collision avoidance, walk/sprint/crouch/jump/vault.
4. **M5 — World sectors + interaction.** Sector data model, streaming
   (current/adjacent/transition), static collider + BVH build, interaction
   system with a single consistent verb, greybox Recovery Depot. First playable
   vertical slice.
5. **M6 — Mission + dialogue systems.** Objective data model with activation and
   completion conditions; data-driven dialogue graph with conditions, flags,
   choices, interrupts; subtitle rendering and timing.
6. **M7 — Saves.** Dexie + Zod campaign saves, versioned with migrations,
   checkpoints, autosave, corruption recovery with backup retention, export/reset.
7. **M8 — Tutorials + cinematic sequences.** First-use contextual tutorial
   registry with save-persistent completion and reset; `SequenceSystem` with
   camera/actor/dialogue/audio/world tracks, hold-to-skip, and guaranteed
   control restoration.
8. **M9 — AI + navigation.** Recast navmesh per sector; human NPC states
   (Idle/Work/WalkTo/Observe/Converse/React/Shelter/ScriptedTask); machine
   perception (vision cone, occlusion, sound, last-known position) and states
   (Dormant→Patrol→Inspect→Suspicious→Alert→Search→Pursue→Recover→Disabled);
   bounded alert propagation.
9. **M10 — Campaign content.** Prologue, Acts I–III, Finale, three endings,
   epilogue variations. Authored dialogue in the four established voices.
10. **M11 — Audio + TTS pipeline.** Web Audio bus graph (Master/Music/Ambience/
    Dialogue/Effects/UI), positional emitters, audio zones, autoplay unlock;
    build-time `edge-tts` generation behind a replaceable adapter with content
    hashing, plus FFmpeg loudness normalisation and subtitle timing output.

Remaining after those: M12 graphics/art polish (water, wetness, rain, LOD,
post), M13 mobile control editor and full menu/accessibility UI, M14 full test
matrix + GitHub Actions + PWA hardening + benchmark suite, M15 benchmark
self-score and release polish.

---

## Known Regressions

None.

---

## Performance

No gameplay exists yet, so there are no meaningful frame-time numbers. Only
build size is measurable:

| Metric | Value |
| --- | --- |
| JS bundle (gzip) | 27.18 kB |
| CSS bundle (gzip) | 3.60 kB |
| Precached PWA entries | 8 (109.64 KiB) |

Benchmark instrumentation is scheduled for M2 (diagnostics) and M14 (benchmark
route). No FPS or GPU-time claims will be made until measured.

---

## Story Completion

Per spec §40. Nothing implemented yet — M10 is the content milestone.

- [ ] Prologue fully playable
- [ ] All four main characters introduced naturally
- [ ] Act I playable start to finish
- [ ] Act II playable start to finish
- [ ] Act III playable start to finish
- [ ] Finale playable
- [ ] Three final choices functional
- [ ] Three epilogue variations functional
- [ ] Dialogue audio exists for required lines
- [ ] Subtitles synchronised
- [ ] No placeholder dialogue
- [ ] Every main conversation has blocking/staging
- [ ] Major beats have authored cinematic treatment
- [ ] Cutscenes transition cleanly and are skippable
- [ ] Player understands the 37-minute timeline without an exposition dump

The story bible is recorded in `.kiro/steering/narrative.md` so it survives
across sessions.

---

## Test Coverage

| Suite | Files | Tests | Status |
| --- | --- | --- | --- |
| Unit | 3 | 95 | pass |
| Integration | 0 | 0 | not started (M2) |
| Saves | 0 | 0 | not started (M7) |
| Browser E2E | 1 | 17 | pass |
| Visual capture | 1 | 7 | pass |
| Performance | 0 | 0 | not started (M14) |

No tests are skipped or disabled.

---

## Asset Issues

`public/assets/` contains no 3D or audio assets yet, so `pnpm lint:assets`
reports two informational warnings (empty asset tree, empty content tree). These
become errors once the corresponding milestones land.

`ASSET_LICENSES.md` exists and currently records only project-authored assets
(the generated PWA icon set).

---

## Platform Verification Notes

Stated honestly rather than assumed:

| Path | Status |
| --- | --- |
| WebGL2 (SwiftShader, headless Linux) | Verified in CI container |
| WebGPU | **Not verified.** No WebGPU adapter is available in this container. Requires real-hardware validation. |
| Android Chrome | **Not verified.** Requires the human Android playtest once GitHub Pages deploys. |
| Desktop Chrome/Firefox/Safari | **Not verified** beyond headless Chromium. |
| iOS Safari | **Not verified.** |
