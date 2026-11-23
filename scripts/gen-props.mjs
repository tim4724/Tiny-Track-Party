#!/usr/bin/env node
// gen-props.mjs — generate the trackside prop GLBs (prop-*.glb) into
// public/assets/toycar/, in the toy-car kit's own format: axis-aligned box
// assemblies, flat faces with chamfered edges, every face UV'd to one flat cell of the kit's
// shared Textures/colormap.png (referenced by URI, exactly like tree.glb).
//
// The props are PROCEDURAL SOURCE, not sourced art: re-run this script after
// editing a builder below and commit the .glb outputs. Palette points are
// pixel coordinates on Kenney's original 512x512 grid (32px flat cells); only
// the UV they become matters, so the shipped atlas's size does not.
//
// Usage: node scripts/gen-props.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeGlb } from './lib/glb-compose.mjs';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/assets/toycar');

// Flat palette cells (pixel centres in Textures/colormap.png).
const PAL = {
  straw: [144, 272],
  strawShade: [176, 336],
  wood: [400, 400],
  woodShade: [432, 464],
  plank: [464, 400],
};

const uv = ([px, py]) => [(px + 0.5) / 512, (py + 0.5) / 512];

// One axis-aligned box, its edges chamfered as the set pieces' blocks are
// (set_prototypes.py chamfer()): one cut a fifth of its thinnest side, never
// past 0.05, with hardened normals, so its faces stay flat and the cut shades
// from one face's light to the next. Each face keeps its four corners (24
// verts, the kit's flat box's own count); the cut is triangles between them.
// One palette cell per box. cy is the box CENTRE.
const CHAMFER = 0.05;
function box(mesh, cx, cy, cz, sx, sy, sz, pal) {
  const [u, v] = uv(pal);
  const h = [sx / 2, sy / 2, sz / 2], c = Math.min(CHAMFER, 0.2 * Math.min(sx, sy, sz));
  const at = new Map();                   // a face's corner: its normal's axis and side, its sides on the other two
  const key = (a, sa, s) => `${a}${sa}${s[(a + 1) % 3]}${s[(a + 2) % 3]}`;
  for (let a = 0; a < 3; a++) for (const sa of [-1, 1]) for (const s1 of [-1, 1]) for (const s2 of [-1, 1]) {
    const s = [0, 0, 0], p = [0, 0, 0], n = [0, 0, 0];
    s[(a + 1) % 3] = s1; s[(a + 2) % 3] = s2;
    for (let q = 0; q < 3; q++) p[q] = q === a ? sa * h[q] : s[q] * (h[q] - c);
    n[a] = sa;
    at.set(key(a, sa, s), mesh.pos.length / 3);
    mesh.pos.push(cx + p[0], cy + p[1], cz + p[2]);
    mesh.nrm.push(...n);
    mesh.uv.push(u, v);
  }
  const P = (i) => mesh.pos.slice(i * 3, i * 3 + 3);
  const tri = (i, j, k) => {              // wound to face away from the box's centre
    const [A, B, C] = [P(i), P(j), P(k)];
    const e1 = B.map((x, q) => x - A[q]), e2 = C.map((x, q) => x - A[q]);
    const f = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const o = [0, 1, 2].map((q) => (A[q] + B[q] + C[q]) / 3 - [cx, cy, cz][q]);
    mesh.idx.push(...(f[0] * o[0] + f[1] * o[1] + f[2] * o[2] >= 0 ? [i, j, k] : [i, k, j]));
  };
  const quad = (q) => { tri(q[0], q[1], q[2]); tri(q[0], q[2], q[3]); };
  const V = (a, sa, s) => at.get(key(a, sa, s));
  const S = (x, y, z) => [x, y, z];
  for (let a = 0; a < 3; a++) for (const sa of [-1, 1]) {   // the faces
    const b = (a + 1) % 3, d = (a + 2) % 3, s = (sb, sd) => { const r = [0, 0, 0]; r[b] = sb; r[d] = sd; return r; };
    quad([V(a, sa, s(-1, -1)), V(a, sa, s(1, -1)), V(a, sa, s(1, 1)), V(a, sa, s(-1, 1))]);
  }
  for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {   // the cut along each edge, between faces a and b
    const d = 3 - a - b;
    for (const sa of [-1, 1]) for (const sb of [-1, 1]) {
      const s = (sd) => { const r = [0, 0, 0]; r[a] = sa; r[b] = sb; r[d] = sd; return r; };
      quad([V(a, sa, s(-1)), V(a, sa, s(1)), V(b, sb, s(1)), V(b, sb, s(-1))]);
    }
  }
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {   // the cut at each corner
    const s = S(x, y, z);
    tri(V(0, x, s), V(1, y, s), V(2, z, s));
  }
}

