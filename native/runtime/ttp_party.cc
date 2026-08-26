// ttp_party.cc — the party ABI over native/libttp-party's RoomFlow.
//
// Shape mirrors ttp_runtime.cc: a handle map of owned objects, one scratch string
// per handle for const char* returns, JSON-scalar ids, canonical JSON out. The
// one structural difference is events: RoomFlow emits through a callback, so each
// handle owns a queue the callback appends to and ttp_room_events_json drains —
// preserving exact intra-op emission order, which is contract (fp-profile §party).
#include "ttp_party.h"
#include "ttp_runtime.h"

#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "ttp/contract.h"
#include "ttp/canonical.h"
#include "ttp/fastlane.h"
#include "ttp/json_parse.h"
#include "ttp/json_read.h"
// The shared constant tables, for ttp_protocol_manifest_json. A C++ layer just
// includes this header; the export exists for shells that cannot.
#include "ttp/protocol.h"
#include "ttp/relay_framing.h"
#include "ttp/room_flow.h"
// The live race, for ttp_room_sync_active_order and ttp_room_in_race_flags: who
// is PLAYING is a fact about the sim, and both the room's participant order and
// each seat's inRace flag are decisions over it. Read through the internal seam,
// never through a serialized snapshot.
#include "ttp/game.h"
#include "ttp_room.h"
#include "ttp_session.h"

using namespace ttp;


namespace {

struct RoomHandle {
  std::unique_ptr<RoomFlow> flow;
  std::vector<std::pair<std::string, Value>> events;  // emission-ordered queue
  std::string scratch;                                // backs const char* returns
  // The lobby pick the net walks decide ({mode,cupId,randomRaces,trackId,
  // hasBag}, explicit nulls — strictEquals reads them). SHIM state, not
  // RoomFlow's: the frozen party corpora know no pick, and the walks are its
  // only writers (ttp_room_store_pick). Shells read ttp_net_pick_json.
  Value pick = Value::Obj();
  // The random-track SHUFFLE BAG ({seed, deck:[ids], cursor}), seeded once by
  // the shell (ttp_net_init_pick) and drawn ONLY by the walks — "random walks
  // the whole catalogue before any repeat" lives here now, so no shell owns a
  // draw protocol. Empty object until seeded.
  Value bag = Value::Obj();
  // The live cup series: a ttp_gp_create handle the RACE walks own (create on
  // launch, advance/apply/rekey mid-cup, dispose on the way out). 0 = single
  // race. Shells read ttp_race_series_state_json; no shell holds the handle.
  int series = 0;
  // The launched race FIELD (the rows every standings board is composed from),
  // retained here because the AI racers exist in no roster the room knows.
  // Written by the launch walks; repaired in place by the rename and rekey
  // walks; cleared with the race. Null outside a race.
  Value field = Value::Null();
  // The composed STANDINGS BOARD the phones' results overlay reads (the lobby
  // frame injects it under `standings`). Written by the race walk's executor,
  // patched in place by the rename walk and by the settled stamp, cleared by
  // the statechange walk. Null outside a race.
  //
  // ON THE ROOM AND NOT ON THE SESSION deliberately — see ttp_room.h: the
  // results screen and the phones' copy of the board outlive the race that made
  // it, so a board that died with the session would blank every phone
  // mid-podium.
  Value board = Value::Null();
};

std::map<int, std::unique_ptr<RoomHandle>> g_rooms;
int g_nextHandle = 1;

RoomHandle* room(int h) {
  auto it = g_rooms.find(h);
  return it == g_rooms.end() ? nullptr : it->second.get();
}

const char* ret(RoomHandle* rh, Value v) {
  canonical_stringify_into(v, rh->scratch);
  return rh->scratch.c_str();
}

}  // namespace

// ---- lifecycle --------------------------------------------------------------

