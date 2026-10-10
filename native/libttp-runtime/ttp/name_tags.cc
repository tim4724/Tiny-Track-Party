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

bool inside(const Box& k, const NameTagShape& sh, V3 p) {
    const V3 d = p - k.o;
    const float x = dot(d, k.r), y = dot(d, k.u), z = dot(d, k.fw);
    return std::fabs(x) <= NAME_TAG_MONSTER_HALF_W * sh.rigScale && y >= 0 && y <= sh.roof
        && std::fabs(z) <= NAME_TAG_MONSTER_HALF_L * sh.rigScale;
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

// Does the ray eye + t*d, t in (t0, t1), cross deck piece i (sample i to i+1)?
bool pieceBlocks(const NameTagDeck& deck, uint32_t i, V3 eye, V3 d, float t0, float t1) {
    const uint32_t j = (i + 1) % (uint32_t) deck.left.size();
    const V3 a = deck.left[i], b = deck.right[i], e = deck.left[j], g = deck.right[j];
    return crossesTri(eye, d, t0, t1, a, b, g) || crossesTri(eye, d, t0, t1, a, g, e);
}

// ...or any piece of chunk `c`?
bool chunkBlocks(const NameTagDeck& deck, const NameTagDeck::Chunk& c, V3 eye, V3 d, float t0, float t1) {
    if (!crossesBox(eye, d, t0, t1, c.lo, c.hi)) return false;
    for (uint32_t i = c.first; i < c.first + c.count; i++)
        if (pieceBlocks(deck, i, eye, d, t0, t1)) return true;
    return false;
}

// The ray eye -> p as eye + t*d over the window (t0, t1) its two clearances
// leave; false when they meet and nothing of it can be blocked.
bool rayWindow(V3 eye, V3 p, float eyeClear, float farClear, V3& d, float& t0, float& t1) {
    d = p - eye;
    const float len = std::sqrt(dot(d, d));
    if (len <= eyeClear + farClear) return false;
    t0 = eyeClear / len;
    t1 = 1 - farClear / len;
    return true;
}

// deckBlocks over the deck pieces `pieces` only.
bool piecesBlock(const NameTagDeck& deck, const std::vector<uint32_t>& pieces, V3 eye, V3 p, float eyeClear,
                 float farClear) {
    V3 d;
    float t0, t1;
    if (!rayWindow(eye, p, eyeClear, farClear, d, t0, t1)) return false;
    for (const uint32_t i : pieces)
        if (pieceBlocks(deck, i, eye, d, t0, t1)) return true;
    return false;
}

}  // namespace

bool deckBlocks(const NameTagDeck& deck, V3 eye, V3 p, float eyeClear, float farClear) {
    V3 d;
    float t0, t1;
    if (!rayWindow(eye, p, eyeClear, farClear, d, t0, t1)) return false;
    for (const NameTagDeck::Chunk& c : deck.chunks)
        if (chunkBlocks(deck, c, eye, d, t0, t1)) return true;
    return false;
}

bool kerbBlocks(const NameTagDeck& deck, V3 eye, V3 p) {
    if (deck.kerbH <= 0) return false;
    const V3 d = p - eye, up = { 0, deck.kerbH, 0 };
    const uint32_t n = (uint32_t) deck.left.size();
    for (const NameTagDeck::Chunk& c : deck.chunks) {
        if (!crossesBox(eye, d, 0, 1, c.lo, c.hi + up)) continue;
        for (uint32_t i = c.first; i < c.first + c.count; i++) {
            const uint32_t j = (i + 1) % n;
            for (const std::vector<V3>* edge : { &deck.left, &deck.right }) {
                const V3 a = (*edge)[i], e = (*edge)[j];
                if (crossesTri(eye, d, 0, 1, a, e, e + up) || crossesTri(eye, d, 0, 1, a, e + up, a + up)) return true;
            }
        }
    }
    return false;
}

