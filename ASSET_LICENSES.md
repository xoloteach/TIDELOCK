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

Pack licence notices are retained beside the assets and distributed in
`LICENSES.txt`. `godot/assets/manifest.json` records each original imported file's
SHA-256. Models are fitted at runtime; textures and sound files remain unmodified.
Rain particles, water shader, pump panels, patrol assembly and HUD are authored
in the project.
