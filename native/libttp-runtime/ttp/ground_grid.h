// ground_grid — the terrain's sampled heightfield, as plain data.
//
// The renderer samples its relief onto this grid once per scene and builds the
// ground MESH from it, so this is the surface that is actually drawn — between
// grid vertices it differs from the analytic field by enough to bury a shadow
// disc. The renderer stands its props on it, and the follow camera
// (ttp/camera.h) keeps its lens and its sight lines above it; the shim hands
// the camera the renderer's copy after each build.
//
// Header-only because the renderer and libttp-runtime may not link each other
// (native/CLAUDE.md), and the lookup must exist ONCE: two interpolants of the
// same mesh would disagree exactly where something sits on a slope.
#pragma once

#include <algorithm>
#include <vector>

namespace ttp {
namespace rt {

struct GroundGrid {
    float flatY = 0;                 // the plain ground, wherever the grid is absent
    float x0 = 0, z0 = 0;            // the grid's corner
    float sx = 0, sz = 0;            // cell size
    int cols = 0, rows = 0;          // cells; h holds (cols + 1) * (rows + 1) vertices
    std::vector<float> h;            // row-major, rows along Z

    float at(float x, float z) const {
        if (h.empty()) return flatY;
        const float u = (x - x0) / sx, v = (z - z0) / sz;
        if (u <= 0 || v <= 0 || u >= cols || v >= rows) return flatY;
        const int c = std::min(cols - 1, (int) u);
        const int r = std::min(rows - 1, (int) v);
        const float fu = u - c, fv = v - r;
        const auto y = [&](int cc, int rr) { return h[(size_t) rr * (cols + 1) + cc]; };
        // TRIANGLE-exact, not bilinear: the mesh splits each cell along the b–d
        // anti-diagonal, and anything draped onto the other interpolant would
        // still dip under the drawn surface.
        const float a = y(c, r), b = y(c + 1, r), d = y(c, r + 1), e = y(c + 1, r + 1);
        if (fu + fv <= 1.0f) return a + (b - a) * fu + (d - a) * fv;
        return e + (d - e) * (1.0f - fu) + (b - e) * (1.0f - fv);
    }
};

}  // namespace rt
}  // namespace ttp
