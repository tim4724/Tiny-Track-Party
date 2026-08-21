// Bake the wordmark to a transparent PNG, rendered through the REAL theme.css.
//
//   node scripts/bake-wordmark.mjs
//
// WHY THIS EXISTS. The wordmark is TYPE — a variable font, a centred text
// stroke, a hard drop shadow and a 2-degree rotation, all declared once in
// `public/shared/theme.css`. Three of the places that need it cannot render
// type at all:
//
//   * an Android VectorDrawable has no text primitive, so the launcher banner
//     shipped as a hand-drawn placeholder that says so in its own comment;
//   * a windowBackground drawable is composited before a single line of app
//     code runs, so it cannot ask Compose to draw anything;
//   * a tvOS launch image comes out of an asset catalog, likewise.
//
// Hand-tracing the glyphs into vectors would fork the wordmark: the CSS would
// move and the traced copy would not, and nothing would notice. So this renders
// the real rule in a real browser and reads the pixels back — the same
// "render the real thing offline and bake it" the car thumbnails and the item
// icons already use, and what `banner.xml` asked for by name.
//
// NOT a codegen-freshness entry, and for the same reason `capture-car-thumbs`
// is not one: that gate re-runs its generator and DIFFS THE TEXT, and a PNG out
// of a real browser is neither text nor byte-stable across Chromium versions —
// it would fail on an antialiasing change and say the wordmark had drifted. The
// bake is re-run by hand when theme.css's wordmark rules or the fonts move.
//
// TRANSPARENT, and cropped to the ink. The callers composite it over their own
// background — paper on the splash, the banner's own art behind it — so a baked
// background colour would be a second place the paper token lives.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// THE REAL SIZE, then supersampled by the device pixel ratio. The wordmark's
// white cut is a FIXED `-webkit-text-stroke: 7px` against a font-size the web
// clamps to 130 at poster scale, so the edge is a proportion of that pair and of
// nothing else. Baking at a bigger font-size thins the cut; baking at 130 and
// asking the browser for 4x pixels keeps every proportion and just hands back
// more of them.
const FONT_PX = 130;
const SCALE = 4;

const TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml'
};

// The page is SERVED, not `setContent`, and that is not a detail: a font is a
// CORS-restricted fetch, so a document left on `about:blank` is cross-origin to
// the stylesheet and the woff2 never arrives — the wordmark then lays out, tilts
// and takes its colours in a fallback sans, which is wrong in the one way a PNG
// cannot tell you about. Same origin for the document, the CSS and the font is
// exactly the display page's own arrangement.
//
// The markup is index.html's `.wordmark` badge verbatim, so the bake and the
// board cannot drift into different line breaks or a different second line.
const PAGE = `<!doctype html>
  <link rel="stylesheet" href="/shared/theme.css">
  <style>
    html, body { margin: 0; background: transparent; }
    body { display: inline-block; padding: 40px; }
    .wordmark { font-size: ${FONT_PX}px; }
  </style>
  <div class="wordmark"><span>TINY TRACK</span><span class="l2">PARTY!</span></div>`;

// THE LAUNCHER TILE, 320x180 and the size Android TV requires. Built from the
// theme's own paper stage rather than drawn by hand: `banner.xml` shipped as a
// vector of coloured rectangles precisely because a VectorDrawable cannot set
// type, and said in its own comment that the honest fix was to render the real
// `.wordmark` and bake it. Same page, same stylesheet, so the tile and the
// welcome board are the same wordmark.
const BANNER_W = 320;
const BANNER_H = 180;

// THE tvOS LAUNCH IMAGE, at 1920x1080 because tvOS lays out in those POINTS
// whatever the box is outputting (the same fact CountdownView sizes its numeral
// against). It is the Android splash's picture: paper, with the mark on it.
const LAUNCH_W = 1920;
const LAUNCH_H = 1080;

// THE ANDROID 12 SPLASH ICON, and its constraint is the reason it is its own
// output rather than a crop of the wordmark. That splash draws ONE icon, masked
// to a CIRCLE, on a background colour — a wide two-line mark dropped in there
// loses its ends. So the mark is laid out to fit the INSCRIBED CIRCLE of a
// square canvas: 512 px square, the wordmark inside a centred circle of ~62% of
// it, transparent everywhere else.
const ICON = 512;
const ICON_FIT = 0.62;
const BANNER = `<!doctype html>
  <link rel="stylesheet" href="/shared/theme.css">
  <style>
    html, body { margin: 0; }
    body { width: ${BANNER_W}px; height: ${BANNER_H}px; position: relative; overflow: hidden; }
    .scene { position: absolute; inset: 0; }
    .mark {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
    }
    /* Sized to the tile rather than to the board: 34px is what fits two lines
       across 320 with the cut and the shadow still inside the frame. */
    .wordmark { font-size: 34px; }
  </style>
  <div class="scene">
    <div class="scene__sky"></div>
    <div class="scene__grass"></div>
  </div>
  <div class="mark">
    <div class="wordmark"><span>TINY TRACK</span><span class="l2">PARTY!</span></div>
  </div>`;

const LAUNCH = `<!doctype html>
  <link rel="stylesheet" href="/shared/theme.css">
  <style>
    html, body { margin: 0; }
    body {
      width: ${LAUNCH_W}px; height: ${LAUNCH_H}px;
      background: var(--paper);
      display: flex; align-items: center; justify-content: center;
    }
    /* The welcome board's own poster clamp, so the launch image and the first
       board it hands over to are the same size of mark. */
    .wordmark { font-size: 130px; }
  </style>
  <div class="wordmark"><span>TINY TRACK</span><span class="l2">PARTY!</span></div>`;

