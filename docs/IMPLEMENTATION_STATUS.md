# TIDELOCK — Implementation Status

Authoritative record of what actually works. Updated after every milestone.

**Last updated:** Wave 1 — verified-defect fixes, sequence/cutscene subsystem,
renderer test coverage. Measured on the working tree on top of commit `4b87354`;
the wave's code changes are not yet committed.

A claim appears here only if it was run and verified, not merely written.
Anything unverified is stated as unverified. Nothing in this document is carried
over from a previous entry without being re-measured.

---

## Verification snapshot

Every number below came from running the command on this tree.

```
pnpm typecheck   0 errors
pnpm test        1426 passed, 28 files, 0 skipped        (48.63 s)
pnpm lint:assets 0 errors, 1 warning ("public/assets contains no files yet")
pnpm build       96.26 kB JS (gzip 27.39) · 14.97 kB CSS (gzip 3.60)
                 1.53 kB index.html (gzip 0.72) · 100 modules transformed
                 PWA precache 8 entries, 110.26 KiB
pnpm test:e2e    47 declared · 41 passed · 6 skipped     (2.4 min)
pnpm test:story  FAILS — "No tests found", exit code 1
pnpm test:mobile FAILS — "No tests found", exit code 1
```

Baseline immediately before this wave, measured by re-running the same commands
at `4b87354`: **1307 tests across 26 files, 95.95 kB JS / gzip 27.26 kB.**

E2E splits across two Playwright projects: `desktop-chromium` (17 boot specs, 3
deployed-Pages specs, 7 visual captures) and `android-phone-landscape` (17 boot
specs, 3 deployed-Pages specs, Pixel 7 landscape emulation). The 6 skips are the
deployed-Pages specs, which no-op unless `PAGES_URL` is set — so the default
`pnpm test:e2e` run does **not** exercise the live deployment.

Run separately with `PAGES_URL=https://xoloteach.github.io/TIDELOCK/`, all 3
deployed specs pass: the site returns HTTP 200, boots to the title screen with no
failed requests, and serves the manifest and icons from the correct base path.
That deployment serves commit `4b87354`, so it does not include this wave.

Browser evidence, not static review: the boot suite's "no fatal console errors"
assertion holds in both projects, and `tests/visual` captured six screenshots to
`test-results/screens/`. `title-desktop-720p.png` was reviewed — wordmark,
municipal subtitle line, five menu rows with Continue and Load correctly disabled
and labelled "no save yet", and a footer reading `webgl2 compatibility` and
`build 4b87354`. The background is flat CSS. There is no rendered 3D content on
screen at any point.

---

## The central fact

**The shipped game is: boot → capability probe → title screen. Nothing else.**

At commit `4b87354`, only **13 of the 50 TypeScript modules under `src/`** were
reachable from `src/main.ts`. This wave added one module (`SequenceSystem.ts`),
bringing the total to 51, and did not change the reachable count: it is still 13.

The reachable set, in full:

```
src/main.ts
src/app/App.ts              src/app/AppState.ts
src/app/buildInfo.ts        src/app/flags.ts
src/ui/dom.ts               src/ui/BootScreen.ts        src/ui/TitleScreen.ts
src/persistence/SettingsStore.ts   src/persistence/settingsSchema.ts
src/engine/events.ts        src/engine/render/Capabilities.ts
src/graphics/quality/presets.ts
```

All five title menu rows — Continue, New Game, Load, Settings, Credits — route to
`App.notImplemented()`, which emits a `console.warn` and returns.
`state.transition()` is called exactly once in the entire codebase, at
`App.ts:173`, with `'title'`. Of the nine declared app states, **two are ever
reached**: `booting` (the initial value) and `title`. The remaining seven —
`loading`, `playing`, `paused`, `dialogue`, `cinematic`, `ending`, `failed` — are
unreachable at runtime. Even `failed` is dead: `main.ts` reports a fatal startup
error by calling `boot.showFatalError()` directly and never enters the state.

