#include "ttp/camera.h"

#include <cmath>

#include "ttp/game.h"

namespace ttp {
namespace rt {

void ChaseCam::update(const ttp::Pose& pose, float spd, float dt) {
    const V3 p = v3(pose.pos), fwd = v3(pose.forward), up = v3(pose.up);
    const V3 want = p + fwd * -(CHASE_DIST + CHASE_DIST_GAIN * spd) + up * CHASE_HEIGHT;
    const V3 wantTgt = p + fwd * CHASE_LOOK + up * CHASE_TGT_UP;
    // Frame-rate-independent damping → smooth lag/swing behind through turns.
    const float rateSpd = spd < CAM_RATE_SPD_MAX ? spd : CAM_RATE_SPD_MAX;
    const float aPos = 1 - std::exp(-(CAM_POS_RATE + CAM_POS_RATE_SPD * rateSpd * rateSpd) * dt);
    const float aTgt = 1 - std::exp(-CAM_TGT_RATE * dt);
    if (!init) { pos = want; target = wantTgt; init = true; }
    else { pos = lerp(pos, want, aPos); target = lerp(target, wantTgt, aTgt); }
    // Overspeed only, off the already-clamped rateSpd (see FOV_BOOST_GAIN).
    const float over = rateSpd > 1 ? rateSpd - 1 : 0;
    const float fovTarget = BASE_FOV + spd * FOV_GAIN + over * FOV_BOOST_GAIN;
    const float fovRate = fovTarget > fov ? FOV_RISE : FOV_FALL;
    fov += (fovTarget - fov) * (1 - std::exp(-fovRate * dt));
}

}  // namespace rt
}  // namespace ttp
