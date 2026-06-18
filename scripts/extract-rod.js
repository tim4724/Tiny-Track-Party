'use strict';

// Mesh surgery: split the exposed cross-axle ("the rod that connects the wheels")
// out of a car's BODY mesh into its own GLB node named `axle`, so SceneRenderer
// can reparent it off the body (like the wheels) and it stays level with the road
// while the body leans/dives.
//
// The rod is a connected component of the body mesh sitting ON the wheel axle line:
// centred on X, at wheel-centre height, thin in Y and Z, spanning inboard between
// the L/R wheels. We move those triangles into a new mesh that REUSES the body's
// vertex accessors (POSITION/NORMAL/UV) and material — only the index list is
// split — so no vertex data is touched and the rod looks pixel-identical.
//
//   node scripts/extract-rod.js public/assets/toycar/vehicle-speedster.glb
//   node scripts/extract-rod.js public/assets/toycar/vehicle-speedster.glb --dry

const fs = require('fs');
const { parseGLB, readAccessor } = require('./glb');

const file = process.argv[2];
const DRY = process.argv.includes('--dry');
if (!file) { console.error('usage: node scripts/extract-rod.js <file.glb> [--dry]'); process.exit(1); }

const raw = fs.readFileSync(file);
const { json, bin } = parseGLB(raw);
const meshes = json.meshes;

// --- locate body + wheels ---
const wheelNodes = json.nodes.filter((n) => n.mesh != null && (meshes[n.mesh].name || '').startsWith('wheel'));
const bodyNodeIdx = json.nodes.findIndex((n) => n.mesh != null && !(meshes[n.mesh].name || '').startsWith('wheel'));
const bodyNode = json.nodes[bodyNodeIdx];
const mesh = meshes[bodyNode.mesh];
if (mesh.primitives.length !== 1) throw new Error(`expected 1 body primitive, got ${mesh.primitives.length}`);
const prim = mesh.primitives[0];

// Wheel-centre height (the axle line) — derived from the model, not hardcoded.
const wheelY = wheelNodes.reduce((s, n) => s + ((n.translation && n.translation[1]) || 0), 0) / (wheelNodes.length || 1);
const wheelX = wheelNodes.reduce((s, n) => s + Math.abs((n.translation && n.translation[0]) || 0), 0) / (wheelNodes.length || 1);

// --- read geometry ---
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

// Per-component bbox over triangles.
const comps = new Map();
for (let t = 0; t < idx.length; t += 3) {
  const root = find(idx[t]);
  let c = comps.get(root);
  if (!c) comps.set(root, c = { tris: [], min: [1e9,1e9,1e9], max: [-1e9,-1e9,-1e9] });
  c.tris.push(t);
  for (let j = 0; j < 3; j++) for (let d = 0; d < 3; d++) {
    const val = pos[idx[t+j]*3+d];
    if (val < c.min[d]) c.min[d] = val;
    if (val > c.max[d]) c.max[d] = val;
  }
}

// --- select rod components by signature ---
// A cross-axle: spans X (inboard of the wheels), centred on X, at wheel-centre
// height, thin in Y and Z (a slender bar, not a body panel or bumper).
const size = (c) => [0,1,2].map((d) => c.max[d] - c.min[d]);
const ctr = (c) => [0,1,2].map((d) => (c.max[d] + c.min[d]) / 2);
const isRod = (c) => {
  const sz = size(c), ct = ctr(c);
  return sz[0] > 0.2 && sz[0] < 2 * wheelX        // spans the track, ends inboard of the wheels
      && sz[1] < 0.1 && sz[2] < 0.1               // slender cross-section
      && Math.abs(ct[0]) < 0.05                   // centred between L/R
      && Math.abs(ct[1] - wheelY) < 0.04;         // sitting on the axle line
};
const rodComps = [...comps.values()].filter(isRod);
if (!rodComps.length) throw new Error('no rod component found — signature may need tuning');

const rodTriStarts = new Set(rodComps.flatMap((c) => c.tris));
const rodIdx = [], bodyIdx = [];
for (let t = 0; t < idx.length; t += 3) {
  const dst = rodTriStarts.has(t) ? rodIdx : bodyIdx;
  dst.push(idx[t], idx[t+1], idx[t+2]);
}

const f = (n) => n.toFixed(3).padStart(7);
console.log(`${file}`);
console.log(`  wheel axle line: y=${wheelY.toFixed(3)}  |x|=${wheelX.toFixed(3)}`);
console.log(`  rod components: ${rodComps.length}  (tris -> axle: ${rodIdx.length/3}, body keeps: ${bodyIdx.length/3})`);
for (const c of rodComps) {
  const sz = size(c), ct = ctr(c);
  console.log(`    size=(${f(sz[0])},${f(sz[1])},${f(sz[2])}) ctr=(${f(ct[0])},${f(ct[1])},${f(ct[2])})`);
}
if (DRY) { console.log('  (dry run — not writing)'); process.exit(0); }

// --- rebuild the GLB ---
// Trim any BIN chunk padding back to the declared buffer length, then append two
// new index bufferViews (body remainder + rod), 4-byte aligned.
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

const bodyAcc = addIndexBV(bodyIdx);
const rodAcc = addIndexBV(rodIdx);

// Point the body primitive at its trimmed index list (old accessor becomes unused).
prim.indices = bodyAcc;

// New mesh + node for the rod, reusing the body's vertex attributes + material.
const rodMeshIdx = meshes.length;
meshes.push({ name: 'axle', primitives: [{ attributes: { ...prim.attributes }, indices: rodAcc, material: prim.material }] });
const rodNodeIdx = json.nodes.length;
json.nodes.push({ name: 'axle', mesh: rodMeshIdx });
bodyNode.children = [...(bodyNode.children || []), rodNodeIdx];

json.buffers[0].byteLength = buf.length;

// --- serialize GLB: header + JSON chunk (space-padded) + BIN chunk (zero-padded) ---
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
console.log(`  wrote ${file} (${raw.length} -> ${out.length} bytes), node[${rodNodeIdx}] 'axle' added under body`);
