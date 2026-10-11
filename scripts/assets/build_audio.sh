#!/usr/bin/env bash
# Prepare the CC0 OpenGameArt sounds for the web build with ffmpeg:
# mono, consistent loudness, trimmed, Ogg Vorbis. Usage: build_audio.sh <cache> <out>
set -euo pipefail
cache=$1; out=$2
mkdir -p "$out" "$cache/oga/x"
oga=https://opengameart.org/sites/default/files
fetch() { [ -f "$cache/oga/$1" ] || curl -sSfL -o "$cache/oga/$1" "$oga/$1"; }
for f in amb_rain_loop_1.ogg sfx_loops.zip sfx_100_v2.zip metal_steps.ogg wave_01_cc0-18363__jasinski__alkaibeach.flac wave_03_cc0-18363__jasinski__alkaibeach.flac; do fetch "$f"; done
sha256sum -c --quiet <<SUMS
ae578791d46218d180a0e3aebefb5d621dbdd3f1627899c25210379f57d480b0  $cache/oga/amb_rain_loop_1.ogg
9c013474c7e56192a0d1b2840535a1e1d8b93166948d4a9f7136bb6c3d5421cd  $cache/oga/sfx_loops.zip
0fc61b4494e2e893c0c015ced4877b3f689c7d84a48cb61daecd7ddb52db797b  $cache/oga/sfx_100_v2.zip
74088fd8141320be128936923d8aab26c2158bea2bcac01f877a711aacdc79e3  $cache/oga/metal_steps.ogg
fcfca178eca2eac536e8c2a4ed5cf8096e44c921acd587047b3d9f1d7845435c  $cache/oga/wave_01_cc0-18363__jasinski__alkaibeach.flac
fc795f95f352b354867d69a587daecb8815334e28e3b56a7798c5f3005349054  $cache/oga/wave_03_cc0-18363__jasinski__alkaibeach.flac
SUMS
unzip -qo "$cache/oga/sfx_loops.zip" -d "$cache/oga/x"
unzip -qo "$cache/oga/sfx_100_v2.zip" -d "$cache/oga/x"
enc() { # in out loudness extra-filter...
  local src=$1 dst=$2 lufs=$3; shift 3
  ffmpeg -loglevel error -y -i "$src" -af "${1:-anull},loudnorm=I=$lufs:TP=-2:LRA=11" -ac 1 -ar 44100 -c:a libvorbis -q:a 3 "$out/$dst"
}
# Loops: a short crossfade-free trim at zero crossings is enough for these beds.
enc "$cache/oga/amb_rain_loop_1.ogg" rain_loop.ogg -20 "atrim=0:40"
enc "$cache/oga/x/pump_01.ogg" pump_loop.ogg -18
enc "$cache/oga/x/machine_01.ogg" patrol_hum.ogg -20
enc "$cache/oga/x/water_flowing.ogg" outflow_loop.ogg -20
enc "$cache/oga/x/alarm_01.ogg" patrol_alarm.ogg -17
enc "$cache/oga/x/noise_01.ogg" radio_static.ogg -24 "atrim=0:0.45,afade=t=out:st=0.3:d=0.15"
enc "$cache/oga/x/sfx100v2_thunder_01.ogg" thunder.ogg -16
enc "$cache/oga/wave_01_cc0-18363__jasinski__alkaibeach.flac" wave_a.ogg -22
enc "$cache/oga/wave_03_cc0-18363__jasinski__alkaibeach.flac" wave_b.ogg -22
enc "$cache/oga/x/sfx100v2_switch_01.ogg" valve.ogg -18
enc "$cache/oga/x/sfx100v2_lock_open_01.ogg" gate_release.ogg -16
enc "$cache/oga/x/sfx100v2_metal_hit_01.ogg" metal_hit.ogg -16
for i in 1 2 3; do enc "$cache/oga/x/sfx100v2_footstep_wet_0$i.ogg" step_wet_$i.ogg -24; done
# The metal steps recording holds several footfalls; cut three of them out.
for i in 0 1 2; do enc "$cache/oga/metal_steps.ogg" step_metal_$((i+1)).ogg -24 "silenceremove=start_periods=1:start_threshold=-40dB,atrim=$((i)):$((i)).55,asetpts=PTS-STARTPTS"; done
# Harbour life (OpenGameArt CC0, fetched and verified by fetch_sources.py).
o2="$cache/oga2"
enc "$o2/Seagull_Ambient_1.wav" gull_a.ogg -22
enc "$o2/Seagull_Ambient_2.wav" gull_b.ogg -22
enc "$o2/Seagull_Ambient_3.wav" gull_c.ogg -22
# Far off across the water: band-limited with a long tail.
enc "$o2/foghorn_kinda_gross.mp3" foghorn.ogg -20 "lowpass=f=900,aecho=0.8:0.7:420|900:0.35|0.2,apad=pad_dur=1.5"
enc "$o2/rain-gutter-loop_0.mp3" gutter_loop.ogg -24 "atrim=0:30"
enc "$o2/short_wind_sound.wav" gust.ogg -22
enc "$o2/tree_creak.ogg" creak.ogg -24
# Synthesised (original, no third-party licence): a distant ship horn and a bell buoy.
ffmpeg -loglevel error -y -f lavfi -i "aevalsrc='0.5*sin(2*PI*98*t)+0.35*sin(2*PI*147*t)+0.2*sin(2*PI*196*t)':s=22050:d=4.5" \
  -af "afade=t=in:d=0.25,afade=t=out:st=3.4:d=1.1,lowpass=f=900,aecho=0.8:0.6:180|420:0.35|0.2" -ac 1 -c:a libvorbis -q:a 3 "$out/ship_horn_synth.ogg"
ffmpeg -loglevel error -y -f lavfi -i "aevalsrc='sin(2*PI*620*t)*exp(-3*t)+0.6*sin(2*PI*1470*t)*exp(-4.5*t)+0.3*sin(2*PI*2310*t)*exp(-6*t)':s=22050:d=2.5" \
  -af "volume=0.5" -ac 1 -c:a libvorbis -q:a 3 "$out/buoy_bell.ogg"
ls -la "$out"
