// Track catalogue — DATA ONLY, no Three.js. This is the single source of truth
// for "what tracks exist": each track is an ordered list of TrackBuilder PIECES
// keys (geometry) plus presentation metadata (name, blurb, difficulty).
//
// Kept dependency-free so the SAME module loads everywhere:
//   • the display engine (TrackBuilder turns `pieces` into drivable geometry),
//   • the Node unit tests (imported directly, no bundler),
//   • the classic-script gallery (gallery-tracks.js imports it as a plain module
//     to list tracks — it can't import TrackBuilder, which pulls in Three.js).
//
// DESIGN GOAL. Each lap should run ~40-55s for a quick driver (≈2-3 min over the
// 3-lap race), and the six tracks should feel DISTINCT — varied in outline,
// corner radius, elevation, and feature density, not the same rectangle dressed
// differently. Use scripts/probe-track.js to check a layout closes and
// scripts/probe-laptime.js to check it runs the right length before shipping it.
//
// ── HOW A TRACK CLOSES ───────────────────────────────────────────────────────
// The builder chains pieces by their connector frames and auto-closes the loop
// (gap < 0.5). Every piece advances ONE span (a straight-length L) along travel;
// a 90° corner also turns the heading. There are three proven closing recipes:
//
//  1. OVAL SKELETON (a simple rectangle). Four identical 90° corners of the SAME
//     hand (4 × 90° = a full turn) with matched OPPOSITE sides. Because the four
//     corners are identical, the lap closes as long as opposite sides have equal
//     length — so any side can be any NET-FLAT, NET-STRAIGHT run of the right
//     length. Aspect ratio (long-thin vs square) and radius (large=sweeping,
//     small=tight) are free, which is most of what makes these tracks differ.
//
//  2. FIGURE-8 (a self-crossing loop, e.g. Crossover). Three right + three left
//     corners net 0° rotation and cross ONCE; swap two straights of one strand
//     for hillUp/hillDown to lift that strand into a bridge OVER the crossing
//     (a hill has the same XZ footprint as a straight, so closure is unchanged).
//
//  3. L-SHAPE (a concave hexagon, e.g. Riverside). Five left + one right corner
//     net a full turn but trace a re-entrant "boot" outline. Side lengths are
//     tuned so the run closes; found/verified with scripts/probe-track.js.
//
// NET-NEUTRAL building blocks (each spans one straight-length L, so any of them
// can stand in for a "straight" on a side without changing where it ends):
//   • straight                         — plain
//   • curve + curveR                   — a chicane (left then back); net 0 lateral
//   • bumpUp + bumpDown                — a hump then a dip; net flat
//   • hillHalfUp + hillHalfDown        — climb then descend; net flat
//   • hillUp + hillDown                — a taller climb/descent; net flat

// ---- Sunny Oval (Easy): the flat-out SPEEDWAY. A long, thin rectangle — huge
// straights and four sweeping large-radius corners, no elevation. The place to
// pin the throttle and learn the tilt. Sides 12/5/12/5 (opposite sides match). ----
export const OVAL = [
  // start/finish straight (gate here) → the long front straight       [side A: 12]
  'straight', 'straight', 'straight', 'straight', 'straight', 'straight',
  'straight', 'straight', 'straight', 'straight', 'straight', 'straight', 'cornerLargeL',
  // short end                                                        [B: 5]
  'straight', 'straight', 'straight', 'straight', 'straight', 'cornerLargeL',
  // back straight                                                    [C: 12, = A]
  'straight', 'straight', 'straight', 'straight', 'straight', 'straight',
  'straight', 'straight', 'straight', 'straight', 'straight', 'straight', 'cornerLargeL',
  // short end                                                        [D: 5, = B]
  'straight', 'straight', 'straight', 'straight', 'straight', 'cornerLargeL'
];

// ---- Grand Tour (Medium): the ROLLING-HILLS circuit. A squarer rectangle (vs
// the oval's long-thin one) where almost every side is hills, crests, and speed
// bumps — full hills, half-hills, and bumps back to back. Net-flat (each feature
// returns to ground) so it closes like the oval, but the elevation never lets up.
// Sides 9/7/9/7. ----
export const GRAND_TOUR = [
  // start/finish straight (gate) → full hill → speed bumps → half-hill   [A: 9]
  'straight', 'hillUp', 'hillDown', 'bumpUp', 'bumpDown', 'hillHalfUp', 'hillHalfDown',
  'straight', 'straight', 'cornerLargeL',
  // short side: half-hill → bumps                                        [B: 7]
  'straight', 'hillHalfUp', 'hillHalfDown', 'bumpUp', 'bumpDown', 'straight', 'straight', 'cornerLargeL',
  // back side: full hill → bumps → half-hill                             [C: 9, = A]
  'straight', 'hillUp', 'hillDown', 'bumpUp', 'bumpDown', 'hillHalfUp', 'hillHalfDown',
  'straight', 'straight', 'cornerLargeL',
  // short side: half-hill → bumps                                        [D: 7, = B]
  'hillHalfUp', 'hillHalfDown', 'bumpUp', 'bumpDown', 'straight', 'straight', 'straight', 'cornerLargeL'
];

