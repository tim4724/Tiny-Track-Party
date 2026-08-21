'use strict';

// Capture a 2x2 split-screen hero shot of a 4-player race for the artwork/ dir.
//
// There's no E2E harness, but the display already renders itself in isolation
// from fake data: `/?test=1&scenario=racing&players=4` stands up the real
// scene with four self-driving cars — one per CAR_MODELS slot, so the field shows
// four DIFFERENT models — laid out in the same split-screen grid the live game
// uses (bestGrid(4, 16:9) = 2x2). This script spins up the static server, drives
// that page in headless Chromium at a 16:9 viewport, lets the race develop for a
// beat so the cars spread along the track, and screenshots the canvas to a PNG.
//
//   node scripts/capture-artwork.js                  # → artwork/splitscreen-4p.png (1920x1080, 2x SSAA)
//   node scripts/capture-artwork.js --track skysnake # a different layout (and so a different BIOME)
//   node scripts/capture-artwork.js --width 2560 --height 1440 --wait 30000
//   node scripts/capture-artwork.js --ss 1           # no supersampling (1:1 native render)
//   node scripts/capture-artwork.js --out artwork/hero.png
//
// --track takes a CATALOGUE id (shared/tracks.js's CUPS), and picking one picks the
// biome with it — the look is resolved from the track's own cup. An id that isn't in
// the catalogue is NOT an error: main.js falls back to the first track, so a stale
// name here would quietly shoot a different scene than the flag asks for.
//
// Edges are antialiased by supersampling: the page renders at SS× the target and
// the shot is downscaled back to WIDTHxHEIGHT in-browser, so SS=2 means a 4K
// render → 1080p. The CSS layout viewport stays WIDTHxHEIGHT throughout, so
// composition never depends on SS. TWO SCALES GET THERE, and they are not the
// same knob: deviceScaleFactor=SS rasterizes the DOM half (the HUD chips) and
// fixes the screenshot's size, while the 3D half is the canvas backing store,
// which Stage sizes from its OWN dpr — RACE_DPR while the race runs, then
// SHOT_DPR for the frame that gets shot. The renderer caps its pixel ratio at 2,
// which is why SHOT_DPR is min(SS, 2): SS above 2 still supersamples the chrome,
// but cannot sharpen the 3D any further.
//
// Flags (all optional): --out, --width, --height, --players, --track, --scenario,
// --ss (supersample factor, default 2), --wait (ms before the shot), --port, --headed.

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');

// --- tiny flag parser: --key value, plus boolean --headed ---
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'headed') { out.headed = true; continue; }
    out[key] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const WIDTH = parseInt(args.width, 10) || 1920;       // 16:9 by default
const HEIGHT = parseInt(args.height, 10) || 1080;
const PLAYERS = parseInt(args.players, 10) || 4;       // 4 → 2x2 grid
const TRACK = args.track || 'ribbon';                  // Backyard Cup — the canonical grass look
const SCENARIO = args.scenario || 'racing';
const WAIT_MS = parseInt(args.wait, 10) || 20000;      // let the race actually develop
// 20 s, not 4: at 4 s the field is still stacked three-deep off the grid, so half the
// cells shoot a camera buried in the car in front, and the places still read 1-2-3-4
// down the grid — a starting line, not a race. By 20 s the bots have strung out, the
// order has shuffled, and each cell frames its own piece of track. It is one LAP of
// three either way. Nothing here is seeded, so framing still varies run to run: the
// shot is worth a couple of rolls. Re-check this if the AI or the default track moves.
const SS = Math.max(1, parseInt(args.ss, 10) || 2);    // supersample factor (2 → 4K render → 1080p)
const PORT = parseInt(args.port, 10) || 4319;          // off the default 4000 dev port
// The two render scales, and the whole reason there are two. Headless Chromium
// rasterizes through SwiftShader, where the CPU is the fill rate: the 3840x2160
// buffer this shot wants measures 0.58 fps. That is not just slow, it stops the
// race — Stage's _loop clamps dt to 50 ms per frame, so at 0.58 fps twenty
// seconds of wall clock advances the sim by 0.6 s and the field never leaves the
// grid. At 0.25 the same twenty seconds is a real twenty seconds of racing.
// Nothing is lost by racing small: the last thing before the screenshot is
// setRenderScale(SHOT_DPR), and the shot is the frame drawn AFTER it.
const RACE_DPR = 0.25;
const SHOT_DPR = Math.min(SS, 2);                      // the renderer's own pixel-ratio cap
const OUT = path.resolve(ROOT, args.out || 'artwork/splitscreen-4p.png');

