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
// Import SCALE from TrackBuilder so the plan→world factor can never drift out of sync
// (findCrossings compares plan coords against world samples and must use the same value).
const { buildTrack, SCALE } = await import(new URL('../public/display/TrackBuilder.js', import.meta.url));
const DEG = Math.PI / 180;

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
  const p0 = { x: r.x, z: r.z }, d0 = { x: Math.cos(r.th), z: Math.sin(r.th) }, p1 = r.pts[0];
  // arrival tangent = the course's ACTUAL start heading (pts[0]→pts[1]), so the Hermite tail
  // joins smoothly whatever direction genPlan opens with — not hardcoded to the turtle's +X.
  const p2 = r.pts[1] || { x: p1.x + 1, z: p1.z }, sl = Math.hypot(p2.x - p1.x, p2.z - p1.z) || 1;
  const sd = { x: (p2.x - p1.x) / sl, z: (p2.z - p1.z) / sl };
  const dist = Math.hypot(p1.x - p0.x, p1.z - p0.z), m = Math.max(8, dist), n = Math.max(4, Math.round(dist / 8));
  const tail = [];
  for (let i = 1; i < n; i++) { const t = i / n, t2 = t * t, t3 = t2 * t; const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2; tail.push({ x: h00 * p0.x + h10 * m * d0.x + h01 * p1.x + h11 * m * sd.x, z: h00 * p0.z + h10 * m * d0.z + h01 * p1.z + h11 * m * sd.z }); }
  return r.pts.concat(tail);
}

// ---- difficulty PROFILES ----
// One parameter table per cup flavour. The turtle grammar is shared; a profile only
// re-weights its distributions (feature count, corner radii/angles, rhythm, lap target),
// names the seeded DECORATION passes to run after the elevation solve (rolling hills,
// banked sweepers, width flares/pinches), and carries the difficulty BAND (`gates`) a
// candidate must land in — structural gates plus measured metrics (see measureTrack)
// and a headless AI lap probe (see aiProbe).
//
// `classic` reproduces the shipped Backyard bakes BIT-FOR-BIT: identical rng call order
// and ranges to the original hard-coded generator, no decoration. Never retune it — a
// change here silently reshapes live tracks the next time gen-tracks.mjs runs.
export const PROFILES = {
  classic: {
    opening: [28, 44], features: [6, 9], sameSense: 0.66,
    pSweep: 0.34, sweepAngle: [70, 130], sweepR: [16, 28],
    pTight: 0.26, tightAngle: [85, 110], tightR: [12, 16],
    pChicane: 0.16, chicane: { angle: 38, r: 13 },
    midStraight: [12, 28], pExtra: 0.4, extraLen: [8, 18],
    closerR: [10, 18], finalStraight: [10, 20], target: [420, 470],
    decor: null,
    gates: { len: [350, 480], crossings: [1, 9], minRadius: [0, 99], hairpins: [0, 9],
      cornerDensity: [0, 99], brakeFrac: [0, 1] }
  },
  // EASY — wide-open flow: few features, all sweepers, long recovery straights, a soft
  // chicane at most. Gentle rolling hills + a helpful banked sweeper; flares on the
  // straights so the road reads roomy where the pack fights. Short lap (~45s).
  easy: {
    opening: [30, 44], features: [4, 6], sameSense: 0.72,
    pSweep: 0.55, sweepAngle: [60, 110], sweepR: [22, 34],
    pTight: 0.0, tightAngle: [80, 100], tightR: [16, 20],
    pChicane: 0.12, chicane: { angle: 30, r: 16 },
    midStraight: [14, 30], pExtra: 0.45, extraLen: [10, 20],
    closerR: [14, 22], finalStraight: [12, 22], target: [350, 395],
    decor: { hills: [1, 2], hillAmp: [0.5, 0.9], hillHW: [3, 4], hops: [2, 4], hopAmp: [0.12, 0.3],
      bank: 8, bankRun: 4, maxBanked: 1, flares: 2, flareW: [3.1, 3.4], pinches: 1, pinchW: 2.35 },
    oilCount: 1,
    // Calibrated against the catalogue (probe-difficulty.mjs): meadow — the canonical
    // Easy — measures brake 0.04, minR 6.8, dens 0.041; bowtie (Medium) brake 0.01.
    gates: { len: [340, 400], crossings: [0, 1], minRadius: [5.0, 99], hairpins: [0, 0],
      cornerDensity: [0, 0.055], brakeFrac: [0, 0.10] }
  },
  // MID — the Backyard flavour, decorated: same grammar as classic, plus rolling hills
  // and the odd banked sweeper/flare so new mid tracks aren't crossing-only flat.
  mid: {
    opening: [28, 44], features: [6, 9], sameSense: 0.66,
    pSweep: 0.34, sweepAngle: [70, 130], sweepR: [16, 28],
    pTight: 0.26, tightAngle: [85, 110], tightR: [12, 16],
    pChicane: 0.16, chicane: { angle: 38, r: 13 },
    midStraight: [12, 28], pExtra: 0.4, extraLen: [8, 18],
    closerR: [10, 18], finalStraight: [10, 20], target: [420, 470],
    decor: { hills: [1, 2], hillAmp: [0.6, 1.1], hillHW: [2, 4], hops: [2, 4], hopAmp: [0.15, 0.35],
      bank: 8, bankRun: 4, maxBanked: 1, flares: 2, flareW: [3.0, 3.4], pinches: 1, pinchW: 2.25 },
    oilCount: 2,
    // Band of the shipped Backyard four: brake 0.01-0.17, minR 2.2-7.2, dens 0.030-0.044,
    // crossings 12-16 (!) — crossing count is DRAMA, not difficulty; corners/braking are
    // the difficulty axis, so the band is generous on crossings and strict on those.
    gates: { len: [410, 480], crossings: [1, 16], minRadius: [2.0, 99], hairpins: [0, 2],
      cornerDensity: [0.025, 0.06], brakeFrac: [0.02, 0.35] }
  },
  // HARD — dense and technical: more features per lap, genuinely tight corners up to
  // hairpins, short (sometimes no) recovery straights, sharper chicanes, width pinches
  // through the technical clusters, bigger hills (crests). 2-3 crossings.
  hard: {
    opening: [24, 36], features: [7, 10], sameSense: 0.7,
    pSweep: 0.30, sweepAngle: [70, 130], sweepR: [15, 26],
    pTight: 0.34, tightAngle: [95, 150], tightR: [9, 12],
    pChicane: 0.2, chicane: { angle: 45, r: 10 },
    midStraight: [10, 22], pExtra: 0.35, extraLen: [8, 14],
    closerR: [9, 14], finalStraight: [8, 16], target: [430, 480],
    decor: { hills: [2, 3], hillAmp: [0.8, 1.6], hillHW: [2, 3], hops: [1, 3], hopAmp: [0.15, 0.4],
      bank: 8, bankRun: 5, maxBanked: 1, flares: 1, flareW: [3.0, 3.3], pinches: 2, pinchW: 2.15 },
    oilCount: 2,
    // Calibration: switchback (the canonical Hard) probes brake 0.66 — but its lap is
    // 25s of wall-to-wall corners; at Backyard lap length (~50s) even a 3-hairpin
    // track dilutes to ~0.14, while bowtie (Medium) sits at 0.01 and the easy band
    // tops out at 0.10. So ≥0.10 + ≥1 hairpin (which already forces a tight-corner
    // moment — no minRadius ceiling needed) + short recovery is what "Hard" measures
    // at this length; the minRadius floor guards spline kinks.
    gates: { len: [420, 490], crossings: [1, 4], minRadius: [1.5, 99], hairpins: [1, 9],
      cornerDensity: [0.035, 99], brakeFrac: [0.10, 1] }
  }
};

