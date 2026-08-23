'use strict';
// The baked artwork's COVERAGE and SIZE — the gate the brand family never had.
//
// Every other baked family in this tree already has a test that notices it going
// wrong: the tracks and tokens have codegen-freshness, the cues have a byte gate,
// the screens have shots-manifest, the models have asset-sources. The brand
// artwork had none, and it is the family a human is least likely to look at:
// nobody opens a favicon. Two real defects shipped through that gap — an app icon
// left at a size that read as a smudge, and a top shelf upscaled from a
// quarter-scale render.
//
// WHAT THIS CAN HONESTLY ASSERT is not what the picture looks like. It is that
// every entry the gallery promises exists, that it is the PIXEL SIZE it claims
// (read out of the file's own header, not out of the manifest), and that nothing
// sitting in the brand directories is missing from the table — the orphan half,
// modelled on tests/shots-manifest.test.js. A picture gate would be a flake
// factory and would say less than it looks like it says; judging the pictures is
// what /gallery-artwork.html is for.
//
// SIZE IS THE HALF THAT EARNS ITS KEEP. Every platform slot here has a size the
// platform chose, not one we did, and every one of the size mistakes this project
// has actually made would have failed here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
// Manifest paths are relative to public/assets/ — see the note in the manifest.
const ASSETS = path.join(PUBLIC, 'assets');

let MANIFEST;
test.before(async () => {
  MANIFEST = await import('../public/shared/artworkManifest.js');
});

// Pixel dimensions out of the file's own header. PNG carries them in the IHDR at
// a fixed offset; JPEG needs a walk of the segment chain to the first SOF marker.
// Twenty lines of parsing, against an image dependency this repo does not need.
function pngSize(buf) {
  assert.equal(buf.readUInt32BE(0), 0x89504e47, 'not a PNG');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    // SOF0..SOF15, minus the four that are not frame headers (DHT, JPG, DAC, RST).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('no SOF marker — not a JPEG?');
}

function imageSize(file) {
  const buf = fs.readFileSync(file);
  return path.extname(file) === '.png' ? pngSize(buf) : jpegSize(buf);
}

test('artwork: every manifest entry exists at the size it claims', () => {
  for (const entry of MANIFEST.ARTWORK) {
    const file = path.join(ASSETS, entry.file);
    assert.ok(fs.existsSync(file), `${entry.id}: missing ${entry.file} — run ${entry.bake}`);
    if (entry.w == null) continue;   // the wordmark is cropped to its ink, so its size is derived
    const got = imageSize(file);
    assert.deepEqual(got, { w: entry.w, h: entry.h },
      `${entry.id}: ${entry.file} is ${got.w}x${got.h}, manifest says ${entry.w}x${entry.h}`);
  }
});

test('artwork: every family is non-empty and names the command that bakes it', () => {
  for (const fam of MANIFEST.ARTWORK_FAMILIES) {
    assert.ok(fam.title && fam.blurb && fam.bake, `${fam.id}: incomplete family entry`);
    // shelf-carousel and items are built from their own sources at render time.
    if (['shelf-carousel', 'items'].includes(fam.id)) continue;
    assert.ok(MANIFEST.ARTWORK.some((e) => e.family === fam.id),
      `${fam.id}: a family with no entries is a heading over nothing`);
  }
});

test('artwork: every entry names a family that exists', () => {
  const known = new Set(MANIFEST.ARTWORK_FAMILIES.map((f) => f.id));
  for (const e of MANIFEST.ARTWORK) {
    assert.ok(known.has(e.family), `${e.id}: unknown family ${e.family}`);
  }
});

// THE ORPHAN HALF. A picture in the brand tree that no entry names is a bake
// nobody is looking at — which is how the top shelf sat as a paper drawing for as
// long as it did. The layer PNGs are named indirectly (an entry's `layers` prefix
// stands for its three .imagestacklayer files), so they are resolved rather than
// listed.
test('artwork: nothing in the brand tree is unlisted', () => {
  const named = new Set();
  for (const e of MANIFEST.ARTWORK) {
    named.add(path.join(ASSETS, e.file));
    if (!e.layers) continue;
    for (const layer of ['back', 'middle', 'front']) {
      named.add(path.join(ASSETS, 'brand', `${e.layers}-${layer}.png`));
      named.add(path.join(ASSETS, 'brand', `${e.layers}-${layer}@2x.png`));
    }
  }
  // The carousel set is listed by carousel.json, which the extension itself reads.
  const shelfDir = path.join(ASSETS, 'brand/tv/shelf');
  if (fs.existsSync(shelfDir)) {
    const carousel = JSON.parse(fs.readFileSync(path.join(shelfDir, 'carousel.json'), 'utf8'));
    named.add(path.join(shelfDir, 'carousel.json'));
    for (const it of carousel.items) {
      named.add(path.join(shelfDir, `${it.id}.jpg`));
      named.add(path.join(shelfDir, `${it.id}@2x.jpg`));
    }
  }

  const orphans = [];
  for (const { dir, skip } of MANIFEST.ARTWORK_SWEEP) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      const file = path.join(abs, name);
      if (fs.statSync(file).isDirectory()) continue;
      // Dotfiles are not artwork and are not in the repo: this sweep walks the
      // FILESYSTEM, so a Finder visit to any of these directories leaves a
      // .DS_Store behind and fails the suite for everyone on a Mac, naming a
      // file git is already ignoring.
      if (name.startsWith('.')) continue;
      if (skip.includes(name)) continue;
      if (!named.has(file)) orphans.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(orphans, [],
    'baked artwork nothing lists — add it to public/shared/artworkManifest.js or delete it');
});

// The carousel is the one family whose running order lives outside this manifest,
// because the tvOS extension reads that file directly. So the gate is that the
// file and the frames agree with each other.
test('artwork: the carousel manifest and its frames agree', () => {
  const shelfDir = path.join(ASSETS, 'brand/tv/shelf');
  const manifestFile = path.join(shelfDir, 'carousel.json');
  assert.ok(fs.existsSync(manifestFile), 'no carousel.json — run npm run bake:shelf');
  const { items } = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

  // Apple's own guidance for a Top Shelf carousel is five to ten items.
  assert.ok(items.length >= 5 && items.length <= 10,
    `carousel has ${items.length} items; tvOS wants 5 to 10`);

  const ids = new Set();
  for (const it of items) {
    assert.ok(it.id && it.title && it.context, `carousel entry ${it.id}: incomplete`);
    assert.ok(!ids.has(it.id), `carousel: duplicate id ${it.id}`);
    ids.add(it.id);
    // BOTH SCALES, and this is the assertion that would have caught the blurry
    // shelf: a 1x-only set is upscaled on every frame of a 4K box. The sizes come
    // from CAROUSEL_SIZE rather than being re-typed here.
    const { w, h, scale } = MANIFEST.CAROUSEL_SIZE;
    const at1x = imageSize(path.join(shelfDir, `${it.id}.jpg`));
    const at2x = imageSize(path.join(shelfDir, `${it.id}@2x.jpg`));
    assert.deepEqual(at1x, { w, h }, `${it.id}: @1x is ${at1x.w}x${at1x.h}`);
    assert.deepEqual(at2x, { w: w * scale, h: h * scale },
      `${it.id}@2x is ${at2x.w}x${at2x.h}`);
  }
});
