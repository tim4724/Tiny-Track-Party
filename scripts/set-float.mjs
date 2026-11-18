#!/usr/bin/env node
// set-float.mjs — the set pieces against the ground the renderer DRAWS under
// them, where they are placed. scripts/set-check.mjs holds a model to its own
// floor (y = 0); this holds each PLACEMENT to the land: a piece lifted by a
// row's `y`, or standing rigid where the land falls away, hangs over it, and
// no model-only check can see that.
//
// Each model is cut into islands (triangles joined by a shared corner). An
// island whose lowest corners are at the model's floor is a standing part, and
// its gap is those corners' height over display.groundY. A part the renderer
// drapes lies on the land by construction and is left out.
//
//   npm run check:floating [-- --track id ...] [--detail lite] [--min 0.15]
//
// prints, per placement with a part more than `min` off the ground, how many
// parts stand wholly clear and the worst corner. What stands in the sea reads
// as off the ground too (the bed is under the water): judge those by eye. A
// measuring tool, not a gate: tests/e2e/terrain-ground.spec.js gates the
// pieces modelled on their own terrain.
import fs from 'node:fs';
import path from 'node:path';

import { glbTriangles } from '../public/display/glbTriangles.js';
import { CUPS, TRACKS } from '../public/shared/tracks.js';
import { ROOT, args, displayURL, launchBrowser, serveApp } from './lib/capture.mjs';

const DIR = path.join(ROOT, 'public/assets/toycar');
const FLOOR = 0.12;   // an island this near the model's floor stands on the ground

function islandsOf(model) {
  const file = path.join(DIR, `${model}.glb`);
  if (!fs.existsSync(file)) return [];
  const tris = glbTriangles(fs.readFileSync(file));
  const ids = new Map(), parent = [];
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const corner = (p) => {
    const k = p.map((v) => Math.round(v * 1e3)).join(',');
    if (!ids.has(k)) { ids.set(k, parent.length); parent.push(parent.length); }
    return ids.get(k);
  };
  const tc = tris.map((t) => t.map(corner));
  for (const [a, b, c] of tc) { parent[find(b)] = find(a); parent[find(c)] = find(a); }
  const by = new Map();
  tris.forEach((t, k) => {
    const r = find(tc[k][0]);
    if (!by.has(r)) by.set(r, { pts: [], drape: false });
    by.get(r).pts.push(...t);
    if (t.drape) by.get(r).drape = true;
  });
  const out = [];
  for (const o of by.values()) {
    const lo = Math.min(...o.pts.map((p) => p[1]));
    if (!o.drape && lo <= FLOOR) out.push(o.pts.filter((p) => p[1] <= lo + 0.05));
  }
  return out;
}

const opt = args();
const named = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] || '').startsWith('--'));
const ids = [].concat(opt.track && opt.track !== true ? [opt.track] : [], named);
const tracks = ids.length ? ids : CUPS.flatMap((c) => c.tracks);
const lite = opt.detail === 'lite', min = Number(opt.min) || 0.15;

const app = await serveApp();
const browser = await launchBrowser({ realUser: false });   // reads no pixel: the automation path is the cheap one
const page = await browser.page();
const models = new Map();
let found = 0;
for (const id of tracks) {
  await page.goto(displayURL(app.port, { scenario: 'track', track: id, dpr: 0.5, detail: lite ? 'lite' : null }));
  await page.waitForFunction(() => window.__scene && window.__scene.display
    && window.__scene.display.setLayout().pieces.length > 0, null, { timeout: 120000, polling: 200 });
  const layout = await page.evaluate(() => window.__scene.display.setLayout());
  const set = TRACKS[id].set || [];
  const parts = [];
  layout.pieces.forEach((r, i) => {
    const k = set[i]?.scale ?? 1, c = Math.cos(r.heading), s = Math.sin(r.heading);
    const model = lite && fs.existsSync(path.join(DIR, `${r.model}-lite.glb`)) ? `${r.model}-lite` : r.model;
    if (!models.has(model)) models.set(model, islandsOf(model));
    for (const feet of models.get(model)) {
      parts.push({ i, feet: feet.map(([x, y, z]) => [r.x + (c * x + s * z) * k, r.y + y * k, r.z + (-s * x + c * z) * k]) });
    }
  });
  const gaps = await page.evaluate((parts) => parts.map(({ feet }) => {
    const d = window.__scene.display;
    let lo = Infinity, hi = -Infinity;
    for (const [x, y, z] of feet) { const g = y - d.groundY(x, z); lo = Math.min(lo, g); hi = Math.max(hi, g); }
    return [lo, hi];
  }), parts);
  const per = new Map();
  parts.forEach((p, j) => {
    if (gaps[j][1] < min) return;
    if (!per.has(p.i)) per.set(p.i, []);
    per.get(p.i).push(gaps[j]);
  });
  for (const [i, list] of per) {
    const clear = list.filter(([lo]) => lo > 0.1);
    found++;
    console.log(`${id}  ${layout.pieces[i].model} (row ${i})  ${clear.length} of ${list.length} parts wholly clear`
      + `${clear.length ? `, by up to ${Math.max(...clear.map(([lo]) => lo)).toFixed(2)}` : ''}`
      + `; worst corner ${Math.max(...list.map(([, hi]) => hi)).toFixed(2)}`);
  }
}
console.log(found ? `${found} placement(s) with a part over ${min} off the ground` : `nothing over ${min} off the ground`);
await browser.close();
app.close();
