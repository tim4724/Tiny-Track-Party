'use strict';

/**
 * PartyConnection — WebSocket wrapper for Party-Server relay protocol.
 *
 * Public peers are addressed by numeric slot index (0, 1, 2, …). The room
 * creator is always index 0. Indices are stable for the room's lifetime and
 * never reassigned. clientId is supplied on create/join as a per-slot bearer
 * secret — the relay matches it to the slot for reconnect — and never crosses
 * the wire in any other direction. Callers must keep clientId private (don't
 * embed it in app messages, URLs, or logs).
 *
 * The relay requires a clientId, so one is auto-generated when the caller omits
 * it. An auto-generated id is stable for the lifetime of this instance (so
 * in-session reconnects land on the same slot) but NOT across page reloads — a
 * game that wants reconnect to survive a reload should persist a clientId
 * (e.g. in localStorage) and pass it in.
 *
 * Party-Server protocol:
 *   Client → PS:  create { clientId, maxClients, url? }
 *   Client → PS:  join   { clientId, room }
 *   Client → PS:  send   { data, to? }            // to is a peer index (number)
 *   PS → Client:  created      { room, index: 0, instance?, region?, url? }
 *   PS → Client:  joined       { room, index, peers: number[], url? }
 *   PS → Client:  peer_joined  { index }
 *   PS → Client:  peer_left    { index }
 *   PS → Client:  message      { from, data }     // from is a peer index (number)
 *   PS → Client:  error        { message }
 */
class PartyConnection {
  constructor(relayUrl, options) {
    this.relayUrl = relayUrl;
    // The relay requires a clientId; generate a session-stable one if omitted.
    this.clientId = (options && options.clientId) || PartyConnection._genClientId();
    this.ws = null;
    this._reconnectTimer = null;
    this._shouldReconnect = true;
    this.maxReconnectAttempts = (options && options.maxReconnectAttempts) || 5;
    this.reconnectAttempt = 0;

    // Callbacks
    this.onOpen = null;        // () => void
    this.onClose = null;       // (attempt: number, maxAttempts: number, meta?: {replaced?: boolean, roomClosed?: boolean}) => void
    this.onError = null;       // () => void
    this.onMessage = null;     // (from: number, data: object) => void
    this.onProtocol = null;    // (type: string, msg: object) => void
    this.onState = null;       // (data: any) => void, retained host snapshot
  }

