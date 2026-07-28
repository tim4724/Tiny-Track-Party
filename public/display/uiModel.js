// uiModel.js — the display's UI MODEL, as a pure layer.
//
// WHAT THIS IS. Every "what should the screen say" decision the display owns,
// extracted out of main.js and lobbySeats.js and expressed as pure functions of
// PLAIN DATA -> a plain UI-state object. It never touches the DOM, a global, a
// clock or an RNG: rosters, snapshots, results and room state arrive as literals,
// the AI/human/disconnected splits arrive as Sets, and the clock arrives as a
// number. That is what makes it loadable in Node (CLAUDE.md's dependency-free
// rule for modules the Node tests import directly) and recordable as an oracle.
//
// WHY IT IS SEPARATE. docs/native-port/shared-cpp-plan.md P8 moves exactly these
// decisions into C++ (P6 moves the per-frame HUD block ahead of it). Once the JS
// is gone the oracle can never be recorded again — the one-way ratchet that
// already froze gen-roomflow-corpus.mjs and gen-grandprix-corpus.mjs — so
// scripts/gen-ui-corpus.mjs records this layer's answers NOW, while the JS that
// produces them still exists. Keep this file free of imports; the moment it
// grows one, the generator and the C++ port both inherit it.
//
// WHAT IS DELIBERATELY NOT HERE (see the plan's non-goals): DOM construction,
// CSS classes, fades, canvas sizing, rAF, fullscreen, QR painting, and the
// back-stack TRAVERSAL. The screen ENUM and the per-screen back EFFECT are the
// model; walking the History API is not.
//
// STRINGS ARE KEYS, NOT COPY. The plan's decision, and the reason this layer can
// become C++ without freezing English into it: everything user-facing comes out
// as a stable key plus data (`{titleKey: 'cup_champs', cupName: 'Sunset'}`),
// never as `'SUNSET CHAMPS!'`. Player names, cup names and track names pass
// through as DATA. The two composed strings the display still owns
// ('Next race ▸', 'Next up: ') live in main.js, next to the elements they fill.

// ---- room states -----------------------------------------------------------
// A local mirror of shared/protocol.js's ROOM_STATE. It cannot be imported: that
// file is a classic script with CommonJS exports, and this module must stay
// import-free. tests/ui-model.test.js pins the two together so the copy can
// never drift silently (CLAUDE.md: nothing may re-declare a shared value
// without a check).
export const ROOM_STATE = {
  LOBBY: 'lobby',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  RESULTS: 'results'
};

// Whole seconds, rounded up — how every countdown label in this layer is read.
const ceilSecs = (ms) => Math.ceil(ms / 1000);

// ---- screens ---------------------------------------------------------------
// The display has three boards and they are strictly ordered, so "forward" and
// "back" are a subtraction. SCREEN_ORDER is the enum; BACK_EFFECT is what the
// back gesture MEANS on each one — the part every shell shares. HOW the gesture
// arrives (popstate, the tvOS Menu button, Android's back stack) is the shell's.
export const SCREEN_ORDER = { welcome: 0, lobby: 1, race: 2 };
export const SCREENS = Object.keys(SCREEN_ORDER);
// welcome is the root: there is nothing above it, so back is swallowed.
export const BACK_EFFECT = { welcome: 'swallow', lobby: 'end-party', race: 'return-to-lobby' };

// >0 = a forward step (push one history entry), <0 = a retreat (pop one), 0 =
// same level. Unknown names count as the root, exactly as the display's show().
export function screenStep(prev, next) {
  return (SCREEN_ORDER[next] || 0) - (SCREEN_ORDER[prev] || 0);
}
export function backEffect(screen) {
  return BACK_EFFECT[screen] || 'swallow';
}

// ---- the lobby -------------------------------------------------------------
// The roster as the seat grid sees it: one entry per connected-or-held seat, the
// host marked, the ready flag carried. Pure projection — the ORDER is the room's
// (join order), never re-sorted here.
export function rosterSeats(roster, hostPeerIndex) {
  return roster.map((p) => ({
    name: p.name,
    colorIndex: p.colorIndex,
    carIndex: p.carIndex,
    connected: p.connected,
    host: p.peerIndex === hostPeerIndex,
    ready: p.ready
  }));
}

