// decal-conform-audit — does every flat decal painted on the deck actually stay
// under the deck's own mesh, on every catalogue track?
//
// WHAT GOES WRONG. The road is swept as N evenly-spaced rings (buildRoadMesh
// targets 0.24u) and each ring's points come from frameAt(s_i), so the road
// surface BETWEEN rings is a chord. Every decal is likewise a chord mesh at its
// own vertex spacing, and two chord approximations of one curve at different
// steps do not agree. Where the decal's surface sags further from the true deck
// than the road's does, the road stands above the decal and pokes through it.
// The decal's small lift is the entire budget for that. Sagitta goes as step^2,
// so a decal tessellated 3x coarser than the road sags ~9x deeper.
//
// TWO FAILURE MODES, opposite in sign, and knowing which one applies is the
// whole diagnosis:
//   FLAT decal      (built from one hoisted frame)  fails on CONCAVE deck —
//                   loops and dips, where the true surface rises above the
//                   decal's plane. Unbounded by the lift: measured 0.175u.
//   CONFORMED decal (a frame per vertex)            fails on CONVEX deck —
//                   crests, where its chords sag below the road's finer ones.
//                   Bounded, and small once the vertex spacing is sane.
// Only the second is fixable by lifting, which is why conforming is not
// optional and a lift is not a substitute for it.
//
// WHAT THIS FOUND (2026-07-30). buildOils built the whole slick from a single
// frameAt(o.s) — a flat 2u disc on a bending deck, 0.175u out on a loop and
// 0.090u on a crest-only track against a 0.012 lift, with 11.3% of catalogue
// positions unsafe. It looked fine purely because no shipped oil sits on
// curvature. The boost disk was conformed but coarse (16 segments over a radius
// reaching 1.56u) and ran 0.026u proud at full boost, 1.3x its lift. Both are
// fixed; this script is what says so, and what will say so again.
//
// It also retired a plan. The conformed decals disagree with the deck by at most
// 0.0005u — 5% of their lift — so porting the JS renderer's zero-lift decal
// clipper (the retired RoadDecal.js) would buy no depth correctness. That is a
// look and architecture question now, not a bug.
//
// THIS MIRRORS THE RENDERER'S TESSELLATION IN JS, which is exactly the kind of
// second implementation this tree does not tolerate silently — TtpRenderer.cpp
// needs the Filament SDK, so no ctest can reach the real geometry. MIRRORED
// below is the whole set of numbers copied out of it, each pinned back to the
// line it came from; verifyMirrors() re-reads the C++ and fails when one moves,
// and tests/decal-conform.test.js runs it. Change a lift or a segment count in
// the renderer and this file has to be updated in the same commit.
//
// Usage:
//   node scripts/decal-conform-audit.mjs              shipped furniture
//   node scripts/decal-conform-audit.mjs --sweep      relocation sweep
//   node scripts/decal-conform-audit.mjs --sweep --step 2

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, buildTrack, trackFrames, trackSweep } from './native-track.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = path.join(ROOT, 'native/renderer/src/TtpRenderer.cpp');

