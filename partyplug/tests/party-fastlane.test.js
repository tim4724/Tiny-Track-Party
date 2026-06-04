'use strict';

const { test, describe, beforeEach } = require('node:test');
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
      fastlane.enqueue(peerIdx, { type: 'input', action: 'left' });
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
});
