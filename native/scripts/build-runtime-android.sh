#!/usr/bin/env bash
# The whole engine for Android TV: sim + party + runtime + the Filament renderer
# + the generated JNI bridge, as the .so the Gradle app in shells/androidtv/
# packages.
#
# The sibling of build-runtime-tvos.sh, and SHORTER by one whole layer, which is
# worth stating because it looks like an omission:
#
#   NO MATERIALS STEP FOR THE SHARED SET. build-materials.sh's default is
#   `opengl mobile`, which is what the web ships AND what this wants — GLES3 is
#   GLES3 — so the .filamat blobs already committed under
#   public/display/engine/native/ are the bytes this app bundles, byte for
#   byte; tvOS is the one leg that needs its own compile of THOSE (Metal). The
#   one set this script does compile is the Android-only MULTIVIEW twin of the
#   shared materials — see the step below for why it can never be the
#   committed set.
#
#   TWO ABIS, NOT TWO SDKS. The tvOS script configures once per SDK because
#   device and simulator are both arm64 and lipo cannot combine them. Here the
#   ABIs are genuinely different architectures, and both are wanted: armeabi-v7a
#   is NOT a legacy fallback on this platform — a Google TV Streamer on Android
#   14 reports ro.product.cpu.abilist=armeabi-v7a,armeabi and has no
#   /system/bin/linker64 at all, so an arm64-only APK does not run on it.
#
# Like the tvOS script this commits NOTHING: the .so files are build output, not
# checked-in artifacts, because no test in the tree replays them.
#
#   build-runtime-android.sh [armeabi-v7a|arm64-v8a|both]     (default: both)
set -euo pipefail

WHICH="${1:-both}"
HERE="$(cd "$(dirname "$0")" && pwd)"
NATIVE="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$NATIVE/.." && pwd)"

# THE PIN BINDS THIS LEG TOO — the same sourced resolver as the web and tvOS
# builds, into the same version-addressed checkout. It matters here for the
# reason it matters on tvOS: the Filament Android SDK is built by hand and then
# reused for months, so a fork that moved under a shared checkout would never be
# recompiled and would say nothing until a .filamat failed to load on the box.
# shellcheck disable=SC1091
source "$NATIVE/scripts/filament-checkout.sh"   # sets FILAMENT_SRC at the pinned commit
require_local_install android-

: "${ANDROID_HOME:=$HOME/Library/Android/sdk}"
# The NDK the FORK pins (build/common/versions), not the newest installed one.
# Filament and this tree must agree: two NDKs means two libc++ builds on one
# link line, and the symptom is a link error with no obvious cause.
NDK_VERSION="${NDK_VERSION:-$(grep GITHUB_NDK_VERSION "$FILAMENT_SRC/build/common/versions" | cut -d= -f2)}"
NDK="$ANDROID_HOME/ndk/$NDK_VERSION"
# android-24 matches the CI leg. Compose needs 21+, Filament's GLES3 path 18+,
# so this floor is about what Android TV boxes actually run, not about either.
API="${API:-24}"

say() { printf '==> %s\n' "$*"; }

if [ ! -d "$NDK" ]; then
  echo "build-runtime-android.sh: no NDK $NDK_VERSION at $NDK" >&2
  echo "  \$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager 'ndk;$NDK_VERSION'" >&2
  exit 1
fi

SDK_ROOT="$FILAMENT_SRC/out/android-release/filament"
if [ ! -f "$SDK_ROOT/include/filament/Engine.h" ]; then
  echo "build-runtime-android.sh: no Filament Android SDK at $SDK_ROOT" >&2
  echo "  Build it in the pinned checkout (~25 min per ABI):" >&2
  echo "    cd $FILAMENT_SRC" >&2
  echo "    ANDROID_HOME=$ANDROID_HOME ./build.sh -i -q armeabi-v7a -S multiview -p android release" >&2
  echo "    ANDROID_HOME=$ANDROID_HOME ./build.sh -i -q arm64-v8a   -S multiview -p android release" >&2
  echo "  Both install under ONE root; FilamentSdk.cmake picks lib/<abi>." >&2
  echo "" >&2
  echo "  -S multiview IS NOT OPTIONAL and it is not about the samples: it is the" >&2
  echo "  only way to set FILAMENT_ENABLE_MULTIVIEW, and without it Filament never" >&2
  echo "  compiles the _multiview variants of its OWN built-in materials. A" >&2
  echo "  MULTIVIEW engine then reaches assert_invariant(false) — INERT in release" >&2
  echo "  — and builds its default material from a null package, which fails as" >&2
  echo "  'could not parse the material package for material <empty name>'. That" >&2
  echo "  reads like a bad blob and is a missing file; it blocked three attempts." >&2
  exit 1
fi

