// AI_PERSONALITIES — the CPU racer roster: display-side identity (name) plus the
// two knobs the native AI takes (caution, laneBias). The DRIVING is in C++
// (native/libttp-sim/ttp/ai_driver.*); this is the table main.js assigns to grid
// slots and hands to the wasm as bot specs, and the names the HUD shows.
// Keep in sync with the personas probe_cli uses.

export const AI_PERSONALITIES = [
  { name: 'Bolt',  caution: 1.05, laneBias: -0.6 },  // OVERDRIVER — carries a touch over the safe corner speed, so it occasionally scrubs a curb but leads; the one bot a clean human must actually out-brake
  { name: 'Pixel', caution: 1.00, laneBias:  0.6 },  // corners at the true limit of its car
  { name: 'Rusty', caution: 0.97, laneBias: -0.25 },
  { name: 'Zippy', caution: 0.94, laneBias:  0.25 }, // the tail still lifts earliest/deepest — but the whole field moved up from the old 1.00/0.97/0.94/0.91
];
