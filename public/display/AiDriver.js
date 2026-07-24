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
import { mulberry32, wrapDelta, wrapS } from './engine/util.js';
import * as dmath from './engine/math.js';

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
const BANANA_AVOID_R = 0.5; // mirrors the engine's BANANA_RADIUS (bananas carry no radius field)

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// ---- racing line ----
// Bots used to drive the CENTERLINE (plus a fixed lane bias) — no apex cutting, so
// their corner radius was the centerline's and a human who straightened the corner
// out-cornered them everywhere. Each track now gets a precomputed line: lateral
// offsets e(s) relaxed (Gauss–Seidel) toward e'' = κ within the road corridor —
// "straighten every bend as much as the road allows", with out-wide entry, inside
// apex, wide exit emerging on their own. The clamp makes this SHORTEST-PATH inside
// each corner, which genuinely straightens short corners and chicanes but hugs long
// sweepers on a TIGHTER radius than the centerline — so after solving, every corner
// is audited: where the line failed to reduce peak curvature, that region falls back
// to the centerline and the line is re-relaxed for a smooth rejoin. The result is
// geometry, computed once per centerline (WeakMap cache, shared by the whole bot
// field) and deterministic, so seeded replays are untouched. cornerBrake then reads
// the LINE's curvature, not the centerline's: the straighter path honestly raises
// vSafe, so the gain shows up in the braking numbers too, not just the steering.
const RL_STEP = 1.25;      // arclength between line samples (world units)
const RL_ITERS = 800;      // Gauss–Seidel sweeps — corner-sized features settle in O(width²) ≈ a few hundred
const RL_LAT_MARGIN = 0.3; // mirrors the engine's LAT_MARGIN (curb clamp inset)
const RL_EDGE = 0.5;       // extra buffer inside the physics curb — pursuit lag + weave must never put the apex ON the rail
const RL_FALLBACK_HALF = 1.5; // half-width when the track carries none (mirrors drive()'s maxLat fallback)
const RL_MIN_ROOM = 0.45;  // corridors with less usable room than this get no line at all (centerline)
const RL_CORNER_K = 0.02;  // |κ| above this is "a corner" for the audit's region split
const RL_PAYOFF = 0.95;    // keep a region's line only if it cut peak curvature to ≤ this × the centerline's
const FAN_MIN_ROOM = 0.7;  // lane width always granted to the persona fan-out (covers the ±0.6 biases the old fixed-lane bots ran safely)

