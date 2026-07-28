// Resolved waypoints for the seeded generated tracks (generated offline by
// scripts/gen-tracks.mjs — solver-placed elevation + difficulty-profile decoration and the
// chosen start anchor baked in; pure data, no renderer). GEN_FURNITURE carries their
// auto-placed oils/pads/boxes (scripts/track-gen.mjs placeFurniture), read via genFurn()
// below — every generated track uses it, the Backyard four included (they were re-baked
// through the decorated `mid` profile and gave up their hand-tuned furniture then). Only
// the Playroom Cup's segment-DSL tracks author furniture by hand, in OILS/PADS/BOXES.
import { GEN_TRACKS, GEN_FURNITURE } from './genTracks.js';

// Auto-placed furniture for a generated track — tolerant of a not-yet-baked id, so the
// registry can name a new track BEFORE gen-tracks.mjs runs (the bake pipeline itself
// imports this module; a hard read here would deadlock that workflow).
const genFurn = (id) => GEN_FURNITURE[id] || { oils: [], pads: [], boxes: [] };

// Track catalogue — DATA ONLY, no renderer. The single source of truth for "what
// tracks exist": each track is a display name, a default road `width`, and an ordered
// list of parametric SEGMENTS (the geometry). The native TrackBuilder integrates the
// segments into a drivable centerline; the renderer sweeps the procedural road over
// it. This file is codegen'd into the wasm by scripts/gen-track-defs-header.mjs, so
// an edit here is only live once that has run (tests/codegen-freshness.test.js).
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
//                                `roll` (probe it) or the stretch after the loop
//                                rides visibly rolled.
// opts (any segment): rise (Δelevation over the segment, eased), bank (peak roll°,
//   eased — corners only in practice), roll (heartline twist about the centerline,
//   eased over the segment and CUMULATIVE downstream — small rolls trim the geometric
//   holonomy of climbing/tilted elements like the spiral and the drift loops; a full
//   roll: 360 corkscrews the road around a straight line and self-cancels, e.g. a
//   barrel roll), width (number or [start,end] taper, overriding the track default),
//   pillars (stand support columns from the grass up to a raised deck — flag the
//   ramp + bridge run of an overpass).
//
// ── HOW A TRACK CLOSES ───────────────────────────────────────────────────────
// The builder walks the segments and auto-closes the loop (gap < 0.5): headings must
// net a whole number of turns and the plan must return to the origin — the shipped
// stunt tracks below get their leg lengths from scripts/compose-stunt.mjs's closure
// solver rather than by hand. Rise…fall pairs are net-flat, so elevation closes by
// construction.
//
// This module holds the tracks that SHIP — everything reachable from CUPS, i.e. the
// phone picker. Dev surfaces (the Gym) live in devTracks.js.

const RL = 4.185;     // sweeping (large) corner radius

const straight = (length, opts = {}) => ({ kind: 'straight', length, ...opts });
const arc = (radius, angle, opts = {}) => ({ kind: 'arc', radius, angle, ...opts });
const loop = (radius, opts = {}) => ({ kind: 'loop', radius, ...opts });

// ---- Helix (Expert): the double-spiral skyway. Climb a 450° spiral to a long
// pillared bridge riding the east side at height, then corkscrew back to earth through
// a SAME-hand descending spiral; the south leg home threads an S-pair of tilted toy
// loops. Same-hand spirals wind the lap to a net -1080° (3 full turns — the plan is
// still a simple rounded rectangle). Composed by
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

// ---- BACKYARD CUP — four SEEDED multi-crossing tracks. Each is a procedurally-generated
// closed plan whose self-crossings are lifted into overpasses by a solved elevation profile
// (scripts/gen-tracks.mjs); the resolved waypoints are baked into GEN_TRACKS and used directly
// in the registry below. To reroll or change the seed picks, edit + run that script. ----

// Oil slicks per track — FIXED hazards. Placed by `u` (fraction of the lap, 0 =
// start/finish) and `lat` (lateral offset in world units; 0 = centreline). `radius`
// and `cones` optional. Off-centre so a careful line can thread past; tune by driving.
//
// Only the Playroom Cup's segment-DSL tracks are listed in these three tables: every
// generated cup (Beach/Snow/Backyard/Canyon) carries auto-placed furniture in
// GEN_FURNITURE instead, resolved via genFurn() in the registry below.
const OILS = {
  // Auto-placed (scripts/track-gen.mjs placeFurniture on the composed geometry) — gentle
  // open ground, clear of decks, spirals and the loops. The three tracks carrying a
  // `startU` were re-placed against their moved line (u is measured from it).
  helix:      [ { u: 0.198, lat: 0.7 }, { u: 0.818, lat: -0.7 } ],
  skyline:    [ { u: 0.834, lat: 0.7 }, { u: 0.245, lat: -0.7 } ],
  gauntlet:   [ { u: 0.29, lat: 0.7 }, { u: 0.795, lat: -0.7 } ],
  skysnake:   [ { u: 0.266, lat: 0.7 }, { u: 0.827, lat: -0.7 } ]
};

