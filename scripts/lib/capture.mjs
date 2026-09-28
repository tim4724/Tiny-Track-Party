// The one way to photograph this game from Node.
//
// Every offline bake in this repo does the same four things — pick a port, stand
// up a server, drive Playwright at the real page, read pixels back — and until
// this module each of them did all four its own way. That was not a tidiness
// problem. Two of the four have a trap in them that is INVISIBLE when you get it
// wrong, and both had already been fallen into:
//
//   THE AUTOMATION TRAP.  Stage.js changes two things when `navigator.webdriver`
//   is set, and it is right to: the E2E suite asserts DOM and engine state, never
//   pixels, so it renders at a quarter scale with the sun's shadow bake skipped
//   and finishes in a fraction of the time. A CAPTURE script is webdriver too,
//   and wants neither. `?dpr=` lifts the render scale — the shadow skip has no
//   URL knob at all, so the only way back is to make the page believe it is an
//   ordinary tab. Three scripts each solved some part of this differently and
//   `capture-shots` solved none of it, which is why the web column of the
//   cross-platform gallery was a quarter-scale, shadowless render being compared
//   against photographs of real televisions.
//
//   THE PORT TRAP.  This tree is worked in many worktrees at once (see the root
//   CLAUDE.md). A literal port number is therefore a coin flip: the capture will
//   happily connect to ANOTHER worktree's dev server and photograph a different
//   branch, with no error anywhere and pictures that look entirely plausible.
//   That happened during the shelf work. Every port here is allocated.
//
// WHAT THIS DOES NOT DO. It does not own the shot. Framing, settling, what to
// hide and when to fire the shutter are the caller's business and differ wildly
// between a favicon and a trailer frame. This is the plumbing only.
//
// THE BENCHES (perf-race's web backend, perf-features) take only serveApp from
// here. Their browser stays their own: each owns its headed lifecycle, console
// wiring and readout gating, and spoofs `navigator.webdriver` false itself
// exactly as launchBrowser would — under the automation defaults a bench would
// measure a different renderer (quarter scale, no shadow bake).
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg'
};

// A port the OS just told us is free. There is a race between closing this and
// the child binding it, and it is the right trade: the alternative is a literal,
// which in a many-worktree tree is not a race but a standing collision.
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function waitFor(port, timeoutMs = 20000) {
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

// THE REAL APP, on a port nothing else has. For anything that drives the actual
// display or controller page.
export async function serveApp({ port } = {}) {
  const p = port || await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(p), APP_ENV: 'development' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  // A spawn that cannot bind must be fatal HERE. Left unhandled it is the port
  // trap's nastiest form: the child dies, the wait below succeeds against
  // somebody else's server, and the bake completes with the wrong pictures.
  let died = null;
  child.on('error', (e) => { died = e; });
  child.on('exit', (code) => { if (code) died = new Error(`server exited with ${code}`); });
  const close = () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } };
  process.on('exit', close);
  try {
    await waitFor(p);
  } catch (e) {
    close();
    throw e;
  }
  if (died) { close(); throw died; }
  return { port: p, close };
}

// SYNTHETIC PAGES over the real asset tree — the wordmark bake's arrangement,
// where the document is ours but the stylesheet, the fonts and the images have to
// be same-origin with it or a woff2 never arrives and the mark bakes in a
// fallback sans (which a PNG cannot tell you about).
//
// `pages` maps a path to HTML. Everything else is served from public/.
export async function servePages(pages, { root = path.join(ROOT, 'public') } = {}) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    if (pages[rel]) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(pages[rel]);
      return;
    }
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  return { port, close: () => server.close() };
}

// A browser whose pages present as an ORDINARY TAB. See the automation trap above:
// this is the only thing that brings the sun's shadow bake back, and it has to be
// an init script because Stage.js reads `navigator.webdriver` during construction.
//
// `realUser: false` opts out, for a caller that genuinely wants the automation
// path (lobby-fit-check, which measures the DOM rather than pixels and runs
// under webdriver in E2E anyway).
export async function launchBrowser({ realUser = true, headed = false } = {}) {
  const browser = await chromium.launch({ headless: !headed });
  async function context(opts = {}) {
    const ctx = await browser.newContext(opts);
    if (realUser) {
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });
    }
    return ctx;
  }
  // The common case: one context, one page, and a loud console.
  async function page(opts = {}) {
    const ctx = await context(opts);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => console.error('[page error]', e.message));
    return p;
  }
  return { browser, context, page, close: () => browser.close() };
}

