// DEV-ONLY tracks — debug/test surfaces. Never part of TRACKS/CUPS, so the phone picker
// can't see them; the display builds one only when ?track=<id> names it in a ?scenario=
// test surface or ?solo mode (see main.js).
//
// (Nothing here needs `startU` — the grid-on-a-straight rule is enforced over TRACK_LIST,
// and these are in no cup.)

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
  }
};
