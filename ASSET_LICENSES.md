# TIDELOCK — Asset Licences

Every third-party asset committed to this repository is recorded here. Only
redistributable assets are committed, and no scraped or unattributed assets are
used. This file is included in the web build's `LICENSES.txt`.

## Original assets and font

The active Godot game's harbor geometry, icon (`godot/icon.svg`), UI art and
synthesized sound are original procedural source assets under this repository's
MIT licence. The first-person edition uses the CC0 libraries listed below. No generated speech is included.

`godot/fonts/FieldSans.ttf` is the unmodified **DejaVu Sans** font from the Debian
`fonts-dejavu-core` package. Source: https://dejavu-fonts.github.io/. Original
Bitstream Vera copyright applies; DejaVu changes are public domain. The full
redistribution notice is in `godot/fonts/LICENSE.txt` and included in the web
build's `LICENSES.txt`. The Godot runtime is MIT-licensed; its licence is included
as `GODOT_LICENSE.txt` in the web build and attributed in the in-game credits.

## First-person 3D libraries (CC0)

| Files | Creator / source | Licence | Use |
| --- | --- | --- | --- |
| `godot/assets/industrial/` | [Kenney City Kit Industrial 2.0](https://kenney.nl/assets/city-kit-industrial) | CC0 1.0 | Warehouses, tanks, containers, tower, chimney, patrol parts |
| `godot/assets/survival/` | [Kenney Survival Kit](https://kenney.nl/assets/survival-kit) | CC0 1.0 | Supply crates, barrels, first-person hammer |
| `godot/assets/impact/` | [Kenney Impact Sounds](https://kenney.nl/assets/impact-sounds) | CC0 1.0 | Concrete footsteps and machine impact |
| `godot/assets/interface/` | [Kenney Interface Sounds](https://kenney.nl/assets/interface-sounds) | CC0 1.0 | Interactions, repairs and induction pulse |
| `godot/assets/particles/` | [Kenney Particle Pack](https://kenney.nl/assets/particle-pack) | CC0 1.0 | Repair and induction sparks |
| `godot/assets/concrete/` | [ambientCG Concrete030](https://ambientcg.com/view?id=Concrete030) | [CC0 1.0](https://ambientcg.com/license) | Quay colour, normal and roughness maps, 1K JPG |

| `godot/assets/characters/` | [Quaternius Universal Base Characters](https://quaternius.itch.io/universal-base-characters) and [Universal Animation Library](https://quaternius.itch.io/universal-animation-library) | CC0 1.0 | Ivo, Dax, Sera and two evacuees; clothing modelled in Blender by `scripts/assets/build_characters.py` |
| `godot/assets/props/` | [Poly Haven](https://polyhaven.com) models: Barrel 01, Barrel 03, Old Military Crate, Plastic Crate 03, Metal Jerrycan Green, Old Tyre, Lifebuoy, Portable Generator, Portable Searchlight, Medical Box, Metal Toolbox, Utility Box 01, Security Light, Trash Bag, Propane Tank, Modular Street Seating, Hand Truck, Clipboard | [CC0 1.0](https://polyhaven.com/license) | Quay props, decimated and resized by `scripts/assets/build_props.py` |
| `godot/assets/sky/` | [Poly Haven HDRI "Abandoned Slipway"](https://polyhaven.com/a/abandoned_slipway) | [CC0 1.0](https://polyhaven.com/license) | Storm cloud band, cropped and graded by `scripts/assets/build_sky.sh` |
| `godot/assets/audio/` | OpenGameArt: "AMB Rain Loop 1" (Kresiek The Furry), "30 CC0 SFX loops" and "100 CC0 SFX #2" (rubberduck), "Metal footsteps on concrete" (Thimras), "Beach Ocean Waves" (jasinski) | CC0 1.0 | Rain, thunder, waves, pump, outflow, patrol hum and alarm, radio static, valve, gate, wet and metal steps; normalised by `scripts/assets/build_audio.sh` |

Pack licence notices are retained beside the assets and distributed in
`LICENSES.txt`. `godot/assets/manifest.json` records each original imported file's
SHA-256. Kenney models are fitted at runtime and their textures and sounds remain unmodified. The generated characters, props, sky and sounds are reproducible from their verified sources with `scripts/assets/build_all.sh`.
Rain particles, water shader, pump panels, patrol assembly and HUD are authored
in the project.
