#!/usr/bin/env bash
# Build the runtime C ABI (native/runtime/ttp_runtime.*) to a browser ES6 wasm
# module and copy the two artifacts into public/display/engine/native/.
#
# The artifacts are CHECKED IN (like the fdlibm blob in public/display/engine/
# math.js): the no-build preview deploy serves them straight from the repo, and
# the display's ?sim=native adapter + tests/runtime-abi.test.js load them.
#
# Mirrors build-mathlib.sh: EMCC defaults to ~/emsdk; the strict-FP flags
# (-ffp-contract=off / -fno-builtin, applied by CMake) are the determinism
# contract — never add fast-math.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EMSDK="${EMSDK:-$HOME/emsdk}"
BUILD="$ROOT/native/build/runtime-web"
OUTDIR="$ROOT/public/display/engine/native"

# emcmake/emcc on PATH (source the SDK env if the caller hasn't).
if ! command -v emcmake >/dev/null 2>&1; then
  # shellcheck disable=SC1091
  source "$EMSDK/emsdk_env.sh"
fi

emcmake cmake -S "$ROOT/native" -B "$BUILD" -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD" --target ttp_runtime_web --parallel

mkdir -p "$OUTDIR"
cp "$BUILD/ttp_runtime.mjs" "$OUTDIR/ttp_runtime.mjs"
cp "$BUILD/ttp_runtime.wasm" "$OUTDIR/ttp_runtime.wasm"

echo "built ttp_runtime_web ->"
ls -l "$OUTDIR/ttp_runtime.mjs" "$OUTDIR/ttp_runtime.wasm"
