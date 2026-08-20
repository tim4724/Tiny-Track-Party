// Car-to-car contact check — the behaviour the golden traces pin but cannot
// JUDGE. A trace proves the sim still does what it did; it says nothing about
// whether what it does is right, and two contact defects lived under a fully
// green corpus for the whole life of the port:
//
//   CLIPPING. The collider used to test (s, lat) as though it were a Cartesian
//   plane. It is not, and on a corner it is wrong three ways at once — see the
//   collision frame in game.cc. Cars drew through each other in bends.
//
//   BOUNCE. Contact resolved as a one-shot impulse with restitution and nothing
//   held it, so a pair in steady contact still traded velocity jolts.
//
// Neither is conformance evidence: no JS twin survives to record an oracle
// from, so these are the invariants the code claims, written as assertions.
//
// THE ORACLE IS INDEPENDENT ON PURPOSE. Every geometric assertion below is
// judged by overlapping the rectangles the RENDERER draws, built from Car::pose
// — which recomputePoses derives by its own route, seating the body on the deck
// — and never by asking the collider what it thinks. A gate that consults the
// code under test cannot catch the code under test being wrong about geometry.

#include <algorithm>
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

// How deeply two cars overlap AS DRAWN, in world metres; zero when clear. The
// rectangles are compared in a's ground plane, which is exact while the pair is
// on the same piece of road and meaningless when it is not — hence sameDeck.
// FULL half-extents: COLLIDE_SHRINK is the collider's tolerance, not the body.
double drawnOverlap(const Game& g, const Car& a, const Car& b) {
  const Vec3 fa = a.pose.forward, ra = a.pose.forward.clone().cross(a.pose.up);
  const Vec3 fb = b.pose.forward, rb = b.pose.forward.clone().cross(b.pose.up);
  const double ma = g.footprintMul(a), mb = g.footprintMul(b);
  const double hla = a.halfLen * ma, hwa = a.halfWid * ma;
  const double hlb = b.halfLen * mb, hwb = b.halfWid * mb;
  const Vec3 d = b.pose.pos.clone().sub(a.pose.pos);
  const Vec3 axes[4] = {fa, ra, fb, rb};
  double pen = 1e9;
  for (const Vec3& x : axes) {
    const double ea = hla * std::fabs(fa.dot(x)) + hwa * std::fabs(ra.dot(x));
    const double eb = hlb * std::fabs(fb.dot(x)) + hwb * std::fabs(rb.dot(x));
    const double sep = std::fabs(d.dot(x)) - (ea + eb);
    if (sep >= 0) return 0.0;              // a separating axis: they are clear
    if (-sep < pen) pen = -sep;
  }
  return pen;
}

// Overpasses stack strands within a couple of metres horizontally; two cars on
// different decks are not in contact however their footprints project.
bool sameDeck(const Car& a, const Car& b) {
  const Vec3 d = b.pose.pos.clone().sub(a.pose.pos);
  return std::fabs(d.dot(a.pose.up)) < 0.5 && d.length() < 3.0;
}

std::vector<PlayerDesc> field(int n) {
  std::vector<PlayerDesc> v;
  for (int i = 0; i < n; i++) v.push_back(PlayerDesc{Id::Num(i), false, Stats{}});
  return v;
}

BuiltRaceTrack track(const char* id) {
  BuiltRaceTrack bt;
  std::string err;
  if (!build_race_track_by_id(id, 3, 42u, bt, err)) {
    std::fprintf(stderr, "FAIL build %s: %s\n", id, err.c_str());
    std::exit(2);
  }
  return bt;
}

// Where a track turns hardest in the road plane — the geometry that breaks a
// flat-(s, lat) collider, so the place to point a sweep at.
double tightestS(Centerline* cl, double length) {
  double best = 0, bestS = 0;
  for (double s = 0; s < length; s += 0.5) {
    Frame f = cl->sampleAt(s), f2 = cl->sampleAt(s + 0.6);
    const double k = std::fabs(-(f2.lateral.clone().sub(f.lateral).dot(f.tangent)) / 0.6);
    if (f.up.y > 0.9 && k > best) { best = k; bestS = s; }
  }
  return bestS;
}

