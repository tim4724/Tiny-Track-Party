// framing — the overview/lobby camera rigs and the fog bands, solved once per
// scene build from the track's bounding box. Lifted verbatim out of
// runtime/ttp_display.cc.
#pragma once

#include "ttp/vecmath.h"
#include "ttp_render.h"

namespace ttp {
namespace rt {

// ---------------------------------------------------------------------------
// Overview rigs (SceneRenderer's _loop, ported).
// ---------------------------------------------------------------------------
constexpr float OVERVIEW_FOV = 50.0f;
// The overview only ever frames whole tracks, so it can afford a far near plane
// and a long reach. The FREE cam is the exception: it flies right up to
// geometry, and at near 4 whatever you fly up to is simply clipped away.
constexpr float OV_NEAR = 4.0f, OV_FAR = 1500.0f, FREE_NEAR = 0.1f;
constexpr float LOBBY_ORBIT_SPEED = 0.1f;  // rad/s (~63 s per turn) — calm, never dizzying
constexpr float BBOX_ORBIT_SPEED = 0.16f;  // rad/s (~39 s per loop)
constexpr float BBOX_CLEARANCE = 8.0f;     // world units outside the bbox edge — tight
constexpr float BBOX_HEIGHT_K = 0.7f;      // height = this × the AVERAGE half-extent …
constexpr float BBOX_HEIGHT_BASE = 24.0f;  // … + this, so the frame looks DOWN onto the track
constexpr float RACE_FOG_NEAR = 70.0f, RACE_FOG_FAR = 170.0f;

// Everything the overview cameras and the fog profiles derive from the track,
// solved once per scene build rather than per frame.
struct Framing {
    V3 center;
    V3 ovOffset;                        // the fitted iso view's offset from centre
    float ovRadius = 0, ovHeight = 0;   // …and the same thing as orbit terms
    float ovBearing = 0;                // its compass bearing, where the orbits start
    float bbAx = 0, bbAz = 0, bbHeight = 0;
    float ovFogNear = 0, ovFogFar = 0;  // whole-track turntable
    float bbFogNear = 0, bbFogFar = 0;  // lobby perimeter orbit
    float raceFogNear = 0, raceFogFar = 0;
};

// Solve the overview rigs + fog bands from the built track's measurements.
// Ported from SceneRenderer.setTrack; `tf`'s bounding box is over the
// CENTERLINE points, not the dressed scene, which is what the JS box was too.
//
// `maxOrbitDist` is the worst-case distance from a camera orbiting at
// (ovRadius, ovHeight) to any centerline point — a pure function of the track
// samples, which only the renderer holds. It is a VALUE, not a callback: this
// library must not know a renderer exists. Note the ordering that implies —
// ovRadius/ovHeight are solved HERE, so a caller that needs them for the query
// runs this once with maxOrbitDist 0, reads them off, and calls again with the
// answer. ovFogNear/ovFogFar are the only fields that depend on it; everything
// else is a pure function of `tf`, so the first pass is free of it.
Framing solveFraming(const TtpTrackFraming& tf, float maxOrbitDist);

}  // namespace rt
}  // namespace ttp
