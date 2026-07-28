// raceFlow.js — the display's RACE ORCHESTRATION, as a pure layer.
//
// WHAT THIS IS. The state machine main.js used to run inline: starting a race,
// launching one, the countdown beats, the finish, the cup chain, the return to
// the lobby, and the four roster-driven repairs that ride alongside it
// (forfeit, rekey, auto-pause, standings). uiModel.js took the PREDICATES out
// of main.js — allRacersReady, canPause, raceFlow, autoPause — and left the
// machine that calls them in order. This is that machine.
//
// WHY THE ORDER IS THE PRODUCT. Every other layer in this tree answers a
// question ("what should this row say", "which cue at what gain"). This one
// answers "what happens next, and in what order", and the order is load-bearing
// in ways nothing type-checks:
//
//   * COUNTDOWN is published only AFTER the session exists, because the
//     statechange republishes the room snapshot and each player's `inRace` is
//     read from the live session. Flip first and every racer's phone briefly
//     says "you're in the next race".
//   * the post-GO auto-pause re-check is DEFERRED off the launch stack, because
//     it runs inside session.update() and its no-seats-left branch tears the
//     session down underneath the caller.
//   * cup points are banked BEFORE the final board is broadcast, because the
//     board carries this race's gains.
//   * the session is disposed BEFORE the flow flips to LOBBY, because that
//     transition sweeps held disconnected seats and would otherwise race an
//     endRace on the way out.
//
// A second shell re-deriving those four from prose gets them subtly wrong and
// nothing fails loudly. So this layer does not hand back a verdict for the
// shell to sequence — it hands back an ORDERED EFFECT LIST, and the shell's
// only job is to walk it and perform each op. The order is then data, recorded
// in a corpus and replayed against the port.
//
// PURE, ON THE SAME TERMS AS uiModel.js. No DOM, no clock, no RNG, no imports
// (the moment it grows one, the generator and the C++ port both inherit it).
// The three things it cannot compute arrive as inputs instead:
//   * `seed`     — the per-race item/wander seed, drawn by the shell's page RNG
//   * `nowMs`    — the intermission deadline's clock
//   * `draws`    — track ids pulled from the shell's shuffle bag. The bag stays
//                  JS on purpose (page RNG, not sim state; the plan's non-goal),
//                  so the shell pre-draws what a rule might need and this layer
//                  takes only as many as the rules actually call for.
//
// CATALOGUE-AGNOSTIC, like ui_model.cc. The persona table, the car-stats table
// and the cup list arrive per call rather than being reached for, which is what
// lets the corpus carry a synthetic world and keeps a new track from being a
// corpus re-record.
//
// WHAT IS DELIBERATELY NOT HERE. The performing: sockets, timers, the History
// API, the AudioContext, scene objects, `setTimeout`. An effect NAMES a timer
// to arm ({op:'arm-intermission', ms, deadline}); it never holds one. Also not
// here, and for the reason the plan gives each: the shuffle BAG itself, the
// host's mode pick, LobbyDemo, and the back-stack traversal.

// ---- the CPU field ---------------------------------------------------------

// carStats' wrap-and-default rule, which is a rule and not a lookup: a null,
// undefined or NaN carIndex is car 0, and anything else wraps into range (the
// modulo is written twice so a negative index lands positive, exactly as
// protocol.js does it).
export function carStatsAt(table, carIndex) {
  if (!table || !table.length) return null;
  const bad = carIndex == null || typeof carIndex !== 'number' || Number.isNaN(carIndex);
  const i = bad ? 0 : ((carIndex % table.length) + table.length) % table.length;
  return table[i];
}

// The lowest livery slot not already taken. RoomFlow owns this rule for seats;
// the CPU fill needs the same one and must not grow a second spelling of it, so
// the shell passes RoomFlow's answer in as `lowestFreeSlot` when it has one and
// this fallback (identical, and the thing the corpus records) runs otherwise.
export function lowestFreeSlot(used, count) {
  for (let i = 0; i < count; i++) if (!used.has(i)) return i;
  return 0;
}

