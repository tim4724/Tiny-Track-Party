// NativeUiModel — the display's edge of the UI MODEL, which is C++.
//
// uiModel.js's surface, backed by native/runtime/ttp_ui.h over
// native/libttp-runtime/ttp/ui_model.cc. Every "what should the screen say"
// decision — the seat grid, the lobby readiness rule, the race card, the
// ITEM-push gate, the reconnect diff, the flow predicates, the pause
// arbitration, the standings board, the results overlay, the screen enum and
// its back EFFECT — is taken in the wasm now. main.js and lobbySeats.js RENDER
// from these answers and decide nothing.
//
// WHAT THIS FILE IS ALLOWED TO DO, and it is a short list: name the shell's own
// objects (a roster entry, a seat, a snapshot car), turn them into the plain
// JSON the ABI takes, and turn the answer back into the shapes the renderers
// already expect. No rule may live here. Two places where that shows:
//
//   * connectedPlayers and reconnectDiff come back as INDICES, and this file
//     resolves them against the arrays it passed in — so the shell keeps its
//     OWN objects (and whatever it hangs off them) instead of racing a copy
//     that has been through a serializer.
//   * raceFlow answers allDone and the forfeit list TOGETHER, because the
//     boundary is what costs, not the rule. main.js reads one and then the
//     other off a single crossing per frame.
//
// STRINGS ARE KEYS. Nothing user-facing crosses: titles, subtitles, row kinds,
// race counts and the back gesture's meaning all arrive as stable keys plus
// data. The copy tables are in main.js, next to the elements they fill.
//
// public/display/uiModel.js is GONE. It was the ORACLE
// tests/fixtures/ui-corpus.jsonl was recorded off, and it was retired once the
// port was conformance-proven. That corpus is now FROZEN and is held by
// native/runtimetest/ui_check.cc (all 1559 steps, every leg), by abi_check.cc
// (the same corpus through the C boundary this file calls) and by record_ui (a
// byte-identical re-emission from the port). If any of those ever disagrees with
// the corpus, the corpus is right.

import { loadNativeRuntime } from './nativeRuntime.js';

let fn = null;

export async function init() {
  if (fn) return;
  const M = await loadNativeRuntime();
  const c = (name, ret, args) => M.cwrap(name, ret, args);
  fn = {
    configure: c('ttp_ui_configure', 'number', ['string']),
    catalogue: c('ttp_ui_catalogue_json', 'string', []),
    screenStep: c('ttp_ui_screen_step', 'number', ['string', 'string']),
    backEffect: c('ttp_ui_back_effect', 'string', ['string']),
    rosterSeats: c('ttp_ui_roster_seats_json', 'string', ['string', 'string']),
    rosterSeatsFromRoom: c('ttp_ui_roster_seats_room_json', 'string', ['number', 'string']),
    seatGrid: c('ttp_ui_seat_grid_json', 'string', ['string']),
    allRacersReady: c('ttp_ui_all_racers_ready', 'number', ['string', 'string']),
    connectedPlayers: c('ttp_ui_connected_players_json', 'string', ['string']),
    cupSlot: c('ttp_ui_cup_slot_json', 'string', ['string']),
    reconnectDiff: c('ttp_ui_reconnect_diff_json', 'string', ['string', 'string']),
    itemPushes: c('ttp_ui_item_pushes_json', 'string', ['string', 'string', 'string']),
    welcomeItem: c('ttp_ui_welcome_item_json', 'string', ['string']),
    raceFlow: c('ttp_ui_race_flow_json', 'string', ['string']),
    canPause: c('ttp_ui_can_pause', 'number', ['number', 'number', 'string']),
    canResume: c('ttp_ui_can_resume', 'number', ['number', 'number']),
    autoPauseAsks: c('ttp_ui_auto_pause_asks', 'number', ['string']),
    autoPause: c('ttp_ui_auto_pause_json', 'string', ['string', 'number']),
    freezeTransition: c('ttp_ui_freeze_transition', 'string', ['number', 'number', 'number']),
    seriesInfo: c('ttp_ui_series_info_json', 'string', ['string']),
    standings: c('ttp_ui_standings_json', 'string', ['string']),
    resultsView: c('ttp_ui_results_view_json', 'string', ['string', 'number']),
    intermissionSecs: c('ttp_ui_intermission_secs', 'number', ['number', 'number'])
  };
}

const J = JSON.stringify;
const id = (x) => J(x === undefined ? null : x);   // a JSON-scalar identity
const ids = (set) => J([...set]);
const b = (x) => (x ? 1 : 0);

