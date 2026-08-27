// car_footprint — the car contact shadow's SHAPE, as pixels.
//
// The shadow the deck actually draws is one bilinear tap of the carShadow
// layer, and what that layer stamps is a small greyscale mask. This header
// makes those masks: the generic superellipse that every car used to share,
// and a per-model FOOTPRINT rasterized from the car's own triangles.
//
// HEADER-ONLY ON PURPOSE, for the reason `glb_mesh.h` beside it gives: the
// renderer and libttp-runtime may not link each other (native/CLAUDE.md), and
// a shape the picture depends on should be executed by a ctest on every leg
// rather than compiled only where the Filament SDK is.
//
// **THE FOUR ROSTER CARS HAVE THE SAME BOUNDING BOX** (x ±0.26..0.28,
// z ±0.438, all four origin-centred), so a footprint sized off the AABB is the
// only thing that can tell them apart — the box cannot. What differs is the
// outline inside it: where the body pinches at the cabin, how far the wheels
// poke past it, how long the tail runs.
//
// THE MASK'S FRAME, and it is the stamp's, not the model's. `rasterCarShadow-
// Stamp` lays the quad from six deck-projected points and samples this mask
// with u ACROSS the car and v ALONG it, so:
//
//     u = 0 -> the car's LEFT edge      v = 0 -> BEHIND the car (its tail)
//     u = 1 -> the car's RIGHT edge     v = 1 -> IN FRONT of it (its nose)
//
// and the kit's cars are modelled nose toward -Z under the renderer's base
// half-turn (`FLIP`), so in MODEL space that is `x = (0.5 - u) * ...` and
// `z = (0.5 - v) * ...` — both axes negated. Getting v backwards puts every
// car's shadow on back to front, which on a symmetric car is the only sign
// that can show. See [[kit-car-facing-convention]].
//
// The footprint occupies `1/overscan` of the frame, leaving the rest as room
// for the blur tail — exactly how the stamp quad is sized (`halfF`/`halfR`
// carry the same 1.45) and how the JS bake framed its own.
#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace ttp {
namespace rt {

// How a mask is finished, once its coverage is known. Every field is a knob the
// display's shadow-tuning ABI carries, because the readable size of a footprint
// at the layer's ~8 texels/u is a LOOK question that has to be judged on a
// television and not argued from a number here.
struct FootprintSpec {
    int w = 64, h = 128;       // mask resolution (across, along)
    float overscan = 1.45f;    // footprint occupies 1/overscan of the frame
    // Dilate, as a fraction of the FOOTPRINT's half-width. A shadow is not a
    // razor projection of the body, and the layer minifies this mask hard — a
    // wheel that pokes out by one mask texel is gone by the time it is a layer
    // texel. Footprint only; the superellipse has no thin features to save.
    float grow = 0.0f;
    // The superellipse's analytic edge ramp, in the same units as `grow`.
    // FOOTPRINT MASKS DO NOT USE IT and must not: their edge is already
    // antialiased by the supersampled raster, and `blur` is where their
    // penumbra comes from. An analytic ramp on top would only be a second
    // softness knob fighting the first.
    float feather = 0.06f;
    // Box blur radius as a fraction of `w`, three separable passes ~ a
    // Gaussian. 0.022 is the JS bake's own radius and the shipped value. This
    // is THE penumbra, and it is not decoration: the mask is minified by the
    // layer raster and a hard edge point-sampled under per-frame sub-texel
    // slide flickers. Zero means zero — a caller asking for no blur gets none.
    float blur = 0.022f;
};

namespace footprint_detail {

// Three separable box passes ~ the canvas filter's Gaussian, at the same
// radius. Outside the frame reads ZERO (the tail has to be able to fall off),
// which is why the divisor counts every tap and not just the in-bounds ones.
inline void box_blur3(std::vector<float>& a, int W, int H, int R) {
    if (R < 1) return;
    std::vector<float> tmp(a.size());
    const auto pass = [&](std::vector<float>& src, std::vector<float>& dst, bool horiz) {
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++) {
                float s = 0;
                int n = 0;
                for (int k = -R; k <= R; k++) {
                    const int px = horiz ? x + k : x, py = horiz ? y : y + k;
                    n++;
                    if (px < 0 || px >= W || py < 0 || py >= H) continue;  // outside = 0
                    s += src[(size_t) py * W + px];
                }
                dst[(size_t) y * W + x] = s / (float) n;
            }
    };
    for (int i = 0; i < 3; i++) {
        pass(a, tmp, true);
        pass(tmp, a, false);
    }
}

// Grow a coverage field by `r` pixels with a separable MAX filter — valid for a
// square structuring element, and exact at the only radii that matter here
// (these shapes are a few dozen pixels across, so a distance transform would be
// machinery for nothing).
inline void dilate(std::vector<float>& a, int W, int H, float r) {
    const int ri = (int) std::lround(r);
    if (ri < 1) return;
    std::vector<float> tmp(a.size());
    const auto pass = [&](std::vector<float>& src, std::vector<float>& dst, bool horiz) {
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++) {
                float m = 0;
                for (int k = -ri; k <= ri; k++) {
                    const int px = horiz ? x + k : x, py = horiz ? y : y + k;
                    if (px < 0 || px >= W || py < 0 || py >= H) continue;
                    m = std::max(m, src[(size_t) py * W + px]);
                }
                dst[(size_t) y * W + x] = m;
            }
    };
    pass(a, tmp, true);
    pass(tmp, a, false);
}

