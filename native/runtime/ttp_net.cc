// ttp_net.cc — the session-policy ABI over libttp-party's ttp::session.
//
// TWO SECTIONS, two charters. The first is MARSHALLING ONLY: not one room
// decision is taken there — every export parses its arguments, calls the rule
// in ttp/session.h and spells the answer back out. That split is what lets
// partytest/session_check.cc gate the RULES against
// tests/fixtures/session-corpus.jsonl while this layer is covered by
// runtimetest/abi_check.cc replaying the SAME corpus through the C boundary —
// the arrangement ttp_ui.cc and ttp_party.cc already have. A wrong key, a
// dropped null or an absent-vs-null confusion lives exactly here and is
// invisible to a check that calls C++ objects directly.
//
// The second section (THE CHOREOGRAPHY WALKS, at the bottom) is the layer that
// used to be the shell: the SEQUENCING of those rules against the live room,
// answered as ordered effect lists. It adds no rule of its own — the
// fine-grained exports above stay untouched (the frozen session corpus replays
// their JSON forms) and become the walks' internal vocabulary, called
// C++-to-C++. Its gate is abi_check's netWalksMatchMultiCallPath, which drives
// the same scenarios through the old multi-call path in the same run and
// asserts the mutations and effects agree.
//
// KEY ORDER IS OUTPUT for the snapshot: it is emitted with ordered_stringify so
// the bytes the relay retains are the ones the phones have always parsed. See
// ttp_net.h's deviation note.
#include "ttp_error.h"
#include "ttp_net.h"

#include <cmath>
#include <map>
#include <string>
#include <utility>
#include <vector>

#include "ttp/canonical.h"
#include "ttp/json_parse.h"
#include "ttp/json_read.h"
#include "ttp/relay_framing.h"
#include "ttp/session.h"
// The live room + the live race. The narrow Value accessors serve
// ttp_net_lobby_frame; the walks additionally take the machine itself through
// ttp_room_flow (the one sanctioned mutation path — see ttp_room.h) and read
// the live Game through ttp_session.h.
#include "ttp/game.h"
#include "ttp/protocol.h"
#include "ttp/room_flow.h"
#include "ttp_party.h"  // ttp_room_sync_active_order — the one participant-set rule
#include "ttp_live.h"
#include "ttp_room.h"
#include "ttp_session.h"
#include "ttp_ui.h"     // ttp_ui_all_racers_ready — the start gate, asked not re-spelled

using namespace ttp;
namespace ns = ttp::session;

namespace {

// The one piece of state in this ABI, and the header says why. Unset, its three
// keys simply do not appear in a snapshot.
Value g_chooser = Value::Obj();

// One scratch buffer per string-returning export rather than one shared: a
// shell reads the join URL and then the claim URL built from it on the same
// tick, and a single buffer would hand the second call's bytes to a caller still
// holding the first's pointer. ttp_abi.h's "valid until the next call" rule is
// per handle, and this ABI has none.
std::string g_bufJoin, g_bufClaimUrl, g_bufTemplate, g_bufCard, g_bufFrame, g_bufOps;

// The walks' effect vocabulary — every op an answer below can carry, in the
// order ttp_net.h documents them. A new pushOp spelling joins this table in
// the same commit; abi_check pins every emitted op to the export.
const char* const NET_EFFECT_OPS[] = {
    "clear-create-timer", "arm-create-watchdog", "join-room", "create-room",
    "pin-instance", "save-room", "forget-room", "room-ready", "start-liveness",
    "reset-reconnect-count", "connect-fresh", "fail-attempt", "reconnect",
    "send-to", "publish", "announce", "close-fastlane", "show-reconnect",
    "clear-reconnect", "rekey-player", "player-renamed", "welcome-item",
    "game-message", "race-abandoned", "track-change", "clear-standings"};

const char* put(std::string& buf, const Value& v) {
  ordered_stringify_into(v, buf);
  return buf.c_str();
}
const char* putStr(std::string& buf, std::string s) {
  buf = std::move(s);
  return buf.c_str();
}

// The ONE spelling of a stored pick — explicit nulls (strictEquals reads the
// fields; null is not absent), hasBag last. Every writer goes through this so
// a fifth pick field is one edit, not five.
Value makePick(Value mode, Value cupId, double randomRaces, Value trackId, Value hasBag) {
  if (mode.type == Value::UNDEF) mode = Value::Null();
  if (cupId.type == Value::UNDEF) cupId = Value::Null();
  if (trackId.type == Value::UNDEF) trackId = Value::Null();
  Value pick = Value::Obj();
  pick.set("mode", std::move(mode));
  pick.set("cupId", std::move(cupId));
  pick.set("randomRaces", Value::Num(randomRaces));
  pick.set("trackId", std::move(trackId));
  pick.set("hasBag", hasBag.type == Value::BOOL ? hasBag : Value::Bool(false));
  return pick;
}

// The stored hasBag — the shell's capability stamp, carried through every
// rewrite of the pick around it.
Value storedHasBag(int roomHandle) {
  const Value cur = ttp_room_pick_value(roomHandle);
  const Value* hb = cur.find("hasBag");
  return hb ? *hb : Value::Bool(false);
}

// The four reader-facing fields, defaults filled — what ttp_net_pick_json
// answers and what the lobby frame merges into its snapshot input.
void setPickFields(int roomHandle, Value& out) {
  const Value pick = ttp_room_pick_value(roomHandle);
  const auto field = [&](const char* k, Value dflt) {
    const Value* v = pick.find(k);
    out.set(k, v ? *v : std::move(dflt));
  };
  field("mode", Value::Null());
  field("cupId", Value::Null());
  field("randomRaces", Value::Num(0));
  field("trackId", Value::Null());
}




std::string strOr(const char* s) { return s ? std::string(s) : std::string(); }

ns::RoomState stateOf(const char* s) { return ns::room_state_of(strOr(s)); }


}  // namespace

// ---- the chooser -------------------------------------------------------------

const char* ttp_net_effect_ops_json(void) {
  Value a = Value::Arr();
  for (const char* op : NET_EFFECT_OPS) a.push(Value::Str(op));
  ordered_stringify_into(a, g_bufOps);
  return g_bufOps.c_str();
}

int ttp_net_configure(const char* chooserJson) {
  ttp::clear_error();
  if (!chooserJson || !*chooserJson) {
    g_chooser = Value::Obj();
    return 1;
  }
  bool ok = false;
  Value v = json::parse(chooserJson, &ok);
  if (!ok || v.type != Value::OBJ) {
    ttp::set_error("ttp_net_configure: the chooser must be a JSON object "
                   "(cars/colors/tracks), got " + ttp::error_excerpt(chooserJson));
    return 0;
  }
  g_chooser = std::move(v);
  return 1;
}

