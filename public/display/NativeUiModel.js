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
//   * reconnectDiff comes back as INDICES, and this file resolves them against
//     the array it passed in — so the shell keeps its OWN objects (and
//     whatever it hangs off them) instead of racing a copy that has been
//     through a serializer.
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

import { loadNativeRuntime, nativeError } from './nativeRuntime.js';

let fn = null;

export async function init() {
  if (fn) return;
  const M = await loadNativeRuntime();
  const c = (name, ret, args) => M.cwrap(name, ret, args);
  fn = {
    configure: c('ttp_ui_configure', 'number', ['string']),
    catalogue: c('ttp_ui_catalogue_json', 'string', []),
    progressLoad: c('ttp_ui_progress_load', 'number', ['string', 'number']),
    progressJson: c('ttp_ui_progress_json', 'string', []),
    screenStep: c('ttp_ui_screen_step', 'number', ['string', 'string']),
    backEffect: c('ttp_ui_back_effect', 'string', ['string']),
    cover: c('ttp_ui_cover', 'string', ['string', 'number']),
    rosterSeatsFromRoom: c('ttp_ui_roster_seats_room_json', 'string', ['number', 'string']),
    seatGrid: c('ttp_ui_seat_grid_json', 'string', ['string']),
    cupSlot: c('ttp_ui_cup_slot_json', 'string', ['string']),
    reconnectDiff: c('ttp_ui_reconnect_diff_json', 'string', ['string', 'string']),
    itemPushes: c('ttp_ui_item_pushes_live_json', 'string', ['number', 'string']),
    welcomeItem: c('ttp_ui_welcome_item_live_json', 'string', ['number', 'string']),
    raceFlowLive: c('ttp_ui_race_flow_live_json', 'string', ['number', 'number']),
    freezePlan: c('ttp_ui_freeze_plan_json', 'string', ['number', 'number', 'number']),
    resultsAction: c('ttp_ui_results_action_json', 'string', ['number']),
    standingsLive: c('ttp_ui_standings_live_json', 'string',
      ['number', 'number', 'number', 'string', 'number']),
    resultsView: c('ttp_ui_results_view_json', 'string', ['string', 'number']),
    intermissionSecs: c('ttp_ui_intermission_secs', 'number', ['number', 'number'])
  };
}

const J = JSON.stringify;
const id = (x) => J(x === undefined ? null : x);   // a JSON-scalar identity
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
  if (!ok) throw nativeError('configuring the UI model');
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

// ---- the couch's progression record -----------------------------------------
// The shell PERSISTS the blob and DECIDES nothing about it: hand whatever
// localStorage held to progressLoad at boot (null/corrupt loads a fresh couch),
// and write back the blob the race walk's persist-progression effect carries.
// Stars, the Playroom lock and the unlock progress come out stamped on
// catalogue() above. `unlockAll` is the ?unlockAll=1 dev/test override.
export function progressLoad(json, unlockAll) { fn.progressLoad(json || '', unlockAll ? 1 : 0); }
export function progressJson() { return fn.progressJson(); }

// ---- screens ---------------------------------------------------------------
// >0 = a forward step, <0 = a retreat, 0 = same level. WALKING the stack is the
// shell's (the History API here, Menu on tvOS); only the table is native.
export function screenStep(prev, next) { return fn.screenStep(prev || '', next || ''); }
export function backEffect(screen) { return fn.backEffect(screen || ''); }
// Which full-bleed cover this board owes — 'none' | 'boot'. `scenePainted` is
// the one fact only a shell has: a BUILT scene having reached the panel.
export function cover(screen, scenePainted) {
  return fn.cover(screen || '', scenePainted ? 1 : 0);
}

// ---- the lobby -------------------------------------------------------------
// The seat grid off a LIVE ROOM handle. A Seat carries name, colorIndex,
// carIndex, connected, host and ready — never inRace — so this is a projection
// of the room alone and needs no session handle.
//
// The shell used to reach the same rows the long way round: pull the roster out
// of the party ABI, ferry it through the retained snapshot's `players`
// projection, then hand those rows back here. That made the lobby's own grid
// depend on the wire message sitting next to it, and serialized the roster three
// times to render it once.
export function rosterSeatsFromRoom(roomHandle, hostPeerIndex) {
  return JSON.parse(fn.rosterSeatsFromRoom(roomHandle | 0, id(hostPeerIndex)));
}