// Poll the server root until it answers (or time out).
function waitForServer(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function ping() {
      const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`server never came up on :${port}`));
        else setTimeout(ping, 150);
      });
    })();
  });
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  // Own static server on its own port so a running dev server isn't disturbed.
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), APP_ENV: 'development' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const killServer = () => { try { server.kill('SIGTERM'); } catch (_) {} };
  process.on('exit', killServer);

  let browser;
  try {
    await waitForServer(PORT);

    browser = await chromium.launch({ headless: !args.headed });
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT }, // CSS layout px — fixes composition
      deviceScaleFactor: SS, // render (WebGL + HUD) at SS× for supersampling; shot is SS·WIDTH × SS·HEIGHT
    });
    page.on('pageerror', (e) => console.error('[page error]', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });

    // THE DISPLAY CLAMPS ITSELF UNDER AUTOMATION, and both clamps ruin a hero shot.
    // Stage.js reads navigator.webdriver and (a) drops the render scale to dpr 0.25
    // — a 1/16th-fragment budget for the E2E suite, which asserts DOM and engine
    // state and never looks at a pixel — and (b) skips the sun's shadow bake. At
    // 1920x1080 that is a 480x270 drawing buffer stretched back up: crisp DOM chrome
    // over mush, which is what the README carried until 2026-07-30. This capture is
    // NOT the suite and wants the shipping render path, so it presents as an ordinary
    // tab. (?dpr= would lift the resolution alone; the shadow skip has no URL knob,
    // and there is no reason for a screenshot to run either of the suite's budgets.)
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // RACE CHEAP, SHOOT SHARP — see the RACE_DPR / SHOT_DPR note above for why the
    // whole run cannot simply be at full scale.
    const url = `http://127.0.0.1:${PORT}/?test=1&scenario=${SCENARIO}` +
      `&players=${PLAYERS}&track=${TRACK}&dpr=${RACE_DPR}`;
    await page.goto(url, { waitUntil: 'networkidle' });

    // The harness builds the engine + scene cars once the GLBs load; wait for the
    // full field to exist before shooting. (There is no GL context to interrogate
    // from here any more — the renderer is native and owns its own; a lost context
    // shows up as the scene never reaching PLAYERS cars, which this already times
    // out on.)
    await page.waitForFunction((n) => {
      const s = window.__scene, e = window.__engine;
      return !!(s && e && s.cars.size >= n);
    }, PLAYERS, { timeout: 20000 });

    // The HUD chips render with the self-hosted Fredoka face — wait so text
    // isn't a fallback.
    await page.evaluate(() => document.fonts && document.fonts.ready);

    // Page chrome that is not the GAME: the fullscreen/pause corner buttons (which
    // sit ON TOP of the top-right cell's place chip — in a 2x2 grid the expand icon
    // lands square on "1st"), the dev panel's gear FAB, and the two bottom-left
    // pills, which in the harness have no content and shoot as a stray dark dot.
    // Hidden rather than avoided, because where they land depends on the grid the
    // player count picks.
    await page.evaluate(() => {
      for (const sel of ['#corner-btns', '.dbg-fab', '#music-credit', '#sound-hint', '#toast']) {
        for (const node of document.querySelectorAll(sel)) node.style.display = 'none';
      }
    });

    // Let the self-driving race run a beat so cars fan out along the track rather
    // than sitting stacked on the start grid. This part runs at RACE_DPR.
    await page.waitForTimeout(WAIT_MS);

    // Now lift the render scale for the shot itself, and let the renderer actually
    // DRAW at it: the resize reallocates (and clears) the drawing buffer, and a
    // 3840x2160 frame takes over a second here, so screenshotting straight after
    // the call captures an empty canvas. Three frames, with a ceiling so a stalled
    // loop fails as a blank shot rather than a hung script.
    await page.evaluate((dpr) => window.__scene.setRenderScale(dpr), SHOT_DPR);
    await page.evaluate(() => new Promise((done) => {
      let n = 0;
      const tick = () => (++n >= 3 ? done() : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
      setTimeout(done, 30000);
    }));

    // A clamped render surface is SILENT — it still shoots a perfectly valid PNG,
    // just a soft one — so assert the drawing buffer rather than trusting it.
    const wantWide = WIDTH * SHOT_DPR;
    const surface = await page.evaluate(() => {
      const c = document.getElementById('scene-canvas');
      return c && { w: c.width, h: c.height };
    });
    if (!surface) throw new Error('no #scene-canvas — the display never booted its renderer');
    if (surface.w < wantWide) {
      throw new Error(`render surface is ${surface.w}x${surface.h}, wanted ${wantWide} wide — ` +
        'the display clamped its resolution (Stage.js drops to dpr 0.25 under automation)');
    }

    if (SS === 1) {
      await page.screenshot({ path: OUT }); // native render, no downscale
    } else {
      // Shot is SS·WIDTH × SS·HEIGHT; downscale to WIDTHxHEIGHT in-browser with a
      // high-quality filter (createImageBitmap resizeQuality) for clean edges.
      const bigPng = await page.screenshot();
      const downscaled = await page.evaluate(async ({ b64, w, h }) => {
        // Decode base64 → bytes by hand (a fetch of a data: URL is blocked by the
        // page's connect-src CSP), then build the source bitmap from a Blob.
        const raw = atob(b64);
        const src = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) src[i] = raw.charCodeAt(i);
        const blob = new Blob([src], { type: 'image/png' });
        const bmp = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
        const canvas = new OffscreenCanvas(w, h);
        canvas.getContext('2d').drawImage(bmp, 0, 0);
        const outBlob = await canvas.convertToBlob({ type: 'image/png' });
        const bytes = new Uint8Array(await outBlob.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
      }, { b64: bigPng.toString('base64'), w: WIDTH, h: HEIGHT });
      fs.writeFileSync(OUT, Buffer.from(downscaled, 'base64'));
    }
    const note = SS === 1 ? '' : ` (${SS}x SSAA from ${WIDTH * SS}x${HEIGHT * SS})`;
    console.log(`Captured ${PLAYERS}-player ${WIDTH}x${HEIGHT} split-screen${note} → ${path.relative(ROOT, OUT)}`);
  } finally {
    if (browser) await browser.close();
    killServer();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
