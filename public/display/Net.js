// DisplayNet — owns the relay connection, RoomFlow roster/host machine, and the
// controller<->display message protocol. The display is slot 0 and authoritative.
// Game logic/rendering live elsewhere; this module is transport + lobby only.
//
// Reads partyplug + protocol globals set by the classic <script> tags that load
// before this module (PartyConnection, RoomFlow, MSG, RELAY_URL, MAX_PLAYERS).
// Room state is owned by the RoomFlow machine (see the `roomState` getter).

const { PartyConnection, RoomFlow, PartyFastlane, MSG, RELAY_URL, STUN_URL, MAX_PLAYERS } = window;

const enc = encodeURIComponent;

export class DisplayNet {
  constructor(opts = {}) {
    this.onRoomReady = opts.onRoomReady || (() => {});
    this.onRosterChange = opts.onRosterChange || (() => {});
    this.onControllerMessage = opts.onControllerMessage || (() => {});

    this.flow = new RoomFlow();
    this.party = null;
    this.roomCode = null;
    this.instance = null;
    this.baseUrlOverride = null;

    this.fastlane = new PartyFastlane({
      selfIndex: 0,
      iceServers: [{ urls: STUN_URL }, { urls: 'stun:stun.l.google.com:19302' }],
      sendSignal: (peerIdx, sig) => { if (this.party) this.party.sendTo(peerIdx, sig); },
      onInput: (peerIdx, ev) => this.onControllerMessage(peerIdx, ev),
    });

    // Re-broadcast roster to controllers + notify our own UI whenever it shifts.
    const announce = () => { this._broadcastLobby(); this.onRosterChange(this.roster(), this.flow.host); };
    this.flow.on('rosterchange', announce);
    this.flow.on('hostchange', announce);
  }

  async start() {
    await this._fetchBaseUrl();
    this._connect();
  }

  // ---- roster helpers ----
  roster() {
    return this.flow.list().map((p) => ({
      peerIndex: p.peerIndex, name: p.name, colorIndex: p.colorIndex, connected: p.connected
    }));
  }
  _usedColors() {
    const s = new Set();
    for (const p of this.flow.list()) s.add(p.colorIndex);
    return s;
  }

  // ---- connection ----
  _connect() {
    this.fastlane.closeAll();
    const url = (this.roomCode && this.instance)
      ? RELAY_URL + '/' + enc(this.roomCode) + '?instance=' + enc(this.instance)
      : RELAY_URL;
    // 'display' is a stable per-slot bearer secret → reconnect lands on slot 0.
    this.party = new PartyConnection(url, { clientId: 'display' });

    this.party.onOpen = () => {
      if (this.roomCode) this.party.join(this.roomCode);
      else this.party.create(MAX_PLAYERS + 1); // +1 for the display itself
    };
    this.party.onProtocol = (type, msg) => this._onProtocol(type, msg);
    this.party.onMessage = (from, data) => this._onMessage(from, data);
    this.party.connect();
  }

  _onProtocol(type, msg) {
    switch (type) {
      case 'created':
        this.roomCode = msg.room;
        this.instance = msg.instance || null;
        if (this.instance) this.party.pinInstance(RELAY_URL, this.roomCode, this.instance);
        this.onRoomReady({ roomCode: this.roomCode, joinUrl: this._joinUrl() });
        break;
      case 'joined': // display reconnected to an existing room
        this.roomCode = msg.room;
        this._resyncPeers(msg.peers || []);
        this.party.resetReconnectCount();
        this.onRoomReady({ roomCode: this.roomCode, joinUrl: this._joinUrl() });
        break;
      case 'peer_joined':
        this._addPeer(msg.index);
        break;
      case 'peer_left':
        this._removePeer(msg.index);
        break;
      case 'error':
        console.warn('[relay]', msg.message);
        break;
    }
  }

