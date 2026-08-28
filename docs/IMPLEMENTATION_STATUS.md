# TIDELOCK — Implementation Status

Authoritative record of what actually works. Updated after every milestone.

**Last updated:** M2/M3 subsystem wave (engine core, input, physics, audio, saves, content schemas)

A feature is only listed under **Complete** if it has been run and verified,
not merely written. Anything unverified is stated as unverified.

---

## Verification snapshot

```
pnpm typecheck   0 errors
pnpm test        769 tests passed, 14 files
pnpm lint:assets passed (0 errors, 2 warnings — no assets committed yet)
pnpm build       succeeded, 95.95 kB JS / 14.97 kB CSS (gzip 27.26 / 3.60)
```

---

## Complete

### M1 — Project scaffold and bootable app shell

| Item | Evidence |
| --- | --- |
| pnpm project, pinned exact dependency versions | `pnpm install` clean |
| TypeScript strict, path aliases, Vite 8 + Pages base from `GITHUB_REPOSITORY` | `pnpm build` |
| Build identity (commit SHA, version, timestamp) | Visible in title footer |
| Municipal design token system | `src/ui/styles/tokens.css` — no neon/gradient/glass |
| Boot screen with named observable stages + fatal-error panel | Screenshot reviewed |
| Graphics capability probing (real WebGPU adapter request, WebGL2, KTX2 targets) | E2E asserts `webgl2 yes` |
| Six quality presets, data-driven, genuinely distinct | 46 tests incl. ≥4 non-resolution dimensions per adjacent pair |
| Settings schema (Zod), versioned, migrating | 34 tests incl. corrupt/truncated blobs |
| Fixed-timestep loop with catch-up cap and pause semantics | 15 tests incl. same-steps-at-30-vs-60-FPS |
| Title screen, PWA icons, asset/content validator | 17 E2E + 7 visual tests |
| CI (Ubuntu/Windows/macOS) + Pages deploy gated on smoke test | Both workflows green |
| **Live GitHub Pages deployment** | https://xoloteach.github.io/TIDELOCK/ boots, verified by `tests/browser/deployed.spec.ts` |

### M2 — Engine core

| Item | Tests | Notes |
| --- | --- | --- |
| ECS world + system scheduler (miniplex) | 62 | Registration-order execution, throw isolation per phase, sector despawn sparing the player |
| `FrameStats` — FPS, 1% low, ring buffer, recency window | 23 | Ring wraparound proven against all-time average |
| `RenderContext` — WebGPU + WebGL2 fallback, DPR/render-scale separation | — | Not yet wired into App; unverified in browser |
| `QualitySystem` — preset + user + adaptive layering | 43 | Clamping proven: scaler cannot exceed player's choice |
| `DynamicScaler` — hysteresis ladder | 15 | Asymmetric timing (5s down / 16s up), dead band, no-oscillation |
| `DiagnosticsOverlay` — budgets vs preset, throttled 5 Hz, changed-only DOM writes | — | Not yet wired into App |
| TSL water material (WebGPU + WebGL2 from one source) | — | Compiles; not yet rendered |

### M3 — Input, physics, audio, saves, content schemas

| Item | Tests | Notes |
| --- | --- | --- |
| Unified action map (`actions.ts`) + `InputState` | 57 | Edge detection exactly one frame; multi-source axis resolution by magnitude; active-family switching with deadzone |
| `KeyboardMouseSource` | 80 | `event.code` not `event.key`; diagonal normalisation; pointer-lock failure never breaks play; blur releases stuck keys |
| `GamepadSource` | 111 | **Radial** deadzone (anti-snapping proven against per-axis); trigger hysteresis; style detection order |
| `PhysicsWorld` (Rapier, real WASM, not mocked) | 52 | **Bit-identical determinism across two worlds over 300 steps**; collision-group u32 packing; far-sleep with hysteresis |
| `AudioEngine` (raw Web Audio bus graph) | 74 | Bus topology asserted via real `connect()` edges; autoplay unlock; emitter budget culling; perceptual volume curve |
| Save system (Dexie + Zod, versioned, v1→v2 migration) | 68 | Corruption recovery preserves the original as backup; autosave ring; export/import |
| Mission + dialogue schemas with condition AST and validators | 89 | Anti-slop validators flag banned phrases, exposition dumps, dangling pointers |
| `TutorialSystem` + registry | — | **Tests not written** (stream cut off) |
| `InteractionSystem` | — | **Tests not written** (stream cut off) |
| `sequenceSchema` | — | `SequenceSystem` **not written** (stream cut off) |

### Bugs found and fixed during this wave

Real defects, each found by a test and fixed in the source rather than by
weakening an assertion:

1. **`QualitySystem.applyAdaptive` could raise render scale above the player's
   choice.** When a user override pushed `renderScale` below the preset's
   `minRenderScale` (the schema permits 0.3 on every preset), the clamp bounds
   inverted and clamping *up* to the stale floor exceeded the explicit setting.
   Fixed by deriving the floor from the ceiling.
2. **`DynamicScaler` ladder desynced from `QualitySystem` on preset change.**
   The system cleared adaptive overrides; the scaler kept its ladder position,
   so the next *restore* re-applied rungs against cleared state and **lowered**
   quality. Fixed with a `presetChanged` event the scaler subscribes to.
