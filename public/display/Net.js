// DisplayNet — owns the relay connection, RoomFlow roster/host machine, and the
// controller<->display message protocol. The display is slot 0 and authoritative.
// Game logic/rendering live elsewhere; this module is transport + lobby only.
//
// Reads partyplug + protocol globals set by the classic <script> tags that load
// before this module (PartyConnection, RoomFlow, MSG, RELAY_URL, MAX_PLAYERS).
// Room state is owned by the RoomFlow machine (see the `roomState` getter).
import { GameNet } from '../shared/GameNet.js';

const { PartyConnection, RoomFlow, MSG, ROOM_STATE, RELAY_URL, MAX_PLAYERS, CAR_MODELS, CAR_COLORS } = window;

const enc = encodeURIComponent;

// How long a mid-game disconnect's seat is held open (showing its reconnect QR)
// before we give up and free the slot. Long enough to cover PartyConnection's
// own ~15 s auto-reconnect run plus a deliberate rescan, short enough that a
// player who's truly gone stops blocking the 4-seat room.
const RECONNECT_GRACE_MS = 90000;

export class DisplayNet extends GameNet {
  constructor(opts = {}) {
    super();
    this.onRoomReady = opts.onRoomReady || (() => {});
    this.onRosterChange = opts.onRosterChange || (() => {});
    this.onControllerMessage = opts.onControllerMessage || (() => {});
    this.onTrackChange = opts.onTrackChange || (() => {});
    // Fired whenever the set of dropped seats awaiting a reconnect changes; the
    // display renders a QR card per seat. Each entry: {peerIndex, name, colorIndex, url}.
    this.onReconnectChange = opts.onReconnectChange || (() => {});
    // Fired when a dropped player reconnects on a DIFFERENT device (new peerIndex):
    // (oldId, newId) so the game layer can re-key their still-racing car onto the
    // new slot. A same-device reconnect keeps its id and never needs this.
    this.onPlayerRekey = opts.onPlayerRekey || (() => {});

    // Dropped seats currently offering a reconnect QR, plus their grace timers.
    // peerIndex -> {peerIndex, name, colorIndex, url}; peerIndex -> timeout id.
    this._reconnectSeats = new Map();
    this._reconnectTimers = new Map();

    // Track selector state. `tracks` is the catalog the display computed (id +
    // name + feature chips + schematic SVG), sent to phones in WELCOME so their
    // picker can render without any game geometry. `trackId` is the current pick;
    // only the host may change it (in the lobby), via SELECT_TRACK.
    this.tracks = opts.trackCatalog || [];
    // null until a track is picked — the lobby shows the plain diorama and the
    // host's "Start race" button stays disabled until then.
    this.trackId = opts.defaultTrackId != null ? opts.defaultTrackId : null;

    this.flow = new RoomFlow();
    this.roomCode = null;
    this.instance = null;
    this.baseUrlOverride = null;

    this._initFastlane(0, { onInput: (peerIdx, ev) => this.onControllerMessage(peerIdx, ev) });

    // Re-broadcast roster to controllers + notify our own UI whenever it shifts.
    this.flow.on('rosterchange', () => this._announce());
    this.flow.on('hostchange', () => this._announce());
    // Ready flags are lobby-only: wipe them whenever the room lands back in the
    // lobby, so the next race needs a fresh round of "I'm ready" taps (stale
    // flags would leave the host's "Start race" pre-armed for the new race).
    this.flow.on('statechange', ({ to }) => { if (to === ROOM_STATE.LOBBY) this._clearReady(); });
  }

  async start() {
    await this._fetchBaseUrl();
    this._connect();
  }

