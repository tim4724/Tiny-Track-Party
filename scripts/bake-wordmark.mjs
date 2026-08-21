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
// THE CAR, and why a PNG rather than more CSS. The subject of the icon and the
// banner is one of the roster's own GLBs, rendered by the same offline harness
// the lobby thumbnails use (scripts/capture-car-thumbs.js) so the car on the
// launcher is the car in the game rather than a drawing of one:
//
//   node scripts/capture-car-thumbs.js --name vehicle-speedster \
//     --yaw 240 --pitch 23 --size 2048 --aspect 1.0 --frames 1 --bias 0 \
//     --out public/assets/brand/car-hero.png
//
// The angle is not arbitrary and is the one thing here worth not re-deriving.
// 0 and 180 degrees of yaw are the two head-on views and both collapse to a bar;
// the readable range is the front three-quarters, which comes as a mirrored pair
// (~135 nose-left, ~240 nose-right). 240 is chosen because the banner sets the
// car LEFT of the wordmark, so a nose-right car drives into the type while its
// mirror drives out of frame. Pitch 23 is the harness default: lower flattens
// this car's low body into a bar, higher foreshortens it.
//
// Baked and committed rather than rendered here, like the fonts staged for
// Android: the 3D harness needs the GLB, the lighting and a served origin, and
// this script only needs the pixels.
const CAR = '/assets/brand/car-hero.png';

// The paper stage, re-proportioned for a SQUARE. Both rules here fix the same
// kind of thing: `.scene` is authored for a 16:9 board, and two of its parts are
// placed in PERCENTAGES OF A WIDE BOX. Neither is a disagreement with the theme,
// so neither belongs in theme.css.
//
//   * the grass band's 22% vertical radius domes into a lozenge on a square,
//     leaving paper at the bottom corners;
//   * the sky's two pale-green sticker clouds sit at `bottom: 9-11%`, which on a
//     wide board is sky above the grass and on a square lands ON the grass,
//     right behind the car, where they read as a smudge rather than as clouds.
//
// The clouds are dropped rather than moved: at the size a launcher draws this,
// there is no room for weather behind the subject.
const SCENE_SQ = `
    .scene__grass { left: -26%; right: -26%; height: 22%;
                    border-radius: 50% 50% 0 0 / 10% 10% 0 0; }
    .scene__sky::before, .scene__sky::after { display: none; }`;

// THE BANNER. The car breaks the left edge, the wordmark sits right. Full bleed:
// the launcher draws its own card behind this, so the tile supplies no border.
const BANNER = `<!doctype html>
  <link rel="stylesheet" href="/shared/theme.css">
  <style>
    html, body { margin: 0; }
    body { width: ${BANNER_W}px; height: ${BANNER_H}px; position: relative; overflow: hidden; }
    .scene { position: absolute; inset: 0; }
    .car { position: absolute; left: -32px; bottom: -6px; width: 205px; }
    .mark { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); }
    /* 28px is what leaves the two lines, the die-cut edge and the shadow inside
       the frame once the car has taken the left half. */
    .wordmark { font-size: 28px; }
  </style>
  <div class="scene">
    <div class="scene__sky"></div>
    <div class="scene__grass"></div>
  </div>
  <img class="car" src="${CAR}" alt="">
  <div class="mark">
    <div class="wordmark"><span>TINY TRACK</span><span class="l2">PARTY!</span></div>
  </div>`;

// THE SQUARE ICON: app icon, apple-touch icon and favicon, one composition at
// three sizes. FULL BLEED and un-rounded on purpose — every platform that shows
// it masks it to its own shape, so a corner radius baked in here would sit
// inside the launcher's own and read as a ring.
const ICON_SQ = (px) => `<!doctype html>
  <link rel="stylesheet" href="/shared/theme.css">
  <style>
    html, body { margin: 0; }
    body { width: ${px}px; height: ${px}px; position: relative; overflow: hidden;
           background: var(--paper); }
    .scene { position: absolute; inset: 0; }
    ${SCENE_SQ}
    /* Sits ON the grass line rather than centred in the box: the hero is baked
       with its ground shadow, and the shadow wants a floor under it. */
    .car { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
           width: 86%; }
  </style>
  <div class="scene">
    <div class="scene__sky"></div>
    <div class="scene__grass"></div>
  </div>
  <img class="car" src="${CAR}" alt="">`;