function writeGlb(name, mesh) {
  const pos = new Float32Array(mesh.pos);
  const nrm = new Float32Array(mesh.nrm);
  const uvs = new Float32Array(mesh.uv);
  const idx = new Uint16Array(mesh.idx);

  const bufs = [pos, nrm, uvs, idx];
  let off = 0;
  const views = bufs.map((b, i) => {
    const v = { buffer: 0, byteOffset: off, byteLength: b.byteLength,
                target: i === 3 ? 34963 : 34962 };
    off += (b.byteLength + 3) & ~3;
    return v;
  });
  const bin = Buffer.alloc(off);
  bufs.forEach((b, i) => Buffer.from(b.buffer).copy(bin, views[i].byteOffset));

  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], pos[i + a]);
      max[a] = Math.max(max[a], pos[i + a]);
    }
  }

  const json = {
    asset: { generator: 'gen-props.mjs', version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0], name }],
    nodes: [{ mesh: 0, name }],
    images: [{ uri: 'Textures/colormap.png', name: 'colormap' }],
    samplers: [{ magFilter: 9728, minFilter: 9984 }],
    textures: [{ sampler: 0, source: 0, name: 'colormap' }],
    materials: [{
      pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 },
      name: 'colormap',
    }],
    meshes: [{
      name,
      primitives: [{
        attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
        indices: 3,
        material: 0,
      }],
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count: nrm.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: uvs.length / 2, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: idx.length, type: 'SCALAR' },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
  };

  const out = encodeGlb(json, bin);
  fs.writeFileSync(path.join(OUT_DIR, `${name}.glb`), out);
  console.log(`  ${name}.glb  ${out.length} bytes, ${idx.length / 3} tris`);
}

// ---- the props --------------------------------------------------------------
// Sized in world units against the kit: cars ~1.8 long, road 5.0 wide, stamped
// trees ~2.5-3.5 tall. Every prop stands with its base at y=0.

function hayBale() { // strapped straw block
  const m = { pos: [], nrm: [], uv: [], idx: [] };
  box(m, 0, 0.31, 0, 1.0, 0.62, 0.64, PAL.straw);
  // the shaded core peeks out at the ends; a finger thinner than the straw, or
  // its chamfer lies in the straw's at the end edges and flickers
  box(m, 0, 0.31, 0, 1.02, 0.58, 0.6, PAL.strawShade);
  for (const px of [-0.28, 0.28]) box(m, px, 0.31, 0, 0.09, 0.66, 0.68, PAL.wood);
  return m;
}

function crate() { // framed shipping crate
  const m = { pos: [], nrm: [], uv: [], idx: [] };
  box(m, 0, 0.31, 0, 0.6, 0.6, 0.6, PAL.plank);
  const F = 0.08, H = 0.62, e = 0.31; // frame stock, outer size, edge offset
  for (const px of [-e, e]) for (const pz of [-e, e]) box(m, px, e, pz, F, H, F, PAL.wood);
  for (const py of [F / 2, H - F / 2]) {
    for (const pz of [-e, e]) box(m, 0, py, pz, H, F, F, PAL.woodShade);
    for (const px of [-e, e]) box(m, px, py, 0, F, F, H, PAL.woodShade);
  }
  return m;
}

console.log('gen-props.mjs →', OUT_DIR);
writeGlb('prop-hay', hayBale());
writeGlb('prop-crate', crate());
