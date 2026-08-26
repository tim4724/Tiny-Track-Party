#!/usr/bin/env bash
# Run the tvOS UITest suite (TinyTrackPartyShots) against a device or the
# simulator.
#
#   test.sh [device|simulator] [-R <TestClass>[/<method>]] [--all]
#
# THE DEFAULT IS THE FAST SUBSET, not everything the target contains — two
# suites don't belong in a routine check:
#
#   - RealRaceShotTests photographs an idle lobby for ~6 minutes UNLESS
#     something joins from a phone and starts a race, which nothing here does;
#     it is a passive prop for scripts/tvos-party-check.mjs's harness, not a
#     self-contained test.
#   - LifecycleTests' own header says it must be run against an app ALREADY
#     launched by hand (`devicectl device process launch`) — a test-launched
#     process provably does not reproduce the bug it guards. It only "passes"
#     in a full run because an earlier suite happens to leave the app in the
#     foreground; that is luck, not a contract.
#
# Pass --all to run everything anyway (e.g. before a release), or -R to target
# one class/method explicitly — which always runs what you named, including
# either of the two above.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TVOS="$(cd "$HERE/.." && pwd)"
source "$HERE/lib.sh"

WHICH=device
FILTER=""
ALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    device|simulator) WHICH="$1" ;;
    -R) FILTER="${2:?test.sh: -R needs a <TestClass>[/<method>] argument}"; shift ;;
    --all) ALL=1 ;;
    *) echo "usage: test.sh [device|simulator] [-R <TestClass>[/<method>]] [--all]" >&2; exit 2 ;;
  esac
  shift
done

"$HERE/prepare.sh" "$WHICH"

DEST="$(resolve_destination "$TVOS/TinyTrackParty.xcodeproj" TinyTrackParty "$WHICH")"

SIGNING=()
if [ "$WHICH" = device ]; then
  TEAM="$(development_team)"
  if [ -z "$TEAM" ]; then
    echo "test.sh: no Apple Development certificate — set TTP_DEVELOPMENT_TEAM=<team id>, or test 'simulator'" >&2
    exit 1
  fi
  SIGNING=("DEVELOPMENT_TEAM=$TEAM" "CODE_SIGNING_ALLOWED=YES" "-allowProvisioningUpdates")
else
  SIGNING=("CODE_SIGNING_ALLOWED=NO")
fi

TEST_ARGS=()
if [ -n "$FILTER" ]; then
  TEST_ARGS=("-only-testing:TinyTrackPartyShots/$FILTER")
elif [ "$ALL" -eq 0 ]; then
  TEST_ARGS=(
    "-skip-testing:TinyTrackPartyShots/RealRaceShotTests"
    "-skip-testing:TinyTrackPartyShots/LifecycleTests"
  )
fi

RESULTS="$TVOS/TestResults.xcresult"
rm -rf "$RESULTS"

# NOT -quiet: that suppresses the live `Test Case '...' passed/failed` lines
# xcodebuild prints as it goes, which is the only feedback during a run that
# can take several minutes — the alternative is silence until the very end.
xcodebuild -project "$TVOS/TinyTrackParty.xcodeproj" -scheme TinyTrackParty \
  -destination "$DEST" -resultBundlePath "$RESULTS" \
  test "${SIGNING[@]}" ${TEST_ARGS[@]+"${TEST_ARGS[@]}"} && STATUS=0 || STATUS=$?

echo
xcrun xcresulttool get test-results summary --path "$RESULTS" 2>/dev/null \
  || echo "(no result bundle written — the build likely failed before tests ran)"

exit "$STATUS"
