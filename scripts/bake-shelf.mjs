// Freeze the Apple TV shelf artwork — REAL GAMEPLAY, out of the real display.
//
//   npm run bake:shelf
//   node scripts/bake-shelf.mjs --only canyon,split --headed
//
// WHY THIS IS NOT IN bake-wordmark.mjs. That script bakes TYPE: it renders the
// theme's own `.wordmark` and paper stage in a browser and reads the pixels back,
// and everything it makes is a drawing. The top shelf stopped being a drawing.
// It is the one slot on the Apple TV where a player sees what the game looks like
// before they open it, and a picture of one car on paper is the weakest possible
// answer to that — so the shelf art is a CAPTURE, on the same terms as the car
// thumbnails and the screenshot gallery: run the real page, wait for the real
// scene, photograph it.
//
// TWO PRODUCTS, one capture pass:
//
//   * the CAROUSEL SET — nine 1920x1080 frames for the Top Shelf extension
//     (shells/tvos/TopShelf). tvOS 13's TVTopShelfCarouselContent is full-screen
//     and 16:9, not the 8:3 strip, and Apple asks for five to ten items. Five are
//     one per cup, so the set is the biome ladder; four are situations a cup frame
//     cannot say on its own, the four-way split most of all.
//   * the STATIC BRAND ASSET — the 8:3 `Top Shelf Image` in the asset catalogue,
//     which is what the home row shows when no extension is installed. Cropped
//     from its own taller capture rather than from a carousel frame, so the crop
//     is a downscale at every one of the four sizes the catalogue asks for.
//
// THE FRAMES ARE CARDS (SHELF_FRAMES in shared/galleryScenarios.js), in the store
// listing's shape: a scenario, its params and a `hold` — the race moment, picked in
// the trailer editor (Copy still) and frozen by the engine itself, the same way every
// screenshot card is. Four of them ARE store cards. This file owns only the pixels:
// the sizes, the crop and the encode.
//
// THE AUTOMATION TRAP IS THE SEAM'S PROBLEM NOW: scripts/lib/capture.mjs pins
// ?dpr= and presents the page as an ordinary tab, which is what brings back both
// the full render scale and the sun's shadow bake. See the note there.
//
// THE LAYOUT STAYS AT 1920x1080 and the PIXELS come from deviceScaleFactor, not
// from a bigger viewport: the split-screen frame's HUD is authored against the
// layout size, so a 3840-wide viewport would shrink every chip and badge by half
// against the picture.
//
// JPEG THROUGHOUT, carousel and catalogue alike. These are photographs of a 3D
// scene, and PNG prices them like line art: the four catalogue strips alone came
// to 5 MB as PNG against 1.2 MB at q90, and the nine carousel frames to ~20 MB
// against 0.9 MB. An asset catalogue takes JPEG in an imageset perfectly well —
// the strips were only ever PNG because the paper-stage bake that made them was
// flat colour, which is the one thing PNG is actually for.
import path from 'node:path';
import fs from 'node:fs';
import {
  ROOT, args as parseArgs, serveApp, launchBrowser, waitForScene, hideChrome, encode, HOLD_SETTLE_MS
} from './lib/capture.mjs';
import { SHELF_FRAMES, scenarioQuery } from '../public/shared/galleryScenarios.js';
// The carousel's layout size is a PLATFORM number and lives with the manifest that
// the gallery and the gate read it from, not here (root CLAUDE.md, rule 1).
import { CAROUSEL_SIZE } from '../public/shared/artworkManifest.js';

const args = parseArgs();

// The carousel's own size, in POINTS. The @2x variant is the one an Apple TV 4K
// actually shows — shipping @1x alone is a 2x upscale on every frame, which is
// exactly as soft as it sounds. Both variants come off ONE capture at 2x, so the
// @1x is a supersampled downscale rather than a second, worse render.
const { w: CAR_W, h: CAR_H, scale: CAR_SCALE } = CAROUSEL_SIZE;

// The static strip is cropped from a capture with more pixels than any catalogue
// size asks for, so all four are downscales — the widest it wants is 4640, and
// upscaling 1920 to that is the other visible way to get this wrong.
const STATIC_SCALE = 2.5;
const SRC_W = CAR_W * STATIC_SCALE, SRC_H = CAR_H * STATIC_SCALE;
// WHERE the strip is cut from, as a fraction down the capture. It follows the
// framing of the frame it is cut from: the follow camera looks down on the lead
// car from outside the circuit and puts it a little ABOVE the middle, with empty
// road below it, so the window is centred there.
//
// The window is always the FULL WIDTH of the capture and as many rows as the
// target aspect needs. Taking it the other way round — fixing the rows and
// widening the columns — is what the first version did, and a 2320x720 strip
// (3.22:1) needs more columns than a 16:9 capture has: the crop ran off both
// sides and createImageBitmap filled the outside with black. The wide variants
// came out with bars down each edge, which the artwork gallery showed within
// minutes of existing.
const CROP_MID = 0.42;

