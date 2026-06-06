// Track catalogue — DATA ONLY, no Three.js. The single source of truth for "what
// tracks exist": each track is a display name, a default road `width`, and an ordered
// list of parametric SEGMENTS (the geometry). TrackBuilder integrates the segments
// into a drivable centerline; the renderer sweeps the procedural road over it.
//
// Kept dependency-free so the SAME module loads everywhere: the display engine, the
// Node unit tests (imported directly), and the classic-script gallery.
//
// ── SEGMENTS ─────────────────────────────────────────────────────────────────
//   straight(length, opts?)      a run of `length` (unscaled units; ×SCALE→world).
//   arc(radius, angleDeg, opts?) a turn of `angleDeg` about `radius`; +angle = LEFT,
//                                −angle = RIGHT.
// opts (any segment): rise (Δelevation over the segment, eased), bump (net-flat hump
//   amplitude), bank (peak roll°, eased — corners only in practice), width (number or
//   [start,end] taper, overriding the track default), lateral (straight-only net
//   cross-shift, an S — a chicane is curve+curveR).
//
// ── HOW A TRACK CLOSES ───────────────────────────────────────────────────────
// The builder walks the segments and auto-closes the loop (gap < 0.5). A straight
// advances `length` along travel; an arc also turns the heading. Three proven recipes:
//  1. OVAL/RECTANGLE (Switchback): four identical 90° corners of the SAME hand
//     (4×90° = a full turn) with matched OPPOSITE sides → closes for any side length.
//  2. FIGURE-8 (Crossover): three right + three left corners net 0° and cross once;
//     a rise…fall pair on one strand lifts it into a bridge OVER the crossing (same
//     plan footprint, so closure is unchanged).
//  3. L-SHAPE (Riverside): five left + one right corner net a full turn but trace a
//     re-entrant outline; side lengths tuned so it closes.
// NET-NEUTRAL building blocks (each advances one `L`, so any can stand in for a
// straight on a side): plain straight; a chicane (lateral −2 then +2); a bump
// (net-flat); a rise…fall pair (net-flat climb then descent).

const L = 4.0;        // base straight advance (unscaled)
const W = 2.5;        // default drivable width (unscaled; ×SCALE → 5.0 world)
const RS = 2.185;     // tight (small) corner radius
const RL = 4.185;     // sweeping (large) corner radius

const straight = (length, opts = {}) => ({ kind: 'straight', length, ...opts });
const arc = (radius, angle, opts = {}) => ({ kind: 'arc', radius, angle, ...opts });
const run = (n, opts) => Array.from({ length: n }, () => straight(L, opts)); // n plain straights
// Net-0 S. The lateral shift is kept SMALL on purpose: at neutral the understeer model
// holds a world heading and washes the car sideways by ≈ the shift's full width, so a big
// shift slides the car curb-to-curb (a left-right lurch you must fight). At ~0.8 the
// neutral drift stays ~1.7 (well inside the 2.2 curb limit) — a gentle S you flow through
// with light steering, not a jink that throws you at the kerb.
const chicane = () => [straight(L, { lateral: -0.8 }), straight(L, { lateral: 0.8 })];
const halfHill = () => [straight(L, { rise: 0.5 }), straight(L, { rise: -0.5 })];  // net-flat
const fullHill = () => [straight(L, { rise: 1.0 }), straight(L, { rise: -1.0 })];  // net-flat
// A run of n straights whose width bulges to `peak` in the middle and eases back to the
// default at both ends (each straight tapers between adjacent sine-curve samples, so the
// width is continuous across the whole run — no step at any joint). Width never changes
// the path, so closure is unaffected.
const flare = (n, peak) => {
  const wOf = (f) => W + (peak - W) * Math.sin(Math.PI * f);
  return Array.from({ length: n }, (_, i) => straight(L, { width: [wOf(i / n), wOf((i + 1) / n)] }));
};

// ---- Switchback (Hard): tight, technical. A compact rectangle (small-radius corners),
// chicane + rolling half-hill on the long sides, a quick chicane on the short sides.
// Sides 7/3/7/3 with four small LEFT corners → closes. ----
export const SWITCHBACK = [
  straight(L), ...chicane(), ...halfHill(), ...flare(2, 3.1), arc(RS, 90),  // A: 7 (flared corner approach)
  ...chicane(), straight(L), arc(RS, 90),                                   // B: 3
  straight(L), ...chicane(), ...halfHill(), ...flare(2, 3.1), arc(RS, 90),  // C: 7 (=A)
  ...chicane(), straight(L), arc(RS, 90)                                    // D: 3 (=B)
];