// One triangle's coverage into a supersampled buffer, by the same top-left rule
// the layer raster uses. Coverage is a UNION — no depth, no winding — because
// the answer wanted is the model's silhouette from above, and every triangle
// of a closed body projects inside it.
inline void raster_tri(std::vector<float>& a, int W, int H,
        float ax, float ay, float bx, float by, float cx, float cy) {
    const float area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (area == 0.0f) return;
    // Wind consistently so the edge functions share a sign.
    if (area < 0.0f) {
        std::swap(bx, cx);
        std::swap(by, cy);
    }
    const int x0 = std::max(0, (int) std::floor(std::min(ax, std::min(bx, cx))));
    const int x1 = std::min(W - 1, (int) std::ceil(std::max(ax, std::max(bx, cx))));
    const int y0 = std::max(0, (int) std::floor(std::min(ay, std::min(by, cy))));
    const int y1 = std::min(H - 1, (int) std::ceil(std::max(ay, std::max(by, cy))));
    const auto edge = [](float e0x, float e0y, float e1x, float e1y, float px, float py) {
        return (e1x - e0x) * (py - e0y) - (e1y - e0y) * (px - e0x);
    };
    for (int y = y0; y <= y1; y++) {
        const float py = (float) y + 0.5f;
        for (int x = x0; x <= x1; x++) {
            const float px = (float) x + 0.5f;
            if (edge(ax, ay, bx, by, px, py) >= 0
                    && edge(bx, by, cx, cy, px, py) >= 0
                    && edge(cx, cy, ax, ay, px, py) >= 0) {
                a[(size_t) y * W + x] = 1.0f;
            }
        }
    }
}

}  // namespace footprint_detail

// The generic shape, and the fallback whenever a model's own triangles are not
// available: a cubic superellipse fitted to the same footprint. Rounder corners
// than any real car, same size, same softness.
//
// The PENUMBRA is not decoration. This mask is MINIFIED by the layer raster
// (one point sample per ~6-8 mask texels), and a binary edge point-sampled
// under per-frame sub-texel slide flickers. Half a footprint of analytic
// feather is the filter that sample never had.
inline std::vector<float> superellipse_mask(const FootprintSpec& spec) {
    const int W = std::max(1, spec.w), H = std::max(1, spec.h);
    std::vector<float> a((size_t) W * H, 0.0f);
    const float hw = (W * 0.5f) / spec.overscan, hl = (H * 0.5f) / spec.overscan;
    for (int y = 0; y < H; y++) {
        for (int x = 0; x < W; x++) {
            const float dx = std::fabs(x + 0.5f - W * 0.5f) / hw;
            const float dz = std::fabs(y + 0.5f - H * 0.5f) / hl;
            const float q = std::cbrt(dx * dx * dx + dz * dz * dz);  // 1 at the edge
            const float e0 = 1.0f - spec.feather * 2.0f, e1 = e0 + 0.24f;
            a[(size_t) y * W + x] =
                    1.0f - std::min(1.0f, std::max(0.0f, (q - e0) / std::max(1e-4f, e1 - e0)));
        }
    }
    footprint_detail::box_blur3(a, W, H, std::max(2, (int) std::lround(W * spec.blur)));
    return a;
}

