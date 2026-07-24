// Generates tests/fixtures/roomflow-corpus.jsonl — the behavioural oracle for
// the C++ RoomFlow port (libttp-party, the sans-IO room-semantics layer).
//
// RoomFlow is a pure, clock-free state machine (nowMs injected everywhere),
// so its oracle is a SCRIPT trace: each fixture line is one scripted run —
// a construction config plus an op sequence — with, per op, the return value,
// the events emitted during that op (in order), and a digest of every PUBLIC
// observation afterwards. The digest deliberately reads only the public
// surface (state/host/list/size/connectedCount/isDisconnected/
// allParticipantsDisconnected/hasLateJoiners), so the C++ port may structure
// its internals freely; time-parameterised predicates (expiredPeers,
// isExpired, graceTick, clearDisconnected) are exercised as explicit ops.
//
// Scripts: hand-authored scenarios for the documented behaviours (host
// election + sticky-slot reclaim, COUNTDOWN order snapshot, restricted
// mid-game joins + late-joiner grace, liveness expiry/revival) plus seeded
// random sweeps (mulberry32) that also exercise INVALID calls — rejected
// transitions, unknown peers — because the recorded behaviour IS the
// contract, error paths included.
//
// Deterministic: re-runs are byte-identical.
// Usage: node scripts/gen-roomflow-corpus.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mulberry32 } from '../public/display/engine/util.js';
import { canonicalStringify } from './record-trace.mjs';

const require = createRequire(import.meta.url);
const RoomFlow = require('../partyplug/RoomFlow.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests/fixtures/roomflow-corpus.jsonl');

const EVENTS = ['hostchange', 'playerjoin', 'playerleave', 'playerupdate', 'rosterchange', 'statechange'];

// JSON-safe projection of any RoomFlow return value (player records, lists,
// scalars). Undefined -> null so returns always occupy the slot.
const proj = (v) => v === undefined ? null : JSON.parse(JSON.stringify(v));

function runScript(script) {
  // RoomFlow console.warns on rejected transitions — contract behaviour the
  // random sweeps exercise on purpose; keep the generator's output readable.
  const warn = console.warn;
  console.warn = () => {};
  try {
    return runScriptInner(script);
  } finally {
    console.warn = warn;
  }
}

function runScriptInner(script) {
  let masterValue = script.master ?? null;
  let livenessEnabled = true;
  const flow = new RoomFlow({
    ...(script.useMasterProvider ? { masterProvider: () => masterValue } : {}),
    ...(script.liveness ? {
      liveness: {
        ...script.liveness,
        ...(script.liveness.useEnabledProvider ? { enabledProvider: () => livenessEnabled } : {})
      }
    } : {})
  });

  let captured = [];
  for (const type of EVENTS) flow.on(type, (detail) => captured.push({ type, detail: proj(detail) }));

  const peers = new Set(); // every peer id the script has mentioned (for digests)
  const digest = () => ({
    state: flow.state,
    host: proj(flow.host),
    size: flow.size,
    connectedCount: flow.connectedCount,
    list: proj(flow.list()),
    allDisconnected: flow.allParticipantsDisconnected(),
    hasLateJoiners: flow.hasLateJoiners(),
    perPeer: [...peers].sort((a, b) => (a > b ? 1 : a < b ? -1 : 0)).map((p) => ({
      p, has: flow.has(p), isHost: flow.isHost(p), disc: flow.isDisconnected(p)
    }))
  });

  const steps = [];
  for (const op of script.ops) {
    for (const k of ['p', 'oldId', 'newId']) if (op[k] !== undefined) peers.add(op[k]);
    captured = [];
    let ret = null;
    switch (op.op) {
      case 'add': ret = proj(flow.addPlayer(op.p, op.fields)); break;
      case 'remove': ret = proj(flow.removePlayer(op.p)); break;
      case 'rekey': ret = proj(flow.rekey(op.oldId, op.newId)); break;
      case 'markDisc': ret = proj(flow.markDisconnected(op.p)); break;
      case 'markReconn': ret = proj(flow.markReconnected(op.p)); break;
      case 'clearDisc': ret = proj(flow.clearDisconnected(op.t)); break;
      case 'transition': ret = proj(flow.transitionTo(op.to)); break;
      case 'endGame': ret = proj(flow.endGame()); break;
      case 'returnToLobby': ret = proj(flow.returnToLobby()); break;
      case 'setOrder': ret = proj(flow.setActiveOrder(op.order)); break;
      case 'seen': ret = proj(flow.onSeen(op.p, op.t)); break;
      case 'isExpired': ret = proj(flow.isExpired(op.p, op.t)); break;
      case 'expiredPeers': ret = proj(flow.expiredPeers(op.t)); break;
      case 'graceTick': ret = proj(flow.graceTick(op.t)); break;
      case 'setMaster': masterValue = op.v; break;
      case 'setLivenessEnabled': livenessEnabled = op.v; break;
      case 'reset': ret = proj(flow.reset()); break;
      default: throw new Error(`unknown op ${op.op}`);
    }
    steps.push({ op, ret, events: captured, digest: digest() });
  }
  return steps;
}

