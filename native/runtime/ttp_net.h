/* ttp_net.h — the SESSION-POLICY half of the party C ABI: every room decision
 * the display owns that is not a socket, a timer, a storage key or a canvas.
 * Sibling of ttp_party.h (RoomFlow + relay framing + fastlane), ttp_ui.h (the
 * screens) and ttp_runtime.h (the sim), same conventions (ttp_abi.h), with no
 * exception.
 *
 * WHAT IS BEHIND IT. libttp-party/ttp/session.{h,cc} — the retained room
 * snapshot and its `players` projection, the four URLs a room's identity is
 * spelled into, the seat defaults and the room-full cap, what a drop and a LEAVE
 * mean in each phase, the SET_CAR / SET_READY guards, the phase-flip effects,
 * the self-heartbeat state machine, the cross-device seat claim and the
 * post-reload reconciliation. Pure functions of plain data, replayed step for
 * step against tests/fixtures/session-corpus.jsonl (recorded off
 * public/display/sessionModel.js while it was live) by partytest/
 * session_check.cc on every leg. This header is only how a SHELL reaches them —
 * and it reaches them AS THE CHOREOGRAPHY WALKS below: one entry point per
 * inbound trigger, sequencing the fine-grained rules against the live room in
 * C++. The one-rule spellings the walks superseded are gone from the ABI; the
 * corpus replays the rules directly in session_check.
 *
 * WHY THIS IS NOT ttp_party.h. ttp_party.h wraps the room MACHINE (RoomFlow
 * handles) and two stateless kits beside it (framing, fastlane). This layer is
 * the POLICY over that machine: what an inbound trigger means, in order.
 *
 * KEY ORDER IS NOT A CONTRACT, and this header used to claim otherwise — the
 * claim being that the retained LOBBY_UPDATE inside ttp_net_lobby_frame is the
 * message every phone parses, so its key order was shipped bytes. The frame
 * encoder canonicalizes, so the model order stopped at framing and never
 * reached a phone. Returned JSON is canonical, like every other ABI's.
 *
 * WHAT STAYS WITH THE SHELL, deliberately: the WebSocket and RTCPeerConnection,
 * sessionStorage, setInterval/setTimeout, the QR module bitmap (decision D3 —
 * the URL composition is shared, the bitmap is three platform one-liners), the
 * reconnect card's DOM, and the slot-0 bearer secret (no rules, just entropy).
 * The random pick's shuffle bag moved BEHIND THE ROOM (2026-07-31): the shell
 * seeds it once with page entropy and the walks own every draw.
 *
 * A rejoinToken IS AN INTEGER OR IT IS NOTHING. The normalizer inside the hello
 * walk takes a finite, integral, non-negative JSON NUMBER and refuses every
 * other shape, so absent and null are the same answer and a client spelling the
 * seat as a string silently claims nothing — see session.h.
 */
#ifndef TTP_NET_H
#define TTP_NET_H

#include "ttp_abi.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ---- the chooser ---------------------------------------------------------- */

/* The display-authoritative content the dumb controller renders from, carried
 * inside every room snapshot:
 *   {"cars":   [{"id","name","stats":{...}}, ...],   always (tiny; the
 *                                                    late-joiner picker needs it
 *                                                    mid-race)
 *    "colors": ["#rrggbb", ...],                     the livery palette
 *    "tracks": [{"id","name","cup",...,"svg"}, ...]} the reduced schematics,
 *                                                    LOBBY ONLY (the bulk)
 *
 * OPAQUE: this layer never looks inside it, which is what lets the conformance
 * corpus carry a synthetic one. Set once at boot for the same reason
 * ttp_ui_configure is — it is authored data that changes when the game ships,
 * not while it runs, and re-sending ~4 KB of it on every rename would be parse
 * for nothing. Returns 1 when the text parsed. A later call replaces it
 * wholesale; unset, the three keys simply do not appear. */
TTP_ABI int ttp_net_configure(const char* chooserJson);

/* ---- the retained room snapshot ------------------------------------------- */

