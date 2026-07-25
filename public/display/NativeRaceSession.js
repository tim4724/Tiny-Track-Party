// NativeRaceSession — RaceSession's exact surface, backed by the NATIVE C++
// sim compiled to WASM (native/runtime/ttp_runtime.h via engine/native/
// ttp_runtime.mjs). Behind ?sim=native only: main.js dynamic-imports this module
// and awaits init() before any race, then constructs it exactly where it
// would construct RaceSession. The default path never loads the module.
//
// Semantic parity is the C++ conformance suite's job (the sim is bit-exact
// against the JS engine on every committed golden trace); THIS file's job is
// wiring parity: same construction order (humans then bots, add order = grid
// order), same callback cadence (countdown ticks, GO, raceEnd — all drained
// from the ABI's one outbound event queue on each update), same passthrough
// shapes (plain data out, fresh objects the caller owns).
//
// Differences from the JS RaceSession, by design:
// - Bots live INSIDE the wasm (added via opts.bots personas); driveBot() is
//   a no-op — ttp_update steps the AI internally in the live loop's order.
// - Construction is deferred: the engine session is built at startCountdown
//   (the ABI's begin/add/start split); every pre-start passthrough answers
//   from the roster.

import { loadNativeRuntime } from './nativeRuntime.js';

let M = null;            // the instantiated emscripten module (shared)
let fn = null;           // cwrap'd ABI
let vecPtr = 0;          // persistent 3-double out-buffer for pos queries

export async function init() {
  if (M) return;
  // Shared loader: ?sim=native and ?party=native must not instantiate the module
  // twice (one wasm heap for both ABIs).
  M = await loadNativeRuntime();
  const c = (name, ret, args) => M.cwrap(name, ret, args);
  fn = {
    version: c('ttp_version', 'string', []),
    begin: c('ttp_session_begin', 'number', ['string', 'number', 'number', 'string']),
    addHuman: c('ttp_add_human', null, ['number', 'string', 'string']),
    addBot: c('ttp_add_bot', null, ['number', 'string', 'number', 'number', 'number', 'string']),
    start: c('ttp_session_start', null, ['number', 'number']),
    update: c('ttp_update', null, ['number', 'number']),
    input: c('ttp_process_input', null, ['number', 'string', 'number', 'number', 'number', 'number']),
    snapshot: c('ttp_snapshot_json', 'string', ['number']),
    results: c('ttp_results_json', 'string', ['number']),
    events: c('ttp_events_json', 'string', ['number']),
    hasCar: c('ttp_has_car', 'number', ['number', 'string']),
    carFinished: c('ttp_car_finished', 'number', ['number', 'string']),
    carIds: c('ttp_car_ids_json', 'string', ['number']),
    carWorldPos: c('ttp_car_world_pos', 'number', ['number', 'string', 'number']),
    trackPoint: c('ttp_track_point', 'number', ['number', 'number', 'number', 'number']),
    removeCar: c('ttp_force_remove_car', 'number', ['number', 'string']),
    rekeyCar: c('ttp_rekey_car', 'number', ['number', 'string', 'string']),
    forceFinish: c('ttp_force_finish', null, ['number', 'string', 'number']),
    fastForward: c('ttp_fast_forward', null, ['number']),
    pause: c('ttp_pause', null, ['number']),
    resume: c('ttp_resume', null, ['number']),
    racing: c('ttp_racing', 'number', ['number']),
    paused: c('ttp_paused', 'number', ['number']),
    dispose: c('ttp_dispose', null, ['number']),
    setSteerExpo: c('ttp_set_steer_expo', null, ['number']),
    getSteerExpo: c('ttp_get_steer_expo', 'number', [])
  };
  vecPtr = M._malloc(3 * 8);
  const v = JSON.parse(fn.version());
  console.info(`[sim=native] ${JSON.stringify(v)}`);
}

// Steer-expo mirror: main.js keeps calling the JS engine's module-level
// setter (harmless); under the flag it also calls this one so the native sim
// tracks the same setting.
export function setNativeSteerExpo(x) { if (fn) fn.setSteerExpo(x); }
// The engine-global steer curve now lives in the wasm, so the debug panel reads
// its default from there instead of from a JS module constant.
export function getNativeSteerExpo() { return fn ? fn.getSteerExpo() : 0; }

const idJson = (id) => JSON.stringify(id);
const vec = () => ({ x: M.HEAPF64[vecPtr >> 3], y: M.HEAPF64[(vecPtr >> 3) + 1], z: M.HEAPF64[(vecPtr >> 3) + 2] });