// ---- the retained room snapshot ----------------------------------------------

const char* ttp_net_lobby_frame(int roomHandle, int sessionHandle, const char* fieldsJson) {
  // The game-owned half — now only what the walks cannot know: the pause latch
  // and the standings board. The PICK is the stored one (ttp_room.h) — the
  // walks are its writers, so the frame reads it where it lives.
  Value input = json::parse_or(fieldsJson, Value::Obj());
  if (input.type != Value::OBJ) input = Value::Obj();
  setPickFields(roomHandle, input);
  // The room-owned half, read through the seam — the SAME four keys the shell
  // used to gather and hand back, so lobby_snapshot below is the untouched,
  // corpus-pinned rule and not a variant of it. The roster is built ONCE and
  // the flags are derived from that copy.
  Value roster = ttp_room_roster_value(roomHandle);
  input.set("inRace", ttp_room_in_race_flags(roster, sessionHandle));
  input.set("roster", std::move(roster));
  input.set("hostPeerIndex", ttp_room_host_value(roomHandle));
  input.set("roomState", Value::Str(ttp_room_state_name(roomHandle)));
  // Canonical, like every other frame encoder: g_bufFrame is framed output, not
  // an ABI answer, so it takes ttp_party.cc's spelling and not this file's.
  g_bufFrame = canonical_stringify(framing::encode_set_state(ns::lobby_snapshot(input, g_chooser)));
  return g_bufFrame.c_str();
}

// ---- URLs ---------------------------------------------------------------------

const char* ttp_net_join_url(const char* base, const char* room, const char* instance) {
  return putStr(g_bufJoin, ns::join_url(strOr(base), strOr(room), strOr(instance)));
}

const char* ttp_net_claim_url(const char* url, double peerIndex) {
  return putStr(g_bufClaimUrl, ns::claim_url(strOr(url), peerIndex));
}

const char* ttp_net_controller_url_template(const char* base) {
  std::string out;
  if (!ns::controller_url_template(strOr(base), &out)) out.clear();
  return putStr(g_bufTemplate, std::move(out));
}

// ---- seats --------------------------------------------------------------------

const char* ttp_net_clean_name(const char* valueJson) {
  static std::string out;
  out = ns::clean_name_json(valueJson ? valueJson : "null");
  return out.c_str();
}

const char* ttp_net_reconnect_card_json(const char* seatJson, const char* url) {
  return put(g_bufCard, ns::reconnect_card(json::parse_or(seatJson, Value::Obj()), strOr(url)));
}

// ---- controller messages ------------------------------------------------------

// protocol.h's MSG table, by NAME — the wire spellings live there alone.
static const std::string& msgType(const char* name) {
  for (const auto& kv : protocol::MSG)
    if (kv.first == name) return kv.second;
  static const std::string none;
  return none;
}

const char* ttp_net_controller_action(int roomHandle, int sessionHandle,
                                      const char* fromJson, const char* type) {
  const std::string t = strOr(type);
  const char* verdict = "none";
  if (t == msgType("CONTROL")) {
    if (ttp_session_engine(sessionHandle)) verdict = "control";
  } else if (t == msgType("PAUSE_GAME")) {
    verdict = "pause";
  } else if (t == msgType("RESUME_GAME")) {
    verdict = "resume";
  } else if (t == msgType("RETURN_TO_LOBBY")) {
    verdict = "return-to-lobby";
  } else if (t == msgType("START_GAME") || t == msgType("SERIES_NEXT")) {
    // Host-only, re-checked here so a stale or forged message cannot jump the
    // lobby; a start additionally needs every other racer ready (the same gate
    // that lights the host's button).
    Value from = json::parse_or(fromJson, Value::Null());
    const bool isHost = from.type != Value::NUL &&
        canonical_stringify(from) == canonical_stringify(ttp_room_host_value(roomHandle));
    if (isHost) {
      if (t == msgType("SERIES_NEXT")) {
        verdict = "series-next";
      } else {
        // The same readiness rule the lobby's Start button shows, asked of the
        // ui model directly over the live roster (ttp_live.h).
        const Value hostV = ttp_room_host_value(roomHandle);
        if (ttp::rt::ui::allRacersReady(ttp_live_roster_players(roomHandle, false),
                                        json::id_of<ttp::rt::ui::Id>(&hostV)))
          verdict = "start-race";
      }
    }
  }
  return verdict;
}

// ---- room-state transitions ----------------------------------------------------

// ---- liveness -------------------------------------------------------------------

// ---- claims + reconciliation ------------------------------------------------------

// ===========================================================================
// THE CHOREOGRAPHY WALKS (ttp_net.h's second section).
//
// Everything below SEQUENCES rules that already exist — the session-policy
// functions above, RoomFlow's mutators, the participant-set sync — and answers
// ordered effect lists. Each helper is one of the old shell's private methods
// (_seen, _dropSeat, _expireSeat, _addPeer, _claimReconnect), moved here so the
// walk is written once for three shells; the justification comments moved with
// them. No JSON crosses between these and the layers they call.
// ===========================================================================