double pct(std::vector<double>& v, double f) {
  if (v.empty()) return 0.0;
  std::sort(v.begin(), v.end());
  return v[std::min(v.size() - 1, (size_t)(f * v.size()))];
}

}  // namespace

int main() {
  // ---- 1. clipping, in a live race ------------------------------------------
  //
  // Eight cars — the shipped FIELD_SIZE, and the packing that makes scrums — on
  // the tracks whose corners are tightest, because the defect scaled with
  // curvature and a gentle track would not have shown it.
  //
  // Judged on the DISTRIBUTION, not on the worst frame. A race is chaotic:
  // any change to contact reshuffles the whole field, so the single deepest
  // event moves around and a max-based gate would be noise. The percentile over
  // ~100k contacts is stable, and it is also the honest question — one frame of
  // deep overlap in a pile-up is a solver that ran out of passes, while a fat
  // tail is a collider that cannot see.
  {
    const char* const TRACKS[] = {"cloverleaf", "sidewinder", "pretzel", "crag",
                                  "tangle",     "avalanche",  "helix",   "tidepool"};
    std::vector<double> pens;
    long deep = 0;
    for (const char* id : TRACKS) {
      BuiltRaceTrack bt = track(id);
      Game game(field(8), bt.game, [](const Event&) {});
      for (int f = 0; f < 1800; f++) {
        game.update(DT);
        const auto& cars = game.cars();
        for (size_t i = 0; i < cars.size(); i++)
          for (size_t j = i + 1; j < cars.size(); j++) {
            const Car &a = *cars[i], &b = *cars[j];
            if (!sameDeck(a, b)) continue;
            const double pen = drawnOverlap(game, a, b);
            if (pen <= 0.001) continue;
            pens.push_back(pen);
            if (pen > 0.10) deep++;
          }
      }
    }
    const double p99 = pct(pens, 0.99);
    const double frac = pens.empty() ? 0 : (double)deep / (double)pens.size();
    // A car is 0.88 x 0.53. Cars in traffic REST in contact — that is what a
    // collider with a 2% tolerance and a 1 cm slop is supposed to do, so the
    // count of contacts is not the measure and the median sits at the slop.
    // The tail is the measure. Before the world-space collision frame the p99
    // was 0.115 and 0.8% of contacts were deeper than 10 cm.
    check(p99 < 0.05, "99th percentile overlap AS DRAWN is under 5 cm (" + std::to_string(p99) + ")");
    check(frac < 0.001, "under 0.1% of contacts are deeper than 10 cm ("
                            + std::to_string(100 * frac) + "%)");
    std::printf("  race: %zu contacts, p99 %.4f m, %ld deeper than 10 cm\n",
                pens.size(), p99, deep);
  }

  // ---- 2. clipping, statically -----------------------------------------------
  //
  // The race metric cannot separate "the collider did not see it" from "the
  // solver ran out of passes". This can: place two cars at a known
  // configuration in a track's tightest corner, step one infinitesimal frame,
  // and ask whether the collider MOVED them. Then compare that verdict against
  // the drawn geometry. No chaos, no accumulation — just agreement.
  //
  // Both directions are defects. A MISS is the clipping the players see. A
  // PHANTOM — the collider acting on a pair that is visibly clear — is an
  // invisible bump, and it is the failure mode that killed the obvious fix:
  // correcting the (s, lat) metric alone, without the frame rotation and the
  // sagitta that go with it, reached a HALF A CAR past touching.
  {
    const char* const TRACKS[] = {"cloverleaf", "sidewinder", "crag"};
    long cases = 0, overlapping = 0, missed = 0, deepMissed = 0, phantom = 0;
    double worstMiss = 0;
    for (const char* id : TRACKS) {
      BuiltRaceTrack bt = track(id);
      const std::vector<PlayerDesc> pair = field(2);
      double s0;
      {
        Game probe(pair, bt.game, [](const Event&) {});
        s0 = tightestS(probe.centerline(), probe.length());
      }
      const auto place = [&](Game& g, double lat, double dl, double ds, double ha, double hb) {
        Car& a = *g.cars()[0];
        Car& b = *g.cars()[1];
        a.totalS = s0;      a.lat = lat;      a.heading = ha; a.v = 0; a.vlat = 0;
        b.totalS = s0 + ds; b.lat = lat + dl; b.heading = hb; b.v = 0; b.vlat = 0;
      };
      for (double ds = -1.4; ds <= 1.4001; ds += 0.1)
        for (double dl = -0.9; dl <= 0.9001; dl += 0.15)
          for (double lat = -0.6; lat <= 0.6001; lat += 0.6)
            for (double ha = -0.5; ha <= 0.5001; ha += 0.5)
              for (double hb = -0.5; hb <= 0.5001; hb += 0.5) {
                cases++;
                // The pair must not collide while its own geometry is measured,
                // or the poses would come back already separated. Marking one
                // car finished does exactly that — a finished car is a ghost to
                // the racing pack — while leaving every other step identical.
                double truth;
                {
                  Game m(pair, bt.game, [](const Event&) {});
                  place(m, lat, dl, ds, ha, hb);
                  m.cars()[1]->finished = true;
                  m.update(1e-6);
                  truth = drawnOverlap(m, *m.cars()[0], *m.cars()[1]);
                }
                Game g(pair, bt.game, [](const Event&) {});
                place(g, lat, dl, ds, ha, hb);
                Car& a = *g.cars()[0];
                Car& b = *g.cars()[1];
                const double as = a.totalS, al = a.lat, bs = b.totalS, bl = b.lat;
                g.update(1e-6);
                const bool acted = std::fabs(a.totalS - as) > 1e-7 || std::fabs(a.lat - al) > 1e-7
                                   || std::fabs(b.totalS - bs) > 1e-7 || std::fabs(b.lat - bl) > 1e-7;
                if (truth > 0.02) {
                  overlapping++;
                  if (!acted) {
                    missed++;
                    if (truth > 0.08) deepMissed++;
                    if (truth > worstMiss) worstMiss = truth;
                  }
                }
                if (truth <= 0.0 && acted) phantom++;
              }
    }
    // The residual misses are shallow BY CONSTRUCTION: the collider's rectangle
    // is COLLIDE_SHRINK smaller than the body, so an overlap inside that
    // tolerance is a contact it is meant to ignore. Nothing DEEP may be missed,
    // and nothing clear may be touched. Before the world-space frame: 6182 deep
    // misses reaching 0.383 m.
    check(deepMissed == 0, "no overlap deeper than 8 cm goes undetected ("
                               + std::to_string(deepMissed) + " missed, worst "
                               + std::to_string(worstMiss) + " m)");
    check(worstMiss < 0.04, "the deepest missed overlap is inside the collider's own "
                            "tolerance (" + std::to_string(worstMiss) + " m)");
    check(phantom == 0, "the collider never acts on a pair that is visibly clear ("
                            + std::to_string(phantom) + " phantom contacts)");
    std::printf("  sweep: %ld cases, %ld overlapping, %ld missed (%ld deep, worst %.3f m), "
                "%ld phantom\n", cases, overlapping, missed, deepMissed, worstMiss, phantom);
  }

  // ---- 3. a rear-end must HOLD and CARRY, not jolt --------------------------
  //
  // A slow car with a fast one behind it, both driven by the engine's own
  // autopilot so they stay on the road for a long stretch of real track —
  // corners, braking and all — rather than ploughing into the first barrier.
  // (`finished` is what puts a car on the autopilot; finished cars still
  // collide with each other, which is exactly the pair needed here.)
  {
    BuiltRaceTrack bt = track("tidepool");
    Stats slow;  slow.vmax = 0.55;
    Stats quick; quick.vmax = 1.10;
    const std::vector<PlayerDesc> pair{PlayerDesc{Id::Num(0), true, slow},
                                       PlayerDesc{Id::Num(1), true, quick}};
    const int FRAMES = 900;
    const auto open = [&](Game& g, double behind) {
      Car& lead = *g.cars()[0];
      Car& push = *g.cars()[1];
      lead.finished = true; push.finished = true;
      lead.totalS = 30.0;          lead.lat = 0; lead.v = 6.0; lead.heading = 0;
      push.totalS = 30.0 - behind; push.lat = 0; push.v = 6.0; push.heading = 0;
    };

    // The control is the SAME race with the pusher put out of reach, so the
    // difference in how far the leader gets is the push and nothing else.
    double solo;
    {
      Game c(pair, bt.game, [](const Event&) {});
      open(c, 200.0);
      const double s0 = c.cars()[0]->totalS;
      for (int f = 0; f < FRAMES; f++) c.update(DT);
      solo = c.cars()[0]->totalS - s0;
    }

    Game game(pair, bt.game, [](const Event&) {});
    open(game, 1.2);
    Car& lead = *game.cars()[0];
    Car& push = *game.cars()[1];
    const double s0 = lead.totalS;
    int contact = 0, run = 0, longest = 0, breaks = 0;
    std::vector<double> dv;
    for (int f = 0; f < FRAMES; f++) {
      game.update(DT);
      const double gap = wrap_delta(lead.totalS - push.totalS, game.length())
                         - (lead.halfLen + push.halfLen);
      if (gap < 0.05) {
        contact++;
        run++;
        longest = std::max(longest, run);
        // Only in SETTLED contact, and not while a barrier is involved: a wall
        // legitimately stops one car and not the other.
        if (run > 2 && !lead.onWall && !push.onWall)
          dv.push_back(std::fabs(push.v * std::cos(push.heading)
                                 - lead.v * std::cos(lead.heading)));
      } else {
        if (run > 0) breaks++;
        run = 0;
      }
    }
    const double carried = lead.totalS - s0 - solo;
    const double worstDv = dv.empty() ? 0.0 : *std::max_element(dv.begin(), dv.end());

    check(longest > 600, "contact is HELD, not re-made: longest unbroken run "
                             + std::to_string(longest) + " of " + std::to_string(FRAMES));
    check(breaks <= 2, "the contact does not chatter (" + std::to_string(breaks) + " breaks)");
    // The bounce, stated: two cars in settled contact travel TOGETHER. The
    // one-shot-impulse collider held contact just as long but jolted to 2.49
    // m/s inside it, which is what read as bounciness rather than a shove.
    check(worstDv < 0.5, "no velocity jolt inside settled contact ("
                             + std::to_string(worstDv) + " m/s)");
    check(carried > 20.0, "the leader is CARRIED " + std::to_string(carried)
                              + " m further than it travels alone");
    std::printf("  rear-end: %d/%d contact, %d breaks, jolt %.3f m/s, carried +%.1f m\n",
                contact, FRAMES, breaks, worstDv, carried);
  }

  // ---- 4. a shove must not blunt the brakes ---------------------------------
  //
  // SHOVE_DECEL applies only off the brake. A driver who brakes the instant a
  // shove lands must still get the full BRAKE_DECEL, or contact would read as
  // a stuck throttle.
  {
    BuiltRaceTrack bt = track("tidepool");
    Game game(field(2), bt.game, [](const Event&) {});
    Car& a = *game.cars()[0];
    Car& b = *game.cars()[1];
    a.totalS = 30.0; a.lat = 0; a.v = 12.0; a.vlat = 0; a.heading = 0;
    b.totalS = -80.0;                       // far away: this is about one car
    a.shoveT = 1.0;                         // longer than any shove the sim grants
    Input brake;
    brake.hasB = true;
    brake.b = 1.0;
    game.processInput(a.id, brake);
    const double v0 = a.v;
    for (int f = 0; f < 12; f++) game.update(DT);
    const double lost = v0 - a.v;
    check(lost > 0.9, "a shoved car still brakes at the brake rate (lost only "
                          + std::to_string(lost) + " m/s under full brake in 0.2 s)");
  }

  std::printf("contact check: %d assertions, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