// The seat grid itself: the taken seats padded with OPEN placeholders up to
// maxPlayers, so the lobby card keeps a fixed size as players trickle in (and
// never shrinks below the field that actually races). Each taken seat resolves
// its car pick — carIndex falls back to the livery slot before the player picks
// — and wraps it into the model roster (carCount) for the thumbnail.
export function seatGrid(seats, maxPlayers, carCount) {
  const total = Math.max(maxPlayers, seats.length);
  const out = [];
  for (let i = 0; i < total; i++) {
    const p = seats[i];
    if (!p) { out.push({ open: true }); continue; }
    const carIndex = (p.carIndex == null ? p.colorIndex : p.carIndex);
    out.push({
      open: false,
      name: p.name,
      colorIndex: p.colorIndex,
      carIndex,
      modelIndex: carCount ? carIndex % carCount : 0,
      off: p.connected === false,   // a held, dropped seat — dimmed, not removed
      host: !!p.host,
      ready: !!p.ready
    });
  }
  return out;
}

// START_GAME gate. The host's start IS their commitment, so they never ready up;
// everyone else must. An empty lobby cannot start.
export function allRacersReady(roster, hostPeerIndex) {
  const players = roster.filter((p) => p.connected);
  return players.length > 0 && players.every((p) => p.ready || p.peerIndex === hostPeerIndex);
}

// Who a race would seat: connected seats only. A dropped racer's seat lingers
// (dimmed, with a reconnect QR) but gets no car until they are back.
export function connectedPlayers(roster) {
  return roster.filter((p) => p.connected);
}

// The lobby's right-rail race card, from the room's pick (mode/cupId/trackId).
// null before a pick — the slot stays empty. Names come out as DATA plus a key
// saying what the name IS, and the race count as a key plus a number, so no
// English is decided here:
//   nameKey  'cup' | 'track' | 'random'   (name is null for random / unresolved)
//   racesKey 'count' | 'one' | 'endless'  (raceCount only meaningful for 'count')
// `maps` names the circuits to draw as minis by TRACK ID; the schematic payload
// is the shell's to look up. A cup numbers them (n = 1..4) — that numbering is
// the GP menu at a glance and belongs to the model.
export function cupSlot({ mode, cupId, trackId, randomRaces, cups, catalog }) {
  if (mode === 'cup') {
    const cup = cups.find((c) => c.id === cupId);
    // The catalogue is in CUPS order, so a cup's first entry carries its difficulty.
    const entry = catalog.find((t) => t.cup === cupId);
    return {
      nameKey: 'cup',
      name: cup ? cup.name : null,
      racesKey: 'count',
      raceCount: cup ? cup.tracks.length : 4,
      difficulty: entry ? entry.cupDifficulty : null,
      maps: cup ? cup.tracks.map((id, i) => ({ trackId: id, n: i + 1 })) : [],
      cupId: cupId == null ? null : cupId
    };
  }
  if (mode === 'track') {
    const entry = catalog.find((t) => t.id === trackId);
    return {
      nameKey: 'track',
      name: entry ? entry.name : null,
      racesKey: 'one',
      raceCount: 1,
      difficulty: entry ? entry.cupDifficulty : null,
      maps: [{ trackId: trackId == null ? null : trackId }],
      cupId: entry ? entry.cup : null
    };
  }
  if (mode === 'random') {
    // A surprise series: the sticker sells the MODE, the mini shows this round's
    // draw (which is also what the lobby preview is orbiting). Only race 1 is
    // known here — the rest of a fixed card is drawn as the series runs — so the
    // card promises a COUNT where a cup shows its four circuits.
    //
    // randomRaces is the run length the room SETTLED on: 0 is endless, a positive
    // integer is that many races. The wire's default for an absent length (a phone
    // whose stored mode predates the field) is applied by the shell's clamp before
    // a pick ever reaches this layer — see Net.js normRandomRaces — so what arrives
    // here is always a settled integer, never the absence.
    //
    // A non-integer is therefore unreachable from any shell that clamps, and reads
    // as endless: that is what `random` meant before run lengths existed, so an
    // older shell driving this model gets the behaviour it was written against
    // rather than a card with `undefined` races on it.
    const entry = catalog.find((t) => t.id === trackId);
    const endless = !(Number.isInteger(randomRaces) && randomRaces > 0);
    return {
      nameKey: 'random',
      name: null,
      racesKey: endless ? 'endless' : 'count',
      raceCount: endless ? null : randomRaces,
      difficulty: null,
      maps: [{ trackId: trackId == null ? null : trackId }],
      cupId: entry ? entry.cup : null
    };
  }
  return null;
}

