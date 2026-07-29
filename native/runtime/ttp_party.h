// ttp_party.h — the public C ABI of Tiny Track Party's native PARTY layer.
//
// Sibling of ttp_runtime.h (the sim ABI): a stable extern "C" surface wrapping
// the conformance-proven C++ party layer (native/libttp-party). This first slice
// exposes RoomFlow — the room state machine (roster identity/join order,
// presence, host election, liveness) — which the display's NativeRoomFlow adapter
// re-implements the kit's RoomFlow surface over.
//
// The transport stays on the host side BY DESIGN: sockets and RTCPeerConnection
// belong to the platform (in the browser they are JS's, and always will be —
// wasm cannot open either without proxying through JS anyway). This ABI carries
// DECISIONS, not bytes.
//
// Conventions are the shared ABI ones — see ttp_abi.h. Here the JSON scalars are
// peer indices, and the opaque caller data is the game fields (name, colorIndex,
// ...) which RoomFlow stores verbatim and never reads. Events drain through
// ttp_room_events_json; the adapter re-fires them to the kit's on(...) listeners.
#ifndef TTP_PARTY_H
#define TTP_PARTY_H

#include "ttp_abi.h"

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
TTP_ABI int ttp_room_create(const char* configJson);
TTP_ABI void ttp_room_dispose(int h);
TTP_ABI void ttp_room_reset(int h);

// ---- roster -----------------------------------------------------------------

// addPlayer: returns the resulting player record as canonical JSON (the kit-owned
// keys peerIndex/joinedAt/connected plus the caller's fields), or "null".
TTP_ABI const char* ttp_room_add_player(int h, const char* peerIdJson, const char* fieldsJsonOrNull);
TTP_ABI void ttp_room_remove_player(int h, const char* peerIdJson);
TTP_ABI int ttp_room_rekey(int h, const char* oldIdJson, const char* newIdJson);  // 1 on success
// Write one opaque game field onto a live record — the ABI equivalent of the JS
// kit's mutable-record write (`flow.get(p).ready = true`). Emits nothing, like
// the assignment it replaces; kit-owned keys are refused. 1 on success.
TTP_ABI int ttp_room_set_field(int h, const char* peerIdJson, const char* key, const char* valueJson);
TTP_ABI void ttp_room_mark_disconnected(int h, const char* peerIdJson);
TTP_ABI void ttp_room_mark_reconnected(int h, const char* peerIdJson);
// clearDisconnected(nowMs). hasNow=0 means the JS call with no argument.
TTP_ABI void ttp_room_clear_disconnected(int h, int hasNow, double nowMs);

// ---- lifecycle / state ------------------------------------------------------

TTP_ABI int ttp_room_transition_to(int h, const char* stateName);  // 1 if accepted
TTP_ABI const char* ttp_room_state(int h);                         // "lobby"|"countdown"|"playing"|"results"
// setActiveOrder(peerIndices): peerIdsJson is a JSON array of peer-id scalars.
TTP_ABI void ttp_room_set_active_order(int h, const char* peerIdsJson);
// syncActiveOrder against a LIVE RACE: every seat holding a car, plus every
// dropped seat (RoomFlow::syncActiveOrder). Takes a session handle rather than a
// list of ids for two reasons: no shell has to define the participant set the
// abandoned-race policy and the "joining" rows both read, and no car id is ever
// serialized out to a shell only to be handed straight back.
//
// sessionHandle 0 / unknown / disposed means "no cars" (the lobby), which leaves
// the dropped seats as the whole order — the same answer a shell with no session
// would produce. Emits nothing, exactly like ttp_room_set_active_order.
TTP_ABI void ttp_room_sync_active_order(int h, int sessionHandle);

// ---- liveness (pure predicates; never mutate, never emit) -------------------

TTP_ABI void ttp_room_on_seen(int h, const char* peerIdJson, double nowMs);
TTP_ABI int ttp_room_is_expired(int h, const char* peerIdJson, double nowMs);
TTP_ABI const char* ttp_room_expired_peers_json(int h, double nowMs);  // JSON array of peer ids
TTP_ABI int ttp_room_all_participants_disconnected(int h);
TTP_ABI int ttp_room_has_late_joiners(int h);
// The late joiners themselves — a JSON array of player records (same shape and
// order as ttp_room_list_json), i.e. the roster outside the active order. The
// list form of ttp_room_has_late_joiners, for a shell that renders them.
TTP_ABI const char* ttp_room_late_joiners_json(int h);
TTP_ABI int ttp_room_grace_tick(int h, double nowMs);

// ---- provider setters -------------------------------------------------------

TTP_ABI void ttp_room_set_master(int h, const char* peerIdJson);
TTP_ABI void ttp_room_set_liveness_enabled(int h, int enabled);

// ---- read accessors ---------------------------------------------------------

TTP_ABI const char* ttp_room_host_json(int h);   // effective host (getter fallback chain)
TTP_ABI int ttp_room_is_host(int h, const char* peerIdJson);
TTP_ABI int ttp_room_size(int h);
TTP_ABI int ttp_room_connected_count(int h);
TTP_ABI const char* ttp_room_list_json(int h);   // roster sorted by joinedAt
TTP_ABI int ttp_room_has(int h, const char* peerIdJson);
TTP_ABI int ttp_room_is_disconnected(int h, const char* peerIdJson);
TTP_ABI const char* ttp_room_get_json(int h, const char* peerIdJson);  // one record, or "null"

// Drain the emitted-event queue as a JSON array [{"type":...,"detail":{...}}, ...]
// in emission order, then empty it.
TTP_ABI const char* ttp_room_events_json(int h);

