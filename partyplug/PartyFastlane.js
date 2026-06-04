'use strict';

/**
 * PartyFastlane — peer-to-peer DataChannel layer that piggybacks on an
 * existing relay/signal channel (e.g. PartyConnection).
 *
 * The lib doesn't own a WebSocket; signaling rides on the integrator's
 * `sendSignal` callback. Input events are resent from a short rolling window
 * until the peer cumulatively acks the highest applied event seq.
 *
 * Wire format (over the DataChannel):
 *
 *   data:       { ps, t, h: [ ev, ... ] }   // sender → peer
 *   heartbeat:  { ps, t, h: [] }            // sender → peer (idle)
 *   ack:        { pa, t }                   // peer ↩
 *
 *   ps  — sender's newest event seq carried by this packet (heartbeats
 *          keep the last data packet's ps, since no new event was added).
 *   t   — sender's clock at send time (echoed in the ack).
 *   h   — event payloads, newest first. Per-entry seq is implicit:
 *         es[i] = ps - i. Safe because the ring only prunes from the
 *         oldest end (TTL), so entries are always consecutive in seq.
 *   pa  — receiver's "highest event seq applied so far." Replaces both
 *         the prior `pa` (packet acked) and `ea` (event applied).
 *
 * Channel mode: { ordered: false, maxRetransmits: 0 }. SCTP retransmits
 * are off — app-layer redundancy + per-event seq dedup replaces them, with
 * tighter latency and no contention with SCTP's own retry timer.
 *
 * WATCHDOG_MS of inbound silence tears down the peer and surfaces
 * onPeerClosed so callers can fall back or update UI.
 *
 * Perfect negotiation: higher-indexed peer is polite (rolls back on
 * collision); lower-indexed peer is impolite. setSelfIndex must be called
 * before open() so the role is known.
 */