// ---- Crossover (Hard): a figure-8 that passes OVER itself. Up a long spine, loop the
// top (clockwise), down the far side, then a west-bound straight CLIMBS onto a bridge
// and crosses 90° OVER the spine before descending and looping the bottom back to
// start. 3 right + 3 left corners → net 0°; the rise…fall lifts the bridge strand. ----
export const CROSSOVER = [
  ...flare(6, 3.4),                                                // spine — flares wide (fast straight)
  arc(RL, -90), straight(L - 0.37), arc(RL, -90),                  // top loop (cw); −0.37 closes the loop
  straight(L - 0.37), ...run(6),                                   // down the far side; −0.37 closes the loop
  arc(RL, -90), straight(L, { rise: 1.0 }), ...run(4), straight(L, { rise: -1.0 }), // turn west + BRIDGE
  arc(RL, 90), ...run(3), arc(RL, 90), ...run(3), arc(RL, 90),     // bottom loop (ccw)
  ...run(6)                                                        // back to the spine
];

// ---- Riverside (Medium): the long grand tour. An L-shaped "boot" (five left corners +
// one right re-entrant elbow) packed with chicanes, full + half hills, and bumps. The
// longest lap in the set. Turns L,L,R,L,L,L; side lengths tuned to auto-close. ----
export const RIVERSIDE = [
  straight(L + 0.37), ...chicane(), ...fullHill(), ...flare(4, 3.3), arc(RL, 90),  // A: 9 (+0.37 closes; flared run)
  straight(L - 0.37), ...halfHill(), arc(RL, 90),                                  // B: 3 (−0.37 closes)
  straight(L), straight(L, { bump: 0.5 }), straight(L), arc(RL, -90),              // C: 3 (elbow, RIGHT)
  ...halfHill(), straight(L), straight(L), arc(RL, 90),                            // D: 4
  ...chicane(), ...fullHill(), arc(RL, 90),                                        // E: 4
  straight(L), straight(L), ...chicane(), ...halfHill(), straight(L, { bump: 0.5 }), straight(L), straight(L), arc(RL, 90) // F: 9
];

// Oil slicks per track — FIXED hazards. Placed by `u` (fraction of the lap, 0 =
// start/finish) and `lat` (lateral offset in world units; 0 = centreline). `radius`
// and `cones` optional. Off-centre so a careful line can thread past; tune by driving.
const OILS = {
  switchback: [ { u: 0.34, lat: 0.7 }, { u: 0.80, lat: -0.7 } ],
  crossover:  [ { u: 0.22, lat: 0.0 }, { u: 0.52, lat: 0.8 }, { u: 0.84, lat: -0.6 } ],
  riverside:  [ { u: 0.16, lat: -0.7 }, { u: 0.46, lat: 0.7 }, { u: 0.74, lat: 0.0 } ]
};

// Boost pads — drive-over speed strips, position-scaled for catch-up. Place on STRAIGHTS
// (XZ curvature ≈ 0, where the boost isn't wasted mid-corner), centred (lat 0) on the
// racing line. `u` = fraction of lap. A pure climb/descent counts as straight.
const PADS = {
  switchback: [ { u: 0.15, lat: 0.0 }, { u: 0.65, lat: 0.0 } ],
  crossover:  [ { u: 0.08, lat: 0.0 }, { u: 0.40, lat: 0.0 } ],
  riverside:  [ { u: 0.10, lat: 0.0 }, { u: 0.51, lat: 0.0 } ]
};

// Item boxes — drive-over pickups in rows ACROSS the lane. `u` = fraction of lap, `lat`
// = lateral offset. A row of 4 spread across the lane.
const BOX_LANES = [-1.05, -0.35, 0.35, 1.05];
const boxRow = (u) => BOX_LANES.map((lat) => ({ u, lat }));
const BOXES = {
  switchback: boxRow(0.20),
  crossover:  boxRow(0.66),
  riverside:  boxRow(0.30)
};

// Registry of named, previewable tracks. Selected in the display via ?track=<key>.
export const TRACKS = {
  switchback: {
    name: 'Switchback', segments: SWITCHBACK,
    oils: OILS.switchback, pads: PADS.switchback, boxes: BOXES.switchback
  },
  crossover: {
    name: 'Crossover', segments: CROSSOVER,
    oils: OILS.crossover, pads: PADS.crossover, boxes: BOXES.crossover
  },
  riverside: {
    name: 'Riverside', segments: RIVERSIDE,
    oils: OILS.riverside, pads: PADS.riverside, boxes: BOXES.riverside
  }
};

// Stable display order for the gallery / picker.
export const TRACK_ORDER = ['switchback', 'crossover', 'riverside'];

// Flat list — {id, name, segments, oils, pads, boxes} in display order — used by main.js
// and the track picker. The display builds each track and computes its schematic SVG
// from the geometry, so the picker needs no per-track art.
export const TRACK_LIST = TRACK_ORDER.map((id) => ({
  id, name: TRACKS[id].name, segments: TRACKS[id].segments,
  oils: TRACKS[id].oils, pads: TRACKS[id].pads, boxes: TRACKS[id].boxes
}));
