"""Fetch the Poly Haven CC0 ground textures for the quay and copy them into the game.

  python3 -I scripts/assets/build_ground.py <asset-cache> godot/assets/ground

Each map is the 1k JPG from the Poly Haven API, verified against the MD5 the API
publishes. The game blends them in shaders/wet_quay.gdshader.
"""
import hashlib, json, shutil, sys, urllib.request
from PIL import Image
from pathlib import Path

CACHE, OUTPUT = (Path(p) for p in sys.argv[1:3])
# name in game: (Poly Haven id)
TEXTURES = {"slab": "concrete_floor_02", "setts": "cobblestone_floor_08", "asphalt": "worn_asphalt"}
MAPS = {"Diffuse": "color", "nor_gl": "normal", "Rough": "roughness"}
HEADERS = {"User-Agent": "TIDELOCK-asset-fetch/1.0"}

def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=300) as response:
        return response.read()

OUTPUT.mkdir(parents=True, exist_ok=True)
for short, name in TEXTURES.items():
    files = json.loads(get(f"https://api.polyhaven.com/files/{name}"))
    for key, suffix in MAPS.items():
        item = files[key]["1k"]["jpg"]
        target = CACHE / "polyhaven" / "textures" / name / f"{key}.jpg"
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists() or hashlib.md5(target.read_bytes()).hexdigest() != item["md5"]:
            data = get(item["url"])
            assert hashlib.md5(data).hexdigest() == item["md5"], f"checksum mismatch: {item['url']}"
            target.write_bytes(data)
        shutil.copy(target, OUTPUT / f"{short}_{suffix}.jpg")
        print("ground", name, key)
# The three roughness maps share one image: slab in R, setts in G, asphalt in B.
channels = [Image.open(OUTPUT / f"{short}_roughness.jpg").convert("L") for short in TEXTURES]
Image.merge("RGB", channels).save(OUTPUT / "ground_roughness.jpg", quality=90)
for short in TEXTURES:
    (OUTPUT / f"{short}_roughness.jpg").unlink()
(OUTPUT / "License.txt").write_text(
    "Ground textures: Poly Haven (https://polyhaven.com) " + ", ".join(TEXTURES.values()) + ".\n"
    "License: CC0 1.0 Universal (public domain dedication)\nhttps://polyhaven.com/license\n")