namespace {

// Per-room net state: the room identity and the self-heartbeat's in-flight
// pair. Keyed by the room handle (created lazily, tiny, never reclaimed — a
// display opens one room per page and handles never recycle). The shell's
// code/instance mirror is written only by save-room/forget-room effects, so
// this map stays the single writer of the truth.
struct NetState {
  std::string roomCode;
  std::string instance;
  bool inRoom = false;
  bool hbPending = false;
  double hbSentAt = 0;
};
std::map<int, NetState> g_netStates;
NetState& netStateOf(int roomHandle) { return g_netStates[roomHandle]; }

// One scratch buffer per walk, the file's own rule (see the block above).
std::string g_bufOpen, g_bufCreateTimeout, g_bufProtocol, g_bufClose, g_bufPeerMsg,
    g_bufSelectDraw, g_bufSetTrack, g_bufLiveness, g_bufSeen, g_bufHostApply,
    g_bufStateApply, g_bufPick;

// The wire spelling of a MSG key, off the shared manifest — never a literal
// here, so the walk cannot drift from what protocol.js told the phone.
const char* msgOf(const char* key) {
  for (const auto& kv : protocol::MSG)
    if (kv.first == key) return kv.second.c_str();
  return "";
}

const Value kUndef;  // JS `undefined`, for absent-key comparisons
const Value& orUndef(const Value* v) { return v ? *v : kUndef; }

const Value* mfind(const Value& v, const char* key) {
  return v.type == Value::OBJ ? v.find(key) : nullptr;
}

PeerId peerIdOf(const Value* v) {
  if (!v) return PeerId::None();
  if (v->type == Value::NUM) return PeerId::Num(v->num);
  if (v->type == Value::STR) return PeerId::Str(v->str);
  return PeerId::None();
}

// JS === over the JSON value set: scalars by value, objects/arrays never (a
// wire value is a fresh parse and can share no reference with the catalogue).
bool strictEquals(const Value& a, const Value& b) {
  if (a.type != b.type) return false;
  switch (a.type) {
    case Value::UNDEF:
    case Value::NUL: return true;
    case Value::BOOL: return a.b == b.b;
    case Value::NUM: return a.num == b.num;  // NaN !== NaN via IEEE ==
    case Value::STR: return a.str == b.str;
    default: return false;
  }
}

const Value* fieldOf(const ttp::Player* p, const char* key) {
  if (!p) return nullptr;
  for (const auto& kv : p->fields)
    if (kv.first == key) return &kv.second;
  return nullptr;
}

Value effectOp(const char* op) {
  Value e = Value::Obj();
  e.set("op", Value::Str(op));
  return e;
}

void pushOp(Value& effects, const char* op) { effects.push(effectOp(op)); }

void pushPeerOp(Value& effects, const char* op, const PeerId& id) {
  Value e = effectOp(op);
  e.set("peerIndex", id.toValue());
  effects.push(std::move(e));
}

const char* answer(std::string& buf, Value effects) {
  Value out = Value::Obj();
  out.set("effects", std::move(effects));
  ordered_stringify_into(out, buf);
  return buf.c_str();
}

// ---- the old shell's private methods, one each -----------------------------

// _seen: record proof of life. Also lifts a dropped seat back to connected: a
// phone can go silent and resume WITHOUT its socket ever closing (locked
// screen, network blip), so presence must flip back here, not only on
// peer_joined. This is the single writer that lifts disconnection.
void seenWalk(RoomFlow* flow, const PeerId& id, double nowMs, Value& effects) {
  flow->onSeen(id, nowMs);  // no-op for unseated peers
  if (flow->isDisconnected(id)) {
    flow->markReconnected(id);  // emits rosterchange -> the shell announces
    pushPeerOp(effects, "clear-reconnect", id);
  }
}

// _dropSeat: mid-game drop (socket gone, liveness silence, or a mid-race
// LEAVE): keep the seat AND the car — the camera stays on it and a quick
// reconnect resumes driving — and offer the per-seat reconnect QR with its
// grace clock running. The card's URL is the shell's (D3: the claim URL needs
// the platform's base origin), so the effect carries the seat and nothing else.
void dropSeatWalk(RoomFlow* flow, const PeerId& id, Value& effects) {
  pushPeerOp(effects, "close-fastlane", id);
  flow->markDisconnected(id);
  const ttp::Player* p = flow->get(id);
  if (!p) return;
  Value seat = Value::Obj();
  seat.set("peerIndex", id.toValue());
  if (const Value* v = fieldOf(p, "name")) seat.set("name", *v);
  if (const Value* v = fieldOf(p, "colorIndex")) seat.set("colorIndex", *v);
  Value e = effectOp("show-reconnect");
  e.set("seat", std::move(seat));
  effects.push(std::move(e));
}

// _expireSeat: free a seat for good — clear its reconnect card and drop the
// player. An intentional LEAVE, and the grace window elapsing.
void expireSeatWalk(RoomFlow* flow, const PeerId& id, Value& effects) {
  pushPeerOp(effects, "clear-reconnect", id);
  if (!flow->has(id)) return;
  pushPeerOp(effects, "close-fastlane", id);
  flow->removePlayer(id);  // emits rosterchange (and its last-seen stamp goes)
}

// _addPeer: the seat rule is add_peer_plan's; lowestFreeSlot stays RoomFlow's,
// resolved here over the roster's colorIndex fields exactly as the shell
// scanned them. The default name is STORED (session::seat_name — see its
// comment for why that is not a D4 breach).
void addPeerWalk(RoomFlow* flow, const PeerId& id, double nowMs, Value& effects) {
  std::vector<double> used;
  const Value roster = flow->listValue();
  for (const Value& p : roster.arr)
    if (const Value* c = p.find("colorIndex"))
      if (c->type == Value::NUM) used.push_back(c->num);
  const int colorIndex = lowest_free_slot(used, protocol::MAX_PLAYERS);
  const ns::AddPeerPlan plan = ns::add_peer_plan(
      flow->has(id), static_cast<double>(flow->size()), protocol::MAX_PLAYERS, colorIndex);
  if (plan.hasSeat) {
    std::vector<std::pair<std::string, Value>> fields;
    fields.emplace_back("name", Value::Str(ns::seat_name(plan.seat)));
    fields.emplace_back("colorIndex", Value::Num(plan.seat.colorIndex));
    fields.emplace_back("carIndex", Value::Num(plan.seat.carIndex));
    fields.emplace_back("ready", Value::Bool(plan.seat.ready));
    flow->addPlayer(id, fields);  // emits rosterchange -> the shell announces
  }
  if (plan.stamp) seenWalk(flow, id, nowMs, effects);
}

// _claimReconnect: the cross-device rejoin, claiming a dropped seat via the
// HELLO's rejoinToken. The WHOLE message is consulted, not just the token: an
// ABSENT rejoinToken and an explicit null answer differently, and that
// difference is frozen — see claim_plan/norm_index. Answers the CLAIMED old
// seat (None when nothing was claimed): the hello walk needs it, because the
// still-racing car is keyed to that seat until the shell performs rekey-player.
PeerId claimWalk(RoomFlow* flow, const Value* fromV, const PeerId& from, const Value& msg,
                 double nowMs, Value& effects) {
  const Value* token = mfind(msg, "rejoinToken");
  // `hasOld`/`oldDisconnected` are asked speculatively, exactly as the shell
  // did: the plan needs them alongside the token it is about to normalize.
  double guess = 0;
  const bool hasGuess = ns::norm_index(token, &guess);
  const PeerId oldId = PeerId::Num(guess);
  const double fromNum =
      (fromV && fromV->type == Value::NUM) ? fromV->num : std::nan("");
  const ns::ClaimPlan plan =
      ns::claim_plan(fromNum, token, hasGuess && flow->has(oldId),
                     hasGuess && flow->isDisconnected(oldId));
  if (!plan.claim) return PeerId::None();
  pushPeerOp(effects, "close-fastlane", oldId);
  pushPeerOp(effects, "close-fastlane", from);
  flow->rekey(oldId, from);  // moves the seat record (+ stamp), marks reconnected
  // The carried stamp is from before the drop (> timeout old), so without this
  // the reclaimed seat would expire again on the very next tick.
  if (plan.restamp) flow->onSeen(from, nowMs);
  Value e = effectOp("rekey-player");  // move their still-racing car over
  e.set("oldId", oldId.toValue());
  e.set("newId", from.toValue());
  effects.push(std::move(e));
  pushPeerOp(effects, "clear-reconnect", oldId);
  pushPeerOp(effects, "clear-reconnect", from);
  return oldId;
}

// ---- the mode pick ---------------------------------------------------------

// A 'random' pick's run length off the wire: 0 is ENDLESS, anything else is
// that many races. Host-supplied like every other field here, so it is clamped
// rather than trusted — and a pick that carries no length at all (a phone from
// before they existed) gets the default card rather than an endless run nobody
// asked for. The two numbers are the MANIFEST's (RANDOM_RACES); 0 is a legal
// length, so MAX is a ceiling and not half of a range.
double normRandomRaces(const Value* v) {
  if (v && v->type == Value::NUM && std::isfinite(v->num) &&
      std::trunc(v->num) == v->num && v->num >= 0 && v->num <= protocol::RANDOM_RACES_MAX)
    return v->num;
  return protocol::RANDOM_RACES_DEFAULT;
}

// tracks.some((t) => t.id === wanted) over the configured chooser — the
// catalogue was already handed to C++ at boot, which is what let the pick
// cross at all.
bool catalogueHasTrack(const Value* wanted) {
  const Value* tracks = g_chooser.find("tracks");
  if (!tracks || tracks->type != Value::ARR || !wanted) return false;
  for (const Value& t : tracks->arr)
    if (t.type == Value::OBJ && strictEquals(orUndef(t.find("id")), *wanted)) return true;
  return false;
}

// ---- the shuffle bag ---------------------------------------------------------
// {seed, deck:[ids], cursor} behind the room handle. xorshift64* over the
// chooser's track ids, re-shuffled when the deck empties — the JS bag's rule
// ("random walks the whole catalogue before any repeat"), owned here so no
// shell carries a draw protocol. The seed is the shell's page entropy, handed
// over once at ttp_net_init_pick; an unseeded bag draws nothing, which is the
// bagless test surface's refusal.
uint64_t bagNext(uint64_t x) {
  if (!x) x = 0x9E3779B97F4A7C15ull;
  x ^= x << 13; x ^= x >> 7; x ^= x << 17;
  return x;
}

std::string bagDraw(int roomHandle) {
  Value bag = ttp_room_bag_value(roomHandle);
  const Value* seedV = bag.find("seed");
  if (!seedV || seedV->type != Value::NUM) return "";
  uint64_t rng = (uint64_t)seedV->num;
  std::vector<std::string> deck;
  if (const Value* d = bag.find("deck"))
    if (d->type == Value::ARR)
      for (const Value& e : d->arr) if (e.type == Value::STR) deck.push_back(e.str);
  const Value* curV = bag.find("cursor");
  size_t cursor = (curV && curV->type == Value::NUM && curV->num >= 0) ? (size_t)curV->num : 0;
  if (cursor >= deck.size()) {
    deck.clear();
    if (const Value* tracks = g_chooser.find("tracks"))
      if (tracks->type == Value::ARR)
        for (const Value& t : tracks->arr)
          if (t.type == Value::OBJ)
            if (const Value* id = t.find("id"))
              if (id->type == Value::STR) deck.push_back(id->str);
    for (size_t i = deck.size(); i > 1; --i) {
      rng = bagNext(rng);
      std::swap(deck[i - 1], deck[rng % i]);
    }
    cursor = 0;
  }
  if (deck.empty()) return "";
  const std::string out = deck[cursor++];
  Value nb = Value::Obj();
  // The advanced rng becomes the next seed; 32 bits keeps the double exact.
  nb.set("seed", Value::Num((double)(bagNext(rng) & 0xFFFFFFFFull)));
  Value dv = Value::Arr();
  for (const std::string& s : deck) dv.push(Value::Str(s));
  nb.set("deck", std::move(dv));
  nb.set("cursor", Value::Num((double)cursor));
  ttp_room_store_bag(roomHandle, std::move(nb));
  return out;
}

// The catalogue is in CUPS order, so a cup's first entry is its race 1.
const Value* firstCupTrackId(const Value* cupId) {
  const Value* tracks = g_chooser.find("tracks");
  if (!tracks || tracks->type != Value::ARR) return nullptr;
  for (const Value& t : tracks->arr)
    if (t.type == Value::OBJ && strictEquals(orUndef(t.find("cup")), orUndef(cupId)))
      return t.find("id");
  return nullptr;
}

// Adopt a new pick: STORE it (ttp_room.h's slot is the one copy — no set-pick
// effect hands it back to a shell anymore), then publish — the frame reads the
// pick just stored — then swap the preview.
void storePickAndPush(int roomHandle, Value& effects, Value mode, Value cupId,
                      double randomRaces, Value trackId) {
  if (trackId.type == Value::UNDEF) trackId = Value::Null();
  ttp_room_store_pick(roomHandle, makePick(std::move(mode), std::move(cupId), randomRaces,
                                           trackId, storedHasBag(roomHandle)));
  pushOp(effects, "publish");
  Value tc = effectOp("track-change");
  tc.set("trackId", std::move(trackId));
  effects.push(std::move(tc));
}

// _applyMode: the host's lobby pick — exact track, a cup (Grand Prix), or a
// random draw. Validates, resolves the concrete trackId, and answers the
// publish + preview swap. Same-pick taps no-op EXCEPT random, where a re-tap
// re-rolls. Returns true when a draw is needed and none was supplied.
bool selectModeWalk(int roomHandle, const PeerId& from, const Value& msg,
                    const Value* drawnTrack, Value& effects) {
  RoomFlow* flow = ttp_room_flow(roomHandle);
  if (!flow) return false;
  if (!(from == flow->host()) || flow->state() != RoomFlow::State::LOBBY) return false;
  const Value pick = ttp_room_pick_value(roomHandle);
  const Value* modeV = mfind(msg, "mode");
  const std::string mode = (modeV && modeV->type == Value::STR) ? modeV->str : "";
  const Value* curModeV = mfind(pick, "mode");
  const std::string curMode = (curModeV && curModeV->type == Value::STR) ? curModeV->str : "";
  if (mode == "track") {
    const Value* tid = mfind(msg, "trackId");
    if (!catalogueHasTrack(tid)) return false;
    if (curMode == "track" && strictEquals(orUndef(tid), orUndef(mfind(pick, "trackId"))))
      return false;
    storePickAndPush(roomHandle, effects, Value::Str(mode), Value::Null(), 0, orUndef(tid));
  } else if (mode == "cup") {
    const Value* cupId = mfind(msg, "cupId");
    const Value* first = firstCupTrackId(cupId);
    if (!first) return false;
    if (curMode == "cup" && strictEquals(orUndef(cupId), orUndef(mfind(pick, "cupId"))))
      return false;
    storePickAndPush(roomHandle, effects, Value::Str(mode), orUndef(cupId), 0, *first);
  } else if (mode == "random") {
    // A bagless shell (test surfaces) refuses random outright, keepDraw
    // included — the old shell's `if (!drawRandomTrack) return` gate.
    if (!json::truthy(mfind(pick, "hasBag"))) return false;
    const double randomRaces = normRandomRaces(mfind(msg, "randomRaces"));
    const Value* curTrack = mfind(pick, "trackId");
    const Value* curRR = mfind(pick, "randomRaces");
    const double curRRn = (curRR && curRR->type == Value::NUM) ? curRR->num : 0;
    // Changing the LENGTH keeps the drawn track — only the shape of the run
    // changed, and re-rolling the preview under the host would read as the
    // length button having picked a track. Every other random tap (the tile
    // itself, or arriving from another mode) draws.
    const bool keepDraw = curMode == "random" && randomRaces != curRRn &&
                          curTrack && curTrack->type != Value::NUL;
    if (keepDraw) storePickAndPush(roomHandle, effects, Value::Str(mode), Value::Null(),
                                   randomRaces, *curTrack);
    else if (drawnTrack) storePickAndPush(roomHandle, effects, Value::Str(mode), Value::Null(),
                                          randomRaces, *drawnTrack);
    else return true;  // needDraw: the bag is the shell's
  }
  return false;
}

}  // namespace