// The taken seats padded with OPEN placeholders (maxPlayers and the car roster
// size come from configure, not from a second copy on this side).
export function seatGrid(seats) { return JSON.parse(fn.seatGrid(J(seats))); }

// (allRacersReady and connectedPlayers have no ABI spelling anymore: the
// START_GAME gate lives inside ttp_net_controller_action, and the race walks
// gather the connected players off the room handle themselves.)

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
// The cars and the CPU set come off the live session in C++; what crosses is
// the shell's own outbox map — what each phone was last told, in insertion
// order. An `item` that is undefined stays undefined through JSON.stringify
// (the key vanishes), which is the third state the rule turns on.
export function itemPushes(sessionHandle, lastItem) {
  const last = [];
  for (const [k, v] of lastItem) last.push(v === undefined ? { id: k } : { id: k, item: v });
  const out = JSON.parse(fn.itemPushes(sessionHandle | 0, J(last)));
  // `item` is absent on the wire when it is undefined — reading the key back
  // gives undefined again, so the ITEM message keeps the shape it always had.
  return out.map((p) => ({ id: p.id, item: p.item }));
}

// The one-shot relight a (re)joining phone gets, off the live race.
export function welcomeItem(sessionHandle, peerIndex) {
  return JSON.parse(fn.welcomeItem(sessionHandle | 0, id(peerIndex)));
}

// ---- race flow -------------------------------------------------------------
// Both finish-moment answers off ONE crossing: allDone is read every frame and
// forfeit only on the frame it flips, so splitting them would double the
// boundary traffic to save nothing. The role sets are GATHERED in C++ off the
// two handles (ttp_ui_race_flow_live_json) — the shell no longer assembles
// carIds/aiIds/disconnectedIds/finishedIds at all.
export function raceFlow(sessionHandle, roomHandle) {
  return JSON.parse(fn.raceFlowLive(sessionHandle | 0, roomHandle | 0));
}

// ---- pause arbitration -----------------------------------------------------
// (canPause/canResume/autoPause have no spelling here anymore: the pause and
// resume walks ask the verdicts inside ttp_race_pause_live_json, and the whole
// silent-freeze arbitration is ttp_race_auto_pause_live_json's — decision and
// effects in one walk.)

// The transition AND its ordered member ops in one answer; the shell walks
// `ops` and re-derives nothing (thaw is deliberately not freeze reversed).
export function freezePlan(paused, autoPaused, sessionPaused) {
  return JSON.parse(fn.freezePlan(b(paused), b(autoPaused), b(sessionPaused)));
}

// What the results board's one button does — the branch behind the click,
// answered by the same layer that labels it (resultsView's newGameKey).
export function resultsAction(roomHandle) {
  return JSON.parse(fn.resultsAction(roomHandle | 0));
}

// ---- the standings board ----------------------------------------------------
// (The Grand Prix chip rides the board's `cup.info` — ttp_ui_series_info_live_json
// stays exported for a shell that draws the chip alone; this page reads it off
// the board and wraps nothing.)

// The board the TV and every phone render.
//
// ITS KEY ORDER IS NOT THE WIRE'S — see the key-order note on lobbyFrame in
// NativeSessionModel.js. This board reaches phones inside the retained room
// snapshot, and ttp_party.cc canonicalizes every outbound frame, so the order
// ttp_ui_standings_json writes is sorted away before it leaves. The ordered
// emitter is pinned by abi_check at the ABI boundary and by the frozen ui
// corpus; it is not a wire guarantee.
// results/cup/lateJoiners/host are gathered in C++ off the three handles
// (ttp_ui_standings_live_json). The FIELD is the one shell-owned input left:
// the launch's frozen copy plus the shell's rename/rekey repairs (the AI
// racers are not in any roster the room knows).
export function standingsPayload({ sessionHandle, roomHandle, over, results, autoAdvanceMs }) {
  return JSON.parse(fn.standingsLive(
    sessionHandle | 0, roomHandle | 0, b(over),
    results ? J(results) : null,
    autoAdvanceMs));
}

// The results overlay, off that same board — pass it straight back.
export function resultsView(board, { intermissionMs }) {
  return JSON.parse(fn.resultsView(J(board), intermissionMs));
}

export function intermissionSecs(deadlineMs, nowMs) {
  return fn.intermissionSecs(deadlineMs, nowMs);
}
