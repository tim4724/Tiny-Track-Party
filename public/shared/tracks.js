// Resolved waypoints for the seeded generated tracks (generated offline by
// scripts/gen-tracks.mjs — solver-placed elevation + difficulty-profile decoration
// baked in; pure data, no Three.js). GEN_FURNITURE carries the auto-placed
// oils/pads/boxes (scripts/track-gen.mjs placeFurniture) for the non-classic tracks;
// the original Backyard four keep their hand-tuned furniture below.
import { GEN_TRACKS, GEN_FURNITURE } from './genTracks.js';

// Auto-placed furniture for a generated track — tolerant of a not-yet-baked id, so the
// registry can name a new track BEFORE gen-tracks.mjs runs (the bake pipeline itself
// imports this module via TrackBuilder; a hard read here would deadlock that workflow).
const genFurn = (id) => GEN_FURNITURE[id] || { oils: [], pads: [], boxes: [] };

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
//   loop(radius, opts?)          a vertical loop. Default: a HALF-loop — 180° of a
//                                planar circle, exiting at ±2·radius (over: false
//                                dives) heading the OPPOSITE way, frame flipped.
//                                With `drift`: the FULL 360° TILTED toy loop — one
//                                circle whose plane leans sideways, landing the
//                                exit `drift` beside the entry at ground level,
//                                parallel, heading unchanged; upside down only at
//                                the top instant. The tilt couples ~75° of frame
//                                holonomy per loop — cancel it with a matching
//                                `roll` (probe it; see Twister) or the stretch
//                                after the loop rides visibly rolled.
// opts (any segment): rise (Δelevation over the segment, eased), bump (net-flat hump
//   amplitude), bank (peak roll°, eased — corners only in practice), roll (heartline
//   twist about the centerline, eased over the segment and CUMULATIVE downstream —
//   small rolls trim the geometric holonomy of climbing/tilted elements like the
//   spiral and the drift loops; a full roll: 360 corkscrews the road around a
//   straight line and self-cancels, e.g. a barrel roll),
//   width (number or [start,end] taper, overriding the track default), lateral
//   (straight-only net cross-shift, an S — a chicane is curve+curveR), pillars (stand
//   support columns from the grass up to a raised deck — flag the ramp + bridge run
//   of an overpass).
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
// Some legs below use L ± 0.37: a 90° arc of these radii advances slightly more/less along
// each plan axis than a plain `L` straight, so the figure-8 (Crossover) and L-shaped
// (Riverside) loops need a small leg nudge to close (gap ≈ 0). Values found empirically and
// guarded by the "every named track closes" test — re-tune if a radius or layout changes.

const straight = (length, opts = {}) => ({ kind: 'straight', length, ...opts });
const arc = (radius, angle, opts = {}) => ({ kind: 'arc', radius, angle, ...opts });
const loop = (radius, opts = {}) => ({ kind: 'loop', radius, ...opts });
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
  arc(RL, -90), straight(L, { rise: 1.0, pillars: true }), ...run(4, { pillars: true }), straight(L, { rise: -1.0, pillars: true }), // turn west + BRIDGE (on pillars)
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

