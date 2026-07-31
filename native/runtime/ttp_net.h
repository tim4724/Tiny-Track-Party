/* ttp_net.h — the SESSION-POLICY half of the party C ABI: every room decision
 * the display owns that is not a socket, a timer, a storage key or a canvas.
 * Sibling of ttp_party.h (RoomFlow + relay framing + fastlane), ttp_ui.h (the
 * screens) and ttp_runtime.h (the sim), same conventions (ttp_abi.h) except for
 * the one stated below.
 *
 * WHAT IS BEHIND IT. libttp-party/ttp/session.{h,cc} — the retained room
 * snapshot and its `players` projection, the four URLs a room's identity is
 * spelled into, the seat defaults and the room-full cap, what a drop and a LEAVE
 * mean in each phase, the SET_CAR / SET_READY guards, the phase-flip effects,
 * the self-heartbeat state machine, the cross-device seat claim and the
 * post-reload reconciliation. Pure functions of plain data, replayed step for
 * step against tests/fixtures/session-corpus.jsonl (recorded off
 * public/display/sessionModel.js while it was live) by partytest/
 * session_check.cc on every leg. This header is only how a SHELL reaches them.
 *
 * WHY THIS IS NOT ttp_party.h. ttp_party.h wraps a STATEFUL machine (RoomFlow
 * handles) and two stateless helpers beside it. This layer holds no handle and
 * never mutates a roster: it answers what to DO, and the shell does it against
 * whichever RoomFlow handle it owns. Keeping the two apart is what lets the
 * session corpus replay with no room machine at all.
 *
 * THE ONE DEVIATION FROM ttp_abi.h, and it is ttp_ui.h's. Returned JSON here is
 * NOT canonical: keys come out in the MODEL'S OWN order. That matters for
 * exactly one answer and it matters a lot — ttp_net_lobby_snapshot_json IS the
 * message the relay retains and every phone parses, and sorting its keys would
 * silently re-spell bytes that have shipped since the JS wrote them.
 *
 * WHAT STAYS WITH THE SHELL, deliberately: the WebSocket and RTCPeerConnection,
 * sessionStorage, setInterval/setTimeout, the QR module bitmap (decision D3 —
 * the URL composition is shared, the bitmap is three platform one-liners), the
 * reconnect card's DOM, the slot-0 bearer secret (no rules, just entropy), and
 * the random pick's SHUFFLE BAG (page RNG, not room state — the walks below ask
 * for a draw rather than owning one).
 *
 * NULL IS NOT ZERO, and ABSENT IS NOT NULL. The rejoinToken normalizer turns on
 * that difference: JS Number(null) is 0 while Number(undefined) is NaN, so a
 * HELLO carrying an explicit null claims seat 0 while one carrying no token at
 * all claims nothing. Pass NULL or "" for an absent value; pass "null" for an
 * explicit JSON null. This is a FROZEN quirk, not a rough edge — see session.h.
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

/* The `players` projection every phone matches itself against.
 *   roster  the array RoomFlow hands over
 *   inRace  a PARALLEL array of flags — the GAME's answer to "does this seat
 *           hold a car in the live race" — as values, not a callback
 *   ->      [{"peerIndex","name","colorIndex","carIndex","connected","ready",
 *             "inRace"}, ...]
 * A field absent from a roster record stays absent from the row; `ready` and
 * `inRace` are always present and coerced. */
TTP_ABI const char* ttp_net_roster_rows_json(const char* rosterJson, const char* inRaceJson);

/* The room's single outbound message — the retained host snapshot the relay
 * pushes live to every controller and replays right after `joined`, so a
 * (re)joining phone recovers its whole state from the replay alone. There is no
 * per-phone WELCOME.
 *   {"hostPeerIndex":id|null,"roomState":str,"paused":bool,
 *    "roster":[...],"inRace":[bool,...],
 *    "mode":str|null,"cupId":str|null,"trackId":str|null,"standings":obj|null}
 *   -> the LOBBY_UPDATE object, chooser content included (from
 *      ttp_net_configure), with `tracks` present only in the lobby.
 * Emitted with ordered_stringify. See the deviation note above — and note that
 * the order stops at this boundary: whatever frames this for the wire
 * canonicalizes it. */