// ---------------------------------------------------------------------------
// tvOS BRAND ASSETS
//
// The Apple TV shell had no app icon at all — the catalogue carried a launch
// image and nothing else — so the home screen drew the platform placeholder.
// It cannot take the square icon either, for two reasons that shape everything
// below:
//
//   * a tvOS app icon is WIDE (400x240 and 1280x768, both 5:3), not square;
//   * it is a LAYERED image stack, not a picture. The system separates the
//     layers as focus moves across the icon, so what would be one flat PNG is
//     three: paper behind, grass between, car in front. That parallax is the
//     whole reason the platform asks for a stack, and a single-layer stack
//     looks dead beside every other icon on the shelf.
//
// The TOP SHELF images are a different job again — the wide feature banner the
// home row shows for the frontmost app — so they carry the wordmark, which the
// icon deliberately does not (type in an app icon is Apple's own vetoed list).
//
// WHERE THE CAR SITS is computed rather than eyeballed, because these frames
// have four different aspect ratios and a hand-fitted percentage that works on
// one is wrong on the rest. The hero's own content box, measured off the bake
// and identical at every size it is rendered at:
const CAR_BODY_W = 0.8906;      // body width as a fraction of the hero's square
const CAR_BODY_BOTTOM = 0.8027; // where the wheels sit in that square

// Place the hero so its BODY (not its transparent frame, and not its ground
// shadow) is `bodyW` of the target width with the wheels at `bottom` of the
// target height. Answers the two CSS lengths that positions it.
function carBox(w, h, bodyW, bottom) {
  const size = (bodyW * w) / CAR_BODY_W;
  return { size, top: bottom * h - CAR_BODY_BOTTOM * size };
}

// The paper stage at a wide-but-not-16:9 aspect. Same class of override as
// SCENE_SQ and for the same reason: the grass band is placed in percentages of
// the box, so its height has to be restated per aspect. The clouds go for the
// icon (small, and they sit behind the subject) and stay for the top shelf,
// which is big enough to carry them.
const SCENE_TV = (grassPct, flat) => `
    .scene__grass { left: -20%; right: -20%; height: ${grassPct}%;
                    ${flat ? 'border-radius: 50% 50% 0 0 / 12% 12% 0 0;' : ''} }`;

// ONE LAYER of the app icon stack. `layer` is back | middle | front — the
// theme's sky, its grass band, the car — and the three composite back-to-front
// into the same picture the square icon shows flat, which is the test that the
// split is a split and not a redraw. The back layer takes the REAL `.scene__sky`
// rather than a flat fill, so its warm glow matches the square icon's.
const TV_ICON_LAYER = (w, h, layer) => {
  const car = carBox(w, h, 0.60, 0.74);
  return `<!doctype html>
  <link rel="stylesheet" href="/shared/theme.css">
  <style>
    html, body { margin: 0; }
    body { width: ${w}px; height: ${h}px; position: relative; overflow: hidden;
           background: ${layer === 'back' ? 'var(--paper)' : 'transparent'}; }
    .scene { position: absolute; inset: 0; }
    ${SCENE_TV(28, true)}
    .scene__sky::before, .scene__sky::after { display: none; }
    .car { position: absolute; left: 50%; transform: translateX(-50%);
           top: ${car.top.toFixed(1)}px; width: ${car.size.toFixed(1)}px; }
  </style>
  ${layer === 'back' ? '<div class="scene"><div class="scene__sky"></div></div>' : ''}
  ${layer === 'middle' ? '<div class="scene"><div class="scene__grass"></div></div>' : ''}
  ${layer === 'front' ? `<img class="car" src="${CAR}" alt="">` : ''}`;
};

// THE TOP SHELF banner. Much wider than the launcher tile (8:3 and 3.2:1
// against 16:9), so the car takes the left third and the wordmark the middle
// rather than the two splitting the frame in half.
//
// The wordmark is sized as a FRACTION OF THE HEIGHT and the @2x variant is the
// same page at deviceScaleFactor 2, never a bigger font on a bigger canvas:
// `-webkit-text-stroke` is a fixed 7px, so the die-cut edge is a proportion of
// the font-size and of nothing else, and re-typing it larger would thin the cut
// on the very asset that shows it biggest. Same reasoning as FONT_PX above.
const TV_TOPSHELF = (w, h) => {
  const car = carBox(w, h, 0.29, 0.82);
  return `<!doctype html>
  <link rel="stylesheet" href="/shared/theme.css">
  <style>
    html, body { margin: 0; }
    body { width: ${w}px; height: ${h}px; position: relative; overflow: hidden; }
    .scene { position: absolute; inset: 0; }
    ${SCENE_TV(26)}
    .car { position: absolute; left: ${(0.09 * w - 0.043 * car.size).toFixed(1)}px;
           top: ${car.top.toFixed(1)}px; width: ${car.size.toFixed(1)}px; }
    .mark { position: absolute; left: ${(0.45 * w).toFixed(0)}px; top: 50%;
            transform: translateY(-50%); }
    .wordmark { font-size: ${Math.round(h * 0.155)}px; }
  </style>
  <div class="scene">
    <div class="scene__sky"></div>
    <div class="scene__grass"></div>
  </div>
  <img class="car" src="${CAR}" alt="">
  <div class="mark">
    <div class="wordmark"><span>TINY TRACK</span><span class="l2">PARTY!</span></div>
  </div>`;
};

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
                    '/splash-icon.html': SPLASH_ICON,
                    '/icon-1024.html': ICON_SQ(1024), '/icon-512.html': ICON_SQ(512),
                    '/icon-180.html': ICON_SQ(180), '/icon-32.html': ICON_SQ(32),
                    '/tv-store-back.html': TV_ICON_LAYER(1280, 768, 'back'),
                    '/tv-store-middle.html': TV_ICON_LAYER(1280, 768, 'middle'),
                    '/tv-store-front.html': TV_ICON_LAYER(1280, 768, 'front'),
                    '/tv-icon-back.html': TV_ICON_LAYER(400, 240, 'back'),
                    '/tv-icon-middle.html': TV_ICON_LAYER(400, 240, 'middle'),
                    '/tv-icon-front.html': TV_ICON_LAYER(400, 240, 'front'),
                    '/tv-topshelf.html': TV_TOPSHELF(1920, 720),
                    '/tv-topshelf-wide.html': TV_TOPSHELF(2320, 720) };
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

