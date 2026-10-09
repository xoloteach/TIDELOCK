# Source this from the repository root before running the cloud Godot tools.
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/workspace/.config}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-/workspace/.local/share}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/workspace/.cache}"
export GODOT_BIN="$XDG_DATA_HOME/godot/4.7.2/Godot_v4.7.2-stable_linux.x86_64"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"
