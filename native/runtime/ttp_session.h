// ttp_session.h — INTERNAL seam between the two halves of the runtime, not an
// ABI: the display shell reads the live Game of a session handle in C++ rather
// than receiving a serialized copy of it back from the shell.
//
// One MUTATION path, deliberately: the sim ABI in ttp_runtime.h stays the only
// way anything mutates a session. The Value accessors below are describe-only
// reads for the ui twins (ttp_ui.cc's *_live_json exports), which gather the
// role sets a shell used to loop the C boundary to build — see ttp_room.h for
// the same rule on the room side.
#ifndef TTP_SESSION_H
#define TTP_SESSION_H

namespace ttp {
class Game;
struct Value;
}

// The engine behind a ttp_session_begin handle, or nullptr for an unknown,
// disposed or not-yet-built handle. Never owns: the session outlives the call.
ttp::Game* ttp_session_engine(int handle);

// The live car ids in grid order (humans first, then bots, in add order) — the
// same source and order ttp_car_ids_json answers from. Empty array for an
// unknown handle, which readers already treat as "no race".
ttp::Value ttp_session_car_ids(int handle);

// The CPU racers among them, in bot add order. This is REGISTRY state (which
// ids ttp_add_bot claimed), not a Game property — the sim drives whichever
// cars the registry hands it, so the registry is the one truthful source.
// Empty array for an unknown handle or an all-human race.
ttp::Value ttp_session_ai_ids(int handle);

// Per-id "has crossed the line" over a caller-ordered id list, in its order.
// An unknown car answers false, exactly as the shell's `=== 1` fold read the
// C ABI's -1 (ttp_car_finished's contract).
ttp::Value ttp_session_finished_flags(int handle, const ttp::Value& carIds);

// getResults()'s row array (each row {playerId, finished, time, ...}) — the
// `.results` the standings board reads. Empty array when there is no engine,
// which composes to an empty board, never a crash.
ttp::Value ttp_session_results_rows(int handle);

#endif  // TTP_SESSION_H
