// ttp_runtime.h — the ONE public C ABI of Tiny Track Party's native engine.
//
// A stable, extern "C" surface wrapping the conformance-proven C++ sim
// (native/libttp-sim: RaceSession / Game / AiController). No C++ types cross it;
// the Swift, Kotlin and JS shells are three thin wrappers over exactly these
// functions (docs/native-port/architecture.md). This first slice targets the
// BROWSER: it is compiled to wasm (ttp_sim_web / build-sim-web.sh) and a JS
// adapter re-implements the display's RaceSession surface over it.
//
// Handles, JSON-scalar ids, scratch-buffer lifetime and canonical JSON are the
// shared ABI conventions — see ttp_abi.h. Car ids are those scalars: `3` is the
// numeric id 3, `"cpu-bolt"` the string id, and the two are different cars.
#ifndef TTP_RUNTIME_H
#define TTP_RUNTIME_H

#include <stdint.h>

#include "ttp_abi.h"

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

// ---- track geometry, without a session --------------------------------------

// The augmented race-track object for `trackId` as canonical JSON — the whole
// thing (docs/native-port/contract/race-track.schema.json minus `cup`, which the
// host tags on): centerline samples, resolved furniture, pillars, berms, support
// posts. Returns NULL on an unknown trackId. Dev-only ranges resolve too.
//
// WHY THIS EXISTS. The browser does not call it: the display's renderer lives in
// this same module and reads the built track in place. Its callers are the Node
// authoring and codegen scripts (track-gen, compose-stunt, audit-tracks,
// gen-track-schematics, …), which used to import a SECOND, JS implementation of
// the builder. There is one builder now, and this is how a tool outside the
// browser reads it.
//
// Not on a frame path — one call per track — so it returns a fresh full
// serialization each time rather than keeping a per-track cache.
TTP_ABI const char* ttp_track_json(const char* trackId, int laps, uint32_t seed);

// The same, for a track that is not in the catalogue: `descriptorJson` is one
// authored track descriptor, the shape public/shared/tracks.js entries have —
//   { "id"?, "name"?, "difficulty"?, "width"?, "startU"?,
//     "segments": [ { "kind": "straight"|"arc"|"loop", "length"?, "radius"?,
//                     "angle"?, "rise"?, "bank"?, "roll"?, "drift"?,
//                     "width"?: n | [a,b], "pillars"?, "over"? } ]
//     | "waypoints": [ { "x", "z", "y"?, "w"?, "bank"?, "bridge"? } ],
//     "oils"?/"pads"?/"boxes"?/"poles"?: [ { "u", "lat"?, "radius"? } ],
//     "bananas"?: [ { "u", "lat"? } ] }
// Returns NULL on anything it cannot read, rather than building a track from a
// half-understood descriptor.
//
// WHY THE CATALOGUE IS NOT ENOUGH. The track AUTHORING tools (scripts/track-gen,
// compose-stunt, preview-tracks, probe-cross) exist to evaluate layouts that are
// not shipped yet — thousands of candidates per run, none of them in the
// compiled-in defs. They used to reach a JS builder for that. This is the same
// builder the game runs, driven by a descriptor instead of an id.
TTP_ABI const char* ttp_track_build_json(const char* descriptorJson, int laps, uint32_t seed);

// Support-structure measurements for a built track, for scripts/audit-tracks.mjs:
//   { "posts": [ { "kind": "pillar"|"shaft", "x", "z", "radius",
//                  "intrusion", "s" } ],
//     "autoPoles": [ { "s", "lat", "radius", "x", "z" } ] }
// `intrusion` is the DEEPEST the post reaches into a drivable corridor over the
// whole lap and `s` the arclength where it peaks (intrusion is negative when the
// post never intrudes). Each autoPole carries the world position its (s, lat)
// reconstructs to.
//
// Both are PRIMITIVES, not verdicts: what counts as a graze worth reporting, and
// how near a pole has to land to count as explained, stay in the audit script
// where they are easy to retune. They live here because the alternative is a
// second copy of the builder's own corridor gate and its centreline sampler,
// which is what the audit is meant to be checking.
//
// Takes a track ID or (when it starts with '{') a descriptor, so an unshipped
// candidate can be audited too. NULL if neither resolves.
TTP_ABI const char* ttp_track_supports_json(const char* trackIdOrDescriptor);

// A uniform sweep of interpolated frames along a built track — s = 0, step,
// 2·step, … while s <= length — as
//   [ { "s", "pos":{x,y,z}, "tangent":{x,y,z}, "up":{x,y,z},
//       "lateral":{x,y,z}, "width" }, … ]
// through the builder's own Centerline, so a frame BETWEEN knots is the same
// cubic the sim and the renderer read.
//
// The authoring pipeline's smoothness gate walks a candidate at 0.1-unit steps
// looking for the worst heading step; that is thousands of frames per candidate
// and hundreds of candidates per scan, so it is a sweep rather than one call per
// point. Takes an ID or a descriptor, like ttp_track_supports_json.
// NULL on an unresolvable track or a step <= 0.
TTP_ABI const char* ttp_track_sweep_json(const char* trackIdOrDescriptor, double step);

// The same frames, at an EXPLICIT list of arclengths (a JSON array of numbers)
// rather than a uniform sweep — for a caller that has particular points to ask
// about. Arclengths wrap, like the sampler itself. NULL if the list is not a JSON
// array of numbers.
TTP_ABI const char* ttp_track_frames_json(const char* trackIdOrDescriptor, const char* sListJson);

// {"contractVersion":N,"mathlib":"..."} — the adapter's sanity check.
TTP_ABI const char* ttp_version(void);

#ifdef __cplusplus
}
#endif

#endif  // TTP_RUNTIME_H