export class NativeRaceSession {
  // players: the same `field` RaceSession gets ([{peerIndex, stats, ai?...}]).
  // opts: RaceSession's callbacks + `bots`: [{peerIndex, caution, laneBias, seed}]
  // for the seats the host would otherwise drive with JS AiControllers.
  constructor(players, track, opts = {}) {
    if (!M) throw new Error('NativeRaceSession used before init() resolved');
    this._onRaceEvent = opts.onRaceEvent || (() => {});
    this._onCountdownTick = opts.onCountdownTick || (() => {});
    this._onRaceStart = opts.onRaceStart || (() => {});
    this._onRaceEnd = opts.onRaceEnd || (() => {});
    this._ended = false;
    this._racingCache = false;

    this.h = fn.begin(track.trackId, (track.seed ?? 1) >>> 0, track.totalLaps || 3, opts.forceItem || null);
    if (!this.h) throw new Error(`ttp_session_begin failed for track '${track.trackId}'`);

    const bots = new Map((opts.bots || []).map((b) => [b.peerIndex, b]));
    for (const p of players) {
      const stats = p.stats ? JSON.stringify(p.stats) : null;
      const b = bots.get(p.peerIndex);
      if (b) fn.addBot(this.h, idJson(p.peerIndex), b.caution ?? 1, b.laneBias ?? 0, (b.seed ?? 1) >>> 0, stats);
      else fn.addHuman(this.h, idJson(p.peerIndex), stats);
    }
  }

  get racing() { return this._racingCache; }
  set racing(v) { this._racingCache = v; } // RaceSession exposes a plain field; keep assignability
  get paused() { return this.h ? !!fn.paused(this.h) : false; }

  startCountdown(seconds) {
    fn.start(this.h, seconds);
    this._drain(); // the opening beat fires synchronously, exactly like RaceSession
  }

  // Bare mode: racing from frame 0 with no countdown — the equivalent of
  // constructing a JS Game directly and stepping it. Preview surfaces (gallery
  // scenarios, the lobby demo) want exactly that: a world that is already moving,
  // with no lobby lifecycle around it.
  startBare() {
    fn.start(this.h, -1);
    this._racingCache = true;
    this._drain();
  }

  update(dtMs) {
    if (this._ended || !this.h) return;
    fn.update(this.h, dtMs);
    this._drain();
  }

  processInput(id, m) {
    if (!this.h) return;
    let mask = 0, s = 0, b = 0, u = 0;
    if (typeof m.s === 'number') { mask |= 1; s = m.s; }
    if (typeof m.b === 'number' || typeof m.b === 'boolean') { mask |= 2; b = +m.b; }
    if (typeof m.u === 'number') { mask |= 4; u = m.u; }
    fn.input(this.h, idJson(id), mask, s, b, u);
  }

  // Bots are stepped inside ttp_update in the live loop's exact order; the
  // host's driveBots() loop has nothing to do here.
  driveBot() { return false; }

  fastForwardToEnd() {
    if (!this.h || this._ended) return;
    fn.fastForward(this.h);
    this._drain();
  }

  forceRemoveCar(id) {
    if (!this.h) return false;
    const removed = !!fn.removeCar(this.h, idJson(id));
    if (removed) this._drain(); // last-car removal can end the race
    return removed;
  }

  rekeyCar(oldId, newId) { return this.h ? !!fn.rekeyCar(this.h, idJson(oldId), idJson(newId)) : false; }
  forceFinish(id, time) { if (this.h) fn.forceFinish(this.h, idJson(id), time); }

  pause() { if (this.h) fn.pause(this.h); }
  resume() {
    if (!this.h) return;
    fn.resume(this.h);
    this._drain(); // resume can re-fire the held countdown beat
  }

  getSnapshot() { return JSON.parse(fn.snapshot(this.h)); }
  getResults() { return JSON.parse(fn.results(this.h)); }
  carIds() { return JSON.parse(fn.carIds(this.h)); }
  hasCar(id) { return !!fn.hasCar(this.h, idJson(id)); }
  carFinished(id) { return fn.carFinished(this.h, idJson(id)) === 1; } // -1 = unknown car, must read false
  carWorldPos(id) { return fn.carWorldPos(this.h, idJson(id), vecPtr) ? vec() : null; }
  trackPoint(s, lat) { return fn.trackPoint(this.h, s, lat, vecPtr) ? vec() : null; }

  dispose() {
    this._ended = true;
    this._racingCache = false;
    if (this.h) { fn.dispose(this.h); this.h = 0; }
  }

  _drain() {
    const evs = JSON.parse(fn.events(this.h));
    for (const e of evs) {
      if (e.type === '_countdown') this._onCountdownTick(e.n);
      else if (e.type === '_raceStart') { this._racingCache = true; this._onRaceStart(); }
      else if (e.type === '_raceEnd') { this._racingCache = false; this._ended = true; this._onRaceEnd(e.results); }
      else this._onRaceEvent(e);
    }
  }
}
