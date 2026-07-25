// fastlane — the C++ twin of partyplug/PartyFastlane.js's NETCODE core: the
// reliability layer that carries controller input over the peer-to-peer
// DataChannel. One `Link` models one peer link, sans-IO: it never touches a
// socket, a timer, or an RTCPeerConnection — ops take an explicit nowMs and
// RETURN the packet to write, so the platform shim owns the transport.
//
// What lives here (the byte logic):
//   * rolling send ring, newest-first, with TTL expiry as a strict suffix
//   * implicit per-event seq — es[i] = ps - i — which is what lets a packet
//     carry no per-entry seq field; only safe because both prune paths (TTL,
//     ack) truncate suffixes, keeping the ring contiguous in seq
//   * cumulative ack (pa = highest applied) + acked-suffix pruning
//   * receive-side dedup against lastAppliedEs, apply oldest-first
//   * RTT EWMA (alpha 0.1) with the [0, 500) outlier gate, surfaced as srtt/2
//   * the inbound classifier (`pa` -> ack, `h` -> data) + stats counters
//
// What does NOT live here (platform shim):
//   * the WebRTC handshake — offer/answer, perfect-negotiation glare, ICE
//   * timer SCHEDULING: the TICK_MS resend loop, the IDLE_MS heartbeat cadence
//     (and its emitIdleHeartbeat send-side gate), the WATCHDOG_MS teardown. The
//     constants are mirrored below because the shim needs them, but a Link only
//     ever acts when the shim calls it.
//   * the peer map (peerIdx -> Link) and per-peer lifetime stats aggregation
//
// Oracle: tests/fixtures/fastlane-corpus.jsonl (scripts/gen-fastlane-corpus.mjs),
// recorded by driving the REAL PartyFastlane with a controlled clock and a fake
// DataChannel. Each scripted op compares the enqueue return, the packet written,
// the events applied, the RTT sample, and a full link-state digest.
#pragma once

#include <string>
#include <vector>

#include "ttp/canonical.h"  // ttp::Value

namespace ttp {
namespace fastlane {

// Netcode parameters (PartyFastlane's module-locals). TICK/IDLE/WATCHDOG are
// cadences the shim schedules on; TTL and RTT_ALPHA are consumed here.
inline constexpr double TICK_MS = 50;
inline constexpr double TTL_MS = 300;
inline constexpr double IDLE_MS = 500;
inline constexpr double WATCHDOG_MS = 3000;
inline constexpr double RTT_ALPHA = 0.1;
// RTT samples outside [0, RTT_CUTOFF_MS) are discarded (clock jumps, very late
// acks). Strict `<`: a sample of exactly 500 is dropped.
inline constexpr double RTT_CUTOFF_MS = 500;

// What one op produced. `packet` is what the shim must write to the channel.
struct Outcome {
  bool sent = false;             // a packet was written (channel was open)
  Value packet;                  // that packet: data / heartbeat / ack
  std::vector<Value> applied;    // events surfaced to onInput, in apply order
  bool hasRtt = false;
  double rtt = 0;                // the onRtt value == srtt / 2
  bool dropped = false;          // enqueue only: true == JS 'dropped'
};

// Per-link packet counters (PartyFastlane's _stats entry). In JS these outlive
// teardown to aggregate per peerIndex; that lifetime concern is the shim's.
struct Stats {
  double out = 0;         // packets written (data + heartbeats + acks)
  double received = 0;    // well-formed packets received
  double lastPsSeen = 0;  // highest inbound ps observed
};

struct RingEntry {
  double es = 0;        // this event's seq
  Value ev;             // the payload
  double expires = 0;   // nowMs at enqueue + TTL_MS
};

class Link {
 public:
  Link() = default;

  // The DataChannel's open state. A closed channel makes writes no-ops that do
  // NOT count toward `out` (mirroring JS: send() throws, _writeRaw swallows).
  void setChannelOpen(bool open) { channelOpen_ = open; }
  bool channelOpen() const { return channelOpen_; }

  // Enqueue `ev` for delivery. On an open channel: bumps eventSeq, pushes onto
  // the ring, and immediately emits a data packet ('p2p'). On a closed channel:
  // returns dropped=true and touches nothing — the signal the game reads to
  // fall back to the relay.
  Outcome enqueue(const Value& ev, double nowMs);

  // The TICK_MS resend: age out expired entries, then re-emit the whole live
  // ring. Emits nothing when the ring drains.
  Outcome sendDataPacket(double nowMs);

  // The IDLE_MS heartbeat: an empty `h` packet that refreshes `t` for RTT
  // sampling. Suppressed when the channel is closed or the ring is non-empty
  // (a real send happened between scheduling and firing).
  Outcome sendIdleHeartbeat(double nowMs);

  // The channel's onmessage: count the frame, track lastPsSeen, then classify —
  // `pa` present -> ack, else `h` present -> data, else ignore.
  Outcome handleInbound(const Value& packet, double nowMs);

  // ---- read accessors (link state) ------------------------------------------
  double eventSeq() const { return eventSeq_; }
  double lastAckedEs() const { return lastAckedEs_; }
  double lastAppliedEs() const { return lastAppliedEs_; }
  double srtt() const { return srtt_; }
  const std::vector<RingEntry>& ring() const { return ring_; }  // newest first
  const Stats& stats() const { return stats_; }

 private:
  // _writeRaw: returns false (and counts nothing) when the channel is closed.
  bool writeRaw(const Value& packet, Outcome& out);
  void handleAck(const Value& ack, double nowMs, Outcome& out);
  void handleDataPacket(const Value& packet, double nowMs, Outcome& out);
  void sendAck(const Value& dataPacket, Outcome& out);

  bool channelOpen_ = true;
  double eventSeq_ = 0;       // monotonic seq of our outbound stream
  double lastAckedEs_ = 0;    // sender side: highest seq the peer confirmed
  double lastAppliedEs_ = 0;  // receiver side: highest seq we applied
  double srtt_ = 0;           // smoothed RTT (0 == unseeded)
  std::vector<RingEntry> ring_;  // newest first, contiguous in es
  Stats stats_;
};

}  // namespace fastlane
}  // namespace ttp
