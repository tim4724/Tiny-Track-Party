'use strict';

// The trailer's SHOT LIST — authored data, the way shared/tracks.js is authored data.
// render.js turns each entry into one clip and cut.js concatenates them in this order,
// so re-cutting the trailer is an edit to this array and nothing else.
//
// Target master: 3840x2160, 60 fps. Length is whatever the shots below add up to,
// less one cross-dissolve per join — cut.js prints the total when it writes the file.
//
// Each shot is one load of the display's test harness
// (`/?test=1&scenario=…&players=…&track=…&seed=…`) — a real native-sim race with
// self-driving AI and no phones or relay. Fields:
//
//   id        clip filename stem; must be unique
//   scenario  TestHarness scenario. The ones worth filming:
//               racing   — a straight race
//               chain    — the only scenario that COUNTS DOWN: it builds a
//                          countdown-mode session and holds the field until GO, so the
//                          3-2-1 banner and the launch are both live. Film it from
//                          frame 0. It starts on `track` and then chains through the
//                          rest of THAT track's cup, so a launch can be filmed anywhere.
//               rocket   — every item box rolls a rocket, and the harness spends it
//                          from the car furthest back on a cooldown, so the showcase
//                          LOOPS instead of showing one hit a lap
//               monster  — the same trick for the catch-up monster truck
//
//             NOT `countdown`: that scenario is a frozen chrome preview (its `live`
//             flag is false, so the scene never steps) and films as a still.
//   players   1 | 2 | 4 — the HUMAN count, and so the split-screen grid. The field is
//             topped up to FIELD_SIZE with cell-less CPU racers either way, so a 1-cell
//             shot is still a full race. On 16:9 ttp_grid_cols gives 1→full, 2→stacked,
//             4→2x2.
//   track     a catalogue id from shared/tracks.js. THE TRACK PICKS THE BIOME (it is
//             resolved from the track's own cup), which is why the list is spread
//             across all five cups rather than chosen for layout alone.
//   seed      the race's item/wander seed. Renders are reproducible with or without it
//             (render.js takes the frame clock off the wall clock — see its GATE note),
//             so this is not what makes a shot repeatable. It is also a WEAK knob for
//             changing a take: the item scenarios force the roulette to one item and the
//             bots seed themselves from botSpecs, so a sweep of eight seeds returned an
//             identical hit list. Omit it unless a specific number is worth keeping.
//   warmup    seconds of sim to step through BEFORE the first captured frame, and the
//             real choice of take. Cars leave the grid stacked three-deep; ~15-25 s is
//             where the field has strung out and each cell frames its own piece of
//             track, while an item beat wants whatever moment scout.js points at.
//             Cheap — warmup frames are stepped but not screenshotted.
//   seconds   captured length.
//
// Optional: `dividers: false` drops the ink lines between split cells (default on —
// they are part of the split-screen look, not chrome).

module.exports = [
  // Built in /trailer.html and pasted in. The editor's clock is the renderer's clock, so
  // every `warmup` below is the frame that was on the monitor when it was marked.

  // Open ON THE LAUNCH, not the lights: `chain` runs a real countdown and GO lands at
  // 3.02s, so an in-point just past it opens on the field breaking away rather than on
  // three seconds of stationary grid. `chain` is the only scenario that counts down, and
  // it starts on the track named here.
  { id: '01-riptide-1p', scenario: 'chain', players: 1, track: 'riptide', warmup: 3.1, seconds: 1.5 },

  { id: '02-driftwood-4p', scenario: 'racing', players: 4, track: 'driftwood', warmup: 9.5, seconds: 3.5 },
  { id: '03-flurry-4p', scenario: 'racing', players: 4, track: 'flurry', warmup: 15, seconds: 3.5 },
  { id: '04-pretzel-2p', scenario: 'rocket', players: 2, track: 'pretzel', warmup: 22, seconds: 4 },
  { id: '05-wash-4p', scenario: 'rocket', players: 4, track: 'wash', warmup: 60, seconds: 4 },
  { id: '06-skyline-4p', scenario: 'racing', players: 4, track: 'skyline', warmup: 11, seconds: 3 },
  { id: '07-helix-4p', scenario: 'rocket', players: 4, track: 'helix', warmup: 30, seconds: 5 },
];
