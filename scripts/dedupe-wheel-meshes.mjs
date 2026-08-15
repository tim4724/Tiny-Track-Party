#!/usr/bin/env node
// Fold a vehicle GLB's wheel meshes down to ONE PER SIDE. APPLIED to the
// checked-in assets; idempotent, so re-running after a kit re-fetch re-applies it.
//
// WHY. The kit exports every wheel as its own mesh — four vertex buffers holding
// two distinct discs. Filament merges renderables into one instanced draw when
// they share geometry AND material, and these share the material but not the
// buffers, so a car costs one draw per wheel per split-screen cell. Measured on
// the web display at four cells: 196 draws a frame, 139 of them cars.
//
// It is worth more than the draw count suggests. Each distinct geometry is its
// own vertex array, and under emscripten's GL a `bindVertexArray` carries a
// synchronous `getParameter` (see the FULL_ES3 trap in the display's docs), so
// what goes away is those binds as well as the submissions.
//
// ONE PER SIDE, NOT ONE. The wheels are MIRRORED: the pale hubcap is on the
// outer face only, so a left wheel standing in for a right one turns its blank
// face outwards. Folding all four into one is the obvious move, it measures
// better still, and it is wrong — the thumbnails lose their hubcaps and so do
// the cars. Left and right therefore keep a mesh each, and the gate below is
// what makes that a rule rather than a thing someone remembered.
//
// WHAT THE GATE PROVES. Two wheels may share a mesh only when one is the other
// turned about its own axle: same vertex and index counts, same material, and an
// identical multiset of (distance along the axle, distance from it, uv, normal
// resolved the same way) — which is exactly congruence-up-to-a-spin, and drops
// the mirrored pair into a different group by construction. It also refuses to
// merge two wheels sitting on opposite sides of the axle axis, so a model whose
// mirroring did not reach the vertex data cannot slip through.
//
// The spin that survives is cosmetic and already overwritten: the renderer
// rebuilds every wheel's local transform each frame from its rest translation
// and the roll angle, so a baked phase only shows at a standstill, on a
// twelve-sided tyre, on two wheels of the same side of one car.
//
// The orphaned meshes, accessors and buffer views are pruned and the binary
// chunk rebuilt, so the file does not carry dead copies of a wheel.
//
// Usage: node scripts/dedupe-wheel-meshes.mjs [--check]
//        --check reports what would change and exits non-zero if anything would.
import fs from 'node:fs';
import path from 'node:path';

const ASSET_DIR = 'public/assets/toycar';
const CHECK = process.argv.includes('--check');

