#!/usr/bin/env node
// gen-props.mjs — generate the trackside prop GLBs (prop-*.glb) into
// public/assets/toycar/, in the toy-car kit's own format: axis-aligned box
// assemblies, flat-shaded, every face UV'd to one flat cell of the kit's
// shared Textures/colormap.png (referenced by URI, exactly like tree.glb).
//
// The props are PROCEDURAL SOURCE, not sourced art: re-run this script after
// editing a builder below and commit the .glb outputs. Palette points are
// pixel coordinates into the 512x512 colormap's 32px flat cells.
//
// Usage: node scripts/gen-props.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// One axis-aligned box: 24 verts (per-face normals, the kit's flat look), one
// palette cell per face set. cy is the box CENTRE.
function box(mesh, cx, cy, cz, sx, sy, sz, pal) {
  const [u, v] = uv(pal);
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const faces = [
    [[+1, 0, 0], [[+hx, -hy, -hz], [+hx, +hy, -hz], [+hx, +hy, +hz], [+hx, -hy, +hz]]],
    [[-1, 0, 0], [[-hx, -hy, +hz], [-hx, +hy, +hz], [-hx, +hy, -hz], [-hx, -hy, -hz]]],
    [[0, +1, 0], [[-hx, +hy, -hz], [-hx, +hy, +hz], [+hx, +hy, +hz], [+hx, +hy, -hz]]],
    [[0, -1, 0], [[-hx, -hy, +hz], [-hx, -hy, -hz], [+hx, -hy, -hz], [+hx, -hy, +hz]]],
    [[0, 0, +1], [[-hx, -hy, +hz], [+hx, -hy, +hz], [+hx, +hy, +hz], [-hx, +hy, +hz]]],
    [[0, 0, -1], [[+hx, -hy, -hz], [-hx, -hy, -hz], [-hx, +hy, -hz], [+hx, +hy, -hz]]],
  ];
  for (const [n, corners] of faces) {
    const base = mesh.pos.length / 3;
    for (const [x, y, z] of corners) {
      mesh.pos.push(cx + x, cy + y, cz + z);
      mesh.nrm.push(...n);
      mesh.uv.push(u, v);
    }
    mesh.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
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

  let jsonBuf = Buffer.from(JSON.stringify(json));
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
  const binPad = (4 - (bin.length % 4)) % 4;
  const binBuf = Buffer.concat([bin, Buffer.alloc(binPad)]);

  const total = 12 + 8 + jsonBuf.length + 8 + binBuf.length;
  const head = Buffer.alloc(12 + 8);
  head.writeUInt32LE(0x46546c67, 0); // glTF
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total, 8);
  head.writeUInt32LE(jsonBuf.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16); // JSON
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(binBuf.length, 0);
  binHead.writeUInt32LE(0x004e4942, 4); // BIN
  const out = Buffer.concat([head, jsonBuf, binHead, binBuf]);
  fs.writeFileSync(path.join(OUT_DIR, `${name}.glb`), out);
  console.log(`  ${name}.glb  ${out.length} bytes, ${idx.length / 3} tris`);
}

// ---- the props --------------------------------------------------------------
// Sized in world units against the kit: cars ~1.8 long, road 5.0 wide, stamped
// trees ~2.5-3.5 tall. Every prop stands with its base at y=0.

function hayBale() { // strapped straw block
  const m = { pos: [], nrm: [], uv: [], idx: [] };
  box(m, 0, 0.31, 0, 1.0, 0.62, 0.64, PAL.straw);
  box(m, 0, 0.31, 0, 1.02, 0.6, 0.62, PAL.strawShade); // shaded core peeks at edges
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
