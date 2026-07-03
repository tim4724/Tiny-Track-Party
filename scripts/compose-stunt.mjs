// Compose the segment-DSL STUNT tracks (Rooftop cup) from proven motifs, solving the
// two hand-tuned constants that made authoring them slow:
//   1. CLOSURE — plan-walk the segment list (mirroring TrackBuilder's exact plan math),
//      then solve two designated straights of non-parallel heading (a 2×2 linear system)
//      so the lap closes to gap ≈ 0. This is the generalized form of Crossover's ±0.37.
//   2. ROLL TRIMS — each 3D element (tilted loop, climbing/diving spiral, half-loop)
//      couples transported frame holonomy; if it isn't cancelled the seam unwind smears
//      the residual around the lap and flat stretches ride tilted. Sweep each marked
//      element's `roll` (coordinate descent, coarse→fine) to minimize tilt on ground-level
//      unbanked road — the automated version of Twister's "measured by probe" ±75.5.
// Then grade the result like a seed: the structural gates the unit tests enforce (twist
// rate, seam holonomy, strand clearance) + measureTrack metrics + the headless AI probe.
//
//   node scripts/compose-stunt.mjs           — solve + grade all designs, print the numbers
//
// The solved lengths/rolls get hard-coded into public/shared/tracks.js (like every other
// segment track); this script is the tool that produced them, not a build step.
import { buildTrack, measureTrack, aiProbe } from './track-gen.mjs';

const DEG = Math.PI / 180;
const straight = (length, opts = {}) => ({ kind: 'straight', length, ...opts });
const arc = (radius, angle, opts = {}) => ({ kind: 'arc', radius, angle, ...opts });
const loop = (radius, opts = {}) => ({ kind: 'loop', radius, ...opts });
const run = (n, opts) => Array.from({ length: n }, () => straight(4.0, opts));
const RL = 4.185;

// ---- plan walk: unscaled endpoint + heading after the whole segment list ----
// Mirrors TrackBuilder's cursor math exactly (dirX=-sin, dirZ=cos; arc closed form;
// a drift loop is a pure lateral jog; a half-loop flips the heading in place).
const dirV = (th) => [-Math.sin(th), Math.cos(th)];
const latV = (th) => [-Math.cos(th), -Math.sin(th)];
function headingAt(segs, i) {
  let th = 0;
  for (let j = 0; j < i; j++) {
    const s = segs[j];
    if (s.kind === 'arc') th += (s.angle || 0) * DEG;
    else if (s.kind === 'loop' && !s.drift) th += Math.PI;
  }
  return th;
}
function planWalk(segs) {
  let x = 0, z = 0, th = 0;
  for (const s of segs) {
    if (s.kind === 'straight') {
      const [dx, dz] = dirV(th); x += dx * s.length; z += dz * s.length;
      if (s.lateral) { const [lx, lz] = latV(th); x += lx * s.lateral; z += lz * s.lateral; }
    } else if (s.kind === 'arc') {
      const a = (s.angle || 0) * DEG, sgn = Math.sign(a) || 1, R = s.radius;
      const [l0x, l0z] = latV(th), [l1x, l1z] = latV(th + a);
      x += R * sgn * (l0x - l1x); z += R * sgn * (l0z - l1z); th += a;
    } else if (s.kind === 'loop') {
      if (s.drift) { const [lx, lz] = latV(th); x += lx * s.drift; z += lz * s.drift; }
      else th += Math.PI;
    }
  }
  return { x, z, th };
}

// ---- closure: adjust two straights' lengths so the walk ends back at the origin ----
function solveClosure(segs, iA, iB) {
  const end = planWalk(segs);
  const thA = headingAt(segs, iA), thB = headingAt(segs, iB);
  const [ax, az] = dirV(thA), [bx, bz] = dirV(thB);
  const det = ax * bz - az * bx;
  if (Math.abs(det) < 1e-3) return null; // (near-)parallel legs can't absorb a 2D gap
  const dA = (-end.x * bz + end.z * bx) / det;
  const dB = (-ax * end.z + az * end.x) / det;
  segs[iA].length = +(segs[iA].length + dA).toFixed(3);
  segs[iB].length = +(segs[iB].length + dB).toFixed(3);
  return { dA, dB };
}

