'use strict';

// ===========================================================================
// WIRE-COMPAT: the C++ host against the unchanged JS phone, over a
// production-shaped relay.
//
// WHY THIS SUITE IS PERMANENT
// docs/native-port/architecture.md: "Fastlane is an enhancement. CONTROL falls
// back to the relay by design (shipping behaviour), so the TVs may launch
// relay-only. Phones stay on the JS controller forever, so a cross-language
// wire-compat suite (C++ host <-> unchanged JS phone <-> real relay) is
// permanent." The phone is a browser on all three TV platforms, forever, so this
// is the one boundary in the system where two DIFFERENT LANGUAGES must agree on
// bytes at runtime. Everything else is either C++ talking to C++ (the corpora)
// or JS talking to JS (what the E2E stub relay used to be).
//
// WHAT IS REAL HERE
//   * C++  — public/display/engine/native/ttp_runtime.wasm, the CHECKED-IN
//            artifact the browser loads, reached through the display's own
//            adapters (NativePartyConnection / NativePartyFastlane /
//            NativeRaceSession / NativeRoomFlow), not through a
//            re-implementation of them.
//   * JS   — partyplug/PartyConnection.js, partyplug/PartyFastlane.js,
//            public/display/Net.js, public/shared/names.js,
//            public/controller/Net.js and public/controller/InputGate.js,
//            unmodified. The phone in this suite is the phone that ships, and
//            the snapshot on the wire is the one DisplayNet._publishLobby
//            actually authors — never a literal typed into a test, which
//            constrains the transport and nothing that rides in it.
//
// WHAT IS FABRICATED, AND WHY THAT IS ALLOWED
//   Only TRANSPORT: a WebSocket, a DataChannel pair, a clock, and four DOM
//   leaves (location/localStorage/window/WebSocket). The relay is a dumb pipe;
//   what it is not allowed to be is a PERMISSIVE pipe, which is the whole
//   problem with testing against tests/e2e/relay-server.js. So the relay here is
//   tests/wire-compat/relay.js — a model of Party-Sockets 2.3.1 with every
//   divergence cited to a line of server.ts, and frozen in
//   tests/wire-compat/relay-contract.json (regenerate with
//   `node scripts/wire-relay-contract.mjs` against a Party-Sockets checkout).
//
// GREEN HERE IS NOT "PROD-FAITHFUL". Read tests/wire-compat/relay.js's header
// for the list of things the model still is not (no backpressure, no
// fragmentation, synchronous delivery, no shard routing). What it DOES cover is
// every behavioural divergence the wire map found between prod and the E2E stub,
// each one turned into a test below with a comment naming what it breaks at a
// real party.
//
// Companion file: tests/wire-fastlane.test.js (the DataChannel reliability
// layer, where the two languages run different implementations of the same
// protocol).
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const H = require('./wire-compat/harness.js');
const { Relay, CLOSE_REPLACED, CLOSE_ROOM_CLOSED, MAX_STATE_BYTES } = require('./wire-compat/relay.js');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// 0. The relay model's own contract
// ---------------------------------------------------------------------------

// The model is only worth anything while it still describes the real relay. The
// frozen contract is what a reviewer diffs when Party-Sockets moves; the
// generator (scripts/wire-relay-contract.mjs) re-derives it from the checkout
// and fails loudly if a cited behaviour has moved or vanished.
test('wire: the relay model matches its frozen Party-Sockets contract', () => {
  const frozen = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/wire-compat/relay-contract.json'), 'utf8'));
  const R = require('./wire-compat/relay.js');
  assert.equal(R.MAX_STATE_BYTES, frozen.limits.maxStateBytes);
  assert.equal(R.MAX_URL_BYTES, frozen.limits.maxUrlBytes);
  assert.equal(R.IDLE_TIMEOUT_MS, frozen.limits.idleTimeoutMs);
  assert.equal(R.HOST_GRACE_MS, frozen.limits.hostGraceMs);
  assert.equal(R.CLOSE_REPLACED, frozen.closeCodes.replaced);
  assert.equal(R.CLOSE_ROOM_CLOSED, frozen.closeCodes.roomClosed);

  // The model's error surface must be EXACTLY prod's, in both directions.
  //
  // Superset would mean the model invents a message the phone has never seen —
  // and in the CouchPad shell all but two error strings end the session, so an
  // invented one is an invented teardown. SUBSET is the sharper half and the one
  // this check used to miss: an error string that disappears from this file is a
  // guard that stopped being enforced, and a permissive model is the exact defect
  // that makes testing against tests/e2e/relay-server.js worthless. Deleting the
  // host-only set_state guard or the 16 KiB cap turns this assertion red on the
  // spot, before any behavioural test gets a chance to.
  const src = fs.readFileSync(path.join(ROOT, 'tests/wire-compat/relay.js'), 'utf8');
  const emitted = new Set();
  for (const m of src.matchAll(/type: 'error', message: (?:'([^']*)'|`([^`]*)`)/g)) {
    emitted.add(m[1] ?? m[2].replace(/\$\{[^}]*\}/g, '*'));
  }
  assert.deepEqual([...emitted].sort(), frozen.errors,
    'the model must model prod\'s WHOLE error surface, and nothing else');
});

// ---------------------------------------------------------------------------
// 1. Outbound: C++ encodes -> the relay (the real consumer of these bytes)
//    accepts them and means what the encoder intended.
// ---------------------------------------------------------------------------

// Bring up a display (C++ framing) on a fresh relay. Returns everything a test
// needs to assert on both the decoded and the raw side.
async function bringUpDisplay(relayOpts = {}, opts = {}) {
  const relay = H.setRelay(new Relay(relayOpts));
  const { NativePartyConnection } = await H.displayAdapters();
  const seen = { protocol: [], message: [], state: [], close: [] };
  const host = new NativePartyConnection('ws://relay/', { clientId: opts.clientId || 'host-1' });
  host.onOpen = () => host.create(opts.maxClients ?? 4, opts.url ?? null);
  host.onProtocol = (type, msg) => seen.protocol.push({ type, msg });
  host.onMessage = (from, data) => seen.message.push({ from, data });
  host.onState = (data) => seen.state.push(data);
  host.onClose = (attempt, max, meta) => seen.close.push({ attempt, max, meta });
  host.connect();
  await H.flush();
  const created = seen.protocol.find((p) => p.type === 'created');
  return { relay, host, seen, room: created && created.msg.room, created };
}

// Bring up a REAL phone (public/controller/Net.js) against the same relay.
async function bringUpPhone(relay, room, { name = 'Ada', claim = null, clientKey = 'phone-1' } = {}) {
  const { ControllerNet } = await H.controllerModules();
  globalThis.location.pathname = '/' + room;
  globalThis.location.search = claim == null ? '' : '?claim=' + claim;
  globalThis.location.hash = '';
  // Each phone gets its own clientId slot in the shared localStorage shim.
  globalThis.localStorage.setItem('clientId_' + room, clientKey);
  const seen = { joined: [], status: [], message: [], rtt: [] };
  const net = new ControllerNet({
    onJoined: (idx) => seen.joined.push(idx),
    onStatus: (s, info) => seen.status.push({ s, info }),
    onMessage: (d) => seen.message.push(d),
    onRtt: (ms, viaFastlane) => seen.rtt.push({ ms, viaFastlane }),
  });
  // ControllerNet builds its own URL from window.RELAY_URL; the fake socket
  // ignores the URL and dials the active relay, so any value is fine.
  H.trackPhone(net);
  net.connect(name);
  await H.flush();
  return { net, seen };
}

// The WHOLE display edge — public/display/Net.js over the native RoomFlow,
// connection and fastlane — on a fresh relay. This is the object that AUTHORS the
// retained room snapshot, so anything asserted downstream of it is asserted about
// the shipping producer rather than about a literal.
async function bringUpRealDisplay(relayOpts = {}, opts = {}) {
  const relay = H.setRelay(new Relay(relayOpts));
  const { DisplayNet, NativeRoomFlow, NativePartyConnection, NativePartyFastlane } = await H.displayModules();
  // The room blob survives in sessionStorage exactly as it does in a browser tab,
  // and a display holding one JOINS instead of creating. Each test wants a cold
  // boot, so clear it (crash recovery is not what these tests are about).
  globalThis.sessionStorage.clear();
  const seen = { roomReady: [], roster: [], controller: [] };
  const net = H.trackDisplay(new DisplayNet({
    RoomFlowImpl: NativeRoomFlow,
    PartyConnectionImpl: NativePartyConnection,
    FastlaneImpl: NativePartyFastlane,
    // Chooser content, as display/main.js supplies it. Small on purpose here; the
    // 16 KiB cap gets its own fixture below.
    carChooser: [{ id: 'vehicle-racer-low', name: 'Dash' }, { id: 'vehicle-speedster', name: 'Bolt' }],
    colorPalette: ['#e6492d', '#f2b134', '#2bb673', '#2d9cdb'],
    trackChooser: [{ id: 'tidepool', name: 'Tidepool', cup: 'beach' }],
    progressChooser: { cups: [{ id: 'beach', stars: 2, locked: false }] },
    defaultTrackId: 'tidepool',
    onRoomReady: (r) => seen.roomReady.push(r),
    onRosterChange: (r, host) => seen.roster.push({ r, host }),
    onControllerMessage: (i, d) => seen.controller.push({ i, d }),
    ...opts,
  }));
  await net.start();
  await H.flush();
  return { relay, net, seen, room: net.roomCode };
}

// The last retained snapshot a phone actually received, decoded by the real
// ControllerNet exactly as controller/main.js's syncRoom would see it.
const lastLobby = (phone) => phone.seen.message.filter((m) => m && m.type === 'lobby_update').at(-1);

// ControllerNet holds a 1 Hz ping interval and DisplayNet a 1 Hz liveness tick;
// without this the runner never exits.
test.after(() => H.teardownClients());

