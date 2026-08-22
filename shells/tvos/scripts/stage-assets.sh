#!/usr/bin/env bash
# Assemble shells/tvos/Generated/assets/ — everything the app bundles, copied
# from the one place each thing is authored.
#
# A COPY rather than an Xcode folder reference into ../../public, deliberately:
# public/assets is 87 MB and 81 MB of it is music this app does not ship (below),
# so pointing the bundle at that directory would put the whole catalogue in the
# .ipa. Staging makes what ships a list rather than an accident, and it is the
# same list `tests/display-abi.test.js` already pins for the web.
#
# WHAT SHIPS (a few MB; the copy below is the list, and it prints its own count
# at the end rather than stating one here that the next asset would falsify):
#   toycar/     the renderer's whole model kit, GLBs + the shared palette PNGs
#   toycar/thumbs/ the lobby's 2D car stills + the banana icon (no strips)
#   items/      the shared item-icon SVGs, byte-for-byte
#   audio/cues/ the pre-baked WAVs + manifest — the shell only plays them
#   audio/      the engine loop, transcoded (below)
#   materials/  the .filamat set, compiled for METAL by build-runtime-tvos.sh
#   licenses/   the notice texts the info board drills into (gen-legal.mjs)
#   fonts       committed TTFs (Resources/Fonts, staged by Xcode not by this)
#
# WHAT DOES NOT: the 81 MB race-music catalogue. It STREAMS from the origin, one
# song at a time, exactly as the web does through its <audio> element — and a TV
# app already has that origin as a hard runtime dependency, because the join QR
# and the phone controller are served from it (docs/native-port/shells.md §8).
# So this costs no dependency that did not already exist, and it sidesteps the
# thing that makes the music hard to bundle: `audio.cc`'s SONG table bakes each
# path INCLUDING its .mp3 extension, and `audio-corpus.jsonl` froze those strings
# with its JS oracle deleted — so the catalogue cannot be re-encoded smaller
# without an ABI change (making Song::file a stem). See the ledger's R1.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TVOS="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$TVOS/../.." && pwd)"
OUT="$TVOS/Generated/assets"

say() { printf '==> %s\n' "$*"; }

if [ ! -d "$TVOS/Generated/materials" ] || [ -z "$(ls -A "$TVOS/Generated/materials" 2>/dev/null)" ]; then
  echo "stage-assets.sh: no Metal materials — run native/scripts/build-runtime-tvos.sh first" >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT/toycar/Textures" "$OUT/audio/cues" "$OUT/materials"

