#include "ttp/framing.h"

#include <cmath>

namespace ttp {
namespace rt {

Framing solveFraming(const TtpTrackFraming& tf, float maxOrbitDist) {
    Framing f;

    f.center = { tf.centerX, tf.centerY, tf.centerZ };
    const float halfX = tf.sizeX * 0.5f, halfZ = tf.sizeZ * 0.5f;
    const float radius = (tf.sizeX > tf.sizeZ ? tf.sizeX : tf.sizeZ) * 0.5f + 8;
    // Whole-track fit distance for the gallery turntable, along the same iso
    // direction the still overview uses.
    const float dist = radius / std::tan((OVERVIEW_FOV * (float) M_PI / 180) / 2) * 0.9f;
    const V3 dir = norm(V3{ 0.35f, 0.8f, 0.9f });
    f.ovOffset = dir * dist;
    // Horizontal radius + height of that iso offset, reused by the lobby and
    // gallery orbits so the moving camera keeps the same framing as the still
    // one — and its bearing, so an orbit's first frame IS the still.
    f.ovRadius = std::hypot(f.ovOffset.x, f.ovOffset.z);
    f.ovHeight = f.ovOffset.y;
    f.ovBearing = std::atan2(f.ovOffset.z, f.ovOffset.x);

    // Overview fog: reusing the race fog here would veil the far half of a track
    // framed from ~100-190u out. Instead start the fog just PAST the farthest the
    // track can sit from the orbiting camera — so the whole circuit stays crisp —
    // then dissolve over a WIDE band, because a narrow one gets compressed into a
    // hard line at the grazing horizon angle where a wide one reads as haze.
    f.ovFogNear = maxOrbitDist + 12;
    f.ovFogFar = f.ovFogNear + (220.0f > radius * 2 ? 220.0f : radius * 2);

    // Lobby perimeter orbit: hug just outside the XZ bbox so the camera traces
    // the track's overall shape up close (elongated tracks → elongated path).
    f.bbAx = halfX + BBOX_CLEARANCE;
    f.bbAz = halfZ + BBOX_CLEARANCE;
    // Height off the AVERAGE half-extent (not the max), so a very elongated track
    // isn't over-elevated into a top-down view on its narrow sides.
    f.bbHeight = BBOX_HEIGHT_K * (halfX + halfZ) * 0.5f + BBOX_HEIGHT_BASE;
    // With the camera hugging the track, keep the near road crisp but haze the
    // open field SOON, so the empty grass outside the circuit dissolves into the
    // sky instead of reading as a flat plane.
    const float wide = halfX > halfZ ? halfX : halfZ;
    f.bbFogNear = 55 * tf.fogTune;
    f.bbFogFar = (55 + (110.0f > wide * 1.2f ? 110.0f : wide * 1.2f)) * tf.fogTune;
    f.raceFogNear = RACE_FOG_NEAR * tf.fogTune;
    f.raceFogFar = RACE_FOG_FAR * tf.fogTune;
    return f;
}

}  // namespace rt
}  // namespace ttp
