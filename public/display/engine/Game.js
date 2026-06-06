// Game — authoritative ribbon-follow car simulation. Cars are glued to the
// track centerline: each car has progress `s` (arclength), lateral offset `lat`,
// and speed `v`. Auto-accelerate forward; steer moves laterally; brake slows.
// Loops/hills "just work" because the car follows the ribbon's pos/tangent/up.
//
// Contract (mirrors the HexStacker engine seams):
//   new Game(playerIds, { centerline, length, roadWidth, totalLaps }, { onEvent })
//   update(dtMs) / processInput(id, {s,b,u}) / getSnapshot() / getResults()

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

// ---- Oil slicks (track hazards) ----
// A puddle is a circle in (s, lat) space — the same locally-flat plane the car-car
// collisions live in, so detection is cheap and "just works" through loops/hills.
// Drive a car's CENTRE onto one and it SPINS OUT: steering goes dead and speed
// bleeds for SPIN_TIME while the body whirls (the spin is cosmetic — the sim
// heading is untouched; the renderer reads snapshot.spin). Detection is RISING-
// EDGE per puddle (enter → trigger once), so a car parked on a slick spins a
// single time, not every frame — it must leave and re-enter to spin again.
// Numbers are STARTING VALUES (tune in playtest). Hitting oil is NOT an abrupt
// stop: the car loses grip — throttle cuts and a gentle drag bleeds speed — so it
// keeps rolling THROUGH the slick and spins out behind it. OIL_RADIUS is only a
// fallback; the display sizes each puddle to a fraction of the track width.
const OIL_RADIUS = 0.7;        // default puddle radius (world units) when a hazard omits one
const SPIN_TIME = 1.0;         // seconds of lost control per spin-out
const SPIN_DRAG = 2.5;         // gentle deceleration (units/s²) while spinning — coasts through, no hard stop
const SPIN_TURNS = 2;          // cosmetic whole turns over SPIN_TIME (a multiple of 2π → no snap on reset)

// ---- Catch-up mechanics (boost pads + items) ----
// The whole "help the cars behind" system rides on ONE per-car factor t∈[0,1]
// (0 = leader, 1 = last), recomputed each frame from the field's SPREAD along the
// track. Boost pads scale a boost MAGNITUDE by t; item boxes roll from a t-WEIGHTED
// table. Same factor, same direction ("further back → better stuff"), one mental
// model. Two flavours are stored: tRaw (unsmoothed — pads read it at the cross
// frame so a position swap can't invert the boost) and tCatch (smoothed — item
// rolls read it so a momentary swap doesn't flip a roll). All STARTING VALUES.
const SPREAD_REF_FRAC = 0.15;  // spread-denominator floor = 15% of lap length (never divide by a bunched pack)
const T_TAU = 0.6;             // tCatch smoothing time-constant (s)
// Boost: a transient multiplier on the speed ceiling that bleeds gently after it
// expires (so it doesn't fight BRAKE_DECEL's snap-back). Pads scale the peak by t;
// the boost ITEM is a fixed, position-independent burst.
const PAD_BOOST_MIN = 1.25;    // pad peak ×vmax for the leader (t=0) — never a dead pad
const PAD_BOOST_MAX = 1.60;    // pad peak ×vmax for last place (t=1)
const BOOST_DURATION = 1.4;    // flat-hold boost time (s) from a pad
const BOOST_ITEM_MUL = 1.5;    // boost-item peak ×vmax (position-independent — it's earned)
const BOOST_ITEM_DURATION = 1.6; // flat-hold boost time (s) from a used boost item
// A freshly-ROLLED item can't be fired until this many seconds after pickup, so it
// can't be used before the player sees what they got — the gate covers the HUD's
// reveal roulette (~0.86s, see SceneRenderer._rouletteChip). Items set by any other
// path (tests, direct assignment) start usable. The buffered ACTION press still
// fires on the first frame past the gate, so a tap during the reveal isn't lost.
const ITEM_USE_READY = 0.9;    // starting value — bump if the reveal grows
const BOOST_ACCEL = 22.0;      // ramp toward the boosted ceiling (u/s²) — snappy
const BOOST_FADE = 0.5;        // after the hold, ease the multiplier back to 1 at this rate (×/s) → a gentle taper, not a snap
const PAD_RADIUS = 0.65;       // fallback pad radius (the display sizes it per track)
const BOX_RADIUS = 0.65;       // fallback item-box radius
const BOX_RESPAWN = 4.0;       // seconds an item box stays empty after a pickup
const LAUNCH_GATE = 1.5;       // no pickups until the grid unbunches (kills launch grief)
const BANANA_RADIUS = 0.6;     // dropped-banana trigger radius
const BANANA_LIFE = 12.0;      // seconds a dropped banana persists before it vanishes
const BANANA_ARM = 0.4;        // grace before a banana is live (so a shoved dropper can't self-trip)
const BANANA_BACK = 1.2;       // how far behind the dropper a banana lands (units)

