'use strict';

// ===========================================================================
// WIRE-COMPAT: the FASTLANE, C++ receiver against the real JS sender.
//
// This is the one place in the system where two languages run DIFFERENT
// IMPLEMENTATIONS OF THE SAME RELIABILITY PROTOCOL at input rate, and until this file
// existed nothing ever ran them against each other:
//
//   * tests/fixtures/fastlane-corpus.jsonl replays RECORDED JS. The C++ Link is
//     compared to a transcript, never to a live peer.
//   * partyplug/tests/party-fastlane.test.js drives JS against JS.
//   * tests/e2e never asserts the DataChannel even opens — if negotiation fails,
//     CONTROL silently falls back to the relay and every test still passes. Which
//     is exactly why "fastlane is an enhancement" has never been verified as an
//     enhancement.
//
// So: the DISPLAY side here is the real NativePartyFastlane (netcode in the
// shipped wasm via ttp_link_*), the PHONE side is the real ControllerNet's real
// PartyFastlane (maxRing 1, idle heartbeats, onAcked driving the real InputGate),
// and between them is an unreliable, unordered, controllable pipe
// (tests/wire-compat/rtc.js) that can drop, duplicate, reorder and stall frames.
// Only the WebRTC HANDSHAKE is faked — it has no C++ twin, so faking it would
// only test the fake.
//
// Clock: node's Date.now and setTimeout are stubbed inside withFakeClock, so the
// TICK_MS resend loop, the IDLE_MS heartbeat and the TTL_MS ring expiry all run
// at their real cadences, deterministically. The bodies are synchronous by
// construction (the netcode is), which is what makes stubbing globals safe.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const H = require('./wire-compat/harness.js');
const { Relay } = require('./wire-compat/relay.js');

// Netcode constants, mirrored from partyplug/PartyFastlane.js's module locals and
// native/libttp-party/ttp/fastlane.h (fastlane_check pins the two to each other).
const TICK_MS = 50;
const TTL_MS = 300;
const IDLE_MS = 500;

test.after(() => H.teardownClients());

// Bring up one live link: a real display-side fastlane and a REAL ControllerNet
// (which builds its own phone-side fastlane with the shipping options). The two
// DataChannels are paired but left CLOSED — the caller opens them inside a fake
// clock so every netcode timer is under test control.
async function bringUpLink() {
  const relay = H.setRelay(new Relay());
  const { NativePartyConnection, NativePartyFastlane } = await H.displayAdapters();
  const { ControllerNet } = await H.controllerModules();

  // --- the display: room host + the receiving side of the fastlane -----------
  const host = new NativePartyConnection('ws://relay/', { clientId: 'host-1' });
  let room = null;
  host.onOpen = () => host.create(4, null);
  host.onProtocol = (t, m) => { if (t === 'created') room = m.room; };
  host.connect();
  await H.flush();

  const applied = [];           // events the C++ Link surfaced, in apply order
  const displayRtt = [];
  const display = new NativePartyFastlane({
    selfIndex: 0,
    iceServers: [],
    sendSignal: (peerIdx, sig) => host.sendTo(peerIdx, sig),
    onInput: (peerIdx, ev) => applied.push({ peerIdx, ev }),
    onRtt: (peerIdx, halfMs) => displayRtt.push({ peerIdx, halfMs }),
  });

  // --- the phone: the shipping ControllerNet, which opens its own fastlane ---
  globalThis.location.pathname = '/' + room;
  globalThis.location.search = '';
  globalThis.location.hash = '';
  globalThis.localStorage.setItem('clientId_' + room, 'phone-fast');
  const phoneRtt = [];
  const net = H.trackPhone(new ControllerNet({
    onRtt: (ms, viaFastlane) => phoneRtt.push({ ms, viaFastlane }),
  }));
  net.connect('Ada');
  await H.flush();
  assert.equal(net.peerIndex, 1, 'the phone joined');

  // ControllerNet._openFastlane already ran, so the phone owns a peer + channel.
  const phonePeer = net.fastlane.peers.get(0);
  assert.ok(phonePeer && phonePeer.channel, 'the phone created its DataChannel');

  return { relay, host, display, net, phonePeer, applied, displayRtt, phoneRtt, room };
}

