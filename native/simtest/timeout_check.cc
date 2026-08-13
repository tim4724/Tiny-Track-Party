// The race-timeout ladder (RaceSession::timedOut): 30 s for the field once the
// first car is home, 5 s once a single straggler remains, MAX_RACE_MS when
// nobody finishes — and the straggler clock must never cut a 1-car solo race.
//
// No golden trace can reach any of these: the session traces stop within
// seconds of their last event, and skysnake's field finishes itself. So the
// windows are pinned here, by driving a RaceSession wall-clock style and
// force-finishing cars at chosen times. The bots are never driven, so no car
// finishes on its own and every transition is the ladder's.

#include <cstdio>

#include "ttp/race_session.h"
#include "ttp/race_track.h"

using namespace ttp;

namespace {

const double TICK_MS = 100;

int fail(const char* msg) {
  std::fprintf(stderr, "FAIL timeout: %s\n", msg);
  return 1;
}

struct Live {
  BuiltRaceTrack track;
  std::unique_ptr<RaceSession> session;
};

// A racing session with `cars` idle cars (countdown already run down).
bool start(Live& lv, int cars, std::string& err) {
  if (!build_race_track_by_id("tidepool", 3, 42u, lv.track, err)) return false;
  std::vector<PlayerDesc> players;
  for (int i = 0; i < cars; i++) players.push_back(PlayerDesc{Id::Num(i), false, Stats{}});
  lv.session = std::make_unique<RaceSession>(players, lv.track.game, nullptr, nullptr, nullptr);
  lv.session->startCountdown(3);
  for (int i = 0; i < 40 && !lv.session->racing(); i++) lv.session->update(TICK_MS);
  if (!lv.session->racing() && err.empty()) err = "countdown never flipped";
  return lv.session->racing();
}

// Tick until ended() or `ms` of race time passes; how long it took, in ms.
double runFor(RaceSession& s, double ms) {
  double t = 0;
  while (t < ms && !s.ended()) { s.update(TICK_MS); t += TICK_MS; }
  return t;
}

}  // namespace

int main() {
  std::string err;

  // 30 s field grace after the first flag (second clock stays unarmed: 2 left).
  {
    Live lv;
    if (!start(lv, 3, err)) return fail(err.c_str());
    lv.session->engine().forceFinish(Id::Num(0), false, 0);
    if (runFor(*lv.session, 29000) < 29000) return fail("field cut before its 30 s grace");
    if (runFor(*lv.session, 2000) >= 2000) return fail("field grace never expired");
  }

  // 5 s straggler grace once the field is down to one.
  {
    Live lv;
    if (!start(lv, 3, err)) return fail(err.c_str());
    lv.session->engine().forceFinish(Id::Num(0), false, 0);
    lv.session->engine().forceFinish(Id::Num(1), false, 0);
    if (runFor(*lv.session, 4000) < 4000) return fail("straggler cut before its 5 s grace");
    if (runFor(*lv.session, 2000) >= 2000) return fail("straggler grace never expired");
  }

  // A 1-car solo race arms neither clock (no finisher); only MAX_RACE_MS ends it.
  {
    Live lv;
    if (!start(lv, 1, err)) return fail(err.c_str());
    if (runFor(*lv.session, 60000) < 60000) return fail("solo race cut by a grace clock");
    if (runFor(*lv.session, 130000) >= 130000) return fail("MAX_RACE_MS never ended the solo race");
  }

  std::printf("timeout: field 30 s, straggler 5 s, solo runs to MAX_RACE_MS\n");
  return 0;
}