// Position-weighted item table. weight(t) = max(0, base + slope·t); normalised at
// roll time (t = 0 leader … 1 last). A clean mirror so the LEADER mostly draws the
// defensive Banana (a trap to drop behind — doesn't extend the lead) and the back
// mostly draws the comeback Boost: leader 20% boost / 80% banana, midfield 50/50,
// last 80% boost / 20% banana.
const ITEM_TABLE = [
  { id: 'boost',  base: 1.0, slope:  3.0 },
  { id: 'banana', base: 4.0, slope: -3.0 }
];

// Tiny seeded PRNG (mulberry32). Item rolls draw from this so a race is fully
// reproducible from its seed under a fixed dt (the Node tests) — never the JS
// global RNG. Live races vary their dt, so they aren't bit-reproducible; that's
// fine, only the tests need determinism.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

    // Authored oil slicks for this track: { s (arclength), lat, radius }. The
    // display resolves them from the track catalogue (fraction-of-lap → arclength);
    // tests set track.hazards directly. Missing on a hazard-less track → no slicks.
    this.hazards = (track.hazards || []).map((h) => ({
      s: h.s, lat: h.lat || 0, radius: h.radius || OIL_RADIUS
    }));

    // Boost pads (drive-over speed strips) and item boxes (drive-over pickups),
    // resolved by the display from the track catalogue (fraction-of-lap → arclength)
    // exactly like oil slicks; tests set track.pads/track.boxes directly. Boxes
    // carry a respawn cooldown; bananas are dropped at runtime (not authored).
    this.pads = (track.pads || []).map((p) => ({ s: p.s, lat: p.lat || 0, radius: p.radius || PAD_RADIUS }));
    this.boxes = (track.boxes || []).map((b) => ({ s: b.s, lat: b.lat || 0, radius: b.radius || BOX_RADIUS, cooldown: 0 }));
    this.bananas = [];      // [{ id, s, lat, life, armT, owner }] — live dropped bananas
    this._bananaSeq = 0;
    // Deterministic item rolls from a per-race seed (track.seed; default if unset).
    this.rng = mulberry32(((track.seed != null ? track.seed : 0x1A2B3C4D) >>> 0) || 1);

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
        spin: 0,         // cosmetic spin-out angle (rad) — renderer whirls the body by this
        spinT: 0,        // seconds left in the current spin-out (0 = in control)
        oilIn: new Set(),// puddle indices the car currently overlaps (rising-edge trigger)
        padIn: new Set(),// pad indices currently overlapped (rising-edge boost)
        boxIn: new Set(),// box indices currently overlapped (rising-edge pickup)
        bananaIn: new Set(), // banana ids currently overlapped (rising-edge spin)
        boostT: 0,       // seconds left on an active boost (0 = none)
        boostMul: 1,     // current boost multiplier on the speed ceiling
        item: null,      // held item id (null = empty slot)
        pickupAge: 999,  // seconds since the held item was ROLLED from a box (gates use; see ITEM_USE_READY). Large so a directly-set item is usable at once
        useSeq: 0,       // last seen use-counter from the controller (dedup; matches the controller's reset)
        wantUse: false,  // a fresh ACTION press is queued for this frame
        tRaw: 0,         // catch-up factor, unsmoothed (pads read this)
        tCatch: 0,       // catch-up factor, smoothed (item rolls read this)
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
    this._rank(); // race-correct positions from frame 0 (grid order ≠ race order on lap 1)
  }

  processInput(id, msg) {
    const c = this.cars.get(id);
    if (!c || c.finished) return;
    if (typeof msg.s === 'number') c.steer = Math.max(-1, Math.min(1, msg.s));
    if (typeof msg.b === 'number') c.brake = Math.max(0, Math.min(1, msg.b));
    else if (typeof msg.b === 'boolean') c.brake = msg.b ? 1 : 0;
    // ACTION button: a wrapping use-counter (rides the latest-wins fastlane, so a
    // dropped frame just re-delivers the same value). Fire once per fresh value.
    if (typeof msg.u === 'number' && msg.u !== c.useSeq) { c.useSeq = msg.u; c.wantUse = true; }
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
    this._computeCatchUp(dt);   // per-car tRaw/tCatch from the field spread
    this._tickProps(dt);        // box respawn cooldowns + banana life/arm

    for (const c of this.cars.values()) {
      c.onWall = false; // cleared once per frame; _clampCurb (main loop + post-collision) only sets it true
      // A finished car takes a victory lap on autopilot instead of stopping: the
      // engine steers it along the racing line at full cruise so the scene stays
      // alive while the rest of the field races. Its phone no longer drives it
      // (processInput rejects finished cars), it stays a collision ghost, and its
      // lap counter is frozen (the `c.finished` guard below skips lap detection).
      if (c.finished) { c.steer = pursue(c, this.centerline); c.brake = cornerBrake(c, this.centerline); }

      // SPIN-OUT (oil slick OR a dropped banana): tick down any active spin (whirling
      // the cosmetic angle, landing back on 0), then test both hazards rising-edge and
      // trigger a fresh spin. While spinning, steering is dead — a clean, recoverable
      // penalty. A spin-out also KILLS an active boost (so oil/banana can't just pause
      // a boost that then re-bursts on recovery). Finished (ghost) cars skip it.
      let spinning = c.spinT > 0;
      if (spinning) {
        c.spinT -= dt;
        c.spin += (SPIN_TURNS * 2 * Math.PI / SPIN_TIME) * dt;
        if (c.spinT <= 0) { c.spinT = 0; c.spin = 0; spinning = false; }
      }
      if (!c.finished) {
        const oil = this._enterOil(c);
        const ban = this._enterBanana(c);
        if (oil || ban) {
          // A fresh hazard (re)arms the spin: entering a SECOND slick/banana mid-spin
          // extends it rather than being silently swallowed (the rising-edge sets keep
          // one slick from re-firing every frame). Keep the whirl angle continuous if
          // already spinning. A spin also kills any active boost — no banked re-burst.
          if (!spinning) c.spin = 0;
          c.spinT = SPIN_TIME; spinning = true;
          c.boostT = 0; c.boostMul = 1;
        }
      }

      // CATCH-UP FEATURES (live cars): fire a held item, arm a boost pad, grab a box.
      if (!c.finished) {
        c.pickupAge += dt; // ages the held item toward ITEM_USE_READY (reset on a fresh roll)
        // press-to-use: fire the held item, but BUFFER the press across a spin-out OR the
        // post-pickup reveal gate (fires the first eligible frame) instead of swallowing
        // it. A press with no item is dropped.
        if (c.wantUse && c.item && !spinning && c.pickupAge >= ITEM_USE_READY) { c.wantUse = false; this._useItem(c); }
        else if (c.wantUse && !c.item) c.wantUse = false;
        if (!spinning && this._enterPad(c)) this._applyPad(c);          // position-scaled boost
        if (this.elapsed > LAUNCH_GATE) this._enterBox(c);             // roll a held item (gated)
      }

      // LONGITUDINAL: a boost is a flat HOLD at peak (boostT) followed by a gentle
      // multiplier FADE back to 1 (BOOST_FADE) — so the ceiling eases down and the car
      // tapers off rather than snapping at BRAKE_DECEL. Then accelerate toward the
      // (boosted) brake-scaled cruise ceiling. brake is analog 0..1: 0 → full speed,
      // 0.5 → half, 1 → stop. On a slick the car loses grip: NO throttle, just a gentle
      // drag, so it coasts through the hazard.
      if (c.boostT > 0) { c.boostT -= dt; if (c.boostT < 0) c.boostT = 0; }
      else if (c.boostMul > 1) c.boostMul = Math.max(1, c.boostMul - BOOST_FADE * dt); // post-hold taper
      const boosting = c.boostMul > 1;
      const targetV = c.vmax * c.boostMul * (1 - c.brake);
      if (spinning) c.v = Math.max(0, c.v - SPIN_DRAG * dt);
      else if (c.v < targetV) c.v = Math.min(targetV, c.v + (boosting ? BOOST_ACCEL : c.accel) * dt);
      else c.v = Math.max(targetV, c.v - BRAKE_DECEL * dt);

      // STEERING (real): tilt turns the car's heading; you must steer through curves.
      // The per-car turn rate caps how sharply it can yaw, so if v exceeds what the
      // corner needs (κ·v > c.turn·authority) the car can't hold the line and runs
      // wide → understeer. authority ramps steering in with speed; non-linear so
      // small tilts barely steer.
      const authority = 0.4 + 0.6 * Math.min(1, c.v / (c.vmax * 0.5));
      const steerEff = spinning ? 0 : c.steer; // a spinning car can't steer
      const steerIn = Math.sign(steerEff) * Math.pow(Math.abs(steerEff), STEER_EXPO);
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
          c.item = null; c.wantUse = false; // drop any held item so the controller's USE button goes dark
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

  // Update which oil slicks `c` overlaps and report whether it ENTERED any this
  // tick (rising edge). Distance is measured in the same (arclength, lateral)
  // plane as the car-car collisions, with the arclength gap wrapped to the
  // shortest way round the closed lap. Membership is kept so a car sitting on a
  // slick doesn't re-trigger every frame — only a fresh enter spins it out.
  _enterOil(c) {
    if (!this.hazards.length) return false;
    let entered = false;
    for (let i = 0; i < this.hazards.length; i++) {
      const h = this.hazards[i];
      let ds = c.totalS - h.s;
      ds -= Math.round(ds / this.length) * this.length; // shortest wrap around the lap
      const dl = c.lat - h.lat;
      const inside = (ds * ds + dl * dl) < (h.radius * h.radius);
      if (inside) { if (!c.oilIn.has(i)) { c.oilIn.add(i); entered = true; } }
      else c.oilIn.delete(i);
    }
    return entered;
  }

  // Catch-up factor per LIVE car: t = how far behind the leader, normalised by the
  // field spread (floored so a bunched pack doesn't blow up). tRaw is read by pads
  // (at the cross frame — must not lag a position swap); tCatch is the smoothed value
  // item rolls read. Finished cars are coasting ghosts and excluded from the spread.
  _computeCatchUp(dt) {
    let lead = -Infinity, tail = Infinity, n = 0;
    for (const c of this.cars.values()) {
      if (c.finished) continue;
      n++;
      if (c.totalS > lead) lead = c.totalS;
      if (c.totalS < tail) tail = c.totalS;
    }
    if (!n) return;
    const denom = Math.max(lead - tail, SPREAD_REF_FRAC * this.length);
    const k = 1 - Math.exp(-dt / T_TAU);
    for (const c of this.cars.values()) {
      if (c.finished) { c.tRaw = 0; c.tCatch = 0; continue; }
      let raw = (lead - c.totalS) / denom;
      raw = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      c.tRaw = raw;
      c.tCatch += (raw - c.tCatch) * k;
    }
  }

  // Per-frame prop upkeep: respawn item boxes, age dropped bananas, drop dead ones.
  _tickProps(dt) {
    for (const b of this.boxes) if (b.cooldown > 0) b.cooldown = Math.max(0, b.cooldown - dt);
    if (this.bananas.length) {
      for (const b of this.bananas) { b.life -= dt; if (b.armT > 0) b.armT -= dt; }
      const dead = this.bananas.filter((b) => b.life <= 0);
      if (dead.length) {
        this.bananas = this.bananas.filter((b) => b.life > 0);
        // sweep the expired ids out of every car's overlap set (ids never repeat, so
        // they couldn't false-trigger — this just stops the sets growing unbounded).
        for (const c of this.cars.values()) for (const b of dead) c.bananaIn.delete(b.id);
      }
    }
  }

  // Rising-edge overlap of a boost PAD (same (s,lat) test as oil). Returns true on a
  // fresh entry so the caller arms one boost per cross, not one per frame.
  _enterPad(c) {
    if (!this.pads.length) return false;
    let entered = false;
    for (let i = 0; i < this.pads.length; i++) {
      const p = this.pads[i];
      let ds = c.totalS - p.s; ds -= Math.round(ds / this.length) * this.length;
      const dl = c.lat - p.lat;
      if ((ds * ds + dl * dl) < (p.radius * p.radius)) { if (!c.padIn.has(i)) { c.padIn.add(i); entered = true; } }
      else c.padIn.delete(i);
    }
    return entered;
  }

  // Arm/refresh a position-scaled boost: peak ×vmax interpolates leader→last by tRaw.
  // Assignment via Math.max (never accumulation) so pads/items can't compound into a
  // teleport; the timer is re-armed each cross.
  _applyPad(c) {
    const mul = PAD_BOOST_MIN + (PAD_BOOST_MAX - PAD_BOOST_MIN) * c.tRaw;
    c.boostMul = Math.max(c.boostMul, mul);
    c.boostT = Math.max(c.boostT, BOOST_DURATION);
  }

  // Rising-edge overlap of an item BOX. A box on cooldown is inert. A car with a
  // full slot does NOT consume the box (it stays live for the next car) — so holding
  // an item means forfeiting every box you pass (defuses hoarding). On a fresh pickup
  // the box goes on cooldown and the car rolls a t-weighted item.
  _enterBox(c) {
    if (!this.boxes.length) return;
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      let ds = c.totalS - b.s; ds -= Math.round(ds / this.length) * this.length;
      const dl = c.lat - b.lat;
      const inside = b.cooldown <= 0 && (ds * ds + dl * dl) < (b.radius * b.radius);
      if (inside && !c.boxIn.has(i)) {
        if (c.item == null) { c.item = this._roll(c.tCatch); c.pickupAge = 0; b.cooldown = BOX_RESPAWN; c.boxIn.add(i); }
        // full slot: leave membership unset so it re-checks next frame (auto-grabs the
        // instant the slot frees while still on the box).
      } else if (!inside) { c.boxIn.delete(i); }
    }
  }

  // Weighted item roll using the seeded PRNG. weight(t)=max(0, base+slope·t).
  _roll(t) {
    let total = 0; const w = [];
    for (const it of ITEM_TABLE) { const x = Math.max(0, it.base + it.slope * t); w.push(x); total += x; }
    let r = this.rng() * total;
    for (let i = 0; i < ITEM_TABLE.length; i++) { r -= w[i]; if (r <= 0) return ITEM_TABLE[i].id; }
    return ITEM_TABLE[ITEM_TABLE.length - 1].id;
  }

  // Fire the held item (press-to-use). Boost reuses the pad boost state; Banana drops
  // a live hazard just behind the dropper (owner-skipped + armed so it can't self-trip).
  _useItem(c) {
    if (c.item === 'boost') {
      c.boostMul = Math.max(c.boostMul, BOOST_ITEM_MUL);
      c.boostT = Math.max(c.boostT, BOOST_ITEM_DURATION);
    } else if (c.item === 'banana') {
      let s = c.totalS - BANANA_BACK; s = ((s % this.length) + this.length) % this.length;
      this.bananas.push({ id: ++this._bananaSeq, s, lat: c.lat, life: BANANA_LIFE, armT: BANANA_ARM, owner: c.id });
    }
    c.item = null;
  }

  // Rising-edge overlap of a live dropped banana (skips the owner and un-armed ones).
  // Returns true on a fresh entry → caller spins the car out (reusing the oil spin).
  _enterBanana(c) {
    if (!this.bananas.length) return false;
    let entered = false;
    for (const b of this.bananas) {
      const skip = b.owner === c.id || b.armT > 0;
      let ds = c.totalS - b.s; ds -= Math.round(ds / this.length) * this.length;
      const dl = c.lat - b.lat;
      const inside = !skip && (ds * ds + dl * dl) < (BANANA_RADIUS * BANANA_RADIUS);
      if (inside) { if (!c.bananaIn.has(b.id)) { c.bananaIn.add(b.id); entered = true; } }
      else c.bananaIn.delete(b.id);
    }
    return entered;
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
        up: f.up
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
        // v (raw speed) + lat (lateral offset) are the engine's physics observables —
        // the in-game display only needs normalized spd, but the unit tests assert on them.
        id: c.id, pose: c.pose, lat: c.lat, v: c.v, spd: c.v / c.vmax, // spd normalized 0..1 (per-car top speed)
        lap: Math.min(this.totalLaps, c.lap + (c.totalS >= 0 ? 1 : 0)), // 1-based display lap
        totalLaps: this.totalLaps, position: c.rank, of: this.cars.size,
        // steer is reported TURN-ALIGNED: its sign matches the way the car actually
        // turns (= STEER_SIGN * raw input), so the renderer's front wheels + body
        // lean line up with the turn without the renderer needing to know STEER_SIGN.
        // steerInput is the RAW player input (matches the phone's steer bar) and
        // drives the on-screen steer indicator.
        finished: c.finished, finishTime: c.finishTime, steer: STEER_SIGN * c.steer, steerInput: c.steer, brake: c.brake, onWall: !!c.onWall,
        spin: c.spin, // cosmetic spin-out angle (rad) for the renderer to whirl the body
        // catch-up + item observables: boostActive/boostMul drive the boost FX (intensity
        // telegraphs the position-scaled size); item is the held pickup (HUD + controller).
        item: c.item, boostActive: c.boostMul > 1.001, boostMul: c.boostMul, tCatch: c.tCatch,
        // collision footprint + arclength — only used by the renderer's debug bbox overlay.
        totalS: c.totalS, halfLen: c.halfLen, halfWid: c.halfWid
      });
    }
    // Static boxes (available = off cooldown) + live dropped bananas, for the renderer
    // to show/hide box meshes and reconcile banana meshes by id.
    return {
      cars, elapsed: this.elapsed,
      boxes: this.boxes.map((b) => b.cooldown <= 0),
      bananas: this.bananas.map((b) => ({ id: b.id, s: b.s, lat: b.lat, radius: BANANA_RADIUS }))
    };
  }

  getResults() {
    const ranked = [...this.cars.values()].sort(byRaceOrder);
    return {
      elapsed: this.elapsed,
      results: ranked.map((c, i) => ({
        playerId: c.id, rank: i + 1, finished: c.finished,
        time: c.finishTime
      }))
    };
  }

  get raceOver() { return this.finishedOrder.length >= this.cars.size; }
}
