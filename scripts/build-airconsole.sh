#!/bin/bash
# Build the AirConsole-ready ZIP for upload to airconsole.com/developers.
#
# AirConsole expects screen.html and controller.html at the ZIP ROOT with every
# asset referenced relatively — which the committed entries already are (see
# scripts/gen-airconsole-html.mjs); this script's own work is baking the
# serve-time placeholders the dev server normally substitutes, and pruning the
# trees down to what the two pages actually reach. There is no bundler in this
# repo: the pages ship as the same individual files the web serves.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_DIR/build/airconsole"
APP_VERSION=$(node -e "console.log(require('$PROJECT_DIR/package.json').version)")
ZIP_FILE="$PROJECT_DIR/build/tiny-track-party-airconsole-$APP_VERSION.zip"

echo "Building AirConsole package..."

# Regenerate the entries so the zip can't ship stale ones.
node "$SCRIPT_DIR/gen-airconsole-html.mjs"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# The four public trees both pages reach, plus the transport kit under the
# same /partyplug/ prefix the server remaps it to.
cp -r "$PROJECT_DIR/public/shared" "$BUILD_DIR/shared"
cp -r "$PROJECT_DIR/public/display" "$BUILD_DIR/display"
cp -r "$PROJECT_DIR/public/controller" "$BUILD_DIR/controller"
cp -r "$PROJECT_DIR/public/assets" "$BUILD_DIR/assets"
mkdir -p "$BUILD_DIR/partyplug"
cp "$PROJECT_DIR"/partyplug/*.js "$BUILD_DIR/partyplug/"

# Entry points at the zip root, with the serve-time placeholders baked: the
# release version (no dev "(#sha)" suffix), no build badge, and an empty relay
# override — protocol.js falls back to the production relay, which AC mode
# never dials anyway. The web-only entries and the subdir copies go.
bake() {
  sed -e "s/__APP_VERSION__/$APP_VERSION/g" \
      -e "s/__VERSION_BADGE__//g" \
      -e "s/__APP_V__/$APP_VERSION/g" \
      -e "s/__RELAY_URL__//g" "$1" > "$2"
}
bake "$BUILD_DIR/display/screen.html" "$BUILD_DIR/screen.html"
bake "$BUILD_DIR/controller/controller.html" "$BUILD_DIR/controller.html"
rm -f "$BUILD_DIR/display/screen.html" "$BUILD_DIR/controller/controller.html" \
      "$BUILD_DIR/display/index.html" "$BUILD_DIR/controller/index.html"

# Favicons belong to the top document — the AC iframe can't surface them.
rm -rf "$BUILD_DIR/assets/icon"

# Dev-only modules the AC pages can never load: each is a dynamic import behind
# a query param (?scenario= gallery, ?solo, ?netstats=1) that the AirConsole
# iframe never carries. debugPanel/debugFields stay — main.js imports them
# unconditionally.
rm -f "$BUILD_DIR/display/TestHarness.js" "$BUILD_DIR/display/DebugSolo.js" \
      "$BUILD_DIR/controller/TestHarness.js" "$BUILD_DIR/controller/NetStats.js"

# Docs and build-time records nothing at runtime reads. License and credit
# files (OFL, Kenney, CREDITS.txt, engine_loop.LICENSE.txt) deliberately stay.
find "$BUILD_DIR" -name CLAUDE.md -delete
rm -f "$BUILD_DIR/display/engine/native/BUILD_STAMP.json" \
      "$BUILD_DIR/shared/design-tokens.json" \
      "$BUILD_DIR/assets/audio/cues/manifest.json" \
      "$BUILD_DIR/assets/audio/music/SOURCES.json"

cd "$BUILD_DIR"
rm -f "$ZIP_FILE"
zip -qr "$ZIP_FILE" . -x '*.DS_Store'

echo ""
echo "AirConsole package: $ZIP_FILE ($(du -h "$ZIP_FILE" | cut -f1))"
echo "Upload at: https://www.airconsole.com/developers"
