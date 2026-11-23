#!/usr/bin/env node
// quantize-glbs.mjs — re-encode kit GLBs in the kit's one attribute layout
// (scripts/lib/glb-compose.mjs, quantizeGlb). The JS bakes write it already;
// this is for a model written by something else (the cars' Blender export).
// Idempotent: a model already quantized comes out byte for byte.
//
//   node scripts/quantize-glbs.mjs [file.glb ...]   (every public/assets/toycar/*.glb when none named)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeGlb, readGlb } from './lib/glb-compose.mjs';

const KIT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/assets/toycar');
const files = process.argv.length > 2 ? process.argv.slice(2)
  : fs.readdirSync(KIT).filter((f) => f.endsWith('.glb')).sort().map((f) => path.join(KIT, f));
let before = 0, after = 0;
for (const file of files) {
  const src = fs.readFileSync(file);
  const { json, bin } = readGlb(file);
  const out = encodeGlb(json, bin);
  before += src.length; after += out.length;
  if (!out.equals(src)) fs.writeFileSync(file, out);
}
console.log(`${files.length} models: ${before} -> ${after} bytes`);
