// Track generator pipeline — the SHARED engine behind the seeded Backyard circuits.
//
// A track is a SEED. From one integer we:
//   1. genPlan(seed)      — drive a random turtle that nets ±360°, then close it with a
//                           smooth Hermite tail → a closed 2D plan that MAY self-cross,
//                           rescaled to a target lap length.
//   2. findCrossings(...) — detect where the (fixed) footprint crosses itself, mapped to
//                           waypoint-index pairs (crossings depend only on x/z, not height).
//   3. solveElevation(...)— relax a smooth periodic height profile that lifts one strand
//                           over the other at every crossing and returns to ground (y[0]=0,
//                           y≥0, Δ≥1.2 per crossing); bails on a runaway "knot".
// Because the plan closes by construction and elevation is solved on top, the two never
// fight. bakeSeed() returns the resolved waypoints (with y/bridge) that tracks.js imports.
//
// Used by BOTH scripts/gen-tracks.mjs (bake the chosen seeds) and scripts/scan-seeds.mjs
// (audition a whole range). Needs Three.js (via buildTrack to sample + cross-detect), so it
// runs OFFLINE in Node — the browser only ever sees the baked DATA.
const { buildTrack } = await import(new URL('../public/display/TrackBuilder.js', import.meta.url));
const DEG = Math.PI / 180, SCALE = 2; // SCALE MUST match TrackBuilder.js (plan units → world); findCrossings uses it to compare plan coords against world samples

export const mulberry32 = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

export { buildTrack };

// Drive a cursor that emits 2D waypoints. `straight(len)` advances; `turn(deg,r)` arcs.
export function drive(build) {
  let x = 0, z = 0, th = 0; const pts = [];
  const emit = () => pts.push({ x, z });
  const a = {
    straight(len) { const n = Math.max(1, Math.round(len / 12)); for (let i = 0; i < n; i++) { x += Math.cos(th) * len / n; z += Math.sin(th) * len / n; emit(); } return a; },
    turn(deg, r) { const tot = deg * DEG, sg = Math.sign(deg) || 1, n = Math.max(2, Math.round(Math.abs(deg) / 16)); const cx = x + Math.cos(th + sg * Math.PI / 2) * r, cz = z + Math.sin(th + sg * Math.PI / 2) * r; let ang = Math.atan2(z - cz, x - cx); for (let i = 1; i <= n; i++) { ang += tot / n; x = cx + Math.cos(ang) * r; z = cz + Math.sin(ang) * r; th = ang + sg * Math.PI / 2; emit(); } return a; },
  };
  build(a); return { pts, x, z, th };
}

// Append a smooth Hermite connector from the course's END pose back to its START → a loop.
export function closeCourse(r) {
  const p0 = { x: r.x, z: r.z }, d0 = { x: Math.cos(r.th), z: Math.sin(r.th) }, p1 = r.pts[0], sd = { x: 1, z: 0 };
  const dist = Math.hypot(p1.x - p0.x, p1.z - p0.z), m = Math.max(8, dist), n = Math.max(4, Math.round(dist / 8));
  const tail = [];
  for (let i = 1; i < n; i++) { const t = i / n, t2 = t * t, t3 = t2 * t; const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2; tail.push({ x: h00 * p0.x + h10 * m * d0.x + h01 * p1.x + h11 * m * sd.x, z: h00 * p0.z + h10 * m * d0.z + h01 * p1.z + h11 * m * sd.z }); }
  return r.pts.concat(tail);
}

export function genPlan(seed) {
  const rng = mulberry32(seed), rand = (lo, hi) => lo + rng() * (hi - lo);
  const sense = rng() < 0.5 ? 1 : -1; let net = 0;
  const r = drive((a) => {
    a.straight(rand(28, 44));
    const nF = 6 + Math.floor(rng() * 4);
    for (let i = 0; i < nF; i++) {
      const dir = rng() < 0.66 ? sense : -sense; const t = rng();
      if (t < 0.34) { const d = dir * rand(70, 130); a.turn(d, rand(16, 28)); net += d; }
      else if (t < 0.6) { const d = dir * rand(85, 110); a.turn(d, rand(12, 16)); net += d; }
      else if (t < 0.76) { a.turn(38, 13).turn(-38, 13); }
      else a.straight(rand(12, 28));
      if (rng() < 0.4) a.straight(rand(8, 18));
    }
    const need = 360 * sense - net; if (Math.abs(need) >= 25 && Math.abs(need) <= 220) a.turn(need, rand(10, 18));
    a.straight(rand(10, 20));
  });
  let pts = closeCourse(r);
  const len0 = buildTrack({ waypoints: pts }).length, k = rand(420, 470) / len0;
  return pts.map((p) => ({ x: p.x * k, z: p.z * k }));
}

export function findCrossings(flat, plan) {
  const S = flat.centerline.samples, n = S.length, L = flat.length, rw = flat.roadWidth;
  const wpS = plan.map((p) => { let best = 0, bd = Infinity; for (let i = 0; i < n; i++) { const dx = S[i].pos.x - p.x * SCALE, dz = S[i].pos.z - p.z * SCALE, d = dx * dx + dz * dz; if (d < bd) { bd = d; best = i; } } return S[best].s; });
  const nearestWp = (s) => { let best = 0, bd = Infinity; for (let i = 0; i < wpS.length; i++) { const d = Math.min(Math.abs(wpS[i] - s), L - Math.abs(wpS[i] - s)); if (d < bd) { bd = d; best = i; } } return best; };
  const pairs = new Map();
  for (let i = 0; i < n; i += 2) for (let j = i + 2; j < n; j += 2) {
    const arc = Math.min(Math.abs(S[i].s - S[j].s), L - Math.abs(S[i].s - S[j].s)); if (arc < 14) continue;
    const dx = S[i].pos.x - S[j].pos.x, dz = S[i].pos.z - S[j].pos.z; if (dx * dx + dz * dz > (rw * 0.55) ** 2) continue;
    const a = nearestWp(S[i].s), b = nearestWp(S[j].s); if (a === b) continue;
    pairs.set(a < b ? `${a},${b}` : `${b},${a}`, [Math.min(a, b), Math.max(a, b)]);
  }
  return [...pairs.values()];
}

