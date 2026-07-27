#!/usr/bin/env bash
# Build the browser engine — libttp-sim + libttp-party + libttp-renderer behind
# ttp_runtime.h / ttp_party.h / ttp_display.h — to one ES6 wasm module, and copy
# it plus the compiled materials into public/display/engine/native/.
#
# The artifacts are CHECKED IN (like the fdlibm blob in public/display/engine/
# math.js): the no-build preview deploy serves them straight from the repo, and
# the display's Native* adapters + tests/{runtime,party}-abi.test.js load them.
# Rebuild and commit whenever native/ changes — tests/native-artifact.test.js
# compares the stamped source hash and fails when they drift.
#
# Layers, each produced on demand and then reused:
#   1. emsdk        — pinned emscripten toolchain (~/emsdk unless EMSDK_DIR)
#   2. Filament SDK — the pinned fork (branch tvos-v1.74.0, carrying our tvOS +
#                     newer-clang patches) built for wasm and installed to
#                     out/wasm-release/filament
#   3. materials    — compiled with the FORK'S OWN matc (never a system matc:
#                     .filamat blobs are MATERIAL_VERSION-locked to the tree)
#   4. the module   — native/ configured with -DFILAMENT_SDK
#
# Env: FILAMENT_SRC (fork checkout), EMSDK_DIR.
#
# The strict-FP flags (-ffp-contract=off / -fno-builtin, applied by CMake to the
# sim targets) are the determinism contract — never add fast-math.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FILAMENT_SRC="${FILAMENT_SRC:-$HOME/Projects/filament}"
EMSDK_DIR="${EMSDK_DIR:-${EMSDK:-$HOME/emsdk}}"
EMSDK_VERSION="6.0.4"   # first green build 2026-07-24; bump deliberately
BUILD="$ROOT/native/build/web"
OUTDIR="$ROOT/public/display/engine/native"

# --- 1. emsdk ---------------------------------------------------------------
if [ ! -x "$EMSDK_DIR/emsdk" ]; then
    git clone https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
fi
"$EMSDK_DIR/emsdk" install "$EMSDK_VERSION" > /dev/null
"$EMSDK_DIR/emsdk" activate "$EMSDK_VERSION" > /dev/null
# shellcheck disable=SC1091
source "$EMSDK_DIR/emsdk_env.sh" > /dev/null 2>&1

# --- 2. Filament wasm SDK ---------------------------------------------------
SDK="$FILAMENT_SRC/out/wasm-release/filament"
MATC="$FILAMENT_SRC/out/cmake-release/tools/matc/matc"
if [ ! -f "$SDK/include/filament/Engine.h" ] || [ ! -x "$MATC" ]; then
    echo "==> building the Filament wasm SDK (once; this is the slow part)"
    (cd "$FILAMENT_SRC" && ./build.sh -p wasm release)
    (cd "$FILAMENT_SRC" && ninja -C out/cmake-wasm-release install > /dev/null)
fi

# --- 3. materials -----------------------------------------------------------
mkdir -p "$OUTDIR"
for mat in "$ROOT"/native/renderer/materials/*.mat; do
    name="$(basename "${mat%.mat}")"
    "$MATC" -a opengl -p mobile -o "$OUTDIR/$name.filamat" "$mat"
done

# --- 4. the module ----------------------------------------------------------
emcmake cmake -S "$ROOT/native" -B "$BUILD" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DFILAMENT_SDK="$SDK" > /dev/null
cmake --build "$BUILD" --target ttp_runtime_web --parallel

cp "$BUILD/ttp_runtime.mjs" "$BUILD/ttp_runtime.wasm" "$OUTDIR/"

# Stamp WHICH sources these artifacts came from. tests/native-artifact.test.js
# recomputes the hash and fails if the checked-in wasm is older than native/ —
# the one way a native-only game can ship an engine conformance never saw.
HASH="$(node "$ROOT/native/scripts/runtime-source-hash.mjs")"
EMCC_VERSION="$(emcc --version | head -1)"
cat > "$OUTDIR/BUILD_STAMP.json" <<JSON
{
  "sourceHash": "$HASH",
  "emcc": "$EMCC_VERSION",
  "note": "sourceHash covers every file feeding ttp_runtime_web (native/scripts/runtime-source-hash.mjs). Rebuild with native/scripts/build-runtime-web.sh after touching native/."
}
JSON

echo "==> $OUTDIR:"
ls -la "$OUTDIR" | awk 'NR>1 {print "    " $5 "\t" $9}'
