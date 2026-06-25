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
import { mulberry32, wrapDelta } from './util.js';

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
const STEER_EXPO = 1.25;  // default response: near-linear with a slightly softened centre (1 = linear); tuned on hardware
// Live-tunable steering response exponent. Shared by every engine (so a value set
// in the display debug panel survives race/lobby re-creation) and read fresh each
// physics step, so dragging the slider re-shapes the curve mid-race. Defaults to
// STEER_EXPO; setSteerExpo clamps to a sane band. Kept module-local + Node-pure
// (no window) so the engine still imports cleanly under node:test.
let _steerExpo = STEER_EXPO;
export function setSteerExpo(v) {
  const n = Number(v);
  if (Number.isFinite(n)) _steerExpo = Math.max(0.5, Math.min(3, n));
  return _steerExpo;
}
export function getSteerExpo() { return _steerExpo; }
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
// it "just works" through loops/hills because it never touches world XYZ. The box
// is the car's HEADING-ORIENTED footprint projected onto the (s, lat) axes (see
// _footprint), so a yawed body collides from its real corners — not a fixed
// axis-aligned box that an angled car would poke straight through.
const COLLIDE_SHRINK = 0.9;    // footprints a touch tighter than the mesh so a bump reads as contact, not a gap
// One impulse model for both contact axes (see _collidePair). RESTITUTION is the
// bounciness of the impact along the contact normal: ~0 = a solid inelastic thunk
// (the cars match speed and part, no rebound), 1 = a perfectly elastic ping. Kept
// LOW on purpose — the old fixed "kick" pinged cars off each other at every brush;
// a velocity-proportional impulse instead means a gentle lean barely registers and
// only a real ram lands a blow, with no rebound to scrub speed.
const RESTITUTION = 0.12;      // impact bounciness along the contact normal (0 = dead stick, 1 = elastic)
const KNOCK_DAMP = 6.0;        // how fast a sideways knock bleeds off (per second, exponential)
// Solid support posts (immovable, see _collidePole). Realistic, UNDERSTANDABLE behaviour: the
// car is pushed straight OUT of the post along the (s, lat) contact line (always AWAY from the
// post), and the speed driven INTO the post is shed (inelastic). So a head-on — you drove into
// it — costs the most pace; clipping the edge glances you off keeping most of it. But a post
// BUMPS you, it doesn't FREEZE you: speed is floored at POLE_MIN_KEEP of top speed, so even a
// square hit leaves you crawling around it rather than dead-stopped. Direction is purely
// POSITIONAL (which side you hit), never the car's velocity, so a curve's yaw can't flip it.
const POLE_MIN_KEEP = 0.3;     // a hit never drops you below this fraction of top speed — you crawl past, never freeze

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
// the boost ITEM holds at a fixed peak but for a t-scaled duration — everyone hits the
// same top speed, but the further back you are the longer you hold it (a catch-up edge).
const PAD_BOOST_MIN = 1.25;    // pad peak ×vmax for the leader (t=0) — never a dead pad
const PAD_BOOST_MAX = 1.60;    // pad peak ×vmax for last place (t=1)
const BOOST_DURATION = 1.4;    // flat-hold boost time (s) from a pad
const BOOST_ITEM_MUL = 1.5;    // boost-item peak ×vmax (position-independent — everyone hits the same ceiling)
const BOOST_ITEM_DUR_MIN = 1.6; // boost-item hold (s) for the leader (t=0) — the old flat value
const BOOST_ITEM_DUR_MAX = 3.0; // boost-item hold (s) for dead last (t=1) — held ~2× longer as a catch-up
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
const BANANA_BACK = 0.7;       // how far behind the dropper a banana lands (units) — tucked
                               // just behind the rear bumper (car half-len ~0.44 + banana
                               // half-depth ~0.23), so the dropper actually sees it land
const BANANA_OWNER_IMMUNE = 5.0; // seconds the dropper is immune to their OWN banana — long
                               // enough to drive clear of the drop spot, far shorter than a
                               // lap (~40-60s) so it bites them when they loop back onto it

// ---- Homing rocket (offensive item) ----
// A fired rocket locks the car PHYSICALLY just ahead on the track — the nearest one in front by
// lap-wrapped arclength, not by race standings — so a rocket fired while lapping (or being lapped)
// hits whoever is actually in front of you, even a full lap apart. It then runs that car down through
// the same (s, lat) plane as everything else: advances faster than any car, eases its lateral offset
// onto the target's lane, and spins it out on contact (reusing the oil/banana spin). It launches just
// ahead of the firer and only ever heads forward, so it can't hit its own firer. A car closer than
// ROCKET_TARGET_MIN (an overlapping/alongside car) isn't a valid lock — the rocket takes the next one
// ahead, or whiffs (flies straight and expires) when nothing live is in front. Numbers tune in playtest.
const ROCKET_HOME = 8.0;       // lateral homing rate toward the target's lane (per second; exp-approach)
const ROCKET_HIT = 0.6;        // arclength lead (units) at which the rocket detonates on its target
const ROCKET_TARGET_MIN = 0.5; // u — a car must be at least this far ahead (≈ half a car length, halfLen 0.44) to be locked
const ROCKET_LIFE = 10.0;      // seconds a rocket flies before it expires (a whiff) — generous so it reliably
                               // runs its target down; a target-less rocket just flies straight until this cap
// Speed profile. The rocket accelerates out of the launcher and decelerates into its target, and it
// PACES itself so the flight lasts about ROCKET_MIN_FLIGHT — a close shot crawls the short gap so it
// reads on screen instead of detonating in a frame, while a distant target (which takes longer to run
// down anyway) is chased at full cruise. Its CLOSING rate (the pace at which it eats the gap) is the
// slowest of: the cruise cap, the min-flight pacing, and a final decel-into-impact — and it rides ON
// TOP of the target's own speed (vWant = target.v + close), so a fleeing/boosted car can't outrun it.
// Pacing governs SPEED, but a rocket that SPAWNS already within ROCKET_HIT of its mark (a near-level
// target at the bunched start) has no gap to pace across — so ROCKET_MIN_LIFE is a hard floor: a rocket
// may not detonate until it has been airborne that long, guaranteeing a brief visible flight always.
const ROCKET_MIN_FLIGHT = 0.7;   // s the pacing aims for; a close shot is slowed to take roughly this long
const ROCKET_MIN_LIFE = 0.4;     // s a rocket MUST stay airborne before it may detonate (the no-instant-hit floor)
const ROCKET_CRUISE = 22.0;      // u/s — max closing rate, the run-down speed for a distant target
const ROCKET_IMPACT = 1.2;       // u/s — closing rate at the moment of contact (the slow, readable thunk-in)
const ROCKET_APPROACH_K = 1.8;   // 1/s — decel-in steepness: closing eases to ROCKET_IMPACT over the last ~11 units (long slow-in)
const ROCKET_ACCEL = 18.0;       // u/s² — speed ramp UP: gentle so it eases OUT of the launcher, not a hard whoosh
const ROCKET_DECEL = 16.0;       // u/s² — speed ramp DOWN: gentle so it eases IN to the target over a long final glide
const ROCKET_WHIFF_SPEED = 22.0; // u/s — a target-less rocket settles to this, flying straight until ROCKET_LIFE
const ROCKET_LAUNCH_AHEAD = 0.7; // u — spawn this far past the firer's nose (car half-length ≈ 0.44) so it reads as
                                 // a launch, not a blob riding on the car; clamped so it never eats a close target's run-in

