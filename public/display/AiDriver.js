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

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

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
// the brake at (1 - skill) on every straight, so a lower-skill bot is catchable.
// Cornering is always perfect (pure-pursuit never scrubs the curbs), so the
// cruise-speed handicap is the one balance lever that keeps a sloppy human in the
// race against a flawless line. `laneBias` holds the bot a fixed offset off the
// centerline so the field fans across the road instead of running nose-to-tail.
export class AiController {
  constructor({ skill = 0.9, lookahead = LOOKAHEAD, gain = STEER_GAIN, laneBias = 0 } = {}) {
    this.skill = clamp(skill, 0, 1);
    this.lookahead = lookahead;
    this.gain = gain;
    this.laneBias = laneBias;
  }
  // {s, b} ready to hand straight to engine.processInput(id, ...).
  drive(car, centerline) {
    const s = pursue(car, centerline, { lookahead: this.lookahead, gain: this.gain, laneBias: this.laneBias });
    return { s, b: 1 - this.skill };
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
