// Generates tests/fixtures/framing-corpus.jsonl — the oracle for the C++ twin of
// partyplug/PartyConnection.js's PURE relay-framing surface: what bytes the kit
// puts on the wire, how it classifies inbound relay frames, what a close code
// decides, the reconnect backoff, and the sharded reconnect URL. The socket
// itself (open/reconnect loop, JSON.parse) stays platform I/O — this pins the
// framing logic that logic drives.
//
// Every case is produced by driving the REAL PartyConnection with a mock
// WebSocket (capturing the exact object handed to ws.send) and a setTimeout spy
// (capturing the backoff delay / whether a reconnect is scheduled) — so the
// oracle is the shipping code, not a paraphrase.
//
//   line 1  header {kind:'framing'}
//   line 2+ one op each (inputs carried so the C++ check drives the port itself):
//     {op:'encode',   kind, ...inputs, expect:<sent object>}
//     {op:'classify', wire, expect:{route, ...payload}}
//     {op:'classify', raw,  expect:{route, ...payload}}   — RAW socket text; ABI-only
//                     (the C++ library takes a parsed frame, so only the ABI can
//                      classify text as route 'none' — see classifyRawCase)
//     {op:'close',    code, hasCode, attemptBefore, maxAttempts, shouldReconnectBefore,
//                     expect:{stopReconnect, closeAttempt, closeMax, meta, willReconnect}}
//     {op:'backoff',  attempt, expect:<delay ms>}
//     {op:'pin',      base, room, instance, expect:<relayUrl>}
//
// Deterministic: re-runs are byte-identical.
// Usage: node scripts/gen-framing-corpus.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { canonicalStringify } from './oracle-lib.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests/fixtures/framing-corpus.jsonl');

// ---- mock WebSocket: captures ws.send payloads, drives on* callbacks ---------
class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 1;               // OPEN (encoders gate on readyState===1)
    this.onopen = this.onclose = this.onmessage = this.onerror = null;
    this._sent = [];
    MockWebSocket._instances.push(this);
  }
  send(data) { this._sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
}
MockWebSocket._instances = [];
global.WebSocket = MockWebSocket;

const require = createRequire(import.meta.url);
const PartyConnection = require('../partyplug/PartyConnection.js');

const lines = [];
lines.push(canonicalStringify({ kind: 'framing' }));

// ---- outbound encoders -------------------------------------------------------
// Data-driven: the case carries the inputs, the real PartyConnection produces
// the captured object, and the C++ check re-drives the port from those inputs.
function encodeCase(rec, run) {
  const pc = new PartyConnection('wss://relay.example.com', { clientId: rec.clientId || 'cid-1' });
  pc.connect();
  const ws = MockWebSocket._instances[MockWebSocket._instances.length - 1];
  ws._sent.length = 0;
  run(pc);
  lines.push(canonicalStringify({ op: 'encode', ...rec, expect: ws._sent[ws._sent.length - 1] }));
}

encodeCase({ kind: 'create', clientId: 'cid-1', maxClients: 4 }, (pc) => pc.create(4));
encodeCase({ kind: 'create', clientId: 'cid-1', maxClients: 8, url: 'https://x.example.com/c/{room}' },
  (pc) => pc.create(8, 'https://x.example.com/c/{room}'));
encodeCase({ kind: 'join', clientId: 'cid-1', room: 'ROOM7' }, (pc) => pc.join('ROOM7'));
encodeCase({ kind: 'sendTo', to: 2, data: { type: 'control', s: 0.5, b: 0 } },
  (pc) => pc.sendTo(2, { type: 'control', s: 0.5, b: 0 }));
encodeCase({ kind: 'sendTo', to: 0, data: { type: 'hello', name: 'Zoë' } },
  (pc) => pc.sendTo(0, { type: 'hello', name: 'Zoë' }));
encodeCase({ kind: 'broadcast', data: { type: 'countdown', n: 3 } },
  (pc) => pc.broadcast({ type: 'countdown', n: 3 }));