export function genPlan(seed, prof = PROFILES.classic) {
  const rng = mulberry32(seed), rand = (lo, hi) => lo + rng() * (hi - lo);
  const sense = rng() < 0.5 ? 1 : -1; let net = 0;
  const r = drive((a) => {
    a.straight(rand(...prof.opening));
    const nF = prof.features[0] + Math.floor(rng() * (prof.features[1] - prof.features[0] + 1));
    for (let i = 0; i < nF; i++) {
      const dir = rng() < prof.sameSense ? sense : -sense; const t = rng();
      if (t < prof.pSweep) { const d = dir * rand(...prof.sweepAngle); a.turn(d, rand(...prof.sweepR)); net += d; }
      else if (t < prof.pSweep + prof.pTight) { const d = dir * rand(...prof.tightAngle); a.turn(d, rand(...prof.tightR)); net += d; }
      else if (t < prof.pSweep + prof.pTight + prof.pChicane) { a.turn(prof.chicane.angle, prof.chicane.r).turn(-prof.chicane.angle, prof.chicane.r); }
      else a.straight(rand(...prof.midStraight));
      if (rng() < prof.pExtra) a.straight(rand(...prof.extraLen));
    }
    const need = 360 * sense - net; if (Math.abs(need) >= 25 && Math.abs(need) <= 220) a.turn(need, rand(...prof.closerR));
    a.straight(rand(...prof.finalStraight));
  });
  let pts = closeCourse(r);
  const len0 = buildTrack({ waypoints: pts }).length, k = rand(...prof.target) / len0;
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

// ---- DECORATION passes (seeded, deterministic) ----
// Layer difficulty-flavour onto a solved plan: rolling grass hills on open stretches,
// banking on sustained sweepers, width flares/pinches. All passes leave the PLAN (x/z)
// untouched — hills only add y where the solver left flat ground, banking/width ride the
// per-waypoint channels buildSplineTrack already interpolates — so closure, crossings
// and the solved bridge clearances cannot be disturbed. Waypoints near a crossing (either
// strand), near the start line, or already lifted by the solver are PROTECTED: solver
// heights are load-bearing there, and the grid must stay flat, level and default-width.
// Decoration draws from its own seeded rng stream (never the plan's), so the same seed
// yields the same plan across profiles that differ only in decor.
export function decoratePlan(wps, wpPairs, prof, seed, salt = 0) {
  const D = prof.decor; if (!D) return wps;
  const rng = mulberry32((seed ^ 0xDEC0 ^ Math.imul(salt, 0x9E3779B9)) >>> 0), rand = (lo, hi) => lo + rng() * (hi - lo);
  const randInt = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  const m = wps.length, at = (i) => wps[((i % m) + m) % m];
  // Protection masks. On a multi-crossing plan the solver lifts the ENTIRE lap into a
  // rolling baseline (only the seam is pinned to 0), so "flat ground" doesn't exist —
  // eligibility must be defined RELATIVE to that baseline or decoration never lands:
  //  - `prot` (crossing zones ±1 + the seam) guards every pass — solver heights are
  //    load-bearing right at a crossing and the grid stays level/default-width.
  //  - hills/hops (protHills) additionally avoid each crossing's LOWER strand (a mound
  //    there rises toward the deck above, eating the solved clearance) and the high
  //    skyways (h > 2.0 — headroom under the maxY gate). Elsewhere a bump ADDS to the
  //    smooth baseline, which is harmless.
  //  - banking / width games run anywhere outside `prot`: neither moves the plan, and
  //    the pillar pass re-measures the decorated width when standing columns.
  // The trimmed margins are NOT load-bearing: every candidate is re-measured on its
  // DECORATED geometry (evaluateSeed's minBridge/step gates) and every shipped bake
  // runs the "no overlapping strands" suite, so real crowding fails loudly.
  // Per-waypoint plan turn: angle between the incoming and outgoing legs, signed so
  // LEFT (in the world frame the builder uses: +bank leans toward lateral-LEFT) is +1.
  // Left of travel is -X when heading +Z, i.e. cross(v1, v2).y < 0 → left turn.
  const turnAt = (i) => {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1);
    const v1x = p1.x - p0.x, v1z = p1.z - p0.z, v2x = p2.x - p1.x, v2z = p2.z - p1.z;
    const cross = v1z * v2x - v1x * v2z, dot = v1x * v2x + v1z * v2z;
    return Math.atan2(cross, dot); // + = left
  };

  // Plan curvature at a waypoint (rad per unscaled unit): per-wp turn alone can't tell a
  // sweeper from a hairpin — the turtle emits ~16° per point on EVERY arc — so divide by
  // the local leg length.
  const kAt = (i) => {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1);
    const l1 = Math.hypot(p1.x - p0.x, p1.z - p0.z), l2 = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    return Math.abs(turnAt(i)) / Math.max(0.5, (l1 + l2) / 2);
  };

  const prot = new Array(m).fill(false);
  const mark = (arr, i, r) => { for (let d = -r; d <= r; d++) arr[(((i + d) % m) + m) % m] = true; };
  for (const [a, b] of wpPairs) { mark(prot, a, 1); mark(prot, b, 1); }
  mark(prot, 0, 2); // the grid straddles the seam
  const protHills = prot.slice();
  for (const [a, b] of wpPairs) mark(protHills, wps[a].y < wps[b].y ? a : b, 1); // the under-strand
  for (let i = 0; i < m; i++) {
    if (wps[i].y > 2.0) protHills[i] = true;           // high skyways
    // ...and TIGHT corners: the centripetal Catmull-Rom parameterizes by 3D distance,
    // so lifting a waypoint re-times the x/z interpolation around it — a bump on a
    // tight corner can sharpen the plan turn past the smoothness gate (and a blind hop
    // into a hairpin is mean design anyway). Sweepers (world radius ≳ 10) keep their
    // mounds; kAt ≥ 0.2 unscaled ≈ tighter than that.
    if (kAt(i) >= 0.2) protHills[i] = true;
  }

  // ROLLING HILLS: raised-cosine bumps dropped onto flat, unprotected runs — the berm
  // pass grows grass under them, so they read as terrain, not ramps. A bump's feet land
  // at zero rise, so it splices smoothly into the flat ground either side.
  const used = protHills.slice(); // hills also shouldn't stack on each other
  const nHills = randInt(...D.hills);
  for (let hIdx = 0, tries = 0; hIdx < nHills && tries < 30; tries++) {
    const hw = randInt(...D.hillHW), c = randInt(0, m - 1);
    let free = true;
    for (let d = -hw; d <= hw; d++) if (used[(((c + d) % m) + m) % m]) { free = false; break; }
    if (!free) continue;
    const amp = rand(...D.hillAmp);
    for (let d = -hw; d <= hw; d++) {
      const j = (((c + d) % m) + m) % m;
      wps[j].y = (wps[j].y || 0) + amp * (1 + Math.cos(Math.PI * d / hw)) / 2;
      used[j] = true;
    }
    hIdx++;
  }

  // HOPS: pocket-size bumps — a quick rise-and-fall the car crests with a little kick.
  // Same flat-ground rules as hills (the berm pass grows a grass hump under each), just
  // smaller and more frequent: hw=1 raises a single waypoint (feet land at zero either
  // side, the spline rounds it into a hop), hw=2 a short roller.
  if (D.hops) {
    const nHops = randInt(...D.hops);
    for (let hIdx = 0, tries = 0; hIdx < nHops && tries < 40; tries++) {
      const hw = randInt(1, 2), c = randInt(0, m - 1);
      let free = true;
      for (let d = -hw; d <= hw; d++) if (used[(((c + d) % m) + m) % m]) { free = false; break; }
      if (!free) continue;
      const amp = rand(...D.hopAmp);
      for (let d = -hw; d <= hw; d++) {
        const j = (((c + d) % m) + m) % m;
        wps[j].y = (wps[j].y || 0) + amp * (1 + Math.cos(Math.PI * d / hw)) / 2;
        used[j] = true;
      }
      hIdx++;
    }
  }

  // BANKED SWEEPERS: find sustained same-hand cornering runs (every waypoint turning
  // the same way, hard enough to be a real corner) on open ground, and lean the road
  // into the turn. Only the run's INTERIOR waypoints carry the bank — the per-waypoint
  // lerp in buildSplineTrack then eases it in/out across the boundary spans.
  const K_TURN = 0.05; // rad of heading change at a waypoint that counts as cornering
  let banked = 0;
  for (let i = 0; i < m && banked < D.maxBanked; i++) {
    const t0 = turnAt(i);
    if (Math.abs(t0) < K_TURN || prot[i]) continue;
    const sgn = Math.sign(t0);
    let j = i;
    while (j < m && !prot[j] && Math.sign(turnAt(j)) === sgn && Math.abs(turnAt(j)) >= K_TURN) j++;
    const runLen = j - i;
    if (runLen >= D.bankRun) {
      for (let k = i + 1; k < j - 1; k++) wps[k].bank = sgn * D.bank;
      banked++;
    }
    i = j;
  }

  // WIDTH: flares bulge straights out to `flareW` (roomy fights, launch zones); pinches
  // squeeze a cornering cluster to `pinchW` (thread the needle). Interior-only, like
  // banking, so the width lerps back to default at the run edges.
  // "Straight" here is generous (< 0.035 rad/wp): the turtle's straights pick up gentle
  // curvature from the closing spline, and a flare on a softly bending run still lerps
  // cleanly — demanding dead-straight starves the pass on organic shapes.
  const straightRuns = [], cornerRuns = [];
  for (let i = 0; i < m;) {
    if (prot[i]) { i++; continue; }
    const straight = Math.abs(turnAt(i)) < 0.035, corner = Math.abs(turnAt(i)) >= K_TURN;
    let j = i;
    while (j < m && !prot[j]
      && (straight ? Math.abs(turnAt(j)) < 0.035 : corner ? Math.abs(turnAt(j)) >= K_TURN : false)) j++;
    if (straight && j - i >= 4) straightRuns.push([i, j]);
    if (corner && j - i >= 3) cornerRuns.push([i, j]);
    i = Math.max(j, i + 1);
  }
  for (let f = 0; f < D.flares && straightRuns.length; f++) {
    const [a, b] = straightRuns.splice(randInt(0, straightRuns.length - 1), 1)[0];
    const peak = rand(...D.flareW);
    for (let k = a; k < b; k++) wps[k].w = +(2.5 + (peak - 2.5) * Math.sin(Math.PI * (k - a) / (b - a - 1 || 1))).toFixed(2);
  }
  for (let p = 0; p < D.pinches && cornerRuns.length; p++) {
    const [a, b] = cornerRuns.splice(randInt(0, cornerRuns.length - 1), 1)[0];
    for (let k = a + 1; k < b - 1; k++) wps[k].w = D.pinchW;
  }
  return wps;
}

