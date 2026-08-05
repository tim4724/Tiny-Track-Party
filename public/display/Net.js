// DisplayNet — owns the relay connection, RoomFlow roster/host machine, and the
// controller<->display message protocol. The display is slot 0 and authoritative.
// Game logic/rendering live elsewhere; this module is transport + lobby only.
//
// Reads partyplug + protocol globals set by the classic <script> tags that load
// before this module (PartyConnection, RELAY_URL, LIVENESS). The room state
// machine is NOT a global any more: it arrives as opts.RoomFlowImpl. Room state
// is owned by the RoomFlow machine (see the `roomState` getter).
import { GameNet } from '../shared/GameNet.js';
// The SESSION CHOREOGRAPHY is C++ (ttp_net.h over libttp-party). Every inbound
// trigger — a relay protocol frame, a peer message, the socket closing, the
// liveness tick, a drained hostchange/statechange event — routes to ONE walk
// entry point that performs the room mutations inside the wasm and answers an
// ORDERED effect list of platform ops. This file performs those ops against
// the socket, the three timers, sessionStorage, the fastlane and the game
// layer's callbacks, and decides nothing: _performNetEffect below is the whole
// remaining shape of what used to be the protocol switch, the peer switch, the
// seat lifecycle, the reconnect claim and the mode pick. The JS twin
// (sessionModel.js) survives only as the oracle session-corpus.jsonl was
// recorded from; the walks are gated by abi_check's netWalksMatchMultiCallPath
// against the fine-grained exports this file used to sequence by hand.
import * as session from './NativeSessionModel.js';
// The sharded dial URL, from the same encoder party.pinInstance calls. This file
// used to build that string by hand eleven lines above asking C++ for it.
import { pinUrl } from './NativePartyConnection.js';

const { PartyConnection, RELAY_URL, CAR_COLORS, LIVENESS } = window;

const enc = encodeURIComponent;

// Presence windows. The manifest numbers this shell still SPENDS itself: the
// detection windows feed RoomFlow at construction, and the tick rate arms the
// one interval the start-liveness effect asks for. The create watchdog's delay
// is no longer read here — it rides the arm-create-watchdog effect, from the
// same manifest entry via protocol.h. __abandonGraceMs is the E2E hook that
// shortens the wait, and it is the one platform-flavoured part — an override
// of a manifest number, not a second declaration of it.
const LIVENESS_TIMEOUT_MS = LIVENESS.TIMEOUT_MS;
const ABANDONED_RACE_GRACE_MS = window.__abandonGraceMs || LIVENESS.ABANDONED_RACE_GRACE_MS;
const LIVENESS_TICK_MS = LIVENESS.TICK_MS;

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

// The walks' shared no-op answer. Compared as BYTES on the hot path (_seen —
// fastlane input rides through it), so the common case skips the parse AND the
// event drain; same trick as NativeRaceSession._drain's '[]'.
const EMPTY_EFFECTS = '{"effects":[]}';

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

