// ttp_room.h — INTERNAL seam between the party ABI and the two ABIs that have
// to read a LIVE ROOM, not an ABI. Sibling of ttp_session.h, same job and same
// rule: the shell names a handle, C++ reads what is behind it, and nothing about
// a roster is serialized out and handed back.
//
// It exists because the room state machine (libttp-party) and the two layers
// that describe the room to a screen or a phone (libttp-runtime's ui_model,
// libttp-party's session model reached through ttp_net.h) are separate
// libraries by design — ui_model.h MIRRORS ROOM_STATE rather than import it, so
// libttp-runtime never gains an edge on the party layer. That rule is about the
// LIBRARIES. The ABI shims in this directory already link both, which is where
// a cross-layer read belongs and where ttp_room_sync_active_order has always
// done it.
//
// NO RoomFlow TYPE CROSSES on the READ accessors, deliberately: they return
// plain ttp::Value, so ttp_ui.cc includes this header and nothing from
// libttp-party's public headers — the seam stays one file wide instead of
// becoming an include that later grows a habit. ttp_room_flow below is the ONE
// exception, and it exists for the choreography walks alone (ttp_net.cc's
// ttp_net_on_* entry points), which MUTATE the room in C++ and therefore need
// the machine itself, not a projection of it. Nothing that only DESCRIBES a
// room may take it.
#ifndef TTP_ROOM_H
#define TTP_ROOM_H

#include <string>

namespace ttp {
struct Value;
class RoomFlow;
}

// The roster as RoomFlow hands it over — ttp_room_list_json's answer as a Value
// instead of as text. Empty array for an unknown handle.
//
// RAW, not the `players` projection, and deliberately: session::lobby_snapshot
// composes that projection itself out of a roster and a flag array, and it is
// pinned by a frozen corpus. Handing it the two halves it already expects keeps
// this seam additive — nothing below it learns a new input shape.
ttp::Value ttp_room_roster_value(int roomHandle);

// The GAME's answer to "does this seat hold a car in the live race", one flag
// per entry of `roster`, in its order — the parallel array
// session::roster_rows composes against, read off ttp_session_engine's Game
// rather than gathered by a shell.
//
// TAKES THE ROSTER rather than fetching it, so a caller that needs both halves
// (ttp_net_lobby_frame does) builds the roster Value ONCE. Fetching it here too
// would be the same compose-it-twice this seam exists to stop, one layer down.
//
// sessionHandle 0 (or unknown/disposed) means NO LIVE RACE, so every seat
// answers false. That is the lobby's own case, and it is what a phone reads as
// "wait for the next race".
ttp::Value ttp_room_in_race_flags(const ttp::Value& roster, int sessionHandle);

// The effective host (the getter fallback chain), as the same JSON scalar
// ttp_room_host_json returns, or null. Null for an unknown handle.
ttp::Value ttp_room_host_value(int roomHandle);

// "lobby" | "countdown" | "playing" | "results". Empty for an unknown handle,
// which every roomStateOf/room_state_of reader already treats as "not a phase".
std::string ttp_room_state_name(int roomHandle);

// The live machine behind a handle, or nullptr — for the choreography walks
// (see the header note). Mutations through it still queue their events on the
// handle exactly as the ttp_room_* mutators do, so a shell that drains
// ttp_room_events_json after a walk observes the same rosterchange/hostchange/
// playerleave cadence it always has. Never owns: the room outlives the call.
ttp::RoomFlow* ttp_room_flow(int roomHandle);

#endif  // TTP_ROOM_H