### The unwired half is absent from the bundle, not dormant in it

Nearly every edge from the reachable set into the rest of `src/` is an
`import type`. TypeScript erases those, so the modules are not merely unused —
they are **not in the shipped artefact at all**.

Verified by grepping the production bundle. Every one of these returns zero
matches in `dist/assets/index-*.js`:

```
Rapier   miniplex   nipplejs   recast   Dexie
WebGLRenderer   BufferGeometry
RenderContext   SequenceSystem   sequenceSchema
DialogueSystem  MissionSystem    TitleBackdrop
```

Three.js is absent in its entirety. So is the physics engine, the ECS, the save
database and the navigation library, despite all four being declared runtime
dependencies.

The bundle size is the cleanest evidence. This wave added **2,323 lines** of
sequence subsystem (`sequenceSchema.ts` 1,129 + `SequenceSystem.ts` 1,194) plus
substantive changes to `RenderContext`. The bundle moved from 95.95 kB to
96.26 kB — **+0.31 kB**, entirely attributable to `App.ts`, the only *reachable*
file the wave touched. The 2,323 new lines contributed nothing, because nothing
imports them.

`three-mesh-bvh`, `stats-gl`, `tweakpane` and `@pmndrs/detect-gpu` are declared
dependencies with **zero imports anywhere in `src/` or `scripts/`**. The only
mentions of `three-mesh-bvh` are two comments describing what a raycast will
eventually be backed by.

---

## Orphan modules

38 of 51 modules are unreachable from `src/main.ts` — 37 of 50 at `4b87354`,
before `SequenceSystem.ts` was added to the unwired side. Grouped by what
verifies them:

**Unit- or integration-tested, unwired (36).** `AudioEngine`, `components`,
`GameWorld`, `actions`, `GamepadSource`, `InputState`, `KeyboardMouseSource`,
`TouchSource`, `NavigationSystem`, `PhysicsWorld`, `FrameStats`, `RenderContext`,
`FixedStepLoop`, `MachineAiSystem`, `PerceptionSystem`, `dialogueSchema`,
`DialogueSystem`, `InteractionSystem`, `missionSchema`, `MissionSystem`,
`PlayerCamera`, `PlayerController`, `sequenceSchema`, `SequenceSystem`,
`tutorialSchema`, `TutorialSystem`, `sectorSchema`, `StreamingSystem`,
`municipalMaterials`, `DynamicScaler`, `QualitySystem`, `saveSchema`,
`SaveStore`, `TitleBackdrop`, `Hud`, `Subtitles`.

**No test at all (2).** `src/diagnostics/DiagnosticsOverlay.ts` and
`src/graphics/water/waterMaterial.ts`. Neither is imported by any test file and
neither is in the bundle, so neither has ever executed.

Two entries on the previous orphan-without-tests list are now closed:
`RenderContext` gained 34 tests this wave, and `sequenceSchema` — a 0-byte file —
was implemented and is covered by the 85 tests in `sequenceSystem.test.ts`.

One item on that list was wrong and is corrected here: **`PlayerCamera` was
already tested.** `tests/unit/playerController.test.ts` imports it directly, and
its 37 tests cover both the controller and the camera.

Separately, ten modules have no direct test but are in the reachable set and are
exercised by browser E2E: `main`, `App`, `AppState`, `buildInfo`, `flags`, `dom`,
`BootScreen`, `TitleScreen`, `Capabilities`, and `events` (the last only
transitively, through the many unit tests of systems that use it).

`TitleBackdrop.ts` deserves a specific mention: it is unit-tested, it is the only
thing in the repository that would put rendered geometry behind the title screen,
and it is not imported by `TitleScreen` or anything else. The title background
seen in the screenshot is CSS.

---

## Wave 1 — defects fixed

Five defects, each fixed at the root cause rather than at the symptom.

