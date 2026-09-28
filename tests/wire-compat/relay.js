'use strict';

// ============================================================================
// A PRODUCTION-SHAPED relay, in process, for the wire-compat suite.
//
// READ THIS BEFORE TRUSTING A GREEN RUN.
//
// This is a MODEL of Party-Sockets (/Users/tim/Projects/Party-Sockets/server.ts,
// package version 2.3.1), not the relay itself. It exists because the two things
// the wire-compat suite must pin — the C++ encoders/decoders on the TV and the JS
// encoders/decoders on the phone — can only be pinned against a relay that
// behaves like the real one, and CI cannot reach the real one.
//
// It is deliberately NOT tests/e2e/relay-server.js. That stub is a permissive
// pipe: it accepts anything, never frees a slot, never times out, never errors on
// a bad target, and can therefore never mint the frames that break a real party.
// Everything it cannot do is modelled here, each cited to the line of server.ts it
// comes from:
//
//   * `to: null` on a send                -> "Target peer not found"   (server.ts:576)
//     (the stub BROADCASTS it instead     -> relay-server.js:110)
//   * a send to a vanished slot           -> "Target peer not found"   (server.ts:580)
//     (the stub silently drops it)
//   * peer indices grow past maxClients   -> index = members.length    (server.ts:544)
//   * a returning owner can be refused    -> "Room is full"            (server.ts:513)
//   * peer_joined SUPPRESSED on a replace -> `if (!wasActive)`         (server.ts:526)
//   * a socket that stops ANSWERING PINGS is closed 1006 (see KEEPALIVE below)
//                                         -> idleTimeout: 10           (server.ts:878)
//   * hostless grace tears the room down  -> startHostGrace            (server.ts:326)
//   * unknown type / invalid JSON error   -> server.ts:902 / :886
//   * `created`/`joined` carry instance/region/url (server.ts:471/:523)
//   * create validates the url template   -> validateUrlTemplate       (server.ts:403)
//   * set_state: host-only, 16 KiB of UTF-8, `undefined` refused but `null`
//     RETAINED as a cleared-state signal  -> server.ts:592
//
// KEEPALIVE, AND WHY IT IS NOT WHAT `idleTimeout: 10` LOOKS LIKE.
// Bun's idleTimeout is not an APPLICATION-traffic timeout. uWS sends protocol
// PING frames on an otherwise-quiet socket and a pong resets the timer, and every
// browser answers a ping inside its network stack — no page JS, no timers, so
// backgrounding a phone cannot stop it. An application-silent socket therefore
// stays open indefinitely; only one that stops answering AT THE PROTOCOL LEVEL is
// dropped. Measured against the real relay (Party-Sockets 2.3.1 on bun 1.3.10,
// 2026-07-28), one `ws` client that sent a single frame and then went quiet:
//
//     auto-pong ON  (what a browser does):  t=35s readyState=1 pings=4 closed=null
//     auto-pong OFF (a dead peer):          t=15s readyState=3 closed={code:1006, atSec:12}
//
// So the model counts idle SWEEPS the way uWS does (a 4 s timer, ping once the
// counter reaches 80% of the timeout, close once it passes it) and closes only
// the socket that does not answer (`ws.autoPong = false`). That reproduces both
// observed instants exactly: the ping at 8 s and, unanswered, the close at 12 s.
//
// This matters because the opposite model ("the relay drops a quiet phone")
// invents a drop path the display DOES rely on: presence is peer_left and nothing
// else now (protocol.js LIVENESS). In truth the relay reports a locked phone as
// PRESENT until its socket really dies, so that phone holds its seat — the known,
// accepted cost of one authority instead of two, and the reason the phone closes
// its own link on background rather than waiting to be noticed.
//
// WHAT THIS MODEL STILL IS NOT:
//   * not the real Bun socket stack: no fragmentation, no backpressure, no
//     maxPayloadLength, no TLS, no real close handshake timing;
//   * the keepalive sweep is a MODEL of uWS's timer, on the same 4 s grid but
//     driven by tick() rather than by a loop: sweeps land on absolute multiples
//     of SWEEP_MS, so where a test stops the clock cannot shift the grid;
//   * delivery is SYNCHRONOUS (a server->client frame lands inside the client's
//     own send() call). Real ordering is preserved, real interleaving is not;
//   * the shard/instance routing, /room/:code, /metrics and the drain path are
//     absent — nothing on the wire path depends on them;
//   * every timer is explicit (relay.tick(nowMs)); nothing fires on its own.
//
// The rules above are frozen in tests/wire-compat/relay-contract.json, and
// scripts/wire-relay-contract.mjs re-derives that file from a Party-Sockets
// checkout. When the relay changes, the generator's output changes, the frozen
// contract test goes red, and this model gets updated on purpose. That is the
// only thing standing between this file and quiet fiction.
// ============================================================================

