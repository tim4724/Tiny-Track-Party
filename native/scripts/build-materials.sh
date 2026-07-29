#!/usr/bin/env bash
# Compile native/renderer/materials/*.mat to .filamat blobs for one backend.
#
#   build-materials.sh <matc> <outdir> [api] [platform]
#
# api/platform default to `opengl mobile`, which is what the web build ships AND
# what an Android TV build wants — GLES3 is GLES3, so those two legs share these
# bytes. tvOS is the one that differs (`metal`), and it is the reason this is a
# script with arguments rather than three lines inside build-runtime-web.sh.
#
# THE matc MUST BE THE FORK'S OWN, never a system install: .filamat blobs are
# MATERIAL_VERSION-locked to the Filament tree they will be loaded by, and a
# mismatch fails at material-load time in the shell, not here.
set -euo pipefail

MATC="${1:?usage: build-materials.sh <matc> <outdir> [api] [platform]}"
OUTDIR="${2:?usage: build-materials.sh <matc> <outdir> [api] [platform]}"
API="${3:-opengl}"
PLATFORM="${4:-mobile}"

MATDIR="$(cd "$(dirname "$0")/../renderer/materials" && pwd)"

if [ ! -x "$MATC" ]; then
    echo "build-materials.sh: no matc at $MATC (build the Filament fork first)" >&2
    exit 1
fi

mkdir -p "$OUTDIR"
count=0
for mat in "$MATDIR"/*.mat; do
    name="$(basename "${mat%.mat}")"
    "$MATC" -a "$API" -p "$PLATFORM" -o "$OUTDIR/$name.filamat" "$mat"
    count=$((count + 1))
done
echo "==> $count materials -> $OUTDIR ($API/$PLATFORM)"