int ttp_room_create(const char* configJson) {
  RoomFlow::Config cfg;
  if (configJson && *configJson) {
    bool ok = false;
    Value c = json::parse(configJson, &ok);
    if (ok && c.type == Value::OBJ) {
      for (const auto& kv : c.obj) {
        if (kv.first == "master") {
          // PRESENCE of the key means a masterProvider exists; its value (which
          // may be null) is the initial master.
          cfg.hasMasterProvider = true;
          if (kv.second.type == Value::NUM) cfg.master = PeerId::Num(kv.second.num);
          else if (kv.second.type == Value::STR) cfg.master = PeerId::Str(kv.second.str);
        } else if (kv.first == "liveness" && kv.second.type == Value::OBJ) {
          cfg.hasLiveness = true;
          for (const auto& lk : kv.second.obj) {
            if (lk.first == "timeoutMs" && lk.second.type == Value::NUM) cfg.timeoutMs = lk.second.num;
            else if (lk.first == "graceMs" && lk.second.type == Value::NUM) cfg.graceMs = lk.second.num;
            else if (lk.first == "useEnabledProvider" && lk.second.type == Value::BOOL)
              cfg.hasEnabledProvider = lk.second.b;
          }
        }
      }
    }
  }

  auto rh = std::make_unique<RoomHandle>();
  RoomHandle* raw = rh.get();
  rh->flow = std::make_unique<RoomFlow>(cfg, [raw](const std::string& type, const Value& detail) {
    raw->events.emplace_back(type, detail);
  });
  const int h = g_nextHandle++;
  g_rooms[h] = std::move(rh);
  return h;
}

void ttp_room_dispose(int h) {
  // The room owns its series: a party ending must not leak a GrandPrix.
  if (RoomHandle* rh = room(h)) {
    if (rh->series) ttp_gp_dispose(rh->series);
  } g_rooms.erase(h); }

// ---- roster -----------------------------------------------------------------

const char* ttp_room_add_player(int h, const char* peerIdJson, const char* fieldsJsonOrNull) {
  RoomHandle* rh = room(h);
  if (!rh) return "null";
  std::vector<std::pair<std::string, Value>> fields;
  if (fieldsJsonOrNull && *fieldsJsonOrNull) {
    bool ok = false;
    Value f = json::parse(fieldsJsonOrNull, &ok);
    if (ok && f.type == Value::OBJ) fields = f.obj;
  }
  const Player* p = rh->flow->addPlayer(parse_scalar_id(peerIdJson), fields);
  return p ? ret(rh, p->toValue()) : "null";
}

int ttp_room_set_field(int h, const char* peerIdJson, const char* key, const char* valueJson) {
  RoomHandle* rh = room(h);
  if (!rh || !key) return 0;
  bool ok = false;
  Value v = json::parse(valueJson, &ok);
  if (!ok) return 0;
  return rh->flow->setField(parse_scalar_id(peerIdJson), key, std::move(v)) ? 1 : 0;
}

// ---- lifecycle / state ------------------------------------------------------

int ttp_room_transition_to(int h, const char* stateName) {
  RoomHandle* rh = room(h);
  if (!rh || !stateName) return 0;
  return rh->flow->transitionTo(stateName) ? 1 : 0;
}

const char* ttp_room_state(int h) {
  RoomHandle* rh = room(h);
  // "" for an unknown handle — the same spelling the internal seam
  // (ttp_room_state_name) has always used, so every reader treats the two
  // paths identically. It used to answer the literal "null", which forced a
  // carve-out in abi_check's frame comparison.
  if (!rh) return "";
  rh->scratch = rh->flow->stateName();
  return rh->scratch.c_str();
}

// ---- the internal seam (ttp_room.h) -----------------------------------------
// The same read, generalized: a room handle plus a session handle is everything
// needed to describe the room to a phone or a screen, and both answers are taken
// HERE rather than reassembled by whichever shell asked. See ttp_room.h.

// syncActiveOrder against the LIVE RACE: every seat holding a car, plus every
// dropped seat. Was an ABI export; the walks and the synced reads below are
// its only callers now, so it lives on the seam.
void ttp_room_sync_active_order(int h, int sessionHandle) {
  RoomHandle* rh = room(h);
  if (!rh) return;
  std::vector<PeerId> active;
  if (Game* g = ttp_session_engine(sessionHandle)) {
    for (const auto& c : g->cars()) active.push_back(c->id);
  }
  rh->flow->syncActiveOrder(active);
}

Value ttp_room_roster_value(int roomHandle) {
  RoomHandle* rh = room(roomHandle);
  return rh ? rh->flow->listValue() : Value::Arr();
}

Value ttp_room_in_race_flags(const Value& roster, int sessionHandle) {
  Value flags = Value::Arr();
  if (roster.type != Value::ARR) return flags;
  Game* g = ttp_session_engine(sessionHandle);
  for (const Value& seat : roster.arr) {
    const Id id = json::id_of<Id>(seat.find("peerIndex"));
    flags.push(Value::Bool(g && !id.isNull() && g->hasCar(id)));
  }
  return flags;
}

