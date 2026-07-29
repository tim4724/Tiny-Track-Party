'use strict';

// Hermetic Party-Server relay stub for the E2E suite — implements just the
// protocol subset partyplug/PartyConnection.js documents, so the display +
// controller pages run their REAL transport against localhost instead of the
// production relay (wss://ws.couchpad.games). Pages are pointed here via the
// app server's RELAY_URL env (injected as the relay-url <meta>; see
// shared/protocol.js); playwright.config.js boots both servers.
//
//   Client → relay:  create    { clientId, maxClients }
//   Client → relay:  join      { clientId, room }
//   Client → relay:  send      { data, to? }
//   Client → relay:  set_state { data }        // host (slot 0) only, <= 16 KiB
//   Client → relay:  close_room {}             // host (slot 0) only: delete the room, close every member socket with 4001
//   relay  → client: created     { room, index: 0 }
//   relay  → client: joined      { room, index, peers: number[] }  // then a `state` replay, if retained
//   relay  → client: peer_joined { index } / peer_left { index }
//   relay  → client: message     { from, data }
//   relay  → client: state       { data }      // retained host snapshot: live push + post-join replay
//   relay  → client: error       { message }   // 'Room not found' / 'Room is full'
//
// Slot semantics mirror the real relay: indices are keyed by clientId, stable
// for the room's lifetime and never reassigned; maxClients caps SLOTS (so a
// dropped player's seat still counts); a second connection with the same
// clientId takes the slot and the old socket is evicted with close code 4000
// (PartyConnection surfaces that as "replaced"). close_room mirrors the real
// relay's room teardown: the room is deleted and every member socket closed
// with 4001 (PartyConnection surfaces that as onClose {roomClosed}, terminal).

const { WebSocketServer } = require('ws');

const PORT = Number(process.env.RELAY_PORT || 4201);

// code -> { code, maxClients, slots: Map<clientId, index>, sockets: Map<index, ws>,
//           nextIndex, state? }  // state = retained host snapshot (set_state)
const rooms = new Map();

// Real-relay cap on the retained snapshot (Party-Sockets MAX_STATE_BYTES), kept
// here so an oversize snapshot fails in E2E the same way it would in prod.
const MAX_STATE_BYTES = 16 * 1024;

// Unambiguous A-Z/2-9 (no I/O/0/1), like the real relay's short codes.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += ALPHABET[(Math.random() * ALPHABET.length) | 0];
    if (!rooms.has(c)) return c;
  }
}

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT }, () => {
  console.log(`[relay-stub] listening on ws://127.0.0.1:${PORT}`);
});

wss.on('connection', (ws) => {
  let room = null;
  let index = null;

  const send = (sock, msg) => { if (sock && sock.readyState === 1) sock.send(JSON.stringify(msg)); };
  const others = () => {
    const out = [];
    if (room) for (const [i, s] of room.sockets) { if (i !== index && s.readyState === 1) out.push(s); }
    return out;
  };

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch (_) { return; }

    if (msg.type === 'create') {
      const code = newCode();
      room = {
        code,
        maxClients: msg.maxClients || 8,
        slots: new Map([[String(msg.clientId), 0]]),
        sockets: new Map([[0, ws]]),
        nextIndex: 1,
      };
      rooms.set(code, room);
      index = 0;
      send(ws, { type: 'created', room: code, index: 0 });

    } else if (msg.type === 'join') {
      const r = rooms.get(msg.room);
      if (!r) { send(ws, { type: 'error', message: 'Room not found' }); return; }
      const clientId = String(msg.clientId);
      let idx = r.slots.get(clientId);
      if (idx == null) {
        if (r.slots.size >= r.maxClients) { send(ws, { type: 'error', message: 'Room is full' }); return; }
        idx = r.nextIndex++;
        r.slots.set(clientId, idx);
      }
      const old = r.sockets.get(idx);
      room = r;
      index = idx;
      r.sockets.set(idx, ws); // take the slot BEFORE evicting, so old's close handler can't emit peer_left
      if (old && old !== ws && old.readyState === 1) old.close(4000, 'replaced');
      const peers = [];
      for (const [i, s] of r.sockets) { if (i !== idx && s.readyState === 1) peers.push(i); }
      send(ws, { type: 'joined', room: r.code, index: idx, peers });
      // Replay the retained host snapshot right after `joined`, same shape as a
      // live push, so a (re)joiner catches up with one handler (cf. real relay).
      if (r.state !== undefined) send(ws, { type: 'state', data: r.state });
      for (const s of others()) send(s, { type: 'peer_joined', index: idx });

    } else if (msg.type === 'send') {
      if (!room) return;
      const payload = { type: 'message', from: index, data: msg.data };
      if (msg.to != null) send(room.sockets.get(msg.to), payload);
      else for (const s of others()) send(s, payload);

    } else if (msg.type === 'set_state') {
      // Retained host snapshot: slot 0 only (the creator's slot, never
      // reassigned), JSON-serializable, capped like prod. Stored on the room,
      // pushed live to everyone but the sender; (re)joiners get it replayed.
      if (!room) return;
      if (index !== 0) { send(ws, { type: 'error', message: 'Only the host can set state' }); return; }
      if (msg.data === undefined) { send(ws, { type: 'error', message: 'State data is required' }); return; }
      if (Buffer.byteLength(JSON.stringify(msg.data)) > MAX_STATE_BYTES) {
        send(ws, { type: 'error', message: 'State too large' }); return;
      }
      room.state = msg.data;
      for (const s of others()) send(s, { type: 'state', data: msg.data });

    } else if (msg.type === 'close_room') {
      // Host-initiated teardown (real-relay parity): slot 0 only. Delete the
      // room, then close every member socket — sender included — with 4001.
      // No ack message: each member's own close frame is the notification.
      if (!room) { send(ws, { type: 'error', message: 'Not in a room' }); return; }
      if (index !== 0) { send(ws, { type: 'error', message: 'Only the host can close the room' }); return; }
      rooms.delete(room.code);
      for (const [i, s] of [...room.sockets]) {
        room.sockets.delete(i); // detach first so each close handler finds nothing to tear down
        if (s.readyState === 1) s.close(4001, 'room closed');
      }
    }
  });

  ws.on('close', () => {
    if (!room || index == null) return;
    if (room.sockets.get(index) !== ws) return; // already replaced by a newer socket
    room.sockets.delete(index);
    for (const [, s] of room.sockets) send(s, { type: 'peer_left', index });
    // Reap fully-empty rooms so a long test run doesn't accumulate them. (The
    // real relay holds rooms a while for reconnects; tests that reload a page
    // always keep at least one other socket in the room, so this stays safe.)
    if (room.sockets.size === 0) rooms.delete(room.code);
  });
});
