#!/usr/bin/env node
// Lighten the square behind the star on each side of item-box.glb.
//
// Every purple vertex of the kit box samples ONE atlas column, a ramp from
// light (v 0.525) to dark (v 0.725), and the side panels sit on its darker
// part. Moving their UVs up the same ramp lightens them in whatever hue the
// renderer's tint (kBoxTint) gives the body, with no second material: the box
// pool draws one renderable per box per primitive, so a material split would
// cost a draw per visible box per view.
//
// A side panel is the flat square of a side face — the triangles whose three
// vertices all have a horizontal axis-aligned normal and a purple UV. The star
// (a white UV, coplanar with the panel), the bevels (diagonal normals), and the
// top and bottom (already the ramp's ends) keep their UVs. Panel vertices are
// shared with no other triangle, which the script checks.
//
// Usage: node scripts/lighten-item-box-panel.mjs, on the kit's original box (a
// copy out of scripts/fetch-kits.mjs's cache), then re-run
// `node scripts/gen-kit-colors.mjs`. It refuses a box it has already moved.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'public/assets/toycar/item-box.glb');
const PURPLE_U = 0.9;   // splits the purple column (u 0.969) from the white star's
const RAMP_TOP = 0.525; // the ramp's light end
const SHIFT = -0.04;    // up the ramp: lands the panel's lightest vertex on RAMP_TOP

const glb = fs.readFileSync(FILE);
const jsonLen = glb.readUInt32LE(12);
const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
const bin = glb.subarray(20 + jsonLen + 8); // a view: writes land in `glb`
const prim = json.meshes[0].primitives[0];

const view = (accIndex) => {
  const a = json.accessors[accIndex];
  const bv = json.bufferViews[a.bufferView];
  return { a, off: (bv.byteOffset || 0) + (a.byteOffset || 0), stride: bv.byteStride };
};
const floats = (accIndex, n) => {
  const { a, off, stride } = view(accIndex);
  const step = stride || n * 4;
  return Array.from({ length: a.count }, (_, k) =>
    Array.from({ length: n }, (_, c) => bin.readFloatLE(off + k * step + c * 4)));
};
const nrm = floats(prim.attributes.NORMAL, 3);
const uv = floats(prim.attributes.TEXCOORD_0, 2);
const ia = view(prim.indices);
if (ia.a.componentType !== 5123) throw new Error('expected u16 indices');
const idx = Array.from({ length: ia.a.count }, (_, k) => bin.readUInt16LE(ia.off + k * 2));

const side = (i) => (Math.abs(nrm[i][0]) > 0.99 || Math.abs(nrm[i][2]) > 0.99) && uv[i][0] > PURPLE_U;
const panel = new Set(), other = new Set();
for (let t = 0; t < idx.length; t += 3) {
  const tri = idx.slice(t, t + 3);
  for (const v of tri) (tri.every(side) ? panel : other).add(v);
}
if (!panel.size) throw new Error('no side-panel vertices found');
if ([...panel].some((v) => other.has(v))) throw new Error('a panel vertex is shared with another triangle');
if (Math.min(...[...panel].map((v) => uv[v][1])) + SHIFT < RAMP_TOP - 1e-4) {
  throw new Error('panel already lightened (or not the kit original)');
}

const uvView = view(prim.attributes.TEXCOORD_0);
const uvStep = uvView.stride || 8;
for (const v of panel) bin.writeFloatLE(uv[v][1] + SHIFT, uvView.off + v * uvStep + 4);
// The accessor's bounds are required for POSITION only, but keep them true.
const vs = uv.map((u, i) => (panel.has(i) ? u[1] + SHIFT : u[1]));
uvView.a.min[1] = Math.min(...vs);
uvView.a.max[1] = Math.max(...vs);

let text = JSON.stringify(json);
text += ' '.repeat((4 - (text.length % 4)) % 4);
const head = Buffer.alloc(20);
head.writeUInt32LE(0x46546c67, 0);
head.writeUInt32LE(2, 4);
head.writeUInt32LE(20 + text.length + (glb.length - 20 - jsonLen), 8);
head.writeUInt32LE(text.length, 12);
head.writeUInt32LE(0x4e4f534a, 16);
fs.writeFileSync(FILE, Buffer.concat([head, Buffer.from(text), glb.subarray(20 + jsonLen)]));
console.log(`item-box.glb: ${panel.size} side-panel vertices moved ${SHIFT} in v`);
