// LANDMARK SIGHT, IN PIXELS: how long a racer can READ each set piece over a
// lap, counted off the renderer's own picture. window.__landmarks.see drives
// the autopiloted player round a live lap under the race's chase camera with
// every placement painted a flat colour of its own (TTP_DEBUG_SET_ID) behind
// the deck, the terrain, the trees and the cars as they really stand, and
// counts each piece's pixels in cell 0. score:landmarks PREDICTS sight from
// boxes and sight lines; this counts, so smoke, draped and flat pieces, parts
// on their own ground and real size all land as they are drawn.
//
// READABLE: at least READ_PX pixels of a 960x540 picture standing at least
// READ_H tall in its tallest column (so a flat pitch or a sliver over a kerb
// does not pass on width). Calibrated by eye on the probe's own stills of
// pieces at a ladder of sizes: a lifeguard tower at ~1000 px / 43 tall, a
// windpump at ~1250 / 80 and a penguin row at ~1300 / 30 read as what they
// are; at ~700 px a headframe or a windpump is a lattice you might name, and
// under ~400 px every piece is a speck. A 4P cell is counted in the same
// canvas pixels, so it is held to the same size on the screen.
//
// Per piece: readable seconds per lap, peak and median share of the picture
// while visible, the stretches (car arclength) where it reads, and the
// stretches where it would read but is hidden (`hid`), with what hid most of
// it: the deck (and its kerbs), the terrain (ground, hills, pillars, berms),
// the two together (either alone still covers it), or the cars. A piece
// hidden by trees or another piece reads as merely small: the unhidden frame
// still draws the dressing.
//
// --out <dir> writes visibility.json, visibility.md (every piece, worst
// first) and, for the --worst N rows (default 40), a driver-view still at
// each one's best near miss in <dir>/probe/ (the piece's unhidden outline
// boxed in magenta). --four adds a 4P pass (cell 0 of four) for those rows.
//
// Usage: npm run see:landmarks [-- --track a,b] [--out dir] [--worst N] [--four]
import fs from 'node:fs';
import path from 'node:path';
import { serveApp, launchBrowser, displayURL, waitForScene, args, ROOT } from './lib/capture.mjs';

const READ_PX = 800;
const READ_H = 20;
const NOISE_PX = 16;           // under this a row is a stray pixel, not in sight
const EVERY = 0.2;             // seconds between samples

const a = args();
const { TRACK_LIST } = await import(path.join(ROOT, 'public/shared/tracks.js'));
const all = TRACK_LIST.map((t) => t.id);
const ids = a.track ? String(a.track).split(',') : all;
for (const id of ids) if (!all.includes(id)) throw new Error(`unknown track ${id}`);
const OUT = typeof a.out === 'string' ? path.resolve(a.out) : null;
const WORST = Number(a.worst) || 40;

const app = await serveApp();
const browser = await launchBrowser();
const page = await browser.page({ viewport: { width: 960, height: 540 } });
await page.goto(displayURL(app.port, { scenario: 'landmarks', track: ids[0], players: 1, dpr: 1 }));
await waitForScene(page, { timeout: 180000 });
await page.waitForFunction(() => window.__landmarks && window.__landmarks.ready(), null, { timeout: 180000, polling: 250 });
await page.evaluate(() => window.__landmarks.ready());
const onTrack = (id, players) => page.evaluate(async ([t, n]) => {
  const l = window.__landmarks;
  if (l.seats() !== n) await l.players(n);
  if (l.trackId() !== t) await l.track(t);
}, [id, players]);
const see = (opts) => page.evaluate((o) => window.__landmarks.see(o), { every: EVERY, minPx: READ_PX, minH: READ_H, ...opts });

const reads = (f) => !!f && f[1] >= READ_PX && f[2] >= READ_H;
// Runs of `on` samples round the lap, as car arclength and seconds.
function stretches(frames, on, every) {
  const out = [];
  let run = null;
  frames.forEach((f, k) => {
    if (on(f)) {
      if (!run) out.push(run = { from: f.s, to: f.s, n: 0, k: [] });
      run.to = f.s;
      run.n++;
      run.k.push(k);
    } else run = null;
  });
  // One run across the line, not two.
  if (out.length > 1 && on(frames[0]) && on(frames[frames.length - 1])) {
    const last = out.pop();
    out[0] = { from: last.from, to: out[0].to, n: last.n + out[0].n, k: [...last.k, ...out[0].k] };
  }
  return out.map((r) => ({ from: Math.round(r.from), to: Math.round(r.to), secs: +(r.n * every).toFixed(1), k: r.k }));
}

