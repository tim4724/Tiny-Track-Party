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
// verdict is what calibrates `ceiling` in the baseline.
//
// WHAT IT GATES, per track:
//   • LIVE-LIT STATIC DRESSING must be none (ttp_display_debug_live_dressing).
//     A model that falls off the baked path is silent on the glass and pays
//     vertex shading in every cell; this names it.
//   • The WORST sampled frame's vertices per cell at each player count must not
//     grow past the track's recorded figure (TOLERANCE), and at four players no
//     SHIPPED track may pass `ceiling` — the worst frame a shipped track has and
//     the box still holds. A dev track (the showroom, a probe) is priced and
//     tracked but never raced by a party of four, so the ceiling is not its.
//     Worst, not median: the 4P frame that drops is the vista, every cell
//     looking down the straight (native/renderer/CLAUDE.md).
//
// HOW. The bench scenario (autopiloted players, the race perf:race runs) under
// ?gate=1 and a fixed step, so the same seed samples the same frames every run.
// The lap is wound UNDRAWN (Stage.setUndrawn: sim + the renderer's CPU half,
// nothing submitted) and only the sampled frames draw, each twice: the full
// scene, then without the DRESSING group, which splits the world's own share
// out of the total. Counts do not depend on resolution, so the page is small
// and headless: aspect is what the frustum needs, not pixels.
//
// Usage: npm run budget:scene [-- --track cove,tangle] [--players 1,4]
//        [--record]   rewrite the baseline's per-track figures (ceiling stays)
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
const EVERY = parseInt(a.every || '30', 10);
const RECORD = !!a.record;

const { TRACKS } = await import(path.join(ROOT, 'public/shared/tracks.js'));
const { DEV_TRACKS } = await import(path.join(ROOT, 'public/shared/devTracks.js'));
const allIds = [...Object.keys(TRACKS), ...Object.keys(DEV_TRACKS)];
const ids = a.track ? String(a.track).split(',') : allIds;
for (const id of ids) if (!allIds.includes(id)) throw new Error(`unknown track ${id}`);

const baseline = fs.existsSync(BASELINE)
  ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : { ceiling: null, tracks: {} };

const app = await serveApp();
const browser = await launchBrowser();

// One lap of one track at one player count: per sampled frame, vertices per
// cell in total and the dressing's share of them, plus draws.
async function measure(track, players) {
  const ctx = await browser.context({ viewport: { width: 480, height: 270 } });
  await ctx.addInitScript(() => {
    const c = (window.__glCount = { draws: 0, verts: 0 });
    const proto = WebGL2RenderingContext.prototype;
    const wrap = (name, n) => {
      const orig = proto[name];
      proto[name] = function (...x) { c.draws++; c.verts += n(x); return orig.apply(this, x); };
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
  await page.goto(displayURL(app.port, { scenario: 'bench', players, track, seed: 1, gate: 1 }));
  // Polled on a timer: under the gate rAF is the driver's, and a rAF poll never fires.
  await page.waitForFunction(() => window.__engine && window.__scene?.sceneBuilt(), null,
    { timeout: 90000, polling: 250 });
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
        if (draws) return { verts: window.__glCount.verts - b.verts, draws };
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
                     draws: all.draws / cells });
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
const recorded = {};

console.log('track            P  samples   worst/cell  p90/cell  dressing@worst  draws@worst');
for (const id of ids) {
  recorded[id] = {};
  for (const players of PLAYERS) {
    const { live, samples } = await measure(id, players);
    const worst = samples.reduce((m, s) => (s.verts > m.verts ? s : m), samples[0]);
    const row = { worst: Math.round(worst.verts), p90: Math.round(pct(samples.map((s) => s.verts), 0.9)),
                  dressing: Math.round(worst.dress) };
    recorded[id][players] = row;
    console.log(`${id.padEnd(16)} ${players}  ${String(samples.length).padStart(7)}  ${k(row.worst)}  `
      + `${k(row.p90)}   ${k(row.dressing)} (${(100 * row.dressing / row.worst).toFixed(0).padStart(2)}%)`
      + `   ${worst.draws.toFixed(0).padStart(6)}`);
    const liveNames = Object.entries(live);
    if (liveNames.length) {
      failures.push(`${id}: static dressing drawing LIVE-LIT (off the baked path): `
        + liveNames.map(([m, n]) => `${m} x${n}`).join(', '));
    }
    const was = baseline.tracks[id]?.[players]?.worst;
    if (!RECORD && was != null && row.worst > was * (1 + TOLERANCE)) {
      failures.push(`${id} ${players}P: worst frame ${k(row.worst).trim()}/cell, recorded ${k(was).trim()}`
        + ` (+${(100 * (row.worst / was - 1)).toFixed(1)}%) — re-record with --record if intended`);
    }
    if (!RECORD && was == null) failures.push(`${id} ${players}P: no recorded figure — run with --record`);
    if (players === 4 && TRACKS[id] && baseline.ceiling != null && row.worst > baseline.ceiling) {
      failures.push(`${id} 4P: worst frame ${k(row.worst).trim()}/cell is over the ceiling `
        + `${k(baseline.ceiling).trim()} — move it off the vista or make it lighter`);
    }
  }
}

await browser.close();
await app.close?.();

if (RECORD) {
  for (const [id, byP] of Object.entries(recorded)) {
    baseline.tracks[id] = { ...(baseline.tracks[id] || {}), ...byP };
  }
  fs.writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`\nrecorded ${path.relative(ROOT, BASELINE)} (ceiling ${baseline.ceiling ?? 'unset'} kept)`);
}
if (failures.length) {
  console.error(`\n${failures.length} over budget:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nwithin budget');
