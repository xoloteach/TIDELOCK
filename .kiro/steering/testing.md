# TIDELOCK — Testing Rules

## Writing code is not completion

For every system changed, in order:

1. `pnpm typecheck`
2. `pnpm test` (relevant unit/integration tests)
3. `pnpm build` (production)
4. Launch the game
5. Exercise the changed behaviour in a browser
6. Inspect the console
7. Inspect network failures
8. Inspect the screenshot/visual result
9. Test a mobile viewport when UI, rendering or input changed
10. Fix failures
11. Re-run

A task is never complete from static code review alone.

## Never

- Skip a failing test without documenting why in `docs/IMPLEMENTATION_STATUS.md`
- Weaken an assertion to make it pass
- Hide browser exceptions
- Catch and ignore fatal initialisation errors
- Write a test that only asserts `true`, or that mocks the entire feature it claims to test

When a test fails, first ask whether the **test** is wrong or the **code** is
wrong. Fix the actual cause. A test that fails for an environment reason (e.g.
jsdom's Proxy-backed `localStorage` ignoring instance spies) needs its technique
corrected, not its assertion deleted.

## Commands

| Command | Scope |
| --- | --- |
| `pnpm typecheck` | Whole repo, no emit |
| `pnpm test` | Vitest: `tests/unit`, `tests/integration`, `tests/saves` |
| `pnpm test:e2e` | Playwright: `tests/browser`, `tests/visual` |
| `pnpm test:story` | Campaign checkpoint smoke tests |
| `pnpm test:mobile` | Mobile-viewport browser tests |
| `pnpm test:visual` | Screenshot capture for review |
| `pnpm lint:assets` | Asset existence, size, licence and content validation |
| `pnpm verify` | typecheck + test + lint:assets + build |
| `pnpm ci` | verify + e2e |

## Required coverage

Unit: mission state transitions, dialogue flags, tutorial first-trigger and
reset persistence, cutscene start/skip/resume/cleanup, save schema and
migrations, quality preset values, dynamic scaler hysteresis, input mapping,
inventory, interaction rules, machine state transitions, utility scoring,
objective triggers, subtitle timing parsing.

Integration: renderer init (both backends), Rapier init, sector load/unload,
navmesh load, player spawn, checkpoint save/load, dialogue/audio manifest,
mission unlock.

Browser E2E: boot, title menu, New Game, prologue begins, settings open, every
graphics preset selectable, settings persist across reload, touch HUD appears
in mobile emulation, keyboard HUD hidden on touch, save created, continue
resumes, scene transition, no fatal console errors.

Story smoke: every act checkpoint boots, has a valid objective, does not spawn
inside geometry, has required NPC/dialogue assets, and is completable.

Mobile: simultaneous move + look + action multi-touch, safe areas, control
editor drag/resize persistence, HUD context transitions, tutorial highlight
targets the correct touch control, touch-only prologue completion.

## Playwright environment notes

The container has no GPU. Chromium is launched with
`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` so WebGL2
is genuinely available and renderer tests are meaningful. WebGPU is normally
unavailable here, so the WebGPU path needs validation on real hardware and that
limitation must be stated rather than glossed over.

Filter console noise narrowly (SwiftShader fallback notices, favicon 404s).
Never blanket-ignore all console errors.

## Visual review

`tests/visual` captures screenshots to `test-results/screens/`. These are for
catching missing materials, pink/black textures, overexposure, clipped UI and
unreadable phone text. Do not use pixel-perfect thresholds that fail on benign
GPU differences.

## Evidence

`docs/IMPLEMENTATION_STATUS.md` records what was verified and how. Claims about
performance or platform support need measurements or an explicit statement that
they are unverified.
