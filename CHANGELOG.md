# Changelog

All notable changes to TIDELOCK. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
[`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) holds the
current measurements.

## [Unreleased]

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
