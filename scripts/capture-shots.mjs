// Freeze one screenshot per gallery scenario, from the WEB display, into
// public/assets/shots/web/ — the reference column /gallery-shots.html reads the
// tvOS ones against.
//
//   npm run shots:web
//   node scripts/capture-shots.mjs --only lobby,podium --headed
//
// WHY A FROZEN SHOT AT ALL, when /gallery.html already renders every one of these
// live in an iframe: because the second column cannot be live. A tvOS screen only
// exists as a photograph of an Apple TV, so the comparison has to be
// still-against-still or it is not a comparison. The live gallery keeps its job;
// this is a different surface with a different question ("has the TV drifted from
// the web?") and the same scenario table underneath, imported rather than copied
// (public/shared/galleryScenarios.js).
//
// THE READINESS WAIT IS THE WHOLE GAME. `capture-artwork.js` learned this: it
// waits on __scene/__engine and the car count and then document.fonts.ready,
// never on a bare timeout. A cold Filament shader compile behind a plain
// setTimeout produces a gallery of half-loaded scenes, and nobody notices for a
// week because every card still has a picture in it.
//
// WEBP, NOT PNG. The whole table across three platforms at 1080p PNG is tens of
// megabytes, which would undo the deliberate 170 -> 87 MB asset work; at 1280x720
// WebP q80 it is a few. Byte-exactness buys nothing here, because
// nothing diffs these programmatically: this is a human-judgement surface, and
// the automated half is coverage and freshness (tests/shots-manifest.test.js).

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { CAPTURED_SCENARIOS, scenarioQuery } from '../public/shared/galleryScenarios.js';
import { gitSha, mergeShots, shotDir } from './lib/shots.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) =>
    a.startsWith('--') ? [[a.slice(2), all[i + 1]?.startsWith('--') === false ? all[i + 1] : true]] : []
  )
);

// Off the 4000 dev port and off capture-artwork's 4319, so a running dev server
// and a concurrent capture are both undisturbed.
const PORT = parseInt(args.port, 10) || 4327;
// The capture viewport. 1920x1080 matches what the Apple TV's render server
// actually composites (devicectl reports TVOut 1920x1080 on the 4K box), so the
// two columns line up without a rescale in the page.
const WIDTH = parseInt(args.width, 10) || 1920;
const HEIGHT = parseInt(args.height, 10) || 1080;
// Stored at half that. Big enough to judge type and colour on a laptop, small
// enough that the whole gallery is a few MB.
const OUT_W = parseInt(args.outWidth, 10) || 1280;
const OUT_H = Math.round((OUT_W * HEIGHT) / WIDTH);
const PLAYERS = parseInt(args.players, 10) || 4;
// Animated scenarios need the race to develop past the start grid; still ones
// need only their first painted frame.
const SETTLE_MS = parseInt(args.settle, 10) || 2500;

const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
const scenarios = CAPTURED_SCENARIOS.filter((s) => !only || only.has(s.id));

function waitForServer(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function ping() {
      const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => { res.resume(); resolve(); });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`server never came up on :${port}`));
        else setTimeout(ping, 150);
      });
    })();
  });
}

async function main() {
  const dir = shotDir(ROOT, 'web');
  fs.mkdirSync(dir, { recursive: true });

  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), APP_ENV: 'development' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  const killServer = () => { try { server.kill('SIGTERM'); } catch { /* already gone */ } };
  process.on('exit', killServer);

  let browser;
  const entries = [];
  try {
    await waitForServer(PORT);
    browser = await chromium.launch({ headless: !args.headed });
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    page.on('pageerror', (e) => console.error('[page error]', e.message));

    const sha = gitSha(ROOT);
    for (const scenario of scenarios) {
      const q = scenarioQuery(scenario, { players: PLAYERS });
      await page.goto(`http://127.0.0.1:${PORT}/?test=1&${q}`, { waitUntil: 'networkidle' });

      // The harness signals readiness itself for the 3D scenarios. A scenario
      // with no scene (welcome, lobby-empty) never sets __scene, so the wait is
      // conditional rather than universal — and it is a WAIT, not a sleep, for
      // the ones that do.
      await page
        .waitForFunction(() => !window.__harnessNeedsScene || (window.__scene && window.__engine), null,
          { timeout: 20000 })
        .catch(() => console.warn(`  ${scenario.id}: scene wait timed out, shooting anyway`));
      // HIDE THE FRAME-COST READOUT. It shows itself in its constructor, on
      // purpose (a budget is something to keep under your eye, not to remember
      // to switch on) — but this column is the REFERENCE the tvOS and Android
      // columns are read against, and a green diagnostic block over the corner
      // of every race shot is a difference that has nothing to do with the UI
      // under inspection. It was in the committed column until this line.
      // Hiding stops the drawing only; the measurement the adaptive scale reads
      // keeps running (render/PerfHud.js).
      await page.evaluate(() => window.__perf && window.__perf.hide());
      // Text renders in the self-hosted Fredoka face; without this the shot can
      // catch a system fallback and every label is subtly the wrong shape.
      await page.evaluate(() => document.fonts && document.fonts.ready);
      // A scenario's own `settleMs` wins: it names WHICH MOMENT of that screen the
      // card is about, which for the two cup boards is after the re-sort has run.
      await page.waitForTimeout(scenario.settleMs ?? (scenario.animated ? SETTLE_MS : 400));

      const png = await page.screenshot();
      const webp = await toWebp(page, png, OUT_W, OUT_H);
      const file = `${scenario.id}.webp`;
      fs.writeFileSync(path.join(dir, file), webp);
      entries.push({
        scenario: scenario.id,
        platform: 'web',
        file: `web/${file}`,
        w: OUT_W,
        h: OUT_H,
        bytes: webp.length,
        capturedAt: new Date().toISOString(),
        gitSha: sha
      });
      console.log(`  ${scenario.id.padEnd(14)} ${String(webp.length).padStart(7)} B`);
    }
  } finally {
    if (browser) await browser.close();
    killServer();
  }

  // Merge rather than replace: --only must not wipe the platforms and scenarios
  // this run did not touch.
  mergeShots(ROOT, 'web', entries);
  console.log(`==> ${entries.length} web shots -> public/assets/shots/web/`);
}

// Encode in the PAGE. Node has no WebP encoder in core, and adding sharp or
// an ffmpeg shell-out for a dev-only capture is a dependency this repo does not
// need — Chromium already has one, and the bytes come back over the CDP bridge.
async function toWebp(page, pngBuffer, w, h) {
  const b64 = await page.evaluate(
    async ({ data, w, h }) => {
      // Decode base64 by hand: fetching a data: URL is blocked by the page's own
      // connect-src CSP.
      const raw = atob(data);
      const src = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) src[i] = raw.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([src], { type: 'image/png' }),
        { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext('2d').drawImage(bmp, 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    },
    { data: pngBuffer.toString('base64'), w, h }
  );
  return Buffer.from(b64, 'base64');
}

main().catch((e) => { console.error(e); process.exit(1); });
