// carfootprint_check — the car contact shadow's SHAPE (ttp/car_footprint.h),
// executed on every leg the way the four-legs rule wants header-inline library
// code to be. The renderer that consumes it is compiled by no ctest at all.
//
// No corpus and no oracle: what a shadow should LOOK like is a taste question
// the tuning page exists to answer. What this pins is the handful of claims the
// consumer cannot function without, and every one of them is a claim a silent
// mistake would satisfy just as well as a correct implementation:
//
//   * THE FRAME. The footprint lands at 1/overscan of the mask, centred, so a
//     mask and the stamp quad that samples it agree on scale.
//   * THE ORIENTATION. v = 1 is the car's NOSE. On a left-right symmetric car
//     this is the only axis whose sign can show, and getting it backwards
//     points every shadow the wrong way down the track.
//   * SHAPE SURVIVES. Two different outlines in the SAME bounding box come out
//     as different masks — which is the whole point, because the four roster
//     cars have all but identical AABBs.
//   * FAILURE IS EMPTY. Nothing to rasterize answers {} so the caller can fall
//     back, rather than a blank mask that draws as a car with no shadow.
//
// The geometry is synthesized here, so the check needs no fixture and cannot
// rot with the asset kit.

#include <cmath>
#include <cstdio>
#include <vector>

#include "ttp/car_footprint.h"

using ttp::rt::car_footprint_mask;
using ttp::rt::FootprintSpec;
using ttp::rt::rounded_rect_coverage;
using ttp::rt::superellipse_mask;

namespace {

int checked = 0, failed = 0;

void expect(bool ok, const char* what) {
    checked++;
    if (ok) return;
    failed++;
    std::fprintf(stderr, "FAIL %s\n", what);
}

// A box on the ground from (x0,z0) to (x1,z1), as two triangles appended to a
// flat (x, z) vertex list. Height is irrelevant — the projection is top-down.
void addQuad(std::vector<float>& xz, std::vector<uint32_t>& idx,
        float x0, float z0, float x1, float z1) {
    const uint32_t b = (uint32_t) (xz.size() / 2);
    xz.insert(xz.end(), { x0, z0, x1, z0, x1, z1, x0, z1 });
    idx.insert(idx.end(), { b, b + 1, b + 2, b, b + 2, b + 3 });
}

float at(const std::vector<float>& m, const FootprintSpec& s, int x, int y) {
    return m[(size_t) y * s.w + x];
}

// Mean coverage of a mask row, as a stand-in for "how wide is the shape here".
float rowMean(const std::vector<float>& m, const FootprintSpec& s, int y) {
    float t = 0;
    for (int x = 0; x < s.w; x++) t += at(m, s, x, y);
    return t / (float) s.w;
}

// The mask row a point ALONG THE FOOTPRINT lands on: 0 = the car's tail, 1 =
// its nose. Needed because the footprint is only 1/overscan of the mask — rows
// 0..19 and 109..127 of a 128-row mask are margin, and a test that samples
// there is measuring the blur tail rather than the shape.
int rowAlong(const FootprintSpec& s, float frac) {
    const float y = (float) s.h * (0.5f - (1.0f - 2.0f * frac) * 0.5f / s.overscan);
    return std::max(0, std::min(s.h - 1, (int) std::lround(y)));
}

}  // namespace