// ---- the walk ABI bodies ---------------------------------------------------

void ttp_net_restore_room(int roomHandle, const char* code, const char* instance) {
  NetState& st = netStateOf(roomHandle);
  st.roomCode = strOr(code);
  st.instance = strOr(instance);
}

const char* ttp_net_on_open_json(int roomHandle) {
  NetState& st = netStateOf(roomHandle);
  Value effects = Value::Arr();
  if (!st.roomCode.empty()) {
    Value e = effectOp("join-room");
    e.set("room", Value::Str(st.roomCode));
    effects.push(std::move(e));
  } else {
    Value e = effectOp("create-room");
    // +1 for the display itself.
    e.set("maxClients", Value::Num(protocol::MAX_PLAYERS + 1));
    effects.push(std::move(e));
  }
  // A socket that opens but never gets a created/joined answer (relay rejected
  // the create, reply lost) would otherwise hang forever — no close event ever
  // fires. The watchdog counts it as a failed attempt so the normal
  // backoff/retry path runs. Cleared by created/joined; the close walk clears
  // it too so a socket already in backoff can't be double-failed.
  Value w = effectOp("arm-create-watchdog");
  w.set("delayMs", Value::Num(protocol::LIVENESS_CREATE_TIMEOUT_MS));
  effects.push(std::move(w));
  return answer(g_bufOpen, std::move(effects));
}

