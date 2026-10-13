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
// Two halves, each with an arm that fails if the catalogue stops reaching the
// case, so neither can pass vacuously:
//   - the contract: every point of every catalogue road is recovered from a
//     hint one frame of top speed behind it, including the outer-curb points
//     where the old step stalled;
//   - the outcome: a hands-off car on the two hairpin tracks never freezes
//     while it is moving, and does reach a hairpin's outer curb.

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
// Recovered to well inside a centimetre: a missed foot is off by a frame's
// travel (decimetres), so this cannot mistake one for float noise.
const double FOOT_TOL = 1e-4;

// Signed plan curvature at s, positive when +lat is the OUTSIDE of the bend:
// ground metres per metre of arc at offset lat are then 1 + lat*k.
double curvature(Centerline& cl, double s) {
  const double h = 0.05;
  Frame a = cl.sampleAt(s - h), b = cl.sampleAt(s + h);
  return b.lateral.clone().sub(a.lateral).dot(a.tangent) / (2 * h);
}

Game makeGame(BuiltRaceTrack& bt) {
  return Game(std::vector<PlayerDesc>{PlayerDesc{Id::Num(0), false, Stats{}}}, bt.game);
}

}  // namespace

int main() {
  // The contract, on every catalogue road out to its edges.
  {
    long points = 0, outside = 0, missed = 0;
    double worst = 0;
    std::string worstAt;
    for (int i = 0; i < TTP_TRACK_COUNT; i++) {
      BuiltRaceTrack bt;
      std::string err;
      if (!build_race_track_by_id(TTP_TRACKS[i].id, 1, 1u, bt, err)) {
        check(false, std::string("build ") + TTP_TRACKS[i].id + ": " + err);
        continue;
      }
      Game game = makeGame(bt);
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
          points++;
          if (lat * k >= HAIRPIN_OUTSIDE) outside++;
          if (dev > FOOT_TOL) missed++;
          if (dev > worst) {
            worst = dev;
            char buf[96];
            std::snprintf(buf, sizeof buf, "%s s=%.2f lat=%+.2f lat*k=%+.2f", TTP_TRACKS[i].id, s, lat, lat * k);
            worstAt = buf;
          }
        }
      }
    }
    std::printf("projection: %ld points, %ld on a hairpin's outside, worst %.1e m at %s\n", points, outside, worst,
                worstAt.c_str());
    check(outside > 0, "the catalogue still has a hairpin outside to test (lat*k >= 0.9)");
    check(missed == 0, "every road point is recovered from a hint a frame behind it (" + std::to_string(missed) +
                           " missed, worst at " + worstAt + ")");
  }

  // The outcome: hands off, the car runs into the hairpins' outer curbs.
  for (const char* id : {"cloverleaf", "sidewinder"}) {
    BuiltRaceTrack bt;
    std::string err;
    if (!build_race_track_by_id(id, 1, 1u, bt, err)) {
      check(false, std::string("build ") + id + ": " + err);
      continue;
    }
    Game game = makeGame(bt);
    Car& car = *game.cars()[0];
    long frozen = 0, outside = 0;
    for (int f = 0; f < 60 * 60 && !game.raceOver(); f++) {
      const double s0 = car.totalS;
      game.update(DT);
      if (car.v < 2 || car.spinT > 0) continue;
      if (car.totalS == s0) frozen++;
      if (car.onWall && car.lat * curvature(*game.centerline(), car.totalS) >= HAIRPIN_OUTSIDE) outside++;
    }
    check(outside > 0, std::string(id) + ": the hands-off car reaches a hairpin's outer curb");
    check(frozen == 0, std::string(id) + ": the car never freezes while moving (" + std::to_string(frozen) +
                           " frozen frames)");
  }

  std::printf("curb hang check: %d assertions, %d failures\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
