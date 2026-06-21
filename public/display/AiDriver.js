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
import { mulberry32, wrapDelta } from './engine/util.js';

const LOOKAHEAD = 7.5;   // world units down the centerline a bot aims at
const STEER_GAIN = 1.8;  // steer per radian of heading error (proportional)

// ---- held-item firing (see AiController.drive / _wantsToUse) ----
// A bot used to dump every item on a fixed ~1.2s timer, so it looked like it fired on
// pickup and the whole field fired on one cadence. Now each pickup gets a SEEDED,
// randomised minimum hold, and the bot then waits for a moment the item actually pays.
const AI_HOLD_MIN = 90;   // frames a bot sits on a fresh item before it'll consider firing (~1.5s @60fps — covers the pickup roulette and kills "fires on pickup")
const AI_HOLD_SPAN = 150; // + up to this many more frames, seeded per pickup, so the field doesn't fire on one shared cadence (≈1.5–4.0s total)
const AI_HOLD_MAX = 480;  // after ~8s a bot stops waiting for the perfect opening and takes the next one (holding forfeits every box it passes — don't hoard)
const BANANA_DROP_FAR = 14;   // world units: drop a banana only when a rival is this close behind (a real trap, not litter on empty track)
const ROCKET_FIRE_RANGE = 80; // cumulative units: fire a rocket only when the car ahead is within reach (beyond this a homing shot just whiffs)

// ---- organic steer wander (seeded) ----
// Bots used to rail one fixed lane forever, which read as robotic. Each bot now eases
// a seeded signal toward a periodically re-rolled target and adds it to its STEER —
// a smooth, organic weave. (We perturb the steer, not the lane: the engine's expo
// steering swallows small lane offsets, but a steer nudge integrates into visible
// drift that pursue gently corrects, so it stays bounded.) The randomness is a PER-BOT
// seeded stream (mulberry32, engine/util.js) — never Math.random — so a seeded race replays
// identically. It's the deliberate "a few real mistakes" cost of looking alive.
const STEER_WANDER = 0.12; // amplitude of the steer weave added to a bot's input (0..1) — small: enough to look alive, not enough to cost real time
const WEAVE_EASE = 0.045;  // per-frame lerp toward the current target — smooth drift, not twitch
const WEAVE_HOLD_MIN = 35, WEAVE_HOLD_SPAN = 55; // frames a target holds before re-roll (~0.6–1.5s @60fps)
const WANDER_FADE = 0.5;   // pursue-steer magnitude at which the weave fully fades — kill it while cornering (the curb is close there) but keep it on straights
const WANDER_CURB = 1.3;   // lateral room (to the curb) below which the weave fades — never nudge a car that has drifted wide onto the rail

// ---- hazard evasion ----
// Bots now steer around oil slicks and live bananas that sit on their line, instead
// of plowing through and spinning out for free. We scan ahead and, for the nearest
// hazard overlapping the intended lane, aim past it on the side with the most corridor
// room — using a short, FIXED lookahead so the cut is sharp and early enough to clear
// in time (the expo steering ignores gentle ones). Evasion overrides the wander.
const EVADE_NEAR = -1.5;  // keep holding the dodge until the hazard is this far BEHIND (don't cut back early and clip it)
const EVADE_FAR = 13.0;   // start considering hazards this far ahead (world units) — commit early
const EVADE_CLEAR = 0.5;  // lateral gap to leave around a hazard (car half-width + margin)
const EVADE_LOOK = 3.5;   // fixed (short) steering lookahead while evading — sharp enough to reach the gap before the hazard (pure-pursuit lags position, so aim close), but not so tight it overshoots onto the curb
const BANANA_AVOID_R = 0.6; // mirrors the engine's BANANA_RADIUS (bananas carry no radius field)

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// ---- race-context reads for item timing ----
// Nearest live rival physically behind on the ribbon (wrapped to the nearest lap copy),
// in world units — the car most likely to drive over a banana we drop. Infinity when the
// track's empty behind us or there's no game (the gallery preview passes none).
function nearestBehind(car, game) {
  if (!game || !game.cars) return Infinity;
  const L = game.length;
  let best = Infinity;
  for (const o of game.cars.values()) {
    if (o.id === car.id || o.finished) continue;
    const ds = wrapDelta(car.totalS - o.totalS, L); // + = o sits behind us
    if (ds > 0 && ds < best) best = ds;
  }
  return best;
}