// ---- Twister (Expert): the stunt showpiece — a flat SPIRAL and two small TILTED
// TOY LOOPS, every stunt entered and exited dead straight on an otherwise flat
// banked circuit. A low pillared bridge opens the lap.
//
// THE BRIDGE: it once carried a 360° heartline barrel roll (the road corkscrewed
// around a dead-straight driving line). Removed — the corkscrew made players
// dizzy. The engine handles it fine, so to bring it back, restore `roll: 360` on
// the bridge straight below (360° ≡ 0, so it self-cancels and needs no other
// change). The raised bridge is kept as scenery.
//
// THE SPIRAL (NW corner): a looping in YAW — 450° clockwise, climbing to bridge
// over its own entrance, then diving out as the downhill launch. -450° ≡ -90°, so
// it drops in as a plain corner; the climb-while-turning couples ~35° of frame
// holonomy, cancelled by the small roll spread invisibly over the arc.
//
// THE LOOPS: each is ONE segment — a full 360° circle whose plane tilts sideways
// (loop(2.2, { drift: ±3 })), so the car drives straight in, around, and out one
// road width beside the entry, parallel, at ground level. No crown, no roll-out;
// upside down only for the instant over the top. The tilt's ~75.5° of transported
// holonomy is cancelled inside each ring by its `roll` (opposite signs for the
// opposite leans), measured by probe — without it the stretch BETWEEN the loops
// rides on its side even though the lap seam closes upright.
//
// Closure: headings sum to -720° (the spiral adds a full extra turn); each loop is
// plan-wise a pure lateral jog of `drift`. The east/south leg lengths are solved
// so the plan closes exactly (gap ≈ 0); every stunt is net-flat, so elevation
// closes by construction. ----
export const TWISTER = [
  ...run(3),                                          // the grid straight
  straight(4, { rise: 1.5, pillars: true }),          // ramp onto the bridge
  straight(32, { pillars: true }),                    // THE BRIDGE — was a 360° barrel roll (see header)
  straight(4, { rise: -1.5, pillars: true }),         // ramp off
  straight(4),                                        // breather up to the spiral
  arc(RL, -450, { rise: 2.6, bank: 10, pillars: true, roll: 34.9 }), // THE SPIRAL
  straight(9, { rise: -2.6, pillars: true }),         // dive out — the downhill launch
  straight(6),                                        // flat beat — boost — straight into
  loop(2.2, { drift: 3, roll: 75.5 }),                            // LOOP 1: one small tilted circle — straight in,
                                                      // around, and out one road width beside the entry
  straight(4),                                        // beat
  arc(RL, -90, { bank: 10 }),                         // NE corner, banked
  straight(52),                                       // east leg south — boost — straight into
  loop(2.2, { drift: -3, roll: -75.5 }),                           // LOOP 2: the same tilted circle, leaning the other way
  straight(7),                                        // beat
  arc(RL, -90, { bank: 10 }),                         // SE corner, banked
  straight(16),                                       // south leg home
  arc(RL, -90, { bank: 10 })                          // SW corner, into the grid
];

// ---- Helix (Expert): the double-spiral skyway. Climb Twister's 450° spiral to a long
// pillared bridge riding the east side at height, then corkscrew back to earth through
// a SAME-hand descending spiral; the south leg home threads an S-pair of tilted toy
// loops. Same-hand spirals wind the lap to a net -1080° (3 full turns — the plan is
// still a simple rounded rectangle, like Twister's -720 double wind). Composed by
// scripts/compose-stunt.mjs: the grid/top-leg lengths are its closure solve, each
// stunt's `roll` its probe-measured holonomy trim (spiral-down needs ~none — the
// descent's twist self-cancels against the same-hand climb already trimmed upstream).
export const HELIX = [
  straight(28),                                                      // grid, north-bound
  arc(RL, -90),                                                      // NE corner (unbanked — the spirals carry the cup's lean)
  straight(26),                                                      // top leg, east-bound
  arc(RL, -450, { rise: 2.6, bank: 10, pillars: true, roll: 39.6 }), // SPIRAL UP
  straight(28, { pillars: true }),                                   // THE SKYWAY, south-bound at height
  arc(RL, -450, { rise: -2.6, bank: 10, pillars: true, roll: -0.5 }),// SPIRAL DOWN (same hand)
  straight(8),                                                       // south leg — boost — straight into
  loop(2.2, { drift: 3, roll: 52 }),                                 // TOY LOOP L
  straight(10),                                                      // beat (rings stay 20 world apart)
  loop(2.2, { drift: -3, roll: -57.1 }),                             // TOY LOOP R (the S-pair)
  straight(8),                                                       // south-west run home
  arc(RL, -90)                                                       // SW corner into the grid
];