// Try every pair of candidate straights (marked `_leg: true` in a design; falls back to
// every plain straight) and keep the feasible solution that disturbs the skeleton least.
export function solveClosureAuto(segs, { minLen = 3 } = {}) {
  let cand = segs.map((s, i) => i).filter((i) => segs[i]._leg);
  if (cand.length < 2) cand = segs.map((s, i) => i).filter((i) => {
    const s = segs[i];
    return s.kind === 'straight' && !s.rise && !s.roll && !s.lateral && !s.bump;
  });
  let best = null;
  for (let a = 0; a < cand.length; a++) for (let b = a + 1; b < cand.length; b++) {
    const copy = segs.map((s) => ({ ...s }));
    const r = solveClosure(copy, cand[a], cand[b]);
    if (!r || copy[cand[a]].length < minLen || copy[cand[b]].length < minLen) continue;
    const cost = Math.abs(r.dA) + Math.abs(r.dB);
    if (!best || cost < best.cost) best = { iA: cand[a], iB: cand[b], ...r, cost, solved: copy };
  }
  if (!best) throw new Error('no straight pair closes this skeleton — rework it');
  best.solved.forEach((s, i) => Object.assign(segs[i], s));
  return best;
}

// ---- alignment: solve two legs so a LATER point on the lap hits a plan target ----
// Same 2×2 linear solve as closure, different objective: adjust segs[iA]/segs[iB]
// (both BEFORE segment iTarget) so the cursor at the START of iTarget lands on
// (tx, tz) (unscaled plan coords). Used by Gauntlet to park the ramp crest dead-
// centre in its loop's ring opening.
export function solveAlign(segs, iA, iB, iTarget, tx, tz) {
  const cur = planWalk(segs.slice(0, iTarget));
  const thA = headingAt(segs, iA), thB = headingAt(segs, iB);
  const [ax, az] = dirV(thA), [bx, bz] = dirV(thB);
  const det = ax * bz - az * bx;
  if (Math.abs(det) < 1e-3) throw new Error('alignment legs are (near-)parallel');
  const gx = tx - cur.x, gz = tz - cur.z;
  const dA = (gx * bz - gz * bx) / det, dB = (ax * gz - az * gx) / det;
  segs[iA].length = +(segs[iA].length + dA).toFixed(3);
  segs[iB].length = +(segs[iB].length + dB).toFixed(3);
  if (segs[iA].length < 2 || segs[iB].length < 2)
    throw new Error(`alignment legs went too short (${segs[iA].length}, ${segs[iB].length})`);
  return { dA, dB };
}

// Measure a built track's FIRST loop ring (first contiguous inverted crown along the
// lap — the threaded ring must precede any other loop in the design): centre = mean of
// the ring samples (a uniformly-sampled full circle averages to its centre), WORLD units.
export function measureRing(segs) {
  const t = buildTrack(segs, { startGate: false });
  const ss = t.centerline.samples, n = ss.length;
  let a = -1, b = -1;
  for (let i = 0; i < n; i++) {
    if (ss[i].up.y < 0.3) { if (a < 0) a = i; b = i; }
    else if (a >= 0) break; // end of the FIRST crown cluster — ignore later loops
  }
  if (a < 0) throw new Error('no inverted crown found — is there a loop?');
  while (a > 0 && ss[a].pos.y > 0.6) a--;
  while (b < n - 1 && ss[b].pos.y > 0.6) b++;
  let cx = 0, cy = 0, cz = 0, cnt = 0;
  for (let i = a; i <= b; i++) { cx += ss[i].pos.x; cy += ss[i].pos.y; cz += ss[i].pos.z; cnt++; }
  return { x: cx / cnt, y: cy / cnt, z: cz / cnt };
}

