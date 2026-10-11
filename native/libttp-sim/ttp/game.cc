#include "ttp/game.h"

#include <algorithm>
#include <cmath>
#include <limits>

#include "ttp/ai_driver.h"
#include "ttp/dmath.h"
#include "ttp/jsmath.h"
#include "ttp/jsonnum.h"
#include "ttp/trackbuilder.h"

namespace ttp {

// ---- module constants (Game.js) ---------------------------------------------
static const double ACCEL = 9.0;
static const double VMAX = 11.6;
static const double BRAKE_DECEL = 5.8;
static const double TURN_RATE = 1.16;
static const double STEER_EXPO = 1.25;
static const double MAX_HEADING = 1.25;
// The speed cap while scraping the curb, as a fraction of vmax.
static const double WALL_SPEED_FRAC = 0.45;
static const double WALL_DECEL = 20.0;
// While pinned, the wall turns the car along itself, so a car never hangs
// nose-first on the curb: the angle into the wall eases at WALL_TURN_RATE (1/s)
// until the car points WALL_PEEL (rad) away from it. Contact only, into-wall
// only: on open road the car still holds its heading (no grip). An ease swings
// hardest on the first frame of contact, so WALL_TURN_MAX (rad/s) bounds it: a
// big hit turns at a steady pace, a small one still eases.
static const double WALL_TURN_RATE = 3.0;
static const double WALL_TURN_MAX = 1.5;
static const double WALL_PEEL = 0.05;
// The turn is what an impact costs: speed falls by exp(-WALL_IMPACT * angle)
// over the angle the wall turns the car through. Summed per frame that is exact
// whatever the dt, so a glancing scrape keeps its pace and a nose-in hit does
// not, and steering INTO the wall keeps paying while the wall turns it back.
// The engine pulls against the loss while the turn runs, so a slower turn needs
// a larger WALL_IMPACT for a nose-in hit to cost more than a scrape.
static const double WALL_IMPACT = 2.0;
static const double WALL_RASH_T = 0.5;
static const double LAT_MARGIN = 0.3;
static const double STEER_SCRUB = 0.35;
// ---- drift ----
// Mario Kart's drift, on our two controls. Holding the brake while steering
// hard at speed is a DRIFT instead of a brake, and letting go of the brake
// ends it — the player's own hold is the only start and stop. A straight, slow
// or light-lean brake is still a brake. The buttons
// scheme brakes with the ‹ › chord, which keeps the first-held side's lock when
// the other is added (TiltInput.js), so it drifts too.
//
// The side is LOCKED when the drift starts, and from then on the lean picks a
// LINE, not a turn rate, that no lean ever straightens. The lean is read
// RELATIVE to the one the drift started on: that lean keeps the curvature the
// car already had (driftK0), leaning further in tightens toward DRIFT_K_IN and
// easing off widens toward DRIFT_K_OUT (both scaled by the car's turn stat).
// Relative, because every lean that can start a drift sits near full lock: an
// absolute map dived the car into the inner curb the moment it began. The line
// is a radius, so speed does not move it, and driftK eases toward the lean over
// DRIFT_SMOOTH, so a held phone's wobble averages out. The brake gives way to
// the DRIFT_SPEED_FLOOR instead of the steer scrub.
//
// driftMix carries the drift in and out: it rises over DRIFT_ENTER_T (the hop,
// so locking the side cannot jerk the car) and fades over DRIFT_RELEASE_T after
// the brake comes up (an instant end snapped the line wide).
//
// A bot drifts only when its controller allows it (Input::d, AiController's
// per-corner roll).
//
// The car still travels along its heading — no grip is added; DRIFT_SLIP only
// turns the drawn body further into the corner.
static const double DRIFT_STEER_MIN = 0.5;
static const double DRIFT_SPEED_MIN = 0.5;   // fraction of vmax to start one
static const double DRIFT_K_IN = 1.0 / 6;    // 1/world units, at the base turn stat
static const double DRIFT_K_OUT = 1.0 / 18;
static const double DRIFT_SMOOTH = 0.2;      // s, the line's ease toward the lean
static const double DRIFT_SPEED_FLOOR = 0.85;  // fraction of vmax a drift holds
static const double DRIFT_ENTER_T = 0.25;
static const double DRIFT_RELEASE_T = 0.4;
static const double DRIFT_SLIP = 0.5;        // rad at DRIFT_K_IN
static const double DRIFT_SLIP_RATE = 8.0;   // 1/s ease of the drawn slip
// ---- contact ----
// The collider's rectangle IS the Kenney mesh AABB — CAR_STATS halfLen/halfWid,
// measured off the meshes — so the shrink is pure tolerance: every centimetre
// of it is interpenetration the sim cannot see. It buys the rounded corners of
// a body that is not really a rectangle, and nothing else.
static const double COLLIDE_SHRINK = 0.98;
// Contact is resolved by sequential impulses: each pass re-runs SAT on the
// positions the last one left, and the `vrel < 0` guard means only the first
// pass that finds a pair closing applies an impulse, so passes cost geometry,
// never energy. Passes are what let a shove travel down a queue and what stop
// a scrum resolving one pair by burying another: one sweep left cars visibly
// buried, and the depth that survives keeps falling until about here. The
// price is ~0.8 us of a ~10 us sim frame per pass, measured at 8 cars.
static const int COLLIDE_PASSES = 4;
static const double COLLIDE_SLOP = 0.01;     // resting overlap: no jitter about zero
static const double RESTITUTION = 0.12;
// Below this closing speed a contact is DEAD: no bounce at all. Restitution is
// what breaks a contact every frame, and a broken contact cannot push — the
// pusher re-accelerates faster than the leader sheds the gift, which reads as
// chatter. Real hits (a T-bone, a boost into a stopped car) still bounce.
static const double RESTITUTION_MIN_CLOSE = 1.5;
// A shove can carry a car above its own targetV. At BRAKE_DECEL the whole gift
// was gone in ~3 frames; this bleeds it off gently instead, which is the
// difference between being nudged and being pushed. Off the brake only.
static const double SHOVE_GRACE = 0.6;
static const double SHOVE_DECEL = 1.2;
// applyImpulse divides the track-frame impulse by cos(heading); at the heading
// cap that divisor is 0.315 and every nudge in an angled scrum came back
// tripled. Floor the gain at 1/0.7 and drop the momentum past it.
static const double IMPULSE_COS_FLOOR = 0.7;
// Ground metres per metre of centreline arc at lateral offset `lat` is
// (1 - lat*k). The collider measures in world metres and only needs this to
// convert a separation back into a totalS step; it is clamped because the
// tightest corners in the catalogue turn inside the road's own half-width,
// where the ribbon folds over itself and the ratio would invert.
static const double RIBBON_SCALE_MIN = 0.35;
static const double RIBBON_SCALE_MAX = 1.65;
static const double CURV_PROBE = 0.6;        // metres; centreline probe step for curvature and twist
static const double KNOCK_DAMP = 6.0;
static const double POLE_MIN_KEEP = 0.3;
static const double OIL_RADIUS = 0.7;
static const double SPIN_TIME = 1.0;
static const double OIL_REARM = 4.0;
static const double SPIN_DRAG_RATE = 1.8;
static const double SPIN_TURNS = 2;
static const double SPREAD_REF_FRAC = 0.15;
static const double T_TAU = 0.6;
static const double PAD_BOOST_MIN = 1.25;
static const double PAD_BOOST_MAX = 1.60;
static const double BOOST_DURATION = 1.4;
static const double BOOST_ITEM_MUL = 1.5;
static const double BOOST_ITEM_DUR_MIN = 1.6;
static const double BOOST_ITEM_DUR_MAX = 3.0;
static const double ITEM_USE_READY = 0.9;
static const double BOOST_ACCEL = 28.5;
static const double BOOST_FADE = 0.5;
static const double PAD_RADIUS = 0.65;
static const double BOX_RADIUS = 0.45;
static const double BOX_RESPAWN = 4.0;
static const double LAUNCH_GATE = 1.5;
static const double BANANA_RADIUS = 0.5;
static const double BANANA_OWNER_IMMUNE = 5.0;
static const double ROCKET_HOME = 8.0;
static const double ROCKET_HIT = 0.6;
static const double ROCKET_TARGET_MIN = 0.5;
static const double ROCKET_LIFE = 10.0;
static const double ROCKET_MIN_LIFE = 0.4;
static const double ROCKET_CRUISE = 28.5;
static const double ROCKET_IMPACT = 1.2;
static const double ROCKET_APPROACH_K = 1.8;
static const double ROCKET_ACCEL = 23.0;
static const double ROCKET_DECEL = 20.5;
static const double ROCKET_WHIFF_SPEED = ROCKET_CRUISE;
static const double ROCKET_LAUNCH_AHEAD = 0.7;
static const double MONSTER_DUR_MIN = 4.0;
static const double MONSTER_DUR_MAX = 8.0;
static const double MONSTER_MASS_MUL = 8.0;
static const double MONSTER_VMAX_MUL = 1.25;
// ---- air (kicker ramps and crests) ----
// Every flight falls under GRAVITY, several times a toy car's honest one: at
// these speeds a true arc floats, and sends a car metres off the catalogue's
// sharper hills. With no kick off a crest, it sets both how high a car goes
// and how long it stays up, and how much speed a hill asks for.
static const double GRAVITY = 12.0;
// Over a crest, an extra pull back toward the road that grows with height
// (1/s^2). Honest crest flight grows with the SQUARE of speed: no gravity let
// a player cresting crag at 80% of top speed leave the road without sending a
// flat-out car too high (0.07 against 0.46 at 20, 0.22 against 0.73 at 16).
// This pull leaves a small hop almost untouched and reins a big one in, so
// the spread is about 2x (0.21 at 80%, 0.44 flat-out). Crest only, so a
// kicker, which leaves its lip already in the air, flies under GRAVITY alone.
static const double CREST_PULL = 80.0;
// Below this height off the deck a car still drives as grounded: a crest taken
// just fast enough lifts it by millimetres, which nothing should notice.
static const double AIR_MIN = 0.02;
// Steering authority off the deck, as a fraction of the ground's: a tilt still
// nudges the landing but cannot turn the car around in the air.
static const double AIR_STEER = 0.35;
// Two cars further apart in height than this pass over each other.
static const double AIR_CLEAR = 0.35;
// How fast an airborne body tips toward the road's angle (1/s). Held at its
// takeoff angle, a car flying off a crest lands leaning back by the whole of
// the slope; easing toward the deck, it noses forward through the flight and
// can never pass the road's own angle.
static const double AIR_TIP = 5.0;
// Arclength step of the crest-curvature table.
static const double CREST_STEP = 0.25;
// The body's angle riding a kicker's wedge.
static const double KICKER_PITCH = dmath::atan2(KICKER_RISE, KICKER_LEN);
// A monster bats the car it spins out ASIDE, off its own line, so a victim
// shedding speed in its spin is not caught and shoved again. vlat decays at
// KNOCK_DAMP, so this carries the victim MONSTER_KNOCK / KNOCK_DAMP = 1 m
// sideways.
static const double MONSTER_KNOCK = 6.0;
static const double PI = 3.141592653589793;
static const double INF = std::numeric_limits<double>::infinity();

static double g_steerExpo = STEER_EXPO;  // setSteerExpo/getSteerExpo — traces never move it
// The curb's live copies, moved only by the debugCurb* knobs — traces never move them.
static double g_wallSpeedFrac = WALL_SPEED_FRAC;
static double g_wallTurnRate = WALL_TURN_RATE;
static double g_wallTurnMax = WALL_TURN_MAX;
static double g_wallImpact = WALL_IMPACT;
// The drift's live copies, moved only by the debugDrift* knobs — traces never move them.
static double g_driftTight = 1;
static double g_driftSmooth = DRIFT_SMOOTH;
static double g_driftFloor = DRIFT_SPEED_FLOOR;
static double g_driftRelease = DRIFT_RELEASE_T;

double debugDriftTight(double scale) {
  g_driftTight = scale < 0 ? 1 : scale;
  return 1;
}
double debugDriftSmooth(double sec) {
  g_driftSmooth = sec < 0 ? DRIFT_SMOOTH : sec;
  return DRIFT_SMOOTH;
}
double debugDriftRelease(double sec) {
  g_driftRelease = sec < 0 ? DRIFT_RELEASE_T : sec;
  return DRIFT_RELEASE_T;
}
double debugDriftFloor(double floor) {
  g_driftFloor = floor < 0 ? DRIFT_SPEED_FLOOR : js_min(1.0, floor);
  return DRIFT_SPEED_FLOOR;
}

double debugCurbSpeed(double frac) {
  g_wallSpeedFrac = frac < 0 ? WALL_SPEED_FRAC : js_min(1.0, frac);
  return WALL_SPEED_FRAC;
}
double debugCurbTurn(double rate) {
  g_wallTurnRate = rate < 0 ? WALL_TURN_RATE : rate;
  return WALL_TURN_RATE;
}
double debugCurbTurnMax(double rate) {
  g_wallTurnMax = rate < 0 ? WALL_TURN_MAX : rate;
  return WALL_TURN_MAX;
}
double debugCurbImpact(double k) {
  g_wallImpact = k < 0 ? WALL_IMPACT : k;
  return WALL_IMPACT;
}

void setSteerExpo(double v) {
  if (std::isfinite(v)) g_steerExpo = js_max(0.5, js_min(3.0, v));  // Game.js: clamp [0.5,3]
}
double getSteerExpo() { return g_steerExpo; }
double steerShape(double s) {
  return js_sign(s) * dmath::pow(std::fabs(s), g_steerExpo);
}
// How much of its turn rate the car has at its speed: steering firms up to full
// by half of vmax.
static double steerAuthority(const Car& c) {
  return 0.4 + 0.6 * js_min(1.0, c.v / (c.vmax * 0.5));
}

const char* const ITEM_IDS[4] = {"boost", "banana", "rocket", "monster"};
static const int ITEM_PLACE_TABLE[8][4] = {
    {20, 80, 0, 0}, {25, 55, 20, 0}, {30, 30, 40, 0}, {30, 30, 30, 10},
    {30, 25, 25, 20}, {30, 25, 20, 25}, {30, 10, 20, 40}, {30, 0, 20, 50}};

// ---- Event serialization -----------------------------------------------------
Value Event::toValue() const {
  Value o = Value::Obj();
  o.set("type", Value::Str(type));
  o.set("id", id.toValue());
  if (type == "spin") o.set("cause", Value::Str(cause));
  else if (type == "finish") { o.set("rank", Value::Num(rank)); o.set("time", Value::Num(time)); }
  else if (type == "lap") o.set("lap", Value::Num(lap));
  else if (type == "pickup") { o.set("item", Value::Str(item)); o.set("finished", Value::Bool(finished)); }
  else if (type == "item_use") o.set("item", Value::Str(item));
  else if (type == "rocket_expire") { o.set("s", Value::Num(s)); o.set("lat", Value::Num(lat)); }
  // monster_end: just {type,id}
  return o;
}

// ---- helpers -----------------------------------------------------------------
static Stats normStats(const Stats& in) {
  Stats o = in;
  o.mass = js_max(0.05, o.mass);
  o.halfLen = js_max(0.05, o.halfLen);
  o.halfWid = js_max(0.05, o.halfWid);
  return o;
}

// byRaceOrder as a strict-weak-ordering `<` predicate (sign of the JS comparator).
// stable_sort with this reproduces V8's stable sort for the consistent comparator.
static bool raceLess(const Car* a, const Car* b) {
  if (a->finished && b->finished) return a->finishTime < b->finishTime;
  if (a->finished) return true;   // a before b  (comparator -1)
  if (b->finished) return false;  // b before a  (comparator +1)
  return b->totalS < a->totalS;   // b.totalS - a.totalS < 0  =>  a first
}

Car* Game::find(const Id& id) const {
  for (const auto& c : cars_) if (c->id == id) return c.get();
  return nullptr;
}

// ---- ctor --------------------------------------------------------------------
// Out-of-line so ~unique_ptr<RacingLine> sees the complete type (ai_driver.h).
Game::~Game() = default;

// Built on first bot drive, from THIS Game's centerline, and destroyed with the
// Game — see the note on the declaration for the address-recycling bug this
// ownership fixes.
RacingLine& Game::racingLine() {
  if (!racingLine_) racingLine_ = std::make_unique<RacingLine>(*centerline_);
  return *racingLine_;
}

Game::Game(const std::vector<PlayerDesc>& players, const GameTrack& track,
           std::function<void(const Event&)> onEvent, std::string forceItem)
    : centerline_(track.centerline),
      length_(track.length),
      totalLaps_(track.totalLaps ? track.totalLaps : 3),
      onEvent_(std::move(onEvent)),
      forceItem_(std::move(forceItem)),
      rng_(track.seed ? track.seed : 1u) {
  maxLat_ = js_max(0.1, (track.roadWidth ? track.roadWidth : 1) / 2 - LAT_MARGIN);

  for (const Zone& h : track.hazards)
    hazards_.push_back(Zone{h.s, h.lat, h.radius ? h.radius : OIL_RADIUS});
  for (const PadRt& p : track.pads) {
    if (p.strip) pads_.push_back(PadRt{p.s, p.lat, true, 0, p.halfLen, p.halfWidth});
    else pads_.push_back(PadRt{p.s, p.lat, false, p.radius ? p.radius : PAD_RADIUS, 0, 0});
  }
  // Box rows: Math.round((b.s||0)*100) keyed, row index by first-seen order.
  std::map<long, int> boxRows;
  for (const BoxRt& b : track.boxes) {
    long keyv = (long)js_round((b.s ? b.s : 0) * 100);
    auto it = boxRows.find(keyv);
    int row;
    if (it == boxRows.end()) { row = (int)boxRows.size(); boxRows[keyv] = row; }
    else row = it->second;
    boxes_.push_back(BoxRt{b.s, b.lat, b.radius ? b.radius : BOX_RADIUS, 0, row});
  }
  for (const PoleRt& p : track.poles)
    poles_.push_back(PoleRt{p.s, p.lat, p.radius ? p.radius : 0.45});
  for (const BananaRt& b : track.bananas)
    bananas_.push_back(BananaRt{++bananaSeq_, b.s, b.lat, Id::None(), 0, true, 0, false});
  kickers_ = track.kickers;
  // Crest curvature: how fast the tangent turns away from the deck's up,
  // differenced across CURV_PROBE either side. Positive over a hill; negative
  // in a dip and all the way round a loop, which is why loops never launch.
  {
    int n = (int)std::ceil(length_ / CREST_STEP);
    crestK_.resize(n);
    for (int i = 0; i < n; i++) {
      double s = i * CREST_STEP;
      Frame f = centerline_->sampleAt(s);
      Frame a = centerline_->sampleAt(s - CURV_PROBE);
      Frame b = centerline_->sampleAt(s + CURV_PROBE);
      crestK_[i] = a.tangent.sub(b.tangent).dot(f.up) / (2 * CURV_PROBE);
    }
  }

  for (size_t i = 0; i < players.size(); i++) {
    const PlayerDesc& desc = players[i];
    Stats st = normStats(desc.hasStats ? desc.stats : Stats{});
    int row = (int)(i / 2);
    double lane = (i % 2 == 0 ? -1.0 : 1.0) * js_min(maxLat_ * 0.6, 0.5);
    auto c = std::make_unique<Car>();
    c->id = desc.id;
    c->driftOk = !desc.bot;
    c->totalS = -(2.5 + row * 1.6);
    c->lat = lane;
    c->rank = (int)i + 1;
    c->accel = ACCEL * st.accel;
    c->vmax = VMAX * st.vmax;
    c->turn = TURN_RATE * st.turn;
    c->mass = st.mass;
    c->halfLen = st.halfLen;
    c->halfWid = st.halfWid;
    cars_.push_back(std::move(c));
  }
  recomputePoses();
  rank();
}

// ---- input / lifecycle -------------------------------------------------------
void Game::processInput(const Id& id, const Input& msg) {
  Car* c = find(id);
  if (!c || c->finished) return;
  if (msg.hasS) c->steer = js_max(-1.0, js_min(1.0, msg.s));
  if (msg.hasB) c->brake = js_max(0.0, js_min(1.0, msg.b));
  if (msg.hasU && msg.u != c->useSeq) { c->useSeq = msg.u; c->wantUse = true; }
  if (msg.hasD) c->driftOk = msg.d != 0;
}

static long indexOfId(const std::vector<Id>& v, const Id& id) {
  for (size_t i = 0; i < v.size(); i++) if (v[i] == id) return (long)i;
  return -1;
}

bool Game::removeCar(const Id& id) {
  auto it = std::find_if(cars_.begin(), cars_.end(),
                         [&](const std::unique_ptr<Car>& c) { return c->id == id; });
  if (it == cars_.end()) return false;
  cars_.erase(it);
  long i = indexOfId(finishedOrder_, id);
  if (i >= 0) finishedOrder_.erase(finishedOrder_.begin() + i);
  rank();
  return true;
}

bool Game::setCarStats(const Id& id, const Stats& stats) {
  Car* c = find(id);
  if (!c) return false;
  Stats st = normStats(stats);
  c->accel = ACCEL * st.accel;
  c->vmax = VMAX * st.vmax;
  c->turn = TURN_RATE * st.turn;
  c->mass = st.mass;
  c->halfLen = st.halfLen;
  c->halfWid = st.halfWid;
  return true;
}

bool Game::rekeyCar(const Id& oldId, const Id& newId) {
  if (oldId == newId) return false;
  auto it = std::find_if(cars_.begin(), cars_.end(),
                         [&](const std::unique_ptr<Car>& c) { return c->id == oldId; });
  if (it == cars_.end() || find(newId)) return false;
  // Map delete + set: move the car to the TAIL of the order, keeping all state.
  std::unique_ptr<Car> car = std::move(*it);
  cars_.erase(it);
  car->id = newId;
  cars_.push_back(std::move(car));
  // Keeping the finished board's ids in step. UNOBSERVABLE as the code stands,
  // and deliberately kept anyway — checked 2026-07-29 rather than assumed, so
  // that nobody has to work it out twice:
  //   finishedOrder_ is read in exactly two places, raceOver() and the finish
  //   event's rank, and BOTH use only its size, which a rename cannot change.
  //   getResults() sorts cars_ and never looks at it. The one guard that reads
  //   the ids, forceFinish's dedup, sits behind `if (c->finished) return false`
  //   — and a rekeyed car carries its finished flag — so it is unreachable too.
  // So there is no test that can catch this line going missing, and one was
  // written and then deleted for exactly that reason: it passed with the line
  // removed, which is worse than no test. Keep it as the invariant it states;
  // if finishedOrder_ ever grows a reader that cares about ORDER or IDENTITY,
  // this becomes load-bearing and gateable on the same commit.
  long fi = indexOfId(finishedOrder_, oldId);
  if (fi != -1) finishedOrder_[fi] = newId;
  for (auto& b : bananas_) if (b.owner == oldId) b.owner = newId;
  for (auto& r : rockets_) { if (r.owner == oldId) r.owner = newId; if (r.targetId == oldId) r.targetId = newId; }
  return true;
}

bool Game::carFinished(const Id& id, bool& out) const {
  Car* c = find(id);
  if (!c) return false;
  out = c->finished;
  return true;
}

// ---- boundary / staging ------------------------------------------------------
bool Game::driveBot(const Id& id, AiController& ai, Input* out) {
  Car* c = find(id);
  if (!c || c->finished) return false;  // pose always present after ctor
  Input m = ai.drive(*c, *centerline_, *this);
  if (out) *out = m;
  processInput(id, m);
  return true;
}

bool Game::giveItem(const Id& id, const std::string& item, bool hasTCatch, double tCatch) {
  Car* c = find(id);
  if (!c) return false;
  c->item = item;  // "" clears
  c->pickupAge = 999;
  if (hasTCatch) c->tCatch = tCatch;
  return true;
}

bool Game::useItem(const Id& id) {
  Car* c = find(id);
  if (!c || c->item.empty()) return false;
  useItemImpl(*c);
  return true;
}

bool Game::forceFinish(const Id& id, bool hasTime, double time) {
  Car* c = find(id);
  if (!c || c->finished) return false;
  c->finished = true;
  c->finishTimeNull = false;
  c->finishTime = hasTime ? time : elapsed_;
  if (indexOfId(finishedOrder_, id) < 0) finishedOrder_.push_back(id);
  rank();
  return true;
}

long Game::stageBanana(double s, double lat) {
  BananaRt b{++bananaSeq_, wrap_s(s, length_), lat, Id::None(), 0, false, 0, false};
  bananas_.push_back(b);
  return b.id;
}

long Game::stageRocket(double s, double lat, double v, Id owner) {
  RocketRt r{++rocketSeq_, s, lat, owner, Id::None(), 0, v, false};
  rockets_.push_back(r);
  return r.id;
}

// ---- geometry helpers --------------------------------------------------------
double Game::curbLimit(double width) const {
  return (!std::isnan(width)) ? js_max(0.1, width / 2 - LAT_MARGIN) : maxLat_;
}
Game::HalfExtents Game::halfExtents(const Car& c) const {
  if (c.monsterT > 0) return {MONSTER_HALF_LEN, MONSTER_HALF_WID};
  return {c.halfLen, c.halfWid};
}

Game::FP Game::footprint(const Car& c) const {
  HalfExtents e = halfExtents(c);
  double hl = e.len, hw = e.wid;
  double ch = std::fabs(dmath::cos(c.heading)), sh = std::fabs(dmath::sin(c.heading));
  return {hl * sh + hw * ch, hw};
}

// The curb as a POSITION constraint: pin the car inside it and say whether it
// had to. Split out of clampCurb because the collision passes have to re-pin
// between sweeps (see resolveCollisions) and must not bill the wall each time.
bool Game::pinCurb(Car& c) {
  double base = c.curbLimSet ? c.curbLim : maxLat_;
  FP fpt = footprint(c);
  double lim = js_max(0.05, base - (fpt.side - fpt.restSide));
  if (c.lat <= lim && c.lat >= -lim) return false;
  c.lat = c.lat > 0 ? lim : -lim;
  c.onWall = true;
  return true;
}

// What touching the curb COSTS: the rash timer, the speed cap, and the end of
// any shove (a car scraping a barrier must not keep coasting on a gift).
void Game::billCurb(Car& c, double dt) {
  double cap = c.vmax * g_wallSpeedFrac;
  c.wallRashT = WALL_RASH_T;
  c.shoveT = 0;
  if (c.v > cap) c.v = js_max(cap, c.v - WALL_DECEL * dt);
}

// The integration's curb: pin the car, turn it along the wall, bill it. The
// turn lives here and not in billCurb, which resolveCollisions also calls AFTER
// its passes: a car turned there would swing its body into a neighbour the
// passes have already separated it from. A car pinned only by a shove is
// billed, not turned; the next frame's pin turns it.
void Game::clampCurb(Car& c, double dt) {
  if (!pinCurb(c)) return;
  // A positive heading steers toward -lateral, so the angle INTO the wall the
  // car is pinned on is -heading on the +lat side.
  double side = c.lat > 0 ? 1 : -1;
  double into = -c.heading * side;
  if (into > -WALL_PEEL) {
    double turned = js_min((into + WALL_PEEL) * (1 - dmath::exp(-g_wallTurnRate * dt)),
                           g_wallTurnMax * dt);
    c.heading += turned * side;
    c.v *= dmath::exp(-g_wallImpact * turned);
  }
  billCurb(c, dt);
}

bool Game::inStrip(const Car& c, const PadRt& z) const {
  double ds = wrap_delta(c.totalS - z.s, length_);
  double dl = c.lat - z.lat;
  return std::fabs(ds) < z.halfLen && std::fabs(dl) < z.halfWidth;
}
bool Game::inZone(const Car& c, double zs, double zlat, double radius) const {
  double ds = wrap_delta(c.totalS - zs, length_);
  double dl = c.lat - zlat;
  return (ds * ds + dl * dl) < radius * radius;
}

bool Game::enterZonesOil(Car& c) {
  bool entered = false;
  for (int i = 0; i < (int)hazards_.size(); i++) {
    const Zone& z = hazards_[i];
    bool hit = inZone(c, z.s, z.lat, z.radius);
    if (hit) {
      if (!c.oilIn.count(i)) {
        c.oilIn.insert(i);
        auto it = c.oilCd.find(i);
        double cdv = it != c.oilCd.end() ? it->second : 0;
        if (elapsed_ >= cdv) { entered = true; c.oilCd[i] = elapsed_ + OIL_REARM; }
      }
    } else c.oilIn.erase(i);
  }
  return entered;
}
bool Game::enterZonesPads(Car& c) {
  bool entered = false;
  for (int i = 0; i < (int)pads_.size(); i++) {
    const PadRt& z = pads_[i];
    bool hit = z.strip ? inStrip(c, z) : inZone(c, z.s, z.lat, z.radius);
    if (hit) {
      if (!c.padIn.count(i)) { c.padIn.insert(i); entered = true; }
    } else c.padIn.erase(i);
  }
  return entered;
}

void Game::computeCatchUp(double dt) {
  double lead = -INF, tail = INF;
  int n = 0;
  for (const auto& c : cars_) {
    if (c->finished) continue;
    n++;
    if (c->totalS > lead) lead = c->totalS;
    if (c->totalS < tail) tail = c->totalS;
  }
  if (!n) return;
  double denom = js_max(lead - tail, SPREAD_REF_FRAC * length_);
  double k = 1 - dmath::exp(-dt / T_TAU);
  for (const auto& c : cars_) {
    if (c->finished) { c->tRaw = 0; c->tCatch = 0; continue; }
    double raw = (lead - c->totalS) / denom;
    raw = raw < 0 ? 0 : raw > 1 ? 1 : raw;
    c->tRaw = raw;
    c->tCatch += (raw - c->tCatch) * k;
  }
}

void Game::tickProps(double dt) {
  for (auto& b : boxes_) if (b.cooldown > 0) b.cooldown = js_max(0.0, b.cooldown - dt);
}

void Game::applyPad(Car& c) {
  double mul = PAD_BOOST_MIN + (PAD_BOOST_MAX - PAD_BOOST_MIN) * c.tRaw;
  c.boostMul = js_max(c.boostMul, mul);
  c.boostT = js_max(c.boostT, BOOST_DURATION);
}

void Game::enterBox(Car& c) {
  if (boxes_.empty()) return;
  for (int i = 0; i < (int)boxes_.size(); i++) {
    BoxRt& b = boxes_[i];
    bool inside = b.cooldown <= 0 && inZone(c, b.s, b.lat, b.radius);
    if (inside && !c.boxIn.count(i)) {
      c.boxIn.insert(i);
      if (c.rowIn.count(b.row)) continue;
      c.rowIn[b.row] = i;
      if (!c.finished || c.item.empty()) {
        c.item = roll(placeT(c)); c.pickupAge = 0; b.cooldown = BOX_RESPAWN;
        Event e; e.type = "pickup"; e.id = c.id; e.item = c.item; e.finished = c.finished; emit(e);
      } else {
        b.cooldown = BOX_RESPAWN;
        Event e; e.type = "pickup"; e.id = c.id; e.item = c.item; e.finished = true; emit(e);
      }
    } else if (!inside) { c.boxIn.erase(i); }
  }
  if (!c.rowIn.empty()) {
    for (auto it = c.rowIn.begin(); it != c.rowIn.end();) {
      const BoxRt& rb = boxes_[it->second];
      if (std::fabs(wrap_delta(c.totalS - rb.s, length_)) > rb.radius) it = c.rowIn.erase(it);
      else ++it;
    }
  }
}

double Game::placeT(const Car& c) const {
  int n = (int)cars_.size();
  return n > 1 ? (double)(c.rank - 1) / (n - 1) : 0;
}

std::string Game::roll(double t) {
  if (!forceItem_.empty()) return forceItem_;
  // From the table, not retyped from it. The JS this was ported from wrote
  // `ITEM_PLACE_TABLE.length - 1`; the port turned that into a literal 8, so a
  // ninth tier would have been unindexable and every corpus would have stayed
  // green while its author believed it had been added.
  int last = (int)(sizeof(ITEM_PLACE_TABLE) / sizeof(ITEM_PLACE_TABLE[0])) - 1;
  int idx = (int)js_max(0.0, js_min((double)last, js_round(t * last)));
  const int* row = ITEM_PLACE_TABLE[idx];
  double total = 0; for (int i = 0; i < 4; i++) total += row[i];
  double r = rng_.next() * total;
  for (int i = 0; i < 4; i++) { r -= row[i]; if (r <= 0) return ITEM_IDS[i]; }
  return ITEM_IDS[3];
}

Car* Game::nextCarAhead(const Car& c) {
  double L = length_;
  Car* best = nullptr;
  double bestGap = INF;
  for (const auto& o : cars_) {
    if (o.get() == &c) continue;
    double fwd = wrap_s(o->totalS - c.totalS, L);
    if (fwd >= ROCKET_TARGET_MIN && fwd < bestGap) { bestGap = fwd; best = o.get(); }
  }
  return best;
}

void Game::useItemImpl(Car& c) {
  { Event e; e.type = "item_use"; e.id = c.id; e.item = c.item; emit(e); }
  if (c.item == "boost") {
    double t = js_max(0.0, js_min(1.0, c.tCatch));
    c.boostMul = js_max(c.boostMul, BOOST_ITEM_MUL);
    c.boostT = js_max(c.boostT, BOOST_ITEM_DUR_MIN + (BOOST_ITEM_DUR_MAX - BOOST_ITEM_DUR_MIN) * t);
  } else if (c.item == "banana") {
    // Dropped ON the rear bumper, not clear of it: a tailgater a nose behind is
    // already over anything further back, and would spin on a banana it never saw.
    double back = halfExtents(c).len;
    Frame f = centerline_->sampleAt(c.totalS);
    Vec3 fwd = f.tangent.clone().applyAxisAngle(f.up, c.heading);
    Vec3 world = f.pos.clone().addScaledVector(f.lateral, c.lat).addScaledVector(fwd, -back);
    ProjectResult hit = centerline_->projectNear(world, c.totalS, back + 0.5);
    double lim = curbLimit(hit.frame.width);
    double lat = js_max(-lim, js_min(lim, hit.lat));
    double s = wrap_s(hit.s, length_);
    double armAt = elapsed_ + BANANA_OWNER_IMMUNE;
    bananas_.push_back(BananaRt{++bananaSeq_, s, lat, c.id, armAt, false, 0, false});
  } else if (c.item == "rocket") {
    Car* target = nextCarAhead(c);
    double fwd = target ? wrap_s(target->totalS - c.totalS, length_) : INF;
    double ahead = js_min(ROCKET_LAUNCH_AHEAD, js_max(0.0, (fwd - ROCKET_HIT) * 0.5));
    rockets_.push_back(RocketRt{++rocketSeq_, c.totalS + ahead, c.lat, c.id,
                                target ? target->id : Id::None(), 0, c.v, false});
  } else if (c.item == "monster") {
    double t = js_max(0.0, js_min(1.0, c.tCatch));
    c.monsterT = MONSTER_DUR_MIN + (MONSTER_DUR_MAX - MONSTER_DUR_MIN) * t;
  }
  c.item = "";
}

bool Game::enterBanana(Car& c) {
  if (bananas_.empty()) return false;
  bool hit = false;
  for (auto& b : bananas_) {
    if (b.hit) continue;
    if (elapsed_ < b.liveAt) continue;
    if (b.id > bananaSeqAtStep_) continue;  // dropped this step: show it for a frame first
    if (b.owner == c.id && elapsed_ < b.armAt) continue;
    if (inZone(c, b.s, b.lat, BANANA_RADIUS)) {
      hit = true;
      if (b.respawn) b.liveAt = elapsed_ + BOX_RESPAWN;
      else b.hit = true;
    }
  }
  if (hit) bananas_.erase(std::remove_if(bananas_.begin(), bananas_.end(),
                                         [](const BananaRt& b) { return b.hit; }),
                          bananas_.end());
  return hit;
}

void Game::spinOut(Car& c, const std::string& cause) {
  c.spin = 0;
  c.spinT = SPIN_TIME;
  c.boostT = 0; c.boostMul = 1;
  Event e; e.type = "spin"; e.id = c.id; e.cause = cause; emit(e);
}

void Game::stepRockets(double dt) {
  if (rockets_.empty()) return;
  double L = length_;
  for (auto& r : rockets_) {
    r.life += dt;
    Car* t = r.targetId.isNull() ? nullptr : find(r.targetId);
    if (t) {
      double fwd = wrap_s(t->totalS - r.s, L);
      double reach = js_max(0.0, fwd - ROCKET_HIT);
      double close = js_min(ROCKET_CRUISE, ROCKET_IMPACT + reach * ROCKET_APPROACH_K);
      double vWant = js_max(0.0, t->v) + close;
      double accel = vWant > r.v ? ROCKET_ACCEL : ROCKET_DECEL;
      r.v += js_max(-accel * dt, js_min(accel * dt, vWant - r.v));
      r.s += js_min(r.v * dt, fwd);
      r.lat += (t->lat - r.lat) * js_min(1.0, ROCKET_HOME * dt);
      if (fwd <= ROCKET_HIT && r.life >= ROCKET_MIN_LIFE) { spinOut(*t, "rocket"); r.hit = true; }
    } else {
      r.targetId = Id::None();
      r.v += js_max(-ROCKET_DECEL * dt, js_min(ROCKET_ACCEL * dt, ROCKET_WHIFF_SPEED - r.v));
      r.s += r.v * dt;
    }
    if (!r.hit && r.life > ROCKET_LIFE) {
      Event e; e.type = "rocket_expire"; e.id = Id::Num(r.id); e.s = wrap_s(r.s, L); e.lat = r.lat; emit(e);
      r.hit = true;
    }
  }
  bool any = false;
  for (auto& r : rockets_) if (r.hit) any = true;
  if (any) rockets_.erase(std::remove_if(rockets_.begin(), rockets_.end(),
                                         [](const RocketRt& r) { return r.hit; }),
                          rockets_.end());
}

// ---- collisions --------------------------------------------------------------
// Add a track-frame impulse to a car that stores its velocity as (speed along
// heading, lateral rate). The decomposition is exact and unique — v gains
// dS/cos(heading) — so the divisor is not a bug, it is what a body constrained
// to travel along its heading must gain to match a given longitudinal push.
// It is still bad contact: at the heading cap the gain is 3.2x and an angled
// scrum pings. IMPULSE_COS_FLOOR caps it, and the momentum past the cap is
// dropped rather than redirected, which is the damping an angled hit wants.
void Game::applyImpulse(Car& c, double dS, double dL) {
  double sh = dmath::sin(c.heading);
  double gain = 1.0 / js_max(IMPULSE_COS_FLOOR, dmath::cos(c.heading));
  double v = js_max(0.0, c.v + dS * gain);
  c.vlat = c.vlat + dL + (v - c.v) * sh;   // before c.v moves: the term reads the OLD speed
  c.v = v;
}

// ---- the collision frame -----------------------------------------------------
// The collider works in WORLD metres, not in (s, lat).
//
// (s, lat) is not a Cartesian plane and treating it as one was wrong three ways
// at once: a metre of arc is (1 - lat*k) metres of ground, two cars a car-length
// apart sit in track frames rotated by k*ds, and the line between them bows off
// the tangent by the corner's sagitta. On cloverleaf, whose centreline turns
// inside its own half-width, all three are first-order. Correcting them one at a
// time traded misses for phantom contacts — an invisible bump reaching a
// half-car past touching — because a half-corrected frame is not any geometry.
// Measuring in the world costs nothing extra: the track frame is cached once per
// car per step from the frame the integration already sampled, and the pair loop
// that used to spend eight sin/cos on footprint() and yaw now spends none.
void Game::cacheColFrame(Car& c, const Frame& f) {
  c.colPos = f.pos;
  c.colTan = f.tangent;
  c.colLat = f.lateral;
  c.colS = c.totalS;
  // The body follows the HEADING, never the spin: a spin-out is drawn, not
  // driven (the car still travels along its heading), and a rectangle turning
  // with it would pulse its reach by a quarter metre, shoving anything in
  // contact four times a second.
  c.colFwd = f.tangent.clone().applyAxisAngle(f.up, c.heading);
  c.colRight = c.colFwd.clone().cross(f.up);
  // Curvature IN THE ROAD PLANE — the only component that stretches a lateral
  // offset. d(lateral)/ds . tangent is -k by construction; a loop's vertical
  // curvature falls out of it, which is correct, since a barrel roll does not
  // change how far apart two cars beside each other are.
  Frame probe = centerline_->sampleAt(c.totalS + CURV_PROBE);
  double curv = -probe.lateral.sub(f.lateral).dot(f.tangent) / CURV_PROBE;
  c.colRib = js_max(RIBBON_SCALE_MIN, js_min(RIBBON_SCALE_MAX, 1 - c.lat * curv));
}

// Where the car is right now. The cached frame is the one sampled at colS, so
// any totalS the collision passes have since added is walked off along the
// tangent — a correction of a few centimetres, where that is exact enough.
Vec3 Game::colWorld(const Car& c) const {
  return c.colPos.clone()
      .addScaledVector(c.colLat, c.lat)
      .addScaledVector(c.colTan, (c.totalS - c.colS) * c.colRib);
}

// SAT between the two bodies, run in A's ground plane: four axes, because two
// rectangles have two distinct normals each. Returns a WORLD normal pointing
// from a to b, and the depth along it.
Game::Hit Game::satRects(const Car& a, const Car& b) const {
  HalfExtents ea = halfExtents(a), eb = halfExtents(b);
  double hla = ea.len * COLLIDE_SHRINK, hwa = ea.wid * COLLIDE_SHRINK;
  double hlb = eb.len * COLLIDE_SHRINK, hwb = eb.wid * COLLIDE_SHRINK;
  // b's body axes as seen in a's plane. Normalized because the two cars' ground
  // planes tilt apart on a bank or a crest, which shortens the projection.
  Vec3 d = colWorld(b).sub(colWorld(a));
  double dx = d.dot(a.colFwd), dy = d.dot(a.colRight);
  double ubx = b.colFwd.dot(a.colFwd), uby = b.colFwd.dot(a.colRight);
  double ul = std::sqrt(ubx * ubx + uby * uby);
  if (ul < 1e-9) return {false, Vec3(), 0};   // b stands on end relative to a
  ubx /= ul; uby /= ul;
  double wbx = -uby, wby = ubx;               // +90 degrees, matching fwd x up
  double axes[8] = {1, 0, 0, 1, ubx, uby, wbx, wby};
  double pen = INF, nx = 0, ny = 0;
  for (int i = 0; i < 8; i += 2) {
    double xS = axes[i], xL = axes[i + 1];
    double ra = hla * std::fabs(xS) + hwa * std::fabs(xL);
    double rb = hlb * std::fabs(ubx * xS + uby * xL) + hwb * std::fabs(wbx * xS + wby * xL);
    double sep = dx * xS + dy * xL;
    double overlap = ra + rb - std::fabs(sep);
    if (overlap <= 0) return {false, Vec3(), 0};
    if (overlap < pen) {
      pen = overlap;
      if (sep >= 0) { nx = xS; ny = xL; }
      else { nx = -xS; ny = -xL; }
    }
  }
  Vec3 n = a.colFwd.clone().multiplyScalar(nx).addScaledVector(a.colRight, ny);
  return {true, n, pen};
}

// A world displacement, written back into the car's own (totalS, lat). The
// arc step divides the ribbon out again: `push` is ground metres, totalS is
// centreline metres.
void Game::separate(Car& c, const Vec3& push) {
  c.totalS += push.dot(c.colTan) / c.colRib;
  c.lat += push.dot(c.colLat);
}

// A world impulse, resolved into the track components applyImpulse speaks.
void Game::applyWorldImpulse(Car& c, const Vec3& imp) {
  applyImpulse(c, imp.dot(c.colTan), imp.dot(c.colLat));
}

// Spin the victim out and knock it off the monster's line: away from the side
// the monster is on, or toward the road's middle when they are dead in line.
void Game::monsterHit(const Car& m, Car& v) {
  spinOut(v, "monster");
  double side = v.lat - m.lat;
  if (side == 0) side = -v.lat;
  v.vlat += side < 0 ? -MONSTER_KNOCK : MONSTER_KNOCK;
}

void Game::collidePair(Car& a, Car& b) {
  // Broadphase in world metres: one subtraction and a length, no trigonometry.
  // Each car contributes its own longer half-extent, and the sum is doubled —
  // comfortably past the diagonals it stands in for, which is the only property
  // a reject needs.
  HalfExtents ea = halfExtents(a), eb = halfExtents(b);
  double reach = (js_max(ea.len, ea.wid) + js_max(eb.len, eb.wid)) * 2;
  Vec3 d = colWorld(b).sub(colWorld(a));
  if (d.lengthSq() >= reach * reach) return;
  Hit hit = satRects(a, b);
  if (!hit.hit) return;

  bool aMon = a.monsterT > 0, bMon = b.monsterT > 0;
  if (aMon && !bMon && b.spinT <= 0) monsterHit(a, b);
  if (bMon && !aMon && a.spinT <= 0) monsterHit(b, a);

  double massA = aMon ? a.mass * MONSTER_MASS_MUL : a.mass;
  double massB = bMon ? b.mass * MONSTER_MASS_MUL : b.mass;
  double invA = 1 / massA, invB = 1 / massB, invSum = invA + invB;
  double aShare = invA / invSum;
  double bShare = invB / invSum;

  // Solid is solid: the whole remaining overlap, every pass. Under-relaxing it
  // only leaves depth for the next frame to inherit; the passes are what carry
  // convergence when a third car is in the way.
  double push = js_max(0.0, hit.pen - COLLIDE_SLOP);
  separate(a, hit.n.clone().multiplyScalar(-push * aShare));
  separate(b, hit.n.clone().multiplyScalar(push * bShare));

  // World velocities, so a pair whose track frames have turned apart still
  // exchanges momentum along the real contact normal.
  Vec3 va = a.colTan.clone().multiplyScalar(a.v * dmath::cos(a.heading))
                .addScaledVector(a.colLat, -a.v * dmath::sin(a.heading) + a.vlat);
  Vec3 vb = b.colTan.clone().multiplyScalar(b.v * dmath::cos(b.heading))
                .addScaledVector(b.colLat, -b.v * dmath::sin(b.heading) + b.vlat);
  double vrel = vb.sub(va).dot(hit.n);
  if (vrel < 0) {
    // Dead below RESTITUTION_MIN_CLOSE: queueing traffic must hold contact.
    // A monster never bounces off a car: it ploughs, and the knock clears the
    // victim. Two monsters bounce like any pair.
    double e = (aMon == bMon && -vrel >= RESTITUTION_MIN_CLOSE) ? RESTITUTION : 0.0;
    double j = -(1 + e) * vrel / invSum;
    double va0 = a.v, vb0 = b.v;
    applyWorldImpulse(a, hit.n.clone().multiplyScalar(-j * invA));
    applyWorldImpulse(b, hit.n.clone().multiplyScalar(j * invB));
    // Whoever the contact SPED UP holds the gift on the gentle bleed.
    if (a.v > va0) a.shoveT = SHOVE_GRACE;
    if (b.v > vb0) b.shoveT = SHOVE_GRACE;
  }
}

// A pole is a static circle standing on the road. Same world frame as the pair
// collider: the pole's centre is expressed in the car's own body axes, clamped
// to the rectangle, and the residual is the contact.
void Game::collidePole(Car& c, const PoleRt& p) {
  HalfExtents e = halfExtents(c);
  double hl = e.len, hw = e.wid;
  // The pole's world position. Its frame never moves, so this is the car's
  // cached frame walked to the pole's arclength — near enough over the metre or
  // so a contact spans, and it costs no sample.
  Vec3 poleW = c.colPos.clone()
                   .addScaledVector(c.colTan, wrap_delta(p.s - c.colS, length_) * c.colRib)
                   .addScaledVector(c.colLat, p.lat);
  Vec3 d = poleW.sub(colWorld(c));
  double reach = hl + hw + p.radius;
  if (d.lengthSq() >= reach * reach) return;
  double lx = d.dot(c.colFwd), ly = d.dot(c.colRight);
  double qx = js_max(-hl, js_min(hl, lx));
  double qy = js_max(-hw, js_min(hw, ly));
  double ex = lx - qx, ey = ly - qy;
  double d2 = ex * ex + ey * ey;
  if (d2 >= p.radius * p.radius) return;
  double nx, ny, pen;
  if (d2 > 1e-6) {
    double dist = std::sqrt(d2);
    nx = -ex / dist; ny = -ey / dist;
    pen = p.radius - dist;
  } else {
    // The pole's centre is INSIDE the rectangle: push out the nearest face.
    double bx = hl - std::fabs(lx), by = hw - std::fabs(ly);
    nx = 0; ny = 0;
    if (bx <= by) { nx = lx > 0 ? -1 : 1; pen = p.radius + bx; }
    else { ny = ly > 0 ? -1 : 1; pen = p.radius + by; }
  }
  Vec3 n = c.colFwd.clone().multiplyScalar(nx).addScaledVector(c.colRight, ny);
  separate(c, n.clone().multiplyScalar(pen));
  Vec3 v = c.colTan.clone().multiplyScalar(c.v * dmath::cos(c.heading))
               .addScaledVector(c.colLat, -c.v * dmath::sin(c.heading) + c.vlat);
  double vn = v.dot(n);
  if (vn < 0) {
    applyWorldImpulse(c, n.clone().multiplyScalar(-vn));
    if (c.v < POLE_MIN_KEEP * c.vmax) c.v = POLE_MIN_KEEP * c.vmax;
  }
  c.vlat = 0;
  // A head-on hit kills a boost; a graze down the flank does not.
  if (std::fabs(n.dot(c.colTan)) > 0.6) { c.boostT = 0; c.boostMul = 1; }
  c.onWall = true;
}

void Game::resolveCollisions(double dt) {
  // A finished car is a ghost to the racing pack — a coasting winner must never
  // block or deflect a car still fighting for its result — but solid to the
  // other finished cars, so the victory lap doesn't overlap. Poles stay
  // ghosted after the line: the autopilot never aims at one, and nothing a
  // pole hit protects still matters.
  std::vector<Car*>& list = carScratch_;
  list.clear();
  for (const auto& c : cars_) list.push_back(c.get());
  // Relaxation: one sweep resolved pair (0,1) by burying car 0 in car 2 and
  // nothing looked again, so a start-line scrum stayed interpenetrated for
  // whole frames. Each pass re-tests against what the last one left. The
  // impulse is self-limiting (see COLLIDE_PASSES), so this converges the
  // geometry without pumping the velocities.
  for (Car* c : list) c->curbHit = false;
  for (int pass = 0; pass < COLLIDE_PASSES; pass++) {
    for (size_t i = 0; i < list.size(); i++)
      for (size_t j = i + 1; j < list.size(); j++)
        if (list[i]->finished == list[j]->finished
            && std::fabs(list[i]->h - list[j]->h) < AIR_CLEAR)
          collidePair(*list[i], *list[j]);
    if (!poles_.empty())
      for (Car* c : list)
        if (!c->finished)
          for (const PoleRt& p : poles_) collidePole(*c, p);
    // The curb is a constraint like any other and belongs INSIDE the loop.
    // Clamped only at the end, two cars pinned on the same wall stayed buried
    // in each other: the sweep separated them laterally, the clamp put them
    // straight back, and no pass was left to find the escape along the road.
    // That was every worst overlap on the catalogue.
    for (Car* c : list) if (pinCurb(*c)) c->curbHit = true;
  }
  // Billed once, however many passes had to pin: the wall costs what it costs.
  for (Car* c : list) if (c->curbHit) billCurb(*c, dt);
}

void Game::recomputePoses() {
  for (const auto& cp : cars_) {
    Car& c = *cp;
    Frame f = centerline_->sampleAt(c.totalS);
    Vec3 up = f.up;
    if (c.lat > 0.05 || c.lat < -0.05) {
      Frame f2 = centerline_->sampleAt(c.totalS + CURV_PROBE);
      double tau = dmath::atan2(f.up.clone().cross(f2.up).dot(f.tangent), f.up.dot(f2.up)) / CURV_PROBE;
      if (tau > 1e-3 || tau < -1e-3) up = f.up.clone().addScaledVector(f.tangent, c.lat * tau).normalize();
    }
    Vec3 forward = f.tangent.clone().applyAxisAngle(f.up, c.heading);
    Frame fR = centerline_->sampleAt(c.totalS - c.halfLen);
    Frame fF = centerline_->sampleAt(c.totalS + c.halfLen);
    Vec3 chord = fF.pos.addScaledVector(fF.lateral, c.lat)
                     .sub(fR.pos.addScaledVector(fR.lateral, c.lat));
    double rise = chord.dot(up);
    double run = chord.addScaledVector(up, -rise).length();
    if (run > 1e-6) forward.addScaledVector(up, rise / run).normalize();
    c.pose.pos = f.pos.clone().addScaledVector(f.lateral, c.lat);
    if (c.h != 0) c.pose.pos.addScaledVector(up, c.h);
    c.pose.forward = forward;
    c.pose.up = up;
  }
}

// The ramp surface under a car: how far up a kicker's wedge it is, or 0 off
// every kicker (the deck itself).
double Game::kickerFloor(double totalS) const {
  for (double k : kickers_) {
    double d = std::fmod(std::fmod(totalS - k, length_) + length_, length_);
    if (d < KICKER_LEN) return KICKER_RISE * d / KICKER_LEN;
  }
  return 0;
}

// A per-CREST_STEP table read at a car's arclength, interpolated.
double Game::tableAt(const std::vector<double>& t, double totalS) const {
  double x = std::fmod(std::fmod(totalS, length_) + length_, length_) / CREST_STEP;
  int n = (int)t.size();
  int i = (int)x;
  double f = x - i;
  i %= n;
  return t[i] + (t[(i + 1) % n] - t[i]) * f;
}

void Game::rank() {
  std::vector<Car*>& arr = carScratch_;
  arr.clear();
  for (const auto& c : cars_) arr.push_back(c.get());
  std::stable_sort(arr.begin(), arr.end(), raceLess);
  for (size_t i = 0; i < arr.size(); i++) arr[i]->rank = (int)i + 1;
}

// ---- the frame ---------------------------------------------------------------
void Game::update(double dtMs) {
  double dt = js_min(dtMs / 1000, 0.05);
  if (dt <= 0) return;
  elapsed_ += dt;
  bananaSeqAtStep_ = bananaSeq_;
  computeCatchUp(dt);
  tickProps(dt);
  stepRockets(dt);

  for (const auto& cp : cars_) {
    Car& c = *cp;
    c.onWall = false;
    if (c.finished) {
      c.steer = pursue(c, *centerline_, LOOKAHEAD, STEER_GAIN, 0);
      c.brake = cornerBrake(c, *centerline_, 0, 1, nullptr);
    }

    bool spinning = c.spinT > 0;
    if (spinning) {
      c.spinT -= dt;
      c.spin += (SPIN_TURNS * 2 * PI / SPIN_TIME) * dt;
      if (c.spinT <= 0) { c.spinT = 0; c.spin = 0; spinning = false; }
    }
    // Oil, bananas and pads lie ON the deck, so a car in the air clears them.
    bool grounded = c.h < AIR_MIN;
    {
      bool oil = grounded && enterZonesOil(c);
      bool ban = grounded && enterBanana(c);
      if ((oil || ban) && c.monsterT <= 0) {
        if (!spinning) c.spin = 0;
        c.spinT = SPIN_TIME; spinning = true;
        c.boostT = 0; c.boostMul = 1;
        Event e; e.type = "spin"; e.id = c.id; e.cause = ban ? "banana" : "oil"; emit(e);
      }
    }

    if (!c.finished) {
      c.pickupAge += dt;
      if (c.wantUse && !c.item.empty() && !spinning && c.pickupAge >= ITEM_USE_READY) { c.wantUse = false; useItemImpl(c); }
      else if (c.wantUse && c.item.empty()) c.wantUse = false;
      if (!spinning && grounded && enterZonesPads(c)) applyPad(c);
    }
    if (c.finished || elapsed_ > LAUNCH_GATE) enterBox(c);

    if (c.boostT > 0) { c.boostT -= dt; if (c.boostT < 0) c.boostT = 0; }
    else if (c.boostMul > 1) c.boostMul = js_max(1.0, c.boostMul - BOOST_FADE * dt);
    if (c.monsterT > 0) { c.monsterT -= dt; if (c.monsterT <= 0) { c.monsterT = 0; Event e; e.type = "monster_end"; e.id = c.id; emit(e); } }
    if (c.shoveT > 0) { c.shoveT -= dt; if (c.shoveT < 0) c.shoveT = 0; }
    // The drift (DRIFT_* above): held brake + hard steer at speed starts it on
    // a locked side, releasing the brake ends it.
    if (!c.driftOk || c.finished || spinning) { c.drifting = false; c.driftMix = 0; }
    else if (c.brake <= 0) c.drifting = false;
    else if (!c.drifting && std::fabs(c.steer) >= DRIFT_STEER_MIN && c.v >= DRIFT_SPEED_MIN * c.vmax) {
      c.drifting = true;
      c.driftDir = js_sign(c.steer);
      c.driftT = 0;
      // start on the curvature the car is already turning at, at this lean
      c.driftK = c.driftK0 = std::fabs(steerShape(c.steer)) * c.turn * steerAuthority(c) / c.v;
      c.driftLean0 = std::fabs(c.steer);
    }
    if (c.drifting) {
      c.driftMix = js_min(1.0, c.driftMix + dt / DRIFT_ENTER_T);
      c.driftT += dt;
    } else if (c.driftMix > 0) {
      c.driftMix = g_driftRelease > 0 ? js_max(0.0, c.driftMix - dt / g_driftRelease) : 0;
    }
    bool boosting = c.boostMul > 1;
    double brakeEff = boosting || c.drifting ? 0 : c.brake;
    double steerEff = spinning ? 0 : c.steer;
    double steerIn = steerShape(steerEff);
    double scrubEff = boosting ? 0 : STEER_SCRUB * steerIn * steerIn;
    if (c.driftMix > 0) {
      // + leans into the drift's side; no lean reaches straight
      double lean = js_max(0.0, js_min(1.0, steerEff * c.driftDir));
      double scale = g_driftTight * c.turn / TURN_RATE;
      double kIn = DRIFT_K_IN * scale, kOut = DRIFT_K_OUT * scale;
      double k0 = js_max(kOut, js_min(kIn, c.driftK0));
      double k = lean >= c.driftLean0
                     ? (c.driftLean0 >= 1 ? kIn : k0 + (lean - c.driftLean0) / (1 - c.driftLean0) * (kIn - k0))
                     : kOut + lean / c.driftLean0 * (k0 - kOut);
      c.driftK += g_driftSmooth > 0 ? (k - c.driftK) * (1 - dmath::exp(-dt / g_driftSmooth)) : k - c.driftK;
      if (!boosting) scrubEff += ((1 - g_driftFloor) - scrubEff) * c.driftMix;
    }
    double slipTo = c.driftMix * STEER_SIGN * c.driftDir * DRIFT_SLIP * js_min(1.0, c.driftK / DRIFT_K_IN);
    if (slipTo != 0 || c.slip != 0) {
      c.slip += (slipTo - c.slip) * (1 - dmath::exp(-DRIFT_SLIP_RATE * dt));
      if (slipTo == 0 && std::fabs(c.slip) < 1e-3) c.slip = 0;
    }
    double vmaxEff = c.monsterT > 0 ? c.vmax * MONSTER_VMAX_MUL : c.vmax;
    double targetV = vmaxEff * c.boostMul * (1 - brakeEff) * (1 - scrubEff);
    if (c.wallRashT > 0) {
      c.wallRashT -= dt;
      if (!boosting) {
        double heal = 1 - js_max(0.0, c.wallRashT) / WALL_RASH_T;
        targetV = js_min(targetV, c.vmax * (g_wallSpeedFrac + (1 - g_wallSpeedFrac) * heal));
      }
    }
    if (spinning) c.v *= dmath::exp(-SPIN_DRAG_RATE * dt);
    else if (c.v < targetV) c.v = js_min(targetV, c.v + (boosting ? BOOST_ACCEL : c.accel) * dt);
    // A car carried above its targetV by a shove bleeds it off gently, so a
    // rear-end reads as a push rather than as chatter. Off the brake ONLY:
    // contact must never blunt the brakes.
    else c.v = js_max(targetV,
                      c.v - (c.shoveT > 0 && brakeEff <= 0 ? SHOVE_DECEL : BRAKE_DECEL) * dt);

    double authority = steerAuthority(c);
    // A drift drives its line: the steer that turns curvature driftK at this
    // speed, blended in by driftMix.
    if (c.driftMix > 0) {
      double driftIn = c.driftDir * c.driftK * c.v / (c.turn * authority);
      steerIn += (driftIn - steerIn) * c.driftMix;
    }
    // after the drift's line, so a drift steers less in the air too
    if (!grounded) authority *= AIR_STEER;
    double steerHeading = c.heading + STEER_SIGN * steerIn * c.turn * authority * dt;

    double prevTotal = c.totalS;
    Frame f0 = centerline_->sampleAt(c.totalS);
    Vec3 fwd = f0.tangent.clone().applyAxisAngle(f0.up, steerHeading);
    Vec3 world = f0.pos.clone()
                     .addScaledVector(f0.lateral, c.lat)
                     .addScaledVector(fwd, c.v * dt)
                     .addScaledVector(f0.lateral, c.vlat * dt);
    c.vlat *= dmath::exp(-KNOCK_DAMP * dt);
    ProjectResult hit = centerline_->projectNear(world, c.totalS, c.v * dt + 0.5);
    c.totalS = js_max(prevTotal, hit.s);
    c.lat = hit.lat;
    c.curbLim = curbLimit(hit.frame.width); c.curbLimSet = true;
    c.heading = dmath::atan2(
        hit.frame.tangent.clone().cross(fwd).dot(hit.frame.up),
        hit.frame.tangent.dot(fwd));
    if (c.heading > MAX_HEADING) c.heading = MAX_HEADING;
    else if (c.heading < -MAX_HEADING) c.heading = -MAX_HEADING;

    clampCurb(c, dt);
    // The collision passes run in world space off this frame — cached here
    // because the integration has already paid for it.
    cacheColFrame(c, hit.frame);

    // Off the deck, measured from the road. A kicker's wedge carries the car
    // up at its slope times its speed. Over a crest nothing kicks it: the car
    // carries on along its own line and the road bends away beneath it, so its
    // height accelerates by v^2*k - GRAVITY (k the crest curvature) and it
    // leaves the deck only when the road falls away faster than gravity pulls
    // it down. In a dip or a loop that term is negative and the deck holds it.
    // On the catalogue's sharper humps that happens a little before the summit,
    // and stays honest: holding the car to the top and releasing it there put
    // the whole pull into one instant, which read as a hop off the crest.
    // In the air the body leaves at the angle it had, so against a road that
    // turns away under it the car pitches nose-up by k per metre travelled,
    // and tips back toward the road's angle at AIR_TIP.
    // Landing is neutral: the car keeps its speed and pays nothing.
    double ramp = kickerFloor(c.totalS);
    double k = tableAt(crestK_, c.totalS);
    double lift = c.v * c.v * k - GRAVITY - (k > 0 ? CREST_PULL * c.h : 0);
    if (c.h <= ramp && lift <= 0) {
      c.h = ramp;
      c.vh = ramp > 0 ? c.v * (KICKER_RISE / KICKER_LEN) : 0;
      c.pitch = ramp > 0 ? KICKER_PITCH : 0;
    } else {
      c.vh += lift * dt;
      c.h += c.vh * dt;
      c.pitch += (k * c.v - AIR_TIP * c.pitch) * dt;
      if (c.h <= ramp) { c.h = ramp; c.vh = 0; }
    }

    if (c.finished) continue;

    double prevLap = std::floor(js_max(0.0, prevTotal) / length_);
    double lap = std::floor(js_max(0.0, c.totalS) / length_);
    if (c.totalS >= 0 && lap > prevLap && prevTotal >= 0) {
      c.lap = lap;
      if (lap >= totalLaps_) {
        c.finished = true;
        c.finishTimeNull = false; c.finishTime = elapsed_;
        c.item = ""; c.wantUse = false;
        finishedOrder_.push_back(c.id);
        Event e; e.type = "finish"; e.id = c.id; e.rank = (int)finishedOrder_.size(); e.time = c.finishTime; emit(e);
      } else {
        Event e; e.type = "lap"; e.id = c.id; e.lap = (int)c.lap; emit(e);
      }
    } else {
      c.lap = js_max(0.0, lap);
    }
  }

  resolveCollisions(dt);
  recomputePoses();
  rank();
}

// ---- snapshot / results ------------------------------------------------------
static Value vec3Value(const Vec3& v) {
  Value o = Value::Obj();
  o.set("x", Value::Num(v.x));
  o.set("y", Value::Num(v.y));
  o.set("z", Value::Num(v.z));
  return o;
}

double Game::displayLap(const Car& c) const {
  return js_min((double)totalLaps_, js_max(1.0, c.lap + (c.totalS >= 0 ? 1.0 : 0.0)));
}

Value Game::getSnapshot() {
  Value cars = Value::Arr();
  for (const auto& cp : cars_) {
    Car& c = *cp;
    HalfExtents body = halfExtents(c);
    Value car = Value::Obj();
    car.set("id", c.id.toValue());
    Value pose = Value::Obj();
    pose.set("pos", vec3Value(c.pose.pos));
    pose.set("forward", vec3Value(c.pose.forward));
    pose.set("up", vec3Value(c.pose.up));
    car.set("pose", pose);
    car.set("lat", Value::Num(c.lat));
    car.set("spd", Value::Num(c.v / c.vmax));
    car.set("lap", Value::Num(displayLap(c)));
    car.set("totalLaps", Value::Num(totalLaps_));
    car.set("position", Value::Num(c.rank));
    car.set("finished", Value::Bool(c.finished));
    car.set("finishTime", c.finishTimeNull ? Value::Null() : Value::Num(c.finishTime));
    car.set("steer", Value::Num(STEER_SIGN * c.steer));
    car.set("steerInput", Value::Num(c.steer));
    car.set("brake", Value::Num(c.brake));
    car.set("onWall", Value::Bool(c.onWall));
    car.set("spin", Value::Num(c.spin));
    car.set("item", c.item.empty() ? Value::Null() : Value::Str(c.item));
    car.set("boostMul", Value::Num(c.boostMul));
    car.set("monster", Value::Bool(c.monsterT > 0));
    car.set("totalS", Value::Num(c.totalS));
    car.set("heading", Value::Num(c.heading));
    car.set("halfLen", Value::Num(body.len));
    car.set("halfWid", Value::Num(body.wid));
    cars.push(std::move(car));
  }
  Value boxes = Value::Arr();
  for (const auto& b : boxes_) boxes.push(Value::Bool(b.cooldown <= 0));
  Value bananas = Value::Arr();
  for (const auto& b : bananas_) {
    if (elapsed_ >= b.liveAt) {
      Value o = Value::Obj();
      o.set("id", Value::Num((double)b.id));
      o.set("s", Value::Num(b.s));
      o.set("lat", Value::Num(b.lat));
      o.set("radius", Value::Num(BANANA_RADIUS));
      bananas.push(std::move(o));
    }
  }
  Value rockets = Value::Arr();
  for (const auto& r : rockets_) {
    Value o = Value::Obj();
    o.set("id", Value::Num((double)r.id));
    o.set("s", Value::Num(wrap_s(r.s, length_)));
    o.set("lat", Value::Num(r.lat));
    rockets.push(std::move(o));
  }
  Value snap = Value::Obj();
  snap.set("version", Value::Num(2));
  snap.set("cars", std::move(cars));
  snap.set("boxes", std::move(boxes));
  snap.set("bananas", std::move(bananas));
  snap.set("rockets", std::move(rockets));
  return snap;
}

Value Game::getResults() {
  std::vector<Car*> ranked;
  for (const auto& c : cars_) ranked.push_back(c.get());
  std::stable_sort(ranked.begin(), ranked.end(), raceLess);
  Value results = Value::Arr();
  for (size_t i = 0; i < ranked.size(); i++) {
    Car* c = ranked[i];
    Value o = Value::Obj();
    o.set("playerId", c->id.toValue());
    o.set("rank", Value::Num((double)i + 1));
    o.set("finished", Value::Bool(c->finished));
    o.set("time", c->finishTimeNull ? Value::Null() : Value::Num(c->finishTime));
    results.push(std::move(o));
  }
  Value out = Value::Obj();
  out.set("results", std::move(results));
  return out;
}

}  // namespace ttp
