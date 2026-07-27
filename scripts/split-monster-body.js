'use strict';

// Mesh surgery: split the monster truck's single `body` mesh into three GLB nodes
// so the monster-truck VARIANT can keep just the bare frame and graft a car body
// where the cab was (see the monster rig in native/renderer/src/TtpRenderer.cpp):
//
//   cab            — the painted box on top (topmost component)
//   chassis-trim   — the four round shock PODS above the wheels + the rear SPOILER
//                    bar (the bits the user asked to drop from the frame)
//   chassis        — the frame to keep: drivetrain block, front struts, axle rods
//
// Like extract-rod.js the split is INDEX-ONLY: all three primitives reuse the body's
// vertex accessors + material, so each part stays pixel-identical. The full monster
// truck (all three nodes present) still renders exactly as authored; the rig drops
// `cab` + `chassis-trim` and keeps `chassis`.
//
// Component identity (from the kit mesh, body-local coords):
//   cab    = topmost component
//   pods   = off-centre (|x|>0.1), above the axle line (y>0.25) — the 4 wheel domes
//   spoiler= topmost of what remains (a thin centred bar high at the rear)
//   frame  = everything else
//
//   node scripts/split-monster-body.js public/assets/toycar/vehicle-monster-truck.glb [--dry]

const fs = require('fs');
const { parseGLB, readAccessor } = require('./glb');

const file = process.argv[2];
const DRY = process.argv.includes('--dry');
if (!file) { console.error('usage: node scripts/split-monster-body.js <file.glb> [--dry]'); process.exit(1); }

const raw = fs.readFileSync(file);
const { json, bin } = parseGLB(raw);
const meshes = json.meshes;

if (json.nodes.some((n) => n.name === 'cab' || n.name === 'chassis-trim')) {
  console.log(`${file}: already split — nothing to do.`);
  process.exit(0);
}

const bodyNodeIdx = json.nodes.findIndex((n) => n.mesh != null && (meshes[n.mesh].name || '') === 'body');
if (bodyNodeIdx < 0) throw new Error("no node with mesh named 'body'");
const bodyNode = json.nodes[bodyNodeIdx];
const mesh = meshes[bodyNode.mesh];
if (mesh.primitives.length !== 1) throw new Error(`expected 1 body primitive, got ${mesh.primitives.length}`);
const prim = mesh.primitives[0];

const pos = readAccessor(json, bin, prim.attributes.POSITION);
const idxAcc = json.accessors[prim.indices];
if (idxAcc.componentType !== 5123) throw new Error(`expected Uint16 indices, got componentType ${idxAcc.componentType}`);
const idx = readAccessor(json, bin, prim.indices);
const nVerts = pos.length / 3;

// --- connected components (weld by quantized position, union-find over tri edges) ---
const q = (v) => Math.round(v * 1e4);
const weld = new Map(), rep = new Int32Array(nVerts);
for (let v = 0; v < nVerts; v++) {
  const k = `${q(pos[v*3])},${q(pos[v*3+1])},${q(pos[v*3+2])}`;
  if (!weld.has(k)) weld.set(k, v);
  rep[v] = weld.get(k);
}
const parent = new Int32Array(nVerts);
for (let v = 0; v < nVerts; v++) parent[v] = rep[v];
const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
const union = (a, b) => { a = find(rep[a]); b = find(rep[b]); if (a !== b) parent[a] = b; };
for (let t = 0; t < idx.length; t += 3) { union(idx[t], idx[t+1]); union(idx[t+1], idx[t+2]); }

const comps = new Map();
for (let t = 0; t < idx.length; t += 3) {
  const root = find(idx[t]);
  let c = comps.get(root);
  if (!c) comps.set(root, c = { root, tris: [], min: [1e9,1e9,1e9], max: [-1e9,-1e9,-1e9] });
  c.tris.push(t);
  for (let j = 0; j < 3; j++) for (let d = 0; d < 3; d++) {
    const val = pos[idx[t+j]*3+d];
    if (val < c.min[d]) c.min[d] = val;
    if (val > c.max[d]) c.max[d] = val;
  }
}
const ctr = (c) => [0,1,2].map((d) => (c.max[d] + c.min[d]) / 2);
const topY = (c) => c.max[1];

// --- classify components ---
let list = [...comps.values()];
const cab = list.reduce((b, c) => (topY(c) > topY(b) ? c : b), list[0]);          // topmost = cab
const rest = list.filter((c) => c !== cab);
const pods = rest.filter((c) => Math.abs(ctr(c)[0]) > 0.1 && ctr(c)[1] > 0.25);    // off-centre domes above the axle line
const afterPods = rest.filter((c) => !pods.includes(c));
const spoiler = afterPods.reduce((b, c) => (topY(c) > topY(b) ? c : b), afterPods[0]); // highest remaining = rear bar
const trim = [...pods, spoiler];

if (pods.length !== 4) throw new Error(`expected 4 wheel pods, found ${pods.length} — selector needs review`);