// Pair the two channels and open them, INSIDE a fake clock. Returns the two
// channel objects so a test can drive the medium.
function pairAndOpen(ctx) {
  const displayPeer = ctx.display._ensurePeer(1);
  const { FakeDataChannel } = require('./wire-compat/rtc.js');
  const displayCh = new FakeDataChannel('party');
  ctx.display._wireChannel(displayPeer, 1, displayCh);
  const phoneCh = ctx.phonePeer.channel;
  displayCh._peer = phoneCh;
  phoneCh._peer = displayCh;
  phoneCh.open();
  displayCh.open();
  return { displayCh, phoneCh, displayPeer };
}

// ---------------------------------------------------------------------------
// 1. The gated control stream, end to end
// ---------------------------------------------------------------------------

test('fastlane: every CONTROL sample the phone sends is applied exactly once by C++', async () => {
  const ctx = await bringUpLink();
  H.withFakeClock((clock) => {
    pairAndOpen(ctx);

    // A real steer sweep. E2E phones have no DeviceOrientation, so every live
    // sample there is {s:0,b:0,u:0} and the gate collapses the stream to one
    // idle send per 500 ms — meaning a NON-ZERO steer has never crossed this
    // boundary in any test, live or frozen. Strong deltas (>= STRONG_THRESHOLD)
    // ride the 40 ms floor; the shallower stretches of the sine pace down to
    // the 100 ms baseline, so a 25-sample sweep sends most-but-not-all samples.
    const sent = [];
    for (let i = 0; i < 25; i++) {
      clock.advanceTo(i * 40);
      const sample = { s: Math.round(Math.sin(i / 4) * 1000) / 1000, b: i > 15 ? 1 : 0, u: 0 };
      if (ctx.net.sendControl(sample, clock.now)) sent.push(sample);
    }
    clock.flush();   // let the last packet (and its ack) land
    assert.ok(sent.length >= 15, `the gate should pass a moving stream (${sent.length}/25)`);

    // Every sample reached the sim side, in order, once.
    assert.deepEqual(ctx.applied.map((a) => ({ s: a.ev.s, b: a.ev.b, u: a.ev.u })), sent,
      'applied payloads match the sent samples exactly, in order');
    assert.ok(ctx.applied.every((a) => a.peerIdx === 1), 'attributed to the right seat');
    assert.ok(ctx.applied.every((a) => a.ev.type === 'control'), 'the type tag survives');

    // Every one was ACKED, so the phone's gate knows what the display holds.
    const gate = ctx.net.gate;
    assert.deepEqual(gate._acked, { s: sent.at(-1).s, b: sent.at(-1).b, u: sent.at(-1).u },
      'the gate\'s confirmed value is the newest applied sample');
    assert.equal(gate._pending, false, 'nothing left in flight');
  });
});

test('fastlane: u wraps 255 -> 0 across the language boundary without collapsing', async () => {
  // Game::processInput treats `u` as a level-triggered change-detect
  // (`msg.u != c->useSeq`), so the wrap at 256 must arrive as a DISTINCT value,
  // not be deduped or coerced. The corpus cannot see this (it replays recorded
  // JS on both sides) and E2E cannot (every live sample is u:0).
  //
  // WHAT THIS BREAKS AT A REAL PARTY: the player taps ITEM for the 256th time and
  // nothing happens — the one input in the game where a lost event is not
  // recoverable by the next sample.
  const ctx = await bringUpLink();
  H.withFakeClock((clock) => {
    pairAndOpen(ctx);
    const us = [253, 254, 255, 0, 1, 0];
    let t = 0;
    for (const u of us) {
      t += 40;
      clock.advanceTo(t);
      // Straight onto the fastlane: the gate's own change rules are tested
      // elsewhere, and it would filter the repeated 0 that makes this interesting.
      ctx.net.fastlane.enqueue(0, { s: 0, b: 0, u, type: 'control' });
    }
    clock.flush();
    assert.deepEqual(ctx.applied.map((a) => a.ev.u), us,
      'every value crossed intact, including the wrap and the immediate repeat');
    assert.ok(ctx.applied.every((a) => typeof a.ev.u === 'number'), 'still a number, not a string');
  });
});

// ---------------------------------------------------------------------------
// 2. The reliability layer itself: loss, duplication, reordering
// ---------------------------------------------------------------------------

