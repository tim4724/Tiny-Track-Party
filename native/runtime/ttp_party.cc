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

// A peer id crosses as a JSON scalar: "3" is numeric, "\"abc\"" is a string,
// "null"/nullptr is absent. Numbers and strings stay distinct keys, like JS.
PeerId peerFrom(const char* json) {
  if (!json || !*json) return PeerId::None();
  bool ok = false;
  Value v = json::parse(json, &ok);
  if (!ok) return PeerId::None();
  if (v.type == Value::NUM) return PeerId::Num(v.num);
  if (v.type == Value::STR) return PeerId::Str(v.str);
  return PeerId::None();
}

const char* ret(RoomHandle* rh, Value v) {
  rh->scratch = canonical_stringify(v);
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
  const Player* p = rh->flow->addPlayer(peerFrom(peerIdJson), fields);
  return p ? ret(rh, p->toValue()) : "null";
}

void ttp_room_remove_player(int h, const char* peerIdJson) {
  RoomHandle* rh = room(h);
  if (rh) rh->flow->removePlayer(peerFrom(peerIdJson));
}

int ttp_room_rekey(int h, const char* oldIdJson, const char* newIdJson) {
  RoomHandle* rh = room(h);
  return (rh && rh->flow->rekey(peerFrom(oldIdJson), peerFrom(newIdJson))) ? 1 : 0;
}

int ttp_room_set_field(int h, const char* peerIdJson, const char* key, const char* valueJson) {
  RoomHandle* rh = room(h);
  if (!rh || !key) return 0;
  bool ok = false;
  Value v = json::parse(valueJson, &ok);
  if (!ok) return 0;
  return rh->flow->setField(peerFrom(peerIdJson), key, std::move(v)) ? 1 : 0;
}

void ttp_room_mark_disconnected(int h, const char* peerIdJson) {
  RoomHandle* rh = room(h);
  if (rh) rh->flow->markDisconnected(peerFrom(peerIdJson));
}

void ttp_room_mark_reconnected(int h, const char* peerIdJson) {
  RoomHandle* rh = room(h);
  if (rh) rh->flow->markReconnected(peerFrom(peerIdJson));
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
  if (rh) rh->flow->onSeen(peerFrom(peerIdJson), nowMs);
}

int ttp_room_is_expired(int h, const char* peerIdJson, double nowMs) {
  RoomHandle* rh = room(h);
  return (rh && rh->flow->isExpired(peerFrom(peerIdJson), nowMs)) ? 1 : 0;
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
  if (rh) rh->flow->setMasterValue(peerFrom(peerIdJson));
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
  return (rh && rh->flow->isHost(peerFrom(peerIdJson))) ? 1 : 0;
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
  return (rh && rh->flow->has(peerFrom(peerIdJson))) ? 1 : 0;
}

int ttp_room_is_disconnected(int h, const char* peerIdJson) {
  RoomHandle* rh = room(h);
  return (rh && rh->flow->isDisconnected(peerFrom(peerIdJson))) ? 1 : 0;
}

const char* ttp_room_get_json(int h, const char* peerIdJson) {
  RoomHandle* rh = room(h);
  if (!rh) return "null";
  const Player* p = rh->flow->get(peerFrom(peerIdJson));
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
