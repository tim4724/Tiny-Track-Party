// NativeCupSeries — the cup-series layer (the race ABOVE a race: points,
// standings order, cup chaining), backed by the native C++ series port through
// ttp_runtime.h's ttp_gp_* entry points. It reproduces the surface the deleted
// GrandPrix.js CupSeries had, which is what main.js still drives.
//
// The endless-mode DRAW stays in JS on purpose. It comes from a page-RNG shuffle
// bag (Math.random, display-side, deliberately not deterministic sim state), so
// this adapter offers the bag's next draw on every applyRace and the C++ side
// consumes it only when the rules call for one. The decision is native; the
// randomness is not.
//
// Conformance WAS a differential test against the JS CupSeries; that died with
// the twin (PR #39). What remains is the C++ side's own coverage — grand_prix.cc
// under the golden traces — plus this adapter's draw-gating being asserted where
// it is decided, below.

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
    endless: c('ttp_gp_endless', 'number', ['number']),
    raceCount: c('ttp_gp_race_count', 'number', ['number']),
    raceIndex: c('ttp_gp_race_index', 'number', ['number']),
    finished: c('ttp_gp_finished', 'number', ['number']),
    currentTrack: c('ttp_gp_current_track', 'string', ['number']),
    nextTrack: c('ttp_gp_next_track', 'string', ['number']),
    cupJson: c('ttp_gp_cup_json', 'string', ['number']),
    applyRace: c('ttp_gp_apply_race', null, ['number', 'string', 'string', 'string']),
    advance: c('ttp_gp_advance', null, ['number']),
    standings: c('ttp_gp_standings_json', 'string', ['number']),
    rekey: c('ttp_gp_rekey', null, ['number', 'string', 'string']),
    needsDraw: c('ttp_gp_needs_draw', 'number', ['number'])
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

  // The wasm handle, for the ui twins that read this series' state in C++
  // (ttp_ui_series_info_gp_json / ttp_ui_standings_live_json).
  get handle() { return this._h; }
  get endless() { return fn.endless(this._h) === 1; }
  get raceCount() { return fn.raceCount(this._h); }
  get raceIndex() { return fn.raceIndex(this._h); }
  get finished() { return fn.finished(this._h) === 1; }
  get currentTrackId() { return fn.currentTrack(this._h); }
  // The ABI returns "" for JS's null (no next race queued).
  get nextTrackId() { const t = fn.nextTrack(this._h); return t === '' ? null : t; }
  // The cup object, including tracks appended by endless draws.
  get cup() { return JSON.parse(fn.cupJson(this._h)); }

  applyRace(results, field) {
    // Draw ONLY when the kit would (ttp_gp_needs_draw owns the WHEN — drawing
    // on every call would pull the shuffle bag faster than the kit does and
    // desynchronise the whole track sequence; the bag is stateful, so an
    // unused draw is not free). What stays here is the BAG: drawNext is the
    // page's shuffle, and its absence means a fixed cup that never draws.
    const drawn = this.drawNext && fn.needsDraw(this._h) ? this.drawNext() : null;
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

  standings() { return JSON.parse(fn.standings(this._h)); }

  rekey(oldId, newId) { fn.rekey(this._h, idJson(oldId), idJson(newId)); }

  dispose() { if (this._h) { fn.dispose(this._h); this._h = 0; } }
}
