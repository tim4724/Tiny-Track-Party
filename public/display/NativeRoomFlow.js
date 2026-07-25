// NativeRoomFlow — the room state machine's ONLY implementation: the C++ port
// (native/libttp-party) compiled to WASM, reached through native/runtime/
// ttp_party.h via engine/native/ttp_runtime.mjs. display/main.js awaits init()
// before net.start() and DisplayNet constructs this; there is no JS RoomFlow to
// fall back to (PR #39 deleted it — git history has it).
//
// The surface it reproduces is partyplug/RoomFlow's, because the kit's other
// consumers still expect that shape. Semantic parity is the conformance suite's
// job (36 behavioural scripts + 13 lowestFreeSlot cases, replayed against the C++
// objects by roomflow_check AND through this very ABI by tests/party-abi.test.js).
// THIS file's job is wiring parity: same getters-vs-methods shape, same event
// cadence, and — the subtle one — same MUTABLE player records.
//
// Two deliberate mechanics:
//
// 1. EVENTS. The C++ RoomFlow emits through a callback; the ABI queues instead.
//    Every mutating call here drains the queue and re-fires to on(...) listeners
//    in order. The kit emits all of an op's events AFTER its mutation completes
//    (RoomFlow.js), so draining once the call returns preserves both the order
//    and the state each handler observes.
//
// 2. LIVE RECORDS. The kit hands out mutable records and the display writes game
//    fields straight onto them (`flow.get(p).ready = true` — display/Net.js).
//    An ABI returns copies, so get() here returns a PROXY: property reads pass
//    through to the live wasm record, and writes go through ttp_room_set_field.
//    Without this, those assignments would land on a detached object and the
//    lobby would show stale names/car picks. list() returns plain snapshots —
//    it is a read-only path (roster announce, colour scan).

import { loadNativeRuntime } from './nativeRuntime.js';

let M = null;   // the instantiated emscripten module (shared with the sim ABI)
let fn = null;  // cwrap'd party ABI

export async function init() {
  if (M) return;
  M = await loadNativeRuntime();
  const c = (name, ret, args) => M.cwrap(name, ret, args);
  fn = {
    create: c('ttp_room_create', 'number', ['string']),
    dispose: c('ttp_room_dispose', null, ['number']),
    reset: c('ttp_room_reset', null, ['number']),
    addPlayer: c('ttp_room_add_player', 'string', ['number', 'string', 'string']),
    removePlayer: c('ttp_room_remove_player', null, ['number', 'string']),
    rekey: c('ttp_room_rekey', 'number', ['number', 'string', 'string']),
    setField: c('ttp_room_set_field', 'number', ['number', 'string', 'string', 'string']),
    markDisc: c('ttp_room_mark_disconnected', null, ['number', 'string']),
    markReconn: c('ttp_room_mark_reconnected', null, ['number', 'string']),
    clearDisc: c('ttp_room_clear_disconnected', null, ['number', 'number', 'number']),
    transitionTo: c('ttp_room_transition_to', 'number', ['number', 'string']),
    state: c('ttp_room_state', 'string', ['number']),
    setActiveOrder: c('ttp_room_set_active_order', null, ['number', 'string']),
    onSeen: c('ttp_room_on_seen', null, ['number', 'string', 'number']),
    isExpired: c('ttp_room_is_expired', 'number', ['number', 'string', 'number']),
    expiredPeers: c('ttp_room_expired_peers_json', 'string', ['number', 'number']),
    allDisc: c('ttp_room_all_participants_disconnected', 'number', ['number']),
    hasLateJoiners: c('ttp_room_has_late_joiners', 'number', ['number']),
    graceTick: c('ttp_room_grace_tick', 'number', ['number', 'number']),
    setMaster: c('ttp_room_set_master', null, ['number', 'string']),
    setLivenessEnabled: c('ttp_room_set_liveness_enabled', null, ['number', 'number']),
    host: c('ttp_room_host_json', 'string', ['number']),
    isHost: c('ttp_room_is_host', 'number', ['number', 'string']),
    size: c('ttp_room_size', 'number', ['number']),
    connectedCount: c('ttp_room_connected_count', 'number', ['number']),
    list: c('ttp_room_list_json', 'string', ['number']),
    has: c('ttp_room_has', 'number', ['number', 'string']),
    isDisconnected: c('ttp_room_is_disconnected', 'number', ['number', 'string']),
    get: c('ttp_room_get_json', 'string', ['number', 'string']),
    events: c('ttp_room_events_json', 'string', ['number']),
    lowestFreeSlot: c('ttp_room_lowest_free_slot', 'number', ['string', 'number']),
    version: c('ttp_party_version', 'string', [])
  };
  console.info(`[native:party] ${fn.version()}`);
}