Value ttp_room_host_value(int roomHandle) {
  RoomHandle* rh = room(roomHandle);
  return rh ? rh->flow->host().toValue() : Value::Null();
}

std::string ttp_room_state_name(int roomHandle) {
  RoomHandle* rh = room(roomHandle);
  return rh ? rh->flow->stateName() : std::string();
}

Value ttp_room_has_flags(int roomHandle, const Value& carIds) {
  Value flags = Value::Arr();
  if (carIds.type != Value::ARR) return flags;
  RoomHandle* rh = room(roomHandle);
  for (const Value& idV : carIds.arr) {
    const PeerId id = json::id_of<PeerId>(&idV);
    flags.push(Value::Bool(rh && !id.isNull() && rh->flow->has(id)));
  }
  return flags;
}

Value ttp_room_disconnected_flags(int roomHandle, const Value& carIds) {
  Value flags = Value::Arr();
  if (carIds.type != Value::ARR) return flags;
  RoomHandle* rh = room(roomHandle);
  for (const Value& idV : carIds.arr) {
    const PeerId id = json::id_of<PeerId>(&idV);
    flags.push(Value::Bool(rh && !id.isNull() && rh->flow->isDisconnected(id)));
  }
  return flags;
}

Value ttp_room_late_joiners_synced(int roomHandle, int sessionHandle) {
  RoomHandle* rh = room(roomHandle);
  if (!rh) return Value::Arr();
  ttp_room_sync_active_order(roomHandle, sessionHandle);
  return rh->flow->lateJoinersValue();
}

int ttp_room_all_participants_disconnected_synced(int roomHandle, int sessionHandle) {
  RoomHandle* rh = room(roomHandle);
  if (!rh) return 0;
  ttp_room_sync_active_order(roomHandle, sessionHandle);
  return rh->flow->allParticipantsDisconnected() ? 1 : 0;
}

RoomFlow* ttp_room_flow(int roomHandle) {
  RoomHandle* rh = room(roomHandle);
  return rh ? rh->flow.get() : nullptr;
}

Value ttp_room_pick_value(int roomHandle) {
  RoomHandle* rh = room(roomHandle);
  return rh ? rh->pick : Value::Obj();
}

void ttp_room_store_pick(int roomHandle, Value pick) {
  RoomHandle* rh = room(roomHandle);
  if (rh) rh->pick = std::move(pick);
}

Value ttp_room_bag_value(int roomHandle) {
  RoomHandle* rh = room(roomHandle);
  return rh ? rh->bag : Value::Obj();
}

void ttp_room_store_bag(int roomHandle, Value bag) {
  RoomHandle* rh = room(roomHandle);
  if (rh) rh->bag = std::move(bag);
}

int ttp_room_series(int roomHandle) {
  RoomHandle* rh = room(roomHandle);
  return rh ? rh->series : 0;
}

void ttp_room_store_series(int roomHandle, int gpHandle) {
  RoomHandle* rh = room(roomHandle);
  if (!rh) return;
  if (rh->series && rh->series != gpHandle) ttp_gp_dispose(rh->series);
  rh->series = gpHandle;
}

Value ttp_room_field_value(int roomHandle) {
  RoomHandle* rh = room(roomHandle);
  return rh ? rh->field : Value::Null();
}

void ttp_room_store_field(int roomHandle, Value field) {
  RoomHandle* rh = room(roomHandle);
  if (rh) rh->field = std::move(field);
}

Value ttp_room_board_value(int roomHandle) {
  RoomHandle* rh = room(roomHandle);
  return rh ? rh->board : Value::Null();
}

void ttp_room_store_board(int roomHandle, Value board) {
  RoomHandle* rh = room(roomHandle);
  if (rh) rh->board = std::move(board);
}

// ---- provider setters -------------------------------------------------------

void ttp_room_set_master(int h, const char* peerIdJson) {
  RoomHandle* rh = room(h);
  if (rh) rh->flow->setMasterValue(parse_scalar_id(peerIdJson));
}

void ttp_room_set_liveness_enabled(int h, int enabled) {
  RoomHandle* rh = room(h);
  if (rh) rh->flow->setLivenessEnabled(enabled != 0);
}

// ---- read accessors ---------------------------------------------------------

const char* ttp_room_host_json(int h) {
  RoomHandle* rh = room(h);
  if (!rh) return "null";
  return ret(rh, rh->flow->host().toValue());
}