/* THE ROOM'S ONE OUTBOUND MESSAGE — the retained host snapshot the relay
 * pushes live to every controller and replays right after `joined` — COMPOSED
 * AND FRAMED WITHOUT LEAVING C++. Hand over the two handles and the fields
 * only the game knows; get back the exact set_state frame text to put on the
 * socket.
 *
 *   roomHandle     a ttp_room_create handle — supplies the roster, the effective
 *                  host and the room phase
 *   sessionHandle  a ttp_session_begin handle, or 0 for no live race — supplies
 *                  every seat's inRace, read off the Game itself
 *   fieldsJson     {"paused":bool,"soundOn":bool} — the two LATCHES only the
 *                  game layer knows. Neither the PICK nor the STANDINGS BOARD
 *                  is among them: the frame reads both off the room handle
 *                  (see the stored pick section below and ttp_room.h), so a
 *                  `pick` or `standings` key passed here is dead.
 *                  tests/shell-parity.test.js pins this list across the shells.
 *   ->             {"data":{...the LOBBY_UPDATE...},"type":"set_state"}
 *
 * The snapshot composer + ttp_framing_encode_set_state are the two halves
 * this folds together; they used to reach each other THROUGH THE SHELL: C++
 * serialized the snapshot, JS parsed it, JS re-serialized it, C++ parsed it
 * back, and every shell owed the round trip. The roster went the same way —
 * pulled out of the room as JSON only to be handed straight back. Nothing about
 * a seat is serialized out now; the roster and each seat's inRace are read
 * through ttp_room.h. Measured in the browser at the 4-player cap: 169.6 us ->
 * 44.4 us per publish.
 *
 * WHAT MADE IT EXPENSIVE WAS NOT THE ROSTER. The snapshot is ~7 KB and ~5.9 KB
 * of that is the `tracks` chooser payload, which ttp_net_configure sets ONCE and
 * nothing here ever looks inside; the roster is ~431 bytes. The round trip was
 * re-parsing an immutable 6 KB blob on every rename and ready toggle. A
 * microbenchmark that builds its own snapshot has no chooser in it and will
 * under-read this by about 3x.
 *
 * The frame is canonical, exactly as ttp_framing_encode_set_state's is — the
 * snapshot's model key order never survived framing and never has. */
TTP_ABI const char* ttp_net_lobby_frame(int roomHandle, int sessionHandle,
                                        const char* fieldsJson);

/* ---- URLs ------------------------------------------------------------------ */

/* base + '/' + room, with the INSTANCE in the FRAGMENT so the relay-shard pin
 * never reaches a request log. The room code is not encoded (the relay's
 * alphabet needs no escaping and the phones already parse these bytes). NULL or
 * "" for no instance.
 *
 * `platform` is this shell's CouchPad `cpp` value ("web", "tvos", "androidtv");
 * the URL is the only place a display declares which box it is, so every shell
 * passes its own and none invents a value. NULL or "" declares nothing. */
TTP_ABI const char* ttp_net_join_url(const char* base, const char* room, const char* instance,
                                     const char* platform);

/* That URL with ?claim=<peerIndex> spliced in BEFORE the fragment, so the shard
 * pin survives — scanning it lands a fresh device on the room with the token
 * that reclaims this exact seat. */
TTP_ABI const char* ttp_net_claim_url(const char* url, double peerIndex);

/* The controller-URL template to register with the relay on room create; the
 * relay fills {room}/{instance} for anyone holding only the room code (native TV
 * shells via GET /room/:code, controllers in `joined`). Same `platform` the QR
 * carries — the contract requires the two to match.
 * Returns "" for REGISTER NONE — the relay accepts only absolute https
 * templates and rejects the whole create on an invalid one, so a plain-http
 * origin must send no template at all, which is a different thing from sending
 * an empty one. */
TTP_ABI const char* ttp_net_controller_url_template(const char* base, const char* platform);


/* ---- seats ----------------------------------------------------------------- */

/* The display-name cap, applied to a HELLO's `name` — trim, then cut to 16
 * UTF-16 code UNITS. Takes the RAW JSON value, not a string, because this is
 * untrusted peer input and JS stringifies rather than rejecting: a number, a
 * bool and an array all have a defined spelling, and a shell using its own
 * language's "describe" would clamp a different string than the phone sent.
 *
 * `public/shared/names.js` stays the AUTHORED source (both browser pages import
 * it, and the phone half is permanent JS). This is the mirror every native
 * shell reads instead of restating the arithmetic — the same relationship
 * protocol.h has with protocol.js, and `tests/name-cap.test.js` is the one
 * place that can see both. It shipped as a hand-copy in the tvOS shell with a
 * comment predicting that a third shell would type it a third time. */