// ---- Skyline (Expert): the big-air one. A HALF-LOOP fires the pack straight up onto
// an 8-world-high skyway ridden back over its own approach — an Immelmann: the deck
// carries the 180° righting roll, eased across the whole span (peak twist ~0.17
// rad/world, inside the helicoid test's 0.21 bound) — then a banked descending U-turn
// swings outboard and dives home past one tilted toy loop. Composed by
// scripts/compose-stunt.mjs (solved legs + probe-measured roll trims, like Helix).
export const SKYLINE = [
  straight(13.8),                                                    // grid, north-bound (+1.8 with the south-bound run
  arc(RL, 90),                                                       //  below: slides the whole stunt section 3.6 world
  straight(16),                                                      //  north of the south edge, whose deck merged with
  arc(RL, 90),                                                       //  the half-loop mouth; closure stays exact)
  straight(14),                                                      // boost approach, south-bound
  loop(2.0),                                                         // HALF-LOOP UP → 8 world, heading flipped, frame inverted
  straight(24, { roll: 180, pillars: true }),                        // SKYWAY back over the approach — rolls upright
  arc(RL, 180, { rise: -2.0, bank: 10, pillars: true, roll: 6 }),    // descending U, swings outboard
  straight(6, { rise: -2.0, pillars: true }),                        // dive to ground
  straight(6),                                                       // flat beat — boost — straight into
  loop(2.2, { drift: -3, roll: -84 }),                               // TOY LOOP
  straight(11.8),                                                    // south-bound run (+1.8, see the grid straight)
  arc(RL, 90),                                                       // SW corner
  straight(27.37),                                                   // south edge home (closure-solved)
  arc(RL, 90)                                                        // into the grid
];

// ---- Coaster (Hard): the airtime one, and the Rooftop cup's no-tilt on-ramp. A
// camelback run of three shrinking net-flat humps the pack crests light, one tilted toy
// loop, then a big grass summit up-and-over with a blind exit. No banking anywhere.
// Composed by scripts/compose-stunt.mjs (solved legs + probe-measured loop trim).
export const COASTER = [
  ...run(6),                                                         // grid, north-bound
  arc(RL, -90),                                                      // NE corner
  straight(9, { bump: 0.8 }),                                        // CAMELBACK RUN — three shrinking humps
  straight(9, { bump: 0.6 }),
  straight(9, { bump: 0.45 }),
  straight(14),                                                      // breather (closure-solved)
  arc(RL, -90),
  straight(18),                                                      // boost — straight into (closure-solved)
  loop(2.2, { drift: 3, roll: 60 }),                                 // TOY LOOP
  straight(6),                                                       // beat
  arc(RL, -90),
  straight(8),
  straight(9, { rise: 1.8 }),                                        // THE SUMMIT — a grass mountain up...
  straight(9, { rise: -1.8 }),                                       // ...and over, blind exit
  straight(6, { lateral: -0.8 }), straight(6, { lateral: 0.8 }),     // soft chicane on the run home
  straight(6),
  arc(RL, -90)                                                       // SW corner into the grid
];

// ---- Gauntlet (Expert): thread the needle. The lap fires straight THROUGH the ring
// of its own toy loop — a pillared ramp narrows as it climbs, crests dead-centre in
// the ring's opening (5.0 world; the hole faces ±lateral, so the ramp runs
// perpendicular to the loop's travel), then plunges onto a low bridge that clears the
// loop's own boost leg before dropping home. Composed by scripts/compose-stunt.mjs:
// the align solver (solveAlign + measureRing) parked the crest 0.00 world off the
// ring axis; the odd lengths are its alignment + closure solves.
export const GAUNTLET = [
  straight(14),                                                      // grid, north-bound
  arc(RL, -90),                                                      // NE corner
  straight(12),                                                      // east leg
  arc(RL, -90),                                                      // south-bound
  straight(8),                                                       // boost — straight into
  loop(2.2, { drift: 3, roll: 66 }),                                 // THE RING (opening faces ±X)
  straight(10),                                                      // south spacing
  arc(RL, -90),                                                      // west-bound
  straight(6.315),                                                   // overshoot past the ring (align-solved)
  arc(RL, -90),                                                      // north-bound
  straight(5.815),                                                   // back to ring latitude (align-solved)
  arc(RL, -90),                                                      // east — straight at the ring
  straight(9, { rise: 2.51, pillars: true, width: [2.5, 2.2] }),     // THE RAMP — narrows, crests in the ring
  straight(6, { rise: -1.61, pillars: true, width: [2.2, 2.5] }),    // THE PLUNGE through and out
  straight(8, { pillars: true }),                                    // low bridge over the boost leg
  straight(5, { rise: -0.9, pillars: true }),                        // final drop to ground
  straight(8),                                                       // east run out
  arc(RL, -90),                                                      // south-bound
  straight(9.63),                                                    // (closure-solved 7.815, then +1.815 with the home leg
  arc(RL, -90),                                                      //  below: the south edge sat only 4 world from the
  straight(44.685),                                                  //  overshoot corridor — decks merged; stretching this
  arc(RL, -90),                                                      //  anti-parallel pair slides it 3.6 world clear while
  straight(7.815)                                                    //  keeping closure exact)
];

