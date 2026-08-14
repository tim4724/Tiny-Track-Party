'use strict';
// The join-code QR encoder, which is browser-side code with no browser in it:
// `public/shared/qr.js` wraps the vendored library and fixes the two things a
// scanner trips over before it ever trips over a wrong codeword — the error
// correction level and the quiet zone. It used to be a server endpoint, so
// nothing was encoded on the client and nothing tested it; the shipped display
// IS the encoder now.
//
// There is no decoder here, so the assertions are structural. That is the half a
// wrapper bug breaks: a missing quiet zone, a mangled finder pattern, or an EC
// level quietly weakened.

const test = require('node:test');
const assert = require('node:assert/strict');

let buildQRMatrix;
test.before(async () => ({ buildQRMatrix } = await import('../public/shared/qr.js')));

const JOIN_URL = 'https://tinytrack.party/ABCD';

// The 7x7 finder: a filled ring, a one-module light gap, a 3x3 core. Read at
// (top, left) of the matrix INCLUDING the quiet zone, so a quiet zone of the
// wrong width shifts it and this fails.
function isFinderAt(m, top, left) {
  const at = (r, c) => m.modules[(top + r) * m.size + (left + c)];
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const ring = r === 0 || r === 6 || c === 0 || c === 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      if (at(r, c) !== (ring || core ? 1 : 0)) return false;
    }
  }
  return true;
}

test('a join URL encodes at EC level L, with its quiet zone', () => {
  const m = buildQRMatrix(JOIN_URL);
  // Size pins the EC level, which nothing else here can see: this payload fits
  // 25 modules at L and needs 29+ at M/Q, 33 at H. Plus the 1-module quiet zone
  // on every side, which the display's renderQR divides its pixel box by.
  assert.equal(m.size, 25 + 2);
  assert.equal(m.modules.length, m.size * m.size);
  for (let i = 0; i < m.size; i++) {
    for (const [r, c] of [[0, i], [m.size - 1, i], [i, 0], [i, m.size - 1]]) {
      assert.equal(m.modules[r * m.size + c], 0, `quiet zone dark at ${r},${c}`);
    }
  }
});

test('the three finder patterns land inside the quiet zone', () => {
  const m = buildQRMatrix(JOIN_URL);
  assert.ok(isFinderAt(m, 1, 1), 'top-left');
  assert.ok(isFinderAt(m, 1, m.size - 8), 'top-right');
  assert.ok(isFinderAt(m, m.size - 8, 1), 'bottom-left');
});

test('the payload is actually encoded, not a fixed pattern', () => {
  const a = buildQRMatrix(JOIN_URL);
  const b = buildQRMatrix(JOIN_URL + '?claim=2');   // the rejoin QR's shape
  assert.notDeepEqual(a.modules, b.modules);
});