const char* ttp_room_list_json(int h) {
  RoomHandle* rh = room(h);
  if (!rh) return "[]";
  return ret(rh, rh->flow->listValue());
}

const char* ttp_room_events_json(int h) {
  RoomHandle* rh = room(h);
  if (!rh) return "[]";
  Value arr = Value::Arr();
  for (const auto& ev : rh->events) {
    Value e = Value::Obj();
    e.set("type", Value::Str(ev.first));
    e.set("detail", ev.second);
    arr.push(std::move(e));
  }
  rh->events.clear();
  return ret(rh, std::move(arr));
}

// =============================================================================
// RELAY FRAMING — stateless; each entry point owns its scratch buffer.
// =============================================================================
namespace {
// One buffer per entry point (not one shared buffer) so a host that holds two
// results at once — e.g. encoding while inspecting a classify — can't have the
// first clobbered by the second.
std::string g_bufCreate, g_bufJoin, g_bufSendTo, g_bufBroadcast, g_bufSetState,
    g_bufCloseRoom, g_bufClassify, g_bufCloseOutcome, g_bufPinUrl;

const char* put(std::string& buf, const Value& v) {
  buf = canonical_stringify(v);
  return buf.c_str();
}
}  // namespace

const char* ttp_framing_encode_create(const char* clientId, double maxClients, const char* urlOrNull) {
  std::string url;
  const bool hasUrl = urlOrNull && *urlOrNull;
  if (hasUrl) url = urlOrNull;
  return put(g_bufCreate,
             framing::encode_create(clientId ? clientId : "", maxClients, hasUrl ? &url : nullptr));
}

const char* ttp_framing_encode_join(const char* clientId, const char* room) {
  return put(g_bufJoin, framing::encode_join(clientId ? clientId : "", room ? room : ""));
}

const char* ttp_framing_encode_send_to(const char* toJson, const char* dataJson) {
  return put(g_bufSendTo,
             framing::encode_send_to(json::parse_or(toJson, Value::Null()), json::parse_or(dataJson, Value::Null())));
}

const char* ttp_framing_encode_broadcast(const char* dataJson) {
  return put(g_bufBroadcast, framing::encode_broadcast(json::parse_or(dataJson, Value::Null())));
}

const char* ttp_framing_encode_set_state(const char* dataJson) {
  return put(g_bufSetState, framing::encode_set_state(json::parse_or(dataJson, Value::Null())));
}

const char* ttp_framing_encode_close_room(void) {
  return put(g_bufCloseRoom, framing::encode_close_room());
}

const char* ttp_framing_classify(const char* frameText) {
  bool ok = false;
  Value frame = frameText && *frameText ? json::parse(frameText, &ok) : Value::Null();
  Value out = Value::Obj();
  if (!ok || frame.type != Value::OBJ) {
    // Not a JSON object — malformed text, or valid JSON that is a scalar or array.
    // Both are dropped. The kit only agrees with this since the typeof guard in
    // PartyConnection.js's onmessage: before it, `null` threw a TypeError out of the
    // handler and `7`/`"x"`/`[1,2]` reached onProtocol with an undefined type. The
    // raw-text cases in framing-corpus.jsonl pin the agreed behaviour.
    out.set("route", Value::Str("none"));
    return put(g_bufClassify, out);
  }
  framing::Inbound in = framing::classify_inbound(frame);
  if (in.route == framing::Inbound::MESSAGE) {
    out.set("route", Value::Str("message"));
    out.set("from", in.from);
    out.set("data", in.data);
  } else if (in.route == framing::Inbound::STATE) {
    out.set("route", Value::Str("state"));
    out.set("data", in.data);
  } else {
    out.set("route", Value::Str("protocol"));
    out.set("type", in.type);
    out.set("msg", in.msg);
  }
  return put(g_bufClassify, out);
}

const char* ttp_framing_close_outcome(int hasCode, double code, double attemptBefore,
                                      double maxAttempts, int shouldReconnectBefore) {
  framing::CloseOutcome c = framing::close_outcome(hasCode != 0, code, attemptBefore, maxAttempts,
                                                   shouldReconnectBefore != 0);
  Value o = Value::Obj();
  o.set("stopReconnect", Value::Bool(c.stopReconnect));
  o.set("closeAttempt", Value::Num(c.closeAttempt));
  o.set("closeMax", Value::Num(c.closeMax));
  o.set("meta", c.meta);
  o.set("willReconnect", Value::Bool(c.willReconnect));
  return put(g_bufCloseOutcome, o);
}