const triSet = (cs) => new Set(cs.flatMap((c) => c.tris));
const cabSet = triSet([cab]), trimSet = triSet(trim);
const cabIdx = [], trimIdx = [], frameIdx = [];
for (let t = 0; t < idx.length; t += 3) {
  const dst = cabSet.has(t) ? cabIdx : (trimSet.has(t) ? trimIdx : frameIdx);
  dst.push(idx[t], idx[t+1], idx[t+2]);
}

const f = (n) => n.toFixed(3).padStart(7);
console.log(`${file}`);
console.log(`  components: ${comps.size}`);
console.log(`  cab:          ${String(cabIdx.length/3).padStart(3)} tris  y=[${f(cab.min[1])},${f(cab.max[1])}]`);
console.log(`  chassis-trim: ${String(trimIdx.length/3).padStart(3)} tris  (4 pods + spoiler)`);
for (const c of trim) console.log(`      ctr=(${f(ctr(c)[0])},${f(ctr(c)[1])},${f(ctr(c)[2])})  tris=${c.tris.length}`);
console.log(`  chassis:      ${String(frameIdx.length/3).padStart(3)} tris  (frame kept)`);
if (DRY) { console.log('  (dry run — not writing)'); process.exit(0); }

// --- rebuild the GLB (same approach as extract-rod.js) ---
if (json.buffers.length !== 1) throw new Error('expected a single buffer');
let buf = Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength).subarray(0, json.buffers[0].byteLength);
const u16 = (arr) => { const b = Buffer.alloc(arr.length * 2); for (let i = 0; i < arr.length; i++) b.writeUInt16LE(arr[i], i*2); return b; };
const addIndexBV = (arr) => {
  let off = buf.length;
  if (off % 4) { const pad = Buffer.alloc(4 - (off % 4)); buf = Buffer.concat([buf, pad]); off = buf.length; }
  const data = u16(arr);
  buf = Buffer.concat([buf, data]);
  const bvIdx = json.bufferViews.length;
  json.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: data.length, target: 34963 });
  const accIdx = json.accessors.length;
  json.accessors.push({ bufferView: bvIdx, componentType: 5123, count: arr.length, type: 'SCALAR' });
  return accIdx;
};

const frameAcc = addIndexBV(frameIdx);
const cabAcc = addIndexBV(cabIdx);
const trimAcc = addIndexBV(trimIdx);

// The body node/mesh becomes the kept FRAME ('chassis'); add `cab` + `chassis-trim`
// as ROOT scene siblings carrying the body node's transform. (GLTFLoader silently
// drops a child node attached to a mesh-bearing root, but builds root nodes — the
// wheels prove it — so siblings are the robust placement.)
prim.indices = frameAcc;
mesh.name = 'chassis';
bodyNode.name = 'chassis';

const sceneNodes = json.scenes[json.scene || 0].nodes;
const addPart = (name, indicesAcc) => {
  const meshIdx = meshes.length;
  meshes.push({ name, primitives: [{ attributes: { ...prim.attributes }, indices: indicesAcc, material: prim.material }] });
  const node = { name, mesh: meshIdx };
  if (bodyNode.matrix) node.matrix = bodyNode.matrix.slice();
  if (bodyNode.translation) node.translation = bodyNode.translation.slice();
  if (bodyNode.rotation) node.rotation = bodyNode.rotation.slice();
  if (bodyNode.scale) node.scale = bodyNode.scale.slice();
  const nodeIdx = json.nodes.length;
  json.nodes.push(node);
  sceneNodes.push(nodeIdx);
  return nodeIdx;
};
const cabNodeIdx = addPart('cab', cabAcc);
const trimNodeIdx = addPart('chassis-trim', trimAcc);

json.buffers[0].byteLength = buf.length;

// --- serialize GLB ---
const jsonRaw = Buffer.from(JSON.stringify(json), 'utf8');
const jsonPad = jsonRaw.length % 4 ? 4 - (jsonRaw.length % 4) : 0;
const jsonChunk = Buffer.concat([jsonRaw, Buffer.alloc(jsonPad, 0x20)]);
const binPad = buf.length % 4 ? 4 - (buf.length % 4) : 0;
const binChunk = Buffer.concat([buf, Buffer.alloc(binPad, 0x00)]);

const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
const out = Buffer.alloc(total);
let o = 0;
out.writeUInt32LE(0x46546c67, o); o += 4;   // 'glTF'
out.writeUInt32LE(2, o); o += 4;            // version
out.writeUInt32LE(total, o); o += 4;        // total length
out.writeUInt32LE(jsonChunk.length, o); o += 4;
out.writeUInt32LE(0x4e4f534a, o); o += 4;   // 'JSON'
jsonChunk.copy(out, o); o += jsonChunk.length;
out.writeUInt32LE(binChunk.length, o); o += 4;
out.writeUInt32LE(0x004e4942, o); o += 4;   // 'BIN\0'
binChunk.copy(out, o); o += binChunk.length;

fs.writeFileSync(file, out);
console.log(`  wrote ${file} (${raw.length} -> ${out.length} bytes): body -> 'chassis' + 'cab' node[${cabNodeIdx}] + 'chassis-trim' node[${trimNodeIdx}]`);