(function () {
  var RTC_KEY = '__rtc';

  // Netcode parameters. See plan doc for derivation.
  // TICK_MS:     resend cadence while ring has unacked events.
  // TTL_MS:      how long a re-sendable event stays in the ring (3× TICK_MS).
  // IDLE_MS:     heartbeat cadence when ring is empty.
  // WATCHDOG_MS: silence threshold before declaring the peer dead. 6× IDLE_MS
  //              so several transient missed heartbeats don't trigger teardown.
  // RTT_ALPHA:   exponential smoothing factor on the RTT estimator (Gaffer).
  var TICK_MS = 50;
  var TTL_MS = 300;
  var IDLE_MS = 500;
  var WATCHDOG_MS = 3000;
  var RTT_ALPHA = 0.1;

  function PartyFastlane(options) {
    options = options || {};
    this.iceServers = options.iceServers || [];
    this.selfIndex = options.selfIndex != null ? options.selfIndex : null;
    this.sendSignal = options.sendSignal || function () {};
    this.onInput = options.onInput || null;
    this.onPeerReady = options.onPeerReady || null;
    this.onPeerClosed = options.onPeerClosed || null;
    this.onConnectionState = options.onConnectionState || null;
    this.onRtt = options.onRtt || null;
    // Send-side role: when true, emit empty `{ ps, t, h: [] }` heartbeats
    // every IDLE_MS while the channel is open and the ring is drained.
    // Receiving side (display) leaves this false — it only emits acks.
    this.emitIdleHeartbeat = !!options.emitIdleHeartbeat;

    this.peers = new Map();

    // Per-peer instrumentation. See _statsFor() for shape and getStats() for
    // derived values. Counters intentionally outlive _teardownPeer — they
    // aggregate across reconnects so getStats(idx) returns lifetime totals
    // for that peer index, not per-session ones. Heartbeats don't advance
    // ps so they don't pollute the count.
    this._stats = new Map();
  }

  PartyFastlane.prototype.setSelfIndex = function (idx) {
    this.selfIndex = idx;
  };

  // Returns true if the message was an RTC envelope and was handled.
  PartyFastlane.prototype.handleSignal = function (from, data) {
    if (!data || typeof data !== 'object' || !(RTC_KEY in data)) return false;
    this._handleRtcSignal(from, data);
    return true;
  };

  PartyFastlane.prototype.open = async function (peerIdx, opts) {
    opts = opts || {};
    if (this.selfIndex == null) throw new Error('PartyFastlane: selfIndex not set');
    if (peerIdx === this.selfIndex) throw new Error("can't open a fastlane to self");
    if (typeof RTCPeerConnection === 'undefined') throw new Error('WebRTC not supported');

    var peer = this.peers.get(peerIdx);
    if (peer && peer.channel && peer.channel.readyState === 'open') return;
    if (!peer) peer = this._ensurePeer(peerIdx);

    var needOffer =
      !peer.makingOffer &&
      peer.pc.signalingState === 'stable' &&
      !peer.channel;

    if (needOffer) {
      // Unreliable + unordered: redundancy is app-layer (rolling window),
      // SCTP retransmits would compete with it on slow links.
      var channel = peer.pc.createDataChannel('party', {
        ordered: false,
        maxRetransmits: 0,
      });
      this._wireChannel(peer, peerIdx, channel);

      try {
        peer.makingOffer = true;
        var offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);
        this.sendSignal(peerIdx, { [RTC_KEY]: 'offer', sdp: peer.pc.localDescription });
      } finally {
        peer.makingOffer = false;
      }
    }

    if (opts.timeoutMs == null) return;
    return this._waitForOpen(peerIdx, opts.timeoutMs);
  };

  PartyFastlane.prototype._waitForOpen = function (peerIdx, timeoutMs) {
    var self = this;
    var peer = this.peers.get(peerIdx);
    if (peer && peer.channel && peer.channel.readyState === 'open') {
      return Promise.resolve();
    }
    return new Promise(function (resolve, reject) {
      // Re-read inside the executor: the outer `peer` lookup happens before
      // the Promise body runs, and the peer entry can change in between.
      var activePeer = self.peers.get(peerIdx);
      if (!activePeer) {
        reject(new Error('fastlane to ' + peerIdx + ' closed'));
        return;
      }
      var done = false;
      var settle = function (err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        activePeer._waitResolvers = activePeer._waitResolvers
          .filter(function (r) { return r !== entry; });
        if (err) reject(err); else resolve();
      };
      var entry = { settle: settle };
      activePeer._waitResolvers.push(entry);

      var timer = setTimeout(function () {
        settle(new Error('fastlane to ' + peerIdx + ' timed out after ' + timeoutMs + 'ms'));
        self.close(peerIdx);
      }, timeoutMs);
    });
  };

  PartyFastlane.prototype.close = function (peerIdx) {
    this._teardownPeer(peerIdx);
  };

  PartyFastlane.prototype.closeAll = function () {
    var indices = [];
    this.peers.forEach(function (_v, k) { indices.push(k); });
    for (var i = 0; i < indices.length; i++) this._teardownPeer(indices[i]);
  };

  // Enqueue `ev` for delivery to `peerIdx`. Returns 'p2p' if the channel is
  // open and the event was added to the send ring, 'dropped' otherwise.
  // The actual send is automatic — the event sits in the ring until it's
  // acked or expires (TTL_MS). Resend ticks fire every TICK_MS while the
  // ring is non-empty; ack from the peer clears acknowledged events.
  PartyFastlane.prototype.enqueue = function (peerIdx, ev) {
    var peer = this.peers.get(peerIdx);
    if (!peer || !peer.channel || peer.channel.readyState !== 'open') {
      return 'dropped';
    }
    peer.eventSeq += 1;
    peer.ring.unshift({
      es: peer.eventSeq,
      ev: ev,
      expires: Date.now() + TTL_MS,
    });
    this._sendDataPacket(peer, peerIdx);
    return 'p2p';
  };

  PartyFastlane.prototype.isOpen = function (peerIdx) {
    var peer = this.peers.get(peerIdx);
    return !!(peer && peer.channel && peer.channel.readyState === 'open');
  };

  // Per-peer packet counters. Minimal surface — the only thing the lib
  // genuinely tracks for diagnostics. RTT is surfaced via the onRtt
  // callback; anything else (ring depth, applied/acked event seq) lives
  // on the peer object and is internal state.
  //   out          packets sent to this peer (data + heartbeats + acks)
  //   received     packets received from this peer
  //   lastPsSeen   highest inbound ps observed (= peer's max event seq)
  PartyFastlane.prototype.getStats = function (peerIdx) {
    var s = this._stats.get(peerIdx);
    if (!s) return null;
    return {
      out: s.out,
      received: s.received,
      lastPsSeen: s.lastPsSeen,
    };
  };

  PartyFastlane.prototype.getAllStats = function () {
    var out = {};
    var self = this;
    this._stats.forEach(function (_v, k) { out[k] = self.getStats(k); });
    return out;
  };

  PartyFastlane.prototype._statsFor = function (peerIdx) {
    var s = this._stats.get(peerIdx);
    if (!s) {
      s = { out: 0, received: 0, lastPsSeen: 0 };
      this._stats.set(peerIdx, s);
    }
    return s;
  };

  // --- send path ---

  PartyFastlane.prototype._sendDataPacket = function (peer, peerIdx) {
    var now = Date.now();
    // Age out expired events. Ring entries are always consecutive in es:
    // .filter only prunes from the oldest end (TTL is monotonic in enqueue
    // order). This is what makes implicit seq encoding safe — receivers
    // can compute es[i] = ps - i without an explicit per-entry seq field.
    peer.ring = peer.ring.filter(function (e) { return e.expires > now; });

    if (peer.ring.length === 0) {
      if (peer.sendTimer) { clearTimeout(peer.sendTimer); peer.sendTimer = null; }
      this._resetIdleTimer(peer, peerIdx);
      return;
    }

    // ps == newest event's es. Heartbeats reuse this value (see below);
    // resends reuse it too (same packet content, same ps), which is fine
    // because receivers dedupe per event via lastAppliedEs.
    this._writeRaw(peer, peerIdx, {
      ps: peer.eventSeq,
      t: now,
      h: peer.ring.map(function (e) { return e.ev; }),
    });

    if (peer.sendTimer) clearTimeout(peer.sendTimer);
    var self = this;
    peer.sendTimer = setTimeout(function () {
      self._sendDataPacket(peer, peerIdx);
    }, TICK_MS);
    if (peer.idleTimer) { clearTimeout(peer.idleTimer); peer.idleTimer = null; }
  };

  PartyFastlane.prototype._resetIdleTimer = function (peer, peerIdx) {
    if (!this.emitIdleHeartbeat) return;
    if (!peer.channel || peer.channel.readyState !== 'open') return;
    if (peer.idleTimer) clearTimeout(peer.idleTimer);
    var self = this;
    peer.idleTimer = setTimeout(function () {
      self._sendIdleHeartbeat(peer, peerIdx);
    }, IDLE_MS);
  };

  PartyFastlane.prototype._sendIdleHeartbeat = function (peer, peerIdx) {
    if (!peer.channel || peer.channel.readyState !== 'open') return;
    if (peer.ring.length > 0) {
      // A real send happened between scheduling and firing — defer.
      this._resetIdleTimer(peer, peerIdx);
      return;
    }
    // ps unchanged: same value as the most recent data packet (or 0 if
    // none yet). Heartbeat exists purely to refresh `t` for RTT samples.
    this._writeRaw(peer, peerIdx, {
      ps: peer.eventSeq,
      t: Date.now(),
      h: [],
    });
    this._resetIdleTimer(peer, peerIdx);
  };

  PartyFastlane.prototype._sendAck = function (peer, peerIdx, dataPacket) {
    if (!peer.channel || peer.channel.readyState !== 'open') return;
    this._writeRaw(peer, peerIdx, {
      pa: peer.lastAppliedEs,
      t: dataPacket.t,
    });
  };

  PartyFastlane.prototype._writeRaw = function (peer, peerIdx, packet) {
    try {
      peer.channel.send(JSON.stringify(packet));
      this._statsFor(peerIdx).out += 1;
    } catch (_) { /* channel transitioned; next caller will see closed state */ }
  };

  // --- receive path ---

  PartyFastlane.prototype._handleDataPacket = function (peer, peerIdx, packet) {
    if (typeof packet.ps !== 'number') return;
    var h = Array.isArray(packet.h) ? packet.h : [];
    // Events arrive newest first; iterate oldest-first so onInput receives
    // them in source order. es is implicit: es[i] = ps - i.
    for (var i = h.length - 1; i >= 0; i--) {
      var es = packet.ps - i;
      if (es > peer.lastAppliedEs) {
        peer.lastAppliedEs = es;
        if (this.onInput) this.onInput(peerIdx, h[i]);
      }
    }
    // Always ack — even duplicates and heartbeats. Re-acks are idempotent
    // on this side and give the sender another shot at clearing its ring
    // if the prior ack was lost.
    this._sendAck(peer, peerIdx, packet);
  };

  PartyFastlane.prototype._handleAck = function (peer, peerIdx, ack) {
    if (typeof ack.pa === 'number' && ack.pa > peer.lastAckedEs) {
      peer.lastAckedEs = ack.pa;
      // pa is cumulative-highest-applied, so filtering out es <= pa always
      // leaves a contiguous tail. This is what lets the receiver decode
      // es[i] = ps - i without an explicit per-entry seq field.
      peer.ring = peer.ring.filter(function (e) { return e.es > ack.pa; });
      if (peer.ring.length === 0 && peer.sendTimer) {
        clearTimeout(peer.sendTimer);
        peer.sendTimer = null;
        this._resetIdleTimer(peer, peerIdx);
      }
    }
    if (typeof ack.t === 'number') {
      var rtt = Date.now() - ack.t;
      // Discard wild samples (clock jumps, very late acks). A 500 ms cap is
      // tight enough that a stale ack carrying a 400 ms RTT can't shift a
      // healthy srtt of 20 ms more than ~38 ms via the EWMA — and the
      // chip recovers within a few subsequent good samples.
      if (rtt >= 0 && rtt < 500) {
        if (peer.srtt === 0) peer.srtt = rtt;
        else peer.srtt = peer.srtt + (rtt - peer.srtt) * RTT_ALPHA;
        if (this.onRtt) this.onRtt(peerIdx, peer.srtt / 2);
      }
    }
  };

  // --- watchdog ---
  // Each side declares the peer dead if no inbound packet arrives for
  // WATCHDOG_MS. On the controller this fires when acks stop coming back
  // (channel is silently broken); on the display, when heartbeats stop
  // arriving. The timer is reset on every inbound packet — if WATCHDOG_MS
  // elapses without a reset, the timer fires and teardown runs.

  PartyFastlane.prototype._resetWatchdog = function (peer, peerIdx) {
    if (peer.watchdogTimer) clearTimeout(peer.watchdogTimer);
    var self = this;
    peer.watchdogTimer = setTimeout(function () {
      console.warn('[fastlane] watchdog: no inbound from peer', peerIdx, 'in', WATCHDOG_MS, 'ms — tearing down');
      self._teardownPeer(peerIdx);
    }, WATCHDOG_MS);
  };

  // --- internals: peer + signaling ---

  PartyFastlane.prototype._ensurePeer = function (peerIdx) {
    var existing = this.peers.get(peerIdx);
    if (existing) return existing;

    var pc = new RTCPeerConnection({ iceServers: this.iceServers });
    var polite = this.selfIndex > peerIdx;
    var peer = {
      pc: pc,
      channel: null,
      pendingCandidates: [],
      polite: polite,
      makingOffer: false,
      ignoreOffer: false,
      _waitResolvers: [],
      eventSeq: 0,        // monotonic event seq for this peer's outbound stream
      ring: [],
      sendTimer: null,
      idleTimer: null,
      watchdogTimer: null,
      lastAckedEs: 0,     // sender side: events this peer has confirmed applied
      lastAppliedEs: 0,   // receiver side: events we've applied from this peer
      srtt: 0,
    };
    this.peers.set(peerIdx, peer);

    var self = this;
    pc.onicecandidate = function (ev) {
      // Browsers fire onicecandidate with ev.candidate === null when ICE
      // gathering completes. Forwarding the null is technically valid
      // (end-of-candidates marker) but burns a WS message no implementation
      // here acts on. Skip it.
      if (!ev.candidate) return;
      self.sendSignal(peerIdx, { [RTC_KEY]: 'ice', candidate: ev.candidate });
    };
    pc.ondatachannel = function (ev) {
      self._wireChannel(peer, peerIdx, ev.channel);
    };
    pc.onconnectionstatechange = function () {
      var state = pc.connectionState;
      if (self.onConnectionState) self.onConnectionState(peerIdx, state);
      if (state === 'failed' || state === 'closed') {
        self._teardownPeer(peerIdx);
      }
    };

    return peer;
  };

  PartyFastlane.prototype._wireChannel = function (peer, peerIdx, channel) {
    if (peer.channel && peer.channel !== channel) {
      // Orphan from a rolled-back offer; detach handlers but don't close()
      // (shared SCTP stream id would tear down the adopted channel remotely).
      peer.channel.onopen = null;
      peer.channel.onmessage = null;
      peer.channel.onclose = null;
      peer.channel.onerror = null;
    }
    peer.channel = channel;

    var self = this;
    channel.onopen = function () {
      if (self.onPeerReady) self.onPeerReady(peerIdx);
      var waiters = peer._waitResolvers;
      peer._waitResolvers = [];
      for (var i = 0; i < waiters.length; i++) waiters[i].settle();
      // Start idle heartbeat schedule (sender side). First enqueue cancels
      // and switches to the data send loop.
      self._resetIdleTimer(peer, peerIdx);
      self._resetWatchdog(peer, peerIdx);
    };
    channel.onmessage = function (e) {
      var parsed;
      try { parsed = JSON.parse(e.data); } catch (_) { return; }
      if (!parsed || typeof parsed !== 'object') return;

      // Any well-formed packet refreshes the watchdog.
      self._resetWatchdog(peer, peerIdx);

      var s = self._statsFor(peerIdx);
      s.received += 1;
      // Data packets advance lastPsSeen; acks don't carry ps (they have pa).
      if (typeof parsed.ps === 'number' && parsed.ps > s.lastPsSeen) {
        s.lastPsSeen = parsed.ps;
      }

      // Disambiguate: presence of `pa` → ack; presence of `h` → data
      // (heartbeats are data packets with h: []).
      if ('pa' in parsed) {
        self._handleAck(peer, peerIdx, parsed);
      } else if ('h' in parsed) {
        self._handleDataPacket(peer, peerIdx, parsed);
      }
    };
    channel.onclose = function () {
      // Orphan channels from glare rollback should not trigger teardown of
      // the adopted channel. Route through _teardownPeer so onPeerClosed
      // fires exactly once (the watchdog and the pc connectionState path
      // also funnel through there; _teardownPeer is idempotent).
      if (peer.channel !== channel) return;
      self._teardownPeer(peerIdx);
    };
    channel.onerror = function () { /* surfaced via onclose / state change */ };
  };

  PartyFastlane.prototype._handleRtcSignal = async function (from, data) {
    if (this.selfIndex == null) return;
    var peer = this._ensurePeer(from);
    var pc = peer.pc;
    var kind = data[RTC_KEY];

    try {
      if (kind === 'offer' || kind === 'answer') {
        var isOffer = kind === 'offer';
        var collision = isOffer &&
          (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;

        await pc.setRemoteDescription(data.sdp);
        for (var i = 0; i < peer.pendingCandidates.length; i++) {
          try { await pc.addIceCandidate(peer.pendingCandidates[i]); } catch (_) {}
        }
        peer.pendingCandidates.length = 0;

        if (isOffer) {
          var answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.sendSignal(from, { [RTC_KEY]: 'answer', sdp: pc.localDescription });
        }
      } else if (kind === 'ice') {
        var c = data.candidate;
        if (!pc.remoteDescription) {
          peer.pendingCandidates.push(c);
          return;
        }
        try {
          await pc.addIceCandidate(c);
        } catch (e) {
          if (!peer.ignoreOffer) console.warn('[fastlane] addIceCandidate failed', e);
        }
      }
    } catch (err) {
      console.warn('[fastlane] signal handling failed', err);
    }
  };

  PartyFastlane.prototype._teardownPeer = function (peerIdx) {
    var peer = this.peers.get(peerIdx);
    if (!peer) return;
    this.peers.delete(peerIdx);

    if (peer.sendTimer) clearTimeout(peer.sendTimer);
    if (peer.idleTimer) clearTimeout(peer.idleTimer);
    if (peer.watchdogTimer) clearTimeout(peer.watchdogTimer);

    var waiters = peer._waitResolvers;
    peer._waitResolvers = [];
    for (var i = 0; i < waiters.length; i++) {
      waiters[i].settle(new Error('fastlane to ' + peerIdx + ' closed'));
    }
    try { if (peer.channel) peer.channel.close(); } catch (_) {}
    try { peer.pc.close(); } catch (_) {}

    if (this.onPeerClosed) this.onPeerClosed(peerIdx);
  };

  if (typeof window !== 'undefined') window.PartyFastlane = PartyFastlane;
  if (typeof module !== 'undefined' && module.exports) module.exports = PartyFastlane;
})();
