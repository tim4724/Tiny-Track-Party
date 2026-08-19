// The bench: one live race, one platform, one table.
//
//   node scripts/perf-race.mjs --platform web --players 4 --track tidepool --seconds 45
//
// It races 1, 2 or 4 AUTOPILOTED player cars from the back of a full grid — a
// real launch's field, driven by the sim rather than by phones (ttp_race.h's
// bench field) — and folds the frame-cost readout the shell prints while it
// runs. The point is the comparison across shells: the browser, an Apple TV and
// an Android box measure the same race, and the readout they print is decided
// in one place (native/runtime/ttp_perf.h), so "60 fps", "2 drops" and "amber"
// are the same statements on all three.
//
// ---- THE SHARED SURFACE ----
// A BACKEND stands one platform's bench up and hands back that platform's log
// stream. It is the whole platform-specific half:
//
//   launch(opts) -> AsyncIterable<string>   the platform's log lines, in order;
//                                           it BEGINS the stream once GRID_MS
//                                           of race has gone by and ENDS it
//                                           when the run is over (opts.seconds)
//   stop()                                  tear the run down; always awaited
//   opts: { players, track, seconds, dpr }
//
// Everything below THE LINE is platform-free: it picks the `TtpPerf ` lines out
// of the stream, parses one canonical readout per line, folds them and prints.
// A backend that folds, renames or re-orders anything has broken the one
// comparison this script exists to make — hand the lines over as they were
// logged and let the shared half read them.
//
// Register a new backend in BACKENDS (a factory, so each run gets its own
// state). Keep it inside its own banner: this file is edited by more than one
// pair of hands.
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeAndroidBackend } from './perf-race.android.mjs';
import { makeTvosBackend } from './perf-race.tvos.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const PLATFORM = arg('platform', 'web');
const PLAYERS = parseInt(arg('players', '4'), 10);
const TRACK = arg('track', 'tidepool');
const SECONDS = parseFloat(arg('seconds', '45'));
const SEED = parseInt(arg('seed', '1'), 10);
// A REQUEST, not a cap (Stage): it pins the drawing buffer and switches the
// adaptive render scale off, so a run measures one resolution instead of
// wandering between two while the controller hunts.
const DPR = parseFloat(arg('dpr', '1'));

// How long a race runs before its lines COUNT, on every platform. The grid is
// eight cars packed at close range and the render scale has not settled, so the
// opening seconds are the most expensive of the run and describe a picture
// nobody plays. (The fold's own warm-up filter is about BOOT — shader compiles
// and first uploads — and cannot see this.) `--seconds` is counted time on top
// of it.
//
// ONE NUMBER FOR ALL THREE BACKENDS, which is the whole reason it lives up here:
// a browser that folds the grid while the two televisions threw it away is not
// comparing the same part of a lap, and this script exists for nothing but that
// comparison.
export const GRID_MS = 6000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The one line every shell prints, and the only thing read off the stream.
const TAG = 'TtpPerf ';

// A log stream a backend fills and the shared half consumes. Lines that arrive
// before anyone iterates are buffered, so nothing is lost to a slow start.
// The queue every backend hands its lines out through. A log arrives when the
// platform feels like it and the shared half consumes at its own pace, so each
// backend needs a buffer and a parked consumer — three hand-rolled copies of
// this were the same four variables and the same iterator, which is exactly the
// kind of copy this whole change exists to stop making.
export function lineStream() {
  const buf = [];
  let wake = null;
  let ended = false;
  const nudge = () => { if (wake) { const w = wake; wake = null; w(); } };
  return {
    push(line) { buf.push(line); nudge(); },
    end() { ended = true; nudge(); },
    async* [Symbol.asyncIterator]() {
      for (;;) {
        while (buf.length) yield buf.shift();
        if (ended) return;
        await new Promise((r) => { wake = r; });
      }
    }
  };
}

// ============================================================================
// BACKEND: web (Playwright over the display page)
//
// Every line of this is a trap already paid for once by scripts/perf-features.mjs
// — read its header before changing any of them:
//
//   • HEADED. Headless Chromium is SwiftShader; the numbers would describe a
//     software rasterizer, not this machine's GPU.
//   • navigator.webdriver SPOOFED FALSE. Stage caps the drawing buffer to the
//     E2E scale and skips the shadow bake under automation, i.e. it would
//     measure a different renderer from the one people play.
//   • ?dpr= PINS the buffer, which also switches the adaptive render scale off.
//     Without it the controller resizes mid-run and the fold spans two
//     resolutions.
//
// It runs the page's own bench scenario (public/display/TestHarness.js), which
// prints the readout; nothing here reaches into the page to compute one.
// ============================================================================