const SPLASH_ICON = `<!doctype html>
  <link rel="stylesheet" href="/shared/theme.css">
  <style>
    html, body { margin: 0; background: transparent; }
    body {
      width: ${ICON}px; height: ${ICON}px;
      display: flex; align-items: center; justify-content: center;
    }
    /* Sized so the two lines sit inside the circle the launcher masks to, with
       the die-cut edge and the drop shadow still inside it. */
    .wordmark { font-size: ${Math.round(ICON * ICON_FIT * 0.30)}px; text-align: center; }
  </style>
  <div class="wordmark"><span>TINY TRACK</span><span class="l2">PARTY!</span></div>`;

function serve() {
  const server = createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const pages = { '/banner.html': BANNER, '/launch.html': LAUNCH,
                    '/splash-icon.html': SPLASH_ICON };
    if (rel === '/' || rel === '/bake.html' || pages[rel]) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(pages[rel] || PAGE);
      return;
    }
    const file = join(ROOT, 'public', rel);
    if (!file.startsWith(join(ROOT, 'public')) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const { server, port } = await serve();
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: SCALE
});
// A MISSING FONT MUST NOT BAKE QUIETLY. The wordmark in a fallback sans still
// lays out, still rotates and still takes its colours — it is only WRONG, which
// a PNG cannot say. Any request that does not answer 200 is fatal here.
const failed = [];
page.on('response', (r) => { if (r.status() !== 200) failed.push(`${r.status()} ${r.url()}`); });
page.on('requestfailed', (r) => failed.push(`failed ${r.url()}`));

await page.goto(`http://127.0.0.1:${port}/bake.html`, { waitUntil: 'load' });

// `document.fonts.ready` alone is not enough: `font-display: swap` means the
// face is fetched lazily and ready can resolve before it has been asked for.
// Loading it BY NAME is what actually blocks on the woff2.
await page.evaluate(async (px) => {
  await document.fonts.load(`700 ${px}px Fredoka`);
  await document.fonts.ready;
}, FONT_PX);
const usedFredoka = await page.evaluate(() => document.fonts.check('700 130px Fredoka'));
if (!usedFredoka || failed.length) {
  await browser.close();
  server.close();
  console.error(`bake-wordmark: refusing to bake${usedFredoka ? '' : ' — Fredoka did not load'}`);
  for (const f of failed) console.error(`  ${f}`);
  process.exit(1);
}

// The element's own box EXCLUDES the stroke, the shadow and the rotation, so a
// screenshot of it clips exactly the parts that make it a sticker. The padded
// body is shot instead, and the padding is what the callers get as margin.
const png = await page.locator('body').screenshot({ omitBackground: true });

// Both shots come off the SAME browser and server; the names below just keep
// the teardown at the end of the file where both are finished with.
const browser2 = browser;
const server2 = server;

const out = join(ROOT, 'public/assets/brand');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'wordmark.png'), png);
console.log(`wordmark -> public/assets/brand/wordmark.png (${png.length} B)`);

// The tile, at its exact required size — no supersampling, because Android TV
// wants 320x180 and anything else is resampled by the launcher.
const tile = await browser2.newPage({
  viewport: { width: BANNER_W, height: BANNER_H },
  deviceScaleFactor: 1
});
await tile.goto(`http://127.0.0.1:${port}/banner.html`, { waitUntil: 'load' });
await tile.evaluate(async (px) => {
  await document.fonts.load(`700 ${px}px Fredoka`);
  await document.fonts.ready;
}, 34);
const bannerPng = await tile.screenshot();
writeFileSync(join(out, 'banner.png'), bannerPng);
console.log(`banner   -> public/assets/brand/banner.png (${bannerPng.length} B, ${BANNER_W}x${BANNER_H})`);
// The tvOS launch image. Same composition as Android's windowBackground —
// deliberately, so a player switching between the two boxes sees one app.
const launch = await browser2.newPage({
  viewport: { width: LAUNCH_W, height: LAUNCH_H },
  deviceScaleFactor: 1
});
await launch.goto(`http://127.0.0.1:${port}/launch.html`, { waitUntil: 'load' });
await launch.evaluate(async () => {
  await document.fonts.load('700 130px Fredoka');
  await document.fonts.ready;
});
const launchPng = await launch.screenshot();
writeFileSync(join(out, 'launch-tv.png'), launchPng);
console.log(`launch   -> public/assets/brand/launch-tv.png (${launchPng.length} B, ${LAUNCH_W}x${LAUNCH_H})`);

// The splash icon.
const icon = await browser2.newPage({
  viewport: { width: ICON, height: ICON },
  deviceScaleFactor: 1
});
await icon.goto(`http://127.0.0.1:${port}/splash-icon.html`, { waitUntil: 'load' });
await icon.evaluate(async () => {
  await document.fonts.load('700 96px Fredoka');
  await document.fonts.ready;
});
const iconPng = await icon.screenshot({ omitBackground: true });
writeFileSync(join(out, 'splash-icon.png'), iconPng);
console.log(`icon     -> public/assets/brand/splash-icon.png (${iconPng.length} B, ${ICON}x${ICON})`);

await browser2.close();
server2.close();