3. **Quality restoration was unreachable on vsync-capped displays.** Requiring
   frame times measurably *better* than target cannot be satisfied when target
   FPS equals refresh rate, so the scaler could only ever ratchet downward.
   Reworked to treat sustained comfort as grounds to attempt a restore, bounded
   by the 16s/5s asymmetry.
4. **Double `changed` emission per scaler decision** (clear-then-apply) caused a
   spurious bounce to full ceiling resolution. `applyAdaptive` now replaces.
5. **`FrameStats.record(NaN)`** permanently poisoned the running sum. Guarded.
6. **`migrateSave` accepted any object**, so `{broken:true}` loaded as a pristine
   prologue and reported success — silently presenting a lost campaign as a
   working load. Now requires slot + savedAt + checkpoint identity.
7. **`perceptualGain(+Infinity)`** collapsed to silence instead of clamping to 1.
8. **`waterMaterial` imported a non-existent type** (`ShaderNodeObject` is not
   exported from `three/tsl` in 0.185). Replaced with properly-typed
   `Node<'float'>` / `Node<'vec3'>` aliases.

---

## In Progress

Three streams from the parallel wave were interrupted before completing:

1. **HUD + Subtitles UI** — nothing delivered. Needs `src/ui/Hud.ts`,
   `src/ui/Subtitles.ts`, `hud.css`, `subtitles.css` + tests.
2. **`SequenceSystem`** — `sequenceSchema.ts` landed; the system and its tests
   did not.
3. **Tests for `TutorialSystem` and `InteractionSystem`** — both systems exist
   and typecheck, but neither has a test file, so neither is verified.

---

## Blocked

Nothing blocked.

---

## Next 10 Tasks

1. Finish the three interrupted streams above (HUD/Subtitles, `SequenceSystem`,
   tutorial + interaction tests).
2. **Wire the engine into `App`** — this is now the critical path. Every M2/M3
   subsystem is tested in isolation but **nothing is imported by `main.ts`**, so
   none of it runs in a browser yet. Renderer, loop, ECS, input, physics,
   audio, diagnostics all need integration.
3. Player controller: capsule kinematic movement on Rapier (walk/sprint/crouch/
   jump/vault), third-person camera with collision avoidance.
4. Resolve the documented look-axis seam: mouse reports displacement, stick
   reports rate, both land on `lookX`/`lookY` and `InputState` clamps to ±1.
   The camera owner must pick one convention.
5. Touch input source + context-aware mobile HUD.
6. World sector streaming + greybox Recovery Depot; BVH interaction targeting.
7. Mission + dialogue *runtime* (the schemas exist; the systems do not).
8. Recast navmesh + NPC/machine AI.
9. Campaign content: Prologue through Epilogue, three endings.
10. TTS pipeline, graphics/art polish, mobile control editor, benchmark suite.

---

## Known Regressions

None. 769 tests pass; no test is skipped or disabled.

---

## Performance

No gameplay exists yet, so there are no frame-time numbers. Measured facts:

| Metric | Value |
| --- | --- |
| JS bundle (gzip) | 27.26 kB |
| CSS bundle (gzip) | 3.60 kB |

Noted risk: `@dimforge/rapier3d-compat` inlines its WASM as base64, which
measured ~2.9 MB in an isolated bundle. Once physics is imported by the app
this lands in the initial payload and will need a deliberate loading strategy.

---

## Story Completion

Per spec §40. No campaign content implemented yet — the data model and
validators exist, the content does not.

- [ ] Prologue fully playable
- [ ] All four main characters introduced naturally
- [ ] Acts I–III playable start to finish
- [ ] Finale playable
- [ ] Three final choices functional
- [ ] Three epilogue variations functional
- [ ] Dialogue audio + synchronised subtitles
- [ ] No placeholder dialogue
- [ ] Major beats have authored cinematic treatment
- [ ] Player understands the 37-minute timeline without an exposition dump

Story bible recorded in `.kiro/steering/narrative.md`.

---

## Test Coverage

| Suite | Files | Tests | Status |
| --- | --- | --- | --- |
| Unit | 12 | 649 | pass |
| Integration | 1 | 52 | pass (real Rapier WASM) |
| Saves | 1 | 68 | pass (fake-indexeddb substitutes the platform API only) |
| Browser E2E | 2 | 20 | pass (17 local + 3 against live Pages) |
| Visual capture | 1 | 7 | pass |
| Performance | 0 | 0 | not started |

---

## Asset Issues

`public/assets/` still contains no 3D or audio assets, so `pnpm lint:assets`
reports two informational warnings. `ASSET_LICENSES.md` records only the
generated PWA icon set. The licence gate was verified to genuinely fail on an
unrecorded asset.

---

## Platform Verification Notes

| Path | Status |
| --- | --- |
| WebGL2 (SwiftShader, headless Linux) | Verified |
| GitHub Pages deployment | Verified — boots, correct base path, manifest + icons resolve |
| WebGPU | **Not verified.** No adapter in this container. |
| Android Chrome | **Not verified.** Needs the human playtest. |
| Gamepad hardware | **Not verified.** No way to inject a synthetic pad in headless Chromium. |
| iOS Safari / non-Chromium desktop | **Not verified.** |

The most important honest caveat: **every M2/M3 subsystem is unit-tested but
unwired.** They are proven correct in isolation and proven to compile into the
bundle, but the game a player loads today is still only the title screen.
Integration is the next milestone.
