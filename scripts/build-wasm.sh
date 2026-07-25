#!/usr/bin/env bash
# Build the native Filament renderer for the web → public/native/ (gitignored).
#
# Layers (each produced on demand, then reused):
#   1. emsdk        — pinned emscripten toolchain (~/emsdk unless EMSDK_DIR)
#   2. Filament SDK — the pinned fork (branch tvos-v1.74.0, carries our tvOS +
#                     newer-clang patches) built for wasm and installed to
#                     out/wasm-release/filament
#   3. our module   — native/web (libttp-renderer + wasm shell) → ttp.js/ttp.wasm
#   4. materials    — compiled with the FORK'S OWN matc (never a system matc:
#                     .filamat blobs are MATERIAL_VERSION-locked to the tree)
#
# Env: FILAMENT_SRC (fork checkout), EMSDK_DIR, TTP_WASM_DEBUG=1 for a debug build.
#
# The artifacts land in public/native/ and are CHECKED IN, like the sim's under
# public/display/engine/native/: building them needs the Filament fork, which CI
# does not carry, so the preview deploy can only serve what the repo holds.
# Rebuild and commit whenever the renderer changes.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
FILAMENT_SRC="${FILAMENT_SRC:-/Users/tim/Projects/filament}"
EMSDK_DIR="${EMSDK_DIR:-$HOME/emsdk}"
EMSDK_VERSION="6.0.4"   # first green build 2026-07-24; bump deliberately
BUILD_TYPE=$([ "${TTP_WASM_DEBUG:-0}" = "1" ] && echo Debug || echo Release)

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
    echo "==> building Filament wasm SDK (once; this is the slow part)"
    (cd "$FILAMENT_SRC" && ./build.sh -p wasm release)
    (cd "$FILAMENT_SRC" && ninja -C out/cmake-wasm-release install > /dev/null)
fi

# --- 3. materials -----------------------------------------------------------
BUILD="$REPO/native/web/build"
mkdir -p "$BUILD/assets"
for mat in "$REPO"/native/renderer/materials/*.mat; do
    name="$(basename "${mat%.mat}")"
    "$MATC" -a opengl -p mobile -o "$BUILD/assets/$name.filamat" "$mat"
done

# --- 4. our module ----------------------------------------------------------
emcmake cmake -S "$REPO/native/web" -B "$BUILD" -G Ninja \
    -DCMAKE_BUILD_TYPE="$BUILD_TYPE" -DFILAMENT_SDK="$SDK" > /dev/null
cmake --build "$BUILD"

# --- 5. deploy --------------------------------------------------------------
OUT="$REPO/public/native"
mkdir -p "$OUT"
cp "$BUILD/ttp.js" "$BUILD/ttp.wasm" "$OUT/"
cp "$BUILD/assets/"*.filamat "$OUT/"
echo "==> public/native/:"
ls -la "$OUT" | awk 'NR>1 {print "    " $5 "\t" $9}'