const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a GLB`);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
  const binLen = buf.readUInt32LE(20 + jsonLen);
  const bin = buf.slice(20 + jsonLen + 8, 20 + jsonLen + 8 + binLen);
  return { json, bin };
}

function writeGlb(file, json, bin) {
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  while (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.from(' ')]);
  let binBuf = bin;
  while (binBuf.length % 4) binBuf = Buffer.concat([binBuf, Buffer.alloc(1)]);
  const head = Buffer.alloc(12);
  head.write('glTF', 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8);
  const jsonHead = Buffer.alloc(8);
  jsonHead.writeUInt32LE(jsonBuf.length, 0);
  jsonHead.write('JSON', 4);
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(binBuf.length, 0);
  binHead.write('BIN\0', 4);
  fs.writeFileSync(file, Buffer.concat([head, jsonHead, jsonBuf, binHead, binBuf]));
}

function readAccessor(bin, json, i) {
  const a = json.accessors[i];
  const view = json.bufferViews[a.bufferView];
  const base = (view.byteOffset || 0) + (a.byteOffset || 0);
  const width = COMPONENT_BYTES[a.componentType];
  const lanes = TYPE_COUNT[a.type];
  // These files hold one tightly-packed view per accessor — a declared
  // byteStride equal to the element is still packed, which is how they ship. An
  // INTERLEAVED one would still be copied correctly by prune (it carries the
  // stride across), but the signature below would compare the wrong bytes and
  // could fold two wheels that are not the same disc. Refuse rather than read
  // past the stride.
  if (view.byteStride != null && view.byteStride !== width * lanes) {
    throw new Error(`accessor ${i} is interleaved (byteStride ${view.byteStride}`
        + ` over a ${width * lanes}-byte element) — the wheel signatures would be garbage`);
  }
  const rows = [];
  for (let r = 0; r < a.count; r++) {
    const row = [];
    for (let c = 0; c < lanes; c++) {
      const at = base + (r * lanes + c) * width;
      row.push(a.componentType === 5126 ? bin.readFloatLE(at)
             : a.componentType === 5125 ? bin.readUInt32LE(at)
             : a.componentType === 5123 ? bin.readUInt16LE(at)
             : bin.readUInt8(at));
    }
    rows.push(row);
  }
  return rows;
}

// The axle: the axis a wheel is thinnest along.
function axleAxis(json, meshIndex) {
  const a = json.accessors[json.meshes[meshIndex].primitives[0].attributes.POSITION];
  const span = [0, 1, 2].map((k) => a.max[k] - a.min[k]);
  return span.indexOf(Math.min(...span));
}

// Congruence UP TO A SPIN about the axle: resolve every vertex into (along the
// axle, distance from it) for both position and normal, keep its uv, and compare
// the sorted multiset. A spin leaves all of that untouched; a MIRROR does not,
// which is what keeps left and right apart.
function spinSignature(bin, json, meshIndex, axis) {
  const prims = json.meshes[meshIndex].primitives;
  if (prims.length !== 1) return null;               // one primitive per wheel here
  const p = prims[0];
  const q = (axis + 1) % 3, r = (axis + 2) % 3;
  const pos = readAccessor(bin, json, p.attributes.POSITION);
  const uv = p.attributes.TEXCOORD_0 == null ? null
      : readAccessor(bin, json, p.attributes.TEXCOORD_0);
  const nrm = p.attributes.NORMAL == null ? null
      : readAccessor(bin, json, p.attributes.NORMAL);
  const rows = pos.map((v, i) => [
    v[axis].toFixed(5), Math.hypot(v[q], v[r]).toFixed(5),
    uv ? uv[i].map((x) => x.toFixed(5)).join(',') : '',
    nrm ? nrm[i][axis].toFixed(4) : '',
    nrm ? Math.hypot(nrm[i][q], nrm[i][r]).toFixed(4) : '',
  ].join('/')).sort();
  const idx = p.indices == null ? [] : readAccessor(bin, json, p.indices);
  return JSON.stringify([p.mode ?? 4, p.material, idx.length, pos.length, rows]);
}

// Keep only what the surviving primitives reference, and rebuild the binary
// around it. These files carry no skins, animations or embedded images, so
// primitives are the only accessor users — asserted rather than assumed.
function prune(json, bin) {
  for (const key of ['skins', 'animations']) {
    if ((json[key] || []).length) throw new Error(`unexpected ${key}: pruning would drop references`);
  }
  for (const img of json.images || []) {
    if (img.bufferView != null) throw new Error('embedded image: pruning would drop its view');
  }
  const usedMesh = new Set((json.nodes || []).map((n) => n.mesh).filter((m) => m != null));
  const meshMap = new Map();
  const meshes = [];
  for (let i = 0; i < json.meshes.length; i++) {
    if (!usedMesh.has(i)) continue;
    meshMap.set(i, meshes.length);
    meshes.push(json.meshes[i]);
  }
  const usedAcc = new Set();
  for (const m of meshes) {
    for (const p of m.primitives) {
      if (p.indices != null) usedAcc.add(p.indices);
      for (const a of Object.values(p.attributes)) usedAcc.add(a);
    }
  }
  const accMap = new Map();
  const accessors = [];
  for (let i = 0; i < json.accessors.length; i++) {
    if (!usedAcc.has(i)) continue;
    accMap.set(i, accessors.length);
    accessors.push(json.accessors[i]);
  }
  // Repack the binary: one view per accessor in these files, so the views are
  // copied out in their new order and the offsets rewritten.
  const views = [];
  const chunks = [];
  let offset = 0;
  const viewMap = new Map();
  for (const a of accessors) {
    const old = json.bufferViews[a.bufferView];
    if (!viewMap.has(a.bufferView)) {
      const start = old.byteOffset || 0;
      const bytes = old.byteLength;
      while (offset % 4) { chunks.push(Buffer.alloc(1)); offset++; }
      chunks.push(bin.slice(start, start + bytes));
      const nv = { buffer: 0, byteOffset: offset, byteLength: bytes };
      if (old.byteStride != null) nv.byteStride = old.byteStride;
      if (old.target != null) nv.target = old.target;
      viewMap.set(a.bufferView, views.length);
      views.push(nv);
      offset += bytes;
    }
    a.bufferView = viewMap.get(a.bufferView);
  }
  for (const m of meshes) {
    for (const p of m.primitives) {
      if (p.indices != null) p.indices = accMap.get(p.indices);
      for (const k of Object.keys(p.attributes)) p.attributes[k] = accMap.get(p.attributes[k]);
    }
  }
  for (const n of json.nodes || []) if (n.mesh != null) n.mesh = meshMap.get(n.mesh);
  json.meshes = meshes;
  json.accessors = accessors;
  json.bufferViews = views;
  const newBin = Buffer.concat(chunks);
  json.buffers = [{ byteLength: newBin.length }];
  return newBin;
}

let changed = 0;
for (const file of fs.readdirSync(ASSET_DIR).filter((f) => f.endsWith('.glb')).sort()) {
  const full = path.join(ASSET_DIR, file);
  const { json, bin } = readGlb(full);
  const wheels = (json.nodes || []).filter((n) => n.mesh != null && /^wheel-/.test(n.name || ''));
  if (wheels.length < 2) continue;
  const meshes = [...new Set(wheels.map((n) => n.mesh))];
  if (meshes.length === 1) continue;                       // already folded
  const axis = axleAxis(json, wheels[0].mesh);
  // Group by "same wheel, possibly spun" AND by which side of the axle the node
  // sits on — the second is a belt to the signature's braces (see the header).
  const groups = new Map();
  let refused = false;
  for (const w of wheels) {
    const sig = spinSignature(bin, json, w.mesh, axis);
    if (sig == null) { refused = true; break; }
    const side = Math.sign((w.translation || [0, 0, 0])[axis]);
    const key = `${side}|${sig}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(w);
  }
  if (refused) { console.error(`${file}: a wheel has more than one primitive — left alone`); continue; }
  const folded = [...groups.values()].every((g) => g.every((w) => w.mesh === g[0].mesh));
  if (folded) continue;                                    // already one mesh per side
  if (groups.size >= meshes.length) {
    console.log(`${file}: no two wheels are the same mesh spun — left alone`);
    continue;
  }
  changed++;
  const shape = [...groups.values()].map((g) => g.map((w) => w.name).join('+')).join(', ');
  if (CHECK) {
    console.log(`${file}: would fold ${meshes.length} wheel meshes into ${groups.size} (${shape})`);
    continue;
  }
  for (const group of groups.values()) {
    const keep = group[0].mesh;
    for (const w of group) w.mesh = keep;
  }
  const before = fs.statSync(full).size;
  writeGlb(full, json, prune(json, bin));
  console.log(`${file}: ${meshes.length} wheel meshes -> ${groups.size}  (${shape})`
      + `  ${before} -> ${fs.statSync(full).size} bytes`);
}
if (!changed) console.log('every vehicle already shares one wheel mesh per side');
if (CHECK && changed) process.exit(1);