// ---- the mirror ------------------------------------------------------------
// `find` is matched against TtpRenderer.cpp verbatim. Keep each one narrow
// enough that it can only match the line it names.
export const MIRRORED = [
  { name: 'pad lift',        value: 0.01,  find: 'const float LIFT = 0.01f;' },
  { name: 'pad chevron lift',value: 0.012, find: '(LIFT + 0.002f)' },
  { name: 'pad disc segs',   value: 24,    find: 'const int SEG = 24;   // PAD_DISC_SEG' },
  { name: 'pad disc rings',  value: 3,     find: 'static const float DISC_RINGS[3] = { 0.35f, 0.7f, 1.0f };' },
  { name: 'oil lift',        value: 0.012, find: 'const float3 ctr = at(0, 0, 0.012f);' },
  { name: 'oil rim lift',    value: 0.014, find: 'o.radius, 0.014f);' },
  { name: 'oil segs',        value: 24,    find: 'constexpr int SEG = 24;' },
  { name: 'oil rings',       value: 3,     find: 'static const float RINGS[3] = { 0.35f, 0.7f, 1.0f };' },
  { name: 'box blob lift',   value: 0.004, find: 'f.up * 0.004f;' },
  { name: 'box blob segs',   value: 20,    find: 'constexpr int SEG = 20;' },
  { name: 'box blob radius', value: 0.3,   find: 'constexpr float R = 0.3f;' },
  { name: 'boost disk segs', value: 24,    find: 'const int SEG = 24; // BOOST_DISK_SEG' },
  { name: 'boost disk rings',value: 3,     find: 'constexpr int NR = 3;' },
  { name: 'car blob grid',   value: '10x14', find: 'constexpr int GW = 10, GL = 14;' },
  { name: 'car blob overscan', value: 1.45, find: 'fw * 1.45f, L = fl * 1.45f;' },
  { name: 'dynamic lift',    value: 0.02,  find: 'carS, carLat, outerR, outerR, 0.02f,' },
  { name: 'road ring target', value: 0.24, find: 'std::lround(L / std::min(0.24f' },
  // RENDER ORDER, and it is correctness rather than taste. Both must stay BELOW
  // the cars' default priority of 4. The boost aura was 5 — drawn after the cars
  // — so its plane, 0.02 above the deck, won the depth test across the bottom
  // 0.02 of every tyre and painted a bright band there; that band is what read as
  // the aura hovering, because it sits visibly above where the wheels touch. The
  // blob shadow sits one below the aura so the aura still paints over it. Nothing
  // geometric in this audit can see a priority, so they are pinned here.
  { name: 'car blob priority',   value: 2, find: 'if (!buildMesh(m, true, mi, 2)) return false;' },
  { name: 'boost disk priority', value: 3, find: 'if (!buildMesh(m, true, mi, 3)) return false;' },
];

export function verifyMirrors() {
  const src = fs.readFileSync(RENDERER, 'utf8');
  const missing = MIRRORED.filter((m) => !src.includes(m.find));
  return { ok: missing.length === 0, missing };
}

// ---- constants, mirrored (see MIRRORED) ------------------------------------
const PAD_LIFT = 0.01, OIL_LIFT = 0.012, BOX_LIFT = 0.004, DYN_LIFT = 0.02;
const PAD_DISC_SEG = 24, OIL_SEG = 24, BOX_SEG = 20, DISK_SEG = 24;
const OIL_RINGS = [0.35, 0.7, 1.0];
const DISK_RINGS = [0.36, 0.72, 1.0];
const BOX_R = 0.3, BOX_RINGS = [0.55, 1.0];
const PAD_DISC_RINGS = [0.35, 0.7, 1.0];
const GW = 10, GL = 14, OVERSCAN = 1.45, FOOT_W = 0.95, FOOT_L = 2.0;
const STRIP_ROWS = 16, STRIP_COLS = 4;

// Boost disk sizing, TtpRenderer.cpp's per-frame block:
//   sc = (1.25 + k*1.4) * (0.94 + 0.08*pulse);  outerR = (footW+footL)*0.5*sc*0.5
// k = boostMul-1, which a pad gives as 0.25..0.60 (PAD_BOOST_MIN/MAX in game.cc).
export const diskOuterR = (k, pulse = 0.9) =>
  (FOOT_W + FOOT_L) * 0.5 * ((1.25 + k * 1.4) * (0.94 + 0.08 * pulse)) * 0.5;

// buildRoadMesh's ring count, verbatim.
export function ringCount(L) {
  const step = Math.min(0.24, Math.max(0.06, Math.min(2.0, 5.76 * 0.25) / 3));
  let N = Math.min(4000, Math.max(8, Math.round(L / step)));
  const dashCycles = Math.max(2, Math.round(L / 5.76));
  let rpc = Math.max(4, Math.round(N / dashCycles));
  if (rpc * dashCycles > 4000) rpc = Math.max(4, Math.floor(4000 / dashCycles));
  return rpc * dashCycles;
}

const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const mul = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

// One batched trackFrames call per track; s quantized so a vertex and a sample
// on the same arclength share a query.
class Frames {
  constructor(id, L) { this.id = id; this.L = L; this.want = new Map(); }
  norm(s) { const L = this.L; return ((s % L) + L) % L; }
  key(s) { return Math.round(this.norm(s) * 1e6); }
  ask(s) { const k = this.key(s); if (!this.want.has(k)) this.want.set(k, this.norm(s)); return k; }
  resolve() {
    const keys = [...this.want.keys()], sl = [...this.want.values()];
    this.got = new Map();
    for (let i = 0; i < sl.length; i += 4000) {
      const part = trackFrames(this.id, sl.slice(i, i + 4000));
      for (let j = 0; j < part.length; j++) this.got.set(keys[i + j], part[j]);
    }
  }
  at(k) { return this.got.get(k); }
}

