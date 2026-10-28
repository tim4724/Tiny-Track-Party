// Hazard-response check — the two sim behaviours that NOTHING else in the tree
// reaches: Game::collidePole and Game::stageBanana.
//
// WHY THEY HAVE NO COVERAGE, AND WHY THAT IS NOT THE SAME PROBLEM TWICE:
//
//   collidePole is UNREACHABLE ON THE SHIPPED CATALOGUE. Every one of the 20
//   catalogue tracks builds with zero poles — verified against the JS TrackBuilder
//   too, so this is not a port gap: TrackBuilder auto-emits ghost poles only for
//   pillars/loop shafts standing inside a drivable corridor, and no shipped layout
//   puts one there (helix has 30 pillars and 2 loops and still emits none). The
//   collision code is live, 36 lines of it, and the moment a track does place a
//   post in the road — or the Gym becomes buildable natively — it is on the byte
//   path. Until then no fixture can exercise it, because fixtures race catalogue
//   tracks. So this check builds the situation directly: a real track with poles
//   spliced into its GameTrack.
//
//   stageBanana is a TRACE-STAGING HOOK with no caller in the engine. The REAL
//   banana gameplay path (useItem -> drop behind the car -> enterBanana -> spin) is
//   well covered by the golden traces. stageBanana exists so a trace header can
//   pre-place a hazard (replay_cli's `stage`, which the skysnake fixture uses for a
//   rocket and no fixture uses for a banana). One line of coverage, cheap to take.
//
// This is a BEHAVIOURAL gate, not conformance evidence. No JS twin survives to
// record an oracle from, so the assertions encode the invariants the code states:
// a pole never leaves a car overlapping it, it kills lateral velocity and a boost
// on a head-on hit, it keeps a minimum speed rather than stopping the car dead,
// and it leaves cars that never touch it completely alone.

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

// Distance from a car to a pole in the (arclength, lateral) plane the collision
// works in. Not a world distance: collidePole itself compares wrap_delta(s) and
// lat, so the assertions must speak the same coordinates.
double gapTo(const Car& c, const PoleRt& p, double length) {
  const double ds = wrap_delta(c.totalS - p.s, length);
  const double dl = c.lat - p.lat;
  return std::sqrt(ds * ds + dl * dl);
}

}  // namespace

