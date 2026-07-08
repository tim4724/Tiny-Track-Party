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

// Controller liveness. The relay only reports a drop when a socket actually
// CLOSES — a locked phone or dead Wi-Fi leaves it dangling for minutes. Phones
// ping at 1 Hz (controller/Net.js), so a seat silent past this window is treated
// as dropped through the same path as a real peer_left. Detection lives in
// RoomFlow (opts.liveness + onSeen/expiredPeers, nowMs-injected); this module
// just stamps traffic and applies expiries. Lobby seats are exempt (expiredPeers
// is empty there): peer_left stays the authority, so a brief blip can't kick a
// lobby seat.
const LIVENESS_TIMEOUT_MS = 3000;
// Display self-heartbeat: each liveness tick relays a message to our own slot.
// An echo overdue past this window means OUR socket is half-dead (the relay
// can't reach us), so force a reconnect instead of waiting for TCP to notice.
// Wider than the controller window: with the fastlane carrying inputs the WS
// sees only ~1 Hz traffic, so this lone canary needs more margin.
const HEARTBEAT_DEAD_MS = 6000;
const LIVENESS_TICK_MS = 1000;

// How long an open socket may sit without a created/joined answer before the
// attempt is written off (party.failAttempt → normal backoff/retry). Guards the
// silent failure mode where the relay accepts the socket but never answers the
// create/join — which fires no error and no close.
const CREATE_TIMEOUT_MS = 8000;

// sessionStorage key for the live room — a crash-recovery fallback. A page
// exit normally ends the party (pagehide → shutdown → close_room), so on a
// clean reload this saved room is already dead and the join bounces into the
// fresh-room fallback. But pagehide's send is best-effort (bfcache freeze,
// killed tab, crash): when it never flushed, the room is still alive on the
// relay and the reloaded display rejoins it, regathering the party (the phones
// just see a short "waiting for the big screen" blip).
// sessionStorage is per-tab on purpose: a second display tab gets its own room.
// The blob also carries the display's clientId secret (see genDisplayClientId).
const ROOM_KEY = 'tinytrack_display_room';

