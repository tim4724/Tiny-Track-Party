'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// PartyFastlane's WebRTC handshake (open/closeFastlane/ICE) needs
// RTCPeerConnection + RTCDataChannel, which we don't mock here. Instead we
// exercise the netcode-pure surface directly: ring lifecycle, ack-clears-
// ring, implicit-seq dedup, RTT smoothing, and stats. Tests construct a
// PartyFastlane, manually inject a synthetic peer entry with a fake
// channel (just captures sent JSON), and drive the internal handlers.

global.window = global.window || {};

const PartyFastlane = require('../PartyFastlane');

function makeFakeChannel() {
  return {
    readyState: 'open',
    _sent: [],
    send(data) { this._sent.push(JSON.parse(data)); },
    close() { this.readyState = 'closed'; },
  };
}

function makePeer(channel) {
  return {
    pc: { close() {}, signalingState: 'stable', connectionState: 'connected' },
    channel: channel,
    pendingCandidates: [],
    polite: false,
    makingOffer: false,
    ignoreOffer: false,
    _waitResolvers: [],
    eventSeq: 0,
    ring: [],
    sendTimer: null,
    idleTimer: null,
    watchdogTimer: null,
    lastAckedEs: 0,
    lastAppliedEs: 0,
    srtt: 0,
  };
}

// Build a fastlane with one synthetic peer at index `peerIdx`. Returns
// { fastlane, peer, channel } for inspection.
function makeFastlane({ selfIndex = 0, peerIdx = 1, options = {} } = {}) {
  const fastlane = new PartyFastlane(Object.assign({ selfIndex }, options));
  const channel = makeFakeChannel();
  const peer = makePeer(channel);
  fastlane.peers.set(peerIdx, peer);
  return { fastlane, peer, channel, peerIdx };
}

