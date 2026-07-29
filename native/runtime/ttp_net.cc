// ttp_net.cc — the session-policy ABI over libttp-party's ttp::session.
//
// MARSHALLING ONLY. Not one room decision is taken in this file: every export
// parses its arguments, calls the rule in ttp/session.h and spells the answer
// back out. That split is what lets partytest/session_check.cc gate the RULES
// against tests/fixtures/session-corpus.jsonl while this layer is covered by
// runtimetest/abi_check.cc replaying the SAME corpus through the C boundary —
// the arrangement ttp_ui.cc and ttp_party.cc already have. A wrong key, a
// dropped null or an absent-vs-null confusion lives exactly here and is
// invisible to a check that calls C++ objects directly.
//
// KEY ORDER IS OUTPUT for the snapshot: it is emitted with ordered_stringify so
// the bytes the relay retains are the ones the phones have always parsed. See
// ttp_net.h's deviation note.
#include "ttp_net.h"

#include <string>
#include <vector>

#include "ttp/canonical.h"
#include "ttp/json_parse.h"
#include "ttp/json_read.h"
#include "ttp/session.h"

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
std::string g_bufRows, g_bufSnapshot, g_bufJoin, g_bufClaimUrl, g_bufTemplate,
    g_bufNorm, g_bufSeat, g_bufAddPeer, g_bufCard, g_bufState, g_bufHost,
    g_bufTick, g_bufClaim, g_bufResync;

const char* put(std::string& buf, const Value& v) {
  ordered_stringify_into(v, buf);
  return buf.c_str();
}
const char* putStr(std::string& buf, std::string s) {
  buf = std::move(s);
  return buf.c_str();
}

// A JSON text that may legitimately be "absent". NULL and "" mean JS
// `undefined`; anything else parses, and a parse FAILURE is undefined too (a
// malformed token is not a null). Returns nullptr for absent.
const Value* parseOptional(const char* json, Value& storage) {
  if (!json || !*json) return nullptr;
  bool ok = false;
  storage = json::parse(json, &ok);
  return ok ? &storage : nullptr;
}

std::vector<double> numbersOf(const char* json) {
  std::vector<double> out;
  Value v = json::parse_or(json, Value::Arr());
  if (v.type != Value::ARR) return out;
  for (const Value& e : v.arr) {
    if (e.type == Value::NUM) out.push_back(e.num);
  }
  return out;
}

std::string strOr(const char* s) { return s ? std::string(s) : std::string(); }

ns::RoomState stateOf(const char* s) { return ns::room_state_of(strOr(s)); }

Value seatValue(const ns::SeatDefaults& d) {
  Value v = Value::Obj();
  v.set("nameKey", Value::Str(d.nameKey));
  v.set("nameArg", Value::Num(d.nameArg));
  v.set("colorIndex", Value::Num(d.colorIndex));
  v.set("carIndex", Value::Num(d.carIndex));
  v.set("ready", Value::Bool(d.ready));
  return v;
}

}  // namespace

// ---- the chooser -------------------------------------------------------------

int ttp_net_configure(const char* chooserJson) {
  if (!chooserJson || !*chooserJson) {
    g_chooser = Value::Obj();
    return 1;
  }
  bool ok = false;
  Value v = json::parse(chooserJson, &ok);
  if (!ok || v.type != Value::OBJ) return 0;
  g_chooser = std::move(v);
  return 1;
}

// ---- the retained room snapshot ----------------------------------------------

const char* ttp_net_roster_rows_json(const char* rosterJson, const char* inRaceJson) {
  return put(g_bufRows, ns::roster_rows(json::parse_or(rosterJson, Value::Arr()),
                                        json::parse_or(inRaceJson, Value::Arr())));
}