// Worst |heading step| per 0.1 world units — the smoothness gate the unit tests enforce,
// measured with the same skips (vertical stunt / tilted flank / high deck / flared width).
function worstStepOf(wps) {
  const t = buildTrack({ waypoints: wps });
  let prev = null, worst = 0;
  for (let s = 0; s <= t.length; s += 0.1) {
    const f = t.centerline.sampleAt(s);
    if (Math.hypot(f.tangent.x, f.tangent.z) < 0.5 || f.up.y < 0.9 || f.pos.y > 2.05 || t.centerline.widthAt(s) > 5.4) { prev = null; continue; }
    const hd = Math.atan2(f.tangent.x, f.tangent.z);
    if (prev != null) { let d = hd - prev; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; worst = Math.max(worst, Math.abs(d)); }
    prev = hd;
  }
  return worst;
}

// Round a resolved plan to the shipping waypoint form (what tracks.js imports). y>0.05 →
// carry an elevation; SOLVER h>0.6 → bridge (pillars, not a berm). 0.6 = half the solver's
// crossing clearance D=1.2: above the midpoint a waypoint is the OVER strand of a crossing.
// Decorated hills never set `bridge` — they must berm, which is exactly why the solver's h
// is kept separate from the decorated y here.
const roundWps = (wps, h) => wps.map((o, i) => {
  const out = { x: +o.x.toFixed(2), z: +o.z.toFixed(2) };
  if (o.y > 0.05) out.y = +o.y.toFixed(2);
  if (h[i] > 0.6) out.bridge = true;
  if (o.w != null) out.w = +o.w.toFixed(2);
  if (o.bank) out.bank = Math.round(o.bank);
  return out;
});