TTP_ABI const char* ttp_net_clean_name(const char* valueJson);


/* The dropped-seat card payload, {peerIndex,name,colorIndex,url}. The DIFF over
 * this set is the UI model's (ttp_ui_reconnect_diff_json); the SET is here. */
TTP_ABI const char* ttp_net_reconnect_card_json(const char* seatJson, const char* url);

/* ---- controller messages --------------------------------------------------- */

/* The verdict on a GAME message (what a `game-message` effect hands the
 * coordinator): "start-race" | "series-next" | "set-sound" | "pause" |
 * "resume" | "return-to-lobby" | "control" | "none" — with the authorization
 * inside.
 * START_GAME must come from the host AND every other racer must be ready (the
 * same readiness gate the lobby's Start button shows); SERIES_NEXT and
 * SET_SOUND are host-only; pause/resume/new-game are any player's; CONTROL
 * needs a live race. A shell dispatches on the verdict and re-derives none of
 * the gates — the if-chain this replaces existed in two shells with the gates
 * spelled twice.
 *
 * "set-sound" carries the display's MUTE, which is one state with two
 * flippers: this message and whatever switch the platform's own chrome has.
 * A shell that drops the verdict leaves the host phone's Sound row showing a
 * setting it cannot change — see the `soundOn` field on the lobby frame.
 *
 * A shell MAY keep CONTROL on its own short-circuit ahead of this call (the
 * web does): CONTROL is the relay-fallback INPUT path, sensor-rate when the
 * fastlane is down, and adding a crossing there was measured and refuted —
 * the verdict exists for the button-press messages. */
TTP_ABI const char* ttp_net_controller_action(int roomHandle, int sessionHandle,
                                              const char* fromJson, const char* type);

/* ===========================================================================
 * THE CHOREOGRAPHY WALKS — one entry point per inbound trigger.
 * ===========================================================================
 *
 * The fine-grained rules used to be exported one by one, leaving the
 * sequencing to the shell — which is exactly where the first TV shell's launch
 * bugs lived: the same walk hand-written twice, once per platform. These entry
 * points are that walk, once. Each takes the ttp_room_create handle (and the session handle where a
 * step reads race state), performs every ROOM MUTATION internally through the
 * live machine, and answers an ORDERED effect list of platform ops:
 *
 *   {"effects":[{"op":"...", ...}, ...]}
 *
 * A shell walks the array in index order and performs each op against its
 * socket, timers, storage and callbacks. It may not reorder, batch or skip,
 * and an op it cannot perform is a missing capability that must THROW — the
 * same contract as ttp_race.h's lists, stated there at length.
 *
 * EVENTS STILL DRAIN FIRST. Room mutations queue rosterchange/hostchange/
 * playerleave on the handle as ever; a shell drains ttp_room_events_json (and
 * re-fires its listeners) BEFORE performing the effects, which reproduces the
 * old inline order (the announce a mutation used to fire mid-walk lands before
 * the walk's own trailing sends).
 *
 * PER-ROOM NET STATE lives behind the room handle: the room code, the shard
 * instance, the in-room flag and the self-heartbeat's in-flight pair. The
 * shell mirrors code/instance only to compose URLs and dial sockets, and only
 * ever writes its mirror while performing `save-room` / `forget-room`.
 *
 * The effect vocabulary (op -> payload -> what the shell does):
 *   clear-create-timer                       cancel the created/joined watchdog
 *   arm-create-watchdog {delayMs}            (re)arm it; on expiry call
 *                                            ttp_net_create_timeout_json
 *   join-room {room}                         relay join
 *   create-room {maxClients}                 relay create (+ the shell's own
 *                                            controller-URL template)
 *   pin-instance {room,instance}             pin the relay shard
 *   save-room {room,instance|null}           adopt + persist the room identity
 *   forget-room                              drop + unpersist it
 *   room-ready {room,instance|null}          the onRoomReady callback
 *   start-liveness                           arm the 1 Hz liveness interval
 *   reset-reconnect-count                    the connection's attempt counter
 *   connect-fresh                            tear down and dial a fresh room
 *   fail-attempt                             count a failed connect attempt
 *   reconnect                                force an immediate reconnect
 *   send-to {to,data}                        relay unicast, data verbatim
 *   publish                                  republish the retained snapshot
 *   announce                                 publish + the roster-changed
 *                                            callback (count + host)
 *   close-fastlane {peerIndex}               close that peer's RTC link
 *   show-reconnect {seat}                    raise the seat's reconnect card
 *                                            ({peerIndex,name,colorIndex}; the
 *                                            shell adds the claim URL — D3)
 *   clear-reconnect {peerIndex}              drop that seat's card
 *   rekey-player {oldId,newId}               the onPlayerRekey callback
 *   player-renamed {peerIndex,name}          the onPlayerRenamed callback
 *   welcome-item {peerIndex}                 relight the rejoiner's held ITEM
 *                                            (emitted only when the live race
 *                                            holds their car — the predicate
 *                                            the shell used to own)
 *   game-message                             hand the triggering message to the
 *                                            game layer (the shell still holds
 *                                            from/data — nothing re-crosses)
 *   race-abandoned                           the onRaceAbandoned callback
 *   track-change {trackId}                   the onTrackChange callback
 *
 * NO clear-standings. The results board is room-retained (ttp_room.h), so the
 * statechange walk drops it with a store and lets its own `publish` carry the
 * change — three shells each holding a mirror to null out is exactly what the
 * retained slot removed. The session PLAN still carries the flag: it is
 * session::StateChangePlan's rule and the frozen session corpus pins it. */

