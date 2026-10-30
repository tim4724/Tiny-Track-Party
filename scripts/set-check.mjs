#!/usr/bin/env node
// set-check.mjs — what an eye should not have to catch in a set piece: parts
// left floating. A set-*.glb is cut into ISLANDS (triangles joined by a shared
// corner, seams welded), and an island is held up when it stands on the floor
// (the model's y = 0, the ground the renderer stands it on; a part sunk below
// it is planted) or touches an island that is. Touching is the islands'
// surfaces coming within TOUCH of each other, triangle against triangle, so a
// part pushed into another counts and one a hair off does not; boxes would
// call a bell hanging inside its arch held. What is left after the walk is
// floating: a part the builder misplaced, mis-rotated or left behind.
//
//   node scripts/set-check.mjs [set-name ...]    (every shipped set piece when none named)
//
// prints each piece's size, triangle count and floating islands, each with how
// far it is from the nearest part that is held up. tests/set-pieces.test.js
// holds every shipped piece to none.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { glbTriangles } from '../public/display/glbTriangles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SET_DIR = path.join(ROOT, 'public/assets/toycar');

// Two islands touch within this distance, in the model's (world) units: a
// gap under it does not show from the road.
const TOUCH = 0.1;
// How far a floating island's gap to the held part nearest it is measured;
// past it the gap reads as "far".
const GAP_REACH = 1.0;


