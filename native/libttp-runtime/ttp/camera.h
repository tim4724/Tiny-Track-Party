// camera — the per-player spring chase rig, lifted verbatim out of
// runtime/ttp_display.cc (DELETED — git history has it). The tuning comments here are the reference
// documentation for every constant; they came across untouched.
#pragma once

#include "ttp/vecmath.h"

namespace ttp {

struct Pose;  // ttp/game.h — a reference parameter needs no definition here

namespace rt {

// ---------------------------------------------------------------------------
// The per-player spring chase camera — an exact port of ChaseCamera.js, whose
// tuning comments are the reference for every constant here.
//
// Close chase sitting LOW and just behind the car with a fairly tight lens, so
// the camera stays comfortable to drive rather than steeply top-down.
// ---------------------------------------------------------------------------
// DIST SETS THE PARKED SHOT ALONE, because the spring's lag is ~v/rate and so
// is zero at a standstill. A notch here moves the grid and the race together and
// never the gap between them; that gap is CAM_POS_RATE's.
//
// DIST AND LOOK ARE ONE BASELINE: the pitch is
// atan((HEIGHT - TGT_UP) / (LOOK + DIST)), so only the SUM (2.85) steers the
// aim. Move one alone and the picture noses over — a 0.35 cut to DIST by itself
// takes the pitch 10.5 -> 12.0 degrees. HEIGHT is in that numerator but is not
// the lever for it: it is what sees over the car, and trading it away hides the
// road ahead. So a closer camera is DIST down and LOOK up by the same amount.
constexpr float CHASE_DIST = 1.15f, CHASE_HEIGHT = 0.64f, CHASE_LOOK = 1.7f;
constexpr float CHASE_TGT_UP = 0.11f;      // look point barely above the road
// 7 -> 32. This one constant decides both how far back the camera sits while
// racing and how far that is from the parked shot, which never lags at all: the
// eye's lag behind its parked place fell 0.44 -> 0.20u flat out, and that is
// v/rate, so it holds whatever DIST is. It cost the swing — at 30% throttle the
// lag is 0.08 where it was 0.33, leaving the spd² shaping below a trim on a
// large base rather than the main event.
constexpr float CAM_POS_RATE = 32.0f, CAM_TGT_RATE = 13.0f;  // damping (1/s)
// The position spring lags the car by ~velocity/rate, so the faster you go the
// further back the camera sits. The follow rate therefore climbs with spd²:
// fast straights and boosts tighten and stay glued (the car stays big), while
// slow corners keep the base rate and its looser swing-behind.
constexpr float CAM_POS_RATE_SPD = 13.0f;
// How far past flat-out ANY overspeed cue tracks: the rate above and the boost
// lens below. Monster + boost reaches spd 1.875 and neither should follow it out
// there.
constexpr float CAM_RATE_SPD_MAX = 1.6f;
constexpr float BASE_FOV = 55.0f;
// Sense of speed, no shake: the FOV widens with speed. Asymmetric — it kicks
// wide fast (a boost lands as a hit) and eases back slow (running out of boost
// is a taper, not a snap).
//
// TWO GAINS. `spd` is normalised to the car's own vmax, so ordinary driving is
// 0..1 and only a boost or the monster truck passes it: FOV_GAIN rides all of
// `spd` and stays small, since every degree of it is variation in NORMAL
// driving, while FOV_BOOST_GAIN rides the OVERSPEED alone and is zero until
// then. The lens carries the boost by itself because the chase cannot —
// CAM_POS_RATE_SPD makes the follow rate climb faster than the car does, so a
// boost TIGHTENS the spring (lag 0.200 flat out, 0.220 boosting) rather than
// stretching it. 12 puts an item boost at 67 degrees against 59.
constexpr float FOV_GAIN = 4.0f, FOV_RISE = 9.0f, FOV_FALL = 3.0f;
constexpr float FOV_BOOST_GAIN = 12.0f;
constexpr float CHASE_DIST_GAIN = 0.06f;
constexpr float CAM_NEAR = 0.1f, CAM_FAR = 600.0f;

struct ChaseCam {
    V3 pos, target;
    float fov = BASE_FOV;
    bool init = false;  // first update snaps, so it doesn't lag in from the origin

    void update(const ttp::Pose& pose, float spd, float dt);
};

}  // namespace rt
}  // namespace ttp
