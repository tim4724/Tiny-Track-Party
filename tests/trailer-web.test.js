'use strict';
// The welcome board's trailer (public/assets/trailer/trailer.mp4, made by
// npm run trailer:web). Nothing else watches the file: a recut that came out
// oversized would land in git history and in the image's assets layer that every
// deploy pulls, and one in the wrong codec or without faststart would still be
// served, then stall or refuse to play in the browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'public', 'assets', 'trailer', 'trailer.mp4');
const BUDGET_MB = 14;

test('the trailer is committed, within budget, and is what the welcome board plays', () => {
  assert.ok(fs.existsSync(FILE), 'no web trailer: run npm run trailer:web');
  const mb = fs.statSync(FILE).size / 1e6;
  assert.ok(mb <= BUDGET_MB, `trailer is ${mb.toFixed(1)} MB, over the ${BUDGET_MB} MB budget`);
  const html = fs.readFileSync(path.join(ROOT, 'public', 'display', 'index.html'), 'utf8');
  assert.match(html, /<video id="trailer-video" src="\/assets\/trailer\/trailer\.mp4"/);
});

test('the trailer is H.264 + AAC with its index up front', () => {
  const head = fs.readFileSync(FILE).subarray(0, 1 << 16);
  // faststart: the moov box (the index) comes before mdat (the media), so the
  // player can start before the download ends. The first 64 KB holds it.
  const moov = head.indexOf('moov'), mdat = head.indexOf('mdat');
  assert.ok(moov > 0 && (mdat < 0 || moov < mdat), 'moov must precede mdat (-movflags +faststart)');
  assert.ok(head.includes('avc1'), 'video must be H.264 (avc1)');
  assert.ok(head.includes('mp4a'), 'audio must be AAC (mp4a)');
});
