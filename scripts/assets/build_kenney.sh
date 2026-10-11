#!/usr/bin/env bash
# Unpack the chosen Kenney CC0 models (GLB + shared colormap + licence) into
# godot/assets/<kit>/. Usage: build_kenney.sh <cache> <godot-assets-dir>
set -euo pipefail
cache=$1; out=$2
unpack() { # kit zip, models...
  local kit=$1 zip=$2; shift 2
  local work; work=$(mktemp -d)
  unzip -qo "$cache/kenney/$zip" -d "$work"
  mkdir -p "$out/$kit/Textures"
  for model in "$@"; do cp "$work/Models/GLB format/$model.glb" "$out/$kit/"; done
  cp "$work/Models/GLB format/Textures/"* "$out/$kit/Textures/"
  cp "$work/License.txt" "$out/$kit/License.txt"
  rm -rf "$work"
}
unpack watercraft kenney_watercraft-pack.zip boat-tug-a boat-tug-b boat-fishing-small boat-row-small boat-row-large buoy buoy-flag ship-cargo-a ship-cargo-c cargo-pile-a
unpack city kenney_city-kit-commercial_2.1.zip low-detail-building-a low-detail-building-b low-detail-building-c low-detail-building-d low-detail-building-g low-detail-building-h low-detail-building-i low-detail-building-j low-detail-building-k low-detail-building-l low-detail-building-m low-detail-building-wide-a low-detail-building-wide-b
unpack vehicles kenney_car-kit.zip ambulance van
unpack roads kenney_city-kit-roads.zip construction-barrier construction-cone construction-fence construction-light dumpster electricity-pole light-curved road-sign-empty
unpack factory kenney_factory-kit_3.0.zip crane crane-magnet
# Two more container colours from the industrial kit already in the game.
work=$(mktemp -d); unzip -qo "$cache/kenney/kenney_city-kit-industrial_2.0.zip" -d "$work"
cp "$work/Models/GLB format/shipping-container-b.glb" "$work/Models/GLB format/shipping-container-c.glb" "$out/industrial/"
rm -rf "$work"