const char* ttp_net_create_timeout_json(int roomHandle) {
  Value effects = Value::Arr();
  if (!netStateOf(roomHandle).inRoom) pushOp(effects, "fail-attempt");
  return answer(g_bufCreateTimeout, std::move(effects));
}

const char* ttp_net_on_protocol_json(int roomHandle, const char* type, const char* msgJson,
                                     double nowMs) {
  RoomFlow* flow = ttp_room_flow(roomHandle);
  NetState& st = netStateOf(roomHandle);
  Value effects = Value::Arr();
  if (!flow) return answer(g_bufProtocol, std::move(effects));
  const std::string t = strOr(type);
  const Value msg = json::parse_or(msgJson, Value::Obj());

  // A room identity was answered: adopt it, persist it, start the clock, tell
  // the shell. The heartbeat's in-flight flag resets HERE, before the shell's
  // start-liveness timer guard can matter: a heartbeat left in flight by a
  // dropped socket must not survive into the fresh connection, or the first
  // tick would read it as overdue and force-reconnect the link that just
  // recovered.
  const auto adoptRoom = [&]() {
    st.inRoom = true;
    Value s = effectOp("save-room");
    s.set("room", Value::Str(st.roomCode));
    s.set("instance", st.instance.empty() ? Value::Null() : Value::Str(st.instance));
    effects.push(std::move(s));
    st.hbPending = false;
    pushOp(effects, "start-liveness");
    Value r = effectOp("room-ready");
    r.set("room", Value::Str(st.roomCode));
    r.set("instance", st.instance.empty() ? Value::Null() : Value::Str(st.instance));
    effects.push(std::move(r));
  };

  if (t == "created") {
    pushOp(effects, "clear-create-timer");
    const Value* room = mfind(msg, "room");
    st.roomCode = (room && room->type == Value::STR) ? room->str : "";
    const Value* inst = mfind(msg, "instance");
    // msg.instance || null — an empty string is the falsy no-shard case.
    st.instance = (json::truthy(inst) && inst->type == Value::STR) ? inst->str : "";
    if (!st.instance.empty()) {
      Value e = effectOp("pin-instance");
      e.set("room", Value::Str(st.roomCode));
      e.set("instance", Value::Str(st.instance));
      effects.push(std::move(e));
    }
    adoptRoom();
  } else if (t == "joined") {
    // Display reconnected to an existing room (in-session or after a reload).
    pushOp(effects, "clear-create-timer");
    const Value* room = mfind(msg, "room");
    st.roomCode = (room && room->type == Value::STR) ? room->str : "";
    // Post-reload reconciliation: seats the relay no longer knows are expired,
    // peers it knows that we don't are seated with placeholder identities.
    // The set logic is resync_plan's; both halves are performed here.
    std::vector<double> rosterIds;
    {
      const Value roster = flow->listValue();
      for (const Value& p : roster.arr)
        if (const Value* id = p.find("peerIndex"))
          if (id->type == Value::NUM) rosterIds.push_back(id->num);
    }
    std::vector<double> relayPeers;
    if (const Value* peers = mfind(msg, "peers"))
      if (peers->type == Value::ARR)
        for (const Value& e : peers->arr)
          if (e.type == Value::NUM) relayPeers.push_back(e.num);
    const ns::ResyncPlan plan = ns::resync_plan(rosterIds, relayPeers);
    for (double id : plan.expire) expireSeatWalk(flow, PeerId::Num(id), effects);
    for (double idx : plan.add) addPeerWalk(flow, PeerId::Num(idx), nowMs, effects);
    // Overwrite the snapshot retained from before the reload: this fresh flow
    // is now the authority, so the live push clears every phone's reconnect
    // overlay and the next joiner isn't replayed the old roster. Each phone
    // also re-HELLOs when it sees the display return.
    if (plan.publish) pushOp(effects, "publish");
    pushOp(effects, "reset-reconnect-count");
    adoptRoom();
  } else if (t == "peer_joined") {
    addPeerWalk(flow, peerIdOf(mfind(msg, "index")), nowMs, effects);
  } else if (t == "peer_left") {
    const PeerId id = peerIdOf(mfind(msg, "index"));
    if (flow->has(id)) {
      pushPeerOp(effects, "close-fastlane", id);
      // In the lobby a drop is forgiving — just free the seat (the lobby's own
      // join QR covers coming back). Mid-game keep the seat AND the player's
      // car running, and offer a reconnect QR for that exact seat.
      if (ns::presence_action(ns::room_state_of(flow->stateName())) ==
          ns::PresenceAction::FREE) {
        flow->removePlayer(id);
      } else {
        dropSeatWalk(flow, id, effects);
      }
    }
  } else if (t == "error") {
    // A join refused while we hold a room code means the room is gone (the
    // relay expired it while this tab was closed/asleep). Fall back to a fresh
    // room instead of erroring forever on a dead one.
    if (!st.roomCode.empty() && !st.inRoom) {
      pushOp(effects, "forget-room");
      st.roomCode.clear();
      st.instance.clear();
      pushOp(effects, "connect-fresh");
    } else if (!st.inRoom) {
      // The CREATE was rejected (bad url template, server error): without a
      // room there is nothing to fall back to, so write the attempt off and
      // let the normal backoff retry it.
      pushOp(effects, "fail-attempt");
    }
  }
  return answer(g_bufProtocol, std::move(effects));
}

