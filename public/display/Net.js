// DisplayNet — owns the relay connection, RoomFlow roster/host machine, and the
// controller<->display message protocol. The display is slot 0 and authoritative.
// Game logic/rendering live elsewhere; this module is transport + lobby only.
//
// Reads partyplug + protocol globals set by the classic <script> tags that load
// before this module (PartyConnection, MSG, RELAY_URL, MAX_PLAYERS). The room
// state machine is NOT a global any more: it arrives as opts.RoomFlowImpl.
// Room state is owned by the RoomFlow machine (see the `roomState` getter).
import { GameNet } from '../shared/GameNet.js';
// The name cap is the phone's rule, applied again here because a HELLO from any
// peer is untrusted input. Shared so the two halves cannot drift (shared/names.js).
import { cleanName } from '../shared/names.js';
// The SESSION POLICY is C++ too (ttp_net.h over libttp-party/ttp/session.cc).
// Every room decision below — what the retained snapshot contains, what a new
// seat starts as, what a drop or a LEAVE means in each phase, which picks are
// refused, when the socket is declared dead, who may claim a dropped seat — is
// ITS answer; this file performs them against the socket, the timers, the
// storage and the RoomFlow, and decides nothing. The JS twin (sessionModel.js)
// survives only as the oracle session-corpus.jsonl was recorded from, exactly as
// uiModel.js and decide.js do for the screens and the sound.
import * as session from './NativeSessionModel.js';
// The sharded dial URL, from the same encoder party.pinInstance calls. This file
// used to build that string by hand eleven lines above asking C++ for it.
import { pinUrl } from './NativePartyConnection.js';

const { PartyConnection, MSG, ROOM_STATE, RELAY_URL, MAX_PLAYERS, CAR_MODELS, CAR_COLORS, LIVENESS } = window;

const enc = encodeURIComponent;

// Presence windows. All six live in the shared manifest (protocol.js LIVENESS)
// because they only mean anything TOGETHER and against the phone's ping cadence:
// the relay only reports a drop when a socket actually CLOSES — a locked phone
// or dead Wi-Fi leaves it dangling for minutes — so a seat silent past
// TIMEOUT_MS is dropped through the same path as a real peer_left, which is only
// safe because phones ping at PING_INTERVAL_MS. Detection itself lives in
// RoomFlow (opts.liveness + onSeen/expiredPeers, nowMs-injected); this module
// stamps traffic and applies expiries. Lobby seats are exempt (expiredPeers is
// empty there): peer_left stays the authority, so a brief blip can't kick a
// lobby seat. The abandoned-race grace is RoomFlow's decision too (graceTick);
// this module only feeds it the participant set and reports the one moment it
// fires. __abandonGraceMs is the E2E hook that shortens the wait, and it is the
// one platform-flavoured part — an override of a manifest number, not a second
// declaration of it.
const LIVENESS_TIMEOUT_MS = LIVENESS.TIMEOUT_MS;
const ABANDONED_RACE_GRACE_MS = window.__abandonGraceMs || LIVENESS.ABANDONED_RACE_GRACE_MS;
const LIVENESS_TICK_MS = LIVENESS.TICK_MS;
const CREATE_TIMEOUT_MS = LIVENESS.CREATE_TIMEOUT_MS;

