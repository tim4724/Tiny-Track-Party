#!/usr/bin/env bash
# Build the Apple TV app, engine and bundle included.
#
#   build.sh [device|simulator]     (default: device)
#
# It used to ASSUME its two prerequisites — the static library and the staged
# bundle — on the grounds that each fails with a pointer here when missing. They
# do when missing; they say nothing when merely STALE, which is the case that
# actually happens. prepare.sh now runs them in the order they require, on every
# build — every step is incremental, so a warm tree barely notices, and the
# failure mode is gone rather than left to a rule someone has to remember.
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

"$HERE/prepare.sh" "$WHICH"

# The build tag the DEBUG lobby shows (LobbyView), so the TV itself answers
# "which commit is this?" — a stale install otherwise looks identical to a
# fresh one. AFTER prepare.sh, which wipes Generated/assets while staging;
# nothing but this line writes the file.
printf '%s%s\n' "$(git -C "$TVOS" rev-parse --short HEAD)" \
  "$(git -C "$TVOS" diff --quiet HEAD 2>/dev/null || echo '-dirty')" \
  > "$TVOS/Generated/assets/version.txt"

xcodebuild -project "$TVOS/TinyTrackParty.xcodeproj" -scheme TinyTrackParty \
  -destination "$DEST" -quiet build "${SIGNING[@]}"
