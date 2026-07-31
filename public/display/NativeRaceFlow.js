// NativeRaceFlow — the display's edge of the RACE ORCHESTRATION, which is C++.
//
// native/runtime/ttp_race.h over native/libttp-runtime/ttp/race_flow.cc. Every
// entry point is a WALK over the live handles: it gathers the room's phase,
// the connected players and the stored pick off the room handle in C++, reads
// the series off the gp handle, and answers an ordered effect list. main.js
// PERFORMS the answers and decides nothing — it no longer assembles a single
// input object.
//
// EVERY ANSWER IS AN ORDERED EFFECT LIST, and the shell's contract is to walk it
// in index order and perform each op. It may not reorder, batch or skip. That is
// not style: four constraints live in the order alone and each is silent when
// broken — COUNTDOWN only after the session exists, the DEFERRED auto-pause
// re-check, points banked before the board, dispose before the LOBBY flip. See
// ttp_race.h. effectOps() is the walks' whole op vocabulary; main.js asserts its
// performer switch against it at boot, so a missing arm fails the load instead
// of dropping a step mid-party.
//
// THE DRAWS PROTOCOL (start / return): call with draws=null first; an answer of
// {action:'draws', drawsNeeded:n} means pull exactly n from the shuffle bag and
// call again with them. The bag stays here (page RNG, not sim state); the WHEN
// and the HOW MANY are the walk's. See ttp_race.h.
//
// THE PERSONA TABLE COMES OUT OF THE WASM. personas() reads the real table
// through ttp_race_personas_json and configure() hands it straight back, so
// there is one table and C++ owns it.
//
// public/display/raceFlow.js stays in the tree and stays the ORACLE:
// tests/fixtures/raceflow-corpus.jsonl was recorded off it, and
// native/runtimetest/raceflow_check.cc replays every step through the C++ on
// every leg. Nothing that ships imports it.

import { loadNativeRuntime } from './nativeRuntime.js';

let fn = null;

export async function init() {
  if (fn) return;
  const M = await loadNativeRuntime();
  const c = (name, ret, args) => M.cwrap(name, ret, args);
  fn = {
    configure: c('ttp_race_configure', 'number', ['string']),
    personas: c('ttp_race_personas_json', 'string', []),
    effectOps: c('ttp_race_effect_ops_json', 'string', []),
    demoLive: c('ttp_race_demo_live_json', 'string', ['number', 'string', 'string']),
    start: c('ttp_race_start_live_json', 'string',
             ['number', 'number', 'string', 'number', 'number', 'string', 'string']),
    launch: c('ttp_race_launch_live_json', 'string',
              ['number', 'number', 'number', 'string', 'string']),
    events: c('ttp_race_events_live_json', 'string',
              ['number', 'number', 'number', 'string', 'number', 'number',
               'number', 'number', 'number']),
    advance: c('ttp_race_advance_live_json', 'string', ['number', 'number', 'number']),
    ret: c('ttp_race_return_live_json', 'string', ['number', 'string']),
    endParty: c('ttp_race_end_party_json', 'string', []),
    pauseRace: c('ttp_race_pause_live_json', 'string',
                 ['number', 'number', 'number', 'number', 'number']),
    resumeRace: c('ttp_race_resume_live_json', 'string',
                  ['number', 'number', 'number', 'number', 'number']),
    intermissionMs: c('ttp_race_intermission_ms', 'number', []),
    resultsFailsafeMs: c('ttp_race_results_failsafe_ms', 'number', []),
    forfeit: c('ttp_race_forfeit_live_json', 'string', ['number', 'string']),
    rekey: c('ttp_race_rekey_live_json', 'string', ['number', 'number', 'string', 'string']),
    autoPause: c('ttp_race_auto_pause_live_json', 'string', ['number', 'number', 'number'])
  };
}

const J = JSON.stringify;
const P = (s) => JSON.parse(s);
// A JSON-scalar identity: an id crosses as the token `3` or `"3"`, and they are
// different players.
const id = (x) => J(x === undefined ? null : x);
// draws=null is the ask phase; an array is the launch/return phase.
const drawsArg = (draws) => (draws == null ? null : J(draws));

// libttp-sim's persona table — the single source. Read once at boot and handed
// back through configure().
export function personas() { return P(fn.personas()); }

// The walks' whole effect vocabulary — main.js proves its switch total at boot.
export function effectOps() { return P(fn.effectOps()); }

// The world every field rule and series lookup resolves against, set once at
// boot. `carStats` rows are OPAQUE: copied into a field entry and never read,
// which is what keeps CAR_STATS out of the wasm's decision layer.
export function configure({ fieldSize, carCount, colorCount, aiPrefix, personas: ps, carStats, cups }) {
  return fn.configure(J({ fieldSize, carCount, colorCount, aiPrefix, personas: ps, carStats, cups })) === 1;
}

// The lobby attract grid + its render signature, off the live room.
export function demoLive(roomHandle, trackId, botCap) {
  return P(fn.demoLive(roomHandle, trackId || '', id(botCap)));
}

export function startRace(roomHandle, sceneReady, draws, { seed, countdownSeconds, forceItem, botCap }) {
  return P(fn.start(roomHandle, sceneReady ? 1 : 0, drawsArg(draws),
                    seed, countdownSeconds, forceItem || null, id(botCap)));
}
export function launchRace(roomHandle, { seed, countdownSeconds, forceItem, botCap }) {
  return P(fn.launch(roomHandle, seed, countdownSeconds, forceItem || null, id(botCap)));
}

// The frame's drain: every queued race event routed and answered as one effect
// list; `results` is non-null exactly when the drain crossed the race's end.
export function drainEvents(sessionHandle, roomHandle, gpHandle,
                            { biome, audioReady, fastForwarding, intermissionMs, nowMs, resultsFailsafeMs }) {
  return P(fn.events(sessionHandle, roomHandle, gpHandle, biome || '',
                     audioReady ? 1 : 0, fastForwarding ? 1 : 0,
                     intermissionMs, nowMs, resultsFailsafeMs));
}

export function advanceSeriesRace(roomHandle, gpHandle, sceneReady) {
  return P(fn.advance(roomHandle, gpHandle, sceneReady ? 1 : 0));
}
export function returnToLobby(roomHandle, draws) {
  return P(fn.ret(roomHandle, drawsArg(draws)));
}
export function endParty() { return P(fn.endParty()); }

export function pauseRace(sessionHandle, roomHandle, { paused, autoPaused, raceEnded }) {
  return P(fn.pauseRace(sessionHandle, roomHandle, paused ? 1 : 0, autoPaused ? 1 : 0, raceEnded ? 1 : 0));
}
export function resumeRace(sessionHandle, roomHandle, { paused, autoPaused, raceEnded }) {
  return P(fn.resumeRace(sessionHandle, roomHandle, paused ? 1 : 0, autoPaused ? 1 : 0, raceEnded ? 1 : 0));
}

export function intermissionMs() { return fn.intermissionMs(); }
export function resultsFailsafeMs() { return fn.resultsFailsafeMs(); }

export function forfeitCar(sessionHandle, peerIndex) {
  return P(fn.forfeit(sessionHandle, id(peerIndex)));
}
export function rekeyCarPlayer(sessionHandle, gpHandle, oldId, newId) {
  return P(fn.rekey(sessionHandle, gpHandle, id(oldId), id(newId)));
}
export function autoPause(sessionHandle, roomHandle, raceEnded) {
  return P(fn.autoPause(sessionHandle, roomHandle, raceEnded ? 1 : 0));
}
