#!/usr/bin/env bash
# ctest emulator shim for the tvOS simulator leg.
#
# Pass as CMAKE_CROSSCOMPILING_EMULATOR (a CMake list — the UDID is baked in at
# configure time):
#   cmake -S native -B build/tvos-sim -DCMAKE_SYSTEM_NAME=tvOS \
#         -DCMAKE_OSX_SYSROOT=appletvsimulator -DCMAKE_OSX_ARCHITECTURES=arm64 \
#         -DCMAKE_MACOSX_BUNDLE=OFF \
#         "-DCMAKE_CROSSCOMPILING_EMULATOR=$PWD/native/scripts/tvos-sim-spawn.sh;$UDID"
#
# ctest then drives the WHOLE suite on the simulator exactly as the wasm leg
# drives it under node — no hardcoded per-check command list in the workflow that
# can drift from CMakeLists (it did: the tvOS job ran 12 of 24 tests, silently
# skipping the four party corpora and every record round-trip).
#
# CMAKE_MACOSX_BUNDLE=OFF matters: simctl spawn wants the executable, and a bundled
# target would hide it inside <name>.app/.
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: tvos-sim-spawn.sh <udid> <executable> [args...]" >&2
  exit 2
fi

UDID="$1"
shift
# simctl spawn propagates the child's exit status, which is what ctest reads.
exec xcrun simctl spawn "$UDID" "$@"