// Boost pads — drive-over speed strips, position-scaled for catch-up. Place on STRAIGHTS
// (XZ curvature ≈ 0, where the boost isn't wasted mid-corner), centred (lat 0) on the
// racing line. `u` = fraction of lap. A pure climb/descent counts as straight.
const PADS = {
  // Auto-placed on the cleanest straights. No pad is authored at a loop: every looping
  // auto-places a full-width launch strip at its own mouth (see main.js /
  // TrackBuilder.loopStarts), so the pack is always fired INTO each ring on boost.
  helix:      [ { u: 0.063, lat: 0.0 }, { u: 0.443, lat: 0.0 } ],
  skyline:    [ { u: 0.103, lat: 0.0 }, { u: 0.575, lat: 0.0 } ],
  gauntlet:   [ { u: 0.105, lat: 0.0 }, { u: 0.683, lat: 0.0 } ],
  skysnake:   [ { u: 0.066, lat: 0.0 }, { u: 0.608, lat: 0.0 } ]
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
  helix:      boxRows(0.086, 0.705),  // auto-placed: the grid run, then the south leg past the loops
  skyline:    boxRows(0.131, 0.695),  // auto-placed: the north leg, then the flat past the toy loop
  gauntlet:   boxRows(0.128, 0.559),  // auto-placed: the east leg, then the exit run past the plunge
  skysnake:   boxRows(0.096, 0.692)   // auto-placed: the grid straight, then the flat past the toy loop
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
  // `startU` moves the start/finish line a fraction of a lap along the ring (see
  // TrackBuilder.finalizeTrack). The GRID sits BEHIND the line — the cars spawn at
  // totalS -2.5…-6.5 and lap 1 opens by driving across it — and a segment walk's opening
  // straight runs FORWARD from the origin, so without this the grid backs into whatever
  // corner closes the lap. Each value here nudges the line ~8.5 world units up its own
  // opening straight, which puts the whole grid on it. The generated tracks solve the same
  // problem at bake time instead (scripts/track-gen.mjs chooseAnchor). Gauntlet needs none:
  // its walk already opens with enough straight behind the line.
  skysnake: {
    name: 'Skysnake', difficulty: 'Hard', segments: SKYSNAKE, startU: 0.026,
    oils: OILS.skysnake, pads: PADS.skysnake, boxes: BOXES.skysnake
  },
  gauntlet: {
    name: 'Gauntlet', difficulty: 'Expert', segments: GAUNTLET,
    oils: OILS.gauntlet, pads: PADS.gauntlet, boxes: BOXES.gauntlet
  },
  helix: {
    name: 'Helix', difficulty: 'Expert', segments: HELIX, startU: 0.020,
    oils: OILS.helix, pads: PADS.helix, boxes: BOXES.helix
  },
  skyline: {
    name: 'Skyline', difficulty: 'Expert', segments: SKYLINE, startU: 0.024,
    oils: OILS.skyline, pads: PADS.skyline, boxes: BOXES.skyline
  }
};

// Cups — curated, ordered sets of tracks (a "grand prix" grouping). Each cup lists its
// track ids easiest→hardest; the controller picker renders one labelled section per cup.
// CUPS is the SOURCE OF TRUTH for track ordering — TRACK_ORDER / TRACK_LIST below are
// derived by flattening it, so a track appears in the picker iff it's listed in a cup.
// New track: add the descriptor to TRACKS above, then drop its id into a cup here.
// Cup order IS the difficulty ladder (tendencies 1→2→3→3→4); each cup's biome is
// mapped in native/libttp-runtime/ttp/theme.cc CUP_BIOME (Backyard keeps the
// canonical grass look), reached from here through the `cup` field
// gen-track-defs-header.mjs carries into the C++ catalogue.
export const CUPS = [
  { id: 'beach',    name: 'Beach Cup',    tracks: ['tidepool', 'cove', 'driftwood', 'riptide'] }, // easy: flowing sweepers + hops (beach biome)
  { id: 'snow',     name: 'Snow Cup',     tracks: ['powder', 'flurry', 'glacier', 'avalanche'] }, // medium: gentle-mid crossings + climb (snow biome)
  { id: 'backyard', name: 'Backyard Cup', tracks: ['ribbon', 'pretzel', 'tangle', 'cloverleaf'] }, // middle: seeded multi-crossing circuits (grass biome)
  { id: 'canyon',   name: 'Canyon Cup',   tracks: ['wash', 'gulch', 'crag', 'sidewinder'] },   // hard: hairpins + stacked crossings (canyon biome)
  // crazy: stunts (playroom biome — orange plastic track).
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
const TRACK_ORDER = CUPS.flatMap((c) => c.tracks);

// Flat list — {id, name, difficulty, cup, cupName, cupDifficulty, segments, waypoints,
// startU, oils, pads, boxes, poles} in cup order — used by main.js, the track picker, and
// the gallery. `difficulty` is per-track data (orders the cup + feeds the tendency); the
// picker renders only the cup tendency. The display builds each track + computes its
// schematic SVG, so no per-track art.
//
// This list is what main.js actually BUILDS from (buildEntry → buildTrack), so any
// descriptor field the builder reads must be copied across or it is silently ignored in
// the game while the unit tests — which build from TRACKS directly — still pass. `startU`
// is one of those; `width` is deliberately absent because no descriptor sets it (the
// shipped width games are per-SEGMENT).
export const TRACK_LIST = TRACK_ORDER.map((id) => ({
  id, name: TRACKS[id].name, difficulty: TRACKS[id].difficulty,
  cup: CUP_OF[id].cup, cupName: CUP_OF[id].cupName, cupDifficulty: CUP_OF[id].cupDifficulty,
  segments: TRACKS[id].segments, waypoints: TRACKS[id].waypoints, startU: TRACKS[id].startU,
  oils: TRACKS[id].oils, pads: TRACKS[id].pads, boxes: TRACKS[id].boxes, poles: TRACKS[id].poles
}));
