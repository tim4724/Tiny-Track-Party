#include "ttp/name_tags.h"

#include <algorithm>
#include <cmath>

#include "ttp/vecmath.h"

namespace ttp {
namespace rt {

namespace {

V3 v3(const TtpVec3& v) { return { v.x, v.y, v.z }; }

// Clearances at each end of a ray, in world units, inside which the deck does not
// block it: the camera rides just over the road, and the tag floats not far over
// the piece its own car stands on, so a slope or a crest under either end would
// otherwise clip a ray that plainly clears the road.
constexpr float DECK_EYE_CLEAR = 0.3f, DECK_CAR_CLEAR = 0.6f;

bool alive(const TtpCarInput& c) {
    // A slot no live car claims is zeroed by the frame builder, pose and all.
    return !(c.up.x == 0 && c.up.y == 0 && c.up.z == 0);
}

bool monster(const TtpCarInput& c) { return c.monster > 0.5f; }

// A monster truck's box axes: right, up, forward. The rig is symmetric, so the
// handedness of `right` does not matter.
struct Box {
    V3 o, r, u, fw;
};

Box boxOf(const TtpCarInput& c) {
    const V3 fw = norm(v3(c.forward)), up = norm(v3(c.up));
    return { v3(c.pos), norm(cross(up, fw)), up, fw };
}

// Does the segment a -> b (excluding b itself) pass through box `k`? Slab test
// in the box's own frame.
bool blocks(const Box& k, V3 a, V3 b) {
    const V3 da = a - k.o, d = b - a;
    const float o[3] = { dot(da, k.r), dot(da, k.u), dot(da, k.fw) };
    const float v[3] = { dot(d, k.r), dot(d, k.u), dot(d, k.fw) };
    const float lo[3] = { -NAME_TAG_MONSTER_HALF_W, 0, -NAME_TAG_MONSTER_HALF_L };
    const float hi[3] = { NAME_TAG_MONSTER_HALF_W, NAME_TAG_MONSTER_H, NAME_TAG_MONSTER_HALF_L };
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

// Does the ray a + t*d, t in (t0, t1), cross the box [lo, hi]?
bool crossesBox(V3 a, V3 d, float t0, float t1, V3 lo, V3 hi) {
    const float o[3] = { a.x, a.y, a.z }, v[3] = { d.x, d.y, d.z };
    const float l[3] = { lo.x, lo.y, lo.z }, h[3] = { hi.x, hi.y, hi.z };
    for (int i = 0; i < 3; i++) {
        if (std::fabs(v[i]) < 1e-9f) {
            if (o[i] < l[i] || o[i] > h[i]) return false;
            continue;
        }
        float ta = (l[i] - o[i]) / v[i], tb = (h[i] - o[i]) / v[i];
        if (ta > tb) std::swap(ta, tb);
        t0 = std::max(t0, ta);
        t1 = std::min(t1, tb);
        if (t0 > t1) return false;
    }
    return true;
}

// Does the ray a + t*d, t in (t0, t1), cross triangle p q r? Either side.
bool crossesTri(V3 a, V3 d, float t0, float t1, V3 p, V3 q, V3 r) {
    const V3 e1 = q - p, e2 = r - p, pv = cross(d, e2);
    const float det = dot(e1, pv);
    if (std::fabs(det) < 1e-12f) return false;
    const float inv = 1.0f / det;
    const V3 tv = a - p;
    const float u = dot(tv, pv) * inv;
    if (u < 0 || u > 1) return false;
    const V3 qv = cross(tv, e1);
    const float w = dot(d, qv) * inv;
    if (w < 0 || u + w > 1) return false;
    const float t = dot(e2, qv) * inv;
    return t > t0 && t < t1;
}

}  // namespace

bool deckBlocks(const NameTagDeck& deck, V3 eye, V3 p, float eyeClear, float farClear) {
    const V3 d = p - eye;
    const float len = std::sqrt(dot(d, d));
    if (len <= eyeClear + farClear) return false;
    const float t0 = eyeClear / len, t1 = 1 - farClear / len;
    const uint32_t n = (uint32_t) deck.left.size();
    for (const NameTagDeck::Chunk& c : deck.chunks) {
        if (!crossesBox(eye, d, t0, t1, c.lo, c.hi)) continue;
        for (uint32_t i = c.first; i < c.first + c.count; i++) {
            const uint32_t j = (i + 1) % n;
            const V3 a = deck.left[i], b = deck.right[i], e = deck.left[j], g = deck.right[j];
            if (crossesTri(eye, d, t0, t1, a, b, g) || crossesTri(eye, d, t0, t1, a, g, e)) return true;
        }
    }
    return false;
}

namespace {

// Is the tag at `tag` (car `s`'s) hidden from `eye` by a monster truck or the deck?
// The cell's own car never hides one: the camera looks over its roof, so driving
// the truck would otherwise blank every rival ahead.
bool covered(const TtpFrameInput& f, const NameTagDeck& deck, V3 eye, V3 tag, uint32_t s,
             uint32_t own) {
    const TtpCarInput* cars = ttp_frame_cars(&f);
    const TtpVec3 eyeV{ eye.x, eye.y, eye.z };
    for (uint32_t k = 0; k < f.carCount; k++) {
        if (k == s || k == own || !alive(cars[k]) || !monster(cars[k])) continue;
        if (own < f.carCount && ttp_monster_ghosted(cars[k].pos, eyeV, cars[own].pos)) continue;
        if (blocks(boxOf(cars[k]), eye, tag)) return true;
    }
    return deckBlocks(deck, eye, tag, DECK_EYE_CLEAR, DECK_CAR_CLEAR);
}

// Scale by eye distance: 1 at NAME_TAG_CLOSE and nearer, then two linear legs.
float scaleAt(float dist) {
    if (dist <= NAME_TAG_NEAR) {
        const float k = std::max(0.0f, dist - NAME_TAG_CLOSE) / (NAME_TAG_NEAR - NAME_TAG_CLOSE);
        return 1 - (1 - NAME_TAG_NEAR_SCALE) * k;
    }
    const float k = std::min(1.0f, (dist - NAME_TAG_NEAR) / (NAME_TAG_FAR - NAME_TAG_NEAR));
    return NAME_TAG_NEAR_SCALE - (NAME_TAG_NEAR_SCALE - NAME_TAG_FAR_SCALE) * k;
}

}  // namespace

NameTagDeck nameTagDeck(const std::vector<OutSample>& samples, bool closed) {
    NameTagDeck deck;
    const uint32_t n = (uint32_t) samples.size();
    if (n < 2) return deck;
    for (const OutSample& s : samples) {
        const V3 c = v3(s.pos), lat = v3(s.lateral) * (float) (s.width * 0.5);
        deck.left.push_back(c - lat);
        deck.right.push_back(c + lat);
    }
    const uint32_t pieces = closed ? n : n - 1;
    for (uint32_t first = 0; first < pieces; first += NAME_TAG_DECK_CHUNK) {
        NameTagDeck::Chunk c;
        c.first = first;
        c.count = std::min(NAME_TAG_DECK_CHUNK, pieces - first);
        c.lo = c.hi = deck.left[first];
        for (uint32_t i = first; i <= first + c.count; i++) {
            for (const V3& v : { deck.left[i % n], deck.right[i % n] }) {
                c.lo = { std::min(c.lo.x, v.x), std::min(c.lo.y, v.y), std::min(c.lo.z, v.z) };
                c.hi = { std::max(c.hi.x, v.x), std::max(c.hi.y, v.y), std::max(c.hi.z, v.z) };
            }
        }
        deck.chunks.push_back(c);
    }
    return deck;
}

std::vector<NameTag> nameTags(const TtpFrameInput& f, const float* pictures,
                              const NameTagDeck& deck, std::vector<float>& cover) {
    std::vector<NameTag> out;
    // Only players are tagged, so a single cell has nobody to tag.
    if ((f.flags & TTP_FRAME_OVERVIEW) || f.viewCount < 2 || !pictures) return out;
    const TtpCarInput* cars = ttp_frame_cars(&f);
    const TtpViewInput* views = ttp_frame_views(&f);
    // 1 = clear, 0 = covered. A new field or split starts every tag clear.
    if (cover.size() != (size_t) f.viewCount * f.carCount) cover.assign((size_t) f.viewCount * f.carCount, 1.0f);
    const float step = f.dt / NAME_TAG_COVER_FADE;
    std::vector<std::pair<float, NameTag>> cell;  // (eye distance, tag)
    for (uint32_t i = 0; i < f.viewCount; i++) {
        const TtpViewInput& v = views[i];
        if (v.car < 0) continue;  // a cell whose car is not in this scene yet
        const float* w = v.world;
        // world is rigid (lookAtWorld), so its inverse is the transposed basis.
        const V3 right{ w[0], w[1], w[2] }, up{ w[4], w[5], w[6] }, back{ w[8], w[9], w[10] };
        const V3 eye{ w[12], w[13], w[14] };
        const float ty = std::tan(v.fov * 0.5f * (float) M_PI / 180.0f);
        const float tx = ty * v.aspect;
        const float* r = pictures + 4 * i;
        cell.clear();
        // The other cells' cars: the players. CPU cars own no cell.
        for (uint32_t j = 0; j < f.viewCount; j++) {
            const int32_t other = views[j].car;
            if (other < 0 || (uint32_t) other >= f.carCount || other == v.car) continue;
            const uint32_t s = (uint32_t) other;
            const TtpCarInput& c = cars[s];
            if (!alive(c)) continue;
            const V3 carUp = norm(v3(c.up));
            const V3 anchor = v3(c.pos) + carUp * (monster(c) ? NAME_TAG_MONSTER_LIFT : NAME_TAG_LIFT);
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
            const bool hidden = covered(f, deck, eye, anchor + carUp * NAME_TAG_BODY, s, (uint32_t) v.car);
            clear = hidden ? std::max(0.0f, clear - step) : std::min(1.0f, clear + step);
            if (clear <= 0) continue;
            NameTag t;
            t.cell = (int32_t) i;
            t.target = (int32_t) s;
            t.x = r[0] + (nx + 1) * 0.5f * r[2];
            t.y = r[1] + (1 - ny) * 0.5f * r[3];
            t.scale = scaleAt(dist);
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
