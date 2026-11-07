// THE SCENE BUDGET: what a track's world submits per split-screen cell, over a
// whole lap, against a committed baseline — so environment content can be added
// fast without each piece needing a session on the Android box.
//
// WHY A COUNT AND NOT MILLISECONDS. The box cannot resolve under ~1 ms without
// interleaved pairs on one install, which is minutes per asset. The command
// stream, though, is decided in shared C++ (the scene, the per-cell cull,
// Filament's sort) before any backend sees it, so the count taken here is the
// count the box submits (perf-features.mjs reproduced the device ledger's
// figures exactly). It is a PROXY: the box stays the verdict, once per batch
// (`perf:race --platform androidtv --players 4 --vk 1 --timeline`), and that
// verdict is what calibrates a tier's `ceiling` and `drawCeiling`.
//
// ONE BASELINE PER DETAIL TIER (ttp/detail.h). The Android TV draws LITE and
// the web and the Apple TV draw FULL, so each tier is priced, tracked and
// ceilinged on its own: `lite` carries the box's ceilings below, and `full`
// carries a PROVISIONAL 260k / 360 that awaits an Apple TV calibration (the
// same stress-build method, on the Apple TV at 4P and the operating point it
// settles on). Until one is read, full's ceilings are a guess, not a box fact.
//
// THE CALIBRATION (lite's ceilings). On the Google TV Streamer (GE9215,
// Vulkan, render scale pinned at 0.5: 4P at 540 lines), 40 s timeline races of
// stress builds that copy set pieces round the lap, read as clean seconds per
// run against this count's 4P worst frame and its most draws per cell (taken
// before the tiers existed, so of the full world; a box fact either way):
//   ~131k vertices, 135-186 draws    40 of 40, every run
//   210k, 195 draws (tidepool)       40 of 41, 39 of 40: holds
//   188k, 271 draws (pretzel)        40 of 41: holds
//   175k, 278 draws (ribbon)         40, 34, 39 of 41: the edge
//   217k, 363 draws (ribbon)         34-36 of 40: fails every run
//   226k and up, 240+ draws          fails everywhere
// Neither count alone separates the builds that hold from the ones that fail
// (210k holds on 195 draws, 175k wobbles on 278): draws limit the box as much
// as vertices do. So both are gated, `ceiling` (180k) under the first vertex
// count that failed and `drawCeiling` (240) under the draws that failed.
//
// WHAT IT GATES, per track and tier:
//   • LIVE-LIT STATIC DRESSING must be none (ttp_display_debug_live_dressing).
//     A model that falls off the baked path is silent on the glass and pays
//     vertex shading in every cell; this names it.
//   • The WORST sampled frame's vertices per cell at each player count must not
//     grow past the tier's recorded figure for the track (TOLERANCE), and at
//     four players no SHIPPED track may pass the tier's `ceiling`, the worst
//     frame a shipped track may have while that tier's device still holds, nor
//     may the lap's most draws per cell pass its `drawCeiling`. A dev track
//     (the showroom, a probe) is priced and tracked but never raced by a party
//     of four, so the ceilings are not its.
//     Worst, not median: the 4P frame that drops is the vista, every cell
//     looking down the straight (native/renderer/CLAUDE.md).
//
// HOW. The bench scenario (autopiloted players, the race perf:race runs) under
// ?gate=1 and a fixed step, so the same seed samples the same frames every run.
// The lap is wound UNDRAWN (Stage.setUndrawn: sim + the renderer's CPU half,
// nothing submitted) and only the sampled frames draw, each twice: the full
// scene, then without the DRESSING group, which splits the world's own share
// out of the total. Headless, at a page size per tier (VIEW): the far forms
// and lite's cuts gate on a cell's own pixels, so lite is priced at the box's
// 4P buffer (960x540); full keeps the small page its figures were recorded
// at, which swaps the far forms in a little early.
//
// Usage: npm run budget:scene [-- --track cove,tangle] [--players 1,4] [--detail full,lite]
//        [--record]   rewrite the measured tiers' per-track figures (the ceilings stay)
//        [--every 30] frames between samples
import fs from 'node:fs';
import path from 'node:path';
import { serveApp, launchBrowser, displayURL, ROOT, args } from './lib/capture.mjs';

