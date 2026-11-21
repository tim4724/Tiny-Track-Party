#!/usr/bin/env node
// gen-colormap.mjs — the ONE colour atlas every model wears:
// public/assets/toycar/Textures/colormap.png, written from the table below.
//
// LAYOUT (what scripts/blender/set_prototypes.py's SWATCH, scripts/toy_cars.py
// and gen-props.mjs address): 128 x 128, cells of 16 x 32. A cell's left half
// is its FLAT colour; its right half is a RAMP, light at the top and running
// linearly to its shade at the bottom, which is what a piece is shaded down by
// height. A cell's (x, y) here is its top-left pixel, as in SWATCH.
//
// The layout and the first three rows' colours are the ones Kenney's Toy Car
// Kit laid out and this game's models were authored against (the kit's atlas
// shipped here until round 27); the file itself is ours, and a new swatch is a
// new row in this table. Unused cells stay black.
//
//   node scripts/gen-colormap.mjs        then gen-kit-colors.mjs and a rebuild:
// the renderer bakes every model's colours from this file (kit_colors.h).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/assets/toycar/Textures/colormap.png');
const SIZE = 128, CELL_W = 16, CELL_H = 32;

// name: [x, y, flat, ramp top, ramp bottom]
const SWATCHES = {
  ochre:    [0, 0, 0xdfb25a, 0xdfb25a, 0xb48234],
  snow:     [16, 0, 0xf8fcfe, 0xf8fcfe, 0xc2e1f6],
  ice:      [32, 0, 0xd8eef2, 0xeaf7fa, 0x5ea9b8],
  serac:    [48, 0, 0xd0f1f7, 0xe2f7fb, 0x3fbcd4],
  palmwood: [96, 0, 0xc09a72, 0xc09a72, 0x825c43],
  palmleaf: [112, 0, 0x54b573, 0x54b573, 0x2f7a45],
  pink:     [0, 32, 0xf378f0, 0xf278f0, 0xa777e8],
  blossom:  [16, 32, 0xf6ccd4, 0xf6ccd4, 0xdca0b2],
  petal:    [32, 32, 0xfbecee, 0xfbecee, 0xecc9d2],
  bark:     [48, 32, 0x8c776a, 0x8c776a, 0x5e5049],
  leaf:     [64, 32, 0xa5d07c, 0xa5d07c, 0x6da658],
  gravel:   [80, 32, 0xd9c7a0, 0xd9c7a0, 0xb9a37c],
  sage:     [96, 32, 0x93a97c, 0x93a97c, 0x55704f],
  olive:    [112, 32, 0xa3a068, 0xa3a068, 0x6a6a42],
  cream:    [0, 64, 0xfde4c7, 0xfde4c6, 0xf4ca98],
  green:    [16, 64, 0x61cb8b, 0x60ca8a, 0x1b8469],
  yellow:   [32, 64, 0xffc044, 0xffd565, 0xff952f],
  orange:   [48, 64, 0xff7e44, 0xff9d44, 0xff7244],
  red:      [64, 64, 0xcf534f, 0xfe6c40, 0xd0534f],
  blue:     [80, 64, 0x6794d9, 0x6793d9, 0x5756bd],
  sky:      [96, 64, 0xd0e8ff, 0xcee7ff, 0x6895da],
  purple:   [112, 64, 0xa878e8, 0xa777e7, 0x5c39b8],
  dark:     [0, 96, 0x38383d, 0x464651, 0x353539],
  grey:     [16, 96, 0x868ba1, 0x858aa0, 0x565c74],
  slate:    [32, 96, 0x4f5260, 0x545767, 0x3b3e4a],
  lavender: [48, 96, 0xa0a8c9, 0xc4cdf6, 0x777c93],
  white:    [64, 96, 0xffffff, 0xfefefe, 0xbcbcd5],
  salmon:   [80, 96, 0xf1976c, 0xf0966b, 0xb16142],
  brown:    [96, 96, 0xb06041, 0xb06041, 0x845442],
  tan:      [112, 96, 0xf2bf99, 0xf2be98, 0xc9825a],
};

const rgb = (hex) => [hex >> 16 & 255, hex >> 8 & 255, hex & 255];
const px = Buffer.alloc(SIZE * SIZE * 3);
for (const [x0, y0, flat, top, bottom] of Object.values(SWATCHES)) {
  const f = rgb(flat), a = rgb(top), b = rgb(bottom);
  for (let y = 0; y < CELL_H; y++) {
    const ramp = a.map((c, k) => Math.round(c + (b[k] - c) * y / (CELL_H - 1)));
    for (let x = 0; x < CELL_W; x++) px.set(x < CELL_W / 2 ? f : ramp, ((y0 + y) * SIZE + x0 + x) * 3);
  }
}

// An 8-bit RGB PNG, every row unfiltered: the file is a few hundred bytes of
// flat runs either way.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4);
  return out;
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4); ihdr[8] = 8; ihdr[9] = 2;
const raw = Buffer.alloc(SIZE * (SIZE * 3 + 1));
for (let y = 0; y < SIZE; y++) px.copy(raw, y * (SIZE * 3 + 1) + 1, y * SIZE * 3, (y + 1) * SIZE * 3);
fs.writeFileSync(OUT, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${Object.keys(SWATCHES).length} swatches`);