// A peer index crosses the ABI as a JSON scalar (numeric 3 vs the string "3" are
// distinct room keys, exactly as in JS).
const idJson = (v) => JSON.stringify(v === undefined ? null : v);

export class NativeRoomFlow {
  constructor(opts = {}) {
    if (!fn) throw new Error('NativeRoomFlow: init() not awaited');
    const cfg = {};
    // Presence of `master` marks a masterProvider; the display passes none.
    if (opts.masterProvider) cfg.master = opts.masterProvider() ?? null;
    if (opts.liveness) {
      cfg.liveness = {};
      if (opts.liveness.timeoutMs !== undefined) cfg.liveness.timeoutMs = opts.liveness.timeoutMs;
      if (opts.liveness.graceMs !== undefined) cfg.liveness.graceMs = opts.liveness.graceMs;
      if (opts.liveness.enabledProvider) cfg.liveness.useEnabledProvider = true;
    }
    this._h = fn.create(JSON.stringify(cfg));
    if (!this._h) throw new Error('NativeRoomFlow: ttp_room_create failed');
    this._listeners = {};
    // Providers are read LIVE in JS (the C++ side holds settable values), so
    // mirror them across before each op that can consult them.
    this._masterProvider = opts.masterProvider || null;
    this._enabledProvider = (opts.liveness && opts.liveness.enabledProvider) || null;
  }

  // ---- events (same tiny emitter contract as the kit) -----------------------
  on(type, handler) {
    (this._listeners[type] = this._listeners[type] || []).push(handler);
    return () => this.off(type, handler);
  }

  off(type, handler) {
    const arr = this._listeners[type];
    if (!arr) return;
    const i = arr.indexOf(handler);
    if (i >= 0) arr.splice(i, 1);
  }

  // Drain the ABI queue and re-fire in emission order. Called after every
  // mutating op; a no-op when nothing was emitted.
  _drain() {
    const raw = fn.events(this._h);
    if (raw === '[]') return;
    for (const { type, detail } of JSON.parse(raw)) {
      for (const h of this._listeners[type] || []) h(detail);
      for (const h of this._listeners['*'] || []) h(type, detail);
    }
  }

  // Push the live provider values into the C++ side before an op reads them.
  _syncProviders() {
    if (this._masterProvider) fn.setMaster(this._h, idJson(this._masterProvider() ?? null));
    if (this._enabledProvider) fn.setLivenessEnabled(this._h, this._enabledProvider() ? 1 : 0);
  }

  // ---- live record view (see header note 2) ---------------------------------
  // Reads pass through to wasm so the record never goes stale; writes route to
  // ttp_room_set_field so the wasm roster stays the single source of truth.
  _record(peerIndex) {
    const pj = idJson(peerIndex);
    const h = this._h;
    const snap = () => JSON.parse(fn.get(h, pj));
    return new Proxy({}, {
      get: (_t, key) => {
        if (key === 'toJSON') return () => snap();
        const rec = snap();
        return rec ? rec[key] : undefined;
      },
      set: (_t, key, value) => {
        fn.setField(h, pj, String(key), JSON.stringify(value ?? null));
        return true;
      },
      has: (_t, key) => { const r = snap(); return !!r && key in r; },
      ownKeys: () => Object.keys(snap() || {}),
      getOwnPropertyDescriptor: (_t, key) => {
        const r = snap();
        if (!r || !(key in r)) return undefined;
        return { value: r[key], enumerable: true, configurable: true, writable: true };
      }
    });
  }

