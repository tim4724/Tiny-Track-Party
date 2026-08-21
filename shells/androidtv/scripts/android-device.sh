# WHICH BOX TO INSTALL ON. Sourced, never run; sets $SERIAL.
#
# `./gradlew install<Variant>` INSTALLS ON EVERY ATTACHED DEVICE, and this tree
# is worked in many worktrees at once: a second agent's `install` lands its APK
# on the box you are measuring and on any emulator you have open. That failure
# does not look like an install — it looks like YOUR build crashing, because the
# APK that starts is someone else's. (One did: a multiview engine over the
# committed `opengl mobile` blobs aborts with "could not parse the material
# package for material", 30 ms into a launch, with no name in the message.)
#
# So nothing here installs through Gradle. Assemble, then `adb -s "$SERIAL"`.
#
# THE SAME RULE AS scripts/lib/androidtv-device.mjs, which is the node harnesses'
# copy of it: the device whose `ro.build.characteristics` says `tv`, TTP_SERIAL
# overriding unchecked, and zero or several an error rather than a guess. An AVD
# says `emulator`, not `tv`, so an emulator is always reached BY NAME —
# `TTP_SERIAL=emulator-5554` — and can never be picked up by accident.
#
# Expects $ADB set (android-sdk.sh first).
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
