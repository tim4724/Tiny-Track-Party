// glb-compose.mjs — read a GLB into its JSON and binary chunks, and write one
// back: the bakes that rewrite a built model (gen-set-prototypes, bake-lite)
// share these so the chunk padding is solved once.

import { readFileSync } from 'node:fs';

const GLB_MAGIC = 0x46546c67, JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942;

export function readGlb(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error(`${file}: not a GLB`);
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === JSON_CHUNK) json = JSON.parse(data.toString('utf8'));
    else if (type === BIN_CHUNK) bin = data;
    off += 8 + len;
  }
  if (!json || !bin) throw new Error(`${file}: expected a JSON and a BIN chunk`);
  return { json, bin };
}

// The kit's NORMALs as normalized i8 and its TEXCOORD_0s as normalized u16
// (KHR_mesh_quantization), in place on `json`, returning the new BIN. Only
// those two: they need no dequantizing transform, so the node tree every
// reader walks stays as built. A uv outside 0..1 (a tiling face) stays float.
// Idempotent: an accessor already integer is copied through. Every reader
// decodes the glTF way (ttp/glb_mesh.h; gltfio), and the `glbmesh` ctest fails
// on a kit model it cannot read, which would otherwise draw live-lit.
export function quantizeGlb(json, bin) {
  const role = new Map();
  for (const m of json.meshes || []) for (const p of m.primitives) {
    if (p.attributes.NORMAL != null) role.set(p.attributes.NORMAL, 'normal');
    if (p.attributes.TEXCOORD_0 != null) role.set(p.attributes.TEXCOORD_0, 'uv');
  }
  const encode = new Map();   // bufferView -> { bytes, stride }
  for (const [ai, kind] of role) {
    const a = json.accessors[ai];
    if (a.componentType !== 5126 || a.sparse || a.byteOffset) continue;
    const view = json.bufferViews[a.bufferView];
    if (view.byteStride || json.accessors.some((b, bi) => bi !== ai && b.bufferView === a.bufferView)) continue;
    const src = new DataView(bin.buffer, bin.byteOffset + (view.byteOffset || 0), a.count * (kind === 'uv' ? 8 : 12));
    const out = Buffer.alloc(a.count * 4);
    if (kind === 'normal') {
      for (let i = 0; i < a.count * 3; i++) out.writeInt8(Math.max(-127, Math.min(127, Math.round(src.getFloat32(i * 4, true) * 127))), (i / 3 | 0) * 4 + i % 3);
      encode.set(a.bufferView, { bytes: out, stride: 4 });
      a.componentType = 5120;
    } else {
      const uv = Array.from({ length: a.count * 2 }, (_, i) => src.getFloat32(i * 4, true));
      if (uv.some((u) => !(u >= 0 && u <= 1))) continue;
      uv.forEach((u, i) => out.writeUInt16LE(Math.round(u * 65535), i * 2));
      encode.set(a.bufferView, { bytes: out });
      a.componentType = 5123;
    }
    a.normalized = true;
    delete a.min; delete a.max;
  }
  if (!encode.size) return bin;
  const parts = []; let at = 0;
  for (const [vi, view] of json.bufferViews.entries()) {
    const e = encode.get(vi);
    const bytes = e ? e.bytes : bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
    const pad = (4 - (at % 4)) % 4;
    if (pad) parts.push(Buffer.alloc(pad));
    at += pad;
    view.byteOffset = at; view.byteLength = bytes.length;
    if (e?.stride) view.byteStride = e.stride;
    parts.push(bytes); at += bytes.length;
  }
  json.buffers = [{ ...json.buffers[0], byteLength: at }];
  for (const key of ['extensionsUsed', 'extensionsRequired']) {
    json[key] = [...new Set([...(json[key] || []), 'KHR_mesh_quantization'])];
  }
  return Buffer.concat(parts);
}

// A glTF document and its binary buffer as GLB bytes, both chunks padded to
// the 4-byte alignment the container requires. The attributes are quantized
// on the way (quantizeGlb), so every bake writes the kit's one layout.
export function encodeGlb(json, srcBin) {
  const bin = quantizeGlb(json, srcBin);
  let text = JSON.stringify(json);
  while (text.length % 4) text += ' ';
  const jsonBytes = Buffer.from(text, 'utf8');
  const binBytes = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const glb = Buffer.alloc(12 + 8 + jsonBytes.length + 8 + binBytes.length);
  glb.writeUInt32LE(GLB_MAGIC, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(jsonBytes.length, 12);
  glb.writeUInt32LE(JSON_CHUNK, 16);
  jsonBytes.copy(glb, 20);
  glb.writeUInt32LE(binBytes.length, 20 + jsonBytes.length);
  glb.writeUInt32LE(BIN_CHUNK, 24 + jsonBytes.length);
  binBytes.copy(glb, 28 + jsonBytes.length);
  return glb;
}