1. **`RenderContext.dispose()` leaked an `orientationchange` listener on every
   create/dispose cycle.** `observeSize()` registered the orientation handler as
   a local closure and never stored it, while `dispose()` removed only the
   separate *resize* fallback held in `orientationHandler`. The orientation
   closure captured `this`, so every disposed context — and the WebGPU renderer
   it owned — stayed reachable from `window` for the lifetime of the page. The
   consequence is a GPU-resource leak that grows with each renderer restart,
   which is exactly what a graphics-preset change or a WebGPU→WebGL2 fallback
   does. Listener registration now goes through a single bookkeeping path that
   `dispose()` drains completely, and `dispose()` is idempotent because the
   teardown paths overlap and can double-fire.

2. **`render()` before `init()` failed silently.** It returned early. A caller
   who forgot `await ctx.init()` therefore got a black screen and an empty
   console — the precise failure mode the "fatal errors are loud" rule exists to
   prevent, and one that is near-impossible to diagnose on a phone. It now
   throws once, with a message naming the missing `await init()`, then stays
   quiet so a render loop neither throws nor logs sixty times a second. The flag
   resets on a successful `init()`, so a render-after-dispose reports again
   instead of being permanently masked by the first report.

3. **`App.hasStoredSettings()` reported "first run" when storage was
   unreadable.** A blocked or absent `localStorage` threw, the `catch` returned
   `false`, and `false` was indistinguishable from a genuine first run. In a
   storage-denied context — private browsing, embedded webviews, blocked
   third-party storage — `stageCapabilities` therefore re-applied the
   capability-suggested quality preset on **every** launch, silently discarding
   whatever the player picked that session. Replaced with a tri-state read:
   `present` / `absent` / `unavailable`. Only `absent` adopts a suggestion, and
   an unreadable read is logged with its cause instead of swallowed.

4. **`StreamingSystem`'s persistent-state clone fallback was silent.** The
   `structuredClone` catch degraded to a shallow spread with no logging. That
   fallback leaves nested objects *shared* with the store, so a sector unload can
   mutate state the save system believes it already captured — a progress-loss
   class of bug — and the value responsible (almost always a function or class
   instance that should never have been in persistent state) was invisible. It
   now reports the failure and names the offending keys, matching how the rest of
   the file handles caught errors.

5. **Playwright ran every browser spec twice on Android.** The
   `android-phone-landscape` project matched both `browser/mobile/**/*.spec.ts`
   and `browser/**/*.spec.ts`; the second glob already subsumes the first. The
   consequence was a doubled E2E runtime and an inflated pass count that made
   coverage look roughly twice as broad as it was. Reduced to `browser/**` alone,
   which still includes mobile specs and still excludes `visual/**`. Confirmed in
   the run above: each of the 17 boot specs is listed exactly once per project.

I did not independently reproduce the implementing agent's claim that seven of
the new renderer tests fail against the pre-fix source; verifying it would have
required reverting source files, which is outside this task's scope. **That claim
is unverified here.**

---

## Sequence / cutscene subsystem

`src/game/sequences/sequenceSchema.ts` was a 0-byte file. It is now 1,129 lines
with 72 exports, and `SequenceSystem.ts` (1,194 lines) plays the sequences it
describes. 85 tests in `tests/unit/sequenceSystem.test.ts` cover schema
validation, `validateSequence`, schedule construction, `start`, fixed-timestep
dispatch, `skip`, suspend/resume, snapshot/restore and `cleanup` — which is the
full start/skip/resume/cleanup coverage `testing.md` requires for cutscenes.

Two honest qualifications:

- `SequenceSystem` reaches the world only through injected ports
  (`SequenceCameraPort`, `SequenceActorPort`, `SequenceAudioPort`,
  `SequenceSubtitlePort`, `SequenceWorldPort`, `SequenceControlPort`). Every port
  is a test double in the test suite. **No sequence has ever moved a real camera,
  played a real sound, or displayed a real subtitle.**
- It is unwired and absent from the bundle, like the rest of `game/`.