TTP_ABI const char* ttp_net_lobby_snapshot_json(const char* inputJson);

/* THE SAME SNAPSHOT, COMPOSED AND FRAMED WITHOUT LEAVING C++, and the whole
 * point is what the shell no longer carries. Hand over the two handles and the
 * fields only the game knows; get back the exact set_state frame text to put on
 * the socket.
 *
 *   roomHandle     a ttp_room_create handle — supplies the roster, the effective
 *                  host and the room phase
 *   sessionHandle  a ttp_session_begin handle, or 0 for no live race — supplies
 *                  every seat's inRace, read off the Game itself
 *   fieldsJson     {"paused":bool,"mode":str|null,"cupId":str|null,
 *                   "randomRaces":num,"trackId":str|null,"standings":obj|null}
 *   ->             {"data":{...the LOBBY_UPDATE...},"type":"set_state"}
 *
 * ttp_net_lobby_snapshot_json + ttp_framing_encode_set_state are the two halves
 * this replaces, and they used to reach each other THROUGH THE SHELL: C++
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
 * "" for no instance. */
TTP_ABI const char* ttp_net_join_url(const char* base, const char* room, const char* instance);

/* That URL with ?claim=<peerIndex> spliced in BEFORE the fragment, so the shard
 * pin survives — scanning it lands a fresh device on the room with the token
 * that reclaims this exact seat. */
TTP_ABI const char* ttp_net_claim_url(const char* url, double peerIndex);

/* The controller-URL template to register with the relay on room create; the
 * relay fills {room}/{instance} for anyone holding only the room code (native TV
 * shells via GET /room/:code, controllers in `joined`).
 * Returns "" for REGISTER NONE — the relay accepts only absolute https
 * templates and rejects the whole create on an invalid one, so a plain-http
 * origin must send no template at all, which is a different thing from sending
 * an empty one. */
TTP_ABI const char* ttp_net_controller_url_template(const char* base);

/* The HELLO's rejoinToken, normalized to a seat index: a JSON number, or null.
 * NULL/"" is JS `undefined` (an absent key) and "null" is an explicit null —
 * and they answer DIFFERENTLY. See the header note; this is frozen. */
TTP_ABI const char* ttp_net_norm_index_json(const char* valueJson);

/* ---- seats ----------------------------------------------------------------- */

/* What a brand-new seat starts as:
 *   -> {"nameKey":"player_n","nameArg":n,"colorIndex":n,"carIndex":n,"ready":false}
 * The car model defaults to the LIVERY slot so everyone starts on a distinct
 * car. The name is a KEY plus its number, never the composed sentence — the copy
 * table is the shell's, next to the element it fills. */
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

TTP_ABI const char* ttp_net_seat_defaults_json(double colorIndex);

/* peer_joined, or a HELLO from someone we never seated. `colorIndex` is
 * RoomFlow.lowestFreeSlot's answer, passed in resolved.
 *   -> {"seat": null | {seat defaults}, "stamp": bool}
 * A FULL room refuses the seat and does not stamp it. An EXISTING seat is a
 * same-device reconnect — no new seat, but its liveness clock restarts. */
TTP_ABI const char* ttp_net_add_peer_plan_json(int has, double size, double maxPlayers,
                                               double colorIndex);

/* A socket close: "free" in the lobby (the join QR covers coming back), "drop"
 * mid-game (keep the seat AND the car, offer a reconnect QR). */
TTP_ABI const char* ttp_net_presence_action(const char* roomState);

/* An intentional LEAVE: "drop" mid-race — one accidental back-swipe must not
 * forfeit a car — and "expire" anywhere else. */
TTP_ABI const char* ttp_net_leave_action(const char* roomState);

/* The dropped-seat card payload, {peerIndex,name,colorIndex,url}. The DIFF over
 * this set is the UI model's (ttp_ui_reconnect_diff_json); the SET is here. */
TTP_ABI const char* ttp_net_reconnect_card_json(const char* seatJson, const char* url);

