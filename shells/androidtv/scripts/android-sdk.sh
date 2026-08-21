# THE SDK, if the environment did not name one. Sourced, never run.
#
# Gradle looks at ANDROID_HOME and at shells/androidtv/local.properties, and that
# file is gitignored — so a fresh worktree with Android Studio installed still
# fails on "SDK location not found", which names neither of the two places it
# looked. Studio's own default install is the fallback; naming it costs nothing
# and is what the failure was asking for anyway. An explicit ANDROID_HOME always
# wins.
#
# Its own file because it has two callers: `build.sh` and the perf loop's
# `androidtv-cycle.sh`.
if [ -z "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ]; then
    for candidate in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
        if [ -d "$candidate/platform-tools" ]; then
            export ANDROID_HOME="$candidate"
            printf '\033[36m==> ANDROID_HOME unset — using %s\033[0m\n' "$candidate"
            break
        fi
    done
fi