const char* ttp_net_on_close_json(int roomHandle, int roomClosed) {
  RoomFlow* flow = ttp_room_flow(roomHandle);
  NetState& st = netStateOf(roomHandle);
  st.inRoom = false;
  Value effects = Value::Arr();
  pushOp(effects, "clear-create-timer");
  // The room itself is gone — our own closeRoom() echoing back, or the relay
  // tore it down. Terminal for the room but not for the display: forget it and
  // open a fresh one (new code/QR), same fallback as a "Room not found" join.
  if (roomClosed && flow) {
    pushOp(effects, "forget-room");
    st.roomCode.clear();
    st.instance.clear();
    // The 4001 bailed every phone terminally — nobody carries a seat into the
    // fresh room (close_room sends no peer_lefts, so without this the old
    // roster would haunt the new lobby). Cleared here, not on 'created', so a
    // plain reconnect's regathered roster stays intact.
    std::vector<PeerId> ids;
    const Value roster = flow->listValue();
    for (const Value& p : roster.arr) ids.push_back(peerIdOf(p.find("peerIndex")));
    for (const PeerId& id : ids) expireSeatWalk(flow, id, effects);
    pushOp(effects, "connect-fresh");
  }
  return answer(g_bufClose, std::move(effects));
}

const char* ttp_net_on_peer_message_json(int roomHandle, int sessionHandle,
                                         const char* fromJson, const char* msgJson,
                                         int isSignal, double nowMs) {
  RoomFlow* flow = ttp_room_flow(roomHandle);
  NetState& st = netStateOf(roomHandle);
  Value effects = Value::Arr();
  if (!flow) return answer(g_bufPeerMsg, std::move(effects));
  const Value fromV = json::parse_or(fromJson, Value::Null());
  const Value msg = json::parse_or(msgJson, Value::Obj());
  const Value* typeV = mfind(msg, "type");
  const std::string type = (typeV && typeV->type == Value::STR) ? typeV->str : "";

  // Slot 0 is US: the only thing that can arrive from it is our own relayed
  // echo, which is how the self-heartbeat closes its loop.
  const double fromNum = fromV.type == Value::NUM ? fromV.num : std::nan("");
  const ns::InboundRoute route = ns::inbound_route(fromNum, type);
  if (route != ns::InboundRoute::PEER) {
    if (route == ns::InboundRoute::SELF_HEARTBEAT) st.hbPending = false;
    return answer(g_bufPeerMsg, std::move(effects));
  }

  // ANY traffic from a peer — app message or RTC signal — is proof of life.
  const PeerId from = peerIdOf(&fromV);
  seenWalk(flow, from, nowMs, effects);
  if (isSignal) return answer(g_bufPeerMsg, std::move(effects));

  const ns::RoomState roomState = ns::room_state_of(flow->stateName());
  switch (ns::message_action(type)) {
    case ns::MessageAction::HELLO: {
      // A cross-device rejoin claims its dropped seat first, so the snapshot
      // published below reflects the restored identity (livery/car/host) — not
      // the throwaway placeholder slot the relay just handed this connection.
      const PeerId claimedOld = claimWalk(flow, &fromV, from, msg, nowMs, effects);
      // A HELLO from a peer we never seated (the relay knows them, we don't —
      // e.g. this tab reloaded and missed their peer_joined): seat them now.
      // Whether the seat EXISTED is also what tells a rename from a first
      // hello: a fresh seat's placeholder name is always "changed" by the one
      // the HELLO carries, and that is a join.
      const bool seated = flow->has(from);
      if (!seated) addPeerWalk(flow, from, nowMs, effects);
      const ttp::Player* p = flow->get(from);
      const Value* nameV = mfind(msg, "name");
      if (p && json::truthy(nameV)) {
        const std::string name = ns::clean_name_json(canonical_stringify(*nameV));
        const Value* cur = fieldOf(p, "name");
        const bool renamed =
            seated && !(cur && cur->type == Value::STR && cur->str == name);
        flow->setField(from, "name", Value::Str(name));
        if (renamed) {
          // A race freezes field-row copies of the name at launch; repair the
          // room-retained field here so every later standings board tells the
          // new name without a shell curating rows.
          Value f = ttp_room_field_value(roomHandle);
          if (f.type == Value::ARR) {
            for (Value& row : f.arr) {
              const Value* pid = row.find("peerIndex");
              if (pid && strictEquals(*pid, from.toValue())) row.set("name", Value::Str(name));
            }
            ttp_room_store_field(roomHandle, std::move(f));
          }
          Value e = effectOp("player-renamed");
          e.set("peerIndex", from.toValue());
          e.set("name", Value::Str(name));
          effects.push(std::move(e));
        }
      }
      // No unicast reply: the phone recovers its whole state from the retained
      // room snapshot (announce republishes it, and the relay replayed it
      // right after `joined`). welcome-item only relights the per-owner ITEM,
      // and only when the live race holds this seat's car — the predicate the
      // shell used to answer through its inRace callback. On a cross-device
      // claim the car is still keyed to the CLAIMED seat at this point (the
      // shell performs rekey-player, already in this list, before
      // welcome-item), so that spelling of "holds a car" counts too.
      Game* g = ttp_session_engine(sessionHandle);
      if (g && (g->hasCar(from) || (!claimedOld.isNull() && g->hasCar(claimedOld))))
        pushPeerOp(effects, "welcome-item", from);
      pushOp(effects, "announce");
      break;
    }
    case ns::MessageAction::LEAVE:
      // Intentional back-out. The fork is leave_action's: freed outright in
      // the lobby (and on the results board), a soft DROP mid-race so one
      // accidental back-swipe cannot forfeit a car.
      if (ns::leave_action(roomState) == ns::LeaveAction::DROP)
        dropSeatWalk(flow, from, effects);
      else
        expireSeatWalk(flow, from, effects);
      break;
    case ns::MessageAction::SET_CAR: {
      // Lobby car-model pick. Whether it is allowed — a ready seat's pick is
      // locked, a racer's is locked until the lobby, a late joiner may pick
      // mid-race, and the index must be an integer in range — is
      // set_car_decision's, off untrusted phone input.
      const ttp::Player* p = flow->get(from);
      if (!p) break;
      Game* g = ttp_session_engine(sessionHandle);
      const Value* carIndex = mfind(msg, "carIndex");
      if (ns::set_car_decision(json::truthy(fieldOf(p, "ready")), roomState,
                               g && g->hasCar(from), carIndex,
                               static_cast<double>(protocol::CAR_MODELS.size()))) {
        flow->setField(from, "carIndex", *carIndex);
        pushOp(effects, "announce");
      }
      break;
    }
    case ns::MessageAction::SET_READY: {
      // Readiness toggle. Stored on the player record and echoed to every
      // phone via LOBBY_UPDATE; the game layer requires every non-host player
      // ready before honouring the host's START_GAME.
      const ttp::Player* p = flow->get(from);
      if (!p) break;
      const bool want = json::truthy(mfind(msg, "ready"));
      if (ns::set_ready_decision(from == flow->host(), roomState, want,
                                 json::truthy(fieldOf(p, "ready")))) {
        flow->setField(from, "ready", Value::Bool(want));
        pushOp(effects, "announce");
      }
      break;
    }
    case ns::MessageAction::SELECT_MODE: {
      // A random pick that needs a draw takes it from the room's own bag and
      // completes in the same walk — the needDraw round trip died with the
      // shell-side bag.
      if (selectModeWalk(roomHandle, from, msg, nullptr, effects)) {
        const std::string drawn = bagDraw(roomHandle);
        if (!drawn.empty()) {
          const Value d = Value::Str(drawn);
          selectModeWalk(roomHandle, from, msg, &d, effects);
        }
      }
      return answer(g_bufPeerMsg, std::move(effects));
    }
    case ns::MessageAction::PING: {
      // The PONG is COMPOSED here — type off the manifest, `t` echoed verbatim
      // (absent stays absent) — so three shells cannot each spell it.
      Value data = Value::Obj();
      data.set("type", Value::Str(msgOf("PONG")));
      if (const Value* tv = mfind(msg, "t")) data.set("t", *tv);
      Value e = effectOp("send-to");
      e.set("to", fromV);
      e.set("data", std::move(data));
      effects.push(std::move(e));
      break;
    }
    case ns::MessageAction::GAME:
      // START_GAME / control / etc. — hand to the game layer. The shell still
      // holds from/data, so the effect carries nothing.
      pushOp(effects, "game-message");
      break;
  }
  return answer(g_bufPeerMsg, std::move(effects));
}