/* The walks' effect vocabulary, as a JSON array of op keys in a stable order —
 * the table above as data. A shell walks it at boot and asserts its performer
 * switch covers every op, so a missing arm is a startup failure instead of a
 * silently dropped step mid-party. abi_check pins every op a walk can emit to
 * this list. */
TTP_ABI const char* ttp_net_effect_ops_json(void);

/* Adopt a room identity restored from the shell's storage, before the first
 * dial — what makes the reopened socket JOIN instead of CREATE. */
TTP_ABI void ttp_net_restore_room(int roomHandle, const char* code, const char* instance);

/* Socket open: join-vs-create plus the created/joined watchdog. */
TTP_ABI const char* ttp_net_on_open_json(int roomHandle);

/* The watchdog expired. fail-attempt unless an answer landed meanwhile. */
TTP_ABI const char* ttp_net_create_timeout_json(int roomHandle);

/* A relay protocol frame: created / joined (post-reload reconciliation
 * included) / peer_joined / peer_left / error. */
TTP_ABI const char* ttp_net_on_protocol_json(int roomHandle, const char* type,
                                             const char* msgJson, double nowMs);

/* The socket closed. roomClosed is the close-outcome meta's flag (our own
 * close_room echoing back, or the relay tearing the room down): terminal for
 * the ROOM but not the display — forget it, expire every seat (close_room
 * sends no peer_lefts, so the old roster would haunt the fresh lobby), and
 * only then dial fresh. That order is load-bearing. The reconnect BACKOFF is
 * not here: it lives in the connection kit (PartyConnection), which stays
 * platform code by design. */
TTP_ABI const char* ttp_net_on_close_json(int roomHandle, int roomClosed);

/* A relay message. Routes slot-0 echoes (the heartbeat closes its loop here),
 * stamps liveness, and walks the peer switch: hello (cross-device claim,
 * seating, rename-vs-first-hello, welcome), leave, set_car, set_ready,
 * select_mode, ping (the PONG is composed here), default -> game-message.
 * `isSignal` is the shell's "the fastlane consumed this as an RTC signal" —
 * the walk then stops after the liveness stamp, exactly where the old shell
 * returned. `sessionHandle` supplies the seat's in-race answer (SET_CAR's
 * lock, the welcome-item predicate) off the live Game; 0 between races.
 * A random mode pick draws from the ROOM'S OWN shuffle bag (seeded once by
 * ttp_net_init_pick) and completes in this walk — no shell owns a draw
 * protocol. The pick itself is STORED STATE behind the room handle
 * (ttp_net_init_pick / ttp_net_pick_json below) — no walk takes it as an
 * argument and no shell mirrors it. */