// A CONFORMED vertex: on the true deck at its own (s, lat), lifted along that
// frame's up. conformDecalAt Newton-solves from the car's plane rather than
// using this parameterization, but it lands vertices on the surface either way,
// which is what fixes the chord geometry.
const conf = (s, lat, lift) => ({ s, lat, lift, flat: false });
// A FLAT vertex: built in one anchor frame's tangent plane. Kept so the
// regression this script was written for can still be reproduced (--flat-oil).
const flat = (anchor, latAnchor, ca, sa, r, lift) =>
  ({ s: anchor + sa * r, lat: latAnchor + ca * r, lift, flat: true, anchor, latAnchor, ca, sa, r });

function place(v, fr) {
  const f = fr.at(fr.key(v.flat ? v.anchor : v.s));
  if (!v.flat) return add(add(f.pos, mul(f.lateral, v.lat)), mul(f.up, v.lift));
  const ctr = add(add(f.pos, mul(f.lateral, v.latAnchor)), mul(f.up, v.lift));
  return add(add(ctr, mul(f.lateral, v.ca * v.r)), mul(f.tangent, v.sa * v.r));
}

// A centre-fan disc with concentric rings: verts[0] centre, then ring after
// ring, each SEG+1 verts. Matches buildPadsMesh / buildOils / the boost disk.
function ringedDisc(mk, rings, seg) {
  const verts = [mk(0, 0)], tris = [];
  for (const rr of rings) {
    for (let j = 0; j <= seg; j++) {
      const a = j / seg * 2 * Math.PI;
      verts.push(mk(Math.cos(a) * rr, Math.sin(a) * rr));
    }
  }
  for (let j = 0; j < seg; j++) tris.push([0, 1 + j, 2 + j]);
  for (let r = 0; r + 1 < rings.length; r++) {
    const a0 = 1 + r * (seg + 1), b0 = a0 + seg + 1;
    for (let j = 0; j < seg; j++) {
      tris.push([a0 + j, b0 + j, b0 + j + 1], [a0 + j, b0 + j + 1, a0 + j + 1]);
    }
  }
  return { verts, tris };
}

// ---- the decals ------------------------------------------------------------
export const DECALS = {
  // buildPadsMesh, chevron disc: toWorld maps each canvas point through its own
  // frameAt, so d is along travel and the lat offset is across it.
  padDisc: (s0, lat0, r = 0.9) => ({
    kind: 'pad-disc', lift: PAD_LIFT, conformed: true,
    ...ringedDisc((ca, sa) => conf(s0 - sa * r, lat0 + ca * r, PAD_LIFT),
                  PAD_DISC_RINGS, PAD_DISC_SEG),
  }),
  // buildPadsMesh, launch strip: a 16x4 grid, v along travel.
  padStrip: (s0, lat0, halfL = 1.1, halfW = 2.5) => {
    const verts = [], tris = [];
    const at = (x, y) => conf(s0 + (0.5 - y / 128) * 2 * halfL,
                              lat0 + (x / 320 - 0.5) * 2 * halfW, PAD_LIFT);
    for (let r = 0; r < STRIP_ROWS; r++) for (let c = 0; c < STRIP_COLS; c++) {
      const y0 = r * (128 / STRIP_ROWS), y1 = (r + 1) * (128 / STRIP_ROWS);
      const x0 = c * (320 / STRIP_COLS), x1 = (c + 1) * (320 / STRIP_COLS);
      const b = verts.length;
      verts.push(at(x0, y0), at(x1, y0), at(x0, y1), at(x1, y1));
      tris.push([b, b + 2, b + 1], [b + 1, b + 2, b + 3]);
    }
    return { kind: 'pad-strip', lift: PAD_LIFT, conformed: true, verts, tris };
  },
  // buildOils, post-fix: conformed, three rings.
  oil: (s0, lat0, r = 1.0) => ({
    kind: 'oil-slick', lift: OIL_LIFT, conformed: true,
    ...ringedDisc((ca, sa) => conf(s0 + sa * r, lat0 + ca * r, OIL_LIFT), OIL_RINGS, OIL_SEG),
  }),
  // buildOils, PRE-fix: one hoisted frame, flat in its tangent plane, 1 ring.
  oilFlat: (s0, lat0, r = 1.0) => ({
    kind: 'oil-slick(flat)', lift: OIL_LIFT, conformed: false,
    ...ringedDisc((ca, sa) => flat(s0, lat0, ca, sa, r, OIL_LIFT), [1.0], 16),
  }),
  boxBlob: (s0, lat0) => ({
    kind: 'box-blob', lift: BOX_LIFT, conformed: true,
    ...ringedDisc((ca, sa) => conf(s0 + sa * BOX_R, lat0 + ca * BOX_R, BOX_LIFT),
                  BOX_RINGS, BOX_SEG),
  }),
  boostDisk: (s0, lat0, outerR = diskOuterR(0.6)) => ({
    kind: 'boost-disk', lift: DYN_LIFT, conformed: true,
    ...ringedDisc((ca, sa) => conf(s0 + sa * outerR, lat0 + ca * outerR, DYN_LIFT),
                  DISK_RINGS, DISK_SEG),
  }),
  carBlob: (s0, lat0) => {
    const W = FOOT_W * OVERSCAN, L = FOOT_L * OVERSCAN, verts = [], tris = [];
    for (let j = 0; j <= GL; j++) for (let i = 0; i <= GW; i++) {
      verts.push(conf(s0 + (j / GL - 0.5) * L, lat0 + (i / GW - 0.5) * W, DYN_LIFT));
    }
    for (let j = 0; j < GL; j++) for (let i = 0; i < GW; i++) {
      const b = j * (GW + 1) + i, n = b + GW + 1;
      tris.push([b, n, b + 1], [b + 1, n, n + 1]);
    }
    return { kind: 'car-blob', lift: DYN_LIFT, conformed: true, verts, tris };
  },
};