// The display page's own URL, with the capture defaults already on it. `dpr` is
// the render scale REQUEST — it beats devicePixelRatio, the automation cap and
// the renderer's buffer-height cap alike, and it must agree with the context's
// deviceScaleFactor or the screenshot resamples what the scene drew.
export function displayURL(port, { scenario, players = 1, dpr = 1, ...params } = {}) {
  const q = new URLSearchParams({ test: '1' });
  if (scenario) q.set('scenario', scenario);
  q.set('players', String(players));
  q.set('dpr', String(dpr));
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    q.set(k, String(v));
  }
  return `http://127.0.0.1:${port}/?${q}`;
}

// Wait for the scene the harness signals, then for the fonts. A scenario with no
// 3D (welcome, the lobby boards) never sets `__scene`, so the scene half is
// conditional — and it is a WAIT, not a sleep, for the ones that do: a cold
// Filament shader compile behind a bare setTimeout produces a gallery of
// half-loaded scenes and nobody notices for a week.
export async function waitForScene(page, { timeout = 30000 } = {}) {
  await page
    .waitForFunction(() => !window.__harnessNeedsScene || (window.__scene && window.__engine),
      null, { timeout })
    .catch(() => console.warn('  scene wait timed out, carrying on'));
  await page.evaluate(() => document.fonts && document.fonts.ready);
}

// The renderer draws the steer bar (voverlay.mat), not the DOM, so CSS cannot
// hide it. `cellCards` is the seam that already exists for it: it tells C++ a
// centred card owns that cell, which is how a finished player's bar goes away.
// Stage only re-pushes the mask when its OWN computed value changes, so setting
// it from out here sticks for the rest of the run.
const HUD_SELECTORS = ['.cell-label', '.cell-rank', '.cell-finish'];
const CHROME_SELECTORS = ['#corner-btns', '#sound-hint', '#toast'];

export async function hideChrome(page, { hud = true } = {}) {
  if (hud) await page.evaluate(() => window.__scene?.display?.cellCards?.(0xF));
  const sel = [...CHROME_SELECTORS, ...(hud ? HUD_SELECTORS : [])];
  await page.addStyleTag({ content: `${sel.join(', ')} { display: none !important; }` });
}

// Encode in the PAGE. Node has no JPEG or WebP encoder in core and Chromium
// already has both, so the bytes come back over the CDP bridge rather than adding
// an image dependency for a dev-only capture. `crop` is a source rectangle
// {sx, sy, sw, sh}; omit it to take the whole shot.
export async function encode(page, pngBuffer, { width, height, type = 'image/jpeg', quality, crop = null }) {
  const b64 = await page.evaluate(
    async ({ data, w, h, type, quality, crop }) => {
      const raw = atob(data);
      const src = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) src[i] = raw.charCodeAt(i);
      const blobIn = new Blob([src], { type: 'image/png' });
      const size = { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' };
      const bmp = crop
        ? await createImageBitmap(blobIn, crop.sx, crop.sy, crop.sw, crop.sh, size)
        : await createImageBitmap(blobIn, size);
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext('2d').drawImage(bmp, 0, 0);
      const blob = await canvas.convertToBlob({ type, quality });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    },
    { data: pngBuffer.toString('base64'), w: width, h: height, type, quality, crop }
  );
  return Buffer.from(b64, 'base64');
}

// `--foo bar` / `--foo` off process.argv, the shape every script here already used.
export function args(argv = process.argv.slice(2)) {
  return Object.fromEntries(argv.flatMap((a, i, all) =>
    a.startsWith('--') ? [[a.slice(2), all[i + 1]?.startsWith('--') === false ? all[i + 1] : true]] : []));
}