// ---- START ANCHOR ----
// Where does a lap START? At waypoint 0 — which is wherever genPlan's turtle happened to
// begin. Nothing ever CHOSE it, and that shows: genPlan opens with a straight running
// FORWARD from waypoint 0, while closeCourse joins the lap's end back to it matching
// HEADING but not CURVATURE. So the opening straight protects the launch run, and the road
// immediately BEHIND the line — an arbitrary corner in the Hermite tail — is left to chance.
// That is exactly where the grid sits: Game.js seeds the cars at totalS -2.5…-6.5 and lap 1
// opens by driving ACROSS the line. Before this pass 14 of 16 seeds started mid-corner;
// sidewinder's grid radius was 2 world units on a 5-wide road, banked and downhill.
//
// The rest of the pipeline ALREADY anchors to the start: solveElevation pins the seam to
// ground (h[0]=0), decoratePlan protects it from hills/banking/width, placeFurniture claims
// the first 5% of the lap. All of them were anchored to a spot nobody picked. So choose the
// anchor BEFORE the solve and every one of those protections starts doing its job.
//
// Rotating a closed ring is the SAME CURVE: the footprint (x/z) stays bit-identical, and so
// do the crossings (findCrossings reads x/z only). Elevation and decoration DO re-solve —
// that's the point, they re-anchor onto the new grid.
const rotateRing = (a, k) => a.slice(k).concat(a.slice(0, k));

// The grid window, in world arclength either side of the start line. Back: the four cars sit
// at s = -2.5 … -6.5 (Game.js `totalS: -(2.5 + row * 1.6)`), so -7 spans the whole grid.
// Forward: the launch run they accelerate down before the first real corner.
const GRID_BACK = 7, GRID_FWD = 12;

// ---- GANTRY dimensions ----
// Mirrors render/FinishGate.js (which imports THREE, so it can't be imported here — keep
// these in sync; the "gantry clears any deck over the line" test guards the pair, and
// FinishGate carries a back-reference). The gantry is a GATE, not a point: two pylons
// straddling the road at ±(roadWidth/2 + REACH), a banner across the top, the whole thing
// rising GANTRY_TOP above the road surface — so its clearance is tested against that full
// lateral SPAN (a deck that misses the centreline entirely can still be speared by a pylon,
// as avalanche's did: it passes 4.6 out, clear of the road, through the right-hand pylon).
const GANTRY_TOP = 2.8;     // FinishGate CLEAR (2.0) + BANNER_H (0.8) — pylon/banner top
const GANTRY_REACH = 1.15;  // FinishGate kerbW + KERB_CLEAR + 2×PYLON_R, plus slack for a
                            // themed kerb (theme.road.kerbW overrides the 0.22 default)

// What a good grid looks like. minRadius is world units against a 5-wide road (30 = a gentle
// drift, not a corner); grade/bank are the frame's y-components (~4.5° / ~3.5°); rise keeps
// the grid near ground level rather than up on a bridge deck; widthTol keeps a decorated
// flare/pinch off it; minHeadroom keeps the finish gantry out of a deck overhead — the
// gantry top plus a little slack. This gate exists because the other criteria actively
// select FOR the danger: the under-strand of a crossing is flat, level, ground-height and
// straight, precisely what a good grid looks like, so a search blind to headroom will
// happily park the line under a bridge.
const GRID_GATE = { minRadius: 30, maxGrade: 0.08, maxBank: 0.06, maxRise: 1.0, widthTol: 0.25, minHeadroom: GANTRY_TOP + 0.3 };
const ANCHOR_SHORTLIST = 16; // full resolves per seed — the prefilter's job is to keep this small