// ---- dropped-seat reconnect cards ------------------------------------------
// Which cards to take down and which to put up, given what is already showing.
// The caller keeps the shown set because putting a card up can FAIL (the car may
// have no cell), so only it knows what actually landed.
export function reconnectDiff(shownIds, seats) {
  const want = new Set(seats.map((s) => s.peerIndex));
  const shown = new Set(shownIds);
  return {
    remove: shownIds.filter((id) => !want.has(id)),
    add: seats.filter((s) => !shown.has(s.peerIndex))
  };
}

// ---- the racing HUD --------------------------------------------------------
// Per-player HUD values, straight off the snapshot: the ordinal, the lap counter,
// the held item, and the finish card's place + time. The one DECISION in here is
// the item: a finished car is on a victory lap with no usable slot, so its item
// reads empty however full the engine says it is.
//
// NOT ON THE RUNTIME PATH ANY MORE. This is ported — the shipping HUD reads
// ttp::rt::hudSlot's answers out of the packed block (native/libttp-runtime/
// ttp_hud.h, via render/Display.js's hud()), and no snapshot is serialized for
// it. What survives here is the ORACLE: tests/fixtures/ui-corpus.jsonl was
// recorded off this function while it was live, and native/runtimetest/
// hud_check.cc replays every row of it through the port on all four legs. So it
// stays for the same reason TrackBuilder.js's twin is kept in git history — it
// is the only thing that can settle whether the C++ is right — and it must keep
// answering exactly as recorded, not track whatever the port does next.
export function hudRows(cars) {
  return cars.map((c) => ({
    id: c.id,
    position: c.position,
    lap: c.lap,
    totalLaps: c.totalLaps,
    item: c.finished ? null : (c.item || null),
    finished: !!c.finished,
    finishTime: c.finishTime == null ? null : c.finishTime
  }));
}

// Which phones need an ITEM push this tick. The held item lights the phone's USE
// button, and it is per-owner, so it rides its own message sent ONLY ON CHANGE —
// `lastItem` is what each phone was last told (a Map; the caller owns it, and
// clears it per race so the first tick resends every empty slot). AI cars have
// no phone behind them.
export function itemPushes(cars, aiIds, lastItem) {
  const out = [];
  for (const c of cars) {
    if (aiIds.has(c.id)) continue;
    const item = c.finished ? null : c.item;
    if (lastItem.get(c.id) !== item) out.push({ id: c.id, item });
  }
  return out;
}

// The same rule for a single car, for the one-shot relight a (re)joining phone
// gets: no live car, or a finished one, means an empty slot.
export function welcomeItem(car) {
  return car && !car.finished ? car.item : null;
}

// ---- race flow -------------------------------------------------------------
// True once every CONNECTED human car has crossed the line (CPU cars may still
// be out) — the cue to fast-forward the deterministic sim to the flag instead of
// making the humans watch bots crawl home. A dropped racer's ghost is skipped:
// it can never finish (no input), so it must not hold the flag down for everyone
// else. False with no connected humans left at all (a fully-AI / fully-dropped
// field — the race-timeout failsafe covers that).
export function humansAllDone({ carIds, aiIds, disconnectedIds, finishedIds }) {
  let humans = 0;
  for (const id of carIds) {
    if (aiIds.has(id)) continue;
    if (disconnectedIds.has(id)) continue;
    humans++;
    if (!finishedIds.has(id)) return false;
  }
  return humans > 0;
}

// Ghosts to forfeit at the finish moment: a dropped human's car can never cross
// the line, so once every connected human is home it must be removed or the
// fast-forward burst runs to its guard cap on a car that cannot finish.
export function forfeitCandidates({ carIds, aiIds, disconnectedIds }) {
  return carIds.filter((id) => !aiIds.has(id) && disconnectedIds.has(id));
}