// CPU seats that top a human roster up to `fieldSize` — shared by the race grid
// (buildField) and the lobby attract demo. Each gets the lowest free livery, the
// model that livery slot maps to (what the renderer already drew when carIndex
// was omitted) + its stats, and a persona cycled by CPU index.
//
// `botCap` is the ?bots=<n> debug cap (null = fill the grid).
export function cpuSeats({ humans, fieldSize, carCount, colorCount, personas, carStats, botCap }) {
  const used = new Set(humans.map((p) => p.colorIndex));
  const seats = [];
  const fill = botCap != null ? Math.min(fieldSize, humans.length + botCap) : fieldSize;
  for (let n = 0; humans.length + seats.length < fill; n++) {
    const colorIndex = lowestFreeSlot(used, colorCount);
    used.add(colorIndex);
    const carIndex = colorIndex % carCount;
    seats.push({
      n,
      persona: personas[n % personas.length],
      colorIndex,
      carIndex,
      stats: carStatsAt(carStats, carIndex)
    });
  }
  return seats;
}

// Build the race field: the connected humans plus AI racers topping the grid up
// to fieldSize (cpuSeats). AI get string ids ('ai-0'…) that never collide with
// the integer phone slots.
//
// Returns the field, the bot specs the wasm takes, and the AI id set — the
// three things launchRace threads onward. `aiIds` is an ARRAY here, not a Set:
// this layer's answers have to survive a JSON round trip to be a corpus.
export function buildField({ humans, seed, fieldSize, carCount, colorCount, personas, carStats, botCap, aiPrefix = 'ai-' }) {
  // carIndex is the player's lobby car pick; each player carries the handling
  // stats resolved from it (carStatsAt wraps + defaults), so the engine can give
  // every car its own accel/top speed/turn/weight + collision footprint.
  const field = humans.map((p) => ({
    peerIndex: p.peerIndex,
    name: p.name,
    colorIndex: p.colorIndex,
    carIndex: p.carIndex,
    stats: carStatsAt(carStats, p.carIndex),
    ai: false
  }));
  const bots = [];
  const aiIds = [];
  for (const s of cpuSeats({ humans: field, fieldSize, carCount, colorCount, personas, carStats, botCap })) {
    const peerIndex = aiPrefix + s.n;
    field.push({
      peerIndex, name: s.persona.name, colorIndex: s.colorIndex,
      carIndex: s.carIndex, stats: s.stats, ai: true
    });
    // Seed each bot's wander from the race seed + its NUMERIC index (s.n, not
    // the 'ai-N' id string — number+string coerces to NaN>>>0 = 0, which had
    // been handing every bot the same stream): distinct per bot, fresh per race.
    bots.push({
      peerIndex,
      caution: s.persona.caution,
      laneBias: s.persona.laneBias,
      seed: ((seed || 1) + s.n) >>> 0
    });
    aiIds.push(peerIndex);
  }
  return { field, bots, aiIds };
}

// The attract field. Same CPU fill, different ids (namespaced so they never
// collide with the integer phone slots a later real race uses) and one extra
// rule: persona by FINAL GRID INDEX so they spread across the whole field, with
// each CPU taking that persona's name so its plate matches how it drives.
// Humans keep their own name but still drive on a persona — no phones steer here.
export function buildDemoField({ humans, fieldSize, carCount, colorCount, personas, carStats, botCap }) {
  const field = humans.map((p) => {
    const carIndex = (p.carIndex == null ? p.colorIndex : p.carIndex);
    return {
      id: 'demo-' + p.peerIndex, name: p.name, colorIndex: p.colorIndex,
      carIndex, stats: carStatsAt(carStats, carIndex)
    };
  });
  const humanCount = field.length;
  for (const s of cpuSeats({ humans: field, fieldSize, carCount, colorCount, personas, carStats, botCap })) {
    field.push({ id: 'demo-cpu-' + s.n, colorIndex: s.colorIndex, carIndex: s.carIndex, stats: s.stats });
  }
  field.forEach((p, i) => {
    p.persona = personas[i % personas.length];
    if (i >= humanCount) p.name = p.persona.name;
  });
  return field;
}

// Cheap signature of what the demo renders, so a refresh can skip a no-op
// rebuild. Track + each car's id/livery/model; a rename alone won't re-grid.
export function demoSig(field, trackId) {
  return trackId + '|' + field.map((p) => p.id + ':' + p.colorIndex + ':' + p.carIndex).join(',');
}

// ---- the series behind a start ---------------------------------------------

