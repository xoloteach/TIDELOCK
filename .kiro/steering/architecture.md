# TIDELOCK — Architecture

## Stack

| Concern | Choice | Notes |
| --- | --- | --- |
| Rendering | Three.js `WebGPURenderer` with WebGL2 backend fallback | TSL for portable custom shaders |
| Physics | `@dimforge/rapier3d-compat` | Fixed 60 Hz timestep, never render delta |
| Spatial queries | `three-mesh-bvh` | Raycasts, interaction targeting, camera collision |
| Navigation | `recast-navigation` + `@recast-navigation/three` | Baked per-sector navmesh |
| Entities | `miniplex` | Small ECS; no engine framework on top of Three |
| Touch joystick | `nipplejs` | Mechanics only — it does not dictate layout or visuals |
| Saves | Dexie (IndexedDB) + Zod | Versioned schema with migrations |
| Settings | localStorage + Zod | Must be readable synchronously during boot |
| Build | Vite | PWA via `vite-plugin-pwa` |
| Tests | Vitest + Playwright | Unit/integration + browser E2E and visual capture |

## Directory contract

```
src/
  app/          boot, state machine, build info, URL flags
  engine/       platform-facing: render, physics, input, audio, time,
                resources, streaming, ecs. Knows nothing about TIDELOCK's story.
  game/         campaign systems: player, ai, missions, dialogue, sequences,
                tutorial, interactions, world, characters, progression
  graphics/     quality tiers, shaders, water, weather, post
  ui/           DOM screens and HUD (no framework, plain typed DOM)
  persistence/  settings + save schemas and stores
  accessibility/ a11y application layer
  diagnostics/  developer overlay, benchmark instrumentation
content/        authored data: dialogue, missions, evidence, sequences,
                tutorials, localization. Never hardcode story in TypeScript.
public/assets/  runtime binaries: models, textures, audio, nav, sectors
scripts/        build-time tooling (asset validation, optimisation, TTS, icons)
tests/          unit, integration, browser, visual, performance, saves
```

Dependency direction: `game` may use `engine` and `graphics`. `engine` must not
import from `game`. `ui` reads state through explicit interfaces, never by
reaching into system internals.

## Hard rules

**No god objects.** No `GameManagerFinal2.ts`. Managers exist only for genuinely
global resources (renderer, audio context, physics world, settings).

**Systems over inheritance.** Behaviour lives in systems that operate on ECS
components. Entities are data.

**Data-driven content.** Dialogue, missions, sequences, tutorials and quality
presets are JSON/TS data, not control flow. Adding a conversation must not
require touching a system.

**Fixed timestep.** Gameplay and physics advance in constant steps
(`FixedStepLoop`). Rendering interpolates. Nothing gameplay-relevant reads raw
frame delta.

**Quality is centralised.** Systems subscribe to quality changes. Never scatter
`if (preset === 'potato')` across files. The preset table in
`src/graphics/quality/presets.ts` is the single source of truth.

**Actions, not keys.** Gameplay reads named actions from the input layer. It
never reads `KeyE` or a gamepad button index directly.

**Fatal errors are loud.** Never catch and ignore an initialisation failure.
The boot screen reports what failed.

## Adding a dependency

Do not, if: Three.js already provides it, a browser API provides it, the
current stack already solves it, or it introduces a second conflicting
state/audio/physics/render framework. Pin exact versions.

## Renderer portability

Prefer TSL so one shader definition serves both WebGPU and WebGL2. Maintain an
explicit compatibility mode (`?webgl2=1` or the graphics setting) that forces
the WebGL2 backend and disables WebGPU-only effects. WebGPU is not universal
and requires a secure context, so the game can never be WebGPU-only.

## Streaming

The world is sectors. Each sector owns its render assets, colliders, navmesh,
audio zones, interactables, NPCs, triggers and LOD metadata. Load current +
adjacent + transition sector. Gameplay state persists separately from loaded
scene objects, so unloading a sector must never lose progress.