const char* ttp_net_lobby_snapshot_json(const char* inputJson) {
  return put(g_bufSnapshot, ns::lobby_snapshot(json::parse_or(inputJson, Value::Obj()), g_chooser));
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

const char* ttp_net_norm_index_json(const char* valueJson) {
  Value storage;
  const Value* v = parseOptional(valueJson, storage);
  double n = 0;
  return put(g_bufNorm, ns::norm_index(v, &n) ? Value::Num(n) : Value::Null());
}

// ---- seats --------------------------------------------------------------------

const char* ttp_net_seat_defaults_json(double colorIndex) {
  return put(g_bufSeat, seatValue(ns::seat_defaults(colorIndex)));
}

const char* ttp_net_add_peer_plan_json(int has, double size, double maxPlayers,
                                       double colorIndex) {
  const ns::AddPeerPlan plan = ns::add_peer_plan(has != 0, size, maxPlayers, colorIndex);
  Value out = Value::Obj();
  out.set("seat", plan.hasSeat ? seatValue(plan.seat) : Value::Null());
  out.set("stamp", Value::Bool(plan.stamp));
  return put(g_bufAddPeer, out);
}

const char* ttp_net_presence_action(const char* roomState) {
  return ns::key(ns::presence_action(stateOf(roomState)));
}

const char* ttp_net_leave_action(const char* roomState) {
  return ns::key(ns::leave_action(stateOf(roomState)));
}

const char* ttp_net_reconnect_card_json(const char* seatJson, const char* url) {
  return put(g_bufCard, ns::reconnect_card(json::parse_or(seatJson, Value::Obj()), strOr(url)));
}

// ---- controller messages ------------------------------------------------------

const char* ttp_net_inbound_route(double from, const char* type) {
  return ns::key(ns::inbound_route(from, strOr(type)));
}

const char* ttp_net_message_action(const char* type) {
  return ns::key(ns::message_action(strOr(type)));
}

int ttp_net_set_car(int ready, const char* roomState, int inRace,
                    const char* carIndexJson, double carCount) {
  Value storage;
  const Value* idx = parseOptional(carIndexJson, storage);
  return ns::set_car_decision(ready != 0, stateOf(roomState), inRace != 0, idx, carCount) ? 1 : 0;
}

int ttp_net_set_ready(int isHost, const char* roomState, int ready, int current) {
  return ns::set_ready_decision(isHost != 0, stateOf(roomState), ready != 0, current != 0) ? 1 : 0;
}

// ---- room-state transitions ----------------------------------------------------

const char* ttp_net_state_change_json(const char* to) {
  const ns::StateChangePlan plan = ns::state_change_plan(stateOf(to));
  Value out = Value::Obj();
  out.set("restampConnected", Value::Bool(plan.restampConnected));
  out.set("freeDisconnected", Value::Bool(plan.freeDisconnected));
  out.set("clearStandings", Value::Bool(plan.clearStandings));
  out.set("publish", Value::Bool(plan.publish));
  return put(g_bufState, out);
}

const char* ttp_net_host_change_json(void) {
  const ns::HostChangePlan plan = ns::host_change_plan();
  Value out = Value::Obj();
  out.set("clearReady", Value::Bool(plan.clearReady));
  out.set("publish", Value::Bool(plan.publish));
  return put(g_bufHost, out);
}

// ---- liveness -------------------------------------------------------------------

const char* ttp_net_heartbeat_tick_json(int inRoom, int hbPending, double hbSentAt, double now) {
  const ns::HeartbeatTick t = ns::heartbeat_tick(inRoom != 0, hbPending != 0, hbSentAt, now);
  Value out = Value::Obj();
  out.set("act", Value::Str(ns::key(t.act)));
  out.set("hbPending", Value::Bool(t.hbPending));
  out.set("hbSentAt", Value::Num(t.hbSentAt));
  out.set("sweep", Value::Bool(t.sweep));
  return put(g_bufTick, out);
}

// ---- claims + reconciliation ------------------------------------------------------

const char* ttp_net_claim_plan_json(const char* helloJson, double fromId, int hasOld,
                                    int oldDisconnected) {
  Value hello = json::parse_or(helloJson, Value::Obj());
  // An ABSENT rejoinToken is JS undefined and an explicit null is not; find()
  // answers nullptr for both absent and undefined, which is exactly the
  // distinction claim_plan turns on.
  const Value* token = hello.type == Value::OBJ ? hello.find("rejoinToken") : nullptr;
  const ns::ClaimPlan plan = ns::claim_plan(fromId, token, hasOld != 0, oldDisconnected != 0);
  Value out = Value::Obj();
  out.set("claim", Value::Bool(plan.claim));
  if (plan.claim) {
    out.set("oldId", Value::Num(plan.oldId));
    out.set("restamp", Value::Bool(plan.restamp));
  }
  return put(g_bufClaim, out);
}

const char* ttp_net_resync_plan_json(const char* rosterIdsJson, const char* relayPeersJson) {
  const ns::ResyncPlan plan = ns::resync_plan(numbersOf(rosterIdsJson), numbersOf(relayPeersJson));
  Value expire = Value::Arr();
  for (double id : plan.expire) expire.push(Value::Num(id));
  Value add = Value::Arr();
  for (double id : plan.add) add.push(Value::Num(id));
  Value out = Value::Obj();
  out.set("expire", std::move(expire));
  out.set("add", std::move(add));
  out.set("publish", Value::Bool(plan.publish));
  return put(g_bufResync, out);
}
