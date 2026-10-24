#!/usr/bin/env bash
# Download the person detector into static/vendor/. Run once; the files are gitignored
# and cached, so the demo works offline afterwards. Failure is not fatal: cam.js falls
# back to motion detection when the files are missing.
set -uo pipefail
cd "$(dirname "$0")/.."
DEST=static/vendor
MP=https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18
MODEL=https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite

mkdir -p "$DEST"
fetch() {
  local url=$1 out=$2
  [ -s "$out" ] && return 0
  echo "  fetching $(basename "$out")"
  curl -sfL --max-time 180 -o "$out.part" "$url" && mv "$out.part" "$out" && return 0
  rm -f "$out.part"
  echo "  could not fetch $(basename "$out"); the camera falls back to motion detection"
  return 1
}

ok=0
fetch "$MP/vision_bundle.mjs"             "$DEST/vision_bundle.mjs"          || ok=1
fetch "$MP/wasm/vision_wasm_internal.js"  "$DEST/vision_wasm_internal.js"    || ok=1
fetch "$MP/wasm/vision_wasm_internal.wasm" "$DEST/vision_wasm_internal.wasm" || ok=1
fetch "$MODEL"                            "$DEST/efficientdet_lite0.tflite"  || ok=1
[ "$ok" = 0 ] && echo "  person detector ready in $DEST"
exit 0
