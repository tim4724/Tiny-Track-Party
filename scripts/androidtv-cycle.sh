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
say() { printf '\033[36m==> %s\033[0m\n' "$*"; }

# BEFORE $ADB is derived, which is the whole point of the ordering: the SDK path
# is spelled once, here, instead of a third time on the line below.
# shellcheck disable=SC1091
source "$ROOT/shells/androidtv/scripts/android-sdk.sh"
ADB="${ADB:-${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb}"

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
"$ADB" -s "$SERIAL" shell logcat -c >/dev/null 2>&1 || true
"$ADB" -s "$SERIAL" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
"$ADB" -s "$SERIAL" shell am start -n games.couchpad.tinytrack/.MainActivity >/dev/null

# WAIT FOR THE PICTURE, DON'T SLEEP AT IT. A fixed sleep is both too long on a
# warm box and too short after a cold install, which is the failure that reads as
# "the change did nothing". `PerfMonitor` logs its readout once a second and only
# once frames are PRESENTING (MainActivity shows the overlay on every
# non-scenario launch), so the first `TtpPerf` line is the signal, and it is the
# same one every node harness in this tree waits on.
#
# WHAT IT PROMISES IS "up and presenting", AND NOTHING MORE. The adaptive scaler
# has not settled a second after the first frame — it is nowhere near — so this
# is strictly EARLIER than the sleep it replaces. The rule that covers settling
# is the other one: throw the first run after an install away.
say "waiting for the first frame"
# POLLED DUMPS, not a live pipe. `logcat -d` prints what is there and exits, so
# there is no long-lived pipe to keep alive, no SIGPIPE to get right, and no
# dependency on which `grep` is on this machine's PATH — a `grep -q -m 1` on a
# live logcat hung for the full timeout on the box this was written against.
# Nor `logcat -m 1`, which counts adb's own "--------- beginning of main" banner
# as the line it was waiting for and returns in 70 ms, looking exactly like an
# app that came up instantly.
# ~90 s, not exactly: each turn is an adb round trip plus the sleep. It is a
# backstop, not the mechanism, so it is spelled in turns rather than clock time.
READY=0
for _ in $(seq 90); do
  OUT="$("$ADB" -s "$SERIAL" logcat -d -s TtpPerf:I 2>/dev/null || true)"
  case "$OUT" in *TtpPerf*) READY=1; break;; esac
  sleep 1
done
if [ "$READY" != 1 ]; then
  echo "no TtpPerf readout in ~90s — is the app up, and is the engine current?" >&2
  exit 1
fi
say ready