encodeCase({ kind: 'setState', data: { roomState: 'lobby', players: [{ peerIndex: 0 }] } },
  (pc) => pc.setState({ roomState: 'lobby', players: [{ peerIndex: 0 }] }));
encodeCase({ kind: 'closeRoom' }, (pc) => pc.closeRoom());

// ---- inbound classification --------------------------------------------------
// Feed ws.onmessage a wire frame; capture which callback fired + its payload.
function classifyCase(wire) {
  const pc = new PartyConnection('wss://relay.example.com', { clientId: 'cid-1' });
  let captured = { route: 'none' };
  pc.onMessage = (from, data) => { captured = { route: 'message', from, data }; };
  pc.onState = (data) => { captured = { route: 'state', data }; };
  pc.onProtocol = (type, msg) => { captured = { route: 'protocol', type: type === undefined ? null : type, msg }; };
  pc.connect();
  const ws = MockWebSocket._instances[MockWebSocket._instances.length - 1];
  ws.onmessage({ data: JSON.stringify(wire) });
  lines.push(canonicalStringify({ op: 'classify', wire, expect: captured }));
}

classifyCase({ type: 'message', from: 3, data: { type: 'control', s: -1, b: 1, u: 42 } });
classifyCase({ type: 'message', from: 0, data: { type: 'leave' } });
classifyCase({ type: 'state', data: { roomState: 'playing', hostPeerIndex: 0 } });
classifyCase({ type: 'created', room: 'AB12', index: 0, instance: 'shard-3' });
classifyCase({ type: 'joined', room: 'AB12', index: 2, peers: [0, 1] });
classifyCase({ type: 'peer_joined', index: 3 });
classifyCase({ type: 'peer_left', index: 1 });
classifyCase({ type: 'error', message: 'Room not found' });
classifyCase({ type: 'weird_unknown_type', foo: 1 });    // -> protocol, type carried
classifyCase({ noType: true });                          // no .type -> protocol, type null

// RAW-TEXT frames: what the socket can actually deliver that is not a JSON object.
// These carry `raw` instead of `wire`, and they are consumed by the ABI check ALONE.
// That is a layering fact, not an omission: ttp::framing::classify_inbound takes an
// already-PARSED value and its Route enum has no "none", because the C++ library
// never sees text. Deciding that a frame is not JSON at all belongs to whoever holds
// the socket — in our case ttp_framing_classify — so this is the only oracle that can
// pin it. Recorded off the real PartyConnection's onmessage, JSON.parse and all.
function classifyRawCase(raw) {
  const pc = new PartyConnection('wss://relay.example.com', { clientId: 'cid-1' });
  let captured = { route: 'none' };
  pc.onMessage = (from, data) => { captured = { route: 'message', from, data }; };
  pc.onState = (data) => { captured = { route: 'state', data }; };
  pc.onProtocol = (type, msg) => { captured = { route: 'protocol', type: type === undefined ? null : type, msg }; };
  pc.connect();
  const ws = MockWebSocket._instances[MockWebSocket._instances.length - 1];
  ws.onmessage({ data: raw });
  lines.push(canonicalStringify({ op: 'classify', raw, expect: captured }));
}

classifyRawCase('not json at all');   // parse throws -> dropped
classifyRawCase('');                  // empty frame
classifyRawCase('[1,2,3]');           // valid JSON, not an object
classifyRawCase('"a string"');        // valid JSON scalar
classifyRawCase('null');              // valid JSON null
classifyRawCase('7');                 // valid JSON number

