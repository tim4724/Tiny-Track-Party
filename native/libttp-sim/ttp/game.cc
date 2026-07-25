#include "ttp/game.h"

#include <algorithm>
#include <cmath>
#include <limits>

#include "ttp/ai_driver.h"
#include "ttp/dmath.h"
#include "ttp/jsmath.h"
#include "ttp/jsonnum.h"

namespace ttp {

// ---- module constants (Game.js) ---------------------------------------------
static const double ACCEL = 7.0;
static const double VMAX = 9.0;
static const double BRAKE_DECEL = 4.5;
static const double TURN_RATE = 0.90;
static const double STEER_EXPO = 1.25;
static const double MAX_HEADING = 1.25;
static const double STEER_SIGN = -1;
static const double WALL_SPEED_FRAC = 0.28;
static const double WALL_DECEL = 20.0;
static const double WALL_RASH_T = 0.5;
static const double LAT_MARGIN = 0.3;
static const double STEER_SCRUB = 0.28;
static const double COLLIDE_SHRINK = 0.9;
static const double RESTITUTION = 0.12;
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
static const double BOOST_ACCEL = 22.0;
static const double BOOST_FADE = 0.5;
static const double PAD_RADIUS = 0.65;
static const double BOX_RADIUS = 0.45;
static const double BOX_RESPAWN = 4.0;
static const double LAUNCH_GATE = 1.5;
static const double BANANA_RADIUS = 0.5;
static const double BANANA_BACK = 0.7;
static const double BANANA_OWNER_IMMUNE = 5.0;
static const double ROCKET_HOME = 8.0;
static const double ROCKET_HIT = 0.6;
static const double ROCKET_TARGET_MIN = 0.5;
static const double ROCKET_LIFE = 10.0;
static const double ROCKET_MIN_LIFE = 0.4;
static const double ROCKET_CRUISE = 22.0;
static const double ROCKET_IMPACT = 1.2;
static const double ROCKET_APPROACH_K = 1.8;
static const double ROCKET_ACCEL = 18.0;
static const double ROCKET_DECEL = 16.0;
static const double ROCKET_WHIFF_SPEED = ROCKET_CRUISE;
static const double ROCKET_LAUNCH_AHEAD = 0.7;
static const double MONSTER_DUR_MIN = 4.0;
static const double MONSTER_DUR_MAX = 8.0;
static const double MONSTER_MASS_MUL = 8.0;
static const double MONSTER_VMAX_MUL = 1.25;
static const double MONSTER_FOOTPRINT_MUL = 1.3;
static const double PI = 3.141592653589793;
static const double INF = std::numeric_limits<double>::infinity();

static double g_steerExpo = STEER_EXPO;  // setSteerExpo/getSteerExpo — traces never move it

void setSteerExpo(double v) {
  if (std::isfinite(v)) g_steerExpo = js_max(0.5, js_min(3.0, v));  // Game.js: clamp [0.5,3]
}
double getSteerExpo() { return g_steerExpo; }

static const char* ITEM_IDS[4] = {"boost", "banana", "rocket", "monster"};
static const int ITEM_PLACE_TABLE[8][4] = {
    {20, 80, 0, 0}, {25, 55, 20, 0}, {30, 30, 40, 0}, {30, 30, 30, 10},
    {30, 25, 25, 20}, {30, 25, 20, 25}, {30, 10, 20, 40}, {30, 0, 20, 50}};

// ---- Id / Event serialization ------------------------------------------------
std::string Id::key() const {
  if (kind == STR) return str;
  if (kind == NUM) return js_number_to_string(num);  // String(number) == Number::toString
  return "";
}
Value Id::toValue() const {
  if (kind == STR) return Value::Str(str);
  if (kind == NUM) return Value::Num(num);
  return Value::Null();
}

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