// THE CHEAP SHAPE: a rounded rectangle, in closed form.
//
// The two masks above are PIXELS, and the layer raster pays for that per texel —
// four bilinear taps of a 64x128 mask is sixteen clamped, scattered reads and a
// dozen lerps, and on an in-order TV core the misses cost more than the maths.
// This is the same footprint as an expression: no mask, no bake, no store, and
// ONE evaluation instead of four because the antialiasing comes from `soft`
// (the caller sizes it from the texel footprint it already computes) rather
// than from supersampling.
//
// `u`, `v` are the stamp's own frame, the same one the masks are drawn in —
// (0,0) is the car's left/tail corner, (1,1) its right/nose corner. `overscan`
// says how much of that frame the footprint occupies, exactly as above.
// `corner` is the corner radius as a fraction of the half-extent: 0 is a hard
// rectangle, 1 an ellipse. `soft` is the edge ramp's half-width in the same
// units.
//
// It is ISOTROPIC IN THE STAMP'S FRAME and therefore not in the world: a car is
// longer than it is wide, so one corner radius here is a longer curve along the
// car than across it. That is the right way round for a car and it is free.
// `fillX` / `fillZ` shrink the shape inside that frame, which is how one
// expression serves every model: a body that does not reach its own bounding
// box gets a smaller rect, at no cost.
inline float rounded_rect_coverage(float u, float v, float overscan,
        float corner, float soft,
        float fillXTail = 1.0f, float fillXNose = 1.0f, float fillZ = 1.0f) {
    // Centre and scale so the footprint is |q| <= 1 on both axes. The width
    // interpolates tail (v = 0) to nose (v = 1), so unequal ends make the
    // four-cornered shape a symmetric trapezoid; the bent frame means `d` is
    // no longer an exact distance on slanted sides, which the soft ramp does
    // not care about.
    const float qy = (v * 2.0f - 1.0f) * overscan / std::max(0.05f, fillZ);
    const float t01 = std::min(1.0f, std::max(0.0f, 0.5f * (qy + 1.0f)));
    const float fillX = fillXTail + (fillXNose - fillXTail) * t01;
    const float qx = (u * 2.0f - 1.0f) * overscan / std::max(0.05f, fillX);
    const float r = std::min(0.999f, std::max(0.0f, corner));
    const float bx = std::fabs(qx) - (1.0f - r);
    const float by = std::fabs(qy) - (1.0f - r);
    const float mx = std::max(bx, 0.0f), my = std::max(by, 0.0f);
    // The rounded box's signed distance: outside via the corner arc, inside via
    // whichever edge is nearest. Negative inside, 0 on the outline.
    const float outside = std::sqrt(mx * mx + my * my);
    const float inside = std::min(std::max(bx, by), 0.0f);
    const float d = outside + inside - r;
    const float e = std::max(1e-4f, soft);
    // A smoothstep over the ramp, so the edge lands like the masks' blur.
    const float t = std::min(1.0f, std::max(0.0f, (e - d) / (2.0f * e)));
    return t * t * (3.0f - 2.0f * t);
}

// A rounded rect FITTED TO ONE MODEL, so the cheap shape is still per-car.
//
// This is the whole point of the analytic path being parameterised: the raster
// evaluates one expression either way, so a shape fitted to THIS car costs
// exactly what a generic one costs. What it cannot carry is the wheel notches —
// a rounded rect has no vocabulary for them — but it does carry the four
// things that actually differ between these models at the layer's density: how
// much of the bounding box the body fills at the tail, at the nose, how much
// along, and how sharply the corners are cut.
//
// Fitted by MATCHING, not by search: the widths come off the central
// silhouette's own rows, the radius from the AREA left inside them — a
// rounded rect of half-extents (1,1) and radius r has area 4 - (4-pi)r², so r
// falls straight out of the covered fraction. One pass over the mask, once per
// model, at bake time.
// The tail and nose carry their own widths, so the four-cornered shape is a
// symmetric TRAPEZOID when the model asks for one and a rect when it does not.
struct RoundedFit {
    float fillXTail = 1.0f; // half-width at the TAIL (v = 0), fraction of the box's
    float fillXNose = 1.0f; // …and at the NOSE (v = 1)
    float fillZ = 1.0f;     // half-length, likewise
    float corner = 0.42f;   // corner radius, as a fraction of the half-extent
};