  // ---- roster ---------------------------------------------------------------
  addPlayer(peerIndex, fields = {}) {
    this._syncProviders();
    const rec = fn.addPlayer(this._h, idJson(peerIndex), JSON.stringify(fields));
    this._drain();
    return rec === 'null' ? null : this._record(peerIndex);
  }

  removePlayer(peerIndex) {
    this._syncProviders();
    fn.removePlayer(this._h, idJson(peerIndex));
    this._drain();
  }

  rekey(oldId, newId) {
    this._syncProviders();
    const ok = fn.rekey(this._h, idJson(oldId), idJson(newId)) === 1;
    this._drain();
    return ok;
  }

  markDisconnected(peerIndex) {
    this._syncProviders();
    fn.markDisc(this._h, idJson(peerIndex));
    this._drain();
  }

  markReconnected(peerIndex) {
    this._syncProviders();
    fn.markReconn(this._h, idJson(peerIndex));
    this._drain();
  }

  clearDisconnected(nowMs) {
    fn.clearDisc(this._h, nowMs === undefined ? 0 : 1, nowMs ?? 0);
    this._drain();
  }

  // ---- lifecycle ------------------------------------------------------------
  transitionTo(state) {
    this._syncProviders();
    const ok = fn.transitionTo(this._h, state) === 1;
    this._drain();
    return ok;
  }

  endGame() { return this.transitionTo('results'); }
  returnToLobby() { return this.transitionTo('lobby'); }

  setActiveOrder(peerIndices) {
    fn.setActiveOrder(this._h, JSON.stringify(peerIndices || []));
    this._drain();
  }

  reset() {
    fn.reset(this._h);
    this._drain();
  }

  // ---- liveness (pure predicates — nothing to drain) ------------------------
  onSeen(peerIndex, nowMs) { fn.onSeen(this._h, idJson(peerIndex), nowMs); }

  isExpired(peerIndex, nowMs) {
    this._syncProviders();
    return fn.isExpired(this._h, idJson(peerIndex), nowMs) === 1;
  }

  expiredPeers(nowMs) {
    this._syncProviders();
    return JSON.parse(fn.expiredPeers(this._h, nowMs));
  }

  allParticipantsDisconnected() { return fn.allDisc(this._h) === 1; }
  hasLateJoiners() { return fn.hasLateJoiners(this._h) === 1; }
  graceTick(nowMs) { return fn.graceTick(this._h, nowMs) === 1; }

  // ---- reads ---------------------------------------------------------------
  // `host`, `state`, `size`, `connectedCount` are GETTERS in the kit contract.
  get host() { return JSON.parse(fn.host(this._h)); }
  get state() { return fn.state(this._h); }
  get size() { return fn.size(this._h); }
  get connectedCount() { return fn.connectedCount(this._h); }

  isHost(peerIndex) { return fn.isHost(this._h, idJson(peerIndex)) === 1; }
  list() { return JSON.parse(fn.list(this._h)); }
  has(peerIndex) { return fn.has(this._h, idJson(peerIndex)) === 1; }
  isDisconnected(peerIndex) { return fn.isDisconnected(this._h, idJson(peerIndex)) === 1; }

  get(peerIndex) {
    if (!this.has(peerIndex)) return null;
    return this._record(peerIndex);
  }

  dispose() {
    if (this._h) { fn.dispose(this._h); this._h = 0; }
  }

  // Static parity with the kit (display/Net.js calls RoomFlow.lowestFreeSlot).
  static lowestFreeSlot(used, max) {
    const arr = used instanceof Set ? [...used] : Array.from(used || []);
    return fn.lowestFreeSlot(JSON.stringify(arr), max);
  }

  static STATES = { LOBBY: 'lobby', COUNTDOWN: 'countdown', PLAYING: 'playing', RESULTS: 'results' };
}