// Cumulative arclength gap to the car directly AHEAD in the standings — the rocket's
// lock target (mirrors the engine's _nextCarAhead, which fires on cumulative totalS so a
// back-marker locks the car one place up, not whoever's physically nearest). null when
// this car is the leader (nothing ahead → a rocket would whiff).
function gapToCarAhead(car, game) {
  if (!game || !game.cars) return null;
  let best = null;
  for (const o of game.cars.values()) {
    if (o.id === car.id || o.finished) continue;
    const gap = o.totalS - car.totalS;
    if (gap > 0 && (best == null || gap < best)) best = gap;
  }
  return best;
}

// Find the nearest hazard sitting on the bot's intended line and pick a lane past it.
// `game` exposes hazards (oil: {s,lat,radius}) + bananas ({s,lat,owner}) in centerline
// space; we aim for the side with the most corridor room. Returns the dodge lane (world
// units off the centerline) for the caller to steer to, or null when the path is clear.
function avoidThreat(car, lane, game, maxLat) {
  if (!game || !game.length) return null;
  const L = game.length;
  let best = null, bestDs = Infinity;
  const consider = (h, radius) => {
    const ds = wrapDelta(h.s - car.totalS, L);               // wrap to the nearest copy
    if (ds < EVADE_NEAR || ds > EVADE_FAR) return;           // behind/abreast, or too far to matter yet
    if (Math.abs(lane - h.lat) > radius + EVADE_CLEAR) return; // off to the side — not on our line
    if (ds < bestDs) { bestDs = ds; best = { lat: h.lat, r: radius }; }
  };
  for (const h of (game.hazards || [])) consider(h, h.radius);
  for (const p of (game.poles || [])) consider(p, p.radius);  // solid poles: dodge like an oil, but they STOP you, not spin you
  for (const b of (game.bananas || [])) if (b.owner !== car.id) consider(b, BANANA_AVOID_R); // skip our own bananas — they can't spin us (matches the engine's _enterBanana)
  if (!best) return null;
  const m = Math.max(0.1, maxLat - 0.1);                     // keep the dodge inside the curb
  const off = best.r + EVADE_CLEAR;
  const left = best.lat - off, right = best.lat + off;       // the two ways past it
  const okL = left >= -m, okR = right <= m;
  if (okL && okR) {
    // prefer the side with MORE room to the curb (a wide hazard can put one gap right
    // on the rail — don't dodge into it); tie-break toward the bot's current lane.
    const clearL = m - Math.abs(left), clearR = m - Math.abs(right);
    if (Math.abs(clearL - clearR) < 0.05) return Math.abs(left - lane) <= Math.abs(right - lane) ? left : right;
    return clearL > clearR ? left : right;
  }
  if (okL) return left;
  if (okR) return right;
  return best.lat >= 0 ? -m : m;                             // both rails blocked: hug the rail away from the hazard
}

// ---- corner-anticipation braking ----
// The engine no longer auto-slows for corners (low-handling cars understeer wide
// instead), so a bot that just steers would plow into the curb. cornerBrake looks
// down the track, finds the tightest upcoming bend, and brakes so the car arrives
// no faster than its turn rate can hold (max corner speed ≈ turn/κ). A low-handling
// car brakes earlier + harder; a grippy one barely lifts.
const TURN_RATE_FALLBACK = 1.2; // matches Game's base TURN_RATE (cars without a resolved .turn)
const BRAKE_LOOK_NEAR = 1.5;    // start scanning this far ahead (world units)
const BRAKE_LOOK_FAR = 22.0;    // ...to here — must cover the braking distance even from boost speed
const BRAKE_LOOK_STEP = 1.0;
const CORNER_MARGIN = 0.95;     // target as a fraction of the max holdable corner speed. Was 0.86, but bots never once touched a curb across the whole catalogue at that value (or even at 1.0) — the 7.5u lookahead keeps them on a smoothed line, so the feared apex-cut washout doesn't happen. 0.95 recovers the speed they were needlessly braking away while banking a hair of safety for items/contact noise.
const BRAKE_DECEL_REF = 4.0;    // assumed braking deceleration (u/s², a touch under the engine's BRAKE_DECEL 4.5 → brake just early enough, not late)

