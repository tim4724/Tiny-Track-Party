'use strict';
// Every kit model is in the kit's one attribute layout (scripts/CLAUDE.md):
// what encodeGlb writes is what is on disk. A bake that writes past
// lib/glb-compose.mjs (the cars' Blender export without quantize-glbs.mjs)
// still renders, so nothing else notices it put float attributes back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const KIT = path.join(__dirname, '..', 'public', 'assets', 'toycar');

test('every kit GLB is already in the layout encodeGlb writes', async () => {
  const { encodeGlb, readGlb } = await import('../scripts/lib/glb-compose.mjs');
  const files = fs.readdirSync(KIT).filter((f) => f.endsWith('.glb'));
  assert.ok(files.length > 0, 'kit models found');
  const off = files.filter((f) => {
    const file = path.join(KIT, f);
    const { json, bin } = readGlb(file);
    return !encodeGlb(json, bin).equals(fs.readFileSync(file));
  });
  assert.deepEqual(off, [], 'run node scripts/quantize-glbs.mjs on these');
});