class RacingLine {
  constructor(centerline) {
    const L = centerline.length;
    const n = Math.max(16, Math.round(L / RL_STEP));
    const h = L / n;
    const frames = [];
    for (let i = 0; i < n; i++) frames.push(centerline.sampleAt(i * h));
    // Signed yaw curvature of the centerline (rad/u, + = left — same convention as
    // pursue's heading error). Projecting the tangent swing onto `up` keeps only the
    // component a LATERAL offset can straighten: a vertical loop's pitch curvature
    // projects to ~0, so the relaxation correctly leaves loops alone.
    const kappa = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = frames[(i - 1 + n) % n].tangent, b = frames[(i + 1) % n].tangent;
      const cross = a.clone().cross(b).dot(frames[i].up);
      const dot = clamp(a.dot(b), -1, 1);
      kappa[i] = dmath.atan2(cross, dot) / (2 * h);
    }
    // Corridor the line may use, given the curvature it will actually carry. Beyond
    // the physics curb inset, each sample reserves the PURSUIT CUT: a pure-pursuit
    // follower tracks inside its target path by up to the lookahead chord's sagitta
    // (≈ κ·look²/8), so a target line touching the curb would put the CAR past it —
    // driving the centerline this slack was free road, which is also why the old
    // bots never ground the rail. The width isn't wasted: the car still runs deeper
    // than the line it chases — it's billed to the path driven, not the one aimed at.
    const boundFor = (kAbs, i) => {
      const f = frames[i];
      const half = (f.width != null && !Number.isNaN(f.width)) ? f.width / 2 : RL_FALLBACK_HALF;
      const cut = Math.min(1.1, kAbs * LOOKAHEAD * LOOKAHEAD / 8);
      const b = half - RL_LAT_MARGIN - RL_EDGE - cut;
      // A corridor too narrow to pay for a lane swing (tapered ramps, tight stunt
      // sections) gets NO line: any offset there is pure added curvature — wiggle,
      // not apex — and cornerBrake would slow for it. Pin to the centerline instead.
      return b < RL_MIN_ROOM ? 0 : b;
    };
    // Relax e'' = κ, clamped to the corridor. + lateral = right, so a left bend
    // (κ > 0) pulls e negative (inside-left) at the apex while the straights either
    // side pull it back — the clamp is what turns "straight line" into "racing line".
    const e = new Float64Array(n);
    const relax = (bound, iters) => {
      for (let it = 0; it < iters; it++) {
        for (let i = 0; i < n; i++) {
          const want = (e[(i - 1 + n) % n] + e[(i + 1) % n]) / 2 - kappa[i] * h * h / 2;
          e[i] = clamp(want, -bound[i], bound[i]);
        }
      }
    };
    // YAW curvature of the CURRENT line, measured from its actual points — projected
    // onto `up` exactly like curvatureAt, so crests, ramps and loop pitch don't read
    // as "corner" (a loop must be taken flat-out, and its launch pad boost kept).
    const measure = () => {
      const pts = frames.map((f, i) => f.pos.clone().addScaledVector(f.lateral, e[i]));
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const v1 = pts[i].clone().sub(pts[(i - 1 + n) % n]);
        const v2 = pts[(i + 1) % n].clone().sub(pts[i]);
        const l1 = v1.length(), l2 = v2.length();
        if (l1 < 1e-6 || l2 < 1e-6) { out[i] = 0; continue; }
        const dot = v1.dot(v2);                       // before cross() — cross MUTATES v1
        const cross = v1.cross(v2).dot(frames[i].up);
        out[i] = Math.abs(dmath.atan2(cross / (l1 * l2), clamp(dot / (l1 * l2), -1, 1))) / ((l1 + l2) / 2);
      }
      return out;
    };

    const bound = new Float64Array(n);
    for (let i = 0; i < n; i++) bound[i] = boundFor(Math.abs(kappa[i]), i);
    relax(bound, RL_ITERS);
    let kLine = measure();

    // Audit each corner: did the line actually straighten it? Split the lap into
    // corner regions (runs of |κ| above threshold, padded so entry/exit swings and
    // any curvature the line moved onto the approach are billed to their corner),
    // and compare peak curvatures. A region the line made no better — long sweepers,
    // where inside-hugging means a TIGHTER radius, more brake and more steer scrub —
    // reverts to the centerline. The reserve is also re-sized with the curvature the
    // LINE carries (entry bends before the centerline does, and ground the rail when
    // the reserve was sized off centerline κ alone). One re-relax smooths the seams.
    const PAD = Math.max(2, Math.round(4 / h));
    let i0 = 0;
    while (i0 < n && Math.abs(kappa[i0]) > RL_CORNER_K) i0++; // start the scan on a straight (a corner may straddle the seam)
    if (i0 < n) {
      for (let i = i0; i < i0 + n; i++) {
        if (Math.abs(kappa[i % n]) <= RL_CORNER_K) continue;
        let j = i; // [i, j] = this corner's run
        while (j + 1 < i0 + n && Math.abs(kappa[(j + 1) % n]) > RL_CORNER_K) j++;
        let kcMax = 0, klMax = 0;
        for (let m = i - PAD; m <= j + PAD; m++) {
          kcMax = Math.max(kcMax, Math.abs(kappa[((m % n) + n) % n]));
          klMax = Math.max(klMax, kLine[((m % n) + n) % n]);
        }
        if (klMax > kcMax * RL_PAYOFF) {
          for (let m = i - PAD; m <= j + PAD; m++) bound[((m % n) + n) % n] = 0;
        }
        i = j;
      }
    }
    for (let i = 0; i < n; i++) {
      if (bound[i] > 0) bound[i] = boundFor(Math.max(Math.abs(kappa[i]), kLine[i]), i);
      e[i] = clamp(e[i], -bound[i], bound[i]);
    }
    relax(bound, RL_ITERS / 2);
    kLine = measure();

    // Lightly smooth what cornerBrake reads, so sampling noise doesn't flicker the brake.
    const k = new Float64Array(n);
    for (let i = 0; i < n; i++) k[i] = (kLine[(i - 1 + n) % n] + 2 * kLine[i] + kLine[(i + 1) % n]) / 4;
    this.length = L; this.n = n; this.h = h;
    this.e = e; this.k = k; this.bound = bound;
  }
  _at(arr, s) {
    const L = this.length;
    s = ((s % L) + L) % L;
    const x = s / this.h, i = Math.floor(x) % this.n, f = x - Math.floor(x);
    return arr[i] * (1 - f) + arr[(i + 1) % this.n] * f;
  }
  laneAt(s) { return this._at(this.e, s); }   // line's lateral offset (world units, + = right)
  curvAt(s) { return this._at(this.k, s); }   // the line's own 3D curvature (rad/u)
  roomAt(s) { return this._at(this.bound, s); } // corridor half-width the line was solved in
}