// One track's pixel lap, folded per piece.
function fold(r, players) {
  const area = r.cell.w * r.cell.h;
  const row = (list, i) => list && list.find((x) => x[0] === i);
  return r.pieces.map((p) => {
    const i = p.index;
    const fr = r.frames.map((f) => ({ s: f.s, a: row(f.a, i), b: row(f.b, i), road: row(f.road, i), ground: row(f.ground, i), both: row(f.both, i) }));
    const seen = fr.filter((f) => f.a && f.a[1] >= NOISE_PX);
    const shares = seen.map((f) => f.a[1] / area).sort((x, y) => x - y);
    const readsAt = (f) => reads(f.a);
    const hidAt = (f) => reads(f.b) && !reads(f.a);
    // What hid it, in pixels: what each frame without the deck, the terrain
    // or both gives back, and what only the cars still cover.
    const lostTo = (f, into) => {
      const base = f.a ? f.a[1] : 0;
      const back = (x) => Math.max((x ? x[1] : 0) - base, 0);
      const deck = back(f.road), terrain = back(f.ground), both = back(f.both);
      into.deck += deck;
      into.terrain += terrain;
      into['deck+terrain'] += Math.max(both - deck - terrain, 0);
      into.cars += Math.max(f.b[1] - base - both, 0);
      return into;
    };
    const main = (l) => {
      const top = Object.entries(l).sort((x, y) => y[1] - x[1])[0];
      return top && top[1] > 0 ? top[0] : null;
    };
    const none = () => ({ deck: 0, terrain: 0, 'deck+terrain': 0, cars: 0 });
    const lost = fr.filter(hidAt).reduce((l, f) => lostTo(f, l), none());
    const hid = stretches(fr, hidAt, r.every).map(({ k, ...s }) => ({ ...s, by: main(k.reduce((l, j) => lostTo(fr[j], l), none())) }));
    const readRuns = stretches(fr, readsAt, r.every).map(({ k, ...s }) => s);
    // The best near miss: where it would read but is hidden, the most of it
    // that still shows (then the most there is to see); else where it read
    // biggest short of the bar; else where the car passes closest.
    const pick = (list, key) => list.reduce((best, k) => (best < 0 || key(k) > key(best) ? k : best), -1);
    const idx = fr.map((_, k) => k);
    let still = pick(idx.filter((k) => hidAt(fr[k])), (k) => (fr[k].a ? fr[k].a[1] : 0) * 1e6 + fr[k].b[1]);
    if (still < 0) still = pick(idx.filter((k) => fr[k].a && !readsAt(fr[k])), (k) => fr[k].a[1]);
    if (still < 0) still = pick(idx.filter((k) => fr[k].b), (k) => fr[k].b[1]);
    if (still < 0) still = pick(idx, (k) => -Math.hypot(r.frames[k].x - p.cx, r.frames[k].z - p.cz));
    const pct = (v) => +(v * 100).toFixed(2);
    return {
      track: r.track, players, index: i, model: p.model, label: p.label, u: p.u, s: Math.round(p.s), lat: p.lat,
      readable: +(fr.filter(readsAt).length * r.every).toFixed(1),
      visible: +(seen.length * r.every).toFixed(1),
      hidden: +(fr.filter(hidAt).length * r.every).toFixed(1),
      peak: shares.length ? pct(shares[shares.length - 1]) : 0,
      median: shares.length ? pct(shares[shares.length >> 1]) : 0,
      peakH: Math.max(0, ...seen.map((f) => f.a[2])),
      best: readRuns.reduce((b, s) => (!b || s.secs > b.secs ? s : b), null),
      reads: readRuns,
      hid,
      occluder: main(lost),
      still: still >= 0 ? { k: r.frames[still].k, s: r.frames[still].s, lat: r.frames[still].lat } : null
    };
  });
}