// What Start commits to, as a DESCRIPTOR the shell hands to CupSeries — never a
// series object, because constructing one is the shell's job and this layer
// holds no handles.
//
// Cup mode: the whole Grand Prix from race 1 (the lobby preview already sits on
// it — the cup pick resolved trackId to its first track). Random mode, per the
// host's length pick: ENDLESS (0) offers a draw at every intermission so it
// never finishes, a fixed count instead draws the WHOLE card up front — race 1
// is the track the lobby already previewed — which makes it a cup in every way
// that matters ("Race 2 of 4", a last race, points, a podium). A count of 1 is
// just a single race, which the phone can't pick but the wire allows. Exact
// picks are single races.
//
// `draws` is the shell's pre-pulled shuffle-bag output; `drawsUsed` says how
// many of them a rule actually consumed, so the shell can put the rest back.
export function seriesForStart({ mode, cupId, trackId, randomRaces, cups, draws = [] }) {
  if (mode === 'cup') {
    const cup = cups.find((c) => c.id === cupId);
    return { series: cup ? { kind: 'cup', cupId: cup.id } : null, drawsUsed: 0 };
  }
  if (mode !== 'random') return { series: null, drawsUsed: 0 };
  // Endless: one track on the card, and a draw offered at every intermission.
  if (!randomRaces) {
    return { series: { kind: 'random-endless', cupId: 'random', cupName: 'Random', tracks: [trackId] }, drawsUsed: 0 };
  }
  if (randomRaces === 1) return { series: null, drawsUsed: 0 };
  const rest = draws.slice(0, randomRaces - 1);
  return {
    series: { kind: 'random-card', cupId: 'random', cupName: 'Random', tracks: [trackId, ...rest] },
    drawsUsed: rest.length
  };
}

// How many bag draws a start with these settings WOULD consume, deciding
// nothing and taking none.
//
// It exists because a draw cannot be put back. A shell that pre-draws for
// startRace and is then told "no-players" has already advanced the shuffle for a
// race that never happened, which makes "random" repeat sooner and silently skip
// a track nobody saw. So the shell asks this first, draws exactly this many, and
// only then decides.
export function drawsNeeded({ mode, randomRaces }) {
  if (mode !== 'random') return 0;
  if (!randomRaces || randomRaces === 1) return 0;
  return randomRaces - 1;
}

// ---- start / launch --------------------------------------------------------

// The START_GAME go/no-go. The host's "Start race" button is only enabled once
// every other player is ready (controller-side); re-checked here so a stale or
// forged START_GAME can't jump the lobby.
//
// Answers 'none' or a launch, with the series descriptor attached. The
// readiness rule itself stays uiModel's — the shell passes its answer in.
export function startRace({ roomState, sceneReady, selectedTrackId, players, mode, cupId, trackId, randomRaces, cups, draws = [] }) {
  if (roomState !== 'lobby') return { action: 'none', reason: 'room-state' };
  if (!sceneReady) return { action: 'none', reason: 'scene' };
  if (!selectedTrackId) return { action: 'none', reason: 'no-track' };
  if (!players.length) return { action: 'none', reason: 'no-players' };
  const { series, drawsUsed } = seriesForStart({ mode, cupId, trackId, randomRaces, cups, draws });
  return { action: 'launch', series, drawsUsed };
}

