'use strict';

// Shared plumbing for the wire-compat suite: the SHIPPED wasm on one side, the
// UNCHANGED JS kit + controller on the other, and a controllable clock between
// them.
//
// Two rules this file exists to enforce:
//
//  1. NOTHING HERE MAY BE A MOCK OF EITHER SIDE. The C++ comes from
//     public/display/engine/native/ttp_runtime.wasm — the artifact the browser
//     loads, not a fresh build — and the JS comes from partyplug/ and
//     public/controller/ unmodified. Everything this file fabricates is
//     TRANSPORT (a socket, a DataChannel, a clock, four DOM globals).
//  2. The browser globals are installed ONCE, process-wide, before any module
//     that reads them at import time. partyplug/*.js assign themselves onto
//     `window`; public/controller/Net.js destructures `window` at module scope.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', '..');
const ENGINE_DIR = path.join(ROOT, 'public/display/engine/native');
const MJS = path.join(ENGINE_DIR, 'ttp_runtime.mjs');
const WASM = path.join(ENGINE_DIR, 'ttp_runtime.wasm');

for (const f of [MJS, WASM]) {
  if (!fs.existsSync(f)) {
    throw new Error(`${path.relative(ROOT, f)} missing — run native/scripts/build-runtime-web.sh`);
  }
}

// ---------------------------------------------------------------------------
// The shipped wasm
// ---------------------------------------------------------------------------

let modulePromise = null;
function loadModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const factory = (await import(pathToFileURL(MJS).href)).default;
      return factory();
    })();
  }
  return modulePromise;
}

let abiPromise = null;
// The C ABI the display's adapters call, wrapped once. Deliberately the same
// cwrap signatures the adapters use, so a signature drift shows up here too.
function loadAbi() {
  if (!abiPromise) {
    abiPromise = (async () => {
      const M = await loadModule();
      const c = (n, ret, args) => M.cwrap(n, ret, args);
      return {
        M,
        framing: {
          create: c('ttp_framing_encode_create', 'string', ['string', 'number', 'string']),
          join: c('ttp_framing_encode_join', 'string', ['string', 'string']),
          sendTo: c('ttp_framing_encode_send_to', 'string', ['string', 'string']),
          broadcast: c('ttp_framing_encode_broadcast', 'string', ['string']),
          setState: c('ttp_framing_encode_set_state', 'string', ['string']),
          closeRoom: c('ttp_framing_encode_close_room', 'string', []),
          classify: c('ttp_framing_classify', 'string', ['string']),
          closeOutcome: c('ttp_framing_close_outcome', 'string', ['number', 'number', 'number', 'number', 'number']),
          backoff: c('ttp_framing_backoff_ms', 'number', ['number']),
          pinUrl: c('ttp_framing_pin_url', 'string', ['string', 'string', 'string']),
        },
        link: {
          create: c('ttp_link_create', 'number', []),
          dispose: c('ttp_link_dispose', null, ['number']),
          setOpen: c('ttp_link_set_channel_open', null, ['number', 'number']),
          enqueue: c('ttp_link_enqueue', 'string', ['number', 'string', 'number']),
          sendTick: c('ttp_link_send_tick', 'string', ['number', 'number']),
          idle: c('ttp_link_idle', 'string', ['number', 'number']),
          inbound: c('ttp_link_inbound', 'string', ['number', 'string', 'number']),
          stats: c('ttp_link_stats_json', 'string', ['number']),
        },
        sim: {
          begin: c('ttp_session_begin', 'number', ['string', 'number', 'number', 'string']),
          addHuman: c('ttp_add_human', null, ['number', 'string', 'string']),
          start: c('ttp_session_start', null, ['number', 'number']),
          update: c('ttp_update', null, ['number', 'number']),
          input: c('ttp_process_input', null, ['number', 'string', 'number', 'number', 'number', 'number']),
          snapshot: c('ttp_snapshot_json', 'string', ['number']),
          events: c('ttp_events_json', 'string', ['number']),
          dispose: c('ttp_dispose', null, ['number']),
        },
      };
    })();
  }
  return abiPromise;
}

// ---------------------------------------------------------------------------
// Browser globals (transport + four DOM leaves), installed once
// ---------------------------------------------------------------------------

let globalsInstalled = false;
// The relay the fake WebSocket constructor dials. Swapped per test so each gets a
// clean relay without reinstalling globals (which would re-evaluate nothing —
// the kit already captured `window`).
let activeRelay = null;

function setRelay(relay) {
  activeRelay = relay;
  return relay;
}

