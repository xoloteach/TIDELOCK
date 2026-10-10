#!/usr/bin/env python3
"""Download the CC0 source assets used by the Blender pipeline into a cache.

Poly Haven files are verified against the MD5 published by its API. The two
Quaternius packs are fetched through itch.io's free-download endpoint and
verified against pinned SHA-256 hashes. Nothing here runs downloaded code.
"""
import hashlib, http.cookiejar, json, re, sys, urllib.parse, urllib.request
from pathlib import Path

CACHE = Path(sys.argv[1] if len(sys.argv) > 1 else ".asset-cache")
POLYHAVEN_MODELS = [
    "Barrel_01", "barrel_03", "old_military_crate", "plastic_crate_03",
    "metal_jerrycan_green", "old_tyre", "lifebuoy", "portable_generator",
    "portable_searchlight", "medical_box", "metal_toolbox", "utility_box_01",
    "security_light", "trashbag", "propane_tank", "modular_street_seating",
    "hand_truck", "clipboard",
]
POLYHAVEN_HDRI = "abandoned_slipway"
QUATERNIUS = {
    "universal-base-characters": (15861669, "fdbf1804c90dfc1ea03e992bff7da2dfd1a79318e13270a660180f9308455f40"),
    "universal-animation-library": (17958403, "cc73fc4e495b82958207316596317a3f40b9fa38065bde1027937452da537724"),
}
HEADERS = {"User-Agent": "TIDELOCK-asset-fetch/1.0"}
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

def get(url, data=None):
    request = urllib.request.Request(url, data=data, headers=HEADERS)
    with opener.open(request, timeout=300) as response:
        return response.read()

def save(path, url, check):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or not check(path.read_bytes()):
        payload = get(url)
        assert check(payload), f"checksum mismatch: {url}"
        path.write_bytes(payload)

def polyhaven_model(name):
    files = json.loads(get(f"https://api.polyhaven.com/files/{name}"))
    gltf = files["gltf"]["1k"]["gltf"]
    md5 = lambda expected: (lambda data: hashlib.md5(data).hexdigest() == expected)
    root = CACHE / "polyhaven" / name
    save(root / f"{name}.gltf", gltf["url"], md5(gltf["md5"]))
    for relative, item in gltf.get("include", {}).items():
        save(root / relative, item["url"], md5(item["md5"]))

def polyhaven_hdri(name):
    files = json.loads(get(f"https://api.polyhaven.com/files/{name}"))
    item = files["tonemapped"]
    save(CACHE / "polyhaven" / f"{name}.jpg", item["url"], lambda data: hashlib.md5(data).hexdigest() == item["md5"])

def quaternius(game, upload, sha256):
    target = CACHE / "quaternius" / f"{game}.zip"
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == sha256:
        return
    page = get(f"https://quaternius.itch.io/{game}").decode()
    token = re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)
    form = urllib.parse.urlencode({"csrf_token": token}).encode()
    url = json.loads(get(f"https://quaternius.itch.io/{game}/file/{upload}?source=view_game&as_props=1&after_download_lightbox=true", form))["url"]
    save(target, url, lambda data: hashlib.sha256(data).hexdigest() == sha256)

for model in POLYHAVEN_MODELS:
    polyhaven_model(model)
    print("polyhaven", model)
polyhaven_hdri(POLYHAVEN_HDRI)
for game, (upload, digest) in QUATERNIUS.items():
    quaternius(game, upload, digest)
    print("quaternius", game)
