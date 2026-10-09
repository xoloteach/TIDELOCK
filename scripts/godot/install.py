#!/usr/bin/env python3
"""Install checksum-pinned Godot 4.7.2 and its verified single-thread web templates.

Files already matching verified hashes are reused. No credentials or project
files are changed. Only the Linux x86_64 editor and web templates are retained.
"""
import hashlib
import os
from pathlib import Path
import platform
import subprocess
import tempfile
import zipfile

VERSION = "4.7.2"
BASE = f"https://github.com/godotengine/godot-builds/releases/download/{VERSION}-stable/"
ARCHIVES = {
    "editor": (f"Godot_v{VERSION}-stable_linux.x86_64.zip", "cadd3204e728a35d3f13adb7fd0d7902636b79f6b95c40c265eb73b6c35329e4"),
    "templates": (f"Godot_v{VERSION}-stable_export_templates.tpz", "f298490b8d44d934be425a5a65a51bf15f422428b229a06a6e11d9ffea248011"),
}
FILES = {
    f"{VERSION}/Godot_v{VERSION}-stable_linux.x86_64": "8d106cbe6144c2dc7e881d61d2429c1a8a76e6b22ef48bd5e48dcf934953f71e",
    f"export_templates/{VERSION}.stable/web_nothreads_release.zip": "d3ee2f08cef0cf3cf6678a6355a92a8db48ccdd35cbd2e8bfd5f0e8a0b4032a0",
    f"export_templates/{VERSION}.stable/web_nothreads_debug.zip": "08962aefef811b603541d7951ac67ef00413aad2d978855183c28adee98f626a",
    f"export_templates/{VERSION}.stable/version.txt": "38885c88f75abbc797a1db7559719800279a00cfb9fa8b2e2868a7f6f84bad2e",
}


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def install():
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "AMD64"):
        raise SystemExit("This installer targets Linux x86_64. Use the official Godot 4.7.2 editor for your platform.")
    data = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share")))
    root = data / "godot"
    for group, (name, expected) in ARCHIVES.items():
        selected = {k: v for k, v in FILES.items() if k.startswith(f"{VERSION}/") == (group == "editor")}
        if all((root / k).is_file() and digest(root / k) == v for k, v in selected.items()):
            print(f"Verified cached Godot {group}")
            continue
        with tempfile.TemporaryDirectory(prefix="tidelock-godot-") as temporary:
            archive = Path(temporary) / name
            subprocess.run(["curl", "--fail", "--location", "--retry", "3", "--max-time", "900", BASE + name, "-o", str(archive)], check=True)
            if digest(archive) != expected:
                raise SystemExit(f"Official archive SHA-256 verification failed: {name}")
            with zipfile.ZipFile(archive) as package:
                for key, file_hash in selected.items():
                    leaf = Path(key).name
                    member = leaf if group == "editor" else "templates/" + leaf
                    content = package.read(member)
                    if hashlib.sha256(content).hexdigest() != file_hash:
                        raise SystemExit(f"Extracted file verification failed: {leaf}")
                    destination = root / key
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(content)
    binary = root / f"{VERSION}/Godot_v{VERSION}-stable_linux.x86_64"
    binary.chmod(0o755)
    print(f"Godot editor: {binary}")
    subprocess.run([str(binary), "--headless", "--version"], check=True)


if __name__ == "__main__":
    install()
