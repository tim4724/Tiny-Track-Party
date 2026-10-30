'use strict';
// The shipped set pieces leave no part floating (scripts/set-check.mjs reads
// what floating is off the GLB's own surfaces). A model builder that misplaces
// or mis-rotates a part makes a piece that looks plausible in a still and wrong
// from the road, and no other gate opens a GLB.
//
// FLOATING names the pieces allowed to float, with how many islands each
// floats: on purpose (water drops in the air, a boat on the sea), or not yet
// fixed. A piece that floats more than its entry, or one with no entry, fails;
// one that floats less fails too until its entry comes down, so the list only
// shrinks.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const FLOATING = {
  'set-garden-hose': 12,      // the sprinkler's spray
  'set-sprinkler': 15,        // its spray
  'set-pirate-ship': 4,       // the rowboat on the sea beside it
  // Not yet fixed:
  'set-cow-skull': 10,
  'set-dead-cottonwood': 10,
  'set-lifeguard-tower': 4,
  'set-log-pile': 1,
  'set-pirate-camp': 1,
  'set-ski-lift': 3,
  'set-windsock': 5
};

test('no shipped set piece floats a part beyond its FLOATING entry', async () => {
  const { checkPiece, shippedPieces, SET_DIR } = await import(path.join(__dirname, '../scripts/set-check.mjs'));
  const got = {};
  for (const name of shippedPieces()) {
    const n = checkPiece(path.join(SET_DIR, `${name}.glb`)).floating.length;
    if (n || FLOATING[name]) got[name] = n;
  }
  assert.deepStrictEqual(got, FLOATING,
    'floating islands per piece (node scripts/set-check.mjs <name> says where)');
});