// ---- roll trims: sweep each marked element to minimize off-stunt tilt ----
// Score: ground-level, near-level road should sit upright (authored banks ≤10° pass
// under the 12° allowance); un-cancelled holonomy tilts whole flat stretches 30-70°.
function tiltScore(segs) {
  const t = buildTrack(segs, { startGate: false });
  let sc = 0;
  for (const sm of t.centerline.samples) {
    if (sm.pos.y > 0.6 || Math.abs(sm.tangent.y) > 0.12) continue;
    const tilt = Math.acos(Math.max(-1, Math.min(1, sm.up.y))) * 180 / Math.PI;
    sc += Math.max(0, tilt - 12) ** 2;
  }
  return sc;
}
function sweepRolls(segs, idxs, { range = 120, coarse = 6 } = {}) {
  for (let round = 0; round < 2; round++) {
    for (const idx of idxs) {
      let best = segs[idx].roll || 0, bs = Infinity;
      for (let r = -range; r <= range; r += coarse) {
        segs[idx].roll = r;
        const s = tiltScore(segs);
        if (s < bs) { bs = s; best = r; }
      }
      for (let r = best - coarse; r <= best + coarse; r += 1) {
        segs[idx].roll = r;
        const s = tiltScore(segs);
        if (s < bs) { bs = s; best = r; }
      }
      for (let r = best - 1; r <= best + 1; r += 0.1) {
        segs[idx].roll = +r.toFixed(1);
        const s = tiltScore(segs);
        if (s < bs) { bs = s; best = segs[idx].roll; }
      }
      segs[idx].roll = best;
    }
  }
  return { rolls: idxs.map((i) => segs[i].roll), score: tiltScore(segs) };
}

// ---- structural grade (mirrors the twister unit tests) ----
function grade(segs) {
  const t = buildTrack(segs);
  const ss = t.centerline.samples, L = t.length;
  let worstTwist = 0, minUpSeam = ss[ss.length - 1].up.dot(ss[0].up), maxY = 0, inverted = 0, sideways = 0;
  for (let i = 1; i < ss.length; i++) {
    const a = ss[i - 1], b = ss[i], ds = b.s - a.s;
    if (ds <= 1e-6) continue;
    const tg = a.tangent;
    const ua = a.up.clone().addScaledVector(tg, -a.up.dot(tg)).normalize();
    const ub = b.up.clone().addScaledVector(tg, -b.up.dot(tg)).normalize();
    worstTwist = Math.max(worstTwist, Math.abs(Math.atan2(ua.clone().cross(ub).dot(tg), ua.dot(ub))) / ds);
  }
  let minStrand = Infinity, strandAt = null;
  for (let i = 0; i < ss.length; i += 2) for (let j = i + 2; j < ss.length; j += 2) {
    const arcD = Math.min(Math.abs(ss[i].s - ss[j].s), L - Math.abs(ss[i].s - ss[j].s));
    if (arcD < 6) continue;
    const d = ss[i].pos.distanceTo(ss[j].pos);
    if (d < minStrand) { minStrand = d; strandAt = [Math.round(ss[i].s), Math.round(ss[j].s)]; }
  }
  for (const sm of ss) {
    maxY = Math.max(maxY, sm.pos.y);
    if (sm.up.y < -0.9) inverted++;
    if (Math.abs(sm.up.y) < 0.2) sideways++;
  }
  return { closed: t.closed, gap: +t.gap.toFixed(3), len: Math.round(L),
    twistRate: +worstTwist.toFixed(3), seamUp: +minUpSeam.toFixed(3),
    minStrand: +minStrand.toFixed(2), strandAt, maxY: +maxY.toFixed(1), inverted, sideways,
    seamVert: +ss[0].up.y.toFixed(3) };
}

// ================= DESIGNS =================
// Each returns { name, segs, rollIdx: [...] }. Closure legs are found automatically
// (solveClosureAuto); marked elements get their roll trims swept.

