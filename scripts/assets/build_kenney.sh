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
unpack watercraft kenney_watercraft-pack.zip boat-tug-a boat-tug-b boat-fishing-small boat-row-small boat-row-large buoy buoy-flag
unpack roads kenney_city-kit-roads.zip construction-barrier construction-cone construction-fence construction-light dumpster electricity-pole light-curved road-sign-empty
unpack factory kenney_factory-kit_3.0.zip crane crane-magnet
