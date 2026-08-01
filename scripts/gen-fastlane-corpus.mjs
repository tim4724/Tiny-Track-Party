// Generates tests/fixtures/fastlane-corpus.jsonl — the oracle for the C++ twin
// of partyplug/PartyFastlane.js's NETCODE core: the reliability layer that
// carries game input over the DataChannel (rolling send ring + TTL, implicit
// per-event seq, cumulative ack + ring pruning, receive-side dedup, RTT EWMA,
// and the packet classifier + stats counters). The WebRTC handshake itself
// (offer/answer/glare/ICE) stays a platform shim — this is the byte logic.
//
// PartyFastlane is clock-driven (Date.now) and channel-driven, so its oracle is
// a SCRIPT trace, like RoomFlow's: each line is one scenario — a construction
// config plus an op sequence — driving the REAL PartyFastlane with a controlled
// clock and a fake DataChannel (captures ws.send), recording per op the packet
// sent (or none), the events applied, the RTT sample surfaced, and a digest of
// the link state afterwards.
//
//   line 1  header {kind:'fastlane', TTL_MS, TICK_MS, IDLE_MS, WATCHDOG_MS, RTT_ALPHA}
//   line 2+ {name, config:{selfIndex,peerIdx,emitIdleHeartbeat}, steps:[{op, ...args,
//            ret, sent, applied, rtt, digest}]}
//
// Ops: enqueue {ev,t} | sendTick {t} | idle {t} | recv {packet,t} | closeChannel {t}.
// `t` sets the clock (Date.now) before the op. `ret` is enqueue's 'p2p'/'dropped'
// (what the game reads to fall back to the relay). digest = {eventSeq,
// ring:[{es,expires}], lastAckedEs, lastAppliedEs, srtt, out, received, lastPsSeen}.
//
// Deterministic: re-runs are byte-identical.
// Usage: node scripts/gen-fastlane-corpus.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { canonicalStringify } from './oracle-lib.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests/fixtures/fastlane-corpus.jsonl');

global.window = global.window || {};
// Deterministic clock: every op sets `clock` before touching the fastlane, so
// Date.now() (packet t, ring expiry, RTT) is reproducible.
let clock = 0;
global.Date.now = () => clock;
// The netcode schedules resend/idle/watchdog timers we don't want firing during
// recording — the corpus drives every tick explicitly. Stub them to no-ops.
global.setTimeout = () => 0;
global.clearTimeout = () => {};

const require = createRequire(import.meta.url);
const PartyFastlane = require('../partyplug/PartyFastlane.js');

// Netcode constants live as module-locals in PartyFastlane; recover them from
// observed behaviour so the header stamps the real values (and the C++ port
// asserts against them). TTL: enqueue at t=0 then read ring[0].expires. TICK is
// exported outright. The remaining three are still re-typed here: nothing on the
// kit's surface reveals them, so a change to one of THOSE is caught by the
// fastlane wire tests rather than by this corpus.
function probeConstants() {
  const fl = new PartyFastlane({ selfIndex: 0 });
  const ch = { readyState: 'open', _sent: [], send() {}, close() {} };
  fl.peers.set(1, makePeer(ch));
  clock = 0;
  fl.enqueue(1, { probe: true });
  const TTL_MS = fl.peers.get(1).ring[0].expires; // now(0) + TTL_MS
  return { TTL_MS, TICK_MS: PartyFastlane.TICK_MS, IDLE_MS: 500, WATCHDOG_MS: 3000, RTT_ALPHA: 0.1 };
}

// A real RTCDataChannel throws InvalidStateError on send() when not open — the
// netcode swallows that in _writeRaw (so `out` doesn't count the failed write).
// The fake mirrors it, otherwise the closed-channel paths record wrong stats.
function makeFakeChannel() {
  return {
    readyState: 'open',
    _sent: [],
    send(d) {
      if (this.readyState !== 'open') throw new Error('InvalidStateError');
      this._sent.push(JSON.parse(d));
    },
    close() { this.readyState = 'closed'; },
  };
}
function makePeer(channel) {
  return {
    pc: { close() {}, signalingState: 'stable', connectionState: 'connected' },
    channel, pendingCandidates: [], polite: false, makingOffer: false, ignoreOffer: false,
    _waitResolvers: [], eventSeq: 0, ring: [], sendTimer: null, idleTimer: null,
    watchdogTimer: null, lastAckedEs: 0, lastAppliedEs: 0, srtt: 0,
  };
}

