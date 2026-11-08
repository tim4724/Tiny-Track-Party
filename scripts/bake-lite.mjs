#!/usr/bin/env node
// bake-lite.mjs — the lite tier's build of a model: <model>-lite.glb, the
// shipped <model>.glb collapse-decimated in headless Blender
// (scripts/blender/decimate.py), its materials grafted back by name.
//
// WHY. The full tier (the web, the Apple TV) is uncapped: a model is authored
// as rich as it should look. The Android TV box draws the LITE tier, and a
// model with a -lite build beside it is drawn from that build there
// (ttp/theme.h lite_models; native/renderer/CLAUDE.md, "The detail tier"). So
// this is where the box's cost is cut, model by model, without touching the
// full world. A piece that should not be on the box at all is `lite: false`
// on its set entry instead.
//
// A model with moving parts ("spin", "path_*", "anim_*" nodes) cannot be decimated into
// one mesh: author its lite build where it is built, and list it in
// SOURCES.json with that builder as `generated`.
//
// SOURCES.json records each bake ({ generated, from, ratio }), so a re-run
// with no arguments re-derives every lite build from its current original.
// Run gen-kit-colors.mjs and gen-track-defs-header.mjs after, then rebuild the
// engine (tests/codegen-freshness.test.js holds both headers to the assets).
//
// Needs `blender` on the PATH.
// Usage: node scripts/bake-lite.mjs [model:ratio ...]   e.g. set-ranch:0.35

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { encodeGlb, readGlb } from './lib/glb-compose.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOYCAR = path.join(ROOT, 'public/assets/toycar');
const SOURCES_PATH = path.join(TOYCAR, 'SOURCES.json');
const SELF = 'scripts/bake-lite.mjs';

const vertices = (json) => json.meshes.flatMap((m) => m.primitives)
  .reduce((n, p) => n + json.accessors[p.attributes.POSITION].count, 0);

const sources = JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8'));
const jobs = process.argv.slice(2).map((arg) => {
  const [model, r] = arg.replace(/\.glb$/, '').split(':');
  const ratio = Number(r);
  if (!(ratio > 0 && ratio < 1)) throw new Error(`${arg}: give model:ratio with 0 < ratio < 1`);
  return { model, ratio };
});
if (!jobs.length) {
  for (const [file, src] of Object.entries(sources.models)) {
    if (src.generated === SELF) jobs.push({ model: src.from.replace(/\.glb$/, ''), ratio: src.ratio });
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-'));
for (const { model, ratio } of jobs) {
  const original = path.join(TOYCAR, `${model}.glb`);
  if (!fs.existsSync(original)) throw new Error(`${model}.glb is not in public/assets/toycar`);
  const o = readGlb(original);
  const moving = (o.json.nodes || []).map((n) => n.name || '')
    .filter((n) => n === 'spin' || n.startsWith('path_') || n.startsWith('anim_'));
  if (moving.length) throw new Error(`${model}: moving parts (${moving.join(', ')}) — author its lite build in its builder`);
  const out = path.join(tmp, `${model}-lite.glb`);
  execFileSync('blender', ['-b', '-P', path.join(ROOT, 'scripts/blender/decimate.py'), '--',
    original, out, String(ratio)], { stdio: 'ignore' });
  const d = readGlb(out);
  for (const p of d.json.meshes.flatMap((m) => m.primitives)) {
    const name = d.json.materials[p.material].name;
    p.material = o.json.materials.findIndex((m) => m.name === name);
    if (p.material < 0) throw new Error(`${model}: no material '${name}' in the original`);
  }
  for (const k of ['materials', 'textures', 'images', 'samplers', 'extensionsUsed']) {
    if (o.json[k]) d.json[k] = o.json[k]; else delete d.json[k];
  }
  fs.writeFileSync(path.join(TOYCAR, `${model}-lite.glb`), encodeGlb(d.json, d.bin));
  sources.models[`${model}-lite.glb`] = { generated: SELF, from: `${model}.glb`, ratio };
  console.log(`  ${model}-lite.glb: ${vertices(o.json)} -> ${vertices(d.json)} vertices`);
}
fs.rmSync(tmp, { recursive: true });
// SOURCES.json's own layout (gen-set-prototypes.mjs): the readme as a block,
// then one line per model.
const entries = Object.entries(sources.models).sort(([a], [b]) => a.localeCompare(b));
const line = ([file, v]) => `    ${JSON.stringify(file)}: { ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${JSON.stringify(x)}`).join(', ')} }`;
fs.writeFileSync(SOURCES_PATH, '{\n  "_readme": ' + JSON.stringify(sources._readme, null, 2).replace(/\n/g, '\n  ')
  + ',\n  "models": {\n' + entries.map(line).join(',\n') + '\n  }\n}\n');
