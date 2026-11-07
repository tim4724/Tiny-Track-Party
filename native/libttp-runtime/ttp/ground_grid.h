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
#include <cmath>
#include <cstdint>
#include <vector>

namespace ttp {
namespace rt {

struct GroundGrid {
    float flatY = 0;                 // the plain ground, wherever the grid is absent
    float x0 = 0, z0 = 0;            // the grid's corner
    float sx = 0, sz = 0;            // cell size
    int cols = 0, rows = 0;          // cells; h holds (cols + 1) * (rows + 1) vertices
    std::vector<float> h;            // row-major, rows along Z

    // THE VERGE BAND (TtpRenderer::buildVergeBand): finer ground laid along
    // the road over the grid, drawn in the same mesh. Where both lie the drawn
    // surface is the HIGHER, so the lookup is too. Triangles in world XZ
    // (bandP holds x, y, z per vertex), found through a bucket grid.
    std::vector<float> bandP;
    std::vector<uint32_t> bandTri;
    float bx0 = 0, bz0 = 0;
    int bCols = 0, bRows = 0;
    std::vector<uint32_t> bStart, bList;   // bucket b's triangles: bList[bStart[b] .. bStart[b + 1])
    static constexpr float kBandCell = 4.0f;

    float gridAt(float x, float z) const {
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

    // The band's height at (x, z): the highest of its triangles over the
    // point, -1e30 where none is.
    float bandAt(float x, float z) const {
        if (bStart.empty()) return -1e30f;
        const int c = (int) std::floor((x - bx0) / kBandCell), r = (int) std::floor((z - bz0) / kBandCell);
        if (c < 0 || r < 0 || c >= bCols || r >= bRows) return -1e30f;
        const size_t b = (size_t) r * bCols + c;
        float best = -1e30f;
        for (uint32_t k = bStart[b]; k < bStart[b + 1]; k++) {
            const uint32_t* t = &bandTri[3 * (size_t) bList[k]];
            const float* p0 = &bandP[3 * (size_t) t[0]];
            const float* p1 = &bandP[3 * (size_t) t[1]];
            const float* p2 = &bandP[3 * (size_t) t[2]];
            const float ux = p1[0] - p0[0], uz = p1[2] - p0[2], vx = p2[0] - p0[0], vz = p2[2] - p0[2];
            const float den = ux * vz - uz * vx;
            if (std::fabs(den) < 1e-9f) continue;
            const float wx = x - p0[0], wz = z - p0[2];
            const float bu = (wx * vz - wz * vx) / den, bv = (ux * wz - uz * wx) / den;
            constexpr float E = -1e-5f;
            if (bu < E || bv < E || bu + bv > 1.0f - E) continue;
            best = std::max(best, p0[1] + (p1[1] - p0[1]) * bu + (p2[1] - p0[1]) * bv);
        }
        return best;
    }

    float at(float x, float z) const { return std::max(gridAt(x, z), bandAt(x, z)); }

    // Buckets every band triangle under each kBandCell square its box touches.
    void indexBand() {
        bStart.clear();
        bList.clear();
        bCols = bRows = 0;
        const size_t nt = bandTri.size() / 3;
        if (!nt) return;
        float ax = 1e30f, az = 1e30f, cx = -1e30f, cz = -1e30f;
        for (size_t i = 0; i < bandP.size(); i += 3) {
            ax = std::min(ax, bandP[i]); cx = std::max(cx, bandP[i]);
            az = std::min(az, bandP[i + 2]); cz = std::max(cz, bandP[i + 2]);
        }
        bx0 = ax;
        bz0 = az;
        bCols = (int) std::floor((cx - ax) / kBandCell) + 1;
        bRows = (int) std::floor((cz - az) / kBandCell) + 1;
        const auto span = [&](size_t t, int& c0, int& c1, int& r0, int& r1) {
            float tx0 = 1e30f, tz0 = 1e30f, tx1 = -1e30f, tz1 = -1e30f;
            for (int k = 0; k < 3; k++) {
                const float* p = &bandP[3 * (size_t) bandTri[3 * t + k]];
                tx0 = std::min(tx0, p[0]); tx1 = std::max(tx1, p[0]);
                tz0 = std::min(tz0, p[2]); tz1 = std::max(tz1, p[2]);
            }
            c0 = (int) std::floor((tx0 - bx0) / kBandCell); c1 = (int) std::floor((tx1 - bx0) / kBandCell);
            r0 = (int) std::floor((tz0 - bz0) / kBandCell); r1 = (int) std::floor((tz1 - bz0) / kBandCell);
        };
        bStart.assign((size_t) bCols * bRows + 1, 0);
        for (size_t t = 0; t < nt; t++) {
            int c0, c1, r0, r1;
            span(t, c0, c1, r0, r1);
            for (int r = r0; r <= r1; r++) for (int c = c0; c <= c1; c++) bStart[(size_t) r * bCols + c + 1]++;
        }
        for (size_t b = 1; b < bStart.size(); b++) bStart[b] += bStart[b - 1];
        bList.assign(bStart.back(), 0);
        std::vector<uint32_t> fill(bStart.begin(), bStart.end() - 1);
        for (size_t t = 0; t < nt; t++) {
            int c0, c1, r0, r1;
            span(t, c0, c1, r0, r1);
            for (int r = r0; r <= r1; r++) for (int c = c0; c <= c1; c++) bList[fill[(size_t) r * bCols + c]++] = (uint32_t) t;
        }
    }
};

}  // namespace rt
}  // namespace ttp