// Where inside a triangle to look. DENSE is a 3-per-edge barycentric grid;
// COARSE is the centroid plus the three edge midpoints, which is what the gate
// uses. A chord's deviation from the curve it spans peaks in the middle and is
// zero at the vertices, so those four points find nearly the same maximum for
// 2.5x less work. Measured against DENSE across the catalogue, COARSE
// UNDER-reads by at most 0.0016u (the boost disk; every other kind is under
// 0.0005), so it is only safe while the margins stay comfortably wider than
// that — they run 0.0018 to 0.0177 today. It still catches the retired flat
// slick at 0.168 against DENSE's 0.175. If a margin ever narrows toward 0.002,
// move the gate back to DENSE.
export const DENSE = (() => { const o = [], n = 3;
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) o.push([i / n, j / n, (n - i - j) / n]);
  return o; })();
export const COARSE = [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0], [0.5, 0, 0.5], [0, 0.5, 0.5]];

// Worst road-above-decal penetration for each decal, along the true deck normal.
export function measure(id, L, decals, BARY = DENSE) {
  const N = ringCount(L), fr = new Frames(id, L), ringS = (i) => (i / N) * L;
  for (const d of decals) {
    for (const v of d.verts) fr.ask(v.flat ? v.anchor : v.s);
    d.samples = [];
    for (const tri of d.tris) {
      const [a, b, c] = tri.map((i) => d.verts[i]);
      for (const w of BARY) {
        const s = a.s * w[0] + b.s * w[1] + c.s * w[2];
        const lat = a.lat * w[0] + b.lat * w[1] + c.lat * w[2];
        const u = fr.norm(s) / L * N, i = Math.floor(u);
        fr.ask(s); fr.ask(ringS(i)); fr.ask(ringS((i + 1) % N));
        d.samples.push({ tri, w, s, lat, ri: i, t: u - i });
      }
    }
  }
  fr.resolve();
  for (const d of decals) {
    let pen = -Infinity, at = 0;
    for (const sm of d.samples) {
      const [a, b, c] = sm.tri.map((i) => d.verts[i]);
      const D = add(add(mul(place(a, fr), sm.w[0]), mul(place(b, fr), sm.w[1])),
                    mul(place(c, fr), sm.w[2]));
      const f = fr.at(fr.key(sm.s));
      const trueP = add(f.pos, mul(f.lateral, sm.lat));
      const f0 = fr.at(fr.key(ringS(sm.ri))), f1 = fr.at(fr.key(ringS((sm.ri + 1) % N)));
      const R = add(mul(add(f0.pos, mul(f0.lateral, sm.lat)), 1 - sm.t),
                    mul(add(f1.pos, mul(f1.lateral, sm.lat)), sm.t));
      const p = dot(sub(R, trueP), f.up) - dot(sub(D, trueP), f.up);
      if (p > pen) { pen = p; at = sm.s; }
    }
    d.pen = pen; d.penAt = at;
    delete d.samples;
  }
  return decals;
}