test('fastlane: a dropped packet is recovered by the resend ring and applied once', async () => {
  const ctx = await bringUpLink();
  H.withFakeClock((clock) => {
    const { phoneCh } = pairAndOpen(ctx);

    // Sample 1 goes out and is LOST on the way.
    phoneCh.medium = () => 'drop';
    clock.advanceTo(40);
    ctx.net.fastlane.enqueue(0, { s: 0.4, b: 0, u: 0, type: 'control' });
    assert.equal(ctx.applied.length, 0, 'the display never saw it');

    // The link heals. The kit's TICK_MS resend re-ships the live ring.
    phoneCh.medium = () => 'deliver';
    clock.advance(TICK_MS);
    assert.equal(ctx.applied.length, 1, 'the resend landed');
    assert.equal(ctx.applied[0].ev.s, 0.4);

    // ...and the ack cleared the ring, so the next tick sends nothing.
    const before = phoneCh.sent.length;
    clock.advance(TICK_MS * 3);
    assert.equal(phoneCh.sent.length, before, 'no further resends once acked');
    assert.equal(ctx.applied.length, 1, 'and it was applied exactly once');
  });
});

test('fastlane: a duplicated packet is deduped by implicit seq, not re-applied', async () => {
  const ctx = await bringUpLink();
  H.withFakeClock((clock) => {
    const { phoneCh } = pairAndOpen(ctx);
    phoneCh.medium = () => 'dup';
    clock.advanceTo(40);
    ctx.net.fastlane.enqueue(0, { s: 0.25, b: 0, u: 0, type: 'control' });
    clock.flush();
    assert.equal(ctx.applied.length, 1, 'the duplicate was recognised by es > lastAppliedEs');
    // Both copies were still COUNTED — the stats are packet counters, not event ones.
    assert.equal(ctx.display.getStats(1).received, 2, 'both frames counted');
    assert.equal(ctx.display.getStats(1).lastPsSeen, 1);
  });
});

test('fastlane: an out-of-order delivery cannot regress the applied state', async () => {
  // The channel is { ordered: false, maxRetransmits: 0 } by design, so the newer
  // packet really can arrive first. `es > lastAppliedEs` is the only thing keeping
  // a stale steer from overwriting a fresh one.
  //
  // WHAT THIS BREAKS AT A REAL PARTY: the car twitches back to where the wheel was
  // 40 ms ago, at random, under load — the exact bug class that is impossible to
  // reproduce by hand.
  const ctx = await bringUpLink();
  H.withFakeClock((clock) => {
    const { phoneCh } = pairAndOpen(ctx);
    phoneCh.medium = () => 'hold';
    clock.advanceTo(40);
    ctx.net.fastlane.enqueue(0, { s: -0.9, b: 0, u: 0, type: 'control' });   // older
    clock.advanceTo(80);
    ctx.net.fastlane.enqueue(0, { s: 0.9, b: 0, u: 0, type: 'control' });    // newer
    assert.equal(ctx.applied.length, 0);

    phoneCh.medium = () => 'deliver';
    phoneCh.releaseHeld({ reverse: true });     // newest packet first
    clock.flush();
    assert.deepEqual(ctx.applied.map((a) => a.ev.s), [0.9],
      'the newer sample was applied and the older one discarded');
  });
});

// ---------------------------------------------------------------------------
// 3. The ack contract — the phone's ONLY truth about what the display holds
// ---------------------------------------------------------------------------

test('fastlane: the C++ ack is what drives the phone\'s send gate', async () => {
  // The ack is a C++ ENCODER whose only consumer is JS: `pa` prunes the phone's
  // ring and feeds InputGate.markAcked, `t` drives the RTT EWMA that sets the
  // resend cadence. A C++ host that got `pa` wrong would silently stall or
  // duplicate the control stream, and no live test would notice.
  const ctx = await bringUpLink();
  H.withFakeClock((clock) => {
    const { phoneCh, displayCh } = pairAndOpen(ctx);

    clock.advanceTo(40);
    ctx.net.sendControl({ s: 0.5, b: 0, u: 0 }, clock.now);
    clock.flush();   // the packet lands, C++ applies it, the ack comes back

    const ack = JSON.parse(displayCh.sent.at(-1));
    assert.deepEqual(Object.keys(ack).sort(), ['pa', 't'], 'the ack carries exactly pa and t');
    assert.equal(ack.pa, 1, 'cumulative highest applied');
    assert.equal(ack.t, JSON.parse(phoneCh.sent.at(-1)).t, 'the sender\'s clock echoed VERBATIM');

    // The gate now believes the display holds this exact sample, so an identical
    // one is filtered.
    assert.equal(ctx.net.gate.decide({ s: 0.5, b: 0, u: 0 }, clock.now, 0), null,
      'a confirmed value is not re-sent');
    // ...and a sub-threshold drift is filtered too, which is only safe BECAUSE the
    // ack was accurate.
    assert.equal(ctx.net.gate.decide({ s: 0.51, b: 0, u: 0 }, clock.now, 0), null);
    // A sub-strong change (0.1 of authority) rides the 100 ms baseline cadence,
    // so straight after the send it defers — and goes once the window opens.
    assert.equal(ctx.net.gate.decide({ s: 0.6, b: 0, u: 0 }, clock.now, 0), null,
      'sub-strong news inside the baseline window is deferred, not sent');
    clock.advance(100);
    assert.equal(ctx.net.gate.decide({ s: 0.6, b: 0, u: 0 }, clock.now, 0), 'change');
  });
});