test('wire: every C++ outbound encoder produces bytes the relay accepts', async () => {
  const abi = await H.loadAbi();
  const f = abi.framing;

  // --- create ---------------------------------------------------------------
  // The url branch has NEVER been on a live wire: E2E runs over http, so
  // DisplayNet._controllerUrlTemplate() returns undefined and the key is omitted.
  // Prod validates the template and rejects the WHOLE create on a bad one. The
  // template carries the `cpp=web` display declaration prod now registers, so the
  // relay's substitution is exercised on the string it will actually be handed —
  // placeholders on either side of a query arg.
  assert.equal(f.create('cid-1', 4, null), '{"clientId":"cid-1","maxClients":4,"type":"create"}');
  assert.equal(
    f.create('cid-1', 4, 'https://tinytrack.example/{room}?cpp=web#{instance}'),
    '{"clientId":"cid-1","maxClients":4,"type":"create","url":"https://tinytrack.example/{room}?cpp=web#{instance}"}');

  const { relay, host, seen } = await bringUpDisplay(
    { instanceId: 'm-1', region: 'ams' },
    { url: 'https://tinytrack.example/{room}?cpp=web#{instance}' });
  const created = seen.protocol.find((p) => p.type === 'created');
  assert.ok(created, 'the url-carrying create was ACCEPTED by prod validation');
  assert.equal(created.msg.instance, 'm-1');
  assert.equal(created.msg.region, 'ams');
  assert.equal(created.msg.url, `https://tinytrack.example/${created.msg.room}?cpp=web#m-1`);

  // And the reject branch, which no live test has ever taken: a plain-http
  // template (a dev origin) kills the create outright. The display's error
  // handler then calls failAttempt() rather than retrying forever.
  {
    const r2 = H.setRelay(new Relay());
    const { NativePartyConnection } = await H.displayAdapters();
    const errs = [];
    const c = new NativePartyConnection('ws://relay/', { clientId: 'h2' });
    c.onOpen = () => c.create(4, 'http://dev.local/{room}');
    c.onProtocol = (t, m) => { if (t === 'error') errs.push(m.message); };
    c.connect();
    await H.flush();
    assert.deepEqual(errs, ['url must be an https URL']);
    assert.equal(r2.rooms.size, 0, 'no room exists after a rejected create');
  }

  // --- join -----------------------------------------------------------------
  assert.equal(f.join('cid-1', 'ABCD'), '{"clientId":"cid-1","room":"ABCD","type":"join"}');

  // --- send (targeted) ------------------------------------------------------
  // encode_send_to ALWAYS emits `to`. The kit omits it when undefined. That
  // difference is the subject of its own test below.
  assert.equal(f.sendTo('1', '{"type":"ping"}'), '{"data":{"type":"ping"},"to":1,"type":"send"}');

  // --- send (broadcast) -----------------------------------------------------
  // No `to` KEY AT ALL — the only way a native host can broadcast is to call a
  // different export.
  assert.equal(f.broadcast('{"type":"countdown","n":3}'),
    '{"data":{"n":3,"type":"countdown"},"type":"send"}');
  assert.ok(!('to' in JSON.parse(f.broadcast('null'))), 'broadcast carries no `to` key');

  // --- set_state / close_room ----------------------------------------------
  assert.equal(f.setState('{"type":"lobby_update"}'), '{"data":{"type":"lobby_update"},"type":"set_state"}');
  assert.equal(f.closeRoom(), '{"type":"close_room"}');

  // Now put each through the relay and check the MEANING, not just the shape.
  host.sendTo(0, { type: '_heartbeat' });          // the display's own-slot echo
  assert.equal(seen.message.at(-1).from, 0, 'the relay allows `to` == self');
  assert.equal(seen.message.at(-1).data.type, '_heartbeat');

  host.setState({ type: 'lobby_update', players: [] });
  assert.equal(relay.rooms.get(created.msg.room).state.type, 'lobby_update');

  host.closeRoom();
  assert.equal(seen.close.at(-1).meta.roomClosed, true, 'the sender\'s own 4001 IS the ack');
  assert.equal(relay.rooms.size, 0);
});

// ---------------------------------------------------------------------------
// 2. Inbound: one frame, two decoders. The kit's JSON.parse+route and C++'s
//    ttp_framing_classify must land on the same route with the same payload.
// ---------------------------------------------------------------------------

// Drive the KIT's real onmessage handler with an arbitrary frame text and record
// which callback it routed to.
function routeThroughKit(text) {
  const { PartyConnection } = H.kit();
  const relay = H.setRelay(new Relay());
  const c = new PartyConnection('ws://relay/', { clientId: 'x' });
  const out = { route: 'none' };
  c.onMessage = (from, data) => { out.route = 'message'; out.from = from; out.data = data; };
  c.onState = (data) => { out.route = 'state'; out.data = data; };
  c.onProtocol = (type, msg) => { out.route = 'protocol'; out.type = type; out.msg = msg; };
  c.connect();
  // The socket has not opened yet (open is a microtask), but onmessage is wired
  // at connect() time — deliver straight into the real handler.
  c.ws.onmessage({ data: text });
  relay.rooms.clear();
  return out;
}