// ---- Monster truck (catch-up transform item) ----
// A trailing player's car BECOMES a monster truck for a few seconds: a heavy,
// slightly faster tank that ploughs through the field. While transformed it is
// IMMUNE to the spin-out hazards it would normally fear — oil slicks and dropped
// bananas (it just crushes them) — and every car it TOUCHES is spun out (a body-
// check, see _collidePair). A rocket can STILL spin it out, though, so the field
// keeps one way to stop a rampage. WHO rolls it is decided by PLACE (back of the field
// only), but the transform LENGTH scales with DISTANCE behind the leader (the catch-up
// factor c.tCatch, 0=on the leader…1=adrift): a car truly dropped off gets the full
// ride, one that's last-but-close a brief one. Numbers are STARTING VALUES (tune in playtest).
const MONSTER_DUR_MIN = 4.0;   // transform seconds at tCatch=0 (right on the leader — brief)
const MONSTER_DUR_MAX = 8.0;   // transform seconds at tCatch=1 (adrift at the back)
const MONSTER_MASS_MUL = 8.0;  // ×mass while transformed → the monster barely budges and shoves light cars aside
const MONSTER_VMAX_MUL = 1.25; // ×top speed while transformed → a solid catch-up surge
const MONSTER_FOOTPRINT_MUL = 1.3; // ×collision half-extents while transformed → the body-check reaches as
                                   // wide as the monster looks (the fat tyres splay past the car's box)

// Place-weighted item table — one row per finishing place, authored as clean weights
// that each sum to 100 (a Mario-Kart-style hand-tuned lookup, NOT a formula). The roll
// reads a car's PLACE via _placeT (leader → 0 … last → 1) and SNAPS to the nearest row
// (round(t·(rows-1))); it never interpolates, so every field size from 4 to 8 cars draws
// whole-number weights. An 8-car race uses all 8 rows 1:1; a 4-car race picks rows
// 1/3/6/8 (placeT 0, ⅓, ⅔, 1 → indices 0,2,5,7); 5–7 cars pick clean subsets between.
// The LEADER (row 1) draws only Boost/Banana — never a Rocket and never a Monster (offensive/
// catch-up items are withheld from the front of the field by design). Banana fades front→back (gone by last), the Rocket
// humps in the upper-mid "snipe zone" (a car just ahead to take) then settles to a steady
// 20% behind, and the Monster ramps in over the back half to dominate last place.
// Probability is PLACE; durations are DISTANCE (c.tCatch) — see _useItem.
//        boost banana rocket monster
//   1st    20    80     0      0
//   2nd    25    55    20      0
//   3rd    30    30    40      0   ← rocket peak (snipe zone)
//   4th    30    30    30     10
//   5th    30    25    25     20
//   6th    30    25    20     25
//   7th    30    10    20     40
//   8th    30     0    20     50
const ITEM_IDS = ['boost', 'banana', 'rocket', 'monster'];
const ITEM_PLACE_TABLE = [ // weights aligned to ITEM_IDS; each row sums to 100
  [20, 80,  0,  0], // 1st (leader)
  [25, 55, 20,  0], // 2nd
  [30, 30, 40,  0], // 3rd — rocket peak
  [30, 30, 30, 10], // 4th
  [30, 25, 25, 20], // 5th
  [30, 25, 20, 25], // 6th
  [30, 10, 20, 40], // 7th
  [30,  0, 20, 50]  // 8th (last)
];