export const TRACKS = ['tidepool', 'cove', 'driftwood', 'riptide', 'powder',
  'flurry', 'glacier', 'avalanche', 'ribbon', 'pretzel', 'tangle', 'cloverleaf',
  'wash', 'gulch', 'crag', 'sidewinder', 'skysnake', 'skyline', 'helix', 'gauntlet'];

// The furniture each track actually ships, as decals.
export function shippedDecals(t) {
  const out = [];
  for (const p of t.pads || []) {
    out.push(p.shape === 'strip'
      ? DECALS.padStrip(p.s, p.lat, p.halfLen, p.halfWidth)
      : DECALS.padDisc(p.s, p.lat, p.radius));
  }
  for (const h of t.hazards || []) out.push(DECALS.oil(h.s, h.lat, h.radius));
  for (const b of t.boxes || []) out.push(DECALS.boxBlob(b.s, b.lat));
  return out;
}

// THE POSITIONS THAT CAN ACTUALLY FAIL, so a gate need not sweep the whole lap
// (which is ~17 s of CPU across the catalogue — too slow for `npm test`).
// Failure lives at curvature extremes, and the two modes sit at OPPOSITE signs:
// a conformed decal's chords sag below the deck on CONVEX ground (a crest,
// d2pos pointing against up), while a flat decal is overtaken by ground rising
// above its plane on CONCAVE ground (a dip or the inside of a loop). Taking the
// top k of each sign covers both without walking every metre.
//
// Curvature is the second difference of position projected on the local up, off
// one uniform sweep. Extremes are de-clustered by `minGap` so k positions are
// k distinct features rather than k samples of one crest.
export function extremeCurvaturePositions(id, k = 12, minGap = 6) {
  const sw = trackSweep(id, 0.2);
  const pts = [];
  for (let i = 1; i + 1 < sw.length; i++) {
    const a = sw[i - 1], b = sw[i], c = sw[i + 1];
    const h = (c.s - a.s) / 2;
    if (h <= 0) continue;
    const d2 = { x: a.pos.x - 2 * b.pos.x + c.pos.x,
                 y: a.pos.y - 2 * b.pos.y + c.pos.y,
                 z: a.pos.z - 2 * b.pos.z + c.pos.z };
    pts.push({ s: b.s, k: dot(d2, b.up) / (h * h) });
  }
  const pick = (cmp) => {
    const out = [];
    for (const p of [...pts].sort(cmp)) {
      if (out.length >= k) break;
      if (out.every((q) => Math.abs(q.s - p.s) > minGap)) out.push(p);
    }
    return out;
  };
  return {
    convex: pick((x, y) => x.k - y.k).map((p) => p.s),   // most negative: crests
    concave: pick((x, y) => y.k - x.k).map((p) => p.s),  // most positive: dips
  };
}

// One decal of each kind dropped at every `step` of the lap.
export function relocationSweep(id, L, makers, step, lat = 0.7) {
  const out = new Map();
  for (const [name, make] of Object.entries(makers)) {
    const items = [];
    for (let s = 0; s < L; s += step) items.push(make(s, lat));
    measure(id, L, items);
    let over = 0, worst = -Infinity, worstAt = 0;
    for (const d of items) {
      if (d.pen > 0) over++;
      if (d.pen > worst) { worst = d.pen; worstAt = d.penAt; }
    }
    out.set(name, { n: items.length, over, worst, worstAt, lift: items[0].lift });
  }
  return out;
}