One genuine first: `sequenceSystem.test.ts` imports
`content/sequences/prologue_cold_open.json` — the only test in the repository
that loads a shipped content file rather than an inline fixture.

---

## Content reality

**42 authored spoken dialogue lines against a 300–380 target: roughly 12%.**

| Speaker | Lines | Target (spec) |
| --- | --- | --- |
| Sera Holt | 16 | 80–100 |
| Mara Venn | 14 | 70–90 |
| Ivo Saye | 12 | 65–85 |
| **Dax Ren** | **0** | 60–80 |

Counted from the two committed dialogue files: `prologue_depot.json` (26 nodes —
Ivo 12, Mara 8, Sera 6) and `prologue_bridge.json` (16 nodes — Sera 10, Mara 6).
Every node has a speaker, so nodes and spoken lines are the same number here.

Dax Ren is not a speaker and not listed in the `participants` array of either
scene. He does not exist in the game's content in any form.

**Zero dialogue nodes carry an `audio` field.** No line is voiced, and no
build-time voice pipeline exists — `edge-tts` is described in `README.md` and
`ASSET_LICENSES.md` but appears nowhere in `scripts/` or `package.json`.

Other content:

| Path | State |
| --- | --- |
| `content/missions/prologue.json` | 7 objectives |
| `content/sequences/prologue_cold_open.json` | 8 tracks |
| `content/tutorials/prologue.json` | 9 entries |
| `content/dialogue/` | 2 files, 42 nodes |
| `content/evidence/` | **empty** |
| `content/localization/` | **empty** |
| `public/assets/{models,textures,audio,nav,sectors}` | **0 files total** |

Acts I, II and III, the Finale and the Epilogue have **no content of any kind** —
no dialogue, no missions, no sequences, no sectors.

Because `content/localization/` is empty, the nine tutorial `messageKey` values
(`tutorial.move`, `tutorial.look`, `tutorial.interact`,
`tutorial.dialogueChoice`, `tutorial.ladderClimb`, `tutorial.vault`,
`tutorial.sprint`, `tutorial.objectiveJournal`, `tutorial.autosave`) resolve to
nothing. There is no string table for them to resolve against.

### No runtime content loader exists

`grep -rn "content/" src` returns exactly one match, and it is a doc comment in
`sequenceSchema.ts`. There is no `fetch` of a content file and no dynamic import
of one anywhere in `src/`. The only `fetch` in the source tree is an injectable
seam in `AudioEngine`, and nothing calls it with a content path.

The only consumer of `content/*.json` in the whole repository is
`scripts/validate-assets.ts`, which is build-time validation. One test —
`sequenceSystem.test.ts` — loads a shipped content file; every other test uses
inline fixtures.

So the authored prologue is **validated at build time and never loaded at
runtime.** Writing a content loader is a prerequisite for any of it reaching a
player.

---

## Test coverage

| Suite | Files | Tests | Status |
| --- | --- | --- | --- |
| Unit | 25 | 1,261 | pass |
| Integration | 2 | 97 | pass (real Rapier WASM, real Recast) |
| Saves | 1 | 68 | pass (`fake-indexeddb` substitutes the platform API only) |
| Browser E2E | 2 files, 2 projects | 41 pass, 6 skip | skips are the live-Pages specs |
| Visual capture | 1 | 7 | pass, 6 screenshots written |
| Story smoke | 0 | 0 | **directory empty — command fails** |
| Mobile | 0 | 0 | **directory empty — command fails** |
| Performance | 0 | 0 | **directory empty, no command** |

### Gaps against `.kiro/steering/testing.md`

`tests/browser/story`, `tests/browser/mobile` and `tests/performance` are empty
directories. Verified by running the commands rather than inferring:

```
$ pnpm test:story
Error: No tests found.
 ELIFECYCLE  Command failed with exit code 1

$ pnpm test:mobile
Error: No tests found.
 ELIFECYCLE  Command failed with exit code 1
```