// ---- pause arbitration -----------------------------------------------------
// Two independent freezes compose into one: the manual overlay pause (any
// player's controller, or the on-screen button) and the SILENT auto-pause (no
// connected human is holding a car). A manual resume while every racer is still
// gone keeps the field frozen; a reconnect during a manual pause keeps the
// overlay's authority.
export function canPause({ hasSession, paused, roomState }) {
  if (paused || !hasSession) return false;
  return roomState === ROOM_STATE.COUNTDOWN || roomState === ROOM_STATE.PLAYING;
}
export function canResume({ hasSession, paused }) {
  return !!paused && !!hasSession;
}

// The auto-pause decision. Three answers:
//   'none'            nothing to arbitrate (no race, or already over)
//   'return-to-lobby' no human seat is left in this race at all — nothing to
//                     wait for, so the room goes back to the lobby and any late
//                     joiners get seated in the next race immediately
//   'set'             carry on, with `autoPaused` as given
// The freeze is a PLAYING-state thing on purpose: freezing the COUNTDOWN would
// strand the room short of the only state the abandoned-race grace runs in, so a
// field that dropped during the beats would never reach the deadline that
// recovers the room. Nothing moves before GO anyway.
// `allParticipantsDisconnected` is NOT re-derived here: it is the party layer's
// answer over the same participant set the abandoned-race grace waits on, which
// is what keeps the silent freeze and that policy from ever disagreeing.
//
// `asked` reports whether that answer was CONSULTED. Reading it is not free on
// the shell side — it pushes the live car set into the room machine first — so
// the caller uses autoPauseAsksParticipants below to read it exactly when this
// decision would, instead of eagerly on every roster change.
export function autoPause({ hasSession, raceEnded, roomState, carIds, aiIds, seatedIds, allParticipantsDisconnected }) {
  if (!hasSession || raceEnded) return { action: 'none', asked: false };
  if (roomState !== ROOM_STATE.COUNTDOWN && roomState !== ROOM_STATE.PLAYING) return { action: 'none', asked: false };
  // "Is any human seat still IN this race?" is game state, not room state: a
  // question about the live car list. A seat that leaves the room forfeits its
  // car, so a car whose owner is off the roster is transient and counts for
  // nobody.
  let humanCars = 0;
  for (const id of carIds) {
    if (aiIds.has(id)) continue;
    if (seatedIds.has(id)) humanCars++;
  }
  if (!humanCars) return { action: 'return-to-lobby', asked: false };
  const asked = roomState === ROOM_STATE.PLAYING;
  return { action: 'set', asked, autoPaused: asked && !!allParticipantsDisconnected };
}

// Would autoPause consult the party layer for this input? Lets the shell defer
// that read (which has a side effect on the room machine) to exactly the ticks
// the decision needs it, without restating when those are.
export function autoPauseAsksParticipants(input) {
  return autoPause({ ...input, allParticipantsDisconnected: false }).asked;
}

// What the combined freeze state means for the SIM's clock, given where the sim
// currently is. One writer, so neither pause path drives pause()/resume() itself.
export function freezeTransition({ paused, autoPaused, sessionPaused }) {
  const frozen = !!paused || !!autoPaused;
  if (frozen && !sessionPaused) return 'freeze';
  if (!frozen && sessionPaused) return 'thaw';
  return 'none';
}

// ---- the Grand Prix chip ---------------------------------------------------
// The cup's progress chip on every standings board: which race of how many
// (raceCount is null for endless random play — there is no "of N"), what is next
// (null after a cup's last race), and whether this board is the podium (`final`;
// never for endless). autoAdvanceMs lets the phones caption the auto-start.
export function seriesInfo({ cupId, cupName, endless, raceIndex, raceCount, finished, nextTrackId, catalog, autoAdvanceMs }) {
  const next = finished ? null : (catalog.find((t) => t.id === nextTrackId) || null);
  return {
    cupId,
    cupName,
    endless,
    raceIndex,
    raceCount: endless ? null : raceCount,
    nextTrackId: next ? next.id : null,
    nextTrackName: next ? next.name : null,
    final: finished,
    autoAdvanceMs
  };
}

