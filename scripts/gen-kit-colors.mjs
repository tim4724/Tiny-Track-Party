// Codegen: emits native/renderer/generated/kit_colors.h — every kit model's
// base colour PER VERTEX, so the renderer can bake a static copy's light into
// its vertices at scene build without ever touching the atlas texture.
//
// WHY THIS IS EXACT. The kit's atlas (Textures/*.png) is a grid of swatches,
// each two flat halves side by side with a near-linear ramp down each half,
// and every kit face's UV triangle is a POINT or a VERTICAL LINE inside one
// half (scratch probes, 2026-09-02). So the texture sampled at a vertex and
// interpolated across the triangle is the picture the fragment shader draws.
//
// The colour here is the TEXTURE half of vglb.mat's ttpGlbBaseColor at the
// vertex: the atlas decoded to LINEAR (gltfio binds it sRGB), white for an
// untextured material. The baseColorFactor is deliberately NOT folded in —
// the biome recolours untextured models by overriding it on the live
// instance (TtpRendererDressing's modelTints), so the renderer multiplies the
// factor it reads back from the instance at bake time. Stored as linear u8,
// the quantisation every hand-built sheet's vertex colour already carries.
//
// Keyed by the FNV-1a of the GLB's bytes, the identity TtpRenderer::glbBytesKey
// gives every cached model, so a GLB that changes without this being re-run
// simply misses the table and its copies light live — the gate is
// tests/codegen-freshness.test.js.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KIT = path.join(ROOT, 'public/assets/toycar');
const OUT = path.join(ROOT, 'native/renderer/generated/kit_colors.h');

// FNV-1a 64 over the bytes, the way glbBytesKey spells it (never 0).
const fnv1a64 = (bytes) => {
  let h = 14695981039346656037n;
  for (const b of bytes) { h ^= BigInt(b); h = (h * 1099511628211n) & 0xffffffffffffffffn; }
  return h === 0n ? 1n : h;
};

