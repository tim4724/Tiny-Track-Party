// NativeRaceFlow — the display's edge of the RACE ORCHESTRATION, which is C++.
//
// raceFlow.js's surface, backed by native/runtime/ttp_race.h over
// native/libttp-runtime/ttp/race_flow.cc. Starting a race, launching one, the
// countdown beats, the finish, the cup chain, the return to the lobby and the
// four roster-driven repairs are all decided in the wasm now. main.js PERFORMS
// the answers and decides nothing.
//
// EVERY ANSWER IS AN ORDERED EFFECT LIST, and the shell's contract is to walk it
// in index order and perform each op. It may not reorder, batch or skip. That is
// not style: four constraints live in the order alone and each is silent when
// broken — COUNTDOWN only after the session exists, the DEFERRED auto-pause
// re-check, points banked before the board, dispose before the LOBBY flip. See
// ttp_race.h.
//
// WHAT THIS FILE IS ALLOWED TO DO, and it is the same short list NativeUiModel
// has: name the shell's own objects (a roster entry, a track id, a sim event),
// turn them into the plain JSON the ABI takes, and hand the answer back. No rule
// may live here — not even a convenience default, because a default IS a rule.
//
// THE PERSONA TABLE COMES OUT OF THE WASM. public/display/aiPersonas.js used to
// be a hand-synced copy of libttp-sim's ttp::AI_PERSONALITIES held together by a
// prose "keep in sync" comment — exactly the drift CLAUDE.md's manifest rule
// exists to stop. personas() reads the real table through ttp_race_personas_json
// and configure() hands it straight back, so there is one table and C++ owns it.
//
// public/display/raceFlow.js stays in the tree and stays the ORACLE:
// tests/fixtures/raceflow-corpus.jsonl was recorded off it, and
// native/runtimetest/raceflow_check.cc replays every step through the C++ on
// every leg while abi_check.cc replays the same corpus through the C boundary
// this file calls. A disagreement between the two is a bug in the port, never in
// the corpus. Nothing that ships imports it.

import { loadNativeRuntime } from './nativeRuntime.js';

let fn = null;

export async function init() {
  if (fn) return;
  const M = await loadNativeRuntime();
  const c = (name, ret, args) => M.cwrap(name, ret, args);
  fn = {
    configure: c('ttp_race_configure', 'number', ['string']),
    personas: c('ttp_race_personas_json', 'string', []),
    buildField: c('ttp_race_build_field_json', 'string', ['string', 'number', 'string']),
    buildDemoField: c('ttp_race_build_demo_field_json', 'string', ['string', 'string']),
    demoSig: c('ttp_race_demo_sig', 'string', ['string', 'string']),
    start: c('ttp_race_start_json', 'string', ['string']),
    drawsNeeded: c('ttp_race_draws_needed', 'number', ['string']),
    launch: c('ttp_race_launch_json', 'string', ['string']),
    countdownTick: c('ttp_race_countdown_tick_json', 'string', ['number']),
    startBeat: c('ttp_race_start_beat_json', 'string', ['string', 'number']),
    event: c('ttp_race_event_json', 'string', ['string']),
    end: c('ttp_race_end_json', 'string', ['string']),
    advance: c('ttp_race_advance_json', 'string', ['string']),
    ret: c('ttp_race_return_json', 'string', ['string']),
    forfeit: c('ttp_race_forfeit_json', 'string', ['number', 'string']),
    rekey: c('ttp_race_rekey_json', 'string', ['number', 'number', 'string', 'string']),
    autoPause: c('ttp_race_auto_pause_json', 'string', ['string'])
  };
}

const J = JSON.stringify;
const P = (s) => JSON.parse(s);
// A JSON-scalar identity: an id crosses as the token `3` or `"3"`, and they are
// different players.
const id = (x) => J(x === undefined ? null : x);

// libttp-sim's persona table — the single source. Read once at boot and handed
// back through configure().
export function personas() { return P(fn.personas()); }

// The world every field rule and series lookup resolves against, set once at
// boot. `carStats` rows are OPAQUE: copied into a field entry and never read,
// which is what keeps CAR_STATS out of the wasm's decision layer.
export function configure({ fieldSize, carCount, colorCount, aiPrefix, personas: ps, carStats, cups }) {
  return fn.configure(J({ fieldSize, carCount, colorCount, aiPrefix, personas: ps, carStats, cups })) === 1;
}

export function buildField(humans, seed, botCap) {
  return P(fn.buildField(J(humans), seed, id(botCap)));
}
export function buildDemoField(humans, botCap) {
  return P(fn.buildDemoField(J(humans), id(botCap)));
}
export function demoSig(field, trackId) { return fn.demoSig(J(field), trackId || ''); }

export function drawsNeeded(input) { return fn.drawsNeeded(J(input)); }
export function startRace(input) { return P(fn.start(J(input))); }
export function launchRace(input) { return P(fn.launch(J(input))); }
export function countdownTick(n) { return P(fn.countdownTick(n)); }
export function raceStart(biome, audioReady) {
  return P(fn.startBeat(biome || '', audioReady ? 1 : 0));
}
export function raceEvent(input) { return P(fn.event(J(input))); }
export function endRace(input) { return P(fn.end(J(input))); }
export function advanceSeriesRace(input) { return P(fn.advance(J(input))); }
export function returnToLobby(input) { return P(fn.ret(J(input))); }
export function forfeitCar(removed, peerIndex) {
  return P(fn.forfeit(removed ? 1 : 0, id(peerIndex)));
}
export function rekeyCarPlayer(hasSeries, rekeyed, oldId, newId) {
  return P(fn.rekey(hasSeries ? 1 : 0, rekeyed ? 1 : 0, id(oldId), id(newId)));
}
export function autoPauseEffects(decision) {
  return P(fn.autoPause(decision == null ? 'null' : J(decision)));
}
