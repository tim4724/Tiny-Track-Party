'use strict';
// NativeRoomFlow adapter conformance — DIFFERENTIAL against the real kit.
//
// tests/party-abi.test.js proves the C boundary reproduces the recorded corpus.
// This proves the JS ADAPTER on top of it behaves like partyplug/RoomFlow.js, by
// driving BOTH with the same op sequence and comparing every observation after
// each step: emitted events (type + detail, in order), the getters
// (host/state/size/connectedCount), list(), and per-peer has/isHost/
// isDisconnected/get().
//
// It exists mainly for the one path the corpus CANNOT cover: the kit hands out
// MUTABLE player records and display/Net.js writes game fields straight onto them
// (`flow.get(p).ready = true`). The corpus generator never mutated a record, so
// the adapter's write-through Proxy would otherwise be untested — and a silent
// failure there means stale names and car picks in the lobby.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const ADAPTER = path.join(ROOT, 'public/display/NativeRoomFlow.js');
const MJS = path.join(ROOT, 'public/display/engine/native/ttp_runtime.mjs');
const RoomFlow = require('../partyplug/RoomFlow.js');

const skip = fs.existsSync(MJS)
  ? false
  : 'ttp_runtime.mjs not built — run native/scripts/build-runtime-web.sh';

// Records carry only JSON-able game fields, so a sorted-key stringify is a fair
// structural comparison of the two sides.
function norm(v) {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
    return out;
  }
  return v;
}
const json = (v) => JSON.stringify(norm(v));

test('NativeRoomFlow matches the JS kit op-for-op (incl. mutable records)', { skip }, async () => {
  const mod = await import(pathToFileURL(ADAPTER).href);
  await mod.init();

  const LIVENESS = { timeoutMs: 3000 };
  const jsEvents = [];
  const nvEvents = [];
  const js = new RoomFlow({ liveness: LIVENESS });
  const nv = new mod.NativeRoomFlow({ liveness: LIVENESS });
  js.on('*', (type, detail) => jsEvents.push({ type, detail }));
  nv.on('*', (type, detail) => nvEvents.push({ type, detail }));

  // Every step runs against both, then all observations are compared.
  const PEERS = [0, 1, 2, 3];
  const steps = [
    ['addPlayer', (f) => f.addPlayer(0, { name: 'Player 1', colorIndex: 0, carIndex: 0, ready: false })],
    ['addPlayer', (f) => f.addPlayer(1, { name: 'Player 2', colorIndex: 1, carIndex: 1, ready: false })],
    ['addPlayer', (f) => f.addPlayer(2, { name: 'Player 3', colorIndex: 2, carIndex: 2, ready: false })],

    // --- the mutable-record path (display/Net.js HELLO / SET_CAR / SET_READY) ---
    ['mutate name', (f) => { const p = f.get(1); p.name = 'Zoë'; return p.name; }],
    ['mutate carIndex', (f) => { const p = f.get(1); p.carIndex = 3; return p.carIndex; }],
    ['mutate ready', (f) => { const p = f.get(1); p.ready = true; return p.ready; }],
    ['mutate ready off', (f) => { const p = f.get(2); p.ready = true; p.ready = false; return p.ready; }],
    ['mutate new field', (f) => { const p = f.get(0); p.score = 12; return p.score; }],
    ['read back after mutation', (f) => json(f.get(1))],
    ['mutation is visible in list()', (f) => json(f.list().map((p) => [p.name, p.carIndex, p.ready]))],
    // A record held across other ops must stay live (the kit's alias contract).
    ['stale alias stays live', (f) => { const p = f.get(0); f.addPlayer(3, { name: 'Player 4', colorIndex: 3 }); return p.name; }],

    // --- presence / identity ---
    ['markDisconnected', (f) => f.markDisconnected(2)],
    ['isDisconnected', (f) => f.isDisconnected(2)],
    ['markReconnected', (f) => f.markReconnected(2)],
    ['rekey', (f) => f.rekey(3, 7)],
    ['mutate after rekey', (f) => { const p = f.get(7); p.ready = true; return p.ready; }],
    ['removePlayer host', (f) => f.removePlayer(0)],
    ['host after removal', (f) => f.host],

    // --- lifecycle + liveness ---
    ['transition countdown', (f) => f.transitionTo('countdown')],
    ['clearDisconnected', (f) => f.clearDisconnected(1000)],
    ['transition playing', (f) => f.transitionTo('playing')],
    ['onSeen', (f) => { f.onSeen(1, 2000); f.onSeen(2, 2000); f.onSeen(7, 2000); }],
    ['expiredPeers none', (f) => json(f.expiredPeers(3000))],
    ['expiredPeers some', (f) => json(f.expiredPeers(9000))],
    ['isExpired', (f) => f.isExpired(1, 9000)],
    ['allParticipantsDisconnected', (f) => f.allParticipantsDisconnected()],
    ['hasLateJoiners', (f) => f.hasLateJoiners()],
    ['invalid transition', (f) => f.transitionTo('countdown')],
    ['transition results', (f) => f.transitionTo('results')],
    ['returnToLobby', (f) => f.returnToLobby()],
    ['reset', (f) => f.reset()]
  ];

  for (const [label, run] of steps) {
    jsEvents.length = 0;
    nvEvents.length = 0;
    const jsRet = run(js);
    const nvRet = run(nv);

    assert.equal(json(nvRet), json(jsRet), `${label}: return value`);
    assert.equal(json(nvEvents), json(jsEvents), `${label}: emitted events`);
    assert.equal(json(nv.host), json(js.host), `${label}: host`);
    assert.equal(nv.state, js.state, `${label}: state`);
    assert.equal(nv.size, js.size, `${label}: size`);
    assert.equal(nv.connectedCount, js.connectedCount, `${label}: connectedCount`);
    assert.equal(json(nv.list()), json(js.list()), `${label}: list()`);
    for (const p of [...PEERS, 7]) {
      assert.equal(nv.has(p), js.has(p), `${label}: has(${p})`);
      assert.equal(nv.isHost(p), js.isHost(p), `${label}: isHost(${p})`);
      assert.equal(nv.isDisconnected(p), js.isDisconnected(p), `${label}: isDisconnected(${p})`);
      const a = js.get(p);
      const b = nv.get(p);
      assert.equal(b === null, a === null, `${label}: get(${p}) nullness`);
      if (a) assert.equal(json({ ...b }), json({ ...a }), `${label}: get(${p}) record`);
    }
  }

  // Kit-owned keys are protected: a write must not corrupt them (the C++ setter
  // refuses them; JS would happily overwrite, so this asserts the SAFER contract
  // rather than bug-parity — documented divergence).
  const p = nv.addPlayer(5, { name: 'Guard' });
  const joinedAt = p.joinedAt;
  p.joinedAt = 999;
  assert.equal(nv.get(5).joinedAt, joinedAt, 'kit-owned joinedAt is not writable through the proxy');

  // static parity
  for (const [used, max] of [[[], 4], [[0, 1], 4], [[0, 1, 2, 3], 4], [new Set([0, 2]), 4]]) {
    assert.equal(mod.NativeRoomFlow.lowestFreeSlot(used, max), RoomFlow.lowestFreeSlot(used, max),
      `lowestFreeSlot(${JSON.stringify(used instanceof Set ? [...used] : used)}, ${max})`);
  }

  nv.dispose();
});
