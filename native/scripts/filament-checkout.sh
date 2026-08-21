# Resolve FILAMENT_SRC — the Filament fork tree an artifact build compiles
# against — from native/filament.pin. SOURCED (never executed) by each
# platform's build script, so no leg can drift from the pin.
#
# The checkout is version-addressed: ~/Projects/filament-<sha12>, cloned at the
# pinned commit on first use and never moved afterwards. It replaces a shared
# mutable checkout, where one `git rebase` broke a concurrent artifact build in
# another worktree (2026-08-13).
#
# Overriding FILAMENT_SRC is allowed (a fork-patch loop wants its own tree),
# but the override must sit AT the pinned commit: to build against new Filament
# work, push it to the fork and bump the pin first.

PIN_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/filament.pin"
# shellcheck disable=SC1090
source "$PIN_FILE"

if [ -n "${FILAMENT_SRC:-}" ]; then
    if [ "$(git -C "$FILAMENT_SRC" rev-parse HEAD)" != "$FILAMENT_COMMIT" ]; then
        echo "FILAMENT_SRC=$FILAMENT_SRC is not at the pinned commit" >&2
        echo "$FILAMENT_COMMIT (native/filament.pin)." >&2
        echo "Push the fork and bump the pin, or unset FILAMENT_SRC." >&2
        exit 1
    fi
else
    FILAMENT_SRC="$HOME/Projects/filament-${FILAMENT_COMMIT:0:12}"
    if [ ! -d "$FILAMENT_SRC" ]; then
        echo "==> cloning the Filament fork at ${FILAMENT_COMMIT:0:12} (once) -> $FILAMENT_SRC"
        git clone --reference-if-able "$HOME/Projects/filament" --dissociate \
            "$FILAMENT_REMOTE" "$FILAMENT_SRC"
        git -C "$FILAMENT_SRC" checkout --detach "$FILAMENT_COMMIT"
    elif [ "$(git -C "$FILAMENT_SRC" rev-parse HEAD)" != "$FILAMENT_COMMIT" ]; then
        echo "$FILAMENT_SRC is not at the commit its own name promises" >&2
        echo "($FILAMENT_COMMIT) — it must never be rebased. Delete it and rerun." >&2
        exit 1
    fi
fi

# A COPIED out/ IS A SILENT MISBUILD, and the checkout being version-addressed
# does not prevent it: carrying the previous pin's out/ across to skip a 25 min
# rebuild is the obvious thing to do, and cmake build directories are not
# relocatable. CMakeCache.txt hardcodes CMAKE_INSTALL_PREFIX, so a carried-over
# dir keeps installing into the OLD tree — `-i` reports success, every file is
# "Up-to-date", and the library this pin is supposed to link never changes.
# Nothing downstream can see that; the first sign is a stale slice discovered on
# a device. One arm64 Filament slice sat a pin behind that way for a week.
#
# CALLED BY LEG, not once for the whole checkout, because a leg can only answer
# for its own directories: a poisoned tvos dir must not block an Android build.
# The argument is the out/cmake- suffix that leg builds ("android-", "wasm-",
# "tvos-"). The desktop out/cmake-release is exempt everywhere and has no call:
# every script uses it in place, for out/cmake-release/tools/matc, and never
# reads what it installed, so its prefix cannot mislead anyone.
require_local_install() {
    local cache prefix
    for cache in "$FILAMENT_SRC"/out/cmake-"$1"*/CMakeCache.txt; do
        [ -f "$cache" ] || continue
        prefix=$(sed -n 's/^CMAKE_INSTALL_PREFIX:PATH=//p' "$cache")
        case "$prefix" in
            "$FILAMENT_SRC"/*|'') ;;
            *)  echo "$(dirname "$cache") installs into" >&2
                echo "  $prefix" >&2
                echo "which is outside $FILAMENT_SRC — an out/ carried over" >&2
                echo "from another checkout. Builds there succeed, report" >&2
                echo "everything up-to-date, and change nothing here." >&2
                echo "Delete that directory and rerun." >&2
                exit 1 ;;
        esac
    done
}
