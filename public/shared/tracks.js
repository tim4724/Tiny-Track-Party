// Resolved waypoints for the seeded generated tracks (generated offline by
// scripts/gen-tracks.mjs — solved crossing elevation + difficulty-profile decoration and the
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
// The road strip between asphalt and kerb (`sand`), plan units per side at full
// width, on every track but Skyline. It lies on all road on the land; where it
// narrows (a corner's inside, two strands side by side, the ease onto pillars)
// is the builder's rule (trackbuilder.cc sandWidths), not authored. `sandOff`
// is left for road the builder cannot tell is off the land (a causeway on piles):
// its [from, to] spans are fractions of the layout as built, before `startU`
// moves the line and before the strips move the centre line, so not the lap's
// u that furniture and set pieces are placed on.
const STRIP = 1.1;

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
// opts (any segment): rise (Δelevation over the segment, eased; a straight's
//   `grade: [in, out]` gives the slopes it starts and ends at instead), bank (peak roll°,
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
// stunt's `roll` its probe-measured holonomy trim, swept with no tilt allowance so
// every floor leg and the skyway ride level and the spirals keep their own 10° bank
// (compose-stunt's 12° allowance had left the legs leaning 13-15°).
export const HELIX = [
  straight(28),                                                      // grid, north-bound
  arc(RL, -90),                                                      // NE corner (unbanked — the spirals carry the cup's lean)
  straight(26),                                                      // top leg, east-bound
  arc(RL, -450, { rise: 2.6, bank: 10, pillars: true, roll: 35.3 }), // SPIRAL UP
  straight(28, { pillars: true }),                                   // THE SKYWAY, south-bound at height
  arc(RL, -450, { rise: -2.6, bank: 10, pillars: true, roll: -35.4 }),// SPIRAL DOWN (same hand)
  straight(8),                                                       // south leg — boost — straight into
  loop(2.2, { drift: 3, roll: 74.7 }),                               // TOY LOOP L
  straight(10),                                                      // beat (rings stay 20 world apart)
  loop(2.2, { drift: -3, roll: -75.7 }),                             // TOY LOOP R (the S-pair)
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

// ---- Skysnake (Hard): snakes and ladders, raced across the board. Up two LADDERS
// (straight climbs, each cresting above its deck so a car raced flat out hops off
// the top: a hill, launched by its crest as the other cups' are) to the top deck
// at 5.2 world, the S-S weave in the sky, round the top corner and down the SNAKE (one long dive) to the
// board, then home past a toy loop. Composed by scripts/compose-stunt.mjs (solved
// grid and first legs + the loop's probe-measured roll trim).
// A ladder: the climb runs straight on into its crest, with no flat before it
// (a hump after a flat stood across the view as a wall, and swung the chase
// camera 40 degrees), rounds over it tightly enough to throw a car raced flat
// out (game.cc's crest lift), and comes down a long shallow slope to the deck,
// 1.3 above where it began.
const LADDER_UP = 0.24, LADDER_DOWN = 0.14, LADDER_CREST = 0.75, LADDER_LAND = 5;
const LADDER = [
  straight(10, { rise: 1.3 + (LADDER_DOWN * LADDER_LAND - (LADDER_UP - LADDER_DOWN) * LADDER_CREST) / 2, grade: [0, LADDER_UP], pillars: true }),
  straight(LADDER_CREST, { rise: (LADDER_UP - LADDER_DOWN) * LADDER_CREST / 2, grade: [LADDER_UP, -LADDER_DOWN], pillars: true }),
  straight(LADDER_LAND, { rise: -LADDER_DOWN * LADDER_LAND / 2, grade: [-LADDER_DOWN, 0], pillars: true })
];
export const SKYSNAKE = [
  straight(35.837),                                                  // grid straight (closure-solved)
  arc(RL, -90),                                                      // east
  straight(12),                                                      // (closure-solved)
  ...LADDER,                                                         // LADDER 1 → 2.6 world
  straight(2.25, { pillars: true }),                                 // the mid deck
  arc(RL, -90, { pillars: true }),                                   // south
  straight(6, { pillars: true }),
  ...LADDER,                                                         // LADDER 2 → 5.2 world
  straight(2.25, { pillars: true }),                                 // the top deck
  arc(RL, 45, { pillars: true }), arc(RL, -45, { pillars: true }),   // THE SKY WEAVE @5.2 world
  arc(RL, -45, { pillars: true }), arc(RL, 45, { pillars: true }),
  straight(3, { pillars: true }),
  arc(RL, -90, { pillars: true }),                                   // west, on the top deck
  straight(3, { pillars: true }),
  straight(13, { rise: -2.6, pillars: true }),                       // THE SNAKE, down to the board
  straight(5),                                                       // boost — straight into
  loop(2.2, { drift: -3, roll: -84 }),                               // TOY LOOP
  straight(9),
  arc(RL, -90)                                                       // home
];

// ---- BACKYARD CUP — four SEEDED multi-crossing tracks. Each is a procedurally-generated
// closed plan whose self-crossings are lifted into overpasses, each on a short ramp of its
// own with the rest of the lap on the ground (scripts/track-gen.mjs, gen-tracks.mjs); the resolved waypoints are baked into GEN_TRACKS and used directly
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
  skysnake:   [ { u: 0.222, lat: 0.7 }, { u: 0.915, lat: -0.7 } ]
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
  skysnake:   [ { u: 0.065, lat: 0.0 }, { u: 0.446, lat: 0.0 } ]
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
  skysnake:   boxRows(0.093, 0.632)   // the grid straight (auto-placed), then the top deck past the weave
};

// Set pieces — `set`, per track: the big landmarks that make one circuit look
// unlike the rest of its cup (the biome's scatter is the same on all four). Each
// names a model built in Blender by scripts/gen-set-prototypes.mjs and places it by `u`
// (fraction of the lap) and `lat` (world units off the centreline; + is the
// track's RIGHT), turned `yaw` degrees from the track's heading there; `y`
// lifts or sinks it, `scale` sizes it. Visual only: the sim never sees one, so a
// piece the road passes through has to leave the deck and its berm clear.
//
// Landforms — `land`, per track: the shapes the ground itself carries (the
// renderer sums them into its terrain; visual only, like `set`). Each is
// anchored like a set piece (`u`, `lat`, `yaw`) and shaped in that frame, +Z
// along the heading, +X the track's LEFT, in world units:
//   ridge  a capsule `len` long along +Z (a round hill at len 0): radius `r`
//          (`r1` at the +Z end), height `h` (`h1`), a flat crest `top` of r
//          (a mesa); a ridge falling to a wide low end is a debris fan
//   ring   a bank round a bowl: crest radius `r`, half-width `w`, height `h`
//   plain  a capsule like a ridge, `r` wide with a `w` fade, where the ground
//          is left UNRAISED: a creek bed or valley floor, the low line the
//          raised land stands over. Nothing goes below the plain itself. With
//          `h`, a channel: a bank that tall along both sides, its crest where
//          the fade ends; reaches chained round a bend keep one floor (no
//          bank crosses another reach's floor). The floor wears the biome's
//          creek-bed tint (the renderer's groundTint).
//   pond   open water on the plain: a capsule like a plain (`len`, `r` the
//          water's reach, `w` the land's fade back), its floor kept flat a
//          little past the water and the sheet drawn on it with its own
//          outline and a pebble shore (its `tint` is the water's, not the
//          land's). Only under a deck on pillars well over
//          the plain, never against a low slab; the dressing keeps off it as
//          off the sea
//   paint  a capsule like a plain that shapes nothing: it only colours the
//          ground (a piste down a mountain)
//   shore  (the beach) brings the sea's waterline in through the anchor, held
//          for `len` of shore and faded back out over `r`; never nearer than
//          a few units past the road, unless `w` lets it that far inside the
//          road's reach (the road then runs over the water). It only reaches
//          road that is the island's outermost on its bearing from the origin
//          (native/renderer/CLAUDE.md, the beach).
//   clear  a capsule like a plain that shapes nothing: no seeded tree, prop,
//          clutter or landmark stands within `r` of its spine (an avenue's
//          verge, kept to its own trees)
//   street `len` of road centred on `u` running through a village: its kerb
//          a low kerbstone instead of the biome's racing kerb, so the
//          pavement and front gardens beside it show from the seat. No lat,
//          r or yaw: it is the road's, both sides
//   snake  `len` of road centred on `u` that is the board's snake made a
//          slide (Skysnake): its deck the toy snake's green and yellow bands
//          from kerb to kerb, its kerbs and slab side its green flanks. No
//          lat, r or yaw, like a street
//   ladder the same for one of the board's ladders: its kerbs the wooden
//          rails, its rungs across the deck
//   shed   `len` of road centred on `u` under a roof (an avalanche gallery):
//          no snow lies there, so the kerb is a concrete kerbstone and
//          paving out to the gallery's columns and back wall instead of the
//          snow cup's plough bank. No lat, r or yaw, like a street
// Any but a mound, a clear, a street, a snake, a ladder or a shed may carry a `tint`, 0xRRGGBB, a
// multiplier over the ground's colour where the form lies (fading with its
// flank, or a plain's or paint's `w`); the ground's grid is 9 u, so a tint is
// a broad wash.
// A ridge or ring clears the road's corridor (no height within a few units
// of it, all of it some 16 u out) unless it carries `near`: then its flank
// stands at full height from that many units past the kerb, a massif's face
// rising off the verge (native/renderer/CLAUDE.md, a big landform). It
// reaches that height over 3 u, so a form whose flank is already high there
// steps up in a crease that reads as a wall or a blade from the road; a
// foothill meant to rise off the verge stands far enough out that its flank
// is low where that ramp ends (a fifth of its height or less). It keeps no
// flat verge in front of a tall flank: the ground's 9 u chords climb from
// the kerb to it, so a piece standing there stands on the slope. A set
// piece's mound withholds every other form under it, but joins a `near` one,
// the higher of the two: run a mountainside on round a piece's slope, clear
// of what stands on it.
// A BEACH RISE is a ridge carrying both `near` and `w`: the sand's own swell
// under a piece on the sea side of a beach road. Past a `shore` the beach is
// the plain and the road stands most of a unit over it, so what stands there
// is under the kerb from the seat; a rise stands from the damp sand's inner
// edge, or from `w` units inside the waterline where that is further in
// (the damp sand and the sea are flat sheets: no land stands in them), and
// fills the sand up to it, adding nothing where raised ground already stands,
// low and broad with a flat `top`, so the piece on it stands at the road's
// height. Beside a hop it may be as high as the hop (`h` to `h1` along it
// follows the climb): the road then lies in the sand as low road does.
// Rises ADD where they overlap, so one stretch is one rise. Only the road's
// verge band draws it (the 9 u grid laid it as
// blocks), so it reaches as far from the kerb as the band does and no
// further. The piece must level nothing, or its clearing cuts down to the
// rise's foot by the kerb. No rise is flat, so what stands on one LIES ON IT
// (set_prototypes.py lie_on_land(): every part drapes, and the row's `y`
// only places what cannot, a chimney's smoke); a piece that stands rigid at
// a typed `y` hangs over the sand's fall. on_a_rise() is for what stands in
// the sea or on the plain and only has to level nothing.
// `lite: false` keeps a form off the lite tier (the Android TV box), like a set
// piece's: land behind other land that the box's frame cannot carry.
// Ground never rises through a deck (the renderer caps it under every road),
// but a form's flank beside a bend still hides the road ahead: keep them to
// the outsides of bends and to the open side of the lap.
//
// SET_GROUND, per MODEL: the ground a set piece was modelled standing on,
// in its own frame. The renderer lays it wherever the piece is placed (and
// levels no clearing under it), and scripts/gen-set-prototypes.mjs hands the
// same numbers to the Blender builder, so the model's towers and pines stand
// on the terrain they were built on. Two extra kinds here, the ground the
// builder builds on (set_ground()), which take the land under them:
//   mound  scripts/blender/set_prototypes.py's mound(): summit at (`x`, `z`),
//          `h` tall, reaching `r` toward +X, `r1` toward -X and `rz` along Z,
//          its flank cos(t·π/2)^`shape`
//   fan    a ridge's shape (`len`, `r`/`r1`, `h`/`h1`, `top`) lying ON the
//          mounds, its rise added to theirs: a debris fan spilling off a
//          slope to a wide low end
// A form's `yaw` turns it, and its (`x`, `z`), in the piece's frame.
export const SET_GROUND = {
  // Powder's ski mountain, its summit behind the lift (in the lift's frame),
  // the valley floor at its foot toward the road where the valley station,
  // the resort's chalets and the slalom's finish stand (a plain, so the
  // ground raised toward the deck does not bury them; the mountain's foot
  // stops a grid cell short of them, where the 9 u grid's chords over the
  // foot would), and the blue run washed down it from the top station to the
  // slalom and on to the finish on the flat (faint: a groomed run is white,
  // and a deeper blue read as a stain); Avalanche's slide face, the debris
  // fan over the chute's end (stopping a grid cell short of the road, whose
  // cap would leave what lies on it floating), and the slopes its pines and
  // warning signs stand under.
  'set-ski-lift': [
    { kind: 'mound', x: -54, h: 40.5, r: 62, r1: 60.75, rz: 101.25, shape: 1.15 },
    { kind: 'plain', x: 17, len: 66, r: 4, w: 5 },
    { kind: 'paint', yaw: 105.07, x: -4.41, z: -27.75, len: 36.35, r: 5.5, w: 8, tint: 0xb1c7ec },
    { kind: 'paint', yaw: 133.20, x: 0.62, z: 4.63, len: 30.31, r: 5.5, w: 8, tint: 0xb1c7ec }
  ],
  'set-avalanche-slide': [
    { kind: 'mound', x: -58, h: 40.6, r: 66.7, r1: 58, rz: 87, shape: 1.6 },
    { kind: 'fan', yaw: 90, z: -17, len: 14, r: 11, r1: 12, h: 1.4, h1: 1.1, top: 0.35, tint: 0xc8cfdf }
  ],
  // Flurry's lake: the ice lies on the plain, unraised, beside the run down
  // off the bridge, and the bank of snow round its shore is the piece's own
  // (set_prototypes.py frozen_lake), standing up from the plain.
  'set-frozen-lake': [
    { kind: 'plain', z: -1.5, len: 7, r: 15.5, w: 4, tint: 0xdcecf8 }
  ],
  // Glacier's toboggan hill: the penguins' slide comes down its long face
  // toward the road (+X) to the water hole on the flat at its foot; broad
  // enough that the ground's 9 u grid draws it as a hill, not a cone.
  'set-penguin-chute': [{ kind: 'mound', x: -19, h: 7, r: 21, r1: 17, rz: 18, shape: 1.5 }],
  // Glacier's rookery: the snow slope the colony stands up, its face to the
  // road (+X), so the crowd shows row over row instead of as a line along the
  // kerb; broad, like the ski school's nursery slope, so the grid draws a hill.
  'set-penguin-group': [{ kind: 'mound', x: -8, h: 3.8, r: 12, r1: 9, rz: 11, shape: 1.2 }],
  // Glacier's expedition camp on a snow bank of its own, flat on top like the
  // den camp's and set back from the road: a camp on the flat hid its tents
  // behind the kerb; on the bank they show over it. The camp drapes, so it lies on the slope drawn:
  // the ground's 9 u grid draws a bank this size as a dome, not a terrace.
  'set-expedition-camp': [{ kind: 'fan', x: -2, z: -0.8, len: 7, r: 10, h: 2.6, top: 0.6 }],
  // Powder's ski school: the nursery slope behind it (-X), a real run down
  // its face to the road (the school's slalom drops some nine units over twenty from the
  // carpet's head to its foot), its foot reaching under the school's hut and
  // arch so the whole school stands up on it over the kerb of the road beside it.
  'set-ski-school': [{ kind: 'mound', x: -19.5, h: 9, r: 25.5, r1: 11, rz: 16, shape: 1.3 }],
  'set-avalanche-slope': [{ kind: 'mound', x: -28, h: 22.4, r: 26.6, r1: 25.2, rz: 36.4, shape: 1.6 }],
  // Cloverleaf's bandstand on the crown of its own knoll: a broad round top
  // the floor lies flush in, steeper to the road (+X, clear of the raised
  // road's stilts), falling away behind.
  'set-bandstand': [{ kind: 'mound', h: 3.2, r: 8, r1: 15, rz: 14, shape: 0.6 }],
  // Tangle's brook lies in its own bed, a reach at a time: the low line the
  // valley's sides and the land raised toward the road stand over, so its
  // water lies level across: each bed is its reach's chord.
  'set-brook-a': [{ kind: 'plain', x: -1.38, z: 0.14, len: 16.4, r: 1.6, w: 6 }],
  'set-brook-b': [{ kind: 'plain', x: -0.43, z: 0.08, len: 23.1, r: 1.6, w: 6 }],
  'set-brook-c': [{ kind: 'plain', x: 0.59, z: -0.09, len: 22.8, r: 1.6, w: 6 }],
  'set-brook-d': [{ kind: 'plain', x: 0.98, z: -0.29, len: 20.9, r: 1.6, w: 6 }],
  'set-brook-e': [{ kind: 'plain', x: 1.81, z: -0.32, len: 22, r: 1.6, w: 6 }],
  'set-brook-f': [{ kind: 'plain', x: 4.61, z: -0.61, len: 19.7, r: 1.6, w: 6 }],
  // (the last reach turns in to the pond: its bed's chord is turned with
  // it, and a round floor at the mouth keeps the lawn's 9 u chords from
  // climbing over the corner of the pond the brook comes in at)
  'set-brook-g': [
    { kind: 'plain', yaw: 7.96, x: 2.83, z: -2.83, len: 16.9, r: 1.6, w: 6 },
    { kind: 'plain', x: 3.58, z: 5.15, len: 0, r: 6.5, w: 5 }
  ],
  // Pretzel's den camp on a bank of its own, the same shape.
  // Tidepool's knoll at the lap's waist, its rock standing on its road side.
  'set-tidepool-knoll': [{ kind: 'mound', x: -3, h: 4.5, r: 10, r1: 12, rz: 13, shape: 1.3 }],
  // Wash's creek, the stretch by the road: the bed is the low line the raised
  // land stands over between its cut banks, the wash's own land carrying on
  // from both ends (turned 90 so the spine runs along the creek's X).
  'set-dry-creek': [{ kind: 'plain', yaw: 90, len: 76, r: 6, w: 8, h: 1.5 }],
  'set-wash-bed': [{ kind: 'plain', len: 38, r: 7, w: 8, h: 1.5 }],
  // ...an arm's last reach: the channel stops at the reach's middle and a
  // narrow low mouth lets the bed out through its bank onto the plain
  'set-wash-bed-end': [
    { kind: 'plain', z: -9, len: 20, r: 7, w: 8, h: 1.5 },
    { kind: 'plain', z: 8, len: 12, r: 3, w: 4, h: 0.5 }
  ],
  // ...and a reach the road runs down: the floor from bank to bank
  'set-wash-road-reach': [{ kind: 'plain', len: 10, r: 9, w: 6, h: 1.4 }],
  // Gulch's mine: the rock spur rising behind the adit's rock face (-X; its
  // foot just behind the face, so the face stands whole on the yard instead
  // of poking out of the slope in shards) and the yard levelled in front of
  // it, toward the road.
  'set-mine-portal': [
    { kind: 'plain', yaw: 90, len: 8, r: 4, w: 5 },
    { kind: 'ridge', x: -13, len: 30, r: 8, h: 9, top: 0.3 }
  ],
  // Its ore line (placed on the portal's own anchor), from the yard along
  // the start straight a few units past its kerb, so its train paces the
  // racers, and round the east bend to the headframe: the level bed it
  // lies in, one plain per chord of its route, so it never steps where the
  // land rolls; its floor wider than a cell of the ground's grid (9 u), which
  // would otherwise draw its chords over the rails and leave the line in
  // pieces with the train riding through the hill. Round the east bend it
  // keeps outside the grass berm under the raised road: a berm is no ground
  // a drape lies on, so rails through it lay under it with the train. The
  // builder lays the rails on a smooth curve through the chords' ends
  // (set_prototypes.py ore_line). A form's x/z is in its own turned frame
  // (TtpRenderer::setupTerrain).
  'set-ore-line': [
    { kind: 'plain', yaw: 71.57, x: 0.16, z: 1.9, len: 2.85, r: 6, w: 5 },
    { kind: 'plain', yaw: 47.64, x: 1.49, z: 5.27, len: 4.6, r: 6, w: 5 },
    { kind: 'plain', yaw: 25.58, x: 4.23, z: 10.76, len: 8.6, r: 6, w: 5 },
    { kind: 'plain', yaw: -4.48, x: 11.2, z: 15.14, len: 8.46, r: 6, w: 5 },
    { kind: 'plain', yaw: -12.12, x: 13.68, z: 21.66, len: 7.89, r: 6, w: 5 },
    { kind: 'plain', yaw: -21.63, x: 17.72, z: 27.05, len: 8.12, r: 6, w: 5 },
    { kind: 'plain', yaw: -22.76, x: 18.33, z: 35.51, len: 9.51, r: 6, w: 5 },
    { kind: 'plain', yaw: -21.65, x: 17.55, z: 45.36, len: 9.50, r: 6, w: 5 },
    { kind: 'plain', yaw: 2.95, x: -4.90, z: 57.90, len: 10.06, r: 6, w: 5 },
    { kind: 'plain', yaw: 25.78, x: -28.94, z: 60.71, len: 9.22, r: 6, w: 5 },
    { kind: 'plain', yaw: 46.27, x: -49.98, z: 54.25, len: 6.39, r: 6, w: 5 },
    { kind: 'plain', yaw: 68.67, x: -68.09, z: 36.56, len: 5.00, r: 6, w: 5 },
    { kind: 'plain', yaw: 72.91, x: -70.79, z: 37.99, len: 8.08, r: 6, w: 5 }
  ]
};