  for (size_t i = 0; i < players.size(); i++) {
    const PlayerDesc& desc = players[i];
    Stats st = normStats(desc.hasStats ? desc.stats : Stats{});
    int row = (int)(i / 2);
    double lane = (i % 2 == 0 ? -1.0 : 1.0) * js_min(maxLat_ * 0.6, 0.5);
    auto c = std::make_unique<Car>();
    c->id = desc.id;
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
double Game::colYaw(const Car& c) const { return c.heading + c.spin; }
double Game::footprintMul(const Car& c) const { return c.monsterT > 0 ? MONSTER_FOOTPRINT_MUL : 1; }

Game::FP Game::footprint(const Car& c) const {
  double fp = footprintMul(c);
  double hl = c.halfLen * fp, hw = c.halfWid * fp;
  double yaw = colYaw(c);
  double ch = std::fabs(dmath::cos(yaw)), sh = std::fabs(dmath::sin(yaw));
  return {hl * ch + hw * sh, hl * sh + hw * ch, hw};
}

void Game::clampCurb(Car& c, double dt) {
  double cap = c.vmax * WALL_SPEED_FRAC;
  double base = c.curbLimSet ? c.curbLim : maxLat_;
  FP fpt = footprint(c);
  double lim = js_max(0.05, base - (fpt.side - fpt.restSide));
  if (c.lat > lim || c.lat < -lim) {
    c.lat = c.lat > 0 ? lim : -lim;
    c.onWall = true;
    c.wallRashT = WALL_RASH_T;
    if (c.v > cap) c.v = js_max(cap, c.v - WALL_DECEL * dt);
  }
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
  int last = 8 - 1;
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
    Frame f = centerline_->sampleAt(c.totalS);
    Vec3 fwd = f.tangent.clone().applyAxisAngle(f.up, c.heading);
    Vec3 world = f.pos.clone().addScaledVector(f.lateral, c.lat).addScaledVector(fwd, -BANANA_BACK);
    ProjectResult hit = centerline_->projectNear(world, c.totalS, BANANA_BACK + 0.5);
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
void Game::applyImpulse(Car& c, double dS, double dL) {
  double ch = dmath::cos(c.heading), sh = dmath::sin(c.heading);
  double wS = c.v * ch + dS;
  double wL = -c.v * sh + c.vlat + dL;
  double v = js_max(0.0, wS / ch);
  c.v = v;
  c.vlat = wL + v * sh;
}

Game::Hit Game::satRects(const Car& a, const Car& b, double ds, double dl) const {
  double ma = footprintMul(a) * COLLIDE_SHRINK, mb = footprintMul(b) * COLLIDE_SHRINK;
  double hla = a.halfLen * ma, hwa = a.halfWid * ma;
  double hlb = b.halfLen * mb, hwb = b.halfWid * mb;
  double ya = colYaw(a), yb = colYaw(b);
  double ca = dmath::cos(ya), sa = dmath::sin(ya), cb = dmath::cos(yb), sb = dmath::sin(yb);
  double uaS = ca, uaL = -sa, waS = sa, waL = ca;
  double ubS = cb, ubL = -sb, wbS = sb, wbL = cb;
  double pen = INF, nS = 0, nL = 0;
  double axes[8] = {uaS, uaL, waS, waL, ubS, ubL, wbS, wbL};
  for (int i = 0; i < 8; i += 2) {
    double xS = axes[i], xL = axes[i + 1];
    double ra = hla * std::fabs(uaS * xS + uaL * xL) + hwa * std::fabs(waS * xS + waL * xL);
    double rb = hlb * std::fabs(ubS * xS + ubL * xL) + hwb * std::fabs(wbS * xS + wbL * xL);
    double d = ds * xS + dl * xL;
    double overlap = ra + rb - std::fabs(d);
    if (overlap <= 0) return {false, 0, 0, 0};
    if (overlap < pen) {
      pen = overlap;
      if (d >= 0) { nS = xS; nL = xL; }
      else { nS = -xS; nL = -xL; }
    }
  }
  return {true, nS, nL, pen};
}

void Game::collidePole(Car& c, const PoleRt& p) {
  double ds = wrap_delta(c.totalS - p.s, length_);
  double dl = c.lat - p.lat;
  double mul = footprintMul(c);
  double hl = c.halfLen * mul, hw = c.halfWid * mul;
  double reach = hl + hw + p.radius;
  if (ds * ds + dl * dl >= reach * reach) return;
  double yaw = colYaw(c);
  double cy = dmath::cos(yaw), sy = dmath::sin(yaw);
  double lx = -ds * cy + dl * sy;
  double ly = -ds * sy - dl * cy;
  double qx = js_max(-hl, js_min(hl, lx));
  double qy = js_max(-hw, js_min(hw, ly));
  double ex = lx - qx, ey = ly - qy;
  double d2 = ex * ex + ey * ey;
  if (d2 >= p.radius * p.radius) return;
  double nS, nL, pen;
  if (d2 > 1e-6) {
    double dist = std::sqrt(d2);
    double nlx = -ex / dist, nly = -ey / dist;
    nS = nlx * cy + nly * sy;
    nL = -nlx * sy + nly * cy;
    pen = p.radius - dist;
  } else {
    double dx = hl - std::fabs(lx), dy = hw - std::fabs(ly);
    double nlx = 0, nly = 0;
    if (dx <= dy) { nlx = lx > 0 ? -1 : 1; pen = p.radius + dx; }
    else { nly = ly > 0 ? -1 : 1; pen = p.radius + dy; }
    nS = nlx * cy + nly * sy;
    nL = -nlx * sy + nly * cy;
  }
  c.totalS += nS * pen;
  c.lat += nL * pen;
  double vS = c.v * dmath::cos(c.heading);
  double vL = -c.v * dmath::sin(c.heading) + c.vlat;
  double vn = vS * nS + vL * nL;
  if (vn < 0) {
    applyImpulse(c, -vn * nS, -vn * nL);
    if (c.v < POLE_MIN_KEEP * c.vmax) c.v = POLE_MIN_KEEP * c.vmax;
  }
  c.vlat = 0;
  if (std::fabs(nS) > 0.6) { c.boostT = 0; c.boostMul = 1; }
  c.onWall = true;
}

void Game::collidePair(Car& a, Car& b) {
  double ds = wrap_delta(b.totalS - a.totalS, length_);
  double dl = b.lat - a.lat;
  FP fpa = footprint(a), fpb = footprint(b);
  if (std::fabs(ds) >= (fpa.along + fpb.along) * COLLIDE_SHRINK) return;
  if (std::fabs(dl) >= (fpa.side + fpb.side) * COLLIDE_SHRINK) return;
  Hit hit = satRects(a, b, ds, dl);
  if (!hit.hit) return;

  if (a.monsterT > 0 && b.monsterT <= 0 && b.spinT <= 0) spinOut(b, "monster");
  if (b.monsterT > 0 && a.monsterT <= 0 && a.spinT <= 0) spinOut(a, "monster");

  double massA = a.monsterT > 0 ? a.mass * MONSTER_MASS_MUL : a.mass;
  double massB = b.monsterT > 0 ? b.mass * MONSTER_MASS_MUL : b.mass;
  double invA = 1 / massA, invB = 1 / massB, invSum = invA + invB;
  double aShare = invA / invSum;
  double bShare = invB / invSum;

  double nS = hit.nS, nL = hit.nL, pen = hit.pen;
  a.totalS -= nS * pen * aShare; a.lat -= nL * pen * aShare;
  b.totalS += nS * pen * bShare; b.lat += nL * pen * bShare;
  double vSa = a.v * dmath::cos(a.heading), vLa = -a.v * dmath::sin(a.heading) + a.vlat;
  double vSb = b.v * dmath::cos(b.heading), vLb = -b.v * dmath::sin(b.heading) + b.vlat;
  double vrel = (vSb - vSa) * nS + (vLb - vLa) * nL;
  if (vrel < 0) {
    double j = -(1 + RESTITUTION) * vrel / invSum;
    applyImpulse(a, -j * invA * nS, -j * invA * nL);
    applyImpulse(b, j * invB * nS, j * invB * nL);
  }
}

void Game::resolveCollisions(double dt) {
  std::vector<Car*> list;
  for (const auto& c : cars_) if (!c->finished) list.push_back(c.get());
  for (size_t i = 0; i < list.size(); i++)
    for (size_t j = i + 1; j < list.size(); j++) collidePair(*list[i], *list[j]);
  if (!poles_.empty())
    for (Car* c : list) for (const PoleRt& p : poles_) collidePole(*c, p);
  for (Car* c : list) clampCurb(*c, dt);
}

void Game::recomputePoses() {
  const double TWIST_PROBE = 0.6;
  for (const auto& cp : cars_) {
    Car& c = *cp;
    Frame f = centerline_->sampleAt(c.totalS);
    Vec3 up = f.up;
    if (c.lat > 0.05 || c.lat < -0.05) {
      Frame f2 = centerline_->sampleAt(c.totalS + TWIST_PROBE);
      double tau = dmath::atan2(f.up.clone().cross(f2.up).dot(f.tangent), f.up.dot(f2.up)) / TWIST_PROBE;
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
    c.pose.forward = forward;
    c.pose.up = up;
  }
}

void Game::rank() {
  std::vector<Car*> arr;
  for (const auto& c : cars_) arr.push_back(c.get());
  std::stable_sort(arr.begin(), arr.end(), raceLess);
  for (size_t i = 0; i < arr.size(); i++) arr[i]->rank = (int)i + 1;
}

// ---- the frame ---------------------------------------------------------------
void Game::update(double dtMs) {
  double dt = js_min(dtMs / 1000, 0.05);
  if (dt <= 0) return;
  elapsed_ += dt;
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
    {
      bool oil = enterZonesOil(c);
      bool ban = enterBanana(c);
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
      if (!spinning && enterZonesPads(c)) applyPad(c);
    }
    if (c.finished || elapsed_ > LAUNCH_GATE) enterBox(c);

    if (c.boostT > 0) { c.boostT -= dt; if (c.boostT < 0) c.boostT = 0; }
    else if (c.boostMul > 1) c.boostMul = js_max(1.0, c.boostMul - BOOST_FADE * dt);
    if (c.monsterT > 0) { c.monsterT -= dt; if (c.monsterT <= 0) { c.monsterT = 0; Event e; e.type = "monster_end"; e.id = c.id; emit(e); } }
    bool boosting = c.boostMul > 1;
    double brakeEff = boosting ? 0 : c.brake;
    double steerEff = spinning ? 0 : c.steer;
    double steerIn = js_sign(steerEff) * dmath::pow(std::fabs(steerEff), g_steerExpo);
    double scrubEff = boosting ? 0 : STEER_SCRUB * steerIn * steerIn;
    double vmaxEff = c.monsterT > 0 ? c.vmax * MONSTER_VMAX_MUL : c.vmax;
    double targetV = vmaxEff * c.boostMul * (1 - brakeEff) * (1 - scrubEff);
    if (c.wallRashT > 0) {
      c.wallRashT -= dt;
      if (!boosting) {
        double heal = 1 - js_max(0.0, c.wallRashT) / WALL_RASH_T;
        targetV = js_min(targetV, c.vmax * (WALL_SPEED_FRAC + (1 - WALL_SPEED_FRAC) * heal));
      }
    }
    if (spinning) c.v *= dmath::exp(-SPIN_DRAG_RATE * dt);
    else if (c.v < targetV) c.v = js_min(targetV, c.v + (boosting ? BOOST_ACCEL : c.accel) * dt);
    else c.v = js_max(targetV, c.v - BRAKE_DECEL * dt);

    double authority = 0.4 + 0.6 * js_min(1.0, c.v / (c.vmax * 0.5));
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

    if (c.finished) continue;

    double prevLap = std::floor(js_max(0.0, prevTotal) / length_);
    double lap = std::floor(js_max(0.0, c.totalS) / length_);
    if (c.totalS >= 0 && lap > prevLap && prevTotal >= 0) {
      c.lap = lap;
      if (lap >= totalLaps_ && !c.finished) {
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

Value Game::getSnapshot() {
  Value cars = Value::Arr();
  for (const auto& cp : cars_) {
    Car& c = *cp;
    double fpMul = footprintMul(c);
    Value car = Value::Obj();
    car.set("id", c.id.toValue());
    Value pose = Value::Obj();
    pose.set("pos", vec3Value(c.pose.pos));
    pose.set("forward", vec3Value(c.pose.forward));
    pose.set("up", vec3Value(c.pose.up));
    car.set("pose", pose);
    car.set("lat", Value::Num(c.lat));
    car.set("spd", Value::Num(c.v / c.vmax));
    car.set("lap", Value::Num(js_min((double)totalLaps_, js_max(1.0, c.lap + (c.totalS >= 0 ? 1.0 : 0.0)))));
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
    car.set("halfLen", Value::Num(c.halfLen * fpMul));
    car.set("halfWid", Value::Num(c.halfWid * fpMul));
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
