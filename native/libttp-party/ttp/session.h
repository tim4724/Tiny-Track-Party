// session — the display's ROOM decisions, in C++.
//
// This is public/display/sessionModel.js, ported. Everything DisplayNet decides
// about a room that is not a socket, a timer, a storage key or a canvas: the
// retained room snapshot (the phone's only source of truth), the `players`
// projection inside it, the four URLs a room's identity is spelled into, what a
// new seat starts as, what a drop or a LEAVE means in each room state, which car
// picks and ready toggles are refused, what a phase flip implies, the
// self-heartbeat state machine, the cross-device seat claim, and the post-reload
// reconciliation against the relay's peer list.
//
// WHY IT LIVES IN libttp-party. It is the layer directly above RoomFlow and it
// speaks that layer's vocabulary (room states, peer indices, the relay's wire
// types), so it belongs beside room_flow.cc rather than in libttp-runtime, which
// deliberately has no edge on the party layer. It holds NO RoomFlow handle: every
// function here is pure over plain data, and the shell performs the roster
// mutations the answers ask for. That is what keeps the corpus replayable with no
// room machine at all, and it is why this file adds no link edge in either
// direction.
//
// WHAT IS DELIBERATELY NOT HERE. The transport (sockets, RTCPeerConnection,
// storage, timers, the QR bitmap, the reconnect card's DOM) and identity
// generation (no rules, just entropy). The host's MODE PICK lived in the shell
// for a while ("needs a catalogue and a shuffle bag") — the catalogue turned out
// to be the chooser payload already configured into ttp_net, so only the BAG
// stays page-side and the pick's rules live in the walk layer (ttp_net.cc's
// select-mode walk), still above this file: they read the chooser, which this
// layer keeps opaque.
//
// STRINGS ARE KEYS, NOT COPY (decision D4). The default seat name comes out as
// {nameKey:"player_n", nameArg:N}; no shell is ever handed the sentence.
//
// CONFORMANCE. tests/fixtures/session-corpus.jsonl was recorded off the live
// public/display/sessionModel.js, which makes it JS-RECORDED cross-implementation
// evidence: class 1 in tests/fixtures/traces/README.md, the only class that can
// settle a parity question. native/partytest/session_check.cc replays every step
// of it through this header on all four legs. A disagreement is a bug HERE, never
// in the corpus. There is no --record mode on purpose.
#pragma once

#include <string>
#include <vector>

#include "ttp/canonical.h"  // ttp::Value