// Which frame the static 8:3 strip is cut from. The Backyard Cup one: the leader
// sliding through a bend with the pack and the finish gantry behind it, all in a
// band the strip keeps.
const STATIC_FROM = 'cup-backyard';

const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
const frames = SHELF_FRAMES.filter((f) => !only || only.has(f.id));

// One capture: navigate, wait for the engine to hold the card's moment, shoot. The
// settle after the hold is the chase camera closing its lag behind the stopped car,
// which is the picture the editor's still previews.
async function shoot(page, port, f, scale) {
  await page.goto(`http://127.0.0.1:${port}/?test=1&dpr=${scale}&${scenarioQuery(f)}`,
    { waitUntil: 'networkidle' });
  await waitForScene(page);
  await hideChrome(page);
  await page.waitForFunction(() => window.__engine?.shotHeld, null, { timeout: 180000, polling: 100 });
  await page.waitForTimeout(HOLD_SETTLE_MS);
  return page.screenshot();
}

async function main() {
  const shelfDir = path.join(ROOT, 'public/assets/brand/tv/shelf');
  const brandDir = path.join(ROOT, 'public/assets/brand/tv');
  fs.mkdirSync(shelfDir, { recursive: true });

  const server = await serveApp();
  let chrome;
  try {
    chrome = await launchBrowser({ headed: !!args.headed });
    // One page per scale: deviceScaleFactor is fixed at construction, and it has
    // to agree with the ?dpr= the scene renders at or the screenshot resamples.
    const page = await chrome.page({
      viewport: { width: CAR_W, height: CAR_H }, deviceScaleFactor: CAR_SCALE
    });

    const manifest = [];
    for (const f of frames) {
      const png = await shoot(page, server.port, f, CAR_SCALE);
      for (const [w, h, suffix] of [
        [CAR_W * CAR_SCALE, CAR_H * CAR_SCALE, '@2x'],
        [CAR_W, CAR_H, '']
      ]) {
        const jpg = await encode(page, png, { width: w, height: h, quality: 0.88 });
        fs.writeFileSync(path.join(shelfDir, `${f.id}${suffix}.jpg`), jpg);
        console.log(`  ${(f.id + suffix).padEnd(17)} ${String(jpg.length).padStart(7)} B  ${w}x${h}`);
      }
      manifest.push({ id: f.id, context: f.context, title: f.title });
    }

    // The carousel's own running order, read by the Top Shelf extension. The order
    // IS the cup ladder followed by the situations, and it lives here rather than
    // in Swift so the frames and their titles cannot drift apart.
    if (!only) {
      fs.writeFileSync(path.join(shelfDir, 'carousel.json'),
        `${JSON.stringify({ items: manifest }, null, 2)}\n`);
      console.log(`  carousel.json  ${manifest.length} items`);
    }

    // ---- the static 8:3 strip, at the four sizes the catalogue asks for -------
    const src = SHELF_FRAMES.find((f) => f.id === STATIC_FROM);
    if (!only || only.has(STATIC_FROM)) {
      const wide = await chrome.page({
        viewport: { width: CAR_W, height: CAR_H }, deviceScaleFactor: STATIC_SCALE
      });
      const big = await shoot(wide, server.port, src, STATIC_SCALE);
      for (const [w, h, file] of [
        [1920, 720, 'topshelf.jpg'],
        [3840, 1440, 'topshelf@2x.jpg'],
        [2320, 720, 'topshelf-wide.jpg'],
        [4640, 1440, 'topshelf-wide@2x.jpg']
      ]) {
        // Full width, and the rows the target aspect asks for — so the wide pair
        // is a SHORTER window of the same picture rather than a stretch of the
        // 16:9 one, and no crop can leave the capture.
        const sw = SRC_W;
        const sx = 0;
        const sh = Math.round((SRC_W * h) / w);
        const sy = Math.max(0, Math.min(SRC_H - sh, Math.round(CROP_MID * SRC_H - sh / 2)));
        const buf = await encode(wide, big, { width: w, height: h, quality: 0.9, crop: { sx, sy, sw, sh } });
        fs.writeFileSync(path.join(brandDir, file), buf);
        console.log(`  ${file.padEnd(22)} ${String(buf.length).padStart(7)} B  ${w}x${h}`);
      }
      await wide.close();
    }
  } finally {
    if (chrome) await chrome.close();
    server.close();
  }
  console.log('==> public/assets/brand/tv/shelf/ + the four catalogue strips');
}

main().catch((e) => { console.error(e); process.exit(1); });