// The two field sizes the seat grid needs, and NOTHING ELSE. The world every id
// in this ABI resolves against — the cups, their names, the track names and the
// cup-tendency rule — is codegen'd into the wasm from shared/tracks.js
// (generated/track_defs.h), so this side no longer assembles ~2 KB of JSON out
// of a catalogue it would otherwise have to carry.
//
// The layer itself stays catalogue-AGNOSTIC: it looks ids up in whatever list it
// holds, which is what lets the conformance corpus install a synthetic world.
// That path is the OPTIONAL `cups`/`catalog` override, used by tests and by
// nothing that ships.
export function configure({ maxPlayers, carCount, cups, catalog }) {
  const world = { maxPlayers, carCount };
  if (cups && catalog) {
    world.cups = cups.map((c) => ({ id: c.id, name: c.name, tracks: c.tracks }));
    world.catalog = catalog.map((t) => ({
      id: t.id, name: t.name,
      cup: t.cup == null ? null : t.cup,
      cupDifficulty: t.cupDifficulty == null ? null : t.cupDifficulty
    }));
  }
  const ok = fn.configure(J(world));
  if (!ok) throw new Error('[ui] the catalogue was rejected by the native UI model');
}

// The shipped catalogue as DATA, for the things a shell has to draw itself: the
// lobby's cup picker and the track names in the phones' chooser payload. Always
// the shipped tables, never a configured override.
//
//   { cups: [{id, name, tracks:[id]}], catalog: [{id, name, cup, cupDifficulty}] }
//
// `catalog` is CUPS order flattened, which is the order every picker draws and
// the order the model's own contract depends on.
export function catalogue() { return JSON.parse(fn.catalogue()); }

// ---- screens ---------------------------------------------------------------
// >0 = a forward step, <0 = a retreat, 0 = same level. WALKING the stack is the
// shell's (the History API here, Menu on tvOS); only the table is native.
export function screenStep(prev, next) { return fn.screenStep(prev || '', next || ''); }
export function backEffect(screen) { return fn.backEffect(screen || ''); }

// ---- the lobby -------------------------------------------------------------
// The seat grid off a LIVE ROOM handle. A Seat carries name, colorIndex,
// carIndex, connected, host and ready — never inRace — so this is a projection
// of the room alone and needs no session handle.
//
// The shell used to reach the same rows the long way round: pull the roster out
// of the party ABI, ferry it through the retained snapshot's `players`
// projection, then hand those rows back here. That made the lobby's own grid
// depend on the wire message sitting next to it, and serialized the roster three
// times to render it once. rosterSeats (the plain-data spelling) stays for
// callers that hold rows rather than a room — the test surfaces, and any shell
// whose roster does not live in this wasm.
export function rosterSeatsFromRoom(roomHandle, hostPeerIndex) {
  return JSON.parse(fn.rosterSeatsFromRoom(roomHandle | 0, id(hostPeerIndex)));
}

export function rosterSeats(roster, hostPeerIndex) {
  return JSON.parse(fn.rosterSeats(J(roster.map((p) => ({
    peerIndex: p.peerIndex, name: p.name, colorIndex: p.colorIndex,
    carIndex: p.carIndex == null ? null : p.carIndex,
    connected: !!p.connected, ready: !!p.ready
  }))), id(hostPeerIndex)));
}

// The taken seats padded with OPEN placeholders (maxPlayers and the car roster
// size come from configure, not from a second copy on this side).
export function seatGrid(seats) { return JSON.parse(fn.seatGrid(J(seats))); }

export function allRacersReady(roster, hostPeerIndex) {
  return !!fn.allRacersReady(J(roster.map((p) => ({
    peerIndex: p.peerIndex, connected: !!p.connected, ready: !!p.ready
  }))), id(hostPeerIndex));
}

// Connected seats only. The ABI answers with indices; the ENTRIES that come
// back are the caller's own objects, because startRace hangs a whole race field
// off them.
export function connectedPlayers(roster) {
  const arr = J(roster.map((p) => ({ connected: !!p.connected })));
  return JSON.parse(fn.connectedPlayers(arr)).map((i) => roster[i]);
}

// The lobby's right-rail race card, or null before a pick. randomRaces is the
// RANDOM mode's run length (0 = endless); absent reads as endless, so a shell
// that never sets it gets what `random` meant before run lengths existed.
export function cupSlot({ mode, cupId, trackId, randomRaces }) {
  return JSON.parse(fn.cupSlot(J({
    mode: mode == null ? null : mode,
    cupId: cupId == null ? null : cupId,
    trackId: trackId == null ? null : trackId,
    randomRaces: randomRaces == null ? null : randomRaces
  })));
}

// ---- dropped-seat reconnect cards ------------------------------------------
// `add` comes back as indices into `seats` and is resolved to the seat objects,
// which carry the fields the card is built from. The caller still keeps the
// shown set: putting a card up can FAIL, so only it knows what landed.
export function reconnectDiff(shownIds, seats) {
  const d = JSON.parse(fn.reconnectDiff(J(shownIds), J(seats.map((s) => s.peerIndex))));
  return { remove: d.remove, add: d.add.map((i) => seats[i]) };
}

