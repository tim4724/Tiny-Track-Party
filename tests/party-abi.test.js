'use strict';
// Party C ABI conformance gate against the SHIPPED wasm. Loads the browser
// module (public/display/engine/native/ttp_runtime.mjs, built by
// native/scripts/build-runtime-web.sh) in Node and drives the party surface the
// display actually calls, crossing the extern "C" boundary the browser adapter
// uses. This is the only place that artifact is exercised.
//
// WHAT IS HERE AND WHAT IS IN ctest. The behavioural corpora are replayed
// against the C++ objects on every ctest leg (partytest/roomflow_check.cc,
// session_check.cc, framing_check.cc, fastlane_check.cc) and the walks are held
// to the same rules over the same live state by runtimetest/abi_check.cc. What
// crossing the boundary HERE adds is the artifact: exports that survived the
// linker, cwrap signatures, scratch-buffer lifetime, JSON-scalar peer identity
// (numeric 3 vs "3"), and the event QUEUE standing in for RoomFlow's emit
// callback with its intra-op order intact.
//
// The room MACHINE is no longer reachable one mutator at a time — the
// fine-grained ttp_room_* spellings the corpus replay rode are gone from the
// ABI, and a room is driven through ttp_net.h's choreography walks. So the
// corpus replay left with them (roomflow_check.cc owns that ground); the
// sections below drive the walks instead, which is what a shell does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const MJS = path.join(ROOT, 'public/display/engine/native/ttp_runtime.mjs');
const WASM = path.join(ROOT, 'public/display/engine/native/ttp_runtime.wasm');

// The artifacts are CHECKED IN and the game is native-only, so a missing module
// is a broken checkout, not an unbuilt optional extra. This used to skip; skipping
// meant the one suite that exercises the SHIPPED engine could quietly not run.
for (const f of [MJS, WASM]) {
  if (!fs.existsSync(f)) {
    throw new Error(`${path.relative(ROOT, f)} missing — run native/scripts/build-runtime-web.sh`);
  }
}

// Recursive key sort, so ABI JSON and recorded JSON compare structurally
// regardless of key order (the ABI already emits canonical, but the recorded
// side comes from JSON.stringify with authored order).
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}
const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