/* ---- controller messages --------------------------------------------------- */

/* Where an inbound relay message goes: "peer", or — from slot 0, which is US —
 * "self-heartbeat" (our own relayed echo, how the canary closes its loop) or
 * "self-ignore". */
TTP_ABI const char* ttp_net_inbound_route(double from, const char* type);

/* The routing table for a peer's message: "hello" | "leave" | "set_car" |
 * "set_ready" | "select_mode" | "ping" | "game". Anything this layer does not
 * name is the game layer's. */
TTP_ABI const char* ttp_net_message_action(const char* type);

/* The verdict on a GAME message (what a `game-message` effect hands the
 * coordinator): "start-race" | "series-next" | "pause" | "resume" |
 * "return-to-lobby" | "control" | "none" — with the authorization inside.
 * START_GAME must come from the host AND every other racer must be ready (the
 * same ttp_ui_all_racers_ready gate the lobby button shows); SERIES_NEXT is
 * host-only; pause/resume/new-game are any player's; CONTROL needs a live
 * race. A shell dispatches on the verdict and re-derives none of the gates —
 * the if-chain this replaces existed in two shells with the gates spelled
 * twice.
 *
 * A shell MAY keep CONTROL on its own short-circuit ahead of this call (the
 * web does): CONTROL is the relay-fallback INPUT path, sensor-rate when the
 * fastlane is down, and adding a crossing there was measured and refuted —
 * the verdict exists for the button-press messages. */
TTP_ABI const char* ttp_net_controller_action(int roomHandle, int sessionHandle,
                                              const char* fromJson, const char* type);

/* SET_CAR: 1 to accept the pick. Four conjoined rules — a READY seat is locked
 * (ready survives race -> lobby, so the pick behind it must not shift), a RACER
 * is locked until the room is back in the lobby while a car-less late joiner may
 * pick freely mid-race, and the index must be an INTEGER IN RANGE. `carIndex` is
 * the RAW JSON value because this is untrusted phone input: "1" and true are
 * refused, not coerced. */
TTP_ABI int ttp_net_set_car(int ready, const char* roomState, int inRace,
                            const char* carIndexJson, double carCount);

/* SET_READY: 1 to accept the toggle. The host starts the race instead of
 * readying up; readiness is a lobby concept; and a redundant toggle is
 * suppressed, because every accepted one republishes to the whole room. */
TTP_ABI int ttp_net_set_ready(int isHost, const char* roomState, int ready, int current);

/* ---- room-state transitions ------------------------------------------------ */

/* What a phase flip means beyond the flip:
 *   -> {"restampConnected":bool,"freeDisconnected":bool,"clearStandings":bool,
 *       "publish":true}
 * restampConnected: race start re-stamps every CONNECTED seat, so lobby silence
 *   is not charged against the first countdown tick. Deliberately not a blanket
 *   clear-disconnected, which would orphan a grace-pending seat's reconnect QR.
 * publish is ALWAYS true: the retained snapshot carries roomState, and a replay
 *   to a (re)joining phone must never hand it a stale phase. */
TTP_ABI const char* ttp_net_state_change_json(const char* to);

/* Host promotion: {"clearReady":true,"publish":true}. A promoted host has no
 * ready toggle, so a leftover ready flag could never be cleared — and it would
 * keep their car pick locked forever. */
TTP_ABI const char* ttp_net_host_change_json(void);

/* ---- liveness -------------------------------------------------------------- */

/* The display's own-socket canary, once per tick.
 *   -> {"act":"idle"|"reconnect"|"send"|"wait","hbPending":bool,"hbSentAt":n,
 *       "sweep":bool}
 * Overdue is an IN-FLIGHT FLAG, not an echo AGE: a throttled background tab's
 * ticks may run minutes apart, and an age test would read its own starvation as
 * a dead link and reconnect a healthy socket.
 * `sweep` is the rest of the tick — apply RoomFlow's expiries as drops, re-sync
 * the active order, then poll the abandoned-race deadline, IN THAT ORDER, on the
 * one clock reading. "reconnect" clears it: a link being torn down has no
 * business expiring seats. */