const rows = [];
const laps = {};
for (const id of ids) {
  await onTrack(id, 1);
  const r = await see();
  laps[id] = +(r.frames.length * r.every).toFixed(1);
  const mine = fold(r, 1);
  rows.push(...mine);
  console.log(`${id}  (lap ${laps[id]} s)`);
  console.log('  piece                    u   read  seen   hid  peak%  med%  peakH  occluder');
  for (const p of mine) {
    const n = (v, w) => String(v).padStart(w);
    console.log(`  ${p.label.padEnd(22)} ${n(p.u.toFixed(3), 5)} ${n(p.readable, 5)} ${n(p.visible, 5)} ${n(p.hidden, 5)} ${n(p.peak, 6)} ${n(p.median, 5)} ${n(p.peakH, 6)}  ${p.occluder || ''}`);
  }
}
// Worst first: the fewest readable seconds, then the smallest it ever got.
rows.sort((x, y) => x.readable - y.readable || x.peak - y.peak);
const worst = rows.slice(0, WORST);

if (a.four) {
  for (const id of [...new Set(worst.map((w) => w.track))]) {
    await onTrack(id, 4);
    for (const q of fold(await see(), 4)) {
      const w = worst.find((x) => x.track === id && x.index === q.index);
      if (w) w.four = { readable: q.readable, peak: q.peak, peakH: q.peakH, hidden: q.hidden };
    }
    console.log(`  4P ${id}`);
  }
}

if (OUT) {
  fs.mkdirSync(path.join(OUT, 'probe'), { recursive: true });
  for (const id of [...new Set(worst.map((w) => w.track))]) {
    const mine = worst.filter((w) => w.track === id && w.still);
    await onTrack(id, 1);
    const r = await see({ stills: mine.map((w) => ({ k: w.still.k, row: w.index })) });
    for (const shot of r.shots) {
      const w = mine.find((x) => x.index === shot.row && x.still.k === shot.k);
      // The replay must be the measured lap, or the still shows another moment.
      if (Math.abs(shot.s - w.still.s) > 0.5) console.warn(`  ${id}: the replay drifted (s ${shot.s} vs ${w.still.s})`);
      const file = `${id}-${w.model.replace(/^set-/, '')}-u${w.u.toFixed(3)}.jpg`;
      fs.writeFileSync(path.join(OUT, 'probe', file), Buffer.from(shot.jpeg.split(',')[1], 'base64'));
      w.shot = `probe/${file}`;
    }
    console.log(`  stills ${id}`);
  }
  fs.writeFileSync(path.join(OUT, 'visibility.json'), JSON.stringify({
    readable: { px: READ_PX, tallest: READ_H, of: '960x540' }, every: EVERY, laps, pieces: rows
  }, null, 1));
  const span = (s) => (s ? `s${s.from}-${s.to} (${s.secs} s)` : '');
  const hidSpan = (list) => {
    const h = list.reduce((b, x) => (!b || x.secs > b.secs ? x : b), null);
    return h ? `${span(h)} by ${h.by}` : '';
  };
  const md = [
    `# Set-piece visibility from the driver's seat`,
    '',
    `Readable = at least ${READ_PX} px of a 960x540 1P picture (${(READ_PX / 5184).toFixed(2)} %), `
      + `standing at least ${READ_H} px tall in its tallest column. `
      + 'Seconds per lap of the autopiloted player\'s second lap; s = car arclength. '
      + '`hid` = seconds it would read but the deck, terrain or a car covers it. Worst first.',
    '',
    '| # | track | piece | u | readable s | seen s | hid s | peak % | median % | tallest px | best stretch | longest hidden stretch | main occluder | 4P readable s | still |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'
  ];
  rows.forEach((p, n) => {
    md.push(`| ${n + 1} | ${p.track} | ${p.label} | ${p.u.toFixed(3)} | ${p.readable} | ${p.visible} | ${p.hidden} | ${p.peak} | ${p.median} | ${p.peakH} | ${span(p.best)} | ${hidSpan(p.hid)} | ${p.occluder || ''} | ${p.four ? p.four.readable : ''} | ${p.shot ? `[still](${p.shot})` : ''} |`);
  });
  fs.writeFileSync(path.join(OUT, 'visibility.md'), md.join('\n') + '\n');
  console.log(`wrote ${OUT}`);
}
await browser.close();
await app.close();