describe('PartyFastlane / netcode', () => {
  describe('enqueue + send', () => {
    test('returns "dropped" when channel is not open', () => {
      const { fastlane, peer, peerIdx } = makeFastlane();
      peer.channel.readyState = 'closed';
      assert.strictEqual(fastlane.enqueue(peerIdx, { type: 'input' }), 'dropped');
      assert.strictEqual(peer.ring.length, 0);
    });

    test('returns "dropped" when peer is unknown', () => {
      const fastlane = new PartyFastlane({ selfIndex: 0 });
      assert.strictEqual(fastlane.enqueue(99, { type: 'input' }), 'dropped');
    });

    test('enqueues into ring with monotonic event seq', () => {
      const { fastlane, peer, peerIdx } = makeFastlane();
      // the happy path returns 'p2p' (the documented success contract, mirroring
      // the 'dropped' return the failure-path tests above assert)
      assert.strictEqual(fastlane.enqueue(peerIdx, { type: 'input', action: 'left' }), 'p2p');
      fastlane.enqueue(peerIdx, { type: 'input', action: 'right' });
      assert.strictEqual(peer.eventSeq, 2);
      // Newest first
      assert.strictEqual(peer.ring[0].es, 2);
      assert.strictEqual(peer.ring[1].es, 1);
    });

    test('sends a data packet immediately on enqueue', () => {
      const { fastlane, channel, peerIdx } = makeFastlane();
      fastlane.enqueue(peerIdx, { type: 'input', action: 'left' });
      assert.strictEqual(channel._sent.length, 1);
      const pkt = channel._sent[0];
      assert.strictEqual(pkt.ps, 1);
      assert.strictEqual(typeof pkt.t, 'number');
      assert.deepStrictEqual(pkt.h, [{ type: 'input', action: 'left' }]);
    });

    test('bundles unacked events into a single packet (rolling window)', () => {
      const { fastlane, channel, peer, peerIdx } = makeFastlane();
      fastlane.enqueue(peerIdx, { type: 'input', action: 'left' });
      fastlane.enqueue(peerIdx, { type: 'input', action: 'right' });
      fastlane.enqueue(peerIdx, { type: 'soft_drop', speed: 5 });
      // Three sends, each carrying the cumulative ring (newest first)
      assert.strictEqual(channel._sent.length, 3);
      assert.strictEqual(channel._sent[2].ps, 3);
      assert.strictEqual(channel._sent[2].h.length, 3);
      assert.deepStrictEqual(channel._sent[2].h[0], { type: 'soft_drop', speed: 5 });
      assert.deepStrictEqual(channel._sent[2].h[2], { type: 'input', action: 'left' });
      assert.strictEqual(peer.ring.length, 3);
    });

    test('clears the send timer when the ring becomes empty after pruning', (t, done) => {
      const { fastlane, peer, peerIdx } = makeFastlane();
      // Enqueue with a TTL just barely in the past so the next _sendDataPacket
      // call prunes everything. We can't easily intercept TTL_MS, so we mutate
      // expires directly after enqueue.
      fastlane.enqueue(peerIdx, { type: 'input', action: 'left' });
      peer.ring[0].expires = Date.now() - 1;
      // Now call _sendDataPacket again — it should prune, see empty ring,
      // clear the timer, return without sending.
      const sentBefore = peer.channel._sent.length;
      fastlane._sendDataPacket(peer, peerIdx);
      assert.strictEqual(peer.channel._sent.length, sentBefore);
      assert.strictEqual(peer.ring.length, 0);
      assert.strictEqual(peer.sendTimer, null);
      done();
    });
  });

  describe('_handleDataPacket (receiver side)', () => {
    test('applies new events in ascending es order and advances lastAppliedEs', () => {
      const captured = [];
      const { fastlane, peer, peerIdx } = makeFastlane({
        options: { onInput: (from, ev) => captured.push({ from, ev }) },
      });
      // Packet ps=3 with h=[{ev3}, {ev2}, {ev1}] → es = [3, 2, 1]
      fastlane._handleDataPacket(peer, peerIdx, {
        ps: 3,
        t: Date.now(),
        h: [{ a: 3 }, { a: 2 }, { a: 1 }],
      });
      assert.strictEqual(peer.lastAppliedEs, 3);
      // Receiver applies oldest first
      assert.deepStrictEqual(captured.map(c => c.ev.a), [1, 2, 3]);
    });

    test('dedupes events with es <= lastAppliedEs (duplicate / out-of-order)', () => {
      const captured = [];
      const { fastlane, peer, peerIdx } = makeFastlane({
        options: { onInput: (from, ev) => captured.push(ev) },
      });
      // First packet applies events 1..3
      fastlane._handleDataPacket(peer, peerIdx, {
        ps: 3, t: Date.now(), h: [{ a: 3 }, { a: 2 }, { a: 1 }],
      });
      // Resend with the same events → all should be skipped
      fastlane._handleDataPacket(peer, peerIdx, {
        ps: 3, t: Date.now(), h: [{ a: 3 }, { a: 2 }, { a: 1 }],
      });
      assert.strictEqual(captured.length, 3);
      assert.strictEqual(peer.lastAppliedEs, 3);
    });

    test('mixed new + duplicate events applies only the new ones', () => {
      const captured = [];
      const { fastlane, peer, peerIdx } = makeFastlane({
        options: { onInput: (from, ev) => captured.push(ev) },
      });
      // Apply ps=2 (events 1..2)
      fastlane._handleDataPacket(peer, peerIdx, {
        ps: 2, t: Date.now(), h: [{ a: 2 }, { a: 1 }],
      });
      // Then ps=4 carrying events 2..4 — only 3 and 4 should fire
      fastlane._handleDataPacket(peer, peerIdx, {
        ps: 4, t: Date.now(), h: [{ a: 4 }, { a: 3 }, { a: 2 }],
      });
      assert.deepStrictEqual(captured.map(c => c.a), [1, 2, 3, 4]);
      assert.strictEqual(peer.lastAppliedEs, 4);
    });

    test('ignores packets with non-numeric ps', () => {
      const captured = [];
      const { fastlane, peer, channel, peerIdx } = makeFastlane({
        options: { onInput: (from, ev) => captured.push(ev) },
      });
      fastlane._handleDataPacket(peer, peerIdx, { ps: 'bogus', t: Date.now(), h: [{ a: 1 }] });
      fastlane._handleDataPacket(peer, peerIdx, { t: Date.now(), h: [{ a: 1 }] });
      assert.strictEqual(captured.length, 0);
      assert.strictEqual(peer.lastAppliedEs, 0);
      // Also no ack sent for malformed packets
      assert.strictEqual(channel._sent.length, 0);
    });

    test('sends an ack on every data packet (including dups + heartbeats)', () => {
      const { fastlane, peer, channel, peerIdx } = makeFastlane();
      // Data packet → ack with pa = applied seq
      fastlane._handleDataPacket(peer, peerIdx, {
        ps: 2, t: 100, h: [{ a: 2 }, { a: 1 }],
      });
      assert.strictEqual(channel._sent.length, 1);
      assert.strictEqual(channel._sent[0].pa, 2);
      assert.strictEqual(channel._sent[0].t, 100);

      // Heartbeat (h:[]) → also acked, pa unchanged, t echoed
      fastlane._handleDataPacket(peer, peerIdx, { ps: 2, t: 200, h: [] });
      assert.strictEqual(channel._sent.length, 2);
      assert.strictEqual(channel._sent[1].pa, 2);
      assert.strictEqual(channel._sent[1].t, 200);
    });
  });

  describe('_handleAck (sender side)', () => {
    test('advances lastAckedEs and clears acked events from the ring', () => {
      const { fastlane, peer, peerIdx } = makeFastlane();
      // Pre-load ring with three pending events
      peer.eventSeq = 3;
      peer.ring = [
        { es: 3, ev: { a: 3 }, expires: Date.now() + 1000 },
        { es: 2, ev: { a: 2 }, expires: Date.now() + 1000 },
        { es: 1, ev: { a: 1 }, expires: Date.now() + 1000 },
      ];
      fastlane._handleAck(peer, peerIdx, { pa: 2, t: Date.now() });
      assert.strictEqual(peer.lastAckedEs, 2);
      assert.strictEqual(peer.ring.length, 1);
      assert.strictEqual(peer.ring[0].es, 3);
    });

    test('idempotent on stale ack (pa <= lastAckedEs)', () => {
      const { fastlane, peer, peerIdx } = makeFastlane();
      peer.ring = [{ es: 5, ev: {}, expires: Date.now() + 1000 }];
      peer.lastAckedEs = 5;
      fastlane._handleAck(peer, peerIdx, { pa: 3, t: Date.now() });
      assert.strictEqual(peer.lastAckedEs, 5);
      assert.strictEqual(peer.ring.length, 1);
    });

    test('computes smoothed RTT via EWMA (α=0.1) and surfaces via onRtt', () => {
      const rttSamples = [];
      const { fastlane, peer, peerIdx } = makeFastlane({
        options: { onRtt: (idx, half) => rttSamples.push({ idx, half }) },
      });
      const now = Date.now();
      // First sample seeds srtt directly (peer.srtt was 0)
      fastlane._handleAck(peer, peerIdx, { pa: 0, t: now - 20 });
      assert.ok(peer.srtt >= 19 && peer.srtt <= 25, 'first sample initializes srtt');
      // Second sample blends: srtt = srtt + (rtt - srtt) * 0.1
      const srttAfterFirst = peer.srtt;
      fastlane._handleAck(peer, peerIdx, { pa: 0, t: now - 100 });
      const expected = srttAfterFirst + (100 - srttAfterFirst) * 0.1;
      // Allow a small slop because Date.now() drifts during the test
      assert.ok(Math.abs(peer.srtt - expected) < 5,
        `srtt blended toward 100: got ${peer.srtt}, expected ~${expected}`);
      assert.ok(rttSamples.length === 2);
      // Half RTT surfaced
      assert.strictEqual(rttSamples[1].idx, peerIdx);
      assert.ok(Math.abs(rttSamples[1].half - peer.srtt / 2) < 0.001);
    });

    test('discards out-of-range RTT samples (negative or above the cutoff)', () => {
      const rttSamples = [];
      const { fastlane, peer, peerIdx } = makeFastlane({
        options: { onRtt: (idx, half) => rttSamples.push(half) },
      });
      // Negative (clock skew / late ack carrying future t)
      fastlane._handleAck(peer, peerIdx, { pa: 0, t: Date.now() + 1000 });
      assert.strictEqual(peer.srtt, 0);
      assert.strictEqual(rttSamples.length, 0);
      // Wild positive — well beyond the 500 ms outlier cutoff
      fastlane._handleAck(peer, peerIdx, { pa: 0, t: Date.now() - 5000 });
      assert.strictEqual(peer.srtt, 0);
      assert.strictEqual(rttSamples.length, 0);
    });
  });

  describe('stats', () => {
    test('getStats returns null for unknown peer', () => {
      const fastlane = new PartyFastlane({ selfIndex: 0 });
      assert.strictEqual(fastlane.getStats(42), null);
    });

    test('counts outbound packets across enqueue + ack-send paths', () => {
      const { fastlane, peer, peerIdx } = makeFastlane();
      fastlane.enqueue(peerIdx, { a: 1 });
      fastlane._handleDataPacket(peer, peerIdx, { ps: 5, t: Date.now(), h: [{ a: 5 }] });
      // 1 outbound (enqueue's data packet) + 1 outbound ack from handleDataPacket
      assert.strictEqual(fastlane.getStats(peerIdx).out, 2);
      // received / lastPsSeen are updated by _wireChannel.onmessage, which we
      // don't drive here. Covered separately by integration via the live
      // browser check — out-of-scope for the netcode-pure unit tests.
    });

    test('counters persist across _teardownPeer (lifetime aggregation)', () => {
      const { fastlane, peerIdx } = makeFastlane();
      fastlane.enqueue(peerIdx, { a: 1 });
      const before = fastlane.getStats(peerIdx).out;
      // Simulate teardown
      fastlane._teardownPeer(peerIdx);
      // Stats survive
      assert.strictEqual(fastlane.getStats(peerIdx).out, before);
    });

    test('getAllStats returns a map of every tracked peer', () => {
      const { fastlane, peerIdx } = makeFastlane();
      fastlane.enqueue(peerIdx, { a: 1 });
      const all = fastlane.getAllStats();
      assert.ok(peerIdx in all);
      assert.strictEqual(all[peerIdx].out, 1);
    });
  });

  describe('handleSignal routing', () => {
    test('returns false for non-__rtc messages', () => {
      const fastlane = new PartyFastlane({ selfIndex: 0 });
      assert.strictEqual(fastlane.handleSignal(1, { type: 'input' }), false);
      assert.strictEqual(fastlane.handleSignal(1, null), false);
      assert.strictEqual(fastlane.handleSignal(1, 'plain string'), false);
    });

    test('returns true for __rtc envelopes (handler is best-effort)', () => {
      const fastlane = new PartyFastlane({ selfIndex: 0 });
      // selfIndex is set; _handleRtcSignal will try _ensurePeer which needs
      // RTCPeerConnection — wrap so we don't actually call through.
      // Just verify the detection path.
      const result = fastlane.handleSignal.call(
        { _handleRtcSignal() {} },
        1,
        { __rtc: 'offer', sdp: {} }
      );
      assert.strictEqual(result, true);
    });
  });

  // The channel runs maxRetransmits:0 — SCTP gives up after the first try, so ALL
  // loss recovery is app-layer (rolling window + cumulative ack + per-event dedup).
  // The tests above exercise each half in isolation with hand-built packets; these
  // compose the two halves across a hand-pumped, lossy link and assert the only
  // property that ultimately matters: every input reaches the peer exactly once,
  // in order, no matter which packets the link eats.
  describe('loss + retransmit (loopback)', () => {
    // A sender fastlane (talks to peer 1) wired to a receiver fastlane (hears peer
    // 0). The sender's fake channel captures DATA packets; the receiver's captures
    // the ACKs it emits. The test plays the lossy link by hand: it chooses which
    // captured packets to hand across, so any drop/reorder pattern is deterministic.
    function makeLoopback() {
      const applied = [];
      const s = makeFastlane({ selfIndex: 0, peerIdx: 1 });
      const r = makeFastlane({
        selfIndex: 1, peerIdx: 0,
        options: { onInput: (_from, ev) => applied.push(ev) },
      });
      return {
        applied,
        sender: s.fastlane, sPeer: s.peer, sChan: s.channel, sIdx: s.peerIdx, // sIdx = 1
        recv: r.fastlane, rPeer: r.peer, rChan: r.channel, rIdx: r.peerIdx,    // rIdx = 0
      };
    }
    const lastSent = (chan) => chan._sent[chan._sent.length - 1];

    test('a dropped data packet is recovered by the next send; each event applies once', () => {
      const { applied, sender, sPeer, sChan, sIdx, recv, rPeer, rChan, rIdx } = makeLoopback();
      sender.enqueue(sIdx, { a: 1 });       // P0: ps=1, h=[e1]  — this one the link eats
      sender.enqueue(sIdx, { a: 2 });       // P1: ps=2, h=[e2, e1] — e1 still unacked, rides along
      const p1 = sChan._sent[1];
      assert.deepStrictEqual(p1.h, [{ a: 2 }, { a: 1 }], 'the lost event still rides the rolling window');
      // Deliver ONLY P1 (P0 is "lost"). Both events must still land, in order, once.
      recv._handleDataPacket(rPeer, rIdx, p1);
      assert.deepStrictEqual(applied, [{ a: 1 }, { a: 2 }], 'both events delivered exactly once despite the drop');
      // The receiver's cumulative ack (pa=2) drains the recovered ring on the sender.
      const ack = lastSent(rChan);
      assert.strictEqual(ack.pa, 2);
      sender._handleAck(sPeer, sIdx, ack);
      assert.strictEqual(sPeer.ring.length, 0, 'the cumulative ack clears the recovered ring');
      sender.closeAll(); recv.closeAll();
    });

    test('a lost ack keeps the event pending until a later cumulative ack drains it', () => {
      const { applied, sender, sPeer, sChan, sIdx, recv, rPeer, rChan, rIdx } = makeLoopback();
      // e1 delivered → receiver applies it and emits ack(pa=1)...
      sender.enqueue(sIdx, { a: 1 });
      recv._handleDataPacket(rPeer, rIdx, sChan._sent[0]);
      assert.deepStrictEqual(applied, [{ a: 1 }]);
      // ...but the link eats that ack: the sender still holds e1 in its ring.
      assert.strictEqual(sPeer.ring.length, 1, 'a lost ack leaves the event pending');
      // e2 delivered → receiver dedupes e1, applies e2, emits ack(pa=2).
      sender.enqueue(sIdx, { a: 2 });
      recv._handleDataPacket(rPeer, rIdx, lastSent(sChan));
      assert.deepStrictEqual(applied, [{ a: 1 }, { a: 2 }], 'e1 is not re-applied');
      const ack2 = lastSent(rChan);
      assert.strictEqual(ack2.pa, 2);
      // One cumulative ack clears BOTH e1 (whose ack was lost) and e2 — that is what
      // makes the implicit-seq encoding safe: pa is highest-applied, so the tail is contiguous.
      sender._handleAck(sPeer, sIdx, ack2);
      assert.strictEqual(sPeer.ring.length, 0, 'the cumulative ack recovers the lost-ack event too');
      assert.strictEqual(sPeer.lastAckedEs, 2);
      sender.closeAll(); recv.closeAll();
    });

    test('a burst of consecutive drops is recovered by one later packet', () => {
      const { applied, sender, sChan, sIdx, recv, rPeer, rIdx } = makeLoopback();
      // Five events; the link eats every packet but the last. Nothing is acked in
      // between, so all five stay in the window and the survivor carries them all.
      for (let i = 1; i <= 5; i++) sender.enqueue(sIdx, { a: i });
      const survivor = lastSent(sChan);
      assert.strictEqual(survivor.ps, 5);
      assert.strictEqual(survivor.h.length, 5, 'the survivor carries every still-unacked event');
      recv._handleDataPacket(rPeer, rIdx, survivor);
      assert.deepStrictEqual(applied.map((e) => e.a), [1, 2, 3, 4, 5], 'all five recovered in order, once each');
      sender.closeAll(); recv.closeAll();
    });

    test('an unacked ring auto-resends on the TICK_MS cadence (timer-driven retransmit)', (t) => {
      // The resends above were pumped by hand; here the real send timer drives them.
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
      const { fastlane, channel, peerIdx } = makeFastlane();
      fastlane.enqueue(peerIdx, { a: 1 }); // immediate send + schedules the next resend
      assert.strictEqual(channel._sent.length, 1);
      t.mock.timers.tick(50);              // TICK_MS elapses with no ack → resend
      assert.strictEqual(channel._sent.length, 2, 'the unacked event is resent after one tick');
      assert.strictEqual(channel._sent[1].ps, 1, 'the resend repeats the same ring (ps unchanged)');
      t.mock.timers.tick(50);              // still no ack → resend again
      assert.strictEqual(channel._sent.length, 3, 'resends continue while the ring is unacked');
      fastlane.close(peerIdx);             // stop the timer
    });
  });
});