TTP_ABI const char* ttp_net_heartbeat_tick_json(int inRoom, int hbPending, double hbSentAt,
                                                double now);

/* ---- claims + reconciliation ------------------------------------------------ */

/* The cross-device seat claim. `helloJson` is the whole HELLO message, because
 * an ABSENT rejoinToken and an explicit null answer differently and only the
 * message itself can tell them apart.
 *   -> {"claim":false} | {"claim":true,"oldId":n,"restamp":true}
 * `restamp` is not decoration: the reclaimed seat's carried last-seen stamp is
 * from BEFORE the drop and is already older than the timeout, so without it the
 * seat expires again on the very next tick. */
TTP_ABI const char* ttp_net_claim_plan_json(const char* helloJson, double fromId,
                                            int hasOld, int oldDisconnected);

/* Post-reload reconciliation against the peer list the relay hands back in
 * `joined`.
 *   -> {"expire":[id,...],"add":[id,...],"publish":true}
 * Seats the relay no longer knows are expired; peers it knows that we do not are
 * seated with placeholder identities. Slot 0 is us and is never a seat;
 * duplicates in the relay's list collapse. */
TTP_ABI const char* ttp_net_resync_plan_json(const char* rosterIdsJson,
                                             const char* relayPeersJson);

/* ===========================================================================
 * THE CHOREOGRAPHY WALKS — one entry point per inbound trigger.
 * ===========================================================================
 *
 * Everything above answers ONE rule and leaves the sequencing to the shell,
 * which is exactly where the first TV shell's launch bugs lived: the same walk
 * hand-written twice, once per platform. These entry points are that walk,
 * once. Each takes the ttp_room_create handle (and the session handle where a
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
 *   set-pick {mode,cupId,randomRaces,trackId} adopt the resolved lobby pick
 *   track-change {trackId}                   the onTrackChange callback
 *   clear-standings                          drop the mirrored results board
 *
 * `pickJson` is the shell's CURRENT pick, {"mode","cupId","randomRaces",
 * "trackId","hasBag"} — shell-held state because the game layer reads it
 * synchronously all day; the walks validate and answer `set-pick`, so the
 * shell mirror has a single writer. `hasBag` says whether a shuffle bag exists
 * at all (test surfaces run without one, and a bagless shell must refuse
 * random picks exactly as the old shell did). */

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
 * select_mode may answer {"effects":[],"needDraw":true}: the pick needs a
 * fresh draw, the bag is the shell's, so draw one and finish with
 * ttp_net_select_mode_draw_json. */
TTP_ABI const char* ttp_net_on_peer_message_json(int roomHandle, int sessionHandle,
                                                 const char* fromJson, const char* msgJson,
                                                 const char* pickJson, int isSignal,
                                                 double nowMs);

/* The second half of a needDraw round trip: the same select-mode rules, with
 * the drawn track id in hand. */
TTP_ABI const char* ttp_net_select_mode_draw_json(int roomHandle, const char* fromJson,
                                                  const char* msgJson, const char* pickJson,
                                                  const char* drawnTrackId);

/* The game-layer track swap that keeps mode/cup as they are (a cup advancing,
 * a lobby re-draw). Same catalogue-membership and same-pick gates as the mode
 * pick, same set-pick/publish/track-change tail. */
TTP_ABI const char* ttp_net_set_track_json(int roomHandle, const char* trackId,
                                           const char* pickJson);

/* The 1 Hz liveness tick: the self-heartbeat state machine (in-flight pair
 * internal — it also resets under created/joined, BEFORE the shell's timer
 * guard can matter, so a heartbeat left in flight by a dropped socket cannot
 * survive into the fresh connection), then on a sweep the expiry drops, the
 * active-order re-sync and the abandoned-race deadline, in that order on the
 * one clock reading. */
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
 * seat's QR), free disconnected seats on LOBBY, clear-standings, publish. */
TTP_ABI const char* ttp_net_state_change_apply_json(int roomHandle, const char* to,
                                                    double nowMs);

#ifdef __cplusplus
}
#endif

#endif /* TTP_NET_H */