// ---------------------------------------------------------------------------
// Relay framing through the ABI. Replays tests/fixtures/framing-corpus.jsonl —
// the same oracle native/partytest/framing_check.cc uses — but crossing the C
// boundary: string marshalling, the per-entry-point scratch buffers, and
// classify taking RAW socket text instead of a parsed object.
// ---------------------------------------------------------------------------
test('party ABI reproduces the relay-framing corpus', async () => {
  const factory = (await import(pathToFileURL(MJS).href)).default;
  const M = await factory();
  const cw = (n, ret, args) => M.cwrap(n, ret, args);
  const f = {
    create: cw('ttp_framing_encode_create', 'string', ['string', 'number', 'string']),
    join: cw('ttp_framing_encode_join', 'string', ['string', 'string']),
    sendTo: cw('ttp_framing_encode_send_to', 'string', ['string', 'string']),
    broadcast: cw('ttp_framing_encode_broadcast', 'string', ['string']),
    setState: cw('ttp_framing_encode_set_state', 'string', ['string']),
    closeRoom: cw('ttp_framing_encode_close_room', 'string', []),
    classify: cw('ttp_framing_classify', 'string', ['string']),
    closeOutcome: cw('ttp_framing_close_outcome', 'string', ['number', 'number', 'number', 'number', 'number']),
    backoff: cw('ttp_framing_backoff_ms', 'number', ['number']),
    pinUrl: cw('ttp_framing_pin_url', 'string', ['string', 'string', 'string'])
  };

  const lines = fs.readFileSync(path.join(ROOT, 'tests/fixtures/framing-corpus.jsonl'), 'utf8')
    .trim().split('\n').slice(1);
  let n = 0;
  for (const line of lines) {
    const r = JSON.parse(line);
    const label = `${r.op}${r.kind ? ':' + r.kind : ''}`;
    if (r.op === 'encode') {
      let got;
      if (r.kind === 'create') got = f.create(r.clientId, r.maxClients, r.url ?? null);
      else if (r.kind === 'join') got = f.join(r.clientId, r.room);
      else if (r.kind === 'sendTo') got = f.sendTo(JSON.stringify(r.to), JSON.stringify(r.data));
      else if (r.kind === 'broadcast') got = f.broadcast(JSON.stringify(r.data));
      else if (r.kind === 'setState') got = f.setState(JSON.stringify(r.data));
      else if (r.kind === 'closeRoom') got = f.closeRoom();
      else throw new Error('unknown encode kind ' + r.kind);
      assert.ok(same(JSON.parse(got), r.expect), `${label}: ${got}`);
    } else if (r.op === 'classify') {
      // The ABI takes the raw text the socket delivered, exactly as the adapter does.
      // `raw` cases ARE that text (non-JSON, or JSON that is not an object); `wire`
      // cases are recorded as a frame object and stringified here. Reading r.wire
      // unconditionally made the raw cases pass for the wrong reason:
      // JSON.stringify(undefined) is undefined, which marshals to an empty frame,
      // which classifies as route "none" — the very answer being asserted.
      const text = 'raw' in r ? r.raw : JSON.stringify(r.wire);
      const got = JSON.parse(f.classify(text));
      assert.equal(got.route, r.expect.route, `${label}: route`);
      for (const k of ['from', 'data', 'type', 'msg']) {
        if (k in r.expect) assert.ok(same(got[k], r.expect[k]), `${label}: ${k}`);
      }
    } else if (r.op === 'close') {
      const got = JSON.parse(f.closeOutcome(
        r.hasCode ? 1 : 0, r.code ?? 0, r.attemptBefore, r.maxAttempts, r.shouldReconnectBefore ? 1 : 0));
      assert.ok(same(got, r.expect), `${label}: ${JSON.stringify(got)}`);
    } else if (r.op === 'backoff') {
      assert.equal(f.backoff(r.attempt), r.expect, `${label}(${r.attempt})`);
    } else if (r.op === 'pin') {
      assert.equal(f.pinUrl(r.base, r.room, r.instance ?? ''), r.expect, `${label}(${r.room})`);
    } else {
      throw new Error('unknown op ' + r.op);
    }
    n++;
  }
  console.info(`[party-abi] ${n} framing cases through the ABI`);
});

