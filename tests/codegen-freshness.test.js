'use strict';
// Generated C++ inputs must be current with the JS they were baked from.
//
// WHY. Four artefacts are derived once from live JS and then committed, and the
// C++ side is judged only against the committed copy. So when the JS moves, the
// C++ keeps agreeing with the stale bake and the whole suite stays green while
// the two halves of the running game disagree. Both cases are real and both were
// verified by mutation:
//
//   track_defs.h        <- public/shared/{tracks,devTracks}.js
//     Adding `width: 3.1` to tidepool passed 33/33 ctest and 140/140 node while
//     the renderer drew a 3.1-wide road and the wasm sim raced the stale
//     2.5-wide one: cars clipping scenery that is not where it is drawn.
//     That failure mode is gone now that the renderer builds from the same defs
//     the sim does — but the header is still a bake of live JS, so a stale one
//     now desyncs the whole GAME from its authored descriptors instead.
//
//   protocol-corpus     <- public/shared/protocol.js
//   framing-corpus      <- partyplug/PartyConnection.js
//   fastlane-corpus     <- partyplug/PartyFastlane.js
//     These three JS files are STILL LIVE ON THE PHONE — the controller runs
//     them directly — while their C++ twins run on the display. Raising
//     MAX_PLAYERS from 4 to 6 passed everything, with the phone allowing six
//     players and the display's party layer capping at four.
//
// The frozen generators (gen-roomflow-corpus, gen-grandprix-corpus) are
// deliberately NOT covered: CLAUDE.md marks them frozen because their JS twins
// are gone, so re-deriving them is impossible by design.
//
// Regenerating is only step one: the refreshed corpus is what then turns the C++
// ctest red, which is what forces the C++ constant to follow.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

const DERIVED = [
  {
    what: 'native/libttp-track/generated/track_defs.h',
    from: 'public/shared/{tracks,devTracks}.js',
    gen: 'scripts/gen-track-defs-header.mjs',
    then: 'node scripts/gen-trackbuilder-corpus.mjs && native/scripts/build-runtime-web.sh',
  },
  {
    what: 'tests/fixtures/protocol-corpus.jsonl',
    from: 'public/shared/protocol.js',
    gen: 'scripts/gen-protocol-corpus.mjs',
    then: 'ctest --test-dir native/build -R protocol   # then match native/libttp-party/ttp/protocol.h',
  },
  {
    what: 'tests/fixtures/framing-corpus.jsonl',
    from: 'partyplug/PartyConnection.js',
    gen: 'scripts/gen-framing-corpus.mjs',
    then: 'ctest --test-dir native/build -R framing    # then match native/libttp-party/ttp/relay_framing.cc',
  },
  {
    what: 'tests/fixtures/fastlane-corpus.jsonl',
    from: 'partyplug/PartyFastlane.js',
    gen: 'scripts/gen-fastlane-corpus.mjs',
    then: 'ctest --test-dir native/build -R fastlane   # then match native/libttp-party/ttp/fastlane.cc',
  },
  {
    // The top-down map + its snapshot codec. Its inputs are the committed
    // shared/trackSchematics.js bake and the live trackSchematic.js, both of
    // which survive — the phone still unpacks in JS — so this one stays
    // re-derivable for as long as the controller does.
    what: 'tests/fixtures/schematic-corpus.jsonl',
    from: 'public/display/trackSchematic.js + public/shared/trackSchematics.js',
    gen: 'scripts/gen-schematic-corpus.mjs',
    then: 'ctest --test-dir native/build -R schematic  # then match native/libttp-track/ttp/schematic.cc',
  },
  // Not a C++ input (yet): the design tokens as data, for the tvOS/Android TV
  // shells architecture.md accepts three implementations of the sticker look
  // for. Same failure mode though — theme.css is the authored source, the JSON
  // is a bake, and a stale bake is a second look silently disagreeing with the
  // web. tests/design-tokens.test.js is the other half: it proves the bake is
  // FAITHFUL, this proves it is CURRENT.
  {
    what: 'public/shared/design-tokens.json',
    from: 'public/shared/theme.css',
    gen: 'scripts/gen-design-tokens.mjs',
    then: 'node --test tests/design-tokens.test.js',
  },
];

for (const d of DERIVED) {
  test(`${d.what} is current with ${d.from}`, () => {
    const committed = fs.readFileSync(path.join(ROOT, d.what), 'utf8');
    const regenerated = execFileSync(
      process.execPath, [path.join(ROOT, d.gen), '--stdout'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (regenerated === committed) return;

    // A whole-file diff is unreadable; point at the first differing line.
    const a = committed.split('\n');
    const b = regenerated.split('\n');
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    const clip = (s) => (s === undefined ? '<missing>' : JSON.stringify(s.length > 200 ? s.slice(0, 200) + '…' : s));
    assert.fail(
      `${d.what} is STALE against ${d.from}: the C++ side is being judged against a bake that no longer matches the JS.\n`
      + `  first difference at line ${i + 1}\n`
      + `    committed:   ${clip(a[i])}\n`
      + `    regenerated: ${clip(b[i])}\n`
      + `  fix: node ${d.gen}\n`
      + `  then: ${d.then}`,
    );
  });
}
