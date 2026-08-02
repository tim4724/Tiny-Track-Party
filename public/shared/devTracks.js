// DEV-ONLY tracks — debug/test surfaces. Never part of TRACKS/CUPS, so the phone picker
// can't see them; the display builds one only when ?track=<id> names it in a ?scenario=
// test surface or ?solo mode (see main.js).
//
// (Nothing here needs `startU` — the grid-on-a-straight rule is enforced over TRACK_LIST,
// and these are in no cup.)

export const DEV_TRACKS = {
  // Gate-0 parity scene (docs/native-port/plan.md): ONE compact circuit holding a
  // representative of every renderer-relevant track feature — plain curve, banked
  // corner, crest, width squeeze, tilted toy loop (auto boost pad + decals across
  // its mouth seam) — plus furniture of every kind. The native renderer is judged
  // on THIS track in the gallery; keep changes additive
  // (fixtures reference it by feature position).
  //
  // Rounded rectangle, all -90 corners (helix hand). Closure: N grid 28 = S legs
  // 8+8+8+4; toy-loop drift +3 shifts the south exit one way in plan — the west
  // leg absorbs it (12 + 3 = 15, gap-verified below 0.5).
  gate0: {
    name: 'Gate 0', difficulty: 'Dev',
    segments: [
      { kind: 'straight', length: 28 },                                  // grid straight
      { kind: 'arc', radius: 4.185, angle: -90 },                        // NE: the plain curve
      { kind: 'straight', length: 6, rise: 1.4 },                        // CREST up…
      { kind: 'straight', length: 6, rise: -1.4 },                       // …and over
      { kind: 'arc', radius: 4.185, angle: -90, bank: 12 },              // SE: the banked corner
      { kind: 'straight', length: 8, width: [2.5, 1.9] },                // width SQUEEZE in… (UNSCALED: 2.5 = the 5.0-world default)
      { kind: 'straight', length: 8, width: [1.9, 2.5] },                // …and out
      { kind: 'straight', length: 8 },                                   // boost approach (loop auto-pads its mouth)
      { kind: 'loop', radius: 2.2, drift: 3, roll: 52 },                 // TOY LOOP (helix's proven trim)
      { kind: 'straight', length: 4 },                                   // landing beat
      { kind: 'arc', radius: 4.185, angle: -90 },                        // SW corner
      { kind: 'straight', length: 15 },                                  // west leg (12 + 3 drift)
      { kind: 'arc', radius: 4.185, angle: -90 }                         // NW into the grid
    ],
    boxes: [
      { u: 0.035, lat: -1.05 }, { u: 0.035, lat: -0.35 },                // grid item row
      { u: 0.035, lat: 0.35 }, { u: 0.035, lat: 1.05 }
    ],
    pads: [
      { u: 0.31, lat: 0 }                                                // authored pad on the crest
    ],
    poles: [
      { u: 0.88, lat: -1.0 }, { u: 0.88, lat: 1.0 }                      // west-leg gate
    ],
    oils: [
      { u: 0.55, lat: 0.6 }                                              // in the squeeze, near the loop seam
    ],
    bananas: [
      { u: 0.75, lat: -0.7 }                                             // landing-beat banana
    ]
  },
  // THE WARP LADDER — the contact shadow's test bench (?scenario=warp).
  //
  // The shadow is a rigid stamp projected along the DECK NORMAL AT THE CAR, so
  // it is exact wherever the deck under the car is flat — however hard the road
  // bends in PLAN. What breaks it is the deck leaving that plane inside the
  // stamp's own footprint: a twist, a crest, a dip. That is the difference this
  // track is built to isolate, because a shipped circuit mixes all of them and
  // you cannot tell which one you are looking at.
  //
  // So: a rounded rectangle whose four legs are one warp each, GRADED, with a
  // flat beat before and after every rung so the eye has a control to return to.
  // Read GAP in the harness readout (the deck's departure from the plane the
  // car is seated on, at its four wheel corners) — ~0 on every flat beat and on
  // the plain corner, and only the rungs move it.
  //
  // THE RUNGS BRACKET WHAT SHIPS, deliberately, and that is worth knowing before
  // reading anything off them. Measured over real four-car races: a shipped deck
  // departs the car's plane by ~0.002 half the time and reaches 0.02–0.06 at its
  // 99th percentile, with the barrel-rolling Skyline worst at ~0.10. This
  // ladder's gentle rungs land in that band; its hard rungs and the banked
  // corner reach ~0.25, two to three times anything a player drives. So a defect
  // visible ONLY on the hard rungs is not yet an explanation of one seen in a
  // race — find it on a gentle rung, or on the track it was reported from.
  //
  // CLOSURE: four -90 arcs of one radius with equal 28-unit legs between them —
  // a plain rounded rectangle, so the plan closes whatever the rungs do. Every
  // rise and every roll comes in a CANCELLING PAIR and `bank` eases back to
  // zero on its own, so elevation and the frame close by construction. A new
  // rung must keep all three of those true; check it with the gap the builder
  // reports rather than by eye.
  warp: {
    name: 'Warp Ladder', difficulty: 'Dev',
    segments: [
      // ── N leg: FLAT CONTROL. The shadow must be perfect for all of it, and
      // this is the leg you come back to when a rung looks wrong.
      { kind: 'straight', length: 28 },
      // The PLAIN corner: hard plan curvature, deck dead flat. The control for
      // "bendy" — if the shadow is clean here and dirty on the banked corner,
      // the cause is the twist and not the bend.
      { kind: 'arc', radius: 4.185, angle: -90 },
      // ── E leg: TWIST, gentle then hard. Pure heartline roll on a STRAIGHT —
      // no plan curvature, no elevation — so a shape change here is the twist
      // and nothing else. Each rung returns to flat before the next.
      { kind: 'straight', length: 2 },
      { kind: 'straight', length: 6, roll: 18 },
      { kind: 'straight', length: 6, roll: -18 },
      { kind: 'straight', length: 4 },
      { kind: 'straight', length: 4, roll: 55 },   // hard: same angle, short run
      { kind: 'straight', length: 4, roll: -55 },
      { kind: 'straight', length: 2 },
      // THE CASE THAT MATTERS MOST: a bank transition ON a bend — twist and
      // plan curvature at once, which is what a shipped circuit actually puts
      // under a car and where the report came from. Same radius as the plain
      // corner above, so the two differ by the bank and nothing else.
      { kind: 'arc', radius: 4.185, angle: -90, bank: 22 },
      // ── S leg: ELEVATION. A long soft crest, then a short sharp one, then a
      // dip — longitudinal curvature with the deck laterally flat throughout,
      // which separates "the deck curves along travel" from "the deck twists".
      { kind: 'straight', length: 4 },
      { kind: 'straight', length: 6, rise: 1.2 },
      { kind: 'straight', length: 6, rise: -1.2 },
      { kind: 'straight', length: 3, rise: 1.4 },  // sharp crest
      { kind: 'straight', length: 3, rise: -1.4 },
      { kind: 'straight', length: 3, rise: -1.4 }, // sharp dip
      { kind: 'straight', length: 3, rise: 1.4 },
      { kind: 'arc', radius: 4.185, angle: -90 },
      // ── W leg: flat run-back to the line, a second control.
      { kind: 'straight', length: 28 },
      { kind: 'arc', radius: 4.185, angle: -90 }
    ],
    // One row on the flat control leg: the shadow's edge against bright paint is
    // the most legible read there is, and it belongs where nothing warps.
    boxes: [
      { u: 0.03, lat: -1.05 }, { u: 0.03, lat: 0 }, { u: 0.03, lat: 1.05 }
    ],
    pads: [
      { u: 0.06, lat: 0 }                          // a pad to cross on the flat
    ]
  },
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
  // The ASSET GALLERY's stage (/gallery-assets.html). Not a driving surface: a
  // stadium oval whose only job is to give every drawn thing somewhere to stand,
  // where a free camera can walk past all of it.
  //
  // The shape is load-bearing, and it is the LANDMARK PLACER that sets it. The
  // renderer places its hero set-pieces by walking the centreline from a
  // per-kind starting arclength (buildLandmarks' findSpot, s0 = 30 .. 130 world
  // units) and taking the first clear spot beside the road. So the EXHIBITION
  // STRAIGHT is 160 world units long: every one of the seventeen kinds lands
  // along it, on alternating sides, instead of being scattered around a circuit
  // you would have to fly a lap of. The back straight then carries the road
  // furniture (boxes, pads, slicks + their cones, dropped bananas, a pole gate),
  // and the run-in is collinear with the exhibition straight so the parked grid
  // — the gallery's opening shot — sits on a straight rather than mid-corner.
  //
  // The VOCABULARY is not here. What stands trackside is the showcase theme's
  // job (native/libttp-runtime/ttp/showcase.h): it unions every biome's scenery,
  // landmarks, clutter and fliers into whichever biome the gallery is showing,
  // so one lap of this oval is the whole kit rather than one cup's corner of it.
  showroom: {
    name: 'Showroom', difficulty: 'Dev',
    waypoints: [
      // exhibition straight — 80 authored units (160 world) of landmark frontage
      { x: 0, z: 0 }, { x: 20, z: 0 }, { x: 40, z: 0 }, { x: 60, z: 0 }, { x: 80, z: 0 },
      // right U-turn (centre 80,15 · r 15)
      { x: 90.6, z: 4.4 }, { x: 95, z: 15 }, { x: 90.6, z: 25.6 },
      // back straight — the furniture run
      { x: 80, z: 30 }, { x: 60, z: 30 }, { x: 40, z: 30 }, { x: 20, z: 30 },
      { x: 0, z: 30 }, { x: -24, z: 30 },
      // left U-turn (centre -24,15 · r 15)
      { x: -34.6, z: 25.6 }, { x: -39, z: 15 }, { x: -34.6, z: 4.4 },
      // run-in to the line, collinear with the exhibition straight (grid straight)
      { x: -24, z: 0 }, { x: -12, z: 0 }
    ],
    // u = fraction of the lap (built length ≈ 603 world units). The exhibition
    // straight is u 0 .. 0.265; the back straight u 0.42 .. 0.76.
    boxes: [
      { u: 0.02, lat: 0 },                                          // the lone box, right off the line
      { u: 0.045, lat: -1.05 }, { u: 0.045, lat: -0.35 },           // the standard 4-lane row
      { u: 0.045, lat: 0.35 }, { u: 0.045, lat: 1.05 }
    ],
    pads: [
      { u: 0.075, lat: -0.9 }, { u: 0.075, lat: 0.9 }               // a pair of boost discs
    ],
    oils: [
      { u: 0.50, lat: 0 },                                          // slick + its ring of cones
      { u: 0.53, lat: -1.0 }                                        // (wet-floor signs in a water biome)
    ],
    bananas: [
      { u: 0.56, lat: 0 }, { u: 0.575, lat: -0.9 }, { u: 0.59, lat: 0.9 }
    ],
    poles: [
      { u: 0.63, lat: -1.0 }, { u: 0.63, lat: 1.0 },                // a pillar gate
      { u: 0.66, lat: 0 }                                           // one dead centre
    ]
  }
};