// ---- the standings board ---------------------------------------------------
// ONE board, rendered by the TV and by every phone — which is the proof this
// layer is real. Pushed as each car finishes (over=false) and once more at race
// end (over=true, so DNF/AFK cars resolve and everyone, not just finishers, sees
// the final board). Enriched from the race FIELD because the AI racers are not
// in the lobby roster the phones know, so the display is the only side that can
// name and colour them.
//
//   results      the sim's ranked rows: {playerId, rank, finished, time}
//   field        this race's grid:      {peerIndex, name, colorIndex, ai}
//   cup          null, or {standings, info} — the banked points and the chip
//   lateJoiners  connected seats with no car: {peerIndex, name, colorIndex}
//
// Key order is the WIRE order and is load-bearing; do not reshuffle it.
export function standingsPayload({ results, field, cup, lateJoiners, hostPeerIndex, over }) {
  const byId = new Map(field.map((p) => [p.peerIndex, p]));
  const order = results.map((res) => {
    const p = byId.get(res.playerId) || {};
    return {
      playerId: res.playerId,
      name: p.name || String(res.playerId),
      colorIndex: p.colorIndex == null ? 0 : p.colorIndex,
      ai: !!p.ai,
      finished: !!res.finished,
      time: res.time
    };
  });
  // Cup: stamp every racer's banked points, and re-sort the FINAL board into
  // cup-standings order (points → latest-race placement — the intermission and
  // podium story). Live boards (over=false) stay in RACE order: mid-race the
  // drama is who crosses the line, not the tally.
  if (cup) {
    const std = new Map(cup.standings.map((r, i) => [r.playerId, { row: r, seq: i }]));
    for (const o of order) {
      const s = std.get(o.playerId);
      o.points = s ? s.row.points : 0;
      if (over) o.gained = s ? s.row.gained : 0;
    }
    if (over) order.sort((a, b) => (std.has(a.playerId) ? std.get(a.playerId).seq : Infinity)
      - (std.has(b.playerId) ? std.get(b.playerId).seq : Infinity));
  }
  // Anyone who joined mid-race has no car this round (the field is locked at the
  // start) — list them UNDER the racers, flagged `joining`, so every board shows
  // who is waiting on the next race instead of silently omitting them. WHO that
  // is comes from the party layer (the roster outside the active participant
  // order), which is the same set the abandoned-race grace waits for.
  for (const p of lateJoiners) {
    order.push({ playerId: p.peerIndex, name: p.name, colorIndex: p.colorIndex, joining: true });
  }
  return {
    over: !!over,
    hostPeerIndex,
    ...(cup ? { series: cup.info } : {}),
    total: order.length,   // racers + joining rows — always matches order
    order
  };
}

// The results overlay in its three dressings, as semantic values:
//   plain single-race board  titleKey 'results', rows carry a lap time
//   cup intermission         titleKey 'standings' + a sub + a "next up" footer
//   cup podium               titleKey 'cup_champs', top three on the steps
// Rows come from the same board the phones get, so both screens always tell the
// same story (order, points, joining rows). `kind` is what each row's trailing
// cell says: a lap time, the cup's points story, or "next race".
//
// Note the podium's split: the STEPS take the top three non-joining rows, while
// the list starts at index 3 of the raw order. That is deliberate and frozen —
// a joining row inside the first three shortens the steps without shifting the
// list.
export function resultsView(board, { intermissionMs }) {
  const s = board.series || null;
  const podium = !!(s && s.final);
  const intermission = !!(s && !s.final);
  const rowKind = (row) => (row.joining ? 'joining' : s ? 'points' : 'time');
  return {
    podium,
    intermission,
    titleKey: podium ? 'cup_champs' : s ? 'standings' : 'results',
    cupName: s ? s.cupName : null,
    sub: intermission
      ? { key: s.endless ? 'cup_race' : 'cup_race_of', cupName: s.cupName, race: s.raceIndex + 1, of: s.endless ? null : s.raceCount }
      : null,
    podiumRows: podium ? board.order.filter((r) => !r.joining).slice(0, 3) : null,
    listRows: (podium ? board.order.slice(3) : board.order).map((row) => ({ ...row, kind: rowKind(row) })),
    next: intermission ? { trackName: s.nextTrackName || '', secs: ceilSecs(intermissionMs) } : null,
    newGameKey: intermission ? 'next_race' : 'new_game'
  };
}

// The intermission's "starting in N…", against the auto-advance deadline. A
// fresh ceil each beat rather than a decrementing counter, so it cannot drift.
export function intermissionSecs(deadlineMs, nowMs) {
  return Math.max(0, ceilSecs(deadlineMs - nowMs));
}
