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
// the player is about to drive. Holding it moves the eye 21% nearer the car
// (hypot 1.494 -> 1.187, so the car draws ~26% bigger) for 1.4 degrees of extra
// view pitch, which reads as nothing.
//
// 1.0 IS ABOUT THE FLOOR for moving the eye ALONE, and the reason is the look
// point: it stays a fixed CHASE_LOOK ahead of the car, so pulling in past here
// stops framing more car and starts framing less ROAD. The eye-to-target
// baseline is down to 2.5 from 2.85 and the elevation over the car is 32.6
// degrees against the 25.4 it was authored at — still the low chase above, but
// with less margin than it had. Anything nearer wants CHASE_LOOK to come in too.
constexpr float CHASE_DIST = 1.0f, CHASE_HEIGHT = 0.64f, CHASE_LOOK = 1.5f;
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