const BASELINE = path.join(ROOT, 'tests/fixtures/scene-budget.json');
// A recorded figure may grow this much before the gate calls it a change: the
// worst sample sits on whichever frame the stride lands nearest the vista.
const TOLERANCE = 0.02;
const a = args();
const PLAYERS = String(a.players || '1,4').split(',').map(Number);
const TIERS = String(a.detail || 'full,lite').split(',');
for (const t of TIERS) if (t !== 'full' && t !== 'lite') throw new Error(`--detail: full and/or lite, not ${t}`);
// HOW, in the header, has why the tiers are priced at different sizes.
const VIEW = { full: { width: 480, height: 270 }, lite: { width: 960, height: 540 } };
const EVERY = parseInt(a.every || '30', 10);
const RECORD = !!a.record;

const { TRACKS } = await import(path.join(ROOT, 'public/shared/tracks.js'));
const { DEV_TRACKS } = await import(path.join(ROOT, 'public/shared/devTracks.js'));
const allIds = [...Object.keys(TRACKS), ...Object.keys(DEV_TRACKS)];
const ids = a.track ? String(a.track).split(',') : allIds;
for (const id of ids) if (!allIds.includes(id)) throw new Error(`unknown track ${id}`);

const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));

const app = await serveApp();
const browser = await launchBrowser();

