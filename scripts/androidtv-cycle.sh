#!/usr/bin/env bash
# Edit → build → install → foreground, in one command, for the perf loop.
#
#   androidtv-cycle.sh            # materials + engine + install
#   androidtv-cycle.sh mat        # materials only (a .mat/.inc edit)
#   androidtv-cycle.sh so         # engine only (a .cc/.h edit)
#   androidtv-cycle.sh stage      # neither; just re-stage and install
#
# ONE ABI. The device is armeabi-v7a and a perf loop that also builds arm64
# doubles every cycle for a slice no measurement will ever run.
#
# The first run after an install measures the install — throw it away; see
# shells/androidtv/CLAUDE.md.
set -euo pipefail

WHAT="${1:-all}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"

say() { printf '\033[36m==> %s\033[0m\n' "$*"; }

# The attached adb device whose build says it is a TV; TTP_SERIAL overrides.
# (scripts/lib/androidtv-device.mjs is the same rule for the node harnesses.)
SERIAL="${TTP_SERIAL:-}"
if [ -z "$SERIAL" ]; then
  for id in $("$ADB" devices | awk 'NR>1 && $2=="device" {print $1}'); do
    if "$ADB" -s "$id" shell getprop ro.build.characteristics | grep -qw tv; then
      [ -z "$SERIAL" ] || { echo "several Android TV devices attached — set TTP_SERIAL" >&2; exit 1; }
      SERIAL="$id"
    fi
  done
  [ -n "$SERIAL" ] || { echo "no Android TV device attached — adb devices, or set TTP_SERIAL" >&2; exit 1; }
fi

if [ "$WHAT" = all ] || [ "$WHAT" = mat ]; then
  say materials
  # source filament-checkout.sh — it owns the checkout naming.
  # shellcheck disable=SC1091
  source "$ROOT/native/scripts/filament-checkout.sh"   # sets FILAMENT_SRC
  MATC="$FILAMENT_SRC/out/cmake-release/tools/matc/matc"
  [ -x "$MATC" ] || { echo "no matc at $MATC" >&2; exit 1; }
  # opengl/mobile — the same bytes the web ships; Android bundles them verbatim
  # (build-runtime-android.sh has no materials step for exactly this reason).
  "$ROOT/native/scripts/build-materials.sh" "$MATC" \
      "$ROOT/public/display/engine/native" opengl mobile
fi

if [ "$WHAT" = all ] || [ "$WHAT" = so ]; then
  say "engine (armeabi-v7a)"
  "$ROOT/native/scripts/build-runtime-android.sh" armeabi-v7a >/dev/null
fi

# Gradle re-stages assets on preBuild and fails on an engine older than native/.
# shells/androidtv/scripts/build.sh is the two-ABI release twin; this stays
# one-ABI/debug because that is what the perf loop wants.
say install
( cd "$ROOT/shells/androidtv" && ./gradlew installDebug -q --console=plain 2>&1 | tail -3 )

say launch
"$ADB" -s "$SERIAL" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
"$ADB" -s "$SERIAL" shell am start -n com.couchgames.tinytrackparty/.MainActivity >/dev/null
# The attract demo needs a scene built and the adaptive scaler needs a window;
# a reading taken before that is a reading of the boot.
sleep 22
say ready
