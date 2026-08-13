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
