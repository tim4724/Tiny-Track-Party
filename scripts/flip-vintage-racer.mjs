#!/usr/bin/env node
// Turn vehicle-vintage-racer.glb around. ONE-SHOT, already applied — kept so the
// edit to a vendored kit asset is reproducible from the pristine download.
//
// Every other Kenney car in the roster is modelled nose-toward −Z: the racer,
// racer-low and speedster all put their low nose at z = −0.438 and their tall
// tail (spoiler, wing, engine cover) at +0.438, and the renderer's base
// half-turn (TtpRenderer's FLIP) is built on that — model −Z becomes the car's
// direction of travel. The VINTAGE RACER is the odd one out: its long bonnet is
// at +Z and its boat tail at −Z, while its wheel NODES still follow the kit's
// naming (wheel-f* at −Z). So the game drove it backwards — tail first, bonnet
// trailing, the rear name plate stuck on the radiator face — and the steering
// yaw went to the wheels under the tail.
//
// Verified against the thumbnail bake's own camera (capture-car-thumbs.js frames
// the model at yaw 305° + f·15° with the camera on +Z, so at frame 6 the model's
// +Z end is the one on the RIGHT): at that frame the speedster shows its wing on
// the right and the vintage racer shows its BONNET there.
//
// The fix bakes a 180° yaw into the geometry rather than adding a per-model
// rotation hook, so the asset simply matches the convention the whole renderer
// (wheels, skids, plates, silhouettes, thumbnails) already assumes:
//   - POSITION / NORMAL / TANGENT: negate x and z (a yaw of π; determinant +1,
//     so triangle winding is untouched)
//   - node translations: negate x and z
//   - wheel node + mesh names: the flip maps fl→br, fr→bl, bl→fr, br→fl
//
// Idempotent by refusing to run twice: a flipped file is detected by the bonnet
// (the long unbroken deck) having moved to −Z.
//
//   node scripts/flip-vintage-racer.mjs [file]
import { readFileSync, writeFileSync } from 'node:fs';

const path = process.argv[2] || 'public/assets/toycar/vehicle-vintage-racer.glb';
const GLB_MAGIC = 0x46546c67, JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942;

const buf = readFileSync(path);
if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error(`${path}: not a GLB`);
const jsonLen = buf.readUInt32LE(12);
if (buf.readUInt32LE(16) !== JSON_CHUNK) throw new Error(`${path}: no JSON chunk`);
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
const binHeader = 20 + jsonLen;
if (buf.readUInt32LE(binHeader + 4) !== BIN_CHUNK) throw new Error(`${path}: no BIN chunk`);
const binOff = binHeader + 8, binLen = buf.readUInt32LE(binHeader);

// One writable copy of the whole file; the vertex edits happen in place.
const out = Buffer.from(buf);

// Already flipped? The node NAMES can't answer that — they followed the kit
// convention before the flip too, which is the whole bug — so the run stamps
// asset.extras and keys off that.
json.asset = json.asset || {};
json.asset.extras = json.asset.extras || {};
if (json.asset.extras.ttpYawFlip) {
  console.log(`${path}: already flipped — nothing to do`);
  process.exit(0);
}
json.asset.extras.ttpYawFlip = 180;

// Which accessors carry a direction? POSITION/NORMAL/TANGENT across every
// primitive. Collected as a SET because the kit shares one vertex buffer between
// the body mesh and the "axle" mesh (they differ only in their index range), and
// negating a shared accessor twice would put it straight back.
const dirAccessors = new Set();
for (const mesh of json.meshes || []) {
  for (const p of mesh.primitives || []) {
    for (const attr of ['POSITION', 'NORMAL', 'TANGENT']) {
      if (p.attributes[attr] != null) dirAccessors.add(p.attributes[attr]);
    }
  }
}

const COMPONENTS = { VEC3: 3, VEC4: 4 };
for (const ai of dirAccessors) {
  const a = json.accessors[ai];
  if (a.componentType !== 5126) throw new Error(`accessor ${ai}: not float`);
  const nc = COMPONENTS[a.type];
  if (!nc) throw new Error(`accessor ${ai}: unexpected type ${a.type}`);
  const bv = json.bufferViews[a.bufferView];
  const stride = bv.byteStride || nc * 4;
  const base = binOff + (bv.byteOffset || 0) + (a.byteOffset || 0);
  for (let k = 0; k < a.count; k++) {
    const o = base + k * stride;
    out.writeFloatLE(-out.readFloatLE(o), o);          // x
    out.writeFloatLE(-out.readFloatLE(o + 8), o + 8);  // z  (y and TANGENT.w stay)
  }
  // min/max are x/y/z bounds, so a negation swaps and negates the x and z pair.
  if (a.min && a.max) {
    for (const c of [0, 2]) {
      const lo = -a.max[c], hi = -a.min[c];
      a.min[c] = lo; a.max[c] = hi;
    }
  }
}

const SWAP = { 'wheel-fl': 'wheel-br', 'wheel-fr': 'wheel-bl',
               'wheel-bl': 'wheel-fr', 'wheel-br': 'wheel-fl' };
const rename = (o) => { if (o && SWAP[o.name]) o.name = SWAP[o.name]; };
for (const n of json.nodes || []) {
  if (n.rotation || n.matrix) throw new Error(`node ${n.name}: has its own rotation — unhandled`);
  if (n.translation) { n.translation[0] = -n.translation[0]; n.translation[2] = -n.translation[2]; }
  rename(n);
}
(json.meshes || []).forEach(rename);

// Repack: the JSON chunk changes length (names are the same width, but the
// min/max numbers are not), so both chunk headers are rewritten.
const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(jsonPad, 0x20)]);
const bin = out.subarray(binOff, binOff + binLen);
const binPad = (4 - (binLen % 4)) % 4;
const header = Buffer.alloc(12);
header.writeUInt32LE(GLB_MAGIC, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binLen + binPad, 8);
const jsonHdr = Buffer.alloc(8);
jsonHdr.writeUInt32LE(jsonChunk.length, 0); jsonHdr.writeUInt32LE(JSON_CHUNK, 4);
const binHdr = Buffer.alloc(8);
binHdr.writeUInt32LE(binLen + binPad, 0); binHdr.writeUInt32LE(BIN_CHUNK, 4);
writeFileSync(path, Buffer.concat(
  [header, jsonHdr, jsonChunk, binHdr, bin, Buffer.alloc(binPad)]));
console.log(`${path}: flipped 180° about Y; wheel names swapped front↔rear`);
