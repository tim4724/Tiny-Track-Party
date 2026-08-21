#!/usr/bin/env bash
# Assemble shells/androidtv/app/src/main/assets/ — everything the APK bundles,
# copied from the one place each thing is authored.
#
# A COPY rather than a symlink into ../../public, deliberately and for the same
# reason the tvOS script gives: public/assets is 89 MB and 81 MB of it is music
# this app does not ship, so pointing the packager at that directory would put
# the whole catalogue in the APK. Staging makes what ships a list rather than an
# accident.
#
# WHAT SHIPS (~7 MB):
#   toycar/     GLB + PNG — the renderer's whole model kit
#   toycar/thumbs/  the lobby's 2D car stills
#   audio/cues/ 28 WAV + manifest — pre-baked; the shell only plays them
#   audio/engine_loop.ogg — the one passthrough voice with live DSP
#   items/      the four shared item SVGs
#   materials/  the .filamat blobs, COMMITTED, not built here — see below
#   design-tokens.json
#   legal/      the attribution list + the license texts the build owes
#
# WHAT DOES NOT: the 81 MB race-music catalogue. It STREAMS from the origin one
# song at a time, exactly as the web does and as the tvOS app does, and a TV app
# already has that origin as a hard runtime dependency because the join QR and
# the phone controller are served from it (shells.md §8).
#
# TWO THINGS ARE EASIER HERE THAN ON tvOS, and both are worth knowing rather
# than rediscovering:
#
#   MATERIALS ARE ALREADY BUILT. build-materials.sh's default is `opengl mobile`,
#   which is what the web ships and what this wants — GLES3 is GLES3 — so these
#   are the SAME BYTES the browser loads, copied out of the committed artifact
#   directory. There is no matc in this pipeline at all. tvOS is the one leg
#   that needs its own set, because Metal.
#
#   THE ENGINE LOOP NEEDS NO TRANSCODE. It ships as Ogg Vorbis, which no Apple
#   platform can decode (there is no Core Audio codec for it, so the tvOS script
#   shells out to ffmpeg and pays ~1 MB for PCM). Android decodes Vorbis
#   natively, like a browser, so the authored file ships as authored.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SHELL_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$SHELL_DIR/../.." && pwd)"
OUT="$SHELL_DIR/app/src/main/assets"
MATERIALS="$ROOT/public/display/engine/native"

say() { printf '==> %s\n' "$*"; }

if [ -z "$(ls "$MATERIALS"/*.filamat 2>/dev/null)" ]; then
  echo "stage-assets.sh: no .filamat under $MATERIALS" >&2
  echo "  They are CHECKED IN (root CLAUDE.md rule 6). If they are missing," >&2
  echo "  run native/scripts/build-runtime-web.sh — not a per-platform build." >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT/toycar/Textures" "$OUT/toycar/thumbs" "$OUT/audio/cues" \
         "$OUT/materials" "$OUT/items"