// FITTED TO THE FULL EXTENT — WHEELS INCLUDED — OVER THE CAR'S WIDE SPAN,
// with short skinny OVERHANGS trimmed off the ends. Two user rounds set the
// two halves of this rule. Wheels count (a shadow narrower than the tyres
// reads as floating rubber — the central-silhouette fit that excluded a
// detached wheel is REVERTED). And the box does not stretch to a narrow
// overhang: an open-wheeler's rear bumper tip is ~16 of 44 texels wide for a
// few rows past the rear wheels, and a rectangle spanning it either
// overshoots the tip's width or (as a trapezoid) starves the wheels. So each
// end is trimmed while it is narrower than ~55% of the car's widest point —
// clamped to a SIXTH of the length per end, so a long genuine taper is never
// eaten (the trapezoid widths carry it instead) and only bumper-class
// overhangs fall outside the shadow, the way ground shading reads under a
// real overhang anyway.
inline RoundedFit fit_rounded_rect(const std::vector<float>& mask,
        const FootprintSpec& spec) {
    RoundedFit fit;
    const int W = std::max(1, spec.w), H = std::max(1, spec.h);
    if (mask.size() < (size_t) W * H) return fit;
    // The footprint's own half-extents in mask pixels — everything outside is
    // the overscan margin and no part of the shape.
    const float hw = (W * 0.5f) / spec.overscan, hh = (H * 0.5f) / spec.overscan;
    // Per row: the EXTENT half-width (widest coverage, wheels included), the
    // row's covered pixel count for the area, and the signed dz (+ = tail).
    std::vector<float> ew((size_t) H, -1.0f);
    std::vector<float> rowPx((size_t) H, 0.0f);
    float wMax = 0;
    int yTail = -1, yNose = -1;   // first/last occupied rows (tail = small y)
    for (int y = 0; y < H; y++) {
        const float dz = std::fabs(y + 0.5f - H * 0.5f) / hh;
        if (dz > 1.0f) continue;
        float half = 0, px = 0;
        for (int x = 0; x < W; x++) {
            if (mask[(size_t) y * W + x] <= 0.5f) continue;
            const float dx = std::fabs(x + 0.5f - W * 0.5f) / hw;
            if (dx > 1.0f) continue;
            half = std::max(half, dx);
            px += 1.0f;
        }
        if (px <= 0.0f) continue;
        ew[y] = half;
        rowPx[y] = px;
        wMax = std::max(wMax, half);
        if (yTail < 0) yTail = y;
        yNose = y;
    }
    if (yTail < 0 || yNose <= yTail || !(wMax > 0.0f)) return fit;
    // Trim the overhangs: walk each end inward while the extent stays under
    // the wide-span threshold, at most a sixth of the occupied length each.
    const int maxTrim = (yNose - yTail + 1) / 6;
    int yT = yTail, yN = yNose;
    for (int n = 0; n < maxTrim && yT < yN; n++) {
        if (!(ew[yT] < 0.55f * wMax)) break;
        do { yT++; } while (yT < yN && ew[yT] < 0.0f);
    }
    for (int n = 0; n < maxTrim && yN > yT; n++) {
        if (!(ew[yN] < 0.55f * wMax)) break;
        do { yN--; } while (yN > yT && ew[yN] < 0.0f);
    }
    // Widths per end: the MEDIAN extent of each end's outer sixth of the
    // trimmed span — robust to a stray row, and what keeps a genuine taper a
    // trapezoid while a boxy car stays a rect.
    const int span = yN - yT + 1;
    const int sixth = std::max(1, span / 6);
    std::vector<float> tailRows, noseRows;
    float covered = 0;
    for (int y = yT; y <= yN; y++) {
        if (ew[y] < 0.0f) continue;
        covered += rowPx[y];
        if (y < yT + sixth) tailRows.push_back(ew[y]);
        if (y > yN - sixth) noseRows.push_back(ew[y]);
    }
    if (tailRows.empty() || noseRows.empty() || covered <= 0.0f) return fit;
    std::sort(tailRows.begin(), tailRows.end());
    std::sort(noseRows.begin(), noseRows.end());
    const float wTail = tailRows[tailRows.size() / 2];
    const float wNose = noseRows[noseRows.size() / 2];
    if (!(wTail > 0.0f) || !(wNose > 0.0f)) return fit;
    fit.fillXTail = wTail;
    fit.fillXNose = wNose;
    const float zT = (H * 0.5f - (yT + 0.5f)) / hh;   // tail end, + = tail
    const float zN = (H * 0.5f - (yN + 0.5f)) / hh;
    fit.fillZ = std::min(1.0f, std::max(std::fabs(zT), std::fabs(zN)));
    // The area of the trapezoid the silhouette actually fills. CAPPED: a car
    // with detached wheels leaves the gaps out of `covered` while the box
    // spans them, and the uncapped formula inflated exactly those cars into
    // ellipses. Past ~0.6 the shape stops reading as four corners at all,
    // which is the look this fit exists to keep.
    const float meanW = 0.5f * (wTail + wNose);
    const float boxPixels = (2.0f * hw * meanW) * (float) span;
    const float frac = boxPixels > 0.0f ? covered / boxPixels : 1.0f;
    // area = 4 - (4-pi)r²  over a 2x2 box  ->  r = sqrt((1-frac)*4/(4-pi))
    constexpr float kPi = 3.14159265358979323846f;
    const float r2 = (1.0f - std::min(1.0f, frac)) * 4.0f / (4.0f - kPi);
    fit.corner = std::min(0.6f, std::max(0.0f, std::sqrt(std::max(0.0f, r2))));
    return fit;
}

