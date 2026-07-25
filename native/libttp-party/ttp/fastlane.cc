#include "ttp/fastlane.h"

namespace ttp {
namespace fastlane {

// Field lookup on a Value::OBJ. Returns nullptr when absent — which also models
// JS `'key' in obj` being false (the classifier's presence test).
static const Value* field(const Value& v, const char* key) {
  if (v.type != Value::OBJ) return nullptr;
  for (const auto& kv : v.obj) if (kv.first == key) return &kv.second;
  return nullptr;
}

// `typeof x === 'number'` — present AND numeric.
static bool isNum(const Value* v) { return v && v->type == Value::NUM; }

bool Link::writeRaw(const Value& packet, Outcome& out) {
  // JS: channel.send() throws InvalidStateError when not open and _writeRaw
  // swallows it, so `out` only counts writes that actually left.
  if (!channelOpen_) return false;
  stats_.out += 1;
  out.sent = true;
  out.packet = packet;
  return true;
}

Outcome Link::enqueue(const Value& ev, double nowMs) {
  Outcome out;
  if (!channelOpen_) {
    out.dropped = true;   // 'dropped' — the relay-fallback signal
    return out;
  }
  eventSeq_ += 1;
  RingEntry e;
  e.es = eventSeq_;
  e.ev = ev;
  e.expires = nowMs + TTL_MS;
  ring_.insert(ring_.begin(), std::move(e));  // ring.unshift — newest first

  // enqueue sends immediately; fold that packet into this outcome.
  Outcome sendOut = sendDataPacket(nowMs);
  out.sent = sendOut.sent;
  out.packet = std::move(sendOut.packet);
  return out;
}

Outcome Link::sendDataPacket(double nowMs) {
  Outcome out;
  // Age out expired events. The ring is newest-first and TTL is monotonic in
  // enqueue order, so expired entries are a strict suffix — truncate in place.
  // This is what keeps the ring contiguous in es, making es[i] = ps - i safe.
  size_t liveLen = ring_.size();
  while (liveLen > 0 && ring_[liveLen - 1].expires <= nowMs) liveLen--;
  if (liveLen < ring_.size()) ring_.resize(liveLen);

  if (ring_.empty()) return out;  // nothing to send (shim switches to idle)

  // ps == the newest event's es. Resends reuse it; receivers dedupe per event.
  Value pkt = Value::Obj();
  pkt.set("ps", Value::Num(eventSeq_));
  pkt.set("t", Value::Num(nowMs));
  Value h = Value::Arr();
  for (const RingEntry& e : ring_) h.push(e.ev);
  pkt.set("h", std::move(h));
  writeRaw(pkt, out);
  return out;
}

Outcome Link::sendIdleHeartbeat(double nowMs) {
  Outcome out;
  if (!channelOpen_) return out;
  if (!ring_.empty()) return out;  // a real send intervened — shim reschedules
  // ps unchanged (same value as the last data packet, or 0). The heartbeat
  // exists purely to refresh `t` so the peer's ack yields an RTT sample.
  Value pkt = Value::Obj();
  pkt.set("ps", Value::Num(eventSeq_));
  pkt.set("t", Value::Num(nowMs));
  pkt.set("h", Value::Arr());
  writeRaw(pkt, out);
  return out;
}

void Link::sendAck(const Value& dataPacket, Outcome& out) {
  if (!channelOpen_) return;
  Value ack = Value::Obj();
  ack.set("pa", Value::Num(lastAppliedEs_));
  // Echo the sender's clock verbatim so it can compute RTT. An absent `t` stays
  // UNDEF, which canonical_stringify drops — exactly as JSON.stringify does.
  const Value* t = field(dataPacket, "t");
  ack.set("t", t ? *t : Value());
  writeRaw(ack, out);
}

void Link::handleDataPacket(const Value& packet, double /*nowMs*/, Outcome& out) {
  const Value* ps = field(packet, "ps");
  if (!isNum(ps)) return;  // malformed: no apply, and NOT acked
  const Value* h = field(packet, "h");
  const bool hasArr = h && h->type == Value::ARR;
  const size_t n = hasArr ? h->arr.size() : 0;

  // Events arrive newest-first; walk backwards so onInput sees source order.
  // es is implicit: es[i] = ps - i.
  for (size_t i = n; i-- > 0;) {
    double es = ps->num - static_cast<double>(i);
    if (es > lastAppliedEs_) {
      lastAppliedEs_ = es;
      out.applied.push_back(h->arr[i]);
    }
  }
  // Always ack — duplicates and heartbeats too. Re-acks are idempotent here and
  // give the sender another chance to clear its ring if an ack was lost.
  sendAck(packet, out);
}

void Link::handleAck(const Value& ack, double nowMs, Outcome& out) {
  const Value* pa = field(ack, "pa");
  if (isNum(pa) && pa->num > lastAckedEs_) {
    lastAckedEs_ = pa->num;
    // pa is cumulative-highest-applied and the ring is newest-first, so acked
    // entries (es <= pa) are a strict suffix — truncate, leaving the unacked head.
    size_t keepLen = ring_.size();
    while (keepLen > 0 && ring_[keepLen - 1].es <= pa->num) keepLen--;
    if (keepLen < ring_.size()) ring_.resize(keepLen);
  }
  const Value* t = field(ack, "t");
  if (isNum(t)) {
    double rtt = nowMs - t->num;
    // Discard wild samples (clock jumps, very late acks) so one stale ack can't
    // drag a healthy srtt far via the EWMA.
    if (rtt >= 0 && rtt < RTT_CUTOFF_MS) {
      if (srtt_ == 0) srtt_ = rtt;
      else srtt_ = srtt_ + (rtt - srtt_) * RTT_ALPHA;
      out.hasRtt = true;
      out.rtt = srtt_ / 2;
    }
  }
}

Outcome Link::handleInbound(const Value& packet, double nowMs) {
  Outcome out;
  if (packet.type != Value::OBJ) return out;  // JS: !parsed || typeof != object

  // Any well-formed packet refreshes the shim's watchdog (not modeled here).
  stats_.received += 1;
  const Value* ps = field(packet, "ps");
  if (isNum(ps) && ps->num > stats_.lastPsSeen) stats_.lastPsSeen = ps->num;

  // Disambiguate by PRESENCE, not type: `pa` -> ack, `h` -> data (a heartbeat
  // is a data packet with h: []). Neither -> counted and otherwise ignored.
  if (field(packet, "pa")) {
    handleAck(packet, nowMs, out);
  } else if (field(packet, "h")) {
    handleDataPacket(packet, nowMs, out);
  }
  return out;
}

}  // namespace fastlane
}  // namespace ttp