// HELIX — the double-spiral skyway: climb a 450° spiral to a high pillared bridge,
// ride it down the east side, then corkscrew back to earth through a SAME-hand
// descending spiral; the south leg home threads an S-pair of tilted toy loops. All
// proven Twister motifs, recomposed. Same-hand spirals wind the lap to a net -1080°
// (3 full turns, like Twister's -720) — the plan stays a simple rounded rectangle.
// (Corners are deliberately UNBANKED — user: tilted curves only in a few places; the
// two spirals keep their bank, which is structural to how a climbing helix reads.)
export function designHelix() {
  const segs = [
    straight(12, { _leg: true }),                                     // grid, north-bound (θ=0; the alt N-S leg)
    arc(RL, -90),                                                     // NE of grid (θ=-90)
    straight(12, { _leg: true }),                                     // top leg, east-bound
    arc(RL, -450, { rise: 2.6, bank: 10, pillars: true, _sweep: true }), // SPIRAL UP (net -90)
    straight(28, { pillars: true, _leg: true }),                      // THE SKYWAY south (θ=-180)
    arc(RL, -450, { rise: -2.6, bank: 10, pillars: true, _sweep: true }), // SPIRAL DOWN, same hand (net -90)
    straight(8, { _leg: true }),                                      // south leg west-bound (θ=-270)
    loop(2.2, { drift: 3, _sweep: true }),                            // TOY LOOP L (jogs outboard)
    straight(10),                                                     // beat — rings stay 20 world apart
    loop(2.2, { drift: -3, _sweep: true }),                           // TOY LOOP R (jogs back)
    straight(8, { _leg: true }),                                      // south-west run home (θ=-270)
    arc(RL, -90)                                                      // SW corner into the grid (θ=-360)
  ];
  return { name: 'helix', segs };
}

// SKYLINE — the big-air one: a HALF-LOOP fires the pack straight up onto an
// 8-world-high skyway ridden back over its own approach (an Immelmann: the deck
// carries the 180° righting roll, eased across the whole span — peak twist ~0.17
// rad/world, inside the 0.21 helicoid bound), then a banked descending U-turn swings
// OUTBOARD (away from every other strand) and dives home past one tilted toy loop.
// If the Immelmann reads badly in 3D, swap the half-loop+roll for a spiral climb
// (Helix-style) and keep the rest.
// (Unbanked corners here too — the descending U keeps its 10°: a fast falling curve at
// altitude is the one place the lean is load-bearing.)
export function designSkyline() {
  const segs = [
    ...run(3),                                                        // grid (θ=0)
    arc(RL, 90),                                                      // (θ=90)
    straight(16, { _leg: true }),                                     // north leg west-bound
    arc(RL, 90),                                                      // (θ=180)
    straight(14),                                                     // boost approach, south-bound
    loop(2.0),                                                        // HALF-LOOP UP → elev 4.0, θ→0, frame inverted
    straight(24, { roll: 180, pillars: true }),                       // SKYWAY back over the approach — rolls upright
    arc(RL, 180, { rise: -2.0, bank: 10, pillars: true, _sweep: true }), // descending U, swings WEST (outboard) (θ→180)
    straight(6, { rise: -2.0, pillars: true }),                       // dive to ground, south-bound
    straight(6),                                                      // flat beat — boost — straight into
    loop(2.2, { drift: -3, _sweep: true }),                           // TOY LOOP (drifts further west, outboard)
    straight(12, { _leg: true }),                                     // (θ=180)
    arc(RL, 90),                                                      // (θ=270)
    straight(10, { _leg: true }),                                     // south edge, east-bound
    arc(RL, 90)                                                       // home (θ=360)
  ];
  return { name: 'skyline', segs };
}

// COASTER — the airtime one, and the cup's no-tilt on-ramp: a CAMELBACK RUN of three
// shrinking humps (each a net-flat `bump` the pack crests light), a toy loop, then one
// big summit hill up-and-over. No banking anywhere, no inversion beyond the loop.
export function designCoaster() {
  const segs = [
    ...run(6),                                                        // grid, north-bound (θ=0)
    arc(RL, -90),                                                     // NE corner (θ=-90)
    straight(9, { bump: 0.8 }),                                       // CAMELBACK RUN — three shrinking humps
    straight(9, { bump: 0.6 }),
    straight(9, { bump: 0.45 }),
    straight(10, { _leg: true }),                                     // breather
    arc(RL, -90),                                                     // (θ=-180)
    straight(16, { _leg: true }),                                     // boost — straight into
    loop(2.2, { drift: 3, _sweep: true }),                            // TOY LOOP
    straight(6),                                                      // beat
    arc(RL, -90),                                                     // (θ=-270)
    straight(8),
    straight(9, { rise: 1.8 }),                                       // THE SUMMIT — a grass mountain up...
    straight(9, { rise: -1.8 }),                                      // ...and over, blind exit
    straight(6, { lateral: -0.8 }), straight(6, { lateral: 0.8 }),    // soft chicane on the run home
    straight(6, { _leg: true }),
    arc(RL, -90)                                                      // SW corner into the grid (θ=-360)
  ];
  return { name: 'coaster', segs };
}

