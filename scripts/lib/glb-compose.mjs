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

// A glTF document and its binary buffer as GLB bytes, both chunks padded to
// the 4-byte alignment the container requires.
export function encodeGlb(json, bin) {
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
