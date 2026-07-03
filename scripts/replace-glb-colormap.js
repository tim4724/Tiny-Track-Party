#!/usr/bin/env node
'use strict';
// Point .glb embedded images at an EXTERNAL colormap file instead (the toy-car kit
// pattern: every kit GLB references "Textures/colormap.png" relative to the model,
// served as a plain static file).
//
// Why this exists: Kenney's Holiday Kit (1.0) GLB exports EMBED a stale palette
// texture — tree-snow-a/b/c render with charcoal foliage and slate-blue snow, while
// the kit's previews (and the colormap.png shipped next to the GLBs) show teal-green
// tiers with white caps. On top of that, GLTFLoader turns bufferView images into
// blob: URLs fetched via the Fetch API, which our CSP's connect-src blocks — so
// embedded images can't load on the display AT ALL. Externalizing the image fixes
// both: correct palette, and it loads via img-src 'self' like every toy-car texture.
//
// Usage: node scripts/replace-glb-colormap.js <relative-uri> <file.glb> [more.glb...]
//   e.g. node scripts/replace-glb-colormap.js Textures/holiday-colormap.png \
//          public/assets/toycar/tree-snow-{a,b,c}.glb
// (Run on FRESH kit copies; ship the referenced PNG at that path relative to the
// GLBs. The old embedded bytes stay in the BIN chunk as a few KB of orphaned
// padding — harmless, and every other bufferView offset stays valid.)
const fs = require('node:fs');

const [uri, ...glbPaths] = process.argv.slice(2);
if (!uri || !glbPaths.length) {
  console.error('usage: replace-glb-colormap.js <relative-uri> <file.glb> [more.glb...]');
  process.exit(1);
}

const pad4 = (n) => (4 - (n % 4)) % 4;

for (const glbPath of glbPaths) {
  const glb = fs.readFileSync(glbPath);
  if (glb.readUInt32LE(0) !== 0x46546c67 || glb.readUInt32LE(4) !== 2) {
    throw new Error(`${glbPath}: not a glTF 2.0 GLB`);
  }
  const jsonLen = glb.readUInt32LE(12);
  if (glb.readUInt32LE(16) !== 0x4e4f534a) throw new Error(`${glbPath}: first chunk is not JSON`);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
  const rest = glb.subarray(20 + jsonLen); // BIN chunk (header + data), byte-exact

  if (!json.images || !json.images.length) throw new Error(`${glbPath}: no images to retarget`);
  for (const img of json.images) {
    delete img.bufferView;
    delete img.mimeType;
    img.uri = uri;
  }

  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  jsonBuf = Buffer.concat([jsonBuf, Buffer.from(' '.repeat(pad4(jsonBuf.length)))]);

  const total = 12 + 8 + jsonBuf.length + rest.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonBuf.length, 12); out.writeUInt32LE(0x4e4f534a, 16);
  jsonBuf.copy(out, 20);
  rest.copy(out, 20 + jsonBuf.length);

  fs.writeFileSync(glbPath, out);
  console.log(`${glbPath}: images → "${uri}", total ${total}`);
}
