// seat_stripe — where a player's centre stripe may run on one car model,
// measured off the model's own PAINT (ttp_glb.inc's ttpSeatMarks draws it).
//
// Two answers, both from geometry so no table names a model:
//   * the stripe's HALF-WIDTH is a share of the paint's own half-width, so a
//     narrow body (Rumble) wears a narrower stripe — down to a floor, because
//     the plain share left Rumble's too thin to read;
//   * the SPOILER is left bare. A spoiler is paint at the REAR that spans the
//     paint's full width; the stripe skips everything behind its front edge
//     AND above its underside, which keeps the rear deck below it striped.
//
// Header-only for the glb_mesh.h reason: the renderer consumes it and may not
// link libttp-runtime; the seatstripe ctest executes it on the shipped GLBs.
#pragma once

#include <algorithm>
#include <cmath>
#include <string>
#include <vector>

#include "ttp/glb_mesh.h"

namespace ttp {
namespace rt {

constexpr float SEAT_STRIPE_SHARE = 0.27f;  // of the paint's half-width
constexpr float SEAT_STRIPE_MIN_HALF = 0.05f;
constexpr float SEAT_STRIPE_HALF = 0.07f;   // when a model cannot be measured

struct SeatStripe {
    float half = SEAT_STRIPE_HALF;
    // The stripe stops where p.z > cutZ AND p.y > cutY (model space; the kit
    // faces -Z, so +z is the rear). Out of reach when the model has no spoiler.
    float cutZ = 1e9f;
    float cutY = 1e9f;
};

// The atlas swatch the body paint samples: the 0.5..0.75 band, any column but
// 13 (the glass). The same test as ttpSeatMarks.
inline bool seat_stripe_paint(float u, float v) {
    return v >= 0.5f && v < 0.75f && std::floor(u * 16.0f) != 13.0f;
}

inline SeatStripe measure_seat_stripe(const std::vector<GlbMeshNode>& nodes) {
    SeatStripe out;
    const GlbMeshNode* body = nullptr;
    for (const GlbMeshNode& n : nodes) {
        if (n.name.rfind("wheel", 0) == 0 || n.name == "axle") continue;
        body = &n;
        break;
    }
    if (!body) return out;
    float maxX = 0, maxZ = 0;
    for (const GlbMeshPrim& p : body->prims) {
        if (p.uv.size() * 3 != p.pos.size() * 2) continue;
        for (size_t i = 0; i < p.pos.size() / 3; i++) {
            maxZ = std::max(maxZ, p.pos[i * 3 + 2]);
            if (seat_stripe_paint(p.uv[i * 2], p.uv[i * 2 + 1])) {
                maxX = std::max(maxX, std::fabs(p.pos[i * 3]));
            }
        }
    }
    if (maxX <= 0) return out;
    out.half = std::max(SEAT_STRIPE_MIN_HALF, SEAT_STRIPE_SHARE * maxX);
    // Full-width paint in the rear half is a spoiler.
    float wingZ = 1e9f, wingY = 1e9f;
    for (const GlbMeshPrim& p : body->prims) {
        if (p.uv.size() * 3 != p.pos.size() * 2) continue;
        for (size_t i = 0; i < p.pos.size() / 3; i++) {
            const float x = std::fabs(p.pos[i * 3]), y = p.pos[i * 3 + 1], z = p.pos[i * 3 + 2];
            if (z < 0.5f * maxZ || x < 0.9f * maxX) continue;
            if (!seat_stripe_paint(p.uv[i * 2], p.uv[i * 2 + 1])) continue;
            wingZ = std::min(wingZ, z);
            wingY = std::min(wingY, y);
        }
    }
    // A hair inside the spoiler's front edge, a hair above its underside: the
    // deck it sits on can share that underside's height (Bolt's does).
    if (wingZ < 1e9f) {
        out.cutZ = wingZ - 0.002f;
        out.cutY = wingY + 0.004f;
    }
    return out;
}

}  // namespace rt
}  // namespace ttp
