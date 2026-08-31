# TIDELOCK — Implementation Status

Authoritative record of what actually works. Updated after every milestone.

**Last updated:** Wave 2 — localization string table, first tests for the two
never-executed modules, Dax Ren's introduction scene, and the build-time Edge-TTS
voice pipeline. Measured on the working tree on top of commit `742b025`.

A claim appears here only if it was run and verified, not merely written.
Anything unverified is stated as unverified. Nothing in this document is carried
over from a previous entry without being re-measured.

---

## Verification snapshot

Every number below came from running the command on this tree.

```
pnpm typecheck   0 errors
pnpm test        1730 passed, 33 files, 0 skipped        (7.00 s)
pnpm lint:assets 0 errors, 0 warnings
pnpm build       96.26 kB JS (gzip 27.39) · 14.97 kB CSS (gzip 3.60)
                 PWA precache 8 entries, 110.26 KiB
pnpm vo:check    72 lines across 3 scenes · 0 stale · manifest current
pnpm test:story  FAILS — "No tests found", exit code 1
pnpm test:mobile FAILS — "No tests found", exit code 1
```

Baseline immediately before this wave, re-measured at `f8a9dcc`: **1426 tests
across 28 files.** The +304 breaks down as localization 114, diagnostics overlay
85, voice cast 57, Dax scene 23, water material 25.

`lint:assets` lost its long-standing "public/assets contains no files yet"
warning: the directory now holds generated voice-over. It reports zero warnings
rather than a new one because the generated tree is licence-exempt by rule and
that exemption is itself gated — see *Voice pipeline* below.

`pnpm test:e2e` was **not re-run this wave.** The 41-pass/6-skip figure above the
line is carried from Wave 1 and is therefore unverified here; nothing in this wave
touches a reachable module, so it is very unlikely to have changed, but it has not
been measured.

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

`src/` now holds **54 TypeScript modules, of which 13 are reachable** from
`src/main.ts`. Wave 2 added three (`voiceSchema.ts`, `localizationSchema.ts`,
`StringTable.ts`) and, like Wave 1, changed the reachable count not at all.
Verified rather than assumed: `grep -rl` finds no reference to any of the three
from outside their own directory, and none of `voiceSchema`, `StringTable`,
`localization` or `vo-manifest` appears anywhere in `dist/assets/index-*.js`.

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

**72 authored spoken dialogue lines against a 300–380 target: roughly 20%.**

| Speaker | Lines | Target (spec) |
| --- | --- | --- |
| Sera Holt | 16 | 80–100 |
| Dax Ren | 16 | 60–80 |
| Mara Venn | 19 | 70–90 |
| Ivo Saye | 12 | 65–85 |
| Noor (minor) | 5 | 2–8 |
| Renna (minor) | 4 | 2–8 |

Counted from three committed dialogue files: `prologue_depot.json` (26 nodes),
`prologue_bridge.json` (16), and `act1_perimeter_contact.json` (30, added this
wave). Every node has a speaker, so nodes and spoken lines are the same number.

**Dax Ren now exists.** He had zero lines and appeared in no `participants` array;
`act1_perimeter_contact` is his introduction — 16 nodes, three interruptible lines
on three distinct world events, and a three-option branch that moves trust in both
directions. `tests/unit/daxDialogue.test.ts` (23 tests) is the first test in the
repository that guards a *shipped* dialogue file rather than an inline fixture:
it pins the interrupts as load-bearing (each must route somewhere the
uninterrupted line does not), the branch as consequential (distinct flag sets per
option), and the anti-slop properties.

Still zero of the four minor NPCs from the depot roster (`teo`, `luz`, `abe`,
`kit`, `paulo`, `wen`) have any lines, and Acts II–III, the Finale and the Epilogue
have no content of any kind.

### Voice pipeline — built and run

`scripts/vo/generate_vo.py` implements all six stages spec §20.4 asks for, and
has been run against all 72 lines. Every line has a distinct-voiced take, a
word-timed WebVTT cue file, and a manifest entry.

| Measured | Value |
| --- | --- |
| Lines synthesised | 72 / 72 |
| Total speech | 359.7 s (6 min) |
| Voices | 12 configured (one per `SpeakerId`), 6 in use — only 6 characters have lines yet |
| Audio produced | 2.10 MB local, mono MP3 48 kbit/s @ 24 kHz (~30 KB/line, so ~11 MB at the 380-line target) |
| Loudness | EBU R128 two-pass, −19 LUFS, −1.5 dBTP |
| Delivery channels | `direct` and `radio`; Sera is routed to `radio` in both prologue scenes by per-scene override |

Two findings worth recording, because both were invisible before anything was
measured:

