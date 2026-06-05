// Game — authoritative ribbon-follow car simulation. Cars are glued to the
// track centerline: each car has progress `s` (arclength), lateral offset `lat`,
// and speed `v`. Auto-accelerate forward; steer moves laterally; brake slows.
// Loops/hills "just work" because the car follows the ribbon's pos/tangent/up.
//
// Contract (mirrors the HexStacker engine seams):
//   new Game(playerIds, { centerline, length, roadWidth, totalLaps }, { onEvent })
//   update(dtMs) / processInput(id, {s,b}) / getSnapshot() / getResults()

// Finished cars take a victory lap on autopilot (see update()). We reuse the same
// pure-pursuit steer as the AI fill so a finished car drives the racing line
// exactly like a CPU racer would — one source of truth for "follow the line".
// AiDriver is dependency-free (no THREE), so this keeps Game loadable in both the
// browser and the Node tests.
import { pursue, cornerBrake } from '../AiDriver.js';

// Base handling numbers — the "Racer" benchmark. Per-car stats (see DEFAULT_STATS
// and the `stats` constructor arg) scale these so each model feels distinct while
// the tuned feel stays anchored here: a car's accel/vmax/turn are these × its
// multipliers, so a stats-less car (plain id) drives exactly like it always has.
const ACCEL = 7.0;        // units/s^2 forward
const VMAX = 9.0;         // top speed units/s on the straights; corner speed is set
                          // by each car's turn rate (understeer), not capped here
const BRAKE_DECEL = 4.5;  // units/s^2 braking → ~2s from top speed (VMAX) to a full stop
// Real steering: tilt turns the car's HEADING (radians, relative to the track
// direction). We subtract the track's own turn each step so NEUTRAL = straight
// in the world — you must steer through curves (no autosteer). Heading is
// clamped so the car can never point backward → u-turn is impossible.
const TURN_RATE = 1.2;    // rad/s at full tilt — calm
const STEER_EXPO = 1.8;   // non-linear response: small tilt = gentle, full = full lock
const MAX_HEADING = 1.25; // ~72° clamp (no u-turn; always some forward progress)
const STEER_SIGN = -1;    // tilt-to-steer direction (negated: tilt right → go right)
const WALL_SPEED_FRAC = 0.5; // curb speed cap as a fraction of the car's own top speed
const WALL_DECEL = 20.0;  // how fast you bleed down to the curb cap
const LAT_MARGIN = 0.3;   // keep the car body inside the curbs
const LOOKAHEAD = 8.0;    // world units down the centerline the camera aims at

// ---- Cornering (understeer, not auto-slowdown) ----
// The "Handling" stat IS the car's turn rate (c.turn). The sim does NOT brake for
// you: carry too much speed into a bend and a low-handling car simply can't yaw
// fast enough to hold the line (it needs κ·v rad/s, but maxes out at c.turn·
// authority) — so it washes wide (understeer) into the curb, which slows it. You
// have to brake yourself. A grippy car (high c.turn) holds a much tighter, faster
// line. That's the whole point of the stat: corners are where weight/handling bite.
// (AI + victory-lap cars brake for corners on their own — see AiDriver.cornerBrake.)

// ---- Car-car collisions ----
// Cars are glued to the centerline ribbon, so two nearby cars live in a locally
// flat plane spanned by arclength `totalS` and lateral offset `lat` (both world
// units). Collision is therefore a 2D box overlap in (s, lat): cheap, robust, and
// it "just works" through loops/hills because it never touches world XYZ.
const COLLIDE_SHRINK = 0.9;    // footprints a touch tighter than the mesh so a bump reads as contact, not a gap
const REAR_RESTITUTION = 0.25; // bounciness of a rear-end tap (0 = dead stick, 1 = elastic)
const LAT_KICK = 1.4;          // sideways shove speed (units/s) imparted on a side bump, split by mass
const KNOCK_DAMP = 6.0;        // how fast a sideways knock bleeds off (per second, exponential)

// Default per-car stats = the benchmark: accel/vmax/turn are multipliers on the
// base constants (1 = unchanged), `mass` is relative (only the ratio matters in a
// collision), and halfLen/halfWid are the collision footprint half-extents in
// world units (measured from the Kenney car meshes; see protocol.CAR_STATS).
const DEFAULT_STATS = { accel: 1, vmax: 1, turn: 1, mass: 1, halfLen: 0.44, halfWid: 0.26 };

// Merge a partial stats object over the benchmark so callers can override only
// what differs. A plain id (no stats) → an exact copy of the benchmark.
function normStats(s) {
  const o = { ...DEFAULT_STATS, ...(s || {}) };
  o.mass = Math.max(0.05, o.mass);
  o.halfLen = Math.max(0.05, o.halfLen);
  o.halfWid = Math.max(0.05, o.halfWid);
  return o;
}

