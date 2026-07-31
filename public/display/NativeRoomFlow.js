// NativeRoomFlow — the room state machine's ONLY implementation: the C++ port
// (native/libttp-party) compiled to WASM, reached through native/runtime/
// ttp_party.h via engine/native/ttp_runtime.mjs. display/main.js awaits init()
// before net.start() and DisplayNet constructs this; there is no JS RoomFlow to
// fall back to (PR #39 deleted it — git history has it).
//
// The room is MUTATED BY THE WALKS (ttp_net.h): every inbound trigger goes
// through DisplayNet's one call into the wasm, which drives the machine
// internally. What this class still owns is the plumbing around that: the
// handle, the event re-fire (the C++ RoomFlow emits through a callback; the
// ABI queues instead, and every mutation drains the queue to on(...) listeners
// in order), the provider mirrors, and the few direct reads and writes the
// shell and its test surfaces make (roster list, host, phase, seeding a solo
// player). The mutable-record Proxy that used to live here served a kit
// contract (`flow.get(p).ready = true`) that no caller has used since the
// walks landed; a roster read is `list()` now, plain data the caller owns.

import { loadNativeRuntime } from './nativeRuntime.js';

let M = null;   // the instantiated emscripten module (shared with the sim ABI)
let fn = null;  // cwrap'd party ABI

export async function init() {
  if (M) return;
  M = await loadNativeRuntime();
  const c = (name, ret, args) => M.cwrap(name, ret, args);
  // ONLY what this shell still calls. A wrapper here with no caller is a
  // wrapper the next shell copies for nothing.
  fn = {
    create: c('ttp_room_create', 'number', ['string']),
    dispose: c('ttp_room_dispose', null, ['number']),
    addPlayer: c('ttp_room_add_player', 'string', ['number', 'string', 'string']),
    setField: c('ttp_room_set_field', 'number', ['number', 'string', 'string', 'string']),
    transitionTo: c('ttp_room_transition_to', 'number', ['number', 'string']),
    state: c('ttp_room_state', 'string', ['number']),
    setMaster: c('ttp_room_set_master', null, ['number', 'string']),
    setLivenessEnabled: c('ttp_room_set_liveness_enabled', null, ['number', 'number']),
    host: c('ttp_room_host_json', 'string', ['number']),
    list: c('ttp_room_list_json', 'string', ['number']),
    events: c('ttp_room_events_json', 'string', ['number']),
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
    // NOT nativeError: ttp_room_create has no refusal path (the handle counter
    // only ever increments), so there is no reason for it to have recorded and
    // reading one could only surface an unrelated failure. Kept as a guard
    // because a 0 here would mean the ABI changed under us.
    if (!this._h) throw new Error('ttp_room_create returned no handle');
    this._listeners = {};
    // Providers are read LIVE in JS (the C++ side holds settable values), so
    // mirror them across before each op that can consult them.
    this._masterProvider = opts.masterProvider || null;
    this._enabledProvider = (opts.liveness && opts.liveness.enabledProvider) || null;
  }

  // The wasm handle behind this room, for the ABIs that read a LIVE ROOM in C++
  // instead of being handed a copy of it: the net walks mutate it, the race
  // walks gather players and the pick off it, ttp_net_lobby_frame composes the
  // retained snapshot off it, ttp_ui_roster_seats_room_json draws the seat grid
  // off it. 0 once disposed, which every reader treats as an empty room.
  get handle() { return this._h; }

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

  // Run a ttp_net choreography walk (DisplayNet's entry points) against THIS
  // room. The walk mutates the roster inside the wasm, so the class's own
  // discipline has to wrap it: providers pushed first, and the queued events
  // re-fired — BEFORE the caller performs the walk's effects, which reproduces
  // the old inline order (the announce a mutation used to fire mid-walk lands
  // before the walk's trailing sends).
  runWalk(call) {
    this._syncProviders();
    const raw = call();
    this.walkMutated();
    return raw;
  }

  // The event re-fire half of runWalk, on its own for the one caller that runs
  // the walk first and only pays this when the answer proves something moved
  // (DisplayNet._seen's hot path).
  walkMutated() { this._drain(); }

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

  // ---- roster ---------------------------------------------------------------
  // The seeded record comes back as a plain snapshot the caller owns (or null
  // for a refused seat). Game fields are written at seat time via `fields`, or
  // afterwards with setField — the test surfaces' dresser.
  addPlayer(peerIndex, fields = {}) {
    this._syncProviders();
    const rec = fn.addPlayer(this._h, idJson(peerIndex), JSON.stringify(fields));
    this._drain();
    return rec === 'null' ? null : JSON.parse(rec);
  }

  // Write one opaque game field onto a live record (kit-owned keys refused).
  setField(peerIndex, key, value) {
    return fn.setField(this._h, idJson(peerIndex), String(key), JSON.stringify(value ?? null)) === 1;
  }

  // ---- lifecycle ------------------------------------------------------------
  transitionTo(state) {
    this._syncProviders();
    const ok = fn.transitionTo(this._h, state) === 1;
    this._drain();
    return ok;
  }

  returnToLobby() { return this.transitionTo('lobby'); }

  // ---- reads ---------------------------------------------------------------
  // `host`, `state`, `size` are GETTERS in the kit contract. size/has/
  // isDisconnected are folds over list() — announce-cadence reads, not worth
  // an export each.
  get host() { return JSON.parse(fn.host(this._h)); }
  get state() { return fn.state(this._h); }
  get size() { return this.list().length; }

  list() { return JSON.parse(fn.list(this._h)); }
  has(peerIndex) { return this.list().some((p) => p.peerIndex === peerIndex); }
  isDisconnected(peerIndex) {
    const p = this.list().find((x) => x.peerIndex === peerIndex);
    return !!p && p.connected === false;
  }

  dispose() {
    if (this._h) { fn.dispose(this._h); this._h = 0; }
  }
}
