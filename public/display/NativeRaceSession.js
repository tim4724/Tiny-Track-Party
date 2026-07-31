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
// - Bots live INSIDE the wasm (added via opts.bots personas); ttp_update steps
//   the AI internally in the live loop's order.
// - Construction is deferred: the engine session is built at startCountdown
//   (the ABI's begin/add/start split); every pre-start passthrough answers
//   from the roster.

import { loadNativeRuntime, nativeError } from './nativeRuntime.js';

let M = null;            // the instantiated emscripten module (shared)
let fn = null;           // cwrap'd ABI

export async function init() {
  if (M) return;
  // Shared loader: the sim and party adapters must not instantiate the module
  // twice (one wasm heap for both ABIs).
  M = await loadNativeRuntime();
  const c = (name, ret, args) => M.cwrap(name, ret, args);
  fn = {
    version: c('ttp_version', 'string', []),
    beginField: c('ttp_session_begin_field', 'number',
      ['string', 'number', 'number', 'string', 'string', 'string']),
    start: c('ttp_session_start', null, ['number', 'number']),
    update: c('ttp_update', null, ['number', 'number']),
    input: c('ttp_process_input', null, ['number', 'string', 'number', 'number', 'number', 'number']),
    snapshot: c('ttp_snapshot_json', 'string', ['number']),
    events: c('ttp_events_json', 'string', ['number']),
    hasCar: c('ttp_has_car', 'number', ['number', 'string']),
    carFinished: c('ttp_car_finished', 'number', ['number', 'string']),
    carIds: c('ttp_car_ids_json', 'string', ['number']),
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
  const v = JSON.parse(fn.version());
  console.info(`[native:sim] ${JSON.stringify(v)}`);
}

// Steer-expo mirror: main.js keeps calling the JS engine's module-level
// setter (harmless); under the flag it also calls this one so the native sim
// tracks the same setting.
export function setNativeSteerExpo(x) { if (fn) fn.setSteerExpo(x); }
// The engine-global steer curve now lives in the wasm, so the debug panel reads
// its default from there instead of from a JS module constant.
export function getNativeSteerExpo() { return fn ? fn.getSteerExpo() : 0; }

const idJson = (id) => JSON.stringify(id);
// ttp_session_start's "no countdown" sentinel (any negative — see its header):
// racing from frame 0, bare-Game stepping.
const BARE_COUNTDOWN = -1;

export class NativeRaceSession {
  // players: the same `field` RaceSession gets ([{peerIndex, stats, ai?...}]).
  // opts: RaceSession's callbacks + `bots`: [{peerIndex, caution, laneBias, seed}]
  // for the seats the host would otherwise drive with JS AiControllers.
  constructor(players, track, opts = {}) {
    if (!M) throw new Error('NativeRaceSession used before init() resolved');
    // events: 'external' — the RACE path. The queue is drained and routed in
    // C++ (ttp_race_events_live_json), so this adapter must not touch it: a
    // drain here would eat the beats the walk routes. Default: drained and
    // DISCARDED on update (the attract demo and preview surfaces, which want a
    // moving world and no lifecycle), or fed to the legacy callbacks when any
    // are passed (test surfaces).
    this._external = opts.events === 'external';
    this._onRaceEvent = opts.onRaceEvent || (() => {});
    this._onCountdownTick = opts.onCountdownTick || (() => {});
    this._onRaceStart = opts.onRaceStart || (() => {});
    this._onRaceEnd = opts.onRaceEnd || (() => {});
    this._ended = false;
    this._racingCache = false;

    // The whole construction — begin plus the one-pass over the field with bot
    // specs keyed by scalar id — is ttp_session_begin_field's. The persona and
    // seed defaults live there too, not at this call site.
    this.h = fn.beginField(track.trackId, (track.seed ?? 1) >>> 0,
      track.totalLaps || window.TOTAL_LAPS,  // the manifest's lap count, not a re-typed 3
      opts.forceItem || null,
      JSON.stringify(players.map((p) => ({ peerIndex: p.peerIndex, stats: p.stats || null }))),
      JSON.stringify(opts.bots || []));
    // The REASON is the engine's — unknown track, refused lap count — rather
    // than this file guessing from the one bit it was handed.
    if (!this.h) throw nativeError(`starting a race on '${track.trackId}'`);
  }

  // External mode reads the engine (the adapter never sees the lifecycle
  // beats); the drain modes latch off the beats as the JS session did.
  get racing() { return this._external ? !!(this.h && fn.racing(this.h)) : this._racingCache; }
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
    fn.start(this.h, BARE_COUNTDOWN);
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
  carIds() { return JSON.parse(fn.carIds(this.h)); }
  hasCar(id) { return !!fn.hasCar(this.h, idJson(id)); }
  carFinished(id) { return this.h ? fn.carFinished(this.h, idJson(id)) === 1 : false; }

  dispose() {
    this._ended = true;
    this._racingCache = false;
    if (this.h) { fn.dispose(this.h); this.h = 0; }
  }

  _drain() {
    if (this._external) return;  // the race walk owns the queue
    // Called every frame; the queue is empty on almost all of them, and the
    // wasm returns the shared "[]" constant for that case — skip the parse.
    const raw = fn.events(this.h);
    if (raw === '[]') return;
    const evs = JSON.parse(raw);
    for (const e of evs) {
      if (e.type === '_countdown') this._onCountdownTick(e.n);
      else if (e.type === '_raceStart') { this._racingCache = true; this._onRaceStart(); }
      else if (e.type === '_raceEnd') { this._racingCache = false; this._ended = true; this._onRaceEnd(e.results); }
      else this._onRaceEvent(e);
    }
  }
}
