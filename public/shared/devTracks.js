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
  // against Three.js on THIS track in /gallery-compare.html; keep changes additive
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
  }
};