test('fastlane: an ack for an already-expired entry stays SILENT, and C++ cannot say otherwise', async () => {
  // PartyFastlane._handleAck fires onAcked only when it can still name the payload
  // the ack covers; if the entry already TTL-expired out of the ring it stays
  // silent, so a gating sender does NOT advance its confirmed state and errs
  // toward re-sending. That rule is load-bearing for InputGate.
  //
  // THE GAP: fastlane::Outcome has no `acked` field and ttp_link_* never returns
  // one, so the whole send-gating contract is UNPORTED. It costs nothing today
  // because the display is the receiver — but the moment a TV shell sends over the
  // fastlane (or the controller moves to wasm), there is no ack callback to build
  // a gate on. This test pins both halves: the kit's rule, and the absence.
  const abi = await H.loadAbi();

  // (a) the kit's rule, on the real class.
  const { PartyFastlane } = H.kit();
  const acked = [];
  const fl = new PartyFastlane({ selfIndex: 0, onAcked: (i, ev, es) => acked.push({ i, ev, es }) });
  const ch = { readyState: 'open', send() {}, close() {} };
  fl.peers.set(1, {
    pc: { close() {}, signalingState: 'stable' }, channel: ch, pendingCandidates: [],
    polite: false, makingOffer: false, ignoreOffer: false, _waitResolvers: [],
    eventSeq: 0, ring: [], sendTimer: null, idleTimer: null, watchdogTimer: null,
    lastAckedEs: 0, lastAppliedEs: 0, srtt: 0,
  });
  H.withFakeClock((clock) => {
    clock.advanceTo(0);
    fl.enqueue(1, { s: 0.1 });
    fl._handleAck(fl.peers.get(1), 1, { pa: 1 });
    assert.equal(acked.length, 1, 'a live entry is named');
    assert.deepEqual(acked[0].ev, { s: 0.1 });

    clock.advanceTo(100);
    fl.enqueue(1, { s: 0.2 });
    clock.advanceTo(100 + TTL_MS + 1);
    fl._sendDataPacket(fl.peers.get(1), 1);       // TTL prune empties the ring
    fl._handleAck(fl.peers.get(1), 1, { pa: 2 });
    assert.equal(acked.length, 1, 'an expired entry is NOT named — silence is the safe direction');
  });

  // (b) the absence, on the real ABI. No op returns which payload was confirmed.
  const h = abi.link.create();
  abi.link.enqueue(h, JSON.stringify({ s: 0.1 }), 0);
  const outcome = JSON.parse(abi.link.inbound(h, JSON.stringify({ pa: 1, t: 0 }), 10));
  assert.deepEqual(Object.keys(outcome).sort(), ['applied', 'dropped', 'packet', 'rtt', 'sent'],
    'the outcome has no `acked` field — the gating contract has no C++ surface');
  abi.link.dispose(h);
});

test('fastlane: the ack DROPS `t` when the data packet had none, exactly as JSON.stringify would', async () => {
  // sendAck sets `t` to an UNDEF Value when the packet had none, and
  // canonical_stringify drops UNDEF keys. The phone tests `typeof ack.t ===
  // 'number'`, so a `t` that came back as null (or 0) would poison the RTT EWMA
  // with a garbage sample instead of being ignored.
  const abi = await H.loadAbi();
  const h = abi.link.create();
  const withT = JSON.parse(abi.link.inbound(h, '{"ps":1,"t":123,"h":[{"s":1}]}', 200));
  assert.equal(withT.packet.t, 123);
  const noT = JSON.parse(abi.link.inbound(h, '{"ps":2,"h":[{"s":1}]}', 200));
  assert.ok(!('t' in noT.packet), `an absent t stays absent: ${JSON.stringify(noT.packet)}`);
  assert.equal(noT.packet.pa, 2);

  // And the kit really does ignore it rather than treating it as 0.
  const { PartyFastlane } = H.kit();
  const rtts = [];
  const fl = new PartyFastlane({ selfIndex: 1, onRtt: (i, ms) => rtts.push(ms) });
  const peer = { ring: [], lastAckedEs: 0, lastAppliedEs: 0, srtt: 0, sendTimer: null, idleTimer: null, channel: { readyState: 'open', send() {} } };
  fl._handleAck(peer, 0, noT.packet);
  assert.deepEqual(rtts, [], 'no `t` means no RTT sample, not a bogus one');
  abi.link.dispose(h);
});

