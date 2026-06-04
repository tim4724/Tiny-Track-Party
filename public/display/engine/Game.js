// Game — authoritative ribbon-follow car simulation. Cars are glued to the
// track centerline: each car has progress `s` (arclength), lateral offset `lat`,
// and speed `v`. Auto-accelerate forward; steer moves laterally; brake slows.
// Loops/hills "just work" because the car follows the ribbon's pos/tangent/up.
//
// Contract (mirrors the HexStacker engine seams):
//   new Game(playerIds, { centerline, length, roadWidth, totalLaps }, { onEvent })
//   update(dtMs) / processInput(id, {s,b}) / getSnapshot() / getResults()

const ACCEL = 7.0;        // units/s^2 forward
const VMAX = 9.0;         // top speed units/s — paired with TURN_RATE so the
                          // large corners are followable at full speed (v/R < turn rate)
const BRAKE_DECEL = 4.5;  // units/s^2 braking → ~2s from top speed (VMAX) to a full stop
// Real steering: tilt turns the car's HEADING (radians, relative to the track
// direction). We subtract the track's own turn each step so NEUTRAL = straight
// in the world — you must steer through curves (no autosteer). Heading is
// clamped so the car can never point backward → u-turn is impossible.
const TURN_RATE = 1.2;    // rad/s at full tilt — calm
const STEER_EXPO = 1.8;   // non-linear response: small tilt = gentle, full = full lock
const MAX_HEADING = 1.25; // ~72° clamp (no u-turn; always some forward progress)
const STEER_SIGN = -1;    // tilt-to-steer direction (negated: tilt right → go right)
const WALL_SPEED = VMAX * 0.5; // speed cap while rubbing the curb (slows, never stuck)
const WALL_DECEL = 20.0;  // how fast you bleed down to the curb cap
const LAT_MARGIN = 0.3;   // keep the car body inside the curbs
const LOOKAHEAD = 8.0;    // world units down the centerline the camera aims at

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
      const row = Math.floor(i / 2);
      const lane = (i % 2 === 0 ? -1 : 1) * Math.min(this.maxLat * 0.6, 0.5);
      this.cars.set(id, {
        id,
        totalS: 1.0 + row * 1.6,  // staggered grid on the opening straight (s>0)
        lat: lane,
        v: 0,
        heading: 0,      // car yaw relative to the track tangent (real steering)
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

      // STEERING (real): tilt turns the car's heading; you must steer through
      // curves. Move along the heading within the track's surface frame.
      const authority = 0.4 + 0.6 * Math.min(1, c.v / (VMAX * 0.5));
      // non-linear response: ease the center so small tilts barely steer
      const steerIn = Math.sign(c.steer) * Math.pow(Math.abs(c.steer), STEER_EXPO);
      c.heading += STEER_SIGN * steerIn * TURN_RATE * authority * dt;

      const before = this.centerline.sampleAt(c.totalS);
      const along = Math.cos(c.heading), across = Math.sin(c.heading);
      const prevTotal = c.totalS;
      c.totalS += c.v * Math.max(0.1, along) * dt; // always some forward progress
      // lateral axis (tangent×up) points opposite the +heading rotation, so the
      // sideways motion is -sin(heading): the car moves the way it points.
      c.lat -= c.v * across * dt;

      // Subtract the track's own turn so NEUTRAL holds a world heading (= you
      // must steer the curves), then clamp so the car can't point backward.
      const after = this.centerline.sampleAt(c.totalS);
      const dTheta = Math.atan2(
        before.tangent.clone().cross(after.tangent).dot(after.up),
        before.tangent.dot(after.tangent)
      );
      c.heading -= dTheta;
      if (c.heading > MAX_HEADING) c.heading = MAX_HEADING;
      else if (c.heading < -MAX_HEADING) c.heading = -MAX_HEADING;

      // Rubbing the curb slows you toward a cap — never a hard stop.
      c.onWall = false;
      if (c.lat > this.maxLat) { c.lat = this.maxLat; c.onWall = true; if (c.v > WALL_SPEED) c.v = Math.max(WALL_SPEED, c.v - WALL_DECEL * dt); }
      else if (c.lat < -this.maxLat) { c.lat = -this.maxLat; c.onWall = true; if (c.v > WALL_SPEED) c.v = Math.max(WALL_SPEED, c.v - WALL_DECEL * dt); }
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
        forward: f.tangent.clone().applyAxisAngle(f.up, c.heading), // car faces its heading
        tangent: f.tangent,                                          // track direction
        up: f.up,
        lookAhead: this.centerline.sampleAt(c.totalS + LOOKAHEAD).pos.clone() // camera aim
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
        id: c.id, pose: c.pose, lat: c.lat, v: c.v, spd: c.v / VMAX, // normalized 0..1
        lap: Math.min(this.totalLaps, c.lap + (c.totalS >= 0 ? 1 : 0)), // 1-based display lap
        totalLaps: this.totalLaps, position: c.rank, of: this.cars.size,
        // steer is reported TURN-ALIGNED: its sign matches the way the car actually
        // turns (= STEER_SIGN * raw input), so the renderer's front wheels + body
        // lean line up with the turn without the renderer needing to know STEER_SIGN.
        // steerInput is the RAW player input (matches the phone's steer bar) and
        // drives the on-screen steer indicator.
        finished: c.finished, steer: STEER_SIGN * c.steer, steerInput: c.steer, brake: c.brake, onWall: !!c.onWall
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
