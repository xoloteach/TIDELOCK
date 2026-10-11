#!/usr/bin/env python3
"""Download the CC0 source assets used by the Blender pipeline into a cache.

Poly Haven files are verified against the MD5 published by its API. The two
Quaternius packs are fetched through itch.io's free-download endpoint and
verified against pinned SHA-256 hashes. Nothing here runs downloaded code.
"""
import hashlib, http.cookiejar, json, re, sys, urllib.parse, urllib.request, zipfile
from pathlib import Path

CACHE = Path(sys.argv[1] if len(sys.argv) > 1 else ".asset-cache")
POLYHAVEN_MODELS = [
    "Barrel_01", "barrel_03", "old_military_crate", "plastic_crate_03",
    "metal_jerrycan_green", "old_tyre", "lifebuoy", "portable_generator",
    "portable_searchlight", "medical_box", "metal_toolbox", "utility_box_01",
    "security_light", "trashbag", "propane_tank", "modular_street_seating",
    "hand_truck", "clipboard", "ocean_buoy",
]
POLYHAVEN_HDRI = "abandoned_slipway"
QUATERNIUS = {
    "universal-base-characters": (15861669, "fdbf1804c90dfc1ea03e992bff7da2dfd1a79318e13270a660180f9308455f40", "ubc"),
    "universal-animation-library": (17958403, "cc73fc4e495b82958207316596317a3f40b9fa38065bde1027937452da537724", "ual"),
}
KENNEY = {
    "kenney_watercraft-pack.zip": ("https://kenney.nl/media/pages/assets/watercraft-kit/a335cfed49-1713519620/kenney_watercraft-pack.zip", "cd1470c1cf441c7f46d0944ae6d0d897242365dc97677c5079b3238965d659f3"),
    "kenney_city-kit-roads.zip": ("https://kenney.nl/media/pages/assets/city-kit-roads/74288c9459-1791628607/kenney_city-kit-roads.zip", "374a4552115cbd11b4ec5c930ee31a533562dc78a09af249a655d03f7ea3b959"),
    "kenney_factory-kit_3.0.zip": ("https://kenney.nl/media/pages/assets/factory-kit/edaac9d4f6-1777639602/kenney_factory-kit_3.0.zip", "7e31fb2308e90304672bd15cd18fa9d9f02c03731a8cbc57a8e3e1c181dfb0a7"),
}
# OpenGameArt CC0 sounds added for the harbour soundscape (file name: hash).
OGA_SOUNDS = {
    "Seagull Ambient 1.wav": "3e891a8cf944797b2f16e0c19b1167e7eea7a20c8c7693487dcfdcfa0eb5621c",
    "Seagull Ambient 2.wav": "477246beafe31569b5937483b34b97043f4331a0639358fdcb3a55347d3d7a3a",
    "Seagull Ambient 3.wav": "f9e5e283197945d3df148082a9c2110154bc5a1c7ff2b58c951134c182c61788",
    "foghorn_kinda_gross.mp3": "791fd64d4eeedc29bd07f9ec28a60cf8d44c093cc8aac60742a62f2c09de9fe3",
    "rain-gutter-loop_0.mp3": "216f57eebace492b1d56226c13a728582735de7282c5cca43059cd3c960f083e",
    "short wind sound.wav": "4435f5ad1baf171f21f876f778d0a8a7447becea0c4955bb2566e0c63ab20f41",
    "theircoming.ogg": "949975ecdd9bece552aebf3e7823f785f686e56886a6b8dfc7a0f9b9692aa6ec",
    "tree_creak.ogg": "465356e0e32e71a5c29fda529a0ac23af7791c62e3bd862e8cb2961eb104e1b1",
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

def quaternius(game, upload, sha256, folder):
    target = CACHE / "quaternius" / f"{game}.zip"
    if not target.exists() or hashlib.sha256(target.read_bytes()).hexdigest() != sha256:
        download_quaternius(game, upload, sha256, target)
    # The Blender scripts read the unpacked packs.
    with zipfile.ZipFile(target) as archive:
        archive.extractall(CACHE / "quaternius" / folder)

def download_quaternius(game, upload, sha256, target):
    page = get(f"https://quaternius.itch.io/{game}").decode()
    token = re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)
    form = urllib.parse.urlencode({"csrf_token": token}).encode()
    url = json.loads(get(f"https://quaternius.itch.io/{game}/file/{upload}?source=view_game&as_props=1&after_download_lightbox=true", form))["url"]
    save(target, url, lambda data: hashlib.sha256(data).hexdigest() == sha256)

for model in POLYHAVEN_MODELS:
    polyhaven_model(model)
    print("polyhaven", model)
polyhaven_hdri(POLYHAVEN_HDRI)
sha = lambda expected: (lambda data: hashlib.sha256(data).hexdigest() == expected)
for name, (url, digest) in KENNEY.items():
    save(CACHE / "kenney" / name, url, sha(digest))
    print("kenney", name)
for name, digest in OGA_SOUNDS.items():
    save(CACHE / "oga2" / name.replace(" ", "_"), "https://opengameart.org/sites/default/files/" + urllib.parse.quote(name), sha(digest))
    print("opengameart", name)
for game, (upload, digest, folder) in QUATERNIUS.items():
    quaternius(game, upload, digest, folder)
    print("quaternius", game)
