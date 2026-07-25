// ttp_runtime.h — the ONE public C ABI of Tiny Track Party's native engine.
//
// A stable, extern "C" surface wrapping the conformance-proven C++ sim
// (native/libttp-sim: RaceSession / Game / AiController). No C++ types cross it;
// the Swift, Kotlin and JS shells are three thin wrappers over exactly these
// functions (docs/native-port/architecture.md). This first slice targets the
// BROWSER: it is compiled to wasm (ttp_sim_web / build-sim-web.sh) and a JS
// adapter re-implements the display's RaceSession surface over it.
//
// CONVENTIONS
//  - Handles are ints > 0 (0 = failure). Every call except ttp_version /
//    ttp_get/set_steer_expo takes a handle as its first argument; an unknown or
//    disposed handle is a safe no-op (queries return 0 / "null" / empty).
//  - Car ids cross as JSON SCALARS in a C string: the token "3" is the numeric
//    id 3, the token "\"cpu-bolt\"" is the string id cpu-bolt. The engine's car
//    map distinguishes numeric from string ids exactly like JS (String(3) vs
//    'cpu-bolt'). "null" / nullptr is the absent id.
//  - Stats/forceItem arguments are JSON (an object, or null / nullptr for the
//    benchmark defaults).
//  - Every const char* return points into a per-handle scratch buffer that is
//    valid ONLY until the next ttp_* call on that handle — copy it out at once
//    (JS UTF8ToString does). ttp_version() uses its own static buffer.
//  - Returned JSON is CANONICAL: recursively sorted keys, ECMA-262 shortest-form
//    numbers — byte-identical to the trace serializer, so fnv1a(ttp_snapshot_json)
//    matches a recorded frame hash.
#ifndef TTP_RUNTIME_H
#define TTP_RUNTIME_H

#include <stdint.h>


// ---- ABI export marking ------------------------------------------------------
// Every entry point below is tagged TTP_ABI. Under emscripten that is
// EMSCRIPTEN_KEEPALIVE, which exports the symbol from the wasm module; the
// declaration IS the export list, so there is no second list to forget. (It used
// to be ~100 names on one -sEXPORTED_FUNCTIONS line in native/CMakeLists.txt,
// where a missed name failed only in the browser, at the cwrap call.) On the
// native/tvOS/Android legs it expands to nothing.
#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define TTP_ABI EMSCRIPTEN_KEEPALIVE
#else
#define TTP_ABI
#endif