function waitForServer(port, timeoutMs = 20000) {
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

function makeWebBackend() {
  // Off the 4000 dev port and off the other capture scripts' ports, so a dev
  // server and a concurrent capture are both undisturbed.
  const port = parseInt(arg('port', '4331'), 10);
  let server = null;
  let browser = null;
  let timer = null;

  return {
    async launch({ players, track, seconds, dpr }) {
      const { chromium } = await import('playwright');
      server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(port), APP_ENV: 'development' },
        stdio: ['ignore', 'ignore', 'inherit']
      });
      await waitForServer(port);

      browser = await chromium.launch({ headless: false });
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });
      const page = await ctx.newPage();

      const lines = lineStream();
      // THE GRID SETTLE IS A DROP, NOT A DELAY. The page has been printing a
      // readout a second since the scene came up and lineStream buffers every
      // one, so sleeping without this gate would hand the fold exactly the
      // seconds the two TV backends threw away.
      let counting = false;
      page.on('console', (m) => { if (counting) lines.push(m.text()); });
      page.on('pageerror', (e) => console.error('  [page]', e.message));

      const url = `http://127.0.0.1:${port}/?test=1&scenario=bench&players=${players}`
          + `&track=${track}&seed=${SEED}&dpr=${dpr}`;
      console.log(`# ${url}`);
      await page.goto(url);
      // The scenario publishes the session it is racing; waiting on the scene
      // alone would start the clock while the GLBs are still landing.
      await page.waitForFunction(() => window.__engine, null, { timeout: 90000 });
      await sleep(GRID_MS);
      counting = true;
      timer = setTimeout(() => lines.end(), seconds * 1000);
      return lines;
    },

    async stop() {
      clearTimeout(timer);
      if (browser) await browser.close().catch(() => {});
      if (server) server.kill('SIGTERM');
    }
  };
}

// The platforms this bench can drive. A factory per platform, so a run owns its
// own state — the Android TV and tvOS backends register here.
const BACKENDS = {
  web: makeWebBackend, androidtv: makeAndroidBackend, tvos: makeTvosBackend
};

// ============================================================================
// ---- THE LINE ---- everything below is platform-free.
// ============================================================================

// One readout, or null for a line that is not one. A shell logs plenty else.
function readoutOf(line) {
  if (!line.startsWith(TAG)) return null;
  try {
    const r = JSON.parse(line.slice(TAG.length));
    // `warming` is the monitor still discarding a run's first frames
    // (perf_stats.h): its window describes nothing yet.
    return (r && typeof r === 'object' && !r.warming && r.frame) ? r : null;
  } catch (_) {
    return null;                       // a shell logging its own `TtpPerf` prose
  }
}

const median = (xs) => {
  const s = xs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const worst = (xs, dir) => {
  const s = xs.filter((v) => Number.isFinite(v));
  if (!s.length) return null;
  return dir === 'low' ? Math.min(...s) : Math.max(...s);
};
const of = (rows, pick) => rows.map(pick).filter((v) => v != null);

function report(rows) {
  const last = rows[rows.length - 1];
  const n = (v, d) => (v == null ? '   —  ' : v.toFixed(d));
  console.log(`\n# ${PLATFORM} · ${last.track || TRACK} · ${PLAYERS} player`
      + `${PLAYERS === 1 ? '' : 's'} · ${last.width}×${last.height} @ dpr ${last.dpr}`
      + ` · ${last.cells} cell${last.cells === 1 ? '' : 's'} · ${rows.length} readouts`);
  if (!of(rows, (r) => r.gpu && r.gpu.p50).length) {
    console.log('# no GPU timer on this platform: cost is the CPU and the cadence only');
  }
  // TYPICAL is the median across the run's readouts; WORST is the run's worst
  // single second. Each readout already folds ~120 frames, so a p50 of p50s is
  // what the run mostly did and the worst p95 is the second you would have
  // felt.
  console.log('\n                    typical      worst');
  const row = (label, xs, dir, d) =>
      console.log(`${label.padEnd(16)}${n(median(xs), d).padStart(9)}`
          + `${n(worst(xs, dir), d).padStart(11)}`);
  row('fps', of(rows, (r) => r.fps), 'low', 0);
  row('hz', of(rows, (r) => r.hz), 'low', 0);
  row('drops/s', of(rows, (r) => r.drops), 'high', 0);
  row('skips/s', of(rows, (r) => r.skips), 'high', 0);
  // The cost rows are the fold's own percentiles: the typical column is the
  // median of the p50s, the worst column the largest p95 any second saw.
  const cost = (label, key) => {
    const p50 = of(rows, (r) => r[key] && r[key].p50);
    const p95 = of(rows, (r) => r[key] && r[key].p95);
    console.log(`${label.padEnd(16)}${n(median(p50), 3).padStart(9)}`
        + `${n(worst(p95, 'high'), 3).padStart(11)}`);
  };
  cost('gpu ms', 'gpu');
  cost('cpu ms', 'cpu');
  cost('frame ms', 'frame');
  const tally = rows.reduce((m, r) => m.set(r.verdict, (m.get(r.verdict) || 0) + 1), new Map());
  const order = ['bad', 'warn', 'good'].filter((v) => tally.has(v));
  console.log(`\nverdict ${order[0]}   (`
      + ['good', 'warn', 'bad'].filter((v) => tally.has(v))
          .map((v) => `${v} ${tally.get(v)}`).join(' · ') + ')');
}

async function main() {
  const make = BACKENDS[PLATFORM];
  if (!make) {
    console.error(`unknown --platform ${PLATFORM} (have: ${Object.keys(BACKENDS).join(', ')})`);
    process.exit(2);
  }
  const backend = make();
  const rows = [];
  try {
    const lines = await backend.launch({ players: PLAYERS, track: TRACK, seconds: SECONDS, dpr: DPR });
    for await (const line of lines) {
      const r = readoutOf(line);
      if (r) rows.push(r);
    }
  } finally {
    await backend.stop();
  }
  if (!rows.length) {
    console.error(`no \`${TAG}\` readouts in ${SECONDS}s — is the shell printing them, `
        + 'and is the engine artifact current (npm run check:artifact)?');
    process.exit(1);
  }
  report(rows);
}

// Only when RUN, never when imported: this spawns a server and a HEADED browser
// and races for `--seconds`, and the two backends beside it import this file for
// the shared run constants. An unguarded main() at module scope has already
// started a bench off nothing but an import once.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