TTP_ABI const char* ttp_net_on_peer_message_json(int roomHandle, int sessionHandle,
                                                 const char* fromJson, const char* msgJson,
                                                 int isSignal, double nowMs);


/* The game-layer track swap that keeps mode/cup as they are (a cup advancing,
 * a lobby re-draw). Same catalogue-membership and same-pick gates as the mode
 * pick, same store/publish/track-change tail. */
TTP_ABI const char* ttp_net_set_track_json(int roomHandle, const char* trackId);

/* ---- the stored pick -------------------------------------------------------
 * The lobby pick ({mode,cupId,randomRaces,trackId}) lives behind the room
 * handle: the walks above are its only writers, the lobby frame reads it on
 * every publish, and a shell that wants it (the start gate, the cup slot)
 * asks — it keeps no mirror, which is a copy two shells already carried.
 *
 * init_pick is the constructor rule that used to live in DisplayNet: a
 * default track preselects mode "track"; hasBag stamps whether this room has
 * a shuffle bag at all (a bagless test surface refuses random outright), and
 * bagSeed is the shell's page entropy — the ONE random thing a shell still
 * supplies for the pick machinery, handed over once. The bag itself (deck,
 * cursor, the walk-the-whole-catalogue rule) lives behind the room handle
 * and only walks draw from it. clear_pick is End party's fresh-room reset
 * (hasBag and the bag survive — the shell's capability did not change).
 * Fields answer with EXPLICIT nulls, exactly as the mirror spelled them. */
TTP_ABI void ttp_net_init_pick(int roomHandle, const char* defaultTrackIdOrNull, int hasBag,
                               double bagSeed);
TTP_ABI void ttp_net_clear_pick(int roomHandle);
TTP_ABI const char* ttp_net_pick_json(int roomHandle);

/* The 1 Hz liveness tick: the self-heartbeat state machine (in-flight pair
 * internal — it also resets under created/joined, BEFORE the shell's timer
 * guard can matter, so a heartbeat left in flight by a dropped socket cannot
 * survive into the fresh connection), then on a sweep the expiry drops, the
 * active-order re-sync and the abandoned-race deadline, in that order on the
 * one clock reading.
 *
 * TWO EDGES A NEW SHELL HITS. The sweep is GATED on the heartbeat: a shell
 * that polls this without wiring the relay's `_heartbeat` echo back through
 * the message walk reads its own socket as dead and silently stops expiring
 * seats. And the walk always re-syncs the active order off sessionHandle —
 * 0 WIPES the participant set (the sync is the set's definition, not a
 * refinement), so a room with no live race never answers "every participant
 * is gone", which is exactly what the abandoned-race policy wants. */
TTP_ABI const char* ttp_net_liveness_json(int roomHandle, int sessionHandle, double nowMs);

/* Proof of life outside the message path (fastlane input): stamp, and lift a
 * dropped seat back to connected — the SINGLE writer that lifts disconnection;
 * ttp_net_on_peer_message_json runs this same walk internally. */
TTP_ABI const char* ttp_net_on_seen_json(int roomHandle, const char* peerIdJson, double nowMs);

/* The drained hostchange event's body, taking the event's own hostPeerIndex:
 * clear the promoted host's ready flag (their footer button is "Start race",
 * so it could never be cleared — and it would keep their car pick locked
 * forever), then announce. */
TTP_ABI const char* ttp_net_host_change_apply_json(int roomHandle, const char* hostPeerIdJson);

/* The drained statechange event's body: restamp connected seats on a race
 * start (never a blanket clear-disconnected — it would orphan a grace-pending
 * seat's QR), free disconnected seats on LOBBY, drop the room's retained
 * standings board, publish. Only the publish is a shell's to perform. */
TTP_ABI const char* ttp_net_state_change_apply_json(int roomHandle, const char* to,
                                                    double nowMs);

#ifdef __cplusplus
}
#endif

#endif /* TTP_NET_H */