function installBrowserGlobals() {
  if (globalsInstalled) return;
  globalsInstalled = true;

  globalThis.window = globalThis.window || globalThis;

  // location — read by controller/Net.js's deriveRoomCode/deriveInstance/
  // deriveClaim, and by display/Net.js's _baseUrl/_controllerUrlTemplate/
  // _fetchBaseUrl. Mutable so a test can pose as a QR-claim URL.
  //
  // The origin is HTTPS on purpose: that is what prod is, and it is the only
  // configuration in which DisplayNet registers a controller-URL template with
  // the relay at all (_controllerUrlTemplate returns undefined for http, which
  // is why E2E has never taken that branch). The hostname is deliberately not
  // localhost, so _fetchBaseUrl short-circuits instead of reaching for fetch().
  globalThis.location = {
    pathname: '/WIRE',
    hash: '',
    search: '',
    hostname: 'wire-compat.invalid',
    origin: 'https://wire-compat.invalid',
    href: 'https://wire-compat.invalid/WIRE',
  };
  globalThis.window.location = globalThis.location;

  // localStorage — the phone's clientId store. Real semantics (strings only).
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
    _store: store,
  };
  globalThis.window.localStorage = globalThis.localStorage;

  // sessionStorage — the display's crash-recovery room blob (DisplayNet's
  // ROOM_KEY). Same semantics, separate store: a display that "reloads" must be
  // able to find its room again, and a fresh test must be able to clear it.
  const sess = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (sess.has(k) ? sess.get(k) : null),
    setItem: (k, v) => { sess.set(k, String(v)); },
    removeItem: (k) => { sess.delete(k); },
    clear: () => sess.clear(),
    _store: sess,
  };
  globalThis.window.sessionStorage = globalThis.sessionStorage;

  // The socket. One class, dialled at whatever relay is active.
  globalThis.WebSocket = class WireWebSocket {
    constructor(url) {
      if (!activeRelay) throw new Error('wire-compat: no relay installed (call setRelay first)');
      const Impl = activeRelay.webSocketClass();
      // Delegate rather than subclass: the relay's class captures ITS relay, and
      // handlers are assigned after construction, so a plain proxy would lose them.
      return new Impl(url);
    }
  };

  // WebRTC. ControllerNet opens a fastlane the moment it is `joined`, so without
  // this every relay test dies on "WebRTC not supported" — and a phone that never
  // reaches _openFastlane is not the phone that ships.
  require('./rtc.js').installFakeWebRTC();

  // The kit's classic scripts assign onto window on load.
  require('../../partyplug/PartyConnection.js');
  require('../../partyplug/PartyFastlane.js');

  const proto = require('../../public/shared/protocol.js');
  globalThis.window.MSG = proto.MSG;
  globalThis.window.RELAY_URL = 'ws://wire-compat.invalid';
  globalThis.window.FASTLANE_TYPES = proto.FASTLANE_TYPES;
  globalThis.window.STUN_URL = proto.STUN_URL;
  globalThis.window.ROOM_STATE = proto.ROOM_STATE;
  globalThis.window.CAR_MODELS = proto.CAR_MODELS;
  globalThis.window.CAR_COLORS = proto.CAR_COLORS;
  globalThis.window.MAX_PLAYERS = proto.MAX_PLAYERS;
  // The presence contract both ends spend: the phone's ping cadence and the
  // display's drop/grace/canary windows. Real values, from the real manifest —
  // "a seat silent past 3 s is dropped" only means anything against a 1 Hz ping,
  // and this suite is where the two ends actually meet.
  globalThis.window.LIVENESS = proto.LIVENESS;
  // The run length a RANDOM pick settles on. `_applyMode` clamps an incoming
  // SELECT_MODE against it, and this suite is the only place a real phone's
  // message meets the real display's resolver.
  globalThis.window.RANDOM_RACES = proto.RANDOM_RACES;
}

function kit() {
  installBrowserGlobals();
  return {
    PartyConnection: globalThis.window.PartyConnection,
    PartyFastlane: globalThis.window.PartyFastlane,
    protocol: require('../../public/shared/protocol.js'),
  };
}

// The display's own adapters — the real ones, not re-implementations. These are
// what a tvOS shell is a sibling of, so they are the JS edge under test.
async function displayAdapters() {
  installBrowserGlobals();
  const conn = await import(pathToFileURL(path.join(ROOT, 'public/display/NativePartyConnection.js')).href);
  await conn.init();
  const fl = await import(pathToFileURL(path.join(ROOT, 'public/display/NativePartyFastlane.js')).href);
  await fl.init();
  return {
    NativePartyConnection: conn.NativePartyConnection,
    NativePartyFastlane: fl.makeNativePartyFastlane(globalThis.window.PartyFastlane),
  };
}

// The phone, unchanged: public/controller/Net.js + public/controller/InputGate.js.
async function controllerModules() {
  installBrowserGlobals();
  const net = await import(pathToFileURL(path.join(ROOT, 'public/controller/Net.js')).href);
  const gate = await import(pathToFileURL(path.join(ROOT, 'public/controller/InputGate.js')).href);
  return { ControllerNet: net.ControllerNet, InputGate: gate.InputGate };
}