int main() {
  // ---- collidePole -----------------------------------------------------------
  {
    BuiltRaceTrack bt;
    std::string err;
    if (!build_race_track_by_id("tidepool", 3, 42u, bt, err)) {
      std::fprintf(stderr, "FAIL build tidepool: %s\n", err.c_str());
      return 2;
    }
    check(bt.game.poles.empty(),
          "the premise still holds: a catalogue track carries no poles (if this "
          "fails, a real track grew one and the golden traces now cover this code)");

    // Two posts: one the car is driven into, one far away that must stay inert.
    const double POLE_S = 40.0, POLE_LAT = 0.0, POLE_R = 0.35;
    bt.game.poles.push_back(PoleRt{POLE_S, POLE_LAT, POLE_R});
    bt.game.poles.push_back(PoleRt{POLE_S + 120.0, 1.0, POLE_R});

    const std::vector<PlayerDesc> players{
        PlayerDesc{Id::Num(0), false, Stats{}},
        PlayerDesc{Id::Num(1), false, Stats{}},
    };
    Game game(players, bt.game, [](const Event&) {});

    Car& hit = *game.cars()[0];
    Car& clear = *game.cars()[1];

    // Park the second car nowhere near either post. "Untouched" cannot be asserted
    // as "unchanged", because a full update() steps the whole sim around it — so
    // the reference is a CONTROL Game on the same track with NO poles at all,
    // driven through the identical opening. Same state in, same state out.
    const auto place = [](Car& c, double s) {
      c.totalS = s; c.lat = 0.0; c.v = 4.0; c.vlat = 0.0; c.heading = 0.0;
    };
    place(clear, POLE_S + 60.0);

    double ctlS = 0, ctlLat = 0, ctlV = 0, ctlVlat = 0;
    bool ctlWall = true;
    {
      GameTrack bare = bt.game;
      bare.poles.clear();
      Game control(players, bare, [](const Event&) {});
      Car& cc = *control.cars()[1];
      place(cc, POLE_S + 60.0);
      Car& other = *control.cars()[0];
      place(other, POLE_S);
      control.update(DT);
      ctlS = cc.totalS; ctlLat = cc.lat; ctlV = cc.v; ctlVlat = cc.vlat; ctlWall = cc.onWall;
    }

    // Drive the first car into the post FRONT-ON: the pole sits just off the nose,
    // so the shallow branch produces a mostly-longitudinal normal (|nS| > 0.6) and
    // the boost-killing clause applies.
    hit.totalS = POLE_S - (hit.halfLen + POLE_R - 0.05);
    hit.lat = POLE_LAT;
    hit.heading = 0.0;
    hit.v = 8.0;
    hit.vlat = 0.0;
    hit.boostT = 2.0;
    hit.boostMul = 2.0;
    hit.onWall = false;

    game.update(DT);

    check(hit.onWall, "a pole hit sets onWall");
    check(hit.vlat == 0.0, "a pole hit zeroes lateral velocity");
    check(hit.boostMul == 1.0 && hit.boostT == 0.0,
          "a front-on pole hit kills an active boost");
    check(hit.v >= 0.3 * hit.vmax - 1e-9,
          "a pole hit keeps POLE_MIN_KEEP of vmax rather than stopping the car dead");

    check(clear.totalS == ctlS && clear.lat == ctlLat && clear.v == ctlV &&
              clear.vlat == ctlVlat && clear.onWall == ctlWall,
          "a car far from every pole steps exactly as it does on a pole-free track");

    // A DEAD-CENTRE hit takes the deep-penetration branch instead (d2 <= 1e-6),
    // where the escape normal is chosen by the shorter half-extent — the width
    // (0.26) beats the length (0.44), so the car is ejected SIDEWAYS and |nS| stays
    // small. Documented here because it is counter-intuitive: a boost survives
    // being impaled on a post while a nose-first tap kills it.
    {
      Car& centre = *game.cars()[0];
      centre.totalS = POLE_S;
      centre.lat = POLE_LAT;
      centre.heading = 0.0;
      centre.v = 8.0;
      centre.vlat = 0.0;
      centre.boostT = 2.0;
      centre.boostMul = 2.0;
      centre.onWall = false;
      const double latBefore = centre.lat;
      game.update(DT);
      check(centre.onWall, "a dead-centre pole hit sets onWall");
      check(std::fabs(centre.lat - latBefore) > 1e-9,
            "a dead-centre hit ejects the car sideways");
      check(centre.boostMul == 2.0,
            "a dead-centre (sideways) ejection does NOT kill the boost");
    }

    // A glancing hit from the side: approach offset laterally so the shallow
    // branch (a real surface normal, d2 > 1e-6) runs instead.
    Car& glance = *game.cars()[0];
    glance.totalS = POLE_S - 0.20;
    glance.lat = POLE_LAT + 0.55;
    glance.heading = 0.0;
    glance.v = 6.0;
    glance.vlat = -3.0;
    glance.onWall = false;
    const double beforeLat = glance.lat;
    game.update(DT);
    check(glance.onWall, "a glancing pole hit also sets onWall");
    check(glance.lat >= beforeLat - 1e-9,
          "a glancing hit pushes the car away from the pole, not through it");
    check(glance.vlat == 0.0, "a glancing pole hit zeroes lateral velocity");

    // And the car must not end up INSIDE the post: separation is the whole point.
    const double gap = gapTo(glance, bt.game.poles[0], bt.game.length);
    check(gap > 0.0, "the car is not left at the pole's centre");
  }

  // ---- stageBanana -----------------------------------------------------------
  {
    BuiltRaceTrack bt;
    std::string err;
    if (!build_race_track_by_id("tidepool", 3, 7u, bt, err)) {
      std::fprintf(stderr, "FAIL build tidepool (banana): %s\n", err.c_str());
      return 2;
    }
    const std::vector<PlayerDesc> players{PlayerDesc{Id::Num(0), false, Stats{}}};

    std::vector<Event> events;
    Game game(players, bt.game, [&events](const Event& e) { events.push_back(e); });

    // Staged bananas are ownerless and armed immediately (armAt 0), unlike a
    // dropped one, which is inert for its owner for BANANA_OWNER_IMMUNE.
    Car& c = *game.cars()[0];
    c.totalS = 30.0;
    c.lat = 0.0;
    c.heading = 0.0;
    c.v = 6.0;

    const long id = game.stageBanana(c.totalS + 0.8, 0.0);
    check(id > 0, "stageBanana returns a positive id");
    const long id2 = game.stageBanana(c.totalS + 40.0, 0.0);
    check(id2 == id + 1, "staged banana ids increment");

    // Roll forward far enough to reach the first banana but not the second.
    bool spun = false;
    for (int i = 0; i < 40 && !spun; i++) {
      game.update(DT);
      for (const Event& e : events) {
        if (e.type == "spin" && e.cause == "banana") spun = true;
      }
    }
    check(spun, "driving over a staged banana spins the car with cause 'banana'");
    check(c.spinT > 0.0, "the spin timer is running after the hit");
  }

  // ---- a banana used with the ITEM button held -------------------------------
  // No trace sends `h`, so no fixture reaches the carried banana. It rides the
  // bumper as a live hazard with the slot already free, and stays put on the
  // release, beside a control arm that sends no `h` and so drops on the press.
  {
    BuiltRaceTrack bt;
    std::string err;
    if (!build_race_track_by_id("tidepool", 3, 7u, bt, err)) {
      std::fprintf(stderr, "FAIL build tidepool (held banana): %s\n", err.c_str());
      return 2;
    }
    const std::vector<PlayerDesc> players{PlayerDesc{Id::Num(0), false, Stats{}},
                                          PlayerDesc{Id::Num(1), false, Stats{}}};
    int uses = 0;
    std::vector<Event> spins;
    Game game(players, bt.game, [&](const Event& e) {
      if (e.type == "item_use") uses++;
      if (e.type == "spin") spins.push_back(e);
    });
    Car& c = *game.cars()[0];
    Car& other = *game.cars()[1];
    c.totalS = 30.0;
    c.v = 6.0;
    other.totalS = 10.0;

    game.giveItem(c.id, "banana", false, 0);
    Input press; press.hasU = true; press.u = 1; press.hasH = true; press.h = 1;
    game.processInput(c.id, press);
    for (int i = 0; i < 30; i++) game.update(DT);
    check(c.trailing, "a banana used with the button down trails the car");
    check(c.item.empty() && uses == 1, "…and leaves the slot on the press");
    check(game.bananas().size() == 1 && game.bananas()[0].carried, "…as a banana on the road");
    double s, lat;
    game.bananaDropPoint(c, s, lat);
    check(game.bananas()[0].s == s && game.bananas()[0].lat == lat, "…riding the rear bumper");
    check(spins.empty(), "…that never spins its carrier");

    game.giveItem(c.id, "boost", false, 0);
    game.update(DT);
    check(c.trailing && c.item == "boost", "the free slot takes another item while it is carried");

    other.totalS = game.bananas()[0].s;
    other.lat = game.bananas()[0].lat;
    other.v = 0;
    game.update(DT);
    check(spins.size() == 1 && spins[0].id == other.id && spins[0].cause == "banana",
          "another car touching a carried banana spins on it");
    check(game.bananas().empty() && !c.trailing, "…and takes it off the bumper");
    other.totalS = 10.0;

    game.giveItem(c.id, "banana", false, 0);
    Input again; again.hasU = true; again.u = 2;
    game.processInput(c.id, again);
    game.update(DT);
    check(c.trailing && game.bananas().size() == 1, "a second held banana trails");
    Input release; release.hasH = true; release.h = 0;
    game.processInput(c.id, release);
    game.update(DT);
    const double atS = game.bananas()[0].s;
    for (int i = 0; i < 30; i++) game.update(DT);
    check(!c.trailing && !game.bananas()[0].carried, "the release lets go of it");
    check(game.bananas()[0].s == atS && uses == 2, "…where it was, as the one use");

    game.giveItem(c.id, "banana", false, 0);
    Input tap; tap.hasU = true; tap.u = 3;
    game.processInput(c.id, tap);
    game.update(DT);
    check(game.bananas().size() == 2 && !c.trailing && !game.bananas()[1].carried,
          "control: no `h` drops on the press");
  }

  std::printf("hazard check: %d assertions, %d failures\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