// One lap of one track at one player count in one tier: per sampled frame,
// vertices per cell in total and the dressing's share of them, plus draws.
async function measure(track, players, tier) {
  const ctx = await browser.context({ viewport: VIEW[tier] });
  await ctx.addInitScript(() => {
    const c = (window.__glCount = { draws: 0, verts: 0, lit: 0 });
    const proto = WebGL2RenderingContext.prototype;
    // LIVE-LIT is a program that reads a normal at draw time: Filament feeds it
    // as mesh_tangents, which every baked (vcolor, vground, vroad) program lacks.
    const litOf = new WeakMap();
    let lit = false;
    const useProgram = proto.useProgram;
    proto.useProgram = function (p) {
      if (p && !litOf.has(p)) litOf.set(p, this.getAttribLocation(p, 'mesh_tangents') >= 0);
      lit = !!p && litOf.get(p);
      return useProgram.call(this, p);
    };
    const wrap = (name, n) => {
      const orig = proto[name];
      proto[name] = function (...x) {
        const v = n(x);
        c.draws++; c.verts += v; if (lit) c.lit += v;
        return orig.apply(this, x);
      };
    };
    // Indices submitted, times instances: the stream the tiler bins per cell.
    // (perf-features.mjs has why each count sits where it does.)
    wrap('drawElements', (x) => x[1]);
    wrap('drawArrays', (x) => x[2]);
    wrap('drawRangeElements', (x) => x[3]);
    wrap('drawElementsInstanced', (x) => x[1] * x[4]);
    wrap('drawArraysInstanced', (x) => x[2] * x[3]);
    // Boot needs frames and nothing runs under the gate unless pumped.
    const t = setInterval(() => {
      if (window.__engine) { clearInterval(t); return; }
      if (window.__pump) window.__pump(16.7);
    }, 8);
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('  [page error]', e.message));
  await page.goto(displayURL(app.port, { scenario: 'bench', players, track, seed: 1, gate: 1, detail: tier }));
  // Polled on a timer: under the gate rAF is the driver's, and a rAF poll never fires.
  await page.waitForFunction(() => window.__engine && window.__scene?.sceneBuilt(), null,
    { timeout: 90000, polling: 250 });
  const drawn = await page.evaluate(() => window.__scene.detail);
  if (drawn !== tier) throw new Error(`${track}: asked for the ${tier} tier, the page drew ${drawn}`);
  const out = await page.evaluate(async ({ every }) => {
    const { FEAT } = await import('/display/render/Display.js');
    const stage = window.__scene, display = stage.display;
    stage.setFixedStep(1 / 60);
    // A pump is not a drawn frame: Filament SKIPS a frame while the GPU is
    // behind (a software one, here, often is). So an arm pumps until its
    // frame actually issued draws, letting the GPU catch up in between.
    const draw = async (mask) => {
      display.debugFeatures(mask);
      for (let t = 0; t < 100; t++) {
        const b = { ...window.__glCount };
        window.__pump(16.7);
        const draws = window.__glCount.draws - b.draws;
        if (draws) return { verts: window.__glCount.verts - b.verts, draws, lit: window.__glCount.lit - b.lit };
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('no frame drew in 100 pumps');
    };
    // The dressing merge (and its bake) runs on the first frame DRAWN after
    // the build, so the live-lit report is only an answer after one.
    for (let i = 0; i < 3; i++) await draw(FEAT.ALL);
    const live = display.debugLiveDressing();
    const cells = display.cellRects(8).length / 8 || 1;   // 8 floats a cell
    const players = () => window.__engine.getSnapshot().cars.filter((c) => !c.ai);
    const startLap = Math.min(...players().map((c) => c.lap));
    const samples = [];
    // One lap of the slowest autopiloted player, and a hard stop so a car that
    // never finishes cannot hang the sweep.
    for (let f = 0; f < 60 * 120; f += every) {
      stage.setUndrawn(true);
      for (let i = 0; i < every; i++) window.__pump(16.7);
      stage.setUndrawn(false);
      const all = await draw(FEAT.ALL);
      const bare = await draw(FEAT.ALL & ~FEAT.DRESSING);
      samples.push({ f, verts: all.verts / cells, dress: (all.verts - bare.verts) / cells,
                     draws: all.draws / cells, lit: all.lit / cells });
      if (Math.min(...players().map((c) => c.lap)) > startLap) break;
    }
    display.debugFeatures(FEAT.ALL);
    return { live, cells, samples };
  }, { every: EVERY });
  await ctx.close();
  return out;
}

const pct = (xs, p) => { const s = [...xs].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const k = (v) => `${(v / 1000).toFixed(1)}k`.padStart(7);
const failures = [];
const recorded = { full: {}, lite: {} };

console.log('tier track            P  samples   worst/cell  p90/cell  dressing@worst  draws@worst  max draws  lit@worst');
for (const tier of TIERS) {
  const base = baseline[tier];
  for (const id of ids) {
    recorded[tier][id] = {};
    for (const players of PLAYERS) {
      const { live, samples } = await measure(id, players, tier);
      const worst = samples.reduce((m, s) => (s.verts > m.verts ? s : m), samples[0]);
      const row = { worst: Math.round(worst.verts), p90: Math.round(pct(samples.map((s) => s.verts), 0.9)),
                    dressing: Math.round(worst.dress) };
      recorded[tier][id][players] = row;
      // Draws are gated like vertices (drawCeiling, below): the box calibration
      // in the header found them limiting as much. The live-lit vertices are
      // only reported; the gate on them is that no static dressing is live-lit.
      const maxDraws = Math.max(...samples.map((s) => s.draws));
      console.log(`${tier} ${id.padEnd(16)} ${players}  ${String(samples.length).padStart(7)}  ${k(row.worst)}  `
        + `${k(row.p90)}   ${k(row.dressing)} (${(100 * row.dressing / row.worst).toFixed(0).padStart(2)}%)`
        + `   ${worst.draws.toFixed(0).padStart(6)}     ${maxDraws.toFixed(0).padStart(6)}  ${k(worst.lit)}`);
      const liveNames = Object.entries(live);
      if (liveNames.length) {
        failures.push(`${tier} ${id}: static dressing drawing LIVE-LIT (off the baked path): `
          + liveNames.map(([m, n]) => `${m} x${n}`).join(', '));
      }
      const was = base.tracks[id]?.[players]?.worst;
      if (!RECORD && was != null && row.worst > was * (1 + TOLERANCE)) {
        failures.push(`${tier} ${id} ${players}P: worst frame ${k(row.worst).trim()}/cell, recorded ${k(was).trim()}`
          + ` (+${(100 * (row.worst / was - 1)).toFixed(1)}%) — re-record with --record if intended`);
      }
      if (!RECORD && was == null) failures.push(`${tier} ${id} ${players}P: no recorded figure — run with --record`);
      if (players === 4 && TRACKS[id] && row.worst > base.ceiling) {
        failures.push(`${tier} ${id} 4P: worst frame ${k(row.worst).trim()}/cell is over the ceiling `
          + `${k(base.ceiling).trim()} — move it off the vista or make it lighter`);
      }
      if (players === 4 && TRACKS[id] && maxDraws > base.drawCeiling) {
        failures.push(`${tier} ${id} 4P: ${maxDraws.toFixed(0)} draws/cell at the lap's busiest frame, over the `
          + `draw ceiling ${base.drawCeiling} — move pieces off the vista or merge them`);
      }
    }
  }
}

await browser.close();
await app.close?.();

if (RECORD) {
  for (const tier of TIERS) {
    for (const [id, byP] of Object.entries(recorded[tier])) {
      baseline[tier].tracks[id] = { ...(baseline[tier].tracks[id] || {}), ...byP };
    }
  }
  fs.writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`\nrecorded ${TIERS.join(' + ')} in ${path.relative(ROOT, BASELINE)} (the ceilings kept)`);
}
if (failures.length) {
  console.error(`\n${failures.length} over budget:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nwithin budget');
