# Sourced by build.sh and test.sh. Not executable on its own.
#
# The team-cert derivation and the concrete-destination lookup are each the
# kind of thing that is only ever debugged once (same rationale as
# scripts/lib/tvos-device.mjs, which extracted the equivalent for the Node
# callers) — so this is the one place either gets re-derived.

# The team id is the OU field of the keychain's Apple Development certificate,
# so any machine that can sign at all can answer it. TTP_DEVELOPMENT_TEAM
# overrides, for a keychain holding several.
development_team() {
  if [ -n "${TTP_DEVELOPMENT_TEAM:-}" ]; then echo "$TTP_DEVELOPMENT_TEAM"; return; fi
  local name
  name="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Apple Development: [^"]*\)".*/\1/p' | head -1)"
  [ -n "$name" ] || return 0
  security find-certificate -c "$name" -p | openssl x509 -noout -subject |
    sed -n 's/.*OU *= *\([A-Z0-9]*\).*/\1/p'
}

# A CONCRETE destination — required to run tests (unlike a build, which can
# target the generic `platform=tvOS` placeholder). `xcodebuild -showdestinations`
# is queried against the project itself because it is the only source that
# agrees with what `-destination` will actually accept.
#
#   resolve_destination <project> <scheme> device|simulator
resolve_destination() {
  local project="$1" scheme="$2" which="$3"
  local list
  list="$(xcodebuild -project "$project" -scheme "$scheme" -showdestinations 2>/dev/null)"
  local line
  if [ "$which" = device ]; then
    # The physical Apple TV: `platform:tvOS,` (not `tvOS Simulator`) with an
    # `arch:` field, which the `Any tvOS Device` placeholder never carries.
    line="$(echo "$list" | grep -E 'platform:tvOS,' | grep 'arch:' | head -1)"
    [ -n "$line" ] || { echo "resolve_destination: no paired Apple TV — pair one in Xcode" >&2; return 1; }
  else
    # Prefer an "Apple TV 4K" simulator (matches the fleet everything else here
    # is measured against); fall back to the first concrete one.
    line="$(echo "$list" | grep -E 'platform:tvOS Simulator,' | grep 'arch:' | grep 'Apple TV 4K' | head -1)"
    [ -n "$line" ] || line="$(echo "$list" | grep -E 'platform:tvOS Simulator,' | grep 'arch:' | head -1)"
    [ -n "$line" ] || { echo "resolve_destination: no tvOS simulator available" >&2; return 1; }
  fi
  local id
  id="$(echo "$line" | sed -n 's/.*id:\([^,}]*\).*/\1/p')"
  [ -n "$id" ] || { echo "resolve_destination: could not parse an id out of: $line" >&2; return 1; }
  if [ "$which" = device ]; then echo "platform=tvOS,id=$id"; else echo "platform=tvOS Simulator,id=$id"; fi
}