// Closest-point geometry (Ericson, Real-Time Collision Detection 5.1).
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const along = (a, d, t) => [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

function pointTri(p, [a, b, c]) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return dist(p, a);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return dist(p, b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return dist(p, along(a, ab, d1 / (d1 - d3)));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return dist(p, c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return dist(p, along(a, ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return dist(p, along(b, sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
  const den = 1 / (va + vb + vc);
  return dist(p, along(along(a, ab, vb * den), ac, vc * den));
}

function segSeg(p1, q1, p2, q2) {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s = 0, t = 0;
  if (a <= 1e-12 && e <= 1e-12) return dist(p1, p2);
  if (a <= 1e-12) t = clamp01(f / e);
  else {
    const c = dot(d1, r);
    if (e <= 1e-12) s = clamp01(-c / a);
    else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den > 1e-12 ? clamp01((b * f - c * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); } else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  return dist(along(p1, d1, s), along(p2, d2, t));
}

// Whether the segment p..q passes through triangle t (Moller-Trumbore).
function segThroughTri(p, q, [a, b, c]) {
  const d = sub(q, p), e1 = sub(b, a), e2 = sub(c, a), h = cross(d, e2), det = dot(e1, h);
  if (Math.abs(det) < 1e-12) return false;
  const s = sub(p, a), u = dot(s, h) / det;
  if (u < 0 || u > 1) return false;
  const qv = cross(s, e1), v = dot(d, qv) / det;
  if (v < 0 || u + v > 1) return false;
  const t = dot(e2, qv) / det;
  return t >= 0 && t <= 1;
}

const edges = ([a, b, c]) => [[a, b], [b, c], [c, a]];
function triTri(s, t) {
  for (const [p, q] of edges(s)) if (segThroughTri(p, q, t)) return 0;
  for (const [p, q] of edges(t)) if (segThroughTri(p, q, s)) return 0;
  let best = Infinity;
  for (const p of s) best = Math.min(best, pointTri(p, t));
  for (const p of t) best = Math.min(best, pointTri(p, s));
  for (const [p1, q1] of edges(s)) for (const [p2, q2] of edges(t)) best = Math.min(best, segSeg(p1, q1, p2, q2));
  return best;
}

const boxOf = (pts) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], p[d]); hi[d] = Math.max(hi[d], p[d]); }
  return { lo, hi };
};
// The gap between two boxes (0 where they overlap).
const boxGap = (a, b) => Math.hypot(...[0, 1, 2].map((d) => Math.max(0, a.lo[d] - b.hi[d], b.lo[d] - a.hi[d])));

export function checkPiece(file) {
  const tris = glbTriangles(fs.readFileSync(file));
  // Islands: triangles joined through a shared corner, corners welded by
  // position (the exporter splits them at every UV and normal seam).
  const ids = new Map();
  const parent = [];
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const corner = (p) => {
    const k = p.map((v) => Math.round(v * 1e4)).join(',');
    if (!ids.has(k)) { ids.set(k, parent.length); parent.push(parent.length); }
    return ids.get(k);
  };
  const triCorners = tris.map((t) => t.map(corner));
  for (const [a, b, c] of triCorners) { parent[find(b)] = find(a); parent[find(c)] = find(a); }
  const roots = new Map();
  const islands = [];
  tris.forEach((t, k) => {
    const r = find(triCorners[k][0]);
    if (!roots.has(r)) { roots.set(r, islands.length); islands.push({ tris: [] }); }
    islands[roots.get(r)].tris.push({ t, box: boxOf(t) });
  });
  for (const isl of islands) isl.box = boxOf(isl.tris.flatMap((x) => [x.box.lo, x.box.hi]));
  const n = islands.length;

  // The nearest the surfaces of islands i and j come, stopping at `within`
  // (Infinity past it).
  const gapBetween = (i, j, within) => {
    const A = islands[i], B = islands[j];
    if (boxGap(A.box, B.box) > within) return Infinity;
    const as = A.tris.filter((x) => boxGap(x.box, B.box) <= within);
    const bs = B.tris.filter((x) => boxGap(x.box, A.box) <= within);
    let best = Infinity;
    for (const x of as) {
      for (const y of bs) {
        if (boxGap(x.box, y.box) > Math.min(best, within)) continue;
        best = Math.min(best, triTri(x.t, y.t));
        if (best === 0) return 0;
      }
    }
    return best <= within ? best : Infinity;
  };

  // Held up: on the floor, or touching what is.
  const held = islands.map((isl) => isl.box.lo[1] <= TOUCH);
  const queue = [...held.keys()].filter((i) => held[i]);
  while (queue.length) {
    const i = queue.pop();
    for (let j = 0; j < n; j++) {
      if (!held[j] && gapBetween(i, j, TOUCH) <= TOUCH) { held[j] = true; queue.push(j); }
    }
  }

  const all = boxOf(islands.flatMap((isl) => [isl.box.lo, isl.box.hi]));
  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    triangles: tris.length,
    islands: n,
    size: { x: r2(all.hi[0] - all.lo[0]), y: r2(all.hi[1] - all.lo[1]), z: r2(all.hi[2] - all.lo[2]) },
    floating: [...Array(n).keys()].filter((i) => !held[i]).map((i) => {
      const { lo, hi } = islands[i].box;
      let gap = Infinity;
      for (let j = 0; j < n; j++) if (held[j]) gap = Math.min(gap, gapBetween(i, j, Math.min(gap, GAP_REACH)));
      return { at: lo.map((v, d) => r2((v + hi[d]) / 2)), size: hi.map((v, d) => r2(v - lo[d])),
               above: r2(lo[1]), gap: r2(gap) };
    })
  };
}

export const shippedPieces = () => fs.readdirSync(SET_DIR)
  .filter((f) => /^set-.*\.glb$/.test(f)).map((f) => f.replace(/\.glb$/, '')).sort();

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : shippedPieces();
  let bad = 0;
  for (const name of names) {
    const r = checkPiece(path.join(SET_DIR, `${name}.glb`));
    console.log(`${name.padEnd(26)} ${r.size.x}x${r.size.z}x${r.size.y}  ${String(r.triangles).padStart(6)} tris  ${r.floating.length ? `${r.floating.length} FLOATING` : 'ok'}`);
    for (const f of r.floating) {
      console.log(`    at [${f.at}] size [${f.size}], ${f.above} up, ${Number.isFinite(f.gap) ? `${f.gap} from a held part` : 'far from any held part'}`);
    }
    if (r.floating.length) bad++;
  }
  if (bad) { console.log(`${bad} piece(s) with floating parts`); process.exitCode = 1; }
}
