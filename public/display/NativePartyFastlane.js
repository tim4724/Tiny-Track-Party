// NativePartyFastlane — the fastlane's NETCODE on the native party layer
// (ttp_party.h's ttp_link_* entry points), with the WebRTC handshake untouched.
//
// PartyFastlane mixes two concerns in one class: the handshake (RTCPeerConnection,
// offer/answer, ICE, glare) which must stay JS, and the netcode (resend ring +
// TTL, implicit per-event seq, cumulative ack, receive dedup, RTT EWMA, packet
// classification) which is ported. Rather than refactor the shared kit fork, this
// SUBCLASSES it and overrides exactly the netcode methods; everything else —
// open(), _handleRtcSignal(), the channel open/close/error wiring, the watchdog,
// _teardownPeer's cleanup — is inherited verbatim.
//
// Per-peer native state is one Link handle, created alongside the JS peer record
// and disposed with it. Before every op the channel's real readyState is pushed
// into the Link, because the Link's "is the channel open" belief is what decides
// whether a write happens and whether it counts toward stats.out (mirroring the
// kit, where a send() on a closed channel throws and is swallowed).
//
// SCOPE: this is wired on the DISPLAY, which is the RECEIVING side (phones send
// CONTROL). So in the browser the natively-exercised paths are inbound handling,
// dedup and ack emission; the sender-side ring/TTL/RTT paths run natively only in
// the conformance corpus, since the controller (a deliberately thin phone page)
// still runs the JS netcode. Putting wasm on the controller is a separate call.

import { loadNativeRuntime } from './nativeRuntime.js';

let M = null;
let fn = null;

export async function init() {
  if (M) return;
  M = await loadNativeRuntime();
  const c = (name, ret, args) => M.cwrap(name, ret, args);
  fn = {
    create: c('ttp_link_create', 'number', []),
    dispose: c('ttp_link_dispose', null, ['number']),
    setOpen: c('ttp_link_set_channel_open', null, ['number', 'number']),
    enqueue: c('ttp_link_enqueue', 'string', ['number', 'string', 'number']),
    sendTick: c('ttp_link_send_tick', 'string', ['number', 'number']),
    idle: c('ttp_link_idle', 'string', ['number', 'number']),
    inbound: c('ttp_link_inbound', 'string', ['number', 'string', 'number']),
    stats: c('ttp_link_stats_json', 'string', ['number'])
  };
}

// Build the subclass lazily: the base class arrives as a classic-script global
// (window.PartyFastlane), so it isn't available at module-evaluation time.
export function makeNativePartyFastlane(Base) {
  return class NativePartyFastlane extends Base {
    // ---- per-peer Link lifecycle ------------------------------------------
    _ensurePeer(peerIdx) {
      const existed = this.peers.get(peerIdx);
      const peer = super._ensurePeer(peerIdx);
      if (!existed) peer._link = fn.create();
      return peer;
    }

    _teardownPeer(peerIdx) {
      const peer = this.peers.get(peerIdx);
      const link = peer && peer._link;
      super._teardownPeer(peerIdx);   // fires onPeerClosed, closes pc/channel
      if (link) fn.dispose(link);
    }

    // The Link decides whether a write happens, so its view of the channel must
    // match reality before every op.
    _syncOpen(peer) {
      if (!peer || !peer._link) return false;
      const open = !!(peer.channel && peer.channel.readyState === 'open');
      fn.setOpen(peer._link, open ? 1 : 0);
      return open;
    }

    // Apply an outcome: write the packet the Link produced, surface applied
    // events, report an RTT sample. Mirrors the kit's callback cadence.
    _applyOutcome(peer, peerIdx, oc) {
      if (oc.sent && oc.packet != null) {
        try { peer.channel.send(JSON.stringify(oc.packet)); } catch (_) { /* channel transitioned */ }
      }
      for (const ev of oc.applied) {
        if (this.onInput) this.onInput(peerIdx, ev);
      }
      if (oc.rtt != null && this.onRtt) this.onRtt(peerIdx, oc.rtt);
    }

    // ---- netcode overrides -------------------------------------------------
    enqueue(peerIdx, ev) {
      const peer = this.peers.get(peerIdx);
      if (!peer || !peer._link) return 'dropped';
      this._syncOpen(peer);
      const oc = JSON.parse(fn.enqueue(peer._link, JSON.stringify(ev ?? null), Date.now()));
      this._applyOutcome(peer, peerIdx, oc);
      if (oc.dropped) return 'dropped';
      // The kit reschedules its resend tick after a successful enqueue; the base
      // class owns that timer, so keep using its scheduler.
      this._scheduleNativeTick(peer, peerIdx);
      return 'p2p';
    }

    // Resend loop: the Link prunes TTL-expired entries and re-emits the live ring.
    // An empty ring produces no packet, and we fall back to the idle heartbeat
    // schedule exactly as the kit does.
    _sendDataPacket(peer, peerIdx) {
      if (!peer || !peer._link) return;
      this._syncOpen(peer);
      const oc = JSON.parse(fn.sendTick(peer._link, Date.now()));
      this._applyOutcome(peer, peerIdx, oc);
      if (!oc.sent) {
        if (peer.sendTimer) { clearTimeout(peer.sendTimer); peer.sendTimer = null; }
        this._resetIdleTimer(peer, peerIdx);
        return;
      }
      this._scheduleNativeTick(peer, peerIdx);
      if (peer.idleTimer) { clearTimeout(peer.idleTimer); peer.idleTimer = null; }
    }

    _scheduleNativeTick(peer, peerIdx) {
      if (peer.sendTimer) clearTimeout(peer.sendTimer);
      // TICK_MS is the kit's resend cadence; the Link mirrors the same constant
      // (asserted against the corpus header by fastlane_check).
      peer.sendTimer = setTimeout(() => this._sendDataPacket(peer, peerIdx), 50);
    }

    _sendIdleHeartbeat(peer, peerIdx) {
      if (!peer || !peer._link) return;
      const open = this._syncOpen(peer);
      if (!open) return;
      const oc = JSON.parse(fn.idle(peer._link, Date.now()));
      this._applyOutcome(peer, peerIdx, oc);
      this._resetIdleTimer(peer, peerIdx);
    }

    // Inbound: hand the RAW channel text to the Link, which classifies (ack vs
    // data vs ignore), dedupes, applies, and produces the ack to write. This
    // replaces the base class's onmessage body; the rest of the channel wiring
    // (open/close/error) comes from super.
    _wireChannel(peer, peerIdx, channel) {
      super._wireChannel(peer, peerIdx, channel);
      channel.onmessage = (e) => {
        if (peer.channel !== channel) return;   // orphan from a rolled-back offer
        this._resetWatchdog(peer, peerIdx);     // transport concern, stays JS
        if (!peer._link) return;
        this._syncOpen(peer);
        const oc = JSON.parse(fn.inbound(peer._link, String(e.data), Date.now()));
        this._applyOutcome(peer, peerIdx, oc);
      };
    }

    // Stats come from the Link (the kit's JS counters are never advanced here).
    getStats(peerIdx) {
      const peer = this.peers.get(peerIdx);
      if (!peer || !peer._link) return super.getStats(peerIdx);
      const s = JSON.parse(fn.stats(peer._link));
      return s && { out: s.out, received: s.received, lastPsSeen: s.lastPsSeen };
    }
  };
}