// A 'random' pick's run length off the wire: 0 is ENDLESS, anything else is that
// many races. The phone offers 4 or endless, but the value is host-supplied like
// every other field here, so it's clamped rather than trusted — and a pick that
// carries no length at all (a phone from before they existed) gets the default
// card rather than an endless run nobody asked for.
//
// This stays in the shell rather than crossing into session.cc with the rest of
// the room policy, and it is the same call _applyMode/setTrack/clearPick already
// made: the host's MODE PICK needs a track catalogue and a game-owned shuffle
// bag, which makes it a cup-series concern wearing a session hat. The length is
// part of that pick, so it travels with it.
const RANDOM_MAX_RACES = 8;
const RANDOM_DEFAULT_RACES = 4;
const normRandomRaces = (n) => (Number.isInteger(n) && n >= 0 && n <= RANDOM_MAX_RACES ? n : RANDOM_DEFAULT_RACES);

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
    // The live race's native session handle, or 0 between races. The only thing
    // this module needs to hand the party layer for it to work out the active
    // participant set itself (_syncActiveOrder); a shell that has no session yet
    // answers 0 and gets "the dropped seats" — the same answer as an empty grid.
    this.sessionHandle = opts.sessionHandle || (() => 0);
    // Asked per WELCOME: is the race manually paused? A rejoiner must re-raise
    // the pause overlay it missed while away, or its wheel just feels dead.
    this.isPaused = opts.isPaused || (() => false);
    // Fired after a WELCOME is sent, so the game layer can follow up with any
    // catch-up state that normally only flows as broadcasts (e.g. the live
    // standings board for a rejoiner whose car already finished).
    this.onPlayerWelcomed = opts.onPlayerWelcomed || (() => {});
    // Fired once when RoomFlow's abandoned-race deadline expires (see
    // ABANDONED_RACE_GRACE_MS): the race has no racer left and someone is waiting
    // for the next one. The game layer returns to the lobby.
    this.onRaceAbandoned = opts.onRaceAbandoned || (() => {});

    // Dropped seats currently offering a reconnect QR. peerIndex -> {peerIndex,
    // name, colorIndex, url}. Held for the whole race (no give-up timer); freed
    // on return to the lobby (_freeDisconnectedSeats) or a real socket close.
    this._reconnectSeats = new Map();

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
    // Slim chooser content for the retained room snapshot (set_state): reduced
    // track schematics (lobby only — the bulk), car id/name/stats (always — the
    // late-joiner picker needs it mid-race), and the livery palette. The controller
    // renders straight off these; car images load by id from the web host.
    this.trackChooser = opts.trackChooser || this.tracks;
    this.carChooser = opts.carChooser || [];
    this.colorPalette = opts.colorPalette || [];
    // Handed to the session model ONCE: it is authored data that changes when
    // the game ships, not while it runs, so it does not ride every publish
    // across the boundary. The model treats it as opaque — the lobby-only gate
    // on `tracks` is the only thing it knows about the shape.
    session.configure({ cars: this.carChooser, colors: this.colorPalette, tracks: this.trackChooser });
    // Latest standings board, mirrored into the snapshot so a phone that reconnects
    // on the results screen (or after its car finished) recovers it by replay.
    // null outside a race; set via setStandings on each finish + at race end.
    this._standings = null;
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
    // How long a 'random' run is: 0 = endless (only a lobby return ends it),
    // otherwise that many drawn races and then a podium. Meaningless in the
    // other modes, where it stays 0.
    this.randomRaces = 0;
    this.drawRandomTrack = opts.drawRandomTrack || null;

    // The room state machine — NativeRoomFlow (C++ decisions, kit surface),
    // injected so this module stays transport-focused. Held for the static
    // lowestFreeSlot too, so both come from one implementation.
    // Required: the room state machine is native (NativeRoomFlow) and there is no
    // JS RoomFlow left to fall back to, so a missing impl is a wiring bug, not a
    // mode. Fail at construction rather than at the first roster change.
    if (!opts.RoomFlowImpl) throw new Error('DisplayNet: opts.RoomFlowImpl is required');
    this._RoomFlowImpl = opts.RoomFlowImpl;
    // Same injection for the relay connection and the fastlane netcode: absent,
    // both are the kit's classes (see GameNet._initFastlane for the latter).
    // PartyConnection (the JS socket owner) survives, but the native adapter is
    // what the display uses; keep the kit class as the documented default.
    this._PartyConnectionImpl = opts.PartyConnectionImpl || PartyConnection;
    if (opts.FastlaneImpl) this.FastlaneImpl = opts.FastlaneImpl;
    this.flow = new this._RoomFlowImpl({
      liveness: { timeoutMs: LIVENESS_TIMEOUT_MS, graceMs: ABANDONED_RACE_GRACE_MS }
    });
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
    this.flow.on('hostchange', ({ hostPeerIndex }) => {
      const plan = session.hostChangePlan();
      if (plan.clearReady) {
        const h = this.flow.get(hostPeerIndex);
        if (h) h.ready = false;
      }
      if (plan.publish) this._announce();
    });
    // Republish the snapshot on every phase flip: the retained copy carries
    // roomState, and a replay to a (re)joining phone must never hand it a
    // stale phase. Ready flags deliberately SURVIVE the race → lobby round
    // trip: the same crew usually races again, so returning racers land back
    // in the lobby still ready (the host's "Start race" is pre-armed) instead
    // of re-tapping "I'm ready" every race. SET_READY is a toggle, and a
    // ready seat's car pick is locked (SET_CAR below) — anyone who wants to
    // switch cars un-readies first, so a ready flag always means "ready".
    this.flow.on('statechange', ({ to }) => {
      const plan = session.stateChangePlan(to);
      // Race start: re-stamp every CONNECTED seat's liveness, so silence
      // accumulated in the lobby (where expiredPeers is gated off) isn't charged
      // against the first COUNTDOWN tick. Deliberately not a blanket
      // clearDisconnected: flipping a grace-pending seat back to connected here
      // would orphan its reconnect QR (only _seen/markReconnected/
      // _claimReconnect may flip presence). Disconnected seats keep their stale
      // stamp; expiredPeers already skips them.
      if (plan.restampConnected) {
        const now = Date.now();
        for (const p of this.flow.list()) if (p.connected) this.flow.onSeen(p.peerIndex, now);
      }
      if (plan.freeDisconnected) this._freeDisconnectedSeats();
      if (plan.clearStandings) this._standings = null;
      if (plan.publish) this._publishLobby();
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
  //
  // ONE PROJECTION, not two. The snapshot's own `players` array IS the roster
  // the UI renders — ttp_net_lobby_snapshot_json composes it with the very
  // rule ttp_net_roster_rows_json applies, and the two are byte-identical. This
  // used to publish and then ask a SECOND time, which pulled the roster out of
  // the wasm twice and re-composed the same rows twice (~74 us and four
  // crossings of a ~640-byte roster per announce, on every join, rename, car
  // pick, ready toggle and host change). Read it off the snapshot instead.
  _announce() {
    this.onRosterChange(this._publishLobby().players, this.flow.host);
  }

  // ---- the active participant order ----
  // RoomFlow's participant order, from THIS game's point of view: the seats this
  // race is for. WHAT that set is (everyone holding a car — connected or blipped,
  // since a dropped racer's car and seat are held for the whole race — plus every
  // other dropped seat, which is absent rather than waiting) is decided in C++,
  // by RoomFlow::syncActiveOrder over the live Game. This module supplies the
  // session handle and nothing else, so a tvOS/Android shell inherits the
  // definition instead of restating it.
  //
  // What is LEFT OVER is exactly a CONNECTED seat with no car, which is precisely
  // a late joiner: someone here, now, with nothing to drive. That leftover set is
  // the one RoomFlow answers both "is anyone waiting?" (hasLateJoiners → the
  // abandoned-race grace) and "who?" (lateJoiners → the standings' `joining`
  // rows) from, so the policy and the boards read one definition.
  //
  // The kit maintains an order of its own — snapshot at COUNTDOWN, follow
  // removePlayer/rekey — and that snapshot already IS the human race field. What
  // it cannot know is which seats have a car NOW, so push before every read.
  // Presence-only members never change host election (a disconnected peer is
  // ineligible either way), so this stays host-neutral.
  _syncActiveOrder() {
    this.flow.syncActiveOrder(this.sessionHandle());
  }

  // Connected seats with no car in the live race — who the room is holding the
  // next race for. Records in join order, like list().
  lateJoiners() {
    this._syncActiveOrder();
    return this.flow.lateJoiners();
  }

  // Every seat this race is for has dropped: the room has a race running and
  // nobody at any wheel. RoomFlow's predicate over the SAME participant set the
  // abandoned-race grace waits on, so the display's freeze and that policy can
  // never disagree about whether the race still has drivers.
  allParticipantsDisconnected() {
    this._syncActiveOrder();
    return this.flow.allParticipantsDisconnected();
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
    // The sharded dial URL, from ttp::framing::pin_instance_url — the same
    // encoder party.pinInstance calls below, rather than a second hand-built
    // copy of the string in the same file. No instance = the plain relay URL.
    const url = this.roomCode ? pinUrl(RELAY_URL, this.roomCode, this.instance) : RELAY_URL;
    // Per-session secret (genDisplayClientId) keyed to slot 0 → reconnect/reload
    // lands back on slot 0, while an outsider with only the room code can't forge it.
    this.party = new this._PartyConnectionImpl(url, { clientId: this.clientId });

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
        // The 4001 bailed every phone terminally — nobody carries a seat into
        // the fresh room (close_room sends no peer_lefts, so without this the
        // old roster would haunt the new lobby). Cleared here, not on
        // 'created', so a plain reconnect's regathered roster stays intact.
        for (const p of this.flow.list()) this._expireSeat(p.peerIndex);
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
    // Slot 0 is US: the only thing that can arrive from it is our own relayed
    // echo, which is how the self-heartbeat closes its loop.
    const route = session.inboundRoute(from, data.type);
    if (route !== 'peer') {
      if (route === 'self-heartbeat') this._hbPending = false;
      return;
    }
    // ANY traffic from a peer — app message or RTC signal — is proof of life.
    this._seen(from);
    if (this._isSignal(from, data)) return;
    switch (session.messageAction(data.type)) {
      case 'hello': {
        // A cross-device rejoin claims its dropped seat first, so the snapshot we
        // publish below reflects the restored identity (livery/car/host) — not the
        // throwaway placeholder slot the relay just handed this fresh connection.
        this._claimReconnect(from, data);
        // A HELLO from a peer we never seated (the relay knows them, we don't —
        // e.g. this tab reloaded and missed their peer_joined): seat them now.
        if (!this.flow.has(from)) this._addPeer(from);
        const p = this.flow.get(from);
        if (p && data.name) p.name = cleanName(data.name);
        // No unicast reply: the phone recovers its whole state from the retained
        // room snapshot (_announce republishes it, and the relay replayed it right
        // after `joined`). onPlayerWelcomed only relights the per-owner ITEM.
        this.onPlayerWelcomed(from);
        this._announce();
        break;
      }
      case 'leave':
        // Intentional back-out. The fork is the session model's: freed outright
        // in the lobby (and on the results board), a soft DROP mid-race so one
        // accidental back-swipe cannot forfeit a car.
        if (session.leaveAction(this.roomState) === 'drop') this._dropSeat(from);
        else this._expireSeat(from);
        break;
      case 'set_car': {
        // Lobby car-model pick. Whether it is allowed — a ready seat's pick is
        // locked, a racer's is locked until the lobby, a late joiner may pick
        // mid-race, and the index must be an integer in range — is decided in
        // C++ off untrusted phone input.
        const p = this.flow.get(from);
        if (p && session.setCarDecision({
          ready: p.ready, roomState: this.roomState, inRace: this.inRace(from),
          carIndex: data.carIndex, carCount: CAR_MODELS.length
        })) {
          p.carIndex = data.carIndex;
          this._announce();
        }
        break;
      }
      case 'set_ready': {
        // Readiness toggle. Stored on the player record and echoed to every
        // phone via LOBBY_UPDATE; the game layer requires every non-host player
        // ready before honouring the host's START_GAME.
        const p = this.flow.get(from);
        if (p && session.setReadyDecision({
          isHost: from === this.flow.host, roomState: this.roomState,
          ready: data.ready, current: p.ready
        })) {
          p.ready = !!data.ready;
          this._announce();
        }
        break;
      }
      case 'select_mode':
        this._applyMode(from, data);
        break;
      case 'ping':
        this.party.sendTo(from, { type: MSG.PONG, t: data.t });
        break;
      default:
        // START_GAME / control / etc. — hand to the game layer.
        this.onControllerMessage(from, data);
    }
  }

  // Host's lobby pick — exact track, a cup (Grand Prix), or a random draw.
  // Validates, resolves the concrete trackId, echoes to every phone
  // (LOBBY_UPDATE mode/cupId/trackId/randomRaces) and tells the display to swap
  // the 3D preview. Same-pick taps no-op EXCEPT random, where a re-tap re-rolls.
  _applyMode(from, data) {
    if (from !== this.flow.host || this.roomState !== ROOM_STATE.LOBBY) return;
    let cupId = null, randomRaces = 0, trackId;
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
      randomRaces = normRandomRaces(data.randomRaces);
      // Changing the LENGTH keeps the drawn track — only the shape of the run
      // changed, and re-rolling the preview under the host would read as the
      // length button having picked a track. Every other random tap (the tile
      // itself, or arriving from another mode) draws.
      const keepDraw = this.mode === 'random' && randomRaces !== this.randomRaces && this.trackId != null;
      trackId = keepDraw ? this.trackId : this.drawRandomTrack();
    } else return;
    this.mode = data.mode;
    this.cupId = cupId;
    this.randomRaces = randomRaces;
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

  _addPeer(peerIndex) {
    // The seat rule is the session model's: a full room refuses the seat and
    // does not even stamp it; an EXISTING seat is a same-device reconnect (the
    // relay keys slots by clientId, so a returning phone lands back on its old
    // index) and only needs its liveness clock restarted. A cross-device rejoin
    // gets a NEW index instead and is re-keyed in _claimReconnect via HELLO.
    // lowestFreeSlot stays RoomFlow's, resolved here and passed in.
    const plan = session.addPeerPlan({
      has: this.flow.has(peerIndex),
      size: this.flow.size,
      maxPlayers: MAX_PLAYERS,
      colorIndex: this._RoomFlowImpl.lowestFreeSlot(this._usedColors(), MAX_PLAYERS)
    });
    // rosterchange fires from addPlayer → announce() handles broadcast + UI.
    if (plan.seat) this.flow.addPlayer(peerIndex, plan.seat);
    if (plan.stamp) this._seen(peerIndex);
  }

  _removePeer(peerIndex) {
    if (!this.flow.has(peerIndex)) return;
    this.fastlane.close(peerIndex);
    // In the lobby a drop is forgiving — just free the seat (the lobby's own join
    // QR covers coming back). Mid-game (countdown/race/results) keep the seat AND
    // the player's car running — so the camera stays on it and a quick reconnect
    // resumes driving — and offer a reconnect QR for that exact seat. The car is
    // only forfeited if the seat's grace window elapses (playerleave → forfeitCar).
    if (session.presenceAction(this.roomState) === 'free') {
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
    if (!this.party) return;
    const now = Date.now();
    // The self-heartbeat's state machine is the session model's: overdue is an
    // IN-FLIGHT FLAG rather than an echo age, so a throttled background tab —
    // whose ticks may run minutes apart — cannot misread its own starvation as a
    // dead link. This side only performs: relay a message to our own slot, or
    // force the reconnect the relay can no longer reach us to ask for.
    const tick = session.heartbeatTick({
      inRoom: this._inRoom, hbPending: this._hbPending, hbSentAt: this._hbSentAt, now
    });
    this._hbPending = tick.hbPending;
    this._hbSentAt = tick.hbSentAt;
    if (tick.act === 'reconnect') this.party.reconnectNow();
    else if (tick.act === 'send') this.party.sendTo(0, { type: MSG.HEARTBEAT });
    if (!tick.sweep) return;
    // Per-controller silence check. RoomFlow owns the detection (mid-game only —
    // expiredPeers is empty in the lobby); applying the drop stays here so
    // markDisconnected keeps its single writer.
    for (const id of this.flow.expiredPeers(now)) this._dropSeat(id);
    // …then the abandoned-race deadline, on the same tick and the same clock:
    // RoomFlow arms it while every participant is gone and someone is waiting,
    // and returns true the one time it expires. Polled here rather than on a
    // timer of its own so the decision runs where the drops that cause it land.
    this._syncActiveOrder();
    if (this.flow.graceTick(now)) this.onRaceAbandoned();
  }

  _resyncPeers(peers) {
    // Post-reload reconciliation: seats the relay no longer knows are expired,
    // peers it knows that we don't are seated with placeholder identities (this
    // tab RELOADED mid-session and lost the roster). Slot 0 is us. The set logic
    // is the session model's; both halves are performed here.
    const plan = session.resyncPlan(this.flow.list().map((p) => p.peerIndex), peers);
    for (const id of plan.expire) this._expireSeat(id);
    for (const idx of plan.add) this._addPeer(idx);
    // Overwrite the snapshot retained from before the reload: this fresh flow is
    // now the authority (roster + roomState), so the live push clears every
    // phone's reconnect overlay and the next joiner isn't replayed the old roster.
    // Each phone also re-HELLOs when it sees the display return (restoring its
    // name + relighting its ITEM via onPlayerWelcomed).
    if (plan.publish) this._publishLobby();
  }

  // ---- reconnect (dropped-seat) handling ----
  // A different device claims a dropped seat by carrying its old peerIndex as the
  // HELLO rejoinToken (from the QR's ?claim=). Re-key the kept seat record from
  // the old index onto this fresh connection so the returning player resumes
  // their livery/car/name/host slot. A same-device reconnect keeps its index and
  // never reaches here (oldId === fromId, handled in _addPeer instead).
  _claimReconnect(fromId, msg) {
    // The WHOLE message crosses, not just the token: an ABSENT rejoinToken and
    // an explicit null answer differently (Number(undefined) is NaN, Number(null)
    // is 0), and that difference is frozen — see the model's norm_index.
    // `hasOld`/`oldDisconnected` are asked speculatively because the model needs
    // them alongside the token it is about to normalize.
    const guess = session.normIndexOf(msg);
    const plan = session.claimPlan({
      hello: msg, fromId,
      hasOld: guess !== null && this.flow.has(guess),
      oldDisconnected: guess !== null && this.flow.isDisconnected(guess)
    });
    if (!plan.claim) return false;
    const oldId = plan.oldId;
    this.fastlane.close(oldId);
    this.fastlane.close(fromId);
    this.flow.rekey(oldId, fromId); // moves the seat record (+ last-seen stamp), marks it reconnected
    // The carried stamp is from before the drop (> timeout old), so without this
    // the reclaimed seat would expire again on the very next tick.
    if (plan.restamp) this.flow.onSeen(fromId, Date.now());
    this.onPlayerRekey(oldId, fromId); // move their still-racing car onto the new slot
    this._clearReconnect(oldId);
    this._clearReconnect(fromId);
    return true;
  }

  // A mid-race drop reserves the seat for the WHOLE race — no give-up timer. The
  // slot, its livery/car and the claim QR are held until the player returns
  // (same-device reconnect or a QR claim) or the room comes back to the lobby,
  // where _freeDisconnectedSeats sweeps whoever never made it back. Reserving for
  // the race (rather than a fixed window) is the HexStacker model: a fixed grid
  // with a live car should keep a blipped racer's place for the length of the
  // race, and only reclaim the slot once it's a lobby seat again.
  _showReconnect(peerIndex) {
    const p = this.flow.get(peerIndex);
    if (!p) return;
    this._reconnectSeats.set(peerIndex,
      session.reconnectCard(p, session.claimUrl(this._joinUrl(), peerIndex)));
    this.onReconnectChange([...this._reconnectSeats.values()]);
  }

  _clearReconnect(peerIndex) {
    if (this._reconnectSeats.delete(peerIndex)) this.onReconnectChange([...this._reconnectSeats.values()]);
  }

  // Returning to the lobby, free every seat still flagged disconnected: the race
  // that reserved them is over, and a lobby ghost with a dead reconnect QR would
  // just block one of the four slots. Whoever wants back in scans the lobby's own
  // join QR. (A cup's RESULTS→COUNTDOWN chain never passes through LOBBY, so a
  // blipped racer's seat rides through the intermission into the next race.)
  _freeDisconnectedSeats() {
    for (const p of this.flow.list()) {
      if (this.flow.isDisconnected(p.peerIndex)) this._expireSeat(p.peerIndex);
    }
  }

  // ---- outbound protocol ----
  // The room's single outbound message: the retained host snapshot (relay
  // set_state). The relay pushes it live to every controller and replays it right
  // after `joined`, so a (re)joining phone recovers its whole state — identity,
  // roster, selection, results, and the chooser content — from the replay alone.
  // There is no per-phone WELCOME: the controller funnels the replayed/pushed
  // replayed/pushed snapshot into their existing LOBBY_UPDATE handler.
  // The COMPOSITION is the session model's — including the rule three shells
  // must not each re-author, that the bulky track schematics ride the LOBBY
  // snapshot only (the picker is shown nowhere else, and the whole blob has to
  // fit the relay's 16 KiB set_state cap). The chooser content itself was handed
  // over once at construction. This side supplies the room's live fields and
  // puts the answer on the relay.
  //
  // RETURNS the snapshot, because _announce needs its `players` and composing
  // that array twice is composing it once too often. Built even with no socket
  // (boot and teardown, where the roster still has to reach our own UI); only
  // the send is gated.
  _publishLobby() {
    const list = this.flow.list();
    const snapshot = session.lobbySnapshot({
      hostPeerIndex: this.flow.host,
      roomState: this.roomState,
      paused: !!this.isPaused(),
      roster: list,
      inRace: list.map((p) => !!this.inRace(p.peerIndex)),
      mode: this.mode,
      cupId: this.cupId,
      randomRaces: this.randomRaces, // 'random' run length (0 = endless)
      trackId: this.trackId,         // resolved concrete track
      standings: this._standings      // results board (playing/results), else null
    });
    if (this.party) this.party.setState(snapshot);
    return snapshot;
  }

  // Mirror the latest standings board into the snapshot (display drives this on
  // each finish + at race end; cleared on lobby return). Republishes so the change
  // reaches live controllers and every later (re)joiner.
  setStandings(board) {
    this._standings = board || null;
    this._publishLobby();
  }

  // Public nudge for the game layer to republish the snapshot when a field it owns
  // changes without a roster/state event (manual pause, mid-race car forfeit/rekey).
  syncState() { this._publishLobby(); }

  // Replace the chooser content the snapshot carries. It is normally authored
  // data set once at construction — which is why the session model holds it
  // rather than being handed 4 KB of it on every publish — so this exists for
  // the cases where it genuinely changes: a shell that loads its catalogue
  // late, and the wire-compat fixture that pushes an oversize one to prove the
  // relay's 16 KiB cap actually bites. Republishes, like every other writer.
  setChooser({ cars, colors, tracks } = {}) {
    if (cars) this.carChooser = cars;
    if (colors) this.colorPalette = colors;
    if (tracks) this.trackChooser = tracks;
    session.configure({ cars: this.carChooser, colors: this.colorPalette, tracks: this.trackChooser });
    this._publishLobby();
  }

  // Reset the lobby pick to the pre-pick state (End party → fresh room: the
  // next party must not inherit the old party's cup). The retained snapshot
  // republishes with the cleared values when the fresh room comes up.
  clearPick() { this.mode = null; this.cupId = null; this.randomRaces = 0; this.trackId = null; }

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
  _joinUrl() { return session.joinUrl(this._baseUrl(), this.roomCode, this.instance); }
  // Controller-URL template registered with the relay on room create. The relay
  // fills {room}/{instance} and hands the result to anyone holding only the room
  // code (native shells via GET /room/:code, controllers in `joined`), so a
  // code-only join can resolve which page to load. Mirrors the _joinUrl() shape
  // (instance in the fragment, kept out of request logs). The relay accepts only
  // absolute https templates and rejects the whole create on an invalid one, so
  // plain-http origins (local dev, e2e) register none.
  _controllerUrlTemplate() {
    // null == register NONE. party.create takes `undefined` for that, so the
    // model's null is translated once, here, rather than the model learning
    // about a JS-only value.
    return session.controllerUrlTemplate(this._baseUrl()) || undefined;
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
// <span class="ticket__cd"> so it reads in the accent colour. The code is the
// last path segment (e.g. the BZK4 in tinytrack.party/BZK4). CSS makes that
// span a block, so the host and the code land on separate lines. Built with
// DOM nodes (not innerHTML) so the code is always treated as text.
export function renderJoinUrl(el, fullText, code) {
  el.textContent = '';
  if (code && fullText.endsWith(code)) {
    el.append(fullText.slice(0, fullText.length - code.length));
    const span = document.createElement('span');
    span.className = 'ticket__cd';
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
// Stage.setCarReconnect / _loop). Reuses the .cell-finish chrome (frosted
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