1. **The hand-authored `duration` estimates run short.** They were derived from
   word counts at 2.5–3.2 words/second, a model with no term for sentence-final
   pauses, and the synthesiser inserts roughly half a second at each full stop.
   Median measured/authored ratio is 0.92 and the full range is 0.49–1.57, so the
   estimates are usable as fallback timing — but two short, heavily punctuated
   lines overrun badly, both of them
   Dax catching himself: `"—sorry. That was five questions. I do that."` (8 words,
   3 sentences, 3.2 s estimated, 4.6 s measured) and `"That's the gate. Fine.
   Slower."` (5 words, 3 sentences, 2.4 s vs 3.8 s). A test asserts that
   *everything* overrunning by more than 35% is short and multi-sentence, so a
   long line drifting would fail — which is what a global rate mistake would look
   like.
2. **A single-stage ffmpeg biquad is not audible as a radio.** The first radio
   channel measured only 3 dB of high-frequency reduction against a direct take,
   because `highpass`/`lowpass` cap at 2 poles (~12 dB/octave). Cascading two
   stages per side gives ~24 dB/octave and measures 6.9 dB down above 4 kHz, which
   is the point at which it reads as a handheld rather than as a subtle EQ.

**No dialogue node carries an `audio` field, and that is deliberate.** Scene JSON
stays clean and the manifest is the index, keyed `<sceneId>__<nodeId>`. Writing
paths into the scenes would make `lint:assets` warn on all 72 lines in CI, where
the audio is intentionally absent.

**The generated audio is not committed** (`edge-tts` output carries no
redistribution licence; spec §20.5). The committed artefacts are the generator,
`content/voices/cast.json`, and `content/dialogue/vo-manifest.json`. Consequence,
stated plainly: **the GitHub Pages build has no voice-over.** Subtitles and
authored timings work, so the campaign is completable and readable silently, but
audio requires a local run of the pipeline. `ASSET_LICENSES.md` documents the
reasoning; `pnpm vo:check` is the CI-safe gate that verifies the manifest matches
the content by hash with no network access.

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
| Unit | 30 | 1,565 | pass |
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
- [~] All four main characters introduced naturally — *all four are now authored; Dax's introduction is `act1_perimeter_contact`. None is reachable by a player.*
- [ ] Acts I–III playable start to finish — *no content authored*
- [ ] Finale playable — *no content authored*
- [ ] Three final choices functional — *not authored*
- [ ] Three epilogue variations functional — *not authored*
- [~] Dialogue audio + synchronised subtitles — *the pipeline exists and has voiced all 72 lines with word-timed VTT cues; `Subtitles` (40 tests) is still unwired and nothing loads a manifest at runtime, so no player has heard a word*
- [ ] No placeholder dialogue — *the 42 authored lines pass the anti-slop validators; there are simply far too few of them*
- [ ] Major beats have authored cinematic treatment — *1 sequence authored (`prologue_cold_open`, 8 tracks), played only against test doubles*
- [ ] Player understands the 37-minute timeline without an exposition dump — *untestable: no player can reach any of it*

Story bible: `.kiro/steering/narrative.md`.

---

## Next tasks

**The integration layer is the critical path, and two waves of subsystem work have
not moved it.** 41 of 54 modules are not in the shipped bundle, and the
overwhelming majority of the 1,730 passing tests describe code a player cannot
reach — only `settings.test.ts` (34) and `qualityPresets.test.ts` (46) target
modules that are actually in the artefact. Wave 2 voiced 72 lines of dialogue that
nothing can play and resolved 53 message ids that nothing can display; both are
real, tested work, and both stay invisible until items 1–3 land. That is the
honest read: **the next wave should be integration, not more content.**
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
5. ~~**Populate `content/localization`**~~ — **done this wave.** 53 message ids
   cover all 9 shipped tutorial keys, all 16 registry keys with escalation
   variants, and the 15 input action labels. `StringTable` resolves them. Still
   unwired: `TutorialSystem` emits a `messageKey` and no HUD reads it, so the keys
   resolve but a player sees nothing.
5b. **Load the VO manifest at runtime.** `content/dialogue/vo-manifest.json` maps
   `<sceneId>__<nodeId>` to a clip path, a measured duration and a VTT cue file,
   and `voiceClipId()` is the binding function. Nothing calls it. This is the
   smallest remaining step to a voiced line, and it depends on the content loader
   (item 2), not on the pipeline.
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
11. ~~**Give `waterMaterial` a test**~~ — **done this wave** (25 tests), along with
    `DiagnosticsOverlay` (85). No module in the repository is now unexecuted. The
    water material had no defects; the overlay had two, both fixed at root cause
    and both negative-controlled. One gap left behind deliberately:
    `src/ui/styles/diagnostics.css` is imported nowhere, so it is outside the Vite
    graph and `.diag--hidden` would not actually hide the panel once wired.
12b. **Author the six remaining minor NPCs** (`teo`, `luz`, `abe`, `kit`, `paulo`,
    `wen`). All six have a cast voice waiting and no lines; `wen` is the only
    character whose default delivery channel is `radio`.
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
