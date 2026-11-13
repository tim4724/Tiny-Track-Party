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
const BEACH_SAND = 1.1;

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
// (straight climbs, each cresting in a hop) to the top deck at 5.2 world, the S-S
// weave in the sky, round the top corner and down the SNAKE (one long dive) to the
// board, then home past a toy loop. Composed by scripts/compose-stunt.mjs (solved
// grid and first legs + the loop's probe-measured roll trim).
export const SKYSNAKE = [
  straight(35.837),                                                  // grid straight (closure-solved)
  arc(RL, -90),                                                      // east
  straight(12),                                                      // (closure-solved)
  straight(10, { rise: 1.3, pillars: true }),                        // LADDER 1 → 2.6 world
  straight(8, { pillars: true }),                                    // the mid deck
  arc(RL, -90, { pillars: true }),                                   // south
  straight(8, { pillars: true }),
  straight(10, { rise: 1.3, pillars: true }),                        // LADDER 2 → 5.2 world
  straight(6, { pillars: true }),                                    // (its kicker's landing)
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
// names a composed model (scripts/gen-set-pieces.mjs, or modelled in Blender by
// scripts/gen-set-prototypes.mjs) and places it by `u`
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
// Any but a mound, a clear, a street, a snake or a ladder may carry a `tint`, 0xRRGGBB, a
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
// is under the kerb from the seat; a rise keeps its height to `w` units
// inside the waterline (every other form is flat long before) and fills the
// sand up to it, adding nothing where raised ground already stands, low and broad
// (a dozen units of radius: the ground's 9 u grid cannot draw less) with a
// flat `top`, so the piece on it stands at the road's height. The piece must
// level nothing (set_prototypes.py on_a_rise()), or its clearing cuts down to
// the rise's foot by the kerb: it stands on the plain, and takes the rise's
// height as its `y`.
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
    { kind: 'paint', yaw: 105.07, x: -4.41, z: -27.75, len: 36.35, r: 4, w: 5, tint: 0xdde7f5 },
    { kind: 'paint', yaw: 48.37, x: -10.43, z: 14.69, len: 32.51, r: 4, w: 5, tint: 0xdde7f5 }
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
  'set-penguin-group': [{ kind: 'mound', x: -8, h: 2.6, r: 12, r1: 9, rz: 11, shape: 1.2 }],
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
  'set-bandstand': [{ kind: 'mound', h: 3.2, r: 10.5, r1: 15, rz: 14, shape: 0.6 }],
  // Tangle's brook lies in its own bed, a reach at a time: the low line the
  // valley's sides and the land raised toward the road stand over, so its
  // water lies level across: each bed is its reach's chord.
  'set-brook-a': [{ kind: 'plain', x: -1.38, z: 0.14, len: 16.4, r: 1.6, w: 2.5 }],
  'set-brook-b': [{ kind: 'plain', x: -0.43, z: 0.08, len: 23.1, r: 1.6, w: 2.5 }],
  'set-brook-c': [{ kind: 'plain', x: 0.59, z: -0.09, len: 22.8, r: 1.6, w: 2.5 }],
  'set-brook-d': [{ kind: 'plain', x: 0.98, z: -0.29, len: 20.9, r: 1.6, w: 2.5 }],
  'set-brook-e': [{ kind: 'plain', x: 1.81, z: -0.32, len: 22, r: 1.6, w: 2.5 }],
  'set-brook-f': [{ kind: 'plain', x: 4.61, z: -0.61, len: 19.7, r: 1.6, w: 2.5 }],
  'set-brook-g': [{ kind: 'plain', x: 1.24, z: -0.78, len: 21.5, r: 1.6, w: 2.5 }],
  // Ribbon's church on the churchyard's own level ground, cut into the
  // terrace it stands on, the green before it: on the slope as it was, the
  // tower stood a storey deep in the hill.
  'set-village-church': [{ kind: 'fan', x: 0.5, len: 10, r: 12, h: 1.9, top: 0.6 }],
  // Pretzel's den camp on a bank of its own, the same shape.
  // Tidepool's knoll at the lap's waist, its rock standing on its road side.
  'set-tidepool-knoll': [{ kind: 'mound', x: -3, h: 4.5, r: 10, r1: 12, rz: 13, shape: 1.3 }],
  // Wash's creek, the stretch by the road: the bed is the low line the raised
  // land stands over between its cut banks, the wash's own land carrying on
  // from both ends (turned 90 so the spine runs along the creek's X).
  'set-dry-creek': [{ kind: 'plain', yaw: 90, len: 76, r: 6, w: 8, h: 1.5 }],
  'set-wash-bed': [{ kind: 'plain', len: 38, r: 7, w: 8, h: 1.5 }],
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
  // pieces with the train riding through the hill. The builder lays the
  // rails on a smooth curve through the chords' ends (set_prototypes.py
  // ore_line). A form's x/z is in its own turned frame
  // (TtpRenderer::setupTerrain).
  'set-ore-line': [
    { kind: 'plain', yaw: 71.57, x: 0.16, z: 1.9, len: 2.85, r: 6, w: 5 },
    { kind: 'plain', yaw: 47.64, x: 1.49, z: 5.27, len: 4.6, r: 6, w: 5 },
    { kind: 'plain', yaw: 25.58, x: 4.23, z: 10.76, len: 8.6, r: 6, w: 5 },
    { kind: 'plain', yaw: -4.48, x: 11.2, z: 15.14, len: 8.46, r: 6, w: 5 },
    { kind: 'plain', yaw: -12.12, x: 13.68, z: 21.66, len: 7.89, r: 6, w: 5 },
    { kind: 'plain', yaw: -21.63, x: 17.72, z: 27.05, len: 8.12, r: 6, w: 5 },
    { kind: 'plain', yaw: -22.76, x: 18.33, z: 35.51, len: 9.51, r: 6, w: 5 },
    { kind: 'plain', yaw: -7.1, x: 6.78, z: 49.23, len: 11.02, r: 6, w: 5 },
    { kind: 'plain', yaw: 16.29, x: -15.51, z: 58.41, len: 10.95, r: 6, w: 5 },
    { kind: 'plain', yaw: 39.19, x: -39.14, z: 58.28, len: 10.92, r: 6, w: 5 },
    { kind: 'plain', yaw: 62.12, x: -60.89, z: 48.99, len: 11.08, r: 6, w: 5 }
  ]
};

