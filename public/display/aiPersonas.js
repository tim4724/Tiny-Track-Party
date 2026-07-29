// AI_PERSONALITIES — the CPU racer roster: display-side identity (name) plus the
// two knobs the native AI takes (caution, laneBias).
//
// THIS IS NOT THE SOURCE ANY MORE, and nothing on the race path reads it.
// libttp-sim's ttp::AI_PERSONALITIES is the one table; main.js reads it out of
// the wasm (ttp_race_personas_json) and hands it straight back to the
// orchestration layer, so a real race and the probe drive the same personas by
// construction rather than by agreement.
//
// What still needs a JS copy is the SYNCHRONOUS surfaces — the gallery/test
// harness grids a persona per slot before any wasm call — so this stays as a
// mirror. It used to be held to the C++ by a prose "keep in sync" comment;
// tests/display-abi.test.js now fails if it drifts.

export const AI_PERSONALITIES = [
  { name: 'Bolt',  caution: 1.05, laneBias: -0.6 },  // OVERDRIVER — carries a touch over the safe corner speed, so it occasionally scrubs a curb but leads; the one bot a clean human must actually out-brake
  { name: 'Pixel', caution: 1.00, laneBias:  0.6 },  // corners at the true limit of its car
  { name: 'Rusty', caution: 0.97, laneBias: -0.25 },
  { name: 'Zippy', caution: 0.94, laneBias:  0.25 }, // the tail still lifts earliest/deepest — but the whole field moved up from the old 1.00/0.97/0.94/0.91
];