// ---------------------------------------------------------------------------
// Fastlane netcode through the ABI. Replays tests/fixtures/fastlane-corpus.jsonl.
// The ABI deliberately exposes no ring/seq internals (fastlane_check covers those
// against the C++ objects), so this compares the OBSERVABLE contract: the enqueue
// return, the packet to write, the events to apply, the RTT sample, and the stats
// counters. Ring state still shows through indirectly, since each packet's ps/h
// reflect it.
// ---------------------------------------------------------------------------
test('party ABI reproduces the fastlane netcode corpus', async () => {
  const factory = (await import(pathToFileURL(MJS).href)).default;
  const M = await factory();
  const cw = (n, ret, args) => M.cwrap(n, ret, args);
  const L = {
    create: cw('ttp_link_create', 'number', []),
    dispose: cw('ttp_link_dispose', null, ['number']),
    setOpen: cw('ttp_link_set_channel_open', null, ['number', 'number']),
    enqueue: cw('ttp_link_enqueue', 'string', ['number', 'string', 'number']),
    sendTick: cw('ttp_link_send_tick', 'string', ['number', 'number']),
    idle: cw('ttp_link_idle', 'string', ['number', 'number']),
    inbound: cw('ttp_link_inbound', 'string', ['number', 'string', 'number']),
    stats: cw('ttp_link_stats_json', 'string', ['number'])
  };

  const lines = fs.readFileSync(path.join(ROOT, 'tests/fixtures/fastlane-corpus.jsonl'), 'utf8')
    .trim().split('\n');
  let scripts = 0, steps = 0;
  for (const line of lines.slice(1)) {
    const rec = JSON.parse(line);
    const h = L.create();
    assert.ok(h > 0, 'ttp_link_create returned a handle');
    scripts++;
    for (const [si, step] of rec.steps.entries()) {
      const op = step.op;
      let oc = null;
      if (op.op === 'enqueue') oc = JSON.parse(L.enqueue(h, JSON.stringify(op.ev), op.t));
      else if (op.op === 'sendTick') oc = JSON.parse(L.sendTick(h, op.t));
      else if (op.op === 'idle') oc = JSON.parse(L.idle(h, op.t));
      else if (op.op === 'recv') oc = JSON.parse(L.inbound(h, JSON.stringify(op.packet), op.t));
      else if (op.op === 'closeChannel') L.setOpen(h, 0);
      else throw new Error('unknown op ' + op.op);

      const where = `${rec.name} step ${si} (${op.op})`;
      if (oc) {
        assert.ok(same(oc.packet, step.sent), `${where}: packet\n  want ${JSON.stringify(step.sent)}\n  got  ${JSON.stringify(oc.packet)}`);
        assert.ok(same(oc.applied, step.applied), `${where}: applied`);
        assert.ok(same(oc.rtt, step.rtt), `${where}: rtt`);
        if (op.op === 'enqueue') {
          assert.equal(oc.dropped ? 'dropped' : 'p2p', step.ret, `${where}: enqueue return`);
        }
      }
      const st = JSON.parse(L.stats(h));
      assert.equal(st.out, step.digest.out, `${where}: stats.out`);
      assert.equal(st.received, step.digest.received, `${where}: stats.received`);
      assert.equal(st.lastPsSeen, step.digest.lastPsSeen, `${where}: stats.lastPsSeen`);
      steps++;
    }
    L.dispose(h);
  }
  console.info(`[party-abi] ${scripts} fastlane scripts / ${steps} steps through the ABI`);
});