// The actual race launch, shared by the lobby start and the series chain.
// Everything here assumes the go/no-go guards already passed and `trackId` is
// the circuit to race.
//
// THE ORDER BELOW IS THE CONTRACT. Read the four constraints in this file's
// header before moving any line of it.
export function launchRace({ players, seed, trackId, countdownSeconds, forceItem = null, fieldSize, carCount, colorCount, personas, carStats, botCap, aiPrefix }) {
  const { field, bots, aiIds } = buildField({
    humans: players, seed, fieldSize, carCount, colorCount, personas, carStats, botCap, aiPrefix
  });
  const effects = [
    // Fresh seed per race so item rolls (and AI lane wander) vary game-to-game.
    // BEFORE the field is built, so the bots seed their wander from it.
    { op: 'set-track-seed', seed },
    { op: 'stop-lobby-demo' },                      // the race owns the scene now
    { op: 'set-field', field, aiIds, bots },        // kept for the results screen
    { op: 'clear-item-cache' },                     // first frame resends every phone's (empty) ITEM
    { op: 'show-screen', screen: 'race' },
    { op: 'hide-results' },
    { op: 'set-race-flags', paused: false, autoPaused: false, raceEnded: false },
    { op: 'set-pause-overlay', on: false },
    { op: 'set-pause-button', shown: true },        // pausable from the countdown on
    { op: 'reveal-chrome' },
    // (re)build scene cars. AI cars get no split-screen cell — they're opponents
    // in the shared world, not players watching the screen. The rebuild is also
    // what puts the warning cones back upright, clears last race's rubber patina
    // and restores every collected item box.
    {
      op: 'reset-scene-cars',
      cars: field.map((p) => ({ id: p.peerIndex, colorIndex: p.colorIndex, name: p.name, cell: !p.ai, carIndex: p.carIndex }))
    },
    { op: 'create-session', trackId, forceItem, bots },
    // Flip to COUNTDOWN only now that the session exists — see the header. No
    // frame or await runs between the create above and here, so this is the
    // first snapshot any phone sees for the race.
    { op: 'transition', to: 'countdown' },
    // Hand the renderer and the audio this race's session. Binding the audio
    // before the countdown starts is what keeps the opening beat from getting
    // away; the lobby's attract race is never bound, which is why it is silent.
    { op: 'bind-session' },
    { op: 'paint-initial-hud' },                    // chrome at final size through the countdown, no pop-in at GO
    { op: 'start-countdown', seconds: countdownSeconds }
  ];
  return { effects, field, aiIds, bots };
}

// One countdown beat. n > 0 is "3/2/1", n === 0 is "GO!" (the race starts on
// this beat and the banner fades over the next), n < 0 is banner-gone.
//
// The n<0 beat clears the LOCAL banner only and is never broadcast: the phones'
// COUNTDOWN handler flips them onto the drive HUD, so a race that ends within a
// second of GO (a fast-forwarded finish under test) would otherwise have this
// trailing beat land AFTER the final standings and yank their results board
// back to the wheel. The beat's SOUND is the wasm's — it taps the same tick —
// so nothing here asks for a cue.
export function countdownTick(n) {
  const effects = [{ op: 'show-countdown', n, slap: n > 0, go: n === 0 }];
  if (n >= 0) effects.push({ op: 'broadcast-countdown', n });
  return { effects };
}

// The "GO!" beat: physics are live and the GO! banner is still up.
export function raceStart({ biome, audioReady }) {
  const effects = [
    // roomState=playing in the snapshot lands phones on the drive screen
    { op: 'transition', to: 'playing' },
    // The auto-pause only freezes while PLAYING, so a field that emptied during
    // the countdown has to be re-checked now that we are. DEFERRED off this
    // stack on purpose — see the header.
    { op: 'refresh-auto-pause', deferred: true }
  ];
  // Background song for the whole race, from the biome's pool. The pick only
  // happens if the device can play it; the ?biome inspector override steers the
  // music too, so an override race sounds like it looks.
  if (audioReady) effects.push({ op: 'start-music', biome });
  effects.push({ op: 'show-music-credit', on: true });
  return { effects };
}

// ---- the finish ------------------------------------------------------------

// A race event, filtered down to what the shell must do about it. The audio is
// NOT here and the absence is the point: a pickup, a banana, a spin and a lap
// chime are decided into sound inside the wasm as the sim fires them.
//
// `fastForwarding` silences the visuals for the same reason it silences the
// sound: the burst is skipping, not racing.
export function raceEvent({ event, fastForwarding, humansAllDone }) {
  const effects = [];
  if (!event) return { effects };
  const e = event;
  if (!fastForwarding) {
    // A live car's grab always re-spins its cell roulette (incl. a box swap that
    // re-rolls the same item) — a finished car's victory-lap grab has no usable
    // slot, so no spin.
    if (e.type === 'pickup' && !e.finished) effects.push({ op: 'item-pickup', id: e.id, item: e.item });
    // Rocket strike: a one-shot impact burst on the target.
    if (e.type === 'spin' && e.cause === 'rocket') effects.push({ op: 'rocket-impact', id: e.id });
    // A rocket self-destructing at the end of its flight (a whiff).
    if (e.type === 'rocket_expire') effects.push({ op: 'rocket-expire', s: e.s, lat: e.lat });
  }
  if (e.type !== 'finish') return { effects };
  // endRace sends the final board once; don't spam one per AI car.
  if (fastForwarding) return { effects };
  // If that finish was the last human's we're about to fast-forward to the flag
  // and endRace will send the final board — skip this intermediate push so the
  // last human jumps straight to results, with no flash of the "FINISHED" hero
  // for a race that is effectively already decided.
  if (humansAllDone) return { effects };
  effects.push({ op: 'broadcast-standings', over: false });
  return { effects };
}