// ---- the ITEM push ---------------------------------------------------------
// Only the three fields the rule reads cross, not the whole snapshot car. Note
// what is NOT done here: an `item` that is undefined stays undefined through
// JSON.stringify (the key vanishes), which is the third state the rule turns on
// — a slot that went from null to absent pushes again.
export function itemPushes(cars, aiIds, lastItem) {
  const last = [];
  for (const [k, v] of lastItem) last.push(v === undefined ? { id: k } : { id: k, item: v });
  const out = JSON.parse(fn.itemPushes(
    J(cars.map((c) => ({ id: c.id, item: c.item, finished: !!c.finished }))),
    ids(aiIds), J(last)));
  // `item` is absent on the wire when it is undefined — reading the key back
  // gives undefined again, so the ITEM message keeps the shape it always had.
  return out.map((p) => ({ id: p.id, item: p.item }));
}

// The one-shot relight a (re)joining phone gets. null for no live car.
export function welcomeItem(car) {
  return JSON.parse(fn.welcomeItem(car ? J({ id: car.id, item: car.item, finished: !!car.finished }) : 'null'));
}

// ---- race flow -------------------------------------------------------------
// Both finish-moment answers off ONE crossing: allDone is read every frame and
// forfeit only on the frame it flips, so splitting them would double the
// boundary traffic to save nothing.
export function raceFlow({ carIds, aiIds, disconnectedIds, finishedIds }) {
  return JSON.parse(fn.raceFlow(J({
    carIds: [...carIds], aiIds: [...aiIds],
    disconnectedIds: [...disconnectedIds], finishedIds: [...finishedIds]
  })));
}

// ---- pause arbitration -----------------------------------------------------
export function canPause({ hasSession, paused, roomState }) {
  return !!fn.canPause(b(hasSession), b(paused), roomState || '');
}
export function canResume({ hasSession, paused }) {
  return !!fn.canResume(b(hasSession), b(paused));
}

function autoPauseArg({ hasSession, raceEnded, roomState, carIds, aiIds, seatedIds }) {
  return J({
    hasSession: !!hasSession, raceEnded: !!raceEnded, roomState: roomState || '',
    carIds: [...carIds], aiIds: [...aiIds], seatedIds: [...seatedIds]
  });
}
// Would the decision consult the party layer for this input? Reading that
// answer is not free (it pushes the live car set into the room machine), so the
// shell asks first and reads it only on the ticks that need it.
export function autoPauseAsksParticipants(input) { return !!fn.autoPauseAsks(autoPauseArg(input)); }
export function autoPause(input) {
  return JSON.parse(fn.autoPause(autoPauseArg(input), b(input.allParticipantsDisconnected)));
}

export function freezeTransition({ paused, autoPaused, sessionPaused }) {
  return fn.freezeTransition(b(paused), b(autoPaused), b(sessionPaused));
}

// ---- the Grand Prix chip + the standings board ------------------------------
export function seriesInfo(input) {
  return JSON.parse(fn.seriesInfo(J({
    cupId: input.cupId == null ? null : input.cupId,
    cupName: input.cupName == null ? null : input.cupName,
    endless: !!input.endless,
    raceIndex: input.raceIndex,
    raceCount: input.raceCount == null ? null : input.raceCount,
    finished: !!input.finished,
    nextTrackId: input.nextTrackId == null ? null : input.nextTrackId,
    autoAdvanceMs: input.autoAdvanceMs
  })));
}

// The board the TV and every phone render.
//
// ITS KEY ORDER IS NOT THE WIRE'S — see the key-order note on lobbyFrame in
// NativeSessionModel.js. This board reaches phones inside the retained room
// snapshot, and ttp_party.cc canonicalizes every outbound frame, so the order
// ttp_ui_standings_json writes is sorted away before it leaves. The ordered
// emitter is pinned by abi_check at the ABI boundary and by the frozen ui
// corpus; it is not a wire guarantee.
export function standingsPayload({ results, field, cup, lateJoiners, hostPeerIndex, over }) {
  return JSON.parse(fn.standings(J({
    results: results.map((r) => ({ playerId: r.playerId, finished: !!r.finished, time: r.time == null ? null : r.time })),
    field: field.map((p) => ({ peerIndex: p.peerIndex, name: p.name, colorIndex: p.colorIndex, ai: !!p.ai })),
    cup: cup ? { standings: cup.standings, info: cup.info } : null,
    lateJoiners: lateJoiners.map((p) => ({ peerIndex: p.peerIndex, name: p.name, colorIndex: p.colorIndex })),
    hostPeerIndex: hostPeerIndex === undefined ? null : hostPeerIndex,
    over: !!over
  })));
}

// The results overlay, off that same board — pass it straight back.
export function resultsView(board, { intermissionMs }) {
  return JSON.parse(fn.resultsView(J(board), intermissionMs));
}

export function intermissionSecs(deadlineMs, nowMs) {
  return fn.intermissionSecs(deadlineMs, nowMs);
}
