// POPS, IN PIXELS: what appears in a racer's picture from one frame to the
// next because the renderer swapped a form, not because the car moved.
// window.__landmarks.pops drives the pixel lap's stepped race and draws each
// sample twice from the same camera: with the far-form choices of the sample
// before held (TTP_DEBUG_LOD_HOLD), then free. The pixels that differ are the
// swap, exactly. Every few samples it is drawn again with no far forms,
// unculled, and with the fog carried past its cutoff, for how much of the
// picture a far form changes at all, whether any box loses what it draws, and
// whether any of the world stands out past the fog.
//
// Per track: `pops` (samples whose swap moved at least POP_PX pixels inside
// one 64 px tile: a thing a racer sees change), per lap and the worst;
// `far` (the far forms' share of the picture, mean and worst, in pixels);
// `cull` (worst pixels lost to a box, 0 when every box is right); `clear`
// (worst pixels of world standing unfogged past the fog's cutoff).
// --out <dir> keeps the lap's json and a still of each of the worst pops,
// held | free.
//
// One player only: the forms' choice is latched per frame, not per cell, so a
// split's cell is probed as a one-player frame of its size (--lines 540 for a
// four-way split on a 1080 panel).
//
// Usage: npm run see:pops [-- --track a,b] [--lines 1080] [--out dir]
import fs from 'node:fs';
import path from 'node:path';
import { serveApp, launchBrowser, displayURL, waitForScene, args, ROOT } from './lib/capture.mjs';

const POP_PX = 40;

const a = args();
const { TRACK_LIST } = await import(path.join(ROOT, 'public/shared/tracks.js'));
const all = TRACK_LIST.map((t) => t.id);
const ids = a.track ? String(a.track).split(',') : all;
for (const id of ids) if (!all.includes(id)) throw new Error(`unknown track ${id}`);
const OUT = typeof a.out === 'string' ? path.resolve(a.out) : null;
const players = 1;
const lines = Number(a.lines) || 1080;

const app = await serveApp();
const browser = await launchBrowser();
const page = await browser.page({ viewport: { width: Math.round((lines * 16) / 9), height: lines } });
await page.goto(displayURL(app.port, { scenario: 'landmarks', track: ids[0], players, dpr: 1 }));
await waitForScene(page, { timeout: 180000 });
await page.waitForFunction(() => window.__landmarks && window.__landmarks.ready(), null, { timeout: 180000, polling: 250 });
await page.evaluate(() => window.__landmarks.ready());

if (OUT) fs.mkdirSync(OUT, { recursive: true });
const rows = [];
for (const id of ids) {
  const r = await page.evaluate(async ([t, n]) => {
    const l = window.__landmarks;
    if (l.seats() !== n) await l.players(n);
    if (l.trackId() !== t) await l.track(t);
    return l.pops({});
  }, [id, players]);
  const pops = r.frames.filter((f) => f.peak >= POP_PX);
  const ref = r.frames.filter((f) => f.far !== undefined);
  const mean = (list) => (list.length ? Math.round(list.reduce((s, v) => s + v, 0) / list.length) : 0);
  const row = {
    track: id, lines, samples: r.frames.length, noise: r.noise,
    pops: pops.length,
    popWorst: Math.max(0, ...r.frames.map((f) => f.peak)),
    popPxLap: r.frames.reduce((s, f) => s + f.pop, 0),
    farMean: mean(ref.map((f) => f.far)),
    farWorst: Math.max(0, ...ref.map((f) => f.far)),
    cullWorst: Math.max(0, ...ref.map((f) => f.cull)),
    fogWorst: Math.max(0, ...ref.map((f) => f.fog))
  };
  rows.push(row);
  console.log(`${id.padEnd(12)} ${lines} lines  pops ${String(row.pops).padStart(4)}  worst ${String(row.popWorst).padStart(5)} px/tile  `
    + `swapped ${String(row.popPxLap).padStart(7)} px/lap  far mean ${String(row.farMean).padStart(6)} worst ${String(row.farWorst).padStart(6)}  `
    + `cull worst ${row.cullWorst}  clear worst ${row.fogWorst}${r.noise ? `  (noise ${r.noise})` : ''}`);
  if (OUT) {
    r.tops.forEach((t, i) => {
      fs.writeFileSync(path.join(OUT, `${id}-${lines}-${String(i).padStart(2, '0')}-s${Math.round(t.s)}-${t.peak}px.jpg`),
        Buffer.from(t.jpeg.split(',')[1], 'base64'));
    });
    for (const [what, t] of [['cull', r.lost], ['clear', r.clear]]) {
      if (!t) continue;
      fs.writeFileSync(path.join(OUT, `${id}-${lines}-${what}-s${Math.round(t.s)}-${t.peak}px.jpg`),
        Buffer.from(t.jpeg.split(',')[1], 'base64'));
    }
    fs.writeFileSync(path.join(OUT, `${id}-${lines}.json`),
      JSON.stringify({ ...r, lost: undefined, clear: undefined, fulls: undefined, tops: r.tops.map(({ jpeg, ...t }) => t) }));
  }
}
if (OUT) fs.writeFileSync(path.join(OUT, `pops-${lines}.json`), JSON.stringify(rows, null, 1));
await browser.close();
app.close();