// ---- Skysnake (Hard): a slalom IN THE SKY. The spiral climbs to 5.2 world, the road
// weaves an S-S through the clouds on pillars, then dives home past a toy loop.
// Composed by scripts/compose-stunt.mjs (solved grid leg + probe-measured roll trims).
export const SKYSNAKE = [
  straight(40.837),                                                  // grid straight (closure-solved)
  arc(RL, -90),                                                      // east
  straight(10),
  arc(RL, -450, { rise: 2.6, bank: 10, pillars: true, roll: 18 }),   // SPIRAL UP → south
  arc(RL, 45, { pillars: true }), arc(RL, -45, { pillars: true }),   // THE SKY WEAVE @5.2 world
  arc(RL, -45, { pillars: true }), arc(RL, 45, { pillars: true }),
  straight(6, { pillars: true }),
  straight(10, { rise: -2.6, pillars: true }),                       // dive to ground
  straight(5),                                                       // boost — straight into
  loop(2.2, { drift: -3, roll: -90 }),                               // TOY LOOP
  straight(8),
  arc(RL, -90),                                                      // west
  straight(7),
  arc(RL, -90)                                                       // home
];

// ---- Meadow Mile (Easy): the gentle teaching circuit. A roomy rounded rectangle on big
// sweeping (RL) corners — the easiest line to hold — with one soft chicane and a rolling
// half-hill per long side, and open sweeper short sides. No stunts, no banking, nothing
// tight. Four small LEFT corners of the SAME hand with matched OPPOSITE sides (long 7 /
// short 3) close it exactly like Switchback, just on the larger radius. ----
export const MEADOW = [
  straight(L), ...chicane(), straight(L), ...halfHill(), straight(L), arc(RL, 90),  // A: 7 (soft S, then a rolling hill)
  ...run(3), arc(RL, 90),                                                           // B: 3 (open sweeper)
  straight(L), ...chicane(), straight(L), ...halfHill(), straight(L), arc(RL, 90),  // C: 7 (= A)
  ...run(3), arc(RL, 90)                                                            // D: 3 (= B)
];

// ---- BACKYARD CUP — four SEEDED multi-crossing tracks. Each is a procedurally-generated
// closed plan whose self-crossings are lifted into overpasses by a solved elevation profile
// (scripts/gen-tracks.mjs); the resolved waypoints are baked into GEN_TRACKS and used directly
// in the registry below. To reroll or change the seed picks, edit + run that script. ----

// Oil slicks per track — FIXED hazards. Placed by `u` (fraction of the lap, 0 =
// start/finish) and `lat` (lateral offset in world units; 0 = centreline). `radius`
// and `cones` optional. Off-centre so a careful line can thread past; tune by driving.
const OILS = {
  // (Generated cups — Beach/Backyard/Canyon — carry auto-placed furniture in
  // GEN_FURNITURE; only the segment-DSL tracks and the retired trio are authored here.)
  // Easiest track → a single, clearly off-line slick a careful line threads past.
  meadow:     [ { u: 0.74, lat: 0.8 } ],
  switchback: [ { u: 0.34, lat: 0.7 }, { u: 0.80, lat: -0.7 } ],
  crossover:  [ { u: 0.22, lat: 0.0 }, { u: 0.52, lat: 0.8 }, { u: 0.84, lat: -0.6 } ],
  riverside:  [ { u: 0.16, lat: -0.7 }, { u: 0.46, lat: 0.7 }, { u: 0.74, lat: 0.0 } ],
  // Flats only — never on a loop or the spiral, where a forced spin would be cruel.
  twister:    [ { u: 0.232, lat: 0.7 }, { u: 0.732, lat: -0.7 } ],
  // Auto-placed (scripts/track-gen.mjs placeFurniture on the composed geometry) —
  // gentle open ground, clear of decks, spirals and the loops.
  helix:      [ { u: 0.198, lat: 0.7 }, { u: 0.829, lat: -0.7 } ],
  skyline:    [ { u: 0.263, lat: 0.7 }, { u: 0.463, lat: -0.7 } ],
  coaster:    [ { u: 0.334, lat: 0.7 }, { u: 0.645, lat: -0.7 } ],
  gauntlet:   [ { u: 0.29, lat: 0.7 }, { u: 0.795, lat: -0.7 } ],
  skysnake:   [ { u: 0.211, lat: 0.7 }, { u: 0.844, lat: -0.7 } ]
};