test('fastlane: the RTT the phone shows comes from C++ echoing the phone\'s own clock', async () => {
  const ctx = await bringUpLink();
  H.withFakeClock((clock) => {
    const { phoneCh } = pairAndOpen(ctx);
    // Delay the ack by holding the phone's packet, then releasing it at a known
    // offset — the ack echoes `t` from the packet, so the phone measures exactly
    // the round trip we impose.
    phoneCh.medium = () => 'hold';
    clock.advanceTo(1000);
    ctx.net.fastlane.enqueue(0, { s: 0.1, b: 0, u: 0, type: 'control' });
    clock.advanceTo(1040);                        // 40 ms of flight
    phoneCh.medium = () => 'deliver';
    phoneCh.releaseHeld();
    clock.flush();

    // srtt seeds to the first sample; onRtt reports srtt/2.
    assert.deepEqual(ctx.phoneRtt.at(-1), { ms: 20, viaFastlane: true });
    // ...and ControllerNet feeds the round trip (not the half) back to the gate,
    // which is what sets the unacked-resend cadence.
    assert.equal(ctx.net._srtt, 40);
  });
});

// ---------------------------------------------------------------------------
// 4. The asymmetries the two implementations carry
// ---------------------------------------------------------------------------

test('asym: the C++ Link has NO maxRing, so a native sender would ship ~6x the payload', async () => {
  // The kit's cap is load-bearing and the controller sets it to 1 on purpose
  // (controller/Net.js, _openFastlane's maxRing): CONTROL is absolute state, so the newest packet
  // already describes the world and the older copies riding with it are dead
  // weight. fastlane::Link has no cap at all, and gen-fastlane-corpus.mjs never
  // sets maxRing — so the frozen oracle cannot see the gap.
  //
  // WHAT THIS BREAKS AT A REAL PARTY: the day a TV shell (or a wasm controller)
  // becomes a fastlane SENDER, every packet carries the whole 300 ms TTL window —
  // several samples' worth instead of one — on the exact link the fastlane exists to
  // keep small.
  const abi = await H.loadAbi();
  const { PartyFastlane } = H.kit();

  // C++: enqueue six samples inside one TTL window.
  const h = abi.link.create();
  let last = null;
  for (let i = 0; i < 6; i++) {
    last = JSON.parse(abi.link.enqueue(h, JSON.stringify({ s: i / 10, type: 'control' }), i * 40));
  }
  assert.equal(last.packet.h.length, 6, 'the C++ Link ships the entire TTL window');
  assert.equal(last.packet.ps, 6);
  abi.link.dispose(h);

  // The kit, with the controller's own option, ships one.
  const fl = new PartyFastlane({ selfIndex: 1, maxRing: 1 });
  const sent = [];
  fl.peers.set(0, {
    pc: { close() {}, signalingState: 'stable' },
    channel: { readyState: 'open', send: (t) => sent.push(JSON.parse(t)), close() {} },
    pendingCandidates: [], polite: true, makingOffer: false, ignoreOffer: false,
    _waitResolvers: [], eventSeq: 0, ring: [], sendTimer: null, idleTimer: null,
    watchdogTimer: null, lastAckedEs: 0, lastAppliedEs: 0, srtt: 0,
  });
  H.withFakeClock((clock) => {
    for (let i = 0; i < 6; i++) { clock.advanceTo(i * 40); fl.enqueue(0, { s: i / 10, type: 'control' }); }
  });
  assert.equal(sent.at(-1).h.length, 1, 'the shipping phone ships latest-only');
  assert.equal(sent.at(-1).ps, 6, 'seq still advances across the discards');

  // The receiver copes with either, which is why this is a payload bug and not a
  // correctness one — the implicit seq decoding holds for both shapes.
  const r = abi.link.create();
  const wide = JSON.parse(abi.link.inbound(r, JSON.stringify({ ps: 6, t: 0, h: [5, 4, 3, 2, 1, 0].map((n) => ({ s: n / 10 })) }), 0));
  assert.deepEqual(wide.applied.map((e) => e.s), [0, 0.1, 0.2, 0.3, 0.4, 0.5], 'applied oldest-first');
  abi.link.dispose(r);
});