  // ---- roster helpers ----
  // Echo roster state everywhere it's consumed: every phone (LOBBY_UPDATE) and
  // the display's own UI. Called on any roster/host/ready/car change.
  _announce() {
    this._broadcastLobby();
    this.onRosterChange(this.roster(), this.flow.host);
  }
  roster() {
    return this.flow.list().map((p) => ({
      peerIndex: p.peerIndex, name: p.name,
      colorIndex: p.colorIndex, carIndex: p.carIndex, connected: p.connected,
      ready: !!p.ready
    }));
  }
  // Drop every player's ready flag (entering the lobby). Announce only if
  // something actually changed, so the first lobby entry stays quiet.
  _clearReady() {
    let changed = false;
    for (const p of this.flow.list()) { if (p.ready) { p.ready = false; changed = true; } }
    if (changed) this._announce();
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
    if (this._isSignal(from, data)) return;
    switch (data.type) {
      case MSG.HELLO: {
        // A cross-device rejoin claims its dropped seat first, so the welcome we
        // build below reflects the restored identity (livery/car/host) — not the
        // throwaway placeholder slot the relay just handed this fresh connection.
        this._claimReconnect(from, data);
        const p = this.flow.get(from);
        if (p && data.name) p.name = String(data.name).slice(0, 16);
        this.party.sendTo(from, this._welcomeFor(from));
        this._announce();
        break;
      }
      case MSG.LEAVE:
        // Intentional back-out: free the seat outright (no reconnect QR).
        this._expireSeat(from);
        break;
      case MSG.SET_CAR: {
        // Lobby car-model pick. Car and colour are independent and duplicates
        // are allowed, so no uniqueness check — just validate and store, then
        // broadcast so this phone's picker confirms and the display renders the
        // chosen model at race start. Lobby only.
        const p = this.flow.get(from);
        const idx = data.carIndex;
        if (p && this.roomState === 'lobby'
          && Number.isInteger(idx) && idx >= 0 && idx < CAR_MODELS.length) {
          p.carIndex = idx;
          this._announce();
        }
        break;
      }
      case MSG.SET_READY: {
        // Lobby readiness toggle (non-hosts — the host starts the race instead
        // of readying up). Stored on the player record and echoed to every
        // phone via LOBBY_UPDATE; the game layer requires every non-host
        // player ready before honouring the host's START_GAME.
        const p = this.flow.get(from);
        const ready = !!data.ready;
        if (p && from !== this.flow.host && this.roomState === 'lobby' && ready !== !!p.ready) {
          p.ready = ready;
          this._announce();
        }
        break;
      }
      case MSG.SELECT_TRACK: {
        // Host-only lobby choice of the race track. Validate the id against the
        // catalog, store it, echo to every phone (LOBBY_UPDATE.trackId), and tell
        // the display so it can swap the 3D preview.
        const idOk = this.tracks.some((t) => t.id === data.trackId);
        if (from === this.flow.host && this.roomState === 'lobby' && idOk && data.trackId !== this.trackId) {
          this.trackId = data.trackId;
          this._broadcastLobby();
          this.onTrackChange(this.trackId);
        }
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
    const existing = this.flow.get(peerIndex);
    if (existing) {
      // Same-device reconnect: the relay keys slots by clientId, so a returning
      // phone lands back on its old index. Flip presence back on and drop its
      // reconnect QR. (A cross-device rejoin gets a NEW index instead and is
      // re-keyed onto the dropped seat in _claimReconnect via HELLO.)
      if (this.flow.isDisconnected(peerIndex)) {
        this.flow.markReconnected(peerIndex);
        this._clearReconnect(peerIndex);
      }
      return;
    }
    if (this.flow.size >= MAX_PLAYERS) return;
    const colorIndex = RoomFlow.lowestFreeSlot(this._usedColors(), MAX_PLAYERS);
    // Default the car model to the livery slot so everyone starts on a distinct
    // car; the player can change it in the lobby (SET_CAR), colour stays fixed.
    this.flow.addPlayer(peerIndex, { name: 'Player ' + (colorIndex + 1), colorIndex, carIndex: colorIndex, ready: false });
    // rosterchange fires from addPlayer → announce() handles broadcast + UI.
  }

  _removePeer(peerIndex) {
    if (!this.flow.has(peerIndex)) return;
    this.fastlane.close(peerIndex);
    // In the lobby a drop is forgiving — just free the seat (the lobby's own join
    // QR covers coming back). Mid-game (countdown/race/results) keep the seat AND
    // the player's car running — so the camera stays on it and a quick reconnect
    // resumes driving — and offer a reconnect QR for that exact seat. The car is
    // only forfeited if the seat's grace window elapses (playerleave → forfeitCar).
    if (this.roomState === ROOM_STATE.LOBBY) {
      this.flow.removePlayer(peerIndex); // emits rosterchange → announce()
    } else {
      this.flow.markDisconnected(peerIndex);
      this._showReconnect(peerIndex);
    }
  }

  // Free a seat for good: clear its reconnect QR/timer and drop the player. Used
  // for an intentional LEAVE and when the reconnect grace window elapses.
  _expireSeat(peerIndex) {
    this._clearReconnect(peerIndex);
    if (!this.flow.has(peerIndex)) return;
    this.fastlane.close(peerIndex);
    this.flow.removePlayer(peerIndex);
  }

  _resyncPeers(peers) {
    const present = new Set(peers);
    for (const p of this.flow.list()) {
      if (!present.has(p.peerIndex)) this._expireSeat(p.peerIndex);
    }
    // Re-welcome everyone so their controllers clear any reconnect overlay.
    for (const p of this.flow.list()) this.party.sendTo(p.peerIndex, this._welcomeFor(p.peerIndex));
  }

  // ---- reconnect (dropped-seat) handling ----
  // A different device claims a dropped seat by carrying its old peerIndex as the
  // HELLO rejoinToken (from the QR's ?claim=). Re-key the kept seat record from
  // the old index onto this fresh connection so the returning player resumes
  // their livery/car/name/host slot. A same-device reconnect keeps its index and
  // never reaches here (oldId === fromId, handled in _addPeer instead).
  _claimReconnect(fromId, msg) {
    const oldId = this._normIndex(msg && msg.rejoinToken);
    if (oldId == null || oldId === fromId) return false;
    if (!this.flow.has(oldId) || !this.flow.isDisconnected(oldId)) return false;
    this.fastlane.close(oldId);
    this.fastlane.close(fromId);
    this.flow.rekey(oldId, fromId); // moves the seat record, marks it reconnected
    this.onPlayerRekey(oldId, fromId); // move their still-racing car onto the new slot
    this._clearReconnect(oldId);
    this._clearReconnect(fromId);
    return true;
  }

  _showReconnect(peerIndex) {
    const p = this.flow.get(peerIndex);
    if (!p) return;
    this._reconnectSeats.set(peerIndex, {
      peerIndex, name: p.name, colorIndex: p.colorIndex, url: this._claimUrl(peerIndex)
    });
    clearTimeout(this._reconnectTimers.get(peerIndex));
    this._reconnectTimers.set(peerIndex, setTimeout(() => this._expireSeat(peerIndex), RECONNECT_GRACE_MS));
    this.onReconnectChange([...this._reconnectSeats.values()]);
  }

  _clearReconnect(peerIndex) {
    if (this._reconnectTimers.has(peerIndex)) {
      clearTimeout(this._reconnectTimers.get(peerIndex));
      this._reconnectTimers.delete(peerIndex);
    }
    if (this._reconnectSeats.delete(peerIndex)) this.onReconnectChange([...this._reconnectSeats.values()]);
  }

  // Join URL with ?claim=<peerIndex> spliced in BEFORE the #instance fragment so
  // the relay-shard pin survives (cf. _joinUrl). Scanning this lands a fresh
  // device on the room with the token that reclaims this exact seat.
  _claimUrl(peerIndex) {
    const u = this._joinUrl();
    const h = u.indexOf('#');
    const base = h >= 0 ? u.slice(0, h) : u;
    const frag = h >= 0 ? u.slice(h) : '';
    const sep = base.indexOf('?') >= 0 ? '&' : '?';
    return base + sep + 'claim=' + enc(peerIndex) + frag;
  }

  _normIndex(value) {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }

  // ---- outbound protocol ----
  _welcomeFor(peerIndex) {
    const p = this.flow.get(peerIndex) || {};
    return {
      type: MSG.WELCOME,
      peerIndex,
      colorIndex: p.colorIndex,
      carIndex: p.carIndex,
      hostPeerIndex: this.flow.host,
      roomState: this.roomState,
      players: this.roster(),
      tracks: this.tracks,       // full catalog (static) — sent once, on join
      trackId: this.trackId      // current selection
    };
  }
  _broadcastLobby() {
    const payload = {
      type: MSG.LOBBY_UPDATE,
      hostPeerIndex: this.flow.host,
      roomState: this.roomState,
      players: this.roster(),
      trackId: this.trackId      // catalog is static (WELCOME) — echo just the pick
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
// `bg` is the quiet-zone fill (default white). Pass a falsy bg for a transparent
// background — black modules sit straight on whatever's behind the canvas.
export function renderQR(canvas, qr, px = 480, bg = '#ffffff') {
  if (!qr || !qr.size) return;
  const n = qr.size, cell = Math.floor(px / n), size = cell * n;
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, size, size); }
  else ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#0b0f17';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (qr.modules[r * n + c]) ctx.fillRect(c * cell, r * cell, cell, cell);
  }
}

// Build a dropped-player reconnect card — name + "scan to rejoin" + the rejoin QR
// — to be centred in that player's split-screen cell by the renderer (see
// SceneRenderer.setCarReconnect / _loop). Reuses the .cell-finish chrome (frosted
// card, livery top-border, centred placement) so it matches the FINISHED card.
// `seat` is {name, colorIndex, url}. Shared by the live display (main.js) and the
// gallery harness so the markup stays in one place. QR matrices are cached by url.
const _rcQrCache = new Map();
export function buildReconnectCard(seat) {
  const card = document.createElement('div');
  card.className = 'cell-finish cell-reconnect'; // .cell-finish = positioning + card chrome
  card.style.setProperty('--c', (CAR_COLORS && CAR_COLORS[seat.colorIndex]) || '#888');

  const head = document.createElement('div');
  head.className = 'rc-card__head';
  const nm = document.createElement('span'); nm.className = 'rc-card__name'; nm.textContent = seat.name;
  head.append(nm);

  const sub = document.createElement('div');
  sub.className = 'rc-card__sub'; sub.textContent = 'Disconnected';

  const qr = document.createElement('canvas');
  qr.className = 'rc-card__qr';

  card.append(head, sub, qr);

  // Transparent QR background → black modules sit straight on the frosted card.
  const cached = _rcQrCache.get(seat.url);
  if (cached) renderQR(qr, cached, 220, null);
  else fetchQR(seat.url)
    .then((m) => { _rcQrCache.set(seat.url, m); renderQR(qr, m, 220, null); })
    .catch((e) => console.warn('reconnect QR failed', e));

  return card;
}