// One line per track, shared by every bot on it (pure geometry — no per-bot state).
const _racingLines = new WeakMap();
export function racingLineFor(centerline) {
  let line = _racingLines.get(centerline);
  if (!line) { line = new RacingLine(centerline); _racingLines.set(centerline, line); }
  return line;
}

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

// Forward arclength to the car PHYSICALLY just ahead on the track — asked of the engine
// itself (Game.nextCarAhead) so the bot evaluates exactly the car a fired rocket would
// lock: one implementation, no drift. null when nothing is ahead at all → a rocket whiffs.
function gapToCarAhead(car, game) {
  if (!game || !game.nextCarAhead) return null;
  const o = game.nextCarAhead(car);
  return o ? wrapS(o.totalS - car.totalS, game.length) : null;
}

// Find the nearest hazard sitting on the bot's intended line and pick a lane past it.
// `game` exposes hazards (oil: {s,lat,radius}) + bananas ({s,lat,owner}) in centerline
// space; we aim for the side with the most corridor room. `laneFor(s)` is the bot's
// intended lane AT an arclength (the racing line sweeps across the road, so "is this
// on our path" must be asked where the hazard sits, not where the car is now).
// `prevDodge` is last frame's dodge lane: while a dodge is in progress the side
// tie-break anchors on it, so the choice is STICKY — the racing line drifts the
// intended lane during the approach, and re-deciding each frame against that moving
// reference flipped a committed dodge mid-approach into the hazard.
// Returns the dodge lane (world units off the centerline), or null when clear.
function avoidThreat(car, laneFor, game, maxLat, prevDodge = null) {
  if (!game || !game.length) return null;
  const L = game.length;
  const lane = prevDodge != null ? prevDodge : laneFor(car.totalS); // side tie-breaks anchor here
  let best = null, bestDs = Infinity;
  const consider = (h, radius) => {
    const ds = wrapDelta(h.s - car.totalS, L);               // wrap to the nearest copy
    if (ds < EVADE_NEAR || ds > EVADE_FAR) return;           // behind/abreast, or too far to matter yet
    if (Math.abs(laneFor(h.s) - h.lat) > radius + EVADE_CLEAR) return; // off to the side — not on our line
    if (ds < bestDs) { bestDs = ds; best = { lat: h.lat, r: radius }; }
  };
  for (const h of (game.hazards || [])) consider(h, h.radius);
  for (const p of (game.poles || [])) consider(p, p.radius);  // solid poles: dodge like an oil, but they STOP you, not spin you
  // Skip our OWN banana only during the short post-drop immunity window. Once it's armed
  // (armAt — an elapsed-time stamp, see Game._useItem) it spins us like anyone's, so dodge
  // it. Mirrors the engine's _enterBanana owner gate exactly.
  for (const b of (game.bananas || [])) if (b.owner !== car.id || game.elapsed >= (b.armAt ?? Infinity)) consider(b, BANANA_AVOID_R);
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

// ---- corner-anticipation braking (a SAFETY NET, not the racing style) ----
// cornerBrake looks down the track, finds the tightest upcoming bend, and brakes so
// the car arrives no faster than its turn rate can hold (max corner speed ≈ turn/κ).
// But in this grip-free model the corners self-regulate — steer-scrub bleeds speed and
// the curb clamps a wide car back on track — so the authored catalogue is drivable
// flat-out (a no-brake time-trial laps it FASTER; see CORNER_MARGIN). So the margin is
// set high enough that this only fires on a genuinely tight bend (boost-into-hairpin),
// keeping a floor without paying the flat-out line's speed away on every gentle corner.
const TURN_RATE_FALLBACK = 0.90; // matches Game's base TURN_RATE (cars without a resolved .turn)
const BRAKE_LOOK_NEAR = 1.5;    // start scanning this far ahead (world units)
const BRAKE_LOOK_FAR = 22.0;    // ...to here — must cover the braking distance even from boost speed
const BRAKE_LOOK_STEP = 1.0;
const CORNER_MARGIN = 1.25;     // target as a fraction of the max holdable corner speed. This is now a SAFETY NET, not the racing style. The driving model is grip-free: STEER_SCRUB already bleeds speed when you steer hard ("the scrub brakes for you") and the curb CLAMPS a wide car back on track, so corners self-regulate — a solo time-trial that never brakes laps the whole catalogue 1.3–2.9% FASTER than the braking bot (every shipped car, 18–20/20 tracks) with ~0% curb scrub and zero spins. Braking for these authored corners was pure lost time, so the field-sim mean drops ~1.4% here vs 1.0 and the shipped fleet (turn ≥0.95) now essentially drives the fast flat-out line. Raised 1.0 → 1.25, the KNEE: at 1.3 the "cornerBrake rescues a low-handling (turn 0.55) car" engine test starts failing (the net stops catching a car that truly can't hold the bend), so 1.25 is as flat-out as we go while the safety net still provably works for a genuinely undriveable corner (e.g. a boost pad firing into a hairpin). The per-bot `caution` still multiplies this, so the tightest bends keep a braking-zone spread. (History: was 0.86 → 0.95 → 1.0, each "still needlessly slow"; the real answer was that braking itself was the handicap.)
const BRAKE_DECEL_REF = 4.5;    // assumed braking deceleration (u/s²) — now EXACTLY the engine's BRAKE_DECEL 4.5, so bots plan to the brakes they actually have. Was 4.0 (a ~12% early-brake handicap), then 4.4 (a last ~2% sliver "for discretisation slack" — but the 1u scan step biases the found corner NEARER, if anything late, so the sliver was just cushion; removed). Catalogue sim shows no new spins at 4.5

// Local track curvature (rad per world unit) at arclength s — the turn between two
// nearby centerline tangents, via the same cross/dot trick the steering uses (so
// no THREE import; works on the Vector3s sampleAt already returns).
function curvatureAt(centerline, s, step = 0.6) {
  const a = centerline.sampleAt(s), b = centerline.sampleAt(s + step);
  const cross = a.tangent.clone().cross(b.tangent).dot(b.up);
  const dot = a.tangent.dot(b.tangent);
  return Math.abs(dmath.atan2(cross, dot)) / step;
}

// Brake (0..1) for upcoming bends — but DISTANCE-AWARE, so the car carries full speed
// down the straight and brakes late, instead of crawling. For each bend ahead we find
// the speed its curvature can hold (vSafe ≈ turn/κ) and the deceleration needed to bleed
// to it over the remaining distance d (v²−vSafe²)/2d; brake = that as a fraction of the
// car's braking power. A far corner needs almost nothing now; a near one needs a lot.
// `turn` overrides car.turn (the per-car yaw rate); `caution` scales the margin (a bot
// persona's corner bravery — see AI_PERSONALITIES); `line` (a RacingLine) rates bends
// by the curvature of the path the bot ACTUALLY steers, which its apex cut has made
// straighter than the centerline — omit it (victory lap) to rate the centerline.
export function cornerBrake(car, centerline, { turn, caution = 1, line = null } = {}) {
  if (!car || !centerline) return 0;
  const yaw = turn || car.turn || TURN_RATE_FALLBACK;
  // Grippy cars can chase the apex aggressively; a low-grip car (low yaw) overshoots the
  // pure-pursuit cut and washes onto the curb, so give it a more conservative margin.
  const margin = CORNER_MARGIN * caution * clamp(yaw / TURN_RATE_FALLBACK, 0.88, 1.0); // floor raised from 0.78: the low-handling cars were the most over-braked yet still never washed out
  const v = car.v;
  let brake = 0;
  for (let d = BRAKE_LOOK_NEAR; d <= BRAKE_LOOK_FAR; d += BRAKE_LOOK_STEP) {
    const k = line ? line.curvAt(car.totalS + d) : curvatureAt(centerline, car.totalS + d);
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
  const err = dmath.atan2(cross, dot); // + = target is to the car's left
  // The engine yaws the car by STEER_SIGN(-1)·f(steer), so a NEGATIVE steer turns
  // toward a LEFT target — hence the leading minus.
  return clamp(-err * gain, -1, 1);
}

// A bot personality. Every bot runs FLAT-OUT on the straights — its car's top speed
// is its top speed (a bot dragging the brake down a straight read as "the AI is
// weak"). Personality lives in the corners instead: `caution` scales the corner-brake
// margin, so a brave bot (≥1.0) carries the full speed its handling can hold — or a
// hair MORE if it overdrives (caution > 1, targeting above the safe corner speed) —
// while a cautious one lifts a touch earlier and deeper — catchable where it's honest,
// in the braking zones. On top of that cornerBrake itself is per-car: a low-handling car
// (e.g. a Truck bot) visibly slows for bends while a grippy one rails them — the same
// trade a human feels. `laneBias` fans the bot off the track's racing line where
// there's room (straights), so the field spreads instead of running nose-to-tail —
// while everyone still funnels through the same apexes.
export class AiController {
  constructor({ caution = 1, lookahead = LOOKAHEAD, gain = STEER_GAIN, laneBias = 0, seed = 1 } = {}) {
    this.caution = clamp(caution, 0.5, 1.1); // >1 lets a bot OVERDRIVE (target above the safe corner speed — a fast, slightly ragged leader); the yaw factor in cornerBrake still reins in low-grip cars
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
    this._dodgeLane = null; // dodge lane held last frame — keeps an in-progress dodge on one side
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
    // Intended lane at an arclength: the track's racing line plus this bot's fan-out
    // bias, faded as the line spends the corridor — the field spreads on straights
    // and converges to the one true apex (where bias would mean the curb).
    const line = racingLineFor(centerline);
    const laneFor = (sAbs) => {
      const e = line.laneAt(sAbs);
      const room = line.roomAt(sAbs);
      const fade = room > 0.05 ? clamp(1 - Math.abs(e) / room, 0, 1) : 1;
      // Clamp the TARGET to the solved corridor: bound already reserves the pursuit
      // cut, and a bias pushed past it would grind the car on the rail mid-corner.
      // Where the line ceded a region back to the centerline (room 0, e 0) the old
      // fixed-bias fan was always safe, so never pinch below that width.
      const lim = Math.min(Math.max(room, FAN_MIN_ROOM), maxLat - 0.1);
      return clamp(e + this.laneBias * fade, -lim, lim);
    };
    let lane = laneFor(car.totalS + this.lookahead); // where pursue's target sits
    let look = this.lookahead;
    const dodge = avoidThreat(car, laneFor, game, maxLat, this._dodgeLane); // a hazard on our line overrides the wander
    this._dodgeLane = dodge;
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
    const corner = cornerBrake(car, centerline, { caution: this.caution, line });
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
    return { s, b: corner, u: this._useSeq };
  }

  // Is NOW a good moment to fire the held item? Called once the per-pickup minimum hold
  // has elapsed, so this is purely the "does it pay off" gate. Each item type waits for
  // its own opening; an item held past AI_HOLD_MAX relaxes its gate so the bot spends it
  // rather than hoarding (every box it passes while holding is forfeited, by design).
  _wantsToUse(item, car, game, corner) {
    const overdue = this._heldFrames >= AI_HOLD_MAX;
    if (item === 'boost')  return corner < 0.05 || (overdue && corner < 0.2);             // on a straight, where the speed sticks
    if (item === 'banana') { const d = nearestBehind(car, game); return (d > 0 && d <= BANANA_DROP_FAR) || overdue; } // drop on a tailgater
    // A homing shot needs a target in REACH — no overdue escape: since targeting went
    // lap-wrapped, "someone ahead" is almost always true (a car 5u behind reads as ~L−5
    // ahead), so an overdue leader would lob a guaranteed-whiff rocket that orbits until
    // ROCKET_LIFE and detonates on empty track. Holding costs forfeited boxes, by design.
    if (item === 'rocket') { const d = gapToCarAhead(car, game); return d != null && d <= ROCKET_FIRE_RANGE; }
    return true; // unknown item type → fall back to firing once held
  }
}

// Bot field, strongest first: a spread of corner bravery and held lanes so the AI
// feels like distinct racers. EVERY bot runs flat-out on the straights — the old
// cruise-brake ladder (skill 0.93–1.00) had the back half riding the brake down
// every straight, lights on, which read as "the AI is weak". Differentiation now
// lives where humans can see and exploit it: `caution` scales cornerBrake's margin,
// so the lead bot (Bolt) OVERDRIVES a touch past the safe corner speed (fast, and
// it'll scrub a curb now and then) while the tail lifts earlier and deeper into the
// braking zones — you catch Zippy under braking, not by out-dragging a sandbagging
// cruiser. Each bot also wanders its lane (seeded) and dodges hazards, so they no
// longer rail one line or feed themselves to bananas.
// Bots fill from the front — a lobby missing a single player gets the strong leader.
export const AI_PERSONALITIES = [
  { name: 'Bolt',  caution: 1.05, laneBias: -0.6 },  // OVERDRIVER — carries a touch over the safe corner speed, so it occasionally scrubs a curb but leads; the one bot a clean human must actually out-brake
  { name: 'Pixel', caution: 1.00, laneBias:  0.6 },  // corners at the true limit of its car
  { name: 'Rusty', caution: 0.97, laneBias: -0.25 },
  { name: 'Zippy', caution: 0.94, laneBias:  0.25 }, // the tail still lifts earliest/deepest — but the whole field moved up from the old 1.00/0.97/0.94/0.91
];