# THE SLICE, NOT THE ROOT. The check above proves an SDK was installed here
# once; it says nothing about the ABI this build is about to link. Both ABIs
# install under ONE root, so a root that exists can still be missing arm64
# entirely, or hold one built without -S multiview — the failure the -S text
# above describes, reached from the other direction. It stays invisible until
# it runs, and then only on arm64: the box this shell is developed against is
# armeabi-v7a, so the whole loop stays green while every phone aborts on launch.
#
# The marker is the built-in materials' multiview vertex shaders, which declare
# layout(num_views). A slice without them cannot serve a MULTIVIEW engine.
require_sdk_slice() {
  local abi="$1"
  local lib="$SDK_ROOT/lib/$abi/libfilament.a"
  if [ ! -f "$lib" ]; then
    echo "build-runtime-android.sh: no $abi slice at $lib" >&2
  elif ! LC_ALL=C grep -aq num_views "$lib"; then
    echo "build-runtime-android.sh: the $abi slice was built without multiview" >&2
    echo "  $lib" >&2
  else
    return 0
  fi
  echo "  Rebuild that ABI in the pinned checkout (~25 min):" >&2
  echo "    cd $FILAMENT_SRC" >&2
  echo "    ANDROID_HOME=$ANDROID_HOME ./build.sh -i -q $abi -S multiview -p android release" >&2
  echo "  If that reports everything up-to-date and changes nothing, its cmake" >&2
  echo "  directory is stale and must be deleted so the configure happens again." >&2
  echo "  Filament names those by ITS arch codename, not by the ABI string:" >&2
  echo "    arm64-v8a -> out/cmake-android-release-aarch64" >&2
  echo "    armeabi-v7a -> out/cmake-android-release-arm7" >&2
  exit 1
}

# THE MULTIVIEW MATERIALS STEP — the one set this leg compiles (the header has
# the shared set's story), and Android-only for the reason
# shells/androidtv/CLAUDE.md's Multiview section gives: a multiview blob's
# stereo variants declare
# `layout(num_views)` in their vertex shaders, which the web and Metal backends
# reject, so this set can never be the committed shared one. It is BUILD OUTPUT
# (like the .so), staged into the APK by stage-assets.sh when present. The
# non-stereo variants inside are byte-for-byte the shared set's shaders, so an
# APK carrying these renders identically until a stereo view draws.
MATC="$FILAMENT_SRC/out/cmake-release/tools/matc/matc"
if [ -x "$MATC" ]; then
  "$NATIVE/scripts/build-materials.sh" "$MATC" "$NATIVE/build/materials-android-mv" \
      opengl mobile multiview
else
  echo "==> no host matc at $MATC — skipping the multiview material set" >&2
  echo "    (the APK will stage the committed non-stereo blobs; the multiview" >&2
  echo "    render path needs this set and will stay off without it)" >&2
fi

# The bridge is generated from the ABI headers, and a stale one marshals the
# wrong arguments into a live ABI with everything still compiling. Regenerate
# before every build rather than trusting the committed copy — it costs
# milliseconds, and tests/jni-generated.test.js is what catches a forgotten
# commit of the result.
say "regenerate the JNI bridge"
node "$ROOT/scripts/gen-jni.mjs"

JNILIBS="$ROOT/shells/androidtv/app/src/main/jniLibs"

build_abi() {
  local abi="$1"
  local dir="$NATIVE/build/android-$abi"

  require_sdk_slice "$abi"

  say "configure $abi"
  # -G Ninja for the same measured reason the rest of the tree prefers it; the
  # generator is fixed for the life of the build dir, so it can only be chosen
  # here. c++_static so the .so carries its own libc++ and the APK needs no
  # second payload — the same reasoning as the ctest leg's, where a missing
  # libc++_shared.so fails as a loader error that reads nothing like a
  # conformance failure.
  cmake -S "$NATIVE" -B "$dir" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake" \
    -DANDROID_ABI="$abi" \
    -DANDROID_PLATFORM="android-$API" \
    -DANDROID_STL=c++_static \
    -DFILAMENT_SDK="$SDK_ROOT" >/dev/null

  say "build $abi"
  cmake --build "$dir" --target ttp_runtime_android --parallel

  # STRIPPED on the way in. Unstripped it is ~35 MB of Filament debug symbols
  # per ABI, which Gradle would happily package into the APK.
  mkdir -p "$JNILIBS/$abi"
  "$NDK/toolchains/llvm/prebuilt/$(uname -s | tr '[:upper:]' '[:lower:]')-x86_64/bin/llvm-strip" \
    -o "$JNILIBS/$abi/libttp_runtime_android.so" \
    "$dir/libttp_runtime_android.so"
  ls -l "$JNILIBS/$abi/libttp_runtime_android.so" | awk '{printf "    %s  %s\n", $5, $9}'
}

case "$WHICH" in
  armeabi-v7a|arm64-v8a) build_abi "$WHICH" ;;
  both) build_abi armeabi-v7a; build_abi arm64-v8a ;;
  *) echo "usage: build-runtime-android.sh [armeabi-v7a|arm64-v8a|both]" >&2; exit 2 ;;
esac

# Staging and the APK are Gradle's now (app/build.gradle.kts stages on preBuild
# and gates on an engine older than native/), so the follow-up is one command
# rather than two in an order. shells/androidtv/scripts/build.sh runs THIS script
# and then that, which is the way to invoke the pair.
say "done — now: npm run build:androidtv -- release install"
