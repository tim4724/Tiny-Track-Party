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

// The record cache's invalidation clock (see NativeRoomFlow._record). Bumped by
// EVERY ABI call that is not a pure read, and the wrapping below is why it is
// module-level rather than per-room: a counter that a method has to remember to
// advance is a counter that goes stale the first time someone adds a method. A
// second room only over-invalidates, which costs a readback and never a wrong
// answer.
let gen = 0;

// The ABI calls that cannot change a record. Everything absent from this set is
// wrapped to bump `gen` — the safe default, since a missed mutator serves stale
// data while a needless bump only re-reads.
const PURE_READS = new Set([
  'state', 'host', 'size', 'connectedCount', 'list', 'has', 'isDisconnected',
  'get', 'events', 'version'
]);

export async function init() {
  if (M) return;
  M = await loadNativeRuntime();
  const c = (name, ret, args) => M.cwrap(name, ret, args);
  // ONLY what this shell still calls. The C ABI keeps the full ttp_party.h
  // surface (the walks call it internally, the corpora replay it, and tests
  // bind it raw); a wrapper here with no caller is a wrapper the next shell
  // copies for nothing — sixteen of them went when the walks landed.
  fn = {
    create: c('ttp_room_create', 'number', ['string']),
    dispose: c('ttp_room_dispose', null, ['number']),
    addPlayer: c('ttp_room_add_player', 'string', ['number', 'string', 'string']),
    rekey: c('ttp_room_rekey', 'number', ['number', 'string', 'string']),
    setField: c('ttp_room_set_field', 'number', ['number', 'string', 'string', 'string']),
    transitionTo: c('ttp_room_transition_to', 'number', ['number', 'string']),
    state: c('ttp_room_state', 'string', ['number']),
    onSeen: c('ttp_room_on_seen', null, ['number', 'string', 'number']),
    setMaster: c('ttp_room_set_master', null, ['number', 'string']),
    setLivenessEnabled: c('ttp_room_set_liveness_enabled', null, ['number', 'number']),
    host: c('ttp_room_host_json', 'string', ['number']),
    size: c('ttp_room_size', 'number', ['number']),
    connectedCount: c('ttp_room_connected_count', 'number', ['number']),
    list: c('ttp_room_list_json', 'string', ['number']),
    has: c('ttp_room_has', 'number', ['number', 'string']),
    isDisconnected: c('ttp_room_is_disconnected', 'number', ['number', 'string']),
    get: c('ttp_room_get_json', 'string', ['number', 'string']),
    events: c('ttp_room_events_json', 'string', ['number']),
    version: c('ttp_party_version', 'string', [])
  };
  for (const [name, f] of Object.entries(fn)) {
    if (PURE_READS.has(name)) continue;
    fn[name] = (...a) => { gen++; return f(...a); };
  }
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
  // instead of being handed a copy of it: ttp_net_lobby_frame composes the
  // retained snapshot off it, ttp_ui_roster_seats_room_json draws the seat grid
  // off it. NOT a kit method — the kit's rooms are JS objects with nothing to
  // name. 0 once disposed, which every reader treats as an empty room.
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
  // discipline has to wrap it: providers pushed first, the record-cache clock
  // bumped (the walk is not in this file's fn table, so the automatic wrapping
  // cannot see it), and the queued events re-fired — BEFORE the caller performs
  // the walk's effects, which reproduces the old inline order (the announce a
  // mutation used to fire mid-walk lands before the walk's trailing sends).
  runWalk(call) {
    this._syncProviders();
    const raw = call();
    this.walkMutated();
    return raw;
  }

  // The bookkeeping half of runWalk, on its own for the one caller that runs
  // the walk first and only pays this when the answer proves something moved
  // (DisplayNet._seen's hot path).
  walkMutated() { gen++; this._drain(); }

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
  //
  // ONE READBACK PER GENERATION, not per property. ttp_room_get_json serializes
  // the WHOLE record, so an unmemoized proxy charged a full serialize + parse
  // (~1.6 us) for every `p.ready` — and `{...p}` pays it twice more via ownKeys
  // and getOwnPropertyDescriptor. The cache is keyed on the room's mutation
  // counter rather than on time, so it is exactly as live as the uncached
  // version was: anything that can move a record bumps `gen` and the next read
  // re-fetches. Writes bump it too, so `p.ready = true; p.ready` still reads
  // back through wasm and cannot observe a value the C++ refused.
  _record(peerIndex) {
    const pj = idJson(peerIndex);
    const h = this._h;
    let cachedGen = -1, cached = null;
    const snap = () => {
      if (cachedGen !== gen) { cached = JSON.parse(fn.get(h, pj)); cachedGen = gen; }
      return cached;
    };
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

  rekey(oldId, newId) {
    this._syncProviders();
    const ok = fn.rekey(this._h, idJson(oldId), idJson(newId)) === 1;
    this._drain();
    return ok;
  }

  // ---- lifecycle ------------------------------------------------------------
  transitionTo(state) {
    this._syncProviders();
    const ok = fn.transitionTo(this._h, state) === 1;
    this._drain();
    return ok;
  }

  returnToLobby() { return this.transitionTo('lobby'); }

  // ---- liveness (a pure stamp — nothing to drain) ---------------------------
  onSeen(peerIndex, nowMs) { fn.onSeen(this._h, idJson(peerIndex), nowMs); }

  // (The rest of the roster/liveness surface — remove/mark/expire/grace/
  // active-order and the participants predicate — has no wrapper anymore: the
  // walks and the ui twins run those rules inside the wasm.)

  // ---- reads ---------------------------------------------------------------
  // `host`, `state`, `size`, `connectedCount` are GETTERS in the kit contract.
  get host() { return JSON.parse(fn.host(this._h)); }
  get state() { return fn.state(this._h); }
  get size() { return fn.size(this._h); }
  get connectedCount() { return fn.connectedCount(this._h); }

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
}
