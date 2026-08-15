#!/usr/bin/env bash
# Regenerate the Xcode project from project.yml, then build the app.
#
#   build.sh [device|simulator]     (default: device)
#
# Assumes the two prerequisites their own scripts own: the static library
# (native/scripts/build-runtime-tvos.sh) and the staged bundle
# (shells/tvos/scripts/stage-assets.sh). Both fail with a pointer here if
# missing, so this does not re-check them.
#
# A device build signs with the keychain's own Apple Development certificate —
# the team id is the OU field of that cert, so any machine that can sign at all
# can answer it (same derivation as scripts/capture-shots-tvos.mjs, and the same
# TTP_DEVELOPMENT_TEAM override for a keychain with several teams). The
# simulator runs unsigned.
set -euo pipefail

WHICH="${1:-device}"
HERE="$(cd "$(dirname "$0")" && pwd)"
TVOS="$(cd "$HERE/.." && pwd)"

development_team() {
  if [ -n "${TTP_DEVELOPMENT_TEAM:-}" ]; then echo "$TTP_DEVELOPMENT_TEAM"; return; fi
  local name
  name="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Apple Development: [^"]*\)".*/\1/p' | head -1)"
  [ -n "$name" ] || return 0
  security find-certificate -c "$name" -p | openssl x509 -noout -subject |
    sed -n 's/.*OU *= *\([A-Z0-9]*\).*/\1/p'
}

SIGNING=()
case "$WHICH" in
  device)
    DEST="generic/platform=tvOS"
    TEAM="$(development_team)"
    if [ -z "$TEAM" ]; then
      echo "build.sh: no Apple Development certificate — set TTP_DEVELOPMENT_TEAM=<team id>, or build 'simulator'" >&2
      exit 1
    fi
    SIGNING=("DEVELOPMENT_TEAM=$TEAM" "CODE_SIGNING_ALLOWED=YES" "-allowProvisioningUpdates")
    ;;
  simulator)
    DEST="generic/platform=tvOS Simulator"
    SIGNING=("CODE_SIGNING_ALLOWED=NO")
    ;;
  *) echo "usage: build.sh [device|simulator]" >&2; exit 2 ;;
esac

# The build tag the DEBUG lobby shows (LobbyView), so the TV itself answers
# "which commit is this?" — a stale install otherwise looks identical to a
# fresh one. Written on EVERY build; stage-assets.sh wipes it with the rest of
# Generated/assets, which is fine because nothing but this line writes it.
if [ -d "$TVOS/Generated/assets" ]; then
  printf '%s%s\n' "$(git -C "$TVOS" rev-parse --short HEAD)" \
    "$(git -C "$TVOS" diff --quiet HEAD 2>/dev/null || echo '-dirty')" \
    > "$TVOS/Generated/assets/version.txt"
fi

xcodegen generate --spec "$TVOS/project.yml" --project "$TVOS" --quiet
xcodebuild -project "$TVOS/TinyTrackParty.xcodeproj" -scheme TinyTrackParty \
  -destination "$DEST" -quiet build "${SIGNING[@]}"