# The model kit. Textures/ keeps its subdirectory because the name IS the lookup
# key: gltfio resolves an external texture by the exact URI authored in the GLB
# ("Textures/colormap.png"), and the shell provides bytes under that same string.
cp "$ROOT/public/assets/toycar"/*.glb "$OUT/toycar/"
cp "$ROOT/public/assets/toycar/Textures"/*.png "$OUT/toycar/Textures/"
cp "$ROOT/public/assets/toycar/KENNEY-License.txt" "$OUT/toycar/"

# Each car's front-3/4 HERO STILL — what makes a lobby seat show the car the
# player actually picked rather than a shape standing in for one. The 24-frame
# turntable strips are left behind for the reason the tvOS script gives: ~800 KB
# each, to make seats rotate behind a board nobody is looking at yet.
for png in "$ROOT/public/assets/toycar/thumbs"/*.png; do
  case "$png" in *.strip.png) continue;; esac
  cp "$png" "$OUT/toycar/thumbs/"
done

# The item icons, as the SHARED SVGs byte for byte (ledger item 11). The two CSS
# custom properties they are recoloured through (--icon-accent from
# ttp_theme_boost_icon, --icon-car from the car model's body tone) are
# substituted at runtime; a pre-baked PNG per (biome x car) would be a second
# source for the artwork these replaced.
cp "$ROOT/public/assets/items"/*.svg "$OUT/items/"

# The cues and their manifest — which carries each cue's detune spread. The
# jitter is the PLAYER's job by design (the bake froze it at 1.0), so the
# manifest is not optional decoration.
cp "$ROOT/public/assets/audio/cues"/*.wav "$OUT/audio/cues/"
cp "$ROOT/public/assets/audio/cues/manifest.json" "$OUT/audio/cues/"

# The engine voice, as authored. See the header for why there is no ffmpeg here.
cp "$ROOT/public/assets/audio/engine_loop.ogg" "$OUT/audio/"
cp "$ROOT/public/assets/audio/engine_loop.LICENSE.txt" "$OUT/audio/"

# The compiled materials — the web's own bytes, UNLESS the multiview set has
# been built (native/scripts/build-runtime-android.sh compiles it beside the
# .so). That set is the same materials with the OVR_multiview stereo variants
# added — identical shaders for every non-stereo draw — and it is what the
# multiview split-screen path needs; it stays build output because its blobs
# cannot be the committed shared set (shells/androidtv/CLAUDE.md, Multiview).
# Ten of the fourteen degrade SILENTLY if absent (no voverlay = the steer bar
# and cell dividers simply vanish, with nothing logged), so the shell asserts
# on the whole set at load rather than skipping like the web's `if (res.ok)`.
MATERIALS_MV="$ROOT/native/build/materials-android-mv"
if [ -n "$(ls "$MATERIALS_MV"/*.filamat 2>/dev/null)" ]; then
  say "materials: MULTIVIEW set ($MATERIALS_MV)"
  cp "$MATERIALS_MV"/*.filamat "$OUT/materials/"
else
  say "materials: committed shared set (no multiview build present)"
  cp "$MATERIALS"/*.filamat "$OUT/materials/"
fi

# The design tokens, as DATA — the same file the web's CSS is baked to, so the
# sticker palette has ONE source across all three shells rather than three
# hand-typed copies. Tokens.kt reads this; no colour in it may be spelled again
# in Kotlin.
cp "$ROOT/public/shared/design-tokens.json" "$OUT/"

# The type. The web ships ONE variable woff2 per family and lets the browser
# interpolate the weight axis; Android's font loader reads neither woff2 nor
# that arrangement, so it wants the same STATIC TTFs tvOS bakes.
#
# TAKEN FROM THE tvOS TREE, which is the one uncomfortable line in this script.
# They are generated build output (shells/tvos/scripts/gen-fonts.py, which needs
# fontTools + brotli — not repo dependencies, which is why the bake is committed
# rather than run here), and they are now shared by two shells rather than owned
# by one. The right home is beside the woff2 in public/assets/fonts/, and moving
# them means editing the Xcode project's resource references; the day a third
# consumer appears, do that instead of adding a second copy.
mkdir -p "$OUT/fonts"
cp "$ROOT/shells/tvos/TinyTrackParty/Resources/Fonts"/*.ttf "$OUT/fonts/"
# The SIL OFL requires the licence to travel with the font.
cp "$ROOT/public/assets/fonts"/OFL-*.txt "$OUT/fonts/"

# THE ATTRIBUTION LIST AND THE LICENSE TEXTS IT NAMES.
#
# An obligation, not an About page: this APK ships CC-BY music, OFL fonts and
# several notice-tier libraries, and a build that shows nobody is in breach.
# GENERATED rather than staged, because the list is not a file in this tree —
# it is public/shared/credits.js plus the live music catalogue, minus what only
# a browser ships, plus this APK's own packages. The generator's header has the
# whole story; it copies the texts it names itself, so the set can never be a
# list two scripts have to agree on.
#
# THIS IS WHY THIS SCRIPT NEEDS node. Nothing else here does, so say so plainly
# rather than failing inside the generator with a shell error.
if ! command -v node >/dev/null 2>&1; then
  echo "stage-assets.sh: node is not on PATH, and the legal board is baked from" >&2
  echo "  the web's own credit data. Build through shells/androidtv/scripts/build.sh" >&2
  echo "  (or any shell where \`npm run setup\` works) rather than from an IDE." >&2
  exit 1
fi
node "$HERE/gen-legal.mjs"

# THE BRAND PNGs, and these are the only staged files that go to res/ rather
# than assets/. Three of the four are consumed before a line of app code runs —
# the launcher tile is read by the home screen from the installed package, and
# the two splash resources by the window manager from the theme — so none of
# them can ask Compose to draw, and a VectorDrawable has no text primitive: the
# wordmark reaches them as a BAKE of the real `.wordmark` rule
# (scripts/bake-wordmark.mjs). res/ is also simply where a Compose
# `painterResource` reads, which is what the fourth one is for.
#
# Staged, not committed, for the reason everything else here is: the bake in
# public/assets/brand/ is the one copy.
RES="$SHELL_DIR/app/src/main/res/drawable-nodpi"
mkdir -p "$RES"
cp "$ROOT/public/assets/brand/wordmark.png" "$RES/"
cp "$ROOT/public/assets/brand/banner.png" "$RES/"
# The APP ICON, square, and separate from the banner on purpose: `android:icon`
# pointed at the 320x180 tile, so every square slot the platform has — settings,
# the app list, notifications — got a letterboxed banner. RENAMED to match the
# manifest's `@drawable/app_icon`: `icon` alone is a legal resource name but says
# nothing next to the four other bakes landing in this directory.
cp "$ROOT/public/assets/brand/icon.png" "$RES/app_icon.png"
# The system splash's icon. Square and laid out to survive the CIRCULAR MASK the
# platform applies to it — see the bake, which sizes the mark to the inscribed
# circle rather than to the canvas.
#
# RENAMED on the way in: an Android resource filename may only hold a-z, 0-9 and
# underscore, so the bake's hyphen would fail the resource merger rather than
# just being ignored.
cp "$ROOT/public/assets/brand/splash-icon.png" "$RES/splash_icon.png"
# The boot cover's picture, and the SAME BAKE tvOS shows (its launch image and
# its CoverView both come from this file). Android TV creates no starting window
# for any app, so unlike the two above this one IS drawn by app code — see
# RootScreen's cover — and a shell that drew live type instead would put a
# second, subtly different mark on the same beat.
cp "$ROOT/public/assets/brand/launch-tv.png" "$RES/launch_tv.png"

# NOT staged: public/shared/trackSchematics.js, the web's prebaked mini-maps.
# That bake exists so a browser need not run the projection; this app HAS the
# projection (ttp_track_schematic_json, and ttp_schematic_pack for the packed
# form the phones' chooser payload rides). Copying it would be a second source
# for something the engine already answers.

say "$(find "$OUT" -type f | wc -l | tr -d ' ') files, $(du -sh "$OUT" | cut -f1) -> app/src/main/assets"
