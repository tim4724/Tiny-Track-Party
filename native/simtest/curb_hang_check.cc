// Curb-hang check — a car keeps moving on a tight bend's outer curb.
//
// Each frame Game::update moves the car in the world and projects the point
// back onto the centreline (Centerline::projectNear). A projection that steps
// as if the point sat ON the centreline overshoots off a bend's outside by
// lat*k, and at lat*k = 1 — the outer curb of a hairpin — it returns its own
// hint: the frame's motion is thrown away and the car hangs on the curb. Every
// golden trace recorded that hang without anyone seeing it, because a corpus
// pins what the sim does, not whether it is right. So this asserts the outcome
// rather than replaying one.
//
// The catalogue no longer has a corner that tight (scripts/track-gen.mjs rounds
// them, and `track_fold` holds it), so the hazard is BUILT here: a stadium loop
// whose two hairpins are tighter than the curb's reach, the geometry that froze
// cars. Two halves, each with an arm that fails if it stops reaching the case:
//   - the contract: every point of that loop and of every catalogue road is
//     recovered from a hint one frame of top speed behind it, including the
//     outer-curb points where the old step stalled;
//   - the outcome: a hands-off car on the loop never freezes while it is
//     moving, and does reach a hairpin's outer curb.

#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

#include "ttp/game.h"
#include "ttp/race_track.h"

using namespace ttp;

namespace {

int failures = 0;
int checks = 0;

void check(bool ok, const std::string& what) {
  checks++;
  if (!ok) {
    failures++;
    std::fprintf(stderr, "FAIL %s\n", what.c_str());
  }
}

const double DT = 1000.0 / 60.0;
// Where the old step stalled (its error factor is -lat*k), with margin.
const double HAIRPIN_OUTSIDE = 0.9;
// The contract's grid: along the road (m), and how many of those steps either
// side a projection can search (a frame of top speed plus Game::update's 0.5).
const double STEP = 0.25;
const int WINDOW = 4;
// Recovered to a centimetre: a missed foot is off by a frame's travel
// (decimetres). Tighter would judge convergence, not misses — the stadium's
// straight-to-arc joints are a curvature STEP no spline has, and the foot just
// inside one converges to millimetres.
const double FOOT_TOL = 1e-2;
// The stadium: two straights joined by two left-hand half circles of radius
// HAIRPIN_R on a ROAD_W road, so the outer curb sits past lat*k = 1.
const double STRAIGHT = 30, HAIRPIN_R = 2.1, ROAD_W = 5;

// Signed plan curvature at s, positive when +lat is the OUTSIDE of the bend:
// ground metres per metre of arc at offset lat are then 1 + lat*k.
double curvature(Centerline& cl, double s) {
  const double h = 0.05;
  Frame a = cl.sampleAt(s - h), b = cl.sampleAt(s + h);
  return b.lateral.clone().sub(a.lateral).dot(a.tangent) / (2 * h);
}

Game makeGame(const GameTrack& track) {
  return Game(std::vector<PlayerDesc>{PlayerDesc{Id::Num(0), false, Stats{}}}, track);
}

Centerline stadium() {
  const double PI = 3.141592653589793, arc = PI * HAIRPIN_R, L = 2 * STRAIGHT + 2 * arc;
  std::vector<Sample> samples;
  for (double s = 0; s < L - 1e-9; s += STEP) {
    Vec3 pos, tan;
    if (s < STRAIGHT) {
      pos = Vec3(s, 0, 0); tan = Vec3(1, 0, 0);
    } else if (s < STRAIGHT + arc) {
      const double a = (s - STRAIGHT) / HAIRPIN_R;
      pos = Vec3(STRAIGHT + HAIRPIN_R * std::sin(a), 0, HAIRPIN_R - HAIRPIN_R * std::cos(a));
      tan = Vec3(std::cos(a), 0, std::sin(a));
    } else if (s < 2 * STRAIGHT + arc) {
      pos = Vec3(STRAIGHT - (s - STRAIGHT - arc), 0, 2 * HAIRPIN_R); tan = Vec3(-1, 0, 0);
    } else {
      const double a = (s - 2 * STRAIGHT - arc) / HAIRPIN_R;
      pos = Vec3(-HAIRPIN_R * std::sin(a), 0, HAIRPIN_R + HAIRPIN_R * std::cos(a));
      tan = Vec3(-std::cos(a), 0, -std::sin(a));
    }
    Sample sm;
    sm.pos = pos; sm.tangent = tan; sm.up = Vec3(0, 1, 0);
    sm.lateral = tan.clone().cross(sm.up);
    sm.width = ROAD_W; sm.s = s;
    samples.push_back(sm);
  }
  return Centerline(std::move(samples), L);
}

GameTrack stadiumTrack(Centerline& cl) {
  GameTrack t{};
  t.centerline = &cl; t.length = cl.length(); t.totalLaps = 3; t.roadWidth = ROAD_W; t.seed = 1u;
  return t;
}

// The contract over one road: every point of it out to the edges, from a hint
// one frame of top speed behind.
struct Projected { long points = 0, outside = 0, missed = 0; double worst = 0; std::string worstAt; };

void projectRoad(const char* name, const GameTrack& track, Projected& out) {
  Game game = makeGame(track);
  Centerline& cl = *game.centerline();
  Car& car = *game.cars()[0];
  const double perFrame = car.vmax * DT / 1000;  // one frame of top speed, in ground metres
  std::vector<double> ks;
  for (double s = 0; s < game.length(); s += STEP) ks.push_back(curvature(cl, s));
  const int n = (int)ks.size();
  for (int j = 0; j < n; j++) {
    const double s = j * STEP;
    const Frame f = cl.sampleAt(s);
    const double k = ks[j];
    double kLo = k, kHi = k;
    for (int w = -WINDOW; w <= WINDOW; w++) {
      const double kw = ks[((j + w) % n + n) % n];
      kLo = std::fmin(kLo, kw);
      kHi = std::fmax(kHi, kw);
    }
    for (double u = -1; u <= 1.0001; u += 0.125) {
      const double lat = u * f.width / 2;
      const double ribbon = 1 + lat * k;
      // Deep on a bend's inside one frame's travel is many metres of arc, and
      // where the ribbon folds anywhere near, past a centre of curvature, the
      // foot is not unique at all. Not the case under test, and the
      // integration's window is not built for it.
      if (std::fmin(1 + lat * kLo, 1 + lat * kHi) < 0.3) continue;
      const Vec3 p = f.pos.clone().addScaledVector(f.lateral, lat);
      ProjectResult r = cl.projectNear(p, s - perFrame / ribbon, perFrame + 0.5);
      const double dev = std::fmax(std::fabs(r.s - s), std::fabs(r.lat - lat));
      out.points++;
      if (lat * k >= HAIRPIN_OUTSIDE) out.outside++;
      if (dev > FOOT_TOL) out.missed++;
      if (dev > out.worst) {
        out.worst = dev;
        char buf[96];
        std::snprintf(buf, sizeof buf, "%s s=%.2f lat=%+.2f lat*k=%+.2f", name, s, lat, lat * k);
        out.worstAt = buf;
      }
    }
  }
}

}  // namespace

