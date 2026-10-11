# TIDELOCK — first-person Godot mission

The game is `godot/`, using Godot 4.7.2 and its Compatibility renderer.
The earlier TypeScript prototype and its assessment remain in git history up to
commit `6fda439`.

## Playable scope

One complete first-person 3D harbor mission: mouse and touch look, camera-relative
movement, sprint, flashlight, hop, a visible repair hammer, warehouse/canal
collision, three collectible fuses, three rotary bypass puzzles, four maintenance
patrols with line-of-sight detection, rechargeable induction pulse, suit/tide
failure recovery, three authored shift logs, persistent checkpoints, evacuation
and a final report choice. Explorer mode stops the tide and removes damage.

Three people work the quay and two evacuees wait at the east gate. They are
Quaternius CC0 base characters dressed in Blender 5.2 by
`scripts/assets/build_characters.py`, animated with clips from the Quaternius
Universal Animation Library (kneeling repair, torch, talking, sitting). Ivo and
Dax have full conversations ported from the earlier prologue and act one
scripts, with three-way replies whose flags change the ending text; Sera speaks
on the radio and in person at evacuation. Conversation state is saved with the
checkpoint, and checkpoints from before this update still load.

Kenney CC0 industrial models build the warehouses, containers, towers, pump tanks
and maintenance machines. Eighteen Poly Haven CC0 props (generators, crates,
barrels, tyre fenders, lifebuoys, floodlights, a searchlight, benches) are
decimated and resized by `scripts/assets/build_props.py`; the sky uses a Poly
Haven cloud band. OpenGameArt CC0 recordings supply the rain bed, thunder,
waves, pump and outflow loops, patrol hum and alarm, radio static and wet or
metal footsteps; Kenney footsteps and interface sounds remain. Lightning (no
flashes in reduced-motion mode), wave spray, pump outflow, rain splashes, fog,
search lights and pulse effects are authored in Godot. Licence notices and file
hashes are kept in `godot/assets/` and included with the exported game.

Keyboard, mouse and touch share the same mission controls. Menus, conversations
and pump panels stop the campaign clock. Software WebGL (or `?quality=low`) uses
a lower resolution 3D buffer, per-vertex lighting on props and people, shorter
draw distances, no decorative lights and no cosmetic particles; UI rendering
stays at full resolution. Model textures ship as lossy WebP, keeping the web
package near 12 MB.

## Verification

The build runs campaign regression checks and exports a fresh WebGL build. The
browser runner uses actual keyboard, mouse and multi-touch input to restore all
pumps, recover all logs, finish evacuation, choose a report and reload saves.
It also checks camera look, flashlight and touch-only pump repair. A separate
migration test replaces the legacy service worker and checks corrupt saves.
The latest local run passed 1259 campaign checks, 35 desktop browser checks,
the touch regression and the migration suite. An earlier run passed 47 campaign checks, including complete crossings of both bridges in both
directions. The desktop browser run completed
all three pumps, all logs, evacuation, the report and reload; the corrected
release touch run passed ten checks, including movement/aiming without camera drift
flashlight and a touch-only repair, with zero runtime errors or failed requests. No game
state is teleported or set by the browser runner. The Pages workflow repeats
the complete suite against the final commit. The local migration checks passed
legacy cache upgrade, unrelated-cache preservation, credits and corrupt-save
recovery without errors.

## Limits

This release is a compact mission. Dialogue is subtitled, not voiced, and there
is no gamepad support or long-form campaign. Automated mobile checks emulate a landscape touch browser;
performance on physical phones has not been measured. Local saves depend on
browser site storage, with a synchronous checkpoint and Godot filesystem backup.
The GitHub Pages workflow verifies the exported game before publishing it.