namespace ttp {
namespace session {

// ---- room states ------------------------------------------------------------
// The four spellings protocol.h names, plus OTHER for anything else. OTHER is
// load-bearing rather than defensive: every rule below tests a state for
// EQUALITY (roomState === LOBBY, or COUNTDOWN||PLAYING), never for "not a race",
// so a phase neither side names must fall through the same way the JS does.
enum class RoomState { LOBBY, COUNTDOWN, PLAYING, RESULTS, OTHER };
RoomState room_state_of(const std::string& name);

// ---- the retained room snapshot ---------------------------------------------

// The `players` projection every phone matches itself against: the room's roster
// composed with the GAME's answer to "does this seat hold a car in the live
// race", which is what lets a (re)joining phone route itself (true = drop back
// into the race, false mid-race = wait for the next one).
//
// `roster` is the array RoomFlow hands over and `inRace` a PARALLEL array of
// flags — values, not a callback, because a callback is a platform affordance.
// A field absent from a roster record stays absent from the row (JS reads
// `undefined` and JSON.stringify drops the key); `ready` and `inRace` are always
// present, coerced.
Value roster_rows(const Value& roster, const Value& inRace);

// The room's single outbound message (LOBBY_UPDATE over the relay's set_state).
// The relay retains it, pushes it live to every controller and replays it right
// after `joined`, so a (re)joining phone recovers its whole state — identity,
// roster, selection, results and the chooser content — from the replay alone.
// There is no per-phone WELCOME.
//
// `input` carries the room's live fields; `chooser` is the display-authoritative
// content the dumb controller renders from and is OPAQUE here — this layer never
// looks inside it, which is what lets the corpus carry a synthetic one. Its
// `tracks` are LOBBY-ONLY: they are the bulk of the blob, the picker is only
// shown there, and the whole snapshot must fit the relay's 16 KiB cap.
//
// KEY ORDER IS NOT A CONTRACT, and this header used to say it was the wire's.
// The only shipping caller (runtime/ttp_net.cc's ttp_net_lobby_frame) frames
// this answer before it goes anywhere, and the frame encoder canonicalizes, so
// the composed order has never reached a phone. Emit it with whatever the
// caller emits everything else with.
Value lobby_snapshot(const Value& input, const Value& chooser);

// ---- the display-name cap ---------------------------------------------------

// The one wire limit that is not the relay's: trim, then cut to NAME_MAX UTF-16
// code UNITS. `public/shared/names.js` is the authored source and stays so (both
// browser pages import it, and the phone half is permanent JS); this is the
// MIRROR every native shell reads instead of restating the arithmetic, exactly
// as protocol.h mirrors protocol.js. `tests/name-cap.test.js` is the drift gate
// that can see both.
//
// THE CUT IS BY UTF-16 CODE UNIT and therefore halves a trailing emoji. That is
// pinned CURRENT behaviour, not desired behaviour — `tests/wire-compat.test.js`
// drives the real producer and asserts what the orphaned surrogate becomes on
// the display. Cutting by code POINT here would be a silent wire change.
//
// The input is taken as JSON so a non-string survives the trip: this runs on
// whatever a peer put in a HELLO, and JS stringifies rather than rejecting.
// null/undefined answer "".
// Spelled NAME_MAX_UNITS, not NAME_MAX: <sys/syslimits.h> defines NAME_MAX as a
// MACRO, so the plain name does not survive a namespace on any Apple or Linux
// build. The "_UNITS" also says what it counts.
inline constexpr int NAME_MAX_UNITS = 16;
std::string clean_name_json(const std::string& valueJson);

// ---- URLs -------------------------------------------------------------------

// The join URL on the QR and the lobby ticket. The INSTANCE rides the FRAGMENT
// on purpose: it pins the relay shard without ever appearing in a request log.
// The room code is NOT encoded — the relay mints it from an alphabet that needs
// no escaping, and encoding it would change bytes the phones already parse.
// An empty instance is the JS falsy case: no fragment at all.
//
// `platform` spells which box this display is into the URL as `?cpp=` (CouchPad
// CONTRACT §6), and the URL is the ONLY place a display declares itself — so the
// QR, the registered template and the launcher's rejoin card all read it from the
// same string. The vocabulary is FIXED at "web", "tvos" and "androidtv" and the
// launcher owns the wording, so a shell passes its own and never invents one; an
// unknown value degrades to a card with no device name, and empty declares
// nothing. It arrives as a string rather than an enum because every shell reaches
// this through the C ABI, where a C++ constant is out of reach anyway.
std::string join_url(const std::string& base, const std::string& room,
                     const std::string& instance, const std::string& platform);

// The per-seat reconnect QR: the join URL with ?claim=<peerIndex> spliced in
// BEFORE the fragment, so the shard pin survives. Get this order wrong and the
// claim lands on a relay shard that has never heard of the room.
std::string claim_url(const std::string& url, double peerIndex);

// The controller-URL template registered with the relay on room create. The
// relay fills {room}/{instance} and hands the result to anyone holding only the
// room code — native TV shells via GET /room/:code, controllers in `joined` — so
// a code-only join can resolve which page to load. Same shape as join_url,
// `platform` included: the contract requires the template to match what a scanned
// QR produces, and it is what carries `cpp` to a typed-code or nearby join.
//
// Returns false for "register NO template". The relay accepts only absolute
// https templates and REJECTS THE WHOLE CREATE on an invalid one, so a plain-http
// origin (local dev, E2E) must send none; that is a different thing from sending
// an empty string, which is why this is not a std::string return.
bool controller_url_template(const std::string& base, const std::string& platform,
                             std::string* out);

// ---- the rejoinToken normalizer ---------------------------------------------
// THE RULE, and every other mention of rejoinToken points here: THE TOKEN IS AN
// INTEGER OR IT IS NOTHING. A JSON number that is finite, integral and >= 0
// claims; every other shape — string, bool, array, object, null — is nothing, so
// ABSENT AND NULL ARE THE SAME ANSWER and a client that sends the seat as a
// STRING silently fails to claim. `v` is the raw JSON value, or nullptr for an
// absent key; returns false for "no index".
//
// This layer type-checks untrusted phone input rather than coercing it (as
// set_car_decision does), and the shipped controller's deriveClaim
// (public/controller/Net.js) already sends an integer or null, so nothing a real
// phone can send changed answer when the coercion went. What went with it: this
// used to be JS `Number(value)`, under which a JSON null read as 0 and therefore
// EVERY ordinary HELLO was a claim on seat 0 — harmless only because seat 0 is
// the DISPLAY'S OWN slot and claim_plan's `hasOld` always missed it. That
// booby-trap is now gone rather than documented.
bool norm_index(const Value* v, double* out);

// ---- seats ------------------------------------------------------------------

// What a brand-new seat starts as. The car model defaults to the LIVERY slot so
// everyone starts on a distinct car; the player can change it in the lobby
// (SET_CAR), while the colour stays fixed for the room's life. The name is a KEY
// plus its number — 'Player 3' is copy, and copy belongs in the shell.
struct SeatDefaults {
  const char* nameKey = "player_n";
  double nameArg = 1;
  double colorIndex = 0;
  double carIndex = 0;
  bool ready = false;
};
SeatDefaults seat_defaults(double colorIndex);

// The composed default name, "Player N" — what actually gets STORED on the seat
// record and therefore rides the retained snapshot to every phone. This is not a
// breach of decision D4, and the distinction is worth keeping straight: D4
// governs what an ABI ANSWERS a shell (keys, so each platform fills from its own
// copy table), while this string is ROSTER DATA the wire carries to phones that
// have no table of their own — one spelling, or two shells' rooms would name the
// same seat differently. seat_defaults keeps answering the key.
std::string seat_name(const SeatDefaults& d);

// peer_joined, or a HELLO from someone we never seated. `colorIndex` is
// RoomFlow::lowestFreeSlot's answer, passed in resolved so this stays a
// composition rather than a second implementation of the slot rule.
//
// A full room REFUSES the seat and does NOT stamp it — the relay let them onto
// the socket, but there is no chair. An EXISTING seat is a same-device
// reconnect: the relay keys slots by clientId, so a returning phone lands back
// on its old index and only needs its liveness clock restarted.
struct AddPeerPlan {
  bool hasSeat = false;   // false = seat nobody (full room, or already seated)
  SeatDefaults seat;
  bool stamp = false;     // record proof of life for this peer
};
AddPeerPlan add_peer_plan(bool has, double size, double maxPlayers, double colorIndex);

// A socket close (peer_left). In the LOBBY a drop is forgiving — free the seat
// outright, the lobby's own join QR covers coming back. Mid-game keep the seat
// AND the player's car running, so the camera stays on it and a quick reconnect
// resumes driving, and offer a reconnect QR for that exact seat.
enum class PresenceAction { FREE, DROP };
PresenceAction presence_action(RoomState state);

// An intentional LEAVE (back-out). Mid-race this is a DROP, not a free: one
// accidental back-swipe must not forfeit a car, so the seat holds its reconnect
// QR through the usual grace window. Anywhere else the seat goes at once.
enum class LeaveAction { EXPIRE, DROP };
LeaveAction leave_action(RoomState state);

// The dropped-seat card payload — {peerIndex, name, colorIndex, url}. Held for
// the WHOLE race (no give-up timer) until the player returns or the room comes
// back to the lobby. The DIFF over this set is the UI model's (reconnectDiff);
// the SET is this layer's, which is one feature split down the middle and worth
// knowing about.
Value reconnect_card(const Value& seat, const std::string& url);

// ---- controller messages -----------------------------------------------------

// Where an inbound relay message goes. Slot 0 is US: the only thing that can
// arrive from it is our own relayed echo, which is how the self-heartbeat closes
// its loop, and anything else from that slot is not a peer talking.
enum class InboundRoute { PEER, SELF_HEARTBEAT, SELF_IGNORE };
InboundRoute inbound_route(double from, const std::string& type);

// The routing table for a peer's message. Everything this layer does not name is
// the game layer's (GAME — START_GAME, RETURN_TO_LOBBY, controls...).
enum class MessageAction { HELLO, LEAVE, SET_CAR, SET_READY, SELECT_MODE, PING, GAME };
MessageAction message_action(const std::string& type);

// SET_CAR — the lobby car-model pick. Car and colour are independent and
// duplicates are allowed, so there is no uniqueness check; four conjoined rules
// instead, and each one earns its place:
//   * a READY seat is locked, because ready survives race -> lobby and the pick
//     behind a standing ready flag must not shift (un-ready first);
//   * a RACER is locked to their car until the room is back in the lobby, while
//     a late joiner with no car may pick freely mid-race — their choice has to
//     stick for the next race;
//   * the index must be an INTEGER and IN RANGE, because this is untrusted input
//     from a phone. `carIndex` is therefore the raw JSON value: the string "1"
//     and the boolean true are both refused, exactly as Number.isInteger refuses
//     them.
bool set_car_decision(bool ready, RoomState state, bool inRace,
                      const Value* carIndex, double carCount);

// SET_READY — the non-host readiness toggle. The host starts the race instead of
// readying up, so their own toggle is refused; readiness is a lobby concept; and
// a redundant toggle is suppressed, because every accepted one republishes the
// snapshot to the whole room.
bool set_ready_decision(bool isHost, RoomState state, bool ready, bool current);

// ---- room-state transitions ---------------------------------------------------

// What a phase flip means, beyond the flip itself.
//
// restampConnected: race start re-stamps every CONNECTED seat's liveness, so
//   silence accumulated in the lobby (where expiries are gated off) is not
//   charged against the first countdown tick — a phone whose ping was throttled
//   past the timeout before the host hit Start would otherwise be dropped one
//   tick in. The window must run from race start. Deliberately NOT a blanket
//   clear-disconnected: flipping a grace-pending seat back to connected here
//   would orphan its reconnect QR.
// freeDisconnected: back in the lobby, the race that reserved dropped seats is
//   over, so reclaim any that never came back.
// clearStandings: a fresh race and the lobby both start with no results board.
// publish: ALWAYS. The retained snapshot carries roomState, and a replay to a
//   (re)joining phone must never hand it a stale phase.
struct StateChangePlan {
  bool restampConnected = false;
  bool freeDisconnected = false;
  bool clearStandings = false;
  bool publish = true;
};
StateChangePlan state_change_plan(RoomState to);

// Host promotion. A promoted host has no ready toggle (their footer button is
// "Start race"), so a ready flag left over from before the promotion could never
// be cleared — and it would keep their car pick locked forever, since SET_CAR
// refuses ready seats. Drop it on promotion.
struct HostChangePlan {
  bool clearReady = true;
  bool publish = true;
};
HostChangePlan host_change_plan();

// ---- liveness ----------------------------------------------------------------

// The display's own-socket canary, once per tick.
//
// Overdue is measured with an IN-FLIGHT FLAG rather than an echo AGE, and that is
// the whole point: a throttled background tab's ticks may run minutes apart, and
// an age test would read its own starvation as a dead link and reconnect a
// perfectly healthy socket. With a flag, the only way to be overdue is to have
// sent one and not had it back.
//
//   IDLE       not in a room — do nothing at all
//   RECONNECT  no echo inside the window: the relay cannot reach us, so force a
//              reconnect now instead of waiting for TCP. The tick STOPS here
//              (sweep false) — a link being torn down has no business expiring
//              seats.
//   SEND       nothing in flight: relay a heartbeat to our own slot.
//   WAIT       one is in flight and still inside the window.
// `sweep` is the rest of the tick: apply RoomFlow's expiries as drops, re-sync
// the active order, then poll the abandoned-race deadline — IN THAT ORDER, on
// this one clock reading.
enum class HeartbeatAct { IDLE, RECONNECT, SEND, WAIT };
struct HeartbeatTick {
  HeartbeatAct act = HeartbeatAct::IDLE;
  bool hbPending = false;
  double hbSentAt = 0;
  bool sweep = false;
};
HeartbeatTick heartbeat_tick(bool inRoom, bool hbPending, double hbSentAt, double now);

// ---- claims + reconciliation ---------------------------------------------------

// A different DEVICE claims a dropped seat by carrying its old peerIndex as the
// HELLO rejoinToken (from the claim QR's ?claim=). The seat record is re-keyed
// from the old index onto this fresh connection, so the returning player resumes
// their livery, car, name and host slot. A same-device reconnect keeps its index
// and never reaches here.
//
// `restamp` is not decoration: the seat's carried last-seen stamp is from BEFORE
// the drop and is therefore already older than the timeout, so a reclaimed seat
// would expire again on the very next tick without it. It is exactly the sort of
// detail a reimplementation loses, which is why it is an explicit command.
//
// `rejoinToken` is nullptr for an absent key, which claims nothing — as does any
// token that is not a non-negative integer. See norm_index.
struct ClaimPlan {
  bool claim = false;
  double oldId = 0;
  bool restamp = false;
};
ClaimPlan claim_plan(double fromId, const Value* rejoinToken, bool hasOld,
                     bool oldDisconnected);

// Post-reload reconciliation, against the peer list the relay hands back in
// `joined`. Seats the relay no longer knows are expired; peers it knows that we
// do not are seated with placeholder identities (each phone re-HELLOs when it
// sees the display return, restoring its name). Slot 0 is us and is never a
// seat. Duplicates in the relay's list collapse — the second sighting would find
// the seat already taken.
//
// The caller then publishes: this fresh flow is now the authority, so the live
// push clears every phone's reconnect overlay and the next joiner is not
// replayed the roster from before the reload.
struct ResyncPlan {
  std::vector<double> expire;
  std::vector<double> add;
  bool publish = true;
};
ResyncPlan resync_plan(const std::vector<double>& rosterIds,
                       const std::vector<double>& relayPeers);

// ---- wire spellings ----------------------------------------------------------
// The key each enum answers with, for an ABI or a corpus line.
const char* key(PresenceAction a);
const char* key(LeaveAction a);
const char* key(InboundRoute r);
const char* key(MessageAction a);
const char* key(HeartbeatAct a);

}  // namespace session
}  // namespace ttp