// GAUNTLET — thread the needle: the lap fires straight THROUGH the ring of its own toy
// loop. A pillared ramp climbs to the ring's measured centre height, crests dead-centre
// in the opening (the hole faces ±lateral, so the ramp runs perpendicular to the loop's
// travel), and plunges down the far side. The `align` hook measures the built ring and
// solves the two _align legs so the crest lands on its axis (the modern version of the
// old jump-through-loop probe work on Twister).
export function designGauntlet() {
  const segs = [
    straight(14),                                                     // grid θ=0, north
    arc(RL, -90),                                                     // θ=-90 east
    straight(12),                                                     // east leg
    arc(RL, -90),                                                     // θ=-180 south
    straight(8),                                                      // boost — straight into
    loop(2.2, { drift: 3, _sweep: true }),                            // THE RING (opening faces ±X)
    straight(10),                                                     // spacing south
    arc(RL, -90),                                                     // θ=-270 west
    straight(14, { _align: true }),                                   // overshoot WEST past the ring (align leg 1)
    arc(RL, -90),                                                     // θ=-360 north
    straight(12, { _align: true }),                                   // come back NORTH to ring latitude (align leg 2)
    arc(RL, -90),                                                     // θ=-450 — EAST, straight at the ring
    straight(9, { pillars: true, width: [2.5, 2.2], _ramp: 'up' }),   // THE RAMP (rise set from the measured ring)
    straight(6, { pillars: true, width: [2.2, 2.5], _ramp: 'down' }), // THE PLUNGE through the ring...
    straight(8, { pillars: true }),                                   // ...onto a low bridge OVER the boost leg
    straight(5, { rise: -0.9, pillars: true }),                       // final drop to ground
    straight(8, { _leg: true }),                                      // east run out
    arc(RL, -90),                                                     // θ=-540 south
    straight(6, { _leg: true }),
    arc(RL, -90),                                                     // θ=-630 west
    straight(24, { _leg: true }),                                     // south edge home
    arc(RL, -90),                                                     // θ=-720 north
    straight(6, { _leg: true })                                       // into the grid
  ];
  return { name: 'gauntlet', segs, align: alignGauntlet };
}
function alignGauntlet(segs) {
  const SCALE = 2; // TrackBuilder's plan→world factor (plan coords here are unscaled)
  const iUp = segs.findIndex((s) => s._ramp === 'up');
  const iDown = segs.findIndex((s) => s._ramp === 'down');
  const [iA, iB] = segs.map((s, i) => (s._align ? i : -1)).filter((i) => i >= 0);
  const ring = measureRing(segs);                       // world coords; the ring sits before the align legs, so it won't move
  const lip = +(ring.y / SCALE).toFixed(2);
  segs[iUp].rise = lip;                                 // crest at the ring's centre height
  segs[iDown].rise = +(0.9 - lip).toFixed(2);           // plunge down to the 0.9 bridge that clears the boost leg
  const r = solveAlign(segs, iA, iB, iDown, ring.x / SCALE, ring.z / SCALE);
  const crest = planWalk(segs.slice(0, iDown));
  const err = Math.hypot(crest.x - ring.x / SCALE, crest.z - ring.z / SCALE) * SCALE;
  console.log(`  gauntlet align: legs ${r.dA >= 0 ? '+' : ''}${r.dA.toFixed(2)}/${r.dB >= 0 ? '+' : ''}${r.dB.toFixed(2)}, crest ${err.toFixed(2)} world off ring axis, lip ${ring.y.toFixed(1)} world`);
  if (err > 1.0) throw new Error(`gauntlet crest ${err.toFixed(2)} world off the ring axis`);
}