test('fastlane: a C++-SENT packet decodes in the real JS receiver, in the right order', async () => {
  // The display is the RECEIVING side today, so nothing in the browser ever runs
  // the C++ Link as a SENDER — and this suite very nearly inherited that blind
  // spot. scripts/wire-mutate.mjs caught it: reversing
  //
  //     for (const RingEntry& e : ring_) h.push(e.ev);      // fastlane.cc:63
  //
  // to iterate the ring backwards turned NO test red, because the only test that
  // looked at a C++-authored multi-event packet checked its LENGTH, not its ORDER.
  //
  // The order is the entire per-event seq encoding. `h` is newest-first and es is
  // implicit (es[i] = ps - i), so a reversed `h` makes the receiver apply the
  // events backwards AND leave the OLDEST sample as the final state. For CONTROL
  // that is a car stuck holding a steer value from 120 ms ago, forever, with no
  // error anywhere.
  //
  // WHAT THIS BREAKS AT A REAL PARTY: nothing today. It breaks the day a tvOS or
  // Android shell sends over the fastlane — which is precisely the port this whole
  // suite exists to protect, so the gate has to bite BEFORE that code is written.
  const abi = await H.loadAbi();

  // Build a real multi-event packet with the C++ sender.
  const h = abi.link.create();
  const events = [{ s: 0.1, u: 1 }, { s: 0.2, u: 2 }, { s: 0.3, u: 3 }];
  let packet = null;
  events.forEach((ev, i) => { packet = JSON.parse(abi.link.enqueue(h, JSON.stringify(ev), i * 40)).packet; });
  abi.link.dispose(h);
  assert.equal(packet.ps, 3);
  assert.deepEqual(packet.h, [...events].reverse(), 'the C++ ring is NEWEST-FIRST on the wire');

  // Now decode it with the real JS receiver, through the real channel wiring.
  const { PartyFastlane } = H.kit();
  const { FakeDataChannel } = require('./wire-compat/rtc.js');
  const applied = [];
  const fl = new PartyFastlane({ selfIndex: 1, onInput: (_i, ev) => applied.push(ev) });
  const peer = {
    pc: { close() {}, signalingState: 'stable' }, channel: null, pendingCandidates: [],
    polite: false, makingOffer: false, ignoreOffer: false, _waitResolvers: [],
    eventSeq: 0, ring: [], sendTimer: null, idleTimer: null, watchdogTimer: null,
    lastAckedEs: 0, lastAppliedEs: 0, srtt: 0,
  };
  fl.peers.set(0, peer);
  const ch = new FakeDataChannel('party');
  H.withFakeClock(() => {
    fl._wireChannel(peer, 0, ch);
    ch.open();
    ch.onmessage({ data: JSON.stringify(packet) });
    // A retransmit of the same packet must change nothing.
    ch.onmessage({ data: JSON.stringify(packet) });
  });

  assert.deepEqual(applied, events, 'applied OLDEST-FIRST, in source order, exactly once');
  assert.equal(peer.lastAppliedEs, 3, 'and the seq decoding agrees with the C++ ps');
  assert.deepEqual(applied.at(-1), events.at(-1), 'the NEWEST sample is the one left holding');
});