// The lowest road strand crossing over the gantry's footprint at arclength s0 (Infinity =
// clear sky). Distances are to the gantry's lateral segment, not to a point.
function gantryHeadroom(t, s0 = 0) {
  const cl = t.centerline, L = t.length, f = cl.sampleAt(s0);
  const half = t.roadWidth / 2 + GANTRY_REACH;
  const ll = Math.hypot(f.lateral.x, f.lateral.z) || 1;
  const ux = f.lateral.x / ll, uz = f.lateral.z / ll;
  let lowest = Infinity;
  for (const sm of cl.samples) {
    const arc = Math.min(Math.abs(sm.s - s0), L - Math.abs(sm.s - s0));
    if (arc < 6) continue;                       // our own road either side of the line
    const dy = sm.pos.y - f.pos.y;
    if (dy <= 0.3) continue;                     // not above us
    const dx = sm.pos.x - f.pos.x, dz = sm.pos.z - f.pos.z;
    const along = Math.max(-half, Math.min(half, dx * ux + dz * uz)); // clamp onto the span
    if (Math.hypot(dx - along * ux, dz - along * uz) > sm.width / 2) continue; // slab misses it
    lowest = Math.min(lowest, dy);
  }
  return lowest;
}

// |curvature| at s, as a central difference of plan heading over ±h world units.
const curvatureAt = (cl, s, h = 1.0) => {
  const a = cl.sampleAt(s - h), b = cl.sampleAt(s + h);
  let d = Math.atan2(b.tangent.x, b.tangent.z) - Math.atan2(a.tangent.x, a.tangent.z);
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d / (2 * h));
};

// Measure the grid window of a BUILT track around arclength s0. Exported so the segment-DSL
// tracks — which have no generator to re-anchor, and instead declare `startU` (see
// TrackBuilder.finalizeTrack) — are judged against this same standard.
export function measureGrid(t, s0 = 0) {
  const cl = t.centerline;
  let groundY = Infinity;
  for (const sm of cl.samples) groundY = Math.min(groundY, sm.pos.y);
  let curvature = 0, grade = 0, bank = 0, minWidth = Infinity, maxWidth = 0, rise = 0;
  for (let d = -GRID_BACK; d <= GRID_FWD; d += 0.5) {
    const s = s0 + d, f = cl.sampleAt(s);
    curvature = Math.max(curvature, curvatureAt(cl, s));
    grade = Math.max(grade, Math.abs(f.tangent.y));
    bank = Math.max(bank, Math.abs(f.lateral.y));
    const w = cl.widthAt(s);
    minWidth = Math.min(minWidth, w); maxWidth = Math.max(maxWidth, w);
    rise = Math.max(rise, f.pos.y - groundY);
  }
  return { curvature, minRadius: curvature > 1e-5 ? 1 / curvature : Infinity, grade, bank,
    minWidth, maxWidth, rise, headroom: gantryHeadroom(t, s0) };
}
export const gridPasses = (g, roadWidth) => g.minRadius > GRID_GATE.minRadius
  && g.grade < GRID_GATE.maxGrade && g.bank < GRID_GATE.maxBank && g.rise < GRID_GATE.maxRise
  && Math.abs(g.maxWidth - roadWidth) < GRID_GATE.widthTol
  && Math.abs(g.minWidth - roadWidth) < GRID_GATE.widthTol
  && g.headroom > GRID_GATE.minHeadroom;
// Rank: anchors that PASS first, then the straightest/flattest/levellest among them. A deck
// over the line is disqualifying rather than merely costly — no solved crossing ever clears
// GANTRY_TOP (D=1.2 plan = 2.4 world), so "a bit of headroom" is never good enough.
const gridCost = (g, roadWidth) => (gridPasses(g, roadWidth) ? 0 : 1000)
  + (g.headroom > GRID_GATE.minHeadroom ? 0 : 1000)
  + g.curvature * 200 + g.grade * 40 + g.bank * 60 + Math.max(0, g.rise - 0.6) * 3
  + Math.abs(g.maxWidth - roadWidth) * 2;

// Plan curvature at waypoint i (rad per UNSCALED unit) — x/z only. Rotation cannot change
// it, which is what makes it a sound cheap PREFILTER: it tests the necessary condition (the
// grid must sit on a straight run of PLAN) without paying for a solve. Grade/bank/width are
// anchor-DEPENDENT, so the survivors still get resolved in full.
const planCurvAt = (plan, i) => {
  const m = plan.length, at = (j) => plan[((j % m) + m) % m];
  const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1);
  const v1x = p1.x - p0.x, v1z = p1.z - p0.z, v2x = p2.x - p1.x, v2z = p2.z - p1.z;
  const turn = Math.abs(Math.atan2(v1z * v2x - v1x * v2z, v1x * v2x + v1z * v2z));
  return turn / Math.max(0.5, (Math.hypot(v1x, v1z) + Math.hypot(v2x, v2z)) / 2);
};
// The waypoints inside anchor k's grid window, walked out by PLAN arclength (the window is
// world units; the plan is unscaled, hence /SCALE). Bounded by m so a degenerate leg can't spin.
const gridWindowIdx = (plan, k) => {
  const m = plan.length, at = (j) => plan[((j % m) + m) % m], wrap = (j) => ((j % m) + m) % m;
  const out = [k];
  for (let j = k, d = 0, n = 0; d < GRID_BACK / SCALE && n < m; j--, n++) { d += Math.hypot(at(j).x - at(j - 1).x, at(j).z - at(j - 1).z); out.push(wrap(j - 1)); }
  for (let j = k, d = 0, n = 0; d < GRID_FWD / SCALE && n < m; j++, n++) { d += Math.hypot(at(j + 1).x - at(j).x, at(j + 1).z - at(j).z); out.push(wrap(j + 1)); }
  return out;
};