// The race is over. `seriesFinished` is the live series' own answer (null when
// there is no series), `intermissionMs` the auto-advance budget, `nowMs` the
// clock the deadline is stamped from.
export function endRace({ hasSeries, seriesFinished, intermissionMs, nowMs, resultsFailsafeMs }) {
  const effects = [
    { op: 'transition', to: 'results' }
  ];
  // Bank the cup points FIRST — the final board broadcast below must already
  // carry this race's gains, and the intermission/podium read them too.
  if (hasSeries) effects.push({ op: 'apply-race-points' });
  effects.push(
    { op: 'set-race-flags', paused: false, autoPaused: false, raceEnded: true }, // hold the finish frame behind the translucent overlay
    { op: 'stop-voices' },                       // the frozen frame must not hold wind/squeal voices open
    { op: 'stop-music' },                        // race over → results screen is quiet
    { op: 'show-music-credit', on: false },
    { op: 'set-pause-overlay', on: false },      // results aren't pausable
    { op: 'set-pause-button', shown: false },
    { op: 'hold-chrome' },
    { op: 'broadcast-standings', over: true },   // final board → phones show the full results overlay
    { op: 'show-results' },
    // The host ends the results screen with "New game"; this is only a safety
    // net so a room whose players all left mid-podium still recovers.
    { op: 'arm-results-failsafe', ms: resultsFailsafeMs }
  );
  // Mid-cup: this results screen is an INTERMISSION — arm the auto-advance into
  // the next race (the host can jump it early; advanceSeriesRace disarms the
  // failsafe above).
  if (hasSeries && !seriesFinished) {
    effects.push({ op: 'arm-intermission', ms: intermissionMs, deadline: nowMs + intermissionMs });
  }
  return { effects };
}

// (The intermission's "starting in N…" is NOT here. It is uiModel's
// intermissionSecs and stays there — this layer arms the deadline, the UI model
// reads it. Two spellings of one ceil is exactly the drift the manifest rule in
// CLAUDE.md exists to stop.)

// ---- the cup chain ---------------------------------------------------------

// Chain into the cup's next race straight from the intermission (RESULTS →
// COUNTDOWN, no lobby in between). Reached three ways: the auto-advance timer,
// the host's "Next race" (SERIES_NEXT) and the display's results button.
// startRace's LOBBY guard stays intact, so nothing else can skip an intermission.
export function advanceSeriesRace({ roomState, hasSeries, seriesFinished, sceneReady, players }) {
  if (roomState !== 'results' || !hasSeries || seriesFinished || !sceneReady) {
    return { action: 'none', effects: [] };
  }
  // Everyone left mid-intermission.
  if (!players.length) return { action: 'return-to-lobby', effects: [] };
  return {
    action: 'advance',
    effects: [
      // endRace armed the back-to-lobby failsafe — it must not yank race N+1.
      { op: 'clear-results-failsafe' },
      { op: 'clear-intermission' },
      { op: 'series-advance' },
      // publishes + selects (track/totalLaps swap). Outside the lobby the select
      // skips its scene crossfade (there is no preview to fade), and a chained
      // start has no lobby step — so the new circuit is placed explicitly and
      // the results overlay covers the pop.
      { op: 'set-track-from-series' },
      { op: 'place-track' }
      // then: launchRace — its COUNTDOWN statechange republishes the snapshot
      // with the sat-out phones now inRace, which is their signal (GAME_END
      // never comes mid-cup). The shell runs launchRace() next.
    ]
  };
}

// ---- the way out -----------------------------------------------------------

