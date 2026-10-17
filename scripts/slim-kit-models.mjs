#!/usr/bin/env node
// slim-kit-models.mjs — re-derive every shipped kit model that SOURCES.json
// marks `decimate: <ratio>` from its kit original, collapse-decimated in
// headless Blender (scripts/blender/decimate.py).
//
// WHY. A decoration is drawn many times a lap in every cell, and the kit
// authors a barrel or a skateboard with as many vertices as a whole car. What
// a toy-scale prop at the verge needs is its silhouette, and a decimation to
// half or a third keeps it. The vertex budget it serves is gated by
// tests/display-abi.test.js; this is how a model gets under it.
//
// Blender's export carries the geometry only: the ORIGINAL file's materials,
// textures, images and samplers are grafted back by material name, so the
// palette URI and the baked colour path (gen-kit-colors.mjs) are unchanged.
// Run gen-kit-colors.mjs after this.
//
// Needs `npm run fetch:kits` (the originals) and `blender` on the PATH.
// Usage: node scripts/slim-kit-models.mjs [model.glb ...]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { encodeGlb, readGlb } from './lib/glb-compose.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOYCAR = path.join(ROOT, 'public/assets/toycar');
const KITS = path.join(ROOT, '.cache/kenney-kits');
const sources = JSON.parse(fs.readFileSync(path.join(TOYCAR, 'SOURCES.json'), 'utf8')).models;

const vertices = (json) => json.meshes.flatMap((m) => m.primitives)
  .reduce((n, p) => n + json.accessors[p.attributes.POSITION].count, 0);

const want = process.argv.slice(2);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slim-'));
for (const [file, src] of Object.entries(sources)) {
  if (!src.decimate || (want.length && !want.includes(file))) continue;
  const original = path.join(KITS, src.kit, 'models', `${src.model}.glb`);
  const out = path.join(tmp, file);
  execFileSync('blender', ['-b', '-P', path.join(ROOT, 'scripts/blender/decimate.py'), '--',
    original, out, String(src.decimate)], { stdio: 'ignore' });
  const o = readGlb(original), d = readGlb(out);
  for (const p of d.json.meshes.flatMap((m) => m.primitives)) {
    const name = d.json.materials[p.material].name;
    p.material = o.json.materials.findIndex((m) => m.name === name);
    if (p.material < 0) throw new Error(`${file}: no material '${name}' in the original`);
  }
  for (const k of ['materials', 'textures', 'images', 'samplers', 'extensionsUsed']) {
    if (o.json[k]) d.json[k] = o.json[k]; else delete d.json[k];
  }
  fs.writeFileSync(path.join(TOYCAR, file), encodeGlb(d.json, d.bin));
  console.log(`  ${file}: ${vertices(o.json)} -> ${vertices(d.json)} vertices`);
}
fs.rmSync(tmp, { recursive: true });
