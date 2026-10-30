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
//          raised land stands over. Nothing goes below the plain itself.
//   paint  a capsule like a plain that shapes nothing: it only colours the
//          ground (a piste down a mountain)
// Any of them but a mound may carry a `tint`, 0xRRGGBB, a multiplier over the
// ground's colour where the form lies (fading with its flank, or a plain's or
// paint's `w`); the ground's grid is 9 u, so a tint is a broad wash.
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
  // Powder's ski mountain, its summit behind the lift (the lift's frame, grown
  // 1.35 by its builder), and the blue run washed down it from the top
  // station to the slalom and on to the finish on the flat; Avalanche's slide
  // face, the debris fan it dropped out to the road, and its fences' slopes.
  'set-ski-lift': [
    { kind: 'mound', x: -54, h: 40.5, r: 74.25, r1: 60.75, rz: 101.25, shape: 1.15 },
    { kind: 'paint', yaw: 105.07, x: -4.41, z: -27.75, len: 36.35, r: 4, w: 5, tint: 0xb4cdf2 },
    { kind: 'paint', yaw: 48.37, x: -10.43, z: 14.69, len: 32.51, r: 4, w: 5, tint: 0xb4cdf2 }
  ],
  'set-avalanche-slide': [
    { kind: 'mound', x: -58, h: 40.6, r: 66.7, r1: 58, rz: 87, shape: 1.6 },
    { kind: 'fan', yaw: 90, z: -9, len: 26, r: 8, r1: 11, h: 2.5, h1: 0.5, top: 0.3 }
  ],
  // Flurry's lake: the ice lies on the plain, unraised, and the snow banks up
  // round it (the road crosses its east edge on stilts).
  'set-frozen-lake': [
    { kind: 'plain', r: 15.5, w: 4, tint: 0xdcecf8 },
    { kind: 'ring', r: 21, w: 6, h: 3.5 }
  ],
  'set-avalanche-fence': [{ kind: 'mound', x: -28, h: 22.4, r: 26.6, r1: 25.2, rz: 36.4, shape: 1.6 }],
  // Wash's creek: the bed is the low line the raised land stands over, between
  // two cut banks (turned 90 so the spine runs along the creek's own X).
  'set-dry-creek': [
    { kind: 'plain', yaw: 90, x: -3, len: 88, r: 6, w: 8 },
    { kind: 'ridge', yaw: 90, x: -18, len: 80, r: 7, h: 2, top: 0.2 },
    { kind: 'ridge', yaw: 90, x: 12, len: 80, r: 7, h: 2, top: 0.2 }
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
  tidepool: {
    name: 'Tidepool', waypoints: GEN_TRACKS.tidepool,
    oils: genFurn('tidepool').oils, pads: genFurn('tidepool').pads, boxes: genFurn('tidepool').boxes,
    set: [
      { model: 'set-rock-pool', u: 0.924, lat: 13, yaw: 20 },
      { model: 'set-crab-pots', u: 0.37, lat: 10.9, yaw: 20 },
      { model: 'set-crab-pots', u: 0.8, lat: 37, yaw: 20 },
      { model: 'set-rowboat', u: 0.86, lat: 37, yaw: 20 },
      { model: 'set-tide-rocks', u: 0.43, lat: 19, yaw: 20 },
      { model: 'set-tide-rocks', u: 0.32, lat: 19.5, yaw: 20 },
      { model: 'set-tide-rocks', u: 0.97, lat: 24.3, yaw: 20 },
      { model: 'set-tide-rocks', u: 0.08, lat: 10.5, yaw: 20 },
      { model: 'set-tide-rocks', u: 0.58, lat: -10.5, yaw: 160 }
    ]
  },
  cove: {
    name: 'Cove', waypoints: GEN_TRACKS.cove,
    oils: genFurn('cove').oils, pads: genFurn('cove').pads, boxes: genFurn('cove').boxes,
    set: [
      { model: 'set-pirate-ship', u: 0.925, lat: 54.5, yaw: 180, y: -0.5, scale: 1.25 },
      { model: 'set-jetty', u: 0.966, lat: 41 },
      { model: 'set-shipwreck-ribs', u: 0.55, lat: 60.5, yaw: 90, scale: 1.4 },
      { model: 'set-pirate-camp', u: 0.99, lat: 10, yaw: 20 },
      { model: 'set-skull-rock', u: 0.64, lat: 20, yaw: 30 },
      { model: 'set-treasure-dig', u: 0.82, lat: 10.5, yaw: 20 },
      { model: 'set-treasure-dig', u: 0.67, lat: -11, yaw: 160 },
      { model: 'set-treasure-dig', u: 0.99, lat: -10.5, yaw: 160 },
      { model: 'set-cannon-post', u: 0.12, lat: 13, yaw: 20 },
      { model: 'set-cannon-post', u: 0.8, lat: 13, yaw: 20 }
    ]
  },
  driftwood: {
    name: 'Driftwood', waypoints: GEN_TRACKS.driftwood,
    oils: genFurn('driftwood').oils, pads: genFurn('driftwood').pads, boxes: genFurn('driftwood').boxes,
    set: [
      { model: 'set-driftwood-trunk', u: 0.7, lat: -14, yaw: 180 },
      { model: 'set-rowboat', u: 0.38, lat: -7, yaw: 160 },
      { model: 'set-drift-logs', u: 0.65, lat: -8.3, yaw: 160 },
      { model: 'set-drift-logs', u: 0.82, lat: -12, yaw: 160 },
      { model: 'set-drift-logs', u: 0.08, lat: -12, yaw: 160 },
      { model: 'set-drift-logs', u: 0.42, lat: -12, yaw: 160 },
      { model: 'set-drift-logs', u: 0.73, lat: 7.5, yaw: 20 },
      { model: 'set-bonfire', u: 0.294, lat: 10.5, yaw: 20 },
      { model: 'set-drift-logs', u: 0, lat: 7, yaw: 20 }
    ]
  },
  riptide: {
    name: 'Riptide', waypoints: GEN_TRACKS.riptide,
    oils: genFurn('riptide').oils, pads: genFurn('riptide').pads, boxes: genFurn('riptide').boxes,
    set: [
      { model: 'set-lifeguard-tower', u: 0.6, lat: -43, yaw: 160, scale: 1.3 },
      { model: 'set-buoy-line', u: 0.596, lat: -59, yaw: 180 },
      { model: 'set-deck-chairs', u: 0.76, lat: -18.2, yaw: 160 },
      { model: 'set-parasol', u: 0.05, lat: -12, yaw: 160 },
      { model: 'set-parasol', u: 0.32, lat: -10.5, yaw: 160 },
      { model: 'set-parasol', u: 0.89, lat: 10.5, yaw: 20 },
      { model: 'set-surfboards', u: 0.61, lat: -6, yaw: 160 },
      { model: 'set-surfboards', u: 0.75, lat: 12, yaw: 20 },
      { model: 'set-deck-chairs', u: 0.45, lat: -12, yaw: 160 },
      { model: 'set-parasol', u: 0.77, lat: 10.4, yaw: 20 }
    ]
  },
  // Snow Cup — SEEDED medium circuits (the gentle end of the mid profile: low brake
  // fraction, no hairpins, roomy radii, but real crossings + climb; auto-placed furniture).
  powder: {
    name: 'Powder', waypoints: GEN_TRACKS.powder,
    oils: genFurn('powder').oils, pads: genFurn('powder').pads, boxes: genFurn('powder').boxes,
    set: [
      { model: 'set-ski-lift', u: 0.9, lat: -32.5, yaw: 180 },
      { model: 'set-ski-rack', u: 0.695, lat: 22.5, yaw: 20 },
      { model: 'set-piste-fence', u: 0.96, lat: -7, yaw: 180 },
      { model: 'set-piste-fence', u: 0.06, lat: 7.5 },
      { model: 'set-ski-rack', u: 0.03, lat: 9, yaw: 20 },
      { model: 'set-ski-rack', u: 0.55, lat: -7.2, yaw: 160 }
    ]
  },
  flurry: {
    name: 'Flurry', waypoints: GEN_TRACKS.flurry,
    oils: genFurn('flurry').oils, pads: genFurn('flurry').pads, boxes: genFurn('flurry').boxes,
    set: [
      { model: 'set-frozen-lake', u: 0.3355, lat: -11.4, yaw: 172 },
      { model: 'set-log-cabin', u: 0.6, lat: -20, yaw: 160 },
      { model: 'set-log-pile', u: 0.3719, lat: -9.2, yaw: -169 }
    ],
    // a frozen stream runs from the village loop under the crossing down to
    // the lake
    land: [
      { kind: 'plain', u: 0.4413, lat: 5, yaw: -142, len: 54, r: 3, w: 5, tint: 0xc8e0f6 }
    ]
  },
  glacier: {
    name: 'Glacier', waypoints: GEN_TRACKS.glacier,
    oils: genFurn('glacier').oils, pads: genFurn('glacier').pads, boxes: genFurn('glacier').boxes,
    set: [
      { model: 'set-snow-fort', u: 0.663, lat: -18, yaw: 180 },
      { model: 'set-igloo', u: 0.12, lat: -14, yaw: 160 },
      { model: 'set-expedition-camp', u: 0.01, lat: 10.5, yaw: 20 },
      { model: 'set-ice-chunks', u: 0.7, lat: 14.5, yaw: 247 },
      { model: 'set-ice-chunks', u: 0.94, lat: -9.2, yaw: 55 },
      { model: 'set-ice-chunks', u: 0.24, lat: -14.5, yaw: 135 },
      { model: 'set-ice-chunks', u: 0.48, lat: 10.5, yaw: 74 },
      { model: 'set-expedition-camp', u: 0.88, lat: -14.5, yaw: 160 },
      { model: 'set-ice-chunks', u: 0.13, lat: 10.5, yaw: 116 },
      { model: 'set-penguin-chute', u: 0.36, lat: 17, yaw: 40 }
    ],
    // the glacier: a tongue of blue ice flows down from the massif in the
    // west between its grey lateral moraines, into the middle of the map,
    // ending among the penguins by the long legs; the fort stands on the
    // terminal moraine the ice left behind at the far end of the lap, which
    // the long legs drive straight at
    land: [
      { kind: 'ridge', u: 0.0491, lat: -126.1, yaw: 151, len: 60, r: 42, h: 28 },
      { kind: 'ridge', u: 0.9954, lat: -71.7, yaw: -122, len: 122, r: 15, r1: 11, h: 8, h1: 2.5, top: 0.4, tint: 0x8cc2f2 },
      { kind: 'ridge', u: 0.0092, lat: -51.4, yaw: -122, len: 90, r: 7, h: 4.5, h1: 3, top: 0.2, tint: 0xbcb8c0 },
      { kind: 'ridge', u: 0.7405, lat: -55.3, yaw: -65, len: 90, r: 7, h: 4.5, h1: 3, top: 0.2, tint: 0xbcb8c0 },
      { kind: 'ridge', u: 0.6671, lat: -18.9, yaw: -172, len: 70, r: 22, h: 4.5, top: 0.55, tint: 0xbcb8c0 }
    ]
  },
  avalanche: {
    name: 'Avalanche', waypoints: GEN_TRACKS.avalanche,
    oils: genFurn('avalanche').oils, pads: genFurn('avalanche').pads, boxes: genFurn('avalanche').boxes,
    set: [
      { model: 'set-avalanche-slide', u: 0.76, lat: 16 },
      { model: 'set-windsock', u: 0.124, lat: 10.5, yaw: 20 },
      { model: 'set-warning-sign', u: 0.277, lat: 27.3, yaw: 55 },
      { model: 'set-warning-sign', u: 0.374, lat: 22.5, yaw: 55 },
      { model: 'set-avalanche-fence', u: 0.87, lat: 16, yaw: 20 },
      { model: 'set-avalanche-fence', u: 0.1, lat: -32.5, yaw: 160 }
    ]
  },
  // Backyard Cup — SEEDED multi-crossing circuits (overpasses + solver-placed elevation,
  // decorated mid profile; auto-placed furniture).
  ribbon: {
    name: 'Ribbon', waypoints: GEN_TRACKS.ribbon,
    oils: genFurn('ribbon').oils, pads: genFurn('ribbon').pads, boxes: genFurn('ribbon').boxes,
    set: [
      { model: 'set-washing-line', u: 0.05, lat: -7.5, yaw: 180 },
      { model: 'set-garden-shed', u: 0.45, lat: 10.5, yaw: 20 },
      { model: 'set-wheelbarrow', u: 0, lat: 8.5, yaw: 20 },
      { model: 'set-flower-bed', u: 0.39, lat: -10.5, yaw: 160 },
      { model: 'set-wheelbarrow', u: 0.425, lat: -10.5, yaw: 160 },
      { model: 'set-flower-bed', u: 0.84, lat: -13, yaw: 160 },
      { model: 'set-flower-bed', u: 0.07, lat: 6, yaw: 20 },
      { model: 'set-flower-bed', u: 0.98, lat: 7.5, yaw: 20 }
    ],
    // a long garden bank behind the north loop and a rounded hill to the east;
    // the west side stays open
    land: [
      { kind: 'ridge', u: 0.2, lat: -46, len: 60, r: 24, h: 6, top: 0.35 },
      { kind: 'ridge', u: 0.66, lat: -46, r: 28, h: 8, top: 0.15 }
    ]
  },
  pretzel: {
    name: 'Pretzel', waypoints: GEN_TRACKS.pretzel,
    oils: genFurn('pretzel').oils, pads: genFurn('pretzel').pads, boxes: genFurn('pretzel').boxes,
    set: [
      { model: 'set-treehouse', u: 0.858, lat: 31.6 },
      { model: 'set-paddling-pool', u: 0.053, lat: 14.5 },
      { model: 'set-trampoline', u: 0.05, lat: 27.5, yaw: 20 },
      { model: 'set-football-pitch', u: 0.772, lat: -32.5, yaw: 160 },
      { model: 'set-trampoline', u: 0.77, lat: -14, yaw: 160 }
    ]
  },
  tangle: {
    name: 'Tangle', waypoints: GEN_TRACKS.tangle,
    oils: genFurn('tangle').oils, pads: genFurn('tangle').pads, boxes: genFurn('tangle').boxes,
    set: [
      { model: 'set-garden-hose', u: 0.509, lat: 16 },
      { model: 'set-sprinkler', u: 0.3, lat: 10, yaw: 20 },
      { model: 'set-sprinkler', u: 0.75, lat: 10, yaw: 20 },
      { model: 'set-sprinkler', u: 0.05, lat: -10, yaw: 160 }
    ]
  },
  cloverleaf: {
    name: 'Cloverleaf', waypoints: GEN_TRACKS.cloverleaf,
    oils: genFurn('cloverleaf').oils, pads: genFurn('cloverleaf').pads, boxes: genFurn('cloverleaf').boxes,
    set: [
      { model: 'set-playground', u: 0.18, lat: 14, yaw: 20, scale: 0.55 },
      { model: 'set-picnic-blanket', u: 0.478, lat: 7.5, yaw: 20 },
      { model: 'set-barbecue', u: 0.075, lat: -7.5, yaw: 160 },
      { model: 'set-picnic-blanket', u: 0.06, lat: -10.5, yaw: 160 },
      { model: 'set-bird-bath', u: 0.84, lat: 14.5, yaw: 20 },
      { model: 'set-flower-bed', u: 0.93, lat: 9, yaw: 20 },
      { model: 'set-picnic-blanket', u: 0.95, lat: 7.5, yaw: 20 },
      { model: 'set-flower-bed', u: 0.8, lat: -10, yaw: 160 }
    ],
    // the playground's hill rising beyond the south bend, a long ridge closing
    // the west; the east stays open
    land: [
      { kind: 'ridge', u: 0.2, lat: -48, r: 32, h: 10, top: 0.15 },
      { kind: 'ridge', u: 0.52, lat: -50, len: 70, r: 26, h: 7, top: 0.2 }
    ]
  },
  // Canyon Cup — SEEDED hard circuits (scan-seeds `hard` profile: hairpins, stacked
  // crossings, width pinches, crest hills; auto-placed furniture).
  wash: {
    name: 'Wash', waypoints: GEN_TRACKS.wash,
    oils: genFurn('wash').oils, pads: genFurn('wash').pads, boxes: genFurn('wash').boxes,
    set: [
      { model: 'set-dry-creek', u: 0.823, lat: -36, yaw: 90 },
      { model: 'set-dead-cottonwood', u: 0.12, lat: -14, yaw: 160 },
      { model: 'set-dead-cottonwood', u: 0.62, lat: -14, yaw: 160 },
      { model: 'set-cow-skull', u: 0.29, lat: 10.5, yaw: 20 },
      { model: 'set-cow-skull', u: 0.05, lat: 10.5, yaw: 20 },
      { model: 'set-ranch-fence', u: 0.962, lat: 14.5, yaw: 20 },
      { model: 'set-ranch-fence', u: 0.85, lat: 14.5, yaw: 20 }
    ]
  },
  gulch: {
    name: 'Gulch', waypoints: GEN_TRACKS.gulch,
    oils: genFurn('gulch').oils, pads: genFurn('gulch').pads, boxes: genFurn('gulch').boxes,
    set: [
      { model: 'set-mine-portal', u: 0.018, lat: 26 },
      { model: 'set-oil-drums', u: 0.09, lat: 13, yaw: 60 }
    ]
  },
  crag: {
    name: 'Crag', waypoints: GEN_TRACKS.crag,
    oils: genFurn('crag').oils, pads: genFurn('crag').pads, boxes: genFurn('crag').boxes,
    set: [
      { model: 'set-water-tower', u: 0.983, lat: 13 },
      { model: 'set-fossil', u: 0.326, lat: -14, yaw: 160 },
      { model: 'set-windpump', u: 0.62, lat: -14, yaw: 160 },
      { model: 'set-ranch-fence', u: 0.302, lat: 18.2, yaw: 20 },
      { model: 'set-ranch-fence', u: 0.19, lat: -10.5, yaw: 160 }
    ]
  },
  sidewinder: {
    name: 'Sidewinder', waypoints: GEN_TRACKS.sidewinder,
    oils: genFurn('sidewinder').oils, pads: genFurn('sidewinder').pads, boxes: genFurn('sidewinder').boxes,
    set: [
      { model: 'set-telegraph-line', u: 0.02, lat: 9.2 },
      { model: 'set-rattlesnake', u: 0.24, lat: 10.2 },
      { model: 'set-cow-skull', u: 0.282, lat: -14.3, yaw: 160 },
      { model: 'set-cow-skull', u: 0.72, lat: 14.5, yaw: 20 },
      { model: 'set-route-sign', u: 0.012, lat: -5.5, yaw: 110 },
      { model: 'set-route-sign', u: 0.81, lat: 10, yaw: 70 }
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
    set: [
      { model: 'set-block-tower', u: 0.096, lat: 12 },
      { model: 'set-block-pile', u: 0.19, lat: -12, yaw: 160 },
      { model: 'set-block-pile', u: 0.9, lat: 12, yaw: 20 },
      { model: 'set-block-pile', u: 0.11, lat: -14.5, yaw: 160 },
      { model: 'set-marbles', u: 0.07, lat: -7.5, yaw: 160 },
      { model: 'set-marbles', u: 0.25, lat: 10.5, yaw: 20 }
    ]
  },
  gauntlet: {
    name: 'Gauntlet', segments: GAUNTLET,
    oils: OILS.gauntlet, pads: PADS.gauntlet, boxes: BOXES.gauntlet,
    set: [
      { model: 'set-block-castle', u: 0.834, lat: 17.9 },
      { model: 'set-toy-robot', u: 0.984, lat: -7.5, yaw: 180 },
      { model: 'set-toy-soldiers', u: 0.97, lat: 6, yaw: 20 },
      { model: 'set-toy-soldiers', u: 0.65, lat: 12, yaw: 20 },
      { model: 'set-toy-soldiers', u: 0.15, lat: 12, yaw: 20 },
      { model: 'set-dominoes', u: 0.64, lat: -10.5, yaw: 160 },
      { model: 'set-dominoes', u: 0.08, lat: -12, yaw: 160 }
    ]
  },
  helix: {
    name: 'Helix', segments: HELIX, startU: 0.020,
    oils: OILS.helix, pads: PADS.helix, boxes: BOXES.helix,
    set: [
      { model: 'set-slinky', u: 0.633, lat: 14.5 },
      { model: 'set-spinning-top', u: 0.145, lat: 10.5 },
      { model: 'set-yoyo', u: 0.24, lat: 10.5, yaw: 20 },
      { model: 'set-yoyo', u: 0.1, lat: 10.5, yaw: 20 },
      { model: 'set-crayons', u: 0.12, lat: -14, yaw: 160 },
      { model: 'set-crayons', u: 0.02, lat: 32.5, yaw: 20 }
    ]
  },
  skyline: {
    name: 'Skyline', segments: SKYLINE, startU: 0.024,
    oils: OILS.skyline, pads: PADS.skyline, boxes: BOXES.skyline,
    set: [
      { model: 'set-toy-rocket', u: 0.42, lat: 31.6 },
      { model: 'set-toy-plane', u: 0.974, lat: -7.5, yaw: 180 },
      { model: 'set-cardboard-box', u: 0.09, lat: -10.5, yaw: 160 },
      { model: 'set-cardboard-box', u: 0.45, lat: -7.5, yaw: 160 },
      { model: 'set-block-pile', u: 0.46, lat: -32.5, yaw: 160 },
      { model: 'set-marbles', u: 0.95, lat: 12, yaw: 20 }
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
  { id: 'snow',     name: 'Snow Cup',     difficulty: 2, tracks: ['powder', 'flurry', 'glacier', 'avalanche'] }, // medium: gentle-mid crossings + climb (snow biome)
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
// silently disagree with the game. `startU` is one of those; `width` is deliberately
// absent because no descriptor sets it (the shipped width games are per-SEGMENT).
export const TRACK_LIST = TRACK_ORDER.map((id) => ({
  id, name: TRACKS[id].name,
  cup: CUP_OF[id].cup, cupName: CUP_OF[id].cupName, cupDifficulty: CUP_OF[id].cupDifficulty,
  segments: TRACKS[id].segments, waypoints: TRACKS[id].waypoints, startU: TRACKS[id].startU,
  oils: TRACKS[id].oils, pads: TRACKS[id].pads, boxes: TRACKS[id].boxes, poles: TRACKS[id].poles
}));
