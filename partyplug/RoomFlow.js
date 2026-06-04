'use strict';

// RoomFlow owns room state, roster identity/join order, presence, and host
// election. It does not own DOM, transport, countdown timers, or game fields
// like color/name/score; those are opaque data on the live player record.

(function (root, factory) {
  var RoomFlow = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = RoomFlow;
  } else {
    root.RoomFlow = RoomFlow;
  }
})(typeof self !== 'undefined' ? self : this, function () {

  var STATES = Object.freeze({
    LOBBY: 'lobby',
    COUNTDOWN: 'countdown',
    PLAYING: 'playing',
    RESULTS: 'results',
  });

  var VALID_TRANSITIONS = {};
  VALID_TRANSITIONS[STATES.LOBBY] = [STATES.COUNTDOWN];
  VALID_TRANSITIONS[STATES.COUNTDOWN] = [STATES.PLAYING, STATES.LOBBY];
  VALID_TRANSITIONS[STATES.PLAYING] = [STATES.RESULTS, STATES.LOBBY];
  VALID_TRANSITIONS[STATES.RESULTS] = [STATES.COUNTDOWN, STATES.LOBBY];

  function RoomFlow(opts) {
    opts = opts || {};
    // Optional () => peerIndex. When the transport designates a master
    // controller (AirConsole), supply it here. Returns null/undefined when
    // there is no platform master.
    this.masterProvider = typeof opts.masterProvider === 'function' ? opts.masterProvider : null;

    this.state = STATES.LOBBY;
    this.players = new Map();        // peerIndex -> player record
    this.hostPeerIndex = null;       // sticky host slot (raw; see `host` getter for effective)
    this._joinSeq = 0;               // monotonic joinedAt source (Date.now collides in same ms)
    this._disconnected = new Set();  // peerIndices currently in the disconnect window
    this._order = [];                // active participants (snapshotted on COUNTDOWN, or via setActiveOrder)
    this._listeners = {};
  }

  RoomFlow.STATES = STATES;

  // Lowest free dense slot in [0, max). Pass slot values, not peerIndices, so
  // sparse transport ids (e.g. AirConsole device_id) don't become color/seat ids.
  RoomFlow.lowestFreeSlot = function (used, max) {
    var taken = used instanceof Set ? used : new Set(used);
    for (var i = 0; i < max; i++) { if (!taken.has(i)) return i; }
    return -1;
  };

  // ---- tiny event emitter (dependency-free; portable Node + browser) ----
  RoomFlow.prototype.on = function (type, handler) {
    (this._listeners[type] = this._listeners[type] || []).push(handler);
    var self = this;
    return function () { self.off(type, handler); };
  };
  RoomFlow.prototype.off = function (type, handler) {
    var arr = this._listeners[type];
    if (!arr) return;
    var i = arr.indexOf(handler);
    if (i >= 0) arr.splice(i, 1);
  };
  RoomFlow.prototype._emit = function (type, detail) {
    var arr = this._listeners[type];
    if (arr) { var copy = arr.slice(); for (var i = 0; i < copy.length; i++) copy[i](detail); }
    var wild = this._listeners['*'];
    if (wild) { var w = wild.slice(); for (var j = 0; j < w.length; j++) w[j](type, detail); }
  };

  // =====================================================================
  // Roster
  // =====================================================================

  // Add a player, or reconnect/refresh an existing one (same peerIndex).
  // `fields` is opaque game data merged onto the record (name, color slot,
  // level, ...). RoomFlow adds peerIndex/joinedAt/connected and never reads
  // the game fields. Returns the live player record.
  RoomFlow.prototype.addPlayer = function (peerIndex, fields) {
    fields = fields || {};
    var existing = this.players.get(peerIndex);
    if (existing) {
      var prevHost = this.host;
      // Reconnect: keep slot / joinedAt / host, refresh presence + fields.
      // Protect kit-owned fields against a caller passing them in `fields`
      // (e.g. a serialized record round-tripped through JSON): joinedAt is the
      // host-election tiebreak and peerIndex is the map key — neither may be
      // clobbered by game data.
      var savedJoinedAt = existing.joinedAt;
      Object.assign(existing, fields);
      existing.joinedAt = savedJoinedAt;
      existing.peerIndex = peerIndex;
      existing.connected = true;
      this._disconnected.delete(peerIndex);
      if (this.host !== prevHost) this._emit('hostchange', { hostPeerIndex: this.host });
      this._emit('playerupdate', { player: existing });
      this._emit('rosterchange', { players: this.list() });
      return existing;
    }
    var player = Object.assign({}, fields, {
      peerIndex: peerIndex,
      joinedAt: this._joinSeq++,
      connected: true,
    });
    this.players.set(peerIndex, player);
    // First joiner owns the sticky host slot. Also covers the "room emptied
    // then someone joined" case (hostPeerIndex was reset to null).
    if (this.hostPeerIndex == null) {
      this.hostPeerIndex = peerIndex;
      this._emit('hostchange', { hostPeerIndex: this.host });
    }
    this._emit('playerjoin', { player: player });
    this._emit('rosterchange', { players: this.list() });
    return player;
  };

  // Hard leave (peer_left). The sticky slot only moves when the holder
  // departs from LOBBY/RESULTS; a mid-game leave leaves the slot untouched
  // so a reconnecting host reclaims it (the `host` getter falls back
  // meanwhile). hostchange fires whenever the EFFECTIVE host changes — including
  // a mid-game departure where the sticky slot stays put but the getter's
  // fallback shifts to a present player.
  RoomFlow.prototype.removePlayer = function (peerIndex) {
    if (!this.players.has(peerIndex)) return;
    var prevHost = this.host;
    var wasHost = peerIndex === this.hostPeerIndex;
    this.players.delete(peerIndex);
    this._disconnected.delete(peerIndex);
    var oi = this._order.indexOf(peerIndex);
    if (oi >= 0) this._order.splice(oi, 1);
    if (wasHost && (this.state === STATES.LOBBY || this.state === STATES.RESULTS)) {
      this.hostPeerIndex = this._electNextHost(peerIndex);
    }
    if (this.host !== prevHost) this._emit('hostchange', { hostPeerIndex: this.host });
    this._emit('playerleave', { peerIndex: peerIndex });
    this._emit('rosterchange', { players: this.list() });
  };

  // Re-key a player from one peerIndex to another. This is ONLY for cross-device
  // takeover: a different client (fresh clientId) claims a dropped player's
  // still-present slot and gets a new peerIndex from the relay. A same-client
  // reconnect keeps its index (the relay keys slots by clientId) and never needs
  // this. Preserves the record (incl. joinedAt) and rekeys host slot + order.
  RoomFlow.prototype.rekey = function (oldId, newId) {
    if (oldId === newId) return false;
    var rec = this.players.get(oldId);
    if (!rec) return false;
    var prevHost = this.host;
    this.players.delete(oldId);
    this.players.delete(newId); // drop the placeholder slot the returning peer got
    rec.peerIndex = newId;
    rec.connected = true;
    this.players.set(newId, rec);
    this._disconnected.delete(oldId);
    this._disconnected.delete(newId);
    for (var i = 0; i < this._order.length; i++) {
      if (this._order[i] === oldId) this._order[i] = newId;
    }
    // The slot wasn't moved when this player blipped mid-game, so if it still
    // points at the old peerIndex, rekey it so the reconnecting host resumes.
    // Only the host's own slot is rekeyed; a non-host claim never promotes
    // (when there's no sticky host, the `host` getter's oldest-eligible
    // fallback already picks the right player).
    if (this.hostPeerIndex === oldId) {
      this.hostPeerIndex = newId;
    }
    if (this.host !== prevHost) this._emit('hostchange', { hostPeerIndex: this.host });
    this._emit('rosterchange', { players: this.list() });
    return true;
  };

  // Soft disconnect window (the player record stays; presence flips false).
  // Emits hostchange if the effective host shifts (e.g. the host blips mid-game
  // and the getter's fallback hands duty to a present player).
  RoomFlow.prototype.markDisconnected = function (peerIndex) {
    var p = this.players.get(peerIndex);
    if (!p) return;
    var prevHost = this.host;
    p.connected = false;
    this._disconnected.add(peerIndex);
    if (this.host !== prevHost) this._emit('hostchange', { hostPeerIndex: this.host });
    this._emit('rosterchange', { players: this.list() });
  };

  RoomFlow.prototype.markReconnected = function (peerIndex) {
    var p = this.players.get(peerIndex);
    if (!p) return;
    var prevHost = this.host;
    p.connected = true;
    this._disconnected.delete(peerIndex);
    if (this.host !== prevHost) this._emit('hostchange', { hostPeerIndex: this.host });
    this._emit('rosterchange', { players: this.list() });
  };

  // Clear every disconnect flag, marking all current players present. Used at
  // game start / lobby return where stale blip flags must not suppress host
  // eligibility for the new round.
  RoomFlow.prototype.clearDisconnected = function () {
    if (this._disconnected.size === 0) return;
    var prevHost = this.host;
    this._disconnected.clear();
    for (var entry of this.players) entry[1].connected = true;
    if (this.host !== prevHost) this._emit('hostchange', { hostPeerIndex: this.host });
    this._emit('rosterchange', { players: this.list() });
  };

  // =====================================================================
  // Host election (DisplayState.getHostPeerIndex / electNextHost / reconcile)
  // =====================================================================

  // During COUNTDOWN/PLAYING/RESULTS the candidate set is restricted to the
  // active participants (the `_order`), so a late joiner can't be handed host
  // duty for menu actions they can't reach. Open to everyone in LOBBY.
  RoomFlow.prototype._restricted = function () {
    return (this.state === STATES.COUNTDOWN ||
            this.state === STATES.PLAYING ||
            this.state === STATES.RESULTS) && this._order.length > 0;
  };

  RoomFlow.prototype._isEligible = function (peerIndex, eligibleSet) {
    return peerIndex != null &&
      this.players.has(peerIndex) &&
      !this._disconnected.has(peerIndex) &&
      (eligibleSet == null || eligibleSet.has(peerIndex));
  };

  // Oldest-joined present player within eligibleSet (null = everyone present),
  // optionally skipping excludeId. Shared by the `host` getter (no exclusion)
  // and _electNextHost (excludes the departing holder).
  RoomFlow.prototype._oldestEligible = function (eligibleSet, excludeId) {
    var bestId = null, bestJoin = Infinity;
    for (var entry of this.players) {
      var id = entry[0];
      if (id === excludeId) continue;
      if (this._disconnected.has(id)) continue;
      if (eligibleSet != null && !eligibleSet.has(id)) continue;
      var ja = entry[1].joinedAt == null ? Infinity : entry[1].joinedAt;
      if (ja < bestJoin) { bestJoin = ja; bestId = id; }
    }
    return bestId;
  };

  // Effective host: platform master (if eligible) -> sticky host (if
  // eligible) -> oldest-joined eligible present player. Read-only; the
  // sticky slot is only mutated by removePlayer / rekey / reconcile.
  Object.defineProperty(RoomFlow.prototype, 'host', {
    get: function () {
      var restricted = this._restricted();
      var eligible = restricted ? new Set(this._order) : null;
      if (this.masterProvider) {
        var m = this.masterProvider();
        if (this._isEligible(m, eligible)) return m;
      }
      if (this._isEligible(this.hostPeerIndex, eligible)) return this.hostPeerIndex;
      return this._oldestEligible(eligible);
    },
  });

  RoomFlow.prototype.isHost = function (peerIndex) {
    return peerIndex != null && peerIndex === this.host;
  };

  // Oldest-joined present player other than excludeId. Restricted to the
  // participant order while in COUNTDOWN/PLAYING/RESULTS, so committing the
  // sticky slot can never promote a late joiner (who is not in `_order`) over
  // the actual game participants. Unrestricted in LOBBY, where everyone present
  // is a valid candidate. Returns null when nobody qualifies.
  RoomFlow.prototype._electNextHost = function (excludeId) {
    return this._oldestEligible(this._restricted() ? new Set(this._order) : null, excludeId);
  };

  // Commit any pending sticky-host handoff. Called when entering LOBBY or
  // RESULTS (the moments host duty is actually exercised: Start, Play Again).
  RoomFlow.prototype._reconcileStickyHost = function () {
    if (this.players.size === 0) return;
    var eligible = this._restricted() ? new Set(this._order) : null;
    if (this.hostPeerIndex != null &&
        this.players.has(this.hostPeerIndex) &&
        !this._disconnected.has(this.hostPeerIndex) &&
        (eligible == null || eligible.has(this.hostPeerIndex))) {
      return;
    }
    var prev = this.hostPeerIndex;
    this.hostPeerIndex = this._electNextHost(this.hostPeerIndex);
    if (this.hostPeerIndex !== prev) this._emit('hostchange', { hostPeerIndex: this.host });
  };

  // =====================================================================
  // Lifecycle
  // =====================================================================

  // Snapshot the current connected roster as the active participant order
  // (join order). Called automatically when entering COUNTDOWN.
  RoomFlow.prototype._snapshotOrder = function () {
    var active = [];
    for (var entry of this.players) {
      if (!this._disconnected.has(entry[0])) active.push(entry[1]);
    }
    active.sort(function (a, b) { return a.joinedAt - b.joinedAt; });
    this._order = active.map(function (p) { return p.peerIndex; });
  };

  // Let a game that maintains its own participant order (e.g. for board
  // layout) keep RoomFlow's host-eligibility set exactly in sync with it.
  RoomFlow.prototype.setActiveOrder = function (peerIndices) {
    var out = [];
    for (var i = 0; i < (peerIndices || []).length; i++) {
      if (this.players.has(peerIndices[i])) out.push(peerIndices[i]);
    }
    this._order = out;
  };

  // Validated state transition. Public so games that run their own countdown
  // (like HexStacker) can drive the machine imperatively; the high-level
  // helpers below call it too. Returns true if applied.
  RoomFlow.prototype.transitionTo = function (to) {
    var from = this.state;
    if (to === from) return true;
    var allowed = VALID_TRANSITIONS[from];
    if (!allowed || allowed.indexOf(to) < 0) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('RoomFlow: invalid transition ' + from + ' -> ' + to);
      }
      return false;
    }
    this.state = to;
    if (to === STATES.COUNTDOWN) this._snapshotOrder();
    if (to === STATES.LOBBY) this._order = [];
    if (to === STATES.LOBBY || to === STATES.RESULTS) this._reconcileStickyHost();
    this._emit('statechange', { from: from, to: to });
    return true;
  };

  // Lifecycle helpers — thin, validated transitions. The countdown itself is
  // game-owned (its visuals and controller messaging are game-flavored): a game
  // drives transitionTo(COUNTDOWN) -> run its own countdown -> transitionTo(PLAYING).

  // Readable sugar for `transitionTo('results')`. Results data is the game's
  // own (it knows the scoring); the kit does not store it.
  RoomFlow.prototype.endGame = function () {
    return this.transitionTo(STATES.RESULTS);
  };

  RoomFlow.prototype.returnToLobby = function () {
    return this.transitionTo(STATES.LOBBY);
  };

  // =====================================================================
  // Read accessors
  // =====================================================================

  // Roster as an array sorted by join order.
  RoomFlow.prototype.list = function () {
    var arr = [];
    for (var entry of this.players) arr.push(entry[1]);
    arr.sort(function (a, b) { return a.joinedAt - b.joinedAt; });
    return arr;
  };

  RoomFlow.prototype.get = function (peerIndex) { return this.players.get(peerIndex) || null; };
  RoomFlow.prototype.has = function (peerIndex) { return this.players.has(peerIndex); };

  Object.defineProperty(RoomFlow.prototype, 'size', {
    get: function () { return this.players.size; },
  });

  // Connected player count (what a lobby "Start (N)" button should show).
  Object.defineProperty(RoomFlow.prototype, 'connectedCount', {
    get: function () {
      var n = 0;
      for (var entry of this.players) { if (!this._disconnected.has(entry[0])) n++; }
      return n;
    },
  });

  RoomFlow.prototype.isDisconnected = function (peerIndex) { return this._disconnected.has(peerIndex); };

  // Reset to a fresh room (new room / return to welcome). Mirrors the
  // roster/host/state portion of DisplayState.resetRoomData.
  RoomFlow.prototype.reset = function () {
    var prevState = this.state;
    var hadHost = this.hostPeerIndex != null;
    // IMPORTANT: clear the Map in place — never reassign `this.players`.
    // Consumers may alias this exact Map object as their roster (HexStacker's
    // DisplayState does), so reassigning would leave them on a stale Map.
    this.players.clear();
    this._disconnected.clear();
    this._order = [];
    this.hostPeerIndex = null;
    this._joinSeq = 0;
    this.state = STATES.LOBBY;
    // Emit so event-driven consumers re-render on reset — every other state
    // change goes through transitionTo (which emits), so reset must too or a
    // game subscribed to statechange/rosterchange would miss the room wipe.
    if (prevState !== STATES.LOBBY) this._emit('statechange', { from: prevState, to: STATES.LOBBY });
    this._emit('rosterchange', { players: [] });
    if (hadHost) this._emit('hostchange', { hostPeerIndex: null });
  };

  return RoomFlow;
});
