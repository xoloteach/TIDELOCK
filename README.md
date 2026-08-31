<div align="center">

# TIDELOCK

**A complete open-source Three.js narrative game built to scale from mobile WebGL2 to desktop WebGPU.**

</div>

---

> **Status: pre-alpha. The game is not playable.** The app boots, probes graphics
> capabilities and presents a title screen. All five menu rows — including New
> Game — log a "not implemented" warning and do nothing. Roughly three quarters
> of the engine and campaign code is written and unit-tested but is not reachable
> from the entry point, so it is not in the shipped bundle at all. See
> [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) for an honest,
> measured account of what actually works today.

## What it is

The coastal borough of Morrow Quay was evacuated after a storm surge overwhelmed
its automated flood-management network. Three days later, parts of the borough
are still sealed behind flood gates, pumps run inconsistently, and maintenance
machines enforce emergency access rules from corrupted maps.

You are Mara Venn, a former municipal field systems technician who knows the old
infrastructure better than the contractors trying to recover it. You are here to
bring the flood-control network back under manual supervision before the next
tide.

What you find is not a conspiracy with a villain. It is a 37-minute gap in an
audit log, three people who each made a defensible decision, and a city that
decided afterwards which parts of the record to publish.

A third-person narrative action-adventure of roughly **2–3 hours**: exploration,
traversal, light stealth, non-graphic machine encounters, environmental puzzles,
and dialogue that changes what people tell you later.

That is the design. None of it is playable yet — see the status note above.

## Play

The production build is deployed and verified to boot at
**https://xoloteach.github.io/TIDELOCK/**. It reaches the title screen and stops
there; there is no game behind the menu. The build is designed to be opened
directly on an Android phone — touch is a first-class control scheme, not an
afterthought — but no real phone has been tested yet.

## Planned features

Tracked against the master specification. Items are only claimed once verified.

- Authored campaign with a beginning, middle, climax, three endings and epilogue
- Four main characters with distinct written voices; no runtime-generated dialogue
- Cinematic sequence system for major beats, with hold-to-skip and clean control restoration
- Contextual first-use tutorials that teach through gameplay and adapt to keyboard, controller or touch
- Six graphics presets from **Potato** to **Cinematic**, each changing real workload
- Dynamic performance scaling with hysteresis
- WebGPU rendering with a WebGL2 compatibility path
- Full Android/iOS touch controls with a drag-to-reposition layout editor
- Positional audio, subtitles, and a build-time voice generation pipeline
- Robust versioned saves and checkpoints
- Installable PWA with offline core gameplay

## Controls

The bindings below are the designed scheme. The keyboard, gamepad and touch
input sources are written and unit-tested, but they are not wired to any screen,
so **none of these controls does anything in the current build.**

| Action | Keyboard | Touch |
| --- | --- | --- |
| Move | `W A S D` | Left thumb joystick |
| Look | Mouse | Right-side swipe |
| Interact | `E` | Context button |
| Sprint | `Shift` | Sprint button |
| Crouch | `C` | Crouch button |
| Jump / vault | `Space` | Jump button |
| Tool action | Left mouse | Primary action button |
| Scan | `Q` | Scan button |
| Objectives | `Tab` | Objectives button |
| Pause | `Esc` | Pause button |

All bindings are designed to be rebindable, and the touch layout customisable
(position, size, opacity, handedness, deadzone, separate look/aim sensitivity).
The settings schema carries these fields; no UI exposes them yet.

## Graphics tiers

The **Target** column is a design target. No FPS figure here has been measured on
any device, because there is no gameplay to measure.

| Preset | Target | Intent |
| --- | --- | --- |
| Potato | 30 FPS | Complete campaign on weak WebGL2 phones; blob shadows keep the scene readable |
| Low | 30 FPS | One shadow source, simple water, modest mobile hardware |
| Medium | 45 FPS | Full PBR materials, moderate shadows, ambient occlusion |
| High | 60 FPS | Reference look: reflections, bloom, wetness |
| Ultra | 60 FPS | Extended draw distance, denser effects, higher-quality water |
| Cinematic | 30/60 | Supersampling and depth of field for screenshots and showcases |

Presets are ceilings. The dynamic scaler may reduce below them but never above,
and it changes one dimension at a time with hysteresis to avoid oscillation. The
preset table and the scaler are implemented and tested; nothing currently applies
them to a live render workload.

## Tech stack

Three.js (`WebGPURenderer` + WebGL2 fallback, TSL shaders) · Rapier physics at a
fixed 60 Hz timestep · three-mesh-bvh for spatial queries · Recast/Detour
navigation · miniplex ECS · Dexie + Zod for versioned saves · Vite · Vitest ·
Playwright.