// A CONVEX POLYGON fitted to one model — the shape between the rounded rect
// and the outline mask. The rect cannot say "tapered" or "short wheelbase at
// the front"; the outline mask can, but its wheel notches are thin features
// the soft edge boils on and its raster costs sixteen reads a texel. A convex
// hull simplified to a handful of edges carries the taper and the asymmetry,
// stays lobeless by construction, and still evaluates in closed form.
//
// THE FRAME IS THE FOOTPRINT'S q-FRAME: the model's AABB maps to |q| <= 1 on
// both axes (anisotropic on purpose, like the rect's own frame), with both
// axes NEGATED per the kit-facing convention — +q.y is the NOSE. Half-planes
// are inside-iff `dot(n, q) <= d` with n unit-length in that frame.
struct PolyFit {
    static constexpr int kMaxEdges = 12;
    int count = 0;               // 0 = no fit; the caller falls back to the rect
    float nx[kMaxEdges] = {};
    float ny[kMaxEdges] = {};
    float d[kMaxEdges] = {};
};

namespace footprint_detail {

// Andrew's monotone chain over (x, y) pairs, answering a CCW hull.
inline std::vector<std::array<float, 2>> convex_hull(std::vector<std::array<float, 2>> p) {
    std::sort(p.begin(), p.end());
    p.erase(std::unique(p.begin(), p.end()), p.end());
    const size_t n = p.size();
    if (n < 3) return {};
    const auto cross = [](const std::array<float, 2>& o, const std::array<float, 2>& a,
            const std::array<float, 2>& b) {
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    };
    std::vector<std::array<float, 2>> h(2 * n);
    size_t k = 0;
    for (size_t i = 0; i < n; i++) {
        while (k >= 2 && cross(h[k - 2], h[k - 1], p[i]) <= 0) k--;
        h[k++] = p[i];
    }
    for (size_t i = n - 1, t = k + 1; i-- > 0;) {
        while (k >= t && cross(h[k - 2], h[k - 1], p[i]) <= 0) k--;
        h[k++] = p[i];
    }
    h.resize(k - 1);
    return h;
}

}  // namespace footprint_detail

// Fit a convex `edges`-gon around a model's projected vertices.
//
// CONTAINMENT-PRESERVING simplification: the hull is reduced one vertex at a
// time by extending that vertex's two neighbouring edges to their
// intersection — the polygon only ever GROWS, so every projected vertex stays
// inside and the shadow can never be smaller than the car. The vertex removed
// is always the one whose removal adds the least area, which is what keeps
// the taper and sheds the noise. SYMMETRIZED in x before hulling: the kit's
// cars are left-right symmetric and the capture is not exactly, and a shadow
// that leans is the one asymmetry an eye always catches.
//
// Answers count == 0 (fall back to the rect) rather than a degenerate shape:
// too few points, a collapsed extent, or an interior numerically too thin.
inline PolyFit fit_convex_poly(const float* xz, size_t vertCount,
        float halfX, float halfZ, int edges) {
    PolyFit out;
    if (!xz || vertCount < 3 || !(halfX > 0.0f) || !(halfZ > 0.0f)) return out;
    edges = std::min((int) PolyFit::kMaxEdges, std::max(3, edges));
    // Model -> q, both axes negated (kit noses toward -z under the base FLIP).
    std::vector<std::array<float, 2>> pts;
    pts.reserve(vertCount * 2);
    for (size_t i = 0; i < vertCount; i++) {
        const float qx = -xz[i * 2] / halfX, qy = -xz[i * 2 + 1] / halfZ;
        pts.push_back({ qx, qy });
        pts.push_back({ -qx, qy });   // the mirror IS the symmetrization
    }
    std::vector<std::array<float, 2>> hull = footprint_detail::convex_hull(std::move(pts));
    if (hull.size() < 3) return out;
    const auto area2 = [](const std::vector<std::array<float, 2>>& v) {
        float s = 0;
        for (size_t i = 0; i < v.size(); i++) {
            const auto& a = v[i];
            const auto& b = v[(i + 1) % v.size()];
            s += a[0] * b[1] - b[0] * a[1];
        }
        return s;   // CCW positive, twice the area
    };
    while ((int) hull.size() > edges) {
        // Removing vertex i extends edges (i-1 -> i) and (i+1 -> i+2) to their
        // intersection; the added area is the triangle (v[i], x, v[i+1])... in
        // vertex terms: replace v[i] and v[i+1]? No — one REMOVAL takes out
        // vertex i and replaces it with the intersection of its neighbouring
        // edges' lines, so the polygon keeps one vertex per remaining edge.
        const size_t n = hull.size();
        float bestAdd = 0;
        int best = -1;
        std::array<float, 2> bestX{};
        for (size_t i = 0; i < n; i++) {
            const auto& p0 = hull[(i + n - 1) % n];
            const auto& p1 = hull[i];
            const auto& p2 = hull[(i + 1) % n];
            const auto& p3 = hull[(i + 2) % n];
            // Lines p0->p1 and p3->p2 (both directed toward the removed side).
            const float d1x = p1[0] - p0[0], d1y = p1[1] - p0[1];
            const float d2x = p2[0] - p3[0], d2y = p2[1] - p3[1];
            const float den = d1x * d2y - d1y * d2x;
            if (std::fabs(den) < 1e-6f) continue;   // near-parallel: skip
            const float t = ((p3[0] - p0[0]) * d2y - (p3[1] - p0[1]) * d2x) / den;
            if (t < 1.0f) continue;                 // intersection behind p1: concave turn
            const std::array<float, 2> x{ p0[0] + d1x * t, p0[1] + d1y * t };
            // Added area = triangle (p1, x, p2).
            const float add = 0.5f * std::fabs((x[0] - p1[0]) * (p2[1] - p1[1])
                                             - (p2[0] - p1[0]) * (x[1] - p1[1]));
            if (best < 0 || add < bestAdd) { best = (int) i; bestAdd = add; bestX = x; }
        }
        if (best < 0) break;   // nothing removable without breaking convexity
        std::vector<std::array<float, 2>> next;
        next.reserve(n - 1);
        for (size_t i = 0; i < n; i++) {
            if ((int) i == best) { next.push_back(bestX); continue; }
            if ((int) ((best + 1) % (int) n) == (int) i) continue;
            next.push_back(hull[i]);
        }
        hull = std::move(next);
    }
    if ((int) hull.size() > PolyFit::kMaxEdges || area2(hull) < 0.05f) return out;
    for (size_t i = 0; i < hull.size(); i++) {
        const auto& a = hull[i];
        const auto& b = hull[(i + 1) % hull.size()];
        // CCW winding: the outward normal of a->b is (dy, -dx).
        float nx = b[1] - a[1], ny = -(b[0] - a[0]);
        const float len = std::sqrt(nx * nx + ny * ny);
        if (len < 1e-6f) continue;
        nx /= len; ny /= len;
        out.nx[out.count] = nx;
        out.ny[out.count] = ny;
        out.d[out.count] = nx * a[0] + ny * a[1];
        out.count++;
    }
    if (out.count < 3) out.count = 0;
    return out;
}

