#!/usr/bin/env node
// gen-trainset.mjs — the playroom's toy train set, composed from Kenney kit
// pieces into ONE model the scene can place like any other prop.
//
// WHY COMPOSE RATHER THAN PLACE. A rail loop with a train on it is one object to
// a player and a dozen to a scatter: dropped into the prop channel the pieces
// would land independently, which is a floor strewn with rails, not a train set.
// The arrangement is authored HERE, once, where it can be looked at — and the
// scene then pays for one model with no per-frame cost and no new renderer path.
//
// The ring is short STRAIGHTS around a circle rather than the kit's own bend
// pieces: their connector geometry is not written down anywhere, and a chord of
// 0.5 on this radius is within a percent of the arc, so the joins close visually
// while the layout stays something you can read in this file.
//
//   node scripts/gen-trainset.mjs
//
// Reads the kit cache (`npm run fetch:kits` — the kits are not in the tree) and
// writes public/assets/toycar/trainset.glb, which IS checked in. Its provenance
// is SOURCES.json, like every other model beside it.
//
// The output references Textures/holiday-colormap.png, which the game already
// ships for the snow trees: every piece here is Holiday Kit, so one palette
// covers the whole set (see scripts/fetch-kits.mjs on why that URI, not the
// toy-car one).

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KIT = path.join(ROOT, '.cache/kenney-kits/holiday/models');
const OUT = path.join(ROOT, 'public/assets/toycar/trainset.glb');
const TEXTURE = 'Textures/holiday-colormap.png';

// The set. RADIUS is the rail centreline; a straight is 0.5 long and 0.3 wide,
// and the train pieces are ~0.35-0.7 long, so this is a toy about 3.5 units
// across — one and a half car lengths, which is the size a playroom landmark
// wants to be beside a car.
const RADIUS = 1.6;
const RAIL = 'trainset-rail-detailed-straight';
const RAIL_LEN = 0.5;
const RAIL_TOP = 0.036;   // the rail's own thickness: the train stands on it
// Locomotive first, then what it pulls, each measured along its own +x.
const TRAIN = [
  { file: 'train-locomotive', len: 0.67 },
  { file: 'train-tender', len: 0.346 },
  { file: 'train-wagon-short', len: 0.37 },
];
const COUPLING = 0.06;
// What the renderer turns to drive the train round the rails. A prop model may
// name ONE node this, and nothing else in the game does.
const SPIN_NODE = 'spin';

const GLB_MAGIC = 0x46546c67, JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942;

function readGlb(name) {
  const buf = readFileSync(path.join(KIT, `${name}.glb`));
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error(`${name}: not a GLB`);
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === JSON_CHUNK) json = JSON.parse(data.toString('utf8'));
    else if (type === BIN_CHUNK) bin = data;
    off += 8 + len;
  }
  if (!json || !bin) throw new Error(`${name}: expected a JSON and a BIN chunk`);
  return { json, bin };
}

// One output glTF, built by appending each source whole and remapping its
// indices. Every piece is the same kit with the same single material, so the
// merge keeps ONE material and points every primitive at it — which is also
// what lets the renderer draw the set in one go.
const out = {
  asset: { version: '2.0', generator: 'ttp gen-trainset.mjs' },
  scene: 0,
  scenes: [{ nodes: [] }],
  nodes: [],
  meshes: [],
  accessors: [],
  bufferViews: [],
  buffers: [],
  materials: [{
    name: 'colormap',
    pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 },
    doubleSided: true,
  }],
  textures: [{ source: 0, sampler: 0 }],
  images: [{ uri: TEXTURE, name: 'colormap' }],
  samplers: [{}],
};
const binParts = [];
let binLen = 0;

// Append a source's meshes and buffers ONCE, and hand back where they landed.
// Twenty rails are twenty nodes over one copy of the rail's geometry — appending
// per placement instead cost 280 kB for a 40 kB model.
function load(src) {
  const base = {
    node: out.nodes.length,
    mesh: out.meshes.length,
    accessor: out.accessors.length,
    view: out.bufferViews.length,
    bin: binLen,
  };
  for (const bv of src.json.bufferViews || []) {
    out.bufferViews.push({ ...bv, buffer: 0, byteOffset: (bv.byteOffset || 0) + base.bin });
  }
  for (const acc of src.json.accessors || []) {
    out.accessors.push(acc.bufferView == null
      ? { ...acc }
      : { ...acc, bufferView: acc.bufferView + base.view });
  }
  for (const mesh of src.json.meshes || []) {
    out.meshes.push({
      ...mesh,
      primitives: mesh.primitives.map((p) => ({
        ...p,
        material: 0,
        indices: p.indices == null ? undefined : p.indices + base.accessor,
        attributes: Object.fromEntries(
          Object.entries(p.attributes).map(([k, v]) => [k, v + base.accessor])),
      })),
    });
  }
  // The source's nodes keep their own transforms; only their indices move.
  const srcNodes = src.json.nodes || [];
  for (const n of srcNodes) {
    const copy = { ...n };
    if (n.children) copy.children = n.children.map((c) => c + base.node);
    if (n.mesh != null) copy.mesh = n.mesh + base.mesh;
    out.nodes.push(copy);
  }
  binParts.push(src.bin);
  binLen += src.bin.length;
  if (binLen % 4) { const pad = 4 - (binLen % 4); binParts.push(Buffer.alloc(pad)); binLen += pad; }
  const roots = (src.json.scenes || [{ nodes: [] }])[src.json.scene || 0].nodes || [];
  return roots.map((r) => r + base.node);
}

