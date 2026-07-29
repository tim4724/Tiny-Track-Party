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
 * the host's MODE PICK (_applyMode/setTrack — a cup-series concern that needs a
 * catalogue and a shuffle bag).
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

#ifdef __cplusplus
}
#endif

#endif /* TTP_NET_H */