Rapier, miniplex, Dexie, Recast and Three.js itself are exercised by the test
suite but are **not present in the production bundle**, because the modules that
import them are not reachable from `src/main.ts`. `three-mesh-bvh`, `stats-gl`,
`tweakpane` and `@pmndrs/detect-gpu` are declared dependencies with no imports
anywhere in the source tree yet.

## Build

Requires Node 20+ and pnpm 10+.

```bash
pnpm install
pnpm dev          # development server
pnpm build        # production build to dist/
pnpm preview      # serve the production build
```

### Verification

```bash
pnpm typecheck    # TypeScript, no emit
pnpm test         # Vitest unit/integration/save tests
pnpm lint:assets  # asset existence, size, licence and content validation
pnpm verify       # all of the above plus a production build
pnpm test:e2e     # Playwright browser + visual tests
pnpm ci           # verify + e2e
```

`pnpm test:story` and `pnpm test:mobile` currently **fail** with "No tests found"
— `tests/browser/story` and `tests/browser/mobile` are empty. That failure is
intentional in the sense that it is honest; the suites simply have not been
written, because their subjects are not reachable in a browser yet.

Playwright needs browsers installed once:

```bash
pnpm exec playwright install chromium --with-deps
```

The live-deployment specs skip unless you point them at a URL:

```bash
PAGES_URL=https://xoloteach.github.io/TIDELOCK/ pnpm exec playwright test tests/browser/deployed.spec.ts
```

### Useful URL flags

| Flag | Effect |
| --- | --- |
| `?webgl2=1` | Force the WebGL2 backend, ignoring WebGPU |
| `?holdBoot=1` | Keep the boot overlay visible after startup |
| `?diagnostics=1` | *Declared, not yet read by anything* |
| `?benchmark=1` | *Declared, not yet read by anything* |

## Architecture

```
src/
  app/           boot sequence, state machine, build info, URL flags
  engine/        render, physics, input, audio, time, resources, streaming, ecs
  game/          player, ai, missions, dialogue, sequences, tutorial, world
  graphics/      quality presets, shaders, water, weather, post-processing
  ui/            DOM screens and HUD (plain typed DOM, no framework)
  persistence/   settings and save schemas
  diagnostics/   developer overlay and benchmark instrumentation
content/         authored dialogue, missions, evidence, sequences, tutorials
public/assets/   runtime models, textures, audio, navmesh, sector data
scripts/         build-time tooling
tests/           unit, integration, browser, visual, performance, saves
```

`engine/` never imports from `game/`. Story content lives in `content/` as data,
not as control flow in TypeScript. Note that nothing in `src/` loads `content/`
at runtime yet — the authored files are validated at build time by
`scripts/validate-assets.ts` and a content loader is still to be written. Design
notes for contributors are in [`.kiro/steering/`](.kiro/steering/).

## Contributing

The project follows the rules in `.kiro/steering/`:
[quality](.kiro/steering/game-quality.md),
[architecture](.kiro/steering/architecture.md),
[narrative](.kiro/steering/narrative.md),
[testing](.kiro/steering/testing.md).

Two rules matter most:

1. **Code compiling is not completion.** Run the game, exercise the change in a
   browser, check the console, and check a mobile viewport when UI, rendering or
   input changed.
2. **Never weaken a test to make it pass.** If a test fails, work out whether
   the test or the code is wrong, and fix the actual cause.

## Licences

Source code is [MIT](LICENSE).

Assets are tracked separately in [`ASSET_LICENSES.md`](ASSET_LICENSES.md) with
source, author and licence for every file. Only redistributable assets are
committed. At present the only committed assets are the five generated PWA icons;
`public/assets/` is empty.

### Voice-over

The build-time voice pipeline is implemented in `scripts/vo/generate_vo.py`. It
reads the authored dialogue, synthesises one take per line with a distinct voice
per character, generates word-timed WebVTT cues, runs an EBU R128 loudness and
format pass, and writes `content/dialogue/vo-manifest.json`.

```bash
python -m pip install -r scripts/vo/requirements.txt
pnpm generate:vo          # synthesise whatever is stale
pnpm vo:check             # offline freshness gate, no network access
```

The generated audio is **not committed.** `edge-tts` is an unofficial client for
Microsoft Edge's online speech service and grants no redistribution licence, so
the repository ships the generator and the manifest instead — see
[`ASSET_LICENSES.md`](ASSET_LICENSES.md) for the full reasoning and its
consequences. The practical effect is that the deployed Pages build has subtitles
and authored line timings but no audio; run the pipeline locally to hear it. The
provider sits behind a `SpeechBackend` adapter so an offline model with a
compatible licence can replace it without touching the manifest format or `src/`.
Voice terms must be reviewed before any commercial distribution.
