#!/usr/bin/env node
// gen-set-prototypes.mjs — the per-track landmarks: one GLB per piece,
// built by scripts/blender/set_prototypes.py in headless Blender (procedural
// primitives with Kenney kit pieces imported where one fits), staged under
// public/assets/toycar as set-<name>.glb for a track's `set` list to place
// (public/shared/tracks.js) and for the asset gallery's set row.
//
// WHY A SECOND SET-PIECE GENERATOR beside gen-set-pieces.mjs. That one composes
// whole kit models through glb-compose, which is the right tool when every part
// IS a kit model (the pirate ship). A ski lift, a slinky or a washing line is
// not in any kit, so these are modelled: Blender is the modelling tool, and a
// kit piece is one more thing it can import. Both land in the same place and
// are placed the same way.
//
// WHAT THIS GRAFTS. Blender's exporter writes no images here (export_image_format
// NONE), so a kit material comes out as a bare white factor over the kit's own
// UVs. The Blender half names each such material `tex:<kit>`; this points it at
// the kit's shipped atlas (Textures/<kit>-colormap.png, the same file the kit's
// other shipped models reference), which is what gen-kit-colors.mjs and the
// renderer's merge need (only external atlases are handled). Procedural parts
// are `tex:toy-car` too: the Blender half paints them from that kit's colormap,
// so they wear Kenney's palette (set_prototypes.py, SWATCH).
//
//   node scripts/gen-set-prototypes.mjs [name ...]      (all pieces when none named)
//
// Needs `npm run fetch:kits` (the kit pieces it imports) and `blender` on the
// PATH. Run gen-kit-colors.mjs after, or the new bytes miss the colour table and
// draw live-lit (tests/codegen-freshness.test.js says so). `node
// scripts/set-check.mjs <name>` then says whether a part was left floating
// (tests/set-pieces.test.js holds the shipped set to it), and
// `npm run score:landmarks` how well a racer sees the piece where it stands.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeGlb, readGlb } from './lib/glb-compose.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public/assets/toycar');
const KIT_CACHE = path.join(ROOT, '.cache/kenney-kits');
const SCRIPT = path.join(ROOT, 'scripts/blender/set_prototypes.py');
const BLENDER = process.env.BLENDER || 'blender';
const SOURCES = path.join(OUT_DIR, 'SOURCES.json');
const ME = 'scripts/gen-set-prototypes.mjs';

// kit id (fetch-kits.mjs) -> the atlas its shipped models reference
const ATLAS = { pirate: 'Textures/pirate-colormap.png', holiday: 'Textures/holiday-colormap.png',
  survival: 'Textures/survival-colormap.png', 'mini-skate': 'Textures/mini-skate-colormap.png',
  'mini-forest': 'Textures/mini-forest-colormap.png', 'city-roads': 'Textures/city-roads-colormap.png',
  'toy-car': 'Textures/colormap.png', watercraft: 'Textures/watercraft-colormap.png',
  graveyard: 'Textures/graveyard-colormap.png' };

if (!fs.existsSync(KIT_CACHE)) throw new Error('no kit cache — run `npm run fetch:kits` first');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ttp-set-protos-'));
execFileSync(BLENDER, ['-b', '--python-exit-code', '1', '-P', SCRIPT, '--', KIT_CACHE, tmp, ...process.argv.slice(2)], { stdio: ['ignore', 'inherit', 'inherit'] });

const sources = JSON.parse(fs.readFileSync(SOURCES, 'utf8'));
for (const file of fs.readdirSync(tmp).filter((f) => f.endsWith('.glb')).sort()) {
  const { json, bin } = readGlb(path.join(tmp, file));
  json.asset = { version: '2.0', generator: 'ttp gen-set-prototypes.mjs (Blender)' };
  json.images = []; json.textures = []; json.samplers = [{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }];
  const texOf = new Map();
  for (const m of json.materials || []) {
    const kit = m.name.startsWith('tex:') ? m.name.slice(4) : null;
    if (!kit) continue;
    if (!ATLAS[kit]) throw new Error(`${file}: no shipped atlas for kit "${kit}"`);
    if (!fs.existsSync(path.join(OUT_DIR, ATLAS[kit]))) throw new Error(`${file}: ${ATLAS[kit]} is not shipped`);
    if (!texOf.has(kit)) {
      json.images.push({ uri: ATLAS[kit] });
      json.textures.push({ sampler: 0, source: json.images.length - 1 });
      texOf.set(kit, json.textures.length - 1);
    }
    m.pbrMetallicRoughness = { baseColorFactor: [1, 1, 1, 1], baseColorTexture: { index: texOf.get(kit) }, metallicFactor: 0, roughnessFactor: 1 };
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
