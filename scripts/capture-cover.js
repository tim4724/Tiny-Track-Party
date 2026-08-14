'use strict';

// Render the store cover tile from the app icon.
//
//   node scripts/capture-cover.js                 # → artwork/airconsole-cover.png (1024x1024)
//   node scripts/capture-cover.js --size 512
//
// AirConsole's developer console wants a square PNG or JPEG, at least 512x512,
// under 1 MB. This is a PLACEHOLDER built from `assets/icon/favicon.svg` so the
// listing has something honest and on-brand; real cover art is its own job.
//
// Two things it does to the icon, and neither is a redraw — the SVG stays the
// one source for the artwork:
//
//   FULL BLEED. The icon is a rounded tile inset by 3 units inside its 64-unit
//   viewBox, so rendered as-is a cover would carry rounded corners and a
//   transparent margin: on a dark store background those corners go dark, and
//   every platform masks its own tile shape anyway. The inset rect and its
//   matching clipPath are rewritten to the full square, which is why the
//   rewrite is ASSERTED — a redesigned icon that no longer spells them this way
//   must fail here rather than quietly ship a transparent tile.
//
//   NO ALPHA. Flattened onto the icon's own background by rendering over an
//   opaque page, so nothing downstream has to decide what shows through.
//
// Playwright is the renderer because it is already the tree's image pipeline
// (see capture-artwork.js) and needs no new dependency to rasterize an SVG.

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const ICON = path.join(ROOT, 'public', 'assets', 'icon', 'favicon.svg');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    out[argv[i].slice(2)] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const SIZE = parseInt(args.size, 10) || 1024;   // >= 512; 1024 leaves room to downscale
const OUT = path.resolve(ROOT, args.out || 'artwork/airconsole-cover.png');

// The inset rounded tile, as favicon.svg spells it — once as the visible
// background and once as the clipPath the flag is cut against.
const INSET = /x="3" y="3" width="58" height="58" rx="16"/g;
const FULL = 'x="0" y="0" width="64" height="64" rx="0"';

function fullBleedIcon() {
  const svg = fs.readFileSync(ICON, 'utf8');
  const hits = svg.match(INSET);
  if (!hits || hits.length !== 2) {
    throw new Error(`favicon.svg no longer carries the two inset tile rects this rewrites ` +
      `(found ${hits ? hits.length : 0}). The icon was redesigned — re-derive the full-bleed ` +
      'rewrite in scripts/capture-cover.js against its new shape.');
  }
  return svg.replace(INSET, FULL);
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const svg = fullBleedIcon();

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: SIZE, height: SIZE },
      deviceScaleFactor: 2,   // supersample, then downscale once — the flag's checks alias badly
    });
    // The icon is vector, so the only raster step is this one. An opaque page
    // is what flattens the alpha.
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#f2ad33">
      <div style="width:${SIZE}px;height:${SIZE}px">${svg.replace('<svg ', `<svg width="${SIZE}" height="${SIZE}" `)}</div>
    </body></html>`);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    const big = await page.screenshot({ type: 'png' });
    const out = await page.evaluate(async ({ b64, n }) => {
      const raw = atob(b64);
      const src = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) src[i] = raw.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([src], { type: 'image/png' }),
        { resizeWidth: n, resizeHeight: n, resizeQuality: 'high' });
      const canvas = new OffscreenCanvas(n, n);
      canvas.getContext('2d').drawImage(bmp, 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
      return btoa(s);
    }, { b64: big.toString('base64'), n: SIZE });
    fs.writeFileSync(OUT, Buffer.from(out, 'base64'));
  } finally {
    await browser.close();
  }

  const kb = fs.statSync(OUT).size / 1024;
  console.log(`Cover: ${OUT} (${SIZE}x${SIZE}, ${kb.toFixed(0)} KB)`);
  // The store's limits, checked here rather than discovered at upload.
  if (SIZE < 512) throw new Error(`cover is ${SIZE}px — AirConsole's floor is 512x512.`);
  if (kb > 1024) throw new Error(`cover is ${kb.toFixed(0)} KB — AirConsole's limit is 1 MB.`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