const char* ttp_net_set_track_json(int roomHandle, const char* trackId) {
  RoomFlow* flow = ttp_room_flow(roomHandle);
  Value effects = Value::Arr();
  if (!flow) return answer(g_bufSetTrack, std::move(effects));
  const Value pick = ttp_room_pick_value(roomHandle);
  const Value tid = Value::Str(strOr(trackId));
  // Single writer with the mode pick, so trackId always flows out the same way
  // (store + publish + preview swap). Mode/cup/length ride through as they
  // are: the series engine advancing a cup, or the lobby re-drawing a random
  // pick, changes the TRACK and nothing else.
  if (!catalogueHasTrack(&tid)) return answer(g_bufSetTrack, std::move(effects));
  if (strictEquals(tid, orUndef(mfind(pick, "trackId"))))
    return answer(g_bufSetTrack, std::move(effects));
  const Value* curModeV = mfind(pick, "mode");
  const Value* curCup = mfind(pick, "cupId");
  const Value* curRR = mfind(pick, "randomRaces");
  storePickAndPush(roomHandle, effects,
                   curModeV ? *curModeV : Value::Null(),
                   curCup ? *curCup : Value::Null(),
                   (curRR && curRR->type == Value::NUM) ? curRR->num : 0, tid);
  return answer(g_bufSetTrack, std::move(effects));
}