  // Random, opaque clientId. crypto.randomUUID where available (browsers,
  // Node 16+); a Math.random/time fallback otherwise. Not security-grade, just
  // unique enough to key a relay slot.
  static _genClientId() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return 'pc-' + crypto.randomUUID();
      }
    } catch (e) { /* fall through */ }
    return 'pc-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
  }

  connect() {
    this._discardOldWs();

    this._shouldReconnect = true;
    var ws = new WebSocket(this.relayUrl);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return; // stale
      if (this.onOpen) this.onOpen();
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return; // stale
      var msg;
      try { msg = JSON.parse(event.data); } catch (_) { return; }

      if (msg.type === 'message') {
        if (this.onMessage) this.onMessage(msg.from, msg.data);
      } else if (msg.type === 'state') {
        // Retained host snapshot, replayed right after `joined` on (re)join
        // and pushed live on each host update. Routed to onState (not
        // onProtocol) so a host that never sets onState (e.g. the display,
        // which authors state but doesn't consume it) silently ignores its
        // own replayed copy.
        if (this.onState) this.onState(msg.data);
      } else {
        if (this.onProtocol) this.onProtocol(msg.type, msg);
      }
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return; // stale — already replaced by reconnectNow
      if (event && event.code === 4000) {
        // Relay evicted us because another client joined with the same clientId
        this._shouldReconnect = false;
        if (this.onClose) this.onClose(0, 0, { replaced: true });
        return;
      }
      if (event && event.code === 4001) {
        // The room itself is gone (host sent close_room, or the relay's
        // hostless grace expired). Terminal: a reconnect would only bounce
        // off "Room not found".
        this._shouldReconnect = false;
        if (this.onClose) this.onClose(0, 0, { roomClosed: true });
        return;
      }
      this.reconnectAttempt++;
      if (this.onClose) this.onClose(this.reconnectAttempt, this.maxReconnectAttempts);
      if (this._shouldReconnect && this.reconnectAttempt <= this.maxReconnectAttempts) {
        this._scheduleReconnect();
      }
    };

    ws.onerror = () => {
      if (this.ws !== ws) return; // stale
      if (this.onError) this.onError();
    };
  }

  _discardOldWs() {
    if (this.ws) {
      var old = this.ws;
      this.ws = null;
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      try { old.close(); } catch (_) {}
    }
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    // Gentle backoff: 1s, 1.5s, 2.25s, 3.375s, capped at 5s
    var delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempt - 1), 5000);
    this._reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // Create a room. `url` is an optional controller-URL template the relay
  // retains on the room and hands (with {room}/{instance} filled in) to anyone
  // who holds only the room code — in `created`/`joined` replies and via
  // GET /room/:code — so a code-only client can resolve which page to load.
  // The relay only accepts absolute https templates and rejects the whole
  // create on an invalid one, so callers must omit it rather than send a
  // non-https URL (e.g. a plain-http dev origin).
  create(maxClients, url) {
    var msg = { type: 'create', clientId: this.clientId, maxClients: maxClients };
    if (url) msg.url = url;
    this._send(msg);
  }

  join(room) {
    this._send({ type: 'join', clientId: this.clientId, room: room });
  }

  // Pin auto-reconnect to a specific relay shard. After the relay assigns an
  // instance (in the `created` reply), call this so reconnects rebuild the
  // sharded URL and land back on the same instance, instead of the bare
  // endpoint routing to whichever shard is least-loaded. The game supplies its
  // base relay URL; the kit owns the URL shape so games don't hand-build it.
  pinInstance(baseUrl, room, instance) {
    if (!instance) return;
    this.relayUrl = baseUrl + '/' + encodeURIComponent(room) + '?instance=' + encodeURIComponent(instance);
  }

  sendTo(to, data) {
    this._send({ type: 'send', data: data, to: to });
  }

  broadcast(data) {
    this._send({ type: 'send', data: data });
  }

  // Publish a retained state snapshot (host/slot-0 only; the relay rejects it
  // from anyone else). The relay keeps the latest blob on the room, pushes it
  // live to current peers (sender excluded), and replays it to any client right
  // after `joined` on (re)join. Costs exactly one broadcast; there is no silent
  // retain. `data` must be JSON-serializable and <= 16 KiB serialized.
  setState(data) {
    this._send({ type: 'set_state', data: data });
  }

  // Tear the room down for everyone (host/slot-0 only; the relay rejects it
  // from anyone else). The relay deletes the room, GET /room/:code turns 404
  // (killing stale rejoin links), and every member socket is closed with 4001,
  // which surfaces to them as onClose(0, 0, {roomClosed: true}). There is no
  // ack message: the sender's own 4001 close is the confirmation, unless the
  // caller close()s first (fine on pagehide, where the page is going away).
  closeRoom() {
    this._send({ type: 'close_room' });
  }

  reconnectNow() {
    clearTimeout(this._reconnectTimer);
    this.connect();
  }

  // Treat the current socket as a failed attempt and drive the normal
  // backoff/give-up path — for callers that detect failure themselves (e.g. a
  // socket that opened but the relay never answered create/join, which never
  // triggers onclose). Mirrors an unexpected onclose: discards the dead socket,
  // bumps the attempt counter, notifies onClose, and either schedules a backoff
  // reconnect or gives up once maxReconnectAttempts is passed.
  failAttempt() {
    if (!this._shouldReconnect) return;
    this._discardOldWs();
    this.reconnectAttempt++;
    if (this.onClose) this.onClose(this.reconnectAttempt, this.maxReconnectAttempts);
    if (this.reconnectAttempt <= this.maxReconnectAttempts) {
      this._scheduleReconnect();
    }
  }

  resetReconnectCount() {
    this.reconnectAttempt = 0;
  }

  close() {
    this._shouldReconnect = false;
    clearTimeout(this._reconnectTimer);
    this._discardOldWs();
  }

  get connected() {
    return this.ws && this.ws.readyState === 1;
  }
}

// Export for both Node.js and browser
if (typeof window !== 'undefined') {
  window.PartyConnection = PartyConnection;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PartyConnection;
}