// The height a model's SET_GROUND mounds and fans give at (x, z) in its own
// frame, over the plain: the highest mound and the fans lying on it, as the
// renderer composes them (TtpRenderer::landforms) and the Blender builder builds on them
// (set_prototypes.py set_ground(), which cannot import this).
export function setGroundY(model, x, z) {
  let mounds = 0, fans = 0;
  // (a lite build stands on its model's ground)
  for (const f of SET_GROUND[model] || SET_GROUND[model.replace(/-lite$/, '')] || []) {
    if (f.kind !== 'mound' && f.kind !== 'fan') continue;
    const a = (f.yaw || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const lx = x * c - z * s - (f.x || 0), lz = x * s + z * c - (f.z || 0);
    if (f.kind === 'mound') {
      const t = Math.hypot(lx / (lx > 0 ? f.r : f.r1), lz / f.rz);
      if (t < 1) mounds = Math.max(mounds, f.h * Math.cos(t * Math.PI / 2) ** (f.shape ?? 1));
      continue;
    }
    // a fan is debris lying on the mounds: its rise adds to theirs
    const half = (f.len || 0) / 2, cz = Math.min(half, Math.max(-half, lz));
    const at = f.len ? (cz + half) / f.len : 0;
    const t = Math.hypot(lx, lz - cz) / (f.r + ((f.r1 ?? f.r) - f.r) * at);
    if (t >= 1) continue;
    const top = f.top || 0, k = t <= top ? 0 : Math.min(1, (t - top) / (1 - top));
    fans += (f.h + ((f.h1 ?? f.h) - f.h) * at) * (1 - k * k * (3 - 2 * k));
  }
  return mounds + fans;
}
//
// Registry of named, previewable tracks. Selected in the display via ?track=<key>.
export const TRACKS = {
  // Beach Cup — SEEDED easy circuits (scan-seeds `easy` profile: sweeping corners,
  // rolling hills + hops, width play, no crossings; auto-placed furniture).
  tidepool: {
    name: 'Tidepool', sand: STRIP, waypoints: GEN_TRACKS.tidepool,
    oils: genFurn('tidepool').oils, pads: genFurn('tidepool').pads, boxes: genFurn('tidepool').boxes,
    // Low tide: the reef the sea left bare is the land the lap drives
    // beside. On the two outer bends the sea comes in to a few strides past
    // the kerb (the `shore`s) and the reef stands between them, rounded,
    // weathered rock a car's height and more from the kerb out into the surf
    // (out at the waterline, and low, it lay under the road's own kerb and
    // read as grey specks): the east bend's with seals hauled out a stride
    // from the road, the west bend's taller, a headland with its sea arch and
    // a stack, gulls over them. The big rock pool lies beside the low west
    // run that points at it, the rock-poolers' nets and buckets left at its
    // edge, the crab fishers' landing just before it, and two smaller pools
    // lie in the reef flats beside the east run and the bend into the waist,
    // the sand the tide has just left dark round them. Where the east run
    // points, Seal Rock stands at the water's edge, the reef's own rock,
    // seals on its low backs. Inland, grassy downs fill
    // both lobes of the lap, their flanks to the kerb, and at the lap's waist
    // a knoll with the same rock breaking out of it; the rock-poolers' vans
    // are parked along their gravel lane by the start straight.
    set: [
      { model: 'set-tidepool-knoll', u: 0.5007, lat: 13 },
      { model: 'set-rock-pool', u: 0.67613, lat: 13.5, yaw: 4 },
      { model: 'set-seal-rock', u: 0.22554, lat: 21 },
      // the smaller pools (the west bend has no room for one: the sea comes
      // in to a few strides off its kerb)
      { model: 'set-reef-pool-a', u: 0.18544, lat: 12.5 },
      { model: 'set-reef-pool-b', u: 0.45559, lat: 11.999, yaw: 30 },
      // the reef in three forms on the outsides of the bends, where the
      // camera swings to them: the seals' shelf round the east bend, the
      // headland and its sea arch where the west run points, the stacks at
      // the west bend's end (each built along its bend, placed on the road)
      { model: 'set-reef-shelf', u: 0.32035, lat: 0, yaw: 2.61 },
      // ...and its ribs running down the beach along the top run after it,
      // the kelp the tide left between them
      { model: 'set-tide-ledges', u: 0.39545, lat: 9.999 },
      // ...and again down the beach beside the east run, which lay bare
      { model: 'set-tide-ledges', u: 0.12529, lat: 10, yaw: 6 },
      { model: 'set-tidepool-headland', u: 0.72124, lat: 0 },
      { model: 'set-reef-stacks', u: 0.83151, lat: 0, yaw: -1.44 },
      { model: 'set-lifeboat-station', u: 0.89975, lat: 10, y: 1.8, scale: 1.3 },
      { model: 'set-tidepool-cottages', u: 0.58591, lat: -8.2, yaw: 180 },
      { model: 'set-crab-pots', u: 0.64105, lat: 9.6, yaw: 10, y: 1.13 },
      { model: 'set-rock-poolers-park', u: 0.96491, lat: 9.5, y: 0.47 },
      // palms on the downs' near flanks below the crests, placed by hand:
      // the `clear`s that keep seeded crates off the hilltops keep its
      // seeded palms off too
      { model: 'set-palm-stand', u: 0.15035, lat: -9, yaw: 180 },
      { model: 'set-palm-stand', u: 0.42051, lat: -8.999, yaw: -180 },
      // the west bend, which lay bare: the sea-kayak hire past
      // the headland and the shellfish shack inside the bend; and on the
      // hard past the start, where the verge stands at the road's height, a
      // fishing boat hauled out on her legs (the beach lies most of a unit
      // under the kerb, and at the hop's foot she stood out of sight)
      { model: 'set-kayak-rack', u: 0.77638, lat: 9.5 },
      { model: 'set-shellfish-shack', u: 0.79943, lat: -10, yaw: 180 },
      { model: 'set-grounded-trawler', u: 0.06031, lat: 10.495, yaw: 0.3 },
      // The rock arch over the road where the west run meets the
      // headland (built astride the road: lat 0), its hole along it. Out
      // where that run looks: the seals' skerry a few lengths off the beach;
      // the crab fishers' pot buoys along the reef's edge toward the stacks,
      // clear of the surf; and south of the skerry, outside the buoys, the
      // boat working her loop with the gulls behind her, half as big again
      // as built (outside the skerry she passed behind it from
      // the west run and the bend, a few pixels of her). And the last
      // tide's wrack along the beach where it lay bare and stands near the
      // road's height (a print: it claims no ground; on the low beach the
      // kerb hides it). One row past the knoll, on the sand between its
      // grass and the crab fishers' landing (a second beside it lay on the
      // knoll's green, which is painted to the kerb).
      { model: 'set-headland-arch', u: 0.70621, lat: 0 },
      { model: 'set-seal-skerry', u: 0.75633, lat: 17.6 },
      { model: 'set-fishing-boat', u: 0.79141, lat: 35.1, scale: 1.5 },
      { model: 'set-lobster-buoys', u: 0.79041, lat: 19.6 },
      { model: 'set-kelp-line', u: 0.61198, lat: 9.5, yaw: -180 },
      { model: 'set-kelp-line', u: 0.02506, lat: 11.5 },
      { model: 'set-kelp-line', u: 0.92482, lat: 12, yaw: -180 }
    ],
    land: [
      // the sea round Seal Rock and up to the reef on the east bend
      { kind: 'shore', u: 0.27, lat: 14.7, len: 100, r: 30 },
      { kind: 'shore', u: 0.79, lat: 9.7, len: 80, r: 30 },
      // the downs filling the east lobe, their flanks to the kerb of the east
      // run and the top run; a lower grassy rise in the west lobe
      { kind: 'ridge', u: 0.2506, lat: -32, len: 30, r: 22, h: 11, top: 0.2, tint: 0x6faa62 },
      { kind: 'ridge', u: 0.15035, lat: -12, len: 36, r: 9, h: 4, top: 0.2, near: 0.5 },
      { kind: 'ridge', u: 0.42051, lat: -11.999, len: 30, r: 9, h: 4, top: 0.2, near: 0.5 },
      { kind: 'ridge', u: 0.75132, lat: -27, r: 18, h: 7, top: 0.2, tint: 0x6faa62 },
      { kind: 'ridge', u: 0.6611, lat: -11, len: 30, r: 8, h: 3.5, top: 0.2, near: 0.5 },
      { kind: 'ridge', u: 0.89975, lat: -12, len: 30, r: 8, h: 3.5, top: 0.2, near: 0.5 },
      // the near flanks' grass painted down to the kerb: a ridge's own tint
      // fades out toward its foot, which left the downs a green cap on bare
      // sand
      { kind: 'paint', u: 0.15035, lat: -12, len: 36, r: 6, w: 4, tint: 0x6faa62 },
      { kind: 'paint', u: 0.42051, lat: -11.999, len: 30, r: 6, w: 4, tint: 0x6faa62 },
      { kind: 'paint', u: 0.6611, lat: -11, len: 30, r: 5.5, w: 4, tint: 0x6faa62 },
      { kind: 'paint', u: 0.89975, lat: -12, len: 30, r: 5.5, w: 4, tint: 0x6faa62 },
      // the knoll at the waist (the piece brings it: SET_GROUND), green to
      // the kerb; and the downs across the road
      { kind: 'paint', u: 0.5007, lat: 16, len: 14, r: 9, w: 5, tint: 0x6faa62 },
      { kind: 'clear', u: 0.5007, lat: 16, len: 14, r: 11 },
      { kind: 'ridge', u: 0.49469, lat: -19, yaw: -79, len: 12, r: 11, h: 4.5, top: 0.2, tint: 0x6faa62 },
      // the lifeboat station's swell of sand over the beach, at the height of
      // the hop the road comes over beside it (lower, only its roof and flag
      // showed over the crest's kerb)
      { kind: 'ridge', u: 0.89975, lat: 17, len: 10, r: 13, h: 1.2, top: 0.55, near: 0.4, w: 5 },
      // ...and the sea brought in to the foot of its slip
      { kind: 'shore', u: 0.9, lat: 22, len: 10, r: 14 },
      // the reef terrace the rock pool lies in, at the road's height, so
      // the seat looks onto its water (flat on the beach it was a sliver)
      { kind: 'ridge', u: 0.67613, lat: 20, len: 10, r: 13, h: 1.0, top: 0.55, near: 0.4, w: 5 },
      // the hard the crab fishers' landing stands on, at the hop's height
      { kind: 'ridge', u: 0.64105, lat: 17, len: 6, r: 13, h: 1.15, top: 0.55, near: 0.4, w: 5 },
      // the shellfish shack's sand, raised from the low ground between the
      // downs to stand a little over the road (down there the
      // kerb hid its foot and the seat saw a roof in a hollow)
      { kind: 'ridge', u: 0.79943, lat: -10.5, len: 6, r: 8, h: 1.4, top: 0.55, near: 0.5 },
      // the sand the tide has just left, darker and cooler round the reef
      { kind: 'paint', u: 0.31059, lat: 13.013, yaw: 0.09, len: 44, r: 5, w: 5, tint: 0xc4bcae },
      // the east run's pool on a terrace of its own, like the big one's
      { kind: 'ridge', u: 0.18544, lat: 19, len: 8, r: 12, h: 1.0, top: 0.55, near: 0.4, w: 5 },
      { kind: 'paint', u: 0.78139, lat: 13, len: 44, r: 5, w: 5, tint: 0xc4bcae },
      { kind: 'paint', u: 0.54682, lat: 15.5, len: 30, r: 7, w: 6, tint: 0xc4bcae },
      // nothing seeded on the camper lane (its gravel claims no footprint)
      { kind: 'clear', u: 0.97293, lat: 10, len: 26, r: 5 },
      // ...nor on the hard past the line, where a seeded palm stood at the
      // kerb between the grid and the trawler
      { kind: 'clear', u: 0.02, lat: 6.5, len: 10, r: 3 },
      // ...nor on the wrack past the knoll (a print, likewise: a seeded
      // boulder sat on the kelp)
      { kind: 'clear', u: 0.61198, lat: 9.5, len: 14, r: 2.5 },
      // nothing seeded on the downs: a crate on a crest read as a prop
      // dropped on a hilltop
      { kind: 'clear', u: 0.2506, lat: -32, len: 30, r: 22 },
      { kind: 'clear', u: 0.15035, lat: -12, len: 36, r: 9 },
      { kind: 'clear', u: 0.42051, lat: -11.999, len: 30, r: 9 },
      { kind: 'clear', u: 0.75132, lat: -27, r: 18 },
      { kind: 'clear', u: 0.6611, lat: -11, len: 30, r: 8 },
      { kind: 'clear', u: 0.89975, lat: -12, len: 30, r: 8 }
    ]
  },
  cove: {
    name: 'Cove', sand: STRIP, waypoints: GEN_TRACKS.cove,
    oils: genFurn('cove').oils, pads: genFurn('cove').pads, boxes: genFurn('cove').boxes,
    // The pirates' island, jungle down to its coves. Its
    // peak, green with jungle, fills the middle of the lap, its foothills
    // coming down to the kerb of the east straight and the start straight,
    // tall groves of palms on them, and the crew's cave cut into a spur of
    // the start straight's foothill, where the grid looks, its door turned to
    // the cars coming down the straight. Past the first
    // bend the crew's camp stands on the sand; down the east straight their
    // lookout watches the east beach from its tower, and the rope bridge
    // from the foothill to it spans the road, which the straight drives at
    // and under. The sea comes in to the road round the bay (its `shore`),
    // the wharf along its sand where the longboat sails out to the
    // ship riding at anchor and back; a little past her their stockade
    // stands on the sand, its jetty out into the bay where their prize
    // rides and her boat plies, and the road goes in through the
    // stockade's landward gate. The old wreck lies in
    // the surf of the west bay (the second `shore`), its ribs
    // out of the water, palms along the bay past it. The
    // east foothill falls away toward its north end and carries no grove,
    // so the ship shows over it down the straight.
    // The sea cannot come to the start: the curve is polar about the origin,
    // which lies on the start straight, so its outer side is never the
    // road's reach (native/renderer/CLAUDE.md).
    set: [
      // far enough out that her whole keel floats (at lat 17.5 her stern lay
      // over dry sand)
      { model: 'set-pirate-ship', u: 0.48465, lat: 24.021, yaw: 50, y: 0.15, scale: 1.4 },
      // the jungle down the island's west flank, along the S: one piece
      // astride the road (set_prototypes.py COVE_ROAD: re-sample it if this u
      // or the road moves)
      { model: 'set-jungle-canopy', u: 0.6522, lat: 0 },
      { model: 'set-jetty', u: 0.4415, lat: 11.512 },
      // the crew's camp on the sand a little past the ship, on its rise
      { model: 'set-pirate-stockade', u: 0.54184, lat: 12.011, y: 0.72 },
      { model: 'set-shipwreck-ribs', u: 0.8027, lat: 19, yaw: 20, y: -0.35, scale: 1.25 },
      { model: 'set-pirate-camp', u: 0.0903, lat: 10.001, yaw: -20, y: 0.9 },
      { model: 'set-skull-rock', u: 0.64217, lat: 20.014, yaw: 30 },
      // the cave levels nothing (its floor drapes) and the land's 9 u chords
      // rise under it, so it is lifted onto them
      { model: 'set-smugglers-cave', u: 0.97492, lat: -7.4, yaw: 180, y: 0.6 },
      { model: 'set-jungle-grove', u: 0.92977, lat: 9.5 },
      // the lookout and its rope bridge stand on the road's own line, over it
      { model: 'set-pirate-lookout', u: 0.27094, lat: 0, yaw: -0.06 },
      { model: 'set-jungle-grove', u: 0.2425, lat: 10.637, yaw: 11.38 },
      // the jungle down to the kerb on the island's side of the east
      // straight, the last of them up the foothill behind the posts the
      // rope bridge lands between, so the bridge comes out of the palms;
      // and on the start straight's foothill past the cave
      { model: 'set-jungle-grove', u: 0.18563, lat: -10.5, yaw: 180 },
      { model: 'set-jungle-grove', u: 0.27284, lat: -18.534, yaw: -175.93 },
      { model: 'set-jungle-grove', u: 0.03512, lat: -10.5, yaw: 180 },
      { model: 'set-jungle-grove', u: 0.74751, lat: -11.004, yaw: -179.99 },
      { model: 'set-jungle-grove', u: 0.77761, lat: 8.802, yaw: 0.01 },
      // palms on the beach outside the west bend, where the chase camera
      // looks through it (the bend's inside wraps round on the camera's left,
      // out of its frame)
      { model: 'set-palm-stand', u: 0.84105, lat: 7.789, yaw: 17.7 },
      // ...and a low green rise past the bend's exit, south of the start
      // straight's head, palms on it: what the camera looks at coming out
      { model: 'set-palm-stand', u: 0.88233, lat: 8.94, yaw: 15.34 },
      // where the beach lay bare at the road's own height (the
      // road to the bay runs two units over its sand, and what stood there
      // stood out of sight): the crew's dig for what they buried, beside
      // the start straight, their sailmaker past the camp, and on the west
      // shore their torchlit way from the stockade to Skull Rock, under
      // palms (a stone idol stood there alone on bare sand, which
      // read as a prop put down; the green under the trail is `land`'s)
      { model: 'set-treasure-dig', u: 0.04515, lat: 10.5 },
      { model: 'set-sail-yard', u: 0.12542, lat: 10.503 },
      { model: 'set-skull-trail', u: 0.58699, lat: 10.509 },
      // on the dune beside the climb to the bay (the east beach
      // lay three units under the kerb there): the crew's sloop hove down
      // to have her bottom tarred, and their guns over the anchorage
      { model: 'set-careened-sloop', u: 0.30409, lat: 12.523 },
      { model: 'set-bay-battery', u: 0.32815, lat: 11.522 },
      // The stockade's landward gate, astride the road at the
      // camp's near corner (set_prototypes.py stockade_gate: its wall meets
      // that corner, so it moves with the stockade's row)...
      { model: 'set-stockade-gate', u: 0.5301, lat: 0 },
      // ...the crew's prize at anchor off the stockade, 30 u out from it at
      // its own u, so her boat's way ends at the head of its jetty
      // (COVE_TENDER)...
      { model: 'set-prize-at-anchor', u: 0.54184, lat: 42.033 },
      // ...and the parrots that cross the road between the groves at u
      // 0.745 and 0.775 (COVE_PARROTS: their way is laid over those palms)
      { model: 'set-parrot-crossing', u: 0.76257, lat: 0 }
    ],
    // The peak and the headland are green with the scrub and jungle that
    // hold them (bare and peaked, a hill that size is a desert dune; the
    // beach's own hills say so, theme.cc). The tint is a wash over the
    // ground's 9 u grid, so only a crest that wide and a tint that deep
    // reads green from the road.
    land: [
      // the island's peak in the middle of the lap; its foothills come down
      // to the east straight and the start straight
      { kind: 'ridge', u: 0.271, lat: -32.055, yaw: -0.08, len: 40, r: 24, r1: 20, h: 15, h1: 9, top: 0.15, tint: 0x3fae52 },
      { kind: 'ridge', u: 0.22175, lat: -21.049, yaw: -1.04, len: 30, r: 18, r1: 10, h: 5.5, h1: 1, top: 0.2, near: 4, tint: 0x7ab878 },
      { kind: 'ridge', u: 0.95987, lat: -22, len: 40, r: 18, h: 5, top: 0.2, near: 6, tint: 0x7ab878 },
      // the spur the cave is cut into, green down to the cave's rock
      { kind: 'ridge', u: 0.97492, lat: -15.5, len: 18, r: 8, h: 6, top: 0.25, near: 2.8, tint: 0x7ab878 },
      { kind: 'paint', u: 0.97492, lat: -12, len: 16, r: 5, w: 4, tint: 0x7ab878 },
      // low green hills inside the S-bends before the finish
      { kind: 'ridge', u: 0.82027, lat: -18.763, yaw: 57.75, len: 16, r: 11, h: 3, top: 0.3, tint: 0x6aaa6a },
      { kind: 'ridge', u: 0.8158, lat: -11.485, yaw: 15.18, len: 12, r: 8, h: 4.6, top: 0.3, near: 0.5, tint: 0x6aaa6a },
      { kind: 'ridge', u: 0.874, lat: -19.173, yaw: 11.86, len: 16, r: 12, h: 2.5, top: 0.25, near: 2, tint: 0x7ab878 },
      { kind: 'ridge', u: 0.88853, lat: 12.917, yaw: 5.62, len: 16, r: 8, h: 3.4, top: 0.3, near: 0.5, tint: 0x6aaa6a },
      // the grassy rise the east beach's grove stands on
      { kind: 'ridge', u: 0.22027, lat: 16.803, yaw: -3.16, len: 26, r: 10, h: 3.2, top: 0.3, near: 2.3, tint: 0x7ab878 },
      // the headland behind Skull Rock, a ridge running out to the west
      // shore past the rock's clearing (which would cut any flank nearer
      // the road)
      { kind: 'ridge', u: 0.64217, lat: 44.028, yaw: 90, len: 26, r: 18, h: 10, top: 0.2, tint: 0x6aaa6a },
      { kind: 'shore', u: 0.45, lat: 11, len: 70, r: 30 },
      // the island down to the kerb of the S on its west side
      { kind: 'ridge', u: 0.58197, lat: -14.011, len: 44, r: 10, h: 5, top: 0.25, near: 0.5 },
      { kind: 'paint', u: 0.58197, lat: -14.011, len: 44, r: 7, w: 4, tint: 0x5f9f5f },
      { kind: 'shore', u: 0.795, lat: 17, len: 24, r: 18 },
      // the stockade's rise on the anchorage's sand, so the camp stands at
      // the road's height (on the plain it hid behind the kerb), and the bay
      // brought in past it, so its jetty reaches the water
      { kind: 'ridge', u: 0.54184, lat: 13.011, len: 14, r: 16, h: 0.92, top: 0.6, near: 0.4, w: 1 },
      { kind: 'shore', u: 0.54, lat: 19.5, len: 20, r: 24 },
      // the dune beside the climb to the bay, a little over the road all
      // the way up, so what stands on it stands over the kerb; it is down
      // again before the bay's damp sand and short of the lookout's legs
      { kind: 'ridge', u: 0.3111, lat: 13.525, len: 9, r: 10, h: 3.0, h1: 3.7, top: 0.5, near: 0.4, w: 3 },
      // the camp's own rise on the east beach: its shelter, its fire and its
      // pirates stand at the road's height instead of under the kerb
      { kind: 'ridge', u: 0.0903, lat: 17.002, len: 8, r: 13, h: 0.92, top: 0.55, near: 0.4, w: 4 },
      // the foothill's face before the cave, green to the kerb (a facet of
      // it lay bare sand on the hillside)
      { kind: 'paint', u: 0.9398, lat: -13, len: 14, r: 5, w: 5, tint: 0x7ab878 },
      // no seeded crate on the island's face above the bend past Skull Rock
      { kind: 'clear', u: 0.69234, lat: -10.006, len: 20, r: 6 },
      // ...nor a seeded boulder on its face from the gate down the S: sand
      // coloured, on the jungle's green, they read as props left on a lawn
      { kind: 'clear', u: 0.53183, lat: -13.012, yaw: -0.01, len: 28, r: 9 },
      { kind: 'clear', u: 0.61207, lat: -13.01, len: 30, r: 9 },
      // the jungle's green carried on round the S's second bend, where the
      // peak's own tint has faded out down its flank (bare sand facets showed
      // between the canopy's crowns)
      { kind: 'paint', u: 0.6823, lat: -16.01, len: 30, r: 8, w: 6, tint: 0x5f9f5f },
      { kind: 'paint', u: 0.72745, lat: -15.006, yaw: -0.01, len: 12, r: 6, w: 5, tint: 0x5f9f5f },
      // ...and down the foothills to the kerb of the east straight, the bend
      // into it and the start straight, which stood bare sand under a green
      // crest (a dune, on an island called jungle)
      { kind: 'paint', u: 0.21662, lat: -13.084, yaw: -1.46, len: 56, r: 8, w: 5, tint: 0x5f9f5f },
      { kind: 'paint', u: 0.21721, lat: -24.134, yaw: -1.31, len: 56, r: 10, w: 6, tint: 0x5f9f5f },
      { kind: 'paint', u: 0.11539, lat: -14.004, yaw: -0.01, len: 16, r: 9, w: 6, tint: 0x5f9f5f },
      { kind: 'paint', u: 0.02508, lat: -13, len: 30, r: 8, w: 5, tint: 0x5f9f5f },
      // ...and round the bay, the peak's flank over the anchorage
      { kind: 'paint', u: 0.31605, lat: -13.024, yaw: 0.01, len: 30, r: 8, w: 5, tint: 0x5f9f5f },
      { kind: 'paint', u: 0.38639, lat: -14.021, yaw: -0.05, len: 22, r: 9, w: 6, tint: 0x5f9f5f },
      { kind: 'paint', u: 0.45154, lat: -14.014, len: 22, r: 9, w: 6, tint: 0x5f9f5f },
      { kind: 'paint', u: 0.51676, lat: -14.014, yaw: -0.01, len: 22, r: 9, w: 6, tint: 0x5f9f5f },
      { kind: 'paint', u: 0.2207, lat: 14.833, yaw: -2.94, len: 26, r: 6, w: 4, tint: 0x5f9f5f },
      // the headland's jungle brought down along the shore from Skull Rock
      // to the stockade, under the crew's trail
      { kind: 'paint', u: 0.59401, lat: 13.511, len: 26, r: 6, w: 4, tint: 0x5f9f5f }
    ]
  },
  driftwood: {
    name: 'Driftwood', sand: STRIP, waypoints: GEN_TRACKS.driftwood,
    oils: genFurn('driftwood').oils, pads: genFurn('driftwood').pads, boxes: genFurn('driftwood').boxes,
    // A storm coast of dunes: the long diagonal is a pass between them, bare
    // sand inland and grass-topped on the seaward side, and it drives
    // straight at the light station on the great dune that closes it, then
    // through that dune in a stone-lined tunnel and out onto the point (the
    // tunnel is one piece with the dune; gen-tracks.mjs levels the road
    // through it); the start straight runs past the fishermen's tarred net huts
    // backed into a grassy bank, dunes on its inside and the east side's.
    // Seeded scatter keeps off the dunes' faces (the `clear`s): driftwood
    // on a clean slope read as specks. The sea comes up to the
    // road on the flat stretch (its `shore`), and the line the storm tide
    // left runs along the sand above it, from the boneyard of dead trees on
    // the east beach and the great trunk to the bonfire. That beach is the
    // plain and the road stands most of a unit over it behind its kerb, so
    // the line is told in what stands up: root plates reared twice a car's
    // height, the trees the sea killed where they stood, the groynes'
    // posts running down into the surf, the beachcombers' fort on its jam
    // of logs. Up the pass, storm fence and marram hold the dunes' feet.
    set: [
      // on a beach rise: on the plain the dead trees' feet and the fallen
      // ones stood under the kerb's line
      { model: 'set-strand-snags', u: 0.14949, lat: -9.5, yaw: 180, y: 0.7 },
      { model: 'set-driftwood-trunk', u: 0.29841, lat: -8.6, yaw: 180 },
      { model: 'set-strand-line', u: 0.33925, lat: -10.195, yaw: 175.25 },
      { model: 'set-strand-groynes', u: 0.38864, lat: -9.499, yaw: -179.56 },
      { model: 'set-bonfire', u: 0.46817, lat: -10.2, yaw: 160, y: 0.7 },
      { model: 'set-driftwood-forts', u: 0.43804, lat: -11, yaw: -0.1, y: 0.86 },
      // the fishers' upturned-boat stores where the pass leaves the beach
      { model: 'set-boat-huts', u: 0.57582, lat: 10.5 },
      // storm fence and marram along the dune pass, a length each side
      { model: 'set-dune-fence-a', u: 0.65632, lat: 9.4 },
      { model: 'set-dune-fence-b', u: 0.69657, lat: -9.6, yaw: 180 },
      // marram in drifts up the seaward dunes' faces, the pass's length
      { model: 'set-dune-marram', u: 0.60098, lat: -14.5, yaw: -180 },
      { model: 'set-dune-marram', u: 0.7016, lat: -15, yaw: 0 },
      // the lighthouse's dune at the pass's end, the road through it in a
      // tunnel and the light station on its seaward shoulder, all one piece
      // that carries the road in its own frame (set_prototypes.py
      // DRIFT_ROAD: re-sample it if this u or the road moves)
      { model: 'set-lighthouse-dune', u: 0.78371, lat: 0 },
      // the storm's wrack piled on the point where the road turns back
      { model: 'set-point-wrack', u: 0.85346, lat: -10.498, yaw: -179.4 },
      // ...and a channel buoy the storm threw up beside it, where the road
      // out of the tunnel points; the strand line again along the sea side
      // of the run back to the net huts, which lay bare
      { model: 'set-storm-buoy', u: 0.87007, lat: -10.5, yaw: 179.77 },
      { model: 'set-strand-line', u: 0.91145, lat: -9.6, yaw: -176 },
      // storm fence and marram at the dunes' foot on the outside of the bend
      // off the east side (the marram behind the fence is the full tier's)
      { model: 'set-dune-fence-b', u: 0.21489, lat: 9.6 },
      { model: 'set-dune-marram', u: 0.22496, lat: 14.5, lite: false },
      // the smokehouse where the start straight bends away, which it points at
      { model: 'set-smokehouse', u: 0.07316, lat: -10.425, yaw: -175.91 },
      // they level nothing (their gear drapes), so the bank can rise behind
      // them; lifted to the verge they stand on
      { model: 'set-net-huts', u: 0.96982, lat: -8.6, yaw: 180, y: 0.59 },
      // the infield, which lay bare: the fishers' drying racks
      // across the start straight from their huts, the chapel the storms
      // unroofed on the dune inside the first bend, and a wood the sand
      // and the salt killed beside the east run
      { model: 'set-fish-racks', u: 0.01207, lat: 11.5 },
      { model: 'set-chapel-ruin', u: 0.14949, lat: 19 },
      { model: 'set-ghost-wood', u: 0.29257, lat: 15.006, yaw: -22.58 },
      // the storm-signal station inside the first bend, the sea
      // defence where the tide comes nearest the east run, and the ship's
      // boxes the storm threw up the strand on the run back to the net huts
      // (there the sand stands at the road's height; before the pass the
      // road climbs off it)
      { model: 'set-storm-mast', u: 0.09719, lat: 9.081, yaw: -4.9 },
      { model: 'set-storm-armour', u: 0.36438, lat: -10.497, yaw: 178.87 },
      { model: 'set-storm-containers', u: 0.95071, lat: -10.5, yaw: 180 },
      // ...and more of them, where the east run comes down to
      // the strand and, still coming ashore, in the surf past the groynes
      { model: 'set-storm-containers-b', u: 0.24508, lat: -10.5, yaw: -180 },
      { model: 'set-storm-containers-c', u: 0.40991, lat: -13.199, yaw: 172.37 },
      // ...and, on the dune beside the climb to the pass, the
      // fore half of a coaster the storm broke
      { model: 'set-storm-wreck', u: 0.50238, lat: -12.5, yaw: 180 },
      // An old wooden hull the dunes buried and
      // the storm blew bare lies along the pass, and the road runs between
      // her ribs: astride it, where the pass is level and straight and the
      // light station stands in the frame she makes
      { model: 'set-hull-arch', u: 0.61306, lat: 0 },
      // what is still afloat: the wreck buoy over the coaster's after half
      // off the east strand, and more of the ship's boxes drifting in where
      // the last ones come ashore, just past the surf where the east run
      // points before it turns (further out and along the strand they never
      // came into a racer's picture), half as big again so they read there
      { model: 'set-wreck-buoy', u: 0.33502, lat: -31, yaw: 179.97 },
      { model: 'set-storm-adrift', u: 0.42216, lat: -20.499, yaw: 179.75, scale: 1.4 },
      // the wrack along the tide line, between what already lies there
      { model: 'set-tide-wrack', u: 0.26821, lat: -16.5, yaw: -179.98 },
      { model: 'set-tide-wrack', u: 0.32101, lat: -14.483, yaw: -174.27 },
      { model: 'set-tide-wrack', u: 0.35412, lat: -14.959, yaw: 172.89, lite: false },
      { model: 'set-tide-wrack', u: 0.40483, lat: -14.499, yaw: -179.91 },
      { model: 'set-tide-wrack', u: 0.42822, lat: -14.999, yaw: -174.37, lite: false },
      { model: 'set-tide-wrack', u: 0.45206, lat: -14.5, yaw: 180 },
      // marram along the dunes' feet, which ran down bare to the verge: the
      // start straight's infield and the first bend's, the bank along the
      // east run, both sides of the pass, and the lighthouse dune's foot
      // where the lap comes back past it
      { model: 'set-dune-foot', u: 0.97485, lat: 12.6 },
      { model: 'set-dune-foot', u: 0.04527, lat: 12.6 },
      { model: 'set-dune-foot', u: 0.1344, lat: 12, lite: false },
      { model: 'set-dune-foot', u: 0.30046, lat: 7.9, yaw: 0.09 },
      { model: 'set-dune-foot', u: 0.35156, lat: 8.1, yaw: -7.29, lite: false },
      { model: 'set-dune-foot', u: 0.40968, lat: 7.229, yaw: -0.47 },
      { model: 'set-dune-foot', u: 0.57281, lat: -9.6, yaw: -180 },
      { model: 'set-dune-foot', u: 0.64928, lat: -9.4, yaw: -180, lite: false },
      { model: 'set-dune-foot', u: 0.7499, lat: -9.6, yaw: -180 },
      { model: 'set-dune-foot', u: 0.60099, lat: 12.8, lite: false },
      { model: 'set-dune-foot', u: 0.7167, lat: 14 },
      { model: 'set-dune-foot', u: 0.91442, lat: 9.2 },
      { model: 'set-dune-foot', u: 0.94467, lat: 13.2 }
    ],
    land: [
      // the dune pass: the long diagonal runs between dunes either side
      // (the inland line is spaced so its dunes run into one another without
      // adding: ridge heights ADD, and where two crests overlap they stack
      // into a peak. Ends a radius and a half apart, half-crested, keep one
      // height along the line.)
      { kind: 'ridge', u: 0.53055, lat: 23, len: 6, r: 15, h: 2.8, top: 0.6 },
      { kind: 'ridge', u: 0.6211, lat: 28, len: 6, r: 16.5, h: 4.6, top: 0.5 },
      { kind: 'ridge', u: 0.71167, lat: 27, len: 6, r: 16, h: 3.6, top: 0.5 },
      { kind: 'ridge', u: 0.79216, lat: 22, len: 6, r: 14, h: 3.2, top: 0.5 },
      { kind: 'ridge', u: 0.5708, lat: -24, yaw: -20, len: 16, r: 19, h: 5.2, top: 0.2, near: 3, tint: 0x93c47c },
      { kind: 'ridge', u: 0.66136, lat: -26, yaw: 12, len: 20, r: 20, h: 6.4, top: 0.2, near: 3, tint: 0x93c47c },
      { kind: 'ridge', u: 0.75191, lat: -23, yaw: -25, len: 14, r: 18, h: 4.8, top: 0.2, near: 3, tint: 0x93c47c },
      // one more dune inside the east side, clear of the pass's own. Once
      // a great dune in the middle of the loop lay under three
      // more, which summed into one sharp pyramid seventeen units high over
      // the start straight; the pass's dunes are the loop's high ground now.
      { kind: 'ridge', u: 0.14949, lat: 19, len: 4, r: 15, h: 3.4, top: 0.5 },
      // a low grassy dune inland of the strand line, the sea side left
      // open: ONE broad form (three small ones run together here added up
      // into a pale peak over the run down to the strand, and a form under
      // a dozen units of radius is a pyramid on the ground's 9 u grid)
      { kind: 'ridge', u: 0.36975, lat: 15, yaw: 0, len: 14, r: 13, h: 2.4, top: 0.6, near: 0.5, tint: 0xa8d090 },
      // the grassy bank the net huts back into
      { kind: 'ridge', u: 0.97485, lat: -18.5, len: 26, r: 6.5, h: 3, top: 0.3, near: 6.5, tint: 0xa8d090 },
      // marram at the dunes' feet along the pass, a green wash by the kerb
      // where the inland faces were bare sand
      { kind: 'paint', u: 0.61104, lat: 12, len: 36, r: 4, w: 5, tint: 0xa8d090 },
      { kind: 'paint', u: 0.73179, lat: 12, len: 36, r: 4, w: 5, tint: 0xa8d090 },
      // the fort's and the fire's rise on the strand, at the road's height
      // (a beach rise), running on as a dune beside the climb to the pass,
      // as high as the road until the pass's own dunes take over: ONE rise,
      // since two side by side add where they overlap
      { kind: 'ridge', u: 0.47671, lat: -15, len: 34.3, r: 12, h: 0.85, h1: 2.75, top: 0.55, near: 0.4, w: 2 },
      // nothing seeded on the dunes' faces
      { kind: 'clear', u: 0.56073, lat: 14, len: 40, r: 9.5 },
      { kind: 'clear', u: 0.67141, lat: 14, len: 40, r: 9.5 },
      { kind: 'clear', u: 0.7821, lat: 14, len: 30, r: 9.5 },
      { kind: 'clear', u: 0.56074, lat: -14, len: 40, r: 9.5 },
      { kind: 'clear', u: 0.67141, lat: -14, len: 40, r: 9.5 },
      { kind: 'clear', u: 0.7821, lat: -14, len: 30, r: 9.5 },
      { kind: 'clear', u: 0.98994, lat: 14, len: 50, r: 9.5 },
      { kind: 'clear', u: 0.17968, lat: 14, len: 30, r: 9 },
      { kind: 'clear', u: 0.33619, lat: 9.864, yaw: -6.38, len: 26, r: 6 },
      { kind: 'clear', u: 0.40997, lat: 10.829, yaw: 0.12, len: 26, r: 6 },
      { kind: 'ridge', u: 0.14949, lat: -16, len: 14, r: 12, h: 0.72, top: 0.55, near: 0.4, w: 3 },
      // the chapel's yard, grass among the stones
      { kind: 'paint', u: 0.14949, lat: 19, len: 4, r: 7, w: 4, tint: 0xa8d090 },
      // the storm sea comes up the beach to the strand line it left
      { kind: 'shore', u: 0.37, lat: -16.2, len: 110, r: 40 }
    ]
  },
  riptide: {
    name: 'Riptide', sand: STRIP, waypoints: GEN_TRACKS.riptide,
    // no sand on the causeway: over the water the kerbs stand at the asphalt's edge.
    // The strip has eased out on the land, by the ring where the hop's piles begin,
    // and stays out to the end of the causeway's rail.
    sandOff: [[0.409, 0.607]],
    oils: genFurn('riptide').oils, pads: genFurn('riptide').pads, boxes: genFurn('riptide').boxes,
    // A seaside town. Past the line the road runs along the beach under the
    // Point, the coastguard's lookout on its green flank, by the surf club,
    // and over the hop, and the cars land facing the surf patrol's tower on
    // its patch of sand by the water (a beach rise, so it stands at the
    // road's height). The sea comes in to the road round that bend (the
    // first `shore`), and from there the road is the town's seafront: the
    // sea wall along the kerb on the sea side, its walk, lamps, shelter,
    // the clock on its bastion where the straight points and the tea kiosk,
    // and across the road the hotel and the guest houses in the seaside's
    // colours looking out over it, their backs in the marram dune; then
    // the promenade's huts on their boardwalk and the pier out to its white
    // pavilion (the third `shore` brings the sea in under it). The seafront
    // pieces are built against the road as it runs past each of them and
    // stand on the beach's plain, so they keep one line round the bend.
    // From the hop on, the road runs out over the shallows (the second
    // `shore`, whose `w` lets the water in past the road and the sea down
    // under it), the hop on timber piles (its `trestle`, scripts/gen-tracks.mjs)
    // over the channel its beacon marks, and then a causeway on the
    // renderer's bents: open sea outside, where the sailing club's dinghies
    // race up and down a course beside the road, a strip of lagoon inside.
    // The causeway points at the club on the bank outside the hook, its
    // boats on the hard and its school's kites over the hook. Behind, a
    // wider lagoon by the hook and the surfers' camp beside it; the north
    // run is a pass between the great marram dune inside the lap and the
    // Point, a big grassy headland north of the start straight, the surf
    // contest's site strung along its kerb.
    set: [
      { model: 'set-lifeguard-tower', u: 0.19943, lat: -9.993, y: 0.78 },
      // the seafront: the sea wall along the kerb on the sea side, in four
      // lengths, and across the road the hotel and the guest houses
      { model: 'set-seafront-wall-a', u: 0.26128, lat: -9.5, yaw: -180 },
      { model: 'set-seafront-wall-b', u: 0.29221, lat: -9.5, yaw: 180 },
      { model: 'set-seafront-wall-c', u: 0.32324, lat: -9.5, yaw: 180, y: -0.25 },
      { model: 'set-seafront-wall-d', u: 0.35417, lat: -9.5, yaw: -180, y: -0.3 },
      { model: 'set-seafront-hotel', u: 0.29422, lat: 9 },
      { model: 'set-seafront-terrace', u: 0.33201, lat: 9 },
      { model: 'set-seafront-cafe', u: 0.36969, lat: 9 },
      { model: 'set-promenade', u: 0.39386, lat: -8.2, yaw: 180 },
      { model: 'set-surf-club', u: 0.08989, lat: -10.986, yaw: -178.77, y: 0.8 },
      { model: 'set-surf-campers', u: 0.71503, lat: -9.137, yaw: 178.03, y: 0.55 },
      { model: 'set-surf-contest', u: 0.84895, lat: -9.5, yaw: -180 },
      { model: 'set-beach-day', u: 0.90465, lat: -10.471, yaw: -177.2, y: 0.85 },
      { model: 'set-channel-beacon', u: 0.45935, lat: -9.501 },
      // the causeway's piles and rope rail, both kerbs, the hop's length and
      // on to the hook: one piece astride the road (set_prototypes.py
      // RIP_ROAD: re-sample it if this u or the road moves)
      { model: 'set-causeway-rail', u: 0.51677, lat: 0 },
      { model: 'set-lagoon-fleet', u: 0.52181, lat: -18, yaw: 180 },
      { model: 'set-sailing-club', u: 0.62256, lat: -11, yaw: -180 },
      // palms on the Point's lower flank, placed by hand (its `clear` keeps
      // the seeded ones off), none on the marram dune
      { model: 'set-palm-stand', u: 0.95095, lat: -8.986, yaw: 177.46 },
      // marram in drifts up the great dune's face along the north run
      { model: 'set-dune-marram', u: 0.83585, lat: 13.5 },
      // the coastguard's lookout on the Point's flank over the start straight
      { model: 'set-coastguard-lookout', u: 0.03022, lat: -12, yaw: -180, y: 4.5 },
      // the town band's stand on the north shore between the
      // club and the camp, and across the road from the camp the lagoon's
      // bathing beach on a beach rise (`land`), at the road's height. The
      // open-air baths stood there once: from a flat road the
      // chase eye never saw their water. They lie on the low beach beside
      // the hop's landing now, on the plain with no rise, so the cars look
      // down into the pool off the crest (set_prototypes.py lido() has the
      // geometry; RIP_HEADING, re-read if the row moves, or turn its yaw to
      // keep the heading). The first two `shore` rows give them that beach
      { model: 'set-seafront-bandstand', u: 0.65611, lat: -11.481, yaw: -177.65 },
      { model: 'set-riptide-lagoon-beach', u: 0.72521, lat: 12.471, yaw: -2.49 },
      { model: 'set-lido', u: 0.15563, lat: -13.947, yaw: 175.12 },
      // the pier's walk carried over the road where the pier sets
      // out, astride it (the promenade's stair meets it: set_prototypes.py
      // PIER_STAIR, re-read if either row moves), its far stair coming down
      // by the lagoon beach; and what moves off the road, each laid out against
      // the shore it floats by (set_prototypes.py RIP_AT, RIP_HEADING):
      // hire pedalos off the patrol's beach, a launch towing a banana boat
      // in a wide circle on the open water off the hop (the lagoon was too
      // narrow to turn it in), the ferry on the horizon, kites over the bathers'
      // beach. Every flag, banner and kite on the lap flies one way (RIP_WIND).
      { model: 'set-pier-bridge', u: 0.40273, lat: 0, yaw: -180 },
      { model: 'set-pedalos', u: 0.2095, lat: -21.986, yaw: -180 },
      { model: 'set-lagoon-launch', u: 0.47144, lat: -17.002 },
      { model: 'set-ferry', u: 0.52181, lat: -52, yaw: 180 },
      { model: 'set-beach-kites', u: 0.90426, lat: -17.465, yaw: -177.77 }
    ],
    land: [
      // the sea at the road from the patrol's tower round the bend and along
      // the seafront, in two rows: the first ends short beside the tower, so
      // the beach north of it, beside the hop, is wide enough for the baths;
      // the second eases the bay's far end out past the pier as gently as
      // one long row did
      { kind: 'shore', u: 0.252, lat: -20.43, len: 64.88, r: 8 },
      { kind: 'shore', u: 0.411, lat: -25.6, len: 17.52, r: 35.27 },
      { kind: 'shore', u: 0.53, lat: 10, len: 40, r: 30, w: 17 },
      // the sea under the pier: its `w` lets the bay in past the causeway's
      // reach on that bearing (the polar shore keeps 5 u past it otherwise),
      // held narrow so no road meets it. Its sunk sea eases out across the
      // spit of beach north of the clock's bastion: a third of a unit further
      // along, the sand stood up through the damp band there in pale shards
      // (seen from above)
      { kind: 'shore', u: 0.3991, lat: -13, len: 16, r: 10, w: 9 },
      // the Point, a big grassy headland north of the start straight, its
      // foothill climbing from the straight's kerb; the interior's great
      // marram dune, its flank along the north run
      { kind: 'ridge', u: 0.96978, lat: -30, len: 50, r: 20, h: 12, top: 0.2 },
      { kind: 'ridge', u: 0.0, lat: -12, len: 50, r: 9, h: 4, top: 0.2, near: 0.5 },
      // their grass painted down the flanks to the kerb, so the headland is
      // green, not a dune with a green cap
      { kind: 'paint', u: 0.96978, lat: -30, len: 50, r: 14, w: 6, tint: 0x5f9f5f },
      { kind: 'paint', u: 0.0, lat: -12, len: 50, r: 6, w: 4, tint: 0x5f9f5f },
      { kind: 'ridge', u: 0.85096, lat: 35, r: 18, h: 9, top: 0.2, tint: 0xa8d090 },
      { kind: 'ridge', u: 0.84089, lat: 12, len: 40, r: 9, h: 4.5, top: 0.2, near: 0.5, tint: 0xa8d090 },
      // its marram's green down the flank to the north run's kerb and up to
      // the crest: under the ridges' own pale tint it stood a bare sand cone
      { kind: 'paint', u: 0.84089, lat: 12, len: 40, r: 7, w: 5, tint: 0x86b872 },
      { kind: 'paint', u: 0.85096, lat: 31, len: 10, r: 14, w: 8, tint: 0x86b872 },
      // the patrol's patch of sand where the cars land off the hop
      { kind: 'ridge', u: 0.18935, lat: -16.988, len: 12, r: 13, h: 0.78, top: 0.55, near: 0.4, w: 6 },
      // the surf club's rise by the hop and the camp's by the hook, each at
      // the road's height (a beach rise)
      { kind: 'ridge', u: 0.08968, lat: -17.975, yaw: 1.03, len: 10, r: 13, h: 0.8, top: 0.55, near: 0.4, w: 6 },
      { kind: 'ridge', u: 0.73346, lat: -16.729, yaw: -18.68, len: 22, r: 13, h: 0.9, top: 0.55, near: 0.4, w: 6 },
      { kind: 'ridge', u: 0.90428, lat: -16.965, yaw: 2.26, len: 14, r: 13, h: 0.88, top: 0.55, near: 0.4, w: 6 },
      // ...and the lagoon beach's (the sand lay most of a unit under the
      // kerb there; higher than the others and nearer the lagoon's edge)
      { kind: 'ridge', u: 0.71774, lat: 17.473, yaw: -2.39, len: 26, r: 13, h: 1.15, top: 0.55, near: 0.4, w: 4 },
      { kind: 'clear', u: 0.96978, lat: -30, len: 50, r: 20 },
      { kind: 'clear', u: 0.0, lat: -12, len: 50, r: 9 },
      { kind: 'clear', u: 0.85096, lat: 35, r: 18 },
      { kind: 'clear', u: 0.84089, lat: 12, len: 40, r: 9 },
      // nothing seeded between the surf contest and the kerb (a palm stood
      // in front of its tower)
      { kind: 'clear', u: 0.84895, lat: -6.5, len: 26, r: 3 }
    ]
  },
  // Snow Cup — SEEDED medium circuits (the gentle end of the mid profile: low brake
  // fraction, no hairpins, roomy radii, but real crossings + hills; auto-placed furniture).
  powder: {
    name: 'Powder', sand: STRIP, waypoints: GEN_TRACKS.powder,
    oils: genFurn('powder').oils, pads: genFurn('powder').pads, boxes: genFurn('powder').boxes,
    // A ski resort in its valley: the ski mountain and its lift to the west,
    // the resort's back wall of peaks over the start straight to the north
    // and east, its foothills coming down to the kerb along the straight and
    // round the east bend, and the second lift running from the base inside
    // the north loop over the start straight and up them, its chairs over
    // the cars. Forest stands on the foothills, a shoulder of the ski
    // mountain by the crossings' west lobe, a spur at the south-west bend,
    // knolls by the south loop and the east hill; the valley stays open to
    // the south-east. The lift and the stands are built on the ground drawn
    // under them, sampled (set_prototypes.py CHAIRLIFT_GROUND, FORESTS):
    // re-sample them after moving the land they stand on.
    set: [
      { model: 'set-ski-lift', u: 0.90023, lat: -32.5, yaw: -180 },
      { model: 'set-ski-school', u: 0.53405, lat: -12.198, yaw: 160 },
      { model: 'set-powder-peaks', u: 0.03025, lat: -60 },
      { model: 'set-powder-chairlift', u: 0.03196, lat: 0 },
      { model: 'set-powder-forest-a', u: 0.9752, lat: -17.748, yaw: -0.65 },
      { model: 'set-powder-forest-b', u: 0.06824, lat: -18.907, yaw: 1.23 },
      { model: 'set-powder-forest-c', u: 0.11023, lat: -13.431, yaw: -1.75 },
      { model: 'set-powder-forest-d', u: 0.5939, lat: -14.829, yaw: 2.72 },
      { model: 'set-powder-forest-e', u: 0.33115, lat: 17.721 },
      { model: 'set-powder-forest-f', u: 0.62983, lat: -15.339, yaw: -3.26 },
      { model: 'set-powder-forest-g', u: 0.42461, lat: -19.859 },
      { model: 'set-powder-forest-h', u: 0.48288, lat: -11.199 },
      // the snowman family on the outside verge of the east bend, at road
      // height, ahead of a car coming over the hump off the start straight
      { model: 'set-snowman-field', u: 0.14857, lat: -6.998, yaw: 180 },
      // the resort's village up the foothill's foot, dead ahead of the long
      // run north and outside the bend onto the start straight: the lodge
      // and its chalets (in the ski mountain's frame, sampled:
      // set_prototypes.py RESORT_*)
      { model: 'set-powder-resort', u: 0.90023, lat: -32.5, yaw: -180 },
      // the verge at road level where the valley's hills stand back: snow
      // fences and their drifts, rail fences, the road's snow poles, along
      // the run west from the east bend and round the south-west bend (the
      // box keeps a snow fence on each)
      { model: 'set-powder-verge-a', u: 0.1768, lat: -6.199, yaw: 180 },
      { model: 'set-powder-verge-b', u: 0.20402, lat: -6.199, yaw: -180, lite: false },
      { model: 'set-powder-verge-a', u: 0.23124, lat: -6.2, yaw: 180, lite: false },
      { model: 'set-powder-verge-b', u: 0.57869, lat: -6.196, yaw: -178.86, lite: false },
      { model: 'set-powder-verge-a', u: 0.60377, lat: -6.196, yaw: -179.45 },
      { model: 'set-powder-verge-b', u: 0.62971, lat: -6.16, yaw: 175.4, lite: false }
    ],
    land: [
      // the foothills at the start straight's and the east bend's kerb
      { kind: 'ridge', u: 0.97805, lat: -36.46, yaw: -0.02, r: 34, h: 11, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.0573, lat: -36.322, yaw: 3.46, r: 34, h: 12, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.09613, lat: -31.407, yaw: -1.96, r: 28, h: 11, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.13637, lat: -31.564, r: 28, h: 11, top: 0.2, near: 2 },
      // the massif behind them, each summit carrying a peak (set-powder-peaks)
      { kind: 'ridge', u: 0.97277, lat: -69.852, yaw: -0.8, r: 34, h: 18, top: 0.15 },
      { kind: 'ridge', u: 0.03597, lat: -81.485, yaw: 6.37, r: 40, h: 20, top: 0.12 },
      { kind: 'ridge', u: 0.07849, lat: -65.981, yaw: -0.1, r: 36, h: 18, top: 0.12 },
      { kind: 'ridge', u: 0.11086, lat: -54, yaw: 1.05, z: -0.86, len: 50, r: 28, h: 14, top: 0.12 },
      { kind: 'ridge', u: 0.94946, lat: -57.92, r: 36, h: 14, top: 0.12 },
      // the spur at the south-west bend, running back to the ski mountain
      { kind: 'ridge', u: 0.59221, lat: -33.713, yaw: 1.76, r: 30, h: 18, top: 0.12, near: 2 },
      { kind: 'ridge', u: 0.60093, lat: -39.983, yaw: 156.94, len: 34, r: 30, h: 18, top: 0.12 },
      // the ski mountain's shoulder by the west lobe, the east hill by the
      // run down from the crossings, the foothill past the descent to the
      // ski school, the knoll in the bay north of the south loop
      { kind: 'ridge', u: 0.32895, lat: 37.161, r: 34, h: 18, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.42562, lat: -31.519, r: 28, h: 14, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.48681, lat: -29.416, r: 26, h: 11, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.62929, lat: -25.667, yaw: -2.48, r: 22, h: 7, top: 0.25, near: 2 },
      // the second lift's run back down the foothill, west of its line: a
      // groomed wash, its netting and poles the lift piece's (RUN_GROUND)
      { kind: 'paint', u: 0.01643, lat: -19, yaw: 90, len: 22, r: 4.5, w: 7, tint: 0xb1c7ec },
      // nothing seeded on the east verge of the run down from the crossings:
      // a pine the east hill raised there stood with its crown behind the
      // deck from the road below
      { kind: 'clear', u: 0.42582, lat: -9, len: 26, r: 5 },
      // nor between the road and the snowman family
      { kind: 'clear', u: 0.14857, lat: -4.499, len: 10, r: 2 }
    ]
  },
  flurry: {
    name: 'Flurry', sand: STRIP, waypoints: GEN_TRACKS.flurry,
    oils: genFurn('flurry').oils, pads: genFurn('flurry').pads, boxes: genFurn('flurry').boxes,
    set: [
      { model: 'set-frozen-lake', u: 0.33362, lat: -11.398, yaw: 180 },
      // the fishing hamlet on the lake's south shore, dead ahead of the run
      // down off the bridge and outside the bend after it: cabins up the
      // hill's foot, the boathouse, the jetty out onto the ice, the fishing
      // huts on it beside the road (built on the ground sampled under it,
      // set_prototypes.py HAMLET_G: re-sample after moving it or the land)
      { model: 'set-lake-hamlet', u: 0.37162, lat: -10.965, yaw: -176.51 },
      // one more corner of the village by the start
      { model: 'set-log-cabin', u: 0.05044, lat: 12, yaw: 30 },
      { model: 'set-flurry-peaks-ne', u: 0.63957, lat: 44.998 },
      { model: 'set-flurry-peaks-sw', u: 0.12158, lat: 44.895, yaw: 1.63 },
      { model: 'set-ski-jump', u: 0.53999, lat: 19.589, yaw: 101.7 },
      { model: 'set-flurry-forest-a', u: 0.58398, lat: 9.11 },
      { model: 'set-flurry-forest-b', u: 0.65953, lat: 13.14 },
      { model: 'set-flurry-forest-c', u: 0.70805, lat: 11.143, yaw: -1.33 },
      // firs across the gap the piste left between those two, so the
      // foothill's forest is one ragged treeline again
      // (the full tier's)
      { model: 'set-flurry-forest-n', u: 0.68395, lat: 14, lite: false },
      { model: 'set-flurry-forest-d', u: 0.13543, lat: 15.355, yaw: 0.19 },
      { model: 'set-flurry-forest-e', u: 0.1863, lat: 14.359, yaw: -2.63 },
      // the west gap the start straight looks into: a clump where the outrun
      // of the old jump stood at the first bend, and pines on the low far ridge
      { model: 'set-flurry-forest-f', u: 0.09426, lat: 10.509, yaw: -0.4 },
      { model: 'set-flurry-forest-g', u: 0.07178, lat: 49.789, yaw: -1.54 },
      { model: 'set-flurry-peaks-nw', u: 0.38879, lat: -70.126, yaw: -0.41 },
      // forest in the hollows of the north-west ridge's face and along its
      // foot (the frame the ridge's: +X up the face, +Z along it)
      { model: 'set-flurry-forest-h', u: 0.38875, lat: -50.124, yaw: -0.55 },
      { model: 'set-flurry-forest-i', u: 0.38875, lat: -50.124, yaw: -0.55 },
      { model: 'set-flurry-forest-j', u: 0.38875, lat: -50.124, yaw: -0.55 },
      { model: 'set-flurry-forest-k', u: 0.38875, lat: -50.124, yaw: -0.55 },
      // (the belt along the foot is the full tier's: the box keeps the hollows)
      { model: 'set-flurry-forest-l', u: 0.38875, lat: -50.124, yaw: -0.55, lite: false },
      { model: 'set-flurry-forest-m', u: 0.38875, lat: -50.124, yaw: -0.55, lite: false },
      { model: 'set-flurry-peaks-se', u: 0.9193, lat: -68 },
      // the hamlet's valley on round the lap's second half: its fields and
      // hay barn outside the bend north off the east loop, the frozen stream
      // where it meets the road (the plain below is its bed) with the
      // footbridge the fields' lane crosses on toward the lake, and a farm
      // outside the last bend before the line (sampled: set_prototypes.py
      // FIELDS_*, FARM_*, STREAM_*; the box keeps each one's bones)
      { model: 'set-flurry-fields', u: 0.76489, lat: 11.968, yaw: 3.46 },
      { model: 'set-flurry-stream', u: 0.81338, lat: 0 },
      { model: 'set-flurry-farm', u: 0.90417, lat: -10, yaw: -180 }
    ],
    // A frozen stream runs from the village loop under the crossing down to
    // the lake. The village's ski jump is cut into the south shoulder of the
    // massif past the east loop, beside its forest: the in-run lies down the
    // shoulder, the table runs out over its foot and the outrun stops on the
    // flat, flying out over the open snowfield, away from every road. The
    // crossing and the run in to the loop see it three-quarter from the front.
    // The valley is closed by mountains on all four sides, open between
    // them: past the two end loops a massif whose foothills rise off the
    // outside verge, forest down their faces (sampled, set_prototypes.py
    // FORESTS: re-sample after moving the land), a range of peaks on its
    // summits behind; along the two long sides the far snow ridges, peaks on
    // their crests. Their reach stays inside the terrain's 48-cell cap.
    land: [
      { kind: 'plain', u: 0.43912, lat: 5, yaw: -142, len: 54, r: 3, w: 5, tint: 0xc8e0f6 },
      // past the east loop: the foothills at its kerb, the massif behind, the
      // ski jump cut into the first one's south shoulder
      { kind: 'ridge', u: 0.58065, lat: 31, r: 28, h: 10, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.65953, lat: 32.649, r: 30, h: 11, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.70939, lat: 31.025, yaw: -1.27, r: 28, h: 9, top: 0.2, near: 2 },
      // (the middle massif stands back: a form that is still high where the
      // road's corridor ends, some 16 u out, steps up there in a hard crease,
      // which showed as a slab between the stands)
      { kind: 'ridge', u: 0.63321, lat: 38.997, yaw: -0.01, r: 28.5, h: 18, top: 0.12 },
      { kind: 'ridge', u: 0.58942, lat: 42.93, r: 30, h: 15, top: 0.12 },
      { kind: 'ridge', u: 0.68475, lat: 49.959, r: 34, h: 18, top: 0.12 },
      // past the west loop: the same
      { kind: 'ridge', u: 0.13547, lat: 30.96, yaw: 0.14, r: 28, h: 10, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.18641, lat: 29.327, yaw: -2.34, r: 26, h: 9, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.12023, lat: 46.243, yaw: 1.38, r: 34, h: 18, top: 0.12 },
      { kind: 'ridge', u: 0.1584, lat: 51.753, r: 30, h: 15, top: 0.12 },
      // the open west gap the start straight looks into, closed low and far
      // off, under the frame's top from the grid and short of the terrain's
      // west edge, pines on its near face (forest-g)
      { kind: 'ridge', u: 0.08894, lat: 57.537, yaw: -0.88, len: 20, r: 20, h: 10, top: 0.15 },
      // a low bench off the start straight's verge under the cabins by the
      // line (set-log-cabin, built on it as sampled): on the plain they
      // stood under the road's own height, their walls behind its bank
      { kind: 'ridge', u: 0.04535, lat: 12.5, r: 10, h: 1.4, top: 0.65, near: 2 },
      // the far ridges along the long sides
      { kind: 'ridge', u: 0.38879, lat: -70.126, yaw: -0.41, len: 100, r: 28, h: 15, top: 0.15 },
      { kind: 'ridge', u: 0.9193, lat: -68, len: 80, r: 28, h: 13, top: 0.15 },
      // the north-west ridge's face is no one white wall: spurs run down it
      // toward the valley, each its own length and height, hollows between
      // them in a little shade, forest up the hollows and along the foot to
      // a ragged treeline (forest-h to -k, sampled, set_prototypes.py
      // FORESTS). All inside the ridge's own reach.
      { kind: 'ridge', u: 0.38876, lat: -51.125, z: -33, yaw: 89.46, len: 14, r: 10, h: 5.5, top: 0.2 },
      { kind: 'ridge', u: 0.38875, lat: -49.123, z: -5, yaw: 77.44, len: 18, r: 11, h: 6.5, top: 0.2 },
      { kind: 'ridge', u: 0.38876, lat: -52.124, z: 24, yaw: 99.47, len: 12, r: 9, h: 4.5, top: 0.2 },
      { kind: 'paint', u: 0.38876, lat: -52.124, z: -19, yaw: 89.47, len: 14, r: 4, w: 5, tint: 0xdbe4f4 },
      { kind: 'paint', u: 0.38876, lat: -52.124, z: 10, yaw: 89.47, len: 14, r: 4, w: 5, tint: 0xdbe4f4 }
    ]
  },
  glacier: {
    name: 'Glacier', sand: STRIP, waypoints: GEN_TRACKS.glacier,
    oils: genFurn('glacier').oils, pads: genFurn('glacier').pads, boxes: genFurn('glacier').boxes,
    set: [
      // the expedition's igloo camp, its doorways to the road
      { model: 'set-igloo-camp', u: 0.23188, lat: -12.503, yaw: -180 },
      { model: 'set-expedition-camp', u: 0.7383, lat: -11.959, yaw: 3.15 },
      // each rookery turned so its white fronts face the road and the car
      // coming at it: one on the moraine outside the bottom loop, dead ahead
      // of the long raised straight, one below the NE bend's crest
      // (the first as near the kerb as its slope's foot lets it stand; the
      // second stays up its slope, where it shows over the hump's kerb)
      { model: 'set-penguin-group', u: 0.64804, lat: -7.486, yaw: 142.2 },
      { model: 'set-penguin-group', u: 0.37083, lat: 7.92, yaw: 34.3 },
      // the terminal moraine either side of that rookery, on the loop's
      // outside verge: slate erratics and stranded blocks of blue ice (built
      // on the ground sampled under them, set_prototypes.py MORAINE)
      { model: 'set-glacier-moraine-a', u: 0.62939, lat: -9.159, yaw: -174.75 },
      { model: 'set-glacier-moraine-b', u: 0.67961, lat: -9.505, yaw: 180 },
      // beside the raised straight: the dog team's trail along the drift on
      // its left, the flagged crevasses of the glacier's snout on its right
      { model: 'set-glacier-dog-trail', u: 0.43376, lat: -8.496, yaw: -180 },
      { model: 'set-glacier-crevasses', u: 0.52264, lat: 14.993, yaw: 0 },
      // the advanced camp at the foot of the flagged crevasses, outside the
      // bend east off the run back from the bottom loop, which drives at it;
      // on the snow past the cracks' ends (a tent stood on one)
      { model: 'set-advanced-camp', u: 0.77382, lat: -6.76, yaw: 145.28 },
      { model: 'set-penguin-chute', u: 0.9697, lat: -15, yaw: 137 },
      // the range over the top straight (`land` lays the snowfield and the
      // foothills in front of it)
      { model: 'set-glacier-peaks', u: 0.18441, lat: -60.008 },
      // the glacier's ice, on the crest of the ridge that carries it down the
      // valley (`land`, the ridge at u 0.9954): placed in that ridge's frame
      { model: 'set-glacier-tongue', u: 0.9954, lat: -71.7, yaw: -122 },
      // the range on round the valley's south side, and on the massif east of
      // the east leg
      { model: 'set-glacier-peaks-south', u: 0.66402, lat: -70.007, yaw: -0.53 },
      { model: 'set-glacier-peaks-east', u: 0.45194, lat: -65.968 },
      // the expedition's airstrip inside the top loop, beside the top straight
      { model: 'set-glacier-airstrip', u: 0.19956, lat: 9.002 },
      // a nunatak on the foothill outside the bend back to the line: the east
      // range's rock breaking out of it (the frame the range's, +X east), the
      // lateral moraine up the verge at its foot
      { model: 'set-glacier-nunatak', u: 0.84134, lat: 21.999, yaw: -179.39 },
      { model: 'set-glacier-moraine-c', u: 0.84851, lat: 9.501 },
      // the expedition's fuel depot just past the line, and its flagged
      // route on along the start straight's outside verge
      { model: 'set-glacier-depot', u: 0.01208, lat: -8.5, yaw: 180 },
      { model: 'set-glacier-route-flags', u: 0.06262, lat: -5.6, yaw: 180 },
      // serac fields where the ice breaks up on the outside verge of a bend:
      // dead ahead of the start straight, outside the bend down to the east
      // leg, and at the nunatak's foot on the bend back to the line (a wash
      // of the glacier's blue under each, `land`)
      { model: 'set-glacier-seracs-a', u: 0.13544, lat: -8.494, yaw: -179.84 },
      { model: 'set-glacier-seracs-b', u: 0.30056, lat: -8.503, yaw: -180 },
      { model: 'set-glacier-seracs-a', u: 0.81415, lat: 8.501, yaw: 20.02 }
    ],
    // Each piece stands where a racer reads it from the chase camera (the
    // see:landmarks probe), not where the old sight-line score put it: the
    // igloo camp at the end of the top straight, short of the
    // corridor down the middle whose vista the box cannot also pay a fort
    // for; the rookeries close by the low road; the expedition's base camp
    // and its smaller advanced camp by the bends.
    // The glacier: a tongue of blue ice flows down from the massif in the
    // west, low in the valley between two snow ridges, into the middle of the
    // map, ending among the penguins by the long legs; the terminal moraine
    // the ice left lies at the far end of the lap, which the long legs drive
    // straight at. The ice is set-glacier-tongue, faces on this ridge's crest:
    // as the ridge's tint it read as a colour gradient, the 9 u grid's wash.
    land: [
      { kind: 'ridge', u: 0.04959, lat: -126.101, yaw: 151, len: 60, r: 42, h: 28 },
      { kind: 'ridge', u: 0.9954, lat: -71.7, yaw: -122, z: 7, len: 136, r: 15, r1: 9, h: 5.5, h1: 1.2, top: 0.5 },
      { kind: 'ridge', u: 0.00926, lat: -51.4, yaw: -122, x: 8, z: -5, len: 80, r: 13, h: 11, h1: 3.5, top: 0.15 },
      { kind: 'ridge', u: 0.73951, lat: -55.232, yaw: -63.7, x: -3, z: -5, len: 80, r: 13, h: 11, h1: 3.5, top: 0.15 },
      { kind: 'ridge', u: 0.66869, lat: -18.909, yaw: -172.11, len: 70, r: 22, h: 4.5, top: 0.55, tint: 0xbcb8c0 },
      // The range over the top straight's outside stands 45 to 90 units back
      // (set-glacier-peaks; its peaks drape on the land, so a swell under one
      // is its foot). At u 0.185 the frame is the world's: lat is Z, z is X.
      // The snowfield between the road and the range rises in one broad, low
      // swell, whose reach is the furthest north Glacier's land goes: no form
      // below reaches past it, since a form reaching further out would move
      // every vertex of the ground's grid round the lap (native/renderer/
      // CLAUDE.md, authored landforms).
      { kind: 'ridge', u: 0.18441, lat: -38.005, z: -40, len: 50, r: 34, h: 1.2 },
      // ...a swell under the far western peak and one in front of the middle
      // one...
      { kind: 'ridge', u: 0.18441, lat: -40.005, z: -109, len: 20, r: 20, h: 5, top: 0.15 },
      { kind: 'ridge', u: 0.18441, lat: -52.007, z: -44, len: 24, r: 18, h: 3, top: 0.15 },
      // ...two rows of snowy foothills in front of the rest, short of the
      // igloo camp's clearing...
      { kind: 'ridge', u: 0.18441, lat: -48.006, z: -24, len: 20, r: 14, h: 3 },
      { kind: 'ridge', u: 0.18441, lat: -45.006, z: 16, len: 22, r: 13, h: 2.8 },
      { kind: 'ridge', u: 0.18441, lat: -24.003, z: -54, yaw: 40, len: 14, r: 15, h: 2.5 },
      { kind: 'ridge', u: 0.18441, lat: -30.004, z: -17, len: 26, r: 13, h: 2.2 },
      { kind: 'ridge', u: 0.18441, lat: -33.005, z: 43, len: 20, r: 12, h: 2.5 },
      // ...and drifts on the snowfield between them and the road, too low to
      // stand into the picture however close they pass
      { kind: 'ridge', u: 0.18441, lat: 0, z: -35, yaw: 30, len: 12, r: 7, h: 1.6 },
      { kind: 'ridge', u: 0.18441, lat: -18.003, z: 9, len: 18, r: 7, h: 1.8 },
      // the ice showing blue through the snow under each serac field
      { kind: 'paint', u: 0.13543, lat: -9.993, yaw: 0.15, len: 10, r: 4, w: 5, tint: 0x9cc6f4 },
      { kind: 'paint', u: 0.30056, lat: -10.004, len: 10, r: 4, w: 5, tint: 0x9cc6f4 },
      { kind: 'paint', u: 0.81415, lat: 10.001, yaw: 20.02, len: 10, r: 4, w: 5, tint: 0x9cc6f4 },
      // nothing seeded on the verge in front of the penguin chute's pool: a
      // boulder there stood between the run to the line and the pool
      { kind: 'clear', u: 0.95455, lat: -9.5, len: 30, r: 5 },
      // ...nor between the road and the airstrip, where two pines stood in
      // front of the plane on the closest pass
      { kind: 'clear', u: 0.21168, lat: 5.501, len: 22, r: 2.5 },
      // ...nor along the advanced camp's tent row (in the camp's frame): a
      // drift heap seeded at the row's end stood into its last tent
      { kind: 'clear', u: 0.77382, lat: -6.76, yaw: 145.28, len: 5, r: 2 },
      // foothills rising off the outside verge of the NE bend, the east leg,
      // the return beside it, the run from the line and the corner onto the
      // top straight (their flanks low where the near ramp ends),
      // the massif behind them carrying set-glacier-peaks-east
      { kind: 'ridge', u: 0.27785, lat: -27.317, r: 24, h: 5, top: 0.25, near: 2 },
      { kind: 'ridge', u: 0.31711, lat: -27.366, yaw: 0.32, r: 24, h: 5.5, top: 0.25, near: 2 },
      { kind: 'ridge', u: 0.43032, lat: -27.287, r: 24, h: 6.5, top: 0.25, near: 2 },
      { kind: 'ridge', u: 0.84446, lat: 27.322, yaw: -0.01, r: 24, h: 6, top: 0.25, near: 2 },
      { kind: 'ridge', u: 0.61739, lat: -25.789, yaw: 0.56, r: 22, h: 6, top: 0.25, near: 2 },
      { kind: 'ridge', u: 0.08251, lat: -25.72, r: 22, h: 3.5, top: 0.25, near: 2 },
      { kind: 'ridge', u: 0.13418, lat: -25.752, yaw: 0.18, z: -0.49, r: 22, h: 3.5, top: 0.25, near: 2 },
      { kind: 'ridge', u: 0.30328, lat: -54.437, r: 30, h: 12, top: 0.15 },
      { kind: 'ridge', u: 0.86477, lat: 61.973, r: 32, h: 13, top: 0.15 },
      { kind: 'ridge', u: 0.82036, lat: 47.877, yaw: 0.37, z: 0.97, r: 28, h: 7, top: 0.15 },
      // past the moraine: the snowfield the south range stands over, a swell
      // under each of its summits
      { kind: 'ridge', u: 0.66293, lat: -41.411, yaw: 170.75, len: 100, r: 26, h: 1.6 },
      { kind: 'ridge', u: 0.64729, lat: -74.305, yaw: -0.57, r: 18, h: 4, top: 0.15 },
      { kind: 'ridge', u: 0.66043, lat: -65.926, yaw: -1.13, r: 22, h: 5, top: 0.15 },
      { kind: 'ridge', u: 0.67153, lat: -56.816, r: 20, h: 4, top: 0.15 },
      { kind: 'ridge', u: 0.68587, lat: -61.006, z: -0.99, r: 18, h: 3, top: 0.15 }
    ]
  },
  avalanche: {
    name: 'Avalanche', sand: STRIP, waypoints: GEN_TRACKS.avalanche,
    oils: genFurn('avalanche').oils, pads: genFurn('avalanche').pads, boxes: genFurn('avalanche').boxes,
    set: [
      { model: 'set-avalanche-slide', u: 0.75964, lat: 14.294, yaw: -0.09 },
      // the avalanche patrol's post past the long gallery, read from the
      // road to it and across the infield from the run to the last loop
      { model: 'set-windsock', u: 0.91336, lat: 6.401, yaw: 10 },
      // the mountainside outside the top loop: three avalanche paths come
      // down through its forest to the road, a warning sign at the foot of
      // the first two, the third coming down onto the snow shed's roof
      // the road keeper's depot outside the bend after the crossing, dead
      // ahead of the run off the bridge: his hut, the plough shed, grit
      { model: 'set-road-keeper', u: 0.48596, lat: 10.982, yaw: 40 },
      // avalanche barriers stepping up the open slope above the run to the
      // last loop (built on the ground sampled under them, FENCE_G)
      { model: 'set-avalanche-fences', u: 0.58669, lat: -12.977, yaw: 179.98 },
      { model: 'set-warning-sign', u: 0.26945, lat: 4.423, yaw: 44 },
      // ...and the first path's slide come down across the road, ploughed
      // through (the blocks stand at the ground sampled under them)
      { model: 'set-avalanche-debris-lobe', u: 0.27549, lat: 0 },
      // (short of the road crew's machines at the gallery's mouth, not in front of them)
      { model: 'set-warning-sign', u: 0.29967, lat: 4.42, yaw: 30 },
      // and at the foot of the west slope's path, at the turn onto the crossing
      { model: 'set-warning-sign', u: 0.08546, lat: -4.372, yaw: 118.72 },
      // forest down the mountainside, the S-bend's spur, the west slope and the
      // wedge inside the S, kept off the paths (sampled, set_prototypes.py FORESTS)
      { model: 'set-avalanche-forest-a', u: 0.26874, lat: 15.782 },
      { model: 'set-avalanche-forest-b', u: 0.31176, lat: 13.474 },
      { model: 'set-avalanche-forest-c', u: 0.34204, lat: 17.811, yaw: 0.07 },
      { model: 'set-avalanche-forest-d', u: 0.39249, lat: 17.56, yaw: -0.07 },
      { model: 'set-avalanche-forest-e', u: 0.41946, lat: 16.961 },
      { model: 'set-avalanche-forest-f', u: 0.09438, lat: -10.712, yaw: -0.09 },
      { model: 'set-avalanche-forest-g', u: 0.57158, lat: -13.602, yaw: -0.01 },
      { model: 'set-avalanche-forest-h', u: 0.03025, lat: 11.75 },
      // forest on the cirque's lower faces up to a ragged treeline, trimmed
      // along the slide's chute (sampled, set_prototypes.py FORESTS)
      { model: 'set-avalanche-forest-i', u: 0.71608, lat: 28.244, yaw: 0.03 },
      { model: 'set-avalanche-forest-j', u: 0.77781, lat: 25.615, yaw: 0.37 },
      { model: 'set-avalanche-forest-k', u: 0.84585, lat: 16.161, yaw: 0.85 },
      { model: 'set-avalanche-slope', u: 0.86991, lat: 14.172, yaw: 19.99 },
      { model: 'set-avalanche-slope', u: 0.10013, lat: -32.543, yaw: 159.42 },
      // Where the road runs under the mountains, on the outside of the last
      // loop, it is cut into the mountainside and roofed over: two galleries,
      // each with the cut it stands in, astride the road. The shorter on the
      // run to the slide's foot, in the cut through the spur's toe; the
      // longer on the straight after the slide. Each piece carries the road's
      // centreline and the land beside it in its own frame (set_prototypes.py
      // ROAD_A/FACE_A, ROAD_B/FACE_B), so a gallery's u here, its samples
      // there and the land below move together: re-sample them after either.
      { model: 'set-avalanche-gallery-short', u: 0.7216, lat: 0 },
      { model: 'set-avalanche-gallery', u: 0.8245, lat: 0 },
      // the third, on the run west along the top loop under the mountainside,
      // where the third avalanche path comes down onto its roof; the plough at
      // work at its east mouth (set_prototypes.py ROAD_C / FACE_C: re-sample
      // with the road or the land)
      { model: 'set-avalanche-gallery-loop', u: 0.3701, lat: 0, yaw: -0.36 },
      // the crags the southern massif's crest breaks out in (`land`): the
      // snow keeps their 9 u facets, rock in them read as stripes on a dome.
      // (The western massif's summit crags were hidden by the spur from
      // every seat; its east face's ribs carry its rock.)
      { model: 'set-avalanche-crags', u: 0.83458, lat: 51.916, yaw: 3.11 },
      // the high peaks the slides start from, east of the mountainside, its
      // stands their foothills (the piece's frame is the world's: yaw cancels
      // the road's heading at u 0.276)
      { model: 'set-avalanche-peaks-east', u: 0.27549, lat: 48.288, yaw: -167.06 },
      // the cirque's faces: ribs of rock down their fall lines, a cornice and
      // a band of rock over the slide's crown, a piece a face so no footprint
      // spans the loop (the frames the world's)
      { model: 'set-avalanche-ribs-w', u: 0.70702, lat: 38.664, yaw: 25.16 },
      { model: 'set-avalanche-ribs-slide', u: 0.76558, lat: 40.938, yaw: -29.84 },
      // big old firs in the wedge inside the S-bend (sampled, set_prototypes.py FORESTS)
      { model: 'set-avalanche-forest-l', u: 0.99355, lat: 17.14 },
      // firs up the north-west face of the cirque's south slope to a ragged
      // treeline: the one bare dome the run to the last loop looked at (the
      // full tier's: the box's cells barely see it)
      { model: 'set-avalanche-forest-m', u: 0.8699, lat: 28.174, yaw: -0.06, lite: false }
    ],
    // The mountains round the last loop, its outside a cirque the slide comes
    // down into: a spur off the western massif runs down to the kerb, the
    // short gallery's cut through its toe; the southern massif's flank stands
    // off the verge along the long gallery's straight, a peak on it and a
    // lower one toward the cirque's slope. Every flank stands `near` the kerb
    // (the galleries' cuts stand in front of it) and joins the slide's
    // mountain either side of its chute, clear of its forest. The cirque's
    // land and what stands on it (the slide, its ribs and crags, its forests,
    // the two galleries) were made together: their rows hold each where the
    // others expect it, so move them together where the lap's centre line
    // moves under them.
    land: [
      { kind: 'ridge', u: 0.71514, lat: 23.625, yaw: -100.97, x: -0.8, len: 32, r: 10, r1: 24, h: 8, h1: 14, top: 0.3, near: 3.8 },
      { kind: 'ridge', u: 0.70861, lat: 67.239, yaw: 0.21, x: 0.6, z: -1.5, r: 62, h: 28, top: 0.1, near: 3.8 },
      { kind: 'ridge', u: 0.83458, lat: 51.916, yaw: 3.11, len: 20, r: 62, h: 28, top: 0.1, near: 3.8 },
      { kind: 'ridge', u: 0.83736, lat: 63.706, yaw: 0.31, r: 20, h: 10, near: 3.8 },
      { kind: 'ridge', u: 0.85835, lat: 60.3, yaw: 0.03, x: -4.4, z: 2.6, r: 40, h: 18, top: 0.1, near: 3.8 },
      // no rock cluster on the open snow the run to the loop looks over: it
      // stood alone on the plain like a dropped asset
      { kind: 'clear', u: 0.60689, lat: -9.989, yaw: 0.04, r: 1 },
      // The mountainside outside the top loop: foothills rising off the
      // verge (their flanks low where the near ramp ends) round its east end
      // and its north-west corner, and over the run west where the third
      // snow shed stands, its face at the kerb, steep as the cirque's (the
      // shed's cut stands in front of it); the massif behind, reaching no
      // further than the track's own region (a form past it moves the
      // ground's grid, and the galleries' cuts stand on that ground as it was
      // sampled); a spur on the S-bend's outside. Down it, three paths the
      // slides keep clear of forest, their snow churned (paint).
      { kind: 'ridge', u: 0.28053, lat: 32.663, z: -0.65, r: 30, h: 13, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.31498, lat: 32.696, z: -0.68, r: 30, h: 14, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.40798, lat: 29.401, z: 0.52, r: 26, h: 11, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.3524, lat: 24.878, yaw: 158.61, len: 10, r: 26, h: 18, top: 0.15, near: 3.8 },
      { kind: 'ridge', u: 0.33332, lat: 43.274, z: -0.75, r: 24, h: 18, top: 0.12 },
      { kind: 'ridge', u: 0.30088, lat: 46.082, z: 0.56, r: 28, h: 16, top: 0.12 },
      { kind: 'ridge', u: 0.38842, lat: 42.883, yaw: -0.15, r: 28, h: 16, top: 0.12 },
      { kind: 'ridge', u: 0.57369, lat: -29.322, yaw: -0.02, r: 26, h: 11, top: 0.2, near: 2 },
      // The ground's region held where the warning signs' cones set it (east
      // and south) before this mountainside replaced them: a region that
      // moves moves every vertex of the ground's 9 u grid, and the cirque's
      // faces and the two cirque galleries' cuts (sampled, ROAD_A/FACE_A,
      // ROAD_B/FACE_B) stand on the ground as it was drawn. Each clears a
      // unit of scatter and does nothing else.
      { kind: 'clear', u: 0.27726, lat: 0, yaw: -168.87, x: 89.0467, z: 6.5189, r: 1 },
      { kind: 'clear', u: 0.37413, lat: 0, yaw: 93.25, x: -4.1748, z: -82.9726, r: 1 },
      // the west slope's foot brought down to the turn, its path churned
      { kind: 'ridge', u: 0.09439, lat: -27.783, yaw: -0.05, z: 0.6, r: 24, h: 10, top: 0.2, near: 2 },
      { kind: 'paint', u: 0.09714, lat: -15.771, yaw: 119.06, x: 0.57, len: 22, r: 3, w: 3, tint: 0xc8cfdf },
      { kind: 'paint', u: 0.28144, lat: 18.959, yaw: -87.3, len: 28, r: 3, w: 3, tint: 0xc8cfdf },
      { kind: 'paint', u: 0.33332, lat: 19.866, yaw: 99.3, x: 0.51, len: 32, r: 3, w: 3, tint: 0xc8cfdf },
      { kind: 'paint', u: 0.36724, lat: 19.426, yaw: 82.99, len: 30, r: 3, w: 3, tint: 0xc8cfdf },
      // under each gallery's roof no snow: the road's kerb a concrete
      // kerbstone and paving there, from a little outside one mouth to a
      // little outside the other (set_prototypes.py gallery_shed's samples)
      { kind: 'shed', u: 0.7212, len: 12.6 },
      { kind: 'shed', u: 0.8254, len: 31.6 },
      { kind: 'shed', u: 0.37, len: 27.6 }
    ]
  },
  // Backyard Cup — SEEDED multi-crossing circuits (overpasses on their own ramps,
  // decorated mid profile; auto-placed furniture).
  ribbon: {
    name: 'Ribbon', sand: STRIP, waypoints: GEN_TRACKS.ribbon,
    oils: genFurn('ribbon').oils, pads: genFurn('ribbon').pads, boxes: genFurn('ribbon').boxes,
    // The village in its valley, and the farms round it. The church on the
    // east terrace where the grid straight looks, the maypole on its green;
    // the long diagonal runs down the village street, cottages on both sides
    // with their doors and open front lawns on a pavement at the road's own
    // level, the kerb a kerbstone there (the `street`); another row of
    // cottages at the west bend's exit, washing out in the gardens. The fete
    // is on beside the grid straight. The orchard at the south hill's foot
    // rings the south loop, a block of trees laid along the road at each spot,
    // turned either way round, two tall poplars at the band's far end (at its
    // near end they stood in the view of the church): the lap's only poplars,
    // every other tree the orchard's. The
    // windmill turns in the north loop beside its wheat field, a rectangle
    // well inside the kerbs, its sails and door turned to the flyover's way
    // down, where a racer comes at it (square to the loop's top it showed
    // them its back); the sheep graze round the loop's outside and
    // under the flyover, their fold of timber hurdles and its post-and-rail
    // fences up the north-east hill where the loop turns under it, and the
    // dairy farm stands on its bank outside the west bend, straight ahead of
    // a racer coming out from under the flyover, its paddock fenced and its
    // lane down to the road. Its fence carries on round the bend past it
    // along the hill's foot (set-farm-fence, two lengths). The church is the village's tallest thing, a quarter
    // over its real size like the cup's other heroes, in a walled yard by
    // the road with its lychgate to it. A
    // piece's box holds the verge band down under it (bandHold), so nothing
    // here is one piece over a whole loop: every box keeps 2 u or more off
    // the kerbs, and the road keeps its verge.
    set: [
      { model: 'set-village-church', u: 0.31942, lat: 13.497, yaw: 39.34, scale: 1.25 },
      { model: 'set-village-street', u: 0.37652, lat: 4, yaw: 1 },
      { model: 'set-village-street-b', u: 0.41067, lat: 4, yaw: 0 },
      { model: 'set-village-street-c', u: 0.37901, lat: -4.05, yaw: -180 },
      { model: 'set-village-street-d', u: 0.41787, lat: -4, yaw: -180 },
      { model: 'set-cottage-row', u: 0.60733, lat: -7.582, yaw: 173.25 },
      { model: 'set-windmill', u: 0.5984, lat: 11.845, yaw: 163.45 },
      { model: 'set-field-wheat', u: 0.69642, lat: 12.001, yaw: 7.7 },
      { model: 'set-village-fete', u: 0.01258, lat: 8.6, yaw: 0 },
      { model: 'set-orchard-block', u: 0.12685, lat: -7.5 },
      { model: 'set-orchard-block', u: 0.14047, lat: -7.5, yaw: 180 },
      { model: 'set-orchard-block-b', u: 0.1546, lat: -7.5, yaw: 180 },
      { model: 'set-orchard-block', u: 0.16419, lat: -7.5 },
      { model: 'set-orchard-block', u: 0.18287, lat: -7.502, yaw: 180 },
      { model: 'set-orchard-block-b', u: 0.19246, lat: -7.502, yaw: 180 },
      { model: 'set-orchard-block', u: 0.20112, lat: -7.499, yaw: 1.05 },
      { model: 'set-orchard-block', u: 0.21899, lat: -7.457, yaw: -177.06 },
      { model: 'set-orchard-block-b', u: 0.22916, lat: -8.391, yaw: -179.63 },
      { model: 'set-orchard-block', u: 0.23904, lat: -8.595, yaw: -0.87 },
      { model: 'set-orchard-block', u: 0.24972, lat: -8.522, yaw: 175.73 },
      { model: 'set-orchard-block-end', u: 0.25895, lat: -7.659, yaw: -3.13 },
      { model: 'set-cow-farm', u: 0.84702, lat: 9.722, yaw: -15.71, scale: 1.3 },
      { model: 'set-farm-fence', u: 0.88188, lat: 6.165, yaw: -9.43, scale: 1.3, lite: false },
      { model: 'set-farm-fence', u: 0.9135, lat: 6.853, yaw: -2.53, scale: 1.3, lite: false },
      { model: 'set-sheep-meadow', u: 0.69874, lat: -8.001, yaw: -180 },
      { model: 'set-sheep-flock', u: 0.75708, lat: -6.8, yaw: 179.85 },
      { model: 'set-sheepfold', u: 0.67452, lat: -8.501, yaw: -180 },
      { model: 'set-hay-meadow', u: 0.45653, lat: -9, yaw: 180 }
    ],
    // the valley the village lies in: the west side rises off the west
    // bend's verge (`near`) to a terrace above it, the east terraces climb
    // behind the street, the south hill stands behind the orchard and the
    // north-east hill behind the sheep; past the street's end the west side
    // comes down to the verge as a hay bank, and outside the west bend's
    // entry the farm's bank rises off the verge the same way, its face to the
    // road so the herd shows up it
    land: [
      { kind: 'ridge', u: 0.91429, lat: 23.098, yaw: -4.07, len: 44, r: 20, h: 7, top: 0.25, near: 0.6 },
      { kind: 'ridge', u: 0.92693, lat: 29.814, yaw: 2.72, len: 100, r: 9, h: 3, top: 0.45 },
      { kind: 'ridge', u: 0.38031, lat: 25.918, yaw: 156.65, len: 120, r: 16, h: 3, top: 0.6 },
      { kind: 'ridge', u: 0.37334, lat: 34.182, yaw: 157.64, len: 100, r: 9, h: 3, top: 0.45 },
      { kind: 'ridge', u: 0.20082, lat: -36.005, yaw: 0.42, len: 60, r: 24, h: 8, top: 0.35 },
      { kind: 'ridge', u: 0.65859, lat: -22.002, r: 24, h: 9, top: 0.15 },
      { kind: 'ridge', u: 0.45653, lat: -13.3, len: 10, r: 10, h: 3, top: 0.4, near: 0.6 },
      { kind: 'ridge', u: 0.83855, lat: 16.438, yaw: -22.61, len: 8, r: 14, h: 3.2, top: 0.25, near: 0.6 },
      { kind: 'street', u: 0.39565, len: 32 }
    ]
  },
  pretzel: {
    name: 'Pretzel', sand: STRIP, waypoints: GEN_TRACKS.pretzel,
    oils: genFurn('pretzel').oils, pads: genFurn('pretzel').pads, boxes: genFurn('pretzel').boxes,
    // The children's summer on sun-yellowed downs (the theme's ground colour;
    // theme.cc backyardTrack): the treehouse oak on the flat outside the
    // north-west bend, straight ahead down the avenue of oaks the diagonal
    // ends in; the pitch beside the diagonal, greener than the downs, bunting
    // down its road-side touchline; the children's blanket den under its oak
    // where the racer comes off the diagonal's top; under great oaks out
    // by the bends a picnic left out and a hay wain loaded; a copse of the
    // downs' oaks on the face of the
    // down the road heads at before the bottom bend;
    // the kite hill rising off the verge beyond the top loop, three kites
    // flying low over its foot from stakes up the slope, and a camp of bell
    // tents up the next down's face past it. Nobody is about (children
    // that small read as specks). The other trees a racer passes are the
    // lawn's own scatter of the garden's broadleaf oaks.
    set: [
      { model: 'set-avenue-oaks', u: 0.01011, lat: 5.5, yaw: 0 },
      { model: 'set-avenue-oaks', u: 0.01011, lat: -5.5, yaw: 180 },
      { model: 'set-treehouse', u: 0.05555, lat: 10.59, yaw: 22.55, scale: 1.3 },
      { model: 'set-football-pitch', u: 0.91401, lat: -8.6, yaw: 1.41 },
      { model: 'set-den-camp', u: 0.56501, lat: 8.301, scale: 1.4 },
      { model: 'set-swing-oak', u: 0.16895, lat: 7.5, yaw: 39.71 },
      { model: 'set-swing-oak', u: 0.75513, lat: -9, yaw: 142.48 },
      { model: 'set-picnic-oak', u: 0.8592, lat: 7.5, yaw: 0, scale: 1.35 },
      { model: 'set-hay-wain-oak', u: 0.51977, lat: 7.002, yaw: 0, scale: 1.35 },
      { model: 'set-kite-flyers', u: 0.71571, lat: -9, yaw: 179.51, scale: 1.4 },
      { model: 'set-oak-copse', u: 0.37588, lat: 12.951, yaw: 30.26, scale: 1.3 },
      { model: 'set-summer-camp', u: 0.77505, lat: -7.701, yaw: 179.91, scale: 1.6 }
    ],
    // low wide downs round the lap's outsides, each rising off the verge
    // (`near`) gently enough to keep its grass (a steep face goes to earth)
    land: [
      { kind: 'clear', u: 0.01011, len: 28, r: 14 },
      { kind: 'ridge', u: 0.71593, lat: -20.999, yaw: -0.47, len: 22, r: 20, h: 7, top: 0.2, near: 0.6 },
      { kind: 'ridge', u: 0.67439, lat: -15.022, yaw: 0.31, len: 8, r: 14, h: 4, top: 0.2, near: 0.6 },
      { kind: 'ridge', u: 0.80896, lat: -18, len: 16, r: 15, h: 4.5, top: 0.2, near: 0.6 },
      { kind: 'ridge', u: 0.10866, lat: 27, len: 30, r: 22, h: 6, top: 0.15, near: 0.6 },
      { kind: 'ridge', u: 0.57566, lat: 30.004, yaw: 0.01, r: 20, h: 6.5, top: 0.15 },
      { kind: 'ridge', u: 0.37677, lat: 27.944, yaw: 3.21, len: 30, r: 22, h: 6.5, top: 0.15, near: 0.6 }
    ]
  },
  tangle: {
    name: 'Tangle', sand: STRIP, waypoints: GEN_TRACKS.tangle,
    oils: genFurn('tangle').oils, pads: genFurn('tangle').pads, boxes: genFurn('tangle').boxes,
    // The mill valley: wooded sides (set-mill-wood, -b, -c: three woods on the hills in `land`)
    // and the brook down its floor, set below its slate walls (set-brook-*,
    // laid in the world and cut into lengths). It rises at the springhouse
    // beyond the north loop's top straight, runs down an open rill to the
    // road and under it, comes out by the kerb and down the north loop,
    // under the start straight, down that straight's left kerb to the line
    // (a sluice and a timber footbridge on it there), under the second
    // bridge with it, back under the road and round the outside of the
    // first bend through the watermill's race, straight ahead of the grid,
    // its wheel turning in the water to the oncoming cars, and over a sill
    // into the duck pond under the first bridge's west span (`pond`; reeds
    // and a willow on its far bank, a jetty, a second willow and a duck
    // house by the shore the low road passes). The road CROSSES the brook
    // three times, and at each a low stone parapet stands along the kerb on
    // both sides (set-brook-parapet, its arch to the water), the brook
    // running to the foot of one and away from the other (each reach ends
    // inside the wall, cut off along it). The valley's timber
    // is worked at the mill's yard on a bank outside the south loop
    // (set-mill-yard).
    set: [
      { model: 'set-watermill', u: 0.09429, lat: 9.587, yaw: -0.33 },
      { model: 'set-mill-wood', u: 0.88446, lat: -12, yaw: -180 },
      { model: 'set-mill-wood-b', u: 0.91963, lat: -12.5, yaw: -180 },
      { model: 'set-mill-wood-c', u: 0.95479, lat: -12, yaw: 180 },
      { model: 'set-mill-wood', u: 0.995, lat: 10.5, yaw: 0 },
      { model: 'set-mill-wood-b', u: 0.03014, lat: 12.5, yaw: 0 },
      { model: 'set-mill-wood-c', u: 0.57949, lat: -8.5, yaw: -179.97 },
      { model: 'set-mill-wood', u: 0.60956, lat: -8.505, yaw: -180 },
      { model: 'set-mill-wood-b', u: 0.28738, lat: -9.002, yaw: -179.99 },
      { model: 'set-mill-wood-c', u: 0.78961, lat: -9.031, yaw: 178.59 },
      { model: 'set-mill-wood', u: 0.0967, lat: 21.275, yaw: 17.54 },
      { model: 'set-brook-parapet', u: 0.84748, lat: 3.9, yaw: 0, y: 0.26 },
      { model: 'set-brook-parapet', u: 0.86087, lat: -3.9, yaw: -180, y: 0.2 },
      { model: 'set-brook-parapet', u: 0.02407, lat: -3.9, yaw: 180 },
      { model: 'set-brook-parapet', u: 0.03768, lat: 3.9, yaw: 0 },
      { model: 'set-brook-parapet', u: 0.73257, lat: -3.901, yaw: 180, y: -0.19 },
      { model: 'set-brook-parapet', u: 0.73357, lat: 3.901, yaw: 0 },
      { model: 'set-mill-yard', u: 0.32633, lat: -12.482, yaw: -178.3 },
      { model: 'set-brook-a', u: 0.74153, lat: 11.906, yaw: -76.76 },
      { model: 'set-brook-b', u: 0.89048, lat: -8.088, yaw: 4.96 },
      { model: 'set-brook-c', u: 0.94452, lat: -8.554, yaw: 2.15 },
      { model: 'set-brook-d', u: 0.99622, lat: -7.232, yaw: -7.68 },
      { model: 'set-brook-e', u: 0.06509, lat: 8.634, yaw: -5.47 },
      { model: 'set-brook-f', u: 0.09674, lat: 8, yaw: -1.9 },
      { model: 'set-brook-g', u: 0.12556, lat: 10.621, yaw: -15.75 },
      { model: 'set-pond-ducks', u: 0.14914, lat: -9.43, yaw: -180 },
      { model: 'set-springhouse', u: 0.73297, lat: -7.801, yaw: 180 },
      { model: 'set-alder-grove', u: 0.28236, lat: -5.801, yaw: -180, scale: 1.1 },
      { model: 'set-alder-grove', u: 0.67992, lat: -5.8, yaw: 180 },
      { model: 'set-alder-grove', u: 0.75448, lat: -11.996, yaw: -178.63, scale: 1.2 },
      { model: 'set-alder-grove', u: 0.90456, lat: 5.8, yaw: 0, scale: 0.9 },
      { model: 'set-alder-grove', u: 0.9578, lat: -5.3, yaw: -180 },
      { model: 'set-alder-grove', u: 0.03014, lat: 5.8, yaw: 0, scale: 1.1 }
    ],
    // the north lawn's hump and the pond under the first bridge; the valley's
    // sides: a hill beyond the stream on each side of the start straight,
    // standing far enough off both strands that its flank is low where it
    // meets the stream (nearer, it stood as a cliff and tipped the reach),
    // the mill's hill behind it, the spring's hill along the north loop's
    // top straight, and hills outside the east loop and the north-east bend;
    // the timber yard's bank outside the south loop's apex, low and flat on
    // top, rising off the verge
    land: [
      // the mill yard's cart track where it meets the kerb: a drape claims no
      // ground, so this keeps the scatter's trees off it
      { kind: 'clear', u: 0.32669, lat: -5.54, len: 4, r: 1.8 },
      { kind: 'ridge', u: 0.32624, lat: -15.981, yaw: 1.49, len: 8, r: 15, h: 1.8, top: 0.35, near: 0.6 },
      { kind: 'ridge', u: 0.39032, lat: -26.741, yaw: 146.41, r: 12, h: 3, top: 0.2 },
      { kind: 'pond', u: 0.14883, lat: -1.93, yaw: 89.13, len: 15, r: 5.3, w: 6 },
      { kind: 'ridge', u: 0.05405, lat: 32.83, yaw: 8.07, len: 23, r: 26, h: 9, top: 0.1, near: 10.5 },
      { kind: 'ridge', u: 0.8934, lat: -34.871, yaw: 1.04, len: 18, r: 28, h: 9, top: 0.1, near: 7.5 },
      { kind: 'ridge', u: 0.09544, lat: 34.859, yaw: -0.17, r: 24, h: 8, top: 0.1 },
      { kind: 'ridge', u: 0.75554, lat: -20.285, yaw: 1.92, len: 20, r: 15, h: 6.5, top: 0.25, near: 0.6 },
      { kind: 'ridge', u: 0.65982, lat: -20.001, yaw: 0.01, len: 12, r: 15, h: 4.5, top: 0.3, near: 0.6 },
      { kind: 'ridge', u: 0.28537, lat: -22.004, yaw: 0.01, len: 14, r: 20, h: 7.5, top: 0.15, near: 0.6 },
      { kind: 'ridge', u: 0.79076, lat: -24.038, yaw: -0.71, r: 22, h: 7.5, top: 0.1, near: 0.6 }
    ]
  },
  cloverleaf: {
    name: 'Cloverleaf', sand: STRIP, waypoints: GEN_TRACKS.cloverleaf,
    oils: genFurn('cloverleaf').oils, pads: genFurn('cloverleaf').pads, boxes: genFurn('cloverleaf').boxes,
    // A spring park: cherries in pale blossom, planted as a park plants them,
    // in avenues beside the straights (set-cherry-avenue) and in groves at the
    // bends, few alone on the lawn. The park's miniature railway runs from a
    // loop by the start straight, under the high road, along the foot of the
    // bandstand's knoll and along the finger lobe to a loop by the lake, a
    // halt at each end, its one train going out and back (set-park-rails-*,
    // one line cut into lengths in set_prototypes.py PARK_ROUTE; it crosses
    // no road at grade and lies on a graded bed, never facet by facet). The playground on the flat outside the south-west hairpin,
    // where the start straight points, between the bend and the foot of its
    // hill: the fenced yard (set-playground: the big frames, a slide down the
    // hill itself, swings, the toddlers' corner, a forecourt to the kerb),
    // the park round it (set-playground-lawn: hedge and cherries behind, a
    // picnic lawn, flower beds, and the paths, one round the bend into the
    // cherry avenue's walk), its ball court across the front path
    // (set-playground-court) and the walk round its back under more cherries
    // (set-playground-grove), four pieces on one anchor. On the open lawns
    // either side of it, on that anchor too, each with the walk that joins it
    // to the park's paths: a carousel and its ice-cream cart past the court
    // (set-park-carousel), a hedge maze up the lawn behind it
    // (set-hedge-maze), and across the yard by the bend's path a crazy golf
    // round a windmill (set-crazy-golf). The bandstand on its mound close under the
    // high road's outside, level with a racer up on the deck. The boating
    // lake beyond the finger lobe's end, straight ahead down the lobe's first
    // leg: a round pond under a stone lip, an islet with a cherry on it, a
    // stone fountain with a tall jet, swans swimming round, the
    // boathouse on the near shore, and across the water on the far one a
    // row of lamps and big cherries. The park's kiosk and its
    // terrace of parasols in the S between the two decks, a grove beside the
    // high deck's way down; a floral clock on the face of the hill outside
    // the top bend and a bed of carpet bedding along the foothill by the
    // west straight, both planted on slopes that face the road.
    set: [
      { model: 'set-playground', u: 0.0858, lat: -9.988, yaw: 150.07, scale: 1.5 },
      { model: 'set-playground-lawn', u: 0.0858, lat: -9.988, yaw: 150.07, scale: 1.5 },
      { model: 'set-playground-court', u: 0.0858, lat: -9.988, yaw: 150.07, scale: 1.5 },
      { model: 'set-playground-grove', u: 0.0858, lat: -9.988, yaw: 150.07, scale: 1.5 },
      { model: 'set-park-kiosk', u: 0.40056, lat: -9.507, yaw: 142.61, y: -0.1, scale: 1.45 },
      { model: 'set-floral-clock', u: 0.44766, lat: -8.482, yaw: -177.46 },
      { model: 'set-carpet-bed', u: 0.49329, lat: -8.059, yaw: 172.19 },
      { model: 'set-park-railway', u: 0.01741, lat: 6.485, yaw: -179.64 },
      { model: 'set-park-rails-a', u: 0.25549, lat: 4.834, yaw: 92.1 },
      { model: 'set-park-rails-b', u: 0.66985, lat: -8.404, yaw: -1.15 },
      { model: 'set-park-rails-c', u: 0.92006, lat: 8.496, yaw: -157.04 },
      { model: 'set-park-rails-d', u: 0.89001, lat: 12.245, yaw: -176.5 },
      { model: 'set-park-rails-e', u: 0.86169, lat: 12.555, yaw: -167.7 },
      { model: 'set-park-rails-loop-a', u: 0.03894, lat: 7.606, yaw: -12.86 },
      { model: 'set-park-rails-loop-b', u: 0.84471, lat: 19.474, yaw: -1.64 },
      { model: 'set-park-halt', u: 0.8617, lat: 12.533, yaw: -170.69 },
      { model: 'set-boating-lake', u: 0.83132, lat: 16.159, yaw: -170.52 },
      { model: 'set-lake-shore', u: 0.83132, lat: 16.159, yaw: -170.52 },
      { model: 'set-boathouse', u: 0.82473, lat: 12.253, yaw: 39.02, scale: 1.3 },
      { model: 'set-bandstand', u: 0.22472, lat: -22.003, yaw: -179.99, scale: 1.5 },
      { model: 'set-cherry-avenue', u: 0.14379, lat: -6.499, yaw: 180 },
      { model: 'set-cherry-avenue', u: 0.52381, lat: -6.487, yaw: 180 },
      { model: 'set-cherry-avenue', u: 0.78566, lat: 6.495, yaw: 0.01 },
      { model: 'set-cherry-avenue', u: 0.88918, lat: 6.5, yaw: 0 },
      { model: 'set-blossom-grove-b', u: 0.20921, lat: -6.8, yaw: -180 },
      { model: 'set-blossom-grove-b', u: 0.34517, lat: 7.505, yaw: -0.01, scale: 1.25 },
      { model: 'set-blossom-grove-b', u: 0.38042, lat: 6.404, yaw: 0.01 },
      { model: 'set-blossom-grove', u: 0.46966, lat: -5.771, yaw: 179.86, scale: 1.1 },
      { model: 'set-blossom-grove-b', u: 0.59934, lat: -5.991, yaw: 180 },
      { model: 'set-blossom-grove', u: 0.84428, lat: 8.496, yaw: 0.64 },
      // the lawns either side of the playground, on its anchor (rows
      // appended: a landform names its piece by row)
      { model: 'set-park-carousel', u: 0.0858, lat: -9.988, yaw: 150.07, scale: 1.5 },
      { model: 'set-hedge-maze', u: 0.0858, lat: -9.988, yaw: 150.07, scale: 1.5 },
      { model: 'set-crazy-golf', u: 0.0858, lat: -9.988, yaw: 150.07, scale: 1.5 }
    ],
    // the round hill beyond the south bend and a long ridge closing the west,
    // the playground's hill (its slide lies on it), the lake and the hill behind it, the bandstand's
    // mound (clear of the raised road's stilts), foothills at the S's west
    // leg and beyond the top bend
    land: [
      { kind: 'ridge', u: 0.19914, lat: -47.999, yaw: 0.01, r: 32, h: 10, top: 0.15 },
      { kind: 'ridge', u: 0.08911, lat: -33.958, yaw: 0.04, r: 20, h: 6, top: 0.2 },
      { kind: 'ridge', u: 0.51876, lat: -49.923, len: 70, r: 26, h: 7, top: 0.2 },
      { kind: 'pond', u: 0.83132, lat: 16.159, yaw: -170.52, len: 4, r: 10, w: 4, tint: 0x8fc2b0 },
      // the lake's shore, level a grid cell past its rim all round, and its
      // hill standing back that far: nearer, the lawn's 9 u chords climbed
      // over the coping and cut across the water
      { kind: 'plain', u: 0.83132, lat: 16.159, yaw: -170.52, len: 4, r: 15, w: 6 },
      { kind: 'ridge', u: 0.83305, lat: 47.496, yaw: -177.66, len: 30, r: 16, h: 7, top: 0.25 },
      { kind: 'ridge', u: 0.51374, lat: -17.271, len: 28, r: 14, h: 5, top: 0.3, near: 0.6 },
      { kind: 'ridge', u: 0.4473, lat: -17.042, yaw: 1.73, r: 18, h: 6, top: 0.3, near: 0.6 }
    ]
  },
  // Canyon Cup — SEEDED hard circuits (scan-seeds `hard` profile: hairpins, stacked
  // crossings, width pinches, crest hills; auto-placed furniture).
  wash: {
    name: 'Wash', sand: STRIP, waypoints: GEN_TRACKS.wash,
    oils: genFurn('wash').oils, pads: genFurn('wash').pads, boxes: genFurn('wash').boxes,
    // A dry wash and the canyon it cut: out of the start the road drops into
    // the wash's canyon, mountainsides of banded rock rising from both verges
    // down the straight and round the outside of the bend (set-canyon-peaks,
    // set-canyon-spur and set-canyon-bend-wash, the ridges in `land` carrying
    // the range on behind them), the inside of the bend left open so the
    // road ahead stays in sight. Out on the plain the wash winds across the
    // whole map, its gravel bed laid reach by reach (set-wash-bed, each
    // bringing its channel; the far north-west reaches, out of a racer's
    // sight, are channel only, in `land`), from the north-west past the
    // hero's stretch by the north straight,
    // across the north strand, which fords it at the bed's level, into the
    // east loop, where the road itself runs down the bed from ford to ford
    // (set-wash-road-reach: gravel from bank to bank, a cut bank a car's
    // roof high past each kerb, the last flood's log jam on the bar, and a
    // flood gauge where the road goes down to the first ford), and out under the east bend's low trestle (gen-tracks SEEDS
    // `trestle`: the bend's hill stands on pillars over the bed, not on an
    // embankment across it); a side wash comes in from the south across the
    // south strand, another ford. The bed is a shallow
    // channel, so what a racer sees of the wash where the road leaves it is
    // what grows along it: saguaros, ocotillo and
    // brush on its banks (each reach brings a stand on each side), and a
    // dead cottonwood standing bare over the start's bends, a vulture on
    // it, a second one fallen beside it. The high road runs along a sandstone bench over the two low
    // strands, a butte of the strata stands in the knot of strands, and
    // mustangs drink at a tinaja past the east loop. A desert of rock,
    // sand and cactus: nothing green but cactus.
    set: [
      // (a reach a road crosses is a ford: its banks stop on the road's half)
      { model: 'set-dry-creek', u: 0.92156, lat: -16.974, yaw: 112.11 },
      { model: 'set-dead-cottonwood', u: 0.32313, lat: 12 },   // (nearer, it stood on the start's bends' strip below)
      { model: 'set-fallen-cottonwood', u: 0.9497, lat: -7, yaw: -150 },
      { model: 'set-wash-bed', u: 0.70829, lat: -23, yaw: -144 },   // (where it lay before the strip pushed it out)
      { model: 'set-wash-bed-ford', u: 0.68127, lat: -3.6, yaw: 77 },
      { model: 'set-wash-bed-ford', u: 0.60049, lat: 10.7, yaw: -64 },
      { model: 'set-wash-bed-ford', u: 0.59485, lat: -19, yaw: 87 },
      // (the east and south arms' last reaches run out into the plain)
      { model: 'set-wash-bed-end', u: 0.59405, lat: -48.9, yaw: 95 },
      { model: 'set-wash-bed-end', u: 0.54012, lat: -46.499, yaw: 78 },
      { model: 'set-wash-bed-ford', u: 0.53359, lat: -19.603, yaw: 68 },
      { model: 'set-wash-bed-ford', u: 0.5185, lat: 8.804, yaw: -91 },
      // between the east loop's two fords the road runs down the bed itself,
      // a cut bank past each kerb, and the last flood's log jam on the bar
      { model: 'set-wash-road-reach', u: 0.53741, lat: 0 },
      { model: 'set-wash-road-reach', u: 0.5535, lat: 0 },
      { model: 'set-flood-jam', u: 0.55853, lat: -5.698, yaw: -180 },
      { model: 'set-wash-road-reach', u: 0.61286, lat: 0 },
      { model: 'set-wash-road-reach', u: 0.62896, lat: 0 },
      // (the loop's last reaches stand a little to its inside: each is
      // straight, and with the strip at the kerb its inner bank's far end
      // stood on it)
      { model: 'set-wash-road-reach', u: 0.64505, lat: 0.5 },
      { model: 'set-wash-road-reach', u: 0.66115, lat: 0.5 },
      { model: 'set-wash-road-reach', u: 0.67523, lat: 0.75 },
      // the canyon's mountainsides, each face toward the road: the outer
      // range (left) down the straight, round the bend and on, lower spurs
      // on the inside of the straight and after the bend, the inside of the
      // bend left open so the road ahead stays in sight
      { model: 'set-canyon-peaks-a', u: 0.01994, lat: -5.2, yaw: -180 },
      { model: 'set-canyon-peaks-b', u: 0.05855, lat: -5.2, yaw: 180 },
      { model: 'set-canyon-bend-wash', u: 0.10012, lat: -5.198, yaw: 179.23 },
      { model: 'set-canyon-peaks-c', u: 0.14301, lat: -5.2, yaw: -179.99 },
      { model: 'set-canyon-spur-a', u: 0.04416, lat: 5.2 },
      { model: 'set-canyon-spur-b', u: 0.14854, lat: 5.2 },
      // a butte of the strata inside the low hairpin, and the tinaja where
      // the side wash meets the road past the east loop, burros at it
      { model: 'set-wash-butte', u: 0.84917, lat: -9.998, yaw: 1.39, scale: 0.75 },
      { model: 'set-bench-ledge', u: 0.31408, lat: -9, yaw: 174 },   // (its far end clear of the low strand's strip)
      // (at its own size: grown, its mustangs stood twice a car's length)
      { model: 'set-tinaja', u: 0.71645, lat: -5.5, yaw: -180 },
      // the flood gauge where the road goes down to the first ford, the
      // last flood's wrack stranded at its foot
      { model: 'set-flood-gauge', u: 0.50723, lat: 4.4 }
    ],
    // the range the canyon's mountainsides belong to, rising behind them
    land: [
      { kind: 'ridge', u: 0.03022, lat: -25, len: 30, r: 14, h: 9, top: 0.45, tint: 0xc8846a },
      { kind: 'ridge', u: 0.09927, lat: -24.997, yaw: -0.27, len: 8, r: 14, h: 10, top: 0.45, tint: 0xc8846a },
      { kind: 'ridge', u: 0.14814, lat: -24.998, len: 14, r: 14, h: 7.5, top: 0.45, tint: 0xc8846a },
      { kind: 'ridge', u: 0.04426, lat: 18, len: 18, r: 11, h: 6, top: 0.4, tint: 0xc8846a },
      { kind: 'ridge', u: 0.14814, lat: 17.999, len: 12, r: 11, h: 5.5, top: 0.4, tint: 0xc8846a },
      // the wash's far reaches north-west of the creek, its channel only
      { kind: 'plain', u: 0.9862, lat: -74.2, yaw: -112, len: 38, r: 5, w: 8, h: 0.7 },   // (the last: lower, narrower)
      { kind: 'plain', u: 0.9726, lat: -54.7, yaw: 66, len: 38, r: 7, w: 8, h: 1.5 },
      // the sandstone bench the high road runs along, its top just under the
      // deck's slab (the road stood on a ribbon 2.8 u over the sand; any
      // higher and it buries the stilts terrain-ground.spec guards), the low
      // strands running through it in cuts under each bridge (`near` counts
      // from every strand). Chords of the road's curve, each ridge's spine
      // 1.7 r past the last: their crests sum to about the bench's height there
      // (overlapping, they stood double); under the ten units that turn to
      // rock, so sand, none of the box's dear rock pixels; the two by the
      // crossing lowered where the low road meets them (full height, they
      // stood over it as a blank embankment)
      { kind: 'ridge', u: 0.28269, lat: -8.35, yaw: 1.1, z: 0.25, len: 11.4, r: 6, h: 1.06, h1: 2.00, top: 0.6, near: 0.5 },
      { kind: 'ridge', u: 0.35009, lat: -7.24, yaw: 0.1, z: 0.01, len: 11.9, r: 6, h: 1.3, h1: 1.3, top: 0.6, near: 0.5 },
      { kind: 'ridge', u: 0.27031, lat: 5.68, yaw: -0.1, z: 0.02, len: 11.9, r: 6, h: 1.06, h1: 2.01, top: 0.6, near: 0.5 },
      { kind: 'ridge', u: 0.30683, lat: 6.04, yaw: -0.3, z: -0.10, len: 12.0, r: 6, h: 2.00, h1: 2.00, top: 0.6, near: 0.5 },
      { kind: 'ridge', u: 0.34727, lat: 6.01, yaw: 0, z: -0.01, len: 12.1, r: 6, h: 1.3, h1: 1.3, top: 0.6, near: 0.5 },
      { kind: 'ridge', u: 0.3843, lat: 6.35, yaw: -1.1, z: -0.31, len: 7.6, r: 6, h: 1.96, h1: 1.20, top: 0.6, near: 0.5 },
      { kind: 'ridge', u: 0.44989, lat: -7.29, yaw: -2.9, z: 1.53, len: 11.9, r: 6, h: 1.55, h1: 1.47, top: 0.6, near: 0.5 },
      { kind: 'ridge', u: 0.44113, lat: 5.69, yaw: -0.2, z: -0.10, len: 11.9, r: 6, h: 1.55, h1: 2.04, top: 0.6, near: 0.5 }
    ]
  },
  gulch: {
    name: 'Gulch', sand: STRIP, waypoints: GEN_TRACKS.gulch,
    oils: genFurn('gulch').oils, pads: genFurn('gulch').pads, boxes: genFurn('gulch').boxes,
    // A gold mine at its own size, reached down a canyon of mountainsides off
    // the crest (the long left-hander and the tight bend into the yard). The
    // ore's way is the lap's story: up the shaft under the headframe at the
    // east bend into its ore bin, by the little train along the line to the
    // mine yard, from the yard's tipple up a boarded gallery to the
    // tramway's terminal and in its buckets over the road to the stamp
    // mill, whose waste runs down its launder to the tailings beside it. The
    // stamp mill across the start straight, its ore tramway's buckets riding
    // over the road to the terminal by the adit, a car high, cut into the rock
    // face of a spur under the long ridge north of the start straight, one
    // ore line winding out of its yard along the whole start straight (on a
    // low timber trestle a few units past its kerb, its train pacing the
    // racers) and round the east bend to the headframe over the shaft at
    // the bend's kerb, its wheel turning over the road, a little train of
    // ore riding the line from the adit to the shaft; grey spoil heaps at
    // the shaft, timber supports round the
    // lap. The gold camp's boomtown lines the north loop's top, its saloon's
    // sign swinging; the miners' camp stands before the canyon. The west of
    // the map is a range of mountains and mesas the descent cuts through.
    set: [
      { model: 'set-mine-portal', u: 0.01808, lat: 16 },
      { model: 'set-ore-line', u: 0.01808, lat: 16 },
      // the headframe astride the road at the east bend, the ore line's
      // loading shed under its bin on the outside verge where the line ends
      { model: 'set-headframe', u: 0.20323, lat: 0 },
      // the gulch itself: off the crest the road drops into a canyon, its
      // faces at the kerb the near faces of the range's massifs (`land`):
      // from the run-in on the outside round the long left-hander, down the
      // straight and round the tight bend into the mine yard, one on the
      // inside round the left-hander. It is the mine's canyon: a timber
      // flume on trestles pinned along the left-hander's face, from a header
      // box in the cliff down to a sluice at the verge, and in the faces'
      // feet the workings, no two alike: an adit given up and boarded, the
      // one being worked, a ladder way to a ledge, pit props stacked, rock
      // come down (the lengths bring them: set_prototypes.py gulch_flume,
      // gulch_workings).
      // The crest's left-hander has no face: its shoulder is the land's own
      // (a face there stood as pyramids on the sand from across the map,
      // where the shoulder reads as one banded mountain). The run-in's face
      // starts west of the sight line from the crest's descent to the stamp
      // mill, so the mill reads from there across the yard. The loop's middle
      // stays low: the deck cap holds the land there under the road, and the
      // yard opens on the stamp mill.
      { model: 'set-canyon-run-gulch', u: 0.81755, lat: 5.2 },
      { model: 'set-canyon-bend-gulch', u: 0.86283, lat: 5.199 },
      { model: 'set-canyon-drop-gulch', u: 0.90441, lat: 5.183, yaw: -2.33 },
      { model: 'set-canyon-hairpin-gulch', u: 0.9373, lat: 5.191, yaw: 1.46 },
      { model: 'set-canyon-yard-gulch', u: 0.9678, lat: 5.2 },
      { model: 'set-canyon-inside-gulch', u: 0.85779, lat: -5.199, yaw: -180 },
      // the stamp mill stepping down its hill across the start straight
      // from the adit, its tramway's buckets riding the sagging ropes over
      // the road to the tower beside the adit; and its tailings, in the
      // mill's own frame: a pale terraced heap down the yard, fed along its
      // launder from the tables' house (the mill's clearing takes in the
      // heap's, so both stand at one level)
      { model: 'set-stamp-mill', u: 0.005, lat: -11, yaw: 180 },
      { model: 'set-tailings-dump', u: 0.005, lat: -10, yaw: 180 },
      // the boomtown down the north loop's top, both sides of the road; the
      // miners' camp before the canyon, the left there left open for the
      // sight line to the mill
      { model: 'set-boomtown-north', u: 0.34769, lat: 6.552, yaw: -16.48 },   // (its livery stable clear of the bend's strip)
      { model: 'set-boomtown-south', u: 0.35654, lat: -5.478, yaw: 177.54 },
      { model: 'set-miners-camp', u: 0.78536, lat: 8.3, yaw: -30, scale: 1.2 },
      // the powder magazine past the town, vaulted and banked with earth
      { model: 'set-powder-magazine', u: 0.40333, lat: 8.131, yaw: -5.74 },
      // the mine's water on the outside of the back loop: a wind engine
      // over its well, a tank on its stand and a flume along the verge to
      // the cistern it fills
      { model: 'set-water-works', u: 0.67229, lat: 7.236, yaw: 0.89 }
    ],
    // the ridge the mine is in, the shaft's spoil heaps (waste rock, greyer
    // than the land), and the range
    land: [
      { kind: 'ridge', u: 0.0004, lat: 48, len: 80, r: 22, h: 18, top: 0.3 },
      { kind: 'ridge', u: 0.18109, lat: 12.497, yaw: 0.01, len: 4, r: 5, h: 4, top: 0.15, near: 2, tint: 0xb0a49c },
      { kind: 'ridge', u: 0.34052, lat: 22.001, yaw: 2.64, len: 14, r: 11, h: 7, top: 0.15, tint: 0xb0a49c },
      // the range: massifs behind the canyon faces, each rising from just
      // past the faces' backs (`near`, so a face stands whole on the verge
      // and its back sinks into the land at the massif's foot; a flank
      // rising under a back stretched it into needles), all on the outside
      // of the crest and the descent; round the crest's left-hander a low
      // shoulder rising off the verge itself and stepping up to a second,
      // higher summit set back (two forms, so its flank turns instead of
      // standing as one plane), so the range steps back from the road.
      // Mesas and peaks behind them, the skyline from the seat,
      // each a ridge with a crest (`len`, `top`): a round form with a low
      // top reads as a cone. Those (the last seven) are full-only (`lite:
      // false`): on the Android box they were the range's cost at 1080, and
      // the massifs at the faces still carry the range there.
      { kind: 'ridge', u: 0.41932, lat: 20.46, yaw: 171.93, len: 17, r: 12, h: 11, top: 0.5, near: 2 },
      { kind: 'ridge', u: 0.44361, lat: 23.437, yaw: -165.21, len: 15, r: 13, h: 14.5, top: 0.45, near: 2 },
      { kind: 'ridge', u: 0.83515, lat: 37.847, yaw: -127.34, len: 32, r: 22, h: 30, h1: 38, top: 0.3, near: 16 },
      { kind: 'ridge', u: 0.88375, lat: 31.899, yaw: -2.48, len: 36, r: 34, h: 36, top: 0.3, near: 16 },
      { kind: 'ridge', u: 0.92957, lat: 28.37, yaw: -34.96, len: 20, r: 30, h: 38, top: 0.3, near: 16 },
      { kind: 'ridge', u: 0.95576, lat: 30.863, yaw: 0.82, len: 28, r: 30, r1: 24, h: 36, h1: 24, top: 0.3, near: 16 },
      { kind: 'ridge', u: 0.87289, lat: 70.797, yaw: 12.17, len: 36, r: 30, h: 46, top: 0.42, lite: false },
      { kind: 'ridge', u: 0.90068, lat: 72.912, yaw: -14.18, len: 20, r: 30, h: 50, top: 0.3, lite: false },
      { kind: 'ridge', u: 0.82267, lat: 92.205, yaw: -21.58, len: 30, r: 26, h: 36, top: 0.3, lite: false },
      { kind: 'ridge', u: 0.84592, lat: 71.253, yaw: -155.83, len: 18, r: 26, h: 46, top: 0.25, lite: false },
      { kind: 'ridge', u: 0.95935, lat: 64.67, yaw: -9.05, len: 30, r: 26, h: 38, top: 0.45, lite: false },
      { kind: 'ridge', u: 0.93924, lat: 70.428, yaw: 30.42, len: 22, r: 28, h: 46, top: 0.3, lite: false },
      { kind: 'ridge', u: 0.92769, lat: 59.88, r: 30, h: 44, top: 0.38, lite: false },
      // the biome's hoodoo family keeps off the east bend, where its tall
      // stack stood beside the headframe as a second tower, and off the
      // boomtown's street after it
      { kind: 'clear', u: 0.11067, lat: 12.5, len: 28, r: 3 },
      { kind: 'clear', u: 0.11067, lat: -12.5, len: 28, r: 3 },
      { kind: 'clear', u: 0.17103, lat: 12.498, len: 28, r: 3 },
      { kind: 'clear', u: 0.17105, lat: -12.498, yaw: -0.01, len: 28, r: 3 },
      { kind: 'clear', u: 0.2314, lat: 12.5, len: 28, r: 3 },
      { kind: 'clear', u: 0.2314, lat: -12.5, len: 28, r: 3 },
      { kind: 'clear', u: 0.29192, lat: 12.489, yaw: 1.94, len: 28, r: 3 },
      { kind: 'clear', u: 0.28932, lat: -12.347, yaw: 2.58, len: 28, r: 3 },
      { kind: 'clear', u: 0.35248, lat: 10.86, yaw: 2.58, len: 28, r: 3 },
      { kind: 'clear', u: 0.35164, lat: -12.251, yaw: -0.85, len: 28, r: 3 },
      { kind: 'clear', u: 0.40825, lat: 12.448, yaw: -3.75, len: 28, r: 3 },
      { kind: 'clear', u: 0.41778, lat: -10.961, yaw: -13.85, len: 28, r: 3 }
    ]
  },
  crag: {
    name: 'Crag', sand: STRIP, waypoints: GEN_TRACKS.crag,
    oils: genFurn('crag').oils, pads: genFurn('crag').pads, boxes: genFurn('crag').boxes,
    // A ranch in butte country. The long straight runs from the ranch on
    // the open plain at its head (house, barn, water tower, the windpump
    // turning, the corral with cattle) down the ranch's fenced range to the
    // rim, the mesa closing the west of the map: at the hairpin the rim's
    // mountainside comes to the verge, round its outside and on along the north
    // straight to the bridge (lengths of the track's own rimrock,
    // set_prototypes.py crag_rim: dark tables over a plain talus with sky in
    // the notches between, the rim's own massif rising behind them in `land`).
    // Off the bridge the road runs at the mesa standing between the
    // north-east loop and the S, a table with a butte broken away from it
    // past a gap of sky: the loop rounds the table and the S passes the
    // butte. A butte stands on the outside of the south loop's bend and a
    // pair of spires on the outside of each loop (strata over a butte's
    // height, set_prototypes.py crag_butte: a cliff of the one hard
    // sandstone in gullies and buttresses on a talus of one colour, never a
    // striped drum nor one long face), small spires of the same rock between
    // them, and the skyline all round is mesas and buttes of the land; a
    // balanced rock stands on the butte past the mesa's gap of sky. A
    // stand of saguaros marks the start straight. Out on the range the
    // ranch's windpump
    // turns over its stock tank near the road, its herds come in to it and
    // to a second tank on the S (a cow alone is a speck from the road;
    // tower, tank and herd read as
    // one). Every wheel, the ranch's included, faces the one wind: the west
    // wind that blows the sand and the clouds east (+X) across the map, its
    // tail vane downwind. Each yaw turns its pump's wheel to the world's -X;
    // the ranch's own is turned inside its piece (set_prototypes.py
    // RANCH_WIND_YAW, for the ranch as it stands here).
    set: [
      { model: 'set-ranch', u: 0.98586, lat: -13, yaw: 180 },
      // out on the range: the shipping pen and its loading chute by the
      // north straight, the one windpump past the bridge, a stock tank on
      // the outside of the S (three windpumps stood in one picture as one
      // tower copied); the ranch's lane from the gateway in the start's
      // fence up to its corral
      { model: 'set-loading-chute', u: 0.16467, lat: 9.2 },
      { model: 'set-stock-tank', u: 0.58024, lat: -12.003, yaw: -180 },
      { model: 'set-windpump', u: 0.47925, lat: 9.502, yaw: -137 },
      { model: 'set-ranch-lane', u: 0.03233, lat: -5.4, yaw: -180 },
      // (two stands, the third the first turned and a size down: one trio
      // at all three read as one piece copied; the first turned to fit the
      // hairpin's lobe between its strips)
      { model: 'set-hoodoos', u: 0.31015, lat: -9.999, yaw: 70 },
      { model: 'set-crag-hoodoos-b', u: 0.61058, lat: 13.004, yaw: 180 },
      { model: 'set-hoodoos', u: 0.90028, lat: 15.979, yaw: 106.85, scale: 0.85 },
      { model: 'set-crag-saguaros', u: 0.05051, lat: 10 },
      // the start is the ranch's open range, fenced along both verges, its
      // gateway on the ranch's side (the cup's other starts are a canyon, a
      // mine yard and an oil camp); the rim begins at the hairpin
      { model: 'set-ranch-fence', u: 0.03233, lat: -5.4, yaw: -180 },
      { model: 'set-ranch-fence', u: 0.03637, lat: 5.4 },
      // the herd on the range inside the fences: eight head in two bunches
      // against the fence on the ranch's side, four more across the road
      { model: 'set-ranch-herd', u: 0.03536, lat: -5.9, yaw: -180 },
      { model: 'set-ranch-herd-east', u: 0.02021, lat: 5.9 },
      // the rock, each piece's talus coming to a couple of units past the
      // kerb (a chase camera rounding a bend passed through a talus on the
      // road), its blocks out at the ends, never by a kerb
      { model: 'set-rimrock-mesa', u: 0.58482, lat: -35.008, yaw: 147 },
      { model: 'set-rimrock-spires', u: 0.37873, lat: 20.994, yaw: 20 },
      { model: 'set-rimrock-butte', u: 0.79414, lat: 23.424, yaw: 6.76 },
      { model: 'set-rimrock-mitten', u: 0.86527, lat: 17.5, yaw: -160 },
      // the rim's mountainside, each face toward the road (the hairpin's
      // entry is looser than its apex, so its length is bent wider)
      { model: 'set-canyon-hairpin-crag', u: 0.09031, lat: -5.2, yaw: 179.86 },
      { model: 'set-canyon-exit-crag', u: 0.10694, lat: -5.197, yaw: 178.93 },
      { model: 'set-canyon-rim-crag-b', u: 0.1324, lat: -5.2, yaw: 179.97 }
    ],
    land: [
      // the rim: the mesa the canyon lengths are the near faces of, rising
      // from past their backs (`near`, Gulch's massifs), scarcely over their
      // crests, so its flat top shows against the sky down the long straight
      // (taller, it filled the picture as one banded wall, and its steep land
      // is rock the box pays for per pixel), its south end a shoulder short
      // of the ranch
      { kind: 'ridge', u: 0.09662, lat: -26, yaw: -129.52, len: 16, r: 26, h: 12, top: 0.5, near: 16 },
      { kind: 'ridge', u: 0.13542, lat: -30, yaw: 0.2, len: 24, r: 24, r1: 18, h: 13, h1: 12, top: 0.5, near: 16 },
      // low swells of the land coming to the kerb out on the range, under
      // the ten units a slope must climb to turn to rock (so sand, and none
      // of the box's dear rock pixels): past the north-east spires, before
      // the bend beyond them, and on the S's outside, joining the mesa's
      // broken-off butte's talus (each short of every other strand: a flank
      // reaching one is cut into a cliff there, a crease and a flap; and
      // none over a rock piece's own talus: one lay on the north-east
      // spires' and the two slopes cut each other in dark shards)
      { kind: 'ridge', u: 0.61862, lat: -15.004, len: 12, r: 10, h: 1.8, top: 0.3, near: 3 },
      // the skyline: mesas and buttes standing apart on the plain, 55 to 95
      // units out (a ring of them read as the walls of a box), each broad
      // enough for the ground's 9 u grid to draw a table, not a pyramid
      { kind: 'ridge', u: 0.44859, lat: 73.542, yaw: 145.76, len: 80, r: 24, h: 16, top: 0.5 },
      { kind: 'ridge', u: 0.36823, lat: 55.464, yaw: 141.42, len: 14, r: 20, h: 22, top: 0.55 },
      { kind: 'ridge', u: 0.33, lat: 65.895, yaw: -4.57, len: 70, r: 24, h: 18, top: 0.5 },
      { kind: 'ridge', u: 0.87341, lat: 93.886, yaw: -116.45, len: 50, r: 22, h: 15, top: 0.5 },
      { kind: 'ridge', u: 0.81626, lat: 62.394, yaw: 14.68, len: 70, r: 26, h: 20, top: 0.5 },
      { kind: 'ridge', u: 0.10552, lat: -71.731, yaw: -151.96, len: 14, r: 18, h: 20, top: 0.55 }
    ]
  },
  sidewinder: {
    name: 'Sidewinder', sand: STRIP, waypoints: GEN_TRACKS.sidewinder,
    oils: genFurn('sidewinder').oils, pads: genFurn('sidewinder').pads, boxes: genFurn('sidewinder').boxes,
    // An oil field in the desert, one company's (white and red, its mark a
    // red drop on a white disc). Past the start the long straight runs into
    // a mountain of banded rock and through it in a tunnel: the massif rises
    // off its right to a summit, throws a spur across the road that falls
    // away into the low ground inside the bend beyond, and runs on off the
    // right as a ridge of the land. Out of the tunnel the road rounds the
    // massif's foothills, in its own strata (geometry: by the road, steep
    // land is the Android box's dear rock). Then the field: its drilling rig
    // on the S's left, where the camera points three times a lap (out of
    // the hairpin, beside the S, down the start straight); a lone red
    // pumpjack dead ahead out of the S at the east bend, a flowing well's
    // christmas tree at the bend's exit; the tank farm at the end of the
    // east straight, outside the north loop's first corner, where the whole
    // straight points; the field's three jacks nodding outside its second
    // corner; and at the line the field's own
    // filling station, its sign turning and a hawk over it. All round the
    // field, on the rim of the basin the circuit lies in, runs the company's
    // railway, its tank trains rolling round and round it the way the race
    // goes, filled at the rack behind the tank farm: on the ground the whole
    // way, past the mountain through the pass between the massif and its
    // range, and across no road. The telegraph line comes in across the open
    // desert from the east to the station (over the railway and the road on
    // tall poles), clear of the mountain. Mesa rims close the west as near
    // backdrops (the north and east stay open).
    // Everything by the road at its own size, the rock as big as rock is.
    set: [
      { model: 'set-telegraph-line', u: 0.02017, lat: 6 },
      { model: 'set-filling-station', u: 0.97171, lat: -9.5, yaw: 180 },
      // the field's wells at the kerb: the pumping wells, the rig, the lone
      // jack and the flowing well a step off the verge, where the chase
      // camera passes them at their own size
      { model: 'set-oil-field', u: 0.76954, lat: 5.2, yaw: 0.27 },
      { model: 'set-tank-farm', u: 0.62792, lat: 12 },
      { model: 'set-drilling-rig', u: 0.36899, lat: -6.989, yaw: 178.77 },
      { model: 'set-well-pad', u: 0.41936, lat: 6.961, yaw: -3.99 },
      { model: 'set-wellhead', u: 0.48751, lat: 5.201 },
      { model: 'set-mountain-tunnel', u: 0.10498, lat: 0 },
      { model: 'set-tunnel-foothills', u: 0.10498, lat: 0 },
      // the field's flare past the tank farm, its flame small
      { model: 'set-flare-stack', u: 0.66332, lat: 11.002 },
      // the field's pipe yard on the outside of the south loop, past where
      // the trunk line dives under the S: racked pipe, drums, a mud pit
      { model: 'set-pipe-yard', u: 0.29837, lat: 11.459, yaw: 0.67 },
      // the railway round the field, length by length on the rim (laid in
      // the world by scratch geometry, set_prototypes.py SW_RING, each
      // length placed on its own chord, its row solved for SW_PIECE's frame
      // on the road as built: the strip's push and the lap's length both
      // move a row, so re-solve them when the road changes): the rack
      // behind the tank farm, the open line (the lengths behind the south
      // loop's ridge, h to m, never
      // seen from the seat, are full-only), and four trains, each built on a
      // length of its own a quarter of the way round from the next (two of
      // them full-only: at the trains' pace two pass every part of the line
      // a racer sees, and c stands on the full-only lengths); the rack fed from the farm
      // through a pipe that comes up at the farm's edge
      { model: 'set-tank-rack', u: 0.63764, lat: 37.003, yaw: -1.58 },
      { model: 'set-tank-line-a', u: 0.6502, lat: 32.464, yaw: 6.11 },
      { model: 'set-tank-line-b', u: 0.66609, lat: 28.461, yaw: 7.63 },
      { model: 'set-tank-line-c', u: 0.68357, lat: 28.202, yaw: -6.67 },
      { model: 'set-tank-train-a', u: 0.70978, lat: 31.809, yaw: -3.78 },
      { model: 'set-tank-line-d', u: 0.73091, lat: 31.737, yaw: 0.22 },
      { model: 'set-tank-line-e', u: 0.74727, lat: 31.637, yaw: 0.11 },
      { model: 'set-tank-line-f', u: 0.76169, lat: 39.039, yaw: -32.09 },
      { model: 'set-tank-line-g', u: 0.05083, lat: 36.73, yaw: 4.42 },
      { model: 'set-tank-train-b', u: 0.10458, lat: 39.907, yaw: -19.96, lite: false },
      { model: 'set-tank-line-h', u: 0.15511, lat: 40.833, yaw: 16.81, lite: false },
      { model: 'set-tank-line-i', u: 0.16745, lat: 33.685, yaw: 13.4, lite: false },
      { model: 'set-tank-line-j', u: 0.17503, lat: 32.209, yaw: -7.07, lite: false },
      { model: 'set-tank-line-k', u: 0.18237, lat: 32.627, yaw: 4.58, lite: false },
      { model: 'set-tank-train-c', u: 0.19163, lat: 30.502, yaw: 4.1, lite: false },
      { model: 'set-tank-line-l', u: 0.23209, lat: 27.909, yaw: 8.79, lite: false },
      { model: 'set-tank-line-m', u: 0.2593, lat: 27.226, yaw: -4.96, lite: false },
      { model: 'set-tank-line-n', u: 0.40761, lat: 29.57, yaw: 32.1 },
      { model: 'set-tank-line-o', u: 0.4263, lat: 21.797, yaw: -0.61 },
      { model: 'set-tank-train-d', u: 0.44594, lat: 23.411, yaw: -5.44 },
      { model: 'set-tank-line-p', u: 0.48197, lat: 27.606, yaw: -3.96 },
      { model: 'set-tank-line-q', u: 0.87399, lat: -21.915, yaw: -161.61 },
      { model: 'set-tank-line-r', u: 0.86307, lat: -27.647, yaw: 139.26 },
      { model: 'set-pipeline-rise', u: 0.6326, lat: 17.544, yaw: 105.68 },
      { model: 'set-pipeline-16', u: 0.6326, lat: 17.544, yaw: -74.28 },
      // the trunk line on its stilts, span by span along the right-hand
      // verge, each span a chord of the road's curve with a support at every
      // joint (each span's anchor is the last one's end as the game stands
      // it, in the plan: a step there is a gap in the pipe): from the valve
      // on the tank farm's middle tank (set_prototypes.py tank_farm, OUT)
      // round the north loop, swinging out behind
      // the pumping wells to their tank battery and back, under the knot;
      // down the start straight and under the mountain; round the outside
      // of the south loop and away under the S. Each span a thin footprint,
      // so the scatter round it stands. The detour behind the pumping wells
      // is full-only (the wells and the deck hide it from the seat): in
      // lite its first span is the line going under the ground
      // (set-pipeline-8-under's lite build), up again at the south run.
      { model: 'set-pipeline-8', u: 0.64091, lat: 6.287, yaw: 3.31 },
      { model: 'set-pipeline-8', u: 0.65224, lat: 6.131, yaw: 7.3 },
      { model: 'set-pipeline-8', u: 0.66306, lat: 6.044, yaw: 10.74 },
      { model: 'set-pipeline-8', u: 0.67402, lat: 6.031, yaw: 11.71 },
      { model: 'set-pipeline-12', u: 0.68502, lat: 5.955, yaw: 12 },
      { model: 'set-pipeline-16', u: 0.70508, lat: 6.247, yaw: 8.04 },
      { model: 'set-pipeline-8-under', u: 0.7313, lat: 6.902, yaw: -20.21 },
      { model: 'set-pipeline-8', u: 0.73975, lat: 10.72, yaw: -20.52, lite: false },
      { model: 'set-pipeline-8', u: 0.7473, lat: 14.509, yaw: 0.54, lite: false },
      { model: 'set-pipeline-8', u: 0.75495, lat: 15.481, yaw: 6.97, lite: false },
      { model: 'set-pipeline-12', u: 0.76222, lat: 15.548, yaw: 8.25, lite: false },
      { model: 'set-pipeline-8', u: 0.77963, lat: 15.6, yaw: 15.86, lite: false },
      { model: 'set-pipeline-8', u: 0.79316, lat: 13.729, yaw: 44.06, lite: false },
      { model: 'set-pipeline-dive', u: 0.79933, lat: 8.916, yaw: 19.75, lite: false },
      { model: 'set-pipeline-rise', u: 0.91535, lat: 7.5, yaw: 179.88 },
      { model: 'set-pipeline-16', u: 0.91535, lat: 7.5, yaw: -1.18 },
      { model: 'set-pipeline-16', u: 0.95136, lat: 7.51, yaw: -0.36 },
      { model: 'set-pipeline-16', u: 0.9869, lat: 7.494, yaw: -0.06 },
      { model: 'set-pipeline-16', u: 0.02254, lat: 7.495, yaw: 1.25 },
      { model: 'set-pipeline-dive', u: 0.05663, lat: 7.503, yaw: -1.97 },
      { model: 'set-pipeline-rise', u: 0.14993, lat: 6.384, yaw: -169.62 },
      { model: 'set-pipeline-8', u: 0.14993, lat: 6.384, yaw: 12.99 },
      { model: 'set-pipeline-8', u: 0.16243, lat: 5.918, yaw: 18.42 },
      { model: 'set-pipeline-8', u: 0.17149, lat: 5.455, yaw: 18.07 },
      { model: 'set-pipeline-8', u: 0.17892, lat: 5.692, yaw: 14.47 },
      { model: 'set-pipeline-8', u: 0.18676, lat: 6.008, yaw: 9.9 },
      { model: 'set-pipeline-16', u: 0.19759, lat: 6.145, yaw: 2.31 },
      { model: 'set-pipeline-8', u: 0.23069, lat: 6.304, yaw: 6.64 },
      { model: 'set-pipeline-8', u: 0.24396, lat: 6.252, yaw: 6.26 },
      { model: 'set-pipeline-8', u: 0.25754, lat: 6.27, yaw: 6.89 },
      { model: 'set-pipeline-8', u: 0.27111, lat: 6.226, yaw: 6.2 },
      { model: 'set-pipeline-dive', u: 0.2846, lat: 6.249, yaw: 1.97 }
    ],
    // the mesa rims: across the far end of the long straight, and south-west
    // past the south loop, no crest edge more than about 8 degrees over the
    // horizon from any point of the road; and the mountain's range running
    // on from its west end, rock-tinted, a pass left between the two for the
    // railway (the ridge's near end a crest's width clear of the massif)
    land: [
      // a low ridge of the rust land along the outside of the south loop,
      // rising from just past the trunk line (`near`), so the road runs
      // round the foot of it; low enough to stay sand, each short of the
      // next so their crests do not stack
      { kind: 'ridge', u: 0.17302, lat: 17.993, len: 8, r: 9, h: 3.6, top: 0.3, near: 4.6, tint: 0xc8846a },
      { kind: 'ridge', u: 0.21416, lat: 18.497, yaw: 0.01, len: 10, r: 9, h: 4.2, top: 0.3, near: 4.6, tint: 0xc8846a },
      { kind: 'ridge', u: 0.25861, lat: 17.998, len: 8, r: 9, h: 3.4, top: 0.3, near: 4.6, tint: 0xc8846a },
      { kind: 'ridge', u: 0.10572, lat: 84.07, yaw: 80.37, len: 40, r: 13, h: 9, top: 0.3, tint: 0xc8846a },
      { kind: 'ridge', u: 0.17946, lat: 99.775, yaw: 3.99, len: 120, r: 30, h: 13, top: 0.5 },
      { kind: 'ridge', u: 0.72888, lat: 105.994, yaw: 150.89, len: 130, r: 30, h: 14, top: 0.5 },
      // The field (the S round the north loop) keeps the biome's hoodoo
      // family off: it stands at the first spot off the road and the pieces
      // from the tunnel on, and every such spot here put its tall stack
      // beside the rig's mast or the lone jack, or centre frame in the loop
      // between the tanks and the pumping wells, as the camera saw them.
      // These thin clears (a unit round their spines, so they take little
      // scatter with them) cover those spots, as the hoodoo's 5 u keep-out
      // reads them, and the family stands east of the crossing, on the open
      // skyline past the field, as the desert's own rock.
      { kind: 'clear', u: 0.34523, lat: 11.394, yaw: 18.72, len: 14, r: 1 },
      { kind: 'clear', u: 0.40282, lat: 11.501, len: 14, r: 1 },
      { kind: 'clear', u: 0.44108, lat: -9.515, yaw: -22.06, len: 4, r: 1 },
      { kind: 'clear', u: 0.47134, lat: 11.501, len: 34, r: 1 },
      { kind: 'clear', u: 0.49457, lat: -11.5, len: 2, r: 1 },
      { kind: 'clear', u: 0.6613, lat: -11.503, yaw: -0.01, len: 6, r: 1 },
      { kind: 'clear', u: 0.68554, lat: 11.5, len: 6, r: 1 },
      { kind: 'clear', u: 0.72007, lat: 11.465, yaw: -3.33, len: 26, r: 1 },
      { kind: 'clear', u: 0.77957, lat: -14.8, len: 17, r: 1 },
      { kind: 'clear', u: 0.80988, lat: 11.5, len: 6, r: 1 },
      // ...nor on the outside of the bend back to the start straight
      { kind: 'clear', u: 0.87392, lat: -11.507, yaw: 0.36, len: 26, r: 1 },
      // ...nor at the kerb before the tank farm, towering over its tanks
      { kind: 'clear', u: 0.535, lat: 11.501, len: 16, r: 1 },
      { kind: 'clear', u: 0.57543, lat: 11.501, len: 22, r: 1 },
      { kind: 'clear', u: 0.61077, lat: 11.5, len: 12, r: 1 },
      // The filling station's forecourt, from its pumps to the kerb, kept
      // clear of the scatter's boulders.
      { kind: 'clear', u: 0.96666, lat: -8, len: 14, r: 4 }
    ]
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
    name: 'Skysnake', sand: STRIP, segments: SKYSNAKE, startU: 0.026,
    oils: OILS.skysnake, pads: PADS.skysnake, boxes: BOXES.skysnake,
    // Snakes and ladders, raced across the board at the toy cars' own scale,
    // and the board stood up where the racers look: two of its printed
    // snakes are jointed wooden ones arching along the kerb (the grid
    // straight, the last corner), wind-up ducks hop the grid's kerb, and
    // outside the first deck a ladder leans up a stack of dice with a snake
    // hung down it, another game's board stood open past it. The games
    // shelf's other things stand where the floor cannot be seen: a house of
    // cards and a stack of game boxes under a spinner outside the top deck,
    // the game's big pawns and a spilled deck past the loop. The dive ends
    // through the snake's head, astride the road at its foot. The room's
    // train runs over the board's edge.
    set: [
      { model: 'set-snake-board', u: 0, lat: 0 },
      { model: 'set-dice-tower', u: 0.19648, lat: 11.002 },
      { model: 'set-game-box', u: 0.39096, lat: 9.004, scale: 1.4 },
      { model: 'set-windup-ducks', u: 0.10426, lat: 4.5 },
      { model: 'set-snake-humps-blue', u: 0.16039, lat: 7.201 },
      { model: 'set-ladder-stack', u: 0.45311, lat: 8.005 },
      { model: 'set-game-board', u: 0.49817, lat: 8.506 },
      { model: 'set-card-house', u: 0.60689, lat: 7.258, yaw: -35 },
      { model: 'set-game-stack', u: 0.67666, lat: 8.01, yaw: -4.05 },
      { model: 'set-snake-jaws', u: 0.7739, lat: 0 },
      { model: 'set-game-pawns', u: 0.93142, lat: 5.639 },
      { model: 'set-snake-humps-purple', u: 0.97494, lat: 7.5 },
      { model: 'set-room-train-skysnake', u: 0, lat: 0 },
      { model: 'set-play-sunbeam', u: 0.207, lat: 30.17, yaw: -72.98 },
      // The toy box's classics left out on the board (each its own piece, to
      // keep or drop), as a child left a game: a line of dominoes run across
      // the middle into the chessmen, knocking the pawn over (the chess row
      // stands at the dominoes' end, along their line); the teddy sat by the
      // rocking horse with the ring stack, looking at the race; the top
      // spinning by the dice; the pull-along snake watching the cars. Set
      // from the grid straight's frame, so lat is minus the board's x and u
      // its z.
      { model: 'set-board-top', u: 0.0254, lat: -10, yaw: 0 },
      { model: 'set-board-rocking-horse', u: 0.07915, lat: -16.001, yaw: -90 },
      { model: 'set-board-teddy', u: 0.09329, lat: -12.501, yaw: -130 },
      { model: 'set-board-ring-stack', u: 0.11592, lat: -20.001, yaw: 0 },
      { model: 'set-board-dominoes', u: 0.06416, lat: -34.662, yaw: 25.82 },
      { model: 'set-board-chess', u: 0.11394, lat: -43.182, yaw: 25.82 },
      { model: 'set-board-pull-snake', u: 0.983007, lat: -28, yaw: -100 }
    ],
    // The dive is the board's snake, from the top deck down to the board.
    // The climbs stay plain road: painted as the board's ladders, their
    // rungs read as stripes across the lane.
    land: [
      { kind: 'snake', u: 0.744, len: 31 }
    ]
  },
  gauntlet: {
    name: 'Gauntlet', sand: STRIP, segments: GAUNTLET,
    oils: OILS.gauntlet, pads: PADS.gauntlet, boxes: BOXES.gauntlet,
    // The toy castle siege, one set of toy knights split into two sides,
    // and the race runs the gauntlet between them. The block castle stands
    // in the lap's heart, in the loop the road makes inside it, so the race
    // circles its walls on four sides and the ramp climbs past its gate to
    // thread the ring. Across the ramp lie the red besiegers' camp of
    // pavilions and their trebuchet just thrown at the castle, a siege
    // tower rolling up where the grid straight points; a blue rank of the
    // castle's knights holds the gap between the castle and the grid
    // straight. The castle's watchtower stands over the bridge out of the
    // plunge, then the road runs through its barbican, a covered passage
    // of blocks, and down past the besiegers' guns aimed across it at the
    // castle and their tents, their supply wagon of powder come up outside
    // the bend before them. On the long home straight the siege goes on:
    // a red rank behind its mantlets and scaling ladders inside it (a rank
    // the lite tier leaves out), two blue ranks with their cannon outside, the castle's outer gatehouse astride the road (the
    // racers drive through its arch, under the portcullis), a tin knight of
    // each side wound up and marching the kerb at the set's own knights'
    // size, and the castle's dragon, the biggest creature of the set, on
    // guard where the straight points (on the gatehouse and on the castle's
    // wall it stood too high for the seat: 2 s a lap against 7 here). The
    // besiegers' wooden horse is left inside the last corner, where the
    // road south of the castle points. Outside the east leg, across the road
    // from their camp, stand their works: palisades, a mangonel and their
    // banners. The besiegers' ram,
    // its log swinging, stands with their guns outside the corner after
    // them, aimed across at the castle, and the castle's corner towers fly
    // tall blue pennants. Between the fights the two sides hold a tourney:
    // the lists outside the grid straight, a red knight and a blue riding at
    // each other along the tilt before the king's stand, and the castle's
    // knights' camp inside the home straight, its archery butts and
    // quintain. The floor's scatter is the tourney's too (theme.cc): shields,
    // butts and banners, none of the biome's other toys.
    set: [
      { model: 'set-toy-soldiers', u: 0.79913, lat: 6.698, lite: false },
      { model: 'set-siege-mantlets', u: 0.80917, lat: -8.698, yaw: 180 },
      { model: 'set-castle-gate', u: 0.82926, lat: 0, yaw: 3.51 },
      { model: 'set-toy-soldiers', u: 0.87446, lat: 6.999 },
      { model: 'set-castle-watchtower', u: 0.56178, lat: 8.989 },
      { model: 'set-barbican', u: 0.60889, lat: 0 },
      { model: 'set-cannon-battery', u: 0.67377, lat: 6.994, scale: 1.2 },
      { model: 'set-siege-ram', u: 0.72289, lat: 8.495, yaw: -150.5 },
      { model: 'set-toy-dragon', u: 0.94978, lat: 7.2, scale: 1.25 },
      // the castle, the camp and the trebuchet face the world's north (yaw against the road's heading, lat short by the strip's push)
      { model: 'set-block-fortress', u: 0.42123, lat: -12.381, yaw: 0 },
      { model: 'set-siege-camp', u: 0.12031, lat: -6.169, yaw: -90 },
      { model: 'set-trebuchet', u: 0.11378, lat: -15.571, yaw: -90 },
      { model: 'set-siege-tower', u: 0.07804, lat: 11, yaw: 35 },
      { model: 'set-toy-soldiers', u: 0.022, lat: -6, yaw: 180 },
      { model: 'set-tilt-yard', u: 0.02709, lat: 8.5 },
      { model: 'set-tourney-camp', u: 0.76096, lat: -9.495, yaw: 180 },
      { model: 'set-windup-knights', u: 0.91964, lat: 4.3 },
      { model: 'set-tourney-rug', u: 0.8845, lat: 0, yaw: 90 },
      { model: 'set-supply-wagon', u: 0.63843, lat: 8.392 },
      { model: 'set-wooden-horse', u: 0.9699, lat: -9, yaw: 180 },
      { model: 'set-siege-works', u: 0.15049, lat: 7.198, yaw: -0.44 },
      { model: 'set-play-sunbeam', u: 0.08736, lat: 28.04, yaw: -72.68 }
    ]
  },
  helix: {
    name: 'Helix', sand: STRIP, segments: HELIX, startU: 0.020,
    oils: OILS.helix, pads: PADS.helix, boxes: BOXES.helix,
    // The marble run: ONE run round the whole room in the race's direction,
    // its marbles rolling only downhill but at its three lifts, each a
    // different machine. Up inside the marble tower's column, where the grid
    // straight points (a slinky walking down off its block beside it), out
    // of its cup and over the corner after the straight on twin rails; along
    // the top leg's infield through a marble wheel, behind a tin humming top
    // and a wooden one spinning short of it, into a catch tray and up the
    // summit screw lift outside the climb, the tallest thing in the room;
    // over the skyway three times, weaving out, back to the infield and out
    // again on twin rails the racers drive under, each span lower than the
    // last; south along its outside, ticking down a stair of tone bars, into
    // a vortex bowl and a helix outside the descent; along
    // the south leg's outside and round a loop of its own beside the mid
    // leg's; on the floor to a stair lift at the corner home, onto a wooden
    // marble racer of two stepped boards beside the grid straight, and from
    // its foot back into the tower's. A click-clack board faces the
    // descent's lower turn from outside the skyway, and the run's own box
    // lies open on the floor past the skyway, its spare pieces in it and a
    // column begun beside it. Nothing of the run stands apart from its one
    // loop. The run is the room's one mover: this
    // room has no train. Each section is built in the world's
    // frame (set_prototypes.py RUN_ORIGIN), and its row lands it there facing
    // north: its yaw the road heading's opposite, its lat short of the
    // origin by the strip the renderer pushes it out by (re-solve the rows
    // whenever the road or its strip moves). The marble tower's row likewise
    // stands its column on TOWER.
    set: [
      { model: 'set-marble-tower', u: 0.1253, lat: 12.3, yaw: -44.98 },
      { model: 'set-spinning-top', u: 0.21539, lat: -5.5 },
      { model: 'set-marble-run-head', u: 0.09626, lat: 4.8, yaw: 0 },
      { model: 'set-marble-run-wheel', u: 0.17924, lat: -4.77, yaw: -90 },
      { model: 'set-marble-run-summit', u: 0.24187, lat: -5.023, yaw: -90 },
      { model: 'set-marble-run-skyway', u: 0.47472, lat: 6.96, yaw: 180 },
      { model: 'set-marble-run-vortex', u: 0.52111, lat: 6.96, yaw: 180 },
      { model: 'set-marble-run-loop', u: 0.81056, lat: 7.03, yaw: 90 },
      { model: 'set-marble-run-stair', u: 0.93441, lat: 6.905, yaw: 90 },
      { model: 'set-marble-run-racer', u: 0.03595, lat: 4.8, yaw: 0 },
      { model: 'set-marble-zigzag', u: 0.53596, lat: 9.2 },
      { model: 'set-helix-run-box', u: 0.50591, lat: 17.3 },
      { model: 'set-windup-robots', u: 0.06011, lat: -4.6, yaw: 180 },
      { model: 'set-play-rug', u: 0.06011, lat: 0, yaw: 90 },
      { model: 'set-play-sunbeam', u: 0.13475, lat: 28.388, yaw: -72.53 }
    ]
  },
  skyline: {
    // No strip: the block city stands at the kerb round most of the lap.
    name: 'Skyline', segments: SKYLINE, startU: 0.024,
    oils: OILS.skyline, pads: PADS.skyline, boxes: BOXES.skyline,
    // Block city: the lap is laid through a town of wooden blocks on city
    // play rugs, the skyway an elevated road over its streets. The infield
    // is one rug: downtown's tower blocks stacked up to the skyway's own
    // height along its run, a wooden train going round past the station
    // beside the south edge, houses facing the grid straight and the top
    // straight across their kerbs and a park in the middle. Across the
    // road from each, more of the town: the west side's street under the
    // skyway with its building site and crane by the south-bound leg, a
    // street of houses and a clock tower outside the grid straight,
    // another with the water tower outside the south-bound leg, the shops
    // and the fire station outside the south edge, and past the top
    // straight the old town, a crane turning on its building site. The
    // town's tallest blocks stand beside the skyway where it turns for the
    // U and others of their own outside it, its TV tower in the U's eye;
    // round the U's outside the old town's square, a minster, the town hall
    // and its clock, a stepped block of flats, all over the deck, and a
    // terrace of tall houses stepping down beside the ramp off it; and
    // towers a child stacked of the small blocks stand outside the corner
    // the south-bound leg turns. A tin bus and tram, wound up, drive round
    // a street on a mat of their own laid against the end of the grid
    // straight's street rug, outside the first corner, where the straight
    // points: the town's traffic, past its bus stop.
    set: [
      { model: 'set-block-city', u: 0.125, lat: -15, yaw: 180 },
      { model: 'set-block-town', u: 0.0147, lat: 24.35 },
      { model: 'set-block-street', u: 0.018, lat: 0 },
      { model: 'set-block-westside', u: 0.2282, lat: -8.56, yaw: -180 },
      { model: 'set-block-high-street', u: 0.8655, lat: -9.63, yaw: 180 },
      { model: 'set-block-uptown', u: 0.4534, lat: -6.64 },
      { model: 'set-block-midtown', u: 0.485, lat: -9, yaw: 90 },
      { model: 'set-block-minster', u: 0.5, lat: -8.6, yaw: 180 },
      { model: 'set-block-terrace', u: 0.547, lat: -7.2, yaw: 180 },
      { model: 'set-block-street-west', u: 0.71, lat: 0 },
      { model: 'set-block-towers', u: 0.768, lat: -7.5, yaw: 180, scale: 0.62 },
      { model: 'set-windup-trams', u: 0.018, lat: 0 },
      { model: 'set-play-sunbeam', u: 0.0875, lat: -48.78, yaw: 84.56 }
    ]
  }
};

// Cups — curated, ordered sets of tracks (a "grand prix" grouping). Each cup lists its
// track ids easiest→hardest; the controller picker renders one labelled section per cup.
// CUPS is the SOURCE OF TRUTH for track ordering — TRACK_ORDER / TRACK_LIST below are
// derived by flattening it, so a track appears in the picker iff it's listed in a cup.
// New track: add the descriptor to TRACKS above, then drop its id into a cup here.
// Cup order IS the difficulty ladder; each cup's biome is
// mapped in native/libttp-runtime/ttp/theme.cc CUP_BIOME (Backyard keeps the
// canonical grass look), reached from here through the `cup` field
// gen-track-defs-header.mjs carries into the C++ catalogue.
//
// `difficulty` (1–4) belongs to the CUP, never to a track: it sets how well the CPU
// fill drives (ttp::aiSkillForTier). It is data only — no screen renders it — and
// the codegen refuses a cup without one.
//
// `stripSpeed` is a car's speed ceiling on the cup's road strip, as a share of
// what it would be on the asphalt. It follows how the strip LOOKS (theme.cc),
// not the ladder: deep powder holds a car back most, flat felt least.
//
// `botMistakes` spreads the cup's bot field: how many times as often as the
// front bot the last one runs wide, the seats between evenly spaced
// (ttp::aiSeatMistakes). Per cup, not per difficulty: tuned with
// `npm run probe:balance` so its regular driver's top-half share falls from
// cup to cup, and its casual driver reaches the top half of about half the
// Beach cups. 1 keeps the whole field at the cup's skill.
export const CUPS = [
  { id: 'beach',    name: 'Beach Cup',    difficulty: 1, stripSpeed: 0.85, botMistakes: 3, tracks: ['tidepool', 'cove', 'driftwood', 'riptide'] }, // easy: flowing sweepers + hops (beach biome)
  { id: 'snow',     name: 'Snow Cup',     difficulty: 2, stripSpeed: 0.65, botMistakes: 5, tracks: ['powder', 'flurry', 'glacier', 'avalanche'] }, // medium: gentle-mid crossings, hills and jumps (snow biome)
  { id: 'backyard', name: 'Backyard Cup', difficulty: 3, stripSpeed: 0.80, botMistakes: 8, tracks: ['ribbon', 'pretzel', 'tangle', 'cloverleaf'] }, // middle: seeded multi-crossing circuits (grass biome)
  { id: 'canyon',   name: 'Canyon Cup',   difficulty: 3, stripSpeed: 0.70, botMistakes: 5, tracks: ['wash', 'gulch', 'crag', 'sidewinder'] },   // hard: hairpins + stacked crossings (canyon biome)
  // crazy: stunts (playroom biome — orange plastic track).
  // id stays 'rooftop' (wired into CUP_BIOME/selections); only the display name moved.
  { id: 'rooftop',  name: 'Playroom Cup', difficulty: 4, stripSpeed: 0.85, botMistakes: 1, tracks: ['skysnake', 'skyline', 'helix', 'gauntlet'] }
];

// id → { cup, cupName, cupDifficulty } so each track knows its cup for the picker. Validate
// ids first (a cup naming a track absent from TRACKS would otherwise vanish silently).
const CUP_OF = {};
for (const c of CUPS) {
  for (const id of c.tracks) if (!TRACKS[id]) throw new Error(`CUPS references unknown track "${id}"`);
  for (const id of c.tracks) CUP_OF[id] = { cup: c.id, cupName: c.name, cupDifficulty: c.difficulty };
}

// Stable display order for the gallery / picker — every cup's tracks, in cup order.
const TRACK_ORDER = CUPS.flatMap((c) => c.tracks);

// Flat list — {id, name, cup, cupName, cupDifficulty, segments, waypoints,
// startU, oils, pads, boxes, poles} in cup order.
//
// The shipped game does NOT build from this list: its catalogue is codegen'd into the
// wasm from TRACKS (scripts/gen-track-defs-header.mjs → track_defs.h) and read back out
// at boot. TRACK_LIST feeds everything that previews or derives from the authored data
// instead — the display/controller TestHarnesses, the trailer editor, the schematic and
// export bakes, and the unit tests that iterate every shipped track. So a new descriptor
// field reaches the GAME only through the codegen; copy it here too, or the previews
// silently disagree with the game. `startU` and `sand` are two of those; `width` is
// deliberately absent because no descriptor sets it (the shipped width games are
// per-SEGMENT).
export const TRACK_LIST = TRACK_ORDER.map((id) => ({
  id, name: TRACKS[id].name,
  cup: CUP_OF[id].cup, cupName: CUP_OF[id].cupName, cupDifficulty: CUP_OF[id].cupDifficulty,
  segments: TRACKS[id].segments, waypoints: TRACKS[id].waypoints, startU: TRACKS[id].startU, sand: TRACKS[id].sand,
  sandOff: TRACKS[id].sandOff,
  oils: TRACKS[id].oils, pads: TRACKS[id].pads, boxes: TRACKS[id].boxes, poles: TRACKS[id].poles
}));
