// The reconnect diff MIXES ids and indices in one answer, and the shell that
// consumes it must resolve — not forward.
//
// `ttp_ui_reconnect_diff_json` answers `{"remove":[id, ...], "add":[index, ...]}`
// — `remove` names the card that is showing and should not be, `add` is a
// POSITION into the seatIds array you passed in. The two arrays in one object
// need opposite handling, and getting it wrong is silent: an id treated as a
// position indexes thin air, no card attaches, and the dropped racer's cell
// shows an empty frame with nothing to scan. The tvOS shell shipped exactly
// that.
//
// (`ttp_ui_connected_players_json`, the other index-shaped export this file
// once pinned, is gone: the executor walks read the connected players off the
// room handle in C++ and no shell resolves a roster any more.)

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

let modPromise = null;
function abi() {
  return (modPromise = modPromise || (async () => {
    const M = await (await import(pathToFileURL(
      path.join(ROOT, 'public/display/engine/native/ttp_runtime.mjs')).href)).default();
    const c = (n, r, a) => M.cwrap(n, r, a);
    return {
      reconnectDiff: c('ttp_ui_reconnect_diff_json', 'string', ['string', 'string'])
    };
  })());
}

test('the reconnect diff MIXES ids and indices in one answer', async () => {
  // The trap. `remove` is ids, `add` is positions into seatIds — so the two
  // arrays in one object need opposite handling.
  const a = await abi();
  const shown = JSON.stringify([4, 5]);
  const seats = JSON.stringify([5, 6]);
  const out = JSON.parse(a.reconnectDiff(shown, seats));

  assert.deepEqual(out.remove, [4], '`remove` carries the ID that is showing and should not be');
  assert.deepEqual(out.add, [1], '`add` carries the POSITION in seatIds — seat 6 is at index 1');
  // Stated as an assertion rather than a comment so it fails if the shapes ever
  // converge and this test stops being about anything.
  assert.notDeepEqual(out.add, [6], 'if `add` were ids this whole hazard would not exist');
});

// Only a source check can see the consumption half: from inside the ABI a
// forwarded index array is a perfectly well-formed list of numbers.
test('the tvOS shell resolves `add` as positions into its seats', () => {
  let src;
  try {
    src = readFileSync(path.join(ROOT,
      'shells/tvos/TinyTrackParty/App/GameCoordinator+Lobby.swift'), 'utf8');
  } catch {
    return; // a tree without the shell has nothing to check
  }
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\/\/\/|\*|\/\*)/.test(l)).join('\n');
  const i = code.indexOf('func applyReconnectCards');
  assert.ok(i > 0, 'applyReconnectCards has moved');
  const body = code.slice(i, code.indexOf('\n    }', i));
  assert.match(body, /seats\[i\]/,
    'the `add` positions must index the seats array — resolving them as ids '
    + 'matches no seat and no reconnect QR ever attaches');
});
