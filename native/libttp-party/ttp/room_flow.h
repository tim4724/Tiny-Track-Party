// RoomFlow — the C++ twin of partyplug/RoomFlow.js. Owns room state, roster
// identity/join order, presence, and host election for libttp-party (the sans-IO
// room-semantics layer: sockets/RTC/framing are injected elsewhere). It does not
// own DOM, transport, timers, or game fields (color/name/score); those ride as
// opaque data on the live player record.
//
// A discrete state machine — no floating-point subtleties. The porting risks it
// preserves are ORDER and IDENTITY: order-preserving roster (Map insertion order,
// modeled as a vector), JSON-scalar peer identity (number vs string distinct),
// joinedAt tiebreaks in host election, the sticky host slot vs the effective
// `host` fallback chain, and the EXACT event emission order within one op.
// Detectors (onSeen/isExpired/expiredPeers/graceTick) are pure predicates that
// never mutate roster/presence and never emit — the single-writer invariant.
#pragma once

#include <cmath>
#include <functional>
#include <string>
#include <utility>
#include <vector>

#include "ttp/canonical.h"  // ttp::Value (header-only struct; canonical_stringify not needed here)
#include "ttp/scalar_id.h"

namespace ttp {

// A room peer index. NONE models JS null/undefined (no host, an unset master).
using PeerId = ScalarId;

// A live player record. peerIndex/joinedAt/connected are kit-owned (protected on
// reconnect); `fields` is the opaque game data (name, colorIndex, ...) merged by
// addPlayer, never read by RoomFlow. toValue() reassembles the full JSON object.
struct Player {
  PeerId peerIndex;
  double joinedAt = 0;
  bool connected = true;
  std::vector<std::pair<std::string, Value>> fields;  // excludes the 3 kit keys
  Value toValue() const;
};

// RoomFlow.lowestFreeSlot — the lowest free DENSE slot in [0, max), or -1 when
// all are taken. Callers pass slot values (colour/seat indices), never peer
// indices, so sparse transport ids can't become colour ids. `used` membership is
// JS Set semantics (SameValueZero); non-integer or out-of-range entries simply
// never match a probed slot. Static on the JS class, free function here.
int lowest_free_slot(const std::vector<double>& used, int max);

class RoomFlow {
 public:
  enum class State { LOBBY, COUNTDOWN, PLAYING, RESULTS };

  // Construction config. masterProvider/enabledProvider are modeled as settable
  // values (driven by setMasterValue/setLivenessEnabled), matching the corpus
  // generator's closures. timeoutMs defaults to Infinity (liveness absent = expiry
  // never fires); graceMs defaults to 0.
  struct Config {
    bool hasMasterProvider = false;
    PeerId master = PeerId::None();  // initial master value
    bool hasLiveness = false;
    double timeoutMs = INFINITY;
    double graceMs = 0;
    bool hasEnabledProvider = false;
  };

  // type + detail, in emission order. Detail keys mirror RoomFlow.js.
  using EmitFn = std::function<void(const std::string& type, const Value& detail)>;

  RoomFlow(const Config& cfg, EmitFn emit);

  // ---- roster ---------------------------------------------------------------
  const Player* addPlayer(const PeerId& peerIndex,
                          const std::vector<std::pair<std::string, Value>>& fields);
  void removePlayer(const PeerId& peerIndex);
  bool rekey(const PeerId& oldId, const PeerId& newId);
  void markDisconnected(const PeerId& peerIndex);
  void markReconnected(const PeerId& peerIndex);
  void clearDisconnected(bool hasNow, double nowMs);

  // ---- lifecycle ------------------------------------------------------------
  bool transitionTo(const std::string& to);
  bool endGame() { return transitionTo("results"); }
  bool returnToLobby() { return transitionTo("lobby"); }
  void setActiveOrder(const std::vector<PeerId>& peerIndices);