function digest(fl, peer, peerIdx) {
  const s = fl.getStats(peerIdx) || { out: 0, received: 0, lastPsSeen: 0 };
  return {
    eventSeq: peer.eventSeq,
    ring: peer.ring.map((e) => ({ es: e.es, expires: e.expires })),
    lastAckedEs: peer.lastAckedEs,
    lastAppliedEs: peer.lastAppliedEs,
    srtt: peer.srtt,
    out: s.out, received: s.received, lastPsSeen: s.lastPsSeen,
  };
}

function runScript(script) {
  const applied = [];
  const rtts = [];
  const fl = new PartyFastlane({
    selfIndex: script.config.selfIndex,
    emitIdleHeartbeat: !!script.config.emitIdleHeartbeat,
    onInput: (from, ev) => applied.push(ev),
    onRtt: (idx, half) => rtts.push(half),
  });
  const peerIdx = script.config.peerIdx;
  const channel = makeFakeChannel();
  const peer = makePeer(channel);
  fl.peers.set(peerIdx, peer);
  // Wire the channel so recv drives the real onmessage path (classify + stats).
  fl._wireChannel(peer, peerIdx, channel);

  const steps = [];
  for (const op of script.steps) {
    clock = op.t;
    const sentBefore = channel._sent.length;
    const appliedBefore = applied.length;
    const rttBefore = rtts.length;

    let ret = null;
    if (op.op === 'enqueue') {
      ret = fl.enqueue(peerIdx, op.ev);   // 'p2p' | 'dropped' — drives relay fallback
    } else if (op.op === 'sendTick') {
      fl._sendDataPacket(peer, peerIdx);
    } else if (op.op === 'idle') {
      fl._sendIdleHeartbeat(peer, peerIdx);
    } else if (op.op === 'recv') {
      channel.onmessage({ data: JSON.stringify(op.packet) });
    } else if (op.op === 'closeChannel') {
      channel.readyState = 'closed';
    } else {
      throw new Error('unknown op ' + op.op);
    }

    const sent = channel._sent.slice(sentBefore);
    steps.push({
      op,
      ret,
      sent: sent.length ? sent[sent.length - 1] : null,
      applied: applied.slice(appliedBefore),
      rtt: rtts.length > rttBefore ? rtts[rtts.length - 1] : null,
      digest: digest(fl, peer, peerIdx),
    });
  }
  return { name: script.name, config: script.config, steps };
}

const C = { selfIndex: 0, peerIdx: 1 };
const scripts = [];

// 1. enqueue bundles the cumulative ring, newest-first, ps = newest es.
scripts.push({ name: 'enqueue-bundle', config: C, steps: [
  { op: 'enqueue', t: 0, ev: { a: 1 } },
  { op: 'enqueue', t: 10, ev: { a: 2 } },
  { op: 'enqueue', t: 20, ev: { a: 3 } },
]});

// 2. TTL expiry is a strict suffix at `expires <= now` (boundary: 300 expires, 299 lives).
scripts.push({ name: 'ttl-expiry-boundary', config: C, steps: [
  { op: 'enqueue', t: 0, ev: { a: 1 } },      // expires at 300
  { op: 'sendTick', t: 299 },                 // alive
  { op: 'sendTick', t: 300 },                 // expires <= now -> pruned, ring empty
]});

// 3. cumulative ack prunes the acked suffix (es <= pa), keeps the head.
scripts.push({ name: 'ack-prune', config: C, steps: [
  { op: 'enqueue', t: 0, ev: { a: 1 } },
  { op: 'enqueue', t: 0, ev: { a: 2 } },
  { op: 'enqueue', t: 0, ev: { a: 3 } },
  { op: 'recv', t: 5, packet: { pa: 2, t: 5 } },   // keep es=3
]});

