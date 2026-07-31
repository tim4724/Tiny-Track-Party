// NativeRaceFlow — the display's edge of the RACE ORCHESTRATION, which is C++.
//
// native/runtime/ttp_race.h over native/libttp-runtime/ttp/race_flow.cc. Every
// entry point is an EXECUTOR WALK over the live handles: it gathers the
// room's phase, the connected players, the stored pick, the bag and the
// series off the room handle in C++, performs the series/field/pick ops
// itself, and answers only the ordered platform ops. main.js PERFORMS the
// answers and decides nothing.
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
// THERE IS NO DRAWS PROTOCOL AND NO SERIES HANDLE. The shuffle bag, the cup
// series and the launched field live behind the room (seeded/created/retained
// by the walks); a start, an advance and a return are each ONE call, and the
// series is displayed via seriesState(). The persona table defaults inside
// configure (libttp-sim's own), so boot hands over nothing it read back.
//
// tests/fixtures/raceflow-corpus.jsonl was recorded off the JS oracle
// (public/display/raceFlow.js, retired — git history has it) and is FROZEN;
// native/runtimetest/raceflow_check.cc replays every step through the C++ on
// every leg.

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
             ['number', 'number', 'number', 'number', 'string', 'string']),
    events: c('ttp_race_events_live_json', 'string',
              ['number', 'number', 'string', 'number', 'number',
               'number', 'number', 'number']),
    advance: c('ttp_race_advance_live_json', 'string',
               ['number', 'number', 'number', 'number', 'string', 'string']),
    ret: c('ttp_race_return_live_json', 'string', ['number']),
    seriesState: c('ttp_race_series_state_json', 'string', ['number']),
    endParty: c('ttp_race_end_party_json', 'string', []),
    pauseRace: c('ttp_race_pause_live_json', 'string',
                 ['number', 'number', 'number', 'number', 'number']),
    resumeRace: c('ttp_race_resume_live_json', 'string',
                  ['number', 'number', 'number', 'number', 'number']),
    intermissionMs: c('ttp_race_intermission_ms', 'number', []),
    resultsFailsafeMs: c('ttp_race_results_failsafe_ms', 'number', []),
    forfeit: c('ttp_race_forfeit_live_json', 'string', ['number', 'string']),
    rekey: c('ttp_race_rekey_live_json', 'string', ['number', 'number', 'string', 'string']),  // (session, room)
    autoPause: c('ttp_race_auto_pause_live_json', 'string', ['number', 'number', 'number'])
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

export function startRace(roomHandle, sceneReady, { seed, countdownSeconds, forceItem, botCap }) {
  return P(fn.start(roomHandle, sceneReady ? 1 : 0,
                    seed, countdownSeconds, forceItem || null, id(botCap)));
}

// The frame's drain: every queued race event routed and answered as one effect
// list; `results` is non-null exactly when the drain crossed the race's end.
export function drainEvents(sessionHandle, roomHandle,
                            { biome, audioReady, fastForwarding, intermissionMs, nowMs, resultsFailsafeMs }) {
  return P(fn.events(sessionHandle, roomHandle, biome || '',
                     audioReady ? 1 : 0, fastForwarding ? 1 : 0,
                     intermissionMs, nowMs, resultsFailsafeMs));
}

export function advanceSeriesRace(roomHandle, sceneReady, { seed, countdownSeconds, forceItem, botCap }) {
  return P(fn.advance(roomHandle, sceneReady ? 1 : 0,
                      seed, countdownSeconds, forceItem || null, id(botCap)));
}
export function returnToLobby(roomHandle) {
  return P(fn.ret(roomHandle));
}
// The room's series state as one read — the E2E surface and any series display.
export function seriesState(roomHandle) {
  return P(fn.seriesState(roomHandle));
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
export function rekeyCarPlayer(sessionHandle, roomHandle, oldId, newId) {
  return P(fn.rekey(sessionHandle, roomHandle, id(oldId), id(newId)));
}
export function autoPause(sessionHandle, roomHandle, raceEnded) {
  return P(fn.autoPause(sessionHandle, roomHandle, raceEnded ? 1 : 0));
}
