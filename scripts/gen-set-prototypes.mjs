#!/usr/bin/env node
// gen-set-prototypes.mjs — every model of the world: one GLB per piece, built
// by scripts/blender/set_prototypes.py in headless Blender from procedural
// primitives, staged under public/assets/toycar: the per-track landmarks as
// set-<name>.glb for a track's `set` list to place (public/shared/tracks.js)
// and for the asset gallery's set row, and the scatter's trees and props and
// the race's items under their own names (the builder's `own-<file>` pieces).
//
// WHAT THIS GRAFTS. Blender's exporter writes no images here (export_image_format
// NONE), so the builder's one material comes out as a bare white factor over
// its UVs. This points it at the shared colour atlas by URI (Textures/colormap.png,
// scripts/gen-colormap.mjs), which is what gen-kit-colors.mjs and the
// renderer's merge need (only external atlases are handled).
//
//   node scripts/gen-set-prototypes.mjs [name ...]      (all pieces when none named)
//
// Needs `blender` on the PATH. Run gen-kit-colors.mjs after, or the new bytes
// miss the colour table and draw live-lit (tests/codegen-freshness.test.js says
// so). `node scripts/set-check.mjs <name>` then says whether a part was left
// floating (tests/set-pieces.test.js holds the shipped set to it), and
// `npm run score:landmarks` how well a racer sees the piece where it stands.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeGlb, readGlb } from './lib/glb-compose.mjs';
import { SET_GROUND } from '../public/shared/tracks.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public/assets/toycar');
const SCRIPT = path.join(ROOT, 'scripts/blender/set_prototypes.py');
const BLENDER = process.env.BLENDER || 'blender';
const SOURCES = path.join(OUT_DIR, 'SOURCES.json');
const ME = 'scripts/gen-set-prototypes.mjs';

const ATLAS = 'Textures/colormap.png';   // what the builder's `tex:colormap` material wears

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ttp-set-protos-'));
// A piece modelled on terrain (SET_GROUND) is built against the very numbers
// the renderer lays as the track's ground, so the two cannot drift.
execFileSync(BLENDER, ['-b', '--python-exit-code', '1', '-P', SCRIPT, '--', tmp, ...process.argv.slice(2)],
  { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, TTP_SET_GROUND: JSON.stringify(SET_GROUND) } });

const sources = JSON.parse(fs.readFileSync(SOURCES, 'utf8'));
for (const file of fs.readdirSync(tmp).filter((f) => f.endsWith('.glb')).sort()) {
  const { json, bin } = readGlb(path.join(tmp, file));
  json.asset = { version: '2.0', generator: 'ttp gen-set-prototypes.mjs (Blender)' };
  json.images = []; json.textures = []; json.samplers = [{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }];
  for (const m of json.materials || []) {
    if (m.name !== 'tex:colormap') continue;
    if (!json.images.length) { json.images.push({ uri: ATLAS }); json.textures.push({ sampler: 0, source: 0 }); }
    m.pbrMetallicRoughness = { baseColorFactor: [1, 1, 1, 1], baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 };
    m.name = 'colormap';
  }
  if (!json.images.length) { delete json.images; delete json.textures; delete json.samplers; }
  const out = path.join(OUT_DIR, file);
  const bytes = encodeGlb(json, bin);
  fs.writeFileSync(out, bytes);
  sources.models[file] = { generated: ME };
  let tris = 0;
  for (const m of json.meshes) for (const p of m.primitives) tris += json.accessors[p.indices].count / 3;
  console.log(`${path.relative(ROOT, out)}: ${tris} tris, ${(bytes.length / 1024).toFixed(1)} kB`);
}
// SOURCES.json's own layout: the readme as a block, then one line per model.
const entries = Object.entries(sources.models).sort(([a], [b]) => a.localeCompare(b));
const line = ([file, v]) => `    ${JSON.stringify(file)}: { ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${JSON.stringify(x)}`).join(', ')} }`;
fs.writeFileSync(SOURCES, '{\n  "_readme": ' + JSON.stringify(sources._readme, null, 2).replace(/\n/g, '\n  ')
  + ',\n  "models": {\n' + entries.map(line).join(',\n') + '\n  }\n}\n');
fs.rmSync(tmp, { recursive: true, force: true });
