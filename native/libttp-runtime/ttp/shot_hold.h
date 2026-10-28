// shot_hold.{h,cc} — the gallery harnesses' two race rules: the HOLD, which
// freezes a race at the moment a screenshot card is about, and the item
// SHOWCASE, which the item showroom fires its item on a loop with.
//
// The screens gallery photographs the same card on three platforms, and a card
// shot "a couple of seconds after the scene stood up" lands at a different RACE
// time on each: a software-rendered browser advances the sim a fraction of what
// a simulator does in the same wall time, and the chase camera's distance is a
// function of speed (camera.cc), so the same card came back with a different
// camera per platform.
//
// So a card names a SIM moment, and the sim stops there. The rule lives here
// because all three shells step the race through one call (ttp_update), and a
// hold decided in each shell would be three copies of it.
//
// A hold is `simMs`, the race time to stop at. An item card is a moment of a
// real race like any other, found on the trailer editor's timeline. The one
// exception is a held banana: no bot holds the ITEM button, so no real race has
// one, and `trailMs` stages it (trailPick below).
//
// Harness-only: nothing in a party arms one.
#pragma once

#include <vector>

#include "ttp/canonical.h"

namespace ttp {
namespace rt {
namespace shot_hold {

struct Spec {
  double simS = 0;
  double trailS = 0;    // > 0: stage a held banana this long before the stop
};

// A malformed hold is a harness bug, not a save to tolerate: false, and nothing
// armed. simMs is required and must be >= 0; trailMs is optional, > 0 and no
// later than simMs.
bool parse(const Value& blob, Spec* out);

struct State {
  bool held = false;    // latched: once held, the race never steps again
  bool trailed = false; // latched: the held banana is staged once
};

// One car as the item showcase reads it.
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
double allow(const Spec& spec, State& state, double elapsedS, double dtS);

// ---- the held banana ----------------------------------------------------------
// True once, on the first step at or past `trailS` before the stop: the step on
// which a player is handed a banana with ITEM held, so the card freezes with it
// trailing and the aim rig up (camera.h). How far before the stop is the card's
// choice: long enough for the rig to finish moving.
bool trailDue(const Spec& spec, State& state, double elapsedS);

// Which car holds it: the viewer with the nearest car behind, since that car
// is what aiming a banana is about. -1 when no viewer has anyone behind.
int trailPick(const std::vector<CarView>& cars);

// ---- the item showcase ------------------------------------------------------
// The item showroom GIVES its item and uses it at once, on a loop, so the
// showroom shows its event every couple of seconds instead of
// whenever a car happens through a box. This is WHO and WHEN: the car furthest
// back (the most dramatic user, and the one the catch-up items are for; the
// launch grids players at the back, so a rocket normally flies at the car in
// front of a camera), on a cooldown so it is not a barrage; a monster only on a
// viewer seat (its own cell then holds the truck, and the audio voices non-AI
// cars only) and one truck at a time.
//
// The banana is the live Banana aim card's, and it is HELD rather than fired:
// trailPick's car takes it with ITEM down, which trails it and brings up the
// aim view, and lets go SHOWCASE_BANANA_HOLD_S later, which drops it.
enum class Showcase { None, Rocket, Monster, Banana };

inline constexpr double SHOWCASE_FIRST_FIRE_S = 0.8;
inline constexpr double SHOWCASE_ROCKET_GAP_S = 1.3;
inline constexpr double SHOWCASE_MONSTER_GAP_S = 1.6;
inline constexpr double SHOWCASE_BANANA_HOLD_S = 3.5;  // the aim view's delay, move and a beat
inline constexpr double SHOWCASE_BANANA_GAP_S = 2.0;

struct ShowcaseState {
  double fireCd = SHOWCASE_FIRST_FIRE_S;
  double releaseCd = -1;  // the held banana's hold still to run; < 0 = none held
};

// "rocket" | "monster" | "banana" -> the kind; anything else is None.
Showcase parseShowcase(const char* kind);

// Called once per sim step of `dtS`. Returns the index in `cars` of the car to
// give the item to and fire it from now, or -1. Not for the banana.
int showcasePick(Showcase kind, ShowcaseState& state, double dtS, const std::vector<CarView>& cars);

// The banana's step: the index of the car to take a banana with ITEM held, or
// -1, and whether the car holding the last one lets go now.
struct BananaStep {
  int hold = -1;
  bool release = false;
};
BananaStep bananaShowcase(ShowcaseState& state, double dtS, const std::vector<CarView>& cars);

}  // namespace shot_hold
}  // namespace rt
}  // namespace ttp