void ttp_net_init_pick(int roomHandle, const char* defaultTrackIdOrNull, int hasBag,
                       double bagSeed) {
  // DisplayNet's constructor rule: a default track preselects mode "track".
  const bool hasDefault = defaultTrackIdOrNull && *defaultTrackIdOrNull;
  ttp_room_store_pick(roomHandle,
      makePick(hasDefault ? Value::Str("track") : Value::Null(), Value::Null(), 0,
               hasDefault ? Value::Str(defaultTrackIdOrNull) : Value::Null(),
               Value::Bool(hasBag != 0)));
  // Seed the room's shuffle bag with the shell's page entropy. hasBag 0 leaves
  // it unseeded — the bagless test surface's refusal, same gate as ever.
  if (hasBag) {
    Value bag = Value::Obj();
    bag.set("seed", Value::Num(bagSeed));
    ttp_room_store_bag(roomHandle, std::move(bag));
  }
}

void ttp_net_clear_pick(int roomHandle) {
  // End party -> fresh room: the next party must not inherit the old party's
  // cup. hasBag survives — the shell's capability did not change.
  ttp_room_store_pick(roomHandle,
      makePick(Value::Null(), Value::Null(), 0, Value::Null(), storedHasBag(roomHandle)));
}

const char* ttp_net_pick_json(int roomHandle) {
  Value out = Value::Obj();
  setPickFields(roomHandle, out);
  ordered_stringify_into(out, g_bufPick);
  return g_bufPick.c_str();
}

const char* ttp_net_liveness_json(int roomHandle, int sessionHandle, double nowMs) {
  RoomFlow* flow = ttp_room_flow(roomHandle);
  NetState& st = netStateOf(roomHandle);
  Value effects = Value::Arr();
  if (!flow) return answer(g_bufLiveness, std::move(effects));
  // The self-heartbeat's state machine is heartbeat_tick's: overdue is an
  // IN-FLIGHT FLAG rather than an echo age, so a throttled background tab —
  // whose ticks may run minutes apart — cannot misread its own starvation as a
  // dead link. The write-back is internal; the shell only performs.
  const ns::HeartbeatTick tick =
      ns::heartbeat_tick(st.inRoom, st.hbPending, st.hbSentAt, nowMs);
  st.hbPending = tick.hbPending;
  st.hbSentAt = tick.hbSentAt;
  if (tick.act == ns::HeartbeatAct::RECONNECT) {
    // The relay can no longer reach us: force the reconnect it cannot ask for.
    pushOp(effects, "reconnect");
  } else if (tick.act == ns::HeartbeatAct::SEND) {
    Value data = Value::Obj();
    data.set("type", Value::Str(msgOf("HEARTBEAT")));
    Value e = effectOp("send-to");
    e.set("to", Value::Num(0));
    e.set("data", std::move(data));
    effects.push(std::move(e));
  }
  if (!tick.sweep) return answer(g_bufLiveness, std::move(effects));
  // Per-controller silence check. RoomFlow owns the detection (mid-game only —
  // expiredPeers is empty in the lobby); the drop is applied here so
  // markDisconnected keeps its single writer.
  for (const PeerId& id : flow->expiredPeers(nowMs)) dropSeatWalk(flow, id, effects);
  // …then the abandoned-race deadline, on the same tick and the same clock:
  // RoomFlow arms it while every participant is gone and someone is waiting,
  // and returns true the one time it expires. The active order is re-synced
  // off the live race first, through the same seam as ever.
  ttp_room_sync_active_order(roomHandle, sessionHandle);
  if (flow->graceTick(nowMs)) pushOp(effects, "race-abandoned");
  return answer(g_bufLiveness, std::move(effects));
}

const char* ttp_net_on_seen_json(int roomHandle, const char* peerIdJson, double nowMs) {
  RoomFlow* flow = ttp_room_flow(roomHandle);
  Value effects = Value::Arr();
  if (flow) seenWalk(flow, parse_scalar_id(peerIdJson), nowMs, effects);
  return answer(g_bufSeen, std::move(effects));
}

const char* ttp_net_host_change_apply_json(int roomHandle, const char* hostPeerIdJson) {
  RoomFlow* flow = ttp_room_flow(roomHandle);
  Value effects = Value::Arr();
  if (!flow) return answer(g_bufHostApply, std::move(effects));
  const ns::HostChangePlan plan = ns::host_change_plan();
  if (plan.clearReady) {
    // The event's OWN hostPeerIndex, not flow->host(): two promotions queued in
    // one drain must each clear their own host's flag, exactly as the shell's
    // per-event handler did.
    const PeerId h = parse_scalar_id(hostPeerIdJson);
    if (flow->get(h)) flow->setField(h, "ready", Value::Bool(false));
  }
  if (plan.publish) pushOp(effects, "announce");
  return answer(g_bufHostApply, std::move(effects));
}

const char* ttp_net_state_change_apply_json(int roomHandle, const char* to, double nowMs) {
  RoomFlow* flow = ttp_room_flow(roomHandle);
  Value effects = Value::Arr();
  if (!flow) return answer(g_bufStateApply, std::move(effects));
  const ns::StateChangePlan plan = ns::state_change_plan(stateOf(to));
  // Race start: re-stamp every CONNECTED seat's liveness, so silence
  // accumulated in the lobby (where expiredPeers is gated off) isn't charged
  // against the first COUNTDOWN tick. Deliberately not a blanket
  // clear-disconnected: flipping a grace-pending seat back to connected here
  // would orphan its reconnect QR (only the seen/claim walks may flip
  // presence). Disconnected seats keep their stale stamp; expiredPeers already
  // skips them.
  if (plan.restampConnected) {
    const Value roster = flow->listValue();
    for (const Value& p : roster.arr)
      if (json::truthy(p.find("connected")))
        flow->onSeen(peerIdOf(p.find("peerIndex")), nowMs);
  }
  // Returning to the lobby, free every seat still flagged disconnected: the
  // race that reserved them is over, and a lobby ghost with a dead reconnect
  // QR would just block one of the four slots. (A cup's RESULTS→COUNTDOWN
  // chain never passes through LOBBY, so a blipped racer's seat rides through
  // the intermission into the next race.)
  if (plan.freeDisconnected) {
    std::vector<PeerId> ids;
    const Value roster = flow->listValue();
    for (const Value& p : roster.arr) {
      const PeerId id = peerIdOf(p.find("peerIndex"));
      if (flow->isDisconnected(id)) ids.push_back(id);
    }
    for (const PeerId& id : ids) expireSeatWalk(flow, id, effects);
  }
  if (plan.clearStandings) pushOp(effects, "clear-standings");
  if (plan.publish) pushOp(effects, "publish");
  return answer(g_bufStateApply, std::move(effects));
}

// The race walks' draws come from the same room-owned bag (ttp_live.h).
extern "C++" std::string ttp_live_bag_draw(int roomHandle) { return bagDraw(roomHandle); }
