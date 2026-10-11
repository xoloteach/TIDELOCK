#!/usr/bin/env bash
# Rebuild the generated game assets from their CC0 sources.
#   BLENDER=/path/to/blender bash scripts/assets/build_all.sh [cache-dir]
# Requires Blender 5.2, ffmpeg, curl, unzip and Python 3. Outputs are committed
# under godot/assets/, so the game build itself never needs Blender.
set -euo pipefail
cd "$(dirname "$0")/../.."
cache=${1:-.asset-cache}
blender=${BLENDER:-blender}
"$blender" --version | head -1 | grep -q "Blender 5.2" || { echo "Blender 5.2 required" >&2; exit 1; }
python3 -I scripts/assets/fetch_sources.py "$cache"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
"$blender" -b --python scripts/assets/build_characters.py -- "$cache" "$work/characters"
"$blender" -b --python scripts/assets/build_props.py -- "$cache" "$work/props"
bash scripts/assets/build_audio.sh "$cache" "$work/audio"
mkdir -p "$work/sky" && bash scripts/assets/build_sky.sh "$cache" "$work/sky"
bash scripts/assets/build_kenney.sh "$cache" godot/assets
for kind in characters props audio sky; do
  mkdir -p "godot/assets/$kind"
  find "godot/assets/$kind" -maxdepth 1 -type f ! -name '*.import' ! -name License.txt -delete
  find "godot/assets/$kind" -maxdepth 1 -name '*.webp.import' -delete
  cp "$work/$kind"/* "godot/assets/$kind/"
done
bash scripts/assets/import_textures.sh
cat > godot/assets/characters/License.txt <<'TXT'
Characters: Quaternius "Universal Base Characters" and "Universal Animation Library"
https://quaternius.itch.io/universal-base-characters
https://quaternius.itch.io/universal-animation-library
License: CC0 1.0 Universal (public domain dedication)
https://creativecommons.org/publicdomain/zero/1.0/
Clothing, hair tint and selection of animation clips were made for TIDELOCK
with scripts/assets/build_characters.py (MIT).
TXT
cat > godot/assets/props/License.txt <<'TXT'
Props: Poly Haven models (https://polyhaven.com), by their respective Poly Haven authors.
License: CC0 1.0 Universal (public domain dedication)
https://polyhaven.com/license
Decimated and texture-reduced for the web with scripts/assets/build_props.py.
TXT
cat > godot/assets/audio/License.txt <<'TXT'
Sound effects from OpenGameArt.org, all marked CC0 1.0 Universal:
  "AMB Rain Loop 1" by Kresiek The Furry
  "30 CC0 SFX loops" and "100 CC0 SFX #2" by rubberduck
  "Metal footsteps on concrete" by Thimras
  "Beach Ocean Waves" by jasinski
https://creativecommons.org/publicdomain/zero/1.0/
Trimmed, converted to mono and loudness-normalised with scripts/assets/build_audio.sh.
TXT
cat > godot/assets/sky/License.txt <<'TXT'
Sky: cloud band from Poly Haven HDRI "Abandoned Slipway" (https://polyhaven.com/a/abandoned_slipway)
License: CC0 1.0 Universal (public domain dedication)
Cropped and graded with scripts/assets/build_sky.sh.
TXT
python3 - <<'PY'
import hashlib, json
from pathlib import Path
root = Path("godot/assets")
entries = [{"path": p.relative_to(root).as_posix(), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
           for p in sorted(root.rglob("*")) if p.is_file() and p.suffix != ".import" and p.name != "manifest.json"]
(root / "manifest.json").write_text(json.dumps(entries, indent=2) + "\n")
PY
