// RaceSession — lifecycle manager for a single race: Game engine, countdown
// timer, and the race-timeout failsafe. All net/DOM/scene side-effects surface
// through callbacks; this module is pure race logic with no browser globals.
import { Game } from './engine/Game.js';

const MAX_RACE_MS = 180_000; // hard ceiling; see startRace() note in main.js

export class RaceSession {
  constructor(players, track, opts = {}) {
    // Each player carries the stats resolved from its car pick (see buildField);
    // the engine reads {id, stats}. Stats-less entries fall back to the benchmark.
    this.engine = new Game(players.map((p) => ({ id: p.peerIndex, stats: p.stats })), track, {
      onEvent: opts.onRaceEvent || (() => {}),
    });
    this.racing = false;

    this._onCountdownTick = opts.onCountdownTick || (() => {});
    this._onRaceStart     = opts.onRaceStart     || (() => {});
    this._onRaceEnd       = opts.onRaceEnd       || (() => {});

    this._countdownTimer = null;
    this._countdownN     = null;   // seconds left on the countdown (for pause/resume)
    this._raceTimer      = null;
    this._raceDeadline   = 0;      // wall-clock ms when MAX_RACE_MS fires (for pause/resume)
    this._raceRemainMs   = null;   // remaining MAX_RACE_MS budget while paused
    this._ended          = false;
    this.paused          = false;
  }

  // Begin the countdown. Fires onCountdownTick(n) for n = seconds..0 at 1 Hz,
  // then onRaceStart() and begins physics (racing = true). Seconds defaults to
  // the remembered count so resume() can re-arm the interval where it left off.
  startCountdown(seconds) {
    this._countdownN = seconds;
    this._onCountdownTick(this._countdownN);
    this._countdownTimer = setInterval(() => {
      this._countdownN -= 1;
      if (this._countdownN >= 0) {
        this._onCountdownTick(this._countdownN);
      } else {
        clearInterval(this._countdownTimer);
        this._countdownTimer = null;
        this._countdownN = null;
        this.racing = true;
        this._onRaceStart();
        this._armRaceTimer(MAX_RACE_MS);
      }
    }, 1000);
  }

  // Arm the race-timeout failsafe, recording the deadline so a pause can bank the
  // remaining budget and resume() can re-arm it (so a long pause never finishes
  // the race early).
  _armRaceTimer(ms) {
    this._raceDeadline = performance.now() + ms;
    this._raceTimer = setTimeout(() => {
      this._raceTimer = null;
      if (this.racing) this._finish();
    }, ms);
  }

  // Freeze the race: stop the countdown / race-timeout timers and bank their
  // remaining time. Physics simply stop advancing (the caller stops calling
  // update()), so engine.elapsed — and thus finish times — don't tick while paused.
  pause() {
    if (this.paused || this._ended) return;
    this.paused = true;
    if (this._countdownTimer) { clearInterval(this._countdownTimer); this._countdownTimer = null; }
    if (this._raceTimer) {
      clearTimeout(this._raceTimer); this._raceTimer = null;
      this._raceRemainMs = Math.max(0, this._raceDeadline - performance.now());
    }
  }

  // Unfreeze: re-arm whichever timer was running when we paused.
  resume() {
    if (!this.paused || this._ended) return;
    this.paused = false;
    if (!this.racing && this._countdownN != null) {
      this.startCountdown(this._countdownN);     // pick the countdown back up
    } else if (this.racing && this._raceRemainMs != null) {
      this._armRaceTimer(this._raceRemainMs);
      this._raceRemainMs = null;
    }
  }

  // Call from the render loop. Advances physics and fires onRaceEnd when done.
  update(dtMs) {
    if (!this.racing || this.paused) return;
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
    this.paused = false;
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
