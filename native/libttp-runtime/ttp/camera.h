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
// DIST came in from 1.35 and HEIGHT deliberately did NOT follow it. A true
// dolly would scale both and keep the elevation, but the height is what sees
// OVER the car: dropping it to hold the angle buys nothing and hides the road
// the player is about to drive. Holding it moves the eye 21% nearer the car —
// hypot 1.494 -> 1.187, so the car draws ~26% bigger.
//
// LOOK THEN WENT THE OTHER WAY, to 1.85, and the pair is why this comment is
// long: DIST and LOOK are the two ends of ONE baseline. The view pitch is
// atan((HEIGHT - TGT_UP) / (LOOK + DIST)) — the drop is fixed at 0.53, so only
// the SUM steers the aim. Pulling the eye in to 1.0 alone shortened it 2.85 ->
// 2.50 and tipped the view 10.5 -> 12.0 degrees nose-down: the horizon climbed,
// the near tarmac grew, and the track the player is about to reach shrank.
// Pushing the look point out to 1.85 restores the sum, so the camera aims where
// it always did while sitting closer. That is the whole trick — LOOK buys back
// the AIM, and cannot buy back the elevation over the car (atan(HEIGHT/DIST),
// now 32.6 degrees against the authored 25.4), which is DIST and HEIGHT's
// alone. It leaves the car lower in frame with more road above it, which is the
// right way round for a closer chase.
//
// SO DO NOT MOVE ONE WITHOUT THE OTHER. Nearer wants LOOK further out by the
// same amount, or the picture goes nose-down again.
constexpr float CHASE_DIST = 1.0f, CHASE_HEIGHT = 0.64f, CHASE_LOOK = 1.85f;
constexpr float CHASE_TGT_UP = 0.11f;      // look point barely above the road
constexpr float CAM_POS_RATE = 7.0f, CAM_TGT_RATE = 13.0f;  // damping (1/s)
// The position spring lags the car by ~velocity/rate, so the faster you go the
// further back the camera sits. The follow rate therefore climbs with spd²:
// fast straights and boosts tighten and stay glued (the car stays big), while
// slow corners keep the base rate and its loose swing-behind.
constexpr float CAM_POS_RATE_SPD = 13.0f;
constexpr float CAM_RATE_SPD_MAX = 1.6f;   // cap, so a future >1.6 boost can't go rigid
constexpr float BASE_FOV = 55.0f;
// Sense of speed, no shake: FOV widens and the chase stretches back with speed.
// `spd` is normalised to the car's own vmax and a boost pushes it past 1, so
// both cues over-extend exactly as much as the car actually overspeeds. The FOV
// response is asymmetric — it kicks wide fast (a boost lands as a hit) and eases
// back slow (running out of boost is a taper, not a snap).
constexpr float FOV_GAIN = 4.0f, FOV_RISE = 9.0f, FOV_FALL = 3.0f;
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