// The abandoned-race policy, against the SHIPPED wasm. Two reasons this is not
// just a copy of native/'s abi_check section:
//
//  - EXPORT LIST. ttp_net_liveness_json has to survive into the artifact the
//    browser loads. The exports come from TTP_ABI/EMSCRIPTEN_KEEPALIVE, so a
//    missing one is a linker outcome ctest cannot see (it links a different
//    target). cwrap does NOT throw on a missing name — it defers until the call
//    — so absence surfaces here as the call failing, not the wrap. See
//    tests/display-abi.test.js, which checks the export table directly.
//  - The policy is LOAD-BEARING and nothing else in this file reaches it:
//    DisplayNet performs `race-abandoned` by returning to the lobby, and the
//    deadline is the ONLY way a party whose phones all walked away ever leaves a
//    race. The frozen RoomFlow corpus calls graceTick 146 times and gets `true`
//    from none of them.
//
// It is driven through the liveness WALK because that is now the only way in:
// the expiry sweep, the active-order re-sync against the live race and the
// deadline are one tick and one clock reading inside ttp_net_liveness_json, and
// the room mutators that used to spell them by hand are gone from the ABI.
test('party ABI: the liveness walk abandons a race nobody is left driving', async () => {
  const factory = (await import(pathToFileURL(MJS).href)).default;
  const M = await factory();
  const cw = (n, ret, args) => M.cwrap(n, ret, args);
  const net = {
    onOpen: cw('ttp_net_on_open_json', 'string', ['number']),
    onProtocol: cw('ttp_net_on_protocol_json', 'string', ['number', 'string', 'string', 'number']),
    onSeen: cw('ttp_net_on_seen_json', 'string', ['number', 'string', 'number']),
    liveness: cw('ttp_net_liveness_json', 'string', ['number', 'number', 'number']),
    stateChangeApply: cw('ttp_net_state_change_apply_json', 'string', ['number', 'string', 'number'])
  };
  const room = {
    create: cw('ttp_room_create', 'number', ['string']),
    dispose: cw('ttp_room_dispose', null, ['number']),
    transitionTo: cw('ttp_room_transition_to', 'number', ['number', 'string']),
    list: cw('ttp_room_list_json', 'string', ['number']),
    events: cw('ttp_room_events_json', 'string', ['number'])
  };
  const sim = {
    begin: cw('ttp_session_begin', 'number', ['string', 'number', 'number', 'string']),
    addHuman: cw('ttp_add_human', null, ['number', 'string', 'string']),
    dispose: cw('ttp_dispose', null, ['number'])
  };

  assert.deepEqual(JSON.parse(cw('ttp_party_version', 'string', [])()),
    { contractVersion: 2, layer: 'party' }, 'the party layer in the artifact is the one the adapter expects');

  // No timeoutMs — presence is the relay's answer, so the room machine holds no
  // per-seat expiry and a seat is dropped by peer_left and by nothing else.
  const h = room.create(JSON.stringify({ liveness: { graceMs: 1500 } }));
  assert.ok(h > 0);
  const ops = (raw) => JSON.parse(raw).effects.map((e) => e.op);
  const tick = (s, t) => ops(net.liveness(h, s, t)).filter((o) => o !== 'send-to');
  const left = (i, t) => ops(net.onProtocol(h, 'peer_left', JSON.stringify({ index: i }), t));
  const seat = (i) => JSON.parse(room.list(h)).find((p) => p.peerIndex === i);

  // A room the walks believe they are IN — the heartbeat's in-room latch is what
  // lets a tick do anything at all, and it is set by the relay's `created`.
  net.onOpen(h);
  net.onProtocol(h, 'created', '{"room":"ABCD"}', 1000);
  net.onProtocol(h, 'peer_joined', '{"index":1}', 1000);
  net.onProtocol(h, 'peer_joined', '{"index":2}', 1000);

  // Seat 1 races; seat 2 is seated but holds no car.
  const s = sim.begin('tidepool', 42, 3, null);
  sim.addHuman(s, '1', null);
  room.transitionTo(h, 'countdown');
  net.stateChangeApply(h, 'countdown', 2000);
  room.transitionTo(h, 'playing');
  net.stateChangeApply(h, 'playing', 2000);
  // ...and a third phone scans in mid-race, car-less: the one WAITING.
  net.onProtocol(h, 'peer_joined', '{"index":3}', 2000);
  room.events(h);

  assert.deepEqual(tick(s, 2100), [], 'a healthy race arms no deadline');

  // The racers go SILENT, which is now not an event at all: no ping, no input,
  // nothing on the wire, for far longer than the drop window this walk used to
  // enforce. Nothing happens, because presence is the relay's answer.
  assert.deepEqual(tick(s, 5200), [], 'silence alone drops nobody');
  assert.equal(seat(1).connected, true, 'a quiet racer is still in the race');

  // Their sockets then close, which IS the event. Both go through the mid-game
  // drop: seat AND car held, reconnect card up.
  assert.deepEqual(left(1, 5300), ['close-fastlane', 'close-fastlane', 'show-reconnect']);
  assert.deepEqual(left(2, 5300), ['close-fastlane', 'close-fastlane', 'show-reconnect']);
  assert.equal(seat(1).connected, false);
  assert.equal(seat(3).connected, true, 'the waiting phone kept its socket, so it kept its seat');
  // A DROPPED seat is still a participant — its car is held for the reconnect —
  // so the deadline is armed by seat 3 waiting, not by the drops themselves.
  // It arms on the first TICK that sees the condition, never on the drop, so
  // the clock starts at 5400 and not at the peer_left before it.
  assert.deepEqual(tick(s, 5400), [], 'the first qualifying tick only armed it');
  assert.deepEqual(tick(s, 6899), [], 'still inside the grace');
  assert.deepEqual(tick(s, 6900), ['race-abandoned'], 'it fires at that tick + graceMs');
  assert.deepEqual(tick(s, 7000), [], 'and fires exactly once');

  // One racer scans back in: a fastlane packet lifts the seat, and a live
  // participant disarms the deadline.
  assert.deepEqual(ops(net.onSeen(h, '1', 7100)), ['clear-reconnect']);
  assert.deepEqual(tick(s, 8000), [], 'a returning racer disarms it');

  sim.dispose(s);
  room.dispose(h);
});