const CLOSE_REPLACED = 4000;
const CLOSE_ROOM_CLOSED = 4001;
// Bun reports an idle-timeout close to the peer as an abnormal closure (1006,
// observed). The value only matters here in that it is NEITHER 4000 nor 4001, so
// both client implementations take their reconnect path.
const CLOSE_IDLE = 1006;

const MAX_STATE_BYTES = 16 * 1024;   // server.ts:97
const MAX_URL_BYTES = 512;           // server.ts:116
const URL_PLACEHOLDERS = new Set(['room', 'instance']);
const IDLE_TIMEOUT_MS = 10_000;      // server.ts:878 (idleTimeout: 10, seconds)
// uWS's keepalive, in the transport's units, not Party-Sockets': a 4 s timer
// grid, a PING once a socket has been quiet for 80% of the timeout (observed at
// t=8 s), and a close on the first sweep past the timeout itself (observed at
// t=12 s). Not Party-Sockets constants, which is why they are not in the frozen
// contract — server.ts only chooses `idleTimeout: 10`.
const SWEEP_MS = 4_000;
const PING_AFTER_MS = IDLE_TIMEOUT_MS * 0.8;
const HOST_GRACE_MS = 120_000;       // server.ts:106 HOST_DISCONNECT_GRACE_MS

// server.ts:391
function fillUrlTemplate(template, code, instance) {
  return template
    .replaceAll('{room}', encodeURIComponent(code))
    .replaceAll('{instance}', encodeURIComponent(instance));
}

// server.ts:403 — verbatim rule set, same order, same messages.
function validateUrlTemplate(url) {
  if (typeof url !== 'string') return 'url must be a string';
  if (Buffer.byteLength(url) > MAX_URL_BYTES) return 'url too large';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f]/.test(url)) {
    return 'url must not contain spaces or control characters';
  }
  for (const match of url.matchAll(/\{([^}]*)\}/g)) {
    if (!URL_PLACEHOLDERS.has(match[1])) return `Unknown url placeholder: {${match[1]}}`;
  }
  if (/[{}]/.test(url.replaceAll('{room}', '').replaceAll('{instance}', ''))) {
    return 'url has an unmatched placeholder brace';
  }
  let parsed;
  try {
    parsed = new URL(fillUrlTemplate(url, 'room', 'instance'));
  } catch (_) {
    return 'url is not a valid URL';
  }
  if (parsed.protocol !== 'https:') return 'url must be an https URL';
  return null;
}

