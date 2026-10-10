# TIDELOCK — Morrow Quay

A **first-person 3D** harbor recovery game built in **Godot 4.7.2**. Explore a storm-flooded municipal
quay, recover ceramic fuses, restore three pumps, avoid maintenance machines,
and reach evacuation before the next tide. Read the shift logs and decide where
the recovery record goes at the ending.

The Godot project is in [`godot/`](godot/). The earlier Three.js engine,
TypeScript tests, and authored campaign material remain in the repository for
reference. The active GitHub Pages pipeline builds and playtests the Godot game.

This release is one complete harbor mission, designed for roughly 5–10 minutes
of play, with imported CC0 assets, a stormy industrial quay, flashlight, rain,
animated water, four patrol machines and a hand-held repair tool.

## Play

GitHub Pages deployment target: **https://xoloteach.github.io/TIDELOCK/**.
The Pages workflow publishes only after the Godot campaign checks and browser
playthrough pass. Check the Actions run for the version currently deployed.

Requires a browser with WebGL 2 and WebAssembly. Web export uses a single thread,
so Pages does not need special cross-origin isolation headers. Phone landscape
is recommended. Touchscreen controls enable automatically; Field Settings also
lets desktop players try them. Drag the right side to turn the camera, including
the lower area beside the buttons. Keep your left thumb down to move while looking.

| Action | Keyboard | Touch |
| --- | --- | --- |
| Look | Mouse | Drag the right side (away from buttons) |
| Move | WASD or arrows | Left stick |
| Flashlight | F | LIGHT |
| Hop | Space | — |
| Run | Shift | Hold RUN |
| Use / collect / open pump / read log | E | USE |
| Pause nearby machines for 5 seconds | Q | PULSE |
| Map and shift record | Tab | LOG |
| Pause | Escape | II |
| Rotate pump valves | 1 / 2 / 3 | ROTATE buttons |
| Energize pump | E | ENERGIZE PUMP |

Match each rotary valve to its labelled outlet, then energize the pump. Each
pump needs one recovered fuse. Restored pumps slow the tide, replenish the suit,
and create a checkpoint. Patrol search cones trigger suit damage; warehouses
block sight. A depleted suit or a surge returns Mara to a safe checkpoint while
retaining progress. Explorer mode stops the tide and removes damage.

Settings, collected items, repairs, recovered logs, position, and the ending
record are saved locally. Web checkpoints use a synchronous browser save, with an additional Godot
filesystem backup. Clearing site data clears these saves. Saves are specific to this browser/profile. Storage failures are reported in game.

## Develop with Godot

Open `godot/project.godot` in the standard Godot **4.7.2** editor. No plugins,
C#, npm dependencies, or external services are needed for the Godot game.

On this cloud machine:

```bash
source scripts/godot/env.sh
python3 scripts/godot/install.py
"$GODOT_BIN" --editor --path godot
```

The Linux installer verifies pinned SHA-256 checksums of the official editor
and export template archives, and reuses installed files only when their hashes
match. It retains the Linux editor and single-thread web templates. On a fresh
machine the official combined template archive is about 1.3 GB to download;
GitHub Actions caches the extracted templates.

## Build and validate

```bash
bash scripts/godot/build.sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory dist
```

The build imports the Godot project, runs the real campaign checks, and exports
the web game into `dist/`. For browser validation, install Playwright 1.57.0
outside the source tree and Chromium, then run:

```bash
NODE_PATH=/path/to/browser-tools/node_modules node scripts/godot/smoke.cjs
```

`CHROMIUM_PATH` can select an installed Chromium binary; set it to an empty
string to use Playwright's downloaded browser. `GAME_URL` selects a served build,
and `GAME_TEST_OUTPUT` selects the screenshot/results directory.

Browser checks use the actual game controls to collect supplies, turn valves,
restore all pumps, recover all three logs, reach the ending, reload checkpoints,
and exercise mouse look, flashlight, simultaneous touch movement/aiming/pulse,
and a touch-only repair. `node scripts/godot/touch-regression.cjs` also checks
left/right camera swipes, floating movement controls, independent finger release,
stale touch preferences, and screen rotation at two phone sizes.

The quay uses wet concrete, weathered warehouse materials, soft contact shadows,
overcast lighting, and directional water ripples. These effects reuse the credited
CC0 textures; the web build keeps dynamic shadows disabled for mobile performance.
The diagnostic `window.tidelockState` is read-only observation; it cannot alter
campaign state. Screenshots and results are written to `test-results/godot/`.

## Layout

- `godot/scripts/campaign.gd`: mission state, fixed-step movement, patrols, repairs, checkpoints.
- `godot/scripts/harbor_data.gd`: harbor geometry, objectives, patrol routes, authored shift logs.
- `godot/scripts/first_person_view.gd`: first-person camera, imported models, lights, rain, water and patrols.
- `godot/scripts/interface.gd`: menu, HUD, journal, pump panels, settings, ending.
- `godot/scripts/main.gd`: input and composition of the game systems.
- `godot/scripts/soundscape.gd`: original storm ambience and Kenney CC0 footsteps/interaction SFX.
- `scripts/godot/`: verified installation, build, and browser playtests.

All campaign simulation advances in Godot's fixed physics step. Menus, journal,
and pump panels stop the campaign clock. Font assets carry their licence in
`godot/fonts/LICENSE.txt`. Imported models, concrete textures and SFX are CC0; their sources and notices
are recorded in `ASSET_LICENSES.md` and `godot/assets/`. Original effects, icon
and code use the repository MIT licence.