// 4. stale ack (pa <= lastAckedEs) is idempotent.
scripts.push({ name: 'ack-stale', config: C, steps: [
  { op: 'enqueue', t: 0, ev: { a: 1 } },
  { op: 'enqueue', t: 0, ev: { a: 2 } },
  { op: 'recv', t: 5, packet: { pa: 2, t: 5 } },   // acks both
  { op: 'recv', t: 6, packet: { pa: 1, t: 6 } },   // stale -> no change
]});

// 5. receive applies new events oldest-first, advances lastAppliedEs, acks.
scripts.push({ name: 'recv-apply-order', config: C, steps: [
  { op: 'recv', t: 100, packet: { ps: 3, t: 100, h: [{ a: 3 }, { a: 2 }, { a: 1 }] } },
]});

// 6. duplicate resend applies nothing but still acks.
scripts.push({ name: 'recv-dedup', config: C, steps: [
  { op: 'recv', t: 100, packet: { ps: 3, t: 100, h: [{ a: 3 }, { a: 2 }, { a: 1 }] } },
  { op: 'recv', t: 110, packet: { ps: 3, t: 110, h: [{ a: 3 }, { a: 2 }, { a: 1 }] } },
]});

// 7. mixed new + duplicate applies only the new tail.
scripts.push({ name: 'recv-mixed', config: C, steps: [
  { op: 'recv', t: 100, packet: { ps: 2, t: 100, h: [{ a: 2 }, { a: 1 }] } },
  { op: 'recv', t: 110, packet: { ps: 4, t: 110, h: [{ a: 4 }, { a: 3 }, { a: 2 }] } },
]});

// 8. non-numeric / missing ps -> fully ignored (no apply, NO ack).
scripts.push({ name: 'recv-bad-ps', config: C, steps: [
  { op: 'recv', t: 10, packet: { ps: 'bogus', t: 10, h: [{ a: 1 }] } },
  { op: 'recv', t: 20, packet: { t: 20, h: [{ a: 1 }] } },
]});

// 9. heartbeat (h:[]) -> acked, pa unchanged, t echoed, no apply.
scripts.push({ name: 'recv-heartbeat', config: C, steps: [
  { op: 'recv', t: 100, packet: { ps: 2, t: 100, h: [{ a: 2 }, { a: 1 }] } },
  { op: 'recv', t: 200, packet: { ps: 2, t: 200, h: [] } },
]});

// 10. RTT EWMA: first sample seeds srtt, second blends (alpha 0.1), onRtt = srtt/2.
scripts.push({ name: 'rtt-ewma', config: C, steps: [
  { op: 'recv', t: 1000, packet: { pa: 0, t: 980 } },    // rtt 20 -> srtt 20
  { op: 'recv', t: 2000, packet: { pa: 0, t: 1900 } },   // rtt 100 -> srtt 28
]});

// 11. out-of-range RTT (negative, or >= 500) is discarded; srtt untouched.
scripts.push({ name: 'rtt-out-of-range', config: C, steps: [
  { op: 'recv', t: 1000, packet: { pa: 0, t: 2000 } },   // rtt -1000 -> discard
  { op: 'recv', t: 1000, packet: { pa: 0, t: 400 } },    // rtt 600 -> discard
  { op: 'recv', t: 1000, packet: { pa: 0, t: 500 } },    // rtt 500 (== cutoff) -> discard
]});

// 12. lastPsSeen is the max inbound ps; received counts every inbound frame.
scripts.push({ name: 'lastpsseen', config: C, steps: [
  { op: 'recv', t: 10, packet: { ps: 5, t: 10, h: [{ a: 5 }, { a: 4 }, { a: 3 }, { a: 2 }, { a: 1 }] } },
  { op: 'recv', t: 20, packet: { ps: 3, t: 20, h: [{ a: 3 }] } },   // lower ps, dup -> lastPsSeen stays 5
]});

// 13. classify: pa -> ack path, h -> data path, neither -> ignored.
scripts.push({ name: 'classify', config: C, steps: [
  { op: 'enqueue', t: 0, ev: { a: 1 } },
  { op: 'recv', t: 5, packet: { pa: 1, t: 5 } },          // ack: prunes ring
  { op: 'recv', t: 6, packet: { ps: 1, t: 6, h: [{ a: 9 }] } },  // data: applies + acks
  { op: 'recv', t: 7, packet: { t: 7 } },                 // neither pa nor h -> received++, else no-op
]});