Both **fail loudly** rather than passing vacuously — they are not silent
false-greens. The mechanism is Playwright's own refusal to run an empty match
set; there is no `--pass-with-no-tests` in either script. Note that `forbidOnly`
is gated on `process.env.CI`, so it is not the cause. Both commands also pay the
full `pnpm build && pnpm preview` webServer cost before failing.

Required E2E coverage that does not exist: **New Game, prologue begins, settings
open, every graphics preset selectable, settings persisting across reload for
graphics presets specifically, touch HUD appearing under mobile emulation,
keyboard HUD hidden on touch, save created, continue resumes, scene transition.**
Required integration coverage that does not exist: **renderer init in a real
browser context, sector load/unload against real sector files, navmesh load from
a real `.bin`, player spawn, and checkpoint save/load joined end-to-end** (the
save store and the mission state are each tested, but never together).

The root cause of every one of these gaps is the same, and it is not missing test
specifications. **You cannot write an E2E test for "New Game" when New Game logs
a warning, and you cannot test a touch HUD that no state machine can reach.** The
gaps close when the integration layer lands, and not before.

---

## In progress

Nothing. The sequence subsystem was the last interrupted stream from the previous
wave and is now complete as an isolated, tested, unwired subsystem.

## Blocked

Nothing is blocked by an external dependency. Everything is blocked on the same
internal work: the integration layer.

---

## Performance

**No gameplay exists, so there are no frame-time numbers.** There is no
performance test suite, no benchmark route, and no measured FPS on any device or
preset. Every FPS figure in the preset table and in `README.md` is a design
target, not a measurement.

Measured facts only:

| Metric | Value |
| --- | --- |
| JS bundle | 96.26 kB (gzip 27.39 kB) |
| CSS bundle | 14.97 kB (gzip 3.60 kB) |
| PWA precache | 8 entries, 110.26 KiB |
| Vite production build | 227 ms, 100 modules transformed |
| Full Vitest run | 48.63 s |
| Full Playwright run | 2.4 min |

Standing risk, still unmeasured on this tree: `@dimforge/rapier3d-compat` inlines
its WASM as base64. An isolated bundle previously measured ~2.9 MB. Rapier is not
in the current bundle at all, so that cost has not yet been paid — it lands in
the initial payload the moment physics is imported by anything reachable, and
needs a deliberate loading strategy before then. The ~2.9 MB figure is from an
earlier experiment and is **not re-verified here.**

---

## Platform verification

| Path | Status |
| --- | --- |
| WebGL2 via SwiftShader, headless Linux Chromium | **Verified.** Boot suite asserts a real backend and GPU string in both projects. |
| GitHub Pages deployment | **Verified.** HTTP 200; 3 deployed specs pass with `PAGES_URL` set. Serves `4b87354`, i.e. not this wave. |
| Desktop Chromium 1280×720 | **Verified.** 17 boot specs + 7 visual captures. |
| Pixel 7 landscape emulation | **Verified as emulation only.** 17 boot specs. Emulated viewport and touch flags, not a real device. |
| WebGPU | **Not verified.** No adapter available in this container. The WebGPU render path has never executed anywhere. |
| Android hardware | **Not verified.** Needs a human playtest. |
| iOS Safari | **Not verified.** |
| Non-Chromium desktop (Firefox, Safari) | **Not verified.** No project configured. |
| Gamepad hardware | **Not verified.** 111 unit tests drive a synthetic `navigator.getGamepads` shape; no physical pad has ever been connected. |
| Touch hardware | **Not verified.** `TouchSource` has 56 unit tests and is not reachable from any screen. |

---

## Story completion

Per spec §40. The data model, the validators and the sequence player exist. The
campaign does not.