// TWO LOBES, so the fit does not have to be convex — only LOBELESS. A single
// hull bridges a car's waist: the wheels poke past the body at the axles, and
// the hull's side runs wheel-to-wheel over the pinch between them. Splitting
// the outline at its narrowest section and hulling each half separately puts
// the pinch back — the UNION of two convex lobes is concave there — while
// each lobe keeps every closed-form and containment property of the single
// hull. What this still cannot say is a NOTCH, deliberately: notches are the
// thin features the soft edge boils on, and they stay the outline mask's job.
//
// The split only happens when it earns its second evaluation: a body whose
// waist is not measurably narrower than both of its ends (a monotone taper, a
// plain box) answers one lobe and a count-0 second.
//
// THE WIDTH PROFILE COMES FROM THE MASK, NEVER FROM THE VERTICES. A long body
// triangle spans the middle of the car while depositing vertices only at its
// ends, so a vertex histogram reads the mid-body as whatever small parts
// happen to have vertices there — a phantom waist that split every boxy car
// into an hourglass. The rasterized mask is the silhouette truth the caller
// already has.
inline std::array<PolyFit, 2> fit_convex_poly_lobes(const float* xz, size_t vertCount,
        const uint32_t* idx, size_t idxCount,
        float halfX, float halfZ, int edges,
        const std::vector<float>& mask, const FootprintSpec& spec) {
    std::array<PolyFit, 2> out{};
    if (!xz || vertCount < 3 || !(halfX > 0.0f) || !(halfZ > 0.0f)) {
        return out;
    }
    const int W = std::max(1, spec.w), H = std::max(1, spec.h);
    // Per-row silhouette half-width, as a fraction of the footprint's own
    // half-width; -1 where the row is empty. Row y maps to model z through the
    // same frame car_footprint_mask draws in (row 0 = tail = +z).
    std::vector<float> w((size_t) H, -1.0f);
    const float hw = (W * 0.5f) / spec.overscan, hh = (H * 0.5f) / spec.overscan;
    if (mask.size() >= (size_t) W * H) {
        for (int y = 0; y < H; y++) {
            const float dz = std::fabs(y + 0.5f - H * 0.5f) / hh;
            if (dz > 1.0f) continue;   // overscan margin, no part of the shape
            for (int x = 0; x < W; x++) {
                if (mask[(size_t) y * W + x] <= 0.5f) continue;
                w[y] = std::max(w[y], std::fabs(x + 0.5f - W * 0.5f) / hw);
            }
        }
    }
    // The waist: the narrowest occupied row of the middle half — and on a tie,
    // the CENTRE of the longest narrowest run. A flat-bottomed pinch ties over
    // its whole span, and splitting at the run's end leaves one lobe holding
    // both wide ends of the car, which bridges exactly what the split exists
    // to stop. Then the widest row on each side; a pinch is real when BOTH
    // sides are wider.
    float wmin = -1.0f;
    for (int y = H / 4; y < 3 * H / 4; y++) {
        if (w[y] < 0.0f) continue;
        if (wmin < 0.0f || w[y] < wmin) wmin = w[y];
    }
    int waist = -1;
    if (wmin >= 0.0f) {
        int bestLen = 0, run0 = -1;
        for (int y = H / 4; y <= 3 * H / 4; y++) {
            const bool narrow = y < 3 * H / 4 && w[y] >= 0.0f && w[y] <= wmin + 0.01f;
            if (narrow && run0 < 0) run0 = y;
            if (!narrow && run0 >= 0) {
                if (y - run0 > bestLen) { bestLen = y - run0; waist = run0 + (y - run0) / 2; }
                run0 = -1;
            }
        }
    }
    float wideLo = -1.0f, wideHi = -1.0f;
    if (waist >= 0) {
        for (int y = 0; y < waist; y++) wideLo = std::max(wideLo, w[y]);
        for (int y = waist + 1; y < H; y++) wideHi = std::max(wideHi, w[y]);
    }
    const bool pinched = waist >= 0 && wideLo > 0.0f && wideHi > 0.0f
            && w[waist] < 0.93f * std::min(wideLo, wideHi);
    if (!pinched) {
        out[0] = fit_convex_poly(xz, vertCount, halfX, halfZ, edges);
        return out;
    }
    // Split there, each half taking an overlap band so the union has no seam.
    // SPLITTING POINTS ALONE LEAVES A HOLE: a triangle spanning the waist has
    // vertices only at its far ends, so neither half would cover the middle —
    // every triangle edge that crosses the split plane therefore contributes
    // its interpolated crossing to BOTH lobes, which is what carries the
    // silhouette's true width at the seam into each hull.
    const float zSplit = (H * 0.5f - (waist + 0.5f)) / hh * halfZ;   // row -> model z
    const float band = 0.10f * halfZ;
    std::vector<float> lo, hi;
    for (size_t i = 0; i < vertCount; i++) {
        const float x = xz[i * 2], z = xz[i * 2 + 1];
        if (z <= zSplit + band) { lo.push_back(x); lo.push_back(z); }
        if (z >= zSplit - band) { hi.push_back(x); hi.push_back(z); }
    }
    if (idx) {
        // Each lobe clips at ITS OWN band edge, not at the split itself: two
        // hulls that merely touch read coverage 0.5 each at the seam, and the
        // union dips there. Overlapping by the full band keeps the seam solid.
        const auto clipInto = [&](std::vector<float>& dst, float zc) {
            for (size_t t = 0; t + 2 < idxCount; t += 3) {
                for (int e = 0; e < 3; e++) {
                    const uint32_t ia = idx[t + e], ib = idx[t + (e + 1) % 3];
                    if (ia >= vertCount || ib >= vertCount) continue;
                    const float za = xz[ia * 2 + 1], zb = xz[ib * 2 + 1];
                    if ((za - zc) * (zb - zc) > 0.0f || za == zb) continue;
                    const float s = (zc - za) / (zb - za);
                    dst.push_back(xz[ia * 2] + s * (xz[ib * 2] - xz[ia * 2]));
                    dst.push_back(zc);
                }
            }
        };
        clipInto(lo, zSplit + band);
        clipInto(hi, zSplit - band);
    }
    out[0] = fit_convex_poly(lo.data(), lo.size() / 2, halfX, halfZ, edges);
    out[1] = fit_convex_poly(hi.data(), hi.size() / 2, halfX, halfZ, edges);
    // Half a fit is worse than no split: the missing lobe would draw as a car
    // cut in half. Fall back to the single hull.
    if (out[0].count < 3 || out[1].count < 3) {
        out[0] = fit_convex_poly(xz, vertCount, halfX, halfZ, edges);
        out[1] = PolyFit{};
    }
    return out;
}

