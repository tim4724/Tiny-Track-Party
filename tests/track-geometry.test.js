// The catalogue's geometry audit, as a GATE.
//
// `scripts/audit-tracks.mjs` catches three things a track can be built wrong in
// — decks that merge side by side, support posts grazing a corridor, and ghost
// collision poles with no post under them — and one of those has already
// SHIPPED (the radial-intrusion bug put an invisible wall on Sidewinder).
//
// It sat unwired: nothing in package.json, the test suite or CI ran it, so it
// only fired when someone remembered to type it. By this repo's own rule that
// is not a weaker gate, it is no gate. Every track edit goes through `npm test`,
// so this is where it belongs — it costs well under a second for the whole
// catalogue, both shipped and dev.
//
// The rules live in the script and are IMPORTED, never restated here: a
// hand-synced copy of the pole gate is exactly how the radial-intrusion bug
// slipped its own regression test the first time.

const test = require('node:test');
const assert = require('node:assert');

test('every catalogue track is geometrically clean', async () => {
  const { auditTracks } = await import('../scripts/audit-tracks.mjs');
  const found = auditTracks();
  const report = Object.entries(found)
    .map(([name, rows]) => `${name}:\n  ${rows.join('\n  ')}`)
    .join('\n');
  assert.deepEqual(found, {}, `track geometry audit found issues:\n${report}`);
});
