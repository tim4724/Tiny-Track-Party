'use strict';
// Provenance guard for the 3D models: public/assets/toycar/SOURCES.json says
// which script builds each shipped .glb. Every model is generated, so a file
// with no row is one nobody can rebuild, and a row whose script is gone is a
// model orphaned from its source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TOYCAR = path.join(ROOT, 'public/assets/toycar');
const SOURCES = JSON.parse(fs.readFileSync(path.join(TOYCAR, 'SOURCES.json'), 'utf8'));

test('every shipped .glb declares where it came from, and nothing declares a file that is gone', () => {
  const onDisk = fs.readdirSync(TOYCAR).filter((f) => f.endsWith('.glb')).sort();
  assert.deepEqual(Object.keys(SOURCES.models).sort(), onDisk,
    'SOURCES.json must list exactly the .glb files beside it');
});

test('each entry names the script that generates it', () => {
  for (const [file, src] of Object.entries(SOURCES.models)) {
    assert.ok(src.generated, `${file}: no generating script (a downloaded model? build it instead)`);
    assert.ok(fs.existsSync(path.join(ROOT, src.generated)), `${file}: ${src.generated} is gone`);
  }
});

// One palette for every model: the atlas scripts/gen-colormap.mjs writes. A
// second texture is a second look, and both TV shells stage Textures/ whole.
test('every model wears the one colour atlas', () => {
  assert.deepEqual(fs.readdirSync(path.join(TOYCAR, 'Textures')), ['colormap.png']);
  for (const file of Object.keys(SOURCES.models)) {
    const glb = fs.readFileSync(path.join(TOYCAR, file));
    const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
    assert.deepEqual((json.images || []).map((i) => i.uri), ['Textures/colormap.png'], file);
  }
});

// The CONCEPT CARS (public/assets/concepts/) are generated outright by
// scripts/gen-concept-cars.py, which writes the index.json beside them, and
// raced on the web by `?cars=` (Stage.js). The index and the folder must agree.
// They share the palette by URI, so a texture of their own would 404.
test('the concept cars index lists exactly the GLBs beside it, all on the shared palette', () => {
  const dir = path.join(ROOT, 'public/assets/concepts');
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.glb')).map((f) => f.slice(0, -4));
  assert.deepEqual(index.models.map((m) => m.name).sort(), files.sort());
  for (const m of index.models) {
    if (m.base) assert.ok(fs.existsSync(path.join(TOYCAR, `${m.base}.glb`)), `${m.name}: no roster car ${m.base}`);
    const glb = fs.readFileSync(path.join(dir, `${m.name}.glb`));
    const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
    assert.deepEqual(json.images.map((i) => i.uri), ['Textures/colormap.png'], m.name);
  }
});