// ---- Slalom Park (Medium): flat but relentless. The oval skeleton (large
// corners) with chicanes (curve → curveR weaves left then back) stacked down
// every side, so you're never straight for long — a continuous left-right weave
// that rewards a smooth line. Sides 6/4/6/4 (opposite sides match). ----
export const SLALOM = [
  // start/finish straight → double chicane → straight                   [A: 6]
  'straight', 'curve', 'curveR', 'curve', 'curveR', 'straight', 'cornerLargeL',
  // short side: chicane → straights                                     [B: 4]
  'curve', 'curveR', 'straight', 'straight', 'cornerLargeL',
  // back side: double chicane                                           [C: 6, = A]
  'straight', 'curve', 'curveR', 'curve', 'curveR', 'straight', 'cornerLargeL',
  // short side: chicane → straights                                     [D: 4, = B]
  'curve', 'curveR', 'straight', 'straight', 'cornerLargeL'
];

// ---- Switchback (Hard): the tight, technical one. TIGHT (small-radius) corners
// make a compact circuit, with a chicane + rolling half-hill on the long sides
// and a quick chicane on the short sides — tight cornering AND elevation on the
// same lap. Sides 7/3/7/3 with four small left corners → closes. ----
export const SWITCHBACK = [
  // start/finish straight → chicane → half-hill                         [A: 7]
  'straight', 'curve', 'curveR', 'hillHalfUp', 'hillHalfDown', 'straight', 'straight', 'cornerL',
  // short side: tight chicane                                           [B: 3]
  'curve', 'curveR', 'straight', 'cornerL',
  // back side: chicane → half-hill                                      [C: 7, = A]
  'straight', 'curve', 'curveR', 'hillHalfUp', 'hillHalfDown', 'straight', 'straight', 'cornerL',
  // short side: tight chicane                                           [D: 3, = B]
  'curve', 'curveR', 'straight', 'cornerL'
];

// ---- Crossover (Hard): a figure-8 that passes OVER ITSELF. The lap runs up a
// long spine, loops the top (clockwise), runs down the far side, then a
// west-bound straight CLIMBS onto a bridge and crosses 90° OVER the spine before
// descending and looping the bottom (counter-clockwise) back to start. The two
// strands meet at one point in plan view but ~2 world units apart in height, so
// one bridges cleanly over the other.
//
// HOW IT STAYS VALID. The plan is a closed single-crossing figure-8 (3 right + 3
// left corners → net 0° rotation; symmetric layout found by scripts/probe-cross.js
// and the figure-8 search). The overpass is added by swapping two straights of
// the bridge strand for hillUp/hillDown — a hill has the SAME XZ footprint as a
// straight, so the crossing point and the closure are unchanged; it just lifts
// the deck over the crossing. Net climb is zero (one up, one down), so the lap
// returns to ground. The renderer's nearest-to-centreline ground probe keeps
// cars on the correct deck at the crossing (upper on the bridge, lower
// underneath). ----
export const CROSSOVER = [
  // spine: straight up from the start/finish (gate here)         [N]
  'straight', 'straight', 'straight', 'straight', 'straight', 'straight',
  // top loop, clockwise                                          [E → S]
  'cornerLargeR', 'straight', 'cornerLargeR',
  // down the far side                                            [S]
  'straight', 'straight', 'straight', 'straight', 'straight', 'straight', 'straight',
  // turn west, then BRIDGE: climb up, cross over, come back down [W, elevated]
  'cornerLargeR', 'hillUp', 'straight', 'straight', 'straight', 'straight', 'hillDown',
  // bottom loop, counter-clockwise, back to the spine            [S → N]
  'cornerLargeL', 'straight', 'straight', 'straight', 'cornerLargeL', 'straight', 'straight', 'straight', 'cornerLargeL',
  'straight', 'straight', 'straight', 'straight', 'straight', 'straight'
];