# The model kit. Textures/ keeps its subdirectory because the name IS the lookup
# key: gltfio resolves an external texture by the exact URI authored in the GLB
# ("Textures/colormap.png"), and the shell provides bytes under that same string.
cp "$ROOT/public/assets/toycar"/*.glb "$OUT/toycar/"
cp "$ROOT/public/assets/toycar/Textures"/*.png "$OUT/toycar/Textures/"
cp "$ROOT/public/assets/toycar/KENNEY-License.txt" "$OUT/toycar/"

# The 2D thumbnails: each car's front-3/4 HERO STILL. They are what makes a
# lobby seat show the car the player actually picked rather than a shape
# standing in for one.
#
# THE TURNTABLE STRIPS ARE DELIBERATELY LEFT BEHIND. `<model>.strip.png` is a
# 24-frame sprite sheet, ~800 KB each and 3.4 MB for the set — thirteen times
# the stills — to make the seats rotate in lockstep. That is a lovely thing on
# the web, where it costs one lazy request; in an .ipa it is 3.4 MB of bundle
# for motion behind a board nobody is looking at yet. If it is ever wanted, the
# assets exist and `carThumbs.js` documents the frame count and rate.
mkdir -p "$OUT/toycar/thumbs"
for png in "$ROOT/public/assets/toycar/thumbs"/*.png; do
  case "$png" in *.strip.png) continue;; esac
  cp "$png" "$OUT/toycar/thumbs/"
done

# The item icons: the SHARED SVGs, byte-for-byte (ledger item 10). ItemIcon
# substitutes the two CSS custom properties (--icon-accent, --icon-car) and
# rasterizes at runtime — a pre-baked PNG per (biome x car) combination would
# be a second source for the artwork, which is what the SVGs replaced.
mkdir -p "$OUT/items"
cp "$ROOT/public/assets/items"/*.svg "$OUT/items/"

# The cues, and their manifest — which carries each cue's detune spread. The
# jitter is the PLAYER's job by design (the bake froze it at 1.0), so the
# manifest is not optional decoration.
cp "$ROOT/public/assets/audio/cues"/*.wav "$OUT/audio/cues/"
cp "$ROOT/public/assets/audio/cues/manifest.json" "$OUT/audio/cues/"

# The engine loop, TRANSCODED. It is the one PASSTHROUGH voice with live DSP
# (pitch and gain by speed) rather than a baked cue, and it ships as Ogg Vorbis —
# which no Apple platform can decode: there is no Core Audio codec for Vorbis, so
# AVAudioFile simply refuses the file. The web gets it for free because browsers
# ship their own decoder.
#
# Re-encoded to 16-bit PCM WAV rather than to AAC on purpose: this loop is
# pitch-shifted and gain-tracked every frame, and a lossy round trip through a
# codec designed for one-shot playback puts pre-echo on exactly the sustained
# tone the effect is made of. It is a few seconds of audio; PCM costs ~1 MB.
ENGINE_SRC="$ROOT/public/assets/audio/engine_loop.ogg"
if [ -f "$ENGINE_SRC" ]; then
  if command -v ffmpeg >/dev/null 2>&1; then
    ffmpeg -v error -y -i "$ENGINE_SRC" -c:a pcm_s16le "$OUT/audio/engine_loop.wav"
    # The CC0 attribution travels with it, as it does in the web tree.
    cp "$ROOT/public/assets/audio/engine_loop.LICENSE.txt" "$OUT/audio/"
  else
    echo "stage-assets.sh: no ffmpeg — the engine voice will be silent" >&2
    echo "  brew install ffmpeg, then re-run" >&2
  fi
fi

# Metal .filamat. Every blob but vcolor degrades SILENTLY if absent (no voverlay
# = the steer bar and cell dividers simply vanish), so the app asserts on the
# whole set at load rather than skipping like the web's `if (res.ok)` does.
# SceneStaging.materialNames is that set, held equal to the web's MATERIALS by
# tests/material-list.test.js.
cp "$TVOS/Generated/materials"/*.filamat "$OUT/materials/"

# The design tokens, as DATA — the same file the web's CSS is baked to, so the
# sticker palette has one source across all three shells rather than three
# hand-typed copies (docs/native-port/architecture.md's mitigation for accepting
# three implementations of the look).
cp "$ROOT/public/shared/design-tokens.json" "$OUT/"

# NOT staged: public/shared/trackSchematics.js, the web's prebaked mini-maps.
# That bake exists so a browser need not run the projection; this app has the
# projection itself (`ttp_track_schematic_json`, and `ttp_schematic_pack` for the
# packed form the phones' chooser payload rides). Copying the bake would be a
# second source for something the wasm already answers — the exact shape of
# drift the manifest rule exists to stop.

# The screenshot runner's scenario list, baked from the same table the web
# gallery renders. Swift rather than a resource, because the runner needs it
# before it can launch anything.
node "$HERE/gen-scenarios.mjs"

# The info board's legal data, and the license texts it drills into. Both are
# the generator's own output (it derives which notices ship from the credits it
# just baked), so nothing here lists them a second time. The fonts' OFL texts
# arrive that way too — they also sit beside the TTFs in Resources/Fonts, which
# is provenance for the font pack rather than a second source: the staged copy
# comes from public/assets/fonts, where credits.js points.
node "$HERE/gen-legal.mjs"

# THE LAUNCH IMAGE, and it goes into an ASSET CATALOG rather than the bundle
# tree above: tvOS reads a launch image out of a compiled Assets.car, before a
# line of app code runs, so it cannot be an ordinary resource and it cannot be
# drawn by SwiftUI. The picture is a bake of the real `.wordmark` rule
# (scripts/bake-wordmark.mjs), the same one Android's windowBackground uses, so
# the two boxes open on one app rather than two.
#
# Staged here rather than committed for the reason the rest of Generated/ is:
# public/assets/brand/ holds the one copy.
# …and the same PNG as an ordinary bundled resource, because the COVER draws it
# too: the launch image is dismissed by the system the moment the window is
# presented, and there is no API to hold it, so the seamless splash is one
# picture shown by two mechanisms rather than two pictures that nearly match.
mkdir -p "$OUT/brand"
cp "$ROOT/public/assets/brand/launch-tv.png" "$OUT/brand/"

CAT="$TVOS/Generated/Assets.xcassets/LaunchImage.launchimage"
mkdir -p "$CAT"
cp "$ROOT/public/assets/brand/launch-tv.png" "$CAT/launch.png"
cat > "$CAT/Contents.json" <<'JSON'
{
  "images" : [
    {
      "extent" : "full-screen",
      "idiom" : "tv",
      "filename" : "launch.png",
      "minimum-system-version" : "9.0",
      "orientation" : "landscape",
      "scale" : "1x"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
JSON
cat > "$TVOS/Generated/Assets.xcassets/Contents.json" <<'JSON'
{
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
JSON

# THE BRAND ASSETS: the app icon and the two top-shelf banners. This shell had
# none of it, so the home screen drew the platform placeholder.
#
# A tvOS app icon is not a picture, it is a STACK. The system separates the
# layers as focus moves across the icon, and that parallax is the entire reason
# the format exists — a one-layer stack is legal and looks dead next to every
# other icon on the shelf. So the same composition the square icon shows flat is
# baked as three: paper behind, grass between, car in front. It is also WIDE
# (5:3), which is why it cannot be the square icon resized.
#
# `role` is what binds each entry to a slot; the sizes are the platform's and
# are not ours to choose. Names carry spaces because that is what Xcode writes
# and what every example in the documentation shows.
BRAND="$TVOS/Generated/Assets.xcassets/Brand Assets.brandassets"
TVSRC="$ROOT/public/assets/brand/tv"
rm -rf "$BRAND"
mkdir -p "$BRAND"
cat > "$BRAND/Contents.json" <<'JSON'
{
  "assets" : [
    { "filename" : "App Icon - App Store.imagestack", "idiom" : "tv",
      "role" : "primary-app-icon", "size" : "1280x768" },
    { "filename" : "App Icon.imagestack", "idiom" : "tv",
      "role" : "primary-app-icon", "size" : "400x240" },
    { "filename" : "Top Shelf Image Wide.imageset", "idiom" : "tv",
      "role" : "top-shelf-image-wide", "size" : "2320x720" },
    { "filename" : "Top Shelf Image.imageset", "idiom" : "tv",
      "role" : "top-shelf-image", "size" : "1920x720" }
  ],
  "info" : { "author" : "xcode", "version" : 1 }
}
JSON

# One layer of a stack: a .imagestacklayer wrapping a Content.imageset. $4 is
# the @2x file and is optional — the App Store icon is 1x only.
tv_layer() {  # $1 stack dir, $2 layer name, $3 1x png, $4 2x png (optional)
  local dir="$1/$2.imagestacklayer"
  mkdir -p "$dir/Content.imageset"
  echo '{ "info" : { "author" : "xcode", "version" : 1 } }' > "$dir/Contents.json"
  cp "$TVSRC/$3" "$dir/Content.imageset/$3"
  if [ -n "${4:-}" ]; then
    cp "$TVSRC/$4" "$dir/Content.imageset/$4"
    cat > "$dir/Content.imageset/Contents.json" <<JSON
{
  "images" : [
    { "filename" : "$3", "idiom" : "tv", "scale" : "1x" },
    { "filename" : "$4", "idiom" : "tv", "scale" : "2x" }
  ],
  "info" : { "author" : "xcode", "version" : 1 }
}
JSON
  else
    cat > "$dir/Content.imageset/Contents.json" <<JSON
{
  "images" : [ { "filename" : "$3", "idiom" : "tv", "scale" : "1x" } ],
  "info" : { "author" : "xcode", "version" : 1 }
}
JSON
  fi
}

# FRONT FIRST. The layer order in this list is front-to-back, so a reversed one
# buries the car behind the paper and the icon renders as an empty field.
tv_stack() {  # $1 stack dir
  mkdir -p "$1"
  cat > "$1/Contents.json" <<'JSON'
{
  "layers" : [
    { "filename" : "Front.imagestacklayer" },
    { "filename" : "Middle.imagestacklayer" },
    { "filename" : "Back.imagestacklayer" }
  ],
  "info" : { "author" : "xcode", "version" : 1 }
}
JSON
}

tv_stack "$BRAND/App Icon - App Store.imagestack"
tv_layer "$BRAND/App Icon - App Store.imagestack" Back   icon-store-back.png
tv_layer "$BRAND/App Icon - App Store.imagestack" Middle icon-store-middle.png
tv_layer "$BRAND/App Icon - App Store.imagestack" Front  icon-store-front.png

tv_stack "$BRAND/App Icon.imagestack"
tv_layer "$BRAND/App Icon.imagestack" Back   icon-back.png   'icon-back@2x.png'
tv_layer "$BRAND/App Icon.imagestack" Middle icon-middle.png 'icon-middle@2x.png'
tv_layer "$BRAND/App Icon.imagestack" Front  icon-front.png  'icon-front@2x.png'

tv_shelf() {  # $1 set name, $2 1x png, $3 2x png
  local dir="$BRAND/$1.imageset"
  mkdir -p "$dir"
  cp "$TVSRC/$2" "$TVSRC/$3" "$dir/"
  cat > "$dir/Contents.json" <<JSON
{
  "images" : [
    { "filename" : "$2", "idiom" : "tv", "scale" : "1x" },
    { "filename" : "$3", "idiom" : "tv", "scale" : "2x" }
  ],
  "info" : { "author" : "xcode", "version" : 1 }
}
JSON
}

# JPEG, not PNG: these are photographs of a 3D scene since the shelf became a
# gameplay capture (scripts/bake-shelf.mjs), and an imageset takes either.
tv_shelf "Top Shelf Image" topshelf.jpg 'topshelf@2x.jpg'
tv_shelf "Top Shelf Image Wide" topshelf-wide.jpg 'topshelf-wide@2x.jpg'

# ---- the Top Shelf CAROUSEL -------------------------------------------------
# The extension's own bundle, and a plain directory copy rather than a catalogue:
# TVTopShelfCarouselItem takes an image URL, so the frames stay files the provider
# resolves by name (TopShelf/TopShelfProvider.swift). carousel.json travels with
# them because it names the running order and the titles, and both come out of the
# same capture (scripts/bake-shelf.mjs) — a running order retyped in Swift would
# drift the first time a frame was renamed.
SHELF_SRC="$ROOT/public/assets/brand/tv/shelf"
SHELF_OUT="$TVOS/Generated/shelf"
rm -rf "$SHELF_OUT"
mkdir -p "$SHELF_OUT"
if [ -d "$SHELF_SRC" ] && [ -f "$SHELF_SRC/carousel.json" ]; then
  cp "$SHELF_SRC"/*.jpg "$SHELF_SRC/carousel.json" "$SHELF_OUT/"
  say "$(ls "$SHELF_OUT"/*.jpg | wc -l | tr -d ' ') carousel frames -> Generated/shelf"
else
  # Not fatal, and deliberately so: the provider drops to nothing and the shelf
  # falls back to the catalogue's static strip, which is staged above and always
  # present. `npm run bake:shelf` is what fills this in.
  echo "  no public/assets/brand/tv/shelf — run 'npm run bake:shelf' (shelf carousel will be empty)" >&2
fi

say "$(find "$OUT" -type f | wc -l | tr -d ' ') files, $(du -sh "$OUT" | cut -f1) -> Generated/assets"