// Race order: finished cars first (by finish time), then by distance covered.
// Shared by the live-position ranker and the final results so they can't disagree.
function byRaceOrder(a, b) {
  if (a.finished && b.finished) return a.finishTime - b.finishTime;
  if (a.finished) return -1;
  if (b.finished) return 1;
  return b.totalS - a.totalS;
}

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
    // Each entry is either a primitive id (→ benchmark stats) or {id, stats}.
    playerIds.forEach((desc, i) => {
      const id = (desc && typeof desc === 'object') ? desc.id : desc;
      const st = normStats(desc && typeof desc === 'object' ? desc.stats : null);
      const row = Math.floor(i / 2);
      const lane = (i % 2 === 0 ? -1 : 1) * Math.min(this.maxLat * 0.6, 0.5);
      this.cars.set(id, {
        id,
        totalS: 1.0 + row * 1.6,  // staggered grid on the opening straight (s>0)
        lat: lane,
        v: 0,
        vlat: 0,         // transient sideways velocity from a bump; decays (KNOCK_DAMP)
        heading: 0,      // car yaw relative to the track tangent (real steering)
        steer: 0,
        brake: 0,        // 0..1 analog brake (swipe distance)
        lap: 0,
        finished: false,
        finishTime: null,
        rank: i + 1,
        pose: null,
        // per-car handling, resolved from this car's model stats
        accel: ACCEL * st.accel,
        vmax: VMAX * st.vmax,
        turn: TURN_RATE * st.turn,        // yaw rate at full tilt = the "Handling" stat (caps corner speed via understeer)
        mass: st.mass,
        halfLen: st.halfLen,
        halfWid: st.halfWid
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

  // Drop a car whose player left mid-race: it forfeits and stops counting toward
  // `raceOver`, so the remaining cars aren't blocked by a ghost that can never
  // finish. Returns true if a car was removed. Caller re-checks `raceOver`.
  removeCar(id) {
    if (!this.cars.has(id)) return false;
    this.cars.delete(id);
    const i = this.finishedOrder.indexOf(id);
    if (i >= 0) this.finishedOrder.splice(i, 1);
    this._rank();
    return true;
  }

  update(dtMs) {
    const dt = Math.min(dtMs / 1000, 0.05);
    if (dt <= 0) return;
    this.elapsed += dt;

    for (const c of this.cars.values()) {
      c.onWall = false; // cleared once per frame; _clampCurb (main loop + post-collision) only sets it true
      // A finished car takes a victory lap on autopilot instead of stopping: the
      // engine steers it along the racing line at full cruise so the scene stays
      // alive while the rest of the field races. Its phone no longer drives it
      // (processInput rejects finished cars), it stays a collision ghost, and its
      // lap counter is frozen (the `c.finished` guard below skips lap detection).
      if (c.finished) { c.steer = pursue(c, this.centerline); c.brake = cornerBrake(c, this.centerline); }

      // LONGITUDINAL: auto-accelerate toward the brake-scaled cruise speed. brake is
      // analog (0..1): 0 → full speed, 0.5 → half speed, 1 → stop. No automatic
      // slow-for-the-corner — too hot into a bend and the car washes wide (below).
      const targetV = c.vmax * (1 - c.brake);
      if (c.v < targetV) c.v = Math.min(targetV, c.v + c.accel * dt);
      else c.v = Math.max(targetV, c.v - BRAKE_DECEL * dt);

      // STEERING (real): tilt turns the car's heading; you must steer through curves.
      // The per-car turn rate caps how sharply it can yaw, so if v exceeds what the
      // corner needs (κ·v > c.turn·authority) the car can't hold the line and runs
      // wide → understeer. authority ramps steering in with speed; non-linear so
      // small tilts barely steer.
      const authority = 0.4 + 0.6 * Math.min(1, c.v / (c.vmax * 0.5));
      const steerIn = Math.sign(c.steer) * Math.pow(Math.abs(c.steer), STEER_EXPO);
      c.heading += STEER_SIGN * steerIn * c.turn * authority * dt;

      const before = this.centerline.sampleAt(c.totalS);
      const along = Math.cos(c.heading), across = Math.sin(c.heading);
      const prevTotal = c.totalS;
      c.totalS += c.v * Math.max(0.1, along) * dt; // always some forward progress
      // lateral axis (tangent×up) points opposite the +heading rotation, so the
      // sideways motion is -sin(heading): the car moves the way it points. A bump
      // adds a transient sideways velocity (vlat) on top, which decays away.
      c.lat -= c.v * across * dt;
      c.lat += c.vlat * dt;
      c.vlat *= Math.exp(-KNOCK_DAMP * dt);

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
      this._clampCurb(c, dt);

      // Victory lap: a finished car keeps driving but no longer counts laps or
      // re-finishes — skip the lap/finish detection so it just circulates.
      if (c.finished) continue;

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

    // Cars are solid: shove overlapping pairs apart and trade momentum on contact.
    this._resolveCollisions(dt);

    this._recomputePoses();
    this._rank();
  }

  // Rubbing a curb pins the car just inside it and bleeds speed toward a cap (a
  // fraction of the car's own top speed) — slows you, never a hard stop. Shared by
  // the integration step and the post-collision re-clamp (a bump can shove a car
  // into the wall).
  _clampCurb(c, dt) {
    // onWall is cleared once per frame at the top of update()'s loop, not here —
    // this runs twice a frame (integration + post-collision re-clamp) and must not
    // wipe a contact the first pass already flagged (a car pinned at the curb sits
    // exactly AT maxLat, so the second pass wouldn't re-detect it).
    const cap = c.vmax * WALL_SPEED_FRAC;
    if (c.lat > this.maxLat || c.lat < -this.maxLat) {
      c.lat = c.lat > 0 ? this.maxLat : -this.maxLat;
      c.onWall = true;
      if (c.v > cap) c.v = Math.max(cap, c.v - WALL_DECEL * dt);
    }
  }

  // Car-car collisions in (totalS, lat) space. Two cars overlap when their
  // arclength gap AND lateral gap are both inside the summed footprints; we push
  // them apart along the axis of least penetration (classic AABB MTV), split by
  // mass so the heavier car barely moves. A rear-end overlap also trades speed
  // (the chaser slows, the car ahead gets nudged); a side overlap imparts a
  // sideways knock. Finished cars are ghosts so a coasting winner can't block the
  // pack at the line.
  _resolveCollisions(dt) {
    const list = [...this.cars.values()].filter((c) => !c.finished);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) this._collidePair(list[i], list[j], dt);
    }
    // A push may have driven a car past a curb — pin it back inside.
    for (const c of list) this._clampCurb(c, dt);
  }

  _collidePair(a, b, dt) {
    const ds = b.totalS - a.totalS;          // +: b is ahead of a along the track
    const dl = b.lat - a.lat;                // +: b sits to a's +lateral side
    const sumLen = (a.halfLen + b.halfLen) * COLLIDE_SHRINK;
    const sumWid = (a.halfWid + b.halfWid) * COLLIDE_SHRINK;
    const penS = sumLen - Math.abs(ds);
    const penL = sumWid - Math.abs(dl);
    if (penS <= 0 || penL <= 0) return;      // no overlap on one axis → no contact

    const mSum = a.mass + b.mass;
    const aShare = b.mass / mSum;            // lighter car takes the larger push
    const bShare = a.mass / mSum;

    if (penS <= penL) {
      // Longitudinal overlap → separate along the track and trade speed.
      const dir = ds >= 0 ? 1 : -1;          // push b forward, a backward (or vice-versa)
      a.totalS -= dir * penS * aShare;
      b.totalS += dir * penS * bShare;
      const rear = dir > 0 ? a : b;          // the car behind (catching up)
      const front = dir > 0 ? b : a;
      const rel = rear.v - front.v;
      if (rel > 0) {                         // only when actually closing in
        // 1D collision with restitution along the track: conserves momentum,
        // `rel` is the closing speed. Rear slows, front gets nudged forward.
        const p = rear.mass * rear.v + front.mass * front.v;
        rear.v = (p - front.mass * REAR_RESTITUTION * rel) / mSum;
        front.v = (p + rear.mass * REAR_RESTITUTION * rel) / mSum;
      }
    } else {
      // Lateral overlap → separate sideways and impart a decaying knock.
      const dir = dl >= 0 ? 1 : -1;          // push b to +lat, a to -lat (stacked → deterministic)
      a.lat -= dir * penL * aShare;
      b.lat += dir * penL * bShare;
      a.vlat -= dir * LAT_KICK * aShare;
      b.vlat += dir * LAT_KICK * bShare;
    }
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

  // Live race position from the shared race-order comparator.
  _rank() {
    const arr = [...this.cars.values()].sort(byRaceOrder);
    arr.forEach((c, i) => { c.rank = i + 1; });
  }

  getSnapshot() {
    const cars = [];
    for (const c of this.cars.values()) {
      cars.push({
        id: c.id, pose: c.pose, lat: c.lat, v: c.v, spd: c.v / c.vmax, // normalized 0..1 (per-car top speed)
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
    const ranked = [...this.cars.values()].sort(byRaceOrder);
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
