#!/usr/bin/env bash
# ctest emulator shim for the Android leg — the sibling of tvos-sim-spawn.sh.
#
# Pass as CMAKE_CROSSCOMPILING_EMULATOR (a CMake list — the serial is baked in
# at configure time):
#   cmake -S native -B build/android-dev \
#         -DCMAKE_TOOLCHAIN_FILE=$ANDROID_HOME/ndk/<v>/build/cmake/android.toolchain.cmake \
#         -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-24 -DANDROID_STL=c++_static \
#         "-DCMAKE_CROSSCOMPILING_EMULATOR=$PWD/native/scripts/android-device-spawn.sh;$SERIAL"
#
# ctest then drives the WHOLE suite on a real Android TV box exactly as the wasm
# leg drives it under node and the tvOS leg under simctl. That matters more here
# than on either of those: the Android NDK leg in .github/workflows/native.yml
# COMPILES AND DOES NOT RUN, so until this existed, NDK clang's contraction
# default (fp-profile.md §6) and Bionic's libm were the one corner of the
# platform matrix with no fixture behind it.
#
# WHY IT IS LONGER THAN THE tvOS ONE. `simctl spawn` runs a host binary against
# the host filesystem, so that shim is a one-line exec. adb shares neither: the
# executable and every fixture have to cross to the device, and ctest passes
# ABSOLUTE HOST PATHS as arguments. So this mirrors host paths under a device
# root and rewrites the arguments to match — the shape is preserved, only the
# prefix moves. `adb push --sync` makes the repeat cost a stat rather than a
# copy, which is what keeps ~40 tests from re-pushing 11 MB of fixtures each.
#
# ANDROID_STL=c++_static above is not incidental: a c++_shared build needs
# libc++_shared.so beside every binary and an LD_LIBRARY_PATH, and a missing one
# fails as a loader error that reads nothing like a conformance failure.
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: android-device-spawn.sh <serial> <executable> [args...]" >&2
  exit 2
fi

SERIAL="$1"; shift
ADB="${ADB:-adb}"
ROOT="/data/local/tmp/ttp"

push() {  # push <host-path>; mirrors it under $ROOT and echoes the device path
  local host="$1" dev="$ROOT$1"
  $ADB -s "$SERIAL" shell "mkdir -p '$(dirname "$dev")'" >/dev/null
  $ADB -s "$SERIAL" push --sync "$host" "$dev" >/dev/null
  printf '%s' "$dev"
}

EXE="$1"; shift
DEV_EXE="$(push "$EXE")"
$ADB -s "$SERIAL" shell "chmod 755 '$DEV_EXE'" >/dev/null

# Rewrite the arguments. Three shapes appear in this tree's ctest entries:
#   an existing file or directory   -> push it, use the device path
#   --out=<host path>               -> mkdir its parent, remember it, pull back
#   anything else (flags, numbers)  -> passed through untouched
ARGS=()
PULL=()
for arg in "$@"; do
  case "$arg" in
    --out=*)
      host="${arg#--out=}"
      $ADB -s "$SERIAL" shell "mkdir -p '$(dirname "$ROOT$host")'" >/dev/null
      PULL+=("$host")
      ARGS+=("--out=$ROOT$host")
      ;;
    /*)
      if [ -e "$arg" ]; then ARGS+=("$(push "$arg")"); else ARGS+=("$arg"); fi
      ;;
    *)
      ARGS+=("$arg")
      ;;
  esac
done

# `adb shell` does NOT propagate the child's exit status, which ctest reads —
# so the status is echoed and parsed back. Without this every test passes.
# ${a[@]+"${a[@]}"} rather than "${a[@]}": macOS ships bash 3.2, where an EMPTY
# array expanded under `set -u` is an unbound-variable error rather than nothing.
printf -v CMD '%q ' "$DEV_EXE" ${ARGS[@]+"${ARGS[@]}"}
OUT="$($ADB -s "$SERIAL" shell "cd '$ROOT' && $CMD; echo \"__rc=\$?\"")"
RC="$(printf '%s' "$OUT" | sed -n 's/.*__rc=\([0-9]*\).*/\1/p' | tail -1)"
printf '%s\n' "$(printf '%s' "$OUT" | sed 's/__rc=[0-9]*//')"

# The record_* round-trips compare the re-emitted fixture on the HOST, so
# anything written on the device has to come back before ctest looks at it.
for host in ${PULL[@]+"${PULL[@]}"}; do
  mkdir -p "$(dirname "$host")"
  $ADB -s "$SERIAL" pull "$ROOT$host" "$host" >/dev/null 2>&1 || true
done

exit "${RC:-1}"
