'use strict';

// Find WHEN to start filming a shot so the action is on camera, without rendering it.
//
//   node scripts/trailer/scout.js --shot 05-snow-monster-1p
//   node scripts/trailer/scout.js --shot 07-rooftop-rocket-1p --window 90
//
// The problem this solves: the item scenarios spend their showcase item from the car
// furthest BACK, which is whichever of the eight that happens to be — so most of the
// time the monster transform or the rocket is off in nobody's cell. Eyeballing renders
// until one lands is minutes per attempt.
//
// So: step the same race the renderer would, ask the sim what happened each beat, and
// never draw a pixel worth keeping. The page runs at a tiny resolution and takes no
// screenshots, so a couple of minutes of sim costs seconds. Because render.js is
// deterministic (the ?gate=1 clock both share), a `warmup` this prints is exactly what
// comes back when you put it in shots.js and render it.
//
// It sweeps TIME, not seeds, and that is deliberate. The race seed feeds the item
// roulette and the wander — but these scenarios FORCE the roulette to one item, and the
// bots take their own seeds from botSpecs, so changing `seed` here moves almost nothing:
// a sweep of eight seeds returned the identical hit list. `warmup` is the knob that
// actually picks a different take.
//
// What counts as "on camera" is per scenario, and asks whether the effect is NEAR the
// cell car rather than happening to it:
//   monster  a transformed car within NEAR_S of the cell car along the track
//   rocket   a rocket in flight within NEAR_S of the cell car
// Near, not on, because the showcase is spent from the car furthest back and the cell
// car is only one of eight — insisting it be the subject rejects almost every seed,
// while a monster truck ploughing past the camera is the shot anyway.
//
// The cell car is read from Stage's own cell order, NOT assumed to be id 0: with one
// human the field is topped up with CPU racers and humans start at the BACK of the
// grid, so the seat that owns the viewport is not the lowest id.
//
// Prints the best seeds with the sim-time each first lands, which is the `warmup` to use.

const { chromium } = require('playwright');
const { UNMASK, STEP_ONE, serveStatic } = require('./harness.js');
const SHOTS = require('./shots.js');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    out[argv[i].slice(2)] = argv[++i];
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const SHOT = SHOTS.find((s) => s.id === args.shot);
if (!SHOT) throw new Error(`--shot must name one of: ${SHOTS.map((s) => s.id).join(', ')}`);
const SEED = args.seed != null ? parseInt(args.seed, 10) : SHOT.seed;
const WINDOW = parseFloat(args.window) || 60;   // seconds of sim to search
const POLL_HZ = 6;                              // beats per second at which the sim is asked
const FPS = 60;
const PORT = parseInt(args.port, 10) || 4322;

async function sweep(page, seed, port) {
  const q = new URLSearchParams({
    test: '1', gate: '1', scenario: SHOT.scenario, players: String(SHOT.players), track: SHOT.track,
  });
  if (seed != null) q.set('seed', String(seed));
  await page.goto(`http://127.0.0.1:${port}/?${q}`, { waitUntil: 'networkidle' });
  await page.waitForFunction((n) => {
    const s = window.__scene, e = window.__engine;
    return !!(s && e && s.cars.size >= n);
  }, SHOT.players, { timeout: 60000 });
  await page.evaluate((fps) => window.__scene.setFixedStep(1 / fps), FPS);

  const stepMs = 1000 / FPS;
  const hits = [];
  const frames = Math.round(WINDOW * FPS);
  const every = Math.round(FPS / POLL_HZ);
  for (let i = 0; i < frames; i++) {
    await page.evaluate(STEP_ONE, stepMs);
    // Poll at POLL_HZ: the events being looked for last a second or more, and a snapshot
    // read per frame would cost more than the step it is measuring.
    if (i % every) continue;
    const on = await page.evaluate((kind) => {
      // A FORWARD CONE, not a radius. The cell camera is a chase cam sitting behind its
      // car and looking down the track, so what reads on screen is what is just ahead:
      // a couple of units behind (still in frame beside the camera) out to about the
      // distance where a car is still a car rather than a speck. A symmetric radius
      // scores a monster 25 units back — completely off screen — as a hit.
      const BEHIND = 4, AHEAD = 18;
      const snap = window.__engine.getSnapshot();
      // EVERY cell, not just the first: at 4P the shot is good if any of the four
      // viewports has the action in it.
      const cells = (window.__scene._order || []).map((id) => snap.cars.find((c) => c.id === id)).filter(Boolean);
      if (!cells.length) return false;
      if (kind === 'monster') {
        return cells.some((cell) => snap.cars.some((c) => c.monster
          && (c.totalS - cell.totalS) > -BEHIND && (c.totalS - cell.totalS) < AHEAD));
      }
      // Rockets are the other way round: they carry a LAP-LOCAL `s` while cars carry a
      // cumulative `totalS`, so the two are not comparable without the track length,
      // which nothing on this page exposes. A cell car being SPUN is a better signal
      // anyway — a rocket landing on a camera is the shot, not one passing by.
      return cells.some((cell) => !!cell.spin);
    }, SHOT.scenario);
    if (on) hits.push(+(i / FPS).toFixed(2));
  }
  return hits;
}

async function main() {
  const killServer = await serveStatic(PORT);

  let browser;
  try {
    browser = await chromium.launch({ headless: false });
    const page = await browser.newPage({ viewport: { width: 480, height: 270 }, deviceScaleFactor: 1 });
    await page.addInitScript(UNMASK);
    page.on('pageerror', (e) => console.error('[page error]', e.message));

    console.log(`Scouting ${SHOT.id} (${SHOT.scenario}, ${SHOT.players}P, ${SHOT.track}) over ${WINDOW}s of sim`);
    const hits = await sweep(page, SEED, PORT);
    if (!hits.length) {
      console.log('\nNothing came near the cell car. Try a longer --window.');
      return;
    }

    // Contiguous runs of hits are one event; a gap of more than a couple of poll beats
    // starts a new one.
    const gap = 3 / POLL_HZ;
    const windows = [];
    for (const t of hits) {
      const last = windows[windows.length - 1];
      if (last && t - last.end <= gap) last.end = t;
      else windows.push({ start: t, end: t });
    }
    for (const w of windows) {
      console.log(`  ${w.start.toFixed(1)}s – ${w.end.toFixed(1)}s  (${(w.end - w.start).toFixed(1)}s on camera)`);
    }

    // Lead in a beat so the clip does not open mid-event.
    const best = windows.slice().sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
    const warmup = +Math.max(0, best.start - 1.5).toFixed(1);
    console.log(`\nLongest run: ${(best.end - best.start).toFixed(1)}s from ${best.start.toFixed(1)}s`);
    console.log(`  put in shots.js:  warmup: ${warmup}`);
    console.log(`  check it:         node scripts/trailer/render.js --shot ${SHOT.id} --warmup ${warmup} --preview`);
  } finally {
    if (browser) await browser.close();
    killServer();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
