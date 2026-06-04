// Game — authoritative ribbon-follow car simulation. Cars are glued to the
// track centerline: each car has progress `s` (arclength), lateral offset `lat`,
// and speed `v`. Auto-accelerate forward; steer moves laterally; brake slows.
// Loops/hills "just work" because the car follows the ribbon's pos/tangent/up.
//
// Contract (mirrors the HexStacker engine seams):
//   new Game(playerIds, { centerline, length, roadWidth, totalLaps }, { onEvent })
//   update(dtMs) / processInput(id, {s,b}) / getSnapshot() / getResults()

const ACCEL = 9.0;        // units/s^2 forward
const VMAX = 15.0;        // top speed units/s
const BRAKE_DECEL = 26.0; // units/s^2 when braking toward the brake-target speed
// Ribbon-follow steering: the car always faces the track direction (so it can
// never u-turn or drive backward); tilt only slides it across the road width.
const STEER_RATE = 4.2;   // lateral units/s at full tilt
const WALL_SPEED = VMAX * 0.5; // speed cap while rubbing the curb (slows, never stuck)
const WALL_DECEL = 20.0;  // how fast you bleed down to the curb cap
const LAT_MARGIN = 0.3;   // keep the car body inside the curbs

export class Game {
  constructor(playerIds, track, callbacks = {}) {
    this.centerline = track.centerline;
    this.length = track.length;
    this.totalLaps = track.totalLaps || 3;
    this.maxLat = Math.max(0.1, (track.roadWidth || 1) / 2 - LAT_MARGIN);
    this.onEvent = callbacks.onEvent || (() => {});
    this.elapsed = 0;
    this.finishedOrder = []; // ids in finish order
    this.cars = new Map();

    // Stagger the grid so cars don't spawn on top of each other: small negative
    // s and alternating lateral lanes, all behind the start line (s=0).
    playerIds.forEach((id, i) => {
      const lane = (i % 2 === 0 ? 1 : -1) * Math.min(this.maxLat, 0.22);
      this.cars.set(id, {
        id,
        totalS: -1.2 - i * 1.1,  // grid positions behind the line
        lat: lane,
        v: 0,
        steer: 0,
        brake: 0,        // 0..1 analog brake (swipe distance)
        lap: 0,
        finished: false,
        finishTime: null,
        rank: i + 1,
        pose: null
      });
    });
    this._recomputePoses();
  }

  processInput(id, msg) {
    const c = this.cars.get(id);
    if (!c || c.finished) return;
    if (typeof msg.s === 'number') c.steer = Math.max(-1, Math.min(1, msg.s));
    if (typeof msg.b === 'number') c.brake = Math.max(0, Math.min(1, msg.b));
    else if (typeof msg.b === 'boolean') c.brake = msg.b ? 1 : 0;
  }

  update(dtMs) {
    const dt = Math.min(dtMs / 1000, 0.05);
    if (dt <= 0) return;
    this.elapsed += dt;

    for (const c of this.cars.values()) {
      if (c.finished) { c.v = Math.max(0, c.v - BRAKE_DECEL * dt); continue; }

      // longitudinal: auto-accelerate toward a brake-scaled cruise speed.
      // brake is analog (0..1): 0 → full speed, 0.5 → half speed, 1 → stop.
      const targetV = VMAX * (1 - c.brake);
      if (c.v < targetV) c.v = Math.min(targetV, c.v + ACCEL * dt);
      else c.v = Math.max(targetV, c.v - BRAKE_DECEL * dt);

      // lateral: steering authority grows with speed (can't strafe when stopped).
      const authority = 0.25 + 0.75 * Math.min(1, c.v / (VMAX * 0.5));
      c.lat += c.steer * STEER_RATE * authority * dt;
      // Rubbing the curb just slows you toward a cap — never a hard stop.
      if (c.lat > this.maxLat) { c.lat = this.maxLat; if (c.v > WALL_SPEED) c.v = Math.max(WALL_SPEED, c.v - WALL_DECEL * dt); }
      else if (c.lat < -this.maxLat) { c.lat = -this.maxLat; if (c.v > WALL_SPEED) c.v = Math.max(WALL_SPEED, c.v - WALL_DECEL * dt); }

      // progress + lap counting (totalS is unwrapped distance from the line).
      const prevTotal = c.totalS;
      c.totalS += c.v * dt;
      const prevLap = Math.floor(Math.max(0, prevTotal) / this.length);
      const lap = Math.floor(Math.max(0, c.totalS) / this.length);
      if (c.totalS >= 0 && lap > prevLap && prevTotal >= 0) {
        c.lap = lap;
        if (lap >= this.totalLaps && !c.finished) {
          c.finished = true;
          c.finishTime = this.elapsed;
          this.finishedOrder.push(c.id);
          this.onEvent({ type: 'finish', id: c.id, rank: this.finishedOrder.length, time: c.finishTime });
          if (this.finishedOrder.length >= this.cars.size) {
            this.onEvent({ type: 'race_over' });
          }
        } else {
          this.onEvent({ type: 'lap', id: c.id, lap: c.lap });
        }
      } else {
        c.lap = Math.max(0, lap);
      }
    }

    this._recomputePoses();
    this._rank();
  }

  _recomputePoses() {
    for (const c of this.cars.values()) {
      const f = this.centerline.sampleAt(c.totalS);
      c.pose = {
        pos: f.pos.clone().addScaledVector(f.lateral, c.lat),
        tangent: f.tangent,
        up: f.up
      };
    }
  }

  // Live race position: finished cars first (by finish order), then by progress.
  _rank() {
    const arr = [...this.cars.values()];
    arr.sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.totalS - a.totalS;
    });
    arr.forEach((c, i) => { c.rank = i + 1; });
  }

  getSnapshot() {
    const cars = [];
    for (const c of this.cars.values()) {
      cars.push({
        id: c.id, pose: c.pose, lat: c.lat, v: c.v,
        lap: Math.min(this.totalLaps, c.lap + (c.totalS >= 0 ? 1 : 0)), // 1-based display lap
        totalLaps: this.totalLaps, position: c.rank, of: this.cars.size,
        finished: c.finished, steer: c.steer, brake: c.brake
      });
    }
    return { cars, elapsed: this.elapsed };
  }

  getResults() {
    const ranked = [...this.cars.values()].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1; if (b.finished) return 1;
      return b.totalS - a.totalS;
    });
    return {
      elapsed: this.elapsed,
      results: ranked.map((c, i) => ({
        playerId: c.id, rank: i + 1, finished: c.finished,
        time: c.finishTime, laps: Math.max(0, c.lap)
      }))
    };
  }

  get raceOver() { return this.finishedOrder.length >= this.cars.size; }
}