// Boost pads — drive-over speed strips, position-scaled for catch-up. Place on STRAIGHTS
// (XZ curvature ≈ 0, where the boost isn't wasted mid-corner), centred (lat 0) on the
// racing line. `u` = fraction of lap. A pure climb/descent counts as straight.
const PADS = {
  // Centred on the two long open sweepers (the short sides) — the cleanest straights.
  meadow:     [ { u: 0.38, lat: 0.0 }, { u: 0.88, lat: 0.0 } ],
  switchback: [ { u: 0.15, lat: 0.0 }, { u: 0.65, lat: 0.0 } ],
  crossover:  [ { u: 0.08, lat: 0.0 }, { u: 0.40, lat: 0.0 } ],
  riverside:  [ { u: 0.10, lat: 0.0 }, { u: 0.51, lat: 0.0 } ],
  // No authored pads: every looping auto-places a full-width rectangular launch
  // strip at its mouth (see main.js / TrackBuilder.loopStarts), so the pack is
  // always fired INTO each ring on boost — the two manual circular loop-feeders
  // that used to sit before loop 1 and loop 2 are now redundant.
  twister:    [],
  // Auto-placed on the cleanest straights (the loop mouths add their own strips).
  helix:      [ { u: 0.063, lat: 0.0 }, { u: 0.445, lat: 0.0 } ],
  skyline:    [ { u: 0.119, lat: 0.0 }, { u: 0.6, lat: 0.0 } ],
  coaster:    [ { u: 0.064, lat: 0.0 }, { u: 0.463, lat: 0.0 } ],
  gauntlet:   [ { u: 0.105, lat: 0.0 }, { u: 0.683, lat: 0.0 } ],
  skysnake:   [ { u: 0.066, lat: 0.0 }, { u: 0.633, lat: 0.0 } ]
};

// Item boxes — drive-over pickups in rows ACROSS the lane. `u` = fraction of lap, `lat`
// = lateral offset. A row is 4 spread across the lane; each track lays down TWO rows
// ~half a lap apart so there's a fresh pickup on each side of the lap (you can only hold
// one item, so a second grab point beats clustering them). The second `u` per track sits
// on the gentlest open stretch ~0.5 lap from the first — lowest curvature/grade, off the
// bridge decks and loops (pickups are safe, so a low deck is otherwise fine).
const BOX_LANES = [-1.05, -0.35, 0.35, 1.05];
const boxRow = (u) => BOX_LANES.map((lat) => ({ u, lat }));
const boxRows = (...us) => us.flatMap(boxRow);
const BOXES = {
  meadow:     boxRows(0.13, 0.64),   // straight after the first chicane, then side C's mirror straight
  switchback: boxRows(0.20, 0.73),
  crossover:  boxRows(0.66, 0.13),
  riverside:  boxRows(0.30, 0.78),
  twister:    boxRows(0.039, 0.57), // early on the launch straight, then the far flat — grab, fly, grab again
  helix:      boxRows(0.086, 0.705),  // auto-placed: the grid run, then the south leg past the loops
  skyline:    boxRows(0.148, 0.723),  // auto-placed: the north leg, then the flat past the toy loop
  coaster:    boxRows(0.093, 0.492),  // auto-placed: the grid run, then the boost straight
  gauntlet:   boxRows(0.128, 0.559),  // auto-placed: the east leg, then the exit run past the plunge
  skysnake:   boxRows(0.096, 0.715)   // auto-placed: the grid straight, then the flat past the toy loop
};