test('fastlane: a C++ SENDER stops resending what the ack covered, and keeps what it did not', async () => {
  // The same blind spot as the test above, one step further down the same path.
  // Sending is half of being a sender; the other half is RETIRING what the peer
  // confirmed, and the C++ Link's ack handling had no assertion anywhere in this
  // suite. The one test that feeds an ack into a C++ sender
  // ("an ack for an already-expired entry stays SILENT") asserts the outcome's
  // SHAPE — Object.keys(outcome) — and never that the ring pruned.
  //
  // The prune is a boundary: `es <= pa` is a strict suffix of a newest-first ring.
  // Off by one and a fully-acked event is never retired, so the sender re-ships it
  // on every tick — forever, at 20 Hz, on the link the fastlane exists to keep
  // small — while the receiver dedupes it into silence. Nothing breaks; everything
  // costs more. That is precisely the failure a shell port produces and a
  // transcript-replay corpus cannot show you.
  const abi = await H.loadAbi();

  // (a) FULLY acked: one event, one full ack, then a send tick that must be mute.
  {
    const h = abi.link.create();
    const first = JSON.parse(abi.link.enqueue(h, JSON.stringify({ s: 0.1, type: 'control' }), 0));
    assert.equal(first.sent, true, 'the event went out');
    assert.equal(first.packet.ps, 1);
    const acked = JSON.parse(abi.link.inbound(h, JSON.stringify({ pa: 1, t: 0 }), 10));
    assert.deepEqual(acked.applied, [], 'an ack carries no events');
    const tick = JSON.parse(abi.link.sendTick(h, 60));
    assert.equal(tick.sent, false, `an acked ring has nothing to resend: ${JSON.stringify(tick.packet)}`);
    assert.equal(tick.packet, null);
    // A SECOND ack at the same pa is idempotent — re-acks are expected (the C++
    // receiver re-acks duplicates on purpose), and one must not resurrect a ring.
    abi.link.inbound(h, JSON.stringify({ pa: 1, t: 0 }), 20);
    assert.equal(JSON.parse(abi.link.sendTick(h, 120)).sent, false, 're-acking changes nothing');
    abi.link.dispose(h);
  }

  // (b) PARTIALLY acked: three events, an ack covering the oldest two, and the
  //     resend must be exactly the unacked head — same shape, newest-first, with
  //     ps unchanged so the receiver's implicit es[i] = ps - i still decodes.
  {
    const h = abi.link.create();
    for (let i = 1; i <= 3; i++) abi.link.enqueue(h, JSON.stringify({ s: i / 10, type: 'control' }), i * 40);
    abi.link.inbound(h, JSON.stringify({ pa: 2, t: 0 }), 130);
    const resend = JSON.parse(abi.link.sendTick(h, 200));
    assert.equal(resend.sent, true, 'the unacked tail is still live');
    assert.equal(resend.packet.ps, 3, 'ps still names the newest event seq');
    assert.deepEqual(resend.packet.h, [{ s: 0.3, type: 'control' }],
      'exactly the unacked head — not the acked prefix, not the whole window');

    // ...and the real JS receiver decodes that pruned packet to the right event.
    const { PartyFastlane } = H.kit();
    const applied = [];
    const fl = new PartyFastlane({ selfIndex: 1, onInput: (_i, ev) => applied.push(ev) });
    const peer = {
      pc: { close() {}, signalingState: 'stable' }, channel: null, pendingCandidates: [],
      polite: false, makingOffer: false, ignoreOffer: false, _waitResolvers: [],
      eventSeq: 0, ring: [], sendTimer: null, idleTimer: null, watchdogTimer: null,
      lastAckedEs: 0, lastAppliedEs: 2, srtt: 0,      // it already applied 1 and 2
    };
    fl.peers.set(0, peer);
    const { FakeDataChannel } = require('./wire-compat/rtc.js');
    const ch = new FakeDataChannel('party');
    H.withFakeClock(() => {
      fl._wireChannel(peer, 0, ch);
      ch.open();
      ch.onmessage({ data: JSON.stringify(resend.packet) });
    });
    assert.deepEqual(applied, [{ s: 0.3, type: 'control' }], 'the pruned resend lands as event 3');
    assert.equal(peer.lastAppliedEs, 3);
    abi.link.dispose(h);
  }
});

test('asym: a packet with neither `pa` nor `h` is counted and silently ignored by BOTH', async () => {
  // Classification is by PRESENCE, not by type. A malformed packet raises no error
  // on either side; it just inflates the received counter. Pinned so that a future
  // packet kind cannot be added by accident and vanish.
  const abi = await H.loadAbi();
  const h = abi.link.create();
  const oc = JSON.parse(abi.link.inbound(h, '{"ps":9,"t":1}', 0));
  assert.equal(oc.sent, false, 'no ack, no apply');
  assert.deepEqual(oc.applied, []);
  const st = JSON.parse(abi.link.stats(h));
  assert.equal(st.received, 1, 'but it WAS counted');
  assert.equal(st.lastPsSeen, 9, 'and it moved lastPsSeen');
  abi.link.dispose(h);

  // The kit's onmessage does the same thing (counts, then falls through both
  // branches). Driven through the real _wireChannel wiring.
  const { PartyFastlane } = H.kit();
  const fl = new PartyFastlane({ selfIndex: 0 });
  const peer = {
    pc: { close() {}, signalingState: 'stable' }, channel: null, pendingCandidates: [],
    polite: false, makingOffer: false, ignoreOffer: false, _waitResolvers: [],
    eventSeq: 0, ring: [], sendTimer: null, idleTimer: null, watchdogTimer: null,
    lastAckedEs: 0, lastAppliedEs: 0, srtt: 0,
  };
  fl.peers.set(1, peer);
  const { FakeDataChannel } = require('./wire-compat/rtc.js');
  const ch = new FakeDataChannel('party');
  H.withFakeClock(() => {
    fl._wireChannel(peer, 1, ch);
    ch.open();
    ch.onmessage({ data: '{"ps":9,"t":1}' });
  });
  assert.equal(fl.getStats(1).received, 1);
  assert.equal(fl.getStats(1).lastPsSeen, 9);
});

