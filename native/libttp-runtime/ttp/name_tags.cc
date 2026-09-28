#include "ttp/name_tags.h"

#include <algorithm>
#include <cmath>

#include "ttp/vecmath.h"

namespace ttp {
namespace rt {

namespace {

V3 v3(const TtpVec3& v) { return { v.x, v.y, v.z }; }

bool alive(const TtpCarInput& c) {
    // A slot no live car claims is zeroed by the frame builder, pose and all.
    return !(c.up.x == 0 && c.up.y == 0 && c.up.z == 0);
}

// The car's box axes: right, up, forward. The kit's cars are symmetric, so the
// handedness of `right` does not matter.
struct Box {
    V3 o, r, u, fw;
    float hw, h, hl;
};

Box boxOf(const TtpCarInput& c) {
    const V3 fw = norm(v3(c.forward)), up = norm(v3(c.up));
    const bool mon = c.monster > 0.5f;
    return { v3(c.pos), norm(cross(up, fw)), up, fw,
             mon ? NAME_TAG_MONSTER_HALF_W : NAME_TAG_CAR_HALF_W,
             mon ? NAME_TAG_MONSTER_H : NAME_TAG_CAR_H, NAME_TAG_CAR_HALF_L };
}

// Does the segment a -> b (excluding b itself) pass through box `k`? Slab test
// in the box's own frame.
bool blocks(const Box& k, V3 a, V3 b) {
    const V3 da = a - k.o, d = b - a;
    const float o[3] = { dot(da, k.r), dot(da, k.u), dot(da, k.fw) };
    const float v[3] = { dot(d, k.r), dot(d, k.u), dot(d, k.fw) };
    const float lo[3] = { -k.hw, 0, -k.hl }, hi[3] = { k.hw, k.h, k.hl };
    float t0 = 0, t1 = 0.999f;
    for (int i = 0; i < 3; i++) {
        if (std::fabs(v[i]) < 1e-9f) {
            if (o[i] < lo[i] || o[i] > hi[i]) return false;
            continue;
        }
        float ta = (lo[i] - o[i]) / v[i], tb = (hi[i] - o[i]) / v[i];
        if (ta > tb) std::swap(ta, tb);
        t0 = std::max(t0, ta);
        t1 = std::min(t1, tb);
        if (t0 > t1) return false;
    }
    return true;
}

// Is car `s` hidden from `eye` by the other cars? Hidden only when EVERY sample
// point on it is blocked, so a car peeking past a truck keeps its tag.
bool covered(const TtpFrameInput& f, V3 eye, uint32_t s, TtpVec3 ownPos, bool hasOwn) {
    const TtpCarInput* cars = ttp_frame_cars(&f);
    const Box t = boxOf(cars[s]);
    const V3 samples[5] = {
        t.o + t.u * (t.h * 0.9f),
        t.o + t.u * (t.h * 0.6f) + t.fw * (t.hl * 0.8f),
        t.o + t.u * (t.h * 0.6f) - t.fw * (t.hl * 0.8f),
        t.o + t.u * (t.h * 0.6f) + t.r * (t.hw * 0.8f),
        t.o + t.u * (t.h * 0.6f) - t.r * (t.hw * 0.8f),
    };
    const TtpVec3 eyeV{ eye.x, eye.y, eye.z };
    bool open[5] = { true, true, true, true, true };
    for (uint32_t k = 0; k < f.carCount; k++) {
        if (k == s || !alive(cars[k])) continue;
        if (cars[k].monster > 0.5f && hasOwn && ttp_monster_ghosted(cars[k].pos, eyeV, ownPos)) continue;
        const Box b = boxOf(cars[k]);
        bool any = false;
        for (int p = 0; p < 5; p++) {
            if (open[p] && blocks(b, eye, samples[p])) open[p] = false;
            any = any || open[p];
        }
        if (!any) return true;
    }
    return false;
}

}  // namespace

std::vector<NameTag> nameTags(const TtpFrameInput& f, const float* pictures,
                              std::vector<float>& cover) {
    std::vector<NameTag> out;
    if ((f.flags & TTP_FRAME_OVERVIEW) || f.viewCount == 0 || !pictures) return out;
    const TtpCarInput* cars = ttp_frame_cars(&f);
    const TtpViewInput* views = ttp_frame_views(&f);
    // 1 = clear, 0 = covered. A new field or split starts every tag clear.
    if (cover.size() != (size_t) f.viewCount * f.carCount) cover.assign((size_t) f.viewCount * f.carCount, 1.0f);
    const float step = f.dt / NAME_TAG_COVER_FADE;
    std::vector<std::pair<float, NameTag>> cell;  // (eye distance, tag)
    for (uint32_t i = 0; i < f.viewCount; i++) {
        const TtpViewInput& v = views[i];
        const float* w = v.world;
        // world is rigid (lookAtWorld), so its inverse is the transposed basis.
        const V3 right{ w[0], w[1], w[2] }, up{ w[4], w[5], w[6] }, back{ w[8], w[9], w[10] };
        const V3 eye{ w[12], w[13], w[14] };
        const float ty = std::tan(v.fov * 0.5f * (float) M_PI / 180.0f);
        const float tx = ty * v.aspect;
        const float* r = pictures + 4 * i;
        cell.clear();
        if (v.car < 0) continue;  // a cell whose car is not in this scene yet
        for (uint32_t s = 0; s < f.carCount; s++) {
            if ((int32_t) s == v.car) continue;
            const TtpCarInput& c = cars[s];
            if (!alive(c)) continue;
            const V3 anchor = V3{ c.pos.x, c.pos.y, c.pos.z }
                    + V3{ c.up.x, c.up.y, c.up.z } * NAME_TAG_LIFT;
            const V3 d = anchor - eye;
            const float depth = -dot(d, back);
            if (depth <= v.nearZ) continue;
            const float nx = dot(d, right) / (depth * tx);
            const float ny = dot(d, up) / (depth * ty);
            if (nx < -1 || nx > 1 || ny < -1 || ny > 1) continue;
            const float dist = std::sqrt(dot(d, d));
            if (dist >= NAME_TAG_FAR) continue;
            const float fade = (NAME_TAG_FAR - dist) / (NAME_TAG_FAR - NAME_TAG_FADE);
            float& clear = cover[(size_t) i * f.carCount + s];
            const bool hasOwn = (uint32_t) v.car < f.carCount;
            const bool hidden = covered(f, eye, s, hasOwn ? cars[v.car].pos : TtpVec3{ 0, 0, 0 }, hasOwn);
            clear = hidden ? std::max(0.0f, clear - step) : std::min(1.0f, clear + step);
            if (clear <= 0) continue;
            NameTag t;
            t.cell = (int32_t) i;
            t.target = (int32_t) s;
            t.x = r[0] + (nx + 1) * 0.5f * r[2];
            t.y = r[1] + (1 - ny) * 0.5f * r[3];
            const float k = std::max(0.0f, dist - NAME_TAG_NEAR) / (NAME_TAG_FAR - NAME_TAG_NEAR);
            t.scale = 1 - (1 - NAME_TAG_FAR_SCALE) * k;
            t.alpha = std::min(1.0f, fade) * clear;
            cell.push_back({ dist, t });
        }
        std::stable_sort(cell.begin(), cell.end(),
                         [](const auto& a, const auto& b) { return a.first > b.first; });
        for (const auto& e : cell) out.push_back(e.second);
    }
    return out;
}

}  // namespace rt
}  // namespace ttp