// SKYSNAKE — a slalom IN THE SKY: spiral up to 5.2 world, weave an S-S through the
// clouds on pillars, then dive home past a toy loop.
export function designSkysnake() {
  const segs = [
    straight(14, { _leg: true }),                                     // grid θ=0
    arc(RL, -90),                                                     // east
    straight(10, { _leg: true }),
    arc(RL, -450, { rise: 2.6, bank: 10, pillars: true, _sweep: true }), // SPIRAL UP (net -90) → south
    arc(RL, 45, { pillars: true }), arc(RL, -45, { pillars: true }),  // THE SKY WEAVE (net 0)
    arc(RL, -45, { pillars: true }), arc(RL, 45, { pillars: true }),
    straight(6, { pillars: true }),
    straight(10, { rise: -2.6, pillars: true }),                      // dive to ground
    straight(5),                                                      // boost — straight into
    loop(2.2, { drift: -3, _sweep: true }),                           // TOY LOOP
    straight(8, { _leg: true }),
    arc(RL, -90),                                                     // west
    straight(12, { _leg: true }),
    arc(RL, -90)                                                      // home (net -720)
  ];
  return { name: 'skysnake', segs };
}

export const DESIGNS = {
  helix: designHelix, skyline: designSkyline, coaster: designCoaster,
  gauntlet: designGauntlet, skysnake: designSkysnake
};
// Audition pool (gallery-tracks candidates). Empty since the 2026-07-04 round settled
// the Rooftop roster; rejected designs (skyfall/bigdipper/orbit/boomerang/tower/
// leapfrog/halo/slingshot) live in git history.
export const CANDIDATE_DESIGNS = {};

// Solve + trim one design in place; returns the report pieces. Sweep/leg markers are
// derived from the segment flags (hand-counted indices kept going stale) and stripped
// before the result is graded, so nothing leaks into a pasted definition.
export async function compose(design) {
  const { name, segs } = design;
  const rollIdx = segs.map((s, i) => i).filter((i) => segs[i]._sweep);
  // alignment (e.g. Gauntlet's thread-the-ring) runs FIRST: its legs sit between the
  // stunt and the closure legs, so the closure solve afterwards absorbs the shift.
  if (design.align) design.align(segs);
  const c = solveClosureAuto(segs);
  for (const i of rollIdx) segs[i].roll = segs[i].roll || 0;
  const r = sweepRolls(segs, rollIdx);
  for (const s of segs) { delete s._sweep; delete s._leg; delete s._align; delete s._ramp; }
  const g = grade(segs);
  const m = measureTrack(buildTrack(segs));
  const ai = await aiProbe(segs);
  return { name, segs, closure: c, rolls: r, rollIdx, grade: g, metrics: m, ai };
}

// ================= CLI =================
if (process.argv[1] && process.argv[1].endsWith('compose-stunt.mjs')) {
  for (const make of Object.values(DESIGNS)) {
    const design = make();
    console.log(`\n=== ${design.name} ===`);
    try {
      const { segs, closure: c, rolls: r, rollIdx, grade: g, metrics: m, ai } = await compose(design);
      console.log(`closure: leg[${c.iA}] → ${segs[c.iA].length} (${c.dA >= 0 ? '+' : ''}${c.dA.toFixed(3)}), leg[${c.iB}] → ${segs[c.iB].length} (${c.dB >= 0 ? '+' : ''}${c.dB.toFixed(3)})`);
      console.log(`rolls:   ${rollIdx.map((i, n) => `seg[${i}]=${r.rolls[n]}`).join('  ')}  (tilt score ${r.score.toFixed(1)})`);
      console.log('grade:  ', g);
      console.log('metrics:', m);
      console.log('ai:     ', ai);
    } catch (e) {
      console.log('FAILED:', e.message);
    }
  }
}
