// NativeCupSeries — the cup-series layer (the race ABOVE a race: points,
// standings order, cup chaining), backed by the native C++ series port through
// ttp_runtime.h's ttp_gp_* entry points.
//
// The series state comes out as ONE read (ttp_gp_state_json): the seven scalar
// getters this adapter used to compose are gone, and with them the ""-means-null
// spelling on the next track — the state's nextTrack is a real JSON null.
//
// The endless-mode DRAW stays in JS on purpose. It comes from a page-RNG shuffle
// bag (Math.random, display-side, deliberately not deterministic sim state), so
// this adapter offers the bag's next draw exactly when the state's `needsDraw`
// says the kit would consume one. The decision is native; the randomness is not.

import { loadNativeRuntime, nativeError } from './nativeRuntime.js';

let M = null;
let fn = null;

export async function init() {
  if (M) return;
  M = await loadNativeRuntime();
  const c = (name, ret, args) => M.cwrap(name, ret, args);
  fn = {
    create: c('ttp_gp_create', 'number', ['string', 'number']),
    dispose: c('ttp_gp_dispose', null, ['number']),
    state: c('ttp_gp_state_json', 'string', ['number']),
    applyRace: c('ttp_gp_apply_race', null, ['number', 'string', 'string', 'string']),
    advance: c('ttp_gp_advance', null, ['number']),
    rekey: c('ttp_gp_rekey', null, ['number', 'string', 'string'])
  };
}

const idJson = (v) => JSON.stringify(v === undefined ? null : v);

export class NativeCupSeries {
  // Signature mirrors the kit's: (cup, { drawNext }) — drawNext present makes it
  // an endless series.
  constructor(cup, opts = {}) {
    if (!fn) throw new Error('NativeCupSeries: init() not awaited');
    this.drawNext = opts.drawNext || null;
    this._h = fn.create(JSON.stringify({
      id: cup.id, name: cup.name, tracks: cup.tracks
    }), this.drawNext ? 1 : 0);
    if (!this._h) throw nativeError('creating a cup series');
  }

  // The wasm handle, for the walks and twins that read this series' state in
  // C++ (ttp_race_*_live, ttp_ui_series_info_live_json, ttp_ui_standings_live_json).
  get handle() { return this._h; }

  // The whole series state, one crossing. See ttp_gp_state_json. The field
  // getters below are projections of the same read — the E2E surface
  // (window.__series().raceIndex and friends) predates the one-read state and
  // stays stable. Game code that wants several fields should read `state` once.
  get state() { return JSON.parse(fn.state(this._h)); }
  get finished() { return this.state.finished; }
  get currentTrackId() { return this.state.currentTrack; }
  get nextTrackId() { return this.state.nextTrack; }
  get raceIndex() { return this.state.raceIndex; }
  get raceCount() { return this.state.raceCount; }
  get endless() { return this.state.endless; }

  applyRace(results, field) {
    // Draw ONLY when the kit would (`needsDraw` owns the WHEN — drawing on
    // every call would pull the shuffle bag faster than the kit does and
    // desynchronise the whole track sequence; the bag is stateful, so an
    // unused draw is not free). What stays here is the BAG: drawNext is the
    // page's shuffle, and its absence means a fixed cup that never draws.
    const drawn = this.drawNext && this.state.needsDraw ? this.drawNext() : null;
    fn.applyRace(this._h,
      JSON.stringify((results || []).map((r) => ({
        playerId: r.playerId, rank: r.rank, finished: !!r.finished
      }))),
      JSON.stringify((field || []).map((p) => ({
        peerIndex: p.peerIndex, name: p.name ?? '', colorIndex: p.colorIndex ?? 0, ai: !!p.ai
      }))),
      drawn);
  }

  advance() { fn.advance(this._h); }

  rekey(oldId, newId) { fn.rekey(this._h, idJson(oldId), idJson(newId)); }

  dispose() { if (this._h) { fn.dispose(this._h); this._h = 0; } }
}