// ---- Riverside (Medium): the long grand tour. An L-SHAPED circuit (a concave
// "boot" — five left corners and one right, so the lap bends back on itself
// instead of tracing a plain rectangle) packed with every flat-and-rolling
// feature: chicanes, full + half hills, speed bumps. The longest lap in the set.
// Sides A9/B3/C3/D4/E4/F9 with turns L,L,R,L,L,L (the single right corner is the
// re-entrant elbow); side lengths tuned so it auto-closes (probe-track.js). ----
export const RIVERSIDE = [
  // start/finish straight → chicane → full hill → run to the first bend [A: 9]
  'straight', 'curve', 'curveR', 'hillUp', 'hillDown', 'straight', 'straight', 'straight', 'straight', 'cornerLargeL',
  // short leg: half-hill                                                 [B: 3]
  'straight', 'hillHalfUp', 'hillHalfDown', 'cornerLargeL',
  // the elbow ledge: speed bumps into the re-entrant RIGHT corner        [C: 3]
  'straight', 'bumpUp', 'bumpDown', 'cornerLargeR',
  // inner leg: half-hill → straights                                     [D: 4]
  'hillHalfUp', 'hillHalfDown', 'straight', 'straight', 'cornerLargeL',
  // chicane → full hill                                                  [E: 4]
  'curve', 'curveR', 'hillUp', 'hillDown', 'cornerLargeL',
  // long home leg: chicane → half-hill → bumps → run to the line         [F: 9]
  'straight', 'straight', 'curve', 'curveR', 'hillHalfUp', 'hillHalfDown', 'bumpUp', 'bumpDown', 'straight', 'cornerLargeL'
];

// ---- Tangle (Hard): a second self-crossing circuit, distinct from Crossover. A
// figure-eight (3 right + 3 left corners → net 0°, crosses once), but with its own
// shape: a big sweeping top loop feeds a long, high FLYOVER that sails over the
// start spine, then a tight bottom loop snaps back. The strands meet in plan but
// ~2 units apart in height (verified collision-free: min strand separation 2.0);
// the renderer's nearest-centreline ground probe keeps cars on the right deck. ----
export const TANGLE = [
  // start/finish spine (gate here) → into the big loop
  'straight', 'straight', 'straight', 'straight', 'straight', 'straight', 'cornerLargeR',
  // big sweeping top loop
  'straight', 'straight', 'straight', 'straight', 'cornerLargeR',
  'straight', 'straight', 'straight', 'straight', 'cornerLargeR',
  // long high FLYOVER: climb, sail over the spine, descend
  'hillUp', 'straight', 'straight', 'straight', 'straight', 'straight', 'straight', 'hillDown', 'cornerLargeL',
  // tight bottom loop, the other way, back to the spine
  'straight', 'straight', 'cornerLargeL',
  'straight', 'straight', 'cornerLargeL',
  'straight', 'straight'
];

// Registry of named, previewable tracks. `pieces` is the layout the builder
// chains; the rest is presentation (gallery cards, future track-picker UI).
// Selected in the display via ?track=<key> (see display/main.js).
export const TRACKS = {
  oval: {
    name: 'Sunny Oval',
    blurb: 'A long, flat speedway — sweeping bends and enormous straights. Pin the throttle and learn the tilt.',
    difficulty: 'Easy',
    pieces: OVAL
  },
  grand: {
    name: 'Grand Tour',
    blurb: 'A rolling country circuit — hills, crests, and speed bumps on every side. Net-flat, but your stomach won’t believe it.',
    difficulty: 'Medium',
    pieces: GRAND_TOUR
  },
  slalom: {
    name: 'Slalom Park',
    blurb: 'One chicane after another — a relentless left-right weave that never lets you straighten up.',
    difficulty: 'Medium',
    pieces: SLALOM
  },
  switchback: {
    name: 'Switchback',
    blurb: 'Compact and vicious: tight corners stacked back-to-back, with rolling half-hills and chicanes between.',
    difficulty: 'Hard',
    pieces: SWITCHBACK
  },
  crossover: {
    name: 'Crossover',
    blurb: 'A true figure-eight that flies over itself — climb the bridge, cross above the lower straight, then loop back underneath.',
    difficulty: 'Hard',
    pieces: CROSSOVER
  },
  riverside: {
    name: 'Riverside',
    blurb: 'The grand tour: an L-shaped marathon that bends back on itself, packed with chicanes, hills, and bumps. The longest lap in the park.',
    difficulty: 'Medium',
    pieces: RIVERSIDE
  },
  tangle: {
    name: 'Tangle',
    blurb: 'A knotted figure-eight: a big sweeping loop hurls you onto a long high flyover that sails clean over your own start straight, then a tight loop snaps back.',
    difficulty: 'Hard',
    pieces: TANGLE
  }
};

// Stable display order for the gallery / picker (object key order is reliable in
// practice, but an explicit list keeps presentation independent of TRACKS edits).
export const TRACK_ORDER = ['oval', 'grand', 'slalom', 'switchback', 'crossover', 'riverside', 'tangle'];

// Flat list for the lobby track picker / selector — {id, name, pieces} in display
// order. The display builds each track and computes its schematic SVG from the
// geometry (see display/trackSchematic.js), so the picker needs no per-track art.
export const TRACK_LIST = TRACK_ORDER.map((id) => ({ id, name: TRACKS[id].name, pieces: TRACKS[id].pieces }));