// Unambiguous A-Z/2-9, like the real relay's short codes. Deterministic here so a
// failing test names the same room every run.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class Relay {
  constructor(opts = {}) {
    this.instanceId = opts.instanceId ?? '';
    this.region = opts.region ?? '';
    this.idleTimeoutMs = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.hostGraceMs = opts.hostGraceMs ?? HOST_GRACE_MS;
    this.draining = false;
    // code -> { maxClients, members: [{clientId, ws}|undefined], active, url, state?,
    //           hostGraceDeadline }
    this.rooms = new Map();
    this.now = 0;
    this._codeSeq = 0;
    this._sockets = new Set();
    // Every frame that crossed the wire, both directions, for assertions about
    // BYTES rather than about decoded values.
    this.log = [];
  }

  // ---- clock -------------------------------------------------------------
  // Nothing in this relay fires on its own. Tests advance the clock explicitly,
  // which runs exactly the two timers the real relay owns.
  //
  // The keepalive is SWEPT rather than evaluated once at `nowMs`: a test that
  // jumps the clock a minute must see the same sequence of pings a real socket
  // would have answered, not a single overdue verdict. The grid is absolute
  // (multiples of SWEEP_MS), so where a test happens to stop the clock cannot
  // shift it and manufacture an idle close. See the header.
  tick(nowMs) {
    for (let t = Math.floor(this.now / SWEEP_MS) * SWEEP_MS + SWEEP_MS; t <= nowMs; t += SWEEP_MS) {
      this.now = t;
      this._keepaliveSweep();
    }
    this.now = nowMs;
    for (const [code, room] of [...this.rooms]) {
      if (room.hostGraceDeadline != null && nowMs >= room.hostGraceDeadline) {
        room.hostGraceDeadline = null;
        if (this.rooms.get(code) === room && !room.members[0]?.ws) this._closeRoom(code, room);
      }
    }
  }

  // One uWS keepalive pass. Idleness is counted in SWEEPS since the socket last
  // said anything, exactly as uWS counts it: at 2 sweeps (8 s) a quiet socket
  // gets a protocol PING, and a peer that answers — every browser, in its network
  // stack — resets the counter, so it is never closed. A peer that does not
  // answer reaches 3 sweeps (12 s) and is closed 1006, which is the ordinary
  // reconnect path on both clients, indistinguishable from a network failure,
  // which is exactly what it is.
  _keepaliveSweep() {
    for (const ws of [...this._sockets]) {
      if (ws.readyState !== 1) continue;
      const idleMs = ++ws._idleSweeps * SWEEP_MS;
      if (idleMs >= this.idleTimeoutMs) { this._serverClose(ws, CLOSE_IDLE, 'idle'); continue; }
      if (idleMs >= PING_AFTER_MS) {
        ws._pingsSent++;
        if (ws.autoPong) ws._idleSweeps = 0;
      }
    }
  }

  // ---- the client-facing WebSocket ---------------------------------------
  // A constructor with the shape both PartyConnection and NativePartyConnection
  // expect: readyState, send(text), close(), on{open,message,close,error}.
  webSocketClass() {
    const relay = this;
    return class FakeWebSocket {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.onopen = this.onmessage = this.onclose = this.onerror = null;
        this._data = { origin: 'wire-compat', room: undefined, clientId: undefined, index: undefined };
        // Sweeps since the last PROTOCOL-level sign of life: an application frame
        // or an answered ping. A browser answers in its network stack, so
        // autoPong defaults on; a test sets it false to model a peer that has
        // genuinely gone away (airplane mode, a killed app, a dead route).
        this._idleSweeps = 0;
        this.autoPong = true;
        this._pingsSent = 0;
        relay._sockets.add(this);
        // Real sockets never open inside the constructor — the caller has not
        // attached handlers yet. One microtask is the smallest honest delay.
        queueMicrotask(() => {
          if (this.readyState !== 0) return;
          this.readyState = 1;
          if (this.onopen) this.onopen();
        });
      }

      send(text) {
        if (this.readyState !== 1) throw new Error('InvalidStateError');
        relay.log.push({ dir: 'c2s', text });
        this._idleSweeps = 0;      // application traffic answers the keepalive too
        relay._onMessage(this, text);
      }

      // Client-initiated close. The relay sees a socket close, exactly as it does
      // for a real one.
      close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        relay._sockets.delete(this);
        relay._removeFromRoom(this);
        // A client-initiated close fires no onclose here: the kit detaches its
        // handlers in _discardOldWs before calling close(), so a real one would
        // not be observed either.
      }
    };
  }

  // ---- server -> client ---------------------------------------------------
  _send(ws, msg) {
    if (!ws || ws.readyState !== 1) return;
    const text = JSON.stringify(msg);
    this.log.push({ dir: 's2c', text });
    if (ws.onmessage) ws.onmessage({ data: text });
  }

  _serverClose(ws, code, reason) {
    if (ws.readyState === 3) return;
    ws.readyState = 3;
    this._sockets.delete(ws);
    this._removeFromRoom(ws);
    if (ws.onclose) ws.onclose({ code, reason: reason || '' });
  }

  _broadcast(code, msg, exclude) {
    const room = this.rooms.get(code);
    if (!room) return;
    for (const member of room.members) {
      if (!member || !member.ws || member.ws === exclude) continue;
      this._send(member.ws, msg);
    }
  }

  // ---- inbound dispatch (server.ts:880) ----------------------------------
  _onMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return this._send(ws, { type: 'error', message: 'Invalid JSON' });
    }
    switch (msg && msg.type) {
      case 'create': return this._handleCreate(ws, msg);
      case 'join': return this._handleJoin(ws, msg);
      case 'send': return this._handleSend(ws, msg);
      case 'set_state': return this._handleSetState(ws, msg);
      case 'close_room': return this._handleCloseRoom(ws);
      default: return this._send(ws, { type: 'error', message: 'Unknown message type' });
    }
  }

  _newCode() {
    // Deterministic 4-char codes: AAAB, AAAC, ... Room identity is not the thing
    // under test, and a stable code makes failures reproducible.
    const n = this._codeSeq++;
    let c = '';
    let v = n;
    for (let i = 0; i < 4; i++) { c = ALPHABET[v % ALPHABET.length] + c; v = Math.floor(v / ALPHABET.length); }
    return c;
  }

  // server.ts:433
  _handleCreate(ws, msg) {
    if (this.draining) return this._send(ws, { type: 'error', message: 'Server draining' });
    if (ws._data.room) return this._send(ws, { type: 'error', message: 'Already in a room' });
    if (!msg.clientId || typeof msg.clientId !== 'string') {
      return this._send(ws, { type: 'error', message: 'clientId is required' });
    }
    if (!msg.maxClients || typeof msg.maxClients !== 'number' || msg.maxClients < 1) {
      return this._send(ws, { type: 'error', message: 'maxClients must be a positive number' });
    }
    if (msg.url !== undefined) {
      const urlError = validateUrlTemplate(msg.url);
      if (urlError) return this._send(ws, { type: 'error', message: urlError });
    }
    const code = this._newCode();
    const room = {
      maxClients: msg.maxClients,
      members: [{ clientId: msg.clientId, ws }],
      active: 1,
      url: msg.url === undefined ? undefined : fillUrlTemplate(msg.url, code, this.instanceId),
      hostGraceDeadline: null,
    };
    this.rooms.set(code, room);
    ws._data.clientId = msg.clientId;
    ws._data.room = code;
    ws._data.index = 0;
    this._send(ws, {
      type: 'created', room: code, instance: this.instanceId, region: this.region,
      index: 0, url: room.url,
    });
  }

  // server.ts:474
  _handleJoin(ws, msg) {
    if (ws._data.room) return this._send(ws, { type: 'error', message: 'Already in a room' });
    if (!msg.clientId || typeof msg.clientId !== 'string') {
      return this._send(ws, { type: 'error', message: 'clientId is required' });
    }
    if (!msg.room || typeof msg.room !== 'string') {
      return this._send(ws, { type: 'error', message: 'room is required' });
    }
    const room = this.rooms.get(msg.room);
    if (!room) return this._send(ws, { type: 'error', message: 'Room not found' });

    const existingIndex = room.members.findIndex((m) => m && m.clientId === msg.clientId);
    if (existingIndex !== -1) {
      const existing = room.members[existingIndex];
      const wasActive = existing.ws !== undefined;
      if (existing.ws) {
        const old = existing.ws;
        old._data.room = undefined;
        old._data.clientId = undefined;
        old._data.index = undefined;
        this._serverClose(old, CLOSE_REPLACED, 'replaced');
      } else {
        // Disconnects free the cap, so a returning owner races new joiners for it.
        if (room.active >= room.maxClients) {
          return this._send(ws, { type: 'error', message: 'Room is full' });
        }
        room.active++;
        if (existingIndex === 0) room.hostGraceDeadline = null;
      }
      existing.ws = ws;
      ws._data.clientId = msg.clientId;
      ws._data.room = msg.room;
      ws._data.index = existingIndex;
      this._send(ws, {
        type: 'joined', room: msg.room, index: existingIndex,
        peers: this._peerIndices(room, existingIndex), url: room.url,
      });
      this._sendRetainedState(ws, room);
      // THE SUPPRESSION (server.ts:526): a replace is invisible to the room.
      if (!wasActive) this._broadcast(msg.room, { type: 'peer_joined', index: existingIndex }, ws);
      return;
    }

    if (room.active >= room.maxClients) {
      return this._send(ws, { type: 'error', message: 'Room is full' });
    }
    // Indices grow monotonically and MAY EXCEED maxClients (server.ts:544).
    const index = room.members.length;
    room.members.push({ clientId: msg.clientId, ws });
    room.active++;
    ws._data.clientId = msg.clientId;
    ws._data.room = msg.room;
    ws._data.index = index;
    this._send(ws, {
      type: 'joined', room: msg.room, index, peers: this._peerIndices(room, index), url: room.url,
    });
    this._sendRetainedState(ws, room);
    this._broadcast(msg.room, { type: 'peer_joined', index }, ws);
  }

  _sendRetainedState(ws, room) {
    if (room.state !== undefined) this._send(ws, { type: 'state', data: room.state });
  }

  _peerIndices(room, selfIndex) {
    const out = [];
    for (let i = 0; i < room.members.length; i++) {
      if (i !== selfIndex && room.members[i] && room.members[i].ws) out.push(i);
    }
    return out;
  }

  // server.ts:564
  _handleSend(ws, msg) {
    const { index, room: roomCode } = ws._data;
    if (index === undefined || !roomCode) {
      return this._send(ws, { type: 'error', message: 'Not in a room' });
    }
    const room = this.rooms.get(roomCode);
    if (!room) return this._send(ws, { type: 'error', message: 'Room not found' });

    if (msg.to !== undefined) {
      // Number.isSafeInteger(null) === false, so an explicit `to: null` lands
      // HERE, not in the broadcast branch. This is the single sharpest divergence
      // from the E2E stub, which tests `msg.to != null` and broadcasts instead.
      if (!Number.isSafeInteger(msg.to) || msg.to < 0) {
        return this._send(ws, { type: 'error', message: 'Target peer not found' });
      }
      const target = room.members[msg.to];
      if (!target || !target.ws) {
        return this._send(ws, { type: 'error', message: 'Target peer not found' });
      }
      this._send(target.ws, { type: 'message', from: index, data: msg.data });
    } else {
      this._broadcast(roomCode, { type: 'message', from: index, data: msg.data }, ws);
    }
  }

  // server.ts:592
  _handleSetState(ws, msg) {
    const { index, room: roomCode } = ws._data;
    if (index === undefined || !roomCode) {
      return this._send(ws, { type: 'error', message: 'Not in a room' });
    }
    const room = this.rooms.get(roomCode);
    if (!room) return this._send(ws, { type: 'error', message: 'Room not found' });
    if (index !== 0) return this._send(ws, { type: 'error', message: 'Only the host can set state' });
    if (msg.data === undefined) {
      return this._send(ws, { type: 'error', message: 'State data is required' });
    }
    // UTF-8 BYTES, not UTF-16 units.
    if (Buffer.byteLength(JSON.stringify(msg.data)) > MAX_STATE_BYTES) {
      return this._send(ws, { type: 'error', message: 'State too large' });
    }
    room.state = msg.data;
    this._broadcast(roomCode, { type: 'state', data: msg.data }, ws);
  }

  // server.ts:625
  _handleCloseRoom(ws) {
    const { index, room: roomCode } = ws._data;
    if (index === undefined || !roomCode) {
      return this._send(ws, { type: 'error', message: 'Not in a room' });
    }
    const room = this.rooms.get(roomCode);
    if (!room) return this._send(ws, { type: 'error', message: 'Room not found' });
    if (index !== 0) {
      return this._send(ws, { type: 'error', message: 'Only the host can close the room' });
    }
    this._closeRoom(roomCode, room);
  }

  // server.ts:373
  _closeRoom(code, room) {
    room.hostGraceDeadline = null;
    this.rooms.delete(code);
    for (const member of room.members) {
      const memberWs = member && member.ws;
      if (!memberWs) continue;
      member.ws = undefined;
      memberWs._data.room = undefined;
      memberWs._data.clientId = undefined;
      memberWs._data.index = undefined;
      this._serverClose(memberWs, CLOSE_ROOM_CLOSED, 'room closed');
    }
  }

  // server.ts:320
  _removeFromRoom(ws) {
    const { index, room: roomCode } = ws._data;
    if (index === undefined || !roomCode) return;
    const room = this.rooms.get(roomCode);
    if (!room) return;
    const member = room.members[index];
    if (!member || member.ws !== ws) return;
    member.ws = undefined;
    room.active--;
    ws._data.room = undefined;
    ws._data.clientId = undefined;
    ws._data.index = undefined;
    if (room.active === 0) {
      room.hostGraceDeadline = null;
      this.rooms.delete(roomCode);
    } else {
      this._broadcast(roomCode, { type: 'peer_left', index });
      // The display vanishing arms the room's death clock.
      if (index === 0) room.hostGraceDeadline = this.now + this.hostGraceMs;
    }
  }
}

module.exports = {
  Relay,
  CLOSE_REPLACED,
  CLOSE_ROOM_CLOSED,
  MAX_STATE_BYTES,
  MAX_URL_BYTES,
  IDLE_TIMEOUT_MS,
  HOST_GRACE_MS,
};