// THE SQUARE ICON, at the three sizes its consumers ask for. Each is RENDERED at
// its own size rather than downscaled from one master: the car is a photograph of
// a model and the grass is a CSS shape, and letting the browser lay both out at
// the target size keeps the band's curve and the car's edges crisp at 32 instead
// of resampling a 512 down by 16x.
//
// The web pair goes to public/assets/icon/ (where the pages link it) and the
// 512 to public/assets/brand/ (where the Android staging reads it), so each
// consumer keeps reading the directory it already reads.
const webOut = join(ROOT, 'public/assets/icon');
mkdirSync(webOut, { recursive: true });
for (const [px, dest, label] of [
  // 1024 is the MASTER and a store asset, not a shipped drawable: Play wants 512
  // and the App Store 1024, while the biggest slot either TV launcher draws is a
  // few hundred px. Putting 1024 in the APK would be four times the bytes for a
  // picture nothing renders at that size.
  [1024, join(out, 'icon-1024.png'), 'public/assets/brand/icon-1024.png'],
  [512, join(out, 'icon.png'), 'public/assets/brand/icon.png'],
  [180, join(webOut, 'apple-touch-icon.png'), 'public/assets/icon/apple-touch-icon.png'],
  [32, join(webOut, 'favicon-32.png'), 'public/assets/icon/favicon-32.png']
]) {
  const page = await browser2.newPage({ viewport: { width: px, height: px }, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${port}/icon-${px}.html`, { waitUntil: 'load' });
  const buf = await page.screenshot();
  writeFileSync(dest, buf);
  console.log(`icon${String(px).padStart(4)} -> ${label} (${buf.length} B, ${px}x${px})`);
  await page.close();
}

// THE tvOS BRAND ASSETS. Three layers per icon stack, two top-shelf crops, and
// the @2x variants are the SAME PAGE at deviceScaleFactor 2 rather than a second
// layout at twice the numbers — so a 1x and a 2x asset cannot drift apart, and
// the wordmark's fixed text-stroke keeps its proportion (see TV_TOPSHELF).
//
// Layers other than `back` are shot with omitBackground: the stack composites
// them, so anything opaque behind the grass or the car would hide the layer
// under it and kill the parallax the format exists for.
const tvOut = join(out, 'tv');
mkdirSync(tvOut, { recursive: true });
for (const [page, w, h, scale, file] of [
  ['tv-store-back', 1280, 768, 1, 'icon-store-back.png'],
  ['tv-store-middle', 1280, 768, 1, 'icon-store-middle.png'],
  ['tv-store-front', 1280, 768, 1, 'icon-store-front.png'],
  ['tv-icon-back', 400, 240, 1, 'icon-back.png'],
  ['tv-icon-middle', 400, 240, 1, 'icon-middle.png'],
  ['tv-icon-front', 400, 240, 1, 'icon-front.png'],
  ['tv-icon-back', 400, 240, 2, 'icon-back@2x.png'],
  ['tv-icon-middle', 400, 240, 2, 'icon-middle@2x.png'],
  ['tv-icon-front', 400, 240, 2, 'icon-front@2x.png'],
  ['tv-topshelf', 1920, 720, 1, 'topshelf.png'],
  ['tv-topshelf', 1920, 720, 2, 'topshelf@2x.png'],
  ['tv-topshelf-wide', 2320, 720, 1, 'topshelf-wide.png'],
  ['tv-topshelf-wide', 2320, 720, 2, 'topshelf-wide@2x.png']
]) {
  const tp = await browser2.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
  await tp.goto(`http://127.0.0.1:${port}/${page}.html`, { waitUntil: 'load' });
  await tp.evaluate(async () => { await document.fonts.load('700 130px Fredoka'); await document.fonts.ready; });
  const buf = await tp.screenshot({ omitBackground: !file.includes('back') && !file.includes('topshelf') });
  writeFileSync(join(tvOut, file), buf);
  console.log(`tv       -> public/assets/brand/tv/${file} (${buf.length} B, ${w * scale}x${h * scale})`);
  await tp.close();
}

await browser2.close();
server2.close();