// Item rolls draw from a seeded PRNG (mulberry32, engine/util.js) so a race is
// fully reproducible from its seed under a fixed dt (the Node tests) — never
// the JS global RNG. Live races vary their dt, so they aren't bit-reproducible;
// that's fine, only the tests need determinism.

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
    // A pad is a circular disc by default, or a full-width RECTANGULAR launch strip
    // (`shape: 'strip'`, auto-placed at every loop mouth — see main.js): a longitudinal
    // band `halfLen` along travel × `halfWidth` across the lane. Both arm the same boost.
    this.pads = (track.pads || []).map((p) => p.shape === 'strip'
      ? { s: p.s, lat: p.lat || 0, shape: 'strip', halfLen: p.halfLen, halfWidth: p.halfWidth }
      : { s: p.s, lat: p.lat || 0, radius: p.radius || PAD_RADIUS });
    this.boxes = (track.boxes || []).map((b) => ({ s: b.s, lat: b.lat || 0, radius: b.radius || BOX_RADIUS, cooldown: 0 }));
    this.poles = (track.poles || []).map((p) => ({ s: p.s, lat: p.lat || 0, radius: p.radius || 0.45 })); // SOLID obstacles (see _collidePole); AI reads this off the game
    this.bananas = [];      // [{ id, s, lat, owner, armAt }] — live dropped bananas (live on drop; owner-immune until armAt)
    this._bananaSeq = 0;
    this.rockets = [];      // [{ id, s (cumulative arclength), lat, owner, targetId, life, v (ribbon speed) }] — live homing rockets
    this._rocketSeq = 0;
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
        boostT: 0,       // seconds left on an active boost (0 = none)
        boostMul: 1,     // current boost multiplier on the speed ceiling
        monsterT: 0,     // seconds left as a MONSTER TRUCK (0 = normal car) — heavy, immune to oil/banana, crushes cars it touches
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

  // Re-resolve a car's per-model handling + footprint IN PLACE, keeping its
  // position/velocity/race state. Used when a player changes their car pick in the
  // lobby attract demo so the swap doesn't restart the race. Returns true if the
  // car exists.
  setCarStats(id, stats) {
    const c = this.cars.get(id);
    if (!c) return false;
    const st = normStats(stats);
    c.accel = ACCEL * st.accel;
    c.vmax = VMAX * st.vmax;
    c.turn = TURN_RATE * st.turn;
    c.mass = st.mass;
    c.halfLen = st.halfLen;
    c.halfWid = st.halfWid;
    return true;
  }

  // Re-key a live car from one id to another (a dropped player reconnects on a
  // DIFFERENT device → new peerIndex, but their car keeps racing). Preserves all
  // car state; updates the map key, the car's own id, its place in the finish
  // order, and any banana it owns so nothing dangles on the old id. No-op (false)
  // if the source car is gone or the target id is taken.
  rekeyCar(oldId, newId) {
    if (oldId === newId) return false;
    const car = this.cars.get(oldId);
    if (!car || this.cars.has(newId)) return false;
    this.cars.delete(oldId);
    car.id = newId;
    this.cars.set(newId, car);
    const fi = this.finishedOrder.indexOf(oldId);
    if (fi !== -1) this.finishedOrder[fi] = newId;
    for (const b of this.bananas) { if (b.owner === oldId) b.owner = newId; }
    // In-flight rockets must follow the rekey too: a rocket LOCKED on this car keeps its
    // lock (else _stepRockets can't find the old id → drops it → whiffs), and one OWNED by
    // it keeps its owner so it still can't self-hit.
    for (const r of this.rockets) { if (r.owner === oldId) r.owner = newId; if (r.targetId === oldId) r.targetId = newId; }
    return true;
  }

  update(dtMs) {
    const dt = Math.min(dtMs / 1000, 0.05);
    if (dt <= 0) return;
    this.elapsed += dt;
    this._computeCatchUp(dt);   // per-car tRaw/tCatch from the field spread
    this._tickProps(dt);        // box respawn cooldowns
    this._stepRockets(dt);      // advance live homing rockets BEFORE the car loop, so a hit lands on the target's own frame

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
      // a boost that then re-bursts on recovery). A finished car on its victory lap is
      // NOT exempt: it still spins out on hazards — its autopilot steer dies mid-spin
      // (steerEff = 0) like a player's would, then recovers and resumes the racing line.
      let spinning = c.spinT > 0;
      if (spinning) {
        c.spinT -= dt;
        c.spin += (SPIN_TURNS * 2 * Math.PI / SPIN_TIME) * dt;
        if (c.spinT <= 0) { c.spinT = 0; c.spin = 0; spinning = false; }
      }
      {
        const oil = this._enterZones(c, this.hazards, c.oilIn);
        const ban = this._enterBanana(c);
        // A MONSTER TRUCK is immune to its own crash hazards: it still keeps oilIn in
        // sync (above) and CONSUMES a banana it rolls over (crushed — _enterBanana
        // already removed it), but it does NOT spin out. A rocket can still spin it
        // (that path is _stepRockets → _spinOut, deliberately not gated here).
        if ((oil || ban) && c.monsterT <= 0) {
          // A fresh hazard (re)arms the spin: entering a SECOND slick/banana mid-spin
          // extends it rather than being silently swallowed (the rising-edge sets keep
          // one slick from re-firing every frame). Keep the whirl angle continuous if
          // already spinning. A spin also kills any active boost — no banked re-burst.
          if (!spinning) c.spin = 0;
          c.spinT = SPIN_TIME; spinning = true;
          c.boostT = 0; c.boostMul = 1;
          this.onEvent({ type: 'spin', id: c.id, cause: ban ? 'banana' : 'oil' });
        }
      }

      // CATCH-UP FEATURES (live cars only): fire a held item, arm a boost pad. A finished
      // car has no controller and keeps whatever item it grabs (see _enterBox), so it
      // never fires an item and isn't lifted by pads — its victory lap stays at cruise.
      if (!c.finished) {
        c.pickupAge += dt; // ages the held item toward ITEM_USE_READY (reset on a fresh roll)
        // press-to-use: fire the held item, but BUFFER the press across a spin-out OR the
        // post-pickup reveal gate (fires the first eligible frame) instead of swallowing
        // it. A press with no item is dropped.
        if (c.wantUse && c.item && !spinning && c.pickupAge >= ITEM_USE_READY) { c.wantUse = false; this._useItem(c); }
        else if (c.wantUse && !c.item) c.wantUse = false;
        if (!spinning && this._enterZones(c, this.pads, c.padIn)) this._applyPad(c); // position-scaled boost
      }
      // Item boxes: live cars roll a held item; a finished car on its victory lap also
      // grabs boxes so they keep popping (cooldown + pickup pop) beneath it — but it KEEPS
      // whatever it holds rather than rerolling (it can't use items). The launch gate only
      // blocks the opening seconds, which a finished car is long past, so it's exempt.
      if (c.finished || this.elapsed > LAUNCH_GATE) this._enterBox(c);

      // LONGITUDINAL: a boost is a flat HOLD at peak (boostT) followed by a gentle
      // multiplier FADE back to 1 (BOOST_FADE) — so the ceiling eases down and the car
      // tapers off rather than snapping at BRAKE_DECEL. Then accelerate toward the
      // (boosted) brake-scaled cruise ceiling. brake is analog 0..1: 0 → full speed,
      // 0.5 → half, 1 → stop. On a slick the car loses grip: NO throttle, just a gentle
      // drag, so it coasts through the hazard.
      if (c.boostT > 0) { c.boostT -= dt; if (c.boostT < 0) c.boostT = 0; }
      else if (c.boostMul > 1) c.boostMul = Math.max(1, c.boostMul - BOOST_FADE * dt); // post-hold taper
      // MONSTER TRUCK timer: tick the transform down; when it lapses, emit so the
      // renderer can morph the car back. The heavy mass + body-check live in
      // _collidePair and the hazard immunity above — both read c.monsterT directly.
      if (c.monsterT > 0) { c.monsterT -= dt; if (c.monsterT <= 0) { c.monsterT = 0; this.onEvent({ type: 'monster_end', id: c.id }); } }
      const boosting = c.boostMul > 1;
      // A live boost OVERRIDES the brake: while boosting the brake can't pull the
      // ceiling down, so a pad/item before a loop guarantees the car keeps the speed
      // to clear it — you can't accidentally (or deliberately) brake the boost off.
      // Brake control returns the instant the multiplier bleeds back to 1.
      const brakeEff = boosting ? 0 : c.brake;
      // A monster rides slightly higher top speed (stacks over any boost it grabs).
      const vmaxEff = c.monsterT > 0 ? c.vmax * MONSTER_VMAX_MUL : c.vmax;
      const targetV = vmaxEff * c.boostMul * (1 - brakeEff);
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
      const steerIn = Math.sign(steerEff) * Math.pow(Math.abs(steerEff), _steerExpo);
      // Steered heading (relative to the road) for THIS step. It feeds the world facing
      // vector below and is then re-derived from the projection, so c.heading isn't
      // mutated until the end — the final c.heading is `fwd` re-expressed vs the new tangent.
      const steerHeading = c.heading + STEER_SIGN * steerIn * c.turn * authority * dt;

      // MOTION — step in WORLD space, then re-project onto the ribbon to recover (s, lat).
      // We drive the car along its WORLD facing direction and read its road coordinates
      // back, rather than advancing `s` and sliding `lat` directly. Integrating in
      // curvilinear (s, lat) can't trace a straight world line through a CURVATURE REVERSAL
      // (a chicane) while the car carries a lateral offset — it bows by a hair, the small
      // sideways "wobble". A world step + projection is straight by construction. This is
      // still grip-free: NEUTRAL holds a fixed WORLD heading (you must steer the curves);
      // there is no auto-follow. The ribbon still owns elevation/up/bank — `world` is built
      // from the frame, so hills, banking and the figure-8 bridge are unchanged.
      const prevTotal = c.totalS;
      const f0 = this.centerline.sampleAt(c.totalS);
      const fwd = f0.tangent.clone().applyAxisAngle(f0.up, steerHeading); // car's world forward
      const world = f0.pos.clone()
        .addScaledVector(f0.lateral, c.lat)        // where the car is now
        .addScaledVector(fwd, c.v * dt)            // drive forward in the world
        .addScaledVector(f0.lateral, c.vlat * dt); // + a decaying sideways knock (bumps)
      c.vlat *= Math.exp(-KNOCK_DAMP * dt);
      // maxStep = the physical per-frame reach: v·dt is the centreline advance; the +0.5
      // covers the extra arclength a laterally-offset car traces on the OUTSIDE of a corner
      // (outer factor peaks ~1.3 at full width; measured worst-case reach ≈0.94 ≪ the ≈1.4
      // window at max boost). The car can't have moved further along the road than this, so
      // the projection is pinned to the LOCAL strand even at the 50ms dt cap or max boost.
      const hit = this.centerline.projectNear(world, c.totalS, c.v * dt + 0.5); // nearest arclength + offset
      // Intra-frame guard: at MAX_HEADING the foot can sit a hair behind sHint — don't let
      // the motion step reverse s. (_resolveCollisions may still push totalS back — that's real.)
      c.totalS = Math.max(prevTotal, hit.s);
      c.lat = hit.lat;
      c.curbLim = this._curbLimit(hit.frame.width); // cache from the projection's frame → _clampCurb reads it
      // Re-express the (translation-invariant) world heading relative to the NEW tangent,
      // so NEUTRAL keeps a fixed world heading exactly — this replaces the old per-step
      // "subtract the road's turn". Then clamp so the car can never point backward.
      c.heading = Math.atan2(
        hit.frame.tangent.clone().cross(fwd).dot(hit.frame.up),
        hit.frame.tangent.dot(fwd)
      );
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

  // Lateral corridor half-width for a road width (world units): half the drivable width
  // minus the body margin, so a flared section widens it and a pinch tightens it. Falls
  // back to the scalar maxLat when width is unknown. (maxLat itself still seeds spawn lanes.)
  _curbLimit(width) {
    return (width != null && !Number.isNaN(width)) ? Math.max(0.1, width / 2 - LAT_MARGIN) : this.maxLat;
  }
  // Per-arclength version — constructs spline frames via sampleAt, so do NOT call it in hot
  // paths: update() caches c.curbLim from the sampleAt it already does each tick.
  maxLatAt(s) {
    return this._curbLimit(this.centerline.widthAt ? this.centerline.widthAt(s) : null);
  }

  // Oriented-footprint half-extents projected onto the (s, lat) axes for a car at its
  // CURRENT heading. A yawed body reaches FURTHER across the road and LESS along it than
  // its resting box (project a rectangle rotated by θ: along = hl·|cosθ| + hw·|sinθ|,
  // side = hl·|sinθ| + hw·|cosθ|). Collisions and the curb clamp read these so an angled
  // car's real corners — not a heading-blind box — decide contact, which is what stops a
  // hard-cornering body from clipping into curbs and other cars. Monster trucks collide
  // from a widened footprint (they look bigger). restSide is the side extent at heading 0
  // (= hw), so the curb clamp can isolate just the EXTRA reach the yaw adds.
  _footprint(c) {
    const fp = c.monsterT > 0 ? MONSTER_FOOTPRINT_MUL : 1;
    const hl = c.halfLen * fp, hw = c.halfWid * fp;
    const ch = Math.abs(Math.cos(c.heading || 0)), sh = Math.abs(Math.sin(c.heading || 0));
    return { along: hl * ch + hw * sh, side: hl * sh + hw * ch, restSide: hw };
  }

  // Rubbing a curb pins the car just inside it and bleeds speed toward a cap (a fraction of
  // the car's own top speed) — slows you, never a hard stop. Runs twice a frame (integration
  // + post-collision re-clamp); both read the cached c.curbLim (same totalS, no re-sample).
  _clampCurb(c, dt) {
    // onWall is cleared once per frame at the top of update()'s loop, not here — a car pinned
    // at the curb sits exactly AT the limit, so the second pass wouldn't re-detect it.
    const cap = c.vmax * WALL_SPEED_FRAC;
    const base = c.curbLim != null ? c.curbLim : this.maxLat;
    // Pull the CENTRE's limit in by exactly the extra lateral reach the heading adds (0 when
    // straight), so the body's OUTER edge stops where it would at rest instead of poking
    // through the curb when the car is angled. Floored so a pinch + full yaw can't invert it.
    const fpt = this._footprint(c);
    const lim = Math.max(0.05, base - (fpt.side - fpt.restSide));
    if (c.lat > lim || c.lat < -lim) {
      c.lat = c.lat > 0 ? lim : -lim;
      c.onWall = true;
      if (c.v > cap) c.v = Math.max(cap, c.v - WALL_DECEL * dt);
    }
  }

  // Rising-edge overlap for circular (s, lat) trigger zones — oil slicks and
  // boost pads share this. Distance is measured in the same (arclength, lateral)
  // plane as the car-car collisions, with the arclength gap wrapped to the
  // shortest way round the closed lap. Membership (`inSet`, per car) is kept so
  // a car sitting in a zone doesn't re-trigger every frame — only a fresh enter
  // fires. (Item boxes keep their own loop: cooldown + full-slot rules differ.)
  _enterZones(c, zones, inSet) {
    let entered = false;
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      const hit = z.shape === 'strip' ? this._inStrip(c, z) : this._inZone(c, z, z.radius);
      if (hit) { if (!inSet.has(i)) { inSet.add(i); entered = true; } }
      else inSet.delete(i);
    }
    return entered;
  }

  // Rectangular overlap in the same (arclength, lateral) plane — a full-width launch
  // STRIP at a loop mouth: a longitudinal band `|ds| < halfLen` across the lane
  // `|dl| < halfWidth` (the road half-width, so any car on the road crosses it). The
  // arclength gap wraps to the shortest way round the closed lap, like _inZone.
  _inStrip(c, z) {
    const ds = wrapDelta(c.totalS - z.s, this.length);
    const dl = c.lat - z.lat;
    return Math.abs(ds) < z.halfLen && Math.abs(dl) < z.halfWidth;
  }

  // Circle overlap in the shared (arclength, lateral) trigger plane — the one
  // geometry test behind oil/pad zones, item boxes, and bananas. The arclength
  // gap wraps to the shortest way round the closed lap.
  _inZone(c, z, radius) {
    const ds = wrapDelta(c.totalS - z.s, this.length);
    const dl = c.lat - z.lat;
    return (ds * ds + dl * dl) < radius * radius;
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

  // Per-frame prop upkeep: respawn item boxes. Bananas need no upkeep — they go live
  // the instant they're dropped and sit until a car hits one (consumed in _enterBanana).
  _tickProps(dt) {
    for (const b of this.boxes) if (b.cooldown > 0) b.cooldown = Math.max(0, b.cooldown - dt);
  }

  // Arm/refresh a position-scaled boost: peak ×vmax interpolates leader→last by tRaw.
  // Assignment via Math.max (never accumulation) so pads/items can't compound into a
  // teleport; the timer is re-armed each cross.
  _applyPad(c) {
    const mul = PAD_BOOST_MIN + (PAD_BOOST_MAX - PAD_BOOST_MIN) * c.tRaw;
    c.boostMul = Math.max(c.boostMul, mul);
    c.boostT = Math.max(c.boostT, BOOST_DURATION);
    this.onEvent({ type: 'pad', id: c.id });
  }

  // Rising-edge overlap of an item BOX. A box on cooldown is inert. A LIVE car with a
  // full slot does NOT consume the box (it stays live for the next car) — so holding
  // an item means forfeiting every box you pass (defuses hoarding). On a fresh pickup
  // the box goes on cooldown and the car rolls a t-weighted item. A FINISHED car always
  // pops the box: empty → rolls (collects) one, full → keeps it (it can't use items, so
  // hoarding is moot — the box still cools down + pops so the victory lap stays lively).
  _enterBox(c) {
    if (!this.boxes.length) return;
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      const inside = b.cooldown <= 0 && this._inZone(c, b, b.radius);
      if (inside && !c.boxIn.has(i)) {
        if (c.item == null) {
          c.item = this._roll(this._placeT(c)); c.pickupAge = 0; b.cooldown = BOX_RESPAWN; c.boxIn.add(i);
          this.onEvent({ type: 'pickup', id: c.id, item: c.item, finished: c.finished });
        } else if (c.finished) {
          // Finished + full slot: pop the box (cooldown + pickup pop) but HOLD the current
          // item — no reroll. Latch membership so the box fires once, not every frame.
          b.cooldown = BOX_RESPAWN; c.boxIn.add(i);
          this.onEvent({ type: 'pickup', id: c.id, item: c.item, finished: true });
        }
        // live car, full slot: leave membership unset so it re-checks next frame (auto-grabs
        // the instant the slot frees while still on the box).
      } else if (!inside) { c.boxIn.delete(i); }
    }
  }

  // Item-roll position factor = discrete finishing PLACE, normalised to 0..1:
  // leader (rank 1) → 0, last (rank N) → 1, evenly spaced in between (4 cars →
  // 0, ⅓, ⅔, 1). Pure standings — NOT the distance gap; a car that's last on the
  // board rolls the back-marker table even if it's right on the leader's bumper.
  // (c.rank is set by _rank() at the end of each update / at init, so it's at most
  // one frame stale here.) Durations key off distance instead (c.tCatch) — see _useItem.
  _placeT(c) {
    const n = this.cars.size;
    return n > 1 ? (c.rank - 1) / (n - 1) : 0;
  }

  // Weighted item roll using the seeded PRNG. The place factor t (from _placeT, 0 = leader
  // … 1 = last) snaps to the nearest authored row; one weighted draw from that row. The
  // weights are normalised here too (defensive), so a row never has to sum to exactly 100.
  _roll(t) {
    const last = ITEM_PLACE_TABLE.length - 1;
    const row = ITEM_PLACE_TABLE[Math.max(0, Math.min(last, Math.round(t * last)))];
    let total = 0; for (const x of row) total += x;
    let r = this.rng() * total;
    for (let i = 0; i < ITEM_IDS.length; i++) { r -= row[i]; if (r <= 0) return ITEM_IDS[i]; }
    return ITEM_IDS[ITEM_IDS.length - 1];
  }

  // Fire the held item (press-to-use). Boost reuses the pad boost state; Banana drops
  // a hazard just behind the dropper — live immediately (so a tailgater is hit at once),
  // owner-immune for a few seconds after the drop, then live for the owner too (so a
  // forgotten trap bites you when you lap back onto it a round later).
  _useItem(c) {
    this.onEvent({ type: 'item_use', id: c.id, item: c.item });
    if (c.item === 'boost') {
      // Same peak ceiling for everyone, but the HOLD scales with DISTANCE behind the
      // leader (c.tCatch — gap / field spread, from _computeCatchUp; the monster's
      // duration reads the same factor). NOT the place the roll used: a back-marker that
      // closes the gap holds it less; one adrift holds it ~2× as long.
      const t = Math.max(0, Math.min(1, c.tCatch));
      c.boostMul = Math.max(c.boostMul, BOOST_ITEM_MUL);
      c.boostT = Math.max(c.boostT, BOOST_ITEM_DUR_MIN + (BOOST_ITEM_DUR_MAX - BOOST_ITEM_DUR_MIN) * t);
    } else if (c.item === 'banana') {
      // Drop straight out the back along the car's HEADING, not down the centreline.
      // A centreline drop (same lat, s-BANANA_BACK) lands beside the tail — with no
      // autosteer the car is yawed through every corner (offset ~BANANA_BACK·sin θ).
      // Rebuild the world pose from the car's live (totalS, lat, heading) — same frame
      // math as _recomputePoses, but local so it's not coupled to pose freshness — step
      // BANANA_BACK back, then re-project to (s, lat) the way the motion step does.
      const f = this.centerline.sampleAt(c.totalS);
      const fwd = f.tangent.clone().applyAxisAngle(f.up, c.heading); // unit forward (tangent is normalised)
      const world = f.pos.clone()
        .addScaledVector(f.lateral, c.lat)    // car's reference point
        .addScaledVector(fwd, -BANANA_BACK);  // straight out the back, along the heading
      const hit = this.centerline.projectNear(world, c.totalS, BANANA_BACK + 0.5);
      const lim = this._curbLimit(hit.frame.width); // keep it on the road if the tail swung wide near a curb
      const lat = Math.max(-lim, Math.min(lim, hit.lat));
      const s = ((hit.s % this.length) + this.length) % this.length;
      // Owner immunity is just a short window after the drop: the banana lands right behind
      // them, so without it a tight-corner projection inside BANANA_RADIUS could self-hit at
      // once. After BANANA_OWNER_IMMUNE it goes live for the owner too — by then they've long
      // since driven clear, but they'll lap back onto it a round later and crash into their
      // own trap (everyone else hits it from the start). armAt is an elapsed-time stamp.
      const armAt = this.elapsed + BANANA_OWNER_IMMUNE;
      this.bananas.push({ id: ++this._bananaSeq, s, lat, owner: c.id, armAt });
    } else if (c.item === 'rocket') {
      // Lock the car physically just ahead on the track (see _nextCarAhead); a shot with nothing live
      // in front launches anyway and self-destructs at the end of its run (a whiff). The rocket starts
      // at the firer's CUMULATIVE totalS (this runs before the motion step, so the value is the frame's
      // start) and is stepped from the next frame on; it only ever heads forward, so it can't hit its firer.
      const target = this._nextCarAhead(c);
      // Launch just AHEAD of the firer's nose so it reads as a shot, not a blob materialising on the car —
      // but never within a close target's run-in (clamp the offset so the spawn gap stays > ROCKET_HIT and
      // the paced approach still plays out). A target-less whiff gets the full offset.
      const fwd = target ? (((target.totalS - c.totalS) % this.length) + this.length) % this.length : Infinity;
      const ahead = Math.min(ROCKET_LAUNCH_AHEAD, Math.max(0, (fwd - ROCKET_HIT) * 0.5));
      this.rockets.push({
        id: ++this._rocketSeq, s: c.totalS + ahead, lat: c.lat, owner: c.id, targetId: target ? target.id : null,
        life: 0, v: c.v // leaves the muzzle at the firer's speed, then accelerates onto its target (see _stepRockets)
      });
    } else if (c.item === 'monster') {
      // Become a monster truck. The transform LENGTH scales with DISTANCE behind the
      // leader (tCatch — gap / field spread, NOT the place that decided the roll; 0=on
      // the leader … 1=adrift), so a car that's truly dropped off gets the full ride and
      // one that rolled it while still close a brief one. The heavy mass,
      // speed bump, hazard immunity and body-check all key off c.monsterT elsewhere.
      const t = Math.max(0, Math.min(1, c.tCatch));
      c.monsterT = MONSTER_DUR_MIN + (MONSTER_DUR_MAX - MONSTER_DUR_MIN) * t;
    }
    c.item = null;
  }

  // Overlap of a live dropped banana. The owner is skipped only for a short window after
  // they drop it (armAt — see _useItem); everyone else trips it at once. A hit CONSUMES the
  // banana — Mario-Kart style — so it can't pile up or re-fire: no rising-edge
  // bookkeeping needed, the banana is simply gone next frame. Returns true if this car
  // hit one → caller spins the car out (reusing the oil spin).
  _enterBanana(c) {
    if (!this.bananas.length) return false;
    let hit = false;
    for (const b of this.bananas) {
      if (b.hit) continue;                                       // already consumed this frame
      if (b.owner === c.id && this.elapsed < (b.armAt ?? Infinity)) continue; // owner, still in the post-drop window
      if (this._inZone(c, b, BANANA_RADIUS)) { b.hit = true; hit = true; }
    }
    if (hit) this.bananas = this.bananas.filter((b) => !b.hit);
    return hit;
  }

  // The car PHYSICALLY just ahead of `c` on the track: the smallest forward arclength gap, wrapped
  // round the lap (so it's true track position, NOT race standings — a car you're lapping, physically
  // in front but a lap down, is a valid target; one a lap ahead of you but physically behind is not).
  // Live cars only (finished cars are coasting ghosts, excluded). Cars closer than ROCKET_TARGET_MIN
  // are skipped (you don't lock a car you're overlapping). Returns null when nothing live is ahead.
  _nextCarAhead(c) {
    const L = this.length;
    let best = null, bestGap = Infinity;
    for (const o of this.cars.values()) {
      if (o === c || o.finished) continue;
      const fwd = (((o.totalS - c.totalS) % L) + L) % L; // forward distance along the track, 0..L (lap-agnostic)
      if (fwd >= ROCKET_TARGET_MIN && fwd < bestGap) { bestGap = fwd; best = o; }
    }
    return best;
  }

  // Advance every live homing rocket. Each runs its locked target down along the ribbon and eases its
  // lateral offset onto the target's lane; on contact (arclength lead ≤ ROCKET_HIT) it spins them out
  // and is consumed. Its SPEED is not constant: it accelerates out of the launcher and decelerates in,
  // with a closing rate eased by distance (fast far, slow near) so a point-blank shot still plays out
  // on screen. A rocket whose target has finished or left drops its lock and flies straight; any rocket
  // that outlives ROCKET_LIFE self-destructs where it is (emits rocket_expire → the renderer detonates
  // it). Runs BEFORE the car loop so a hit lands on the target's own frame this tick. Deterministic (no RNG).
  _stepRockets(dt) {
    if (!this.rockets.length) return;
    const L = this.length;
    for (const r of this.rockets) {
      r.life += dt;
      const t = r.targetId != null ? this.cars.get(r.targetId) : null;
      if (t && !t.finished) {
        const fwd = (((t.totalS - r.s) % L) + L) % L;       // physical forward gap rocket→target (lap-wrapped)
        const reach = Math.max(0, fwd - ROCKET_HIT);        // arclength still to cover before it detonates
        // Closing rate = slowest of: cruise (far run-down), the min-flight pace (don't arrive early), and
        // the decel-into-impact ramp (slow, readable contact). On top of the target's own speed → always closes.
        const timeLeft = ROCKET_MIN_FLIGHT - r.life;
        const pace = timeLeft > 1e-3 ? reach / timeLeft : Infinity;
        const close = Math.min(ROCKET_CRUISE, pace, ROCKET_IMPACT + reach * ROCKET_APPROACH_K);
        const vWant = Math.max(0, t.v) + close;
        const accel = vWant > r.v ? ROCKET_ACCEL : ROCKET_DECEL; // ramp up on the launch, down into the target
        r.v += Math.max(-accel * dt, Math.min(accel * dt, vWant - r.v));
        r.s += r.v * dt;
        r.lat += (t.lat - r.lat) * Math.min(1, ROCKET_HOME * dt); // home onto the target's lane
        // Caught up → detonate, but never before ROCKET_MIN_LIFE: a rocket spawned already within
        // ROCKET_HIT (a near-level target) instead rides just behind its mark for a beat so it's seen.
        if (fwd <= ROCKET_HIT && r.life >= ROCKET_MIN_LIFE) { this._spinOut(t, 'rocket'); r.hit = true; }
      } else {
        // Target gone (finished/left) or a leader's whiff: settle to cruise and fly straight, then expire.
        r.targetId = null;
        r.v += Math.max(-ROCKET_DECEL * dt, Math.min(ROCKET_ACCEL * dt, ROCKET_WHIFF_SPEED - r.v));
        r.s += r.v * dt;
      }
      // Out of fuel without a hit (a whiff): self-destruct where it is — emit the position so the
      // renderer can detonate it there (a boom, not a silent vanish). Skip if it already hit this frame.
      if (!r.hit && r.life > ROCKET_LIFE) {
        this.onEvent({ type: 'rocket_expire', id: r.id, s: ((r.s % L) + L) % L, lat: r.lat });
        r.hit = true;
      }
    }
    if (this.rockets.some((r) => r.hit)) this.rockets = this.rockets.filter((r) => !r.hit);
  }

  // Spin a car out from an EXTERNAL strike (a homing rocket). A rocket CANCELS any crash
  // already in progress and starts a fresh one: reset the cosmetic whirl to 0 and re-arm
  // the FULL spin timer (so a car mid-spin from a banana is overwritten — the banana crash
  // ends, a new explosion + spin-out begins). Also kills any active boost and emits the
  // event for sound/FX. The target's own update() picks the spin up at the top of its next
  // frame (steering dies, speed bleeds), exactly as if it had driven onto a slick.
  _spinOut(c, cause) {
    c.spin = 0;            // restart the whirl — a new crash, not a continuation
    c.spinT = SPIN_TIME;   // full fresh stun (overwrites any remaining banana/oil spin)
    c.boostT = 0; c.boostMul = 1;
    this.onEvent({ type: 'spin', id: c.id, cause });
  }

  // Car-car collisions in (totalS, lat) space. Two cars overlap when their
  // arclength gap AND lateral gap are both inside the summed footprints; we push
  // them apart along the axis of least penetration (classic AABB MTV), split by
  // mass so the heavier car barely moves, then resolve the impact as ONE
  // mass-weighted impulse along that normal (the heavier/faster car keeps its line,
  // the lighter one absorbs the blow). Finished cars are ghosts so a coasting
  // winner can't block the pack at the line.
  _resolveCollisions(dt) {
    const list = [...this.cars.values()].filter((c) => !c.finished);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) this._collidePair(list[i], list[j]);
    }
    // Solid poles: immovable, so each car is resolved against each pole on its own.
    if (this.poles.length) for (const c of list) for (const p of this.poles) this._collidePole(c, p);
    // A push may have driven a car past a curb — pin it back inside.
    for (const c of list) this._clampCurb(c, dt);
  }

  // A car vs an immovable support post. Treat the car as a disc and push it straight out of
  // the post along the (s, lat) contact normal (post → car), always AWAY from the post — so a
  // head-on pushes you back and a side-clip pushes you aside. Then shed the velocity driven
  // INTO the post (inelastic): drive straight in and you lose most of your pace; pass cleanly
  // alongside and you keep it. Speed is floored at POLE_MIN_KEEP of top speed, so a hit bumps
  // you to a crawl but never freezes you — you nudge around it. Direction is positional, never
  // velocity-based, so a curve's yaw can't flip it. The post's `s` is on ONE pass, so a car on
  // the deck crossing overhead (far-away totalS) never matches.
  _collidePole(c, p) {
    const ds = wrapDelta(c.totalS - p.s, this.length);
    const dl = c.lat - p.lat;
    const fp = c.monsterT > 0 ? MONSTER_FOOTPRINT_MUL : 1; // a monster clears posts from a bigger radius too
    const R = (c.halfLen + c.halfWid) / 2 * fp + p.radius;   // car-disc + post radius
    let dist = Math.hypot(ds, dl);
    if (dist >= R) return;                              // discs clear → no contact
    let nS, nL;                                          // outward contact normal, post → car
    if (dist > 1e-3) { nS = ds / dist; nL = dl / dist; }
    else { nS = -1; nL = 0; dist = 1e-3; }              // dead-on → treat as a pure head-on (push straight back)
    const pen = R - dist;
    c.totalS += nS * pen;                               // de-penetrate straight out of the post (away from it)
    c.lat += nL * pen;
    // Scrub the speed going INTO the post. Car velocity in (s, lat): forward speed along the
    // tangent (≈+s) plus lateral drift. Remove the inward normal component → head-on kills pace.
    const vS = c.v * Math.cos(c.heading);
    const vL = -c.v * Math.sin(c.heading) + (c.vlat || 0);
    const vn = vS * nS + vL * nL;                       // <0 ⇒ driving into the post
    // Only when you're driving INTO it: shed the into-post speed (head-on → near zero), but floor
    // it so the post bumps you to a crawl rather than freezing you. A glancing touch that isn't
    // driving in keeps its pace untouched (the floor must never hand a slow car free speed).
    if (vn < 0) c.v = Math.max(POLE_MIN_KEEP * c.vmax, vS - vn * nS);
    c.vlat = 0;
    if (Math.abs(nS) > 0.6) { c.boostT = 0; c.boostMul = 1; } // a head-on also kills an active boost
    c.onWall = true;                                    // contact flag → brake light + controller buzz
  }

  _collidePair(a, b) {
    // Wrapped along-track gap, like every other (s, lat) proximity test: totalS is
    // CUMULATIVE across laps, so a raw difference between a lapping leader and a
    // backmarker is ≈ a whole lap — they'd occupy the same WORLD spot yet never
    // register contact, and the leader would ghost straight through. Wrapping
    // measures the real world gap; the pushes below are small local deltas, so
    // applying them to the cumulative totalS stays correct across the lap seam.
    const ds = wrapDelta(b.totalS - a.totalS, this.length); // +: b is ahead of a along the track
    const dl = b.lat - a.lat;                // +: b sits to a's +lateral side
    // Each car's oriented footprint projected onto the (s, lat) axes: a yawed body reaches
    // further across the road, so contact registers from the car's real corners rather than a
    // heading-blind box (no more clipping when a car is sideways). Monster footprint is folded
    // into _footprint. The AABB overlap on these projected extents stays cheap and keeps the
    // rear-end/side-bump resolution below intact.
    const fpa = this._footprint(a), fpb = this._footprint(b);
    const sumLen = (fpa.along + fpb.along) * COLLIDE_SHRINK;
    const sumWid = (fpa.side + fpb.side) * COLLIDE_SHRINK;
    const penS = sumLen - Math.abs(ds);
    const penL = sumWid - Math.abs(dl);
    if (penS <= 0 || penL <= 0) return;      // no overlap on one axis → no contact

    // MONSTER TRUCK body-check: a transformed car crushes anything it touches — the
    // OTHER car spins out (a fresh stun). Guarded on the victim not already spinning so
    // sustained contact re-stuns only after it recovers, never pinning the timer at max.
    // Two monsters just bump (neither crushes the other). The heavy monster mass below
    // then shoves the victim aside while the monster keeps its line.
    if (a.monsterT > 0 && b.monsterT <= 0 && b.spinT <= 0) this._spinOut(b, 'monster');
    if (b.monsterT > 0 && a.monsterT <= 0 && a.spinT <= 0) this._spinOut(a, 'monster');

    // Inverse-mass shares: the lighter car takes the larger push and the larger
    // velocity change (invA/invSum == b.mass/mSum), so a heavy car barely budges
    // and keeps its momentum — the "stronger car dominates" feel. A monster truck's
    // mass is multiplied so it ploughs through the field and is itself near-immovable.
    const massA = a.monsterT > 0 ? a.mass * MONSTER_MASS_MUL : a.mass;
    const massB = b.monsterT > 0 ? b.mass * MONSTER_MASS_MUL : b.mass;
    const invA = 1 / massA, invB = 1 / massB, invSum = invA + invB;
    const aShare = invA / invSum;
    const bShare = invB / invSum;

    if (penS <= penL) {
      // ── REAR-END: contact normal lies along the track ──────────────────────
      // Separate along s, then resolve the 1D impact as a mass-weighted impulse.
      // With RESTITUTION≈0 it equalises the closing speed (a solid thunk, no
      // rebound) — the heavy car keeps its pace and launches the light one forward,
      // rather than both bouncing apart. This is the minimum speed change that
      // still keeps the cars from interpenetrating, so the chaser sheds no more
      // pace than physics demands.
      const n = ds >= 0 ? 1 : -1;            // contact normal: a → b along the track
      a.totalS -= n * penS * aShare;
      b.totalS += n * penS * bShare;
      const vrel = (b.v - a.v) * n;          // <0 ⇒ closing (the rear car is gaining)
      if (vrel < 0) {
        const j = -(1 + RESTITUTION) * vrel / invSum; // impulse magnitude (>0)
        a.v = Math.max(0, a.v - j * invA * n); // rear slows / front gets nudged on
        b.v = Math.max(0, b.v + j * invB * n);
      }
    } else {
      // ── SIDE BUMP: contact normal points sideways ──────────────────────────
      // Separate sideways, then trade a mass-weighted impulse from the actual
      // lateral closing speed — steering drift (−v·sin(heading)) plus any live
      // knock. Forward speed is never touched, so racing door-to-door scrubs NO
      // pace, and the knock scales with how hard the cars converge: a gentle lean
      // barely registers, a committed swerve shoves the lighter car off its line.
      const n = dl >= 0 ? 1 : -1;            // contact normal: a → b sideways (+lat)
      a.lat -= n * penL * aShare;
      b.lat += n * penL * bShare;
      const vLatA = -a.v * Math.sin(a.heading) + a.vlat; // lateral velocity, +lat dir
      const vLatB = -b.v * Math.sin(b.heading) + b.vlat;
      const vrel = (vLatB - vLatA) * n;      // <0 ⇒ converging sideways
      if (vrel < 0) {
        const j = -(1 + RESTITUTION) * vrel / invSum; // impulse magnitude (>0)
        a.vlat -= j * invA * n;              // lighter car takes the bigger knock
        b.vlat += j * invB * n;
      }
    }
  }

  // Per-car world pose for the renderer/camera. `up` is the LOCAL SURFACE normal at
  // the car's (s, lat), not the centreline frame's up: where the road twists about
  // its tangent (a corkscrew), the swept surface is a helicoid, whose normal pitches
  // by atan(lat·twistRate) away from the frame up as you move off-centre — a curb-
  // hugging car oriented to the frame up alone visibly floats off / digs into the
  // twisting road. Measured by sampling the frame a short step ahead; on untwisted
  // road (everything but a roll segment) the rate is ~0 and `up` is the frame up.
  _recomputePoses() {
    const TWIST_PROBE = 0.6; // arclength step for the twist-rate estimate (world units)
    for (const c of this.cars.values()) {
      const f = this.centerline.sampleAt(c.totalS);
      let up = f.up;
      if (c.lat > 0.05 || c.lat < -0.05) {
        const f2 = this.centerline.sampleAt(c.totalS + TWIST_PROBE);
        // twist of `up` about the tangent across the probe step (rad/world-unit)
        const tau = Math.atan2(f.up.clone().cross(f2.up).dot(f.tangent), f.up.dot(f2.up)) / TWIST_PROBE;
        if (tau > 1e-3 || tau < -1e-3) up = f.up.clone().addScaledVector(f.tangent, c.lat * tau).normalize();
      }
      c.pose = {
        pos: f.pos.clone().addScaledVector(f.lateral, c.lat),
        forward: f.tangent.clone().applyAxisAngle(f.up, c.heading), // car faces its heading (yaw about the FRAME up)
        up
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
        monster: c.monsterT > 0, // car is currently a monster truck — renderer morphs the model; HUD/cam may react

        // collision footprint + arclength — only used by the renderer's debug bbox overlay.
        // heading lets the overlay orient the box to the body (the engine collides oriented).
        totalS: c.totalS, heading: c.heading,
        halfLen: c.halfLen * (c.monsterT > 0 ? MONSTER_FOOTPRINT_MUL : 1),
        halfWid: c.halfWid * (c.monsterT > 0 ? MONSTER_FOOTPRINT_MUL : 1)
      });
    }
    // Static boxes (available = off cooldown) + live dropped bananas, for the renderer
    // to show/hide box meshes and reconcile banana meshes by id.
    return {
      cars, elapsed: this.elapsed,
      boxes: this.boxes.map((b) => b.cooldown <= 0),
      bananas: this.bananas.map((b) => ({ id: b.id, s: b.s, lat: b.lat, radius: BANANA_RADIUS })),
      // Live homing rockets: cumulative arclength wrapped to [0, length) so the renderer
      // can place them by (s, lat) like every other prop (it derives the facing/bank from
      // the centreline tangent at s). owner is exposed for any per-cell FX gating.
      rockets: this.rockets.map((r) => ({
        id: r.id, s: ((r.s % this.length) + this.length) % this.length, lat: r.lat, owner: r.owner
      }))
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