// 14. idle heartbeat (emitIdleHeartbeat sender, empty ring) sends {ps,t,h:[]}.
scripts.push({ name: 'idle-heartbeat', config: { selfIndex: 0, peerIdx: 1, emitIdleHeartbeat: true }, steps: [
  { op: 'idle', t: 500 },                                 // ring empty, eventSeq 0
  { op: 'enqueue', t: 600, ev: { a: 1 } },
  { op: 'recv', t: 610, packet: { pa: 1, t: 610 } },      // drain ring
  { op: 'idle', t: 1100 },                                // ring empty again, eventSeq 1
]});

// 15. interleaved send/ack/recv — a realistic slice.
scripts.push({ name: 'interleaved', config: C, steps: [
  { op: 'enqueue', t: 0, ev: { s: 0.1 } },
  { op: 'enqueue', t: 20, ev: { s: 0.2 } },
  { op: 'recv', t: 40, packet: { ps: 1, t: 40, h: [{ s: -0.5 }] } },  // inbound input + ack
  { op: 'recv', t: 45, packet: { pa: 1, t: 20 } },                     // ack our es=1, rtt 25
  { op: 'sendTick', t: 60 },                                           // resend remaining es=2
  { op: 'recv', t: 80, packet: { pa: 2, t: 60 } },                     // ack es=2, ring empty, rtt 20
]});

// 16. closed channel: enqueue returns 'dropped', ring untouched, nothing sent.
// This return IS the relay-fallback signal in GameNet, so it's contract surface.
scripts.push({ name: 'closed-channel-dropped', config: C, steps: [
  { op: 'enqueue', t: 0, ev: { a: 1 } },        // open: 'p2p'
  { op: 'closeChannel', t: 10 },
  { op: 'enqueue', t: 20, ev: { a: 2 } },       // closed: 'dropped', eventSeq frozen
  { op: 'sendTick', t: 30 },                    // write throws + is swallowed: out stays
  { op: 'idle', t: 40 },                        // guarded: no heartbeat
  { op: 'recv', t: 50, packet: { ps: 1, t: 50, h: [{ a: 7 }] } },  // applies, but ack write fails
]});

// 17. re-ack at an EQUAL pa must be a no-op, not a re-prune. Reachable after a
// link rebuild: our eventSeq restarts at 0 while the peer still acks its old
// high lastAppliedEs, so freshly enqueued events sit BELOW pa. The `>` gate (not
// `>=`) is what protects them — with `>=` the duplicate ack would evict an event
// that was never actually acked. Boundary probe for the ack-advance test.
scripts.push({ name: 'ack-equal-pa-no-reprune', config: C, steps: [
  { op: 'recv', t: 0, packet: { pa: 5, t: 0 } },     // lastAckedEs = 5, ring empty
  { op: 'enqueue', t: 10, ev: { a: 1 } },            // es = 1, i.e. <= pa
  { op: 'recv', t: 20, packet: { pa: 5, t: 20 } },   // equal pa: ring must KEEP es=1
  { op: 'recv', t: 30, packet: { pa: 6, t: 30 } },   // higher pa: now it prunes
]});

const constants = probeConstants();
const lines = [canonicalStringify({ kind: 'fastlane', ...constants })];
for (const s of scripts) lines.push(canonicalStringify(runScript(s)));
// --stdout emits instead of writing, so tests/codegen-freshness.test.js can
// re-derive this corpus and byte-compare without touching the working copy.
const text = lines.join('\n') + '\n';
// --stdout goes to a PIPE, and `process.exit()` right after a write to one
// TRUNCATES it: the write is asynchronous, exit does not flush, and the loss is
// silent at exactly the 64 KiB pipe buffer. Nothing under that size ever
// noticed. So the branch just ends here and the process exits on its own —
// gen-track-defs-header.mjs has always been written this way, which is why its
// 134 KB header survived the same test path.
if (process.argv.includes('--stdout')) {
  process.stdout.write(text);
} else {
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${OUT}: ${scripts.length} scripts, TTL_MS=${constants.TTL_MS}`);
}