// The net walks' performers, one per op of ttp_net_effect_ops_json. A TABLE
// rather than a switch so the coverage is checkable data: assertNetOps holds it
// to the wasm's vocabulary at construction, turning a missing arm into a boot
// failure instead of a silently half-set-up room mid-party.
const NET_PERFORMERS = {
  'clear-create-timer': (n) => clearTimeout(n._createTimer),
  // A socket that opens but never gets a created/joined answer would hang
  // forever — no close event ever fires — so the walk arms a watchdog and
  // the expiry asks C++ whether the attempt is still unanswered.
  'arm-create-watchdog': (n, e) => {
    clearTimeout(n._createTimer);
    n._createTimer = setTimeout(() => {
      n._walk(n.flow.runWalk(() => session.createTimeout(n.flow.handle)));
    }, e.delayMs);
  },
  'join-room': (n, e) => n.party.join(e.room),
  'create-room': (n, e) => n.party.create(e.maxClients, n._controllerUrlTemplate()),
  'pin-instance': (n, e) => n.party.pinInstance(RELAY_URL, e.room, e.instance),
  'save-room': (n, e) => {
    n.roomCode = e.room;
    n.instance = e.instance;
    n._saveRoom();
  },
  'forget-room': (n) => {
    n._forgetRoom();
    n.roomCode = null;
    n.instance = null;
  },
  'room-ready': (n, e) => n.onRoomReady({ roomCode: e.room, joinUrl: n._joinUrl() }),
  // The timer guard is all that is left of _startLiveness: the in-flight
  // heartbeat reset that had to precede it happens inside the wasm, on the
  // created/joined walk itself.
  'start-liveness': (n) => {
    if (!n._livenessTimer) n._livenessTimer = setInterval(() => n._livenessTick(), LIVENESS_TICK_MS);
  },
  'reset-reconnect-count': (n) => n.party.resetReconnectCount(),
  'connect-fresh': (n) => n._connect(),
  'fail-attempt': (n) => n.party.failAttempt(),
  'reconnect': (n) => n.party.reconnectNow(),
  // The frame data arrives composed (PONG, the self-heartbeat) — this side
  // puts it on the socket and adds nothing.
  'send-to': (n, e) => n.party.sendTo(e.to, e.data),
  'publish': (n) => n._publishLobby(),
  'announce': (n) => n._announce(),
  'close-fastlane': (n, e) => n.fastlane.close(e.peerIndex),
  // The claim URL needs this shell's base origin (D3), so it is spliced
  // here; the card payload and the DIFF over the set stay C++'s.
  'show-reconnect': (n, e) => {
    n._reconnectSeats.set(e.seat.peerIndex,
      session.reconnectCard(e.seat, session.claimUrl(n._joinUrl(), e.seat.peerIndex)));
    n.onReconnectChange([...n._reconnectSeats.values()]);
  },
  'clear-reconnect': (n, e) => {
    if (n._reconnectSeats.delete(e.peerIndex)) n.onReconnectChange([...n._reconnectSeats.values()]);
  },
  'rekey-player': (n, e) => n.onPlayerRekey(e.oldId, e.newId),
  'player-renamed': (n, e) => n.onPlayerRenamed(e.peerIndex, e.name),
  'welcome-item': (n, e) => n.onPlayerWelcomed(e.peerIndex),
  'game-message': (n, e, ctx) => n.onControllerMessage(ctx.from, ctx.data),
  'race-abandoned': (n) => n.onRaceAbandoned(),
  'track-change': (n, e) => n.onTrackChange(e.trackId),
  'clear-standings': (n) => { n._standings = null; }
};