const fieldsFor = (p) => ({ name: `P${p}`, colorIndex: p % 8 });

// ---- hand-authored scenarios --------------------------------------------
const scenarios = [];

scenarios.push({
  name: 'host-election-and-sticky-reclaim',
  liveness: null,
  ops: [
    { op: 'add', p: 3, fields: fieldsFor(3) },           // first joiner = sticky host
    { op: 'add', p: 1, fields: fieldsFor(1) },
    { op: 'add', p: 7, fields: fieldsFor(7) },
    { op: 'transition', to: 'countdown' },                // snapshots order
    { op: 'transition', to: 'playing' },
    { op: 'markDisc', p: 3 },                             // mid-game host drop: slot stays, effective host falls back
    { op: 'markReconn', p: 3 },                           // host reclaims
    { op: 'markDisc', p: 3 },
    { op: 'remove', p: 3 },                               // hard leave mid-game: slot untouched, fallback again
    { op: 'transition', to: 'results' },
    { op: 'returnToLobby' },
    { op: 'add', p: 3, fields: fieldsFor(3) },            // rejoins in lobby: fresh joinedAt, no auto-host
    { op: 'remove', p: 1 }, { op: 'remove', p: 7 }, { op: 'remove', p: 3 },
    { op: 'add', p: 5, fields: fieldsFor(5) }             // emptied room: next joiner takes the slot
  ]
});

scenarios.push({
  name: 'restricted-joins-and-late-grace',
  liveness: { timeoutMs: 3000, graceMs: 1500 },
  ops: [
    { op: 'add', p: 0, fields: fieldsFor(0) },
    { op: 'add', p: 1, fields: fieldsFor(1) },
    { op: 'transition', to: 'countdown' },
    { op: 'transition', to: 'playing' },
    { op: 'add', p: 2, fields: fieldsFor(2) },            // mid-game join → late joiner
    { op: 'graceTick', t: 1000 },
    { op: 'graceTick', t: 2400 },
    { op: 'graceTick', t: 2600 },
    { op: 'transition', to: 'results' },
    { op: 'transition', to: 'countdown' },                // RESULTS→COUNTDOWN chain re-snapshots order (now incl. 2)
    { op: 'transition', to: 'playing' },
    { op: 'endGame' },
    { op: 'returnToLobby' }
  ]
});

scenarios.push({
  name: 'liveness-expiry-and-revival',
  liveness: { timeoutMs: 3000, graceMs: 0, useEnabledProvider: true },
  ops: [
    { op: 'add', p: 0, fields: fieldsFor(0) },
    { op: 'add', p: 1, fields: fieldsFor(1) },
    { op: 'seen', p: 0, t: 1000 }, { op: 'seen', p: 1, t: 1000 },
    { op: 'expiredPeers', t: 3500 },                      // neither expired (3500-1000 < 3000? boundary: 2500 < 3000)
    { op: 'expiredPeers', t: 4000 },                      // exactly at timeout — boundary semantics recorded
    { op: 'expiredPeers', t: 4001 },
    { op: 'seen', p: 1, t: 4200 },                        // 1 revives
    { op: 'expiredPeers', t: 7300 },
    { op: 'isExpired', p: 0, t: 7300 },
    { op: 'markDisc', p: 0 },                             // host applies the expiry
    { op: 'setLivenessEnabled', v: false },
    { op: 'expiredPeers', t: 99999 },                     // suppressed
    { op: 'setLivenessEnabled', v: true },
    { op: 'seen', p: 0, t: 100000 },                      // traffic restores
    { op: 'markReconn', p: 0 },
    { op: 'expiredPeers', t: 102000 }
  ]
});

