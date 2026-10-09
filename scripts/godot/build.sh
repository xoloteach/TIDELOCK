#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/godot/env.sh
python3 scripts/godot/install.py
mkdir -p .godot-tools
build_log=$(mktemp .godot-tools/build.XXXXXX.log)
export_stage=$(mktemp -d .godot-tools/export.XXXXXX)
trap 'rm -f "$build_log"; rm -rf "$export_stage"' EXIT
run_godot() {
  "$GODOT_BIN" "$@" 2>&1 | tee "$build_log"
  python3 - "$build_log" <<'PY'
import re, sys
from pathlib import Path
text = Path(sys.argv[1]).read_text()
assert not re.search(r'^(SCRIPT ERROR|ERROR):', text, re.M), 'Godot reported errors; see log above'
PY
}
run_godot --headless --path godot --editor --import
run_godot --headless --path godot --script tests/test_campaign.gd
python3 - "$build_log" <<'PY'
import re, sys
from pathlib import Path
text = Path(sys.argv[1]).read_text()
match = re.search(r'Campaign checks: (\d+) passed / (\d+) total', text)
assert match and int(match[1]) > 0 and match[1] == match[2], 'Campaign checks did not complete successfully'
PY
run_godot --headless --path godot --export-release Web "$PWD/$export_stage/index.html"
python3 - "$export_stage" <<'PY'
from pathlib import Path
import json, os, subprocess, sys
root = Path(sys.argv[1])
for name in ('index.html', 'index.js', 'index.pck', 'index.wasm'):
    path = root / name
    assert path.is_file() and path.stat().st_size > 100, f'Missing fresh web artifact: {name}'
(root / '.nojekyll').touch()
commit = os.environ.get('GITHUB_SHA') or subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
(root / 'build-info.json').write_text(json.dumps({'engine': '4.7.2', 'commit': commit, 'variant': 'single-threaded-web', 'game': 'first-person-3d'}, indent=2))
PY
cat LICENSE godot/fonts/LICENSE.txt ASSET_LICENSES.md godot/assets/*/License.txt > "$export_stage/LICENSES.txt"
cp godot/LICENSE.godot.txt "$export_stage/GODOT_LICENSE.txt"
cp godot/COPYRIGHT.godot.txt "$export_stage/GODOT_THIRD_PARTY_LICENSES.txt"
cp godot/web/sw.js "$export_stage/sw.js"
mkdir -p dist
cp -a "$export_stage/." dist/
