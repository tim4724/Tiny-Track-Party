#include "ttp/room_flow.h"

#include <algorithm>

namespace ttp {

// ---- Player serialization ---------------------------------------------------
Value Player::toValue() const {
  Value o = Value::Obj();
  for (const auto& kv : fields) o.set(kv.first, kv.second);
  o.set("peerIndex", peerIndex.toValue());
  o.set("joinedAt", Value::Num(joinedAt));
  o.set("connected", Value::Bool(connected));
  return o;
}

// ---- valid transitions ------------------------------------------------------
// LOBBY -> [COUNTDOWN]; COUNTDOWN -> [PLAYING, LOBBY];
// PLAYING -> [RESULTS, LOBBY]; RESULTS -> [COUNTDOWN, LOBBY].
static bool transitionAllowed(const std::string& from, const std::string& to) {
  if (from == "lobby") return to == "countdown";
  if (from == "countdown") return to == "playing" || to == "lobby";
  if (from == "playing") return to == "results" || to == "lobby";
  if (from == "results") return to == "countdown" || to == "lobby";
  return false;
}

// ============================================================================
RoomFlow::RoomFlow(const Config& cfg, EmitFn emit) : cfg_(cfg), emit_(std::move(emit)) {
  masterValue_ = cfg_.master;
}

bool RoomFlow::isKitKey(const std::string& k) {
  return k == "peerIndex" || k == "joinedAt" || k == "connected";
}

std::string RoomFlow::stateName() const {
  switch (state_) {
    case State::LOBBY: return "lobby";
    case State::COUNTDOWN: return "countdown";
    case State::PLAYING: return "playing";
    case State::RESULTS: return "results";
  }
  return "lobby";
}

// ---- roster storage helpers (JS Map semantics over an ordered vector) -------
Player* RoomFlow::find(const PeerId& id) {
  for (auto& p : players_) if (p.peerIndex == id) return &p;
  return nullptr;
}
const Player* RoomFlow::find(const PeerId& id) const {
  for (const auto& p : players_) if (p.peerIndex == id) return &p;
  return nullptr;
}
void RoomFlow::erasePlayer(const PeerId& id) {
  for (size_t i = 0; i < players_.size(); i++)
    if (players_[i].peerIndex == id) { players_.erase(players_.begin() + i); return; }
}

bool RoomFlow::discHas(const PeerId& id) const {
  for (const auto& d : disconnected_) if (d == id) return true;
  return false;
}
void RoomFlow::discAdd(const PeerId& id) {
  if (!discHas(id)) disconnected_.push_back(id);
}
void RoomFlow::discDelete(const PeerId& id) {
  for (size_t i = 0; i < disconnected_.size(); i++)
    if (disconnected_[i] == id) { disconnected_.erase(disconnected_.begin() + i); return; }
}

bool RoomFlow::lastSeenHas(const PeerId& id) const {
  for (const auto& kv : lastSeen_) if (kv.first == id) return true;
  return false;
}
bool RoomFlow::lastSeenGet(const PeerId& id, double& out) const {
  for (const auto& kv : lastSeen_) if (kv.first == id) { out = kv.second; return true; }
  return false;
}
void RoomFlow::lastSeenSet(const PeerId& id, double v) {
  for (auto& kv : lastSeen_) if (kv.first == id) { kv.second = v; return; }
  lastSeen_.emplace_back(id, v);
}
void RoomFlow::lastSeenDelete(const PeerId& id) {
  for (size_t i = 0; i < lastSeen_.size(); i++)
    if (lastSeen_[i].first == id) { lastSeen_.erase(lastSeen_.begin() + i); return; }
}

// ---- emit helpers -----------------------------------------------------------
void RoomFlow::emitHostchange() {
  Value d = Value::Obj();
  d.set("hostPeerIndex", host().toValue());
  emit("hostchange", std::move(d));
}
void RoomFlow::emitRosterchange() {
  Value d = Value::Obj();
  d.set("players", listValue());
  emit("rosterchange", std::move(d));
}

// ============================================================================
// Roster
// ============================================================================
const Player* RoomFlow::addPlayer(const PeerId& peerIndex,
                                  const std::vector<std::pair<std::string, Value>>& fields) {
  Player* existing = find(peerIndex);
  if (existing) {
    PeerId prevHost = host();
    // Reconnect: merge game fields (Object.assign), protect the kit-owned keys
    // (joinedAt is the election tiebreak, peerIndex is the map key), refresh
    // presence. joinedAt/peerIndex stay; connected -> true.
    for (const auto& kv : fields) {
      if (isKitKey(kv.first)) continue;
      bool set = false;
      for (auto& f : existing->fields) if (f.first == kv.first) { f.second = kv.second; set = true; break; }
      if (!set) existing->fields.emplace_back(kv.first, kv.second);
    }
    existing->connected = true;
    discDelete(peerIndex);
    if (host() != prevHost) emitHostchange();
    Value d = Value::Obj();
    d.set("player", existing->toValue());
    emit("playerupdate", std::move(d));
    emitRosterchange();
    return existing;
  }
  Player p;
  p.peerIndex = peerIndex;
  p.joinedAt = joinSeq_++;
  p.connected = true;
  for (const auto& kv : fields) if (!isKitKey(kv.first)) p.fields.emplace_back(kv.first, kv.second);
  players_.push_back(std::move(p));
  Player* added = &players_.back();
  // First joiner owns the sticky host slot (also the emptied-then-rejoined case).
  if (hostPeerIndex_.isNull()) {
    hostPeerIndex_ = peerIndex;
    emitHostchange();
  }
  Value d = Value::Obj();
  d.set("player", added->toValue());
  emit("playerjoin", std::move(d));
  emitRosterchange();
  return added;
}

void RoomFlow::removePlayer(const PeerId& peerIndex) {
  if (!find(peerIndex)) return;
  PeerId prevHost = host();
  bool wasHost = peerIndex == hostPeerIndex_;
  erasePlayer(peerIndex);
  discDelete(peerIndex);
  lastSeenDelete(peerIndex);
  for (size_t i = 0; i < order_.size(); i++)
    if (order_[i] == peerIndex) { order_.erase(order_.begin() + i); break; }
  if (wasHost && (state_ == State::LOBBY || state_ == State::RESULTS)) {
    hostPeerIndex_ = electNextHost(&peerIndex);
  }
  if (host() != prevHost) emitHostchange();
  Value d = Value::Obj();
  d.set("peerIndex", peerIndex.toValue());
  emit("playerleave", std::move(d));
  emitRosterchange();
}

bool RoomFlow::rekey(const PeerId& oldId, const PeerId& newId) {
  if (oldId == newId) return false;
  Player* rec = find(oldId);
  if (!rec) return false;
  PeerId prevHost = host();
  Player moved = *rec;               // capture before the deletes
  erasePlayer(oldId);
  erasePlayer(newId);                // drop the placeholder slot the returning peer got
  moved.peerIndex = newId;
  moved.connected = true;
  players_.push_back(std::move(moved));  // re-appended -> moves to end of Map order
  discDelete(oldId);
  discDelete(newId);
  // Keep the NEWER of the two last-seen stamps (the placeholder's is the live
  // signal; the old seat's may be a full grace window stale).
  double oldStamp = 0, newStamp = 0;
  bool hasOld = lastSeenGet(oldId, oldStamp), hasNew = lastSeenGet(newId, newStamp);
  lastSeenDelete(oldId);
  lastSeenDelete(newId);
  if (hasOld || hasNew) {
    double kept = !hasOld ? newStamp : (!hasNew ? oldStamp : std::max(oldStamp, newStamp));
    lastSeenSet(newId, kept);
  }
  for (auto& id : order_) if (id == oldId) id = newId;
  if (hostPeerIndex_ == oldId) hostPeerIndex_ = newId;
  if (host() != prevHost) emitHostchange();
  emitRosterchange();
  return true;
}

void RoomFlow::markDisconnected(const PeerId& peerIndex) {
  Player* p = find(peerIndex);
  if (!p) return;
  PeerId prevHost = host();
  p->connected = false;
  discAdd(peerIndex);
  if (host() != prevHost) emitHostchange();
  emitRosterchange();
}

void RoomFlow::markReconnected(const PeerId& peerIndex) {
  Player* p = find(peerIndex);
  if (!p) return;
  PeerId prevHost = host();
  p->connected = true;
  discDelete(peerIndex);
  if (host() != prevHost) emitHostchange();
  emitRosterchange();
}

void RoomFlow::clearDisconnected(bool hasNow, double nowMs) {
  // Re-stamp liveness on this "everyone present" transition BEFORE the early
  // return, so a controller that just went quiet isn't instantly re-expired.
  if (hasNow) {
    for (const auto& p : players_) lastSeenSet(p.peerIndex, nowMs);
  }
  if (disconnected_.empty()) return;
  PeerId prevHost = host();
  disconnected_.clear();
  for (auto& p : players_) p.connected = true;
  if (host() != prevHost) emitHostchange();
  emitRosterchange();
}

// ============================================================================
// Host election
// ============================================================================
bool RoomFlow::restricted() const {
  return (state_ == State::COUNTDOWN || state_ == State::PLAYING || state_ == State::RESULTS) &&
         !order_.empty();
}

bool RoomFlow::isEligible(const PeerId& id, const std::vector<PeerId>* eligible) const {
  if (id.isNull()) return false;
  if (!find(id)) return false;
  if (discHas(id)) return false;
  if (eligible) {
    bool in = false;
    for (const auto& e : *eligible) if (e == id) { in = true; break; }
    if (!in) return false;
  }
  return true;
}

PeerId RoomFlow::oldestEligible(const std::vector<PeerId>* eligible, const PeerId* exclude) const {
  PeerId best = PeerId::None();
  double bestJoin = INFINITY;
  for (const auto& p : players_) {  // insertion order; joinedAt is unique so ties never arise
    if (exclude && p.peerIndex == *exclude) continue;
    if (discHas(p.peerIndex)) continue;
    if (eligible) {
      bool in = false;
      for (const auto& e : *eligible) if (e == p.peerIndex) { in = true; break; }
      if (!in) continue;
    }
    if (p.joinedAt < bestJoin) { bestJoin = p.joinedAt; best = p.peerIndex; }
  }
  return best;
}

PeerId RoomFlow::host() const {
  bool r = restricted();
  std::vector<PeerId> orderSet;
  const std::vector<PeerId>* eligible = nullptr;
  if (r) { orderSet = order_; eligible = &orderSet; }
  if (cfg_.hasMasterProvider) {
    PeerId m = masterValue_;
    if (isEligible(m, eligible)) return m;
  }
  if (isEligible(hostPeerIndex_, eligible)) return hostPeerIndex_;
  return oldestEligible(eligible, nullptr);
}

bool RoomFlow::isHost(const PeerId& peerIndex) const {
  return !peerIndex.isNull() && peerIndex == host();
}

PeerId RoomFlow::electNextHost(const PeerId* exclude) const {
  std::vector<PeerId> orderSet;
  const std::vector<PeerId>* eligible = nullptr;
  if (restricted()) { orderSet = order_; eligible = &orderSet; }
  return oldestEligible(eligible, exclude);
}

void RoomFlow::reconcileStickyHost() {
  if (players_.empty()) return;
  std::vector<PeerId> orderSet;
  const std::vector<PeerId>* eligible = nullptr;
  if (restricted()) { orderSet = order_; eligible = &orderSet; }
  if (!hostPeerIndex_.isNull() && find(hostPeerIndex_) && !discHas(hostPeerIndex_)) {
    bool ok = true;
    if (eligible) {
      ok = false;
      for (const auto& e : *eligible) if (e == hostPeerIndex_) { ok = true; break; }
    }
    if (ok) return;
  }
  PeerId prev = hostPeerIndex_;
  hostPeerIndex_ = electNextHost(&hostPeerIndex_);
  if (hostPeerIndex_ != prev) emitHostchange();
}

// ============================================================================
// Lifecycle
// ============================================================================
void RoomFlow::snapshotOrder() {
  std::vector<const Player*> active;
  for (const auto& p : players_) if (!discHas(p.peerIndex)) active.push_back(&p);
  std::stable_sort(active.begin(), active.end(),
                   [](const Player* a, const Player* b) { return a->joinedAt < b->joinedAt; });
  order_.clear();
  for (const Player* p : active) order_.push_back(p->peerIndex);
}

void RoomFlow::setActiveOrder(const std::vector<PeerId>& peerIndices) {
  std::vector<PeerId> out;
  for (const auto& id : peerIndices) if (find(id)) out.push_back(id);
  order_ = std::move(out);
}

bool RoomFlow::transitionTo(const std::string& to) {
  std::string from = stateName();
  if (to == from) return true;
  if (!transitionAllowed(from, to)) return false;  // console.warn is side-channel only
  if (to == "lobby") state_ = State::LOBBY;
  else if (to == "countdown") state_ = State::COUNTDOWN;
  else if (to == "playing") state_ = State::PLAYING;
  else if (to == "results") state_ = State::RESULTS;
  if (to != "playing") { hasGraceDeadline_ = false; }
  if (to == "countdown") snapshotOrder();
  if (to == "lobby") order_.clear();
  if (to == "lobby" || to == "results") reconcileStickyHost();
  Value d = Value::Obj();
  d.set("from", Value::Str(from));
  d.set("to", Value::Str(to));
  emit("statechange", std::move(d));
  return true;
}

// ============================================================================
// Liveness (pure, nowMs-injected predicates)
// ============================================================================
void RoomFlow::onSeen(const PeerId& peerIndex, double nowMs) {
  if (find(peerIndex)) lastSeenSet(peerIndex, nowMs);
}

bool RoomFlow::isExpired(const PeerId& peerIndex, double nowMs) const {
  if (cfg_.hasEnabledProvider && !livenessEnabled_) return false;
  double stamp = 0;
  if (!lastSeenGet(peerIndex, stamp)) return false;
  return nowMs - stamp > cfg_.timeoutMs;  // strict '>' — exactly-at-timeout is alive
}

std::vector<PeerId> RoomFlow::expiredPeers(double nowMs) const {
  std::vector<PeerId> out;
  if (state_ == State::LOBBY) return out;
  for (const auto& p : players_) {  // Map key order -> return array order
    if (discHas(p.peerIndex)) continue;
    if (isExpired(p.peerIndex, nowMs)) out.push_back(p.peerIndex);
  }
  return out;
}

bool RoomFlow::allParticipantsDisconnected() const {
  if (order_.empty()) return false;
  for (const auto& id : order_) if (!discHas(id)) return false;
  return true;
}

bool RoomFlow::hasLateJoiners() const {
  for (const auto& p : players_) {
    bool inOrder = false;
    for (const auto& id : order_) if (id == p.peerIndex) { inOrder = true; break; }
    if (!inOrder) return true;
  }
  return false;
}

bool RoomFlow::graceTick(double nowMs) {
  if (state_ == State::PLAYING && allParticipantsDisconnected() && hasLateJoiners()) {
    if (!hasGraceDeadline_) { hasGraceDeadline_ = true; graceDeadline_ = nowMs + cfg_.graceMs; return false; }
    if (nowMs >= graceDeadline_) { hasGraceDeadline_ = false; return true; }
    return false;
  }
  hasGraceDeadline_ = false;
  return false;
}

// ============================================================================
// Read accessors
// ============================================================================
int RoomFlow::connectedCount() const {
  int n = 0;
  for (const auto& p : players_) if (!discHas(p.peerIndex)) n++;
  return n;
}

Value RoomFlow::listValue() const {
  std::vector<const Player*> arr;
  for (const auto& p : players_) arr.push_back(&p);
  std::stable_sort(arr.begin(), arr.end(),
                   [](const Player* a, const Player* b) { return a->joinedAt < b->joinedAt; });
  Value out = Value::Arr();
  for (const Player* p : arr) out.push(p->toValue());
  return out;
}

void RoomFlow::reset() {
  std::string prevState = stateName();
  bool hadHost = !hostPeerIndex_.isNull();
  players_.clear();
  disconnected_.clear();
  lastSeen_.clear();
  hasGraceDeadline_ = false;
  order_.clear();
  hostPeerIndex_ = PeerId::None();
  joinSeq_ = 0;
  state_ = State::LOBBY;
  if (prevState != "lobby") {
    Value d = Value::Obj();
    d.set("from", Value::Str(prevState));
    d.set("to", Value::Str("lobby"));
    emit("statechange", std::move(d));
  }
  {
    Value d = Value::Obj();
    d.set("players", Value::Arr());
    emit("rosterchange", std::move(d));
  }
  if (hadHost) {
    Value d = Value::Obj();
    d.set("hostPeerIndex", Value::Null());  // literal null, not host()
    emit("hostchange", std::move(d));
  }
}

}  // namespace ttp