// ---- CLI -------------------------------------------------------------------
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const SWEEP = process.argv.includes('--sweep');
  const stepArg = process.argv.indexOf('--step');
  const STEP = stepArg > 0 ? Number(process.argv[stepArg + 1]) : 1.0;
  const FLAT = process.argv.includes('--flat-oil');

  const mirror = verifyMirrors();
  if (!mirror.ok) {
    console.error('MIRROR DRIFT — these no longer appear in TtpRenderer.cpp:');
    for (const m of mirror.missing) console.error(`  ${m.name}: expected \`${m.find}\``);
    console.error('\nThe renderer changed and this script still describes the old geometry.');
    process.exit(1);
  }
  console.log(`mirror ok — ${MIRRORED.length} renderer constants still where this script expects\n`);

  await init();
  const pad = (s, w) => String(s).padEnd(w), padl = (s, w) => String(s).padStart(w);

  if (!SWEEP) {
    console.log('SHIPPED FURNITURE — worst road-above-decal penetration, world units.');
    console.log('Positive means the deck stands above the decal. Road width 5.0.\n');
    const KINDS = ['pad-disc', 'pad-strip', 'oil-slick', 'box-blob'];
    console.log(pad('track', 12) + KINDS.map((k) => padl(k, 12)).join('') + padl('', 8));
    console.log('-'.repeat(12 + 48 + 8));
    const agg = new Map();
    for (const id of TRACKS) {
      const t = buildTrack(id);
      const ds = measure(id, t.length, shippedDecals(t));
      let bad = 0;
      const cells = KINDS.map((k) => {
        const mine = ds.filter((d) => d.kind === k);
        if (!mine.length) return padl('-', 12);
        const w = Math.max(...mine.map((d) => d.pen));
        if (w > 0) bad++;
        const a = agg.get(k) || { worst: -Infinity, n: 0, over: 0, lift: mine[0].lift };
        a.n += mine.length; a.over += mine.filter((d) => d.pen > 0).length;
        a.worst = Math.max(a.worst, w); agg.set(k, a);
        return padl(w.toFixed(4) + (w > 0 ? '*' : ' '), 12);
      });
      console.log(pad(id, 12) + cells.join('') + padl(bad ? 'THRU' : 'clean', 8));
    }
    console.log('\nCatalogue-wide, worst case and how much of the lift it used:');
    for (const [k, a] of agg) {
      console.log(`  ${pad(k, 11)} lift ${a.lift.toFixed(3)}  worst ${padl(a.worst.toFixed(4), 9)}` +
        `  used ${padl((100 * (1 + a.worst / a.lift)).toFixed(0) + '%', 5)}  ${a.over}/${a.n} through`);
    }
  } else {
    const makers = {
      'pad-disc': DECALS.padDisc,
      'oil': FLAT ? DECALS.oilFlat : DECALS.oil,
      'box-blob': DECALS.boxBlob,
      'boost-disk': (s, l) => DECALS.boostDisk(s, l, diskOuterR(0.6)),
      'car-blob': DECALS.carBlob,
    };
    const names = Object.keys(makers);
    console.log(`RELOCATION SWEEP — one decal of each kind at every ${STEP}u of lap.` +
      (FLAT ? '\n(--flat-oil: the PRE-FIX unconformed slick, for comparison)' : ''));
    console.log('"unsafe" = lap positions where the deck would poke through.\n');
    console.log(pad('track', 12) + names.map((n) => padl(n, 15)).join(''));
    console.log('-'.repeat(12 + 15 * names.length));
    const agg = new Map(names.map((n) => [n, { over: 0, n: 0, worst: -Infinity, lift: 0 }]));
    for (const id of TRACKS) {
      const t = buildTrack(id);
      const res = relocationSweep(id, t.length, makers, STEP);
      const cells = names.map((n) => {
        const r = res.get(n), a = agg.get(n);
        a.over += r.over; a.n += r.n; a.worst = Math.max(a.worst, r.worst); a.lift = r.lift;
        return padl(`${r.over}/${r.n}` + (r.over ? ` w${r.worst.toFixed(3)}` : ''), 15);
      });
      console.log(pad(id, 12) + cells.join(''));
    }
    console.log('-'.repeat(12 + 15 * names.length));
    console.log('\nCatalogue-wide:');
    for (const [n, a] of agg) {
      console.log(`  ${pad(n, 12)} lift ${a.lift.toFixed(3)}  ${padl(a.over + '/' + a.n, 11)} unsafe ` +
        `(${padl((100 * a.over / a.n).toFixed(1) + '%', 6)})  worst ${padl(a.worst.toFixed(4), 9)}` +
        `  = ${(a.worst / a.lift).toFixed(1)}x lift`);
    }
  }
}