export function solveElevation(wpPairs, M) {
  const D = 1.2, h = new Array(M).fill(0);
  for (let iter = 0; iter < 400; iter++) {
    let worst = 0;
    for (const [a, b] of wpPairs) { const gap = h[a] - h[b], need = D - Math.abs(gap); if (need <= 0) continue; worst = Math.max(worst, need); const s = gap >= 0 ? 1 : -1, push = need / 2 + 0.02; if (a !== 0) h[a] += s * push; if (b !== 0) h[b] -= s * push; }
    const hs = h.slice(); for (let i = 0; i < M; i++) h[i] = 0.8 * hs[i] + 0.1 * (hs[(i - 1 + M) % M] + hs[(i + 1) % M]);
    h[0] = 0; const mn = Math.min(...h); if (mn < 0) for (let i = 0; i < M; i++) h[i] -= mn; h[0] = 0;
    if (Math.max(...h) > 8) throw new Error('elevation diverged (crossing knot)');
    if (worst < 1e-3) break;
  }
  return h;
}

// Resolve a seed → rounded waypoints with baked y/bridge (what tracks.js imports).
export function bakeSeed(seed) {
  const plan = genPlan(seed);
  const flat = buildTrack({ waypoints: plan });
  const h = solveElevation(findCrossings(flat, plan), plan.length);
  return plan.map((p, i) => { const o = { x: +p.x.toFixed(2), z: +p.z.toFixed(2) }; if (h[i] > 0.05) o.y = +h[i].toFixed(2); if (h[i] > 0.6) o.bridge = true; return o; });
}

// Audition a seed WITHOUT committing it: returns the gate stats so scan-seeds.mjs can rank
// candidates. `pass` mirrors the qualities the unit tests enforce on shipped tracks:
//   closed (gap<0.5) · smooth (worst plan-heading step <0.08) · ≥1 self-crossing, each
//   bridged ≥1.5 world · elevation solves (no knot) · lap ~40-60s (length 350-480).
export function evaluateSeed(seed) {
  let plan, flat;
  try { plan = genPlan(seed); flat = buildTrack({ waypoints: plan }); }
  catch (e) { return { seed, pass: false, reason: 'plan failed: ' + e.message }; }
  const L = flat.length, S = flat.centerline.samples, n = S.length;
  // smoothness: worst |heading step| per 0.1 world units (skip bridges/loops/flares)
  let prev = null, worstStep = 0;
  for (let s = 0; s <= L; s += 0.1) {
    const f = flat.centerline.sampleAt(s);
    if (Math.hypot(f.tangent.x, f.tangent.z) < 0.5 || f.up.y < 0.9 || f.pos.y > 2.05 || flat.centerline.widthAt(s) > 5.4) { prev = null; continue; }
    const hd = Math.atan2(f.tangent.x, f.tangent.z);
    if (prev != null) { let d = hd - prev; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; worstStep = Math.max(worstStep, Math.abs(d)); }
    prev = hd;
  }
  // DISTINCT self-crossings (deduped to waypoint-index pairs — independent of height)
  const crossings = findCrossings(flat, plan).length;
  // bridge clearance + peak height after the solve
  let elev, threw = false;
  try { const h = solveElevation(findCrossings(flat, plan), plan.length); const baked = plan.map((p, i) => ({ ...p, y: h[i] })); elev = buildTrack({ waypoints: baked }); }
  catch (e) { threw = true; }
  let minBridge = Infinity, maxY = 0;
  if (elev) {
    const E = elev.centerline.samples, EL = elev.length, rw = elev.roadWidth;
    for (const s of E) maxY = Math.max(maxY, s.pos.y);
    for (let i = 0; i < E.length; i += 2) for (let j = i + 2; j < E.length; j += 2) {
      const arc = Math.min(Math.abs(E[i].s - E[j].s), EL - Math.abs(E[i].s - E[j].s)); if (arc < 14) continue;
      const dx = E[i].pos.x - E[j].pos.x, dz = E[i].pos.z - E[j].pos.z; if (dx * dx + dz * dz > (rw * 0.55) ** 2) continue;
      minBridge = Math.min(minBridge, Math.abs(E[i].pos.y - E[j].pos.y));
    }
  }
  const lapSec = L * 0.124;
  const pass = !threw && elev != null && flat.gap < 0.5 && worstStep < 0.08
    && crossings >= 1 && minBridge >= 1.5 && L >= 350 && L <= 480 && maxY <= 8;
  return { seed, pass, gap: +flat.gap.toFixed(2), len: Math.round(L), lapSec: Math.round(lapSec),
    step: +worstStep.toFixed(3), crossings, bridge: crossings ? +minBridge.toFixed(1) : 0,
    maxY: +maxY.toFixed(1), knot: threw, wp: plan.length };
}
