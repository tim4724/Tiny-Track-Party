// ttp_party.cc — the party ABI over native/libttp-party's RoomFlow.
//
// Shape mirrors ttp_runtime.cc: a handle map of owned objects, one scratch string
// per handle for const char* returns, JSON-scalar ids, canonical JSON out. The
// one structural difference is events: RoomFlow emits through a callback, so each
// handle owns a queue the callback appends to and ttp_room_events_json drains —
// preserving exact intra-op emission order, which is contract (fp-profile §party).
#include "ttp_party.h"

#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "ttp/canonical.h"
#include "ttp/json_parse.h"
#include "ttp/fastlane.h"
#include "ttp/relay_framing.h"
#include "ttp/room_flow.h"

using namespace ttp;

static const int CONTRACT_VERSION = 2;

namespace {

struct RoomHandle {
  std::unique_ptr<RoomFlow> flow;
  std::vector<std::pair<std::string, Value>> events;  // emission-ordered queue
  std::string scratch;                                // backs const char* returns
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

void ttp_room_dispose(int h) { g_rooms.erase(h); }

void ttp_room_reset(int h) {
  RoomHandle* rh = room(h);
  if (rh) rh->flow->reset();
}

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

void ttp_room_remove_player(int h, const char* peerIdJson) {
  RoomHandle* rh = room(h);
  if (rh) rh->flow->removePlayer(parse_scalar_id(peerIdJson));
}

int ttp_room_rekey(int h, const char* oldIdJson, const char* newIdJson) {
  RoomHandle* rh = room(h);
  return (rh && rh->flow->rekey(parse_scalar_id(oldIdJson), parse_scalar_id(newIdJson))) ? 1 : 0;
}

int ttp_room_set_field(int h, const char* peerIdJson, const char* key, const char* valueJson) {
  RoomHandle* rh = room(h);
  if (!rh || !key) return 0;
  bool ok = false;
  Value v = json::parse(valueJson, &ok);
  if (!ok) return 0;
  return rh->flow->setField(parse_scalar_id(peerIdJson), key, std::move(v)) ? 1 : 0;
}

void ttp_room_mark_disconnected(int h, const char* peerIdJson) {
  RoomHandle* rh = room(h);
  if (rh) rh->flow->markDisconnected(parse_scalar_id(peerIdJson));
}

void ttp_room_mark_reconnected(int h, const char* peerIdJson) {
  RoomHandle* rh = room(h);
  if (rh) rh->flow->markReconnected(parse_scalar_id(peerIdJson));
}

void ttp_room_clear_disconnected(int h, int hasNow, double nowMs) {
  RoomHandle* rh = room(h);
  if (rh) rh->flow->clearDisconnected(hasNow != 0, nowMs);
}

// ---- lifecycle / state ------------------------------------------------------

int ttp_room_transition_to(int h, const char* stateName) {
  RoomHandle* rh = room(h);
  if (!rh || !stateName) return 0;
  return rh->flow->transitionTo(stateName) ? 1 : 0;
}

const char* ttp_room_state(int h) {
  RoomHandle* rh = room(h);
  if (!rh) return "null";
  rh->scratch = rh->flow->stateName();
  return rh->scratch.c_str();
}

void ttp_room_set_active_order(int h, const char* peerIdsJson) {
  RoomHandle* rh = room(h);
  if (!rh) return;
  std::vector<PeerId> order;
  if (peerIdsJson && *peerIdsJson) {
    bool ok = false;
    Value a = json::parse(peerIdsJson, &ok);
    if (ok && a.type == Value::ARR) {
      for (const Value& e : a.arr) {
        if (e.type == Value::NUM) order.push_back(PeerId::Num(e.num));
        else if (e.type == Value::STR) order.push_back(PeerId::Str(e.str));
        else order.push_back(PeerId::None());
      }
    }
  }
  rh->flow->setActiveOrder(order);
}

// ---- liveness ---------------------------------------------------------------

void ttp_room_on_seen(int h, const char* peerIdJson, double nowMs) {
  RoomHandle* rh = room(h);
  if (rh) rh->flow->onSeen(parse_scalar_id(peerIdJson), nowMs);
}

int ttp_room_is_expired(int h, const char* peerIdJson, double nowMs) {
  RoomHandle* rh = room(h);
  return (rh && rh->flow->isExpired(parse_scalar_id(peerIdJson), nowMs)) ? 1 : 0;
}

const char* ttp_room_expired_peers_json(int h, double nowMs) {
  RoomHandle* rh = room(h);
  if (!rh) return "[]";
  Value arr = Value::Arr();
  for (const PeerId& p : rh->flow->expiredPeers(nowMs)) arr.push(p.toValue());
  return ret(rh, std::move(arr));
}

int ttp_room_all_participants_disconnected(int h) {
  RoomHandle* rh = room(h);
  return (rh && rh->flow->allParticipantsDisconnected()) ? 1 : 0;
}

int ttp_room_has_late_joiners(int h) {
  RoomHandle* rh = room(h);
  return (rh && rh->flow->hasLateJoiners()) ? 1 : 0;
}

int ttp_room_grace_tick(int h, double nowMs) {
  RoomHandle* rh = room(h);
  return (rh && rh->flow->graceTick(nowMs)) ? 1 : 0;
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

int ttp_room_is_host(int h, const char* peerIdJson) {
  RoomHandle* rh = room(h);
  return (rh && rh->flow->isHost(parse_scalar_id(peerIdJson))) ? 1 : 0;
}

int ttp_room_size(int h) {
  RoomHandle* rh = room(h);
  return rh ? static_cast<int>(rh->flow->size()) : 0;
}

int ttp_room_connected_count(int h) {
  RoomHandle* rh = room(h);
  return rh ? rh->flow->connectedCount() : 0;
}

const char* ttp_room_list_json(int h) {
  RoomHandle* rh = room(h);
  if (!rh) return "[]";
  return ret(rh, rh->flow->listValue());
}

int ttp_room_has(int h, const char* peerIdJson) {
  RoomHandle* rh = room(h);
  return (rh && rh->flow->has(parse_scalar_id(peerIdJson))) ? 1 : 0;
}

int ttp_room_is_disconnected(int h, const char* peerIdJson) {
  RoomHandle* rh = room(h);
  return (rh && rh->flow->isDisconnected(parse_scalar_id(peerIdJson))) ? 1 : 0;
}

const char* ttp_room_get_json(int h, const char* peerIdJson) {
  RoomHandle* rh = room(h);
  if (!rh) return "null";
  const Player* p = rh->flow->get(parse_scalar_id(peerIdJson));
  return p ? ret(rh, p->toValue()) : "null";
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
Value parseOr(const char* json, Value fallback) {
  if (!json || !*json) return fallback;
  bool ok = false;
  Value v = json::parse(json, &ok);
  return ok ? v : fallback;
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
             framing::encode_send_to(parseOr(toJson, Value::Null()), parseOr(dataJson, Value::Null())));
}

const char* ttp_framing_encode_broadcast(const char* dataJson) {
  return put(g_bufBroadcast, framing::encode_broadcast(parseOr(dataJson, Value::Null())));
}

const char* ttp_framing_encode_set_state(const char* dataJson) {
  return put(g_bufSetState, framing::encode_set_state(parseOr(dataJson, Value::Null())));
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
  return outcomeJson(lh, lh->link.enqueue(parseOr(evJson, Value::Null()), nowMs));
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

int ttp_room_lowest_free_slot(const char* usedJson, int max) {
  std::vector<double> used;
  if (usedJson && *usedJson) {
    bool ok = false;
    Value a = json::parse(usedJson, &ok);
    if (ok && a.type == Value::ARR) {
      for (const Value& e : a.arr) if (e.type == Value::NUM) used.push_back(e.num);
    }
  }
  return lowest_free_slot(used, max);
}

const char* ttp_party_version(void) {
  static std::string buf;
  Value o = Value::Obj();
  o.set("contractVersion", Value::Num(static_cast<double>(CONTRACT_VERSION)));
  o.set("layer", Value::Str("party"));
  buf = canonical_stringify(o);
  return buf.c_str();
}
