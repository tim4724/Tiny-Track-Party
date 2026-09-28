#!/usr/bin/env bash
# The whole engine for Apple TV: sim + party + runtime + the Filament renderer,
# as a static library the Xcode app in shells/tvos/ links.
#
# The sibling of build-runtime-web.sh, and the same four layers — Filament SDK,
# materials, configure, build — with two differences that are both consequences
# of the platform rather than choices:
#
#   TWO SLICES. Apple TV device and simulator are both arm64, so `lipo` cannot
#   combine them and there is no fat library to build. Each SDK gets its own
#   configure and its own build directory, named after $(PLATFORM_NAME) so the
#   Xcode project can find them with one LIBRARY_SEARCH_PATHS entry.
#
#   METAL MATERIALS. The web and Android TV share the `opengl mobile` .filamat
#   blobs (GLES3 is GLES3); tvOS is the one leg that needs its own set. They land
#   in shells/tvos/Generated/materials/ and are bundled as app Resources.
#
# Unlike the web script this commits NOTHING: the .a files are build output, not
# checked-in artifacts, because no test in the tree replays them. (If that ever
# changes — the way ttp_runtime.wasm is checked in — package the two slices as an
# .xcframework and commit that instead.)
#
#   build-runtime-tvos.sh [device|simulator|both]     (default: both)
set -euo pipefail

WHICH="${1:-both}"
HERE="$(cd "$(dirname "$0")" && pwd)"
NATIVE="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$NATIVE/.." && pwd)"

# THE PIN BINDS THIS LEG TOO — the same sourced resolver as the web build, into
# the same version-addressed checkout. It matters more here than on the web leg:
# the tvOS SDK is built by hand and then reused for months, so a fork that moves
# under a shared checkout is never recompiled and says nothing — a
# MATERIAL_VERSION bump surfaces as a material-load failure inside the app, on
# the device, with no build error anywhere.
# shellcheck disable=SC1091
source "$NATIVE/scripts/filament-checkout.sh"   # sets FILAMENT_SRC at the pinned commit
require_local_install tvos-
# tvOS floors at 17.0 to match the Filament fork's own toolchain branch. Left to
# the SDK, this defaults to whatever Xcode ships (26.5 at time of writing), which
# is a silent App Store restriction nobody notices until submission.
TVOS_MIN="${TVOS_MIN:-17.0}"

say() { printf '==> %s\n' "$*"; }

# ---- 1. the Filament tvOS SDK ----------------------------------------------
# Built from the pinned fork commit by `./build.sh -s -i -a -p tvos release`.
# Not built here: it is a ~25 min cross build with a host-tools dependency, and
# it changes about once a year. native/filament.pin names the commit — a branch
# name written here would go stale the first time the fork is rebased, and this
# comment already had.
#
# Point at the PER-SDK install tree, never at out/tvos-release/filament (the
# xcframework root). FilamentSdk.cmake globs lib/*/*.a, and under that root the
# glob matches the device AND simulator archives together — both arm64, both on
# the same link line, and the include/filament/Engine.h guard does not catch it.
#
# Those per-SDK trees are NOT what `build.sh -i` writes: it installs the
# xcframework root only, and each slice needs its own `cmake --install` off the
# matching cmake-tvos-release-arm64-* build directory. sdk_missing() below spells
# both steps out, because the build succeeds and leaves you looking for a tree
# that was never going to be there.
sdk_root() {
  case "$1" in
    appletvos)        echo "$FILAMENT_SRC/out/tvos-release/filament-appletvos" ;;
    appletvsimulator) echo "$FILAMENT_SRC/out/tvos-release/filament-appletvsimulator" ;;
  esac
}

# The BUILD directory's matc, which is the one build.sh always leaves behind and
# the path build-runtime-web.sh already uses. The installed copy under
# out/release/ exists only in a tree someone ran the install step on by hand.
MATC="$FILAMENT_SRC/out/cmake-release/tools/matc/matc"

# ---- 2. materials, for METAL ------------------------------------------------
# The fork's own matc, never a system one: .filamat blobs are MATERIAL_VERSION
# locked to the tree that loads them, and a mismatch fails at material-load time
# inside the app rather than here. build-materials.sh is mtime-gated on both the
# .mat and matc itself, and its outdir is per backend, so these never gate the
# web's opengl blobs.
MATERIALS_OUT="$ROOT/shells/tvos/Generated/materials"
bash "$NATIVE/scripts/build-materials.sh" "$MATC" "$MATERIALS_OUT" metal mobile

# ---- 3 + 4. configure and build, once per SDK -------------------------------
build_slice() {
  local platform="$1"
  local sdk; sdk="$(sdk_root "$platform")"
  local dir="$NATIVE/build/tvos-$platform"

  if [ ! -f "$sdk/include/filament/Engine.h" ]; then
    echo "build-runtime-tvos.sh: no Filament tvOS SDK at $sdk" >&2
    echo "  Build it in the pinned checkout — TWO steps, the second easy to miss:" >&2
    echo "    cd $FILAMENT_SRC" >&2
    echo "    ./build.sh -s -i -a -p tvos release        # ~25 min" >&2
    echo "    cmake --install out/cmake-tvos-release-arm64-$platform \\" >&2
    echo "          --prefix out/tvos-release/filament-$platform" >&2
    exit 1
  fi

  say "configure $platform"
  # -G Ninja for the same measured reason the rest of the tree prefers it; the
  # generator is fixed for the life of the build dir, so it can only be chosen
  # here. CMAKE_MACOSX_BUNDLE=OFF matches the ctest leg's configure and keeps any
  # executable target in this tree a plain binary.
  cmake -S "$NATIVE" -B "$dir" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_SYSTEM_NAME=tvOS \
    -DCMAKE_OSX_SYSROOT="$platform" \
    -DCMAKE_OSX_ARCHITECTURES=arm64 \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="$TVOS_MIN" \
    -DCMAKE_MACOSX_BUNDLE=OFF \
    -DFILAMENT_SDK="$sdk" >/dev/null

  say "build $platform"
  cmake --build "$dir" --target ttp_runtime_tvos --parallel
  ls -l "$dir/libttp_runtime_tvos.a" | awk '{printf "    %s  %s\n", $5, $9}'
}

case "$WHICH" in
  device)    build_slice appletvos ;;
  simulator) build_slice appletvsimulator ;;
  both)      build_slice appletvos; build_slice appletvsimulator ;;
  *) echo "usage: build-runtime-tvos.sh [device|simulator|both]" >&2; exit 2 ;;
esac

# This is one step of three, and the order matters — stage-assets.sh copies the
# materials this script just wrote, so running it FIRST bundles the previous set
# (the stale twin that looks like a clean build). That order is
# shells/tvos/scripts/prepare.sh's job now, not a thing to remember, so building
# the app is one command and this script is rarely run on its own.
say "done — the app is \`shells/tvos/scripts/build.sh [device|simulator]\` (npm run build:tvos), which runs this itself"