// =============================================================================
// RELAY FRAMING (ttp::framing — the pure surface of PartyConnection.js)
// =============================================================================
// Stateless: no handles. Each returns into its OWN static scratch buffer, valid
// until the next call to THAT function. The host still owns the socket; these
// answer "what bytes?" and "what does this mean?".

// Outbound encoders -> the JSON text to hand to ws.send() verbatim.
TTP_ABI const char* ttp_framing_encode_create(const char* clientId, double maxClients, const char* urlOrNull);
TTP_ABI const char* ttp_framing_encode_join(const char* clientId, const char* room);
TTP_ABI const char* ttp_framing_encode_send_to(const char* toJson, const char* dataJson);
TTP_ABI const char* ttp_framing_encode_broadcast(const char* dataJson);
TTP_ABI const char* ttp_framing_encode_set_state(const char* dataJson);
TTP_ABI const char* ttp_framing_encode_close_room(void);

// Inbound routing. Takes the RAW socket text (the host need not parse it) and
// returns {"route":"message"|"state"|"protocol", plus "from"/"data"/"type"/"msg"}.
// route "none" means the text was not a JSON object (the host drops it).
TTP_ABI const char* ttp_framing_classify(const char* frameText);

// Close-code decision -> {"stopReconnect":bool,"closeAttempt":N,"closeMax":N,
// "meta":{...}|null,"willReconnect":bool}. hasCode=0 models a close event with
// no code at all.
TTP_ABI const char* ttp_framing_close_outcome(int hasCode, double code, double attemptBefore,
                                      double maxAttempts, int shouldReconnectBefore);

// Reconnect backoff for attempt N, in ms.
TTP_ABI double ttp_framing_backoff_ms(double attempt);

// base + '/' + enc(room) + '?instance=' + enc(instance); base unchanged when
// instance is empty (the JS early return).
TTP_ABI const char* ttp_framing_pin_url(const char* base, const char* room, const char* instance);

// =============================================================================
// FASTLANE NETCODE (ttp::fastlane::Link — one handle per peer link)
// =============================================================================
// The reliability layer over the DataChannel: resend ring + TTL, implicit
// per-event seq, cumulative ack, receive dedup, RTT EWMA, packet classifier.
// The WebRTC handshake and all timer SCHEDULING stay with the host.
//
// Every op returns an outcome as canonical JSON:
//   {"sent":bool,            // a packet should be written to the channel
//    "packet":{...}|null,    // that packet (write it verbatim)
//    "applied":[ev,...],     // inbound events to surface, in apply order
//    "rtt":N|null,           // an RTT sample to report (already srtt/2)
//    "dropped":bool}         // enqueue only: true == JS 'dropped'

TTP_ABI int ttp_link_create(void);
TTP_ABI void ttp_link_dispose(int h);
// Mirror the channel's readyState: a closed channel makes writes no-ops that do
// NOT count toward stats.out (matching JS's swallowed send() throw).
TTP_ABI void ttp_link_set_channel_open(int h, int open);

TTP_ABI const char* ttp_link_enqueue(int h, const char* evJson, double nowMs);
TTP_ABI const char* ttp_link_send_tick(int h, double nowMs);
TTP_ABI const char* ttp_link_idle(int h, double nowMs);
// packetText is the RAW channel text; non-object input is ignored.
TTP_ABI const char* ttp_link_inbound(int h, const char* packetText, double nowMs);

// {"out":N,"received":N,"lastPsSeen":N} — the per-link packet counters.
TTP_ABI const char* ttp_link_stats_json(int h);

// ---- statics ----------------------------------------------------------------

// RoomFlow.lowestFreeSlot(used, max): lowest free dense slot in [0,max), or -1.
// usedJson is a JSON array of slot values (never peer indices).
TTP_ABI int ttp_room_lowest_free_slot(const char* usedJson, int max);

// {"contractVersion":N,"layer":"party"} — the adapter's sanity check.
TTP_ABI const char* ttp_party_version(void);

// The whole shared manifest as one JSON object: the wire vocabulary (MSG,
// FASTLANE_TYPES, ROOM_STATE), the relay/STUN URLs, MAX_PLAYERS, TOTAL_LAPS,
// COUNTDOWN_SECONDS, the STEER and LIVENESS blocks, and the car tables
// (CAR_COLORS / CAR_MODELS / CAR_NAMES / CAR_MODEL_YAW / CAR_STATS). Exactly
// ttp::protocol::manifest() (native/libttp-party/ttp/protocol.h), which is the
// 1:1 C++ mirror of public/shared/protocol.js.
//
// WHY THIS IS AN EXPORT AND NOT JUST A HEADER. Those numbers are the manifest
// the config rule exists to protect: nothing may re-declare one silently. A C++
// layer honours that by including protocol.h and the web shell by reading
// protocol.js, but a shell in a language that can do NEITHER (Kotlin over JNI is
// the case in front of us) had no third option, so its lobby would hand-copy the
// car list and its input path the tilt numbers — with nothing anywhere watching
// the copy. This is that third option. tests/config-drift.test.js pins what
// comes out of here to protocol.js; runtimetest/abi_check.cc pins it to the
// library on every leg.
//
// The web shell does NOT read this (protocol.js is the authored source and is
// already on its page), which is deliberate: this is the port surface, and a
// second consumer of it would be a second spelling of the same fact.
TTP_ABI const char* ttp_protocol_manifest_json(void);

#ifdef __cplusplus
}
#endif

#endif  // TTP_PARTY_H
