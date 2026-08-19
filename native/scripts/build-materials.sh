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

# Only the ones that actually moved. matc is deterministic — the .filamat it
# writes for an unchanged .mat is byte-identical — so recompiling every material
# on every engine build was time spent reproducing bytes we already had, on the
# command you run most while working on native/.
#
# matc ITSELF is a dependency, not just the .mat: a rebuilt Filament fork can
# change the output of an untouched material, and a stale blob is the kind of bug
# you chase in the renderer for an hour. -nt covers both. The OUTDIR is per
# backend, so the metal and opengl blobs never gate each other.
#
# SO ARE THE .inc FILES. matc resolves #include relative to the .mat, and the
# shading vlit and vroad share lives in ttp_shade.inc — so an edit there changes
# the output of materials whose own mtime never moved. Rather than parse each
# material's includes, any .inc newer than a blob rebuilds it: there are two or
# three of them, they change rarely, and the failure this prevents (editing the
# shared shading and rendering with the old one) is silent.
mkdir -p "$OUTDIR"
newest_inc=""
for inc in "$MATDIR"/*.inc; do
    [ -f "$inc" ] || continue
    if [ -z "$newest_inc" ] || [ "$inc" -nt "$newest_inc" ]; then newest_inc="$inc"; fi
done
built=0 kept=0
for mat in "$MATDIR"/*.mat; do
    name="$(basename "${mat%.mat}")"
    out="$OUTDIR/$name.filamat"
    if [ ! -f "$out" ] || [ "$mat" -nt "$out" ] || [ "$MATC" -nt "$out" ] \
            || [ "$0" -nt "$out" ] \
            || { [ -n "$newest_inc" ] && [ "$newest_inc" -nt "$out" ]; }; then
        # -Os IS NOT A SIZE PREFERENCE, it is what makes vroad COMPILE on a real
        # mobile GPU.
        #
        # matc's default optimizer round-trips through SPIR-V and emits loops
        # that carry a temporary through the increment expression
        # (`for (int i=0; i<n; t0=t1,i++)`), where the temporary is only assigned
        # inside the body. Desktop GL and Metal accept it. The PowerVR Rogue
        # driver in a Google TV Streamer reports each one as "used without being
        # initialised" and then fails the compile outright, so TtpVroad — the
        # only material with dynamic loops, over its 32 deck decals — never
        # links, and Filament's GL thread throws PostconditionPanic and aborts
        # the process. -Os takes a different path that emits none of them, at
        # 546 generated lines against the default's 509.
        #
        # GLOBAL rather than per-platform on purpose. This is not an Android
        # quirk: a browser on that same box drives the same driver, so the web
        # display shipped the same broken shader to it. One flag, one set of
        # blobs, every platform fixed.
        #
        # NOTE the `$0 -nt` gate above: the flags live in this script and are NOT
        # part of runtime-source-hash, so without it an edit here leaves every
        # blob looking current and changes nothing.
        "$MATC" -a "$API" -p "$PLATFORM" -Os -o "$out" "$mat"
        built=$((built + 1))
    else
        kept=$((kept + 1))
    fi
done

# A blob whose .mat is gone is a STALE TWIN, and nothing else prunes it: the
# tvOS outdir is gitignored and stage-assets.sh bundles the whole directory, so
# a retired material ships forever (vskid did, for a day after the rubber layer
# stopped using a render target). Harmless only while no shell names it — a
# RENAMED material ships as both blobs, and the dead one loads without
# complaint. The outdir is per backend and holds nothing but these, so the .mat
# set is the whole truth about what belongs here.
pruned=0
for blob in "$OUTDIR"/*.filamat; do
    [ -f "$blob" ] || continue
    name="$(basename "${blob%.filamat}")"
    [ -f "$MATDIR/$name.mat" ] && continue
    rm "$blob"
    pruned=$((pruned + 1))
done
echo "==> materials -> $OUTDIR ($API/$PLATFORM): $built compiled, $kept up to date, $pruned orphans pruned"
