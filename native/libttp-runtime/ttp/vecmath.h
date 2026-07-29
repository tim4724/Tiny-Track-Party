// vecmath — the cosmetic float vectors the display layer runs on, plus the one
// camera world matrix it hands the renderer.
//
// Lifted VERBATIM out of runtime/ttp_display.cc (DELETED — git history has it;
// runtime/ttp_display_web.cc is the web shell that survived it), which sat behind the Filament
// gate and therefore compiled on exactly one machine configuration and was
// exercised by none of the ctests. Nothing in libttp-runtime knows what a
// renderer, a canvas or an emscripten context is; it is compiled and tested on
// every leg.
#pragma once

#include <cmath>

#include "ttp/vec3.h"

namespace ttp {
namespace rt {

// ---------------------------------------------------------------------------
// Small vector helpers. Cosmetic math only — nothing here is conformance-
// bearing, so it runs in plain float, unlike everything in libttp-sim.
// ---------------------------------------------------------------------------
struct V3 {
    float x = 0, y = 0, z = 0;
};
inline V3 operator+(V3 a, V3 b) { return { a.x + b.x, a.y + b.y, a.z + b.z }; }
inline V3 operator-(V3 a, V3 b) { return { a.x - b.x, a.y - b.y, a.z - b.z }; }
inline V3 operator*(V3 a, float k) { return { a.x * k, a.y * k, a.z * k }; }
inline float dot(V3 a, V3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline V3 cross(V3 a, V3 b) {
    return { a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x };
}
inline V3 norm(V3 a) {
    const float l = std::sqrt(dot(a, a));
    return l > 0 ? a * (1.0f / l) : V3{ 0, 0, 1 };
}
inline V3 lerp(V3 a, V3 b, float t) { return a + (b - a) * t; }
inline V3 v3(const ttp::Vec3& v) { return { (float) v.x, (float) v.y, (float) v.z }; }

// A camera world matrix, column-major, for an eye looking at `target` with
// `up` — three.js Matrix4.lookAt's basis, which is what TtpViewInput.world is
// documented to carry. Camera looks down -Z, so the Z column points BACK.
inline void lookAtWorld(float out[16], V3 eye, V3 target, V3 up) {
    V3 z = eye - target;
    if (dot(z, z) == 0) z.z = 1;
    z = norm(z);
    V3 x = cross(up, z);
    if (dot(x, x) == 0) {  // eye directly above/below the target
        if (std::fabs(up.z) == 1) z.x += 1e-4f; else z.z += 1e-4f;
        z = norm(z);
        x = cross(up, z);
    }
    x = norm(x);
    const V3 y = cross(z, x);
    out[0] = x.x;  out[1] = x.y;  out[2] = x.z;  out[3] = 0;
    out[4] = y.x;  out[5] = y.y;  out[6] = y.z;  out[7] = 0;
    out[8] = z.x;  out[9] = z.y;  out[10] = z.z; out[11] = 0;
    out[12] = eye.x; out[13] = eye.y; out[14] = eye.z; out[15] = 1;
}

}  // namespace rt
}  // namespace ttp