test('wire: the kit and C++ classify every prod relay frame identically', async () => {
  const abi = await H.loadAbi();

  const FRAMES = [
    // Every frame Party-Sockets can send, in its PROD shape (the E2E stub's
    // `created`/`joined` are strict subsets of these).
    '{"type":"created","room":"ABCD","index":0,"instance":"m-1","region":"ams","url":"https://x/ABCD"}',
    '{"type":"created","room":"ABCD","index":0,"instance":"","region":"","url":null}',
    '{"type":"joined","room":"ABCD","index":7,"peers":[0,1,2,3,4,5,6],"url":"https://x/ABCD"}',
    '{"type":"peer_joined","index":3}',
    '{"type":"peer_left","index":3}',
    '{"type":"message","from":2,"data":{"type":"hello","name":"Ada","rejoinToken":null}}',
    '{"type":"message","from":0,"data":{"type":"pong","t":1234567890123}}',
    '{"type":"state","data":{"type":"lobby_update","players":[],"standings":null}}',
    '{"type":"state","data":null}',
    '{"type":"error","message":"Target peer not found"}',
    '{"type":"error","message":"Room is full"}',
    '{"type":"error","message":"Unknown message type"}',
    '{"type":"error","message":"Invalid JSON"}',
    '{"type":"error","message":"State too large"}',
    // The RTC signalling envelope. No C++ twin, no corpus line, and the largest
    // free-text payload on the wire — SDP is multi-line with \r\n.
    JSON.stringify({ type: 'message', from: 1, data: { __rtc: 'offer', sdp: { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\na=ice-ufrag:AbC/9+x\r\n' } } }),
    JSON.stringify({ type: 'message', from: 1, data: { __rtc: 'ice', candidate: { candidate: 'candidate:1 1 UDP 2122252543 192.168.1.9 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 } } }),
  ];

  for (const text of FRAMES) {
    const kitOut = routeThroughKit(text);
    const cpp = JSON.parse(abi.framing.classify(text));
    assert.equal(cpp.route, kitOut.route, `route for ${text.slice(0, 60)}`);
    if (cpp.route === 'message') {
      assert.equal(cpp.from, kitOut.from, `from for ${text.slice(0, 60)}`);
      assert.ok(H.same(cpp.data, kitOut.data), `data for ${text.slice(0, 60)}`);
    } else if (cpp.route === 'state') {
      assert.ok(H.same(cpp.data ?? null, kitOut.data ?? null), `state data for ${text.slice(0, 60)}`);
    } else if (cpp.route === 'protocol') {
      assert.equal(cpp.type ?? undefined, kitOut.type, `protocol type for ${text.slice(0, 60)}`);
      assert.ok(H.same(cpp.msg, kitOut.msg), `protocol msg for ${text.slice(0, 60)}`);
    }
  }

  // SDP survives byte for byte through json::parse + canonical_stringify. If it
  // did not, the DataChannel would silently fail to negotiate and CONTROL would
  // fall back to the relay — with every test still green, which is exactly why
  // "fastlane is an enhancement" has never been verified as an enhancement.
  const sdp = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=ice-ufrag:AbC/9+x\r\na=fingerprint:sha-256 AB:CD\r\n';
  const cls = JSON.parse(abi.framing.classify(
    JSON.stringify({ type: 'message', from: 1, data: { __rtc: 'offer', sdp: { type: 'offer', sdp } } })));
  assert.equal(cls.data.sdp.sdp, sdp, 'SDP CRLFs survive the C++ round trip verbatim');

  // ...and the kit's fastlane really does recognise the envelope C++ handed back
  // (handleSignal tests `RTC_KEY in data`, so a re-serialization that renamed or
  // dropped __rtc would make every handshake silently no-op).
  const { PartyFastlane } = H.kit();
  const fl = new PartyFastlane({ selfIndex: 0 });
  fl._handleRtcSignal = () => { fl._sawSignal = true; };
  assert.equal(fl.handleSignal(1, cls.data), true, 'the C++-decoded envelope is still an RTC signal');
});

test('wire: non-object and malformed frames are dropped by both sides', async () => {
  const abi = await H.loadAbi();
  // A frame that PARSES but is not an object is not a relay frame. Both drop it.
  for (const text of ['null', '7', '"x"', '[1,2]', 'true', 'not json at all', '']) {
    assert.equal(routeThroughKit(text).route, 'none', `kit drops ${JSON.stringify(text)}`);
    assert.equal(JSON.parse(abi.framing.classify(text)).route, 'none', `C++ drops ${JSON.stringify(text)}`);
  }
});

// ---------------------------------------------------------------------------
// 3. The full loop: C++ host <-> prod-shaped relay <-> the real JS phone.
// ---------------------------------------------------------------------------

test('wire: a real phone joins a C++-hosted room and HELLO/PING cross both parsers', async () => {
  const { relay, host, seen, room } = await bringUpDisplay();
  const { net, seen: pseen } = await bringUpPhone(relay, room, { name: 'Ada' });

  assert.deepEqual(pseen.joined, [1], 'the phone got slot 1 from prod join semantics');

  // The phone's HELLO — the only free-text field on the wire — reached the
  // display through C++'s parser.
  const hello = seen.message.find((m) => m.data && m.data.type === 'hello');
  assert.ok(hello, 'HELLO arrived');
  assert.equal(hello.from, 1);
  assert.equal(hello.data.name, 'Ada');
  // rejoinToken is LITERALLY null on a normal join, and DisplayNet._normIndex(null)
  // is 0 (Number(null) === 0) — every normal HELLO is a claim on seat 0 that
  // survives only because the display's own slot is never on the roster.
  assert.equal(hello.data.rejoinToken, null);
  assert.ok('rejoinToken' in hello.data, 'the key is PRESENT, not absent');

  // PING/PONG across the boundary. The phone pings at 1 Hz; the display answers
  // by echoing `t`. An absent `t` is silently ignored by the phone (typeof
  // check), so a `t` lost to a serialization difference reads as "no signal".
  net.send('ping', { t: 1234567890123 });
  const ping = seen.message.find((m) => m.data && m.data.type === 'ping');
  assert.equal(ping.data.t, 1234567890123, 'a 13-digit epoch survives shortest-form serialization');
  host.sendTo(1, { type: 'pong', t: ping.data.t });
  const pong = pseen.message.find((m) => m && m.type === 'pong');
  assert.equal(pong, undefined, 'PONG is consumed by ControllerNet, not surfaced as a game message');

  net.disconnect();
  host.close();
});

test('wire: the LOBBY_UPDATE the display AUTHORS survives the round trip, field by field', async () => {
  // LOBBY_UPDATE is the biggest object on the wire and the phone's ONLY source of
  // truth: identity, roster, phase, chooser content, results. It is authored by
  // DisplayNet._publishLobby over a roster the C++ RoomFlow serialises
  // (ttp_room_list_json), re-serialised by C++ again inside encode_set_state, and
  // read back by controller/main.js's syncRoom BY NAME.
  //
  // So this test writes NO snapshot. It drives the real producer and asserts the
  // NAMES, TYPES and ORDER the phone depends on — the four things a deep-equal
  // against a literal cannot see, because a literal only ever constrains the
  // transport it was handed to.
  //
  // WHAT THIS BREAKS AT A REAL PARTY: every one of these is silent. A renamed
  // `players` empties every phone's lobby; a peerIndex that arrives as "1"
  // instead of 1 fails syncRoom's `p.peerIndex === net.peerIndex` and the player
  // never finds their own seat (no livery, no car, no drive screen); a reversed
  // roster shuffles the seat order under everyone; a dropped `ready` freezes the
  // host's Start button.
  const { MSG, ROOM_STATE } = H.kit().protocol;
  // The shuffle bag lives behind the room handle and the walk draws from it
  // itself; what a shell supplies is `hasBag`, and a bagless display refuses
  // random outright. The run-length assertions below need one, so wire it.
  const { relay, net, room } = await bringUpRealDisplay({}, { hasBag: true });
  const ada = await bringUpPhone(relay, room, { name: 'Ada', clientKey: 'lu-a' });
  const bo = await bringUpPhone(relay, room, { name: 'Bo', clientKey: 'lu-b' });

  const snap = lastLobby(ada);
  assert.ok(snap, 'the phone received the display\'s retained snapshot');

  // 1. THE TOP-LEVEL SCHEMA. Every key syncRoom reads, and nothing it does not.
  assert.deepEqual(Object.keys(snap).sort(), [
    'cars', 'colors', 'cupId', 'hostPeerIndex', 'mode', 'paused', 'players',
    'progress', 'randomRaces', 'roomState', 'standings', 'trackId', 'tracks', 'type',
  ], 'the snapshot schema is the contract; renaming or dropping a key is silent');
  assert.equal(snap.type, MSG.LOBBY_UPDATE, 'routed by the shared type tag');
  // The progression chooser crosses OPAQUELY (like tracks): the phone draws
  // stars/locks straight off it, so its shape is part of the wire contract.
  assert.deepEqual(snap.progress,
    { cups: [{ id: 'beach', stars: 2, locked: false }] },
    'the couch progression rides the lobby snapshot verbatim');

  // 2. THE ROSTER, whose every field crosses from C++ (RoomFlow) through JS
  //    (DisplayNet.roster) and back through C++ (encode_set_state).
  assert.deepEqual(snap.players.map((p) => p.peerIndex), [1, 2],
    'seats ride in JOIN order (RoomFlow sorts by joinedAt), oldest first');
  for (const p of snap.players) {
    assert.deepEqual(Object.keys(p).sort(),
      ['carIndex', 'colorIndex', 'connected', 'inRace', 'name', 'peerIndex', 'ready'],
      `a roster row carries exactly the fields the phone reads: ${JSON.stringify(p)}`);
    assert.equal(typeof p.peerIndex, 'number', 'peerIndex is a NUMBER — syncRoom matches it with ===');
    assert.equal(typeof p.name, 'string');
    assert.equal(typeof p.colorIndex, 'number');
    assert.equal(typeof p.carIndex, 'number');
    assert.equal(typeof p.connected, 'boolean', 'connected is a BOOLEAN, not 0/1');
    assert.equal(typeof p.ready, 'boolean');
    assert.equal(typeof p.inRace, 'boolean');
  }
  // The identity lookup itself, done exactly as the phone does it.
  assert.ok(snap.players.some((p) => p.peerIndex === ada.net.peerIndex),
    'Ada finds her own seat by strict equality');
  assert.equal(snap.players.find((p) => p.peerIndex === ada.net.peerIndex).name, 'Ada',
    'the HELLO name reached the roster and came back');
  assert.equal(snap.players.find((p) => p.peerIndex === bo.net.peerIndex).name, 'Bo');
  assert.equal(snap.hostPeerIndex, 1, 'the first seat is the host, and the phone reads it by name');

  // 3. THE ROSTER IS LIVE, not a constant that happens to look right. Bo readies
  //    up over the real wire; the display validates, stores and republishes.
  bo.net.send(MSG.SET_READY, { ready: true });
  await H.flush();
  const afterReady = lastLobby(ada);
  assert.equal(afterReady.players.find((p) => p.peerIndex === 2).ready, true,
    'Bo\'s ready flag reached EVERY phone, not just Bo');
  assert.equal(afterReady.players.find((p) => p.peerIndex === 1).ready, false);
  ada.net.send(MSG.SET_CAR, { carIndex: 1 });
  await H.flush();
  assert.equal(lastLobby(ada).players.find((p) => p.peerIndex === 1).carIndex, 1,
    'a car pick is echoed back through the same field');

  // 3b. THE RANDOM RUN LENGTH, which is the newest field on this message and the
  //     only one whose meaning turns on a NUMBER rather than a string or a flag.
  //     0 is endless and any other value is a race count, so a length that
  //     crossed as "4", or that C++ dropped because lobby_snapshot never learned
  //     the key, would silently turn a 4-race card into an endless run nobody
  //     can leave. The clamp is the select-mode walk's (ttp_net.cc, off the
  //     manifest's RANDOM_RACES); this is the only place a real phone's message
  //     meets it over a real wire.
  //     Driven the way a real party does it: the HOST's phone sends SELECT_MODE
  //     over the wire, the display validates and clamps, C++ re-emits.
  ada.net.send(MSG.SELECT_MODE, { mode: 'random', randomRaces: 4 });
  await H.flush();
  const randomPick = lastLobby(ada);
  assert.equal(randomPick.mode, 'random', 'the mode reached every phone');
  assert.equal(randomPick.randomRaces, 4, 'the run length survived the C++ emitter');
  assert.equal(typeof randomPick.randomRaces, 'number',
    'randomRaces is a NUMBER — the phone tests it against 0 to mean endless');
  ada.net.send(MSG.SELECT_MODE, { mode: 'random', randomRaces: 0 });
  await H.flush();
  assert.equal(lastLobby(ada).randomRaces, 0,
    'ZERO survives too: it is endless, not absent, and a falsy-drop would read as a default card');
  //     And the clamp is the display's, not the phone's to bypass: a forged
  //     length comes back as the default rather than as itself.
  ada.net.send(MSG.SELECT_MODE, { mode: 'random', randomRaces: 999 });
  await H.flush();
  assert.equal(lastLobby(ada).randomRaces, 4,
    'an out-of-range length is clamped to the default before it is ever published');

  // 4. THE PHASE STRING. RoomFlow names its own states in C++ (room_flow.cc's
  //    stateName), the phone compares them against protocol.js's ROOM_STATE
  //    table, and NOTHING on the wire path checks that the two tables agree — a
  //    renamed state would just make every phone miss the race screen.
  const phases = [ROOM_STATE.COUNTDOWN, ROOM_STATE.PLAYING, ROOM_STATE.RESULTS, ROOM_STATE.LOBBY];
  for (const phase of phases) {
    assert.equal(net.flow.transitionTo(phase), true, `the machine accepts ${phase}`);
    await H.flush();
    const now = lastLobby(ada);
    assert.equal(now.roomState, phase,
      'the phase C++ publishes is the exact string protocol.js told the phone to expect');
    // 4b. THE CHOOSER PAYLOAD, which is phase-dependent in ONE direction only.
    //     `cars` and `colors` ride EVERY snapshot on purpose — a phone that
    //     joins mid-race is a late joiner picking a car for the next race, and
    //     an empty picker is a silent dead end. `tracks` are the bulk and ride
    //     the LOBBY only, which is what keeps the whole blob inside the relay's
    //     16 KiB cap. Both halves are one rule in ttp::session::lobby_snapshot,
    //     and scripts/wire-mutate.mjs found this suite blind to the first half:
    //     gating `cars` on the lobby broke nothing.
    assert.ok(Array.isArray(now.cars) && now.cars.length,
      `cars must ride the ${phase} snapshot — the late-joiner picker has nothing else`);
    assert.ok(Array.isArray(now.colors) && now.colors.length,
      `colors must ride the ${phase} snapshot — a phone's livery dots come from it`);
    if (phase === ROOM_STATE.LOBBY) {
      assert.ok(Array.isArray(now.tracks), 'the track chooser rides the lobby snapshot');
    } else {
      assert.equal(now.tracks, null,
        `the bulky track schematics must NOT ride the ${phase} snapshot (the 16 KiB cap)`);
    }
  }
  assert.equal(net.roomState, ROOM_STATE.LOBBY);

  // 5. A LATE JOINER gets the same object by RELAY REPLAY rather than by push,
  //    which is the only way a reconnecting phone recovers anything.
  const cy = await bringUpPhone(relay, room, { name: 'Cy', clientKey: 'lu-c' });
  const replayed = cy.seen.message.filter((m) => m && m.type === 'lobby_update')[0];
  assert.ok(replayed, 'the retained snapshot was replayed right after `joined`');
  assert.deepEqual(Object.keys(replayed).sort(), Object.keys(snap).sort(),
    'the replay is the same schema as the push');

  ada.net.disconnect();
  bo.net.disconnect();
  cy.net.disconnect();
});

test('wire: a live rename republishes the roster AND raises the rename signal', async () => {
  // ControllerNet.rename re-HELLOs — the launcher's setName (§2 of the Couch
  // Games contract), and a plain browser reaches the same path by backing out and
  // rejoining. TWO things have to come of that and only one of them is bytes: the
  // retained snapshot carries the new name, and DisplayNet raises onPlayerRenamed.
  // That signal is the ONLY thing the copies a RACE froze at its start can move
  // by — the cell name chip Stage wrote when the car was added, and the
  // `currentField` every standings board is composed from (main.js renamePlayer).
  //
  // WHAT THIS BREAKS AT A REAL PARTY: a rename that raises nothing leaves a
  // racing player's chip and results row reading their old name for the whole
  // race, while their phone and the lobby show the new one — and a first HELLO
  // that also counted as a rename would fire it on every single join.
  const renamed = [];
  const { relay, room } = await bringUpRealDisplay({}, {
    onPlayerRenamed: (peerIndex, name) => renamed.push({ peerIndex, name }),
  });
  const ada = await bringUpPhone(relay, room, { name: 'Ada', clientKey: 'rn-1' });
  assert.deepEqual(renamed, [], 'a JOIN is not a rename, however new the name is');

  ada.net.rename('Zephyr');
  await H.flush();
  assert.deepEqual(renamed, [{ peerIndex: ada.net.peerIndex, name: 'Zephyr' }],
    'the re-HELLO raised the signal ONCE, carrying the seat and the new name');
  assert.equal(lastLobby(ada).players.find((p) => p.peerIndex === ada.net.peerIndex).name,
    'Zephyr', 'and the snapshot every phone reads was republished with it');

  // An unchanged name is not an event: phones re-introduce themselves whenever
  // they see the display return, and that must not look like a rename.
  ada.net.rename('Zephyr');
  await H.flush();
  assert.equal(renamed.length, 1, 'a re-HELLO carrying the same name raises nothing');

  ada.net.disconnect();
});

test('wire: the C++-composed PONG closes the phone\'s RTT loop', async () => {
  // The PONG used to be a JS object literal in Net.js; the peer-message walk
  // composes it in C++ now (type off the manifest, `t` echoed verbatim), so a
  // second language owns bytes the phone's RTT chip depends on. The phone
  // ignores a PONG whose `t` is not a number (typeof gate in _handlePong), so
  // a dropped or retyped echo is SILENT: the chip just never updates.
  //
  // Driven end to end: a real phone's ping through the real display's walk,
  // asserting the phone's own onRtt fired — the only observable that proves
  // `t` survived, not just that a frame moved.
  const { relay, room } = await bringUpRealDisplay();
  const phone = await bringUpPhone(relay, room, { name: 'Ada', clientKey: 'rtt-1' });
  const before = phone.seen.rtt.length;
  phone.net.send('ping', { t: Date.now() - 42 });
  await H.flush();
  assert.ok(phone.seen.rtt.length > before, 'the PONG came back and carried a numeric t');
  assert.equal(phone.seen.rtt.at(-1).viaFastlane, false, 'over the relay, not the fastlane');
  assert.ok(phone.seen.rtt.at(-1).ms >= 21, 'the RTT reading is derived from the echoed t');

  // And a ping with NO t answers a PONG with no t — absent stays absent, so the
  // phone's typeof gate skips it instead of reading Date.now() - undefined.
  const count = phone.seen.rtt.length;
  phone.net.send('ping', {});
  await H.flush();
  assert.equal(phone.seen.rtt.length, count, 'a t-less PONG raises no reading');
  phone.net.disconnect();
});

test('wire: the self-heartbeat the display composes echoes home through slot 0', async () => {
  // The display's own-socket canary — sendTo(0, HEARTBEAT) — is the walk
  // layer's other new C++-composed SEND. Its type must round-trip through the
  // relay AND route back as 'self-heartbeat' (ttp::session::inbound_route), or
  // the in-flight flag never clears and the display force-reconnects a healthy
  // socket once the dead window elapses.
  const { MSG } = H.kit().protocol;
  const { relay, net } = await bringUpRealDisplay();
  const hbFrames = () => relay.log.filter((e) => e.dir === 'c2s' && e.text.includes('"' + MSG.HEARTBEAT + '"'));

  net._livenessTick();   // in-room, nothing in flight → the walk answers SEND
  await H.flush();
  const first = hbFrames();
  assert.equal(first.length, 1, 'the canary frame reached the relay');
  const frame = JSON.parse(first[0].text);
  assert.equal(frame.type, 'send');
  assert.equal(frame.to, 0, 'addressed to our own slot');
  assert.equal(frame.data.type, MSG.HEARTBEAT, 'spelled off the manifest, both sides');

  // The echo already came home (synchronous relay), so the next tick SENDS
  // again instead of waiting out the window or reconnecting.
  net._livenessTick();
  await H.flush();
  assert.equal(hbFrames().length, 2, 'the echo cleared the in-flight flag — the canary re-arms');
});

test('wire: a control character in a name stays ESCAPED all the way round', async () => {
  // Names are the only free-text field on the wire and nothing strips control
  // characters from them (cleanName trims and truncates, that is all). A TAB
  // therefore rides the HELLO as \t, is parsed by C++, is re-emitted by
  // canonical_stringify into the set_state frame, and is parsed AGAIN by the
  // relay's JSON.parse.
  //
  // WHAT THIS BREAKS AT A REAL PARTY: an escaper that emits the raw byte instead
  // makes that frame invalid JSON, and prod answers "Invalid JSON" — so one
  // player with a tab in their name silently stops the roster updating for the
  // whole room. The kit-to-kit path cannot see it (JSON.stringify escapes on both
  // sides), and no corpus rides a control character through the SET_STATE
  // encoder into a parser.
  const { relay, net, room } = await bringUpRealDisplay();
  const odd = await bringUpPhone(relay, room, { name: 'Ada\tB', clientKey: 'ctl-1' });

  const snap = lastLobby(odd);
  assert.ok(snap, 'the set_state frame was accepted as valid JSON by the relay');
  assert.equal(snap.players[0].name, 'Ada\tB', 'the control character survived verbatim');
  assert.equal(relay.log.filter((e) => e.dir === 's2c' && e.text.includes('Invalid JSON')).length, 0,
    'the relay never had to reject a frame the display encoded');
  // ...and it really was escaped on the wire, not smuggled through as a byte.
  const frame = relay.log.filter((e) => e.dir === 'c2s' && e.text.includes('"set_state"')).at(-1);
  assert.ok(frame.text.includes('Ada\\tB'), `escaped on the wire: ${frame.text.slice(0, 120)}`);
  assert.equal(frame.text.includes('\t'), false, 'no raw TAB byte in the frame');
  assert.equal(net.roomState, 'lobby');

  odd.net.disconnect();
});

test('wire: an emoji name is the ONE place C++ loses data the kit would keep', async () => {
  // shared/names.js's cleanName slices names to 16 UTF-16 UNITS, which cuts a
  // trailing emoji in half. JSON.stringify emits the lone high surrogate as
  // \ud83c; json_parse writes it as 3-byte WTF-8; canonical_stringify passes it
  // through; and emscripten's non-fatal TextDecoder turns it into U+FFFD on the
  // way back.
  //
  // WHAT THIS BREAKS AT A REAL PARTY: a player whose name ends in an emoji at the
  // 16-character boundary sees three replacement characters on the TV. It is
  // reachable from ordinary input, it is silent, and the kit-to-kit path (which
  // is what E2E and the corpora both exercise) is LOSSLESS — so nothing else in
  // the tree can see it.
  //
  // Pinned as CURRENT behaviour, not as desired behaviour: the fix is to slice by
  // code POINT. The input below is produced BY CALLING cleanName, and the name is
  // carried by a real phone through a real display, so landing that fix flips
  // these assertions instead of leaving them agreeing with a copy of the old
  // expression. (It used to inline `.slice(0, 16)` — with which the fix could
  // ship, and this test would have stayed green and claimed to have checked it.)
  const abi = await H.loadAbi();
  const { cleanName, NAME_MAX } = await H.sharedNames();
  const sliced = cleanName('abcdefghijklmno\u{1F3CE}');
  assert.equal(NAME_MAX, 16);
  assert.equal(sliced.length, 16);
  assert.equal(sliced.charCodeAt(15), 0xd83c, 'the slice really does end in a lone high surrogate');

  const frame = JSON.stringify({ type: 'message', from: 1, data: { type: 'hello', name: sliced } });
  assert.ok(frame.includes('\\ud83c'), 'JSON.stringify escapes the lone surrogate');

  // The kit keeps it exactly.
  assert.equal(routeThroughKit(frame).data.name, sliced, 'JSON.parse is lossless');

  // C++ does not.
  const viaCpp = JSON.parse(abi.framing.classify(frame)).data.name;
  assert.notEqual(viaCpp, sliced, 'the lone surrogate does NOT survive the C++ path');
  assert.equal(viaCpp, 'abcdefghijklmno���',
    'it comes back as three U+FFFD (WTF-8 bytes through a non-fatal TextDecoder)');

  // A WELL-FORMED emoji is fine, so this is specifically about the slice.
  const whole = 'Ada \u{1F3CE}';
  assert.equal(
    JSON.parse(abi.framing.classify(JSON.stringify({ type: 'message', from: 1, data: { name: whole } }))).data.name,
    whole, 'a paired surrogate survives intact');
  assert.equal(cleanName('  ' + whole + '  '), whole, 'and it is short enough to be untouched');

  // ...and now the whole path, which is what a player actually sees. It is NOT
  // the three replacement characters above: the display re-clamps the name it
  // received with the same 16-unit cleanName, and the half-emoji has already
  // grown from one UTF-16 unit to three, so two of the three U+FFFD are sliced
  // straight back off. One replacement character reaches the roster, and it does
  // so having cost the player two characters of their own name.
  const { relay, room } = await bringUpRealDisplay();
  const phone = await bringUpPhone(relay, room, { name: sliced, clientKey: 'emoji-1' });
  assert.equal(lastLobby(phone).players[0].name, 'abcdefghijklmno�',
    'what the TV and every phone show — fix cleanName and this line is what changes');
  assert.equal(cleanName(viaCpp), 'abcdefghijklmno�',
    'and that is the display\'s own re-clamp of the mangled name, not a wire effect');
  phone.net.disconnect();
});

test('wire: the retained snapshot fits prod\'s 16 KiB cap AFTER the C++ round trip', async () => {
  // display/main.js:67 sizes the lobby snapshot against this cap deliberately
  // ("reduced schematics (~24 pts) so the whole catalog fits 16 KiB"), and the
  // snapshot now makes a full JSON round trip through C++ before the relay
  // measures it. Key sorting and shortest-form numbers preserve byte length;
  // escape normalisation does NOT (an escaped lone surrogate shrinks 6 bytes to
  // 3, a non-ASCII character grows 6 to 2-4). So the cap holds by luck of
  // direction and nothing measured the margin. This does.
  const abi = await H.loadAbi();

  // A realistic worst case: 20 tracks with schematics, 4 players, full standings.
  const tracks = [];
  for (let i = 0; i < 20; i++) {
    const pts = [];
    for (let p = 0; p < 24; p++) pts.push([Math.round(Math.cos(p) * 1000) / 10, Math.round(Math.sin(p) * 1000) / 10]);
    tracks.push({ id: 'track-' + i, name: 'Track Number ' + i, cup: 'cup-' + (i % 5), cupName: 'Cup ' + (i % 5), cupDifficulty: (i % 4) + 1, svg: pts });
  }
  const snapshot = {
    type: 'lobby_update', hostPeerIndex: 1, roomState: 'lobby', paused: false,
    players: [0, 1, 2, 3].map((i) => ({ peerIndex: i + 1, name: 'Player ' + i, colorIndex: i, carIndex: i % 4, connected: true, ready: i > 0, inRace: false })),
    mode: 'cup', cupId: 'beach', trackId: 'tidepool',
    standings: {
      over: false, hostPeerIndex: 1, total: 8,
      order: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ playerId: i, name: 'Racer ' + i, colorIndex: i % 8, ai: i > 3, finished: true, time: 61.234 + i, points: 9 - i, gained: 0 })),
      series: { cupId: 'beach', cupName: 'Beach Cup', endless: false, raceIndex: 1, raceCount: 4, nextTrackId: 'lagoon', nextTrackName: 'Lagoon', final: false, autoAdvanceMs: 12000 },
    },
    cars: [{ id: 'vehicle-racer-low', name: 'Dash', stats: { accel: 1.04, vmax: 1.02, turn: 1.1, mass: 1 } }],
    colors: ['#e6492d', '#f2b134', '#2bb673', '#2d9cdb'],
    tracks,
  };

  // WHICH BYTES? Two different numbers, and only one of them is the wire.
  // NativePartyConnection does ws.send(fn.encSetState(...)) — the cwrap'd STRING —
  // so the bytes on the socket are that JS string's UTF-8 encoding, NOT the bytes
  // C++ wrote into the wasm heap. The two differ whenever emscripten's non-fatal
  // TextDecoder had to substitute, which is exactly the lone-surrogate case below.
  const WRAP = Buffer.byteLength('{"data":,"type":"set_state"}');
  const jsBytes = Buffer.byteLength(JSON.stringify(snapshot));
  const frame = abi.framing.setState(JSON.stringify(snapshot));
  const wireBytes = Buffer.byteLength(frame) - WRAP;             // what ws.send() ships
  const heapBytes = (await H.wasmCStringBytes(
    'ttp_framing_encode_set_state', ['string'], [JSON.stringify(snapshot)])) - WRAP;  // what C++ wrote

  assert.ok(jsBytes > 8000, `the fixture must actually stress the cap (got ${jsBytes} B)`);
  assert.ok(wireBytes <= MAX_STATE_BYTES,
    `the C++ round trip must not push the snapshot past the relay cap (${wireBytes} > ${MAX_STATE_BYTES})`);
  // For an ASCII payload all three agree, which is the property that makes
  // display/main.js:67's "sized to fit 16 KiB" reasoning survive the port.
  assert.equal(wireBytes, jsBytes, 'ASCII snapshots round-trip byte-length-identical');
  assert.equal(heapBytes, jsBytes, '...in the heap too');

  // Well-formed non-ASCII is also length-neutral: JSON.stringify does not escape
  // BMP characters, so both sides emit the same UTF-8.
  const wide = { type: 'lobby_update', players: [{ name: 'こんにちは世界' }] };
  const wideJs = Buffer.byteLength(JSON.stringify(wide));
  const wideCpp = Buffer.byteLength(abi.framing.setState(JSON.stringify(wide))) - WRAP;
  assert.equal(wideCpp, wideJs, 'a well-formed multi-byte name is length-neutral');

  // The one payload that is NOT length-neutral, and it GROWS — the opposite of
  // what the escape-shrinks intuition predicts. A lone surrogate is 6 bytes of
  // JSON escape (\ud83c); C++ stores 3 bytes of WTF-8 (so the HEAP shrinks); the
  // decode on the way out turns those 3 invalid bytes into three U+FFFD, which is
  // 9 bytes of UTF-8 ON THE WIRE. Net +3 bytes per unpaired surrogate.
  //
  // WHAT THIS BREAKS AT A REAL PARTY: four players with emoji-clipped names on a
  // snapshot already sized to the cap can push it over, and the relay answers
  // "State too large" — which means the roster silently stops updating for
  // everyone. Nothing measured this margin before.
  // The name comes from the REAL producer, so the day cleanName slices by code
  // point this arithmetic stops describing anything and says so (there is no
  // lone surrogate left to grow). That is the intended failure: the margin below
  // only exists because of the clipping.
  const { cleanName } = await H.sharedNames();
  const lone = { type: 'lobby_update', players: [{ name: cleanName('abcdefghijklmno\u{1F3CE}') }] };
  const loneJs = Buffer.byteLength(JSON.stringify(lone));
  const loneWire = Buffer.byteLength(abi.framing.setState(JSON.stringify(lone))) - WRAP;
  const loneHeap = (await H.wasmCStringBytes(
    'ttp_framing_encode_set_state', ['string'], [JSON.stringify(lone)])) - WRAP;
  assert.equal(loneHeap, loneJs - 3, 'the heap shrinks 6 escape bytes to 3 WTF-8 bytes');
  assert.equal(loneWire, loneJs + 3, 'the WIRE grows: 6 escape bytes become three U+FFFD (9 bytes)');
});

test('wire: a snapshot over the cap is REFUSED, and the room silently keeps the stale one', async () => {
  // The consequence the byte-counting test above only NAMES. Measuring the margin
  // proves nothing about what happens when it is missed, and "the roster silently
  // stops updating for everyone" is the kind of claim a suite has to be able to
  // demonstrate — otherwise the cap in the model is decoration: it could be
  // deleted outright and every test would stay green.
  //
  // WHAT THIS BREAKS AT A REAL PARTY: nothing errors. The display keeps
  // publishing, the relay keeps refusing, and every phone keeps rendering the
  // last roster that fit — including every phone that joins afterwards, which is
  // replayed the stale one. The display never learns: its only feedback is an
  // `error` frame it logs with console.warn.
  const { relay, net, room } = await bringUpRealDisplay();
  const phone = await bringUpPhone(relay, room, { name: 'Ada', clientKey: 'cap-1' });
  const good = lastLobby(phone);
  assert.ok(good, 'the small snapshot went through');
  assert.equal(good.tracks.length, 1);

  // Now the display's chooser content grows past the cap — 20 tracks with
  // unreduced schematics, which is exactly what display/main.js:67's "reduced
  // schematics (~24 pts) so the whole catalog fits 16 KiB" exists to prevent.
  //
  // JUST past it, on purpose. ttp_framing_encode_set_state takes its argument as
  // a cwrap 'string', which emscripten copies onto the 64 KiB wasm STACK, so a
  // snapshot in the tens of KiB is a wasm trap rather than a relay error — the
  // shipped (Filament) build and CI's sim-only build even disagree on where it
  // starts to go wrong. The relay cap is what keeps the display far away from
  // that, and this fixture stays on the relay's side of it deliberately.
  const fat = [];
  for (let i = 0; i < 20; i++) {
    const pts = [];
    for (let p = 0; p < 80; p++) pts.push([Math.round(Math.cos(p) * 1000) / 10, Math.round(Math.sin(p) * 1000) / 10]);
    fat.push({ id: 'track-' + i, name: 'Track Number ' + i, cup: 'cup-' + (i % 5), svg: pts });
  }
  const fatBytes = Buffer.byteLength(JSON.stringify(fat));
  assert.ok(fatBytes > MAX_STATE_BYTES, `the fixture really is oversize (${fatBytes} B)`);
  assert.ok(fatBytes < 32 * 1024, `...and stays well clear of the stack limit (${fatBytes} B)`);

  // setChooser rather than a field poke: the chooser payload lives in the native
  // session model now (it is authored data, handed over once instead of crossing
  // the boundary on every publish), so replacing it goes through the setter that
  // re-configures it. The publish it triggers is the one under test.
  const before = phone.seen.message.length;
  net.setChooser({ tracks: fat });
  await H.flush();

  assert.equal(phone.seen.message.length, before, 'the phone received NOTHING — no error, no update');
  assert.equal(relay.rooms.get(room).state.tracks.length, 1, 'the relay still retains the OLD snapshot');
  assert.deepEqual(relay.log.filter((e) => e.dir === 's2c' && e.text.includes('State too large')).length, 1,
    'the only sign anything went wrong is one error frame to the display');

  // And the seat that joins next inherits the stale roster, which is the part
  // that makes this a party-wide failure rather than one lost frame.
  const late = await bringUpPhone(relay, room, { name: 'Bo', clientKey: 'cap-2' });
  const replayed = late.seen.message.filter((m) => m && m.type === 'lobby_update')[0];
  assert.ok(replayed, 'the late joiner got the retained snapshot');
  assert.equal(replayed.players.length, 1, 'which does not know Bo exists');

  phone.net.disconnect();
  late.net.disconnect();
});

test('wire: only slot 0 may publish the room snapshot, and a phone that tries is refused', async () => {
  // set_state is host-only (server.ts:592). The display is slot 0 by construction,
  // so nothing in this repo has ever taken the refusal branch — and a model that
  // stopped enforcing it would make every "the display owns the snapshot" test
  // vacuous, because any peer could have written it.
  //
  // WHAT THIS BREAKS AT A REAL PARTY: a phone (or a shell reusing the kit for a
  // second screen) that calls setState gets an error string outside the two the
  // CouchPad launcher survives, so the WebView is torn down.
  const { relay, net, room } = await bringUpRealDisplay();
  const phone = await bringUpPhone(relay, room, { name: 'Ada', clientKey: 'host-only' });
  const retained = relay.rooms.get(room).state;
  assert.equal(retained.type, 'lobby_update');

  phone.net.party.setState({ type: 'lobby_update', players: [], hijacked: true });
  await H.flush();
  assert.equal(phone.seen.status.at(-1).s, 'error');
  assert.equal(phone.seen.status.at(-1).info, 'Only the host can set state');
  assert.equal(relay.rooms.get(room).state, retained, 'the retained snapshot is untouched');
  assert.equal(net.roomState, 'lobby');

  phone.net.disconnect();
});

test('wire: a draining instance refuses new rooms outright', async () => {
  // server.ts's drain path, modelled because a Fly deploy runs it on every
  // release: the instance stops accepting creates while it finishes serving the
  // rooms it has. The display's create fails with an error string, no room
  // exists, and the ONLY correct answer is to retry (a different instance answers
  // next time) — which is what failAttempt's backoff does.
  const relay = H.setRelay(new Relay());
  relay.draining = true;
  const { NativePartyConnection } = await H.displayAdapters();
  const errs = [];
  const c = new NativePartyConnection('ws://relay/', { clientId: 'drain-1' });
  c.onOpen = () => c.create(4, null);
  c.onProtocol = (t, m) => { if (t === 'error') errs.push(m.message); };
  c.connect();
  await H.flush();
  assert.deepEqual(errs, ['Server draining']);
  assert.equal(relay.rooms.size, 0);
  c.close();
});

// ---------------------------------------------------------------------------
// 4. The asymmetries. Each one is a real divergence the wire map found; each
//    comment names what it breaks at a real party.
// ---------------------------------------------------------------------------

test('asym: a null `to` MEANS something different in each implementation', async () => {
  // encode_send_to ALWAYS emits `to`; NativePartyConnection coerces `to ?? null`;
  // the kit omits the key when `to` is undefined. Prod then reads a present-but-
  // null `to` as an invalid target (Number.isSafeInteger(null) === false) and
  // answers "Target peer not found"; the E2E stub tests `msg.to != null` and
  // BROADCASTS it instead.
  //
  // WHAT THIS BREAKS AT A REAL PARTY: a TV shell that reaches for sendTo with a
  // peer index it doesn't have yet gets an error frame on prod and a silent
  // broadcast in every test — and on the phone, that error frame is
  // session-ending (see the next test).
  const abi = await H.loadAbi();
  const { PartyConnection } = H.kit();

  const cpp = JSON.parse(abi.framing.sendTo('null', '{"type":"ping"}'));
  assert.equal(cpp.to, null, 'C++ emits an explicit null `to`');
  assert.ok('to' in cpp);

  // The kit, same call, on a socket whose send() we capture.
  H.setRelay(new Relay());
  const kitConn = new PartyConnection('ws://relay/', { clientId: 'k' });
  const sentTexts = [];
  kitConn.connect();
  kitConn.ws.readyState = 1;
  kitConn.ws.send = (t) => sentTexts.push(t);
  kitConn.sendTo(undefined, { type: 'ping' });
  assert.ok(!('to' in JSON.parse(sentTexts[0])), 'the kit DROPS the key, which means broadcast');
  kitConn.close();

  // And the two frames get OPPOSITE answers from prod: one is an error, the
  // other is a fan-out to every peer.
  const { relay, host, seen, room } = await bringUpDisplay();
  const phone = await bringUpPhone(relay, room, { name: 'Ada', clientKey: 'nullto' });
  const phoneMsgs = () => phone.seen.message.length;

  const before = phoneMsgs();
  host.sendTo(null, { type: 'countdown', n: 3 });     // C++ shape: to === null
  assert.equal(phoneMsgs(), before, 'nobody received it');
  assert.equal(seen.protocol.at(-1).type, 'error');
  assert.equal(seen.protocol.at(-1).msg.message, 'Target peer not found');

  host.broadcast({ type: 'countdown', n: 3 });        // the DIFFERENT export
  assert.equal(phoneMsgs(), before + 1, 'the broadcast export reached the phone');
  assert.equal(phone.seen.message.at(-1).type, 'countdown');

  phone.net.disconnect();
  host.close();
});

test('asym: prod answers a send to a vanished slot with an error the phone treats as fatal', async () => {
  // WHAT THIS BREAKS AT A REAL PARTY: phones PING slot 0 at 1 Hz. Any window
  // where the display's socket is gone produces exactly this frame. The phone
  // routes EVERY error string through onStatus('error', message)
  // (controller/Net.js, onProtocol's 'error' branch), and inside the CouchPad shell anything other than
  // 'Room not found'/'Room is full' maps to endSession('game_ended') — the
  // launcher tears down the WebView. Structurally unreachable in E2E: the stub
  // has no such error at all.
  const { relay, host, room } = await bringUpDisplay();
  const { net, seen: pseen } = await bringUpPhone(relay, room);

  // The display's socket goes away (tab asleep, network blip).
  host.close();
  assert.equal(relay.rooms.get(room).members[0].ws, undefined, 'slot 0 is vacant but the room lives');

  // The phone's next 1 Hz PING targets slot 0.
  net.party.sendTo(0, { type: 'ping', t: 1 });
  const err = pseen.status.find((s) => s.s === 'error');
  assert.ok(err, 'prod answered with an error frame');
  assert.equal(err.info, 'Target peer not found');

  // The exact discrimination the shell makes. Nothing in this repo owns that
  // mapping — it lives in the launcher — so this test pins the INPUT to it.
  const SHELL_SURVIVABLE = new Set(['Room not found', 'Room is full']);
  assert.equal(SHELL_SURVIVABLE.has(err.info), false,
    'this is the class of error that ends a CouchPad session');

  net.disconnect();
});

test('asym: peer indices grow past maxClients, and both decoders must cope', async () => {
  // Prod counts LIVE clients against maxClients and pushes new joiners to
  // members.length, so indices grow monotonically past the cap after churn. The
  // E2E stub caps ALLOCATED slots and never frees one, so it can never mint an
  // index above 4 — any assumption that peerIndex < MAX_PLAYERS + 1 passes E2E.
  //
  // WHAT THIS BREAKS AT A REAL PARTY: a lobby that has seen a few players come
  // and go hands the next phone index 5, 6, 7... A display keying colour slots or
  // roster arrays by peerIndex-as-array-index reads undefined and seats a
  // nameless ghost.
  const abi = await H.loadAbi();
  const { relay, room } = await bringUpDisplay({}, { maxClients: 4 });

  const indices = [];
  for (let i = 0; i < 6; i++) {
    const { net, seen } = await bringUpPhone(relay, room, { name: 'P' + i, clientKey: 'churn-' + i });
    indices.push(seen.joined[0]);
    net.disconnect();            // frees the cap, keeps the slot allocated
    await H.flush();
  }
  assert.deepEqual(indices, [1, 2, 3, 4, 5, 6], 'indices grow past maxClients=4');

  // Both decoders read the high index the same way.
  const frame = '{"type":"joined","room":"ABCD","index":6,"peers":[0,1,2,3,4,5]}';
  assert.equal(JSON.parse(abi.framing.classify(frame)).msg.index, 6);
  assert.equal(routeThroughKit(frame).msg.index, 6);
});

test('asym: a returning owner can be told the room is full', async () => {
  // Structurally impossible on the E2E stub, which never frees a slot. On prod a
  // disconnect frees the cap, so by the time the original owner comes back the
  // room may have re-filled — first-come-first-served, no priority for the prior
  // owner (server.ts:508).
  //
  // WHAT THIS BREAKS AT A REAL PARTY: the phone shows "Room is full" on a
  // reconnect the player believes is theirs. It is one of only two error strings
  // the CouchPad shell survives, which is not an accident — but nothing in
  // this repo ever produced it before this test.
  const { relay, room } = await bringUpDisplay({}, { maxClients: 2 });
  const a = await bringUpPhone(relay, room, { name: 'A', clientKey: 'own-A' });
  assert.deepEqual(a.seen.joined, [1]);
  a.net.disconnect();                       // frees the one non-host seat
  await H.flush();

  const b = await bringUpPhone(relay, room, { name: 'B', clientKey: 'own-B' });
  assert.deepEqual(b.seen.joined, [2], 'the freed cap went to a new joiner');

  const back = await bringUpPhone(relay, room, { name: 'A', clientKey: 'own-A' });
  assert.deepEqual(back.seen.joined, [], 'the returning owner never got joined');
  assert.equal(back.seen.status.find((s) => s.s === 'error').info, 'Room is full');
});

test('asym: replacing a live socket fires NO peer_joined, so phones never re-HELLO', async () => {
  // server.ts:526 broadcasts peer_joined only `if (!wasActive)`. The E2E stub
  // fires it unconditionally.
  //
  // WHAT THIS BREAKS AT A REAL PARTY: the display's crash-recovery path replaces
  // its own still-live socket. On prod the phones see nothing, so
  // controller/Net.js's peer_joined-0 re-HELLO never runs, and a display that lost its
  // roster (a reload) never recovers anyone's name — every seat shows blank.
  const { relay, room } = await bringUpDisplay();
  const phone = await bringUpPhone(relay, room, { name: 'Ada', clientKey: 'p' });
  const before = phone.seen.message.length;

  // Same clientId, new socket: prod REPLACES the live one.
  const { NativePartyConnection } = await H.displayAdapters();
  const replacement = new NativePartyConnection('ws://relay/', { clientId: 'host-1' });
  const seen2 = [];
  replacement.onOpen = () => replacement.join(room);
  replacement.onProtocol = (t, m) => seen2.push({ t, m });
  replacement.connect();
  await H.flush();

  assert.equal(seen2.find((e) => e.t === 'joined').m.index, 0, 'the replacement took slot 0');
  const sawPeerJoined = phone.seen.status.some((s) => s.s === 'display_gone')
    || phone.seen.message.length !== before;
  assert.equal(sawPeerJoined, false, 'the phone saw NOTHING — no peer_joined, no peer_left');

  // ...and therefore sent no HELLO. The display's roster stays empty.
  const hellos = relay.log.filter((e) => e.dir === 'c2s' && e.text.includes('"hello"'));
  assert.equal(hellos.length, 1, 'exactly the join-time HELLO, never a re-introduction');
});

test('asym: prod does NOT drop an application-idle socket — only one that stops answering', async () => {
  // `idleTimeout: 10` (server.ts:878) reads like "a quiet phone is dropped in ten
  // seconds". It is not: uWS pings an otherwise-quiet socket and a pong resets the
  // clock, and browsers answer inside the network stack — no page JS, no timers,
  // so backgrounding a tab cannot stop it. MEASURED against the real relay
  // (Party-Sockets 2.3.1 / bun 1.3.10, 2026-07-28), one client that sent a single
  // frame and then went application-silent:
  //
  //   auto-pong ON  (a browser):  t=35s readyState=1 protocolPings=4 closed=null
  //   auto-pong OFF (a dead peer): t=15s readyState=3 closed={code:1006, atSec:12}
  //
  // WHAT THIS MEANS AT A REAL PARTY: the relay reports a locked, backgrounded or
  // Wi-Fi-parked phone as PRESENT, for as long as its socket survives. peer_left
  // is not a silence detector, which is exactly why display/Net.js runs its own
  // 1 Hz liveness (LIVENESS_TIMEOUT_MS = 3 s) instead of trusting the relay, and
  // why a TV shell that skips that layer will show ghosts on the grid.
  //
  // The E2E stub never times out at all, so neither half of this was ever
  // exercised; the previous version of this test asserted the OPPOSITE of what
  // prod does, and the model happily agreed with it.
  const { relay, host, seen, room } = await bringUpDisplay();
  const phone = await bringUpPhone(relay, room, { name: 'Ada', clientKey: 'idle-1' });
  const phoneWs = relay.rooms.get(room).members[1].ws;

  // A full minute of total application silence from BOTH ends. Six timeouts'
  // worth. Nothing is dropped.
  relay.tick(60_000);
  assert.equal(seen.protocol.filter((p) => p.type === 'peer_left').length, 0,
    'the relay never declared the silent phone gone');
  assert.equal(phoneWs.readyState, 1, 'its socket is still open');
  assert.ok(phoneWs._pingsSent >= 5, `and it was pinged along the way (${phoneWs._pingsSent})`);
  assert.deepEqual(phone.seen.status.filter((s) => s.s === 'reconnecting'), [],
    'the phone saw nothing at all');

  // Now the phone stops answering at the PROTOCOL level, which is what a dead
  // peer looks like: airplane mode, a killed app, a router that ate the flow.
  phoneWs.autoPong = false;
  relay.tick(60_000 + 10_000);
  const left = seen.protocol.find((p) => p.type === 'peer_left');
  assert.ok(left, 'THAT is the socket the relay closes, and the display gets a real peer_left');
  assert.equal(left.msg.index, 1);
  // The phone is told nothing by the protocol — its SOCKET simply closes with a
  // non-4000/4001 code, which is the ordinary reconnect path. So a relay-initiated
  // idle drop and a real network failure are indistinguishable to the phone, which
  // is correct: they are the same event.
  assert.deepEqual(phone.seen.status.at(-1), { s: 'reconnecting', info: { attempt: 1, max: 5 } });
  host.close();
});

test('asym: the hostless grace is the most likely real-party ending and has no E2E coverage', async () => {
  // server.ts:326 — the display vanishes and does not come back; ~2 minutes later
  // the relay tears the room down and 4001s everyone. The E2E stub deletes a room
  // only once it is fully empty, so it can never produce this.
  //
  // WHAT THIS BREAKS AT A REAL PARTY: this is how most parties actually end (the
  // TV is switched off), and it is the path that must land phones on the
  // party-over overlay rather than in a reconnect loop.
  const { relay, host, room } = await bringUpDisplay({ hostGraceMs: 120_000 });
  const phone = await bringUpPhone(relay, room, { name: 'Ada', clientKey: 'grace-1' });

  host.close();                       // the TV goes away, WITHOUT close_room
  assert.ok(relay.rooms.has(room), 'the room outlives the host, for now');
  assert.equal(phone.seen.status.at(-1).s, 'display_gone', 'the phone saw peer_left(0)');

  // Two minutes of the phone doing exactly what it does: pinging slot 0 at 1 Hz.
  // (Its socket would survive the wait either way — the relay's idle timeout is
  // protocol-level, see the keepalive test above. The pings are the phone's own
  // liveness signal to the DISPLAY, and here they are what makes the grace
  // observable at all.)
  for (let t = 1000; t < 120_000; t += 1000) {
    relay.tick(t);
    phone.net.send('ping', { t });
  }
  assert.ok(relay.rooms.has(room), 'still alive at 119 s');
  relay.tick(120_000);
  assert.equal(relay.rooms.has(room), false, 'the grace expired and the room is gone');

  // The phone got a 4001, which is TERMINAL — no auto-reconnect.
  assert.equal(phone.seen.status.at(-1).s, 'room_closed');

  // AND — the finding this test exists for. Every one of those 119 pings targeted
  // a vacant slot 0, so prod answered every one with "Target peer not found".
  // The phone routes each through onStatus('error'), and in the CouchPad shell
  // anything outside {Room not found, Room is full} ends the session. So on prod
  // the WebView is torn down about one second after the TV goes away — the room's
  // two-minute grace, and the reconnect it exists to allow, is dead code from the
  // phone's point of view. Neither the E2E stub nor any corpus can produce this.
  const targetErrors = phone.seen.status.filter((s) => s.s === 'error' && s.info === 'Target peer not found');
  assert.equal(targetErrors.length, 119, 'one session-ending error per second of grace');
});

test('asym: a terminal close RESETS the C++ adapter\'s attempt counter, unlike the kit', async () => {
  // NativePartyConnection._applyClose writes `this.reconnectAttempt = o.closeAttempt`
  // unconditionally, and close_outcome returns closeAttempt 0 for 4000/4001. The
  // kit returns early and leaves reconnectAttempt untouched. The framing corpus
  // records the onClose ARGUMENTS, not the field, so it is blind to this.
  //
  // WHAT THIS BREAKS AT A REAL PARTY: nothing today, because every terminal close
  // is followed by a brand-new connection object. A future reconnectNow() after a
  // 4000 would silently get a fresh 5-attempt budget on a socket that was evicted
  // for cause. Pinned as CURRENT behaviour so the divergence is a decision, not a
  // surprise.
  const { PartyConnection } = H.kit();
  const { NativePartyConnection } = await H.displayAdapters();
  H.setRelay(new Relay());

  for (const [label, Ctor] of [['kit', PartyConnection], ['native', NativePartyConnection]]) {
    const c = new Ctor('ws://relay/', { clientId: 'x' });
    c.onClose = () => {};
    c.connect();
    c.reconnectAttempt = 3;                       // three failed retries so far
    c.ws.onclose({ code: CLOSE_REPLACED });
    if (label === 'kit') assert.equal(c.reconnectAttempt, 3, 'the kit leaves the counter alone');
    else assert.equal(c.reconnectAttempt, 0, 'the adapter resets it to 0');
    c.close();
  }

  // The onClose ARGUMENTS — the thing the corpus does pin — are identical.
  const abi = await H.loadAbi();
  const o = JSON.parse(abi.framing.closeOutcome(1, CLOSE_ROOM_CLOSED, 3, 5, 1));
  assert.equal(o.closeAttempt, 0);
  assert.equal(o.closeMax, 0);
  assert.deepEqual(o.meta, { roomClosed: true });
  assert.equal(o.stopReconnect, true);
});

test('asym: setState(undefined) means "clear the state" in C++ and "error" in the kit', async () => {
  // NativePartyConnection coerces `data ?? null`, so setState(undefined) puts
  // {"data":null} on the wire. Prod RETAINS null as a cleared-state signal and
  // pushes it to every peer. The kit drops the key entirely and gets
  // "State data is required".
  //
  // WHAT THIS BREAKS AT A REAL PARTY: a TV shell that clears the lobby by passing
  // undefined silently publishes `null` to every phone, whose onState handler
  // does `if (data && data.type)` and ignores it — so the roster freezes at its
  // last value instead of erroring visibly.
  const { relay, host, room } = await bringUpDisplay();
  const phone = await bringUpPhone(relay, room, { name: 'Ada', clientKey: 'st-1' });

  host.setState({ type: 'lobby_update', players: [] });
  assert.ok(phone.seen.message.find((m) => m.type === 'lobby_update'));

  const before = phone.seen.message.length;
  host.setState(undefined);
  assert.equal(relay.rooms.get(room).state, null, 'prod retained an explicit null');
  assert.equal(phone.seen.message.length, before, 'the phone ignored it (no `.type`)');

  // The kit, same call, gets an error instead.
  const { PartyConnection } = H.kit();
  const kitHost = new PartyConnection('ws://relay/', { clientId: 'kit-host' });
  const kitErrs = [];
  kitHost.onOpen = () => kitHost.create(4, undefined);
  kitHost.onProtocol = (t, m) => { if (t === 'error') kitErrs.push(m.message); };
  kitHost.connect();
  await H.flush();
  kitHost.setState(undefined);
  assert.deepEqual(kitErrs, ['State data is required']);
});

// ---------------------------------------------------------------------------
// 5. The parsers are not the same parser, and C++'s is the display's.
// ---------------------------------------------------------------------------

test('asym: C++ json::parse accepts frames JSON.parse rejects, with different values', async () => {
  // NativePartyConnection hands ttp_framing_classify the RAW socket text
  // DELIBERATELY, so C++'s parser semantics ARE the display's parser semantics.
  // Where the kit drops a malformed frame, C++ accepts it — sometimes with a
  // different value.
  //
  // WHAT THIS BREAKS AT A REAL PARTY: nothing the RELAY sends, because Bun
  // serializes properly. It matters for anything else that can reach the socket
  // — a proxy, a future relay written in another language, or a hostile peer —
  // and it matters most because the divergence is SILENT: the display acts on a
  // value no other implementation would have produced.
  const abi = await H.loadAbi();
  const cls = (t) => JSON.parse(abi.framing.classify(t));
  const kitDrops = (t) => routeThroughKit(t).route === 'none';

  // 1. Trailing bytes after the value.
  const trailing = '{"type":"peer_left","index":3}garbage';
  assert.ok(kitDrops(trailing), 'the kit drops it (JSON.parse throws)');
  assert.equal(cls(trailing).route, 'protocol');
  assert.equal(cls(trailing).msg.index, 3, 'C++ ACCEPTS it and acts on it');

  // 2. Leading '+' and multi-dot numbers: `1.2.3` parses as 1.2.
  const weird = '{"type":"peer_left","index":1.2.3}';
  assert.ok(kitDrops(weird));
  assert.equal(cls(weird).msg.index, 1.2, 'C++ reads 1.2.3 as 1.2');
  assert.equal(cls('{"type":"peer_left","index":+7}').msg.index, 7, 'C++ accepts a leading +');

  // 3. Raw control characters inside a string (a literal 0x01, unescaped).
  const CTL = String.fromCharCode(1);
  const rawCtl = `{"type":"error","message":"a${CTL}b"}`;
  assert.ok(kitDrops(rawCtl), 'JSON.parse rejects an unescaped control char');
  assert.equal(cls(rawCtl).msg.message, `a${CTL}b`, 'C++ accepts it verbatim');

  // 4. Duplicate keys: BOTH parsers take the LAST now. Value::set gained JS
  // assignment semantics (2026-07-31, replace-in-place), so C++'s parser
  // collapses a hostile duplicate at parse time exactly as JSON.parse does.
  // This used to be the sharpest edge in the file: ONE frame yielded TWO
  // different values on the same display, depending on whether C++ EXTRACTED
  // the field (first won) or PASSED THE OBJECT THROUGH to JSON.parse (last
  // won). Both routes agree with each other and with the kit now.
  const dup = '{"type":"message","from":1,"from":2,"data":{"type":"ping"}}';
  assert.equal(routeThroughKit(dup).from, 2, 'JSON.parse: last wins');
  assert.equal(cls(dup).from, 2, 'C++: last wins too');

  const dupProto = '{"type":"peer_left","index":1,"index":2}';
  const raw = abi.framing.classify(dupProto);
  assert.equal((raw.match(/"index"/g) || []).length, 1,
    `the duplicate collapses at the C++ parse: ${raw}`);
  assert.equal(cls(dupProto).msg.index, 2, 'passed through: same last-wins value');
  assert.equal(routeThroughKit(dupProto).msg.index, 2, '...which is what the kit says too');
});

test('asym: numbers cross the boundary in shortest form, both directions', async () => {
  // canonical_stringify uses double-conversion's EcmaScriptConverter::ToShortest,
  // which IS JSON.stringify's algorithm — so every finite double round-trips
  // byte-identically. The gap is the non-finites: canonical_stringify emits bare
  // NaN/Infinity (invalid JSON) where JSON.stringify emits null.
  //
  // WHAT THIS BREAKS AT A REAL PARTY: nothing today — JS stringifies first, so no
  // non-finite ever reaches a Value::Num on the wire path. A TV shell building a
  // Value directly would put an unparseable frame on the relay, and
  // scripts/gen-json-number-corpus.mjs explicitly excludes non-finites, so
  // nothing tests it in either direction. This pins the finite half and names the
  // hole.
  const abi = await H.loadAbi();
  const NUMBERS = [
    0, -0, 1, -1, 0.1, 1e-7, 1e21, 1e-21, 5e-324, 1.7976931348623157e308,
    1234567890123, 0.30000000000000004, 123.456, -9007199254740991, 9007199254740991,
  ];
  for (const n of NUMBERS) {
    const text = abi.framing.sendTo(JSON.stringify(n), JSON.stringify({ v: n }));
    const want = `{"data":{"v":${JSON.stringify(n)}},"to":${JSON.stringify(n)},"type":"send"}`;
    assert.equal(text, want, `shortest form for ${n}`);
    // ...and back through the kit's parser, bit-identical.
    assert.equal(Object.is(JSON.parse(text).data.v, Object.is(n, -0) ? 0 : n), true, `round trip for ${n}`);
  }
  // -0 is the one value JSON cannot carry: JSON.stringify(-0) is "0" on both
  // sides, so it is a shared limitation rather than a divergence.
  assert.equal(JSON.stringify(-0), '0');
});

// ---------------------------------------------------------------------------
// 6. CONTROL: the only game-vocabulary message that becomes typed C++ state.
// ---------------------------------------------------------------------------

test('wire: a real phone\'s CONTROL reaches the sim through the real marshalling rules', async () => {
  // ttp::protocol is a constant TABLE, not a parser — nothing in C++ decodes
  // hello/set_car/select_mode/lobby_update. CONTROL is the exception, and the
  // rules that turn a wire object into (mask, s, b, u) live in
  // public/display/NativeRaceSession.js:127-134, i.e. in the shell the
  // architecture says may contain no logic. Three TV shells will each re-derive
  // them from nothing, and there is no fixture to check them against — so this
  // drives the REAL adapter with the REAL phone's samples.
  const { pathToFileURL } = require('node:url');
  const mod = await import(pathToFileURL(path.join(ROOT, 'public/display/NativeRaceSession.js')).href);
  await mod.init();
  const { InputGate } = await H.controllerModules();

  const session = new mod.NativeRaceSession(
    [{ peerIndex: 0 }], { trackId: 'tidepool', seed: 1, totalLaps: 3 });
  session.startBare();
  const car = () => session.getSnapshot().cars.find((c) => String(c.id) === '0');

  // The exact object ControllerNet.sendControl puts on the wire. `steerInput` is
  // the sim's copy of it (the snapshot's `steer` is the rendered wheel angle).
  const wireMsg = (s, b, u) => ({ s, b, u, type: 'control' });

  session.processInput(0, wireMsg(0.5, 0, 0));
  session.update(16);
  assert.equal(car().steerInput, 0.5, 'steer crossed as a double, not a rounded string');

  // `b` may be a BOOLEAN — a rule that exists only in the shell, nowhere in the
  // protocol table, and that three TV shells will each have to rediscover.
  session.processInput(0, { b: true, type: 'control' });
  session.update(16);
  assert.equal(car().brake, 1, 'typeof m.b === "boolean" -> +m.b');
  session.processInput(0, { b: false, type: 'control' });
  session.update(16);
  assert.equal(car().brake, 0, '...and false is 0, not "absent"');

  // ABSENT fields leave the car untouched (the mask bits), which is exactly what
  // makes the phone's gate safe: a filtered field is not a zeroed field. Get this
  // wrong in a shell and every gated sample slams the wheel straight.
  session.processInput(0, wireMsg(0.75, 0, 0));
  session.update(16);
  session.processInput(0, { u: 1, type: 'control' });
  session.update(16);
  assert.equal(car().steerInput, 0.75, 'an absent `s` did NOT reset steering to 0');

  // A non-numeric `s` is NOT marshalled at all (mask bit stays clear), so a shell
  // that stringified its samples would silently freeze every wheel rather than
  // erroring. Pinned because a string is exactly what a naive port produces.
  session.processInput(0, { s: '0.1', type: 'control' });
  session.update(16);
  assert.equal(car().steerInput, 0.75, 'a stringified steer is dropped, not coerced');

  // The sim clamps, the wire does not. Both halves of that matter: a phone
  // sending 5 must not drive at 5x lock, and the display must not pre-clamp and
  // hide a broken sender.
  session.processInput(0, wireMsg(5, 5, 0));
  session.update(16);
  assert.equal(car().steerInput, 1, 'steer clamps to [-1, 1] IN THE SIM');
  assert.equal(car().brake, 1, 'brake clamps to [0, 1]');

  // Full double precision survives the boundary — the controller sends {s,b,u}
  // verbatim and nothing rounds on the wire, so the phone's gate threshold and
  // the sim's value are the same number.
  const gate = new InputGate();
  const sample = { s: 0.123456789, b: 0, u: 0 };
  assert.equal(gate.decide(sample, 0, 0), 'change');
  gate.markSent(sample, 0);
  session.processInput(0, { ...sample, type: 'control' });
  session.update(16);
  assert.equal(car().steerInput, 0.123456789, 'full double precision survives');

  // `u`'s wrap at 256 is NOT observable here — Game::processInput only sets
  // wantUse, which does nothing without a held item, and no ABI export surfaces
  // useSeq. It is asserted where it IS observable: the fastlane's applied-payload
  // stream (tests/wire-fastlane.test.js), which is also the only place the wrap
  // actually crosses a language boundary.

  session.dispose();
});
