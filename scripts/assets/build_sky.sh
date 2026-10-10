#!/usr/bin/env bash
# Cut the cloud band from the CC0 Poly Haven "abandoned_slipway" panorama:
# only sky above the horizon features, graded toward a cold storm palette.
set -euo pipefail
cache=$1; out=$2
ffmpeg -loglevel error -y -i "$cache/polyhaven/abandoned_slipway.jpg" \
  -vf "crop=iw:ih*0.32:0:0,scale=2048:512:flags=lanczos,eq=brightness=-0.06:contrast=1.3:saturation=0.3,colorbalance=bs=0.06:bm=0.03:bh=0.02" \
  -q:v 4 "$out/storm_clouds.jpg"