// Support poles — SOLID obstacles cars collide with (unlike oils, which only spin you).
// A pole stands ON a lower stretch of road and rises to brace a deck crossing overhead,
// so the flown-over span reads as supported, not floating — and clipping it costs you.
// Placed by `u`/`lat` like the others; collision lives in (s, lat), so a pole on the
// LOWER pass only bites that pass — a car on the deck above (a far-away `s`) sails over
// it. Off-centre so a clean line threads past. Only the Twister spiral needs one.
const POLES = {
  twister: [ { u: 0.272, lat: 0 } ] // dead-centre on the lower pass DIRECTLY under the summit — the column
                                     // rises bottom→top to hold the spiral's highest point; you clip it climbing in
};

// Registry of named, previewable tracks. Selected in the display via ?track=<key>.
// `difficulty` is a display label only (the picker badges it; cups order easy→hard).
export const TRACKS = {
  // Beach Cup — SEEDED easy circuits (scan-seeds `easy` profile: sweeping corners,
  // rolling hills + hops, width play, no crossings; auto-placed furniture).
  tidepool: {
    name: 'Tidepool', difficulty: 'Easy', waypoints: GEN_TRACKS.tidepool,
    oils: genFurn('tidepool').oils, pads: genFurn('tidepool').pads, boxes: genFurn('tidepool').boxes
  },
  cove: {
    name: 'Cove', difficulty: 'Easy', waypoints: GEN_TRACKS.cove,
    oils: genFurn('cove').oils, pads: genFurn('cove').pads, boxes: genFurn('cove').boxes
  },
  driftwood: {
    name: 'Driftwood', difficulty: 'Easy', waypoints: GEN_TRACKS.driftwood,
    oils: genFurn('driftwood').oils, pads: genFurn('driftwood').pads, boxes: genFurn('driftwood').boxes
  },
  riptide: {
    name: 'Riptide', difficulty: 'Easy', waypoints: GEN_TRACKS.riptide,
    oils: genFurn('riptide').oils, pads: genFurn('riptide').pads, boxes: genFurn('riptide').boxes
  },
  // Snow Cup — SEEDED medium circuits (the gentle end of the mid profile: low brake
  // fraction, no hairpins, roomy radii, but real crossings + climb; auto-placed furniture).
  powder: {
    name: 'Powder', difficulty: 'Medium', waypoints: GEN_TRACKS.powder,
    oils: genFurn('powder').oils, pads: genFurn('powder').pads, boxes: genFurn('powder').boxes
  },
  flurry: {
    name: 'Flurry', difficulty: 'Medium', waypoints: GEN_TRACKS.flurry,
    oils: genFurn('flurry').oils, pads: genFurn('flurry').pads, boxes: genFurn('flurry').boxes
  },
  glacier: {
    name: 'Glacier', difficulty: 'Medium', waypoints: GEN_TRACKS.glacier,
    oils: genFurn('glacier').oils, pads: genFurn('glacier').pads, boxes: genFurn('glacier').boxes
  },
  avalanche: {
    name: 'Avalanche', difficulty: 'Hard', waypoints: GEN_TRACKS.avalanche,
    oils: genFurn('avalanche').oils, pads: genFurn('avalanche').pads, boxes: genFurn('avalanche').boxes
  },
  // Backyard Cup — SEEDED multi-crossing circuits (overpasses + solver-placed elevation,
  // decorated mid profile; auto-placed furniture).
  ribbon: {
    name: 'Ribbon', difficulty: 'Medium', waypoints: GEN_TRACKS.ribbon,
    oils: genFurn('ribbon').oils, pads: genFurn('ribbon').pads, boxes: genFurn('ribbon').boxes
  },
  pretzel: {
    name: 'Pretzel', difficulty: 'Hard', waypoints: GEN_TRACKS.pretzel,
    oils: genFurn('pretzel').oils, pads: genFurn('pretzel').pads, boxes: genFurn('pretzel').boxes
  },
  tangle: {
    name: 'Tangle', difficulty: 'Hard', waypoints: GEN_TRACKS.tangle,
    oils: genFurn('tangle').oils, pads: genFurn('tangle').pads, boxes: genFurn('tangle').boxes
  },
  cloverleaf: {
    name: 'Cloverleaf', difficulty: 'Expert', waypoints: GEN_TRACKS.cloverleaf,
    oils: genFurn('cloverleaf').oils, pads: genFurn('cloverleaf').pads, boxes: genFurn('cloverleaf').boxes
  },
  // Canyon Cup — SEEDED hard circuits (scan-seeds `hard` profile: hairpins, stacked
  // crossings, width pinches, crest hills; auto-placed furniture).
  wash: {
    name: 'Wash', difficulty: 'Hard', waypoints: GEN_TRACKS.wash,
    oils: genFurn('wash').oils, pads: genFurn('wash').pads, boxes: genFurn('wash').boxes
  },
  gulch: {
    name: 'Gulch', difficulty: 'Hard', waypoints: GEN_TRACKS.gulch,
    oils: genFurn('gulch').oils, pads: genFurn('gulch').pads, boxes: genFurn('gulch').boxes
  },
  crag: {
    name: 'Crag', difficulty: 'Hard', waypoints: GEN_TRACKS.crag,
    oils: genFurn('crag').oils, pads: genFurn('crag').pads, boxes: genFurn('crag').boxes
  },
  sidewinder: {
    name: 'Sidewinder', difficulty: 'Expert', waypoints: GEN_TRACKS.sidewinder,
    oils: genFurn('sidewinder').oils, pads: genFurn('sidewinder').pads, boxes: genFurn('sidewinder').boxes
  },
  // Rooftop Cup — segment-DSL stunt circuits (overpass + loops).
  crossover: {
    name: 'Crossover', difficulty: 'Hard', segments: CROSSOVER,
    oils: OILS.crossover, pads: PADS.crossover, boxes: BOXES.crossover
  },
  twister: {
    // Retired from the cup 2026-07-04 audition (kept defined: the spiral/tilted-loop/
    // pole geometry regression suite runs against it).
    name: 'Twister', difficulty: 'Expert', segments: TWISTER,
    oils: OILS.twister, pads: PADS.twister, boxes: BOXES.twister, poles: POLES.twister
  },
  skysnake: {
    name: 'Skysnake', difficulty: 'Hard', segments: SKYSNAKE,
    oils: OILS.skysnake, pads: PADS.skysnake, boxes: BOXES.skysnake
  },
  gauntlet: {
    name: 'Gauntlet', difficulty: 'Expert', segments: GAUNTLET,
    oils: OILS.gauntlet, pads: PADS.gauntlet, boxes: BOXES.gauntlet
  },
  coaster: {
    // Retired from the cup 2026-07-04 audition (kept defined: camelback-bump coverage).
    name: 'Coaster', difficulty: 'Hard', segments: COASTER,
    oils: OILS.coaster, pads: PADS.coaster, boxes: BOXES.coaster
  },
  helix: {
    name: 'Helix', difficulty: 'Expert', segments: HELIX,
    oils: OILS.helix, pads: PADS.helix, boxes: BOXES.helix
  },
  skyline: {
    name: 'Skyline', difficulty: 'Expert', segments: SKYLINE,
    oils: OILS.skyline, pads: PADS.skyline, boxes: BOXES.skyline
  },
  // Retired — in no cup, so they don't appear in the picker; kept defined only so the
  // geometry regression tests keep exercising the segment-DSL builders they use.
  meadow: {
    name: 'Meadow Mile', difficulty: 'Easy', segments: MEADOW,
    oils: OILS.meadow, pads: PADS.meadow, boxes: BOXES.meadow
  },
  switchback: {
    name: 'Switchback', difficulty: 'Hard', segments: SWITCHBACK,
    oils: OILS.switchback, pads: PADS.switchback, boxes: BOXES.switchback
  },
  riverside: {
    name: 'Riverside', difficulty: 'Medium', segments: RIVERSIDE,
    oils: OILS.riverside, pads: PADS.riverside, boxes: BOXES.riverside
  }
};