// Pick the plan waypoint the start line should sit on: shortlist by plan straightness, then
// fully resolve each survivor and score its real, decorated grid.
function chooseAnchor(plan, resolveAt) {
  const ranked = [];
  for (let k = 0; k < plan.length; k++) {
    let worst = 0;
    for (const i of gridWindowIdx(plan, k)) worst = Math.max(worst, planCurvAt(plan, i));
    ranked.push({ k, worst });
  }
  ranked.sort((a, b) => a.worst - b.worst || a.k - b.k);
  let best = null;
  for (const { k } of ranked.slice(0, ANCHOR_SHORTLIST)) {
    let g, t;
    // solveElevation can diverge for a given anchor (a "crossing knot" it can't lift from
    // that seam) — that anchor simply isn't available; the shortlist has plenty more.
    try { const r = resolveAt(k); t = buildTrack({ waypoints: roundWps(r.wps, r.h) }); g = measureGrid(t); }
    catch { continue; }
    const cost = gridCost(g, t.roadWidth);
    if (!best || cost < best.cost) best = { k, cost };
  }
  if (!best) throw new Error('no usable start anchor: every shortlisted candidate diverged');
  return best.k;
}

// Resolve a seed through the full pipeline WITHOUT rounding: plan → crossings → start
// anchor → elevation solve → decoration. Returns everything evaluateSeed/bakeSeed need.
//
// Decoration is SELF-HEALING: a bump re-times the centripetal spline around it, and an
// unlucky roll can sharpen a marginal corner past the smoothness gate even with the
// tight-corner exclusions. Rather than starving every track to save one unlucky seed,
// re-roll the decoration stream (salt 1, 2, …) until the decorated track passes a quick
// smoothness check; salt 0 first keeps existing bakes reproducible.
//
// `anchor: false` pins the start at waypoint 0 (the pre-2026-07-17 behaviour) — for
// comparing against an old bake, not for shipping.
export function resolveSeed(seed, profileName = 'classic', { anchor = true } = {}) {
  const prof = PROFILES[profileName];
  if (!prof) throw new Error(`unknown profile "${profileName}" (have: ${Object.keys(PROFILES).join(', ')})`);
  const plan0 = genPlan(seed, prof);
  const flat = buildTrack({ waypoints: plan0 });
  const pairs0 = findCrossings(flat, plan0);
  const m = plan0.length;

  // Resolve with the start line moved to plan waypoint `k`: rotate the ring, re-index the
  // crossings, then solve + decorate exactly as before. Throws if the solve diverges here.
  const resolveAt = (k) => {
    const plan = k ? rotateRing(plan0, k) : plan0;
    const sh = (i) => ((i - k) % m + m) % m;
    const wpPairs = k ? pairs0.map(([a, b]) => { const x = sh(a), y = sh(b); return [Math.min(x, y), Math.max(x, y)]; }) : pairs0;
    const h = solveElevation(wpPairs, m);
    let wps = null, best = null, bestStep = Infinity;
    for (let salt = 0; salt < 4; salt++) {
      const cand = plan.map((p, i) => ({ x: p.x, z: p.z, y: h[i] }));
      decoratePlan(cand, wpPairs, prof, seed, salt);
      if (!prof.decor) { wps = cand; break; }
      const step = worstStepOf(cand);
      if (step < 0.078) { wps = cand; break; }          // safely under the 0.08 gate
      if (step < bestStep) { bestStep = step; best = cand; }
    }
    if (!wps) wps = best; // all salts marginal — keep the least bad; the gates will judge it
    return { prof, plan, flat, wpPairs, h, wps, anchor: k };
  };

  return resolveAt(anchor ? chooseAnchor(plan0, resolveAt) : 0);
}

// Resolve a seed → rounded waypoints with baked y/bridge/w/bank (what tracks.js imports).
export function bakeSeed(seed, profileName = 'classic', opts) {
  const { h, wps } = resolveSeed(seed, profileName, opts);
  return roundWps(wps, h);
}

// ---- difficulty METRICS ----
// Measure the qualities that make a lap easy or brutal, off the built (decorated)
// geometry: the tightest corner radius, hairpin count, how much of the lap is spent
// cornering, the shortest recovery straight between real corners, width extremes and
// total climb. Complements the structural gates (closure/smoothness/bridging), which
// say a track is VALID — these say which cup it belongs in.
export function measureTrack(t) {
  const cl = t.centerline, L = t.length, STEP = 0.5;
  const stations = [];
  let prevH = null, prevS = 0, totTurn = 0, minW = Infinity, maxW = 0, climb = 0, prevY = null;
  for (let s = 0; s <= L; s += STEP) {
    const f = cl.sampleAt(s);
    const w = cl.widthAt ? cl.widthAt(s) : t.roadWidth;
    minW = Math.min(minW, w); maxW = Math.max(maxW, w);
    if (prevY != null) climb += Math.max(0, f.pos.y - prevY);
    prevY = f.pos.y;
    if (Math.hypot(f.tangent.x, f.tangent.z) < 0.5) { prevH = null; continue; } // vertical stunt — no plan heading
    const h = Math.atan2(f.tangent.x, f.tangent.z);
    if (prevH != null) {
      let dh = h - prevH;
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      stations.push({ s, k: dh / (s - prevS) }); // signed plan curvature, rad/world-unit
      totTurn += Math.abs(dh);
    }
    prevH = h; prevS = s;
  }
  // Corner EVENTS: contiguous same-hand runs of |k| ≥ K_ON. `turn` is the event's total
  // heading change; only events of ≥ ~30° count as real corners (the rest is drift).
  const K_ON = 0.05;
  const events = [];
  let cur = null;
  const flush = () => { if (cur) { events.push(cur); cur = null; } };
  for (const st of stations) {
    if (Math.abs(st.k) < K_ON) { flush(); continue; }
    const sgn = Math.sign(st.k);
    if (!cur || cur.sgn !== sgn) { flush(); cur = { sgn, start: st.s, end: st.s, turn: 0, kPeak: 0 }; }
    cur.turn += Math.abs(st.k) * STEP; cur.end = st.s; cur.kPeak = Math.max(cur.kPeak, Math.abs(st.k));
  }
  flush();
  const sig = events.filter((e) => e.turn > 0.5);
  const kMax = stations.reduce((mx, st) => Math.max(mx, Math.abs(st.k)), 0);
  // Hairpin: one continuous corner that turns ≥ ~115° AND is genuinely tight somewhere.
  const hairpins = sig.filter((e) => e.turn > 2.0 && e.kPeak > 0.14).length;
  let minRecovery = Infinity;
  for (let i = 0; i < sig.length; i++) {
    const gap = i + 1 < sig.length ? sig[i + 1].start - sig[i].end : (L - sig[i].end) + (sig[0] ? sig[0].start : 0);
    minRecovery = Math.min(minRecovery, gap);
  }
  return {
    minRadius: kMax > 1e-6 ? +(1 / kMax).toFixed(1) : Infinity,
    hairpins, corners: sig.length,
    cornerDensity: +(totTurn / L).toFixed(3),   // rad of cornering per world unit
    minRecovery: +(minRecovery === Infinity ? L : minRecovery).toFixed(0),
    minW: +minW.toFixed(1), maxW: +maxW.toFixed(1), climb: +climb.toFixed(1)
  };
}