// The WHOLE display edge, unchanged: public/display/Net.js (which owns the room
// protocol and AUTHORS the LOBBY_UPDATE snapshot) over the native RoomFlow, the
// native connection and the native fastlane. Nothing below this line is a
// re-implementation, which is the point: the object the phone reads is the object
// the shipping display produces, roster fields and all.
async function displayModules() {
  const adapters = await displayAdapters();
  const flow = await import(pathToFileURL(path.join(ROOT, 'public/display/NativeRoomFlow.js')).href);
  await flow.init();
  // The session policy is native too (ttp_net.h): the snapshot the phone reads
  // is COMPOSED in C++ now, so this is part of the display edge under test, not
  // a stand-in for it.
  const sess = await import(pathToFileURL(path.join(ROOT, 'public/display/NativeSessionModel.js')).href);
  await sess.init();
  const net = await import(pathToFileURL(path.join(ROOT, 'public/display/Net.js')).href);
  return { ...adapters, DisplayNet: net.DisplayNet, NativeRoomFlow: flow.NativeRoomFlow };
}

// The name cap both pages apply (public/shared/names.js). Imported rather than
// restated so a change to the real producer moves the assertions.
async function sharedNames() {
  return import(pathToFileURL(path.join(ROOT, 'public/shared/names.js')).href);
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

// Run `body` with Date.now() and setTimeout under test control. The body must be
// SYNCHRONOUS: the globals are process-wide, so an await would hand a stubbed
// clock to the test runner itself. Everything the netcode does is synchronous,
// which is why this is safe and why it is enforced rather than documented.
function withFakeClock(body) {
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  let seq = 0;
  const clock = {
    now: 0,
    // Advance to `t`, firing every timer due at or before it, in due order.
    advanceTo(t) {
      for (;;) {
        let next = null;
        for (const [id, e] of timers) {
          if (e.at <= t && (next === null || e.at < next.e.at || (e.at === next.e.at && id < next.id))) {
            next = { id, e };
          }
        }
        if (!next) break;
        timers.delete(next.id);
        this.now = next.e.at;
        next.e.fn();
      }
      this.now = t;
    },
    advance(dt) { this.advanceTo(this.now + dt); },
    // Fire everything already due without moving the clock — i.e. let in-flight
    // frames land. Real transports deliver on a later task; this is that task.
    flush() { this.advanceTo(this.now); },
    pending() { return timers.size; },
  };
  Date.now = () => clock.now;
  globalThis.setTimeout = (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: clock.now + (ms || 0) }); return id; };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  try {
    const r = body(clock);
    if (r && typeof r.then === 'function') {
      throw new Error('withFakeClock body must be synchronous');
    }
    return r;
  } finally {
    Date.now = realNow;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

// Let queued microtasks (the fake socket's `open`) run.
const flush = () => new Promise((r) => setImmediate(r));

// The TRUE byte length of what an encoder produced, measured in the wasm heap
// BEFORE emscripten decodes it. This is not the same number as
// Buffer.byteLength(cwrap'd string): the decode is lossy for WTF-8, so the string
// the browser actually puts on the socket can be LONGER than the bytes C++ wrote.
// Anything reasoning about the relay's 16 KiB cap has to know which of the two it
// is looking at.
async function wasmCStringBytes(fnName, argTypes, args) {
  const M = await loadModule();
  const ptr = M.cwrap(fnName, 'number', argTypes)(...args);
  let n = 0;
  while (M.HEAPU8[ptr + n] !== 0) n++;
  return n;
}

// Anything holding a live timer (ControllerNet's 1 Hz ping, DisplayNet's 1 Hz
// liveness tick) has to be torn down or the test runner never exits. Registered
// here so every test file gets the same guarantee from one `after` hook.
const _openPhones = new Set();
const _openDisplays = new Set();
function trackPhone(net) { _openPhones.add(net); return net; }
function trackDisplay(net) { _openDisplays.add(net); return net; }
function teardownClients() {
  for (const net of _openPhones) {
    try { net.disconnect(); } catch (_) { /* already gone */ }
  }
  _openPhones.clear();
  for (const net of _openDisplays) {
    try { net.shutdown(); } catch (_) { /* already gone */ }
  }
  _openDisplays.clear();
}

// Recursive key sort so two JSON texts compare by VALUE. Used only where key
// order is explicitly not the thing under test; the byte-level assertions
// compare raw text instead.
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}
const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

module.exports = {
  ROOT, ENGINE_DIR,
  loadModule, loadAbi,
  installBrowserGlobals, setRelay, kit, displayAdapters, displayModules,
  controllerModules, sharedNames,
  withFakeClock, flush, same, sortKeys, wasmCStringBytes,
  trackPhone, trackDisplay, teardownClients,
};