// The polygon as coverage, in the same (u, v) stamp frame and with the same
// smoothstep ramp as `rounded_rect_coverage`. `corner` rounds by pulling the
// faces in and letting the max-of-planes field bulge back out at the
// vertices — not the exact Euclidean corner arc, but within a texel of it at
// these radii, and free.
inline float convex_poly_coverage(float u, float v, float overscan,
        const PolyFit& p, float corner, float soft) {
    if (p.count < 3) return 0.0f;
    const float qx = (u * 2.0f - 1.0f) * overscan;
    const float qy = (v * 2.0f - 1.0f) * overscan;
    const float r = std::max(0.0f, corner);
    float d = -1e9f;
    for (int i = 0; i < p.count; i++) {
        d = std::max(d, p.nx[i] * qx + p.ny[i] * qy - (p.d[i] - r));
    }
    d -= r;
    const float e = std::max(1e-4f, soft);
    const float t = std::min(1.0f, std::max(0.0f, (e - d) / (2.0f * e)));
    return t * t * (3.0f - 2.0f * t);
}

// A model's own top-down outline.
//
//   xz          2 floats per vertex, MODEL space (x, z), any node transform
//               already applied by the caller — the renderer has gltfio's world
//               transforms and this header has no business knowing a hierarchy.
//   idx         triangle indices into those vertices
//   halfX/halfZ the footprint half-extents the STAMP is sized to (the model's
//               AABB extents halved), so the mask and the quad agree on scale.
//
// Returns an empty vector when there is nothing to rasterize; the caller falls
// back to `superellipse_mask`. A car whose outline came out blank must NOT be
// drawn as a blank shadow — the bake that silently shipped an empty silhouette
// layer is the standing lesson here.
inline std::vector<float> car_footprint_mask(const float* xz, size_t vertCount,
        const uint32_t* idx, size_t idxCount,
        float halfX, float halfZ, const FootprintSpec& spec) {
    const int W = std::max(1, spec.w), H = std::max(1, spec.h);
    if (!xz || !idx || idxCount < 3 || vertCount < 3
            || !(halfX > 0.0f) || !(halfZ > 0.0f)) {
        return {};
    }
    // SUPERSAMPLE, then box down. The mask is tens of pixels across and a car's
    // wheels poke past its body by a couple of them; a one-sample-per-pixel
    // raster turns that into a stair, and the layer minifies whatever it is
    // given. Four times each way is the cheapest rate at which the outline
    // stops depending on where a triangle edge happens to fall.
    constexpr int SS = 4;
    const int SW = W * SS, SH = H * SS;
    std::vector<float> cov((size_t) SW * SH, 0.0f);
    // Model -> mask. Both axes negate: the kit faces -Z under the base FLIP, so
    // the car's nose (model -z) is v = 1, and its right (model -x) is u = 1.
    const float fx = (SW * 0.5f) / (halfX * spec.overscan);
    const float fz = (SH * 0.5f) / (halfZ * spec.overscan);
    const auto toMaskX = [&](float mx) { return SW * 0.5f - mx * fx; };
    const auto toMaskY = [&](float mz) { return SH * 0.5f - mz * fz; };
    for (size_t t = 0; t + 2 < idxCount; t += 3) {
        const uint32_t i0 = idx[t], i1 = idx[t + 1], i2 = idx[t + 2];
        if (i0 >= vertCount || i1 >= vertCount || i2 >= vertCount) return {};
        footprint_detail::raster_tri(cov, SW, SH,
                toMaskX(xz[i0 * 2]), toMaskY(xz[i0 * 2 + 1]),
                toMaskX(xz[i1 * 2]), toMaskY(xz[i1 * 2 + 1]),
                toMaskX(xz[i2 * 2]), toMaskY(xz[i2 * 2 + 1]));
    }
    // Grow while the resolution is still there to grow into — the dilation is
    // in FOOTPRINT half-widths, and the footprint is SW/overscan wide.
    footprint_detail::dilate(cov, SW, SH, spec.grow * (SW * 0.5f / spec.overscan));
    std::vector<float> a((size_t) W * H, 0.0f);
    float covered = 0.0f;
    constexpr float inv = 1.0f / (float) (SS * SS);
    for (int y = 0; y < H; y++) {
        for (int x = 0; x < W; x++) {
            float s = 0;
            for (int sy = 0; sy < SS; sy++) {
                const float* row = cov.data() + (size_t) (y * SS + sy) * SW + x * SS;
                for (int sx = 0; sx < SS; sx++) s += row[sx];
            }
            const float v = s * inv;
            a[(size_t) y * W + x] = v;
            covered += v;
        }
    }
    // A model that projected onto nothing is a failed bake, not a car with no
    // shadow. Say so by answering empty.
    if (covered <= 0.0f) return {};
    footprint_detail::box_blur3(a, W, H, (int) std::lround(W * spec.blur));
    return a;
}

}  // namespace rt
}  // namespace ttp