// The choreography walks (ttp_net_on_*), against the SHIPPED wasm — the entry
// points DisplayNet actually calls. The equivalence gate (walk == the old
// multi-call sequence) is abi_check's netWalksMatchMultiCallPath on every ctest
// leg; what THIS test adds is the artifact: the exports survived the linker,
// cwrap's signatures match, and one whole party's choreography runs through the
// same wasm the browser loads.
test('party ABI: the session choreography walks run against the shipped wasm', async () => {
  const factory = (await import(pathToFileURL(MJS).href)).default;
  const M = await factory();
  const cw = (n, ret, args) => M.cwrap(n, ret, args);
  const net = {
    configure: cw('ttp_net_configure', 'number', ['string']),
    restoreRoom: cw('ttp_net_restore_room', null, ['number', 'string', 'string']),
    onOpen: cw('ttp_net_on_open_json', 'string', ['number']),
    createTimeout: cw('ttp_net_create_timeout_json', 'string', ['number']),
    onProtocol: cw('ttp_net_on_protocol_json', 'string', ['number', 'string', 'string', 'number']),
    onClose: cw('ttp_net_on_close_json', 'string', ['number', 'number']),
    onPeerMessage: cw('ttp_net_on_peer_message_json', 'string',
      ['number', 'number', 'string', 'string', 'number', 'number']),
    setTrack: cw('ttp_net_set_track_json', 'string', ['number', 'string']),
    initPick: cw('ttp_net_init_pick', null, ['number', 'string', 'number', 'number']),
    pickJson: cw('ttp_net_pick_json', 'string', ['number']),
    liveness: cw('ttp_net_liveness_json', 'string', ['number', 'number', 'number']),
    onSeen: cw('ttp_net_on_seen_json', 'string', ['number', 'string', 'number']),
    hostChangeApply: cw('ttp_net_host_change_apply_json', 'string', ['number', 'string']),
    stateChangeApply: cw('ttp_net_state_change_apply_json', 'string', ['number', 'string', 'number'])
  };
  const room = {
    create: cw('ttp_room_create', 'number', ['string']),
    dispose: cw('ttp_room_dispose', null, ['number']),
    state: cw('ttp_room_state', 'string', ['number']),
    transitionTo: cw('ttp_room_transition_to', 'number', ['number', 'string']),
    list: cw('ttp_room_list_json', 'string', ['number']),
    events: cw('ttp_room_events_json', 'string', ['number'])
  };
  // Presence and seat count come off the roster the room publishes — the
  // per-seat predicates are internal to the walks now, and the roster row is
  // what a shell (and every phone) reads them from anyway.
  const roster = () => JSON.parse(room.list(h));
  const connected = (i) => roster().find((p) => p.peerIndex === i)?.connected;
  const sim = {
    begin: cw('ttp_session_begin', 'number', ['string', 'number', 'number', 'string']),
    addHuman: cw('ttp_add_human', null, ['number', 'string', 'string']),
    hasCar: cw('ttp_has_car', 'number', ['number', 'string']),
    rekeyCar: cw('ttp_rekey_car', 'number', ['number', 'string', 'string']),
    dispose: cw('ttp_dispose', null, ['number'])
  };

  assert.equal(net.configure(JSON.stringify({
    cars: [{ id: 'dash' }], colors: ['#f00'],
    tracks: [{ id: 'tidepool', cup: 'beach' }, { id: 'lagoon', cup: 'beach' }]
  })), 1);
  const h = room.create(JSON.stringify({ liveness: { graceMs: 1500 } }));
  assert.ok(h > 0);
  const walk = (raw) => JSON.parse(raw);
  const ops = (raw) => walk(raw).effects.map((e) => e.op);
  const drain = () => JSON.parse(room.events(h));

  // Open on a cold boot: create + watchdog; the unanswered watchdog fails the attempt.
  assert.deepEqual(ops(net.onOpen(h)), ['create-room', 'arm-create-watchdog']);
  assert.deepEqual(ops(net.createTimeout(h)), ['fail-attempt']);
  // A restored identity joins instead.
  net.restoreRoom(h, 'OLDR', '');
  assert.deepEqual(ops(net.onOpen(h)), ['join-room', 'arm-create-watchdog']);
  net.restoreRoom(h, '', '');

  // created → adopt/persist/liveness/ready, and the watchdog goes quiet.
  assert.deepEqual(ops(net.onProtocol(h, 'created', '{"room":"ABCD"}', 1000)),
    ['clear-create-timer', 'save-room', 'start-liveness', 'room-ready']);
  assert.deepEqual(ops(net.createTimeout(h)), []);

  // peer_joined → hello → set_car → set_ready, events draining like the shell does.
  net.onProtocol(h, 'peer_joined', '{"index":1}', 2000);
  assert.equal(drain().some((e) => e.type === 'rosterchange'), true, 'the seat landed');
  // The pick is stored behind the handle now — seeded once, exactly as
  // DisplayNet's constructor does (no default track, a bag wired, one page
  // entropy seed). The bag itself lives behind the room; the seed is the only
  // random thing this shell still supplies.
  net.initPick(h, null, 1, 20260731);
  const storedPick = () => JSON.parse(net.pickJson(h));
  const hello = walk(net.onPeerMessage(h, 0, '1',
    JSON.stringify({ type: 'hello', name: 'Ada', rejoinToken: null }), 0, 2100));
  assert.deepEqual(hello.effects.at(-1), { op: 'announce' });
  assert.equal(JSON.parse(room.list(h))[0].name, 'Ada');
  assert.deepEqual(ops(net.onPeerMessage(h, 0, '1',
    '{"type":"set_car","carIndex":0}', 0, 2200)), ['announce']);
  net.onProtocol(h, 'peer_joined', '{"index":2}', 2300);
  drain();
  assert.deepEqual(ops(net.onPeerMessage(h, 0, '2',
    '{"type":"set_ready","ready":true}', 0, 2400)), ['announce']);

  // The mode pick, all three modes — verified off the STORED pick. Exact track:
  const trackPick = walk(net.onPeerMessage(h, 0, '1',
    '{"type":"select_mode","mode":"track","trackId":"lagoon"}', 0, 2500));
  assert.deepEqual(ops(JSON.stringify(trackPick)), ['publish', 'track-change']);
  assert.deepEqual(storedPick(),
    { mode: 'track', cupId: null, randomRaces: 0, trackId: 'lagoon' });
  // A cup resolves to its first race:
  walk(net.onPeerMessage(h, 0, '1',
    '{"type":"select_mode","mode":"cup","cupId":"beach"}', 0, 2600));
  assert.equal(storedPick().trackId, 'tidepool');
  // Random completes in ONE walk: the shuffle bag is the room's, so the draw
  // happens inside and the pick lands with the same publish/track-change tail
  // as the other two modes. There is no draws protocol for a shell to hold.
  const rnd = walk(net.onPeerMessage(h, 0, '1',
    '{"type":"select_mode","mode":"random","randomRaces":4}', 0, 2700));
  assert.deepEqual(ops(JSON.stringify(rnd)), ['publish', 'track-change']);
  assert.equal(rnd.needDraw, undefined, 'the two-step draw protocol is gone');
  // WHICH track the bag drew is the bag's business (seeded above); that it drew
  // from the configured catalogue is the contract.
  assert.ok(['tidepool', 'lagoon'].includes(storedPick().trackId),
    `the bag drew outside the catalogue: ${storedPick().trackId}`);
  assert.equal(rnd.effects.at(-1).trackId, storedPick().trackId,
    'the track-change effect names the track the walk stored');
  // ...and the game-layer swap shares the tail and keeps mode/length. Aim it at
  // the track the bag did NOT draw: a same-pick swap is a deliberate no-op.
  const other = storedPick().trackId === 'tidepool' ? 'lagoon' : 'tidepool';
  const swapped = walk(net.setTrack(h, other));
  assert.deepEqual(ops(JSON.stringify(swapped)), ['publish', 'track-change']);
  assert.deepEqual(storedPick(),
    { mode: 'random', cupId: null, randomRaces: 4, trackId: other });
  drain();

  // Into the race.
  room.transitionTo(h, 'countdown');
  net.stateChangeApply(h, 'countdown', 3000);
  room.transitionTo(h, 'playing');
  net.stateChangeApply(h, 'playing', 3000);
  drain();
  const s = sim.begin('tidepool', 42, 3, null);
  sim.addHuman(s, '1', null);

  // The liveness tick is the canary send and nothing else. Seat 2 says nothing
  // at all across every tick below — no ping, no input — and keeps its seat,
  // because presence is the relay's answer and the relay has not spoken.
  assert.deepEqual(ops(net.liveness(h, s, 3100)), ['send-to']);
  net.onPeerMessage(h, s, '0', '{"type":"_heartbeat"}', 0, 3200); // the echo comes home
  net.onSeen(h, '1', 5000);              // seat 1 keeps driving (fastlane input)
  assert.deepEqual(ops(net.liveness(h, s, 6500)).filter((o) => o !== 'send-to'), [],
    'no sweep: a silent seat is not a dropped seat');
  assert.equal(connected(2), true);
  drain();

  // Its socket closing is what drops it, mid-game, card up.
  const expiry = walk(net.onProtocol(h, 'peer_left', '{"index":2}', 6550));
  assert.deepEqual(ops(JSON.stringify(expiry)),
    ['close-fastlane', 'close-fastlane', 'show-reconnect']);
  assert.deepEqual(expiry.effects.find((e) => e.op === 'show-reconnect').seat.peerIndex, 2);
  assert.equal(connected(2), false);
  drain();

  // A fastlane packet from the seat says it is back: the single writer lifts it.
  const lifted = walk(net.onSeen(h, '2', 6600));
  assert.deepEqual(lifted.effects, [{ op: 'clear-reconnect', peerIndex: 2 }]);
  assert.equal(connected(2), true);
  drain();

  // The cross-device claim: drop seat 1, then a fresh connection carries its
  // index as the rejoin token — an INTEGER, never the string '1', or the walk
  // reads no token at all and claims nothing (session.h). The car is still keyed
  // to the OLD seat when the walk decides — rekey-player must precede
  // welcome-item in the answer.
  net.onProtocol(h, 'peer_left', '{"index":1}', 6700);
  drain();
  const claim = walk(net.onPeerMessage(h, s, '7',
    JSON.stringify({ type: 'hello', name: 'Ada', rejoinToken: 1 }), 0, 6800));
  const claimOps = claim.effects.map((e) => e.op);
  assert.ok(claimOps.indexOf('rekey-player') >= 0, 'the seat was claimed');
  assert.ok(claimOps.indexOf('rekey-player') < claimOps.indexOf('welcome-item'),
    'the car moves before the item relight that needs it');
  assert.deepEqual(claim.effects.find((e) => e.op === 'rekey-player'),
    { op: 'rekey-player', oldId: 1, newId: 7 });
  assert.equal(sim.rekeyCar(s, '1', '7'), 1); // what the shell's effect performs
  assert.equal(JSON.parse(room.list(h)).some((p) => p.peerIndex === 7), true);
  drain();

  // close with the room gone: forget → expire EVERY seat → only then re-dial.
  const closed = walk(net.onClose(h, 1));
  const closedOps = closed.effects.map((e) => e.op);
  assert.equal(closedOps[0], 'clear-create-timer');
  assert.equal(closedOps[1], 'forget-room');
  assert.equal(closedOps.at(-1), 'connect-fresh');
  assert.ok(closedOps.indexOf('close-fastlane') < closedOps.indexOf('connect-fresh'),
    'seats are expired BEFORE the fresh dial');
  assert.equal(roster().length, 0, 'no seat haunts the fresh lobby');

  sim.dispose(s);
  room.dispose(h);
  net.configure('');
});