  _onMessage(from, data) {
    if (!data || from === 0) return;
    if (this.fastlane.handleSignal(from, data)) return;
    switch (data.type) {
      case MSG.HELLO: {
        const p = this.flow.get(from);
        if (p && data.name) p.name = String(data.name).slice(0, 16);
        this.party.sendTo(from, this._welcomeFor(from));
        this._broadcastLobby();
        this.onRosterChange(this.roster(), this.flow.host);
        break;
      }
      case MSG.PING:
        this.party.sendTo(from, { type: MSG.PONG, t: data.t });
        break;
      default:
        // START_GAME / control / etc. — hand to the game layer.
        this.onControllerMessage(from, data);
    }
  }

  _addPeer(peerIndex) {
    if (this.flow.has(peerIndex) || this.flow.size >= MAX_PLAYERS) return;
    const colorIndex = RoomFlow.lowestFreeSlot(this._usedColors(), MAX_PLAYERS);
    this.flow.addPlayer(peerIndex, { name: 'Player ' + (colorIndex + 1), colorIndex });
    // rosterchange fires from addPlayer → announce() handles broadcast + UI.
  }

  _removePeer(peerIndex) {
    if (!this.flow.has(peerIndex)) return;
    this.fastlane.close(peerIndex);
    this.flow.removePlayer(peerIndex); // emits rosterchange → announce()
  }

  _resyncPeers(peers) {
    const present = new Set(peers);
    for (const p of this.flow.list()) {
      if (!present.has(p.peerIndex)) this.flow.removePlayer(p.peerIndex);
    }
    // Re-welcome everyone so their controllers clear any reconnect overlay.
    for (const p of this.flow.list()) this.party.sendTo(p.peerIndex, this._welcomeFor(p.peerIndex));
  }

  // ---- outbound protocol ----
  _welcomeFor(peerIndex) {
    return {
      type: MSG.WELCOME,
      peerIndex,
      colorIndex: (this.flow.get(peerIndex) || {}).colorIndex,
      hostPeerIndex: this.flow.host,
      roomState: this.roomState,
      players: this.roster()
    };
  }
  _broadcastLobby() {
    const payload = {
      type: MSG.LOBBY_UPDATE,
      hostPeerIndex: this.flow.host,
      roomState: this.roomState,
      players: this.roster()
    };
    for (const p of this.flow.list()) this.party.sendTo(p.peerIndex, payload);
  }

  broadcast(data) { if (this.party) this.party.broadcast(data); }
  sendTo(id, data) { if (this.party) this.party.sendTo(id, data); }
  // Room state is owned by RoomFlow — read it straight through so the display
  // never keeps a second copy that can drift out of sync with the machine.
  get roomState() { return this.flow.state; }

  // ---- join URL / QR base ----
  _joinUrl() {
    const base = this.baseUrlOverride || window.location.origin;
    return base + '/' + this.roomCode + (this.instance ? '#' + enc(this.instance) : '');
  }
  async _fetchBaseUrl() {
    const host = window.location.hostname;
    if (host !== 'localhost' && host !== '127.0.0.1') return;
    try {
      const r = await fetch('/api/baseurl');
      const d = await r.json();
      if (d.baseUrl) this.baseUrlOverride = d.baseUrl;
    } catch (_) { /* fall back to origin */ }
  }
}

// Render a join URL into `el`, wrapping the trailing room code in a
// <span class="join__code"> so it can be tinted a fun colour. The code is the
// last path segment (e.g. the BZK4 in tinytrack.party/BZK4). Built with DOM
// nodes (not innerHTML) so the code is always treated as text.
export function renderJoinUrl(el, fullText, code) {
  el.textContent = '';
  if (code && fullText.endsWith(code)) {
    el.append(fullText.slice(0, fullText.length - code.length));
    const span = document.createElement('span');
    span.className = 'join__code';
    span.textContent = code;
    el.appendChild(span);
  } else {
    el.textContent = fullText;
  }
}

// QR matrix fetch + canvas render (server returns a module bitmap).
export async function fetchQR(text) {
  const r = await fetch('/api/qr?text=' + enc(text));
  return r.json();
}
export function renderQR(canvas, qr, px = 480) {
  if (!qr || !qr.size) return;
  const n = qr.size, cell = Math.floor(px / n), size = cell * n;
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#0b0f17';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (qr.modules[r * n + c]) ctx.fillRect(c * cell, r * cell, cell, cell);
  }
}
