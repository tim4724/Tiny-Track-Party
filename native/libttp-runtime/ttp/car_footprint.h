// car_footprint — the car contact shadow's SHAPE.
//
// The shadow the deck actually draws is one bilinear tap of the carShadow
// layer, and what that layer stamps is a ROUNDED RECT FITTED TO EACH MODEL.
// This header makes it: a per-model FOOTPRINT rasterized from the car's own
// triangles, the fit measured off that raster, and the closed-form evaluator
// the layer raster calls per texel.
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
// Stamp` lays the quad from six deck-projected points and evaluates the shape
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
// for the soft edge — exactly how the stamp quad is sized (`halfF`/`halfR`
// carry the same 1.45).
#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace ttp {
namespace rt {

// The frame a footprint is rasterized in.
struct FootprintSpec {
    int w = 64, h = 128;       // mask resolution (across, along)
    float overscan = 1.45f;    // footprint occupies 1/overscan of the frame
};

namespace footprint_detail {

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

// THE SHAPE: a rounded rectangle, in closed form.
//
// A mask would be PIXELS, and the layer raster would pay for that per texel —
// four bilinear taps of a 64x128 mask is sixteen clamped, scattered reads and a
// dozen lerps, and on an in-order TV core the misses cost more than the maths.
// This is the footprint as an expression: no mask, no bake, no store, and ONE
// evaluation because the antialiasing comes from `soft` (the caller sizes it
// from the texel footprint it already computes) rather than from supersampling.
//
// `u`, `v` are the stamp's own frame, the same one the footprint is drawn in —
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
//
// AN EVALUATOR, not just a function, because the layer raster calls it once per
// texel with everything but (u, v) fixed for the whole stamp: the constructor
// takes what is per-stamp, `operator()` what is per-texel. They are the same
// IEEE operations in the same order either way, so the split changes no bit;
// the `carfootprint` ctest holds a frozen copy of the one-call form to prove it.
struct RoundedRectEval {
    RoundedRectEval(float overscan, float corner, float soft,
            float fillXTail = 1.0f, float fillXNose = 1.0f, float fillZ = 1.0f) {
        ov = overscan;
        tail = fillXTail;
        fzDen = std::max(0.05f, fillZ);
        dX = fillXNose - fillXTail;
        r = std::min(0.999f, std::max(0.0f, corner));
        omr = 1.0f - r;
        e = std::max(1e-4f, soft);
        twoE = 2.0f * e;
        // zero()'s bounds. |q| past 1 + e on either axis is a whole ramp
        // outside the outline; 1e-3 and the 1.0001 factor are margin for the
        // few roundings between this bound and the evaluator's own |q|. The u
        // bound takes the WIDER end, which fillX's lerp cannot exceed while
        // both fills are positive, so anything else turns the test off.
        const float lim = 1.0f + e + 1e-3f;
        thrV = lim * fzDen * 1.0001f;
        thrU = lim * std::max(0.05f, std::max(fillXTail, fillXNose)) * 1.0001f;
        canZero = std::isfinite(overscan) && overscan > 0.0f && std::isfinite(e)
                && std::isfinite(fillXTail) && fillXTail > 0.0f
                && std::isfinite(fillXNose) && fillXNose > 0.0f
                && std::isfinite(fillZ) && fillZ > 0.0f;
    }

    float operator()(float u, float v) const {
        // Centre and scale so the footprint is |q| <= 1 on both axes. The width
        // interpolates tail (v = 0) to nose (v = 1), so unequal ends make the
        // four-cornered shape a symmetric trapezoid; the bent frame means `d`
        // is no longer an exact distance on slanted sides, which the soft ramp
        // does not care about.
        const float qy = (v * 2.0f - 1.0f) * ov / fzDen;
        const float t01 = std::min(1.0f, std::max(0.0f, 0.5f * (qy + 1.0f)));
        const float fillX = tail + dX * t01;
        const float qx = (u * 2.0f - 1.0f) * ov / std::max(0.05f, fillX);
        const float bx = std::fabs(qx) - omr;
        const float by = std::fabs(qy) - omr;
        const float mx = std::max(bx, 0.0f), my = std::max(by, 0.0f);
        // The rounded box's signed distance: outside via the corner arc, inside
        // via whichever edge is nearest. Negative inside, 0 on the outline.
        const float outside = std::sqrt(mx * mx + my * my);
        const float inside = std::min(std::max(bx, by), 0.0f);
        const float d = outside + inside - r;
        // A smoothstep over the ramp, so the edge lands soft.
        const float t = std::min(1.0f, std::max(0.0f, (e - d) / twoE));
        return t * t * (3.0f - 2.0f * t);
    }

    // True only where operator() is EXACTLY +0, so a caller that would only
    // max() that zero into a non-negative store may skip the evaluation. It
    // tests the same rounded |2v-1|*overscan the evaluator divides; a NaN on
    // either axis answers false and is left to the evaluator.
    bool zero(float u, float v) const {
        const float pu = std::fabs(u * 2.0f - 1.0f) * ov;
        const float pv = std::fabs(v * 2.0f - 1.0f) * ov;
        if (!canZero || std::isnan(pu) || std::isnan(pv)) return false;
        return pv >= thrV || pu >= thrU;
    }

private:
    float ov, tail, fzDen, dX, r, omr, e, twoE;
    float thrU, thrV;
    bool canZero;
};

inline float rounded_rect_coverage(float u, float v, float overscan,
        float corner, float soft,
        float fillXTail = 1.0f, float fillXNose = 1.0f, float fillZ = 1.0f) {
    return RoundedRectEval(overscan, corner, soft, fillXTail, fillXNose, fillZ)(u, v);
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
// back to the default fit. A car whose outline came out blank must NOT be drawn
// as a blank shadow — a bake that silently shipped an empty silhouette is the
// standing lesson here.
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
    return a;
}

}  // namespace rt
}  // namespace ttp
