// Cross-race isolation: a Game must derive its AI racing line from ITS OWN
// centerline, even when a previous race's centerline occupied the same address.
//
// THE BUG THIS PINS DOWN. racingLineFor() used to memoize lines in a function-
// static vector keyed by `Centerline*` — described in the code as a WeakMap
// analogue. A WeakMap keys on object identity for as long as the object lives; a
// raw address is RECYCLED. BuiltRaceTrack heap-allocates its Centerline, so the
// second race in a process could land on the first's freed block, hit the stale
// entry, and drive the PREVIOUS TRACK'S racing line — wrong lane offsets, wrong
// corner braking, for the whole race. Reachable in the shipped game (a cup series
// builds four tracks in one wasm instance) and in probe_cli's catalogue sweep,
// where it showed up as lap times that moved by up to 3 s between identical runs.
//
// Every golden trace was blind to it: one race per process, so the cache was
// always cold. Replaying several traces in one process (replay_cli takes a list
// now) is the general leak detector, but it cannot FORCE the address collision.
// This check does, with placement new into one static slot: two different
// centerlines, same address, guaranteed. That is the whole point of the test —
// under the old ownership it fails deterministically instead of by allocator luck.
//
// The fix is ownership: Game::racingLine() builds and owns the line, so its
// lifetime is the race's and no key is involved.

#include <cstdio>
#include <memory>
#include <new>
#include <string>
#include <vector>

#include "ttp/ai_driver.h"
#include "ttp/centerline.h"
#include "ttp/game.h"
#include "ttp/race_track.h"

using namespace ttp;

namespace {

// Drive one bot for `frames` and digest what it DID: the AI's own outputs plus the
// resulting car state. Going through driveBot is the point — the stale line was
// only ever consulted from inside AiController::drive, so a test that asks the Game
// for its line directly passes even with the bug in place.
std::vector<double> raceDigest(const GameTrack& track, int frames) {
  const std::vector<PlayerDesc> players{PlayerDesc{Id::Num(0), false, Stats{}}};
  Game game(players, track, [](const Event&) {});
  AiController ai(1.0, LOOKAHEAD, STEER_GAIN, 0.0, 1u);
  std::vector<double> out;
  for (int i = 0; i < frames; i++) {
    Input in;
    game.driveBot(Id::Num(0), ai, &in);
    game.update(1000.0 / 60.0);
    out.push_back(in.s);
    out.push_back(in.b);
    const Car& c = *game.cars()[0];
    out.push_back(c.totalS);
    out.push_back(c.lat);
    out.push_back(c.v);
    out.push_back(c.heading);
  }
  return out;
}

GameTrack trackOn(const GameTrack& src, Centerline* cl) {
  GameTrack t = src;
  t.centerline = cl;
  return t;
}

int fail(const char* msg) {
  std::fprintf(stderr, "FAIL race isolation: %s\n", msg);
  return 1;
}

}  // namespace

int main() {
  BuiltRaceTrack a, b;
  std::string err;
  if (!build_race_track_by_id("tidepool", 3, 42u, a, err)) return fail(err.c_str());
  if (!build_race_track_by_id("helix", 3, 7u, b, err)) return fail(err.c_str());

  const int FRAMES = 400;

  // Reference: each track raced on its own freshly built centerline, nothing else
  // in the process having raced yet at that address.
  const std::vector<double> wantA = raceDigest(a.game, FRAMES);
  const std::vector<double> wantB = raceDigest(b.game, FRAMES);
  if (wantA == wantB) return fail("the two tracks drive identically — pick different fixtures");

  // ONE slot, reused: two DIFFERENT centerlines at the SAME address, by
  // construction rather than by allocator luck.
  alignas(Centerline) static unsigned char slot[sizeof(Centerline)];

  Centerline* first = new (slot) Centerline(*a.centerline);
  const std::vector<double> gotA = raceDigest(trackOn(a.game, first), FRAMES);
  first->~Centerline();
  if (gotA != wantA) return fail("race 1 diverged from its own reference (copy of the centerline differs?)");

  Centerline* second = new (slot) Centerline(*b.centerline);
  if (second != first) return fail("placement new did not reuse the slot — test cannot pin the bug");
  const std::vector<double> gotB = raceDigest(trackOn(b.game, second), FRAMES);
  second->~Centerline();

  if (gotB != wantB) {
    return fail("race 2 drove differently than the same track does in isolation — "
                "state keyed by the recycled centerline address leaked from race 1");
  }

  std::printf("race isolation: 2 races at one centerline address, each drove its own track (%d frames)\n",
              FRAMES);
  return 0;
}
