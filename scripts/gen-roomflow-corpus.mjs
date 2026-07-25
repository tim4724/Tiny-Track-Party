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
import { canonicalStringify } from './oracle-lib.mjs';

const require = createRequire(import.meta.url);
// FROZEN ORACLE. partyplug/RoomFlow.js was retired when the room state machine
// moved to C++ (native/libttp-party), so this generator can no longer RUN — the
// committed tests/fixtures/roomflow-corpus.jsonl it produced is now permanent
// cross-implementation evidence, replayed by roomflow_check (C++ objects) and
// tests/party-abi.test.js (through the ABI).
//
// It is kept because the 36 scenarios below ARE the room-semantics spec, in
// executable form: read them to understand the contract, and extend them if you
// ever need to re-derive the oracle. To do that, restore the JS twin first:
//   git show <commit-before-retirement>:partyplug/RoomFlow.js > partyplug/RoomFlow.js
// (find it with: git log --diff-filter=D -- partyplug/RoomFlow.js)
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
      // The display writes game fields straight onto the LIVE record
      // (display/Net.js: flow.get(p).ready = true). The kit hands out mutable
      // objects, so this is a plain assignment and emits nothing; a host behind
      // an ABI needs a setter (ttp_room_set_field) and this is its oracle.
      case 'setField': {
        const live = flow.get(op.p);
        if (live) live[op.key] = op.value;
        ret = live ? proj(live[op.key]) : null;
        break;
      }
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

// Direct live-record mutation — the display's HELLO (name), SET_CAR (carIndex),
// SET_READY (ready) and host-promotion (ready=false) path. No scenario touched it
// before, so the ABI setter and the adapter's write-through proxy were invisible
// to the frozen oracle.
scenarios.push({ name: 'live-record-mutation', ops: [
  { op: 'add', p: 0, fields: { name: 'Player 1', colorIndex: 0, carIndex: 0, ready: false } },
  { op: 'add', p: 1, fields: { name: 'Player 2', colorIndex: 1, carIndex: 1, ready: false } },
  { op: 'setField', p: 0, key: 'name', value: 'Ada' },
  { op: 'setField', p: 0, key: 'carIndex', value: 3 },
  { op: 'setField', p: 1, key: 'ready', value: true },
  { op: 'setField', p: 1, key: 'ready', value: false },
  { op: 'setField', p: 0, key: 'score', value: 12 },       // a brand-new field
  { op: 'setField', p: 9, key: 'ready', value: true },      // unknown peer -> no-op
  { op: 'setField', p: 0, key: 'name', value: 'Zoë' },      // non-ASCII round-trip
  { op: 'setField', p: 0, key: 'carIndex', value: 0 },      // falsy value must stick
  { op: 'markDisc', p: 1 },
  { op: 'setField', p: 1, key: 'ready', value: true },      // writable while disconnected
  { op: 'rekey', oldId: 0, newId: 7 },
  { op: 'setField', p: 7, key: 'name', value: 'AfterRekey' },
]});

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

// RoomFlow.lowestFreeSlot — the static dense-slot allocator the display uses for
// livery colours (display/Net.js). Recorded as its own line kind ({slotCase:...})
// since it takes no RoomFlow instance. Covers: empty, partial, full, gaps,
// out-of-order, duplicates, out-of-range and non-integer entries (which can never
// match a probed slot), max<=0, and a Set vs array argument (JS accepts both).
const SLOT_CASES = [
  { used: [], max: 4 },
  { used: [0], max: 4 },
  { used: [0, 1, 2, 3], max: 4 },          // full -> -1
  { used: [0, 1, 3], max: 4 },             // gap at 2
  { used: [3, 1, 0], max: 4 },             // out of order -> 2
  { used: [0, 0, 1, 1], max: 4 },          // duplicates
  { used: [7, 9], max: 4 },                // out of range -> 0
  { used: [0.5, 1.5], max: 4 },            // non-integers never match
  { used: [-0], max: 4 },                  // -0 matches slot 0 (SameValueZero)
  { used: [0, 1, 2, 3], max: 8 },          // beyond the taken block -> 4
  { used: [], max: 0 },                    // empty range -> -1
  { used: [0], max: 1 },                   // single slot taken -> -1
  { used: new Set([0, 2]), max: 4 },       // Set argument
];
for (const c of SLOT_CASES) {
  const usedArr = c.used instanceof Set ? [...c.used] : c.used;
  lines.push(canonicalStringify({
    slotCase: { used: usedArr, max: c.max, expect: RoomFlow.lowestFreeSlot(c.used, c.max) },
  }));
}

const header = JSON.stringify({ scripts: scripts.length, events: EVENTS, slotCases: SLOT_CASES.length });
fs.writeFileSync(OUT, header + '\n' + lines.join('\n') + '\n');
console.log(`${OUT}: ${scripts.length} scripts, ${lines.reduce((a, l) => a + l.length, 0)} bytes of steps`);
