#!/usr/bin/env bash
# Import character and prop GLBs with their textures extracted and stored as
# lossy WebP: a small download that decodes at load, instead of two
# VRAM-compressed copies per texture. Run after adding or replacing a GLB.
set -euo pipefail
cd "$(dirname "$0")/../.."
# Model textures are extracted and imported as lossy WebP: a small download
# that decodes at load, instead of two VRAM-compressed copies per texture.
source scripts/godot/env.sh
python3 scripts/godot/install.py
for glb in godot/assets/characters/*.glb godot/assets/props/*.glb; do
  if [ -f "$glb.import" ]; then
    sed -i 's/^gltf\/embedded_image_handling=.*/gltf\/embedded_image_handling=1/' "$glb.import"
  fi
done
rm -rf godot/.godot
"$GODOT_BIN" --headless --path godot --editor --import >/dev/null 2>&1
for texture in godot/assets/characters/*.webp.import godot/assets/props/*.webp.import; do
  sed -i -e 's/^compress\/mode=.*/compress\/mode=1/' -e 's/^compress\/lossy_quality=.*/compress\/lossy_quality=0.8/' \
    -e 's/^detect_3d\/compress_to=.*/detect_3d\/compress_to=0/' -e 's/^mipmaps\/generate=.*/mipmaps\/generate=true/' "$texture"
done
"$GODOT_BIN" --headless --path godot --editor --import >/dev/null 2>&1