  // ---- liveness (pure predicates) ------------------------------------------
  void onSeen(const PeerId& peerIndex, double nowMs);
  bool isExpired(const PeerId& peerIndex, double nowMs) const;
  std::vector<PeerId> expiredPeers(double nowMs) const;
  bool allParticipantsDisconnected() const;
  bool hasLateJoiners() const;
  // WHO the late joiners are — the same roster-minus-active-order set
  // hasLateJoiners() tests, as records in list() order. A shell that renders
  // "waiting for the next race" rows must read them from here, so the rows and
  // the graceTick policy can never disagree about who is waiting.
  Value lateJoinersValue() const;
  bool graceTick(double nowMs);

  // ---- provider setters -----------------------------------------------------
  void setMasterValue(const PeerId& v) { masterValue_ = v; }
  void setLivenessEnabled(bool v) { livenessEnabled_ = v; }

  // ---- read accessors -------------------------------------------------------
  State state() const { return state_; }
  std::string stateName() const;
  PeerId host() const;               // effective host (getter fallback chain)
  bool isHost(const PeerId& peerIndex) const;
  size_t size() const { return players_.size(); }
  int connectedCount() const;
  Value listValue() const;           // roster sorted by joinedAt, as a Value::Arr
  bool has(const PeerId& peerIndex) const { return find(peerIndex) != nullptr; }

  // Write one opaque game field onto a live record. The JS kit hands out MUTABLE
  // player records and the game writes fields straight onto them (`flow.get(p)
  // .ready = true`) — this is that write, for hosts that can't share the object.
  // Emits nothing, exactly like the property assignment it replaces. Kit-owned
  // keys (peerIndex/joinedAt/connected) are refused, as they are on addPlayer.
  // Returns false for an unknown peer or a kit key.
  bool setField(const PeerId& peerIndex, const std::string& key, Value v);
  bool isDisconnected(const PeerId& peerIndex) const { return discHas(peerIndex); }
  const Player* get(const PeerId& peerIndex) const { return find(peerIndex); }

  void reset();

 private:
  // roster storage keeps Map INSERTION ORDER (players_ is a vector); lookups are
  // linear (peer counts are tiny), matching JS Map get/has/set/delete semantics.
  Player* find(const PeerId& id);
  const Player* find(const PeerId& id) const;
  void erasePlayer(const PeerId& id);  // Map.delete

  bool discHas(const PeerId& id) const;
  void discAdd(const PeerId& id);
  void discDelete(const PeerId& id);

  bool lastSeenHas(const PeerId& id) const;
  bool lastSeenGet(const PeerId& id, double& out) const;
  void lastSeenSet(const PeerId& id, double v);
  void lastSeenDelete(const PeerId& id);

  bool inActiveOrder(const PeerId& id) const;  // the late-joiner test, once
  bool restricted() const;
  bool isEligible(const PeerId& id, const std::vector<PeerId>* eligible) const;
  PeerId oldestEligible(const std::vector<PeerId>* eligible, const PeerId* exclude) const;
  PeerId electNextHost(const PeerId* exclude) const;
  void reconcileStickyHost();
  void snapshotOrder();

  void emit(const std::string& type, Value detail) { if (emit_) emit_(type, std::move(detail)); }
  void emitHostchange();  // { hostPeerIndex: host() }
  void emitRosterchange();  // { players: list() }

  static bool isKitKey(const std::string& k);

  Config cfg_;
  EmitFn emit_;

  State state_ = State::LOBBY;
  std::vector<Player> players_;      // peerIndex -> record, insertion-ordered
  PeerId hostPeerIndex_ = PeerId::None();  // sticky host slot (raw; see host())
  double joinSeq_ = 0;               // monotonic joinedAt source
  std::vector<PeerId> disconnected_; // membership set (order irrelevant)
  std::vector<PeerId> order_;        // active participants (snapshot / setActiveOrder)
  std::vector<std::pair<PeerId, double>> lastSeen_;  // peerIndex -> last nowMs
  bool hasGraceDeadline_ = false;
  double graceDeadline_ = 0;

  PeerId masterValue_ = PeerId::None();  // live master (setMasterValue)
  bool livenessEnabled_ = true;          // live enabled flag (setLivenessEnabled)
};

}  // namespace ttp
