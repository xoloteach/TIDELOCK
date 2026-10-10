# Changelog

All notable changes to TIDELOCK. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
[`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) holds the
current measurements.

## [Unreleased]

### Added

- People on the quay. Ivo kneels at the depot clinic's generator, Dax Ren
  waits by the North Weir with a torch, and Sera Holt and two evacuees wait
  beyond the east gate. They are Quaternius CC0 base characters dressed in
  Blender 5.2 by a committed pipeline (`scripts/assets/`), animated with CC0
  clips, solid to the player and visible on the map.
- Conversations ported from the earlier prologue and act one scripts, with
  subtitles, three-way replies and saved choices that change the ending text.
  Sera's radio lines play as subtitles during play. Older checkpoints still load.
- Eighteen Poly Haven CC0 props, a photographed storm sky, lightning and
  thunder, wave spray against the seawall, pump outflow, rain splashes, 3D
  pump, patrol and wave sound, patrol alarms, rain, radio static, and wet or
  metal footsteps from OpenGameArt CC0 recordings.
- Campaign checks for people, props, conversations and story saves, and a
  browser check that talks to Ivo and picks a reply.

### Changed

- Software WebGL drops decorative lights, normal maps and cosmetic particles.
  Model textures ship as lossy WebP, keeping the web package near 12 MB.

### Removed

- The earlier Three.js/TypeScript prototype: `src/`, `tests/`, `content/`,
  `public/`, the Vite/Vitest/Playwright/pnpm configuration, the voice-over and
  icon generators, the Kiro spec and steering notes, and the legacy status
  report. None of it was used by the Godot build or CI. It, and the changelog
  entries describing it, remain in git history up to commit `6fda439`.

### Changed

- `ASSET_LICENSES.md`, which ships in the web build's `LICENSES.txt`, now lists
  only the Godot game's assets.

## Godot harbor mission

- Rebuilt TIDELOCK as a first-person Godot 4.7.2 harbor mission, with browser
  playtests of desktop and touch controls gating the GitHub Pages deployment.
