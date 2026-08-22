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
// THE STEER BAR IS THE ONE THING THAT HAS TO BE TURNED OFF, and it cannot be done
// with CSS: the renderer draws it (voverlay.mat), not the DOM. `cellCards(mask)`
// is the seam that already exists for it — it tells C++ a centred card owns that
// cell, which is how a finished player's steer bar goes away — and Stage only
// re-pushes the mask when its OWN computed value changes, so setting it from out
// here sticks for the rest of the run.
//
// THE ITEM FRAMES ARE SHOT ON A FROZEN SIM. A rocket crosses the visible road in
// a few frames and the showcase spends its held item on its own cooldown, so a
// settle time lands wherever it lands — both item frames came back with no item
// in them. `engine.update` is wrapped instead: sim seconds are counted, and the
// sim is stopped dead at the chosen instant. The pixels are still a real render
// of real sim state; only the clock is ours.
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
  ROOT, args as parseArgs, serveApp, launchBrowser, displayURL, waitForScene, hideChrome, encode
} from './lib/capture.mjs';
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
// WHERE the strip is cut from, as a fraction down the capture. The horizon sits
// high in a chase view, so the window is centred below the middle: sky is the
// part with nothing in it.
//
// The window is always the FULL WIDTH of the capture and as many rows as the
// target aspect needs. Taking it the other way round — fixing the rows and
// widening the columns — is what the first version did, and a 2320x720 strip
// (3.22:1) needs more columns than a 16:9 capture has: the crop ran off both
// sides and createImageBitmap filled the outside with black. The wide variants
// came out with bars down each edge, which the artwork gallery showed within
// minutes of existing.
const CROP_MID = 0.565;

// THE SET. `key` is the TestHarness scenario, `title`/`context` are what the
// carousel item shows over the frame — tvOS supplies the naming, which is the
// second reason none of these carries the wordmark.
const FRAMES = [
  { id: 'cup-beach', key: 'racing', track: 'cove', settle: 7000,
    context: 'Grand Prix', title: 'Beach Cup' },
  { id: 'cup-snow', key: 'racing', track: 'flurry', settle: 9000,
    context: 'Grand Prix', title: 'Snow Cup' },
  { id: 'cup-backyard', key: 'racing', track: 'tangle', settle: 10000,
    context: 'Grand Prix', title: 'Backyard Cup' },
  { id: 'cup-canyon', key: 'racing', track: 'sidewinder', settle: 10500,
    context: 'Grand Prix', title: 'Canyon Cup' },
  { id: 'cup-playroom', key: 'racing', track: 'gauntlet', settle: 9000,
    context: 'Grand Prix', title: 'Playroom Cup' },
  // THE HUD STAYS ON for this one, alone in the set: the split and the four name
  // chips ARE the pitch, and nothing else here says couch multiplayer.
  { id: 'split', key: 'racing', track: 'driftwood', players: 4, settle: 7000, hud: true,
    context: 'Up to four players', title: 'Four phones, one screen' },
  { id: 'countdown', key: 'countdown', track: 'riptide', settle: 1400,
    context: 'Race start', title: 'Ready, set…' },
  // THE WEAKEST OF THE NINE, and knowingly so. The gate is "a monster truck is
  // within a few lengths of the viewer", not "the viewer transformed": the
  // showcase arms whichever car is furthest back, the autopilot on the human seat
  // rarely collects a box, and the stricter conditions (id === 0, or a gap under
  // 3) both wait forever. So the truck lands a few lengths up the road — legible
  // full-screen on a television, small in a contact sheet. Putting it under the
  // camera needs a sim-side hook that does not exist today.
  { id: 'monster', key: 'monster', track: 'skyline', settle: 6000,
    context: 'Items', title: 'Monster truck',
    hold: { after: 0.6, when: `const m = s.cars.find((c) => c.monster), me = s.cars.find((c) => c.id === 0);
            return m && me && Math.abs(m.totalS - me.totalS) < 6;` } },
  // THE IMPACT, NOT THE PROJECTILE. A rocket in flight crosses the visible road in
  // about three frames and photographs as an empty road; the burst happens AT a
  // car, which is where the camera is already pointed. `scene.rocketImpact` is the
  // seam the harness already routes the engine's hit event through, so the wrap
  // below is a listener rather than a guess at when to shoot.
  { id: 'rocket', key: 'rocket', track: 'tangle', settle: 6000,
    context: 'Items', title: 'Rocket strike', onImpact: true,
    hold: { after: 0.09, when: 'return window.__shelfHitAt != null;' } }
];

// Which frame the static 8:3 strip is cut from. The Backyard Cup one: an item box
// in the near lane, four cars, kerbs and hills, and the subject dead centre — so
// it survives losing the top and bottom thirds, which the canyon frame does not.
const STATIC_FROM = 'cup-backyard';

const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
const frames = FRAMES.filter((f) => !only || only.has(f.id));

// One capture: navigate, wait for the scene, silence the chrome, optionally hold
// the sim on a condition, shoot.
async function shoot(page, port, f, scale) {
  await page.goto(displayURL(port, {
    scenario: f.key, players: f.players || 1, dpr: scale, track: f.track
  }), { waitUntil: 'networkidle' });
  await waitForScene(page);

  if (f.hold) {
    await page.evaluate(() => {
      const eng = window.__engine;
      if (eng.__shelfWrapped) return;
      const orig = eng.update.bind(eng);
      window.__simT = 0;
      window.__freeze = false;
      eng.update = (ms) => { if (window.__freeze) return; window.__simT += ms / 1000; return orig(ms); };
      eng.__shelfWrapped = true;
    });
  }
  if (f.onImpact) {
    await page.evaluate(() => {
      const sc = window.__scene;
      const orig = sc.rocketImpact.bind(sc);
      window.__shelfHitAt = null;
      sc.rocketImpact = (id) => {
        if (window.__shelfHitAt == null) window.__shelfHitAt = window.__simT;
        return orig(id);
      };
    });
  }

  await page.waitForTimeout(f.settle);
  await hideChrome(page, { hud: !f.hud });

  if (f.hold) {
    await page.waitForFunction(new Function(`const s = window.__engine.getSnapshot(); ${f.hold.when}`),
      null, { timeout: 120000 });
    // The clock starts at the EVENT, not at the moment the poll noticed it — an
    // impact is instantaneous and the poll can be a frame or two late.
    const t0 = await page.evaluate(() => (window.__shelfHitAt != null ? window.__shelfHitAt : window.__simT));
    await page.waitForFunction(([t0, d]) => window.__simT - t0 >= d, [t0, f.hold.after],
      { timeout: 20000, polling: 16 })
      .catch(() => console.warn(`  ${f.id}: hold never reached ${f.hold.after}s, shooting where it got to`));
    await page.evaluate(() => { window.__freeze = true; });
    await page.waitForTimeout(200);
  }
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
    const src = FRAMES.find((f) => f.id === STATIC_FROM);
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
