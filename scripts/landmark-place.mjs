// LANDMARK PLACE: better spots for the set pieces a racer barely sees
// (window.__landmarks.better, the placement search; TestHarness.js says what it
// may move, how far, and what it keeps clear of). Prints, per track, each
// searched piece where it stands and reads now and where it would read better.
//
// --write rewrites those pieces' `u` and `lat` in public/shared/tracks.js. The
// search scores moves without building them, so then regenerate the track
// defs, rebuild the engine, and score the built tracks to see what the moves
// actually bought (scatter re-rolls and the ground flattens round a moved piece):
//   node scripts/gen-track-defs-header.mjs && native/scripts/build-runtime-web.sh
//   npm run score:landmarks
//
// Usage: npm run place:landmarks [-- --track a,b] [--write]
import fs from 'node:fs';
import path from 'node:path';
import { serveApp, launchBrowser, displayURL, waitForScene, args, ROOT } from './lib/capture.mjs';

const a = args();
const TRACKS_JS = path.join(ROOT, 'public/shared/tracks.js');
const { TRACK_LIST } = await import(TRACKS_JS);
const all = TRACK_LIST.map((t) => t.id);
const ids = a.track ? String(a.track).split(',') : all;
for (const id of ids) if (!all.includes(id)) throw new Error(`unknown track ${id}`);

const app = await serveApp();
const browser = await launchBrowser();
const page = await browser.page({ viewport: { width: 640, height: 360 } });
await page.goto(displayURL(app.port, { scenario: 'landmarks', track: ids[0], players: 1, dpr: 0.5 }));
await waitForScene(page, { timeout: 180000 });
await page.waitForFunction(() => window.__landmarks && window.__landmarks.ready(), null, { timeout: 180000, polling: 250 });

let src = fs.readFileSync(TRACKS_JS, 'utf8');
let moved = 0;
for (const id of ids) {
  const r = await page.evaluate(async (t) => {
    const l = window.__landmarks;
    if (l.trackId() !== t) await l.track(t);
    return l.better();
  }, id);
  console.log(id);
  const moves = new Map();
  for (const p of r.proposals) {
    const f = p.from, to = p.to;
    console.log(`  ${p.hero ? '*' : ' '}${p.label.padEnd(20)} reads ${String(f.seen).padStart(4)}s  ${to
      ? `-> ${String(to.seen).padStart(4)}s  (u ${f.u.toFixed(3)} -> ${to.u.toFixed(3)}, lat ${f.lat} -> ${to.lat.toFixed(1)})`
      : `stays (${p.candidates} legal spots)`}${p.clash ? `  (${p.clash})` : ''}`);
    if (to) moves.set(p.index, { u: (Math.round(to.u * 1000) / 1000) % 1, lat: Math.round(to.lat * 10) / 10, yaw: to.yaw });
  }
  if (!a.write || !moves.size) continue;
  // The k-th entry of the track's `set: [ ... ]` is layout row k (every GLB
  // loads; ttp_display_set_layout keeps authored order).
  const at = src.indexOf(`\n  ${id}: {`);
  const s0 = src.indexOf('set: [', at);
  const s1 = src.indexOf('\n    ]', s0);
  if (at < 0 || s0 < 0 || s1 < 0) throw new Error(`${id}: no set list in tracks.js`);
  const lines = src.slice(s0, s1).split('\n');
  let k = -1;
  const out = lines.map((line) => {
    if (!/^\s*\{ model:/.test(line)) return line;
    k++;
    const m = moves.get(k);
    if (!m) return line;
    moved++;
    const at = line.replace(/\bu: [-\d.]+/, `u: ${m.u}`).replace(/\blat: [-\d.]+/, `lat: ${m.lat}`);
    // a piece moved across the road is turned to face it from there
    if (/\byaw: /.test(at)) return at.replace(/\byaw: [-\d.]+/, `yaw: ${m.yaw}`);
    return m.yaw ? at.replace(/ \}(,?)$/, `, yaw: ${m.yaw} }$1`) : at;
  });
  src = src.slice(0, s0) + out.join('\n') + src.slice(s1);
}
if (a.write) {
  fs.writeFileSync(TRACKS_JS, src);
  console.log(`moved ${moved} pieces in public/shared/tracks.js`);
}
await browser.close();
await app.close();