// The participant set — who this race is FOR — left with ttp_room_sync_active_order,
// which is an internal seam (native/runtime/ttp_room.h) rather than an export now:
// it is folded into the reads that need it so no caller can ask off a stale set.
// Its ground is covered twice over. runtimetest/abi_check.cc holds the seam to the
// sync-then-read sequence the shell used to spell, and the liveness walk above is
// the artifact proof that the party ABI still reaches ACROSS the two halves of the
// runtime — the deadline it fires is armed by "a seat with no car in the live
// Game", which is that definition and nothing else.

// The join URL's shape, through the artifact — the CouchPad launcher reads this
// string and nothing else to learn which box a room is on (CONTRACT §6), so the
// pieces have to compose in one order: the `cpp` declaration is a QUERY arg and
// the relay-shard instance is the FRAGMENT, and a per-seat claim splices in
// between them. Get that wrong and the claim lands on a shard that has never
// heard of the room, or `cpp` becomes fragment text the launcher cannot read.
// The web display's own value ('web') lives in its adapter and is pinned by
// tests/e2e/couchpad-shell.spec.js; what is pinned here is the composition every
// shell shares.
test('party ABI: cpp rides the query, the instance rides the fragment, claim splices between', async () => {
  const factory = (await import(pathToFileURL(MJS).href)).default;
  const M = await factory();
  const joinUrl = M.cwrap('ttp_net_join_url', 'string', ['string', 'string', 'string', 'string']);
  const claimUrl = M.cwrap('ttp_net_claim_url', 'string', ['string', 'number']);
  const template = M.cwrap('ttp_net_controller_url_template', 'string', ['string', 'string']);

  const base = 'https://tinytrack.couchpad.games';
  assert.equal(joinUrl(base, 'BZK4', 'eu-1', 'web'), `${base}/BZK4?cpp=web#eu-1`);
  assert.equal(joinUrl(base, 'BZK4', '', 'web'), `${base}/BZK4?cpp=web`);
  // A shell that declares nothing keeps the pre-contract URL byte for byte.
  assert.equal(joinUrl(base, 'BZK4', 'eu-1', ''), `${base}/BZK4#eu-1`);

  assert.equal(claimUrl(joinUrl(base, 'BZK4', 'eu-1', 'web'), 2), `${base}/BZK4?cpp=web&claim=2#eu-1`);
  assert.equal(claimUrl(joinUrl(base, 'BZK4', 'eu-1', ''), 2), `${base}/BZK4?claim=2#eu-1`);

  // The template must match what the QR produces, placeholders intact for the
  // relay to substitute — including through a trailing slash on the base.
  assert.equal(template(base + '/', 'web'), `${base}/{room}?cpp=web#{instance}`);
  assert.equal(template(base, ''), `${base}/{room}#{instance}`);
  // "" is REGISTER NONE: a plain-http origin must send no template at all,
  // whatever it would have declared.
  assert.equal(template('http://localhost:3000', 'web'), '');
});
