// shot_hold.{h,cc} — freeze a race at the moment a screenshot card is about.
//
// The screens gallery photographs the same card on three platforms, and a card
// shot "a couple of seconds after the scene stood up" lands at a different RACE
// time on each: a software-rendered browser advances the sim a fraction of what
// a simulator does in the same wall time, and the chase camera's distance is a
// function of speed (camera.cc), so the same card came back with a different
// camera per platform. The item cards were worse: a rocket crosses the road in a
// few frames, so a wall-clock shot usually has no rocket in it.
//
// So a card names a SIM moment, and the sim stops there. The rule lives here
// because all three shells step the race through one call (ttp_update), and a
// hold decided in each shell would be three copies of it.
//
// A hold is
//   simMs    the race time to stop at; for an item card, the earliest moment the
//            item may count (an event before it is ignored)
//   on       "rocket" — a rocket hit on any car; "monster" — a VIEWER's own car
//            (a human seat) is the truck, so its cell has the truck up close.
//            A CPU truck up the road counted once, and photographed as a speck.
//   afterMs  how long past that event to stop
//   capMs    for an item card, stop here anyway if the event never came
//
// Harness-only: nothing in a party arms one.
#pragma once

#include <vector>

#include "ttp/canonical.h"

namespace ttp {
namespace rt {
namespace shot_hold {

enum class On { None, Rocket, Monster };

struct Spec {
  double simS = 0;
  double afterS = 0;
  double capS = 0;
  On on = On::None;
};

// A malformed hold is a harness bug, not a save to tolerate: false, and nothing
// armed. simMs is required and must be >= 0; `on` must be absent or known.
bool parse(const Value& blob, Spec* out);

struct State {
  double eventAt = -1;  // sim seconds of the first qualifying event
  bool held = false;    // latched: once held, the race never steps again
};

// One car as the hold and the showcase read it.
struct CarView {
  double totalS = 0;
  bool monster = false;
  bool viewer = false;
  bool finished = false;
};

// A held race steps in FIXED increments of this, whatever the frame rate, so a
// card is the same race on every platform — the sim is bit-exact for identical
// inputs, and a frame-rate-dependent dt was the one input that differed.
inline constexpr double FIXED_STEP_MS = 1000.0 / 60.0;

// Seconds the race may advance this frame, given `dtS` wanted: the whole dt, a
// shorter step that lands exactly on the target, or 0 once held. Latches
// `state.held` on the frame the target is reached.
double allow(const Spec& spec, State& state, double elapsedS, double dtS,
             const std::vector<CarView>& cars);

// A rocket hit happened at sim time `elapsedS`.
void noteRocketHit(const Spec& spec, State& state, double elapsedS);

// ---- the item showcase ------------------------------------------------------
// The rocket and monster previews GIVE their item and fire it at once, on a
// loop, so the preview shows its event every couple of seconds instead of
// whenever a car happens through a box. This is WHO and WHEN: the car furthest
// back (the most dramatic user, and the one the catch-up items are for; the
// launch grids players at the back, so a rocket normally flies at the car in
// front of a camera), on a cooldown so it is not a barrage; a monster only on a
// viewer seat (its own cell then holds the truck, and the audio voices non-AI
// cars only) and one truck at a time.
//
// It used to SPEND an item a car had picked up, and was the web harness's alone:
// the autopiloted seats rarely drive through a box, so the item cards waited on
// luck, and each platform had different luck.
enum class Showcase { None, Rocket, Monster };

inline constexpr double SHOWCASE_FIRST_FIRE_S = 0.8;
inline constexpr double SHOWCASE_ROCKET_GAP_S = 1.3;
inline constexpr double SHOWCASE_MONSTER_GAP_S = 1.6;

struct ShowcaseState {
  double fireCd = SHOWCASE_FIRST_FIRE_S;
};

// "rocket" | "monster" -> the kind; anything else is None.
Showcase parseShowcase(const char* kind);

// Called once per sim step of `dtS`. Returns the index in `cars` of the car to
// give the item to and fire it from now, or -1.
int showcasePick(Showcase kind, ShowcaseState& state, double dtS, const std::vector<CarView>& cars);

}  // namespace shot_hold
}  // namespace rt
}  // namespace ttp
