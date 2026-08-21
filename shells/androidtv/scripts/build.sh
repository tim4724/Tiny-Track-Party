#!/usr/bin/env bash
# Build the Android TV app, engine and bundle included — the twin of
# shells/tvos/scripts/build.sh, and it exists for the same reason that one does.
#
#   build.sh                     # release APK, both ABIs
#   build.sh debug               # debug APK
#   build.sh release install     # ...and put it on the box
#   TTP_ABI=armeabi-v7a build.sh debug install    # the perf loop's one slice
#
# The three steps were three commands in a documented ORDER, and the order is
# not decorative: staging copies what the engine build produced, so running it
# first bundles the PREVIOUS build's materials — a stale twin that looks like a
# clean build and reads as "the change did nothing". Gradle now owns the staging
# and gates on a stale engine (app/build.gradle.kts), so this script is what
# makes the ENGINE step unforgettable rather than merely documented.
#
# There is no materials step, deliberately: build-materials.sh's default is
# `opengl mobile`, which is what the web ships and what this wants, so the
# .filamat blobs committed under public/display/engine/native/ are the bytes this
# app bundles. scripts/androidtv-cycle.sh is the loop that also rebuilds those,
# for when a .mat is what changed.
set -euo pipefail

VARIANT="${1:-release}"
INSTALL="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SHELL_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$SHELL_DIR/../.." && pwd)"

case "$VARIANT" in
  release) TASK_SUFFIX=Release ;;
  debug)   TASK_SUFFIX=Debug ;;
  *) echo "usage: build.sh [release|debug] [install]" >&2; exit 2 ;;
esac
case "$INSTALL" in
  ''|install) ;;
  *) echo "usage: build.sh [release|debug] [install]" >&2; exit 2 ;;
esac

say() { printf '\033[36m==> %s\033[0m\n' "$*"; }

# shellcheck disable=SC1091
source "$HERE/android-sdk.sh"

# BOTH ABIS BY DEFAULT, because armeabi-v7a is not a legacy fallback here — a
# Google TV Streamer has no /system/bin/linker64 and cannot load an arm64 APK at
# all. TTP_ABI cuts that in half for a measurement loop that only ever installs
# to one known box.
say "engine (${TTP_ABI:-both})"
"$ROOT/native/scripts/build-runtime-android.sh" "${TTP_ABI:-both}"

# Staging is a preBuild dependency, so it runs inside this. Naming it anyway:
# the point of the script is that the order is visible in one place.
say "stage + assemble ($VARIANT)"
if [ "$INSTALL" = install ]; then
  ( cd "$SHELL_DIR" && ./gradlew "install$TASK_SUFFIX" )
else
  ( cd "$SHELL_DIR" && ./gradlew "assemble$TASK_SUFFIX" )
fi

APK="$SHELL_DIR/app/build/outputs/apk/$VARIANT/app-$VARIANT.apk"
if [ -f "$APK" ]; then say "$APK"; fi

# The same string app/build.gradle.kts stamps into versionName, so `adb shell
# dumpsys package games.couchpad.tinytrack | grep versionName` answers
# "which commit is on the box?" and can be compared against this by eye.
DIRTY=""
if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then DIRTY="-dirty"; fi
say "versionName 1.0-$(git -C "$ROOT" rev-parse --short HEAD)$DIRTY"