test('fastlane: a closed channel drops on both sides without counting the write', async () => {
  const abi = await H.loadAbi();
  const h = abi.link.create();
  abi.link.setOpen(h, 0);
  const oc = JSON.parse(abi.link.enqueue(h, JSON.stringify({ s: 1 }), 0));
  assert.equal(oc.dropped, true, 'C++ says dropped — the relay-fallback signal');
  assert.equal(JSON.parse(abi.link.stats(h)).out, 0, 'a swallowed write is not counted');
  abi.link.dispose(h);

  const ctx = await bringUpLink();
  H.withFakeClock(() => {
    const { phoneCh } = pairAndOpen(ctx);
    phoneCh.readyState = 'closed';
    assert.equal(ctx.net.fastlane.enqueue(0, { s: 1, type: 'control' }), 'dropped');
  });
  // ...and sendControl then falls back to the relay, which is the "enhancement"
  // half of the architecture rule. Nothing else in the tree asserts the fallback.
  H.withFakeClock((clock) => {
    const relayFrames = ctx.relay.log.filter((e) => e.dir === 'c2s' && e.text.includes('"control"'));
    const before = relayFrames.length;
    ctx.net.sendControl({ s: 0.7, b: 0, u: 0 }, clock.now);
    const after = ctx.relay.log.filter((e) => e.dir === 'c2s' && e.text.includes('"control"')).length;
    assert.equal(after, before + 1, 'CONTROL fell back to the WebSocket relay');
  });
});

test('fastlane: idle heartbeats keep acks (and therefore the RTT chip) alive with no input', async () => {
  // The controller sets emitIdleHeartbeat:true; the display leaves it false. A
  // heartbeat is a data packet with h:[] and an UNCHANGED ps, and its whole job is
  // to refresh `t` so the ack yields an RTT sample.
  const ctx = await bringUpLink();
  H.withFakeClock((clock) => {
    const { phoneCh, displayCh } = pairAndOpen(ctx);
    clock.advanceTo(40);
    ctx.net.fastlane.enqueue(0, { s: 0.3, b: 0, u: 0, type: 'control' });
    const psAfterData = JSON.parse(phoneCh.sent.at(-1)).ps;
    clock.flush();                      // packet lands, ack comes back, ring drains
    const acksBefore = displayCh.sent.length;
    assert.equal(acksBefore, 1, 'the data packet was acked');

    clock.advance(IDLE_MS);
    const hb = JSON.parse(phoneCh.sent.at(-1));
    assert.deepEqual(hb.h, [], 'a heartbeat carries an empty h');
    assert.equal(hb.ps, psAfterData, 'ps is UNCHANGED — no new event was added');
    assert.equal(displayCh.sent.length, acksBefore + 1, 'and it was still acked');
    assert.equal(ctx.applied.length, 1, 'without re-applying anything');

    // The display never emits heartbeats of its own — it is the receiving side.
    assert.ok(displayCh.sent.every((t) => 'pa' in JSON.parse(t)), 'the display only ever acks');
  });
});

test('fastlane: the display\'s stats come from the wasm Link, not the kit\'s counters', async () => {
  // NativePartyFastlane.getStats reads ttp_link_stats_json and the kit's own
  // counters are never advanced. A shell reading the wrong one gets zeroes.
  const ctx = await bringUpLink();
  H.withFakeClock((clock) => {
    pairAndOpen(ctx);
    for (let i = 0; i < 5; i++) {
      clock.advanceTo(40 * (i + 1));
      ctx.net.fastlane.enqueue(0, { s: i / 10, b: 0, u: 0, type: 'control' });
    }
    clock.flush();
    const s = ctx.display.getStats(1);
    assert.equal(s.received, 5, 'five data packets');
    assert.equal(s.out, 5, 'five acks written');
    assert.equal(s.lastPsSeen, 5, 'the peer\'s highest event seq');
    // The kit's own map was never touched on the display side.
    assert.equal(ctx.display._stats.size, 0, 'the JS counters stayed at zero');
  });
});