// Back to the lobby, from anywhere. Every exit route cancels a running cup
// (quit, abandon, failsafe).
//
// `trackSwap` re-aims the pick for the next lobby: random re-rolls every visit,
// a cup rewinds to its race 1 (a quit or finished cup left trackId mid-cup, and
// the next Start races a fresh series from the top). Decided while still in
// RESULTS/PLAYING so the select skips its lobby crossfade — the scene swap
// rides the fade this function's last effect asks for.
export function returnToLobby({ roomState, mode, cupId, trackId, cups, draws = [] }) {
  if (roomState === 'lobby') return { action: 'none', effects: [], drawsUsed: 0 };
  let trackSwap = null;
  let drawsUsed = 0;
  if (mode === 'random') {
    trackSwap = draws.length ? draws[0] : null;
    drawsUsed = draws.length ? 1 : 0;
  } else if (mode === 'cup') {
    const cup = cups.find((c) => c.id === cupId);
    if (cup && trackId !== cup.tracks[0]) trackSwap = cup.tracks[0];
  }
  const effects = [
    { op: 'clear-results-failsafe' },
    { op: 'clear-series' },
    { op: 'clear-intermission' }
  ];
  if (trackSwap) effects.push({ op: 'set-track', trackId: trackSwap });
  effects.push(
    // Tear the session down BEFORE the flow flips to LOBBY — see the header.
    { op: 'dispose-session' },
    { op: 'transition', to: 'lobby' },
    // Reachable straight from a live race (controller RETURN_TO_LOBBY, solo's R
    // key) — kill any state voices or a boost wind would drone on in the lobby.
    { op: 'stop-voices' },
    { op: 'stop-music' },
    { op: 'show-music-credit', on: false },
    { op: 'set-race-flags', paused: false, autoPaused: false, raceEnded: false },
    { op: 'set-pause-overlay', on: false },
    { op: 'set-pause-button', shown: false },
    { op: 'hold-chrome' },
    { op: 'clear-field' },
    // controllers return to the lobby off the snapshot (roomState=lobby)
    { op: 'show-screen', screen: 'lobby' },
    // Crossfade from the frozen finish frame back to the attract demo: drop the
    // race cars + restart the demo under cover so the reset doesn't pop.
    { op: 'fade-to-lobby', placeTrack: !!trackSwap }
  );
  return { action: 'return', effects, trackSwap, drawsUsed };
}

// ---- the roster-driven repairs ---------------------------------------------

// Pull a player's car out of the live race. Fires on playerleave — a clean
// back-out (LEAVE) or a dropped seat whose reconnect grace elapsed. A brief
// mid-race disconnect does NOT come through here: the car is kept running
// (camera stays on it) so a quick reconnect resumes driving.
//
// `removed` is whether the session actually held that car — the shell asks the
// session and passes the answer in, because only it holds the handle.
export function forfeitCar({ removed, peerIndex }) {
  if (!removed) return { effects: [] };
  return {
    effects: [
      { op: 'remove-scene-car', id: peerIndex },
      // its id leaves the loop — no zero-level update will come
      { op: 'stop-car-audio', id: peerIndex },
      // inRace(peerIndex) just flipped false with no roster event — republish
      { op: 'sync-state' }
    ]
  };
}

// A dropped player reconnected on a different device (new peerIndex): move
// their still-racing car — engine, render entry and results identity — onto the
// new slot so that phone drives it and the camera keeps following the same car.
//
// The cup rekey happens even when there is no car: banked points follow the
// PLAYER, car or no car.
export function rekeyCarPlayer({ hasSeries, rekeyed, oldId, newId }) {
  const effects = [];
  if (hasSeries) effects.push({ op: 'series-rekey', oldId, newId });
  if (!rekeyed) return { effects };
  effects.push(
    { op: 'rekey-scene-car', oldId, newId },
    // the loop re-creates voices under newId next frame
    { op: 'stop-car-audio', id: oldId },
    { op: 'rekey-field', oldId, newId }
  );
  return { effects };
}

// The auto-pause arbitration's EFFECT half. The RULE is uiModel.autoPause's —
// which seats count, when the freeze may apply, what an empty field means — and
// the shell passes its answer in as `decision`.
export function autoPauseEffects(decision) {
  if (!decision || decision.action === 'none') return { effects: [] };
  if (decision.action === 'return-to-lobby') return { effects: [{ op: 'return-to-lobby' }] };
  return {
    effects: [
      { op: 'set-auto-paused', on: !!decision.autoPaused },
      { op: 'sync-frozen' }
    ]
  };
}