namespace {

// One cell's camera, and the two maps between its view space (x right, y up,
// z the depth in front of the eye) and the surface (fractions, top-left origin,
// within the cell's picture rect `r`).
struct Cam {
    V3 eye, right, up, back;
    float tx, ty;
    const float* r;
};

struct P2 {
    float x, y;
};

V3 viewOf(const Cam& c, V3 p) {
    const V3 d = p - c.eye;
    return { dot(d, c.right), dot(d, c.up), -dot(d, c.back) };
}

P2 screenOf(const Cam& c, V3 v) {
    return { c.r[0] + (v.x / (v.z * c.tx) + 1) * 0.5f * c.r[2], c.r[1] + (1 - v.y / (v.z * c.ty)) * 0.5f * c.r[3] };
}

// The world point at depth z behind surface point s.
V3 worldAt(const Cam& c, P2 s, float z) {
    const float nx = (s.x - c.r[0]) / c.r[2] * 2 - 1, ny = 1 - (s.y - c.r[1]) / c.r[3] * 2;
    return c.eye - c.back * z + c.right * (nx * z * c.tx) + c.up * (ny * z * c.ty);
}

// The sticker on the surface: left, top, right, bottom.
struct Rect {
    float l, t, r, b;
};

float cross2(P2 o, P2 a, P2 b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }

// A small fixed-size point list: a clipped box has at most 8 corners and 24
// edge crossings, and clipping a convex polygon to another adds at most one
// vertex per clipping edge.
struct Poly {
    P2 p[80];
    int n = 0;
    void add(P2 q) { p[n++] = q; }
};

// The convex hull of `in` (monotone chain): counter-clockwise in the plain
// sense of its coordinates, so a point is inside an edge where cross2 >= 0.
Poly hull(Poly in) {
    std::sort(in.p, in.p + in.n, [](P2 a, P2 b) { return a.x < b.x || (a.x == b.x && a.y < b.y); });
    if (in.n < 3) return in;
    P2 h[160];
    int k = 0;
    for (int i = 0; i < in.n; i++) {
        while (k >= 2 && cross2(h[k - 2], h[k - 1], in.p[i]) <= 0) k--;
        h[k++] = in.p[i];
    }
    for (int i = in.n - 2, lo = k + 1; i >= 0; i--) {
        while (k >= lo && cross2(h[k - 2], h[k - 1], in.p[i]) <= 0) k--;
        h[k++] = in.p[i];
    }
    Poly out;
    for (int i = 0; i < k - 1; i++) out.add(h[i]);
    return out;
}

// `poly` clipped to convex polygon `by` (Sutherland-Hodgman); both in hull's
// winding. Two buffers swap between edges rather than a copy per edge.
Poly clipTo(const Poly& poly, const Poly& by) {
    if (poly.n == 0 || by.n < 3) return Poly{};
    Poly buf[2];
    buf[0] = poly;
    int cur = 0;
    for (int e = 0; e < by.n && buf[cur].n > 0; e++) {
        const P2 a = by.p[e], b = by.p[(e + 1) % by.n];
        const Poly& in = buf[cur];
        Poly& out = buf[cur ^ 1];
        out.n = 0;
        for (int i = 0; i < in.n; i++) {
            const P2 p = in.p[i], q = in.p[(i + 1) % in.n];
            const float dp = cross2(a, b, p), dq = cross2(a, b, q);
            if (dp >= 0) out.add(p);
            if ((dp >= 0) != (dq >= 0)) {
                const float t = dp / (dp - dq);
                out.add({ p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t });
            }
        }
        cur ^= 1;
    }
    return buf[cur];
}

float area(const Poly& poly) {
    float a = 0;
    for (int i = 0; i < poly.n; i++) {
        const P2 p = poly.p[i], n = poly.p[(i + 1) % poly.n];
        a += p.x * n.y - n.x * p.y;
    }
    return std::fabs(a) * 0.5f;
}

// Box `k`'s slice [y0, y1] up its own axis (half width hw, half length hl)
// projected onto the surface: only the part between the near plane and the
// tag's depth, hulled. Its vertices are the corners inside that slab and the
// edges' crossings of its two planes. Empty when nothing of it is in the slab
// or its bounds miss `q`.
Poly projectBox(const Cam& c, const Box& k, float hw, float hl, float y0, float y1, float zNear, float zTag,
                const Rect& q) {
    V3 corner[8];
    float zMin = 1e30f, zMax = -1e30f;
    for (int b = 0; b < 8; b++) {
        const V3 p = k.o + k.r * ((b & 1) ? hw : -hw) + k.u * ((b & 2) ? y1 : y0) + k.fw * ((b & 4) ? hl : -hl);
        corner[b] = viewOf(c, p);
        zMin = std::min(zMin, corner[b].z);
        zMax = std::max(zMax, corner[b].z);
    }
    Poly pts;
    if (zMin >= zTag || zMax <= zNear) return pts;  // wholly behind the tag, or the eye
    for (int b = 0; b < 8; b++)
        if (corner[b].z >= zNear && corner[b].z <= zTag) pts.add(screenOf(c, corner[b]));
    for (int a = 0; a < 8; a++)
        for (int bit = 1; bit < 8; bit <<= 1) {
            if (a & bit) continue;
            const V3 p = corner[a], e = corner[a | bit];
            for (const float z : { zNear, zTag }) {
                if ((p.z - z) * (e.z - z) >= 0) continue;
                pts.add(screenOf(c, p + (e - p) * ((z - p.z) / (e.z - p.z))));
            }
        }
    if (pts.n < 3) return Poly{};
    float l = 1e30f, t = 1e30f, r = -1e30f, b = -1e30f;
    for (int i = 0; i < pts.n; i++) {
        l = std::min(l, pts.p[i].x); r = std::max(r, pts.p[i].x);
        t = std::min(t, pts.p[i].y); b = std::max(b, pts.p[i].y);
    }
    if (r <= q.l || l >= q.r || b <= q.t || t >= q.b) return Poly{};  // nowhere near the sticker
    return hull(pts);
}

// The share of `q` that truck `k` covers: its chassis below the seat and its
// car's body above, counted as their UNION, since the two overlap on screen
// wherever the camera sees the chassis's top beside the body.
float truckShare(const Cam& c, const Box& k, const NameTagShape& sh, float zNear, float zTag, const Rect& q) {
    // The truck's bounding sphere first: most trucks are nowhere near a given
    // tag's line of sight, and this rejects them before eight projections.
    const float hh = sh.roof * 0.5f;
    const float cw = NAME_TAG_MONSTER_HALF_W * sh.rigScale, cl = NAME_TAG_MONSTER_HALF_L * sh.rigScale;
    const float rad = std::sqrt(cw * cw + cl * cl + hh * hh);
    const V3 m = viewOf(c, k.o + k.u * hh);
    if (m.z - rad >= zTag || m.z + rad <= zNear) return 0;
    if (m.z - rad > zNear) {
        // Wholly in front of the eye: its image lies within rad / (z - rad) of
        // the centre's, in each axis's NDC.
        const P2 s = screenOf(c, m);
        const float ex = rad / ((m.z - rad) * c.tx) * 0.5f * c.r[2], ey = rad / ((m.z - rad) * c.ty) * 0.5f * c.r[3];
        if (s.x + ex <= q.l || s.x - ex >= q.r || s.y + ey <= q.t || s.y - ey >= q.b) return 0;
    }
    Poly rect;
    for (const P2 p : { P2{ q.l, q.t }, P2{ q.r, q.t }, P2{ q.r, q.b }, P2{ q.l, q.b } }) rect.add(p);
    const Poly chassis = clipTo(
        projectBox(c, k, cw, cl, 0, sh.seat, zNear, zTag, q), rect);
    const Poly body = projectBox(c, k, sh.bodyHalfW, sh.bodyHalfL, sh.seat, sh.roof, zNear, zTag, q);
    const Poly bodyIn = clipTo(body, rect);
    float covered = area(chassis) + area(bodyIn);
    if (chassis.n > 0 && bodyIn.n > 0) covered -= area(clipTo(chassis, body));
    return covered / ((q.r - q.l) * (q.b - q.t));
}

// The share of the sticker the deck covers, by rays to an N x N grid over it.
// Every ray lies inside the box around the eye and the sticker's corners, so
// the deck is cut once per tag to the pieces whose bounds meet it: on a flat
// track that is none at all, since the road runs below both ends.
float deckShare(const Cam& c, const NameTagDeck& deck, const Rect& q, float zTag, std::vector<uint32_t>& pieces) {
    if (deck.chunks.empty()) return 0;
    V3 lo = c.eye, hi = c.eye;
    for (const P2 s : { P2{ q.l, q.t }, P2{ q.r, q.t }, P2{ q.l, q.b }, P2{ q.r, q.b } }) {
        const V3 p = worldAt(c, s, zTag);
        lo = { std::min(lo.x, p.x), std::min(lo.y, p.y), std::min(lo.z, p.z) };
        hi = { std::max(hi.x, p.x), std::max(hi.y, p.y), std::max(hi.z, p.z) };
    }
    auto meets = [&](V3 a, V3 b) {
        return a.x <= hi.x && b.x >= lo.x && a.y <= hi.y && b.y >= lo.y && a.z <= hi.z && b.z >= lo.z;
    };
    const uint32_t n = (uint32_t) deck.left.size();
    pieces.clear();
    for (const NameTagDeck::Chunk& k : deck.chunks) {
        if (!meets(k.lo, k.hi)) continue;
        for (uint32_t i = k.first; i < k.first + k.count; i++) {
            const uint32_t j = (i + 1) % n;
            V3 a = deck.left[i], b = a;
            for (const V3& v : { deck.right[i], deck.left[j], deck.right[j] }) {
                a = { std::min(a.x, v.x), std::min(a.y, v.y), std::min(a.z, v.z) };
                b = { std::max(b.x, v.x), std::max(b.y, v.y), std::max(b.z, v.z) };
            }
            if (meets(a, b)) pieces.push_back(i);
        }
    }
    if (pieces.empty()) return 0;
    const int g = NAME_TAG_DECK_GRID;
    int hit = 0;
    for (int iy = 0; iy < g; iy++)
        for (int ix = 0; ix < g; ix++) {
            const P2 s{ q.l + (q.r - q.l) * (ix + 0.5f) / g, q.t + (q.b - q.t) * (iy + 0.5f) / g };
            if (piecesBlock(deck, pieces, c.eye, worldAt(c, s, zTag), DECK_EYE_CLEAR, DECK_CAR_CLEAR)) hit++;
        }
    return (float) hit / (float) (g * g);
}

// The share of car `s`'s sticker `q` (at depth zTag) that the scene covers:
// every monster truck — the cell's own included, since the chase camera can ride
// below its roof — bar one the camera is INSIDE (its faces point away) or one
// the renderer is ghosting in this cell; then the deck. Shares add, so two
// occluders over the same patch count it twice; the threshold is coarse enough
// that this only ever hides a tag a little early.
float coveredShare(const TtpFrameInput& f, const Cam& c, const NameTagShape* shapes, const NameTagDeck& deck,
                   const Rect& q, float zNear, float zTag, uint32_t s, uint32_t own,
                   std::vector<uint32_t>& cands) {
    const TtpCarInput* cars = ttp_frame_cars(&f);
    const TtpVec3 eyeV{ c.eye.x, c.eye.y, c.eye.z };
    float share = 0;
    for (uint32_t k = 0; k < f.carCount && share < 1; k++) {
        if (k == s || !alive(cars[k]) || !monster(cars[k])) continue;
        if (k != own && own < f.carCount && ttp_monster_ghosted(cars[k].pos, eyeV, &cars[own])) continue;
        const Box b = boxOf(cars[k]);
        if (inside(b, shapes[k], c.eye)) continue;
        share += truckShare(c, b, shapes[k], zNear, zTag, q);
    }
    if (share < 1) share += deckShare(c, deck, q, zTag, cands);
    return std::min(1.0f, share);
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

std::vector<NameTag> nameTags(const TtpFrameInput& f, const float* pictures, const NameTagShape* shapes,
                              const NameTagSize* sizes, const NameTagDeck& deck,
                              std::vector<NameTagCover>& cover) {
    std::vector<NameTag> out;
    // Only players are tagged, so a single cell has nobody to tag.
    if ((f.flags & TTP_FRAME_OVERVIEW) || f.viewCount < 2 || !pictures || !shapes || !sizes) return out;
    const TtpCarInput* cars = ttp_frame_cars(&f);
    const TtpViewInput* views = ttp_frame_views(&f);
    // A new field or split starts every tag clear.
    if (cover.size() != (size_t) f.viewCount * f.carCount) cover.assign((size_t) f.viewCount * f.carCount, {});
    const float step = f.dt / NAME_TAG_COVER_FADE;
    std::vector<std::pair<float, NameTag>> cell;  // (eye distance, tag)
    std::vector<uint32_t> cands;
    for (uint32_t i = 0; i < f.viewCount; i++) {
        const TtpViewInput& v = views[i];
        if (v.car < 0) continue;  // a cell whose car is not in this scene yet
        const float* w = v.world;
        // world is rigid (lookAtWorld), so its inverse is the transposed basis.
        const float ty = std::tan(v.fov * 0.5f * (float) M_PI / 180.0f);
        const Cam cam{ { w[12], w[13], w[14] }, { w[0], w[1], w[2] }, { w[4], w[5], w[6] }, { w[8], w[9], w[10] },
                       ty * v.aspect, ty, pictures + 4 * i };
        cell.clear();
        // The other cells' cars: the players. CPU cars own no cell.
        for (uint32_t j = 0; j < f.viewCount; j++) {
            const int32_t other = views[j].car;
            if (other < 0 || (uint32_t) other >= f.carCount || other == v.car) continue;
            const uint32_t s = (uint32_t) other;
            const TtpCarInput& c = cars[s];
            if (!alive(c)) continue;
            const V3 anchor = v3(c.pos) + norm(v3(c.up)) * (shapes[s].roof + NAME_TAG_ROOF_GAP);
            const V3 a = viewOf(cam, anchor);
            if (a.z <= v.nearZ) continue;
            const P2 at = screenOf(cam, a);
            const float* r = cam.r;
            if (at.x < r[0] || at.x > r[0] + r[2] || at.y < r[1] || at.y > r[1] + r[3]) continue;
            const float dist = std::sqrt(dot(anchor - cam.eye, anchor - cam.eye));
            if (dist >= NAME_TAG_FAR) continue;
            const float fade = (NAME_TAG_FAR - dist) / (NAME_TAG_FAR - NAME_TAG_FADE);
            const float scale = scaleAt(dist);
            // The sticker as the shell draws it: scaled about the anchor.
            const NameTagSize& z = sizes[s];
            const Rect q{ at.x - scale * z.w * 0.5f, at.y - scale * (z.lift + z.h),
                          at.x + scale * z.w * 0.5f, at.y - scale * z.lift };
            NameTagCover& st = cover[(size_t) i * f.carCount + s];
            if (q.r > q.l && q.b > q.t) {
                const float share = coveredShare(f, cam, shapes, deck, q, v.nearZ, a.z, s, (uint32_t) v.car, cands);
                st.hidden = st.hidden ? share > NAME_TAG_SHOW_AT : share >= NAME_TAG_HIDE_AT;
            }
            st.clear = st.hidden ? std::max(0.0f, st.clear - step) : std::min(1.0f, st.clear + step);
            if (st.clear <= 0) continue;
            NameTag t;
            t.cell = (int32_t) i;
            t.target = (int32_t) s;
            t.x = at.x;
            t.y = at.y;
            t.scale = scale;
            t.alpha = std::min(1.0f, fade) * st.clear;
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
