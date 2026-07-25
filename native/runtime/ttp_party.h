// ttp_party.h — the public C ABI of Tiny Track Party's native PARTY layer.
//
// Sibling of ttp_runtime.h (the sim ABI): a stable extern "C" surface wrapping
// the conformance-proven C++ party layer (native/libttp-party). This first slice
// exposes RoomFlow — the room state machine (roster identity/join order,
// presence, host election, liveness) — which the display's ?party=native adapter
// re-implements the kit's RoomFlow surface over.
//
// The transport stays on the host side BY DESIGN: sockets and RTCPeerConnection
// belong to the platform (in the browser they are JS's, and always will be —
// wasm cannot open either without proxying through JS anyway). This ABI carries
// DECISIONS, not bytes.
//
// CONVENTIONS (identical to ttp_runtime.h, so the shells share one mental model)
//  - Handles are ints > 0 (0 = failure). An unknown or disposed handle is a safe
//    no-op: queries return 0 / "null" / an empty array.
//  - Peer indices cross as JSON SCALARS in a C string: the token "3" is the
//    numeric peerIndex 3, "\"abc\"" the string id abc; numbers and strings are
//    DISTINCT keys, exactly like JS. "null" / nullptr is the absent id.
//  - Opaque game fields (name, colorIndex, ...) cross as a JSON object and are
//    stored verbatim; RoomFlow never reads them.
//  - Every const char* return points into a per-handle scratch buffer valid ONLY
//    until the next ttp_* call on that handle — copy it out at once (JS
//    UTF8ToString does). ttp_party_version() uses its own static buffer.
//  - Returned JSON is CANONICAL (recursively sorted keys, ECMA-262 shortest-form
//    numbers), byte-identical to the trace serializer.
//  - Events are not callbacks: they queue and are drained as a JSON array by
//    ttp_room_events_json, in exact emission order. The adapter re-fires them to
//    the kit's on(...) listeners. Drain after EVERY mutating call — intra-op
//    order is load-bearing.
#ifndef TTP_PARTY_H
#define TTP_PARTY_H

#ifdef __cplusplus
extern "C" {
#endif

// ---- lifecycle --------------------------------------------------------------

// Open a RoomFlow handle. configJson mirrors the JS constructor options:
//   { "master": <peerId|null>,            // present => a masterProvider exists
//     "liveness": { "timeoutMs": N,       // absent => liveness disabled entirely
//                   "graceMs": N,
//                   "useEnabledProvider": bool } }
// nullptr / "null" / "{}" gives the defaults (no master provider, no liveness).
int ttp_room_create(const char* configJson);
void ttp_room_dispose(int h);
void ttp_room_reset(int h);

// ---- roster -----------------------------------------------------------------

// addPlayer: returns the resulting player record as canonical JSON (the kit-owned
// keys peerIndex/joinedAt/connected plus the caller's fields), or "null".
const char* ttp_room_add_player(int h, const char* peerIdJson, const char* fieldsJsonOrNull);
void ttp_room_remove_player(int h, const char* peerIdJson);
int ttp_room_rekey(int h, const char* oldIdJson, const char* newIdJson);  // 1 on success
// Write one opaque game field onto a live record — the ABI equivalent of the JS
// kit's mutable-record write (`flow.get(p).ready = true`). Emits nothing, like
// the assignment it replaces; kit-owned keys are refused. 1 on success.
int ttp_room_set_field(int h, const char* peerIdJson, const char* key, const char* valueJson);
void ttp_room_mark_disconnected(int h, const char* peerIdJson);
void ttp_room_mark_reconnected(int h, const char* peerIdJson);
// clearDisconnected(nowMs). hasNow=0 means the JS call with no argument.
void ttp_room_clear_disconnected(int h, int hasNow, double nowMs);

// ---- lifecycle / state ------------------------------------------------------

int ttp_room_transition_to(int h, const char* stateName);  // 1 if accepted
const char* ttp_room_state(int h);                         // "lobby"|"countdown"|"playing"|"results"
// setActiveOrder(peerIndices): peerIdsJson is a JSON array of peer-id scalars.
void ttp_room_set_active_order(int h, const char* peerIdsJson);

// ---- liveness (pure predicates; never mutate, never emit) -------------------

void ttp_room_on_seen(int h, const char* peerIdJson, double nowMs);
int ttp_room_is_expired(int h, const char* peerIdJson, double nowMs);
const char* ttp_room_expired_peers_json(int h, double nowMs);  // JSON array of peer ids
int ttp_room_all_participants_disconnected(int h);
int ttp_room_has_late_joiners(int h);
int ttp_room_grace_tick(int h, double nowMs);

// ---- provider setters -------------------------------------------------------

void ttp_room_set_master(int h, const char* peerIdJson);
void ttp_room_set_liveness_enabled(int h, int enabled);

// ---- read accessors ---------------------------------------------------------

const char* ttp_room_host_json(int h);   // effective host (getter fallback chain)
int ttp_room_is_host(int h, const char* peerIdJson);
int ttp_room_size(int h);
int ttp_room_connected_count(int h);
const char* ttp_room_list_json(int h);   // roster sorted by joinedAt
int ttp_room_has(int h, const char* peerIdJson);
int ttp_room_is_disconnected(int h, const char* peerIdJson);
const char* ttp_room_get_json(int h, const char* peerIdJson);  // one record, or "null"

// Drain the emitted-event queue as a JSON array [{"type":...,"detail":{...}}, ...]
// in emission order, then empty it.
const char* ttp_room_events_json(int h);

// ---- statics ----------------------------------------------------------------

// RoomFlow.lowestFreeSlot(used, max): lowest free dense slot in [0,max), or -1.
// usedJson is a JSON array of slot values (never peer indices).
int ttp_room_lowest_free_slot(const char* usedJson, int max);

// {"contractVersion":N,"layer":"party"} — the adapter's sanity check.
const char* ttp_party_version(void);

#ifdef __cplusplus
}
#endif

#endif  // TTP_PARTY_H
