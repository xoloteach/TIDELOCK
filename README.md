<div align="center">

# TIDELOCK

**A complete open-source Three.js narrative game built to scale from mobile WebGL2 to desktop WebGPU.**

</div>

---

> **Status: early alpha.** The engine shell boots and the title screen is
> playable-adjacent, but no gameplay exists yet. See
> [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) for an
> honest, evidence-backed account of what actually works today.

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

## Play

Once the Pages deployment is live it will be linked here. The build is designed
to be opened directly on an Android phone — touch is a first-class control
scheme, not an afterthought.

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

Keyboard/mouse, gamepad and touch are all supported. Prompts switch
automatically to whichever input family you last used.

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

All bindings are rebindable, and the touch layout is fully customisable
(position, size, opacity, handedness, deadzone, separate look/aim sensitivity).

## Graphics tiers

| Preset | Target | Intent |
| --- | --- | --- |
| Potato | 30 FPS | Complete campaign on weak WebGL2 phones; blob shadows keep the scene readable |
| Low | 30 FPS | One shadow source, simple water, modest mobile hardware |
| Medium | 45 FPS | Full PBR materials, moderate shadows, ambient occlusion |
| High | 60 FPS | Reference look: reflections, bloom, wetness |
| Ultra | 60 FPS | Extended draw distance, denser effects, higher-quality water |
| Cinematic | 30/60 | Supersampling and depth of field for screenshots and showcases |

Presets are ceilings. The dynamic scaler may reduce below them but never above,
and it changes one dimension at a time with hysteresis to avoid oscillation.

## Tech stack

Three.js (`WebGPURenderer` + WebGL2 fallback, TSL shaders) · Rapier physics at a
fixed 60 Hz timestep · three-mesh-bvh for spatial queries · Recast/Detour
navigation · miniplex ECS · Dexie + Zod for versioned saves · Vite · Vitest ·
Playwright.

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

Playwright needs browsers installed once:

```bash
pnpm exec playwright install chromium --with-deps
```

### Useful URL flags

| Flag | Effect |
| --- | --- |
| `?webgl2=1` | Force the WebGL2 backend, ignoring WebGPU |
| `?holdBoot=1` | Keep the boot overlay visible after startup |
| `?diagnostics=1` | Open the developer diagnostics overlay |
| `?benchmark=1` | Run the benchmark route |

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
not as control flow in TypeScript. Design notes for contributors are in
[`.kiro/steering/`](.kiro/steering/).

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
committed.

The voice pipeline uses `edge-tts` for development placeholder generation. It is
an unofficial client for an online Microsoft service and does not itself grant a
commercial voice licence, so it sits behind a replaceable adapter. Voice terms
must be reviewed before any commercial distribution.