// The boot proof: every op this build's walks can emit has a performer. Run at
// DisplayNet construction — before any walk — so the next platform's port
// fails its first launch instead of dropping a step at a party.
function assertNetOps() {
  const missing = session.effectOps().filter((op) => !NET_PERFORMERS[op]);
  if (missing.length) throw new Error(`net effect ops with no performer: ${missing.join(', ')}`);
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
    // Fired when a SEATED player changes their name: (peerIndex, name). A rename
    // arrives as a re-HELLO — the launcher's setName, or a back-out and rejoin —
    // and the seat grid and the phones both recover from the snapshot _announce
    // republishes, so this exists for the surfaces a RACE froze at its start.
    this.onPlayerRenamed = opts.onPlayerRenamed || (() => {});
    // The live race's native session handle, or 0 between races. The one thing
    // this module hands the party layer for it to read the race itself: the
    // active participant set (_syncActiveOrder), each seat's inRace flag, and
    // the welcome-item predicate are all answered off it in C++. A shell that
    // has no session yet answers 0 and gets "no live race".
    this.sessionHandle = opts.sessionHandle || (() => 0);
    // Asked per publish: is the race manually paused? A rejoiner must re-raise
    // the pause overlay it missed while away, or its wheel just feels dead.
    this.isPaused = opts.isPaused || (() => false);
    // Fired by the welcome-item effect — a HELLO from a seat whose car is in
    // the live race (the predicate is C++'s, off the session handle). The game
    // layer relights the per-owner ITEM; everything else a (re)joiner needs
    // arrives via the snapshot replay.
    this.onPlayerWelcomed = opts.onPlayerWelcomed || (() => {});
    // Fired once when RoomFlow's abandoned-race deadline expires (see
    // ABANDONED_RACE_GRACE_MS): the race has no racer left and someone is waiting
    // for the next one. The game layer returns to the lobby.
    this.onRaceAbandoned = opts.onRaceAbandoned || (() => {});

    // Dropped seats currently offering a reconnect QR. peerIndex -> {peerIndex,
    // name, colorIndex, url}. Held for the whole race (no give-up timer); freed
    // on return to the lobby (the statechange walk) or a real socket close. The
    // SET is driven by show-reconnect/clear-reconnect effects; the claim URL is
    // composed here because it needs this shell's base origin (decision D3).
    this._reconnectSeats = new Map();

    this._livenessTimer = null; // armed by the start-liveness effect, 1 Hz

    // Track selector state. `tracks` is the catalog the display computed (id +
    // name + feature chips + schematic SVG); the PICK rules live in the wasm
    // and read the configured chooser, so this survives only as the
    // trackChooser fallback below.
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
    // across the boundary. The snapshot composition treats it as opaque; the
    // MODE PICK walk reads its `tracks` as the catalogue, which is what let
    // the pick rules cross at all.
    session.configure({ cars: this.carChooser, colors: this.colorPalette, tracks: this.trackChooser });
    assertNetOps();
    // Latest standings board, mirrored into the snapshot so a phone that reconnects
    // on the results screen (or after its car finished) recovers it by replay.
    // null outside a race; set via setStandings on each finish + at race end,
    // cleared by the statechange walk's clear-standings effect.
    this._standings = null;
    // The shuffle bag lives BEHIND THE ROOM; what this shell supplies is one
    // page-entropy seed at init_pick. hasBag false is the bagless test
    // surface, which refuses random picks outright (the walk's gate).
    this._hasBag = !!opts.hasBag;
    // NO PICK MIRROR. The lobby pick lives behind the room handle
    // (ttp_net_init_pick / pick_json): the walks write it, the lobby frame
    // reads it on every publish, and the game layer asks `this.pick` when it
    // needs one. This constructor only seeds the initial state — a default
    // track preselects mode 'track' — and stamps whether a bag is wired.

    // The room state machine — NativeRoomFlow (C++ decisions, kit surface),
    // injected so this module stays transport-focused.
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
    session.initPick(this.flow.handle,
      opts.defaultTrackId != null ? opts.defaultTrackId : null, this._hasBag,
      (Math.random() * 0x100000000) >>> 0);
    this.roomCode = null;   // mirror of the wasm's room identity; written only by
    this.instance = null;   // the save-room/forget-room effects (and _restoreRoom)
    this.clientId = null;   // slot-0 bearer secret; restored-or-minted in _restoreRoom
    this.baseUrlOverride = null;
    this._createTimer = null; // created/joined-answer watchdog (armed/cleared by effects)

    // Fastlane input counts as proof of life: a phone whose relay socket died
    // can still be driving over the open P2P channel — its car must not grow a
    // reconnect QR mid-corner.
    this._initFastlane(0, { onInput: (peerIdx, ev) => { this._seen(peerIdx); this.onControllerMessage(peerIdx, ev); } });

    // Re-broadcast roster to controllers + notify our own UI whenever it shifts.
    this.flow.on('rosterchange', () => this._announce());
    // The bodies of these two are C++ walks now: what a host promotion or a
    // phase flip implies (the ready-clear, the countdown restamp, the lobby
    // sweep of dropped seats, when to republish) is decided and MUTATED inside
    // the wasm; the effects that come back are performed like any other walk's.
    this.flow.on('hostchange', ({ hostPeerIndex }) => {
      this._walk(this.flow.runWalk(() =>
        session.hostChangeApply(this.flow.handle, hostPeerIndex)));
    });
    // Republish on every phase flip (the walk's plan always says publish): the
    // retained copy carries roomState, and a replay to a (re)joining phone must
    // never hand it a stale phase. Ready flags deliberately SURVIVE the race →
    // lobby round trip — see session.h's state_change_plan for the full why.
    this.flow.on('statechange', ({ to }) => {
      this._walk(this.flow.runWalk(() =>
        session.stateChangeApply(this.flow.handle, to, Date.now())));
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
    // Hand the restored identity to the wasm, whose open walk is what decides
    // join-vs-create. The shell mirror above exists only to dial URLs.
    session.restoreRoom(this.flow.handle, this.roomCode || '', this.instance || '');
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
  // THE ROSTER NEVER BECOMES A JS VALUE. Publishing reads it off the room handle
  // in C++ (_publishLobby) and rendering reads it off the same handle in C++
  // (onRosterChange -> ui.rosterSeatsFromRoom), so this function passes a COUNT
  // and a host and nothing else.
  _announce() {
    this._publishLobby();
    this.onRosterChange(this.flow.size, this.flow.host);
  }

  // The active participant order — the seats this race is for, and by
  // subtraction who is a late joiner — is synced and read entirely inside the
  // wasm now: the net walks push it on their own ticks, and the ui twins
  // (auto-pause, standings) read it through the synced seam accessors in
  // ttp_room.h. This module holds no reader of its own anymore.

  // The game-message verdict (start/series-next/pause/resume/new-game), with
  // the host and all-ready gates inside — asked, never re-derived. CONTROL
  // does not come through here; main.js short-circuits it (input path).
  controllerAction(from, type) {
    return session.controllerAction(this.flow.handle, this.sessionHandle(), from, type);
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

    // The four socket callbacks, each one walk. The walks own join-vs-create,
    // the watchdog, the room-closed teardown order and the whole peer switch;
    // what stays here is the socket object and the console.
    this.party.onOpen = () => {
      this._walk(this.flow.runWalk(() => session.onOpen(this.flow.handle)));
    };
    this.party.onClose = (attempt, max, meta) => {
      this._walk(this.flow.runWalk(() =>
        session.onClose(this.flow.handle, !!(meta && meta.roomClosed))));
    };
    this.party.onProtocol = (type, msg) => {
      if (type === 'error') console.warn('[relay]', msg.message);
      this._walk(this.flow.runWalk(() =>
        session.onProtocol(this.flow.handle, type, msg, Date.now())));
    };
    this.party.onMessage = (from, data) => this._onMessage(from, data);
    this.party.connect();
  }

  _onMessage(from, data) {
    if (!data) return;
    // The fastlane consumes RTC signals; the walk still stamps liveness for
    // them (ANY traffic from a peer is proof of life) and then stops.
    const sig = this._isSignal(from, data);
    const ctx = { from, data };
    this._walk(this.flow.runWalk(() =>
      session.onPeerMessage(this.flow.handle, this.sessionHandle(), from, data,
        sig, Date.now())), ctx);
  }

  // The stored pick ({mode,cupId,randomRaces,trackId}), read where it lives.
  // One crossing per ask, at button-press frequency.
  get pick() { return session.pick(this.flow.handle); }
  // Field projections of the same read — the E2E surface (window.__net.mode
  // and friends) predates the stored pick and stays stable. Prefer `pick` in
  // game code: one crossing for all four fields.
  get mode() { return this.pick.mode; }
  get cupId() { return this.pick.cupId; }
  get trackId() { return this.pick.trackId; }
  get randomRaces() { return this.pick.randomRaces; }

  // Parse a walk's answer and perform its effects IN INDEX ORDER. The walk
  // already mutated the room; flow.runWalk drained the queued events first, so
  // the announce a mutation used to fire mid-walk has already landed. Nothing
  // here may reorder, batch or skip — several correctness constraints (the
  // close teardown order, set-pick before publish, rekey-player before
  // welcome-item) live in that order alone.
  //
  // `ctx` carries the one thing an effect names but the walk does not re-cross:
  // the triggering message (game-message hands it to the game layer). Only the
  // peer-message walks emit it, and both callers pass {from, data}.
  _walk(rawAnswer, ctx) {
    if (rawAnswer === EMPTY_EFFECTS) return { effects: [] };
    const ans = JSON.parse(rawAnswer);
    for (const e of ans.effects) this._performNetEffect(e, ctx);
    return ans;
  }

  // A race walk's answer may carry net-vocabulary ops in place (the executor
  // merges the set-track tail); main.js's applyEffect falls through to here.
  performEffect(e, ctx = {}) { this._performNetEffect(e, ctx); }

  _performNetEffect(e, ctx) {
    const perform = NET_PERFORMERS[e.op];
    // An op this build cannot perform is a MISSING CAPABILITY, not an optional
    // step — and assertNetOps below turns this throw into a BOOT failure by
    // holding this table to the wasm's own vocabulary before any walk runs.
    if (!perform) throw new Error(`net: unperformable effect ${e.op}`);
    perform(this, e, ctx);
  }

  // Game-layer track swap that keeps mode/cupId as they are: the series engine
  // advancing to a cup's next race, or the lobby re-drawing a random pick. The
  // walk shares the mode pick's gates and tail (catalogue membership, same-pick
  // no-op, set-pick + publish + preview swap), so trackId always flows out the
  // same way.
  setTrack(id) {
    this._walk(this.flow.runWalk(() => session.setTrack(this.flow.handle, id)));
  }

  // ---- liveness (1 Hz) ----
  // Record proof of life for a peer outside the message path — fastlane input.
  // The walk also lifts a dropped seat back to connected (a phone can go silent
  // and resume WITHOUT its socket ever closing) and is the single writer that
  // lifts disconnection; the message walks run the same C++ internally.
  _seen(peerIndex) {
    const raw = session.onSeen(this.flow.handle, peerIndex, Date.now());
    // Hot path: this rides every fastlane input event, and the common answer is
    // the shared empty list — the stamp moved no record and queued no event, so
    // skip the parse and the drain entirely.
    if (raw === EMPTY_EFFECTS) return;
    this.flow.walkMutated();
    this._walk(raw);
  }

  _livenessTick() {
    if (!this.party) return;
    // The whole tick is one walk: the self-heartbeat state machine (in-flight
    // pair lives in the wasm), then on a sweep the expiry drops, the
    // active-order re-sync and the abandoned-race deadline, in that order on
    // one clock reading.
    this._walk(this.flow.runWalk(() =>
      session.liveness(this.flow.handle, this.sessionHandle(), Date.now())));
  }

  // ---- outbound protocol ----
  // The room's single outbound message: the retained host snapshot (relay
  // set_state). The relay pushes it live to every controller and replays it right
  // after `joined`, so a (re)joining phone recovers its whole state — identity,
  // roster, selection, results, and the chooser content — from the replay alone.
  // There is no per-phone WELCOME: the controller funnels the replayed/pushed
  // snapshot into their existing LOBBY_UPDATE handler.
  //
  // NOTHING ABOUT A SEAT CROSSES. The roster, the effective host, the room phase
  // and every seat's "does this seat hold a car in the live race" are read off
  // the two HANDLES in C++ (ttp_net_lobby_frame over ttp_room.h's seam); what is
  // passed here is the six fields only the game knows. The answer is the finished
  // frame text, so the socket write is the next statement and there is no object
  // in between. (~169.6 us -> 44.4 us a publish in the browser at the 4-player
  // cap when the round trip through this file was removed; most of what was
  // being re-read is the ~5.9 KB `tracks` chooser payload.)
  //
  // DELIBERATELY NOT re-routed through ttp_framing_encode_set_state: that
  // encoder takes the snapshot as an argument, which would put the roster back
  // on the boundary this call exists to keep it off.
  _publishLobby() {
    if (!this.party) return;
    // The pick is not here: the frame reads the stored one off the handle.
    this.party.setStateFrame(session.lobbyFrame(this.flow.handle, this.sessionHandle(), {
      paused: !!this.isPaused(),
      standings: this._standings      // results board (playing/results), else null
    }));
  }

  // Mirror the latest standings board into the snapshot (display drives this on
  // each finish + at race end; cleared on lobby return). Republishes so the change
  // reaches live controllers and every later (re)joiner.
  setStandings(board) {
    this._standings = board || null;
    this._publishLobby();
  }

  // Is a board currently in the retained snapshot? A live rename refreshes the
  // one that is out (it carries player NAMES) but must never publish the first:
  // phones raise their results overlay on a non-null standings, so a board pushed
  // before anyone has crossed the line pops an empty one over every wheel.
  hasStandings() { return this._standings != null; }

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
    assertNetOps();
    this._publishLobby();
  }

  // Reset the lobby pick to the pre-pick state (End party → fresh room: the
  // next party must not inherit the old party's cup). The retained snapshot
  // republishes with the cleared values when the fresh room comes up.
  clearPick() { session.clearPick(this.flow.handle); }

  // End the party for everyone: the relay deletes the room (stale rejoin links
  // 404) and closes every socket with 4001 — phones bail terminally (their
  // onClose {roomClosed}), while the display's own 4001 self-heals into a fresh
  // room (the room-closed walk). For a page exit use shutdown() instead,
  // which suppresses that self-heal.
  closeRoom() { if (this.party) this.party.closeRoom(); }

  // Page-exit teardown (pagehide): the party is over for everyone, so tear the
  // room down (phones bail terminally instead of waiting out the relay's ~2 min
  // hostless grace) and stop reconnecting — party.close() also detaches the
  // socket handlers, so our own 4001 echo can't fire the room-closed walk and
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

  // A message from a LOCAL controller — a gamepad plugged into the TV
  // (Gamepads.js) — routed through the SAME walk a relayed one takes, so every
  // seat, ready, car-pick and start gate stays where it is decided (C++) rather
  // than being re-derived for a second kind of controller. The only difference
  // is that nothing came off a socket: the id is a local one (a string, so it
  // can never collide with a relay peer index) and sendTo below drops the
  // per-seat sends that would otherwise be addressed to nobody.
  localMessage(peerIndex, data) { this._onMessage(peerIndex, data); }

  // Proof of life for a local seat. Same walk the fastlane's input path stamps
  // with: it keeps a pad that is sitting still off the liveness sweep, and lifts
  // its own seat back to connected if the pad returns before the grace expires.
  noteSeen(peerIndex) { this._seen(peerIndex); }

  broadcast(data) { if (this.party) this.party.broadcast(data); }
  // The relay addresses NUMERIC peer slots, so a per-seat send to a local seat
  // (a gamepad's 'pad-N') would be addressed to nobody. Those seats need none of
  // it either: the ITEM light and the reconnect card are phone chrome, and a pad
  // player reads the TV.
  sendTo(id, data) { if (this.party && typeof id === 'number') this.party.sendTo(id, data); }
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
  // (instance in the fragment, kept out of request logs; the same `cpp=web`
  // declaration, since a typed code must reach the launcher knowing as much as a
  // scanned QR does — see NativeSessionModel). The relay accepts only
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
  el.classList.add('is-in'); // the lobby ticket fades its content in on first render
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
  canvas.classList.add('is-in'); // see renderJoinUrl — inert everywhere but the ticket
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