// One placement of an already-loaded source: a node carrying the transform, with
// the source's own roots as its children. glTF allows a node to be the child of
// only ONE parent, so a repeated piece gets a fresh copy of its root nodes —
// cheap, since a root is a transform and a mesh index, not geometry.
//
// Returns the placement node, so a caller can put it under a pivot instead of
// straight on the scene (the train does — see SPIN_NODE).
function place(roots, { x, z, yaw, y = 0, scene = true }) {
  const half = yaw / 2;
  const kids = roots.map((r) => {
    out.nodes.push({ ...out.nodes[r] });
    return out.nodes.length - 1;
  });
  out.nodes.push({
    translation: [x, y, z],
    rotation: [0, Math.sin(half), 0, Math.cos(half)],  // yaw about +y
    children: kids,
  });
  const node = out.nodes.length - 1;
  if (scene) out.scenes[0].nodes.push(node);
  return node;
}

const rail = load(readGlb(RAIL));
// One straight per chord of RAIL_LEN, rotated to lie along its own tangent. The
// kit's straights run along their +x, which is what the tangent is here.
const count = Math.max(4, Math.round((2 * Math.PI * RADIUS) / RAIL_LEN));
for (let i = 0; i < count; i++) {
  const a = (i / count) * 2 * Math.PI;
  place(rail, { x: Math.cos(a) * RADIUS, z: Math.sin(a) * RADIUS, yaw: -a });
}

// The train, nose to tail along the same circle, starting a quarter turn round
// so it reads as travelling rather than parked at the seam.
//
// Under a PIVOT at the ring's centre, named so the renderer can find it: turning
// that one node walks the whole train round the rails, which is the only moving
// part of the set and costs one transform a frame. The name is the contract —
// see TtpRenderer::buildProps.
const carriages = [];
let arc = Math.PI * 0.5;
for (const car of TRAIN) {
  arc += (car.len / 2 + COUPLING) / RADIUS;
  carriages.push(place(load(readGlb(car.file)), {
    x: Math.cos(arc) * RADIUS, z: Math.sin(arc) * RADIUS, yaw: -arc, y: RAIL_TOP,
    scene: false,
  }));
  arc += (car.len / 2) / RADIUS;
}
out.nodes.push({ name: SPIN_NODE, children: carriages });
out.scenes[0].nodes.push(out.nodes.length - 1);

const bin = Buffer.concat(binParts, binLen);
out.buffers = [{ byteLength: bin.length }];
let text = JSON.stringify(out);
while (text.length % 4) text += ' ';           // chunks are 4-byte aligned
const jsonBytes = Buffer.from(text, 'utf8');
const glb = Buffer.alloc(12 + 8 + jsonBytes.length + 8 + bin.length);
glb.writeUInt32LE(GLB_MAGIC, 0);
glb.writeUInt32LE(2, 4);
glb.writeUInt32LE(glb.length, 8);
glb.writeUInt32LE(jsonBytes.length, 12);
glb.writeUInt32LE(JSON_CHUNK, 16);
jsonBytes.copy(glb, 20);
glb.writeUInt32LE(bin.length, 20 + jsonBytes.length);
glb.writeUInt32LE(BIN_CHUNK, 24 + jsonBytes.length);
bin.copy(glb, 28 + jsonBytes.length);
writeFileSync(OUT, glb);

const tris = out.meshes.reduce((n, m) => n + m.primitives.reduce(
  (k, p) => k + (p.indices == null ? 0 : out.accessors[p.indices].count / 3), 0), 0);
console.log(`${path.relative(ROOT, OUT)}: ${count} rails + ${TRAIN.length} carriages, `
  + `${Math.round(tris)} tris, ${(glb.length / 1024).toFixed(1)} kB`);
