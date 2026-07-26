'use strict';
// The generated C++ track catalogue must match the JS catalogue it was baked
// from.
//
// WHY. public/shared/tracks.js is the one authored source of track geometry, and
// it feeds TWO consumers: the JS TrackBuilder that the RENDERER draws with, live
// on every load, and native/libttp-track/generated/track_defs.h, which is baked
// once by scripts/gen-track-defs-header.mjs and is what the wasm SIM races on.
//
// Nothing connected them. Adding `width: 3.1` to a track — the most ordinary
// edit a designer makes — left all 33 ctests and all node tests green while the
// renderer drew a 3.1-wide road and the sim simulated the stale 2.5-wide one:
// cars clipping scenery that is not where it is drawn, with a fully green suite.
// The C++ conformance corpora cannot catch it either, because they are frozen
// recordings of the OLD geometry, so they agree with the OLD header.
//
// This is the tripwire. It re-derives the header from the current catalogue and
// demands byte equality, naming the command that fixes it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

test('generated/track_defs.h is current with public/shared/tracks.js', () => {
  const committed = fs.readFileSync(
    path.join(ROOT, 'native/libttp-track/generated/track_defs.h'), 'utf8');

  const regenerated = execFileSync(
    process.execPath,
    [path.join(ROOT, 'scripts/gen-track-defs-header.mjs'), '--stdout'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

  if (regenerated !== committed) {
    // Point at the first differing line — a whole-header diff is unreadable.
    const a = committed.split('\n');
    const b = regenerated.split('\n');
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    assert.fail(
      'native/libttp-track/generated/track_defs.h is STALE: the C++ sim would race '
      + 'different geometry than the renderer draws.\n'
      + `  first difference at line ${i + 1}\n`
      + `    committed:   ${JSON.stringify(a[i])}\n`
      + `    regenerated: ${JSON.stringify(b[i])}\n`
      + '  fix: node scripts/gen-track-defs-header.mjs\n'
      + '  then regenerate the corpus it is judged against and rebuild the wasm:\n'
      + '       node scripts/gen-trackbuilder-corpus.mjs\n'
      + '       native/scripts/build-runtime-web.sh',
    );
  }
});
