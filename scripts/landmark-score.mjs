// LANDMARK SCORE: how long a racer sees each track's set pieces over a lap
// (window.__landmarks.score: an autopiloted player's chase rig run through the
// landmark gallery's own sight tests; TestHarness.js says what CLEAN means).
// It is the measure a piece's PLACE is judged by, so run it after moving a
// piece, reshaping one or changing a track's scenery, and read the poor rows'
// reasons: the seconds in the lens lost to being too small, hidden, or under
// a deck. It judges nothing itself; the numbers move with the sight tests.
//
// --board <dir> also photographs every model for the landmark review board,
// at its best-seen placement: the racer's best moment of the lap (the car
// parked where that placement reads best), and the gallery's Glance and High
// views. <dir>/board.json carries the scores beside them, the floating-part
// check (set-check.mjs) and each model's version (a hash of its GLB), which
// is what resets a verdict on the board when the piece changes. --since
// <old board.json> lists the models new or rebuilt since that bake, which the
// board's "Changed since review" filter shows whatever is marked meanwhile.
//
// Usage: npm run score:landmarks [-- --track a,b] [--json out.json] [--board dir [--since old/board.json]]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { serveApp, launchBrowser, displayURL, waitForScene, encode, args, ROOT } from './lib/capture.mjs';
import { checkPiece, SET_DIR } from './set-check.mjs';

const a = args();
const { TRACK_LIST } = await import(path.join(ROOT, 'public/shared/tracks.js'));
const all = TRACK_LIST.map((t) => t.id);
const ids = a.track ? String(a.track).split(',') : all;
for (const id of ids) if (!all.includes(id)) throw new Error(`unknown track ${id}`);
const BOARD = typeof a.board === 'string' ? path.resolve(a.board) : null;
// The shots: what the board shows, at a size a phone and a desktop both read.
const SHOT = { width: 960, height: 540, quality: 0.82 };

const app = await serveApp();
const browser = await launchBrowser();
const page = await browser.page({ viewport: { width: 1280, height: 720 } });
await page.goto(displayURL(app.port, { scenario: 'landmarks', track: ids[0], players: 1, dpr: 1 }));
await waitForScene(page, { timeout: 180000 });
await page.waitForFunction(() => window.__landmarks && window.__landmarks.ready(), null, { timeout: 180000, polling: 250 });
const onTrack = (id) => page.evaluate(async (t) => {
  const l = window.__landmarks;
  if (l.trackId() !== t) await l.track(t);
}, id);

const scores = [];
for (const id of ids) {
  await onTrack(id);
  const r = await page.evaluate(() => window.__landmarks.score());
  scores.push(r);
  console.log(`${id}  (a lap is ${r.lap}s)`);
  console.log('  piece                    s     lat   seen longest  lens small hidden roof  peak  clash');
  for (const p of r.pieces) {
    const n = (v, w) => String(v).padStart(w);
    console.log(`  ${p.label.padEnd(20)} ${n(Math.round(p.s), 5)} ${n(Math.round(p.lat), 5)}  ${n(p.seen, 5)} ${n(p.longest, 7)} ${n(p.lens, 5)} ${n(p.small, 5)} ${n(p.hidden, 6)} ${n(p.roof, 4)} ${n(p.peak, 5)}  ${p.spot}`);
  }
}
if (typeof a.json === 'string') {
  fs.mkdirSync(path.dirname(path.resolve(a.json)), { recursive: true });
  fs.writeFileSync(a.json, JSON.stringify(scores, null, 1));
}

if (BOARD) {
  fs.mkdirSync(path.join(BOARD, 'shots'), { recursive: true });
  // Each model at its best-seen placement: the most clean seconds, then the
  // biggest it read.
  const best = new Map();
  for (const r of scores) {
    for (const p of r.pieces) {
      const b = best.get(p.model);
      if (!b || p.seen > b.p.seen || (p.seen === b.p.seen && p.peak > b.p.peak)) best.set(p.model, { track: r.track, p });
    }
  }
  const settle = () => page.evaluate(() => new Promise((resolve) => {
    let left = 20;
    window.__scene.onAfterFrame = () => { if (--left <= 0) { window.__scene.onAfterFrame = null; resolve(); } };
  }));
  const shoot = async (file) => {
    await settle();
    fs.writeFileSync(path.join(BOARD, 'shots', file), await encode(page, await page.screenshot(), { ...SHOT, type: 'image/jpeg' }));
    return `shots/${file}`;
  };
  const models = [];
  for (const id of ids) {
    const mine = [...best].filter(([, b]) => b.track === id);
    if (!mine.length) continue;
    await onTrack(id);
    const marks = await page.evaluate(() => window.__landmarks.landmarks());
    for (const [model, { p }] of mine) {
      const shots = {};
      if (p.at) {
        await page.evaluate(({ s, lat }) => window.__landmarks.park(s, lat), p.at);
        shots.lap = await shoot(`${model}-lap.jpg`);
      }
      const i = marks.findIndex((m) => m.model === model);
      for (const view of ['glance', 'high']) {
        await page.evaluate(([v, k]) => { window.__landmarks.view(v); window.__landmarks.focus(k); }, [view, i]);
        shots[view] = await shoot(`${model}-${view}.jpg`);
      }
      const file = path.join(SET_DIR, `${model}.glb`);
      const check = checkPiece(file);
      models.push({
        model, label: p.label, track: id, shots,
        version: crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 12),
        check: { triangles: check.triangles, size: check.size, floating: check.floating.length },
        placements: scores.flatMap((r) => r.pieces.filter((q) => q.model === model).map((q) => ({ track: r.track, ...q })))
      });
      console.log(`  shot ${model}`);
    }
  }
  const tracks = TRACK_LIST.filter((t) => ids.includes(t.id))
    .map((t) => {
      const r = scores.find((x) => x.track === t.id);
      return { id: t.id, name: t.name, cup: t.cupName, lap: r.lap, length: r.length };
    });
  // A model is changed when its GLB or any of its placements moved (or
  // turned, where the older bake recorded yaw).
  const old = a.since ? JSON.parse(fs.readFileSync(a.since, 'utf8')).models : [];
  const turned = old.some((m) => m.placements.some((p) => 'yaw' in p));
  const key = (m) => [m.version, ...m.placements.map((p) => `${p.track}:${Math.round(p.s)}:${p.lat}${turned ? `:${p.yaw}` : ''}`).sort()].join('|');
  const before = a.since ? new Map(old.map((m) => [m.model, key(m)])) : null;
  const changed = before ? models.filter((m) => before.get(m.model) !== key(m)).map((m) => m.model) : [];
  fs.writeFileSync(path.join(BOARD, 'board.json'), JSON.stringify({ tracks, models, changed }, null, 1));
  console.log(`board: ${models.length} models in ${BOARD}`);
}
await browser.close();
await app.close();