scenarios.push({
  // The exact-at-timeout boundary, probed IN A RACE STATE: isExpired uses
  // strict `>` (diff == timeoutMs is still alive), and the only prior probe
  // at the boundary sat in LOBBY where expiredPeers short-circuits — a
  // `>`→`>=` mutation survived the corpus (found by the C++ port's author).
  name: 'liveness-exact-boundary-in-race',
  liveness: { timeoutMs: 3000, graceMs: 0 },
  ops: [
    { op: 'add', p: 0, fields: fieldsFor(0) },
    { op: 'add', p: 1, fields: fieldsFor(1) },
    { op: 'transition', to: 'countdown' },
    { op: 'transition', to: 'playing' },
    { op: 'seen', p: 0, t: 1000 }, { op: 'seen', p: 1, t: 2000 },
    { op: 'isExpired', p: 0, t: 3999 },   // diff 2999 < timeout: alive
    { op: 'isExpired', p: 0, t: 4000 },   // diff EXACTLY timeout: alive (strict >)
    { op: 'isExpired', p: 0, t: 4001 },   // diff 3001: expired
    { op: 'expiredPeers', t: 4000 },      // boundary via the sweep too: only sub-boundary peers stay
    { op: 'expiredPeers', t: 5000 },      // p0 over (4000ms), p1 exactly at (3000ms): only p0
    { op: 'expiredPeers', t: 5001 }       // both over
  ]
});

scenarios.push({
  name: 'rekey-through-disconnect-and-order',
  liveness: { timeoutMs: 3000, graceMs: 0 },
  ops: [
    { op: 'add', p: 10, fields: fieldsFor(10) },
    { op: 'add', p: 11, fields: fieldsFor(11) },
    { op: 'add', p: 12, fields: fieldsFor(12) },
    { op: 'setOrder', order: [12, 10] },                  // explicit active order
    { op: 'transition', to: 'countdown' },
    { op: 'markDisc', p: 10 },
    { op: 'rekey', oldId: 10, newId: 20 },                // reconnect on a new device mid-window
    { op: 'transition', to: 'playing' },
    { op: 'rekey', oldId: 12, newId: 10 },                // rekey onto a JUST-VACATED id
    { op: 'rekey', oldId: 99, newId: 100 },               // unknown source: recorded no-op
    { op: 'clearDisc', t: 5000 },
    { op: 'transition', to: 'results' },
    { op: 'returnToLobby' }
  ]
});

// ---- seeded random sweeps -----------------------------------------------
const OPS = ['add', 'add', 'add', 'remove', 'markDisc', 'markReconn', 'transition',
  'seen', 'expiredPeers', 'graceTick', 'rekey', 'setOrder', 'clearDisc',
  'endGame', 'returnToLobby', 'isExpired', 'reset'];
const STATES = ['lobby', 'countdown', 'playing', 'results'];

function randomScript(seedN) {
  const rand = mulberry32(0xF10ECAFE ^ seedN * 2654435761);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const peer = () => Math.floor(rand() * 8);
  let t = 0;
  const ops = [];
  const n = 60 + Math.floor(rand() * 60);
  for (let i = 0; i < n; i++) {
    t += Math.floor(rand() * 900);
    const op = pick(OPS);
    switch (op) {
      case 'add': ops.push({ op, p: peer(), fields: fieldsFor(peer()) }); break;
      case 'remove': case 'markDisc': case 'markReconn': ops.push({ op, p: peer() }); break;
      case 'transition': ops.push({ op, to: pick(STATES) }); break;
      case 'seen': ops.push({ op, p: peer(), t }); break;
      case 'isExpired': ops.push({ op, p: peer(), t }); break;
      case 'expiredPeers': case 'graceTick': case 'clearDisc': ops.push({ op, t }); break;
      case 'rekey': ops.push({ op, oldId: peer(), newId: peer() + (rand() < 0.5 ? 0 : 8) }); break;
      case 'setOrder': ops.push({ op, order: [peer(), peer(), peer()] }); break;
      default: ops.push({ op }); break;
    }
  }
  return {
    name: `random-${seedN}`,
    useMasterProvider: seedN % 3 === 0,
    master: seedN % 6 === 0 ? 2 : null,
    liveness: seedN % 2 === 0 ? { timeoutMs: 3000, graceMs: seedN % 4 === 0 ? 1500 : 0 } : null,
    ops
  };
}

const scripts = [...scenarios];
for (let i = 1; i <= 30; i++) scripts.push(randomScript(i));

const lines = scripts.map((s) => canonicalStringify({
  name: s.name,
  config: {
    useMasterProvider: !!s.useMasterProvider, master: s.master ?? null,
    liveness: s.liveness ?? null
  },
  steps: runScript(s)
}));

const header = JSON.stringify({ scripts: scripts.length, events: EVENTS });
fs.writeFileSync(OUT, header + '\n' + lines.join('\n') + '\n');
console.log(`${OUT}: ${scripts.length} scripts, ${lines.reduce((a, l) => a + l.length, 0)} bytes of steps`);
