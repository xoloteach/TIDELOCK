# TIDELOCK — first-person Godot mission

The active game is `godot/`, using Godot 4.7.2 and its Compatibility renderer.
The earlier TypeScript prototype is retained; its assessment is in
`LEGACY_IMPLEMENTATION_STATUS.md`.

## Playable scope

One complete first-person 3D harbor mission: mouse and touch look, camera-relative
movement, sprint, flashlight, hop, a visible repair hammer, warehouse/canal
collision, three collectible fuses, three rotary bypass puzzles, four maintenance
patrols with line-of-sight detection, rechargeable induction pulse, suit/tide
failure recovery, three authored shift logs, persistent checkpoints, evacuation
and a final report choice. Explorer mode stops the tide and removes damage.

Kenney CC0 industrial models build the warehouses, containers, towers, pump tanks
and maintenance machines. Survival-kit models supply crates, barrels and the
held hammer. Concrete colour/normal/roughness textures come from ambientCG.
Kenney footsteps and interface sounds accompany original storm ambience.
Animated water, rain particles, fog, search lights, streetlights, pump wheels and
pulse effects are authored in Godot. Licence notices and file hashes are kept in
`godot/assets/` and included with the exported game.

Keyboard, mouse and touch share the same mission controls. Menus and pump panels
stop the campaign clock. Software WebGL uses a lower resolution 3D buffer and
simpler shadows; UI rendering stays at full resolution.

## Verification

The build runs campaign regression checks and exports a fresh WebGL build. The
browser runner uses actual keyboard, mouse and multi-touch input to restore all
pumps, recover all logs, finish evacuation, choose a report and reload saves.
It also checks camera look, flashlight and touch-only pump repair. A separate
migration test replaces the legacy service worker and checks corrupt saves.
Local validation passed 47 campaign checks, including complete crossings of both bridges in both
directions. The desktop browser run completed
all three pumps, all logs, evacuation, the report and reload; the corrected
release touch run passed ten checks, including movement/aiming without camera drift
flashlight and a touch-only repair, with zero runtime errors or failed requests. No game
state is teleported or set by the browser runner. The Pages workflow repeats
the complete suite against the final commit. The local migration checks passed
legacy cache upgrade, unrelated-cache preservation, credits and corrupt-save
recovery without errors.

## Limits

This release is a compact mission. There is no voice acting, gamepad support or
long-form campaign. Automated mobile checks emulate a landscape touch browser;
performance on physical phones has not been measured. Local saves depend on
browser site storage, with a synchronous checkpoint and Godot filesystem backup.
The GitHub Pages workflow verifies the exported game before publishing it.