// Cups — curated, ordered sets of tracks (a "grand prix" grouping). Each cup lists its
// track ids easiest→hardest; the controller picker renders one labelled section per cup.
// CUPS is the SOURCE OF TRUTH for track ordering — TRACK_ORDER / TRACK_LIST below are
// derived by flattening it, so a track appears in the picker iff it's listed in a cup.
// New track: add the descriptor to TRACKS above, then drop its id into a cup here.
// Cup order IS the difficulty ladder (tendencies 1→2→3→3→4); each cup's biome is
// mapped in themes.js CUP_BIOME (Backyard keeps the canonical grass look).
export const CUPS = [
  { id: 'beach',    name: 'Beach Cup',    tracks: ['tidepool', 'cove', 'driftwood', 'riptide'] }, // easy: flowing sweepers + hops (beach biome)
  { id: 'snow',     name: 'Snow Cup',     tracks: ['powder', 'flurry', 'glacier', 'avalanche'] }, // medium: gentle-mid crossings + climb (snow biome)
  { id: 'backyard', name: 'Backyard Cup', tracks: ['ribbon', 'pretzel', 'tangle', 'cloverleaf'] }, // middle: seeded multi-crossing circuits (grass biome)
  { id: 'canyon',   name: 'Canyon Cup',   tracks: ['wash', 'gulch', 'crag', 'sidewinder'] },   // hard: hairpins + stacked crossings (canyon biome)
  // crazy: stunts (playroom biome — orange plastic track); crossover/coaster/twister retired.
  // id stays 'rooftop' (wired into CUP_BIOME/selections); only the display name moved.
  { id: 'rooftop',  name: 'Playroom Cup', tracks: ['skysnake', 'skyline', 'helix', 'gauntlet'] }
];

