// RaceSession — lifecycle manager for a single race: Game engine, countdown
// timer, and the race-timeout failsafe. All net/DOM/scene side-effects surface
// through callbacks; this module is pure race logic with no browser globals.
import { Game } from './engine/Game.js';

const MAX_RACE_MS = 180_000; // hard ceiling; see startRace() note in main.js

export class RaceSession {
  constructor(players, track, opts = {}) {
    this.engine = new Game(players.map((p) => p.peerIndex), track, {
      onEvent: opts.onRaceEvent || (() => {}),
    });
    this.racing = false;

    this._onCountdownTick = opts.onCountdownTick || (() => {});
    this._onRaceStart     = opts.onRaceStart     || (() => {});
    this._onRaceEnd       = opts.onRaceEnd       || (() => {});

    this._countdownTimer = null;
    this._raceTimer      = null;
    this._ended          = false;
  }

  // Begin the countdown. Fires onCountdownTick(n) for n = seconds..0 at 1 Hz,
  // then onRaceStart() and begins physics (racing = true).
  startCountdown(seconds) {
    let n = seconds;
    this._onCountdownTick(n);
    this._countdownTimer = setInterval(() => {
      n -= 1;
      if (n >= 0) {
        this._onCountdownTick(n);
      } else {
        clearInterval(this._countdownTimer);
        this._countdownTimer = null;
        this.racing = true;
        this._onRaceStart();
        this._raceTimer = setTimeout(() => { if (this.racing) this._finish(); }, MAX_RACE_MS);
      }
    }, 1000);
  }

  // Call from the render loop. Advances physics and fires onRaceEnd when done.
  update(dtMs) {
    if (!this.racing) return;
    this.engine.update(dtMs);
    if (this.engine.raceOver) this._finish();
  }

  processInput(id, input) { this.engine.processInput(id, input); }

  // Remove a car mid-race (player left). Triggers onRaceEnd if it was the last
  // unfinished car. Returns truthy if the car existed and was removed.
  forceRemoveCar(id) {
    const removed = this.engine.removeCar(id);
    if (removed && this.racing && this.engine.raceOver) this._finish();
    return removed;
  }

  getSnapshot() { return this.engine.getSnapshot(); }
  getResults()  { return this.engine.getResults(); }

  // Tear down timers without firing callbacks (used on lobby reset, not race end).
  dispose() {
    if (this._countdownTimer) { clearInterval(this._countdownTimer); this._countdownTimer = null; }
    if (this._raceTimer)      { clearTimeout(this._raceTimer);       this._raceTimer = null; }
    this._ended = true;
    this.racing = false;
  }

  _finish() {
    if (this._ended) return;
    this._ended = true;
    this.racing = false;
    clearTimeout(this._raceTimer);
    this._raceTimer = null;
    this._onRaceEnd(this.engine.getResults());
  }
}