int main() {
  Centerline loop = stadium();
  const GameTrack loopTrack = stadiumTrack(loop);

  // The contract, on the stadium and on every catalogue road.
  {
    Projected loopP, p;
    projectRoad("stadium", loopTrack, loopP);
    for (int i = 0; i < TTP_TRACK_COUNT; i++) {
      BuiltRaceTrack bt;
      std::string err;
      if (!build_race_track_by_id(TTP_TRACKS[i].id, 1, 1u, bt, err)) {
        check(false, std::string("build ") + TTP_TRACKS[i].id + ": " + err);
        continue;
      }
      projectRoad(TTP_TRACKS[i].id, bt.game, p);
    }
    for (const Projected* r : {&loopP, &p}) {
      std::printf("projection, %s: %ld points, %ld on a hairpin's outside, worst %.1e m at %s\n",
                  r == &loopP ? "stadium" : "catalogue", r->points, r->outside, r->worst, r->worstAt.c_str());
      check(r->missed == 0, "every road point is recovered from a hint a frame behind it (" +
                                std::to_string(r->missed) + " missed, worst at " + r->worstAt + ")");
    }
    check(loopP.outside > 0, "the stadium has a hairpin outside to test (lat*k >= 0.9)");
  }

  // The outcome: hands off, the car runs into the hairpins' outer curbs.
  {
    Game game = makeGame(loopTrack);
    Car& car = *game.cars()[0];
    long frozen = 0, outside = 0;
    for (int f = 0; f < 60 * 60 && !game.raceOver(); f++) {
      const double s0 = car.totalS;
      game.update(DT);
      if (car.v < 2 || car.spinT > 0) continue;
      if (car.totalS == s0) frozen++;
      if (car.onWall && car.lat * curvature(*game.centerline(), car.totalS) >= HAIRPIN_OUTSIDE) outside++;
    }
    check(outside > 0, "the hands-off car reaches a hairpin's outer curb");
    check(frozen == 0, "the car never freezes while moving (" + std::to_string(frozen) + " frozen frames)");
  }

  std::printf("curb hang check: %d assertions, %d failures\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
