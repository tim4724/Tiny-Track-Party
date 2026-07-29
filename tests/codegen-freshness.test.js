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
//   raceflow-corpus     <- public/display/raceFlow.js
//     The last RENEWABLE oracle. The other four (ui, session, audio, schematic)
//     were retired with their ports, so their corpora are frozen and the
//     `record_*` roundtrips took over; this one's JS survives, so it keeps the
//     original obligation and belongs here.
//
//   genTracks.js        <- scripts/track-gen.mjs (the seed grammar)
//     The odd member: not a C++ input, and its generator reads no JS twin — it
//     reads the NATIVE builder through scripts/native-track.mjs. Which is exactly
//     why it needs an entry. It went un-run from 2201d21 ("one track builder —
//     delete the JS twin") until this test, because placeFurniture still called
//     `cl.sampleAt(s)` on a Centerline that commit deleted: the whole bake for 16
//     shipped tracks could not be re-derived and nothing anywhere noticed. A
//     generator that consumes an ABI can rot without its own source changing, so
//     "the JS moved" is not the only trigger this list guards against.
//
// The FROZEN generators are deliberately NOT covered — gen-roomflow-corpus,
// gen-grandprix-corpus, gen-trackbuilder-corpus, gen-track-sampler-corpus,
// gen-math-corpus, gen-theme-corpus, and now gen-ui-corpus / gen-session-corpus
// / gen-audio-corpus / gen-schematic-corpus, whose twins went with the port.
// Re-deriving those is impossible by design.
//
// WHAT MUST NOT HAPPEN HERE, because it already did once: an entry being dropped
// while its generator is still live. This list is the only thing that runs these
// generators, so a missing entry is not a smaller gate — it is no gate, and the
// comment above still reads as coverage.
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
    // The race orchestration, and the LAST renewable oracle in the tree. The
    // other four were retired with their ports and their corpora frozen; this
    // one still has its JS (public/display/raceFlow.js), so it still carries the
    // obligation the frozen ones were released from — keep it green, because the
    // day it goes red for a rotted input is the day the corpus can no longer be
    // re-derived and the ratchet closes on the last one.
    what: 'tests/fixtures/raceflow-corpus.jsonl',
    from: 'public/display/raceFlow.js',
    gen: 'scripts/gen-raceflow-corpus.mjs',
    then: 'ctest --test-dir native/build -R raceflow   # then match native/libttp-runtime/ttp/race_flow.cc',
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
  // Also not a C++ input: the baked waypoints + auto-placed furniture for the 16
  // seeded tracks. Slow (~12 s) and it earns it — every other entry re-derives in
  // milliseconds because it just re-reads a JS file, while this one re-runs the
  // whole search: 16 elevation solves and grid-anchor shortlists, each building
  // real geometry through the native builder. That IS the check. A cheaper
  // version (one track per profile, say) would prove the pipeline executes and
  // then read like it proved the bake, which is the failure this file's header
  // is about.
  {
    what: 'public/shared/genTracks.js',
    from: 'scripts/track-gen.mjs + the native builder',
    gen: 'scripts/gen-tracks.mjs',
    then: 'node scripts/gen-track-schematics.js   # the schematics bake off these waypoints',
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
