// ttp_session.h — INTERNAL seam between the two halves of the runtime, not an
// ABI: the display shell reads the live Game of a session handle in C++ rather
// than receiving a serialized copy of it back from the shell.
//
// One MUTATION path for the RACE, deliberately: the sim ABI in ttp_runtime.h
// stays the only way anything mutates a session's Game. The Value accessors
// below are describe-only reads for the ui twins (ttp_ui.cc's *_live_json
// exports), which gather the role sets a shell used to loop the C boundary to
// build — see ttp_room.h for the same rule on the room side. The one writable
// accessor (the ITEM outbox) hands back state that is not the Game's at all;
// its own comment says why it lives on the session.
#ifndef TTP_SESSION_H
#define TTP_SESSION_H

namespace ttp {
class CupSeries;
class Game;
struct Value;
namespace rt { namespace ui { class LastItems; } }
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

// The live cars as the ITEM-push rule reads them
// ([{"id","item":str|null,"finished"}], grid order) — the per-owner USE-button
// gather, off the engine rather than a snapshot. Empty for an unknown handle.
ttp::Value ttp_session_item_cars(int handle);

// The per-phone ITEM OUTBOX — what each phone was last told its held item was,
// in the order the phones were first told. WRITABLE, because the push rule and
// the welcome relight both stamp it as they answer; nullptr for an unknown
// handle, which the callers answer "nothing to push" for.
//
// PER SESSION, and that is a decision. It is not Game state (nothing in the sim
// knows a phone exists) and it could as easily have been one map beside the ui
// ABI's other statics — but a race IS its lifetime: the walk's clear-item-cache
// fires as a race launches, and every launch builds a new session. Hanging it
// here makes that clear a no-op by construction instead of a rule three shells
// had to keep, and keeps concurrent sessions (the ABI checks run several) from
// sharing one outbox.
ttp::rt::ui::LastItems* ttp_session_item_outbox(int handle);

// Drain the session's outbound event queue — race events verbatim plus the
// reconstructed lifecycle beats — in fire order, and EMPTY it. The same queue
// ttp_events_json spells as text; the race walk's event drain routes it in
// C++ instead. Empty array for an unknown handle.
ttp::Value ttp_session_drain_events(int handle);

// The live cup series behind a ttp_gp_create handle, or nullptr — the seam the
// ui and race shims read series metadata through, so no scalar getter has to
// be exported per field (ttp_gp_state_json is the shell's one read).
ttp::CupSeries* ttp_gp_series(int handle);

// The series' standings rows in the JS twin's spelling (absent keys for an
// unseated row) — shared by ttp_gp_state_json and the standings board's live
// gather. Empty array for an unknown handle.
ttp::Value ttp_gp_standings_value(int handle);

#endif  // TTP_SESSION_H
