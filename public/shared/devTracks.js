// DEV-ONLY tracks — debug/test surfaces and RETIRED circuits. Never part of TRACKS/CUPS, so
// the phone picker can't see them; the display builds one only when ?track=<id> names it in a
// ?scenario= test surface or ?solo mode (see main.js).
//
// Two kinds live here:
//   gym       — the collision test range (below).
//   retired   — circuits the 2026-07-04 audition dropped from the cups. They are NOT dead
//               code: the geometry suites in tests/track.test.js run against them, and they
//               are the only tracks exercising some of the segment DSL. Twister carries the
//               whole stunt-geometry suite (loops invert the frame, deck twist stays shallow,
//               frames resolve upright at the seam, the spiral bridges its own entrance);
//               Switchback pins buildTrack(array) === buildTrack(descriptor); Crossover and
//               Riverside pin the flare, pole and berm passes; Coaster and Riverside are the
//               only carriers of `bump`. Meadow and Switchback are also the difficulty
//               calibration anchors cited by PROFILES.easy/hard (scripts/track-gen.mjs).
//               Delete one and you delete its coverage — check tests/track.test.js first.
//
// They author with the SAME segment vocabulary as the shipped catalogue, imported rather than
// copied: shared/tracks.js owns the DSL and its documentation, this module owns the track data
// that doesn't ship. (Nothing here needs `startU` — the grid-on-a-straight rule is enforced
// over TRACK_LIST, and these are in no cup.)
import { DSL, boxRows } from './tracks.js';
const { L, W, RS, RL, straight, arc, loop, run, chicane, halfHill, fullHill, flare } = DSL;

// ---- RETIRED circuits — segment geometry (moved verbatim from shared/tracks.js) ----

// ---- Switchback (Hard): tight, technical. A compact rectangle (small-radius corners),
// chicane + rolling half-hill on the long sides, a quick chicane on the short sides.
// Sides 7/3/7/3 with four small LEFT corners → closes. ----
const SWITCHBACK = [
  straight(L), ...chicane(), ...halfHill(), ...flare(2, 3.1), arc(RS, 90),  // A: 7 (flared corner approach)
  ...chicane(), straight(L), arc(RS, 90),                                   // B: 3
  straight(L), ...chicane(), ...halfHill(), ...flare(2, 3.1), arc(RS, 90),  // C: 7 (=A)
  ...chicane(), straight(L), arc(RS, 90)                                    // D: 3 (=B)
];