#ifdef __cplusplus
extern "C" {
#endif

// ---- lifecycle --------------------------------------------------------------

// Build a race track (buildRaceTrack twin) and open a session handle. Returns a
// handle > 0, or 0 on an unknown trackId. Players are added next, then started.
// forceItemOrNull (DEBUG ?item=): every box rolls this item when non-null.
TTP_ABI int ttp_session_begin(const char* trackId, uint32_t seed, int laps, const char* forceItemOrNull);

// Add a human-driven car (input arrives via ttp_process_input). idJson is a JSON
// scalar; statsJsonOrNull a JSON stats object or null (benchmark defaults).
TTP_ABI void ttp_add_human(int h, const char* idJson, const char* statsJsonOrNull);

// Add an AI car. The runtime constructs its AiController and drives it inside
// ttp_update (no per-bot call). caution/laneBias/aiSeed are the persona knobs.
TTP_ABI void ttp_add_bot(int h, const char* idJson, double caution, double laneBias,
                 uint32_t aiSeed, const char* statsJsonOrNull);

// Construct the RaceSession with all added players (humans first, then bots, in
// add order — grid order matters) and begin the countdown.
//  countdownSeconds >= 0 : normal countdown, racing flips on the GO beat.
//  countdownSeconds  < 0 : NO countdown — racing from frame 0, bare-Game stepping
//                          (the input-replay / golden-trace equivalent).
TTP_ABI void ttp_session_start(int h, int countdownSeconds);

// Advance one frame. Internally drives all bots FIRST (only while racing, exactly
// like the live render loop's driveBots()-then-update ordering), then steps the
// session/engine by dtMs. A no-op while paused or disposed.
TTP_ABI void ttp_update(int h, double dtMs);

// Inject a (possibly partial) CONTROL message for a car. mask bit 1 = s present,
// 2 = b present, 4 = u present; absent fields are left untouched on the car.
TTP_ABI void ttp_process_input(int h, const char* idJson, int mask, double s, double b, double u);

// ---- readback (canonical JSON; see buffer-lifetime note above) --------------

TTP_ABI const char* ttp_snapshot_json(int h);  // getSnapshot() — the per-frame world state
TTP_ABI const char* ttp_results_json(int h);   // getResults() — the ranked finishing board

// Drain the outbound event queue as a JSON array, in fire order: race events
// verbatim, plus the reconstructed session beats {"type":"_countdown","n":N},
// {"type":"_raceStart"} and {"type":"_raceEnd","results":...}. The adapter
// rebuilds the RaceSession callbacks from these. Empties the queue.
TTP_ABI const char* ttp_events_json(int h);

// ---- boundary queries -------------------------------------------------------

TTP_ABI int ttp_has_car(int h, const char* idJson);       // 1 if the car is live
TTP_ABI int ttp_car_finished(int h, const char* idJson);  // 1 finished, 0 racing, -1 unknown
TTP_ABI const char* ttp_car_ids_json(int h);              // JSON array of live car ids

// Write a car's world position / a track (arclength,lateral) world point into
// out3 (a persistent 3-double buffer, e.g. HEAPF64). Returns 1 on success, 0 for
// an unknown car (out3 untouched).
TTP_ABI int ttp_car_world_pos(int h, const char* idJson, double* out3);
TTP_ABI int ttp_track_point(int h, double s, double lat, double* out3);

// ---- mid-race mutation ------------------------------------------------------

TTP_ABI int ttp_force_remove_car(int h, const char* idJson);                 // forceRemoveCar (incl. end-trigger)
TTP_ABI int ttp_rekey_car(int h, const char* oldJson, const char* newJson);  // rekeyCar
TTP_ABI void ttp_force_finish(int h, const char* idJson, double time);       // forceFinish (synthetic time)
TTP_ABI void ttp_fast_forward(int h);                                        // fastForwardToEnd (drives bots internally)

// ---- pause / state ----------------------------------------------------------

TTP_ABI void ttp_pause(int h);
TTP_ABI void ttp_resume(int h);
TTP_ABI int ttp_racing(int h);
TTP_ABI int ttp_paused(int h);
TTP_ABI void ttp_dispose(int h);

// ---- global tunable (affects every session, like Game.js _steerExpo) --------

TTP_ABI void ttp_set_steer_expo(double v);
TTP_ABI double ttp_get_steer_expo(void);

// ---- Grand Prix / cup series (GrandPrix.js CupSeries twin) ------------------
// The series layer ABOVE a race: points, standings order, race chaining. Handles
// are independent of session handles.
//
// The endless-mode DRAW stays with the host: it comes from a page-RNG shuffle bag
// (display-side by design, not sim state). The host offers its next draw on every
// apply_race; CupSeries consumes it only when the rules say to (at the last race
// of an endless series), so the DECISION stays here while the randomness does not.

// cupJson: {"id":..,"name":..,"tracks":[trackId,...]}. endless != 0 makes it an
// endless series (drawn tracks appended) instead of a fixed cup.
TTP_ABI int ttp_gp_create(const char* cupJson, int endless);
TTP_ABI void ttp_gp_dispose(int h);

TTP_ABI int ttp_gp_endless(int h);
TTP_ABI int ttp_gp_race_count(int h);
TTP_ABI int ttp_gp_race_index(int h);
TTP_ABI int ttp_gp_finished(int h);
TTP_ABI const char* ttp_gp_current_track(int h);
TTP_ABI const char* ttp_gp_next_track(int h);   // "" == JS null
TTP_ABI const char* ttp_gp_cup_json(int h);

// resultsJson: [{"playerId":<scalar>,"rank":N,"finished":bool},...] (Game results)
// fieldJson:   [{"peerIndex":<scalar>,"name":..,"colorIndex":N,"ai":bool},...]
// drawnTrackIdOrNull: the host's next shuffle-bag draw (endless only; may be null).
TTP_ABI void ttp_gp_apply_race(int h, const char* resultsJson, const char* fieldJson,
                       const char* drawnTrackIdOrNull);
TTP_ABI void ttp_gp_advance(int h);
TTP_ABI const char* ttp_gp_standings_json(int h);
TTP_ABI void ttp_gp_rekey(int h, const char* oldIdJson, const char* newIdJson);

// {"contractVersion":N,"mathlib":"..."} — the adapter's sanity check.
TTP_ABI const char* ttp_version(void);

#ifdef __cplusplus
}
#endif

#endif  // TTP_RUNTIME_H