// Cup "tendency" difficulty (1–4): a LEAN for the whole cup, not a per-track label —
// the rounded mean of its tracks' levels (Easy=1 … Expert=4), or an explicit `difficulty`
// on the cup to pin it. The picker shows this as a 4-pip meter on the cup header; tracks
// are NOT badged individually. Recomputes as tracks join a cup.
const DIFF_LEVEL = { Easy: 1, Medium: 2, Hard: 3, Expert: 4 };
const cupTendency = (c) => c.difficulty != null ? c.difficulty
  : Math.round(c.tracks.reduce((sum, id) => sum + (DIFF_LEVEL[TRACKS[id].difficulty] || 2), 0) / c.tracks.length);

// id → { cup, cupName, cupDifficulty } so each track knows its cup for the picker. Validate
// ids first (a cup naming a track absent from TRACKS would otherwise vanish silently).
const CUP_OF = {};
for (const c of CUPS) {
  for (const id of c.tracks) if (!TRACKS[id]) throw new Error(`CUPS references unknown track "${id}"`);
  const cupDifficulty = cupTendency(c);
  for (const id of c.tracks) CUP_OF[id] = { cup: c.id, cupName: c.name, cupDifficulty };
}

// Stable display order for the gallery / picker — every cup's tracks, in cup order.
export const TRACK_ORDER = CUPS.flatMap((c) => c.tracks);

// Flat list — {id, name, difficulty, cup, cupName, cupDifficulty, segments, oils, pads,
// boxes, poles} in cup order — used by main.js, the track picker, and the gallery. `difficulty`
// is per-track data (orders the cup + feeds the tendency); the picker renders only the cup
// tendency. The display builds each track + computes its schematic SVG, so no per-track art.
export const TRACK_LIST = TRACK_ORDER.map((id) => ({
  id, name: TRACKS[id].name, difficulty: TRACKS[id].difficulty,
  cup: CUP_OF[id].cup, cupName: CUP_OF[id].cupName, cupDifficulty: CUP_OF[id].cupDifficulty,
  segments: TRACKS[id].segments, waypoints: TRACKS[id].waypoints,
  oils: TRACKS[id].oils, pads: TRACKS[id].pads, boxes: TRACKS[id].boxes, poles: TRACKS[id].poles
}));