int main() {
    // A spec with the blur turned off wherever the test is measuring geometry:
    // three box passes smear every edge by design, and an assertion about WHERE
    // an edge is should not be reading the penumbra's tail.
    FootprintSpec sharp;
    sharp.w = 64;
    sharp.h = 128;
    sharp.blur = 0.0f;
    sharp.grow = 0.0f;

    // ── THE FRAME ───────────────────────────────────────────────────────────
    // A full-footprint rectangle: exactly the AABB the stamp is sized to. It
    // must fill 1/overscan of the mask on both axes, centred.
    {
        const float hx = 0.275f, hz = 0.438f;
        std::vector<float> xz;
        std::vector<uint32_t> idx;
        addQuad(xz, idx, -hx, -hz, hx, hz);
        const auto m = car_footprint_mask(xz.data(), xz.size() / 2,
                idx.data(), idx.size(), hx, hz, sharp);
        expect(m.size() == (size_t) sharp.w * sharp.h, "frame: mask is w*h");
        if (m.size() != (size_t) sharp.w * sharp.h) return 1;

        // The centre is solid, the corners are outside the footprint.
        expect(at(m, sharp, sharp.w / 2, sharp.h / 2) > 0.99f, "frame: centre covered");
        expect(at(m, sharp, 0, 0) < 0.01f, "frame: corner clear");
        expect(at(m, sharp, sharp.w - 1, sharp.h - 1) < 0.01f, "frame: far corner clear");

        // Total coverage is the footprint's share of the frame: 1/overscan each
        // way, so 1/overscan^2 of the area.
        float total = 0;
        for (const float v : m) total += v;
        const float share = total / (float) (sharp.w * sharp.h);
        const float want = 1.0f / (sharp.overscan * sharp.overscan);
        expect(std::fabs(share - want) < 0.02f, "frame: footprint is 1/overscan^2 of the mask");

        // And it is CENTRED: the same in each quadrant.
        float q[4] = { 0, 0, 0, 0 };
        for (int y = 0; y < sharp.h; y++)
            for (int x = 0; x < sharp.w; x++) {
                q[(y < sharp.h / 2 ? 0 : 2) + (x < sharp.w / 2 ? 0 : 1)] += at(m, sharp, x, y);
            }
        expect(std::fabs(q[0] - q[1]) < 1.0f && std::fabs(q[0] - q[2]) < 1.0f
                        && std::fabs(q[0] - q[3]) < 1.0f,
                "frame: footprint is centred");
    }

    // ── THE ORIENTATION ─────────────────────────────────────────────────────
    // The kit models its cars nose toward -Z (the renderer's base FLIP is built
    // on it), and the stamp samples v = 1 IN FRONT of the car. So a wedge whose
    // wide end is at model +z — the TAIL — must come out wide at v = 0.
    {
        const float hx = 0.275f, hz = 0.438f;
        std::vector<float> xz;
        std::vector<uint32_t> idx;
        // Narrow at -z (the nose), full width at +z (the tail).
        const uint32_t b = (uint32_t) (xz.size() / 2);
        xz.insert(xz.end(), { -0.05f, -hz, 0.05f, -hz, hx, hz, -hx, hz });
        idx.insert(idx.end(), { b, b + 1, b + 2, b, b + 2, b + 3 });
        const auto m = car_footprint_mask(xz.data(), xz.size() / 2,
                idx.data(), idx.size(), hx, hz, sharp);
        expect(!m.empty(), "orientation: wedge rasterized");
        if (m.empty()) return 1;
        const float behind = rowMean(m, sharp, rowAlong(sharp, 0.15f));
        const float ahead = rowMean(m, sharp, rowAlong(sharp, 0.85f));
        expect(behind > ahead * 2.0f,
                "orientation: v=0 is the TAIL (model +z), v=1 is the NOSE");
    }

    // ── SHAPE SURVIVES THE SAME BOX ─────────────────────────────────────────
    // The four roster cars have all but identical AABBs, so a footprint is only
    // worth baking if two outlines inside ONE box come out different.
    {
        const float hx = 0.275f, hz = 0.438f;
        FootprintSpec s = sharp;
        // A slab: body the full width, all the way along.
        std::vector<float> axz;
        std::vector<uint32_t> aidx;
        addQuad(axz, aidx, -hx, -hz, hx, hz);
        // An open-wheeler in the SAME box: a narrow body plus four wheels that
        // reach the box's edges. Same AABB, visibly different outline.
        std::vector<float> bxz;
        std::vector<uint32_t> bidx;
        addQuad(bxz, bidx, -0.12f, -hz, 0.12f, hz);              // body
        addQuad(bxz, bidx, -hx, -hz, -0.12f, -hz + 0.2f);        // front left
        addQuad(bxz, bidx, 0.12f, -hz, hx, -hz + 0.2f);          // front right
        addQuad(bxz, bidx, -hx, hz - 0.2f, -0.12f, hz);          // rear left
        addQuad(bxz, bidx, 0.12f, hz - 0.2f, hx, hz);            // rear right

        const auto ma = car_footprint_mask(axz.data(), axz.size() / 2,
                aidx.data(), aidx.size(), hx, hz, s);
        const auto mb = car_footprint_mask(bxz.data(), bxz.size() / 2,
                bidx.data(), bidx.size(), hx, hz, s);
        expect(!ma.empty() && !mb.empty(), "shape: both outlines rasterized");
        if (ma.empty() || mb.empty()) return 1;
        expect(ma.size() == mb.size(), "shape: same mask size");
        float diff = 0;
        for (size_t i = 0; i < ma.size(); i++) diff += std::fabs(ma[i] - mb[i]);
        const float per = diff / (float) ma.size();
        expect(per > 0.05f, "shape: two outlines in ONE box differ");

        // And the difference is in the right place — the open-wheeler is
        // PINCHED at its waist, where the slab is not.
        const int waist = rowAlong(s, 0.5f);
        expect(rowMean(mb, s, waist) < rowMean(ma, s, waist) * 0.75f,
                "shape: the open-wheeler pinches at the waist");
        // while both still reach the box's edges at the axles.
        expect(rowMean(mb, s, rowAlong(s, 0.1f)) > rowMean(mb, s, waist),
                "shape: the rear axle row is wider than the waist");
        expect(rowMean(mb, s, rowAlong(s, 0.9f)) > rowMean(mb, s, waist),
                "shape: the front axle row is wider than the waist");
    }

    // ── GROW WIDENS, AND ONLY WIDENS ────────────────────────────────────────
    // The layer minifies this mask hard, so a wheel poking out by one mask
    // texel is gone by the time it is a layer texel. Grow is the knob for it
    // and it must be monotone — a dilation may never remove coverage.
    {
        const float hx = 0.275f, hz = 0.438f;
        std::vector<float> xz;
        std::vector<uint32_t> idx;
        addQuad(xz, idx, -0.12f, -hz * 0.5f, 0.12f, hz * 0.5f);
        FootprintSpec s = sharp;
        const auto plain = car_footprint_mask(xz.data(), xz.size() / 2,
                idx.data(), idx.size(), hx, hz, s);
        s.grow = 0.08f;
        const auto grown = car_footprint_mask(xz.data(), xz.size() / 2,
                idx.data(), idx.size(), hx, hz, s);
        expect(!plain.empty() && !grown.empty(), "grow: both rasterized");
        if (plain.empty() || grown.empty()) return 1;
        float tp = 0, tg = 0;
        bool monotone = true;
        for (size_t i = 0; i < plain.size(); i++) {
            tp += plain[i];
            tg += grown[i];
            if (grown[i] + 1e-4f < plain[i]) monotone = false;
        }
        expect(tg > tp * 1.05f, "grow: a dilation adds coverage");
        expect(monotone, "grow: a dilation never REMOVES coverage");
    }

    // ── FAILURE IS EMPTY, NEVER BLANK ───────────────────────────────────────
    {
        FootprintSpec s = sharp;
        std::vector<float> xz{ 0, 0, 1, 0, 0, 1 };
        std::vector<uint32_t> idx{ 0, 1, 2 };
        expect(car_footprint_mask(nullptr, 3, idx.data(), 3, 0.2f, 0.4f, s).empty(),
                "empty: no vertices");
        expect(car_footprint_mask(xz.data(), 3, nullptr, 3, 0.2f, 0.4f, s).empty(),
                "empty: no indices");
        expect(car_footprint_mask(xz.data(), 3, idx.data(), 2, 0.2f, 0.4f, s).empty(),
                "empty: fewer than three indices");
        expect(car_footprint_mask(xz.data(), 3, idx.data(), 3, 0.0f, 0.4f, s).empty(),
                "empty: a degenerate footprint");
        // An index past the end refuses the WHOLE model, the way glb_mesh does
        // — a partial outline would be a hole with nothing to say so.
        std::vector<uint32_t> bad{ 0, 1, 99 };
        expect(car_footprint_mask(xz.data(), 3, bad.data(), 3, 0.2f, 0.4f, s).empty(),
                "empty: an out-of-range index refuses the whole model");
        // Geometry entirely outside the frame rasterizes nothing, and that is a
        // failed bake rather than a car with no shadow.
        std::vector<float> far;
        std::vector<uint32_t> fidx;
        addQuad(far, fidx, 40.0f, 40.0f, 41.0f, 41.0f);
        expect(car_footprint_mask(far.data(), far.size() / 2,
                       fidx.data(), fidx.size(), 0.275f, 0.438f, s).empty(),
                "empty: geometry off the frame");
    }

    // ── THE FALLBACK STILL WORKS ────────────────────────────────────────────
    // The superellipse is what a car whose outline could not be read draws, and
    // what the generic decal-mask layer holds. Same frame, same centring.
    {
        FootprintSpec s;
        s.w = 64;
        s.h = 128;
        const auto m = superellipse_mask(s);
        expect(m.size() == (size_t) s.w * s.h, "superellipse: mask is w*h");
        if (m.size() != (size_t) s.w * s.h) return 1;
        expect(at(m, s, s.w / 2, s.h / 2) > 0.9f, "superellipse: centre covered");
        expect(at(m, s, 0, 0) < 0.05f, "superellipse: corner clear");
        // Left/right and front/back symmetric — which is half the reason it
        // could never be mirrored by a handedness mistake.
        bool sym = true;
        for (int y = 0; y < s.h; y++)
            for (int x = 0; x < s.w / 2; x++) {
                if (std::fabs(at(m, s, x, y) - at(m, s, s.w - 1 - x, y)) > 1e-5f) sym = false;
                if (std::fabs(at(m, s, x, y) - at(m, s, x, s.h - 1 - y)) > 1e-5f) sym = false;
            }
        expect(sym, "superellipse: symmetric on both axes");
    }

    // ── THE CHEAP SHAPE ─────────────────────────────────────────────────────
    // The rounded rect is the one shape with no mask behind it, so nothing else
    // can catch it being wrong. It has to agree with the masks about the FRAME
    // (or it draws at a different size from everything it is A/B'd against),
    // and its corner knob has to actually span rectangle to ellipse.
    {
        const float OV = 1.45f, SOFT = 0.004f;
        // The frame: the footprint fills 1/overscan, centred, on both axes.
        // A point just inside the footprint's edge mid-side is covered; the
        // frame's own corner is far outside it.
        const float in = 0.5f + 0.98f * 0.5f / OV;   // along v, mid-width
        expect(rounded_rect_coverage(0.5f, in, OV, 0.42f, SOFT) > 0.5f,
                "rounded: covered just inside the footprint edge");
        const float out = 0.5f + 1.02f * 0.5f / OV;
        expect(rounded_rect_coverage(0.5f, out, OV, 0.42f, SOFT) < 0.5f,
                "rounded: clear just outside it");
        expect(rounded_rect_coverage(0.5f, 0.5f, OV, 0.42f, SOFT) > 0.99f,
                "rounded: centre solid");
        expect(rounded_rect_coverage(0.0f, 0.0f, OV, 0.42f, SOFT) < 0.01f,
                "rounded: frame corner clear");
        // Symmetric on both axes — it is a generic shape and must not favour an
        // end, or it would read as a handedness bug in the per-car outline.
        for (const float u : { 0.2f, 0.35f, 0.5f }) {
            for (const float v : { 0.2f, 0.35f, 0.5f }) {
                const float a = rounded_rect_coverage(u, v, OV, 0.42f, SOFT);
                expect(std::fabs(a - rounded_rect_coverage(1 - u, v, OV, 0.42f, SOFT)) < 1e-5f
                                && std::fabs(a - rounded_rect_coverage(u, 1 - v, OV, 0.42f, SOFT)) < 1e-5f,
                        "rounded: symmetric on both axes");
            }
        }
        // The corner knob spans the two shapes it claims to. At the footprint's
        // own CORNER a rectangle is covered and an ellipse is not.
        const float cu = 0.5f + 0.92f * 0.5f / OV, cv = 0.5f + 0.92f * 0.5f / OV;
        expect(rounded_rect_coverage(cu, cv, OV, 0.0f, SOFT) > 0.9f,
                "rounded: corner 0 fills the box corner");
        expect(rounded_rect_coverage(cu, cv, OV, 1.0f, SOFT) < 0.1f,
                "rounded: corner 1 rounds it away");
        // …and it is MONOTONE in between, or the slider would not read as one
        // shape becoming another.
        float last = 2.0f;
        bool mono = true;
        for (float r = 0.0f; r <= 1.0f; r += 0.1f) {
            const float a = rounded_rect_coverage(cu, cv, OV, r, SOFT);
            if (a > last + 1e-4f) mono = false;
            last = a;
        }
        expect(mono, "rounded: coverage at the corner falls monotonically with radius");
        // A wider ramp only ever SOFTENS: the outline stays put.
        expect(std::fabs(rounded_rect_coverage(0.5f, 0.5f + 0.5f / OV, OV, 0.42f, 0.2f) - 0.5f) < 0.1f,
                "rounded: the edge sits at coverage ~0.5 whatever the ramp");
    }

    // ── THE FIT INCLUDES WHEELS AND TRIMS OVERHANGS ─────────────────────────
    // An open-wheeler: a narrow bumper tip past the rear wheels. The wheels
    // set the WIDTH (a shadow narrower than the tyres reads as floating
    // rubber), and the short tip is an OVERHANG the box does not stretch to.
    {
        using ttp::rt::fit_rounded_rect;
        const float hx = 0.28f, hz = 0.40f;
        std::vector<float> xz;
        std::vector<uint32_t> idx;
        addQuad(xz, idx, -0.10f, -0.05f, 0.10f, 0.40f);   // body, tip past the wheels
        addQuad(xz, idx, 0.20f, 0.15f, hx, 0.35f);        // rear wheels, GAP to body
        addQuad(xz, idx, -hx, 0.15f, -0.20f, 0.35f);
        addQuad(xz, idx, -hx, -0.40f, hx, 0.05f);         // wide flush front
        const auto m = car_footprint_mask(xz.data(), xz.size() / 2,
                idx.data(), idx.size(), hx, hz, sharp);
        expect(!m.empty(), "extent fit: fixture rasterizes");
        const auto fit = fit_rounded_rect(m, sharp);
        expect(fit.fillXTail > 0.9f,
                "extent fit: the rear WHEELS set the tail's width");
        expect(fit.fillXNose > 0.9f,
                "extent fit: the flush front keeps its width");
        // And a plain slab stays a full RECT: both ends full, nothing trimmed.
        std::vector<float> sxz;
        std::vector<uint32_t> sidx;
        addQuad(sxz, sidx, -hx, -hz, hx, hz);
        const auto sm = car_footprint_mask(sxz.data(), sxz.size() / 2,
                sidx.data(), sidx.size(), hx, hz, sharp);
        const auto sfit = fit_rounded_rect(sm, sharp);
        expect(std::fabs(sfit.fillXTail - sfit.fillXNose) < 0.05f
                        && sfit.fillXTail > 0.9f && sfit.fillZ > 0.95f,
                "extent fit: a slab stays a full rect");
        // A GRADUAL taper is the car's real shape and survives as a trapezoid
        // — the overhang trim is clamped to a sixth per end and cannot eat it.
        std::vector<float> wxz;
        std::vector<uint32_t> widx;
        const uint32_t b = (uint32_t) (wxz.size() / 2);
        wxz.insert(wxz.end(), { -0.06f, -hz, 0.06f, -hz, hx, hz, -hx, hz });
        widx.insert(widx.end(), { b, b + 1, b + 2, b, b + 2, b + 3 });
        const auto wm = car_footprint_mask(wxz.data(), wxz.size() / 2,
                widx.data(), widx.size(), hx, hz, sharp);
        const auto wfit = fit_rounded_rect(wm, sharp);
        expect(wfit.fillXTail > 0.85f && wfit.fillXNose < 0.55f,
                "extent fit: a gradual taper keeps its trapezoid");
        // The trapezoid's ORIENTATION reaches the coverage: at the same
        // wide-x offset, the TAIL end is covered and the nose end is not.
        const float OV = sharp.overscan;
        const float uWide = 0.5f + 0.7f * 0.5f / OV;
        const float cTail = ttp::rt::rounded_rect_coverage(uWide,
                0.5f - 0.6f * 0.5f / OV, OV, 0.1f, 0.02f,
                wfit.fillXTail, wfit.fillXNose, wfit.fillZ);
        const float cNose = ttp::rt::rounded_rect_coverage(uWide,
                0.5f + 0.6f * 0.5f / OV, OV, 0.1f, 0.02f,
                wfit.fillXTail, wfit.fillXNose, wfit.fillZ);
        expect(cTail > 0.5f && cNose < 0.5f,
                "extent fit: v=0 wears the tail's width, v=1 the nose's");
    }

    // ---- the fitted convex polygon ------------------------------------------
    {
        using ttp::rt::convex_poly_coverage;
        using ttp::rt::fit_convex_poly;
        using ttp::rt::PolyFit;
        // A tapered body: wide tail, narrow nose — the shape the rect cannot
        // say. Model space, nose toward -z per the kit convention.
        std::vector<float> xz = {
            -0.25f,  0.40f,  0.25f,  0.40f,   // tail corners (+z)
            -0.28f,  0.10f,  0.28f,  0.10f,   // widest at the hips
            -0.12f, -0.40f,  0.12f, -0.40f,   // narrow nose (-z)
        };
        const float HX = 0.28f, HZ = 0.40f;
        const PolyFit p = fit_convex_poly(xz.data(), xz.size() / 2, HX, HZ, 6);
        expect(p.count >= 3 && p.count <= 6, "poly: fits within the asked edge count");
        // CONTAINMENT: simplification only ever grows, so every projected
        // vertex sits inside (q frame, both axes negated).
        bool inside = true;
        for (size_t i = 0; i + 1 < xz.size(); i += 2) {
            const float qx = -xz[i] / HX, qy = -xz[i + 1] / HZ;
            for (int e = 0; e < p.count; e++) {
                if (p.nx[e] * qx + p.ny[e] * qy > p.d[e] + 1e-4f) inside = false;
            }
        }
        expect(inside, "poly: every input vertex stays inside the fit");
        // SYMMETRY: the fit mirrors its input in x, so every plane's mirror is
        // a plane of the fit too.
        bool sym = true;
        for (int e = 0; e < p.count; e++) {
            bool found = false;
            for (int f = 0; f < p.count; f++) {
                if (std::fabs(p.nx[e] + p.nx[f]) < 1e-3f
                        && std::fabs(p.ny[e] - p.ny[f]) < 1e-3f
                        && std::fabs(p.d[e] - p.d[f]) < 1e-3f) found = true;
            }
            if (!found) sym = false;
        }
        expect(sym, "poly: left-right symmetric by construction");
        // THE TAPER SURVIVES: coverage at the hips' width near the NOSE
        // (v = 1) is clear, the same offset near the TAIL (v = 0) is covered —
        // which is also the orientation pinned end to end (nose -z -> v 1).
        const float OV = 1.45f, SOFT = 0.02f;
        const float uHip = 0.5f + (0.24f / HX) * 0.5f / OV;
        const float vNose = 0.5f + 0.75f * 0.5f / OV;
        const float vTail = 0.5f - 0.75f * 0.5f / OV;
        expect(convex_poly_coverage(uHip, vNose, OV, p, 0.0f, SOFT) < 0.5f,
                "poly: the nose is narrower than the hips");
        expect(convex_poly_coverage(uHip, vTail, OV, p, 0.0f, SOFT) > 0.5f,
                "poly: the tail keeps the hips' width");
        expect(convex_poly_coverage(0.5f, 0.5f, OV, p, 0.0f, SOFT) > 0.99f,
                "poly: centre solid");
        expect(convex_poly_coverage(0.02f, 0.02f, OV, p, 0.0f, SOFT) < 0.01f,
                "poly: frame corner clear");
        // FAILURE IS EMPTY, so the caller falls back to the rect.
        expect(fit_convex_poly(nullptr, 0, HX, HZ, 6).count == 0,
                "poly: nothing to fit answers count 0");
        expect(fit_convex_poly(xz.data(), 2, HX, HZ, 6).count == 0,
                "poly: too few points answers count 0");

        // ---- the lobed fit: concave at the waist, convex per lobe ----------
        // The profile comes from the MASK, so the fixtures build real ones.
        using ttp::rt::fit_convex_poly_lobes;
        FootprintSpec fspec;
        // A waisted body: wide at both axles, pinched between them — the
        // outline a single hull bridges wheel-to-wheel.
        std::vector<float> waisted;
        std::vector<uint32_t> waistedIdx;
        addQuad(waisted, waistedIdx, -0.28f, 0.20f, 0.28f, 0.40f);    // rear axle
        addQuad(waisted, waistedIdx, -0.14f, -0.20f, 0.14f, 0.20f);   // the pinch
        addQuad(waisted, waistedIdx, -0.28f, -0.40f, 0.28f, -0.20f);  // front axle
        const std::vector<float> waistedMask = car_footprint_mask(
                waisted.data(), waisted.size() / 2,
                waistedIdx.data(), waistedIdx.size(), HX, HZ, fspec);
        expect(!waistedMask.empty(), "lobes: the waisted fixture rasterizes");
        const auto lobes = fit_convex_poly_lobes(waisted.data(), waisted.size() / 2,
                waistedIdx.data(), waistedIdx.size(),
                HX, HZ, 6, waistedMask, fspec);
        expect(lobes[0].count >= 3 && lobes[1].count >= 3,
                "lobes: a waisted body splits in two");
        const auto unionCov = [&](float u, float v) {
            return std::max(
                    convex_poly_coverage(u, v, OV, lobes[0], 0.0f, SOFT),
                    convex_poly_coverage(u, v, OV, lobes[1], 0.0f, SOFT));
        };
        // THE PINCH SURVIVES: beside the waist the union is clear where a
        // single hull covers, and both axles stay covered at full width.
        const float uWide = 0.5f + (0.24f / HX) * 0.5f / OV;
        expect(unionCov(uWide, 0.5f) < 0.5f,
                "lobes: the union is clear beside the waist");
        const ttp::rt::PolyFit one = fit_convex_poly(waisted.data(),
                waisted.size() / 2, HX, HZ, 6);
        expect(convex_poly_coverage(uWide, 0.5f, OV, one, 0.0f, SOFT) > 0.5f,
                "lobes: the single hull would have bridged it (the control)");
        expect(unionCov(uWide, 0.5f + 0.85f * 0.5f / OV) > 0.5f
                        && unionCov(uWide, 0.5f - 0.85f * 0.5f / OV) > 0.5f,
                "lobes: both axles keep their width");
        expect(unionCov(0.5f, 0.5f) > 0.99f,
                "lobes: the centreline stays covered through the waist");
        // A MONOTONE TAPER DOES NOT SPLIT: narrow at the nose only, so the
        // nose side is never wider than the "waist" — no pinch, no second
        // evaluation.
        std::vector<float> taper;
        std::vector<uint32_t> taperIdx;
        addQuad(taper, taperIdx, -0.28f, -0.05f, 0.28f, 0.40f);   // wide rear
        addQuad(taper, taperIdx, -0.14f, -0.40f, 0.14f, 0.05f);   // narrow nose
        const std::vector<float> taperMask = car_footprint_mask(
                taper.data(), taper.size() / 2,
                taperIdx.data(), taperIdx.size(), HX, HZ, fspec);
        expect(fit_convex_poly_lobes(taper.data(), taper.size() / 2,
                        taperIdx.data(), taperIdx.size(),
                        HX, HZ, 6, taperMask, fspec)[1].count == 0,
                "lobes: a taper stays one lobe");
    }

    std::printf("carfootprint_check: %d checked, %d failed\n", checked, failed);
    return failed ? 1 : 0;
}
