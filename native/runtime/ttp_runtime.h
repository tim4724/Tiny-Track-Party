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

#ifdef __cplusplus
extern "C" {
#endif

// ---- lifecycle --------------------------------------------------------------

// Build a race track (buildRaceTrack twin) and open a session handle. Returns a
// handle > 0, or 0 on an unknown trackId. Players are added next, then started.
// forceItemOrNull (DEBUG ?item=): every box rolls this item when non-null.
int ttp_session_begin(const char* trackId, uint32_t seed, int laps, const char* forceItemOrNull);

// Add a human-driven car (input arrives via ttp_process_input). idJson is a JSON
// scalar; statsJsonOrNull a JSON stats object or null (benchmark defaults).
void ttp_add_human(int h, const char* idJson, const char* statsJsonOrNull);

// Add an AI car. The runtime constructs its AiController and drives it inside
// ttp_update (no per-bot call). caution/laneBias/aiSeed are the persona knobs.
void ttp_add_bot(int h, const char* idJson, double caution, double laneBias,
                 uint32_t aiSeed, const char* statsJsonOrNull);

// Construct the RaceSession with all added players (humans first, then bots, in
// add order — grid order matters) and begin the countdown.
//  countdownSeconds >= 0 : normal countdown, racing flips on the GO beat.
//  countdownSeconds  < 0 : NO countdown — racing from frame 0, bare-Game stepping
//                          (the input-replay / golden-trace equivalent).
void ttp_session_start(int h, int countdownSeconds);

// Advance one frame. Internally drives all bots FIRST (only while racing, exactly
// like the live render loop's driveBots()-then-update ordering), then steps the
// session/engine by dtMs. A no-op while paused or disposed.
void ttp_update(int h, double dtMs);

// Inject a (possibly partial) CONTROL message for a car. mask bit 1 = s present,
// 2 = b present, 4 = u present; absent fields are left untouched on the car.
void ttp_process_input(int h, const char* idJson, int mask, double s, double b, double u);

// ---- readback (canonical JSON; see buffer-lifetime note above) --------------

const char* ttp_snapshot_json(int h);  // getSnapshot() — the per-frame world state
const char* ttp_results_json(int h);   // getResults() — the ranked finishing board

// Drain the outbound event queue as a JSON array, in fire order: race events
// verbatim, plus the reconstructed session beats {"type":"_countdown","n":N},
// {"type":"_raceStart"} and {"type":"_raceEnd","results":...}. The adapter
// rebuilds the RaceSession callbacks from these. Empties the queue.
const char* ttp_events_json(int h);

// ---- boundary queries -------------------------------------------------------

int ttp_has_car(int h, const char* idJson);       // 1 if the car is live
int ttp_car_finished(int h, const char* idJson);  // 1 finished, 0 racing, -1 unknown
const char* ttp_car_ids_json(int h);              // JSON array of live car ids

// Write a car's world position / a track (arclength,lateral) world point into
// out3 (a persistent 3-double buffer, e.g. HEAPF64). Returns 1 on success, 0 for
// an unknown car (out3 untouched).
int ttp_car_world_pos(int h, const char* idJson, double* out3);
int ttp_track_point(int h, double s, double lat, double* out3);

// ---- mid-race mutation ------------------------------------------------------

int ttp_force_remove_car(int h, const char* idJson);                 // forceRemoveCar (incl. end-trigger)
int ttp_rekey_car(int h, const char* oldJson, const char* newJson);  // rekeyCar
void ttp_force_finish(int h, const char* idJson, double time);       // forceFinish (synthetic time)
void ttp_fast_forward(int h);                                        // fastForwardToEnd (drives bots internally)

// ---- pause / state ----------------------------------------------------------

void ttp_pause(int h);
void ttp_resume(int h);
int ttp_racing(int h);
int ttp_paused(int h);
void ttp_dispose(int h);

// ---- global tunable (affects every session, like Game.js _steerExpo) --------

void ttp_set_steer_expo(double v);
double ttp_get_steer_expo(void);

// {"contractVersion":N,"mathlib":"..."} — the adapter's sanity check.
const char* ttp_version(void);

#ifdef __cplusplus
}
#endif

#endif  // TTP_RUNTIME_H