// Local track curvature (rad per world unit) at arclength s — the turn between two
// nearby centerline tangents, via the same cross/dot trick the steering uses (so
// no THREE import; works on the Vector3s sampleAt already returns).
function curvatureAt(centerline, s, step = 0.6) {
  const a = centerline.sampleAt(s), b = centerline.sampleAt(s + step);
  const cross = a.tangent.clone().cross(b.tangent).dot(b.up);
  const dot = a.tangent.dot(b.tangent);
  return Math.abs(Math.atan2(cross, dot)) / step;
}

// Brake (0..1) for upcoming bends — but DISTANCE-AWARE, so the car carries full speed
// down the straight and brakes late, instead of crawling. For each bend ahead we find
// the speed its curvature can hold (vSafe ≈ turn/κ) and the deceleration needed to bleed
// to it over the remaining distance d (v²−vSafe²)/2d; brake = that as a fraction of the
// car's braking power. A far corner needs almost nothing now; a near one needs a lot.
// `turn` overrides car.turn (the per-car yaw rate). Shared with the engine's victory lap.
export function cornerBrake(car, centerline, { turn } = {}) {
  if (!car || !centerline) return 0;
  const yaw = turn || car.turn || TURN_RATE_FALLBACK;
  // Grippy cars can chase the apex aggressively; a low-grip car (low yaw) overshoots the
  // pure-pursuit cut and washes onto the curb, so give it a more conservative margin.
  const margin = CORNER_MARGIN * clamp(yaw / TURN_RATE_FALLBACK, 0.88, 1.0); // floor raised from 0.78: the low-handling cars were the most over-braked yet still never washed out
  const v = car.v;
  let brake = 0;
  for (let d = BRAKE_LOOK_NEAR; d <= BRAKE_LOOK_FAR; d += BRAKE_LOOK_STEP) {
    const k = curvatureAt(centerline, car.totalS + d);
    if (k <= 1e-3) continue;
    const vSafe = (margin * yaw) / k;
    if (v <= vSafe) continue;
    const need = (v * v - vSafe * vSafe) / (2 * d); // decel to reach vSafe by the bend
    brake = Math.max(brake, need / BRAKE_DECEL_REF);
  }
  return clamp(brake, 0, 1);
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
  constructor({ skill = 0.9, lookahead = LOOKAHEAD, gain = STEER_GAIN, laneBias = 0, seed = 1 } = {}) {
    this.skill = clamp(skill, 0, 1);
    this.lookahead = lookahead;
    this.gain = gain;
    this.laneBias = laneBias;
    this._rng = mulberry32((seed >>> 0) || 1); // own jitter stream (reproducible per race seed)
    this._weave = 0;        // current wander offset, eased toward _weaveTarget
    this._weaveTarget = 0;  // re-rolled every _weaveT frames
    this._weaveT = 0;       // frames until the next target re-roll (0 → re-roll on the first drive)
    this._useSeq = 0;       // wrapping use-counter handed to the engine (advances only on the fire frame)
    this._lastItem = null;  // item held last frame (detects a fresh pickup → restart the hold)
    this._heldFrames = 0;   // frames the current item has been held
    this._holdMin = 0;      // this pickup's seeded minimum hold (frames) before firing is considered
  }
  // {s, b, u} ready to hand straight to engine.processInput(id, ...). `u` is a
  // wrapping use-counter (same protocol as the phone's ACTION button): a bot HOLDS a
  // freshly-collected item for a seeded minimum (so it reads on screen, the pickup
  // roulette can finish, and the field fires on staggered cadences) and then spends it
  // when it pays off — see _wantsToUse. CPU cars thus contest items instead of hoarding.
  // The counter only advances on the use frame; the per-pickup hold is the one RNG draw,
  // off the same seeded stream as the wander, so a seeded race still replays identically.
  drive(car, centerline, game) {
    // Wander: ease a seeded signal toward a target re-rolled now and then (smooth, ±1).
    if (--this._weaveT <= 0) {
      this._weaveTarget = (this._rng() * 2 - 1);
      this._weaveT = WEAVE_HOLD_MIN + Math.floor(this._rng() * WEAVE_HOLD_SPAN);
    }
    this._weave += (this._weaveTarget - this._weave) * WEAVE_EASE;

    const maxLat = (game && game.maxLat) || 1.5;
    let lane = clamp(this.laneBias, -(maxLat - 0.1), maxLat - 0.1);
    let look = this.lookahead;
    const dodge = avoidThreat(car, lane, game, maxLat); // a hazard on our line overrides the wander
    if (dodge != null) { lane = dodge; look = EVADE_LOOK; } // cut hard toward the gap, sharp + early

    let s = pursue(car, centerline, { lookahead: look, gain: this.gain, laneBias: lane });
    // Organic weave only when the path's clear, the bot isn't already working a corner
    // (a big pursue steer means the curb is close), AND it isn't already near a curb —
    // weave shoves a car that's drifted wide (e.g. a fast/low-grip car on a corner exit)
    // right over the edge, so fade it out as the car nears the rail.
    if (dodge == null) {
      const room = clamp(1 - Math.abs(s) / WANDER_FADE, 0, 1);
      const curbRoom = clamp((maxLat - Math.abs(car.lat)) / WANDER_CURB, 0, 1);
      s = clamp(s + this._weave * STEER_WANDER * room * curbRoom, -1, 1);
    }
    const corner = cornerBrake(car, centerline);
    // Held-item firing. A bot reads the race before it spends an item instead of dumping
    // it the instant the roulette stops — so it no longer looks like it fires on pickup.
    // A fresh pickup restarts the hold and rolls a seeded minimum (so the field fires on
    // staggered cadences, not one shared timer); _wantsToUse then waits for a moment the
    // item actually pays. The use-counter only advances on the fire frame (deterministic).
    const item = car && car.item;
    if (item && item === this._lastItem) {
      this._heldFrames++;
    } else {
      this._lastItem = item || null;
      this._heldFrames = 0;
      // Roll this pickup's hold ONLY when actually holding, so item-free bots draw nothing
      // from the RNG and keep their weave stream (and seeded replays) identical.
      this._holdMin = item ? AI_HOLD_MIN + Math.floor(this._rng() * AI_HOLD_SPAN) : 0;
    }
    if (item && this._heldFrames >= this._holdMin && this._wantsToUse(item, car, game, corner)) {
      this._useSeq = (this._useSeq + 1) & 255;
    }
    return { s, b: Math.max(1 - this.skill, corner), u: this._useSeq };
  }

  // Is NOW a good moment to fire the held item? Called once the per-pickup minimum hold
  // has elapsed, so this is purely the "does it pay off" gate. Each item type waits for
  // its own opening; an item held past AI_HOLD_MAX relaxes its gate so the bot spends it
  // rather than hoarding (every box it passes while holding is forfeited, by design).
  _wantsToUse(item, car, game, corner) {
    const overdue = this._heldFrames >= AI_HOLD_MAX;
    if (item === 'boost')  return corner < 0.05 || (overdue && corner < 0.2);             // on a straight, where the speed sticks
    if (item === 'banana') { const d = nearestBehind(car, game); return (d > 0 && d <= BANANA_DROP_FAR) || overdue; } // drop on a tailgater
    if (item === 'rocket') { const d = gapToCarAhead(car, game); return d != null && (d <= ROCKET_FIRE_RANGE || overdue); } // need a target in reach
    return true; // unknown item type → fall back to firing once held
  }
}

// Bot field, strongest first. Tuned for the OVAL (maxLat ~1.5): a spread of
// cruise speeds and held lanes so the AI feels like distinct racers. The lead bot
// (Bolt) runs flat-out on the straights (skill 1.0) so a human can't out-drag it
// for free; the field steps down from there but stays a genuine challenge. The
// ladder is deliberately SHALLOW (1.00 → 0.93, a 7% cruise spread): the old wider
// step (down to 0.86) left the back half sandbagging the straights — feathering the
// brake every frame — which read as "the AI is too easy" because the trailing bots
// were ~14% slower than the leader on every straight. Now even the tail bot pushes.
// Each bot also wanders its lane (seeded) and dodges hazards, so they no longer rail
// one line or feed themselves to bananas. Bots fill from the front — a lobby missing
// a single player gets the strong leader.
export const AI_PERSONALITIES = [
  { name: 'Bolt',  skill: 1.00, laneBias: -0.6 },
  { name: 'Pixel', skill: 0.97, laneBias:  0.6 },
  { name: 'Rusty', skill: 0.95, laneBias: -0.25 },
  { name: 'Zippy', skill: 0.93, laneBias:  0.25 },
];