- [ ] Prologue fully playable — *no content loader; no `playing` state*
- [ ] All four main characters introduced naturally — *Dax Ren has 0 lines and appears nowhere*
- [ ] Acts I–III playable start to finish — *no content authored*
- [ ] Finale playable — *no content authored*
- [ ] Three final choices functional — *not authored*
- [ ] Three epilogue variations functional — *not authored*
- [ ] Dialogue audio + synchronised subtitles — *`Subtitles` has 40 tests and is unwired; 0 nodes have an `audio` field; no voice pipeline exists*
- [ ] No placeholder dialogue — *the 42 authored lines pass the anti-slop validators; there are simply far too few of them*
- [ ] Major beats have authored cinematic treatment — *1 sequence authored (`prologue_cold_open`, 8 tracks), played only against test doubles*
- [ ] Player understands the 37-minute timeline without an exposition dump — *untestable: no player can reach any of it*

Story bible: `.kiro/steering/narrative.md`.

---

## Next tasks

**The integration layer is the critical path.** 38 of 51 modules are not in the
shipped bundle, and the overwhelming majority of the 1,426 passing tests describe
code a player cannot reach — only `settings.test.ts` (34) and
`qualityPresets.test.ts` (46) target modules that are actually in the artefact.
Every other item on this list is blocked behind integration, and no amount of
additional isolated subsystem work changes what a player can do.

1. **Wire the engine into `App`.** Add a `loading` → `playing` path so
   `state.transition('playing')` is called for the first time. Own the
   `RenderContext`, the `FixedStepLoop`, the `GameWorld`, the `PhysicsWorld`, the
   `InputState` and its sources, the `AudioEngine` and the `QualitySystem` from
   `App`, and hold them across state changes.
2. **Write the content loader.** `content/*.json` currently reaches nothing at
   runtime. Load, Zod-validate and register dialogue, missions, sequences,
   tutorials and sectors, and fail loudly on a validation error rather than
   booting into an empty world.
3. **Make New Game work end to end.** Menu row → `loading` → sector load → player
   spawn → prologue cold open → player control. That single path converts roughly
   ten currently-unwritable E2E tests into writable ones.
4. **Author the first real sector.** `public/assets/sectors` is empty, so there is
   no geometry to spawn into and `StreamingSystem`'s 41 tests all run against
   fixtures.
5. **Populate `content/localization`** so the nine tutorial `messageKey`s resolve
   to text.
6. **Wire `Hud`, `Subtitles` and `DiagnosticsOverlay`,** and give
   `DiagnosticsOverlay` its first test. Hook `?diagnostics=1`, which is documented
   in `flags.ts` and read nowhere.
7. **Wire `TitleBackdrop`** so the title screen renders something, and get the
   first real evidence that Three.js works in this app at all.
8. **Add the missing test suites** as their subjects become reachable:
   `tests/browser/story`, `tests/browser/mobile`, `tests/performance`. Until then
   `pnpm test:story` and `pnpm test:mobile` will keep failing, which is the
   correct signal.
9. **Author Act I content** toward the 300–380 line target, starting with Dax Ren,
   who currently does not exist.
10. **Resolve the look-axis convention seam** before the camera ships: mouse
    reports displacement, stick reports rate, both land on `lookX`/`lookY`, and
    `InputState` clamps to ±1. The camera owner must pick one.
11. **Give `waterMaterial` a test,** or delete it. It is the only module in the
    repository that has never been executed by anything.
12. **Measure something on real hardware.** Every performance and platform claim
    in this document that is not marked verified is waiting on a device.

---

## Known regressions

None. 1,426 tests pass; no test is skipped, disabled or weakened. The 6 skipped
Playwright tests are the live-Pages specs, which skip by design without
`PAGES_URL` and pass when it is supplied.

---

## Asset issues

`public/assets/` contains zero files, so `pnpm lint:assets` reports one
informational warning and no errors. `ASSET_LICENSES.md` records only the five
generated PWA icons, which is accurate. The licence gate was previously verified
to genuinely fail on an unrecorded asset; that check has **not** been re-run this
wave, because there are still no assets to record.