// ---- close-code semantics ----------------------------------------------------
// Drive ws.onclose; capture onClose(attempt,max,meta), whether reconnect is
// scheduled (setTimeout spy), and the resulting _shouldReconnect.
function closeCase(code, hasCode, attemptBefore, maxAttempts, shouldReconnectBefore) {
  const pc = new PartyConnection('wss://relay.example.com', { clientId: 'cid-1', maxReconnectAttempts: maxAttempts });
  pc.connect();
  const ws = MockWebSocket._instances[MockWebSocket._instances.length - 1];
  pc.reconnectAttempt = attemptBefore;
  pc._shouldReconnect = shouldReconnectBefore;
  let closeArgs = null;
  pc.onClose = (attempt, max, meta) => { closeArgs = { attempt, max, meta: meta === undefined ? null : meta }; };
  const realSetTimeout = global.setTimeout;
  let scheduled = false;
  global.setTimeout = () => { scheduled = true; return 0; };
  try {
    ws.onclose(hasCode ? { code } : {});
  } finally {
    global.setTimeout = realSetTimeout;
  }
  lines.push(canonicalStringify({
    op: 'close', code: hasCode ? code : null, hasCode, attemptBefore, maxAttempts, shouldReconnectBefore,
    expect: {
      stopReconnect: pc._shouldReconnect === false,
      closeAttempt: closeArgs ? closeArgs.attempt : null,
      closeMax: closeArgs ? closeArgs.max : null,
      meta: closeArgs ? closeArgs.meta : null,
      willReconnect: scheduled,
    },
  }));
}

closeCase(4000, true, 0, 5, true);      // replaced (eviction)
closeCase(4001, true, 0, 5, true);      // room closed
closeCase(1006, true, 0, 5, true);      // abnormal -> reconnect (attempt 1)
closeCase(1006, true, 4, 5, true);      // last allowed reconnect (attempt 5 == max)
closeCase(1006, true, 5, 5, true);      // over budget (attempt 6 > max) -> give up
closeCase(1000, true, 2, 5, true);      // normal close -> still reconnects
closeCase(1006, true, 0, 5, false);     // shouldReconnect already false -> no schedule
closeCase(0, false, 1, 5, true);        // no code at all -> else branch

// ---- reconnect backoff -------------------------------------------------------
// Isolated: set reconnectAttempt=k, call _scheduleReconnect with a setTimeout
// spy that captures the delay (min(1000*1.5^(k-1), 5000)).
function backoffCase(attempt) {
  const pc = new PartyConnection('wss://relay.example.com', { clientId: 'cid-1' });
  pc.reconnectAttempt = attempt;
  const realSetTimeout = global.setTimeout;
  let delay = null;
  global.setTimeout = (_fn, ms) => { delay = ms; return 0; };
  try { pc._scheduleReconnect(); } finally { global.setTimeout = realSetTimeout; }
  lines.push(canonicalStringify({ op: 'backoff', attempt, expect: delay }));
}
for (let k = 1; k <= 12; k++) backoffCase(k);

// ---- sharded reconnect URL (pinInstance -> encodeURIComponent) ---------------
function pinCase(base, room, instance) {
  const pc = new PartyConnection(base, { clientId: 'cid-1' });
  pc.pinInstance(base, room, instance);
  lines.push(canonicalStringify({ op: 'pin', base, room, instance, expect: pc.relayUrl }));
}
const BASE = 'wss://relay.example.com';
pinCase(BASE, 'MY-ROOM', 'inst-1');            // plain
pinCase(BASE, 'a b/c', 'i?d=1');               // space, slash, query specials
pinCase(BASE, 'r#m&x=1', 's/2?a=b&c=d');       // hash, amp, equals
pinCase(BASE, "-_.!~*'()", "-_.!~*'()");       // unreserved: passthrough, no escaping
pinCase(BASE, 'Zoë', '日本');                   // multibyte UTF-8 -> %XX%XX
pinCase(BASE, 'A+B%C', 'x y+z');               // plus and percent literals
pinCase(BASE, '', 'only-instance');            // empty room
// instance falsy -> no-op (relayUrl unchanged); record the untouched base.
{
  const pc = new PartyConnection(BASE, { clientId: 'cid-1' });
  pc.pinInstance(BASE, 'X', null);
  lines.push(canonicalStringify({ op: 'pin', base: BASE, room: 'X', instance: null, expect: pc.relayUrl }));
}
{
  const pc = new PartyConnection(BASE, { clientId: 'cid-1' });
  pc.pinInstance(BASE, 'X', '');
  lines.push(canonicalStringify({ op: 'pin', base: BASE, room: 'X', instance: '', expect: pc.relayUrl }));
}

fs.writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`wrote ${OUT}: ${lines.length - 1} cases`);
