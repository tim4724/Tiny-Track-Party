#include "ttp/ai_driver.h"

#include <cmath>
#include <limits>
#include <memory>
#include <utility>

#include "ttp/dmath.h"
#include "ttp/game.h"
#include "ttp/jsmath.h"

namespace ttp {

static const double INF = std::numeric_limits<double>::infinity();

// clamp = Math.max(lo, Math.min(hi, x)) — js_min/js_max so ±0 matches (fp §3.4).
static inline double clampd(double x, double lo, double hi) { return js_max(lo, js_min(hi, x)); }

// ---- constants (AiDriver.js) ------------------------------------------------
static const int AI_HOLD_MIN = 90;
static const int AI_HOLD_SPAN = 150;
static const int AI_HOLD_MAX = 480;
static const double BANANA_DROP_FAR = 14;
static const double ROCKET_FIRE_RANGE = 80;
static const double STEER_WANDER = 0.12;
static const double WEAVE_EASE = 0.045;
static const int WEAVE_HOLD_MIN = 35, WEAVE_HOLD_SPAN = 55;
static const double WANDER_FADE = 0.5;
static const double WANDER_CURB = 1.3;
static const double EVADE_NEAR = -1.5;
static const double EVADE_FAR = 13.0;
static const double EVADE_CLEAR = 0.5;
static const double EVADE_LOOK = 3.5;
static const double BANANA_AVOID_R = 0.5;

static const double RL_STEP = 1.25;
static const int RL_ITERS = 800;
static const double RL_LAT_MARGIN = 0.3;
static const double RL_EDGE = 0.5;
static const double RL_FALLBACK_HALF = 1.5;
static const double RL_MIN_ROOM = 0.45;
static const double RL_CORNER_K = 0.02;
static const double RL_PAYOFF = 0.95;
static const double FAN_MIN_ROOM = 0.7;

static const double TURN_RATE_FALLBACK = 1.16;
static const double BRAKE_LOOK_NEAR = 1.5;
static const double BRAKE_LOOK_FAR = 22.0;
static const double BRAKE_LOOK_STEP = 1.0;
static const double CORNER_MARGIN = 1.25;
static const double BRAKE_DECEL_REF = 5.8;

// Seven so a FIELD_SIZE-8 single-player race fills without a repeated name.
// The first four are the originals and stay first: cpuSeats deals personas in
// order, so short fields keep the exact roster they always had. New entries
// stay inside the proven caution band [0.94, 1.05] (the ladder below it was
// removed on purpose) and avoid the CAR names (Dash/Bolt/Carve/Rumble aside —
// Bolt's double duty predates this table).
const Persona AI_PERSONALITIES[7] = {
    {"Bolt", 1.05, -0.6}, {"Pixel", 1.00, 0.6}, {"Rusty", 0.97, -0.25}, {"Zippy", 0.94, 0.25},
    {"Turbo", 1.02, 0.4}, {"Gizmo", 0.99, -0.4}, {"Scoot", 0.96, 0.1}};

// ---- RacingLine --------------------------------------------------------------
RacingLine::RacingLine(Centerline& centerline) {
  double L = centerline.length();
  int n = (int)js_max(16.0, js_round(L / RL_STEP));
  double h = L / n;
  std::vector<Frame> frames;
  frames.reserve(n);
  for (int i = 0; i < n; i++) frames.push_back(centerline.sampleAt(i * h));

  std::vector<double> kappa(n);
  for (int i = 0; i < n; i++) {
    const Vec3& a = frames[(i - 1 + n) % n].tangent;
    const Vec3& b = frames[(i + 1) % n].tangent;
    double cross = a.clone().cross(b).dot(frames[i].up);
    double dot = clampd(a.dot(b), -1, 1);
    kappa[i] = dmath::atan2(cross, dot) / (2 * h);
  }

  auto boundFor = [&](double kAbs, int i) -> double {
    const Frame& f = frames[i];
    double half = (!std::isnan(f.width)) ? f.width / 2 : RL_FALLBACK_HALF;
    double cut = js_min(1.1, kAbs * LOOKAHEAD * LOOKAHEAD / 8);
    double b = half - RL_LAT_MARGIN - RL_EDGE - cut;
    return b < RL_MIN_ROOM ? 0 : b;
  };

  std::vector<double> e(n, 0.0);
  auto relax = [&](const std::vector<double>& bound, int iters) {
    for (int it = 0; it < iters; it++) {
      for (int i = 0; i < n; i++) {
        double want = (e[(i - 1 + n) % n] + e[(i + 1) % n]) / 2 - kappa[i] * h * h / 2;
        e[i] = clampd(want, -bound[i], bound[i]);
      }
    }
  };

  auto measure = [&]() -> std::vector<double> {
    std::vector<Vec3> pts(n);
    for (int i = 0; i < n; i++) pts[i] = frames[i].pos.clone().addScaledVector(frames[i].lateral, e[i]);
    std::vector<double> out(n);
    for (int i = 0; i < n; i++) {
      Vec3 v1 = pts[i].clone().sub(pts[(i - 1 + n) % n]);
      Vec3 v2 = pts[(i + 1) % n].clone().sub(pts[i]);
      double l1 = v1.length(), l2 = v2.length();
      if (l1 < 1e-6 || l2 < 1e-6) { out[i] = 0; continue; }
      double dot = v1.dot(v2);                  // before cross() — cross MUTATES v1
      double cross = v1.cross(v2).dot(frames[i].up);
      out[i] = std::fabs(dmath::atan2(cross / (l1 * l2), clampd(dot / (l1 * l2), -1, 1))) / ((l1 + l2) / 2);
    }
    return out;
  };

  std::vector<double> bound(n);
  for (int i = 0; i < n; i++) bound[i] = boundFor(std::fabs(kappa[i]), i);
  relax(bound, RL_ITERS);
  std::vector<double> kLine = measure();

  int PAD = (int)js_max(2.0, js_round(4 / h));
  int i0 = 0;
  while (i0 < n && std::fabs(kappa[i0]) > RL_CORNER_K) i0++;
  if (i0 < n) {
    for (int i = i0; i < i0 + n; i++) {
      if (std::fabs(kappa[i % n]) <= RL_CORNER_K) continue;
      int j = i;
      while (j + 1 < i0 + n && std::fabs(kappa[(j + 1) % n]) > RL_CORNER_K) j++;
      double kcMax = 0, klMax = 0;
      for (int m = i - PAD; m <= j + PAD; m++) {
        kcMax = js_max(kcMax, std::fabs(kappa[((m % n) + n) % n]));
        klMax = js_max(klMax, kLine[((m % n) + n) % n]);
      }
      if (klMax > kcMax * RL_PAYOFF) {
        for (int m = i - PAD; m <= j + PAD; m++) bound[((m % n) + n) % n] = 0;
      }
      i = j;
    }
  }
  for (int i = 0; i < n; i++) {
    if (bound[i] > 0) bound[i] = boundFor(js_max(std::fabs(kappa[i]), kLine[i]), i);
    e[i] = clampd(e[i], -bound[i], bound[i]);
  }
  relax(bound, RL_ITERS / 2);
  kLine = measure();

  std::vector<double> k(n);
  for (int i = 0; i < n; i++) k[i] = (kLine[(i - 1 + n) % n] + 2 * kLine[i] + kLine[(i + 1) % n]) / 4;
  length_ = L; n_ = n; h_ = h;
  e_ = std::move(e); k_ = std::move(k); bound_ = std::move(bound);
}

double RacingLine::at(const std::vector<double>& arr, double s) const {
  double L = length_;
  s = std::fmod(std::fmod(s, L) + L, L);
  double x = s / h_;
  int i = (int)std::floor(x) % n_;
  double f = x - std::floor(x);
  return arr[i] * (1 - f) + arr[(i + 1) % n_] * f;
}

// ---- race-context reads ------------------------------------------------------
static double nearestBehind(const Car& car, Game& game) {
  double L = game.length();
  double best = INF;
  for (const auto& o : game.cars()) {
    if (o->id == car.id || o->finished) continue;
    double ds = wrap_delta(car.totalS - o->totalS, L);
    if (ds > 0 && ds < best) best = ds;
  }
  return best;
}

// gap to the car physically ahead; returns false when nothing is ahead (whiff).
static bool gapToCarAhead(Car& car, Game& game, double& out) {
  Car* o = game.nextCarAhead(car);
  if (!o) return false;
  out = wrap_s(o->totalS - car.totalS, game.length());
  return true;
}

// ---- pursue / cornerBrake ----------------------------------------------------
double pursue(const Car& car, Centerline& centerline, double lookahead, double gain, double laneBias) {
  Frame f = centerline.sampleAt(car.totalS + lookahead);
  Vec3 tgt = f.pos.clone().addScaledVector(f.lateral, laneBias);
  const Vec3& up = car.pose.up;
  const Vec3& fwd = car.pose.forward;
  tgt.sub(car.pose.pos);                 // to = tgt (mutated in place)
  tgt.addScaledVector(up, -tgt.dot(up)); // flatten onto the road plane
  if (tgt.lengthSq() < 1e-6) return 0;
  tgt.normalize();
  double cross = fwd.clone().cross(tgt).dot(up);
  double dot = clampd(fwd.dot(tgt), -1, 1);
  double err = dmath::atan2(cross, dot);
  return clampd(-err * gain, -1, 1);
}

static double curvatureAt(Centerline& centerline, double s, double step) {
  Frame a = centerline.sampleAt(s), b = centerline.sampleAt(s + step);
  double cross = a.tangent.clone().cross(b.tangent).dot(b.up);
  double dot = a.tangent.dot(b.tangent);
  return std::fabs(dmath::atan2(cross, dot)) / step;
}

double cornerBrake(const Car& car, Centerline& centerline, double turn, double caution, const RacingLine* line) {
  double yaw = turn != 0 ? turn : (car.turn != 0 ? car.turn : TURN_RATE_FALLBACK);
  double margin = CORNER_MARGIN * caution * clampd(yaw / TURN_RATE_FALLBACK, 0.88, 1.0);
  double v = car.v;
  double brake = 0;
  for (double d = BRAKE_LOOK_NEAR; d <= BRAKE_LOOK_FAR; d += BRAKE_LOOK_STEP) {
    double k = line ? line->curvAt(car.totalS + d) : curvatureAt(centerline, car.totalS + d, 0.6);
    if (k <= 1e-3) continue;
    double vSafe = (margin * yaw) / k;
    if (v <= vSafe) continue;
    double need = (v * v - vSafe * vSafe) / (2 * d);
    brake = js_max(brake, need / BRAKE_DECEL_REF);
  }
  return clampd(brake, 0, 1);
}

// ---- avoidThreat -------------------------------------------------------------
namespace {
struct Dodge { bool has = false; double lane = 0; };
struct Best { bool has = false; double lat = 0, r = 0; };
}  // namespace

template <class LaneFor>
static Dodge avoidThreat(const Car& car, LaneFor laneFor, Game& game, double maxLat,
                         bool prevSet, double prevLane) {
  double L = game.length();
  double lane = prevSet ? prevLane : laneFor(car.totalS);
  Best best;
  double bestDs = INF;
  auto consider = [&](double hs, double hlat, double radius) {
    double ds = wrap_delta(hs - car.totalS, L);
    if (ds < EVADE_NEAR || ds > EVADE_FAR) return;
    if (std::fabs(laneFor(hs) - hlat) > radius + EVADE_CLEAR) return;
    if (ds < bestDs) { bestDs = ds; best.has = true; best.lat = hlat; best.r = radius; }
  };
  for (const auto& h : game.hazards()) consider(h.s, h.lat, h.radius);
  for (const auto& p : game.poles()) consider(p.s, p.lat, p.radius);
  for (const auto& b : game.bananas())
    if (b.owner != car.id || game.elapsed() >= b.armAt) consider(b.s, b.lat, BANANA_AVOID_R);
  if (!best.has) return {};
  double m = js_max(0.1, maxLat - 0.1);
  double off = best.r + EVADE_CLEAR;
  double left = best.lat - off, right = best.lat + off;
  bool okL = left >= -m, okR = right <= m;
  if (okL && okR) {
    double clearL = m - std::fabs(left), clearR = m - std::fabs(right);
    if (std::fabs(clearL - clearR) < 0.05)
      return {true, std::fabs(left - lane) <= std::fabs(right - lane) ? left : right};
    return {true, clearL > clearR ? left : right};
  }
  if (okL) return {true, left};
  if (okR) return {true, right};
  return {true, best.lat >= 0 ? -m : m};
}

// ---- AiController ------------------------------------------------------------
AiController::AiController(double caution, double lookahead, double gain, double laneBias, uint32_t seed)
    : caution_(clampd(caution, 0.5, 1.1)),
      lookahead_(lookahead),
      gain_(gain),
      laneBias_(laneBias),
      rng_(seed ? seed : 1u) {}

Input AiController::drive(Car& car, Centerline& centerline, Game& game) {
  if (--weaveT_ <= 0) {
    weaveTarget_ = (rng_.next() * 2 - 1);
    weaveT_ = WEAVE_HOLD_MIN + (int)std::floor(rng_.next() * WEAVE_HOLD_SPAN);
  }
  weave_ += (weaveTarget_ - weave_) * WEAVE_EASE;

  double maxLat = game.maxLat();
  RacingLine& line = game.racingLine();
  auto laneFor = [&](double sAbs) -> double {
    double e = line.laneAt(sAbs);
    double room = line.roomAt(sAbs);
    double fade = room > 0.05 ? clampd(1 - std::fabs(e) / room, 0, 1) : 1;
    double lim = js_min(js_max(room, FAN_MIN_ROOM), maxLat - 0.1);
    return clampd(e + laneBias_ * fade, -lim, lim);
  };
  double lane = laneFor(car.totalS + lookahead_);
  double look = lookahead_;
  Dodge dodge = avoidThreat(car, laneFor, game, maxLat, dodgeSet_, dodgeLane_);
  dodgeSet_ = dodge.has; dodgeLane_ = dodge.lane;
  if (dodge.has) { lane = dodge.lane; look = EVADE_LOOK; }

  double s = pursue(car, centerline, look, gain_, lane);
  if (!dodge.has) {
    double room = clampd(1 - std::fabs(s) / WANDER_FADE, 0, 1);
    double curbRoom = clampd((maxLat - std::fabs(car.lat)) / WANDER_CURB, 0, 1);
    s = clampd(s + weave_ * STEER_WANDER * room * curbRoom, -1, 1);
  }
  double corner = cornerBrake(car, centerline, 0, caution_, &line);

  const std::string& item = car.item;  // "" == null
  if (!item.empty() && item == lastItem_) {
    heldFrames_++;
  } else {
    lastItem_ = item;  // item || null → "" for null
    heldFrames_ = 0;
    holdMin_ = !item.empty() ? AI_HOLD_MIN + (int)std::floor(rng_.next() * AI_HOLD_SPAN) : 0;
  }
  if (!item.empty() && heldFrames_ >= holdMin_ && wantsToUse(item, car, game, corner)) {
    useSeq_ = (useSeq_ + 1) & 255;
  }
  Input out;
  out.hasS = true; out.s = s;
  out.hasB = true; out.b = corner;
  out.hasU = true; out.u = useSeq_;
  return out;
}

bool AiController::wantsToUse(const std::string& item, Car& car, Game& game, double corner) {
  bool overdue = heldFrames_ >= AI_HOLD_MAX;
  if (item == "boost") return corner < 0.05 || (overdue && corner < 0.2);
  if (item == "banana") { double d = nearestBehind(car, game); return (d > 0 && d <= BANANA_DROP_FAR) || overdue; }
  if (item == "rocket") { double d; return gapToCarAhead(car, game, d) && d <= ROCKET_FIRE_RANGE; }
  return true;
}

}  // namespace ttp