// The height a model's SET_GROUND mounds and fans give at (x, z) in its own
// frame, over the plain: the highest mound and the fans lying on it, as the
// renderer composes them (TtpRenderer::landforms) and the Blender builder builds on them
// (set_prototypes.py set_ground(), which cannot import this).
export function setGroundY(model, x, z) {
  let mounds = 0, fans = 0;
  for (const f of SET_GROUND[model] || []) {
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
  // Every Beach track carries a sand strip beside the asphalt (plan units per side).
  tidepool: {
    name: 'Tidepool', sand: BEACH_SAND, waypoints: GEN_TRACKS.tidepool,
    oils: genFurn('tidepool').oils, pads: genFurn('tidepool').pads, boxes: genFurn('tidepool').boxes,
    // Low tide: the reef the sea left bare is the land the lap drives
    // beside. On the two outer bends the sea comes in to a few strides past
    // the kerb (the `shore`s) and the reef stands between them, rounded,
    // weathered rock a car's height and more from the kerb out into the surf
    // (out at the waterline, and low, it lay under the road's own kerb and
    // read as grey specks): the east bend's with seals hauled out a stride
    // from the road, the west bend's taller, a headland with its sea arch and
    // a stack, gulls over them. The big rock pool lies beside the low west
    // run that points at it, people at its edge, the crab fishers' landing
    // just before it. Off the east bend, where the east run points, Seal Rock
    // stands in open water, seals on its ledges. Inland, grassy downs fill
    // both lobes of the lap, their flanks to the kerb, and at the lap's waist
    // a knoll with the same rock breaking out of it; the rock-poolers' vans
    // are parked along their gravel lane by the start straight.
    set: [
      { model: 'set-tidepool-knoll', u: 0.5, lat: 13 },
      { model: 'set-rock-pool', u: 0.675, lat: 16.7, yaw: 4 },
      { model: 'set-seal-rock', u: 0.235, lat: 25 },
      // the reef in three forms on the outsides of the bends, where the
      // camera swings to them: the seals' shelf round the east bend, the
      // headland and its sea arch where the west run points, the stacks at
      // the west bend's end (each built along its bend, placed on the road)
      { model: 'set-reef-shelf', u: 0.32, lat: 0 },
      { model: 'set-tidepool-headland', u: 0.72, lat: 0 },
      { model: 'set-crab-boat', u: 0.76, lat: 0 },
      { model: 'set-reef-stacks', u: 0.83, lat: 0 },
      { model: 'set-lifeboat-station', u: 0.9, lat: 10, y: 0.9, scale: 1.2 },
      { model: 'set-tidepool-cottages', u: 0.585, lat: -11, yaw: 180 },
      { model: 'set-crab-pots', u: 0.64, lat: 9.6, yaw: 10, y: 1.13 },
      { model: 'set-rock-poolers-park', u: 0.965, lat: 9.5 },
      // palms on the downs' near flanks below the crests, placed by hand:
      // the `clear`s that keep seeded crates off the hilltops keep its
      // seeded palms off too
      { model: 'set-palm-stand', u: 0.15, lat: -9, yaw: 180 },
      { model: 'set-palm-stand', u: 0.42, lat: -9, yaw: 180 }
    ],
    land: [
      // the sea round Seal Rock and up to the reef on the east bend
      { kind: 'shore', u: 0.27, lat: 14.7, len: 100, r: 30 },
      { kind: 'shore', u: 0.79, lat: 9.7, len: 80, r: 30 },
      // the downs filling the east lobe, their flanks to the kerb of the east
      // run and the top run; a lower grassy rise in the west lobe
      { kind: 'ridge', u: 0.25, lat: -32, len: 30, r: 22, h: 11, top: 0.2, tint: 0x6faa62 },
      { kind: 'ridge', u: 0.15, lat: -12, len: 36, r: 9, h: 4, top: 0.2, near: 0.5 },
      { kind: 'ridge', u: 0.42, lat: -12, len: 30, r: 9, h: 4, top: 0.2, near: 0.5 },
      { kind: 'ridge', u: 0.75, lat: -27, r: 18, h: 7, top: 0.2, tint: 0x6faa62 },
      { kind: 'ridge', u: 0.66, lat: -11, len: 30, r: 8, h: 3.5, top: 0.2, near: 0.5 },
      { kind: 'ridge', u: 0.9, lat: -12, len: 30, r: 8, h: 3.5, top: 0.2, near: 0.5 },
      // the near flanks' grass painted down to the kerb: a ridge's own tint
      // fades out toward its foot, which left the downs a green cap on bare
      // sand
      { kind: 'paint', u: 0.15, lat: -12, len: 36, r: 6, w: 4, tint: 0x6faa62 },
      { kind: 'paint', u: 0.42, lat: -12, len: 30, r: 6, w: 4, tint: 0x6faa62 },
      { kind: 'paint', u: 0.66, lat: -11, len: 30, r: 5.5, w: 4, tint: 0x6faa62 },
      { kind: 'paint', u: 0.9, lat: -12, len: 30, r: 5.5, w: 4, tint: 0x6faa62 },
      // the knoll at the waist (the piece brings it: SET_GROUND), green to
      // the kerb; and the downs across the road
      { kind: 'paint', u: 0.5, lat: 16, len: 14, r: 9, w: 5, tint: 0x6faa62 },
      { kind: 'clear', u: 0.5, lat: 16, len: 14, r: 11 },
      { kind: 'ridge', u: 0.494, lat: -19, yaw: -79, len: 12, r: 11, h: 4.5, top: 0.2, tint: 0x6faa62 },
      // the lifeboat station's rock over the beach, at the road's height
      { kind: 'ridge', u: 0.9, lat: 17, len: 10, r: 13, h: 0.9, top: 0.55, near: 0.4, w: 5 },
      // the hard the crab fishers' landing stands on, at the hop's height
      { kind: 'ridge', u: 0.64, lat: 17, len: 6, r: 13, h: 1.15, top: 0.55, near: 0.4, w: 5 },
      // the sand the tide has just left, darker and cooler round the reef
      { kind: 'paint', u: 0.31, lat: 13, len: 44, r: 5, w: 5, tint: 0xc4bcae },
      { kind: 'paint', u: 0.78, lat: 13, len: 44, r: 5, w: 5, tint: 0xc4bcae },
      { kind: 'paint', u: 0.546, lat: 15.5, len: 30, r: 7, w: 6, tint: 0xc4bcae },
      // nothing seeded on the downs: a crate on a crest read as a prop
      // dropped on a hilltop
      { kind: 'clear', u: 0.25, lat: -32, len: 30, r: 22 },
      { kind: 'clear', u: 0.15, lat: -12, len: 36, r: 9 },
      { kind: 'clear', u: 0.42, lat: -12, len: 30, r: 9 },
      { kind: 'clear', u: 0.75, lat: -27, r: 18 },
      { kind: 'clear', u: 0.66, lat: -11, len: 30, r: 8 },
      { kind: 'clear', u: 0.9, lat: -12, len: 30, r: 8 }
    ]
  },
  cove: {
    name: 'Cove', sand: BEACH_SAND, waypoints: GEN_TRACKS.cove,
    oils: genFurn('cove').oils, pads: genFurn('cove').pads, boxes: genFurn('cove').boxes,
    // The pirates' island: a jungle island with black-sand coves. Its
    // peak, green with jungle, fills the middle of the lap, its foothills
    // coming down to the kerb of the east straight and the start straight,
    // tall groves of palms on them, and the crew's cave cut into a spur of
    // the start straight's foothill, where the grid looks. Past the first
    // bend the crew's camp stands on the sand; down the east straight their
    // lookout watches the east beach from its tower, and the rope bridge
    // from the jungle to it spans the road, which the straight drives at
    // and under. The sea comes in to the road round the bay (its `shore`),
    // the wharf along its black sand where the longboat sails out to the
    // ship riding at anchor and back. Outside the S an old stepped temple
    // the jungle has half taken back faces Skull Rock across the road. The
    // old wreck lies in the surf of the west bay's black sand (the second
    // `shore`), its ribs out of the water, palms along the bay past it. The
    // east foothill falls away toward its north end and carries no grove,
    // so the ship shows over it down the straight.
    // The sea cannot come to the start: the curve is polar about the origin,
    // which lies on the start straight, so its outer side is never the
    // road's reach (native/renderer/CLAUDE.md).
    set: [
      { model: 'set-pirate-ship', u: 0.483, lat: 17.5, yaw: 230, y: 0.15, scale: 1.4 },
      { model: 'set-jungle-grove', u: 0.56, lat: -8, yaw: 180 },
      { model: 'set-jetty', u: 0.44, lat: 11.5 },
      { model: 'set-shipwreck-ribs', u: 0.8, lat: 19, yaw: 20, y: -0.35, scale: 1.25 },
      { model: 'set-pirate-camp', u: 0.09, lat: 10.0, yaw: -20, y: 0.9 },
      { model: 'set-skull-rock', u: 0.64, lat: 20, yaw: 30 },
      { model: 'set-jungle-ruin', u: 0.655, lat: -10.5, yaw: 180 },
      // the cave levels nothing (its gear drapes) and the land's 9 u chords
      // rise under it, so it is lifted onto them
      { model: 'set-smugglers-cave', u: 0.975, lat: -7.4, yaw: 180, y: 0.9 },
      { model: 'set-jungle-grove', u: 0.93, lat: 9.5 },
      // the lookout and its rope bridge stand on the road's own line, over it
      { model: 'set-pirate-lookout', u: 0.27, lat: 0 },
      { model: 'set-jungle-grove', u: 0.235, lat: 11 },
      { model: 'set-jungle-grove', u: 0.745, lat: -11, yaw: 180 },
      { model: 'set-jungle-grove', u: 0.775, lat: 8.8 },
      // palms on the beach outside the west bend, where the chase camera
      // looks through it (the bend's inside wraps round on the camera's left,
      // out of its frame)
      { model: 'set-palm-stand', u: 0.84, lat: 7.8, yaw: 20 },
      // ...and a low green rise past the bend's exit, south of the start
      // straight's head, palms on it: what the camera looks at coming out
      { model: 'set-palm-stand', u: 0.88, lat: 9, yaw: 10 }
    ],
    // The peak and the headland are green with the scrub and jungle that
    // hold them (bare and peaked, a hill that size is a desert dune; the
    // beach's own hills say so, theme.cc). The tint is a wash over the
    // ground's 9 u grid, so only a crest that wide and a tint that deep
    // reads green from the road.
    land: [
      // the island's peak in the middle of the lap; its foothills come down
      // to the east straight and the start straight
      { kind: 'ridge', u: 0.27, lat: -32, len: 40, r: 24, r1: 20, h: 15, h1: 9, top: 0.15, tint: 0x3fae52 },
      { kind: 'ridge', u: 0.22, lat: -21, len: 30, r: 18, r1: 10, h: 5.5, h1: 1, top: 0.2, near: 4, tint: 0x7ab878 },
      { kind: 'ridge', u: 0.96, lat: -22, len: 40, r: 18, h: 5, top: 0.2, near: 6, tint: 0x7ab878 },
      // the spur the cave is cut into, green down to the cave's rock
      { kind: 'ridge', u: 0.975, lat: -15.5, len: 18, r: 8, h: 6, top: 0.25, near: 2.8, tint: 0x7ab878 },
      { kind: 'paint', u: 0.975, lat: -12, len: 16, r: 5, w: 4, tint: 0x7ab878 },
      // low green hills inside the S-bends before the finish
      { kind: 'ridge', u: 0.835, lat: -20, yaw: 40, len: 16, r: 11, h: 3, top: 0.3, tint: 0x6aaa6a },
      { kind: 'ridge', u: 0.81, lat: -11.5, yaw: 20, len: 12, r: 8, h: 4.6, top: 0.3, near: 0.5, tint: 0x6aaa6a },
      { kind: 'ridge', u: 0.885, lat: -20, len: 16, r: 12, h: 2.5, top: 0.25, near: 2, tint: 0x7ab878 },
      { kind: 'ridge', u: 0.885, lat: 13, len: 16, r: 8, h: 3.4, top: 0.3, near: 0.5, tint: 0x6aaa6a },
      // the grassy rise the east beach's grove stands on
      { kind: 'ridge', u: 0.222, lat: 17, len: 26, r: 10, h: 3.2, top: 0.3, near: 2.3, tint: 0x7ab878 },
      // the headland behind Skull Rock, a ridge running out to the west
      // shore past the rock's clearing (which would cut any flank nearer
      // the road)
      { kind: 'ridge', u: 0.64, lat: 44, yaw: 90, len: 26, r: 18, h: 10, top: 0.2, tint: 0x6aaa6a },
      { kind: 'shore', u: 0.45, lat: 11, len: 70, r: 30 },
      // the island down to the kerb of the S on its west side
      { kind: 'ridge', u: 0.58, lat: -14, len: 44, r: 10, h: 5, top: 0.25, near: 0.5 },
      { kind: 'paint', u: 0.58, lat: -14, len: 44, r: 7, w: 4, tint: 0x5f9f5f },
      { kind: 'shore', u: 0.795, lat: 17, len: 24, r: 18 },
      // the camp's own rise on the east beach: its shelter, its fire and its
      // pirates stand at the road's height instead of under the kerb
      { kind: 'ridge', u: 0.09, lat: 17, len: 8, r: 13, h: 0.92, top: 0.55, near: 0.4, w: 4 },
      // the foothill's face before the cave, green to the kerb (a facet of
      // it lay bare sand on the hillside)
      { kind: 'paint', u: 0.94, lat: -13, len: 14, r: 5, w: 5, tint: 0x7ab878 },
      // no seeded crate on the island's face above the bend past Skull Rock
      { kind: 'clear', u: 0.69, lat: -10, len: 20, r: 6 },
      // the coves' black sand, from the kerb's foot down into the surf
      { kind: 'paint', u: 0.45, lat: 13, len: 60, r: 6, w: 4, tint: 0x34333a },
      { kind: 'paint', u: 0.795, lat: 15, len: 34, r: 9, w: 4, tint: 0x34333a }
    ]
  },
  driftwood: {
    name: 'Driftwood', sand: BEACH_SAND, waypoints: GEN_TRACKS.driftwood,
    oils: genFurn('driftwood').oils, pads: genFurn('driftwood').pads, boxes: genFurn('driftwood').boxes,
    // A storm coast of dunes: the long diagonal is a pass between them, bare
    // sand inland and grass-topped on the seaward side, and it drives
    // straight at the lighthouse on the point where it comes out onto the
    // beach; the start straight runs past the fishermen's tarred net huts
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
      { model: 'set-strand-snags', u: 0.15, lat: -9.5, yaw: 180 },
      { model: 'set-driftwood-trunk', u: 0.298, lat: -8.6, yaw: 180 },
      { model: 'set-strand-line', u: 0.339, lat: -10.2, yaw: 176 },
      { model: 'set-strand-groynes', u: 0.389, lat: -9.5, yaw: 180 },
      { model: 'set-bonfire', u: 0.468, lat: -10.2, yaw: 160, y: 0.87 },
      { model: 'set-driftwood-forts', u: 0.438, lat: -11.0, y: 0.86 },
      // the fishers' upturned-boat stores where the pass leaves the beach
      { model: 'set-boat-huts', u: 0.575, lat: 10.5 },
      // storm fence and marram along the dune pass, a length each side
      { model: 'set-dune-fence-a', u: 0.655, lat: 9.4 },
      { model: 'set-dune-fence-b', u: 0.735, lat: -9.6, yaw: 180 },
      // the lighthouse's dune at the pass's end, the road through it in a
      // tunnel, and the light on its seaward shoulder (8.4 up)
      { model: 'set-lighthouse-dune', u: 0.79, lat: 0 },
      { model: 'set-lighthouse', u: 0.7953, lat: -11, yaw: 180, y: 8.4 },
      // a beach boat working in and out past the groynes
      { model: 'set-drift-coble', u: 0.389, lat: 0, scale: 1.5 },
      // the storm's wrack piled on the point where the road turns back
      { model: 'set-point-wrack', u: 0.852, lat: -10.5, yaw: 180 },
      // the smokehouse where the start straight bends away, which it points at
      { model: 'set-smokehouse', u: 0.075, lat: -10.5, yaw: 180 },
      // they level nothing (their gear drapes), so the bank can rise behind
      // them; lifted to the verge they stand on
      { model: 'set-net-huts', u: 0.97, lat: -8.6, yaw: 180, y: 0.59 }
    ],
    land: [
      // the dune pass: the long diagonal runs between dunes either side
      { kind: 'ridge', u: 0.53, lat: 23, yaw: 25, len: 14, r: 19, h: 4.0, top: 0.5 },
      { kind: 'ridge', u: 0.62, lat: 28, yaw: -12, len: 18, r: 23, h: 4.0, top: 0.5 },
      { kind: 'ridge', u: 0.71, lat: 27, yaw: 25, len: 16, r: 22, h: 3.8, top: 0.5 },
      { kind: 'ridge', u: 0.79, lat: 22, yaw: -15, len: 12, r: 17, h: 3.6, top: 0.5 },
      { kind: 'ridge', u: 0.57, lat: -24, yaw: -20, len: 16, r: 19, h: 5.2, top: 0.2, near: 3, tint: 0xa8d090 },
      { kind: 'ridge', u: 0.66, lat: -26, yaw: 12, len: 20, r: 20, h: 6.4, top: 0.2, near: 3, tint: 0xa8d090 },
      { kind: 'ridge', u: 0.75, lat: -23, yaw: -25, len: 14, r: 18, h: 4.8, top: 0.2, near: 3, tint: 0xa8d090 },
      // the great dune in the middle of the loop, over the rest
      { kind: 'ridge', u: 0.62, lat: 50, yaw: 20, len: 30, r: 22, h: 5.5, top: 0.6 },
      // dunes inside the start straight and the east side
      { kind: 'ridge', u: 0.95, lat: 22, yaw: 20, len: 16, r: 16, h: 3.0, top: 0.5 },
      { kind: 'ridge', u: 0.03, lat: 23, yaw: -25, len: 14, r: 16, h: 2.5, top: 0.5 },
      { kind: 'ridge', u: 0.18, lat: 21, yaw: 20, len: 14, r: 15, h: 2.0, top: 0.5 },
      // a low grassy line of dunes inland of the strand line, the sea side
      // left open
      // kept low: ridge heights add, so taller ones here stacked with the
      // dune behind into a pale peak over the run down to the strand
      { kind: 'ridge', u: 0.315, lat: 13, yaw: 20, len: 12, r: 8, h: 2.2, top: 0.3, near: 0.5, tint: 0xa8d090 },
      { kind: 'ridge', u: 0.37, lat: 13.5, len: 16, r: 8.5, h: 2.6, top: 0.3, near: 0.5, tint: 0xa8d090 },
      { kind: 'ridge', u: 0.425, lat: 13, yaw: -25, len: 12, r: 8, h: 2.2, top: 0.3, near: 0.5, tint: 0xa8d090 },
      // the grassy bank the net huts back into
      { kind: 'ridge', u: 0.975, lat: -18.5, len: 26, r: 6.5, h: 3, top: 0.3, near: 6.5, tint: 0xa8d090 },
      // marram at the dunes' feet along the pass, a green wash by the kerb
      // where the inland faces were bare sand
      { kind: 'paint', u: 0.61, lat: 12, len: 36, r: 4, w: 5, tint: 0xa8d090 },
      { kind: 'paint', u: 0.73, lat: 12, len: 36, r: 4, w: 5, tint: 0xa8d090 },
      // the fort's and the fire's rise on the strand, at the road's height
      // (a beach rise)
      { kind: 'ridge', u: 0.452, lat: -16, len: 16, r: 12, h: 0.85, top: 0.55, near: 0.4, w: 2 },
      // nothing seeded on the dunes' faces
      { kind: 'clear', u: 0.56, lat: 14, len: 40, r: 9.5 },
      { kind: 'clear', u: 0.67, lat: 14, len: 40, r: 9.5 },
      { kind: 'clear', u: 0.78, lat: 14, len: 30, r: 9.5 },
      { kind: 'clear', u: 0.56, lat: -14, len: 40, r: 9.5 },
      { kind: 'clear', u: 0.67, lat: -14, len: 40, r: 9.5 },
      { kind: 'clear', u: 0.78, lat: -14, len: 30, r: 9.5 },
      { kind: 'clear', u: 0.99, lat: 14, len: 50, r: 9.5 },
      { kind: 'clear', u: 0.18, lat: 14, len: 30, r: 9 },
      { kind: 'clear', u: 0.34, lat: 11, len: 26, r: 6 },
      { kind: 'clear', u: 0.41, lat: 11, len: 26, r: 6 },
      // the storm sea comes up the beach to the strand line it left
      { kind: 'shore', u: 0.37, lat: -16.2, len: 110, r: 40 }
    ]
  },
  riptide: {
    name: 'Riptide', sand: BEACH_SAND, waypoints: GEN_TRACKS.riptide,
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
      { model: 'set-lifeguard-tower', u: 0.19, lat: -10, y: 0.78 },
      // the seafront: the sea wall along the kerb on the sea side, in four
      // lengths, and across the road the hotel and the guest houses
      { model: 'set-seafront-wall-a', u: 0.2614, lat: -9.5, yaw: 180 },
      { model: 'set-seafront-wall-b', u: 0.2921, lat: -9.5, yaw: 180 },
      { model: 'set-seafront-wall-c', u: 0.3229, lat: -9.5, yaw: 180 },
      { model: 'set-seafront-wall-d', u: 0.3536, lat: -9.5, yaw: 180 },
      { model: 'set-seafront-hotel', u: 0.2941, lat: 9 },
      { model: 'set-seafront-terrace', u: 0.3316, lat: 9 },
      { model: 'set-seafront-cafe', u: 0.369, lat: 9 },
      { model: 'set-promenade', u: 0.393, lat: -8.2, yaw: 180 },
      { model: 'set-surf-club', u: 0.09, lat: -11, yaw: 180, y: 0.8 },
      { model: 'set-surf-campers', u: 0.715, lat: -8.8, yaw: 180, y: 0.8 },
      { model: 'set-surf-contest', u: 0.84, lat: -9.5, yaw: 180 },
      { model: 'set-beach-day', u: 0.905, lat: -10.5, yaw: 180, y: 0.85 },
      { model: 'set-channel-beacon', u: 0.458, lat: -9.5 },
      { model: 'set-lagoon-fleet', u: 0.52, lat: -18, yaw: 180 },
      { model: 'set-sailing-club', u: 0.62, lat: -11, yaw: 180 },
      // palms on the Point's lower flank, placed by hand (its `clear` keeps
      // the seeded ones off), none on the marram dune
      { model: 'set-palm-stand', u: 0.95, lat: -9, yaw: 180 },
      // the coastguard's lookout on the Point's flank over the start straight
      { model: 'set-coastguard-lookout', u: 0.03, lat: -12, yaw: 180, y: 4.5 }
    ],
    land: [
      { kind: 'shore', u: 0.23, lat: -12.2, len: 90, r: 30 },
      { kind: 'shore', u: 0.53, lat: 10, len: 40, r: 30, w: 17 },
      // the sea under the pier: its `w` lets the bay in past the causeway's
      // reach on that bearing (the polar shore keeps 5 u past it otherwise),
      // held narrow so no road meets it
      { kind: 'shore', u: 0.40, lat: -13, len: 16, r: 10, w: 9 },
      // the Point, a big grassy headland north of the start straight, its
      // foothill climbing from the straight's kerb; the interior's great
      // marram dune, its flank along the north run
      { kind: 'ridge', u: 0.97, lat: -30, len: 50, r: 20, h: 12, top: 0.2 },
      { kind: 'ridge', u: 0.0, lat: -12, len: 50, r: 9, h: 4, top: 0.2, near: 0.5 },
      // their grass painted down the flanks to the kerb, so the headland is
      // green, not a dune with a green cap
      { kind: 'paint', u: 0.97, lat: -30, len: 50, r: 14, w: 6, tint: 0x5f9f5f },
      { kind: 'paint', u: 0.0, lat: -12, len: 50, r: 6, w: 4, tint: 0x5f9f5f },
      { kind: 'ridge', u: 0.85, lat: 35, r: 18, h: 9, top: 0.2, tint: 0xa8d090 },
      { kind: 'ridge', u: 0.84, lat: 12, len: 40, r: 9, h: 4.5, top: 0.2, near: 0.5, tint: 0xa8d090 },
      // the patrol's patch of sand where the cars land off the hop
      { kind: 'ridge', u: 0.19, lat: -17, len: 12, r: 13, h: 0.78, top: 0.55, near: 0.4, w: 6 },
      // the surf club's rise by the hop and the camp's by the hook, each at
      // the road's height (a beach rise)
      { kind: 'ridge', u: 0.09, lat: -18, len: 10, r: 13, h: 0.8, top: 0.55, near: 0.4, w: 6 },
      { kind: 'ridge', u: 0.715, lat: -17, len: 22, r: 13, h: 0.9, top: 0.55, near: 0.4, w: 6 },
      { kind: 'ridge', u: 0.905, lat: -17, len: 14, r: 13, h: 0.88, top: 0.55, near: 0.4, w: 6 },
      { kind: 'clear', u: 0.97, lat: -30, len: 50, r: 20 },
      { kind: 'clear', u: 0.0, lat: -12, len: 50, r: 9 },
      { kind: 'clear', u: 0.85, lat: 35, r: 18 },
      { kind: 'clear', u: 0.84, lat: 12, len: 40, r: 9 }
    ]
  },
  // Snow Cup — SEEDED medium circuits (the gentle end of the mid profile: low brake
  // fraction, no hairpins, roomy radii, but real crossings + hills; auto-placed furniture).
  powder: {
    name: 'Powder', waypoints: GEN_TRACKS.powder,
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
      { model: 'set-ski-lift', u: 0.9, lat: -32.5, yaw: 180 },
      { model: 'set-ski-school', u: 0.54, lat: -10.2, yaw: 160 },
      { model: 'set-powder-peaks', u: 0.03, lat: -60 },
      { model: 'set-powder-chairlift', u: 0.0317, lat: 0 },
      { model: 'set-powder-forest-a', u: 0.9749, lat: -17.75 },
      { model: 'set-powder-forest-b', u: 0.0691, lat: -18.92 },
      { model: 'set-powder-forest-c', u: 0.1109, lat: -13.45 },
      { model: 'set-powder-forest-d', u: 0.5939, lat: -14.87 },
      { model: 'set-powder-forest-e', u: 0.3311, lat: 17.72 },
      { model: 'set-powder-forest-f', u: 0.6284, lat: -15.4 },
      { model: 'set-powder-forest-g', u: 0.4238, lat: -19.86 },
      { model: 'set-powder-forest-h', u: 0.4816, lat: -11.2 },
      // the snowman family on the outside verge of the east bend, at road
      // height, ahead of a car coming over the hump off the start straight
      { model: 'set-snowman-field', u: 0.15, lat: -7, yaw: 180 }
    ],
    land: [
      // the foothills at the start straight's and the east bend's kerb
      { kind: 'ridge', u: 0.9782, lat: -36.46, r: 34, h: 11, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.0619, lat: -36.46, r: 34, h: 12, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.0952, lat: -31.51, r: 28, h: 11, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.1379, lat: -31.57, r: 28, h: 11, top: 0.2, near: 2 },
      // the massif behind them, each summit carrying a peak (set-powder-peaks)
      { kind: 'ridge', u: 0.9708, lat: -69.87, r: 34, h: 18, top: 0.15 },
      { kind: 'ridge', u: 0.056, lat: -81.93, r: 40, h: 20, top: 0.12 },
      { kind: 'ridge', u: 0.079, lat: -65.97, r: 36, h: 18, top: 0.12 },
      { kind: 'ridge', u: 0.1109, lat: -54.04, yaw: 1.8, z: -0.86, len: 50, r: 28, h: 14, top: 0.12 },
      { kind: 'ridge', u: 0.9494, lat: -57.92, r: 36, h: 14, top: 0.12 },
      // the spur at the south-west bend, running back to the ski mountain
      { kind: 'ridge', u: 0.5929, lat: -33.78, r: 30, h: 18, top: 0.12, near: 2 },
      { kind: 'ridge', u: 0.6006, lat: -39.99, yaw: 156.6, len: 34, r: 30, h: 18, top: 0.12 },
      // the ski mountain's shoulder by the west lobe, the east hill by the
      // run down from the crossings, the foothill past the descent to the
      // ski school, the knoll in the bay north of the south loop
      { kind: 'ridge', u: 0.3289, lat: 37.16, r: 34, h: 18, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.4248, lat: -31.52, r: 28, h: 14, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.4855, lat: -29.42, r: 26, h: 11, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.6274, lat: -25.74, r: 22, h: 7, top: 0.25, near: 2 },
      // nothing seeded on the east verge of the run down from the crossings:
      // a pine the east hill raised there stood with its crown behind the
      // deck from the road below
      { kind: 'clear', u: 0.425, lat: -9, len: 26, r: 5 },
      // nor between the road and the snowman family
      { kind: 'clear', u: 0.15, lat: -4.5, len: 10, r: 2 }
    ]
  },
  flurry: {
    name: 'Flurry', waypoints: GEN_TRACKS.flurry,
    oils: genFurn('flurry').oils, pads: genFurn('flurry').pads, boxes: genFurn('flurry').boxes,
    set: [
      { model: 'set-frozen-lake', u: 0.3355, lat: -11.4, yaw: 180 },
      // the village round the lap, close by the road where a racer reads a
      // cabin (see:landmarks): by the start, past the lake in the bend's
      // inside, on the east loop, on the run in
      { model: 'set-log-cabin', u: 0.05, lat: 9, yaw: 30 },
      { model: 'set-log-cabin', u: 0.392, lat: 8, yaw: 20 },
      { model: 'set-log-cabin', u: 0.675, lat: -9, yaw: 150 },
      { model: 'set-log-cabin', u: 0.875, lat: 11, yaw: 75 },
      { model: 'set-flurry-peaks-ne', u: 0.64, lat: 45 },
      { model: 'set-flurry-peaks-sw', u: 0.12, lat: 45 },
      { model: 'set-ski-jump', u: 0.5413, lat: 19.59, yaw: 101.7 },
      // the village piste down the foothill outside the east loop, cut
      // through the forest between stands b and c, the groomer working it,
      // skiers coming down it to the verge
      { model: 'set-flurry-piste', u: 0.684, lat: 12, yaw: 0 },
      { model: 'set-flurry-forest-a', u: 0.5849, lat: 9.11 },
      { model: 'set-flurry-forest-b', u: 0.6598, lat: 13.14 },
      { model: 'set-flurry-forest-c', u: 0.7086, lat: 11.15 },
      { model: 'set-flurry-forest-d', u: 0.1371, lat: 15.35 },
      { model: 'set-flurry-forest-e', u: 0.1894, lat: 14.39 },
      // the west gap the start straight looks into: a clump where the outrun
      // of the old jump stood at the first bend, and pines on the low far ridge
      { model: 'set-flurry-forest-f', u: 0.095, lat: 10.5 },
      { model: 'set-flurry-forest-g', u: 0.075, lat: 50 },
      { model: 'set-flurry-peaks-nw', u: 0.39, lat: -70 },
      // forest in the hollows of the north-west ridge's face and along its
      // foot (the frame the ridge's: +X up the face, +Z along it)
      { model: 'set-flurry-forest-h', u: 0.39, lat: -50 },
      { model: 'set-flurry-forest-i', u: 0.39, lat: -50 },
      { model: 'set-flurry-forest-j', u: 0.39, lat: -50 },
      { model: 'set-flurry-forest-k', u: 0.39, lat: -50 },
      // (the belt along the foot is the full tier's: the box keeps the hollows)
      { model: 'set-flurry-forest-l', u: 0.39, lat: -50, lite: false },
      { model: 'set-flurry-forest-m', u: 0.39, lat: -50, lite: false },
      { model: 'set-flurry-peaks-se', u: 0.92, lat: -68 }
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
      { kind: 'plain', u: 0.4413, lat: 5, yaw: -142, len: 54, r: 3, w: 5, tint: 0xc8e0f6 },
      // past the east loop: the foothills at its kerb, the massif behind, the
      // ski jump cut into the first one's south shoulder
      { kind: 'ridge', u: 0.5816, lat: 31, r: 28, h: 10, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.6598, lat: 32.65, r: 30, h: 11, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.7109, lat: 31.05, r: 28, h: 9, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.6337, lat: 33.68, r: 34, h: 18, top: 0.12 },
      { kind: 'ridge', u: 0.5903, lat: 42.93, r: 30, h: 15, top: 0.12 },
      { kind: 'ridge', u: 0.6848, lat: 49.96, r: 34, h: 18, top: 0.12 },
      // past the west loop: the same
      { kind: 'ridge', u: 0.1371, lat: 30.95, r: 28, h: 10, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.1907, lat: 29.39, r: 26, h: 9, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.1186, lat: 46.36, r: 34, h: 18, top: 0.12 },
      { kind: 'ridge', u: 0.16, lat: 51.74, r: 30, h: 15, top: 0.12 },
      // the open west gap the start straight looks into, closed low and far
      // off, under the frame's top from the grid and short of the terrain's
      // west edge, pines on its near face (forest-g)
      { kind: 'ridge', u: 0.09, lat: 57.5, len: 20, r: 20, h: 10, top: 0.15 },
      // the far ridges along the long sides
      { kind: 'ridge', u: 0.39, lat: -70, len: 100, r: 28, h: 15, top: 0.15 },
      { kind: 'ridge', u: 0.92, lat: -68, len: 80, r: 28, h: 13, top: 0.15 },
      // the north-west ridge's face is no one white wall: spurs run down it
      // toward the valley, each its own length and height, hollows between
      // them in a little shade, forest up the hollows and along the foot to
      // a ragged treeline (forest-h to -k, sampled, set_prototypes.py
      // FORESTS). All inside the ridge's own reach.
      { kind: 'ridge', u: 0.39, lat: -51, z: -33, yaw: 90, len: 14, r: 10, h: 5.5, top: 0.2 },
      { kind: 'ridge', u: 0.39, lat: -49, z: -5, yaw: 78, len: 18, r: 11, h: 6.5, top: 0.2 },
      { kind: 'ridge', u: 0.39, lat: -52, z: 24, yaw: 100, len: 12, r: 9, h: 4.5, top: 0.2 },
      { kind: 'paint', u: 0.39, lat: -52, z: -19, yaw: 90, len: 14, r: 4, w: 5, tint: 0xdbe4f4 },
      { kind: 'paint', u: 0.39, lat: -52, z: 10, yaw: 90, len: 14, r: 4, w: 5, tint: 0xdbe4f4 }
    ]
  },
  glacier: {
    name: 'Glacier', waypoints: GEN_TRACKS.glacier,
    oils: genFurn('glacier').oils, pads: genFurn('glacier').pads, boxes: genFurn('glacier').boxes,
    set: [
      // the snow castle, its gate to the road
      { model: 'set-snow-fort', u: 0.232, lat: -12.5, yaw: 180 },
      { model: 'set-expedition-camp', u: 0.738, lat: -12, yaw: 0 },
      // each rookery turned so its white fronts face the road and the car
      // coming at it: one off the run into the bottom loop, one below the NE
      // bend's crest
      { model: 'set-penguin-group', u: 0.665, lat: 9.5, yaw: 35 },
      { model: 'set-penguin-group', u: 0.37, lat: 8, yaw: 35 },
      // beside the raised straight: the dog team's trail along the drift on
      // its left, the flagged crevasses of the glacier's snout on its right
      { model: 'set-glacier-dog-trail', u: 0.432, lat: -8.5, yaw: 180 },
      { model: 'set-glacier-crevasses', u: 0.52, lat: 15, yaw: 0 },
      // the advanced camp up on the crest of the glacier's lateral bank, on
      // the snow as drawn (no bank of its own: a bank's foot withholds the
      // land it stands in, and nearer the road the ground is held down to the
      // decks by the grid cells the roads cross, so a camp there sinks
      // behind the raised east leg)
      { model: 'set-advanced-camp', u: 0.886, lat: -19.5, yaw: 20 },
      { model: 'set-penguin-chute', u: 0.97, lat: -15, yaw: 137 },
      // the range over the top straight (`land` lays the snowfield and the
      // foothills in front of it)
      { model: 'set-glacier-peaks', u: 0.185, lat: -60 },
      // the range on round the valley's south side, and on the massif east of
      // the east leg
      { model: 'set-glacier-peaks-south', u: 0.661, lat: -70 },
      { model: 'set-glacier-peaks-east', u: 0.45, lat: -66 },
      // the expedition's airstrip inside the top loop, beside the top straight
      { model: 'set-glacier-airstrip', u: 0.2, lat: 9 },
      // pines up the face of the foothill over the bottom loop, so it reads as
      // mountainside, not a white wall (sampled, set_prototypes.py FORESTS)
      { model: 'set-glacier-forest-a', u: 0.8423, lat: 14.87 }
    ],
    // Each piece stands where a racer reads it from the chase camera (the
    // see:landmarks probe), not where the old sight-line score put it: the
    // fort and its igloo camp at the end of the top straight, short of the
    // corridor down the middle whose vista the box cannot also pay a fort
    // for; the rookeries close by the low road; the expedition's base camp
    // and its smaller advanced camp by the bends.
    // The glacier: a tongue of blue ice flows down from the massif in the
    // west, low in the valley between two snow ridges, into the middle of the
    // map, ending among the penguins by the long legs; the terminal moraine
    // the ice left lies at the far end of the lap, which the long legs drive
    // straight at
    land: [
      { kind: 'ridge', u: 0.0491, lat: -126.1, yaw: 151, len: 60, r: 42, h: 28 },
      { kind: 'ridge', u: 0.9954, lat: -71.7, yaw: -122, z: 7, len: 136, r: 15, r1: 9, h: 5.5, h1: 1.2, top: 0.5, tint: 0x74b4f0 },
      // the bands the ice carries down its lower tongue (ogives)
      { kind: 'paint', u: 0.9454, lat: -36.57, yaw: 148.5, len: 18, r: 2, w: 4, tint: 0x5c9be6 },
      { kind: 'paint', u: 0.9709, lat: -53.51, yaw: 148, len: 20, r: 2, w: 4, tint: 0x5c9be6 },
      { kind: 'paint', u: 0.9954, lat: -70.48, yaw: 148.2, len: 22, r: 2, w: 4, tint: 0x5c9be6 },
      { kind: 'ridge', u: 0.0092, lat: -51.4, yaw: -122, x: 8, z: -5, len: 80, r: 13, h: 11, h1: 3.5, top: 0.15 },
      { kind: 'ridge', u: 0.7405, lat: -55.3, yaw: -65, x: -3, z: -5, len: 80, r: 13, h: 11, h1: 3.5, top: 0.15 },
      { kind: 'ridge', u: 0.6671, lat: -18.9, yaw: -172, len: 70, r: 22, h: 4.5, top: 0.55, tint: 0xbcb8c0 },
      // The range over the top straight's outside stands 45 to 90 units back
      // (set-glacier-peaks; its peaks drape on the land, so a swell under one
      // is its foot). At u 0.185 the frame is the world's: lat is Z, z is X.
      // The snowfield between the road and the range rises in one broad, low
      // swell, whose reach is the furthest north Glacier's land goes: no form
      // below reaches past it, since a form reaching further out would move
      // every vertex of the ground's grid round the lap (native/renderer/
      // CLAUDE.md, authored landforms).
      { kind: 'ridge', u: 0.185, lat: -38, z: -40, len: 50, r: 34, h: 1.2 },
      // ...a swell under the far western peak and one in front of the middle
      // one...
      { kind: 'ridge', u: 0.185, lat: -40, z: -109, len: 20, r: 20, h: 5, top: 0.15 },
      { kind: 'ridge', u: 0.185, lat: -52, z: -44, len: 24, r: 18, h: 3, top: 0.15 },
      // ...two rows of snowy foothills in front of the rest, short of the
      // fort's clearing...
      { kind: 'ridge', u: 0.185, lat: -48, z: -24, len: 20, r: 14, h: 3 },
      { kind: 'ridge', u: 0.185, lat: -45, z: 16, len: 22, r: 13, h: 2.8 },
      { kind: 'ridge', u: 0.185, lat: -24, z: -54, yaw: 40, len: 14, r: 15, h: 2.5 },
      { kind: 'ridge', u: 0.185, lat: -30, z: -17, len: 26, r: 13, h: 2.2 },
      { kind: 'ridge', u: 0.185, lat: -33, z: 43, len: 20, r: 12, h: 2.5 },
      // ...and drifts on the snowfield between them and the road, too low to
      // stand into the picture however close they pass
      { kind: 'ridge', u: 0.185, lat: 0, z: -35, yaw: 30, len: 12, r: 7, h: 1.6 },
      { kind: 'ridge', u: 0.185, lat: -18, z: 9, len: 18, r: 7, h: 1.8 },
      // nothing seeded on the verge in front of the penguin chute's pool: a
      // boulder there stood between the run to the line and the pool
      { kind: 'clear', u: 0.955, lat: -9.5, len: 30, r: 5 },
      // ...nor between the road and the airstrip, where two pines stood in
      // front of the plane on the closest pass
      { kind: 'clear', u: 0.212, lat: 5.5, len: 22, r: 2.5 },
      // foothills rising off the outside verge of the NE bend, the east leg,
      // the return beside it, the run from the line and the corner onto the
      // top straight (their flanks low where the near ramp ends),
      // the massif behind them carrying set-glacier-peaks-east
      { kind: 'ridge', u: 0.2775, lat: -27.31, r: 24, h: 5, top: 0.25, near: 2 },
      { kind: 'ridge', u: 0.3168, lat: -27.36, r: 24, h: 5.5, top: 0.25, near: 2 },
      { kind: 'ridge', u: 0.4286, lat: -27.3, r: 24, h: 6.5, top: 0.25, near: 2 },
      { kind: 'ridge', u: 0.846, lat: 27.32, r: 24, h: 6, top: 0.25, near: 2 },
      { kind: 'ridge', u: 0.6143, lat: -25.81, r: 22, h: 6, top: 0.25, near: 2 },
      { kind: 'ridge', u: 0.0817, lat: -25.72, r: 22, h: 3.5, top: 0.25, near: 2 },
      { kind: 'ridge', u: 0.1338, lat: -25.77, z: -0.49, r: 22, h: 3.5, top: 0.25, near: 2 },
      { kind: 'ridge', u: 0.3027, lat: -54.42, r: 30, h: 12, top: 0.15 },
      { kind: 'ridge', u: 0.8661, lat: 61.97, r: 32, h: 13, top: 0.15 },
      { kind: 'ridge', u: 0.8209, lat: 47.88, z: 0.97, r: 28, h: 7, top: 0.15 },
      // past the moraine: the snowfield the south range stands over, a swell
      // under each of its summits
      { kind: 'ridge', u: 0.6596, lat: -41.43, yaw: 171.8, len: 100, r: 26, h: 1.6 },
      { kind: 'ridge', u: 0.6435, lat: -74.3, r: 18, h: 4, top: 0.15 },
      { kind: 'ridge', u: 0.6558, lat: -65.99, r: 22, h: 5, top: 0.15 },
      { kind: 'ridge', u: 0.67, lat: -56.79, r: 20, h: 4, top: 0.15 },
      { kind: 'ridge', u: 0.6842, lat: -60.98, z: -0.99, r: 18, h: 3, top: 0.15 }
    ]
  },
  avalanche: {
    name: 'Avalanche', waypoints: GEN_TRACKS.avalanche,
    oils: genFurn('avalanche').oils, pads: genFurn('avalanche').pads, boxes: genFurn('avalanche').boxes,
    set: [
      { model: 'set-avalanche-slide', u: 0.76, lat: 16 },
      { model: 'set-windsock', u: 0.894, lat: 7.5, yaw: 48 },
      // the mountainside outside the top loop: three avalanche paths come
      // down through its forest to the road, a warning sign at the foot of
      // the first two, the third coming down onto the snow shed's roof
      // a log cabin by the crossing, a little back from it
      { model: 'set-avalanche-cabin', u: 0.232, lat: -17.5, yaw: 150 },
      { model: 'set-warning-sign', u: 0.27, lat: 4.4, yaw: 44 },
      // ...and the first path's slide come down across the road, ploughed
      // through (the blocks stand at the ground sampled under them)
      { model: 'set-avalanche-debris-lobe', u: 0.276, lat: 0 },
      { model: 'set-warning-sign', u: 0.317, lat: 4.4, yaw: 46 },
      // and at the foot of the west slope's path, at the turn onto the crossing
      { model: 'set-warning-sign', u: 0.085, lat: -4.4, yaw: 115 },
      // forest down the mountainside, the S-bend's spur, the west slope and the
      // wedge inside the S, kept off the paths (sampled, set_prototypes.py FORESTS)
      { model: 'set-avalanche-forest-a', u: 0.2693, lat: 15.72 },
      { model: 'set-avalanche-forest-b', u: 0.3120, lat: 13.43 },
      { model: 'set-avalanche-forest-c', u: 0.3420, lat: 17.80 },
      { model: 'set-avalanche-forest-d', u: 0.3922, lat: 17.58 },
      { model: 'set-avalanche-forest-e', u: 0.4190, lat: 16.98 },
      { model: 'set-avalanche-forest-f', u: 0.0943, lat: -10.71 },
      { model: 'set-avalanche-forest-g', u: 0.5700, lat: -13.62 },
      { model: 'set-avalanche-forest-h', u: 0.0300, lat: 11.75 },
      // forest on the cirque's lower faces up to a ragged treeline, trimmed
      // along the slide's chute (sampled, set_prototypes.py FORESTS)
      { model: 'set-avalanche-forest-i', u: 0.7165, lat: 28.61 },
      { model: 'set-avalanche-forest-j', u: 0.7785, lat: 26.84 },
      { model: 'set-avalanche-forest-k', u: 0.8458, lat: 16.93 },
      { model: 'set-avalanche-slope', u: 0.87, lat: 16, yaw: 20 },
      { model: 'set-avalanche-slope', u: 0.1, lat: -32.5, yaw: 160 },
      // Where the road runs under the mountains, on the outside of the last
      // loop, it is cut into the mountainside and roofed over: two galleries,
      // each with the cut it stands in, astride the road. The shorter on the
      // run to the slide's foot, in the cut through the spur's toe; the
      // longer on the straight after the slide. Each piece carries the road's
      // centreline and the land beside it in its own frame (set_prototypes.py
      // ROAD_A/FACE_A, ROAD_B/FACE_B), so a gallery's u here, its samples
      // there and the land below move together: re-sample them after either.
      { model: 'set-avalanche-gallery-short', u: 0.722, lat: 0 },
      { model: 'set-avalanche-gallery', u: 0.825, lat: 0 },
      // the third, on the run west along the top loop under the mountainside,
      // where the third avalanche path comes down onto its roof; the plough at
      // work at its east mouth (set_prototypes.py ROAD_C / FACE_C: re-sample
      // with the road or the land)
      { model: 'set-avalanche-gallery-loop', u: 0.37, lat: 0 },
      // the crags the southern massif's crest breaks out in (`land`): the
      // snow keeps their 9 u facets, rock in them read as stripes on a dome.
      // (The western massif's summit crags were hidden by the spur from
      // every seat; its east face's ribs carry its rock.)
      { model: 'set-avalanche-crags', u: 0.8349, lat: 52.1, yaw: 3 },
      // the high peaks the slides start from, east of the mountainside, its
      // stands their foothills (the piece's frame is the world's: yaw cancels
      // the road's heading at u 0.276)
      { model: 'set-avalanche-peaks-east', u: 0.276, lat: 48.12, yaw: -167.06 },
      // the cirque's faces: ribs of rock down their fall lines, a cornice and
      // a band of rock over the slide's crown, a piece a face so no footprint
      // spans the loop (the frames the world's)
      { model: 'set-avalanche-ribs-w', u: 0.7075, lat: 38.7, yaw: 24.87 },
      { model: 'set-avalanche-ribs-slide', u: 0.766, lat: 42.97, yaw: -29.84 },
      // big old firs in the wedge inside the S-bend (sampled, set_prototypes.py FORESTS)
      { model: 'set-avalanche-forest-l', u: 0.9936, lat: 17.14 }
    ],
    // The mountains round the last loop, its outside a cirque the slide comes
    // down into: a spur off the western massif runs down to the kerb, the
    // short gallery's cut through its toe; the southern massif's flank stands
    // off the verge along the long gallery's straight, a peak on it and a
    // lower one toward the cirque's slope. Every flank stands `near` the kerb
    // (the galleries' cuts stand in front of it) and joins the slide's
    // mountain either side of its chute, clear of its forest.
    land: [
      { kind: 'ridge', u: 0.7156, lat: 24.0, yaw: -101, x: -0.8, len: 32, r: 10, r1: 24, h: 8, h1: 14, top: 0.3, near: 3.8 },
      { kind: 'ridge', u: 0.7091, lat: 67.4, x: 0.6, z: -1.5, r: 62, h: 28, top: 0.1, near: 3.8 },
      { kind: 'ridge', u: 0.8349, lat: 52.1, yaw: 3, len: 20, r: 62, h: 28, top: 0.1, near: 3.8 },
      { kind: 'ridge', u: 0.8371, lat: 64.0, r: 20, h: 10, near: 3.8 },
      { kind: 'ridge', u: 0.8587, lat: 61.8, x: -4.4, z: 2.6, r: 40, h: 18, top: 0.1, near: 3.8 },
      // no rock cluster on the open snow the run to the loop looks over: it
      // stood alone on the plain like a dropped asset
      { kind: 'clear', u: 0.605, lat: -10, r: 1 },
      // The mountainside outside the top loop: foothills rising off the
      // verge (their flanks low where the near ramp ends) round its east end
      // and its north-west corner, and over the run west where the third
      // snow shed stands, its face at the kerb, steep as the cirque's (the
      // shed's cut stands in front of it); the massif behind, reaching no
      // further than the track's own region (a form past it moves the
      // ground's grid, and the galleries' cuts stand on that ground as it was
      // sampled); a spur on the S-bend's outside. Down it, three paths the
      // slides keep clear of forest, their snow churned (paint).
      { kind: 'ridge', u: 0.281, lat: 32.55, z: -0.65, r: 30, h: 13, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.3152, lat: 32.6, z: -0.68, r: 30, h: 14, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.4076, lat: 29.43, z: 0.52, r: 26, h: 11, top: 0.2, near: 2 },
      { kind: 'ridge', u: 0.3517, lat: 25, yaw: 158, len: 10, r: 26, h: 18, top: 0.15, near: 3.8 },
      { kind: 'ridge', u: 0.3334, lat: 43.16, z: -0.75, r: 24, h: 18, top: 0.12 },
      { kind: 'ridge', u: 0.3012, lat: 45.94, z: 0.56, r: 28, h: 16, top: 0.12 },
      { kind: 'ridge', u: 0.3883, lat: 42.95, r: 28, h: 16, top: 0.12 },
      { kind: 'ridge', u: 0.5721, lat: -29.36, r: 26, h: 11, top: 0.2, near: 2 },
      // The ground's region held where the warning signs' cones set it (east
      // and south) before this mountainside replaced them: a region that
      // moves moves every vertex of the ground's 9 u grid, and the cirque's
      // faces and the two cirque galleries' cuts (sampled, ROAD_A/FACE_A,
      // ROAD_B/FACE_B) stand on the ground as it was drawn. Each clears a
      // unit of scatter and does nothing else.
      { kind: 'clear', u: 0.277, lat: 0, yaw: -168.87048, x: 89.0467, z: 6.5189, r: 1 },
      { kind: 'clear', u: 0.374, lat: 0, yaw: 93.24529, x: -4.1748, z: -82.9726, r: 1 },
      // the west slope's foot brought down to the turn, its path churned
      { kind: 'ridge', u: 0.0943, lat: -27.78, z: 0.6, r: 24, h: 10, top: 0.2, near: 2 },
      { kind: 'paint', u: 0.0971, lat: -15.76, yaw: 119.6, x: 0.57, len: 22, r: 3, w: 3, tint: 0xc8cfdf },
      { kind: 'paint', u: 0.2819, lat: 18.89, yaw: -87.3, len: 28, r: 3, w: 3, tint: 0xc8cfdf },
      { kind: 'paint', u: 0.3334, lat: 19.81, yaw: 99.3, x: 0.51, len: 32, r: 3, w: 3, tint: 0xc8cfdf },
      { kind: 'paint', u: 0.3549, lat: 19.27, yaw: 67.9, len: 30, r: 3, w: 3, tint: 0xc8cfdf }
    ]
  },
  // Backyard Cup — SEEDED multi-crossing circuits (overpasses on their own ramps,
  // decorated mid profile; auto-placed furniture).
  ribbon: {
    name: 'Ribbon', waypoints: GEN_TRACKS.ribbon,
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
    // near end they stood in the view of the church). The
    // windmill turns in the north loop beside its wheat field, a rectangle
    // well inside the kerbs; the sheep graze round the loop's outside and
    // under the flyover, and the dairy farm stands inside the west bend. A
    // piece's box holds the verge band down under it (bandHold), so nothing
    // here is one piece over a whole loop: every box keeps 2 u or more off
    // the kerbs, and the road keeps its verge.
    set: [
      { model: 'set-village-church', u: 0.32107, lat: 21.693, yaw: 39.34 },
      { model: 'set-village-street', u: 0.37873, lat: 4, yaw: 1 },
      { model: 'set-village-street-b', u: 0.41257, lat: 4, yaw: 0 },
      { model: 'set-village-street-c', u: 0.3812, lat: -4.05, yaw: 180 },
      { model: 'set-village-street-d', u: 0.4145, lat: -4, yaw: 180 },
      { model: 'set-cottage-row', u: 0.608, lat: -7.6, yaw: 176.98 },
      { model: 'set-windmill', u: 0.6, lat: 13, yaw: 0 },
      { model: 'set-field-wheat', u: 0.6977, lat: 12, yaw: 7.7 },
      { model: 'set-village-fete', u: 0.0125, lat: 8.6, yaw: 0 },
      { model: 'set-orchard-block', u: 0.126, lat: -7.5 },
      { model: 'set-orchard-block', u: 0.1395, lat: -7.5, yaw: 180 },
      { model: 'set-orchard-block-b', u: 0.1535, lat: -7.5, yaw: 180 },
      { model: 'set-orchard-block', u: 0.163, lat: -7.5 },
      { model: 'set-orchard-block', u: 0.1815, lat: -7.5, yaw: 180 },
      { model: 'set-orchard-block-b', u: 0.191, lat: -7.5, yaw: 180 },
      { model: 'set-orchard-block', u: 0.2, lat: -7.5 },
      { model: 'set-orchard-block', u: 0.219, lat: -7.5, yaw: 180 },
      { model: 'set-orchard-block-b', u: 0.229, lat: -8.4, yaw: 180 },
      { model: 'set-orchard-block', u: 0.239, lat: -8.6 },
      { model: 'set-orchard-block', u: 0.249, lat: -8.6, yaw: 180 },
      { model: 'set-orchard-block-end', u: 0.259, lat: -7.7 },
      { model: 'set-cow-farm', u: 0.892, lat: -8.7, yaw: 180 },
      { model: 'set-sheep-meadow', u: 0.7, lat: -8, yaw: 180 },
      { model: 'set-sheep-flock', u: 0.758, lat: -6.8, yaw: 180 },
      { model: 'set-hay-meadow', u: 0.458, lat: -9, yaw: 180 }
    ],
    // the valley the village lies in: the west side rises off the west
    // bend's verge (`near`) to a terrace above it, the east terraces climb
    // behind the street, the south hill stands behind the orchard and the
    // north-east hill behind the sheep; past the street's end the west side
    // comes down to the verge as a hay bank
    land: [
      { kind: 'ridge', u: 0.915, lat: 23.1, yaw: -4, len: 44, r: 20, h: 7, top: 0.25, near: 0.6 },
      { kind: 'ridge', u: 0.92746, lat: 29.818, yaw: 2.68, len: 100, r: 9, h: 3, top: 0.45 },
      { kind: 'ridge', u: 0.38249, lat: 25.92, yaw: 156.65, len: 120, r: 16, h: 3, top: 0.6 },
      { kind: 'ridge', u: 0.37558, lat: 34.185, yaw: 157.64, len: 100, r: 9, h: 3, top: 0.45 },
      { kind: 'ridge', u: 0.2, lat: -36, len: 60, r: 24, h: 8, top: 0.35 },
      { kind: 'ridge', u: 0.66022, lat: -22, r: 24, h: 9, top: 0.15 },
      { kind: 'ridge', u: 0.458, lat: -13.3, len: 10, r: 10, h: 3, top: 0.4, near: 0.6 },
      { kind: 'street', u: 0.39565, len: 32 }
    ]
  },
  pretzel: {
    name: 'Pretzel', waypoints: GEN_TRACKS.pretzel,
    oils: genFurn('pretzel').oils, pads: genFurn('pretzel').pads, boxes: genFurn('pretzel').boxes,
    // The children's summer on sun-yellowed downs (the theme's ground colour;
    // theme.cc backyardTrack): the treehouse oak on the flat outside the
    // north-west bend, straight ahead down the avenue of oaks the diagonal
    // ends in; the pitch beside the diagonal, greener than the downs, bunting
    // down its road-side touchline; the children's blanket den under its oak
    // where the racer comes off the diagonal's top; under four great oaks out
    // by the bends a picnic left out, a hay wain loaded, a trampoline, a
    // paddling pool;
    // the kite hill rising off the verge beyond the top loop, three kites up
    // over its face on their stakes. Nobody is about (children that small
    // read as specks). The other trees a racer passes are the lawn's own
    // scatter of the garden's broadleaf oaks.
    set: [
      { model: 'set-avenue-oaks', u: 0.01011, lat: 5.5, yaw: 0 },
      { model: 'set-avenue-oaks', u: 0.01011, lat: -5.5, yaw: 180 },
      { model: 'set-treehouse', u: 0.0561, lat: 10.59, yaw: 22.49, scale: 1.3 },
      { model: 'set-football-pitch', u: 0.91, lat: -8.6, yaw: 1.41 },
      { model: 'set-den-camp', u: 0.565, lat: 8.3, scale: 1.4 },
      { model: 'set-swing-oak', u: 0.17, lat: 7.5, yaw: 39.71 },
      { model: 'set-swing-oak', u: 0.755, lat: -9, yaw: 142.46 },
      { model: 'set-picnic-oak', u: 0.86, lat: 7, yaw: 0 },
      { model: 'set-hay-wain-oak', u: 0.52, lat: 6.5, yaw: 0 },
      { model: 'set-trampoline-oak', u: 0.115, lat: 6.5, yaw: 0 },
      { model: 'set-paddling-pool-oak', u: 0.34, lat: 6.5, yaw: 0 },
      { model: 'set-kite-flyers', u: 0.715, lat: -11.5, yaw: 180 }
    ],
    // low wide downs round the lap's outsides, each rising off the verge
    // (`near`) gently enough to keep its grass (a steep face goes to earth)
    land: [
      { kind: 'clear', u: 0.01011, len: 28, r: 14 },
      { kind: 'ridge', u: 0.715, lat: -21, len: 22, r: 20, h: 7, top: 0.2, near: 0.6 },
      { kind: 'ridge', u: 0.674, lat: -15, len: 8, r: 14, h: 4, top: 0.2, near: 0.6 },
      { kind: 'ridge', u: 0.81, lat: -18, len: 16, r: 15, h: 4.5, top: 0.2, near: 0.6 },
      { kind: 'ridge', u: 0.11, lat: 27, len: 30, r: 22, h: 6, top: 0.15, near: 0.6 },
      { kind: 'ridge', u: 0.5756, lat: 30, r: 20, h: 6.5, top: 0.15 },
      { kind: 'ridge', u: 0.3749, lat: 27, len: 30, r: 22, h: 6.5, top: 0.15, near: 0.6 }
    ]
  },
  tangle: {
    name: 'Tangle', waypoints: GEN_TRACKS.tangle,
    oils: genFurn('tangle').oils, pads: genFurn('tangle').pads, boxes: genFurn('tangle').boxes,
    // The mill valley: wooded sides (set-mill-wood, -b, -c: three woods on the hills in `land`)
    // and the brook down its floor, set below its slate walls (set-brook-*,
    // laid in the world and cut into lengths). It rises at the springhouse
    // beyond the north loop's top straight, goes under it in a pipe, comes
    // out by the kerb and down the north loop to a stone culvert under the
    // start straight, runs down that straight's left kerb to the line, under
    // the second bridge with it, back under the road through a second
    // culvert and round the outside of the first bend through the
    // watermill's race, straight ahead of the grid, its wheel turning in the
    // water to the oncoming cars, and over a sill into the duck pond under
    // the first bridge's west span (`pond`; reeds, a willow and a jetty on
    // its open half).
    set: [
      { model: 'set-watermill', u: 0.0935, lat: 10.8, yaw: 0 },
      { model: 'set-mill-wood', u: 0.885, lat: -12, yaw: 180 },
      { model: 'set-mill-wood-b', u: 0.92, lat: -12.5, yaw: 180 },
      { model: 'set-mill-wood-c', u: 0.955, lat: -12, yaw: 180 },
      { model: 'set-mill-wood', u: 0.995, lat: 12, yaw: 0 },
      { model: 'set-mill-wood-b', u: 0.03, lat: 12.5, yaw: 0 },
      { model: 'set-mill-wood-c', u: 0.58, lat: -8.5, yaw: 180 },
      { model: 'set-mill-wood', u: 0.61, lat: -8.5, yaw: 180 },
      { model: 'set-mill-wood-b', u: 0.285, lat: -9, yaw: 180 },
      { model: 'set-mill-wood-c', u: 0.79, lat: -9, yaw: 180 },
      { model: 'set-mill-wood', u: 0.0959, lat: 22.37, yaw: 17.86 },
      { model: 'set-culvert', u: 0.84819, lat: 4.42, yaw: -33.13 },
      { model: 'set-culvert', u: 0.86152, lat: -4.515, yaw: 148 },
      { model: 'set-culvert', u: 0.024, lat: -4.5, yaw: -147 },
      { model: 'set-culvert', u: 0.0375, lat: 4.42, yaw: 33 },
      { model: 'set-brook-a', u: 0.74132, lat: 11.904, yaw: -76.76 },
      { model: 'set-brook-b', u: 0.89099, lat: -8.088, yaw: 4.96 },
      { model: 'set-brook-c', u: 0.94478, lat: -8.554, yaw: 2.15 },
      { model: 'set-brook-d', u: 0.99622, lat: -7.232, yaw: -7.68 },
      { model: 'set-brook-e', u: 0.06548, lat: 8.641, yaw: -3.89 },
      { model: 'set-brook-f', u: 0.09588, lat: 9.104, yaw: -1.23 },
      { model: 'set-brook-g', u: 0.12394, lat: 10.621, yaw: -15.75 },
      { model: 'set-pond-ducks', u: 0.1474, lat: -9.43, yaw: 180 },
      { model: 'set-springhouse', u: 0.7335, lat: -9.6, yaw: 180 },
      { model: 'set-alder-grove', u: 0.28, lat: -5.8, yaw: 180, scale: 1.1 },
      { model: 'set-alder-grove', u: 0.68, lat: -5.8, yaw: 180 },
      { model: 'set-alder-grove', u: 0.755, lat: -12, yaw: 180, scale: 1.2 },
      { model: 'set-alder-grove', u: 0.905, lat: 5.8, yaw: 0, scale: 0.9 },
      { model: 'set-alder-grove', u: 0.935, lat: -5.3, yaw: 180 },
      { model: 'set-alder-grove', u: 0.03, lat: 5.8, yaw: 0, scale: 1.1 }
    ],
    // the north lawn's hump and the pond under the first bridge; the valley's
    // sides: a hill beyond the stream on each side of the start straight,
    // standing far enough off both strands that its flank is low where it
    // meets the stream (nearer, it stood as a cliff and tipped the reach),
    // the mill's hill behind it, the spring's hill along the north loop's
    // top straight, and hills outside the east loop and the north-east bend
    land: [
      { kind: 'ridge', u: 0.38886, lat: -26.736, yaw: 146.41, r: 12, h: 3, top: 0.2 },
      { kind: 'pond', u: 0.1471, lat: -1.93, yaw: 89.13, len: 15, r: 5.3, w: 6 },
      { kind: 'ridge', u: 0.0538, lat: 32.83, yaw: 8.07, len: 23, r: 26, h: 9, top: 0.1, near: 10.5 },
      { kind: 'ridge', u: 0.8939, lat: -34.87, yaw: 1.04, len: 18, r: 28, h: 9, top: 0.1, near: 7.5 },
      { kind: 'ridge', u: 0.0947, lat: 36, r: 24, h: 8, top: 0.1 },
      { kind: 'ridge', u: 0.757, lat: -20.3, len: 20, r: 15, h: 6.5, top: 0.25, near: 0.6 },
      { kind: 'ridge', u: 0.66, lat: -20, len: 12, r: 15, h: 4.5, top: 0.3, near: 0.6 },
      { kind: 'ridge', u: 0.283, lat: -22, len: 14, r: 20, h: 7.5, top: 0.15, near: 0.6 },
      { kind: 'ridge', u: 0.791, lat: -24, r: 22, h: 7.5, top: 0.1, near: 0.6 }
    ]
  },
  cloverleaf: {
    name: 'Cloverleaf', waypoints: GEN_TRACKS.cloverleaf,
    oils: genFurn('cloverleaf').oils, pads: genFurn('cloverleaf').pads, boxes: genFurn('cloverleaf').boxes,
    // A spring park: cherries in pale blossom, planted as a park plants them,
    // in avenues beside the straights (set-cherry-avenue) and in groves at the
    // bends, few alone on the lawn. The park's miniature railway runs from a
    // loop by the start straight, under the high road, past the bandstand's
    // knoll and along the finger lobe to a loop by the lake, a halt at each
    // end, its one train going out and back (set-park-rails-*, laid by
    // scratch geometry in set_prototypes.py PARK_ROUTE; it crosses no road at
    // grade). The playground on the flat outside the south-west hairpin,
    // where the start straight points: big climbing frames standing on the
    // grass, its hill behind it. The bandstand on its mound close under the
    // high road's outside, level with a racer up on the deck. The boating
    // lake beyond the finger lobe's end, straight ahead down the lobe's first
    // leg: a round pond under a stone lip, an islet with a cherry on it, a
    // stone fountain of a park's size, swan pedalos going round, the
    // boathouse on the near shore. Another corner of the playground in the S
    // between the two decks.
    set: [
      { model: 'set-playground', u: 0.086, lat: -8.6, yaw: 150, scale: 1.5 },
      { model: 'set-play-corner', u: 0.4, lat: -9.5, yaw: 142.61, y: -0.1, scale: 1.45 },
      { model: 'set-park-railway', u: 0.01755, lat: 8.184, yaw: -179.62 },
      { model: 'set-park-rails-a', u: 0.23569, lat: 6.061, yaw: 116.1 },
      { model: 'set-park-rails-b', u: 0.23452, lat: -8.196, yaw: 45.76 },
      { model: 'set-park-rails-c', u: 0.92932, lat: 9.073, yaw: 165.75 },
      { model: 'set-park-rails-d', u: 0.89364, lat: 12.196, yaw: -172.87 },
      { model: 'set-park-rails-e', u: 0.86206, lat: 12.513, yaw: -165.87 },
      { model: 'set-park-rails-loop-a', u: 0.0503, lat: 8.47, yaw: 0 },
      { model: 'set-park-rails-loop-b', u: 0.84393, lat: 19.518, yaw: 0 },
      { model: 'set-park-halt', u: 0.86206, lat: 12.513, yaw: -167.52 },
      { model: 'set-boating-lake', u: 0.8316, lat: 16.16, yaw: -170.59 },
      { model: 'set-boathouse', u: 0.8252, lat: 12.6, yaw: 42.59, scale: 1.3 },
      { model: 'set-bandstand', u: 0.23, lat: -20, yaw: 180, scale: 1.5 },
      { model: 'set-cherry-avenue', u: 0.145, lat: -6.5, yaw: 180 },
      { model: 'set-cherry-avenue', u: 0.525, lat: -6.5, yaw: 180 },
      { model: 'set-cherry-avenue', u: 0.785, lat: 6.5, yaw: 0 },
      { model: 'set-cherry-avenue', u: 0.89, lat: 6.5, yaw: 0 },
      { model: 'set-blossom-grove-b', u: 0.21, lat: -5.8, yaw: 180 },
      { model: 'set-blossom-grove-b', u: 0.38, lat: 6.4, yaw: 0 },
      { model: 'set-blossom-grove', u: 0.47, lat: -5.8, yaw: 180, scale: 1.1 },
      { model: 'set-blossom-grove-b', u: 0.6, lat: -6, yaw: 180 },
      { model: 'set-blossom-grove', u: 0.845, lat: 8.5, yaw: 0 }
    ],
    // the round hill beyond the south bend and a long ridge closing the west,
    // the playground's hill, the lake and the hill behind it, the bandstand's
    // mound (clear of the raised road's stilts), foothills at the S's west
    // leg and beyond the top bend
    land: [
      { kind: 'ridge', u: 0.2, lat: -48, r: 32, h: 10, top: 0.15 },
      { kind: 'ridge', u: 0.0895, lat: -34, r: 20, h: 6, top: 0.2 },
      { kind: 'ridge', u: 0.52, lat: -50, len: 70, r: 26, h: 7, top: 0.2 },
      { kind: 'pond', u: 0.8316, lat: 16.16, yaw: -170.59, len: 4, r: 10, w: 4, tint: 0x8fc2b0 },
      { kind: 'ridge', u: 0.8334, lat: 43.42, yaw: -177.69, len: 30, r: 16, h: 7, top: 0.25 },
      { kind: 'ridge', u: 0.515, lat: -17.3, len: 28, r: 14, h: 5, top: 0.3, near: 0.6 },
      { kind: 'ridge', u: 0.448, lat: -17.06, r: 18, h: 6, top: 0.3, near: 0.6 }
    ]
  },
  // Canyon Cup — SEEDED hard circuits (scan-seeds `hard` profile: hairpins, stacked
  // crossings, width pinches, crest hills; auto-placed furniture).
  wash: {
    name: 'Wash', waypoints: GEN_TRACKS.wash,
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
    // hero's stretch by the north straight (tumbleweeds blowing down it),
    // across the north strand, which fords it at the bed's level, into the
    // east loop and out under the east bend's low trestle (gen-tracks SEEDS
    // `trestle`: the bend's hill stands on pillars over the bed, not on an
    // embankment across it); a side wash comes in from the south across the
    // south strand, another ford. The bed is a shallow
    // channel, so what a racer sees of the wash where the road leaves it is
    // what grows along it: saguaros, ocotillo and
    // brush on its banks (each reach brings a stand on each side), and two
    // dead cottonwoods standing bare over the start's bends, a vulture on
    // each. The high road runs along a sandstone bench over the two low
    // strands, a butte of the strata stands in the knot of strands, and
    // wild burros drink at a tinaja past the east loop. A desert of rock,
    // sand and cactus: nothing green but cactus.
    set: [
      // (a reach a road crosses is a ford: its banks stop on the road's half)
      { model: 'set-dry-creek', u: 0.9221, lat: -18.5, yaw: 112 },
      { model: 'set-dead-cottonwood', u: 0.302, lat: 10.5 },
      { model: 'set-dead-cottonwood', u: 0.95, lat: -10, yaw: -180 },
      { model: 'set-wash-bed', u: 0.7086, lat: -25.2, yaw: -144 },
      { model: 'set-wash-bed-ford', u: 0.68, lat: -3.6, yaw: 77 },
      { model: 'set-wash-bed-ford', u: 0.5997, lat: 10.7, yaw: -64 },
      { model: 'set-wash-bed-ford', u: 0.5941, lat: -19, yaw: 87 },
      { model: 'set-wash-bed', u: 0.5933, lat: -48.9, yaw: 95 },
      { model: 'set-wash-bed', u: 0.5397, lat: -44.4, yaw: -102 },
      { model: 'set-wash-bed-ford', u: 0.5332, lat: -17.6, yaw: 68 },
      { model: 'set-wash-bed-ford', u: 0.5182, lat: 8.6, yaw: -91 },
      // the canyon's mountainsides, each face toward the road: the outer
      // range (left) down the straight, round the bend and on, lower spurs
      // on the inside of the straight and after the bend, the inside of the
      // bend left open so the road ahead stays in sight
      { model: 'set-canyon-peaks-a', u: 0.0198, lat: -5.2, yaw: 180 },
      { model: 'set-canyon-peaks-b', u: 0.0582, lat: -5.2, yaw: 180 },
      { model: 'set-canyon-bend-wash', u: 0.101, lat: -5.2, yaw: 180 },
      { model: 'set-canyon-peaks-c', u: 0.1449, lat: -5.2, yaw: 180 },
      { model: 'set-canyon-spur-a', u: 0.0439, lat: 5.2 },
      { model: 'set-canyon-spur-b', u: 0.1504, lat: 5.2 },
      // a butte of the strata inside the low hairpin, and the tinaja where
      // the side wash meets the road past the east loop, burros at it
      { model: 'set-wash-butte', u: 0.85, lat: -10, scale: 0.75 },
      { model: 'set-bench-ledge', u: 0.318, lat: -9, yaw: 180 },
      { model: 'set-tinaja', u: 0.715, lat: -6, yaw: 180, scale: 1.5 }
    ],
    // the range the canyon's mountainsides belong to, rising behind them
    land: [
      { kind: 'ridge', u: 0.03, lat: -25, len: 30, r: 14, h: 9, top: 0.45, tint: 0xc8846a },
      { kind: 'ridge', u: 0.1, lat: -25, len: 8, r: 14, h: 10, top: 0.45, tint: 0xc8846a },
      { kind: 'ridge', u: 0.15, lat: -25, len: 14, r: 14, h: 7.5, top: 0.45, tint: 0xc8846a },
      { kind: 'ridge', u: 0.044, lat: 18, len: 18, r: 11, h: 6, top: 0.4, tint: 0xc8846a },
      { kind: 'ridge', u: 0.15, lat: 18, len: 12, r: 11, h: 5.5, top: 0.4, tint: 0xc8846a },
      // the wash's far reaches north-west of the creek, its channel only
      { kind: 'plain', u: 0.9863, lat: -74.2, yaw: -112, len: 38, r: 7, w: 8, h: 1.5 },
      { kind: 'plain', u: 0.9728, lat: -54.7, yaw: 66, len: 38, r: 7, w: 8, h: 1.5 },
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
      { kind: 'ridge', u: 0.2838, lat: -8.35, yaw: 1.1, z: 0.25, len: 11.4, r: 6, h: 1.06, h1: 2.00, top: 0.6, near: 0.5 },
      { kind: 'ridge', u: 0.3508, lat: -7.24, yaw: 0.1, z: 0.01, len: 11.9, r: 6, h: 1.3, h1: 1.3, top: 0.6, near: 0.5 },
      { kind: 'ridge', u: 0.2715, lat: 5.68, yaw: -0.1, z: 0.02, len: 11.9, r: 6, h: 1.06, h1: 2.01, top: 0.6, near: 0.5 },
      { kind: 'ridge', u: 0.3078, lat: 6.04, yaw: -0.3, z: -0.10, len: 12.0, r: 6, h: 2.00, h1: 2.00, top: 0.6, near: 0.5 },
      { kind: 'ridge', u: 0.3480, lat: 6.01, yaw: -0.0, z: -0.01, len: 12.1, r: 6, h: 1.3, h1: 1.3, top: 0.6, near: 0.5 },
      { kind: 'ridge', u: 0.3848, lat: 6.35, yaw: -1.1, z: -0.31, len: 7.6, r: 6, h: 1.96, h1: 1.20, top: 0.6, near: 0.5 },
      { kind: 'ridge', u: 0.4500, lat: -7.29, yaw: -2.9, z: 1.53, len: 11.9, r: 6, h: 1.55, h1: 1.47, top: 0.6, near: 0.5 },
      { kind: 'ridge', u: 0.4413, lat: 5.69, yaw: -0.2, z: -0.10, len: 11.9, r: 6, h: 1.55, h1: 2.04, top: 0.6, near: 0.5 }
    ]
  },
  gulch: {
    name: 'Gulch', waypoints: GEN_TRACKS.gulch,
    oils: genFurn('gulch').oils, pads: genFurn('gulch').pads, boxes: genFurn('gulch').boxes,
    // A gold mine at its own size, reached down a canyon of mountainsides off
    // the crest (the long left-hander and the tight bend into the yard). The
    // ore's way is the lap's story: up the shaft under the headframe at the
    // east bend into its ore bin, by the little train along the line to the
    // mine yard, from the yard's tipple up a boarded gallery to the
    // tramway's terminal and in its buckets over the road to the stamp
    // mill, whose waste is the tailings dump. The
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
    // sign swinging; the tailings dump stands by the headframe it came out
    // of, a cart tipping at its top; the miners' camp stands before the canyon. The west of
    // the map is a range of mountains and mesas the descent cuts through.
    set: [
      { model: 'set-mine-portal', u: 0.018, lat: 16 },
      { model: 'set-ore-line', u: 0.018, lat: 16 },
      // the headframe astride the road at the east bend, the ore line's
      // loading shed under its bin on the outside verge where the line ends
      { model: 'set-headframe', u: 0.205, lat: 0 },
      // the gulch itself: off the crest the road drops into a canyon, its
      // faces at the kerb the near faces of the range's massifs (`land`):
      // from the run-in on the outside round the long left-hander, down the
      // straight and round the tight bend into the mine yard, one on the
      // inside round the left-hander (Wash's lengths reused between bends).
      // The crest's left-hander has no face: its shoulder is the land's own
      // (a face there stood as pyramids on the sand from across the map,
      // where the shoulder reads as one banded mountain). The run-in's face
      // starts west of the sight line from the crest's descent to the stamp
      // mill, so the mill reads from there across the yard. The loop's middle
      // stays low: the deck cap holds the land there under the road, and the
      // yard opens on the stamp mill.
      { model: 'set-canyon-peaks-c', u: 0.817, lat: 5.2 },
      { model: 'set-canyon-bend-gulch', u: 0.862, lat: 5.2 },
      { model: 'set-canyon-peaks-a', u: 0.904, lat: 5.2 },
      { model: 'set-canyon-hairpin-gulch', u: 0.937, lat: 5.2 },
      { model: 'set-canyon-spur-a', u: 0.968, lat: 5.2 },
      { model: 'set-canyon-inside-gulch', u: 0.857, lat: -5.2, yaw: 180 },
      // the stamp mill cascading down its spoil heap across the start
      // straight from the adit, its tramway's buckets riding the sagging
      // ropes over the road to the tower beside the adit
      { model: 'set-stamp-mill', u: 0.005, lat: -11, yaw: 180 },
      // the boomtown down the north loop's top, both sides of the road; the
      // tailings dump by the headframe (the inner loop left it no room off
      // the road); the miners' camp before the
      // canyon, the left there left open for the sight line to the mill
      { model: 'set-boomtown-north', u: 0.355, lat: 6.8 },
      { model: 'set-boomtown-south', u: 0.355, lat: -6, yaw: 180 },
      { model: 'set-tailings-dump', u: 0.195, lat: 18.15, yaw: 180 },
      { model: 'set-miners-camp', u: 0.785, lat: 8.3, yaw: -30, scale: 1.2 }
    ],
    // the ridge the mine is in, the shaft's spoil heaps (waste rock, greyer
    // than the land), and the range
    land: [
      { kind: 'ridge', u: 0.0004, lat: 48, len: 80, r: 22, h: 18, top: 0.3 },
      { kind: 'ridge', u: 0.18, lat: 12.5, len: 4, r: 5, h: 4, top: 0.15, near: 2, tint: 0xb0a49c },
      { kind: 'ridge', u: 0.3367, lat: 22.9, len: 14, r: 11, h: 7, top: 0.15, tint: 0xb0a49c },
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
      { kind: 'ridge', u: 0.4194, lat: 20.5, yaw: 172, len: 17, r: 12, h: 11, top: 0.5, near: 2 },
      { kind: 'ridge', u: 0.4414, lat: 23.5, yaw: -168, len: 15, r: 13, h: 14.5, top: 0.45, near: 2 },
      { kind: 'ridge', u: 0.8345, lat: 37.85, yaw: -127.34, len: 32, r: 22, h: 30, h1: 38, top: 0.3, near: 16 },
      { kind: 'ridge', u: 0.8828, lat: 31.9, yaw: -2.48, len: 36, r: 34, h: 36, top: 0.3, near: 16 },
      { kind: 'ridge', u: 0.9292, lat: 28.37, yaw: -35, len: 20, r: 30, h: 38, top: 0.3, near: 16 },
      { kind: 'ridge', u: 0.9542, lat: 30.88, yaw: -0.6, len: 28, r: 30, r1: 24, h: 36, h1: 24, top: 0.3, near: 16 },
      { kind: 'ridge', u: 0.872, lat: 70.8, yaw: 12.18, len: 36, r: 30, h: 46, top: 0.42, lite: false },
      { kind: 'ridge', u: 0.9036, lat: 72.99, yaw: -12.83, len: 20, r: 30, h: 50, top: 0.3, lite: false },
      { kind: 'ridge', u: 0.8221, lat: 92.21, yaw: -21.59, len: 30, r: 26, h: 36, top: 0.3, lite: false },
      { kind: 'ridge', u: 0.8452, lat: 71.26, yaw: -155.83, len: 18, r: 26, h: 46, top: 0.25, lite: false },
      { kind: 'ridge', u: 0.9596, lat: 64.67, yaw: -9.05, len: 30, r: 26, h: 38, top: 0.45, lite: false },
      { kind: 'ridge', u: 0.9382, lat: 70.46, yaw: 30, len: 22, r: 28, h: 46, top: 0.3, lite: false },
      { kind: 'ridge', u: 0.9272, lat: 59.88, r: 30, h: 44, top: 0.38, lite: false }
    ]
  },
  crag: {
    name: 'Crag', waypoints: GEN_TRACKS.crag,
    oils: genFurn('crag').oils, pads: genFurn('crag').pads, boxes: genFurn('crag').boxes,
    // A ranch in butte country. The long straight runs from the ranch on
    // the open plain at its head (house, barn, water tower, the windpump
    // turning, the corral with cattle) down the ranch's fenced range to the
    // rim, the mesa closing the west of the map: at the hairpin the rim's
    // mountainside comes to the verge, round its outside and on along the north
    // straight to the bridge (canyon lengths, set_prototypes.py
    // canyon_mountain, the rim's own massif rising behind them in `land`).
    // Off the bridge the road runs at the mesa standing between the
    // north-east loop and the S, a table with a butte broken away from it
    // past a gap of sky: the loop rounds the table and the S passes the
    // butte. A butte stands on the outside of the south loop's bend and a
    // pair of spires on the outside of each loop (strata over a butte's
    // height, set_prototypes.py crag_butte: a cliff of the one hard
    // sandstone in gullies and buttresses on a talus of one colour, never a
    // striped drum nor one long face), small spires of the same rock between
    // them, and the skyline all round is mesas and buttes of the land. A
    // stand of saguaros marks the start straight. Out on the range the
    // ranch's windpumps
    // turn over their stock tanks near the road, its herds come in to them
    // (a cow alone is a speck from the road; tower, tank and herd read as
    // one). Every wheel, the ranch's included, faces the one wind: the west
    // wind that blows the sand and the clouds east (+X) across the map, its
    // tail vane downwind. Each yaw turns its pump's wheel to the world's -X;
    // the ranch's own is turned inside its piece (set_prototypes.py
    // RANCH_WIND_YAW, for the ranch as it stands here).
    set: [
      { model: 'set-ranch', u: 0.986, lat: -19, yaw: 180 },
      { model: 'set-windpump', u: 0.175, lat: 10, yaw: 90 },
      { model: 'set-windpump', u: 0.58, lat: -13, yaw: 154 },
      { model: 'set-windpump', u: 0.48, lat: 9.5, yaw: -137 },
      { model: 'set-hoodoos', u: 0.32, lat: -12 },
      { model: 'set-hoodoos', u: 0.61, lat: 13, yaw: 180 },
      { model: 'set-hoodoos', u: 0.9, lat: 16 },
      { model: 'set-crag-saguaros', u: 0.05, lat: 10 },
      // the start is the ranch's open range, fenced along both verges, its
      // gateway on the ranch's side (the cup's other starts are a canyon, a
      // mine yard and an oil camp); the rim begins at the hairpin
      { model: 'set-ranch-fence', u: 0.032, lat: -5.4, yaw: 180 },
      { model: 'set-ranch-fence', u: 0.036, lat: 5.4 },
      // the herd on the range inside the fences: a dozen head and calves in
      // loose bunches on the ranch's side, a few more across the road
      { model: 'set-ranch-herd', u: 0.035, lat: -5.9, yaw: 180 },
      { model: 'set-ranch-herd-east', u: 0.02, lat: 5.9 },
      // the rock, each piece's talus coming to a couple of units past the
      // kerb (a chase camera rounding a bend passed through a talus on the
      // road), its blocks out at the ends, never by a kerb
      { model: 'set-rimrock-mesa', u: 0.5845, lat: -35, yaw: 147 },
      { model: 'set-rimrock-spires', u: 0.38, lat: 21, yaw: 20 },
      { model: 'set-rimrock-butte', u: 0.795, lat: 23.5, yaw: 10 },
      { model: 'set-rimrock-mitten', u: 0.865, lat: 17.5, yaw: 200 },
      // the rim's mountainside, each face toward the road (the hairpin's
      // entry is looser than its apex, so its length is bent wider)
      { model: 'set-canyon-hairpin-crag', u: 0.09, lat: -5.2, yaw: 180 },
      { model: 'set-canyon-exit-crag', u: 0.108, lat: -5.2, yaw: 180 },
      { model: 'set-canyon-rim-crag-b', u: 0.134, lat: -5.2, yaw: 180 }
    ],
    land: [
      // the rim: the mesa the canyon lengths are the near faces of, rising
      // from past their backs (`near`, Gulch's massifs), scarcely over their
      // crests, so its flat top shows against the sky down the long straight
      // (taller, it filled the picture as one banded wall, and its steep land
      // is rock the box pays for per pixel), its south end a shoulder short
      // of the ranch
      { kind: 'ridge', u: 0.0968, lat: -26, yaw: -129.3, len: 16, r: 26, h: 12, top: 0.5, near: 16 },
      { kind: 'ridge', u: 0.137, lat: -30, yaw: 0.2, len: 24, r: 24, r1: 18, h: 13, h1: 12, top: 0.5, near: 16 },
      // low swells of the land coming to the kerb out on the range, under
      // the ten units a slope must climb to turn to rock (so sand, and none
      // of the box's dear rock pixels): past the north-east spires, before
      // the bend beyond them, and on the S's outside, joining the mesa's
      // broken-off butte's talus (each short of every other strand: a flank
      // reaching one is cut into a cliff there, a crease and a flap)
      { kind: 'ridge', u: 0.392, lat: 15, len: 8, r: 9, h: 4.5, top: 0.3, near: 2 },
      { kind: 'ridge', u: 0.618, lat: -15, len: 12, r: 10, h: 1.8, top: 0.3, near: 3 },
      // the skyline: mesas and buttes standing apart on the plain, 55 to 95
      // units out (a ring of them read as the walls of a box), each broad
      // enough for the ground's 9 u grid to draw a table, not a pyramid
      { kind: 'ridge', u: 0.4487, lat: 73.7, yaw: 146.2, len: 80, r: 24, h: 16, top: 0.5 },
      { kind: 'ridge', u: 0.3683, lat: 55.5, yaw: 141.4, len: 14, r: 20, h: 22, top: 0.55 },
      { kind: 'ridge', u: 0.33, lat: 65.9, yaw: -4.6, len: 70, r: 24, h: 18, top: 0.5 },
      { kind: 'ridge', u: 0.8738, lat: 94, yaw: -116.4, len: 50, r: 22, h: 15, top: 0.5 },
      { kind: 'ridge', u: 0.8177, lat: 62.4, yaw: 14.8, len: 70, r: 26, h: 20, top: 0.5 },
      { kind: 'ridge', u: 0.1052, lat: -71.9, yaw: -152.1, len: 14, r: 18, h: 20, top: 0.55 }
    ]
  },
  sidewinder: {
    name: 'Sidewinder', waypoints: GEN_TRACKS.sidewinder,
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
    // east straight, outside the north loop's first corner
    // where the whole straight points; the field's three jacks nodding and
    // tumbleweeds blowing by outside its second corner; and at the line the
    // field's own filling station, its sign turning and a hawk over it. The
    // telegraph line comes in across the open desert from the east to the
    // station (over the road on two tall poles), clear of the mountain. Mesa
    // rims close the west as
    // near backdrops (the north and east stay open).
    // Everything by the road at its own size, the rock as big as rock is.
    set: [
      { model: 'set-telegraph-line', u: 0.02, lat: 6 },
      { model: 'set-filling-station', u: 0.972, lat: -9.5, yaw: 180 },
      // the field's wells at the kerb: the pumping wells, the rig, the lone
      // jack and the flowing well a step off the verge, where the chase
      // camera passes them at their own size
      { model: 'set-oil-field', u: 0.77, lat: 5.2 },
      { model: 'set-tank-farm', u: 0.63, lat: 12 },
      { model: 'set-drilling-rig', u: 0.368, lat: -6.6, yaw: 180 },
      { model: 'set-well-pad', u: 0.42, lat: 7 },
      { model: 'set-wellhead', u: 0.488, lat: 5.2 },
      { model: 'set-mountain-tunnel', u: 0.1039, lat: 0 },
      { model: 'set-tunnel-foothills', u: 0.1039, lat: 0 },
      // the company's tank train over the east straight on its viaduct,
      // between two knolls of the strata it tunnels into
      { model: 'set-tank-train', u: 0.462, lat: 0, yaw: 90 },
      // a dust devil wandering the flats inside the north loop
      { model: 'set-dust-devil', u: 0.7, lat: -12 },
      // the trunk line on its stilts, span by span along the right-hand
      // verge, each span a chord of the road's curve with a support at every
      // joint: from the tank farm round the north loop, swinging out behind
      // the pumping wells to their tank battery and back, under the knot;
      // down the start straight and under the mountain; round the outside
      // of the south loop and away under the S. Each span a thin footprint,
      // so the scatter round it stands.
      { model: 'set-pipeline-rise', u: 0.6270, lat: 6.50, yaw: -179.8 },
      { model: 'set-pipeline-8', u: 0.6270, lat: 6.50, yaw: 2.5 },
      { model: 'set-pipeline-8', u: 0.6430, lat: 6.47, yaw: 14.5 },
      { model: 'set-pipeline-8', u: 0.6550, lat: 6.38, yaw: 12.8 },
      { model: 'set-pipeline-8', u: 0.6667, lat: 6.33, yaw: 13.2 },
      { model: 'set-pipeline-8', u: 0.6791, lat: 6.35, yaw: 12.7 },
      { model: 'set-pipeline-12', u: 0.6907, lat: 6.33, yaw: 10.7 },
      { model: 'set-pipeline-16', u: 0.7139, lat: 6.48, yaw: 8.1 },
      { model: 'set-pipeline-8', u: 0.7389, lat: 8.76, yaw: -31.9 },
      { model: 'set-pipeline-8', u: 0.7459, lat: 13.88, yaw: -5.3 },
      { model: 'set-pipeline-8', u: 0.7546, lat: 15.88, yaw: 8.3 },
      { model: 'set-pipeline-8', u: 0.7631, lat: 15.84, yaw: 7.9 },
      { model: 'set-pipeline-12', u: 0.7714, lat: 15.99, yaw: 6.0 },
      { model: 'set-pipeline-8', u: 0.7932, lat: 15.63, yaw: 46.4 },
      { model: 'set-pipeline-8', u: 0.7999, lat: 10.31, yaw: 42.7 },
      { model: 'set-pipeline-dive', u: 0.8091, lat: 6.53, yaw: 5.2 },
      { model: 'set-pipeline-rise', u: 0.9150, lat: 7.50, yaw: 179.9 },
      { model: 'set-pipeline-16', u: 0.9150, lat: 7.50, yaw: -1.2 },
      { model: 'set-pipeline-16', u: 0.9510, lat: 7.50, yaw: -0.4 },
      { model: 'set-pipeline-16', u: 0.9866, lat: 7.50, yaw: -0.1 },
      { model: 'set-pipeline-16', u: 0.0220, lat: 7.50, yaw: 0.1 },
      { model: 'set-pipeline-dive', u: 0.0573, lat: 7.50, yaw: 0.0 },
      { model: 'set-pipeline-rise', u: 0.1421, lat: 6.50, yaw: 179.8 },
      { model: 'set-pipeline-8', u: 0.1421, lat: 6.50, yaw: 2.4 },
      { model: 'set-pipeline-8', u: 0.1578, lat: 6.39, yaw: 13.4 },
      { model: 'set-pipeline-8', u: 0.1689, lat: 6.27, yaw: 26.9 },
      { model: 'set-pipeline-8', u: 0.1768, lat: 6.07, yaw: 20.4 },
      { model: 'set-pipeline-8', u: 0.1857, lat: 6.14, yaw: 14.7 },
      { model: 'set-pipeline-16', u: 0.1975, lat: 6.29, yaw: 5.0 },
      { model: 'set-pipeline-8', u: 0.2305, lat: 6.34, yaw: 7.0 },
      { model: 'set-pipeline-8', u: 0.2446, lat: 6.40, yaw: 7.4 },
      { model: 'set-pipeline-8', u: 0.2590, lat: 6.43, yaw: 7.3 },
      { model: 'set-pipeline-8', u: 0.2733, lat: 6.38, yaw: 6.9 },
      { model: 'set-pipeline-dive', u: 0.2877, lat: 6.49, yaw: 1.7 }
    ],
    // the mesa rims: across the far end of the long straight, and south-west
    // past the south loop, no crest edge more than about 8 degrees over the
    // horizon from any point of the road; and the mountain's range running
    // on from its west end, rock-tinted
    land: [
      // a low ridge of the rust land along the outside of the south loop,
      // rising from just past the trunk line (`near`), so the road runs
      // round the foot of it; low enough to stay sand, each short of the
      // next so their crests do not stack
      { kind: 'ridge', u: 0.172, lat: 18, len: 8, r: 9, h: 3.6, top: 0.3, near: 4.6, tint: 0xc8846a },
      { kind: 'ridge', u: 0.214, lat: 18.5, len: 10, r: 9, h: 4.2, top: 0.3, near: 4.6, tint: 0xc8846a },
      { kind: 'ridge', u: 0.258, lat: 18, len: 8, r: 9, h: 3.4, top: 0.3, near: 4.6, tint: 0xc8846a },
      // the low ridge the east straight cuts through, either side, the tank
      // train's knolls of rock standing out of it (set-tank-train)
      { kind: 'ridge', u: 0.462, lat: 14, len: 20, r: 9, h: 3.2, top: 0.3, near: 4, tint: 0xc8846a },
      { kind: 'ridge', u: 0.462, lat: -14, len: 18, r: 9, h: 3.0, top: 0.3, near: 4, tint: 0xc8846a },
      { kind: 'ridge', u: 0.115, lat: 58, yaw: 80, len: 40, r: 13, h: 9, top: 0.3, tint: 0xc8846a },
      { kind: 'ridge', u: 0.1784, lat: 100, yaw: 4, len: 120, r: 30, h: 13, top: 0.5 },
      { kind: 'ridge', u: 0.7313, lat: 106, yaw: 151, len: 130, r: 30, h: 14, top: 0.5 },
      // The field (the S round the north loop) keeps the biome's hoodoo
      // family off: it stands at the first spot off the road and the pieces
      // from the tunnel on, and every such spot here put its tall stack
      // beside the rig's mast or the lone jack, or centre frame in the loop
      // between the tanks and the pumping wells, as the camera saw them.
      // These thin clears (a unit round their spines, so they take little
      // scatter with them) cover those spots, as the hoodoo's 5 u keep-out
      // reads them, and the family stands east of the crossing, on the open
      // skyline past the field, as the desert's own rock.
      { kind: 'clear', u: 0.335, lat: 11.5, len: 14, r: 1 },
      { kind: 'clear', u: 0.402, lat: 11.5, len: 14, r: 1 },
      { kind: 'clear', u: 0.43, lat: -11.5, len: 4, r: 1 },
      { kind: 'clear', u: 0.472, lat: 11.5, len: 34, r: 1 },
      { kind: 'clear', u: 0.495, lat: -11.5, len: 2, r: 1 },
      { kind: 'clear', u: 0.66, lat: -11.5, len: 6, r: 1 },
      { kind: 'clear', u: 0.684, lat: 11.5, len: 6, r: 1 },
      { kind: 'clear', u: 0.72, lat: 11.5, len: 26, r: 1 },
      { kind: 'clear', u: 0.78, lat: -14.8, len: 17, r: 1 },
      { kind: 'clear', u: 0.81, lat: 11.5, len: 6, r: 1 }
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
    name: 'Skysnake', segments: SKYSNAKE, startU: 0.026,
    oils: OILS.skysnake, pads: PADS.skysnake, boxes: BOXES.skysnake,
    // Each ladder ends in a kicker: the racers kick up off its top rung onto
    // the next deck.
    kickers: [ { u: 0.336 }, { u: 0.523 } ],
    // Snakes and ladders, raced across the board at the toy cars' own scale.
    set: [
      { model: 'set-snake-board', u: 0, lat: 0 },
      { model: 'set-board-snake', u: 0.7031, lat: 0 },
      { model: 'set-dice-tower', u: 0.196, lat: 11 },
      { model: 'set-game-box', u: 0.39, lat: 11, scale: 1.4 },
      { model: 'set-windup-chicks', u: 0.12, lat: 3.9 },
      { model: 'set-room-train-skysnake', u: 0, lat: 0 },
      { model: 'set-play-sunbeam', u: 0.207, lat: 30.17, yaw: -72.96 }
    ],
    // The climbs are the board's ladders, the dive its snake, from the top
    // deck down to the board.
    land: [
      { kind: 'ladder', u: 0.3092, len: 23 },
      { kind: 'ladder', u: 0.4927, len: 23 },
      { kind: 'snake', u: 0.744, len: 31 }
    ]
  },
  gauntlet: {
    name: 'Gauntlet', segments: GAUNTLET,
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
    // castle and their tents. On the long home straight the siege goes on:
    // a red rank and a siege tower inside it, two blue ranks with their
    // cannon outside, the castle's outer gatehouse astride the road (the
    // racers drive through its arch, under the portcullis), a tin knight of
    // each side wound up and marching the kerb, and the castle's dragon on
    // guard where the straight points. The besiegers' ram,
    // its log swinging, stands with their guns outside the corner after
    // them, aimed across at the castle, and the castle's corner towers fly
    // tall blue pennants. Between the fights the two sides hold a tourney:
    // the lists outside the grid straight, a red knight and a blue riding at
    // each other along the tilt before the king's stand, and the castle's
    // knights' camp inside the home straight, its archery butts and
    // quintain. The floor's scatter is the tourney's too (theme.cc): shields,
    // butts and banners, none of the biome's other toys.
    set: [
      { model: 'set-toy-soldiers', u: 0.8, lat: 6.7 },
      { model: 'set-siege-tower', u: 0.81, lat: -8.7, yaw: 180 },
      { model: 'set-castle-gate', u: 0.83, lat: 0 },
      { model: 'set-toy-soldiers', u: 0.875, lat: 7 },
      { model: 'set-castle-watchtower', u: 0.5637, lat: 9 },
      { model: 'set-barbican', u: 0.6106, lat: 0 },
      { model: 'set-cannon-battery', u: 0.6752, lat: 7, scale: 1.2 },
      { model: 'set-siege-ram', u: 0.7241, lat: 8.5, yaw: -150.5 },
      { model: 'set-toy-dragon', u: 0.95, lat: 6.8 },
      { model: 'set-block-fortress', u: 0.4193, lat: -14.08 },
      { model: 'set-siege-camp', u: 0.1198, lat: -8.37, yaw: -90 },
      { model: 'set-trebuchet', u: 0.1133, lat: -17.77, yaw: -90 },
      { model: 'set-siege-tower', u: 0.0777, lat: 11, yaw: 35 },
      { model: 'set-toy-soldiers', u: 0.9977, lat: -8.7, yaw: 180 },
      { model: 'set-tilt-yard', u: 0.027, lat: 8.5 },
      { model: 'set-tourney-camp', u: 0.762, lat: -9.5, yaw: 180 },
      { model: 'set-windup-knights', u: 0.92, lat: 3.9 },
      { model: 'set-play-rug', u: 0.885, lat: 0, yaw: 90 },
      { model: 'set-play-sunbeam', u: 0.087, lat: 30.24, yaw: -72.68 }
    ]
  },
  helix: {
    name: 'Helix', segments: HELIX, startU: 0.020,
    oils: OILS.helix, pads: PADS.helix, boxes: BOXES.helix,
    // The marble run: ONE run round the whole room in the race's direction,
    // its marbles rolling only downhill but at its three lifts, each a
    // different machine. Up inside the marble tower's column, where the grid
    // straight points (a slinky walking down off its block beside it), out
    // of its cup and over the corner after the straight on twin rails; along
    // the top leg's infield through a marble wheel, behind a tin humming top
    // and a wooden one spinning short of it, into a catch tray and up the
    // summit screw lift outside the climb, the tallest thing in the room;
    // over the skyway and south along its outside, ticking down a stair of
    // tone bars, into a vortex bowl and a helix outside the descent; along
    // the south leg's outside and round a loop of its own beside the mid
    // leg's; on the floor to a stair lift at the corner home, onto a wooden
    // marble racer of two stepped boards beside the grid straight, and from
    // its foot back into the tower's. Each section is built in the world's
    // frame (set_prototypes.py RUN_ORIGIN): its place is that origin, its yaw
    // the heading's opposite.
    set: [
      { model: 'set-marble-tower', u: 0.1253, lat: 14.5, yaw: -45 },
      { model: 'set-spinning-top', u: 0.215, lat: -5.5 },
      { model: 'set-marble-run-head', u: 0.096259, lat: 7, yaw: 0 },
      { model: 'set-marble-run-wheel', u: 0.179241, lat: -6.97, yaw: -90 },
      { model: 'set-marble-run-summit', u: 0.241867, lat: -6.97, yaw: -90 },
      { model: 'set-marble-run-skyway', u: 0.474724, lat: 6.96, yaw: 180 },
      { model: 'set-marble-run-vortex', u: 0.521114, lat: 6.96, yaw: 180 },
      { model: 'set-marble-run-loop', u: 0.81056, lat: 7.03, yaw: 90 },
      { model: 'set-marble-run-stair', u: 0.934415, lat: 7.03, yaw: 90 },
      { model: 'set-marble-run-racer', u: 0.035952, lat: 7, yaw: 0 },
      { model: 'set-windup-robots', u: 0.06, lat: 3.9 },
      { model: 'set-play-rug', u: 0.06, lat: 0, yaw: 90 },
      { model: 'set-room-train-helix', u: 0, lat: 0 },
      { model: 'set-play-sunbeam', u: 0.13475, lat: 30.24, yaw: -72.53 }
    ]
  },
  skyline: {
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
    // U and again outside it, its TV tower in the U's eye, and towers a
    // child stacked stand outside the corner the south-bound leg turns.
    set: [
      { model: 'set-block-city', u: 0.125, lat: -15, yaw: 180 },
      { model: 'set-block-town', u: 0.0147, lat: 24.35 },
      { model: 'set-block-street', u: 0.018, lat: 0 },
      { model: 'set-block-westside', u: 0.2282, lat: -8.56, yaw: -180 },
      { model: 'set-block-high-street', u: 0.8655, lat: -9.63, yaw: 180 },
      { model: 'set-block-uptown', u: 0.4534, lat: -6.64 },
      { model: 'set-block-uptown', u: 0.485, lat: -9, yaw: 90 },
      { model: 'set-block-street-west', u: 0.71, lat: 0 },
      { model: 'set-block-towers', u: 0.768, lat: -7.5, yaw: 180 },
      { model: 'set-windup-robots', u: 0.06, lat: -3.9, yaw: 180 },
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
export const CUPS = [
  { id: 'beach',    name: 'Beach Cup',    difficulty: 1, tracks: ['tidepool', 'cove', 'driftwood', 'riptide'] }, // easy: flowing sweepers + hops (beach biome)
  { id: 'snow',     name: 'Snow Cup',     difficulty: 2, tracks: ['powder', 'flurry', 'glacier', 'avalanche'] }, // medium: gentle-mid crossings, hills and jumps (snow biome)
  { id: 'backyard', name: 'Backyard Cup', difficulty: 3, tracks: ['ribbon', 'pretzel', 'tangle', 'cloverleaf'] }, // middle: seeded multi-crossing circuits (grass biome)
  { id: 'canyon',   name: 'Canyon Cup',   difficulty: 3, tracks: ['wash', 'gulch', 'crag', 'sidewinder'] },   // hard: hairpins + stacked crossings (canyon biome)
  // crazy: stunts (playroom biome — orange plastic track).
  // id stays 'rooftop' (wired into CUP_BIOME/selections); only the display name moved.
  { id: 'rooftop',  name: 'Playroom Cup', difficulty: 4, tracks: ['skysnake', 'skyline', 'helix', 'gauntlet'] }
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
  oils: TRACKS[id].oils, pads: TRACKS[id].pads, boxes: TRACKS[id].boxes, poles: TRACKS[id].poles
}));