double ttp_framing_backoff_ms(double attempt) { return framing::backoff_delay_ms(attempt); }
double ttp_framing_max_reconnect_attempts(void) { return framing::MAX_RECONNECT_ATTEMPTS; }

const char* ttp_framing_pin_url(const char* base, const char* room, const char* instance) {
  g_bufPinUrl = framing::pin_instance_url(base ? base : "", room ? room : "",
                                          instance ? instance : "");
  return g_bufPinUrl.c_str();
}

// =============================================================================
// FASTLANE NETCODE — one handle per peer link.
// =============================================================================
namespace {
struct LinkHandle {
  fastlane::Link link;
  std::string scratch;
};
std::map<int, std::unique_ptr<LinkHandle>> g_links;
int g_nextLink = 1;

LinkHandle* linkOf(int h) {
  auto it = g_links.find(h);
  return it == g_links.end() ? nullptr : it->second.get();
}

const char* outcomeJson(LinkHandle* lh, const fastlane::Outcome& oc) {
  Value o = Value::Obj();
  o.set("sent", Value::Bool(oc.sent));
  o.set("packet", oc.sent ? oc.packet : Value::Null());
  Value applied = Value::Arr();
  for (const Value& ev : oc.applied) applied.push(ev);
  o.set("applied", std::move(applied));
  o.set("rtt", oc.hasRtt ? Value::Num(oc.rtt) : Value::Null());
  o.set("dropped", Value::Bool(oc.dropped));
  canonical_stringify_into(o, lh->scratch);
  return lh->scratch.c_str();
}
const char* EMPTY_OUTCOME = "{\"applied\":[],\"dropped\":false,\"packet\":null,\"rtt\":null,\"sent\":false}";
}  // namespace

int ttp_link_create(void) {
  const int h = g_nextLink++;
  g_links[h] = std::make_unique<LinkHandle>();
  return h;
}

void ttp_link_dispose(int h) { g_links.erase(h); }

void ttp_link_set_channel_open(int h, int open) {
  LinkHandle* lh = linkOf(h);
  if (lh) lh->link.setChannelOpen(open != 0);
}

const char* ttp_link_enqueue(int h, const char* evJson, double nowMs) {
  LinkHandle* lh = linkOf(h);
  if (!lh) return EMPTY_OUTCOME;
  return outcomeJson(lh, lh->link.enqueue(json::parse_or(evJson, Value::Null()), nowMs));
}

const char* ttp_link_send_tick(int h, double nowMs) {
  LinkHandle* lh = linkOf(h);
  if (!lh) return EMPTY_OUTCOME;
  return outcomeJson(lh, lh->link.sendDataPacket(nowMs));
}

const char* ttp_link_idle(int h, double nowMs) {
  LinkHandle* lh = linkOf(h);
  if (!lh) return EMPTY_OUTCOME;
  return outcomeJson(lh, lh->link.sendIdleHeartbeat(nowMs));
}

const char* ttp_link_inbound(int h, const char* packetText, double nowMs) {
  LinkHandle* lh = linkOf(h);
  if (!lh) return EMPTY_OUTCOME;
  bool ok = false;
  Value pkt = packetText && *packetText ? json::parse(packetText, &ok) : Value::Null();
  if (!ok) pkt = Value::Null();  // non-object: Link ignores it (and counts nothing)
  return outcomeJson(lh, lh->link.handleInbound(pkt, nowMs));
}

const char* ttp_link_stats_json(int h) {
  LinkHandle* lh = linkOf(h);
  if (!lh) return "null";
  const fastlane::Stats& s = lh->link.stats();
  Value o = Value::Obj();
  o.set("out", Value::Num(s.out));
  o.set("received", Value::Num(s.received));
  o.set("lastPsSeen", Value::Num(s.lastPsSeen));
  canonical_stringify_into(o, lh->scratch);
  return lh->scratch.c_str();
}

// ---- statics ----------------------------------------------------------------

const char* ttp_party_version(void) {
  static std::string buf;
  Value o = Value::Obj();
  o.set("contractVersion", Value::Num(static_cast<double>(CONTRACT_VERSION)));
  o.set("layer", Value::Str("party"));
  buf = canonical_stringify(o);
  return buf.c_str();
}

const char* ttp_protocol_manifest_json(void) {
  // Built once: the tables are compile-time constants, so a shell may call this
  // at boot and keep the parsed result for the life of the process.
  static const std::string buf = canonical_stringify(protocol::manifest());
  return buf.c_str();
}
