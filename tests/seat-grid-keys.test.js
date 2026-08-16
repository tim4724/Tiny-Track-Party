// The seat grid takes `connected` and answers `off`.
//
// Two ABIs, two vocabularies, one row travelling between them:
//
//   ttp_ui_roster_seats_json  -> [{name, colorIndex, carIndex, CONNECTED, host, ready}]
//   ttp_ui_seat_grid_json     -> [{open} | {name, colorIndex, carIndex, OFF, host, ready}]
//
// The grid DERIVES the dimming — `off` is `!connected` plus the padding rule —
// so it reads `connected` on the way in and writes `off` on the way out. Feed it
// its own OUTPUT shape and the input key is missing: `connected` is absent,
// falsy, and every seat comes back dimmed.
//
// That shipped in the tvOS screenshot harness, which re-encodes its own seats
// rather than piping a roster through. The live lobby was never affected — it
// hands roster_seats straight to seat_grid — so the ONLY casualty was the
// gallery, where every lobby and results photograph showed the whole dock at
// 50% opacity. The surface that exists to verify the look was quietly
// misrepresenting it, which is worse than not having it.
//
// So this pins the asymmetry itself, and that each producer of grid INPUT sends
// the key the grid reads.

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

let gridPromise = null;
function grid() {
  return (gridPromise = gridPromise || (async () => {
    const M = await (await import(pathToFileURL(
      path.join(ROOT, 'public/display/engine/native/ttp_runtime.mjs')).href)).default();
    const c = (n, r, a) => M.cwrap(n, r, a);
    const manifest = JSON.parse(c('ttp_protocol_manifest_json', 'string', [])());
    c('ttp_ui_configure', 'number', ['string'])(JSON.stringify({
      maxPlayers: manifest.MAX_PLAYERS, carCount: manifest.CAR_MODELS.length }));
    return (seats) => JSON.parse(c('ttp_ui_seat_grid_json', 'string', ['string'])(
      JSON.stringify(seats)));
  })());
}

const seat = (extra) => ({
  open: false, name: 'Ann', colorIndex: 0, carIndex: 0, modelIndex: 0,
  host: true, ready: true, ...extra
});

test('a connected seat is not dimmed', async () => {
  const g = await grid();
  assert.equal(g([seat({ connected: true })])[0].off, false);
});

test('a dropped seat IS dimmed, and kept', async () => {
  const g = await grid();
  const out = g([seat({ connected: false })]);
  assert.equal(out[0].off, true);
  assert.equal(out[0].name, 'Ann', 'dimmed, never removed — the seat is still theirs');
});

test('sending `off` instead of `connected` dims EVERY seat', async () => {
  // The failure mode, pinned so it reads as a known trap rather than a mystery.
  // `off` is not an input key: it is ignored, `connected` defaults falsy, and a
  // perfectly healthy roster comes back entirely greyed out.
  const g = await grid();
  const out = g([seat({ off: false }), seat({ off: false, name: 'Bo' })]);
  assert.deepEqual(out.slice(0, 2).map((s) => s.off), [true, true],
    'if this ever stops being true the trap is gone and this test can go');
});

test('every producer of grid input sends `connected`', () => {
  // Only a source check can see this: from inside the ABI, a row with no
  // `connected` is a legitimately disconnected seat.
  const files = [
    'shells/tvos/TinyTrackParty/App/GameState.swift'   // Seat.wire, the harness's encoder
  ];
  for (const file of files) {
    const full = path.join(ROOT, file);
    if (!existsSync(full)) {
      assert.ok(file.startsWith('shells/'), `${file} is missing and is not an optional shell`);
      continue;
    }
    const src = readFileSync(full, 'utf8');
    const i = src.indexOf('var wire');
    assert.ok(i > 0, `${file}: no wire encoder found — has it moved?`);
    const body = src.slice(i, i + 1400);
    const code = body.split('\n').filter((l) => !/^\s*(\/\/|\/\/\/)/.test(l)).join('\n');
    assert.match(code, /"connected"/,
      `${file}: the seat grid reads \`connected\`; sending anything else dims the whole dock`);
    assert.doesNotMatch(code, /"off"\s*:/,
      `${file}: sends \`off\`, which the grid does not read — it ANSWERS that key`);
  }
});
