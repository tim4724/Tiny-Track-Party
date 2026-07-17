// RaceSession: lifecycle manager for a single race. Wraps the Game engine plus
// the countdown beats and the race-timeout failsafe. All net/DOM/scene
// side-effects surface through callbacks. The module owns NO timers and reads
// NO clock: the host feeds time in through update(dtMs) (the render loop), and
// countdown/failsafe are pure functions of the accumulated time. Same injected-
// time pattern as partyplug/RoomFlow.js's liveness engine, adapted to the sim's
// dt boundary.
// Pause banking is therefore free: while paused, update() ignores dt, so time
// simply does not pass for the countdown or the timeout budget.
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

    this._countdownN  = null;  // current displayed beat (seconds left); null = no countdown
    this._countdownMs = null;  // ms accumulated toward the next beat; null = no countdown
    this._raceMs      = 0;     // racing time accumulated since GO (the failsafe's time base)
    this._ended       = false;
    this.paused       = false;
  }

  // Begin the countdown. Fires onCountdownTick(n) for n = seconds..0 at one
  // beat per 1000 ms of injected time (n = 0 is the "GO!" beat). The race
  // starts ON "GO!": racing = true and onRaceStart() both fire at n = 0, so
  // cars launch the instant the banner reads GO, not a second later. One more
  // beat at n = -1 clears the lingering banner. Only the opening beat fires
  // here (synchronously); the rest ride update(dtMs).
  startCountdown(seconds) {
    this._countdownN = seconds;
    this._countdownMs = 0;
    this._onCountdownTick(this._countdownN);
  }

  // Advance the countdown by injected time. A whole-beats loop, so one large
  // dt can never skip the GO beat. Racing flips only on a 1 → 0 crossing:
  // startCountdown(0)'s opening beat never starts the race (its next beat is
  // the -1 clear). That is the floor contract the E2E __countdownSeconds hook
  // relies on.
  _stepCountdown(dtMs) {
    if (this._countdownMs == null) return;
    this._countdownMs += dtMs;
    while (this._countdownMs >= 1000) {
      this._countdownMs -= 1000;
      this._countdownN -= 1;
      this._onCountdownTick(this._countdownN);   // 2, 1, 0 (GO!), then -1 (clear)
      if (this._countdownN === 0) {
        // "GO!" is on screen: drop the flag and start physics this same beat.
        this.racing = true;
        this._onRaceStart();
        this._raceMs = 0;                        // arm the timeout failsafe
      } else if (this._countdownN < 0) {
        this._countdownN = null;
        this._countdownMs = null;
        return;
      }
    }
  }

  // Freeze the race. No banking to do: update() drops dt while paused, so the
  // countdown fraction and the remaining timeout budget hold exactly where they
  // were. Physics stop the same way (engine.elapsed, and thus finish times,
  // don't tick while paused).
  pause() {
    if (this.paused || this._ended) return;
    this.paused = true;
  }

  // Unfreeze. Time starts flowing again on the next update(dtMs).
  resume() {
    if (!this.paused || this._ended) return;
    this.paused = false;
    if (!this.racing && this._countdownN != null) {
      this._onCountdownTick(this._countdownN);   // re-show the held count on the banner
    } else if (this.racing && this._countdownN === 0) {
      // Paused exactly on the GO! beat: clear the lingering banner now rather
      // than a full race-second later.
      this._countdownN = null;
      this._countdownMs = null;
      this._onCountdownTick(-1);
    }
  }

  // Call from the render loop. Advances the countdown, then physics (from the
  // update AFTER the GO beat, exactly like the old 1 Hz interval firing between
  // frames), and fires onRaceEnd when the
  // engine reports the flag or the failsafe budget runs out.
  update(dtMs) {
    if (this.paused || this._ended) return;
    const wasRacing = this.racing;
    this._stepCountdown(dtMs);
    if (!wasRacing) return;
    this.engine.update(dtMs);
    this._raceMs += dtMs;
    if (this.engine.raceOver || this._raceMs >= MAX_RACE_MS) this._finish();
  }

  // Skip the rest of the race in one synchronous burst: step the deterministic
  // sim to the chequered flag (no rendering), then end the race. Used when every
  // human has crossed the line and only CPU cars are still circulating; the
  // humans shouldn't have to watch them crawl home. Because this runs the REAL
  // physics, the CPU finish times are their true times, not an estimate.
  // `stepBots` feeds the AI their input each simulated step, exactly as the
  // render loop does (a no-op once a car has finished). The burst bills the
  // same _raceMs time base as update(), so the failsafe ceiling holds; the
  // guard caps the loop so a never-finishing car can't hang the burst.
  // _finish then reports whatever crossed (the rest fall out as DNF, same as
  // the race-timeout path).
  fastForwardToEnd(stepBots, dtMs = 1000 / 30) {
    if (!this.racing || this.paused || this._ended) return;
    let guard = 0;
    while (!this.engine.raceOver && this._raceMs < MAX_RACE_MS && guard++ < 100000) {
      if (stepBots) stepBots();
      this.engine.update(dtMs);
      this._raceMs += dtMs;
    }
    this._finish();
  }

  processInput(id, input) { this.engine.processInput(id, input); }

  // Remove a car mid-race (player left). Triggers onRaceEnd if it was the last
  // unfinished car. Returns truthy if the car existed and was removed.
  forceRemoveCar(id) {
    const removed = this.engine.removeCar(id);
    if (removed && this.racing && this.engine.raceOver) this._finish();
    return removed;
  }

  // Re-key a live car (dropped player reconnects on another device). See
  // Game.rekeyCar. Returns truthy if the car existed and was moved.
  rekeyCar(oldId, newId) { return this.engine.rekeyCar(oldId, newId); }

  getSnapshot() { return this.engine.getSnapshot(); }
  getResults()  { return this.engine.getResults(); }

  // Wind down without firing callbacks (used on lobby reset, not race end).
  dispose() {
    this._countdownN = null;
    this._countdownMs = null;
    this._ended = true;
    this.racing = false;
    this.paused = false;
  }

  _finish() {
    if (this._ended) return;
    this._ended = true;
    this.racing = false;
    this._onRaceEnd(this.engine.getResults());
  }
}