// ---- headless AI lap probe ----
// Ground truth for "how hard does this lap drive": run the benchmark bot (skill 1.0 —
// its brake input is then PURELY corner-anticipation braking) through the real engine
// and measure flying-lap seconds and the fraction of frames spent braking. A sweeping
// easy track barely lifts; a technical one is on the brakes a third of the time.
let _engineMods = null;
async function loadEngine() {
  if (!_engineMods) {
    const g = await import(new URL('../public/display/engine/Game.js', import.meta.url));
    const a = await import(new URL('../public/display/AiDriver.js', import.meta.url));
    _engineMods = { Game: g.Game, AiController: a.AiController };
  }
  return _engineMods;
}
export async function aiProbe(def, { laps = 3 } = {}) {
  const { Game, AiController } = await loadEngine();
  const track = buildTrack(def);
  track.poles = track.autoPoles; // corridor-blocking supports collide in the live game — probe with them
  track.totalLaps = laps;
  const engine = new Game([0], track, { onEvent() {} });
  const bot = new AiController({ skill: 1.0, laneBias: 0, seed: 7 });
  const DT = 1000 / 60;
  let t = 0, lastLap = 0, lapStart = 0, measured = 0, braking = 0;
  const lapTimes = [];
  while (!engine.raceOver && t < 600) {
    const car = engine.cars.get(0);
    if (car && !car.finished && car.pose) {
      const input = bot.drive(car, track.centerline, engine);
      engine.processInput(0, input);
      if (car.lap >= 1) { measured++; if (input.b > 0.15) braking++; } // skip the standing-start lap
    }
    engine.update(DT);
    t += DT / 1000;
    const c = engine.cars.get(0);
    if (c && c.lap > lastLap) { lapTimes.push(t - lapStart); lapStart = t; lastLap = c.lap; }
  }
  const flying = lapTimes.slice(1); // drop the standing start
  const lapSec = flying.length ? flying.reduce((a, b) => a + b, 0) / flying.length : (lapTimes[0] || 0);
  return { lapSec: +lapSec.toFixed(1), brakeFrac: +(measured ? braking / measured : 0).toFixed(3) };
}

// Audition a seed WITHOUT committing it: bake it exactly as gen-tracks.mjs would, then
// grade the SHIPPING geometry. `pass` needs both layers: the structural gates the unit
// tests enforce (closed · smooth · every crossing bridged ≥1.5 · no elevation knot ·
// maxY ≤ 8) and the profile's difficulty BAND (crossings/length/metrics/AI brake
// fraction in range). `fails` lists every gate missed, for scan-seeds --all.
export async function evaluateSeed(seed, profileName = 'classic', { probe = true } = {}) {
  const G = PROFILES[profileName].gates;
  let r, baked, t;
  // Round r itself rather than re-running bakeSeed → resolveSeed: the anchor search now costs
  // a full resolve per shortlisted candidate, and a scan calls this for hundreds of seeds.
  try { r = resolveSeed(seed, profileName); baked = roundWps(r.wps, r.h); t = buildTrack({ waypoints: baked }); }
  catch (e) { return { seed, pass: false, fails: ['pipeline'], reason: e.message }; }
  const L = t.length, crossings = r.wpPairs.length;
  // smoothness: worst |heading step| per 0.1 world units, same skips as the unit test
  let prev = null, worstStep = 0;
  for (let s = 0; s <= L; s += 0.1) {
    const f = t.centerline.sampleAt(s);
    if (Math.hypot(f.tangent.x, f.tangent.z) < 0.5 || f.up.y < 0.9 || f.pos.y > 2.05 || t.centerline.widthAt(s) > 5.4) { prev = null; continue; }
    const hd = Math.atan2(f.tangent.x, f.tangent.z);
    if (prev != null) { let d = hd - prev; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; worstStep = Math.max(worstStep, Math.abs(d)); }
    prev = hd;
  }
  // bridge clearance + peak height, on the decorated geometry
  let minBridge = Infinity, maxY = 0;
  {
    const E = t.centerline.samples, EL = t.length, rw = t.roadWidth;
    for (const s of E) maxY = Math.max(maxY, s.pos.y);
    for (let i = 0; i < E.length; i += 2) for (let j = i + 2; j < E.length; j += 2) {
      const arc = Math.min(Math.abs(E[i].s - E[j].s), EL - Math.abs(E[i].s - E[j].s)); if (arc < 14) continue;
      const dx = E[i].pos.x - E[j].pos.x, dz = E[i].pos.z - E[j].pos.z; if (dx * dx + dz * dz > (rw * 0.55) ** 2) continue;
      minBridge = Math.min(minBridge, Math.abs(E[i].pos.y - E[j].pos.y));
    }
  }
  const m = measureTrack(t);
  const fails = [];
  const band = (name, v, [lo, hi]) => { if (v < lo || v > hi) fails.push(`${name}=${v}∉[${lo},${hi}]`); };
  if (t.gap >= 0.5) fails.push(`gap=${t.gap.toFixed(2)}`);
  if (worstStep >= 0.08) fails.push(`step=${worstStep.toFixed(3)}`);
  if (crossings > 0 && minBridge < 1.5) fails.push(`bridge=${minBridge.toFixed(1)}`);
  if (maxY > 8) fails.push(`maxY=${maxY.toFixed(1)}`);
  band('len', Math.round(L), G.len);
  band('cross', crossings, G.crossings);
  band('minR', m.minRadius, G.minRadius);
  band('hairpins', m.hairpins, G.hairpins);
  band('density', m.cornerDensity, G.cornerDensity);
  // The AI probe is the priciest gate — only pay for it on structurally sound candidates.
  let ai = null;
  if (probe && fails.length === 0) {
    ai = await aiProbe({ waypoints: baked });
    band('brake', ai.brakeFrac, G.brakeFrac);
  }
  return { seed, profile: profileName, pass: fails.length === 0, fails,
    gap: +t.gap.toFixed(2), len: Math.round(L), step: +worstStep.toFixed(3), crossings,
    bridge: crossings ? +minBridge.toFixed(1) : 0, maxY: +maxY.toFixed(1), wp: baked.length,
    ...m, ...(ai || {}) };
}

