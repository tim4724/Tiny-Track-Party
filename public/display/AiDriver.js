// AiDriver — pure-pursuit autopilot for the AI ("CPU") cars that fill empty grid
// slots so a short-handed lobby still races a full field. Steers a car toward a
// point further along the track centerline: because the target sits ON the
// racing line, the same term both recenters lateral drift and anticipates the
// upcoming curvature, so bots hold the line instead of scrubbing the curbs.
//
// This is the one source of truth for how bots drive, shared by the live race
// (display/main.js) and the gallery preview (TestHarness). It operates on engine
// car POSES — the THREE.Vector3s the engine already placed on car.pose — so it
// imports no THREE and always reads the same frame the engine produced.

const LOOKAHEAD = 7.5;   // world units down the centerline a bot aims at
const STEER_GAIN = 1.8;  // steer per radian of heading error (proportional)
const AI_ITEM_HOLD = 70; // frames a bot holds a fresh item before firing (~1.2s @60fps; lets the pickup roulette finish)

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// ---- corner-anticipation braking ----
// The engine no longer auto-slows for corners (low-handling cars understeer wide
// instead), so a bot that just steers would plow into the curb. cornerBrake looks
// down the track, finds the tightest upcoming bend, and brakes so the car arrives
// no faster than its turn rate can hold (max corner speed ≈ turn/κ). A low-handling
// car brakes earlier + harder; a grippy one barely lifts.
const TURN_RATE_FALLBACK = 1.2; // matches Game's base TURN_RATE (cars without a resolved .turn)
const BRAKE_LOOK_NEAR = 1.5;    // start scanning this far ahead (world units)
const BRAKE_LOOK_FAR = 15.0;    // ...to here — far enough to shed speed before the apex
const BRAKE_LOOK_STEP = 1.0;
const CORNER_MARGIN = 0.78;     // target well under the max holdable corner speed (pure-pursuit cuts the apex, so leave room)
const BRAKE_RANGE = 1.6;        // units/s over the safe speed that maps to full brake (firm, early lift)

// Local track curvature (rad per world unit) at arclength s — the turn between two
// nearby centerline tangents, via the same cross/dot trick the steering uses (so
// no THREE import; works on the Vector3s sampleAt already returns).
function curvatureAt(centerline, s, step = 0.6) {
  const a = centerline.sampleAt(s), b = centerline.sampleAt(s + step);
  const cross = a.tangent.clone().cross(b.tangent).dot(b.up);
  const dot = a.tangent.dot(b.tangent);
  return Math.abs(Math.atan2(cross, dot)) / step;
}

// Brake (0..1) so the car reaches the tightest bend in the look-ahead window no
// faster than it can hold. `turn` overrides car.turn (the per-car yaw rate). Used
// by both the AI bots and a finished car's victory lap (engine), so neither washes
// wide now that the sim leaves corner speed to the driver.
export function cornerBrake(car, centerline, { turn } = {}) {
  if (!car || !centerline) return 0;
  const yaw = turn || car.turn || TURN_RATE_FALLBACK;
  let vSafe = Infinity;
  for (let d = BRAKE_LOOK_NEAR; d <= BRAKE_LOOK_FAR; d += BRAKE_LOOK_STEP) {
    const k = curvatureAt(centerline, car.totalS + d);
    if (k > 1e-3) vSafe = Math.min(vSafe, (CORNER_MARGIN * yaw) / k);
  }
  if (!isFinite(vSafe) || car.v <= vSafe) return 0;
  return clamp((car.v - vSafe) / BRAKE_RANGE, 0, 1);
}

// Steer one engine car toward the centerline lookahead point (optionally offset
// to a held lane). Returns a steer input in [-1, 1] for engine.processInput {s}.
export function pursue(car, centerline, { lookahead = LOOKAHEAD, gain = STEER_GAIN, laneBias = 0 } = {}) {
  if (!car || !car.pose) return 0;
  const f = centerline.sampleAt(car.totalS + lookahead);
  const tgt = f.pos.clone().addScaledVector(f.lateral, laneBias);
  const up = car.pose.up, fwd = car.pose.forward;
  const to = tgt.sub(car.pose.pos);
  to.addScaledVector(up, -to.dot(up)); // flatten onto the road plane
  if (to.lengthSq() < 1e-6) return 0;
  to.normalize();
  const cross = fwd.clone().cross(to).dot(up);
  const dot = clamp(fwd.dot(to), -1, 1);
  const err = Math.atan2(cross, dot); // + = target is to the car's left
  // The engine yaws the car by STEER_SIGN(-1)·f(steer), so a NEGATIVE steer turns
  // toward a LEFT target — hence the leading minus.
  return clamp(-err * gain, -1, 1);
}

// A bot personality. `skill` is the fraction of top speed it cruises at: it holds
// the brake at (1 - skill) on the straights, so a lower-skill bot is catchable.
// On top of that the bot brakes for corners it can't hold (cornerBrake), so a
// low-handling car (e.g. a Truck bot) visibly slows for bends while a grippy one
// rails them — the same trade a human feels. `laneBias` holds the bot a fixed
// offset off the centerline so the field fans across the road, not nose-to-tail.
export class AiController {
  constructor({ skill = 0.9, lookahead = LOOKAHEAD, gain = STEER_GAIN, laneBias = 0 } = {}) {
    this.skill = clamp(skill, 0, 1);
    this.lookahead = lookahead;
    this.gain = gain;
    this.laneBias = laneBias;
  }
  // {s, b, u} ready to hand straight to engine.processInput(id, ...). `u` is a
  // wrapping use-counter (same protocol as the phone's ACTION button): a bot HOLDS a
  // freshly-collected item for a beat (AI_ITEM_HOLD frames) — so it reads on screen
  // and the pickup roulette can finish — then fires it on a STRAIGHT (corner
  // anticipation ≈ 0): boost where it pays off, a banana dropped for chasers. CPU
  // cars thus contest items instead of hoarding. Deterministic (no RNG): the counter
  // only advances on the use frame.
  drive(car, centerline) {
    const s = pursue(car, centerline, { lookahead: this.lookahead, gain: this.gain, laneBias: this.laneBias });
    const corner = cornerBrake(car, centerline);
    if (this._useSeq == null) this._useSeq = 0;
    const item = car && car.item;
    if (item && item === this._lastItem) this._heldFrames = (this._heldFrames || 0) + 1;
    else { this._lastItem = item || null; this._heldFrames = 0; } // fresh pickup → restart the hold
    if (item && this._heldFrames >= AI_ITEM_HOLD && corner < 0.05) this._useSeq = (this._useSeq + 1) & 255;
    return { s, b: Math.max(1 - this.skill, corner), u: this._useSeq };
  }
}

// Bot field, strongest first. Tuned for the OVAL (maxLat ~1.5): a spread of
// cruise speeds and held lanes so the AI feels like distinct racers, the tail bot
// is beatable by a first-timer, and the lead bot rewards clean driving. Bots are
// filled from the front, so a lobby missing a single player gets the strong leader.
export const AI_PERSONALITIES = [
  { name: 'Bolt',  skill: 0.95, laneBias: -0.6 },
  { name: 'Pixel', skill: 0.88, laneBias:  0.6 },
  { name: 'Rusty', skill: 0.82, laneBias: -0.25 },
  { name: 'Zippy', skill: 0.78, laneBias:  0.25 },
];