// ---- Crossover (Hard): a figure-8 that passes OVER itself. Up a long spine, loop the
// top (clockwise), down the far side, then a west-bound straight CLIMBS onto a bridge
// and crosses 90° OVER the spine before descending and looping the bottom back to
// start. 3 right + 3 left corners → net 0°; the rise…fall lifts the bridge strand. ----
const CROSSOVER = [
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
const RIVERSIDE = [
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
const TWISTER = [
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

// ---- Coaster (Hard): the airtime one, and the Rooftop cup's no-tilt on-ramp. A
// camelback run of three shrinking net-flat humps the pack crests light, one tilted toy
// loop, then a big grass summit up-and-over with a blind exit. No banking anywhere.
// Composed by scripts/compose-stunt.mjs (solved legs + probe-measured loop trim).
const COASTER = [
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

// ---- Meadow Mile (Easy): the gentle teaching circuit. A roomy rounded rectangle on big
// sweeping (RL) corners — the easiest line to hold — with one soft chicane and a rolling
// half-hill per long side, and open sweeper short sides. No stunts, no banking, nothing
// tight. Four small LEFT corners of the SAME hand with matched OPPOSITE sides (long 7 /
// short 3) close it exactly like Switchback, just on the larger radius. ----
const MEADOW = [
  straight(L), ...chicane(), straight(L), ...halfHill(), straight(L), arc(RL, 90),  // A: 7 (soft S, then a rolling hill)
  ...run(3), arc(RL, 90),                                                           // B: 3 (open sweeper)
  straight(L), ...chicane(), straight(L), ...halfHill(), straight(L), arc(RL, 90),  // C: 7 (= A)
  ...run(3), arc(RL, 90)                                                            // D: 3 (= B)
];
// ---- Retired-circuit furniture. Authored by hand against the original hand-built layouts
// (u = fraction of lap from the start line, lat = world-unit offset from the centreline),
// except Coaster's, which was auto-placed by track-gen's placeFurniture. ----
const OILS = {
  meadow:     [ { u: 0.74, lat: 0.8 } ],
  switchback: [ { u: 0.34, lat: 0.7 }, { u: 0.80, lat: -0.7 } ],
  crossover:  [ { u: 0.22, lat: 0.0 }, { u: 0.52, lat: 0.8 }, { u: 0.84, lat: -0.6 } ],
  riverside:  [ { u: 0.16, lat: -0.7 }, { u: 0.46, lat: 0.7 }, { u: 0.74, lat: 0.0 } ],
  twister:    [ { u: 0.232, lat: 0.7 }, { u: 0.732, lat: -0.7 } ], // flats only — never on a loop or the spiral
  coaster:    [ { u: 0.334, lat: 0.7 }, { u: 0.645, lat: -0.7 } ]
};
const PADS = {
  meadow:     [ { u: 0.38, lat: 0.0 }, { u: 0.88, lat: 0.0 } ],
  switchback: [ { u: 0.15, lat: 0.0 }, { u: 0.65, lat: 0.0 } ],
  crossover:  [ { u: 0.08, lat: 0.0 }, { u: 0.40, lat: 0.0 } ],
  riverside:  [ { u: 0.10, lat: 0.0 }, { u: 0.51, lat: 0.0 } ],
  twister:    [], // no authored pads: every looping auto-places a launch strip at its mouth
  coaster:    [ { u: 0.064, lat: 0.0 }, { u: 0.463, lat: 0.0 } ]
};
const BOXES = {
  meadow:     boxRows(0.13, 0.64),
  switchback: boxRows(0.20, 0.73),
  crossover:  boxRows(0.66, 0.13),
  riverside:  boxRows(0.30, 0.78),
  twister:    boxRows(0.039, 0.57),
  coaster:    boxRows(0.093, 0.492)
};
// Support poles — SOLID obstacles (unlike oils, which only spin you). Collision lives in
// (s, lat), so a pole on the LOWER pass only bites that pass. Only the Twister spiral needs one.
const POLES = {
  twister: [ { u: 0.272, lat: 0 } ] // dead-centre on the lower pass DIRECTLY under the summit
};

export const DEV_TRACKS = {
  gym: {
    name: 'Gym', difficulty: 'Easy',
    waypoints: [
      // main straight (collinear points stay straight under the centripetal spline)
      { x: 0, z: 0 }, { x: 8, z: 0 }, { x: 16, z: 0 }, { x: 24, z: 0 }, { x: 32, z: 0 },
      // right U-turn
      { x: 38.5, z: 1.5 }, { x: 41, z: 7 }, { x: 38.5, z: 12.5 },
      // back straight
      { x: 32, z: 14 }, { x: 24, z: 14 }, { x: 16, z: 14 }, { x: 8, z: 14 }, { x: 0, z: 14 },
      // left U-turn (closes back to the start line)
      { x: -6.5, z: 12.5 }, { x: -9, z: 7 }, { x: -6.5, z: 1.5 }
    ],
    // u = fraction of the lap (built length ≈ 232 world units, ~29 s/lap) — each
    // cluster sits well inside its straight, clear of the U-turns.
    boxes: [
      { u: 0.045, lat: 0 },                                        // isolated box — feel the radius exactly
      { u: 0.10, lat: -1.05 }, { u: 0.10, lat: -0.35 },            // the standard 4-lane row
      { u: 0.10, lat: 0.35 }, { u: 0.10, lat: 1.05 }
    ],
    pads: [
      { u: 0.135, lat: 0.9 }                                        // one boost disc, off-centre
    ],
    poles: [
      { u: 0.17, lat: -1.0 }, { u: 0.17, lat: 1.0 },               // a gate to thread
      { u: 0.225, lat: 0 }                                          // one dead-centre to dodge
    ],
    oils: [
      { u: 0.52, lat: 0 },                                          // centre puddle
      { u: 0.575, lat: -1.0 }                                       // edge puddle
    ],
    bananas: [
      { u: 0.63, lat: 0 }, { u: 0.665, lat: -0.9 }, { u: 0.70, lat: 0.9 }
    ]
  },

  // ---- Retired from the cups (2026-07-04 audition). Preview any with ?solo&track=<id>. ----
  crossover: {
    name: 'Crossover', difficulty: 'Hard', segments: CROSSOVER,
    oils: OILS.crossover, pads: PADS.crossover, boxes: BOXES.crossover
  },
  twister: {
    name: 'Twister', difficulty: 'Expert', segments: TWISTER,
    oils: OILS.twister, pads: PADS.twister, boxes: BOXES.twister, poles: POLES.twister
  },
  coaster: {
    name: 'Coaster', difficulty: 'Hard', segments: COASTER,
    oils: OILS.coaster, pads: PADS.coaster, boxes: BOXES.coaster
  },
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
