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

# The licenses page, which the AC lobby's legal footer opens in a NEW TAB (the
# screen iframe itself must never navigate — that drops the SDK session and ends
# the party). It is the only web page besides the two entries that ships, and it
# has to: the license texts under assets/ travel with the build, and this page is
# the one thing that points at them. It sits at the zip ROOT because licenses.js
# resolves ./shared/ and ./display/ against itself.
#
# Four transforms. The first two are what gen-airconsole-html.mjs does to the
# entries: drop the icon links (assets/icon/ is pruned below) and turn absolute
# hrefs relative. The other two remove the way BACK — in a tab the game did not
# open, "back to the game" has nowhere to go, and screen.html loaded outside the
# AirConsole iframe is a dead game. So the button goes and the wordmark loses its
# href, which leaves it rendering as the plain badge it already looks like.
bake "$PROJECT_DIR/public/licenses.html" "$BUILD_DIR/licenses.html"
cp "$PROJECT_DIR/public/licenses.js" "$PROJECT_DIR/public/licenses.css" "$BUILD_DIR/"
sed -E -e '/<link rel="(icon|apple-touch-icon)"/d' \
       -e '/class="btn btn--brand sheet__back"/d' \
       -e 's#(class="wordmark sheet__wordmark") href="/" aria-label="[^"]*"#\1#' \
       -e 's#(src|href)="/([^/])#\1="\2#g' \
       "$BUILD_DIR/licenses.html" > "$BUILD_DIR/licenses.html.tmp"
mv "$BUILD_DIR/licenses.html.tmp" "$BUILD_DIR/licenses.html"
# All four are silent no-ops if that page's markup moves, and the failure they
# would ship is a page that looks right and strands the reader (or one whose
# stylesheet 404s), so assert the outcome rather than trusting the patterns: the
# footer's own link is bare "licenses.html", and no root-absolute href survives.
grep -q 'href="licenses.html"' "$BUILD_DIR/licenses.html" || {
  echo "ERROR: licenses.html did not come out with relative hrefs" >&2; exit 1; }
if grep -q 'href="/' "$BUILD_DIR/licenses.html"; then
  echo "ERROR: licenses.html still carries root-absolute links, which have no root in the zip:" >&2
  grep -n 'href="/' "$BUILD_DIR/licenses.html" >&2
  exit 1
fi

# THE ENGINE GLUE SHIPS AS .js, NOT .mjs.
#
# A CDN answers by extension, and .mjs is not one every CDN knows. Served as
# application/octet-stream a module script is REFUSED OUTRIGHT — strict MIME
# checking per the HTML spec, not a warning — and it 200s while doing it, so
# nothing 404s and no request "fails". That kills the engine, and a display
# with no engine never opens a room or publishes a snapshot, so every phone
# that joins sits blank on "no signal".
#
# It is invisible everywhere we test: our own server maps .mjs explicitly (see
# server/index.js), which covers the web, the previews and the AC simulator. It
# bites only in the uploaded build. .js is the one extension every CDN gets
# right, and the glue carries no reference to its own name — only to the .wasm
# beside it — so the rename costs two references and nothing else.
#
# .wasm needs no such care: a wrong type there costs the streaming path and
# emscripten falls back to ArrayBuffer instantiation, which is a log line, not
# a failure. Verified by serving this tree from a server that knows neither.
mv "$BUILD_DIR/display/engine/native/ttp_runtime.mjs" \
   "$BUILD_DIR/display/engine/native/ttp_runtime.js"
for f in "$BUILD_DIR/display/nativeRuntime.js" "$BUILD_DIR/screen.html"; do
  sed -e 's|ttp_runtime\.mjs|ttp_runtime.js|g' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
done
# Any .mjs left is one nothing above knew about — fail rather than ship a build
# whose engine may not start on the CDN.
if find "$BUILD_DIR" -name '*.mjs' | grep -q .; then
  echo "ERROR: .mjs files remain in the package (a CDN may serve them as octet-stream," >&2
  echo "       which refuses them as module scripts):" >&2
  find "$BUILD_DIR" -name '*.mjs' >&2
  exit 1
fi

# Favicons belong to the top document — the AC iframe can't surface them.
rm -rf "$BUILD_DIR/assets/icon"

# Dev-only modules the AC pages never load: each is a dynamic import behind a
# gate the AirConsole iframe can't satisfy — a query param (?scenario= gallery,
# ?solo, ?netstats=1) or, for the wrench debug panel, main.js's
# !window.airconsole check.
rm -f "$BUILD_DIR/display/TestHarness.js" "$BUILD_DIR/display/DebugSolo.js" \
      "$BUILD_DIR/display/debugFields.js" \
      "$BUILD_DIR/controller/TestHarness.js" "$BUILD_DIR/controller/NetStats.js" \
      "$BUILD_DIR/shared/debugPanel.js" "$BUILD_DIR/shared/debugPanel.css"

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