// ---- furniture auto-placement ----
// Mechanizes the hand-placement rules the catalogue documents (see OILS/PADS/BOXES in
// public/shared/tracks.js): boost pads centred on the two cleanest straights ~half a
// lap apart (a pure climb counts as straight, mid-corner doesn't); item-box rows of 4
// across the lane on gentle open stretches ~half a lap apart, off high decks; oil
// slicks off-centre on gentle OPEN ground — never under a deck (cones tangle with
// pillars) and never up on a bridge/hill (a forced spin mustn't throw you off a drop).
// Deterministic (pure argmin over centerline stats). Returns {oils, pads, boxes} in the
// catalogue's u/lat form; the shipped hand-tuned tracks keep their authored data.
export function placeFurniture(t, { oils = 2 } = {}) {
  const cl = t.centerline, L = t.length, STEP = 0.5, N = Math.floor(L / STEP);
  const st = [];
  let groundY = Infinity;
  for (let i = 0; i < N; i++) {
    const s = i * STEP, f = cl.sampleAt(s);
    st.push({ s, pos: f.pos.clone(), grade: Math.abs(f.tangent.y), h: Math.atan2(f.tangent.x, f.tangent.z) });
    groundY = Math.min(groundY, f.pos.y);
  }
  for (let i = 0; i < N; i++) {
    const a = st[i], b = st[(i + 1) % N];
    let dh = b.h - a.h;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    a.k = Math.abs(dh) / STEP;
  }
  const wrapI = (i) => ((i % N) + N) % N;
  const winK = (i, r) => { let mx = 0; for (let d = -r; d <= r; d++) mx = Math.max(mx, st[wrapI(i + d)].k); return mx; };
  const overhead = (i) => { // another strand of road flying over this station?
    const p = st[i].pos;
    for (const sm of cl.samples) {
      const arc = Math.min(Math.abs(sm.s - st[i].s), L - Math.abs(sm.s - st[i].s));
      if (arc < 6) continue;
      const dx = sm.pos.x - p.x, dz = sm.pos.z - p.z, clear = sm.width / 2 + 1.5;
      if (dx * dx + dz * dz < clear * clear && sm.pos.y > p.y + 1.5) return true;
    }
    return false;
  };
  const nearLoop = (i) => (t.loopStarts || []).some((ls) => {
    const d = Math.abs(st[i].s - ls.s); return Math.min(d, L - d) < 10;
  });
  // Claimed arclength intervals keep picks apart (and everything away from the grid).
  const claims = [[0, 0.05 * L]];
  const clearOf = (s, r) => claims.every(([cs, cr]) => Math.min(Math.abs(s - cs), L - Math.abs(s - cs)) >= r + cr);
  // argmin cost over stations inside the (wrapped) arclength window that are unclaimed
  const pick = (cost, r, win = null) => {
    let best = -1, bc = Infinity;
    for (let i = 0; i < N; i++) {
      const s = st[i].s;
      if (win) { const d = ((s - win[0]) % L + L) % L; if (d > ((win[1] - win[0]) % L + L) % L) continue; }
      if (!clearOf(s, r)) continue;
      const c = cost(i);
      if (c < bc) { bc = c; best = i; }
    }
    if (best >= 0) claims.push([st[best].s, r]);
    return best;
  };
  const u = (i) => +(st[i].s / L).toFixed(3);
  const half = (i, cost, r) => pick(cost, r, [st[i].s + 0.38 * L, st[i].s + 0.62 * L]); // the "~half a lap apart" partner

  const costPad = (i) => winK(i, 8) * 10 + st[i].grade * 2 + (nearLoop(i) ? 100 : 0);
  const p0 = pick(costPad, 5), p1 = p0 >= 0 ? half(p0, costPad, 5) : -1;

  const costBox = (i) => winK(i, 6) * 10 + st[i].grade * 3
    + (st[i].pos.y - groundY > 2.5 ? 30 : 0) + (nearLoop(i) ? 100 : 0);
  const b0 = pick(costBox, 5), b1 = b0 >= 0 ? half(b0, costBox, 5) : -1;

  const costOil = (i) => winK(i, 4) * 8 + st[i].grade * 4
    + (overhead(i) ? 1000 : 0) + (st[i].pos.y - groundY > 1.2 ? 1000 : 0);
  const oilIdx = [];
  for (let n = 0; n < oils; n++) { const o = pick(costOil, 0.1 * L); if (o >= 0) oilIdx.push(o); }

  const BOX_LANES = [-1.05, -0.35, 0.35, 1.05]; // mirrors the catalogue's boxRow lanes
  return {
    oils: oilIdx.map((i, n) => ({ u: u(i), lat: n % 2 === 0 ? 0.7 : -0.7 })),
    pads: [p0, p1].filter((i) => i >= 0).map((i) => ({ u: u(i), lat: 0.0 })),
    boxes: [b0, b1].filter((i) => i >= 0).flatMap((i) => BOX_LANES.map((lat) => ({ u: u(i), lat })))
  };
}