// The smallest PNG reader that covers the kit's atlases: 8-bit RGB, RGBA or
// palette, non-interlaced. Anything else is refused loudly.
const readPng = (file) => {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: not a PNG`);
  let pos = 8, width = 0, height = 0, channels = 0, palette = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      const depth = data[8], color = data[9], interlace = data[12];
      channels = { 2: 3, 3: 1, 6: 4 }[color];
      if (depth !== 8 || !channels || interlace) throw new Error(`${file}: unsupported PNG (${depth}-bit, colour ${color}, interlace ${interlace})`);
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels, out = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= channels ? out[dst + i - channels] : 0;
      const b = y > 0 ? out[dst - stride + i] : 0;
      const c = y > 0 && i >= channels ? out[dst - stride + i - channels] : 0;
      out[dst + i] = (x + [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter]) & 0xff;
    }
  }
  if (channels === 1) {
    if (!palette) throw new Error(`${file}: palette PNG without PLTE`);
    const rgb = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i++) rgb.set(palette.subarray(out[i] * 3, out[i] * 3 + 3), i * 3);
    return { width, height, channels: 3, px: rgb };
  }
  return { width, height, channels, px: out };
};

const srgbToLinear = (u) => { const c = u / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };

// Bilinear sample with the sampler gltfio uses (REPEAT, linear), in linear.
const sampleLinear = (img, u, v) => {
  const wrap = (t) => t - Math.floor(t);
  const fx = wrap(u) * img.width - 0.5, fy = wrap(v) * img.height - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const at = (x, y) => {
    const xx = ((x % img.width) + img.width) % img.width, yy = ((y % img.height) + img.height) % img.height;
    const i = (yy * img.width + xx) * img.channels;
    return [srgbToLinear(img.px[i]), srgbToLinear(img.px[i + 1]), srgbToLinear(img.px[i + 2])];
  };
  const p00 = at(x0, y0), p10 = at(x0 + 1, y0), p01 = at(x0, y0 + 1), p11 = at(x0 + 1, y0 + 1);
  return [0, 1, 2].map((k) => (p00[k] * (1 - tx) + p10[k] * tx) * (1 - ty) + (p01[k] * (1 - tx) + p11[k] * tx) * ty);
};

const readGlb = (file) => {
  const buf = fs.readFileSync(file);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
  const binOff = 20 + jsonLen + 8;
  const accessor = (i) => {
    const a = json.accessors[i], bv = json.bufferViews[a.bufferView];
    const T = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array, 5121: Uint8Array }[a.componentType];
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    const off = buf.byteOffset + binOff + (bv.byteOffset || 0) + (a.byteOffset || 0);
    return new T(buf.buffer.slice(off, off + a.count * comps * T.BYTES_PER_ELEMENT));
  };
  return { bytes: buf, json, accessor };
};

const images = new Map();
const models = [];
for (const name of fs.readdirSync(KIT).filter((f) => f.endsWith('.glb')).sort()) {
  const { bytes, json, accessor } = readGlb(path.join(KIT, name));
  const meshes = [];
  for (const mesh of json.meshes) {
    const prims = [];
    for (const p of mesh.primitives) {
      const pos = accessor(p.attributes.POSITION);
      const n = pos.length / 3;
      const mat = json.materials?.[p.material];
      const pbr = mat?.pbrMetallicRoughness ?? {};
      const tex = pbr.baseColorTexture;
      let img = null, uv = null;
      if (tex && p.attributes.TEXCOORD_0 != null) {
        const im = json.images[json.textures[tex.index].source];
        if (!im.uri) throw new Error(`${name}: embedded image — only external atlases are handled`);
        const file = path.join(KIT, decodeURIComponent(im.uri));
        if (!images.has(file)) images.set(file, readPng(file));
        img = images.get(file);
        uv = accessor(p.attributes.TEXCOORD_0);
      }
      const rgb = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) {
        const base = img ? sampleLinear(img, uv[i * 2], uv[i * 2 + 1]) : [1, 1, 1];
        for (let k = 0; k < 3; k++) rgb[i * 3 + k] = Math.round(Math.min(1, Math.max(0, base[k])) * 255);
      }
      prims.push(rgb);
    }
    meshes.push(prims);
  }
  models.push({ name, key: fnv1a64(bytes), meshes });
}

const lines = [];
lines.push('// GENERATED by scripts/gen-kit-colors.mjs from public/assets/toycar — do not edit.');
lines.push('// Per-vertex base colour (linear u8 rgb) of every kit model, keyed by the');
lines.push('// FNV-1a of its GLB bytes; the generator says why a vertex sample is exact.');
lines.push('#pragma once');
lines.push('#include <cstdint>');
lines.push('#include <cstddef>');
lines.push('');
lines.push('namespace ttp { namespace kitcolors {');
lines.push('');
lines.push('struct Prim { uint32_t vertexCount; const uint8_t* rgb; };');
lines.push('struct Mesh { uint32_t primCount; const Prim* prims; };');
lines.push('struct Model { uint64_t key; uint32_t meshCount; const Mesh* meshes; };');
lines.push('');
const ident = (s) => s.replace(/[^A-Za-z0-9]/g, '_');
for (const m of models) {
  const id = ident(m.name.replace(/\.glb$/, ''));
  m.meshes.forEach((prims, mi) => {
    prims.forEach((rgb, pi) => {
      const rows = [];
      for (let i = 0; i < rgb.length; i += 48) rows.push('    ' + Array.from(rgb.subarray(i, i + 48)).join(','));
      lines.push(`inline const uint8_t k_${id}_m${mi}_p${pi}[] = {`);
      lines.push(rows.join(',\n'));
      lines.push('};');
    });
    lines.push(`inline const Prim k_${id}_m${mi}[] = {`);
    lines.push(prims.map((rgb, pi) => `    { ${rgb.length / 3}u, k_${id}_m${mi}_p${pi} }`).join(',\n'));
    lines.push('};');
  });
  lines.push(`inline const Mesh k_${id}[] = {`);
  lines.push(m.meshes.map((prims, mi) => `    { ${prims.length}u, k_${id}_m${mi} }`).join(',\n'));
  lines.push('};');
  lines.push('');
}
lines.push('inline const Model kModels[] = {');
lines.push(models.map((m) => `    { ${m.key}ull, ${m.meshes.length}u, k_${ident(m.name.replace(/\.glb$/, ''))} },  // ${m.name}`).join('\n'));
lines.push('};');
lines.push(`inline const size_t kModelCount = ${models.length};`);
lines.push('');
lines.push('inline const Model* find(uint64_t key) {');
lines.push('    for (size_t i = 0; i < kModelCount; i++) if (kModels[i].key == key) return &kModels[i];');
lines.push('    return nullptr;');
lines.push('}');
lines.push('');
lines.push('}}  // namespace ttp::kitcolors');
lines.push('');
const text = lines.join('\n');
// --stdout is the freshness gate's spelling (tests/codegen-freshness.test.js).
// No process.exit after the write: a pipe takes a 200 KB header in pieces, and
// exiting first truncates it.
if (process.argv.includes('--stdout')) {
  process.stdout.write(text);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  const verts = models.reduce((s, m) => s + m.meshes.flat().reduce((t, rgb) => t + rgb.length / 3, 0), 0);
  console.log(`wrote ${path.relative(ROOT, OUT)}: ${models.length} models, ${verts} vertices, ${images.size} atlases`);
}