// The display's clientId doubles as the bearer secret for slot 0: the relay keys
// the authoritative seat by it, and a socket that presents it EVICTS the incumbent
// (close 4000). A constant like 'display' would be no secret at all — the room code
// is on-screen and this source is public, so anyone could claim slot 0 and hijack
// the big screen out from under the host. So mint a per-session random secret and
// persist it with the room (_saveRoom), so a display RELOAD still reclaims slot 0
// while an outsider holding only the room code can't forge it. Prefer the CSPRNG;
// the Math.random tail is a last resort for exotic non-secure contexts (real
// deploys are https/localhost, where crypto.randomUUID is always present).
function genDisplayClientId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return 'display-' + crypto.randomUUID();
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const a = new Uint8Array(16); crypto.getRandomValues(a);
      return 'display-' + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch (_) { /* fall through to the non-crypto path */ }
  return 'display-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

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
    // Asked per WELCOME: does this seat have a car in the live race? Lets a
    // mid-race WELCOME distinguish a rejoin (drop back into the race) from a
    // brand-new late joiner (wait in the lobby for the next race). The game
    // layer answers from its session; default "yes" preserves the rejoin path.
    this.inRace = opts.inRace || (() => true);
    // Asked per WELCOME: is the race manually paused? A rejoiner must re-raise
    // the pause overlay it missed while away, or its wheel just feels dead.
    this.isPaused = opts.isPaused || (() => false);
    // Fired after a WELCOME is sent, so the game layer can follow up with any
    // catch-up state that normally only flows as broadcasts (e.g. the live
    // standings board for a rejoiner whose car already finished).
    this.onPlayerWelcomed = opts.onPlayerWelcomed || (() => {});

    // Dropped seats currently offering a reconnect QR, plus their grace timers.
    // peerIndex -> {peerIndex, name, colorIndex, url}; peerIndex -> timeout id.
    this._reconnectSeats = new Map();
    this._reconnectTimers = new Map();

    // Liveness tick + self-heartbeat in-flight state (see _livenessTick).
    // Per-peer last-seen stamps live in RoomFlow (fed via _seen → flow.onSeen).
    this._livenessTimer = null;
    this._hbPending = false;
    this._hbSentAt = 0;

    // Track selector state. `tracks` is the catalog the display computed (id +
    // name + feature chips + schematic SVG), sent to phones in WELCOME so their
    // picker can render without any game geometry. Only the host may change the
    // pick (in the lobby), via SELECT_MODE (or the legacy SELECT_TRACK).
    this.tracks = opts.trackCatalog || [];
    // null until a track is picked — the lobby shows the plain diorama and the
    // host's "Start race" button stays disabled until then. `trackId` is always
    // the RESOLVED concrete track (exact pick / a cup's current race / the
    // random draw): the 3D preview, startRace and the phones all key on it.
    this.trackId = opts.defaultTrackId != null ? opts.defaultTrackId : null;
    // What the trackId MEANS: 'track' = single race on exactly it, 'cup' = it's
    // the current race of cupId's 4-race Grand Prix, 'random' = it was drawn by
    // drawRandomTrack (game-supplied shuffle bag; re-picking random re-rolls).
    this.mode = this.trackId != null ? 'track' : null;
    this.cupId = null;
    this.drawRandomTrack = opts.drawRandomTrack || null;

    this.flow = new RoomFlow({ liveness: { timeoutMs: LIVENESS_TIMEOUT_MS } });
    this.roomCode = null;
    this.instance = null;
    this.clientId = null;   // slot-0 bearer secret; restored-or-minted in _restoreRoom
    this.baseUrlOverride = null;
    this._inRoom = false; // true between a created/joined ack and the socket dropping
    this._createTimer = null; // created/joined-answer watchdog (see _connect's onOpen)

    // Fastlane input counts as proof of life: a phone whose relay socket died
    // can still be driving over the open P2P channel — its car must not grow a
    // reconnect QR mid-corner.
    this._initFastlane(0, { onInput: (peerIdx, ev) => { this._seen(peerIdx); this.onControllerMessage(peerIdx, ev); } });

    // Re-broadcast roster to controllers + notify our own UI whenever it shifts.
    this.flow.on('rosterchange', () => this._announce());
    this.flow.on('hostchange', () => this._announce());
    // Ready flags are lobby-only: wipe them whenever the room lands back in the
    // lobby, so the next race needs a fresh round of "I'm ready" taps (stale
    // flags would leave the host's "Start race" pre-armed for the new race).
    // Then republish the snapshot: the retained copy carries roomState, and a
    // replay to a (re)joining phone must never hand it a stale phase. When
    // _clearReady already announced (flags were wiped), that publish carried
    // the new state — skip the duplicate.
    this.flow.on('statechange', ({ to }) => {
      // Race start: re-stamp every CONNECTED seat's liveness so silence accumulated in
      // the lobby (where expiredPeers is gated off) isn't charged against the first
      // COUNTDOWN tick — a phone whose 1 Hz ping was throttled >3s before the host hit
      // Start would otherwise be dropped one tick in. The 3s window must run from race
      // start. Deliberately NOT flow.clearDisconnected(now): flipping a grace-pending
      // seat back to connected here would orphan its reconnect QR and 90s expiry timer
      // (only _seen/markReconnected/_claimReconnect may flip presence). Disconnected
      // seats keep their stale stamp; expiredPeers already skips them.
      if (to === ROOM_STATE.COUNTDOWN) {
        const now = Date.now();
        for (const p of this.flow.list()) if (p.connected) this.flow.onSeen(p.peerIndex, now);
      }
      const announced = to === ROOM_STATE.LOBBY && this._clearReady();
      if (!announced) this._publishLobby();
    });
  }

  async start() {
    await this._fetchBaseUrl();
    this._restoreRoom();
    this._connect();
  }

  // ---- room persistence (reload survival) ----
  _restoreRoom() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(ROOM_KEY) || 'null');
      if (saved && saved.room) {
        this.roomCode = saved.room;
        this.instance = saved.instance || null;
        this.clientId = saved.cid || null; // reuse the secret so a reload lands on slot 0
      }
    } catch (_) { /* no restore — create a fresh room */ }
    // Mint a fresh secret on a cold boot (or a legacy blob without one). Done here,
    // before _connect, so the create/join always carries our clientId.
    if (!this.clientId) this.clientId = genDisplayClientId();
  }
  _saveRoom() {
    try { sessionStorage.setItem(ROOM_KEY, JSON.stringify({ room: this.roomCode, instance: this.instance, cid: this.clientId })); } catch (_) {}
  }
  _forgetRoom() {
    try { sessionStorage.removeItem(ROOM_KEY); } catch (_) {}
  }

  // ---- roster helpers ----
  // Echo roster state everywhere it's consumed: the retained snapshot every
  // phone sees (LOBBY_UPDATE) and the display's own UI. Called on any
  // roster/host/ready/car change.
  _announce() {
    this._publishLobby();
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
  // something actually changed, so the first lobby entry stays quiet. Returns
  // whether it announced, so the statechange handler can skip its own publish.
  _clearReady() {
    let changed = false;
    for (const p of this.flow.list()) { if (p.ready) { p.ready = false; changed = true; } }
    if (changed) this._announce();
    return changed;
  }
  _usedColors() {
    const s = new Set();
    for (const p of this.flow.list()) s.add(p.colorIndex);
    return s;
  }

  // ---- connection ----
  _connect() {
    if (this.party) this.party.close(); // fresh-room fallback replaces the connection
    this.fastlane.closeAll();
    const url = (this.roomCode && this.instance)
      ? RELAY_URL + '/' + enc(this.roomCode) + '?instance=' + enc(this.instance)
      : RELAY_URL;
    // Per-session secret (genDisplayClientId) keyed to slot 0 → reconnect/reload
    // lands back on slot 0, while an outsider with only the room code can't forge it.
    this.party = new PartyConnection(url, { clientId: this.clientId });

    this.party.onOpen = () => {
      if (this.roomCode) this.party.join(this.roomCode);
      else this.party.create(MAX_PLAYERS + 1, this._controllerUrlTemplate()); // +1 for the display itself
      // A socket that opens but never gets a created/joined answer (relay
      // rejected the create, reply lost) would otherwise hang forever — no
      // close event ever fires. Count it as a failed attempt so the normal
      // backoff/retry path runs. Cleared by created/joined; onClose clears it
      // too so a socket already in backoff can't be double-failed.
      clearTimeout(this._createTimer);
      this._createTimer = setTimeout(() => { if (!this._inRoom) this.party.failAttempt(); }, CREATE_TIMEOUT_MS);
    };
    this.party.onClose = (attempt, max, meta) => {
      this._inRoom = false;
      clearTimeout(this._createTimer);
      // The room itself is gone — our own closeRoom() echoing back, or the
      // relay tore it down. Terminal for the room but not for the display:
      // forget it and open a fresh one (new code/QR), same fallback as a
      // "Room not found" join.
      if (meta && meta.roomClosed) {
        this._forgetRoom();
        this.roomCode = null;
        this.instance = null;
        this._connect();
      }
    };
    this.party.onProtocol = (type, msg) => this._onProtocol(type, msg);
    this.party.onMessage = (from, data) => this._onMessage(from, data);
    this.party.connect();
  }

  _onProtocol(type, msg) {
    switch (type) {
      case 'created':
        clearTimeout(this._createTimer);
        this.roomCode = msg.room;
        this.instance = msg.instance || null;
        if (this.instance) this.party.pinInstance(RELAY_URL, this.roomCode, this.instance);
        this._inRoom = true;
        this._saveRoom();
        this._startLiveness();
        this.onRoomReady({ roomCode: this.roomCode, joinUrl: this._joinUrl() });
        break;
      case 'joined': // display reconnected to an existing room (in-session or after a reload)
        clearTimeout(this._createTimer);
        this.roomCode = msg.room;
        this._resyncPeers(msg.peers || []);
        this.party.resetReconnectCount();
        this._inRoom = true;
        this._saveRoom();
        this._startLiveness();
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
        // A join refused while we hold a room code means the room is gone (the
        // relay expired it while this tab was closed/asleep). Fall back to a
        // fresh room instead of erroring forever on a dead one.
        if (this.roomCode && !this._inRoom) {
          this._forgetRoom();
          this.roomCode = null;
          this.instance = null;
          this._connect();
        } else if (!this._inRoom) {
          // The CREATE was rejected (bad url template, server error): without a
          // room there is nothing to fall back to, so write the attempt off and
          // let the normal backoff retry it.
          this.party.failAttempt();
        }
        break;
    }
  }

  _onMessage(from, data) {
    if (!data) return;
    if (from === 0) { // our own relay echo coming back (see _livenessTick)
      if (data.type === '_heartbeat') this._hbPending = false;
      return;
    }
    // ANY traffic from a peer — app message or RTC signal — is proof of life.
    this._seen(from);
    if (this._isSignal(from, data)) return;
    switch (data.type) {
      case MSG.HELLO: {
        // A cross-device rejoin claims its dropped seat first, so the welcome we
        // build below reflects the restored identity (livery/car/host) — not the
        // throwaway placeholder slot the relay just handed this fresh connection.
        this._claimReconnect(from, data);
        // A HELLO from a peer we never seated (the relay knows them, we don't —
        // e.g. this tab reloaded and missed their peer_joined): seat them now.
        if (!this.flow.has(from)) this._addPeer(from);
        const p = this.flow.get(from);
        if (p && data.name) p.name = String(data.name).slice(0, 16);
        this.party.sendTo(from, this._welcomeFor(from));
        this.onPlayerWelcomed(from);
        this._announce();
        break;
      }
      case MSG.LEAVE:
        // Intentional back-out. In the lobby (and on the results board) the
        // seat is freed outright — the join QR covers coming back. Mid-race
        // it's treated as a DROP instead: one accidental back-swipe must not
        // forfeit a car for good, so the seat holds its reconnect QR through
        // the usual grace window (re-joining lands straight back in the seat)
        // and expires like any other drop if the player is truly gone.
        if (this.roomState === ROOM_STATE.COUNTDOWN || this.roomState === ROOM_STATE.PLAYING) {
          this._dropSeat(from);
        } else {
          this._expireSeat(from);
        }
        break;
      case MSG.SET_CAR: {
        // Lobby car-model pick. Car and colour are independent and duplicates
        // are allowed, so no uniqueness check — just validate and store, then
        // broadcast so this phone's picker confirms and the display renders the
        // chosen model at race start. Allowed in the lobby, and mid-race for
        // players with no car on track (late joiners wait in THEIR lobby while
        // a race runs — their pick must stick for the next race). Racers stay
        // locked to their car until the room is back in the lobby.
        const p = this.flow.get(from);
        const idx = data.carIndex;
        if (p && (this.roomState === ROOM_STATE.LOBBY || !this.inRace(from))
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
        if (p && from !== this.flow.host && this.roomState === ROOM_STATE.LOBBY && ready !== !!p.ready) {
          p.ready = ready;
          this._announce();
        }
        break;
      }
      case MSG.SELECT_TRACK:
        // Legacy exact pick (a mid-deploy phone that predates modes) — same
        // validation and effect as SELECT_MODE {mode:'track'}.
        this._applyMode(from, { mode: 'track', trackId: data.trackId });
        break;
      case MSG.SELECT_MODE:
        this._applyMode(from, data);
        break;
      case MSG.PING:
        this.party.sendTo(from, { type: MSG.PONG, t: data.t });
        break;
      default:
        // START_GAME / control / etc. — hand to the game layer.
        this.onControllerMessage(from, data);
    }
  }

  // Host's lobby pick — exact track, a cup (Grand Prix), or a random draw.
  // Validates, resolves the concrete trackId, echoes to every phone
  // (LOBBY_UPDATE mode/cupId/trackId) and tells the display to swap the 3D
  // preview. Same-pick taps no-op EXCEPT random, where a re-tap re-rolls.
  _applyMode(from, data) {
    if (from !== this.flow.host || this.roomState !== ROOM_STATE.LOBBY) return;
    let cupId = null, trackId;
    if (data.mode === 'track') {
      if (!this.tracks.some((t) => t.id === data.trackId)) return;
      if (this.mode === 'track' && data.trackId === this.trackId) return;
      trackId = data.trackId;
    } else if (data.mode === 'cup') {
      // The catalog is in CUPS order, so a cup's first entry is its race 1.
      const first = this.tracks.find((t) => t.cup === data.cupId);
      if (!first) return;
      if (this.mode === 'cup' && data.cupId === this.cupId) return;
      cupId = data.cupId;
      trackId = first.id;
    } else if (data.mode === 'random') {
      if (!this.drawRandomTrack) return;
      trackId = this.drawRandomTrack();
    } else return;
    this.mode = data.mode;
    this.cupId = cupId;
    this.trackId = trackId;
    this._publishLobby();
    this.onTrackChange(this.trackId);
  }

  // Game-layer track swap that keeps mode/cupId as they are: the series engine
  // advancing to a cup's next race, or the lobby re-drawing a random pick.
  // Single writer with _applyMode, so trackId always flows out the same way
  // (publish + preview swap).
  setTrack(id) {
    if (!this.tracks.some((t) => t.id === id) || id === this.trackId) return;
    this.trackId = id;
    this._publishLobby();
    this.onTrackChange(id);
  }

  // Re-send a seat's WELCOME outside the join path. A chained series race
  // starts with no lobby round-trip, so a phone that was waiting out the last
  // race ("you're in the next race!") only learns it now has a car from a
  // fresh WELCOME (inRace flips true) — GAME_END, the usual reset, never comes.
  resendWelcome(peerIndex) {
    if (!this.party || !this.flow.has(peerIndex)) return;
    this.party.sendTo(peerIndex, this._welcomeFor(peerIndex));
    this.onPlayerWelcomed(peerIndex);
  }

  _addPeer(peerIndex) {
    if (!this.flow.has(peerIndex)) {
      if (this.flow.size >= MAX_PLAYERS) return;
      const colorIndex = RoomFlow.lowestFreeSlot(this._usedColors(), MAX_PLAYERS);
      // Default the car model to the livery slot so everyone starts on a distinct
      // car; the player can change it in the lobby (SET_CAR), colour stays fixed.
      this.flow.addPlayer(peerIndex, { name: 'Player ' + (colorIndex + 1), colorIndex, carIndex: colorIndex, ready: false });
      // rosterchange fires from addPlayer → announce() handles broadcast + UI.
    }
    // Existing seat = same-device reconnect: the relay keys slots by clientId,
    // so a returning phone lands back on its old index — _seen flips presence
    // back on and drops its reconnect QR. (A cross-device rejoin gets a NEW
    // index instead and is re-keyed onto the dropped seat in _claimReconnect
    // via HELLO.) New seats just get their liveness clock started.
    this._seen(peerIndex);
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
      this.flow.removePlayer(peerIndex); // emits rosterchange → announce(); drops its last-seen stamp
    } else {
      this._dropSeat(peerIndex);
    }
  }

  // Mid-game drop (socket gone, liveness silence, or a mid-race LEAVE): keep the
  // seat AND the car — the camera stays on it and a quick reconnect resumes
  // driving — and offer the per-seat reconnect QR with its grace clock running.
  _dropSeat(peerIndex) {
    this.fastlane.close(peerIndex);
    this.flow.markDisconnected(peerIndex);
    this._showReconnect(peerIndex);
  }

  // Free a seat for good: clear its reconnect QR/timer and drop the player. Used
  // for an intentional LEAVE and when the reconnect grace window elapses.
  _expireSeat(peerIndex) {
    this._clearReconnect(peerIndex);
    if (!this.flow.has(peerIndex)) return;
    this.fastlane.close(peerIndex);
    this.flow.removePlayer(peerIndex);
  }

  // ---- liveness (1 Hz) ----
  _startLiveness() {
    // Reset BEFORE the timer guard: a heartbeat left in-flight by a dropped
    // socket must not survive into the fresh connection, or the first tick
    // would read it as overdue and force-reconnect the link that just recovered.
    this._hbPending = false;
    if (this._livenessTimer) return;
    this._livenessTimer = setInterval(() => this._livenessTick(), LIVENESS_TICK_MS);
  }

  // Record proof of life for a peer — relay message, RTC signal, fastlane input,
  // or a relay (re)join. Also lifts a dropped seat back to connected: a phone can
  // go silent and resume WITHOUT its socket ever closing (locked screen, network
  // blip), so presence must flip back here, not only on peer_joined.
  _seen(peerIndex) {
    this.flow.onSeen(peerIndex, Date.now()); // no-op for unseated peers
    if (this.flow.isDisconnected(peerIndex)) {
      this.flow.markReconnected(peerIndex); // emits rosterchange → announce + auto-pause refresh
      this._clearReconnect(peerIndex);
    }
  }

  _livenessTick() {
    if (!this._inRoom || !this.party) return;
    const now = Date.now();
    // Self-heartbeat: relay a message to our own slot and expect it echoed back.
    // Tracked as an in-flight flag rather than an echo-age so a throttled
    // background tab — whose ticks may run minutes apart — can't misread its own
    // starvation as a dead link. No echo inside the window = the socket is
    // half-dead; reconnect now instead of waiting for TCP to notice.
    if (this._hbPending && now - this._hbSentAt > HEARTBEAT_DEAD_MS) {
      this._hbPending = false;
      this.party.reconnectNow();
      return;
    }
    if (!this._hbPending) {
      this._hbPending = true;
      this._hbSentAt = now;
      this.party.sendTo(0, { type: '_heartbeat' });
    }
    // Per-controller silence check. RoomFlow owns the detection (mid-game only —
    // expiredPeers is empty in the lobby); applying the drop stays here so
    // markDisconnected keeps its single writer.
    for (const id of this.flow.expiredPeers(now)) this._dropSeat(id);
  }

  _resyncPeers(peers) {
    const present = new Set(peers);
    for (const p of this.flow.list()) {
      if (!present.has(p.peerIndex)) this._expireSeat(p.peerIndex);
    }
    // Peers the relay knows that we don't — this tab RELOADED mid-session and
    // lost the roster. Seat them with placeholder identities now; each phone
    // also re-HELLOs when it sees the display return, restoring its name.
    for (const idx of peers) {
      if (idx !== 0 && !this.flow.has(idx)) this._addPeer(idx);
    }
    // Re-welcome everyone so their controllers clear any reconnect overlay.
    for (const p of this.flow.list()) this.party.sendTo(p.peerIndex, this._welcomeFor(p.peerIndex));
    // Overwrite the snapshot retained from before the reload: this fresh flow is
    // now the authority, and the next joiner must not be replayed the old roster.
    this._publishLobby();
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
    this.flow.rekey(oldId, fromId); // moves the seat record (+ last-seen stamp), marks it reconnected
    // Re-stamp now: the carried stamp is from before the drop (> timeout old), so
    // without this the reclaimed seat could expire again on the very next tick.
    this.flow.onSeen(fromId, Date.now());
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
      inRace: !!this.inRace(peerIndex), // mid-race: rejoin (true) vs late joiner (false)
      paused: !!this.isPaused(),        // mid-race: re-sync the pause overlay a rejoiner missed
      players: this.roster(),
      tracks: this.tracks,       // full catalog (static) — sent once, on join
      mode: this.mode,           // what the pick means ('track'|'cup'|'random')
      cupId: this.cupId,
      trackId: this.trackId      // resolved current selection
    };
  }
  // Publish the lobby snapshot as the room's retained host state (relay
  // set_state): one message where the per-phone fanout used to be N. The relay
  // pushes it live to every controller and replays it right after `joined`, so
  // a (re)joining phone catches up on roster/track before WELCOME round-trips.
  // Same payload shape as the old relayed message — controllers funnel the
  // replayed/pushed snapshot into their existing LOBBY_UPDATE handler.
  _publishLobby() {
    if (!this.party) return;
    this.party.setState({
      type: MSG.LOBBY_UPDATE,
      hostPeerIndex: this.flow.host,
      roomState: this.roomState,
      players: this.roster(),
      mode: this.mode,           // catalog is static (WELCOME) — echo just the pick
      cupId: this.cupId,
      trackId: this.trackId      // ...resolved to a concrete track
    });
  }

  // End the party for everyone: the relay deletes the room (stale rejoin links
  // 404) and closes every socket with 4001 — phones bail terminally (their
  // onClose {roomClosed}), while the display's own 4001 self-heals into a fresh
  // room (see onClose in _connect). For a page exit use shutdown() instead,
  // which suppresses that self-heal.
  closeRoom() { if (this.party) this.party.closeRoom(); }

  // Page-exit teardown (pagehide): the party is over for everyone, so tear the
  // room down (phones bail terminally instead of waiting out the relay's ~2 min
  // hostless grace) and stop reconnecting — party.close() also detaches the
  // socket handlers, so our own 4001 echo can't fire the onClose self-heal and
  // race a fresh room into existence on a dying page. Best-effort by nature:
  // on a bfcache freeze / killed tab the close_room may never flush — then the
  // room outlives us and the sessionStorage rejoin (ROOM_KEY above) turns the
  // next load into a party-regathering crash recovery instead.
  shutdown() {
    if (this._livenessTimer) { clearInterval(this._livenessTimer); this._livenessTimer = null; }
    clearTimeout(this._createTimer);
    if (!this.party) return; // test/gallery/solo surfaces never opened the relay
    this.party.closeRoom();
    this.party.close();
  }

  broadcast(data) { if (this.party) this.party.broadcast(data); }
  sendTo(id, data) { if (this.party) this.party.sendTo(id, data); }
  // Room state is owned by RoomFlow — read it straight through so the display
  // never keeps a second copy that can drift out of sync with the machine.
  get roomState() { return this.flow.state; }

  // ---- join URL / QR base ----
  _baseUrl() { return this.baseUrlOverride || window.location.origin; }
  _joinUrl() {
    return this._baseUrl() + '/' + this.roomCode + (this.instance ? '#' + enc(this.instance) : '');
  }
  // Controller-URL template registered with the relay on room create. The relay
  // fills {room}/{instance} and hands the result to anyone holding only the room
  // code (native shells via GET /room/:code, controllers in `joined`), so a
  // code-only join can resolve which page to load. Mirrors the _joinUrl() shape
  // (instance in the fragment, kept out of request logs). The relay accepts only
  // absolute https templates and rejects the whole create on an invalid one, so
  // plain-http origins (local dev, e2e) register none.
  _controllerUrlTemplate() {
    const base = this._baseUrl().replace(/\/+$/, '');
    if (base.indexOf('https://') !== 0) return undefined;
    return base + '/{room}#{instance}';
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
