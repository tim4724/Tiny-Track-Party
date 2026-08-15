// The chooser payload's SHAPE, across the two shells that write it.
//
// The chooser — cars, colours, tracks — is the one game payload with no gate
// anywhere else in the tree, and it is worth being precise about why:
//
//   * `ttp_net_configure` takes it OPAQUELY. The session model knows exactly one
//     thing about it (that `tracks` ride the lobby snapshot), so C++ validates
//     no key and rejects no shape.
//   * It is not in the protocol MANIFEST, so `tests/config-drift.test.js` does
//     not see it.
//   * No corpus covers it. The session corpus carries a synthetic world, and it
//     is frozen besides.
//   * `abi_check` cannot see it either: it is a blob in, a blob out.
//
// So a shell that spells a key wrong publishes a snapshot the relay accepts, the
// phone parses, and nobody errors on — the picker just comes up blank. That is
// exactly what shipped: the tvOS shell sent `cars` as bare model-id strings and
// spelled the packed map `p` and the difficulty `level`, and a scanned phone drew
// a car picker with no images, a track list with no maps, no cup selector, and a
// Start button that did nothing because no pick could resolve a trackId. Four
// symptoms, one shape, zero failing tests.
//
// THE SPEC IS THE CONTROLLER. Phones stay on the JS controller on all three TV
// platforms, so `public/controller/main.js` is the only reader that will ever
// exist and its field names are the contract. The WEB display is the known-good
// encoding of that contract — it is what players use — so this pins every other
// shell to the web's key set rather than to a list retyped here, which would be
// a third source of the same fact and would rot the same way.
//
// It reads Swift as TEXT, which is crude and deliberate: nothing else in this
// repo can see a .swift file and a .js file at once, and the alternative to a
// crude gate here is the none that let this ship.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

// One extractor per language, because the two spell a literal key differently
// and a regex loose enough for both picks up things that are not keys at all.
//
// Swift QUOTES every key (`"svg": packed`), so requiring the quotes is what
// keeps its type annotations out — `[String: Any]` and `reduce(into: [String:
// String]())` both look exactly like a key to a quote-optional pattern, and
// `String` is not a field of anything.
const swiftKeys = (block) => {
  const keys = new Set();
  for (const m of block.matchAll(/["'](\w+)["']\s*:/g)) keys.add(m[1]);
  return keys;
};
// JS writes them BARE (`svg: pack(...)`) and also allows the shorthand
// `{ id, name }`, which carries no colon at all. Both passes are needed:
// without the second the web side reads as almost keyless and the whole gate
// passes vacuously. Anchoring each on a preceding `{`, `[` or `,` keeps
// ternaries and labels out.
const jsKeys = (block) => {
  const keys = new Set();
  for (const m of block.matchAll(/[{[,]\s*["']?(\w+)["']?\s*:/g)) keys.add(m[1]);
  for (const m of block.matchAll(/[{,]\s*(\w+)\s*(?=[,}])/g)) keys.add(m[1]);
  return keys;
};
const slice = (src, start, end) => {
  const i = src.indexOf(start);
  assert.notEqual(i, -1, `anchor not found: ${start}`);
  const j = src.indexOf(end, i + start.length);
  assert.notEqual(j, -1, `end anchor not found after ${start}: ${end}`);
  return src.slice(i, j);
};

const webBoot = read('public/display/boot.js');
// The shell is optional, as every other tvOS test treats it (fast-forward,
// launch-answer-keys, last-error): a checkout without shells/ still runs the
// web-side anchor guard and skips only the cross-shell comparisons.
const TVOS_FILE = 'shells/tvos/TinyTrackParty/App/GameCoordinator.swift';
const tvos = existsSync(path.join(ROOT, TVOS_FILE)) ? read(TVOS_FILE) : null;

// `stats` is nested in both, and its four members matter as much as the wrapper
// (a picker bar reading `undefined` draws nothing). Flattening the key sets is
// what lets one comparison cover the wrapper and its contents together.
const webCars = jsKeys(slice(webBoot, 'const carChooser = carModels.map', '\n  // The cup list is NOT handed back'));
const webTracks = jsKeys(slice(webBoot, 'const trackChooser = trackList.flatMap', '\n  // Car id/name/handling stats'));
const tvosCars = tvos && swiftKeys(slice(tvos, 'private func chooserCars()', '\n    /// The chooser\'s track list'));
const tvosTracks = tvos && swiftKeys(slice(tvos, 'private func chooserTracks(', '\n    // MARK: - Screens'));

// A guard on the extraction itself. Every assertion below is a set comparison,
// and two empty sets compare equal — so an anchor that silently stops matching
// (a rename, a reordered file) would turn this whole file green while testing
// nothing at all.
test('the extraction actually found the four payload shapes', () => {
  const shapes = [['web cars', webCars], ['web tracks', webTracks]];
  if (tvos) shapes.push(['tvOS cars', tvosCars], ['tvOS tracks', tvosTracks]);
  for (const [name, keys] of shapes) {
    assert.ok(keys.size >= 3, `${name}: extracted ${keys.size} keys — the anchor has drifted`);
  }
  // The fields the controller INDEXES on, named here so the gate states the
  // contract rather than only comparing two shells to each other. `svg` is the
  // packed mini-map, `cup` is what the mode picker groups by
  // (`trackCatalog.find((t) => t.cup)`), `stats` is the picker's bars.
  for (const k of ['id', 'name', 'stats']) assert.ok(webCars.has(k), `web cars lost "${k}"`);
  for (const k of ['id', 'name', 'svg', 'cup', 'cupName']) {
    assert.ok(webTracks.has(k), `web tracks lost "${k}"`);
  }
});

test('the tvOS shell writes the same car chooser keys as the web', () => {
  if (!tvos) return;
  assert.deepEqual([...tvosCars].sort(), [...webCars].sort(),
    'shells/tvos GameCoordinator.chooserCars() and public/display/boot.js carChooser disagree — ' +
    'the phone reads these by name (public/controller/main.js), so a mismatch is a blank car picker');
});

test('the tvOS shell writes the same track chooser keys as the web', () => {
  if (!tvos) return;
  assert.deepEqual([...tvosTracks].sort(), [...webTracks].sort(),
    'shells/tvos GameCoordinator.chooserTracks() and public/display/boot.js trackChooser disagree — ' +
    'missing `svg` is a lobby with no mini-maps, missing `cup` is no cup selector at all');
});
