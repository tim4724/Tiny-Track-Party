// The track scene build: terrain, ground sheet, road chunks, gantry and the
// hill ring. TtpRendererImpl.h carries what the topic files share.
#include <array>
#include <chrono>
#include <cstring>
#include <map>
#include <numeric>
#include <utility>

#include <utils/Log.h>

#include "TtpRendererImpl.h"
#include "TtpRendererKit.h"

#include "ttp/kitfield.h"   // header-only; the renderer may not link libttp-runtime


namespace {
// Terrain value noise: integer lattice hash, cosine-eased bilinear blend.
// Renderer-local and cosmetic — no JS twin, no conformance corpus behind it —
// but integer-hashed rather than sin-based so every platform draws the same
// hills for the same track.
uint32_t terrainHash(uint32_t seed, int32_t xi, int32_t zi) {
    uint32_t h = seed;
    h ^= (uint32_t) xi * 0x27d4eb2du; h = (h ^ (h >> 15)) * 0x85ebca6bu;
    h ^= (uint32_t) zi * 0x165667b1u; h = (h ^ (h >> 13)) * 0xc2b2ae35u;
    return h ^ (h >> 16);
}
float terrainNoise(uint32_t seed, float x, float z) { // [0, 1)
    const float fx = std::floor(x), fz = std::floor(z);
    const int32_t xi = (int32_t) fx, zi = (int32_t) fz;
    float tx = x - fx, tz = z - fz;
    tx = tx * tx * (3.0f - 2.0f * tx);
    tz = tz * tz * (3.0f - 2.0f * tz);
    const auto at = [&](int32_t dx, int32_t dz) {
        return (float) (terrainHash(seed, xi + dx, zi + dz) >> 8) / 16777216.0f;
    };
    const float a = at(0, 0) + (at(1, 0) - at(0, 0)) * tx;
    const float b = at(0, 1) + (at(1, 1) - at(0, 1)) * tx;
    return a + (b - a) * tz;
}
float smooth01(float t) {
    t = std::min(1.0f, std::max(0.0f, t));
    return t * t * (3.0f - 2.0f * t);
}
float lerp(float a, float b, float t) { return a + (b - a) * t; }
} // namespace

// The open-country biomes (lawn, redrock, snow) get a shaped ground: it rises
// under raised road and rolls into hills away from it. Sand gets dunes, but
// only inland of the road and never at the water (beachMask): the shoreline
// and the water sheet assume the plane there. The playroom's wood floor stays
// flat: an indoor floor with hills under the boards reads as a defect, not a
// landscape.
void TtpRenderer::setupTerrain(const TrackBin& tb) {
    switch (tb.groundKind) {
        case 0: mTerrainAmp = 4.6f; break;  // lawn
        case 1: mTerrainAmp = 3.6f; break;  // sand — soft dunes, inland only
        case 2: mTerrainAmp = 6.5f; break;  // redrock — badlands earn the drama
        case 3: mTerrainAmp = 5.2f; break;  // snow
        default: mTerrainAmp = 0; break;    // wood
    }
    mInland.clear();
    mShoreR.clear();
    mShoreSup.clear();
    mShoreSink.clear();
    mGroundGrid = {};
    mGroundGrid.flatY = tb.groundY;
    mTerrainCap.clear();
    // Own stream, derived from the scatter seed: reusing scSeed1's VALUE (not
    // its stream) keeps every existing tree/clutter/landmark roll untouched.
    mTerrainSeed = tb.scSeed1 ^ 0x7465726eu;
    mTerrainFlats.clear();
    mVergeHolds.clear();
    float x0 = 1e30f, z0 = 1e30f, x1 = -1e30f, z1 = -1e30f;
    for (const auto& s : tb.samples) {
        x0 = std::min(x0, s.pos.x); x1 = std::max(x1, s.pos.x);
        z0 = std::min(z0, s.pos.z); z1 = std::max(z1, s.pos.z);
    }
    // Hills live in the track's own neighbourhood; past the region the flat
    // sheet resumes, well before the horizon ring's feature bases. The beach's
    // dunes stand inside the loop, so its region only needs the border fade's
    // room past the road (a landform out on the beach grows it below): every
    // grid vertex out there would be flat sand costing what a hill does.
    const float EXT = tb.groundKind == 1 ? kRampR + 6.0f : 90.0f, LIM = 390.0f;
    x0 -= EXT; x1 += EXT; z0 -= EXT; z1 += EXT;
    if (tb.samples.empty()) mTerrainAmp = 0;
    // The landforms, into the world. One whose reach passes the region grows
    // it (by the border fade's width too), so no form is cut off at the edge.
    mLand.clear();
    mSetOwnGround.assign(tb.setPieces.size(), -1.0f);
    std::vector<float2> anchors(tb.setPieces.size());
    if (mTerrainAmp > 0) {
        for (const ttp::rt::Landform& l : tb.land) {
            if (l.kind == 6) continue;   // a shore moves the sea, not the land (shoreline())
            if (l.kind == 9 || l.kind == 10 || l.kind == 11) continue;   // the road's own (buildRoadMesh)
            float u = l.u, lat = l.lat, yaw = l.yaw, k = 1.0f;
            if (l.piece >= 0) {
                if ((size_t) l.piece >= tb.setPieces.size()) continue;
                const auto& p = tb.setPieces[(size_t) l.piece];
                u = p.u; lat = p.lat; yaw += p.yaw; k = p.scale;
                mSetOwnGround[(size_t) l.piece] = 0;
            }
            // buildSetPieces' frame, so a piece and its ground cannot disagree.
            const TrackBin::Sample f = tb.frameAt(u * tb.length);
            const float3 t = f.tangent();
            const float hd = std::atan2(t.x, t.z) + yaw;
            const float ax = std::cos(hd), az = -std::sin(hd);
            const float px = f.pos.x + f.lat.x * lat, pz = f.pos.z + f.lat.z * lat;
            if (l.piece >= 0) anchors[(size_t) l.piece] = { px, pz };
            const float3 tint = l.tint ? float3{ (float) ((l.tint >> 16) & 0xff),
                    (float) ((l.tint >> 8) & 0xff), (float) (l.tint & 0xff) } / 255.0f : float3{ 1.0f };
            LandShape s{ l.kind, l.piece,
                    px + (ax * l.x - az * l.z) * k, pz + (az * l.x + ax * l.z) * k, ax, az,
                    l.len * k, l.r * k, l.r1 * k, l.w * k, l.rz * k, l.h * k, l.h1 * k,
                    l.top, l.shape, 0, 0, 0, 0, 0, tint, l.near > 0 ? l.near + tb.kerbW : 0.0f };
            // What the form reaches, as a box on its own axes: +X, -X, +-Z.
            float px1 = 0, nx1 = 0, zz = 0, fade = 1.0f;
            switch (s.kind) {
                case 0: px1 = nx1 = std::max(s.r, s.r1); zz = 0.5f * s.len + px1; break; // ridge
                case 1: px1 = nx1 = zz = s.r + s.w; break;                               // ring
                case 2: case 7:                                                          // plain, its banks; pond
                        px1 = nx1 = s.r + (s.kind == 7 ? kPondFloor : 0.0f) + (s.h > 0 ? 2.6f : 1.0f) * s.w;
                        zz = 0.5f * s.len + px1; break;
                case 5: px1 = nx1 = s.r + s.w; zz = 0.5f * s.len + px1; break;           // paint
                case 8: px1 = nx1 = s.r; zz = 0.5f * s.len + px1; break;                 // clear
                case 4: px1 = nx1 = std::max(s.r, s.r1); zz = 0.5f * s.len + px1; fade = 1.3f; break; // fan
                default: px1 = s.r; nx1 = s.r1; zz = s.rz; fade = 1.3f; break;          // mound
            }
            // The world box, for the quick reject, takes in a mound's fade too;
            // the REGION only what rises (the fade just gives the land back).
            const auto worldBox = [&](float k2, float& bx0, float& bz0, float& bx1, float& bz1) {
                bx0 = bz0 = 1e30f; bx1 = bz1 = -1e30f;
                for (const float lx : { px1 * k2, -nx1 * k2 }) {
                    for (const float lz : { zz * k2, -zz * k2 }) {
                        const float wx = s.x + ax * lx - az * lz, wz = s.z + az * lx + ax * lz;
                        bx0 = std::min(bx0, wx); bx1 = std::max(bx1, wx);
                        bz0 = std::min(bz0, wz); bz1 = std::max(bz1, wz);
                    }
                }
            };
            worldBox(fade, s.x0, s.z0, s.x1, s.z1);
            mLand.push_back(s);
            float rx0, rz0, rx1, rz1;
            worldBox(1.0f, rx0, rz0, rx1, rz1);
            x0 = std::min(x0, rx0 - kRampR); x1 = std::max(x1, rx1 + kRampR);
            z0 = std::min(z0, rz0 - kRampR); z1 = std::max(z1, rz1 + kRampR);
        }
    }
    mTerrainX0 = std::max(x0, -LIM); mTerrainX1 = std::min(x1, LIM);
    mTerrainZ0 = std::max(z0, -LIM); mTerrainZ1 = std::min(z1, LIM);
    if (mTerrainAmp <= 0) return;
    if (tb.groundKind == 1) setupBeachMask(tb);
    // The grid's cell is decided here, before anything samples the field,
    // because the deck cap is kept per grid vertex (buildTerrainCap).
    //
    // THE STEP IS A COST, NOT A LOOK. The field's shortest wavelength is 34 u
    // (terrainY), so a 9 u step still puts nearly four samples on every swell;
    // the 4.5 u it used to be drew ~18k triangles per cell for hills a few units
    // tall, ~1 ms of vertex work at four cells on the Android box
    // (docs/perf/androidtv-frame-map.md, 2026-09-09).
    constexpr float STEP = 9.0f;
    mGroundGrid.cols = std::min(48, std::max(12,
            (int) std::ceil((mTerrainX1 - mTerrainX0) / STEP)));
    mGroundGrid.rows = std::min(48, std::max(12,
            (int) std::ceil((mTerrainZ1 - mTerrainZ0) / STEP)));
    mGroundGrid.x0 = mTerrainX0;
    mGroundGrid.z0 = mTerrainZ0;
    mGroundGrid.sx = (mTerrainX1 - mTerrainX0) / mGroundGrid.cols;
    mGroundGrid.sz = (mTerrainZ1 - mTerrainZ0) / mGroundGrid.rows;
    buildTerrainSampleIndex(tb);
    buildTerrainCap(tb);
    // A piece whose ground is a mound or a fan stands where the land is
    // raised at its anchor, and its ground rises from there (LandShape::base):
    // the parts at its foot meet the raised verge rather than being buried by it.
    for (LandShape& s : mLand) {
        if ((s.kind != 3 && s.kind != 4) || s.piece < 0) continue;
        const float2 a = anchors[(size_t) s.piece];
        float edge;
        s.base = roadLift(tb, a.x, a.y, edge);
        mSetOwnGround[(size_t) s.piece] = s.base;
    }
}

// The beach's two masks (see mInland in TtpRenderer.h). The loop's inside is
// rasterised once by scanline over the centreline polygon; a cell is only 2 u
// and the road's own corridor keeps the hills down for several units either
// side of the centreline, so the raster's steps never show. The shoreline is
// tabled by bearing off the very curve the sea is drawn on.
void TtpRenderer::setupBeachMask(const TrackBin& tb) {
    const size_t n = tb.samples.size();
    mInlandCols = std::max(1, (int) std::ceil((mTerrainX1 - mTerrainX0) / kInlandCell));
    mInlandRows = std::max(1, (int) std::ceil((mTerrainZ1 - mTerrainZ0) / kInlandCell));
    mInland.assign((size_t) mInlandCols * mInlandRows, 0);
    std::vector<float> cross;
    for (int r = 0; r < mInlandRows && tb.closed; r++) {
        const float z = mTerrainZ0 + (r + 0.5f) * kInlandCell;
        cross.clear();
        for (size_t i = 0; i < n; i++) {
            const float3 a = tb.samples[i].pos, b = tb.samples[(i + 1) % n].pos;
            if ((a.z <= z) == (b.z <= z)) continue;
            cross.push_back(a.x + (b.x - a.x) * (z - a.z) / (b.z - a.z));
        }
        std::sort(cross.begin(), cross.end());
        for (size_t k = 0; k + 1 < cross.size(); k += 2) {
            const int c0 = std::max(0, (int) std::ceil((cross[k] - mTerrainX0) / kInlandCell - 0.5f));
            const int c1 = std::min(mInlandCols - 1,
                    (int) std::floor((cross[k + 1] - mTerrainX0) / kInlandCell - 0.5f));
            for (int c = c0; c <= c1; c++) mInland[(size_t) r * mInlandCols + c] = 1;
        }
    }
    if (!tb.hasWater) return;
    const Shoreline shore = shoreline(tb);
    mShoreR.resize(kShoreSpokes);
    for (int k = 0; k < kShoreSpokes; k++) mShoreR[k] = shore.at(k * 2.0f * (float) M_PI / kShoreSpokes);
    if (std::none_of(shore.bays.begin(), shore.bays.end(), [](const Shoreline::Bay& b) { return b.sunk; })) return;
    mShoreSup.resize(kShoreSpokes);
    mShoreSink.resize(kShoreSpokes);
    for (int k = 0; k < kShoreSpokes; k++) {
        const float a = k * 2.0f * (float) M_PI / kShoreSpokes;
        mShoreSup[k] = shore.support(a);
        mShoreSink[k] = shore.sunk(a);
    }
}

// The sunk sea (TtpRenderer.h, kSeaSink): read off the spoke tables by
// bearing, so a grid vertex never walks the track.
float TtpRenderer::seaSink(float x, float z) const {
    if (mShoreSink.empty()) return 0.0f;
    float f = std::atan2(z, x) / (2.0f * (float) M_PI) * kShoreSpokes;
    if (f < 0) f += kShoreSpokes;
    const int k = std::min(kShoreSpokes - 1, (int) f), k1 = (k + 1) % kShoreSpokes;
    const float t = f - k;
    const float sink = mShoreSink[k] + (mShoreSink[k1] - mShoreSink[k]) * t;
    if (sink <= 0) return 0.0f;
    const float sup = mShoreSup[k] + (mShoreSup[k1] - mShoreSup[k]) * t;
    const float out = std::sqrt(x * x + z * z) - sup;
    // Linear, as the sheet is between its rings at kSinkHold and kSinkOpen.
    return kSeaSink * sink * (1.0f - std::min(1.0f, std::max(0.0f, (out - kSinkHold) / (kSinkOpen - kSinkHold))));
}

// The ground under a sunk sea: down from the plain to the water's level over
// kSinkBeach, reaching it kSinkShore inside the waterline, then kSinkBed
// further under the water. The 9 u grid's chords decide where the drawn sand
// actually meets the water, so the sheet reaches in under the beach there
// (kSinkInset, buildWater) and the drawn ground sets the edge. All of it
// scales with how far the sea has sunk, so where the bay eases out the
// beach does too.
float TtpRenderer::bedSink(float x, float z) const {
    const float sink = seaSink(x, z);
    if (sink <= 0) return 0.0f;
    float f = std::atan2(z, x) / (2.0f * (float) M_PI) * kShoreSpokes;
    if (f < 0) f += kShoreSpokes;
    const int k = std::min(kShoreSpokes - 1, (int) f);
    const float t = f - k;
    const float R = mShoreR[k] + (mShoreR[(k + 1) % kShoreSpokes] - mShoreR[k]) * t;
    const float d = std::sqrt(x * x + z * z) - R + kSinkShore;   // past the water's edge
    const float share = sink / kSeaSink;
    return share * ((kSeaSink - kWaterLift) * smooth01((d + kSinkBeach) / kSinkBeach)
                    + (kWaterLift + kSinkBed) * smooth01(d / 3.0f));
}

float TtpRenderer::beachMask(float x, float z, float& inland) const {
    inland = 1.0f;
    if (mInland.empty()) return 1.0f;
    const int c = (int) std::floor((x - mTerrainX0) / kInlandCell);
    const int r = (int) std::floor((z - mTerrainZ0) / kInlandCell);
    inland = c >= 0 && r >= 0 && c < mInlandCols && r < mInlandRows
            && mInland[(size_t) r * mInlandCols + c] ? 1.0f : 0.0f;
    if (mShoreR.empty()) return 1.0f;
    float f = std::atan2(z, x) / (2.0f * (float) M_PI) * kShoreSpokes;
    if (f < 0) f += kShoreSpokes;
    const int k = std::min(kShoreSpokes - 1, (int) f);
    const float t = f - k;
    const float R = mShoreR[k] + (mShoreR[(k + 1) % kShoreSpokes] - mShoreR[k]) * t;
    return smooth01((R - kShoreKeep - std::sqrt(x * x + z * z)) / kShoreRamp);
}

// A bucket index over the track samples in XZ, so terrainY can ask "how far to
// the road, and how high is it" without walking the whole centreline.
//
// It walked it before: ~9,400 grid points times a few thousand samples is ~19
// MILLION distance-with-sqrt per build, and it measured 72 ms on the Android
// reference box — 46% of a rebuild once the bodies were pooled, and the single
// biggest phase left. A cache would have hidden it and still paid it on the
// first build of every track, which is the one that hurts.
//
// EXACT, not approximate, and that is what the cell size buys. A sample can
// only change terrainY's answer within its reach — the hills' ramp, or the
// raised ground's blend and ramp, past its own half-width — and a search of
// the cells within that reach covers every one of them.
void TtpRenderer::buildTerrainSampleIndex(const TrackBin& tb) {
    mTsiCells.clear();
    mTsiTopY.clear();
    mTsiSpan.clear();
    mTsiCols = mTsiRows = 0;
    if (tb.samples.empty()) return;
    const size_t n = tb.samples.size();
    float maxHalfW = 0;
    mTsiTopY.resize(n);
    mTsiSpan.resize(n);
    for (size_t i = 0; i < n; i++) {
        const auto& s = tb.samples[i];
        const float half = s.width * 0.5f;
        maxHalfW = std::max(maxHalfW, half);
        // The deck's top at its lower edge, so a banked deck lifts the ground
        // only as far as its low side allows.
        mTsiTopY[i] = std::min((s.pos + s.lat * half).y, (s.pos - s.lat * half).y);
        const auto& prev = tb.samples[(i + n - 1) % n];
        const auto& next = tb.samples[(i + 1) % n];
        mTsiSpan[i] = 0.5f * (length(next.pos - s.pos) + length(s.pos - prev.pos));
    }
    mTsiReach = std::max(kFlatR + kRampR, kRaiseFlatR + kRaiseRampR) + maxHalfW;
    mTsiX0 = mTerrainX0 - mTsiReach;
    mTsiZ0 = mTerrainZ0 - mTsiReach;
    const float w = (mTerrainX1 + mTsiReach) - mTsiX0;
    const float h = (mTerrainZ1 + mTsiReach) - mTsiZ0;
    mTsiCols = std::max(1, (int) std::ceil(w / kIndexCell));
    mTsiRows = std::max(1, (int) std::ceil(h / kIndexCell));
    mTsiCells.assign((size_t) mTsiCols * mTsiRows, {});
    for (uint32_t i = 0; i < n; i++) {
        const auto& s = tb.samples[i];
        const int c = (int) ((s.pos.x - mTsiX0) / kIndexCell);
        const int r = (int) ((s.pos.z - mTsiZ0) / kIndexCell);
        if (c < 0 || r < 0 || c >= mTsiCols || r >= mTsiRows) continue;
        mTsiCells[(size_t) r * mTsiCols + c].push_back(i);
    }
}

// THE DECK CAP, per grid vertex. Every sample's deck section is a disc in XZ
// (half-width, kerb and half the way to its farther neighbour), and every
// grid TRIANGLE that disc touches gets its three corners capped at the
// deck's TOP at the section's lower kerb edge, bank included, less
// kDeckClear. A linear triangle never rises above its highest corner, so no
// point of the drawn surface comes through any deck: the LOWER road at a
// crossing included, which is how a road under a bridge stays open. The
// ground may meet the slab inside its skirt, where the opaque deck hides it.
// Per triangle rather than per radius, so the cap reaches only the cells a
// deck actually crosses and the ground can still rise one cell beside it.
void TtpRenderer::buildTerrainCap(const TrackBin& tb) {
    const int cols = mGroundGrid.cols, rows = mGroundGrid.rows;
    const float sx = mGroundGrid.sx, sz = mGroundGrid.sz;
    mTerrainCap.assign((size_t) (cols + 1) * (rows + 1), 1e30f);
    // Squared distance from p to the triangle (a, b, c) in XZ; 0 inside.
    const auto triDist2 = [](float2 p, float2 a, float2 b, float2 c) {
        const auto cr = [](float2 u, float2 v) { return u.x * v.y - u.y * v.x; };
        const float s0 = cr(b - a, p - a), s1 = cr(c - b, p - b), s2 = cr(a - c, p - c);
        if ((s0 >= 0 && s1 >= 0 && s2 >= 0) || (s0 <= 0 && s1 <= 0 && s2 <= 0)) return 0.0f;
        const auto seg = [](float2 q, float2 u, float2 v) {
            const float2 e = v - u;
            const float t = std::min(1.0f, std::max(0.0f, dot(q - u, e) / dot(e, e)));
            const float2 d = q - (u + e * t);
            return dot(d, d);
        };
        return std::min({ seg(p, a, b), seg(p, b, c), seg(p, c, a) });
    };
    const size_t n = tb.samples.size();
    for (size_t i = 0; i < n; i++) {
        const auto& s = tb.samples[i];
        const float half = s.width * 0.5f + tb.kerbW;
        const float lim = std::min((s.pos + s.lat * half).y, (s.pos - s.lat * half).y) - kDeckClear;
        // Out to halfway to each neighbour, so the discs cover the whole deck
        // whatever the spacing (it stretches where the lap closes).
        const float gap = std::max(length(tb.samples[(i + 1) % n].pos - s.pos),
                                   length(s.pos - tb.samples[(i + n - 1) % n].pos));
        const float R = half + 0.5f * gap + 0.05f;
        const float2 p{ s.pos.x, s.pos.z };
        const int c0 = std::max(0, (int) std::floor((p.x - R - mTerrainX0) / sx));
        const int c1 = std::min(cols - 1, (int) std::floor((p.x + R - mTerrainX0) / sx));
        const int r0 = std::max(0, (int) std::floor((p.y - R - mTerrainZ0) / sz));
        const int r1 = std::min(rows - 1, (int) std::floor((p.y + R - mTerrainZ0) / sz));
        for (int r = r0; r <= r1; r++) {
            for (int c = c0; c <= c1; c++) {
                // The cell's two triangles, split on the b–d diagonal like the
                // mesh and GroundGrid::at: (a, d, b) and (b, d, e).
                const size_t ia = (size_t) r * (cols + 1) + c, ib = ia + 1;
                const size_t id = ia + (size_t) cols + 1, ie = id + 1;
                const float2 a{ mTerrainX0 + c * sx, mTerrainZ0 + r * sz };
                const float2 b = a + float2{ sx, 0 }, d = a + float2{ 0, sz };
                const float2 e = a + float2{ sx, sz };
                if (triDist2(p, a, d, b) <= R * R) {
                    for (const size_t v : { ia, id, ib }) mTerrainCap[v] = std::min(mTerrainCap[v], lim);
                }
                if (triDist2(p, b, d, e) <= R * R) {
                    for (const size_t v : { ib, id, ie }) mTerrainCap[v] = std::min(mTerrainCap[v], lim);
                }
            }
        }
    }
}

// The cap at any point: its own vertex's on the grid, and between vertices the
// lowest corner of the triangle it lies in — what the drawn surface there can
// reach at most, so a height read off-grid is never above the one drawn.
float TtpRenderer::terrainCapAt(float x, float z) const {
    if (mTerrainCap.empty()) return 1e30f;
    const int cols = mGroundGrid.cols, rows = mGroundGrid.rows;
    const float u = (x - mTerrainX0) / mGroundGrid.sx, v = (z - mTerrainZ0) / mGroundGrid.sz;
    if (u < 0 || v < 0 || u > cols || v > rows) return 1e30f;
    const int c = std::min(cols - 1, (int) u), r = std::min(rows - 1, (int) v);
    const float fu = u - c, fv = v - r;
    const auto at = [&](int cc, int rr) { return mTerrainCap[(size_t) rr * (cols + 1) + cc]; };
    const float tri = fu + fv <= 1.0f
            ? std::min({ at(c, r), at(c + 1, r), at(c, r + 1) })
            : std::min({ at(c + 1, r + 1), at(c + 1, r), at(c, r + 1) });
    return tri;
}

float TtpRenderer::terrainY(const TrackBin& tb, float x, float z, bool withFlats) const {
    return std::max(tb.groundY - bedSink(x, z), std::min(terrainField(tb, x, z, withFlats), terrainCapAt(x, z)));
}

// What the road decides at (x, z): how far its nearest EDGE is, and the raised
// ground's lift there above the plain (before the border fade and any landform).
float TtpRenderer::roadLift(const TrackBin& tb, float x, float z, float& edge) const {
    // One walk over the samples in reach (buildTerrainSampleIndex) gathers
    // what the road decides here: how far its nearest EDGE is (each sample's
    // own width, like the scatter's isClear) and which sample that is, the
    // blend of deck heights nearby, and the samples close enough to matter.
    float wSum = 0, tSum = 0;
    edge = 1e30f;
    uint32_t nearest = 0;
    const float raiseR = kRaiseFlatR + kRaiseRampR;
    const int span = (int) std::ceil(mTsiReach / kIndexCell);
    const int cq = (int) ((x - mTsiX0) / kIndexCell);
    const int rq = (int) ((z - mTsiZ0) / kIndexCell);
    mTsiNear.clear();
    for (int r = std::max(0, rq - span); r <= std::min(mTsiRows - 1, rq + span); r++) {
        for (int c = std::max(0, cq - span); c <= std::min(mTsiCols - 1, cq + span); c++) {
            for (const uint32_t i : mTsiCells[(size_t) r * mTsiCols + c]) {
                const auto& sm = tb.samples[i];
                const float dx = x - sm.pos.x, dz = z - sm.pos.z;
                const float d = std::sqrt(dx * dx + dz * dz) - sm.width * 0.5f;
                if (d < edge) { edge = d; nearest = i; }
                if (d < raiseR) {
                    // Inverse-square in the distance past the edge, softened
                    // so the deck right overhead does not swamp a vertex just
                    // beside it; per unit of road, not per sample.
                    const float dd = std::max(0.0f, d);
                    const float w = mTsiSpan[i] / (dd * dd + 4.0f);
                    wSum += w;
                    tSum += w * mTsiTopY[i];
                    mTsiNear.push_back({ i, d });
                }
            }
        }
    }
    // The raised ground: kVergeDrop under low road, kRaiseDrop under raised
    // road and level between (TtpRenderer.h), held out to kRaiseFlatR past
    // the edge and relaxing to the plain over kRaiseRampR. Close in, the
    // deck is the nearest one; further out, the blend. And never over the
    // cone each OTHER strand of road allows (a crossing, the far side of a
    // hairpin: further along the lap than a strand's own reach) — flat out to
    // kRaiseFlatR past it, climbing kStrandSlope past that — so no bank rises
    // beside the lower road and the road under a bridge stays open. A verge
    // hold (TtpRenderer.h) brings its footprint's nearest road edge to every
    // point on or around it: the distance the band fades by, not the hills'.
    float reach = edge;
    for (const VergeHold& h : mVergeHolds) {
        const float dx = x - h.x, dz = z - h.z;
        const float u = std::max(0.0f, std::fabs(dx * h.ax + dz * h.az) - h.hx);
        const float v = std::max(0.0f, std::fabs(dz * h.ax - dx * h.az) - h.hz);
        reach = std::min(reach, h.e0 + std::sqrt(u * u + v * v));
    }
    float lift = 0;
    if (wSum > 0 && reach < raiseR) {
        const float blend = tSum / wSum, nearTop = mTsiTopY[nearest];
        float target = nearTop + (blend - nearTop) * smooth01((reach - kRaiseFlatR) / 12.0f);
        const float s0 = tb.samples[nearest].s;
        for (const auto& [i, d] : mTsiNear) {
            const float ds = std::fabs(tb.samples[i].s - s0);
            if (std::min(ds, tb.length - ds) < kOtherStrandS) continue;
            target = std::min(target, mTsiTopY[i] + kStrandSlope * std::max(0.0f, d - kRaiseFlatR));
        }
        const float h = target - tb.groundY;
        lift = std::max(0.0f, std::min(h - kVergeDrop, std::max(kVergeLow - kVergeDrop, h - kRaiseDrop)))
             * (1.0f - smooth01((reach - kRaiseFlatR) / kRaiseRampR));
    }
    return lift;
}

// The land before the deck cap: the raised ground, the hills and (withFlats)
// the clearings, and a sunk sea's bed. Never through a deck and never under
// the plain (that bed aside) is the caller's to apply (terrainY,
// buildTerrainGrid): the pillars, posts and berms stand on groundY, and
// ground below it would leave them hanging.
float TtpRenderer::terrainField(const TrackBin& tb, float x, float z, bool withFlats,
        float* dell, float* bed, float liftCap) const {
    if (dell) *dell = 0;
    if (bed) *bed = 0;
    mNearRise = 0;
    mBeachRise = 0;
    if (mTerrainAmp <= 0 || mTsiCells.empty()) return tb.groundY;
    // Fade to the flat plane at the region border, so the outer sheet joins
    // without a step.
    const float border = std::min(
            std::min(x - mTerrainX0, mTerrainX1 - x),
            std::min(z - mTerrainZ0, mTerrainZ1 - z));
    if (border <= 0) return tb.groundY;
    float edge;
    const float lift = std::min(liftCap, roadLift(tb, x, z, edge));
    // The hills: clear of the road's corridor, full height 28 u out.
    float hill = 0;
    const float mask = smooth01((edge - kFlatR) / kRampR);
    if (mask > 0) {
        // Broad swells with a whisper of detail: short wavelengths at these
        // amplitudes read as lumps tracking the road outline, not landscape.
        const float n = 0.78f * terrainNoise(mTerrainSeed, x / 92.0f, z / 92.0f)
                      + 0.22f * terrainNoise(mTerrainSeed ^ 0x9e3779b9u, x / 34.0f, z / 34.0f);
        // Shaped so valleys sit flat and hills round off — pure noise reads as
        // static, not landscape.
        const float shape = std::pow(n, 1.15f);
        hill = mTerrainAmp * mask * shape;
        // How far down a swell this is, out where the hills are: the ground
        // colour's dell term (groundTint).
        if (dell) *dell = mask * (1.0f - shape) * smooth01(border / kRampR);
    }
    // The beach rolls inland only, and nothing stands at the water.
    float inland;
    const float shore = beachMask(x, z, inland);
    hill *= inland;
    if (dell) *dell *= inland * shore;
    const float land = mLand.empty() ? lift + hill : landforms(x, z, edge, lift, hill, dell, bed);
    // A beach rise keeps its own, tighter distance from the water (its `w`,
    // which landforms() folded into mBeachRise as the smallest among them).
    float beach = 0;
    if (mBeachRise > 0 && !mShoreR.empty()) {
        float f = std::atan2(z, x) / (2.0f * (float) M_PI) * kShoreSpokes;
        if (f < 0) f += kShoreSpokes;
        const int k = std::min(kShoreSpokes - 1, (int) f);
        const float R = mShoreR[k] + (mShoreR[(k + 1) % kShoreSpokes] - mShoreR[k]) * (f - k);
        // It fills the sand UP TO its height and adds nothing where the land
        // already stands there (the raised ground under a hop beside it).
        beach = std::max(0.0f, mBeachRise * smooth01((R - mBeachKeep - std::sqrt(x * x + z * z)) / kBeachRamp) - land * shore);
        mNearRise += beach;   // the verge band draws it at its own resolution, as it does a `near` form
    }
    float y = tb.groundY + (land * shore + beach) * smooth01(border / kRampR) - bedSink(x, z);
    if (withFlats) {
        // Cut only: a clearing lowers what stands above its level and leaves
        // a dip alone, so nothing is ever filled up under a piece.
        for (const TerrainFlat& f : mTerrainFlats) {
            if (f.y >= y) continue;
            const float dx = x - f.x, dz = z - f.z;
            const float u = std::max(0.0f, std::fabs(dx * f.ax + dz * f.az) - f.hx);
            const float v = std::max(0.0f, std::fabs(dz * f.ax - dx * f.az) - f.hz);
            const float w = 1.0f - smooth01((std::sqrt(u * u + v * v) - f.r) / 8.0f);
            y += (f.y - y) * w;
        }
    }
    return y;
}

// The landforms over the raised ground (`lift`) and the hills (`hill`), both
// above the plain, in three passes so the order of authoring never matters: a
// plain withholds the lift and the hills under it, ridges and rings add to the
// hills (fading out toward the road so a flank never walls a verge), and the
// mounds and fans a set piece brought (SET_GROUND) take the land under them:
// their union (the highest of them, each risen from its piece's base), or the
// raised ground where that stands higher, with the hills withheld (a form
// authored `near` joins the union instead) — so the piece's parts stand on
// the very surface they were modelled on, and the road beside its foot keeps
// its short stilts. A paint shapes nothing (landTint).
float TtpRenderer::landforms(float x, float z, float edge, float lift, float hill,
        float* dell, float* bed) const {
    const auto local = [&](const LandShape& s, float& lx, float& lz) {
        const float dx = x - s.x, dz = z - s.z;
        lx = dx * s.ax + dz * s.az;
        lz = dz * s.ax - dx * s.az;
    };
    // Distance to the form's spine (local Z, len long) and where along it.
    const auto spine = [](const LandShape& s, float lx, float lz, float& at) {
        const float half = 0.5f * s.len;
        const float c = std::min(half, std::max(-half, lz));
        at = s.len > 0 ? (c + half) / s.len : 0.0f;
        return std::sqrt(lx * lx + (lz - c) * (lz - c));
    };
    const auto profile = [](float t, float top) {   // 1 on the crest, 0 at the foot
        return t <= top ? 1.0f : 1.0f - smooth01((t - top) / (1.0f - top));
    };
    const auto in = [&](const LandShape& s) { return x > s.x0 && x < s.x1 && z > s.z0 && z < s.z1; };
    // A plain with a height `h` is a channel: a bank that tall along both
    // sides, its crest where the floor's fade ends, falling away over 1.6 of
    // that fade behind. The highest bank of any plain, and only where no
    // plain keeps its floor (`keepAll`), so the bank of one reach never runs
    // across the floor of the next round a bend.
    float keepAll = 1.0f, bank = 0.0f;
    for (const LandShape& s : mLand) {
        if ((s.kind != 2 && s.kind != 7) || !in(s)) continue;
        float lx, lz, at;
        local(s, lx, lz);
        const float d = spine(s, lx, lz, at);
        const float w = std::max(0.01f, s.w);
        // A pond's floor runs a little past its water, so the sheet's edge
        // lies on the plain, not on a grid chord climbing to the land.
        const float keep = smooth01((d - s.r - (s.kind == 7 ? kPondFloor : 0.0f)) / w);
        lift *= keep;
        hill *= keep;
        keepAll *= keep;
        if (dell) *dell *= keep;
        if (bed) *bed = std::max(*bed, 1.0f - keep);
        if (s.h > 0) bank = std::max(bank, s.h * keep * (1.0f - smooth01((d - s.r - w) / (1.6f * w))));
    }
    const float clear = smooth01((edge - kFlatR) / 12.0f);
    hill += bank * keepAll * clear;
    float near = 0;
    for (const LandShape& s : mLand) {
        if ((s.kind != 0 && s.kind != 1) || !in(s)) continue;
        float lx, lz, at = 0;
        local(s, lx, lz);
        float t, h;
        if (s.kind == 0) {
            const float d = spine(s, lx, lz, at);
            t = d / (s.r + (s.r1 - s.r) * at);
            h = s.h + (s.h1 - s.h) * at;
        } else {
            t = std::fabs(std::sqrt(lx * lx + lz * lz) - s.r) / s.w;
            h = s.h;
        }
        if (t >= 1.0f) continue;
        // A form authored `near` keeps its height to that close past the
        // kerb (the verge band draws it there); the rest clear the corridor.
        const float rise = h * profile(t, s.top) * (s.near > 0 ? smooth01((edge - s.near) / kNearRamp) : clear);
        if (s.kind == 0 && s.near > 0 && s.w > 0) {   // a beach rise: terrainY's own mask, not the shore's
            mBeachRise += rise;
            mBeachKeep = mBeachRise > rise ? std::min(mBeachKeep, s.w) : s.w;
            continue;
        }
        hill += rise;
        if (s.near > 0) near += rise;
        if (dell) *dell *= 1.0f - profile(t, 0);
    }
    // The mounds first, then the fans: a fan is debris lying ON what is under
    // it (a mound's foot), so its rise adds to theirs. Two fans side by side
    // (two pieces' banks overlapping) union like the mounds, the higher of
    // them: one stacked on the other buried the first's cottages in it.
    float own = 0, top = 0, mounds = 0;
    for (const uint32_t kind : { 3u, 4u }) {
        if (kind == 4) mounds = top;
        for (const LandShape& s : mLand) {
            if (s.kind != kind || !in(s)) continue;
            float lx, lz, t, rise;
            local(s, lx, lz);
            if (kind == 3) {
                // set_prototypes.py mound(): an oval reaching r toward +X, r1
                // behind, rz along, its flank cos(t·π/2)^shape.
                const float rx = lx > 0 ? s.r : s.r1;
                t = std::sqrt((lx / rx) * (lx / rx) + (lz / s.rz) * (lz / s.rz));
                rise = t < 1.0f ? s.h * std::pow(std::cos(t * (float) M_PI * 0.5f), s.shape) : 0.0f;
            } else {
                // A fan: a ridge's capsule and crest.
                float at;
                const float d = spine(s, lx, lz, at);
                t = d / (s.r + (s.r1 - s.r) * at);
                rise = t < 1.0f ? (s.h + (s.h1 - s.h) * at) * profile(t, s.top) : 0.0f;
            }
            const float o = 1.0f - smooth01((t - 1.0f) / 0.3f);
            if (o <= 0) continue;
            own = std::max(own, o);
            top = std::max(top, kind == 3 ? s.base * o + rise : std::max(mounds, s.base * o) + rise);
        }
    }
    if (dell) *dell *= 1.0f - own;
    // A form authored `near` is not withheld under a mound: it joins their
    // union, the higher of them (a mountainside the road is cut into, running
    // on round a set piece's slope). mNearRise is what it adds as drawn.
    const float under = std::max(top, lift);
    const float joined = near > 0 ? std::max(top, lift + near) : under;
    mNearRise = near * (1.0f - own) + (joined - under) * own;
    return (lift + hill) * (1.0f - own) + joined * own;
}

// Each tinted form lays its tint where it lies: over a ridge, ring or fan its
// crest, fading down its flank to the foot; over a plain or paint its width,
// fading over `w`. Colour only, sampled at the grid's vertices, so a tint
// reads as a broad wash, never an edge.
float3 TtpRenderer::landTint(float x, float z) const {
    float3 c{ 1.0f };
    for (const LandShape& s : mLand) {
        if (s.tint == float3{ 1.0f } || s.kind == 7 || x <= s.x0 || x >= s.x1 || z <= s.z0 || z >= s.z1) continue;
        const float dx = x - s.x, dz = z - s.z;
        const float lx = dx * s.ax + dz * s.az, lz = dz * s.ax - dx * s.az;
        const float half = 0.5f * s.len;
        const float lc = std::min(half, std::max(-half, lz));
        const float at = s.len > 0 ? (lc + half) / s.len : 0.0f;
        const float d = std::sqrt(lx * lx + (lz - lc) * (lz - lc));
        // Over a crest its whole width (its flat `top`), then fading to the foot.
        const auto crest = [&](float t) {
            return t <= s.top ? 1.0f : 1.0f - smooth01((t - s.top) / (1.0f - s.top));
        };
        float w;
        switch (s.kind) {
            case 2: case 5: case 7: w = 1.0f - smooth01((d - s.r) / std::max(0.01f, s.w)); break;
            case 1: w = crest(std::fabs(std::sqrt(lx * lx + lz * lz) - s.r) / s.w); break;
            default: w = crest(d / (s.r + (s.r1 - s.r) * at)); break;   // ridge, fan
        }
        c *= mix(float3{ 1.0f }, s.tint, w);
    }
    return c;
}

float TtpRenderer::naturalFootY(const TrackBin& tb, const TerrainFlat& f) const {
    // A lattice over the footprint grown by r, no wider apart than the grid's
    // own step, so no dip between samples is left inside the footprint.
    const float step = std::max(1.0f, std::min(mGroundGrid.sx, mGroundGrid.sz));
    const float ex = f.hx + f.r, ez = f.hz + f.r;
    const int nx = std::max(1, (int) std::ceil(2 * ex / step));
    const int nz = std::max(1, (int) std::ceil(2 * ez / step));
    float y = 1e30f;
    for (int i = 0; i <= nx; i++) {
        for (int j = 0; j <= nz; j++) {
            const float u = -ex + 2 * ex * i / nx, v = -ez + 2 * ez * j / nz;
            y = std::min(y, terrainY(tb, f.x + u * f.ax - v * f.az, f.z + u * f.az + v * f.ax, false));
        }
    }
    return y;
}

// The footprint sampled half a unit apart, each sample marking the corners of
// the triangle it lies in (split like the mesh and GroundGrid::at), so every
// triangle the footprint touches is held at its level however the grid falls.
// Never a corner of the VERGE, though: a corner the road's raised ground holds
// up keeps that much (the land under it, where that is lower), or the road
// beside a piece lower than the verge would stand on a step again. A piece
// that low is buried at its road side; its level wants moving, not the verge.
// Nor a corner of another piece's own ground (a mound or fan: its parts stand
// on it as modelled, and would hang).
void TtpRenderer::capFootprint(const TrackBin& tb, const TerrainFlat& f, float grow) {
    if (mTerrainCap.empty()) return;
    const int cols = mGroundGrid.cols, rows = mGroundGrid.rows;
    const float ex = f.hx + grow, ez = f.hz + grow;
    const int nx = std::max(1, (int) std::ceil(2 * ex / 0.5f));
    const int nz = std::max(1, (int) std::ceil(2 * ez / 0.5f));
    std::vector<size_t> corners;
    for (int i = 0; i <= nx; i++) {
        for (int j = 0; j <= nz; j++) {
            const float u = -ex + 2 * ex * i / nx, v = -ez + 2 * ez * j / nz;
            const float du = std::max(0.0f, std::fabs(u) - f.hx), dv = std::max(0.0f, std::fabs(v) - f.hz);
            if (du * du + dv * dv > grow * grow) continue;   // the rounded corners
            const float gu = (f.x + u * f.ax - v * f.az - mTerrainX0) / mGroundGrid.sx;
            const float gv = (f.z + u * f.az + v * f.ax - mTerrainZ0) / mGroundGrid.sz;
            if (gu < 0 || gv < 0 || gu > cols || gv > rows) continue;
            const int c = std::min(cols - 1, (int) gu), r = std::min(rows - 1, (int) gv);
            const size_t ia = (size_t) r * (cols + 1) + c, ib = ia + 1;
            const size_t id = ia + (size_t) cols + 1, ie = id + 1;
            const bool lower = (gu - c) + (gv - r) <= 1.0f;
            corners.insert(corners.end(), { lower ? ia : ie, ib, id });
        }
    }
    std::sort(corners.begin(), corners.end());
    corners.erase(std::unique(corners.begin(), corners.end()), corners.end());
    for (const size_t k : corners) {
        const float x = mTerrainX0 + (float) (k % (size_t) (cols + 1)) * mGroundGrid.sx;
        const float z = mTerrainZ0 + (float) (k / (size_t) (cols + 1)) * mGroundGrid.sz;
        if (std::any_of(mLand.begin(), mLand.end(), [&](const LandShape& s) {
                return (s.kind == 3 || s.kind == 4) && x > s.x0 && x < s.x1 && z > s.z0 && z < s.z1; })) {
            continue;
        }
        float edge;
        const float verge = std::min(terrainField(tb, x, z, false), tb.groundY + roadLift(tb, x, z, edge));
        mTerrainCap[k] = std::min(mTerrainCap[k], std::max(f.y, verge));
    }
}

// Sample the field once at the mesh's own resolution (setupTerrain chose it).
// Runs after buildLandmarks (whose spots carve the clearings) and before every
// builder that stands anything on the ground.
//
// UNDER A SET PIECE'S MOUND THE CHORDS ARE LIFTED. The piece's parts were
// built on the exact curve (SET_GROUND), and the grid's straight chords run
// under a convex crest — by a unit or two on a steep mound at this step,
// enough to leave its pines hanging. A chord one step long misses the curve
// at its middle by an eighth of the field's second difference across the
// vertex, so inside a mound's reach each vertex is raised by the worst of
// that over its three edge directions. What a triangle's middle can still
// miss is a third of that at most (a quadratic's miss peaks at the centroid,
// 4/3 of its edges'), inside the sink every part standing on a mound is built
// with. Only where the land is convex: the concave foot keeps its height, so
// the fences and huts standing there are not buried. The deck cap still
// applies after. tests/e2e/terrain-ground.spec.js holds the parts to it.
void TtpRenderer::buildTerrainGrid(const TrackBin& tb) {
    if (mTerrainAmp <= 0) return;
    const int cols = mGroundGrid.cols, rows = mGroundGrid.rows;
    const float sx = mGroundGrid.sx, sz = mGroundGrid.sz;
    const size_t nv = (size_t) (cols + 1) * (rows + 1);
    const auto vi = [&](int c, int r) { return (size_t) r * (cols + 1) + c; };
    std::vector<float> h(nv);
    mGroundDell.assign(nv, 0.0f);
    mGroundBed.assign(nv, 0.0f);
    for (int r = 0; r <= rows; r++) {
        for (int c = 0; c <= cols; c++) {
            const size_t v = vi(c, r);
            h[v] = terrainField(tb, mTerrainX0 + c * sx, mTerrainZ0 + r * sz, true, &mGroundDell[v],
                    &mGroundBed[v]);
        }
    }
    mGroundGrid.h.resize(nv);
    for (int r = 0; r <= rows; r++) {
        for (int c = 0; c <= cols; c++) {
            const size_t v = vi(c, r);
            float y = h[v];
            const float x = mTerrainX0 + c * sx, z = mTerrainZ0 + r * sz;
            bool mound = false;
            for (const LandShape& s : mLand) {
                mound |= (s.kind == 3 || s.kind == 4) && x > s.x0 && x < s.x1 && z > s.z0 && z < s.z1;
            }
            if (mound && c > 0 && r > 0 && c < cols && r < rows) {
                // The second differences along X, Z and the mesh's diagonal
                // (the b–d split runs from (c+1, r) to (c, r+1)).
                const float d2 = std::min({ h[vi(c - 1, r)] + h[vi(c + 1, r)],
                                            h[vi(c, r - 1)] + h[vi(c, r + 1)],
                                            h[vi(c + 1, r - 1)] + h[vi(c - 1, r + 1)] }) - 2 * y;
                y += std::max(0.0f, -d2) / 8.0f;
            }
            mGroundGrid.h[v] = std::max(tb.groundY - bedSink(x, z), std::min(y, mTerrainCap[v]));
        }
    }
}

float TtpRenderer::bandHold(float x, float z, float nearRise, float& rise) const {
    float hold = 1.0f;
    if (mShoreFn) {
        const float d = mShoreFn(std::atan2(z, x)) - std::hypot(x, z);
        hold = std::min(hold, smooth01((d - 1.0f) / 2.0f));
    }
    for (const LandShape& s : mLand) {
        if (s.kind != 7) continue;
        const float dx = x - s.x, dz = z - s.z;
        const float lx = dx * s.ax + dz * s.az, lz = dz * s.ax - dx * s.az;
        const float half = 0.5f * s.len, c = std::min(half, std::max(-half, lz));
        hold = std::min(hold, smooth01((std::sqrt(lx * lx + (lz - c) * (lz - c)) - s.r - 1.0f) / 2.0f));
    }
    // A footprint: what lies flat on it stands at the grid's level there, so
    // the band comes down to it, kHoldSlope a unit, and goes under inside.
    // A form authored `near` (nearRise here) passes the footprint of a piece
    // that levels nothing (one that drapes, one on its own ground: its parts
    // lie on the land as drawn or as modelled), never a clearing: a gallery
    // stands in the mountainside it is let into.
    const auto box = [&](float fx, float fz, float ax, float az, float hx, float hz) {
        const float dx = x - fx, dz = z - fz;
        const float u = std::max(0.0f, std::fabs(dx * ax + dz * az) - hx);
        const float v = std::max(0.0f, std::fabs(dz * ax - dx * az) - hz);
        return kHoldSlope * std::sqrt(u * u + v * v) - kBandTuck;
    };
    float flats = 1e30f, feet = 1e30f;
    for (const TerrainFlat& f : mTerrainFlats) flats = std::min(flats, box(f.x, f.z, f.ax, f.az, f.hx, f.hz));
    for (const SetFoot& f : mSetFeet) feet = std::min(feet, box(f.x, f.z, f.ax, f.az, f.hx, f.hz));
    rise = std::min(flats, feet + nearRise);
    return hold;
}

void TtpRenderer::buildVergeBand(const TrackBin& tb) {
    mBandVerts.clear();
    mBandNormals.clear();
    mBandIdx.clear();
    mGroundGrid.bandP.clear();
    mGroundGrid.bandTri.clear();
    mGroundGrid.indexBand();
    const auto& rings = tb.rings;
    const size_t N = rings.size();
    if (mTerrainAmp <= 0 || mGroundGrid.h.empty() || N < 8) return;
    // The rings it keeps: kBandStep apart, closer where the road turns or
    // crests, and the last held off ring 0 so the closing span is no sliver.
    std::vector<uint32_t> sel{ 0 };
    {
        float arc = 0;
        float3 t0 = rings[0].tangent();
        for (size_t i = 1; i < N; i++) {
            arc += length(rings[i].pos - rings[i - 1].pos);
            const float3 t = rings[i].tangent();
            if (arc >= kBandStep || dot(t, t0) < kBandTurnCos) {
                sel.push_back((uint32_t) i);
                arc = 0;
                t0 = t;
            }
        }
        if (sel.size() > 2 && length(rings[sel.back()].pos - rings[0].pos) < 0.5f * kBandStep) sel.pop_back();
    }
    const int K = (int) sel.size(), R = kBandRows;
    const auto vi = [&](int k, int side, int r) { return ((size_t) k * 2 + side) * R + r; };
    const float cw = tb.kerbW;
    // Per ring and side (2k + side): the kerb's outer foot and the way out
    // from it, the level the apron keeps, how far it may reach (the inside of
    // a bend), and how much of it lies in the land (fill).
    struct Edge { float3 E; float2 l; float top, lev, hump, reach, fill; };
    std::vector<Edge> edges((size_t) K * 2);
    for (int k = 0; k < K; k++) {
        const TrackBin::Sample& f = rings[sel[k]];
        const float half = 0.5f * f.width;
        // A street's kerb is its pavement (buildRoadMesh), the village's own:
        // the band is out of it a ring's step past either end, so no span
        // between two rings carries the apron in over its pieces.
        float street = 0;
        for (const ttp::rt::Landform& l : tb.land) {
            if (l.kind != 9) continue;
            float d = std::fabs(f.s - l.u * tb.length);
            d = std::min(d, tb.length - d);
            street = std::max(street, 1.0f - smooth01((d - 0.5f * l.len - kBandStep) / kStreetEase));
        }
        // The turn here, for the inside of a bend: rows past its centre fold.
        const TrackBin::Sample& fa = rings[sel[(k + K - 1) % K]];
        const TrackBin::Sample& fb = rings[sel[(k + 1) % K]];
        const float2 ta = normalize(float2{ fa.tangent().x, fa.tangent().z });
        const float2 tbn = normalize(float2{ fb.tangent().x, fb.tangent().z });
        const float turn = std::acos(std::min(1.0f, std::max(-1.0f, dot(ta, tbn))));
        const float arc = length(float2{ fb.pos.x - fa.pos.x, fb.pos.z - fa.pos.z });
        const float2 latH = normalize(float2{ f.lat.x, f.lat.z });
        const float toward = dot(tbn - ta, latH);   // > 0: turning toward +lat
        const TrackBin::Sample f0 = tb.frameAt(f.s - kHumpRun), f1 = tb.frameAt(f.s + kHumpRun);
        // A deck on its own pillars keeps them in sight: the band yields
        // there, so a bridge's or a hop's piers stand on the grid's ground
        // from the first, not in a bank of land the apron ramps up under it.
        float stilts = 0;
        for (const TrackBin::Pillar& p : tb.pillars) {
            if (std::fabs(p.topY - (f.pos.y - kDeckDepth)) > kStiltMatch) continue;
            const float d = length(float2{ p.x - f.pos.x, p.z - f.pos.z });
            stilts = std::max(stilts, 1.0f - smooth01((d - kStiltNear) / kStiltFade));
        }
        for (int side = 0; side < 2; side++) {
            const float sg = side ? 1.0f : -1.0f;
            Edge& e = edges[(size_t) k * 2 + side];
            e.E = f.pos + f.lat * (sg * (half + cw));
            e.l = latH * sg;
            // A short rise in the deck (a jump's lip, a hump) stands out of
            // the land: the apron follows the deck's top less what it rises
            // over the chord kHumpRun either side.
            e.top = e.E.y;
            const float y0 = (f0.pos + f0.lat * (sg * (0.5f * f0.width + cw))).y;
            const float y1 = (f1.pos + f1.lat * (sg * (0.5f * f1.width + cw))).y;
            e.lev = std::min(e.top, 0.5f * (y0 + y1));
            e.hump = e.top - e.lev;
            e.reach = 1e30f;
            if (turn > 1e-4f && toward * sg > 0) e.reach = std::max(0.0f, 0.85f * (arc / turn - half - cw));
            // LOW road (over the plain no higher than the field's own verge
            // rule calls low, kVergeLow) lies in the land; road climbing past
            // it rises out of it onto its stilts. And road the land itself
            // stands up beside, the raise the road brings left out (a cut
            // through a mountain's foot), lies in it however high it runs.
            const float o = std::min(kApronRef, e.reach);
            const float rx = e.E.x + e.l.x * o, rz = e.E.z + e.l.y * o;
            float edge;
            const float natural = terrainField(tb, rx, rz, true) - roadLift(tb, rx, rz, edge);
            const float low = 1.0f - smooth01((e.lev - tb.groundY - kApronFull) / (kApronNone - kApronFull));
            const float cut = 1.0f - smooth01((e.lev - natural - kApronCut) / (kApronNone - kApronFull));
            e.fill = std::max(low, cut) * (1.0f - street) * (1.0f - stilts);
        }
    }
    // The land at (px, pz), o past the kerb, as this road alone raises it:
    // another road's raised ground (a ramp's, beside it) is the grid's to lay.
    const auto landAt = [&](const Edge& e, float px, float pz, float o, float* dell, float* bed) {
        const float h = e.lev - tb.groundY;
        const float liftOwn = std::max(0.0f, std::min(h - kVergeDrop, std::max(kVergeLow - kVergeDrop, h - kRaiseDrop)))
                * (1.0f - smooth01((o + cw - kRaiseFlatR) / kRaiseRampR));
        return std::max(tb.groundY - bedSink(px, pz), terrainField(tb, px, pz, true, dell, bed, liftOwn));
    };
    // WIDE where the grid cannot draw what stands at the band's usual end (a
    // mountain's flank the deck cap pulls down): the band runs on to its last
    // row there, eased in and out along the road so its end never steps.
    std::vector<float> wide((size_t) K * 2, 0.0f);
    {
        constexpr float O = kBandRow[kBandNarrow];
        std::vector<float> want(wide.size(), 0.0f);
        for (size_t q = 0; q < edges.size(); q++) {
            const Edge& e = edges[q];
            if (e.fill <= 0 || e.reach < O) continue;
            const float px = e.E.x + e.l.x * O, pz = e.E.z + e.l.y * O;
            const float field = landAt(e, px, pz, O, nullptr, nullptr), grid = mGroundGrid.gridAt(px, pz);
            want[q] = std::min(field, grid + kBandOver + mNearRise) - grid > kBandWide ? 1.0f : 0.0f;
        }
        for (size_t q = 0; q < want.size(); q++) {
            const int k = (int) (q / 2), side = (int) (q % 2);
            for (int d = -2; d <= 2; d++) wide[q] = std::max(wide[q], want[(size_t) ((k + d + K) % K) * 2 + side]);
        }
        for (int pass = 0; pass < 2; pass++) {
            std::vector<float> eased(wide.size());
            for (size_t q = 0; q < wide.size(); q++) {
                const int k = (int) (q / 2), side = (int) (q % 2);
                float sum = 0;
                for (int d = -2; d <= 2; d++) sum += (float) (3 - std::abs(d)) * wide[(size_t) ((k + d + K) % K) * 2 + side];
                eased[q] = sum / 9.0f;
            }
            wide.swap(eased);
        }
    }
    std::vector<float3> P((size_t) K * 2 * R);
    std::vector<float> dellV(P.size(), 0.0f), bedV(P.size(), 0.0f);
    std::vector<uint8_t> live(P.size(), 0);
    std::vector<float> over(P.size(), 1.0f);   // how far into the hand-over to the grid
    std::vector<float> lift(P.size(), 0.0f);   // how far over the grid it stands
    for (int k = 0; k < K; k++) {
        const float s = rings[sel[k]].s;
        for (int side = 0; side < 2; side++) {
            const size_t q = (size_t) k * 2 + side;
            const Edge& e = edges[q];
            // The hand-over to the grid, from b0 to the band's end b1.
            const float b0 = lerp(kBandBlend, kBandRow[kBandNarrow] + 1.0f, wide[q]);
            const float b1 = lerp(kBandRow[kBandNarrow], kBandRow[R - 1], wide[q]);
            for (int r = 0; r < R; r++) {
                // The first row tucks under the kerb, kBandKerbIn short of
                // its inner face (a wide bank's foot is under the bank too).
                const float o = r == 0 ? std::min(kBandRow[0], kBandKerbIn - cw) : std::min(kBandRow[r], e.reach);
                const float px = e.E.x + e.l.x * o, pz = e.E.z + e.l.y * o;
                const size_t v = vi(k, side, r);
                const float field = landAt(e, px, pz, o, &dellV[v], &bedV[v]);
                // landAt's walk left the samples in reach of (px, pz) in
                // mTsiNear, and what the `near` forms raise there in mNearRise.
                const float nearRise = mNearRise;
                const float grid = mGroundGrid.gridAt(px, pz);
                // Row 0 stands kApronKerb over the deck's top inside the kerb,
                // so no sliver of the slab's side shows at the kerb's outer
                // foot; under a plough bank, whose slope runs on down into
                // the land, it tucks under instead.
                float a = e.lev + (r ? -kApronGap : tb.kerbBank ? -kApronTuck : kApronKerb);
                if (o > kApronLevel) {
                    // The land keeps to the grid's within kBandOver, but for a
                    // form authored `near`: the band follows the road, not
                    // every swell the grid smoothed away.
                    const float land = std::max(std::min(field - e.hump * (1.0f - smooth01((o - kApronRun) / kRaiseRampR)),
                                                         grid + kBandOver + nearRise),
                                                grid + kBandLift);
                    a = lerp(a, land, smooth01((o - kApronLevel) / kApronRun));
                }
                // Raised road keeps the ground the grid lays under it (fill 0).
                float y = lerp(grid + kBandLift, a, e.fill);
                y = lerp(y, grid + kBandLift, smooth01((o - b0) / (b1 - b0)));
                bool mine = o < b1 - 0.01f && e.fill > 0;
                const float own = o + cw;
                for (const auto& [i, d] : mTsiNear) {
                    const TrackBin::Sample& sm = tb.samples[i];
                    const float ds = std::fabs(sm.s - s);
                    if (std::min(ds, tb.length - ds) < kBandOwnS) continue;
                    if (std::fabs(sm.pos.y - e.top) < kBandRival) {
                        if (d < own - 0.25f) mine = false;
                    } else if (d < cw + kBandStep) {
                        y = std::min(y, mTsiTopY[i] - kDeckClear);
                    }
                }
                float rise = 0.0f;
                const float hold = mine ? bandHold(px, pz, nearRise, rise) : 0.0f;
                y = lerp(grid - kBandTuck, std::min(y, grid + rise), hold);
                live[v] = hold > 0 && y > grid - kBandTuck;
                P[v] = { px, y, pz };
                over[v] = smooth01((o - b0) / (b1 - b0));
                lift[v] = y - grid;
            }
        }
    }
    // THE BAND ENDS WHERE IT STOPS MATTERING: past the apron, a row that only
    // copies the grid (within kBandFlat) costs its vertices in every cell and
    // shows nothing, so each ring's band goes under at the first row from
    // which on it would, and its neighbours' ends hold it out a ring either
    // side so the edge runs smooth.
    {
        std::vector<int> end((size_t) K * 2, R - 1);
        for (size_t q = 0; q < end.size(); q++) {
            int e = R - 1;
            while (e > kBandMinEnd && std::fabs(lift[q * R + e - 1] - kBandLift) < kBandFlat) e--;
            end[q] = e;
        }
        for (int k = 0; k < K; k++) {
            for (int side = 0; side < 2; side++) {
                int e = end[(size_t) k * 2 + side];
                for (const int d : { -1, 1 }) e = std::max(e, end[(size_t) ((k + d + K) % K) * 2 + side]);
                for (int r = e; r < R; r++) {
                    const size_t v = vi(k, side, r);
                    if (!live[v]) continue;
                    live[v] = 0;
                    P[v].y -= lift[v] + kBandTuck;
                }
            }
        }
    }
    // Quads between consecutive kept rings, any of whose corners stands.
    std::vector<float3> nrm(P.size(), float3{ 0 });
    for (int k = 0; k < K; k++) {
        const int kn = (k + 1) % K;
        for (int side = 0; side < 2; side++) {
            for (int r = 0; r + 1 < R; r++) {
                const size_t a = vi(k, side, r), b = vi(kn, side, r);
                const size_t c = vi(kn, side, r + 1), d = vi(k, side, r + 1);
                if (!(live[a] | live[b] | live[c] | live[d])) continue;
                for (const auto& t : { std::array<size_t, 3>{ a, b, c }, std::array<size_t, 3>{ a, c, d } }) {
                    // A face diving under the grid shades nothing it touches.
                    if (live[t[0]] & live[t[1]] & live[t[2]]) {
                        float3 n = cross(P[t[1]] - P[t[0]], P[t[2]] - P[t[0]]);
                        if (n.y < 0) n = -n;
                        for (const size_t q : t) nrm[q] += n;
                    }
                    for (const size_t q : t) mBandIdx.push_back((uint32_t) q);
                }
            }
        }
    }
    if (mBandIdx.empty()) return;
    // A face diving under the grid dives from its own standing corners, never
    // from the grid's height at its far corner: at a massif's foot the grid
    // climbs a row out, and a skirt laid up to it ran its chord over the
    // grid's concave foot as a pale sliver standing out of the slope.
    for (size_t t = 0; t + 2 < mBandIdx.size(); t += 3) {
        float low = 1e30f;
        for (size_t k = 0; k < 3; k++) {
            if (live[mBandIdx[t + k]]) low = std::min(low, P[mBandIdx[t + k]].y);
        }
        if (low > 1e29f) continue;
        for (size_t k = 0; k < 3; k++) {
            float3& p = P[mBandIdx[t + k]];
            if (!live[mBandIdx[t + k]]) p.y = std::min(p.y, low - kBandTuck);
        }
    }
    // Compact to the vertices the quads use.
    // The grid's own light, normal and colour terms where the band hands over
    // to it, so the two meet without a seam (buildStatic's normal, the mesh's
    // triangle split for the rest).
    const auto gridTerm = [&](const std::vector<float>& f, float x, float z) {
        const int cols = mGroundGrid.cols, rows = mGroundGrid.rows;
        const float u = (x - mTerrainX0) / mGroundGrid.sx, w = (z - mTerrainZ0) / mGroundGrid.sz;
        if (u <= 0 || w <= 0 || u >= cols || w >= rows) return 0.0f;
        const int c = std::min(cols - 1, (int) u), r = std::min(rows - 1, (int) w);
        const float fu = u - c, fv = w - r;
        const auto at = [&](int cc, int rr) { return f[(size_t) rr * (cols + 1) + cc]; };
        if (fu + fv <= 1.0f) return at(c, r) + (at(c + 1, r) - at(c, r)) * fu + (at(c, r + 1) - at(c, r)) * fv;
        return at(c + 1, r + 1) + (at(c, r + 1) - at(c + 1, r + 1)) * (1.0f - fu) + (at(c + 1, r) - at(c + 1, r + 1)) * (1.0f - fv);
    };
    const auto gridNormal = [&](float x, float z) {
        const float sx = mGroundGrid.sx, sz = mGroundGrid.sz;
        return normalize(float3{ (mGroundGrid.gridAt(x - sx, z) - mGroundGrid.gridAt(x + sx, z)) / (2 * sx), 1.0f,
                                 (mGroundGrid.gridAt(x, z - sz) - mGroundGrid.gridAt(x, z + sz)) / (2 * sz) });
    };
    std::vector<uint32_t> remap(P.size(), UINT32_MAX);
    for (uint32_t& q : mBandIdx) {
        if (remap[q] == UINT32_MAX) {
            remap[q] = (uint32_t) mBandVerts.size();
            const float3& p = P[q];
            const float3 ng = gridNormal(p.x, p.z);
            float3 n = length(nrm[q]) > 1e-9f ? normalize(nrm[q]) : ng;
            n = normalize(mix(n, ng, live[q] ? over[q] : 1.0f));
            const float dell = lerp(dellV[q], gridTerm(mGroundDell, p.x, p.z), over[q]);
            const float bed = lerp(bedV[q], gridTerm(mGroundBed, p.x, p.z), over[q]);
            mBandVerts.push_back({ p.x, p.y, p.z,
                    packAlbedo(groundTint(tb.groundKind, dell, bed, n.y) * landTint(p.x, p.z), 1.0f) });
            mBandNormals.push_back(n);
            mGroundGrid.bandP.insert(mGroundGrid.bandP.end(), { p.x, p.y, p.z });
        }
        q = remap[q];
    }
    mGroundGrid.bandTri = mBandIdx;
    mGroundGrid.indexBand();
}

// Three terms, all tied to a shape and all gentle, because the grid's 9 u
// interpolation turns them into broad gradients: dells out among the hills a
// shade deeper, a steep face turning to what lies under the surface (earth
// under lawn, darker rust on the badlands, grey rock through the snow, the
// sandstone of a headland under the beach), and the floor of a `plain`
// landform (`bed`) wearing what a dry creek leaves (the badlands' grey-khaki
// gravel). Linear multipliers over the biome texture; 1 is the texture as
// painted, which is what the road's verge and the berms keep, so nothing seams
// at a berm's foot. Multipliers only darken, so a bed can only shift toward a
// duller colour, never a paler one.
float3 TtpRenderer::groundTint(uint32_t groundKind, float dell, float bed, float upY) const {
    float3 deep{ 1.0f }, face{ 1.0f }, floor{ 1.0f };
    switch (groundKind) {
        case 0: deep = { 0.88f, 0.92f, 0.86f }; face = { 0.86f, 0.76f, 0.58f }; break;  // lawn
        case 2: deep = { 0.92f, 0.88f, 0.86f }; face = { 0.76f, 0.62f, 0.56f };         // redrock
                floor = { 0.62f, 0.80f, 0.96f }; break;
        case 3: deep = { 0.90f, 0.93f, 0.99f }; face = { 0.62f, 0.66f, 0.74f }; break;  // snow
        case 1: deep = { 0.94f, 0.91f, 0.85f }; face = { 0.70f, 0.64f, 0.62f }; break;  // sand: rock under a headland
        default: return float3{ 1.0f };
    }
    // From about 20 degrees, fully by about 42.
    const float steep = smooth01((1.0f - upY - 0.06f) / 0.2f);
    float3 c = mix(float3{ 1.0f }, deep, std::min(1.0f, std::max(0.0f, dell)));
    c = mix(c, c * floor, std::min(1.0f, std::max(0.0f, bed)));
    return mix(c, c * face, 0.55f * steep);
}

// Each biome's rock (vground.mat), display-encoded like the canvas. The
// colours are the rock set pieces' own (set_prototypes.py): the canyon's brown
// and salmon cliffs on tan benches. A ground facet is rock where its normal's
// y is under `upY`: the badlands break to rock soonest, but only on a cliff
// (gateRock's `rise`): a dune, a spoil heap or a road's bank keeps its sand,
// since banded rock on one paints a striped dome, so strata show on mesas
// and the massifs' faces; a lawn only on a cliff. The beach has none: its land
// sinks to the plain short of the sea, so no dune of it is a cliff, and rock on
// one reads as a canyon. Snow has none either: a 9 u facet is too big to be a
// crag, and rock on one read as a grey panel painted on the slope (alone, in a
// small mass, or a whole face of them). Its rock is geometry: crags draped on
// the massifs' crests (set_prototypes.py `crag`), the galleries' cut faces.
namespace {
struct GroundRock {
    uint32_t a, b, l;
    float upY;
    float perRoot;   // strata per square root of a unit over the plain (0: none, rock is `a`)
    float wobble;    // how far (u) the broad lattice bends them
    float ledge;     // the bench's share of a stratum
    float rise;      // how far (u) a run of steep facets must climb to be rock (0: any)
};
const GroundRock* groundRock(uint32_t groundKind) {
    static const GroundRock lawn{ 0x8f7752u, 0x9d998eu, 0x7fa055u, 0.62f, 1.0f, 0.3f, 0.2f, 0.0f };       // past 52 degrees
    static const GroundRock redrock{ 0xb06041u, 0xd68f62u, 0xf2bf99u, 0.866f, 1.0f, 0.3f, 0.12f, 10.0f }; // past 30 degrees
    switch (groundKind) {
        case 0: return &lawn;
        case 2: return &redrock;
        default: return nullptr;
    }
}
// A cliff's run joins through facets this much (in normal y) under the slope
// too, so one gentler facet in a face does not split it into two short runs.
constexpr float kRockRunSlack = 0.03f;
// A rock facet's shade: a gain on the sun's term about a steep face's, so a
// face reads cut against its neighbours. Its corners carry it over
// kFacetShadeMax in their red channel (vground.mat's facet.x scales it back):
// the shade tops out near 1.2.
constexpr float kFacetGain = 0.6f, kFacetMid = 0.7f, kFacetShadeMax = 1.25f;
}  // namespace

// The rock (vground.mat), decided per TRIANGLE here: alpha 0 on a rock
// facet's corners, 1 on the rest, exact, so the shader's branch covers whole
// facets and the edge is the mesh's own. Every rock facet has corners of its
// own, carrying its shade (kFacetShadeMax) in their colour, so a face reads
// cut and no facet's alpha or shade is interpolated across an edge. Baked
// here rather than taken from the world position's screen derivatives in
// the shader: on the Android box that normal was most of what a bare rock
// pixel cost.
//
// Where the biome asks a `rise`, only a CLIFF is rock: the steep facets joined
// through their corners must climb that far between them, so a spoil heap's
// flank, a dune's steep lee or a lone steep facet keeps its sand while a
// massif's face is rock to its foot. The band's skirt (a face diving under the
// grid) is a short run on low land, so its sliver never pokes through the grid
// as a crawling dotted line of rock.
void TtpRenderer::gateRock(Mesh& m, uint32_t groundKind) {
    const GroundRock* r = groundRock(groundKind);
    if (!r) return;
    const size_t T = m.idx.size() / 3;
    std::vector<float> up(T, 1.0f);
    for (size_t t = 0; t < T; t++) {
        const auto p = [&](size_t k) { const Vertex& v = m.verts[m.idx[t * 3 + k]]; return float3{ v.px, v.py, v.pz }; };
        const float3 n = cross(p(1) - p(0), p(2) - p(0));
        const float len = length(n);
        if (len > 1e-9f) up[t] = std::abs(n.y) / len;
    }
    std::vector<uint8_t> rock(T);
    for (size_t t = 0; t < T; t++) rock[t] = up[t] < r->upY;
    if (r->rise > 0.0f) {
        std::vector<uint32_t> run(m.verts.size());
        std::iota(run.begin(), run.end(), 0u);
        const auto root = [&](uint32_t v) {
            while (run[v] != v) v = run[v] = run[run[v]];
            return v;
        };
        const auto joins = [&](size_t t) { return up[t] < r->upY + kRockRunSlack; };
        for (size_t t = 0; t < T; t++) {
            if (!joins(t)) continue;
            run[root(m.idx[t * 3 + 1])] = root(m.idx[t * 3]);
            run[root(m.idx[t * 3 + 2])] = root(m.idx[t * 3]);
        }
        std::vector<float2> span(m.verts.size(), float2{ 1e30f, -1e30f });
        for (size_t t = 0; t < T; t++) {
            if (!joins(t)) continue;
            for (size_t k = 0; k < 3; k++) {
                float2& sp = span[root(m.idx[t * 3 + k])];
                const float y = m.verts[m.idx[t * 3 + k]].py;
                sp = { std::min(sp.x, y), std::max(sp.y, y) };
            }
        }
        for (size_t t = 0; t < T; t++) {
            const float2 sp = span[root(m.idx[t * 3])];
            rock[t] = rock[t] && sp.y - sp.x >= r->rise;
        }
    }
    // The corners: a plain facet's stay as they are and shared among them; a
    // rock facet takes a corner no plain facet uses if no rock facet took it
    // first, and a copy of any other.
    std::vector<uint8_t> plain(m.verts.size(), 0), taken(m.verts.size(), 0);
    for (size_t t = 0; t < T; t++) {
        if (rock[t]) continue;
        for (size_t k = 0; k < 3; k++) plain[m.idx[t * 3 + k]] = 1;
    }
    for (size_t t = 0; t < T; t++) {
        if (!rock[t]) continue;
        const auto p = [&](size_t k) { const Vertex& v = m.verts[m.idx[t * 3 + k]]; return float3{ v.px, v.py, v.pz }; };
        float3 n = cross(p(1) - p(0), p(2) - p(0));
        n = (n.y < 0.0f ? -n : n) / std::max(length(n), 1e-12f);
        const float shade = dot(n, kToSun) * kFacetGain + 1.0f - kFacetGain * kFacetMid;
        const uint32_t q8 = (uint32_t) std::lround(std::min(1.0f, std::max(0.0f, shade / kFacetShadeMax)) * 255.0f);
        const uint32_t abgr = q8 | q8 << 8 | q8 << 16;   // alpha 0: rock
        for (size_t k = 0; k < 3; k++) {
            uint32_t& q = m.idx[t * 3 + k];
            if (!plain[q] && !taken[q]) {
                taken[q] = 1;
                m.verts[q].abgr = abgr;
            } else {
                Vertex v = m.verts[q];
                v.abgr = abgr;
                m.verts.push_back(v);
                m.uvs.push_back(m.uvs[q]);
                m.normals.push_back(m.normals[q]);
                q = (uint32_t) m.verts.size() - 1;
            }
        }
    }
}

// The rock's colours, its banding over the plain at `groundY`, and the scale
// its facets' baked shade comes back by (gateRock). The lite tier has no
// strata: on the box the banding is most of what a rock pixel costs, and a
// canyon's walls fill the frame (native/renderer/CLAUDE.md, "The detail tier").
void TtpRenderer::setRockParams(MaterialInstance* mi, uint32_t groundKind, float groundY) const {
    const GroundRock* r = groundRock(groundKind);
    if (!r) return;
    const auto c = [](uint32_t h, float a) {
        return float4{ (float) ((h >> 16) & 0xff) / 255.0f, (float) ((h >> 8) & 0xff) / 255.0f,
                       (float) (h & 0xff) / 255.0f, a };
    };
    mi->setParameter("rockA", c(r->a, kGroundTile));
    mi->setParameter("rockB", c(r->b, 0.0f));
    mi->setParameter("rockL", c(r->l, r->ledge));
    mi->setParameter("strata", float4{ mLite ? 0.0f : r->perRoot, r->wobble, 0.0f, groundY });
    mi->setParameter("facet", float4{ kFacetShadeMax, 0.0f, 0.0f, 0.0f });
}

// The grounding rule for chunky pieces: the LOWEST surface point under the
// footprint, so a slope-centre height can't leave the downhill edge hanging
// in silhouette on a dune face.
float TtpRenderer::footprintY(const TrackBin& tb, float x, float z, float r) const {
    return footprintSpan(tb, x, z, r).x;
}

float2 TtpRenderer::footprintSpan(const TrackBin& tb, float x, float z, float r) const {
    float2 span{ groundSurfaceY(tb, x, z) };
    for (const auto& o : { float2{ r, 0 }, float2{ -r, 0 },
                           float2{ 0, r }, float2{ 0, -r } }) {
        const float y = groundSurfaceY(tb, x + o.x, z + o.y);
        span = { std::min(span.x, y), std::max(span.y, y) };
    }
    return span;
}

float TtpRenderer::groundSurfaceY(const TrackBin& tb, float x, float z) const {
    if (mGroundGrid.h.empty()) return tb.groundY;
    return mGroundGrid.at(x, z);
}

// A berm is the hill a raised stretch of road stands on, and it is drawn over
// the ground rather than folded into it, so a sight line has to meet both.
float TtpRenderer::groundY(float x, float z) const {
    if (!mTrack) return 0.0f;
    return std::max(groundSurfaceY(*mTrack, x, z), bermY(*mTrack, x, z));
}

// The painted road — a direct port of render/track.js buildRoad's sweep: a
// cross-section (skirt/kerb/gap/line/asphalt/dash) swept along a fine
// uniform resample, per-side kerb striping banded by EACH KERB EDGE's own
// arclength (even-band snap → clean seam), dash cadence snapped to whole ring
// runs, bare asphalt under launch strips, and the same baked-AO gradients.
// Unlit for now (the JS ribbon is Lambert; the matte-material family is later
// work) — the AO carries most of the plastic-toy form.
bool TtpRenderer::buildRoadMesh(TrackBin& tb) {
    const size_t nSrc = tb.samples.size();
    const float L = tb.length;
    if (nSrc < 2 || L <= 0 || !tb.closed) return false;

    // Arclength interpolation over the serialized samples (they're the contract
    // centerline samples, unevenly spaced ~0.4–1.5u).
    // Catmull-Rom via TrackBin::frameAt — the JS sweep samples the same cubic.
    const auto frameAt = [&](float s) { return tb.frameAt(s); };

    // Constants — identical to buildRoad's.
    const float defHalf = tb.roadWidth / 2;
    const float cw = tb.kerbW, ch = tb.kerbH, deck = kDeckDepth;
    // Sand is the gap between kerb and edge line, grown, ring by ring
    // (TrackBin::gapOf): a sample's width runs kerb to kerb, so the line lands on
    // the asphalt's edge and the section keeps its strips.
    const float gap = std::min(0.07f, defHalf * 0.3f);
    const float lw = std::min(0.20f, defHalf * 0.5f - gap);
    const float stripeLen = 2.0f, dashW = TrackBin::kDashW;
    tb.deckGap = gap;
    tb.deckLine = lw; // with the rings: project()'s deck strip model
    const float DASH_PERIOD = 5.76f, DASH_FRAC = 0.25f;

    // RING STEP. This was hard-capped at 0.24u, which is HALF what the paint
    // derivation beside it asks for (minBand/3 = 0.48) — so the cap, not the
    // paint, set the road's density and skyline carried 47,616 triangles.
    //
    // The dashes do not care. They are counted in RINGS (dashRingsOn of
    // ringsPerCycle), and the rings are evenly spaced, so at 0.48 every dash is
    // still exactly 25% duty and exactly the same length as its neighbours — the
    // pattern is identical, only its edges are placed on a coarser grid. What
    // does change is the road's own chord sag, and that got CHEAPER to accept
    // rather than dearer: the flat decals are shaded into the deck now instead of
    // floating over it, so a coarser road no longer has anything to disagree with.
    // Measured on a 3.5u loop the extra sag is 0.008u, well under a tenth of a
    // kerb's height. Verified by pixel A/B over road, dashes, both kerbs and a
    // curve, and by the catalogue decal sweep.
    const float minBand = std::min(stripeLen, DASH_PERIOD * DASH_FRAC);
    uint32_t N = (uint32_t) std::min(4000L, std::max(8L,
            std::lround(L / std::min(0.48f, std::max(0.06f, minBand / 3)))));
    const uint32_t dashCycles = (uint32_t) std::max(2L, std::lround(L / DASH_PERIOD));
    uint32_t ringsPerCycle = std::max(4u, (uint32_t) std::lround((double) N / dashCycles));
    if (ringsPerCycle * dashCycles > 4000) ringsPerCycle = std::max(4u, 4000u / dashCycles);
    N = ringsPerCycle * dashCycles;
    const uint32_t dashRingsOn = std::min(ringsPerCycle - 1,
            std::max(1u, (uint32_t) std::lround(ringsPerCycle * DASH_FRAC)));

    std::vector<TrackBin::Sample> frames(N);
    for (uint32_t i = 0; i < N; i++) frames[i] = frameAt(((float) i / N) * L);
    // Retained on the bin: uv0's track space is linear along exactly these
    // chords, so project() must scan these and no others — see its comment.
    tb.rings = frames;
    const auto halfAt = [&](uint32_t i) { return frames[i].width / 2; };

    // Palette (linear).
    const float3 ASPHALT = srgbToLinear(tb.pal[0]);
    const float3 LINE = srgbToLinear(tb.pal[1]);
    const float3 DASHC = srgbToLinear(tb.pal[2]);
    const float3 KERB_A = srgbToLinear(tb.pal[3]);
    const float3 KERB_B = srgbToLinear(tb.pal[4]);
    const float3 SKIRT = srgbToLinear(tb.pal[5]);
    const float3 SHOULDER = srgbToLinear(tb.pal[6]);
    const float3 SAND = srgbToLinear(tb.pal[7]);
    const float3 SLUSH = srgbToLinear(tb.kerbSlush);

    // Cross-section profile, strips and baked AO.
    //
    // THE KERB'S TOP CORNERS ARE BEVELLED, the cars' own grammar (one flat
    // chamfer, scripts/toy_cars.py) — in the FINE ribbon only. Past the far
    // ribbon's distance a bevel is under a pixel, so there the kerb stays a
    // box: its top is one far-only strip across the two bevels' feet (kFar
    // below), with corners of its own lit as a top, so it meets both faces at
    // shared positions and stays watertight. It sits `bev` low, inside
    // kDeckLodTol. The fine ribbon pays four strips a ring; the far one none.
    const float bev = 0.2f * std::min(cw, ch);
    struct PPoint { int sign; float off, y; };
    constexpr int kPts = 20;
    PPoint P[kPts] = {
        { -1, -cw, -deck }, { -1, -cw, 0 }, { -1, -cw, ch - bev }, { -1, -cw + bev, ch },
        { -1, -bev, ch }, { -1, 0, ch - bev },
        { -1, 0, 0 }, { -1, gap, 0 }, { -1, gap + lw, 0 },     // gap: offAt widens it per ring
        { 0, -dashW / 2, 0 }, { 0, dashW / 2, 0 },
        { 1, -gap - lw, 0 }, { 1, -gap, 0 }, { 1, 0, 0 },
        { 1, 0, ch - bev }, { 1, bev, ch },
        { 1, cw - bev, ch }, { 1, cw, ch - bev }, { 1, cw, 0 }, { 1, cw, -deck },
    };
    // THE PLOUGH BANK (tb.kerbBank): the kerb drawn as the snow a plough threw
    // up, on the same seven points a side. A rounded crest leaning off the
    // road, a slush-grey road face, and an outer slope that runs down into the
    // land beside the road. Its toe goes where the land is, `bankDepth` under
    // the deck's edge: where the land meets the slab (low road) a little past
    // the slab's foot, under the ground; where it lies lower, out of reach of
    // a kerb (a causeway over a frozen lake, a banked bend's high side), on
    // down to it at kBankRun, out to kBankSpread of depth. Deeper still the
    // slope stands up into snow piled against the slab's side, and past
    // kBankSheer, raised road on its stilts, the bank sits on the deck with
    // the slab's edge bare under it: a bank on a bridge, never snow hanging
    // off a ledge. The step to that is one ring wide, between two toes on the
    // slab's side, so it is the end of the pile. Each ring then scales the
    // bank's height and width by a slow seeded wobble (bankAt), so it wanders
    // along the road rather than running as one extruded bar. The static
    // profile is the low bank; the per-ring one only moves points off the
    // deck.
    constexpr float kBankToe = 0.35f, kBankRun = 1.2f, kBankSpread = 0.9f, kBankSheer = 1.3f;
    if (tb.kerbBank) {
        const float bankP[7][2] = { { -(cw + kBankToe), -deck }, { -(cw + 0.1f), 0.15f * ch },
                                    { -0.85f * cw, 0.62f * ch }, { -0.6f * cw, 0.95f * ch },
                                    { -0.32f * cw, ch }, { -0.1f * cw, 0.6f * ch }, { 0, 0 } };
        for (int k = 0; k < 7; k++) {
            P[k] = { -1, bankP[k][0], bankP[k][1] };
            P[kPts - 1 - k] = { 1, -bankP[k][0], bankP[k][1] };
        }
    }
    // How far a bank side has stood up against the slab, at depth c, and
    // whether it is up on the deck.
    const auto bankSteep = [&](float c) { return smooth01((c - kBankSpread) / (kBankSheer - kBankSpread)); };
    const auto bankOnDeck = [&](float c) { return c > kBankSheer; };
    // The bank's point k (0 the toe, 6 the foot on the deck) on the left, at
    // depth c: (off, y) beside the edge.
    const auto bankPoint = [&](int k, float c, float& off, float& y) {
        const float sheer[7][2] = { { -cw, -deck }, { -cw, 0 }, { -0.95f * cw, 0.45f * ch },
                                    { -0.75f * cw, 0.85f * ch }, { -0.45f * cw, ch },
                                    { -0.12f * cw, 0.6f * ch }, { 0, 0 } };
        const float t = bankSteep(c);
        off = P[k].off + (sheer[k][0] - P[k].off) * t;
        y = P[k].y + (sheer[k][1] - P[k].y) * t;
        if (k == 0 && c > deck && !bankOnDeck(c)) {
            off = P[0].off - kBankRun * (std::min(c, kBankSpread) - deck);
            off += (-cw - off) * t;
            y = -c - 0.05f;
        }
    };
    // The bank's height and width scales at arclength s on `side`: a lump
    // every 3 u or so over a slower swell, out of phase with the other side;
    // and how high up its road face the slush splashes, thick in places and
    // thin in others, never one even band. A shape, not a colour per ring: a
    // colour that changes ring by ring splits the ribbon's shared corners and
    // its far runs, which the scene budget cannot afford.
    const auto bankAt = [](float s, int side, float& hs, float& ws, float& slush) {
        const float ph = side > 0 ? 1.7f : 0.0f;
        const float n = 0.5f + 0.3f * std::sin(s * 2.03f + ph) + 0.2f * std::sin(s * 0.74f + 2.0f * ph + 1.0f);
        const float m = 0.5f + 0.3f * std::sin(s * 1.61f + 3.0f * ph + 0.4f) + 0.2f * std::sin(s * 0.53f + ph);
        const float q = 0.5f + 0.3f * std::sin(s * 1.37f + 2.3f * ph) + 0.2f * std::sin(s * 3.1f + 4.6f * ph);
        hs = 0.55f + 0.45f * n;
        ws = 0.8f + 0.4f * m;
        slush = 0.7f + 0.4f * q;
    };
    // Each ring's bank depth, per side (2i left, 2i + 1 right): the land
    // under the deck's edge at the low bank's toe, the berm's slope or the
    // ground (terrainY: the field the ground grid is sampled from, before any
    // clearing). Read every kBankStep rings, eased along the road (a berm's
    // end drops its slope to the plain inside one sample, and a bank turning
    // over that fast folds into a spike) and run between.
    std::vector<float> bankDepth;
    if (tb.kerbBank) {
        constexpr uint32_t kBankStep = 4;
        const uint32_t n = (N + kBankStep - 1) / kBankStep;
        std::vector<float> read((size_t) n * 2), eased((size_t) n * 2);
        for (uint32_t c = 0; c < n; c++) {
            const uint32_t i = c * kBankStep;
            const TrackBin::Sample& f = frames[i];
            for (int k = 0; k < 2; k++) {
                const float side = k ? 1.0f : -1.0f;
                const float3 edge = f.pos + f.lat * (side * halfAt(i));
                const float3 toe = edge + f.lat * (side * (cw + kBankToe));
                read[2 * c + k] = edge.y - std::max(terrainY(tb, toe.x, toe.z), bermY(tb, toe.x, toe.z));
            }
        }
        for (int pass = 0; pass < 2; pass++) {
            for (uint32_t c = 0; c < n; c++) {
                for (int k = 0; k < 2; k++) {
                    float sum = 0;
                    for (uint32_t d = 0; d < 5; d++) {
                        sum += (float) (d < 3 ? d + 1 : 5 - d) * read[2 * ((c + n + d - 2) % n) + k];
                    }
                    eased[2 * c + k] = sum / 9.0f;
                }
            }
            read.swap(eased);
        }
        bankDepth.resize((size_t) N * 2);
        for (uint32_t i = 0; i < N; i++) {
            const uint32_t c = i / kBankStep, cn = (c + 1) % n;
            const uint32_t a = c * kBankStep, b = cn ? cn * kBankStep : N;
            const float t = (float) (i - a) / (float) (b - a);
            for (int k = 0; k < 2; k++) {
                bankDepth[2 * i + k] = read[2 * c + k] + (read[2 * cn + k] - read[2 * c + k]) * t;
            }
        }
    }
    // The deck-level points: the inner kerb feet, { ±1, 0, 0 }, and between.
    constexpr int kDeckPt0 = 6, kDeckPt1 = 13;
    enum Kind { K_SKIRT, K_KERB, K_GAP, K_LINE, K_ROAD, K_DASH };
    struct Strip { int a, b; Kind kind; int side; }; // side: -1 L, +1 R, 0 n/a
    // The first kFine strips are the ring the fine ribbon draws; the last two
    // are the far ribbon's square kerb tops, laid but never drawn near.
    constexpr int kFine = kPts, kFarTopL = kFine, kFarTopR = kFine + 1, kLaid = kFine + 2;
    const Strip STRIPS[kLaid] = {
        { 0, 1, K_SKIRT, 0 }, { 1, 2, K_KERB, -1 }, { 2, 3, K_KERB, -1 },
        { 3, 4, K_KERB, -1 }, { 4, 5, K_KERB, -1 }, { 5, 6, K_KERB, -1 },
        { 6, 7, K_GAP, 0 }, { 7, 8, K_LINE, 0 },
        { 8, 9, K_ROAD, 0 }, { 9, 10, K_DASH, 0 }, { 10, 11, K_ROAD, 0 },
        { 11, 12, K_LINE, 0 }, { 12, 13, K_GAP, 0 }, { 13, 14, K_KERB, 1 },
        { 14, 15, K_KERB, 1 }, { 15, 16, K_KERB, 1 }, { 16, 17, K_KERB, 1 },
        { 17, 18, K_KERB, 1 }, { 18, 19, K_SKIRT, 0 }, { 19, 0, K_SKIRT, 0 },
        { 2, 5, K_KERB, -1 }, { 14, 17, K_KERB, 1 },
    };
    // The far ribbon's ring, in order round the section: the fine one with
    // each kerb's bevel, top, bevel replaced by its far top.
    constexpr int kFarStrips = kFine - 4;
    static const int kFar[] = { 0, 1, kFarTopL, 5, 6, 7, 8, 9, 10, 11, 12, 13,
                                kFarTopR, 17, 18, 19 };
    static_assert(sizeof kFar / sizeof *kFar == kFarStrips);
    const float AO[kPts] = { 0.55f, 0.65f, 0.90f, 0.90f, 1.0f, 1.0f, 0.70f, 0.90f,
                             1.0f, 1.0f, 1.0f, 1.0f, 0.90f, 0.70f, 1.0f, 1.0f,
                             0.90f, 0.90f, 0.65f, 0.55f };

    // THE DECK FLAG. The section above is a CLOSED ring, so its last strip —
    // the last point back to P[0] — is the road's UNDERSIDE, spanning the deck's whole lat
    // range from +half+cw to -half-cw. A decal is placed in track space alone, so
    // every one of them matched that quad as readily as the deck: on a LOOP,
    // where the back of the road is in shot, a boosting car's aura was painted on
    // the OUTSIDE of the loop as well as under the car. A flat track hides it,
    // because nothing ever sees the underside.
    // The mask cannot be a threshold on v — that was tried twice and was wrong
    // both times, see vroad.mat's material() — so track space is written only
    // where it means anything: the strips with BOTH endpoints at y == 0. The
    // kerbs, the outer skirts and the underside get an out-of-band v no decal's
    // half-extent can reach. DERIVED from the profile rather than tagged onto
    // STRIPS by hand, so it cannot drift when the section changes; and v is in
    // the key a corner is shared by, so it is a per-quad constant with nothing
    // to interpolate across. A FULL-WIDTH decal is safe now too: a
    // launch strip may fill the deck edge to edge without climbing a kerb.
    constexpr float OFF_DECK_LAT = 1000.0f;

    // A STREET (a `street` landform): where the road runs through a village
    // its kerb is the PAVEMENT, not the biome's racing kerb: a kerbstone's
    // step kStreetKerbH tall and paving kStreetKerbW wide, out to the margin
    // a set piece keeps from the road (spotIssue), where the street's own
    // piece takes over at the same height. The ground grid cannot rise to the
    // kerb, so the road brings the first strip of the street with it.
    // Per ring, how far into one (0..1), easing in over kStreetEase at each
    // end so the kerb ramps down and narrows rather than steps.
    std::vector<float> street(N, 0.0f);
    for (const ttp::rt::Landform& l : tb.land) {
        if (l.kind != 9) continue;
        for (uint32_t i = 0; i < N; i++) {
            float d = std::fabs(((float) i / N) * L - l.u * L);
            d = std::min(d, L - d);
            street[i] = std::max(street[i], 1.0f - smooth01((d - 0.5f * l.len + kStreetEase) / kStreetEase));
        }
    }
    const float3 KERB_STREET = srgbToLinear(kStreetKerb);
    // THE BOARD'S PIECES (Skysnake's `snake` and `ladder` landforms): a
    // stretch of road that is one of the game's snakes or ladders made
    // track. A snake's back is the jointed toy snake's (set_prototypes.py
    // SNAKE), green blocks banded yellow from kerb to kerb, counted from its
    // head, its flanks (the kerbs and the slab's side) green; a ladder's
    // kerbs are its two wooden rails and its rungs cross the deck. Neither
    // carries lane dashes. Per ring: -1 off any, else the livery and which of
    // its two colours (2 * livery + band).
    std::vector<int8_t> piece(N, -1);
    for (const ttp::rt::Landform& l : tb.land) {
        if (l.kind != 10 && l.kind != 11) continue;
        const bool ladder = l.kind == 11;
        const float on = ladder ? kLadderRung : kSnakeBody, off = ladder ? kLadderGap : kSnakeBand;
        const float head = l.u * L - 0.5f * l.len;
        for (uint32_t i = 0; i < N; i++) {
            float d = ((float) i / N) * L - head;
            d -= std::floor(d / L) * L;
            if (d > l.len) continue;
            piece[i] = (int8_t) (2 * (ladder ? 1 : 0) + (std::fmod(d, on + off) < on ? 0 : 1));
        }
    }
    const float3 GAME[4][2] = {   // [livery * 2 + band]: { the deck, the kerb and slab side }
        { srgbToLinear(kSnakeColors[0]), srgbToLinear(kSnakeColors[0]) },
        { srgbToLinear(kSnakeColors[1]), srgbToLinear(kSnakeColors[0]) },
        { srgbToLinear(kLadderColors[0]), srgbToLinear(kLadderColors[1]) },
        { srgbToLinear(tb.pal[0]), srgbToLinear(kLadderColors[1]) } };
    const float3 SNAKE_SIDE = srgbToLinear(kSnakeColors[2]), LADDER_SIDE = srgbToLinear(kLadderColors[2]);
    // Every ring's profile points, once: the sweep, the strip normals and the
    // far ribbon's chord test each read the same points many times over. A
    // street lowers the kerb's raised points and moves its outer face (and
    // the skirt under it) out; the deck's points stay.
    // A point's lateral offset from its kerb at ring i: the gap's two edges
    // follow that ring's own gap (the sand, where there is some).
    const auto offAt = [&](uint32_t i, int j) {
        const float g = tb.gapOf(frames[i]);
        switch (j) {
            case 7: return g;
            case 8: return g + lw;
            case 11: return -g - lw;
            case 12: return -g;
            default: return P[j].off;
        }
    };
    std::vector<float3> ringPts((size_t) N * kPts);
    for (uint32_t i = 0; i < N; i++) {
        const TrackBin::Sample& f = frames[i];
        const float kerbK = 1.0f + street[i] * (kStreetKerbH / ch - 1.0f);
        const float wider = street[i] * (kStreetKerbW - cw);
        float hs[2] = { 1, 1 }, ws[2] = { 1, 1 }, slush[2] = { 1, 1 };
        if (tb.kerbBank) {
            const float sArc = ((float) i / N) * L;
            bankAt(sArc, -1, hs[0], ws[0], slush[0]);
            bankAt(sArc, 1, hs[1], ws[1], slush[1]);
        }
        for (int j = 0; j < kPts; j++) {
            float off = offAt(i, j), y = P[j].y;
            if (tb.kerbBank && (j < kDeckPt0 || j > kDeckPt1)) {
                const int k = j < kDeckPt0 ? 0 : 1;     // the side
                const int b = k ? kPts - 1 - j : j;
                bankPoint(b, bankDepth[2 * i + k], off, y);
                off *= (k ? -1.0f : 1.0f) * ws[k];
                if (y > 0) y *= hs[k] * (b == 5 ? slush[k] : 1.0f);
            }
            const bool outer = P[j].off * P[j].sign > cw * 0.5f;   // the kerb's outer face and the skirt
            if (y > 0) y *= kerbK;
            const float l = P[j].sign * halfAt(i) + off + (outer ? P[j].sign * wider : 0.0f);
            ringPts[(size_t) i * kPts + j] = f.pos + f.up * y + f.lat * l;
        }
    }
    const auto pointAt = [&](uint32_t i, int j) { return ringPts[(size_t) i * kPts + j]; };

    // Kerb stripes banded by each kerb edge's own arclength, even-band snap.
    struct KerbDist { std::vector<float> d; float eff; };
    const auto kerbDist = [&](int side) {
        KerbDist k;
        k.d.resize(N);
        const auto at = [&](uint32_t i) {
            const TrackBin::Sample& f = frames[i];
            return f.pos + f.up * ch + f.lat * (side * (halfAt(i) + cw / 2));
        };
        float3 prev = at(0);
        float acc = 0;
        k.d[0] = 0;
        for (uint32_t i = 1; i < N; i++) {
            const float3 cur = at(i);
            acc += length(cur - prev);
            k.d[i] = acc;
            prev = cur;
        }
        const float total = acc + length(at(0) - prev);
        const long bands = std::max(2L, 2 * std::lround(total / (2 * stripeLen)));
        k.eff = total / bands;
        return k;
    };
    const KerbDist kerbL = kerbDist(-1), kerbR = kerbDist(1);
    const auto bandCol = [&](const KerbDist& k, uint32_t i) {
        return ((long) std::floor(k.d[i] / k.eff) % 2) == 0 ? KERB_A : KERB_B;
    };
    const auto dashOn = [&](uint32_t i) { return (i % ringsPerCycle) < dashRingsOn; };
    const auto bareAsphalt = [&](uint32_t i) {
        const float sArc = ((float) i / N) * L;
        for (const auto& z : tb.zones) {
            float d = std::fabs(sArc - z.first);
            if (d > L / 2) d = L - d;
            if (d < z.second) return true;
        }
        return false;
    };
    // (The launch strip used to be painted INTO the ribbon here as full-width
    // Vs — too coarse: the drivable profile has only ~8 vertex columns across
    // the lane, while the pad stamp lays a 5×2 GRID of chevrons. It's now SDF
    // chevrons in vroad.mat.)

    // ANALYTIC normals (the JS lesson: computing normals per face on the raw
    // sweep flat-shades and bands every vertical curve): a strip's normal
    // at ring i is across × tangent, smooth ALONG the road while per-quad
    // verts keep profile corners hard. doubleSided flips per fragment.
    std::vector<float3> tans(N);
    for (uint32_t i = 0; i < N; i++) {
        tans[i] = frames[(i + 1) % N].pos - frames[(i + N - 1) % N].pos;
    }

    // Sweep: indexed QUADS — 4 corners + 6 indices per strip per ring pair,
    // per-vert AO from its own profile point. Each quad is laid with its own
    // corners (crisp paint bands, hard profile corners, per-quad colour and
    // deck flag), and a corner becomes a NEW vertex only when no corner
    // already laid is identical in every attribute, so none of that changes.
    // Each cell shades a shared corner once instead of once per quad.
    //
    // THE WELD IS BY CONSTRUCTION. Two corners can only be equal at the same
    // profile point of the same ring under the same UNWRAPPED u (the start
    // line's seam stays split, see uIdx) — short of a road narrower than its
    // painted lines, where two profile points coincide. At most six corners
    // land at one point (a strip's two, from the quads on either side of the
    // ring, times the three strips that share a bevel's foot with a far top),
    // so a corner is compared with those few rather than hashed against the
    // whole ribbon. `roadRemap` answers corner -> vertex for the
    // far ribbon, which is laid over the corners' numbering. The baked light
    // below is a function of the normal alone, so it cannot split what this
    // merged.
    static const int VSEQ_PT[4] = { 0, 1, 1, 0 };   // a@i, b@i, b@ni, a@ni
    constexpr uint32_t kNone = ~0u;
    using Slots = std::array<uint32_t, 6>;
    std::vector<Slots> laidAt((size_t) (N + 1) * kPts,
            { kNone, kNone, kNone, kNone, kNone, kNone });
    std::vector<uint32_t> roadRemap;
    roadRemap.reserve((size_t) N * kLaid * 4);
    mRoad.verts.reserve((size_t) N * kLaid * 3);   // a little over half the corners survive
    mRoad.normals.reserve((size_t) N * kLaid * 3);
    mRoad.uvs.reserve((size_t) N * kLaid * 3);
    mRoad.idx.reserve((size_t) N * kFine * 6);
    const auto lay = [&](uint32_t u, int pt, const Vertex& v, const float3& n,
            const math::float2& uv) {
        Slots& here = laidAt[(size_t) u * kPts + pt];
        for (const uint32_t k : here) {
            if (k != kNone && !std::memcmp(&mRoad.verts[k], &v, sizeof v)
                    && !std::memcmp(&mRoad.normals[k], &n, sizeof n)
                    && !std::memcmp(&mRoad.uvs[k], &uv, sizeof uv)) {
                return k;
            }
        }
        const uint32_t k = (uint32_t) mRoad.verts.size();
        mRoad.verts.push_back(v);
        mRoad.normals.push_back(n);
        mRoad.uvs.push_back(uv);
        for (uint32_t& slot : here) {
            if (slot == kNone) { slot = k; break; }
        }
        return k;
    };
    std::vector<uint32_t> quadKey((size_t) N * kLaid);
    // THE UNDERSIDE (the ring's last strip, P[19] back to P[0]) is seen from
    // under every bridge, and lit as what it faces it bakes to the ground's
    // bounce times the skirt's darkest corners: a near-black slab over the
    // road. It is ROAD SEEN FROM BELOW: no corner shade, and at least the
    // light the deck has in shade (after bakeVertexLight). Baked like the
    // rest, so it costs a frame nothing.
    constexpr int kUnderside = kFine - 1;
    std::vector<uint32_t> underside;
    for (uint32_t i = 0; i < N; i++) {
        const uint32_t ni = (i + 1) % N;
        const int game = piece[i];
        const float3 colL = street[i] > 0 ? KERB_STREET : game >= 0 ? GAME[game][1] : bandCol(kerbL, i);
        const float3 colR = street[i] > 0 ? KERB_STREET : game >= 0 ? GAME[game][1] : bandCol(kerbR, i);
        const bool bare = bareAsphalt(i);
        for (int s = 0; s < kLaid; s++) {
            const Strip& st = STRIPS[s];
            const bool onDeck = P[st.a].y == 0.0f && P[st.b].y == 0.0f;
            float3 cb;
            switch (st.kind) {
                case K_KERB:
                    cb = st.side > 0 ? colR : colL;
                    // the bank's road face, splashed with slush (how high
                    // the splash reaches wanders: bankAt)
                    if (tb.kerbBank && ((st.a == 5 && st.b == 6) || (st.a == 13 && st.b == 14))) cb = SLUSH;
                    break;
                case K_SKIRT:
                    // a bank's outer slope is snow down to its toe, turning to
                    // the slab's edge where the bank sits on its deck at both
                    // rings (a quad from one to the other is the end of a
                    // pile); the underside stays
                    cb = game < 0 ? SKIRT : game < 2 ? SNAKE_SIDE : LADDER_SIDE;
                    if (tb.kerbBank && s != 19) {
                        const int k = s ? 1 : 0;
                        if (!bankOnDeck(bankDepth[2 * i + k]) || !bankOnDeck(bankDepth[2 * ni + k])) cb = colL;
                    }
                    break;
                case K_DASH: cb = bare ? ASPHALT : (dashOn(i) ? DASHC : ASPHALT); break;
                case K_LINE: cb = bare ? ASPHALT : (tb.edgeLines ? LINE : SHOULDER); break;
                case K_GAP: cb = tb.sand > 0 ? SAND : (tb.edgeLines ? ASPHALT : SHOULDER); break;
                default: cb = ASPHALT; break;
            }
            if (game >= 0 && st.kind != K_KERB && st.kind != K_SKIRT) cb = GAME[game][0];
            quadKey[(size_t) i * kLaid + s] = packAlbedo(cb, 1.0f);
            const uint32_t ringIdx[4] = { i, i, ni, ni };
            // uv0's arclength must NOT wrap with the ring index. ringIdx uses
            // ni = (i+1) % N, so on the last strip it is 0 and u would sweep from
            // ~L back to 0 across one 0.48u band — which crosses EVERY decal's
            // arclength and painted a thin line of each, right at the start line,
            // on every track. Carry the UNWRAPPED index for u instead: the last
            // strip runs to exactly L, and the shader's periodic distance already
            // treats L and 0 as the same place.
            const uint32_t uIdx[4] = { i, i, i + 1, i + 1 };
            const auto stripNormal = [&](uint32_t ring) {
                const float3 across = pointAt(ring, st.b) - pointAt(ring, st.a);
                float3 along = tans[ring];
                // a bank's strip leans with its own wobble, so its lumps shade
                if (tb.kerbBank && (st.kind == K_KERB || (st.kind == K_SKIRT && s != 19))) {
                    const uint32_t rn = (ring + 1) % N, rp = (ring + N - 1) % N;
                    along = (pointAt(rn, st.a) + pointAt(rn, st.b)) - (pointAt(rp, st.a) + pointAt(rp, st.b));
                }
                const float3 n = cross(across, along);
                const float len = length(n);
                return len > 1e-9f ? n / len : frames[ring].up;
            };
            const float3 nA = stripNormal(i), nB = stripNormal(ni);
            uint32_t corner[4];
            for (int v = 0; v < 4; v++) {
                const int pt = VSEQ_PT[v] ? st.b : st.a;
                const uint32_t ri = ringIdx[v];
                const float3 p = pointAt(ri, pt);
                // TRACK SPACE, for vroad.mat: u is arclength, v is RAW WORLD
                // LAT. This is what lets a decal be shaded into the deck instead
                // of floated over it — the fragment already knows where it is on
                // the track, so nothing is conformed and a loop's two stacked
                // arclengths never collide.
                // v was lat/half at first, so the deck could be masked with
                // |v| <= 1, and that normalisation cost several debugging rounds:
                // it needs the decal side to divide by exactly the same
                // half-width, and where the road narrows the fixed cross-section
                // offsets divided by a small half push deck vertices past 1
                // anyway. Raw lat has no second quantity to agree with.
                // Off the deck, v is the out-of-band sentinel instead — see the
                // DECK FLAG note above.
                // A low bank's slope is snow lying on snow, not a kerb's foot
                // in its shadow: its toe and shoulder darken only as it
                // stands up against the slab, and its toe on the deck.
                float ao = s == kUnderside ? 1.0f : AO[pt];
                if (tb.kerbBank && (pt <= 1 || pt >= kPts - 2)) {
                    const float c = bankDepth[2 * ri + (pt > 1 ? 1 : 0)];
                    const bool toe = pt == 0 || pt == kPts - 1;
                    if (!(toe && bankOnDeck(c))) ao += ((toe ? 0.85f : 0.95f) - ao) * (1.0f - bankSteep(c));
                }
                // A sand strip's alpha is 0: vroad.mat reads it as "a tyre
                // leaves a groove here, not rubber". The deck is opaque, so the
                // alpha is free.
                const float flag = (st.kind == K_GAP && tb.sand > 0) ? 0.0f : 1.0f;
                corner[v] = lay(uIdx[v], pt, { p.x, p.y, p.z, packAlbedo(cb, ao, flag) },
                        ri == i ? nA : nB,
                        { (float) uIdx[v] / N * L,
                          onDeck ? P[pt].sign * halfAt(ri) + offAt(ri, pt) : OFF_DECK_LAT });
                if (s == kUnderside) underside.push_back(corner[v]);
                roadRemap.push_back(corner[v]);
            }
            // The soup's two triangles, verbatim: (a@i, b@i, b@ni) then
            // (a@i, b@ni, a@ni) — the (i,a)-(i+1,b) diagonal project() splits
            // by. Keep the order: same winding, same provoking vertex per
            // triangle, so the rasterizer sees exactly what the soup drew.
            if (s >= kFine) continue;   // a far top: the far ribbon's alone
            const uint32_t quad[6] = { corner[0], corner[1], corner[2],
                                       corner[0], corner[2], corner[3] };
            mRoad.idx.insert(mRoad.idx.end(), quad, quad + 6);
        }
    }
    // BAKED VERTEX LIGHT (encoded ambient and ambient + sun, plus the NoL the
    // visibility bake reads), evaluated once here instead of per
    // vertex per frame — it reads no map, so it is final at build whatever the
    // sun bake later does.
    bakeVertexLight(mRoad);
    {
        // The deck's light in shade: the sky's ambient, no sun. Raised to,
        // never lowered: a loop's underside turned to the sky keeps its sun.
        const float3 shade = displayLight(matteTerms(float3{ 0, 1, 0 }).xyz);
        for (const uint32_t k : underside) {
            for (math::half4* c : { &mRoad.custom0[k], &mRoad.custom1[k] }) {
                c->x = std::max((float) c->x, shade.x);
                c->y = std::max((float) c->y, shade.y);
                c->z = std::max((float) c->z, shade.z);
            }
        }
    }
    buildCarShadowDraws();
    buildSandDraws(tb);
    // The ring's mean baked light at full visibility, display-encoded, for
    // the car-shadow rows (TtpRenderer.h, mRingLight): the deck-level points
    // of the cross-section.
    mRingLight.assign(N, math::half4{ 1.0f, 1.0f, 1.0f, 1.0f });
    for (uint32_t u = 0; u < N; u++) {
        float4 acc{ 0.0f };
        int cnt = 0;
        for (int pt = kDeckPt0; pt <= kDeckPt1; pt++) {
            for (const uint32_t k : laidAt[(size_t) u * kPts + pt]) {
                if (k == kNone || k >= mRoad.custom0.size()) continue;
                const math::half4& h = mRoad.custom1[k];   // ambient + sun, encoded
                acc += float4{ (float) h.x, (float) h.y, (float) h.z, (float) h.w };
                cnt++;
            }
        }
        if (cnt) {
            acc /= (float) cnt;
            mRingLight[u] = math::half4{ acc.x, acc.y, acc.z, acc.w };
        }
    }
    // Chunked by RINGS, each chunk with its own bounds, so a chase camera pays
    // for the stretch of circuit it can actually see instead of all ~59k
    // triangles of it — per cell, every frame.
    //
    // 26 rings (~12 u) is the knee, and the far ribbon below is why it moved
    // from 78: a chunk is swapped whole, and the chunk the camera is IN is
    // always near, so the far ribbon cannot start before the next boundary —
    // at 78 rings that was 40-70 u ahead however near the gate sat. Measured on
    // the Android box at 4P/432 on the heavy seconds: 78 rings 15.4-15.8 ms,
    // 26 rings 14.2-14.5, 13 rings 14.7 and +0.7 ms of frame thread (every
    // chunk is a renderable and a decal fold). Draws are cheap under Vulkan;
    // the fold is not free.
    constexpr uint32_t kRoadChunkRings = 26;
    constexpr uint32_t trisPerRing = kFine * 2;
    constexpr uint32_t kRoadChunkTris = kRoadChunkRings * trisPerRing;
    if (!buildMesh(mRoad, true, roadInstance(), 4, kRoadChunkTris)) return false;

    // THE FAR RIBBON: a second index buffer over the SAME vertices, per chunk.
    // Along each strip, a run of rings painted one colour is drawn as ONE quad
    // from the run's first ring to its last — the corners are vertices the fine
    // ribbon already owns, so colours, uv0 (track space), the baked light and
    // the chunk boundaries are all exactly the fine ribbon's. What a run gives
    // up is the chord between its two rings, capped by kDeckLodTol against
    // every ring it skips (bends, crests and width changes keep their rings)
    // and by kDeckLodSpan. A split cell on the Android box is ~200 lines tall
    // and a 0.48 u ring past ~17 u is under two pixels, so looking down a
    // straight the fine ribbon is thousands of sub-pixel triangles a cell; the
    // far ribbon is worth ~4 ms of that frame (chooseLods has the numbers).
    // Ring runs are the whole of it: a coarse CROSS-SECTION on top measured
    // nothing further, so the square kerb's sixteen strips stay (kFar).
    constexpr uint32_t kDeckLodSpan = 16;
    mRoadFarIdx.clear();
    std::vector<std::pair<uint32_t, uint32_t>> farRange;
    {
        const auto quadBase = [&](uint32_t ring, int s) {
            return (ring * (uint32_t) kLaid + (uint32_t) s) * 4u;
        };
        const auto chordOk = [&](uint32_t i, uint32_t j, const Strip& st) {
            for (const int pt : { st.a, st.b }) {
                const float3 a = pointAt(i, pt), b = pointAt(j % N, pt);
                const float3 ab = b - a;
                const float ab2 = std::max(dot(ab, ab), 1e-9f);
                for (uint32_t r = i + 1; r < j; r++) {
                    const float3 p = pointAt(r % N, pt);
                    const float t = std::clamp(dot(p - a, ab) / ab2, 0.0f, 1.0f);
                    const float3 q = a + ab * t;
                    if (length(p - q) > kDeckLodTol) return false;
                }
            }
            return true;
        };
        // A strip's vertex at a ring, on its a or b edge, inside a run: the
        // fine ribbon's own corner (quad r's a/b at r, the run's last ring
        // from quad r-1's far corners so the colour is the run's).
        const auto vertAt = [&](uint32_t r, int s, bool bSide, uint32_t runEnd) {
            if (r == runEnd) return quadBase(r - 1, s) + (bSide ? 2u : 3u);
            return quadBase(r, s) + (bSide ? 1u : 0u);
        };
        std::vector<uint32_t> bounds[kFarStrips], ra, rb;
        for (uint32_t r0 = 0; r0 < N; r0 += kRoadChunkRings) {
            const uint32_t r1 = std::min(N, r0 + kRoadChunkRings);
            const uint32_t off = (uint32_t) mRoadFarIdx.size();
            // Each strip's run boundaries first: the rings where its runs
            // start, plus the chunk's end.
            for (int f = 0; f < kFarStrips; f++) {
                const int s = kFar[f];
                const Strip& st = STRIPS[s];
                bounds[f].clear();
                uint32_t i = r0;
                while (i < r1) {
                    bounds[f].push_back(i);
                    uint32_t j = i;
                    while (j + 1 < r1 && j + 1 - i < kDeckLodSpan
                            && quadKey[(size_t) (j + 1) * kLaid + s] == quadKey[(size_t) i * kLaid + s]
                            && chordOk(i, j + 2, st)) {
                        j++;
                    }
                    i = j + 1;
                }
                bounds[f].push_back(r1);
            }
            // WATERTIGHT: a run's edge shared with a neighbouring strip
            // carries that neighbour's boundary rings as extra vertices, so
            // the two strips meet at the same corners wherever either one
            // ends a run. Without this a strip spanning a chord beside one
            // ending on the true ring leaves a T-junction crack of up to the
            // chord bound — sub-pixel past the gate, a dark hairline up
            // close (seen with every chunk forced far). The run is then a
            // polygon between two polylines, triangulated by walking both.
            // bounds is by far-ring position f, the corners by laid strip s.
            for (int f = 0; f < kFarStrips; f++) {
                const int s = kFar[f];
                const std::vector<uint32_t>& ba = bounds[(f + kFarStrips - 1) % kFarStrips]; // shares point a
                const std::vector<uint32_t>& bb = bounds[(f + 1) % kFarStrips];              // shares point b
                const std::vector<uint32_t>& own = bounds[f];
                for (size_t k = 0; k + 1 < own.size(); k++) {
                    const uint32_t i = own[k], j = own[k + 1];
                    ra.assign(1, i);
                    rb.assign(1, i);
                    for (uint32_t r : ba) if (r > i && r < j) ra.push_back(r);
                    for (uint32_t r : bb) if (r > i && r < j) rb.push_back(r);
                    ra.push_back(j); rb.push_back(j);
                    size_t ia = 0, ib = 0;
                    while (ia + 1 < ra.size() || ib + 1 < rb.size()) {
                        const uint32_t A = vertAt(ra[ia], s, false, j);
                        const uint32_t B = vertAt(rb[ib], s, true, j);
                        if (ia + 1 < ra.size() && (ib + 1 == rb.size() || ra[ia + 1] <= rb[ib + 1])) {
                            const uint32_t tri[3] = { A, B, vertAt(ra[ia + 1], s, false, j) };
                            mRoadFarIdx.insert(mRoadFarIdx.end(), tri, tri + 3);
                            ia++;
                        } else {
                            const uint32_t tri[3] = { A, B, vertAt(rb[ib + 1], s, true, j) };
                            mRoadFarIdx.insert(mRoadFarIdx.end(), tri, tri + 3);
                            ib++;
                        }
                    }
                }
            }
            farRange.push_back({ off, (uint32_t) mRoadFarIdx.size() - off });
        }
        for (uint32_t& k : mRoadFarIdx) k = roadRemap[k];
        mRoadFarIb = IndexBuffer::Builder()
                .indexCount((uint32_t) mRoadFarIdx.size())
                .bufferType(IndexBuffer::IndexType::UINT)
                .build(*mEngine);
        mRoadFarIb->setBuffer(*mEngine, IndexBuffer::BufferDescriptor(
                mRoadFarIdx.data(), mRoadFarIdx.size() * sizeof(uint32_t), nullptr));
    }

    // Per-chunk material instances. Each ring contributes kFine strips of 2
    // triangles, so a chunk's triangle range maps straight back to an arclength
    // range, and uploadDeckDecals can hand each chunk only what overlaps it.
    mRoadChunks.clear();
    if (mRoadMaterial) {
        auto& rcm = mEngine->getRenderableManager();
        const size_t triCount = mRoad.idx.size() / 3;
        const size_t perChunk = std::min<size_t>(kRoadChunkTris, triCount);
        size_t k = 0;
        for (size_t t0 = 0; t0 < triCount; t0 += perChunk, k++) {
            const size_t n = std::min(perChunk, triCount - t0);
            const utils::Entity e = (k == 0) ? mRoad.entity
                    : (k - 1 < mRoad.chunks.size() ? mRoad.chunks[k - 1] : utils::Entity{});
            if (e.isNull()) break;
            auto ri = rcm.getInstance(e);
            if (!ri) continue;
            const float sMin = (float) (t0 / trisPerRing) / N * L;
            const float sMax = (float) ((t0 + n) / trisPerRing + 1) / N * L;
            RoadChunk chunk{};
            if (k < farRange.size() && farRange[k].second) {
                LodRange r;
                r.entity = e;
                r.vb = mRoad.vb;
                r.ib = mRoad.ib;
                r.farIb = mRoadFarIb;
                r.off = (uint32_t) (t0 * 3);
                r.cnt = (uint32_t) (n * 3);
                r.farOff = farRange[k].first;
                r.farCnt = farRange[k].second;
                r.err = kDeckLodTol;
                r.ring0 = (int) (t0 / trisPerRing);
                r.ring1 = (int) ((t0 + n) / trisPerRing) + 1;
                r.lo = float3{ 1e30f };
                r.hi = float3{ -1e30f };
                for (size_t q = t0 * 3; q < (t0 + n) * 3; q++) {
                    const Vertex& vt = mRoad.verts[mRoad.idx[q]];
                    r.lo = min(r.lo, float3{ vt.px, vt.py, vt.pz });
                    r.hi = max(r.hi, float3{ vt.px, vt.py, vt.pz });
                }
                mLods.push_back(r);
            }
            MaterialInstance* mi = sceneInstance(mRoadMaterial);
            mi->setParameter("profCount", 0);
            mi->setParameter("paintCount", 0);
            // Build-time constants: the lap's normalisation and this chunk's
            // own midpoint never change again, so uploadDeckDecals only ever
            // writes the decal set.
            mi->setParameter("invTrackLength", L > 0.0f ? 1.0f / L : 0.0f);
            mi->setParameter("chunkMid", (sMin + sMax) * 0.5f);
            bindSkidLayer(mi);
            rcm.setMaterialInstanceAt(ri, 0, mi);
            chunk.mi = mi;
            chunk.sMin = sMin;
            chunk.sMax = sMax;
            mRoadChunks.push_back(std::move(chunk));
        }
    }
    // The whole-lap fallback instance carries the same build-time constants
    // as the chunks, so uploadDeckDecals only ever writes decal sets.
    if (mRoadInst) {
        mRoadInst->setParameter("invTrackLength", L > 0.0f ? 1.0f / L : 0.0f);
        mRoadInst->setParameter("chunkMid", 0.0f);
    }
    return true;
}

// Colour of the ground sheet at world x — the band the tiled canvas would put
// there. The berms tile the same texture, so they read from here.
float3 TtpRenderer::groundColorAt(float x) const {
    if (mGroundBands.empty()) return srgbToLinear(LAWN_SRGB);
    float t = std::fmod(x, kGroundTile);
    if (t < 0) t += kGroundTile;
    float cursor = 0;
    for (const GroundBand& b : mGroundBands) {
        cursor += b.w * kGroundTile;
        if (t < cursor) return b.col;
    }
    return mGroundBands.back().col;
}

namespace {
// The per-biome ground band palette, stated ONCE for its two consumers:
// buildGroundTexture rasterizes the bands into the tiled canvas, and
// buildStatic's mGroundBands feed groundColorAt — whose contract is to
// answer the band that canvas would put there, so the two must agree and both
// read this table. Each keeps its own arithmetic (8-bit lround for texels,
// srgbChannel floats for bands); the texture-only extras (the wood's end
// joints) stay in buildGroundTexture.
struct GroundPalette {
    int bands;                       // band count across one tile
    uint32_t base;                   // base colour, sRGB hex
    void (*factor)(int i, float* f); // per-band rgb factors
};
const GroundPalette& groundPalette(uint32_t kind) {
    static const GroundPalette sand{ 10, 0xdec896, // gentle wind ripples
            [](int i, float* f) { f[0] = f[1] = f[2] = (i % 2) ? 1.03f : 0.975f; } };
    static const GroundPalette redrock{ 8, 0xd39671, // sediment strata (a hue wobble)
            [](int i, float* f) {
                const bool rust = i % 2;
                f[0] = rust ? 1.008f : 0.997f;
                f[1] = rust ? 0.972f : 1.024f;
                f[2] = rust ? 0.958f : 1.036f;
            } };
    // Snow is one white: the canvas maps world XZ, so on a mountain's face
    // its bands stood as vertical pleats down the slope.
    static const GroundPalette snow{ 1, 0xedf2f7,
            [](int, float* f) { f[0] = f[1] = f[2] = 1.0f; } };
    static const GroundPalette wood{ 8, 0xc99c68,  // planks: per-board tone
            [](int i, float* f) { f[0] = f[1] = f[2] = 0.96f + ((i * 37) % 5) * 0.02f; } };
    static const GroundPalette lawn{ 8, LAWN_SRGB, // mowing stripes
            [](int i, float* f) { f[0] = f[1] = f[2] = (i % 2) ? 1.04f : 0.965f; } };
    switch (kind) {
        case 1: return sand;
        case 2: return redrock;
        case 3: return snow;
        case 4: return wood;
        default: return lawn;
    }
}
// The wood seam ink, stroked between planks by both consumers.
constexpr uint32_t kWoodSeamInk = 0x604228;
constexpr float kWoodSeamAlpha = 0.55f;
} // namespace

// The biome's floor canvas, from textures.js: N vertical bands of a per-kind
// luminance/hue wobble over a base colour. The JS also stamped a per-kind
// speckle pass; it is deliberately GONE — sub-pixel from the race rig, and
// from any lower camera the tiling repeated its grain clusters across the
// whole ground. The wood keeps the pieces the band approximation could never
// carry — a dark seam stroked between planks, staggered END joints across
// each board, and knots.
//
// 256², sRGB, repeat-wrapped, mipmapped: three tiles the same 256² canvas at
// 33.3 world-u, so the texel density and tiling cadence match.
Texture* TtpRenderer::buildGroundTexture(uint32_t kind, uint32_t baseColor) {
    constexpr int S = 256;
    std::vector<uint8_t> px((size_t) S * S * 4, 255);
    const auto at = [&](int x, int y) { return &px[((size_t) y * S + x) * 4]; };
    // Canvas fillRect with a solid colour.
    const auto band = [&](int x0, int w, const int rgb[3]) {
        for (int x = x0; x < std::min(S, x0 + w); x++) {
            if (x < 0) continue;
            for (int y = 0; y < S; y++) {
                uint8_t* p = at(x, y);
                p[0] = (uint8_t) rgb[0]; p[1] = (uint8_t) rgb[1]; p[2] = (uint8_t) rgb[2];
            }
        }
    };
    // Canvas source-over of a solid colour at `a`, over a w×h rect.
    const auto blend = [&](int x0, int y0, int w, int h, int r, int g, int b, float a) {
        for (int y = y0; y < y0 + h; y++)
            for (int x = x0; x < x0 + w; x++) {
                uint8_t* p = at(((x % S) + S) % S, ((y % S) + S) % S);
                p[0] = (uint8_t) std::lround(p[0] * (1 - a) + r * a);
                p[1] = (uint8_t) std::lround(p[1] * (1 - a) + g * a);
                p[2] = (uint8_t) std::lround(p[2] * (1 - a) + b * a);
            }
    };
    // The shared band sweep: `n` columns of base × per-index factors.
    const auto sweep = [&](int n, const int base[3], const std::function<void(int, float*)>& fac) {
        for (int i = 0; i < n; i++) {
            float f[3];
            fac(i, f);
            const int rgb[3] = { (int) std::lround(base[0] * f[0]),
                                 (int) std::lround(base[1] * f[1]),
                                 (int) std::lround(base[2] * f[2]) };
            band((int) std::floor((float) i * S / n), (int) std::ceil((float) S / n), rgb);
        }
    };
    const GroundPalette& pal = groundPalette(kind);
    const uint32_t col = baseColor ? baseColor : pal.base;
    const int base[3] = { (int) ((col >> 16) & 0xff),
                          (int) ((col >> 8) & 0xff), (int) (col & 0xff) };
    sweep(pal.bands, base, pal.factor);
    if (kind == 4) { // wood — the texture-only extras over the plank bands
        const int BOARDS = pal.bands;
        const float bw = (float) S / BOARDS;
        const int ink[3] = { (int) ((kWoodSeamInk >> 16) & 0xff),
                             (int) ((kWoodSeamInk >> 8) & 0xff), (int) (kWoodSeamInk & 0xff) };
        // Board seams: a 2px dark line stroked between planks…
        for (int i = 1; i < BOARDS; i++) {
            blend((int) std::floor(i * bw) - 1, 0, 2, S,
                    ink[0], ink[1], ink[2], kWoodSeamAlpha);
        }
        // …and staggered end joints, offset per board so they never align.
        for (int i = 0; i < BOARDS; i++) {
            blend((int) std::floor(i * bw), (i * 149 + 40) % S,
                    (int) std::ceil(bw), 2, ink[0], ink[1], ink[2], kWoodSeamAlpha);
        }
    }
    Texture* tex = Texture::Builder()
            .width(S).height(S).levels(9) // 256² down to 1×1
            // RGBA8, not SRGB8_A8: the canvas is authored in sRGB bytes and
            // the scene is authored in display space (TtpRendererImpl.h), so
            // the sample IS the albedo vground multiplies.
            .format(Texture::InternalFormat::RGBA8)
            .sampler(Texture::Sampler::SAMPLER_2D)
            // GEN_MIPMAPPABLE is not in DEFAULT, and generateMipmaps() asserts
            // on it. Mips are not optional here: this is a 33-u tile stretched
            // to the horizon, so the minified stripes alias into a shimmer.
            .usage(Texture::Usage::DEFAULT | Texture::Usage::GEN_MIPMAPPABLE)
            .build(*mEngine);
    if (!tex) return nullptr;
    // The upload is asynchronous, so the pixels have to outlive this call.
    // Hand them to the heap FIRST and read data() off that — passing px.data()
    // in the same argument list as std::move(px) would be a race on unspecified
    // evaluation order (the windmill bug, again).
    auto* owned = new std::vector<uint8_t>(std::move(px));
    tex->setImage(*mEngine, 0, Texture::PixelBufferDescriptor(
            owned->data(), owned->size(), Texture::Format::RGBA, Texture::Type::UBYTE,
            [](void*, size_t, void* user) { delete (std::vector<uint8_t>*) user; }, owned));
    tex->generateMipmaps(*mEngine);
    return tex;
}

// Procedural start/finish gantry — FinishGate.js's numbers, vertex-coloured
// (the chequer is per-check geometry instead of a canvas texture): two chunky
// pylons on flag-stand feet carrying a 2-row chequered banner across s=0.
void TtpRenderer::buildGantry(const TrackBin& tb) {
    const TrackBin::Sample f = tb.frameAt(0);
    const float3 tanv = f.tangent();
    const auto toWorld = [&](float x, float y, float z) {
        // buildFinishGate seats the group a hair (0.02) INTO the road.
        return f.pos + f.lat * x + f.up * (y - 0.02f) + tanv * z;
    };
    // theme.gantry picks the plastic colours; theme.gate multiplies its
    // near-white colour grade over every part (sun-bleach / heat / cold).
    const float3 grade = srgbToLinear(tb.gateCol);
    const float3 PYLON_C = srgbToLinear(tb.gantryPylon) * grade;
    const float3 RING_C = srgbToLinear(tb.gantryRings) * grade;
    const float3 FINIAL_C = srgbToLinear(tb.gantryFinial) * grade;
    const float3 INKC = srgbToLinear(0x2a2735) * grade;
    const float3 PAPER = srgbToLinear(0xfff6eb) * grade;
    const float defHalf = tb.roadWidth / 2;
    // Outside the kerbs; on a sand track where they would stand without the sand,
    // out on it, where the pylons collide (ttp::sand_gantry_lat says why).
    const float halfSpan = tb.sand > 0 ? (float) ttp::sand_gantry_lat(tb.roadWidth)
                                       : defHalf + tb.kerbW + (float) ttp::GANTRY_CLEAR;
    const float POST_R = (float) ttp::GANTRY_POST_RADIUS;
    const float CLEARH = 2.0f, BANNER_H = 0.8f, BANNER_D = 0.12f;

    const auto quadW = [&](const float3& a, const float3& b, const float3& c,
            const float3& d, const float3& col) {
        const uint32_t base = (uint32_t) mGantry.verts.size();
        const uint32_t cc = packAlbedo(col, 1.0f);
        for (const float3& p : { a, b, c, d }) mGantry.verts.push_back({ p.x, p.y, p.z, cc });
        mGantry.idx.insert(mGantry.idx.end(),
                { base, base + 1, base + 2, base + 2, base + 1, base + 3 });
    };
    // Vertical (optionally tapered) tube in the road frame, plus a top cap. Flat
    // colour: the JS pylon is plain Lambert, and the vertical AO ramp this used
    // to carry read as a seam inside every ring of a banded post.
    const auto tubeAo = [&](float cx, float rBot, float rTop, float y0, float y1,
            const float3& col, float aoLo, float aoHi) {
        const int SEG = 16; // FinishGate's CylinderGeometry radial count
        const uint32_t base = (uint32_t) mGantry.verts.size();
        const uint32_t cLo = packAlbedo(col, aoLo);
        const uint32_t cHi = packAlbedo(col, aoHi);
        for (int j = 0; j <= SEG; j++) {
            const float a = (float) j / SEG * 2.0f * (float) M_PI;
            const float dx = std::cos(a), dz = std::sin(a);
            const float3 lo = toWorld(cx + dx * rBot, y0, dz * rBot);
            const float3 hi = toWorld(cx + dx * rTop, y1, dz * rTop);
            mGantry.verts.push_back({ lo.x, lo.y, lo.z, cLo });
            mGantry.verts.push_back({ hi.x, hi.y, hi.z, cHi });
        }
        for (int j = 0; j < SEG; j++) {
            const uint32_t a0 = base + j * 2, b0 = a0 + 1, a1 = a0 + 2, b1 = a0 + 3;
            mGantry.idx.insert(mGantry.idx.end(), { a0, b0, a1, b0, b1, a1 });
        }
        const uint32_t capC = (uint32_t) mGantry.verts.size();
        const float3 ctr = toWorld(cx, y1, 0);
        mGantry.verts.push_back({ ctr.x, ctr.y, ctr.z, cHi });
        for (int j = 0; j < SEG; j++) {
            mGantry.idx.insert(mGantry.idx.end(),
                    { capC, base + (uint32_t) j * 2 + 1, base + ((uint32_t) j + 1) * 2 + 1 });
        }
    };
    const auto tube = [&](float cx, float r, float y0, float y1, const float3& col) {
        tubeAo(cx, r, r, y0, y1, col, 1.0f, 1.0f);
    };

    // FinishGate.js: the pylon runs from the LAWN (footY = −dropDepth) to the
    // banner top, standing in a squat INK flag-stand plinth down there. The port
    // had the foot as a fat RED collar sitting ON the road — visible from every
    // grid camera, and (until the bake's sun was fixed) throwing a shadow across
    // the start line that the JS never casts.
    // buildFinishGate: dropDepth is how far the LAWN lies below the road at the
    // line (the feet stand on it), floored at 0.15 so they still tuck under the
    // kerb skirt on a flush track. A fixed 0.35 left the plinth floating.
    const float footY = -std::max(0.15f, f.pos.y - tb.groundY);
    const float topY = CLEARH + BANNER_H;
    for (const float sx : { -halfSpan, halfSpan }) {
        // Flag-stand foot: a squat TAPERED plinth (FOOT_R 0.55 → 0.82 of it).
        tubeAo(sx, 0.55f, 0.451f, footY, footY + 0.24f, INKC, 1.0f, 1.0f);
        if (tb.gantryHasRings) {
            // Striped pylon (the beach lighthouse look): an ODD band count, so
            // it starts and ends on the base colour.
            constexpr float RING_H = 0.42f;
            const int bands = 2 * (int) std::lround((topY / RING_H - 1) / 2) + 1;
            for (int b = 0; b < bands; b++) {
                const float f0 = (float) b / bands, f1 = (float) (b + 1) / bands;
                tubeAo(sx, POST_R, POST_R, footY + (topY - footY) * f0,
                        footY + (topY - footY) * f1, (b % 2) ? RING_C : PYLON_C,
                        1.0f, 1.0f);
            }
        } else {
            tube(sx, POST_R, footY, topY, PYLON_C);
        }
        // Finial: a flush dome cap at PYLON_R (an oversized/pillbox cap swallows
        // the pylon top with a visible crease).
        const int RINGS = 4, SEG = 12;
        const uint32_t capBase = (uint32_t) mGantry.verts.size();
        const uint32_t domeC = packAlbedo(FINIAL_C, 1.0f);
        for (int r = 0; r <= RINGS; r++) {
            const float phi = (float) r / RINGS * (float) M_PI / 2;
            const float rr = std::cos(phi) * POST_R, yy = std::sin(phi) * POST_R;
            for (int j = 0; j <= SEG; j++) {
                const float a = (float) j / SEG * 2.0f * (float) M_PI;
                const float3 p = toWorld(sx + std::cos(a) * rr, topY + yy, std::sin(a) * rr);
                mGantry.verts.push_back({ p.x, p.y, p.z, domeC });
            }
        }
        for (int r = 0; r < RINGS; r++) {
            for (int j = 0; j < SEG; j++) {
                const uint32_t a0 = capBase + (uint32_t) (r * (SEG + 1) + j);
                const uint32_t b0 = a0 + (uint32_t) (SEG + 1);
                mGantry.idx.insert(mGantry.idx.end(), { a0, b0, a0 + 1, a0 + 1, b0, b0 + 1 });
            }
        }
        const float3 foot = toWorld(sx, 0, 0);
        mShadowSpots.push_back({ foot.x, foot.z, 1.0f, 1.6f });
    }

    // Banner: 2-row chequer on both faces, ink edges. The column count is the
    // JS's — ~square checks with an ODD count so both ends land on the same
    // colour (an even count put the whole board a half-check out of phase), and
    // the row parity is flipped because the texture's canvas y runs top-down
    // while these quads stack bottom-up.
    const int rows = 2;
    const int cols = 2 * (int) std::lround(halfSpan * rows / BANNER_H) + 1;
    const float cw = 2 * halfSpan / cols, chh = BANNER_H / rows;
    for (const float z : { -BANNER_D / 2, BANNER_D / 2 }) {
        for (int y = 0; y < rows; y++) {
            for (int x = 0; x < cols; x++) {
                const float3 col = ((x + (rows - 1 - y)) % 2) ? PAPER : INKC;
                const float x0 = -halfSpan + x * cw, y0 = CLEARH + y * chh;
                quadW(toWorld(x0, y0, z), toWorld(x0 + cw, y0, z),
                        toWorld(x0, y0 + chh, z), toWorld(x0 + cw, y0 + chh, z), col);
            }
        }
    }
    quadW(toWorld(-halfSpan, CLEARH + BANNER_H, -BANNER_D / 2),
            toWorld(halfSpan, CLEARH + BANNER_H, -BANNER_D / 2),
            toWorld(-halfSpan, CLEARH + BANNER_H, BANNER_D / 2),
            toWorld(halfSpan, CLEARH + BANNER_H, BANNER_D / 2), PYLON_C); // top edge
    quadW(toWorld(-halfSpan, CLEARH, -BANNER_D / 2),
            toWorld(halfSpan, CLEARH, -BANNER_D / 2),
            toWorld(-halfSpan, CLEARH, BANNER_D / 2),
            toWorld(halfSpan, CLEARH, BANNER_D / 2), PYLON_C); // underside
    accumulateNormals(mGantry);
    mGantry.bakeLight = true;
    buildMesh(mGantry);
}

// The matte light rig, as NUMBERS: exactly what the scene's sun and
// IndirectLight are built from in buildStatic, and exactly what
// bakeVertexLight bakes into the receivers' vertices — ONE derivation so the two
// cannot drift. Intensities are UNEXPOSED; a consumer replicating
// frameUniforms multiplies by the camera's exposure (Filament pre-exposes
// both lights the same way — ColorPassDescriptorSet::prepare*Light).
TtpRenderer::MatteRig TtpRenderer::matteRig(const TrackBin& tb) const {
    const float3 skyC = srgbToLinear(tb.hemiSky);
    const float3 gndC = srgbToLinear(tb.hemiGround);
    return { srgbToLinear(tb.keyCol),
             48000.0f * (tb.keyIntensity / 1.4f),
             (skyC + gndC) * 0.5f, (skyC - gndC) * 0.5f,
             28000.0f * (tb.hemiIntensity / 2.2f) };
}

// The playroom's horizon is the room the floor lies in: four walls standing
// kRoomMargin past the lap's reach on every side, near enough for the fog to
// leave them their colour. At the toy cars' scale (1 u is about 5.5 cm) the
// room is all there is of the real world, so it is drawn as a room is seen
// from the floor, never as furniture to recognise: a white skirting board
// along the foot of every wall, a dado rail with the wall a deeper shade
// under it, bunting strung round the walls, and one window, in the wall the
// grid straight points at, with the daylight in it and its curtains drawn
// back. Colours from the theme's
// hill list by index (theme.cc playroomTheme). Every face is its own quad
// with its own normal (flat shaded), and a wall is cut every kRoomStep so the
// fog, which is per vertex, has corners to interpolate between.
void TtpRenderer::buildRoomRing(const TrackBin& tb) {
    float x0 = 1e30f, x1 = -1e30f, z0 = 1e30f, z1 = -1e30f;
    for (const auto& s : tb.samples) {
        x0 = std::min(x0, s.pos.x); x1 = std::max(x1, s.pos.x);
        z0 = std::min(z0, s.pos.z); z1 = std::max(z1, s.pos.z);
    }
    if (!(x1 > x0)) return;
    x0 -= kRoomMargin; x1 += kRoomMargin; z0 -= kRoomMargin; z1 += kRoomMargin;
    mRoom = { x0, z0, x1, z1 };
    const float floorY = tb.groundY, foot = floorY - 1.0f;
    const auto colour = [&](int i) {
        return srgbToLinear(tb.hillColors.empty() ? 0x8cc578u
                : tb.hillColors[(size_t) i % tb.hillColors.size()]);
    };
    const float3 TRIM = colour(4), WALL = colour(5), DADO = colour(6), CURTAIN = colour(7);
    const float3 SKY_TOP = colour(8), SKY_LOW = colour(9), ROD = colour(10);
    const float3 Y{ 0, 1, 0 };
    // THE ROOM SHOWS ITS AUTHORED COLOURS. Under the warm room light a wall
    // that faces away from the sun bakes to grey, so each face's colour is
    // divided by the light its normal bakes (the sheet folds it back in) and
    // given a fixed form shade instead: tops full, faces turned from the sun
    // a little darker, undersides darker still, so the corners and the
    // skirting's profile read.
    const float3 sunFlat = normalize(float3{ kToSun.x, 0, kToSun.z });
    const auto shown = [&](const float3& c, const float3& n) {
        const float form = n.y > 0.5f ? 1.0f : n.y < -0.5f ? 0.72f
                : 0.86f + 0.14f * std::max(0.0f, dot(n, sunFlat));
        const float3 l = bakedMatteLight(n);
        return float3{ std::min(1.0f, c.x * form / std::max(1e-3f, l.x)),
                       std::min(1.0f, c.y * form / std::max(1e-3f, l.y)),
                       std::min(1.0f, c.z * form / std::max(1e-3f, l.z)) };
    };
    // A quad p0 -> p1 -> p2 -> p3, wound to face `n`, a colour per corner.
    const auto quad = [&](const float3 (&p)[4], const float3& n, const float3 (&c)[4]) {
        const bool flip = dot(cross(p[1] - p[0], p[2] - p[0]), n) < 0;
        const uint32_t base = (uint32_t) mHills.verts.size();
        for (int j = 0; j < 4; j++) {
            const int q = flip ? (4 - j) % 4 : j;
            mHills.verts.push_back({ p[q].x, p[q].y, p[q].z, packAlbedo(shown(c[q], n), 1.0f) });
            mHills.normals.push_back(n);
        }
        for (const uint32_t t : { 0u, 1u, 2u, 0u, 2u, 3u }) mHills.idx.push_back(base + t);
    };
    const auto flat = [&](const float3& a, const float3& b, const float3& c, const float3& d,
            const float3& n, const float3& col) {
        quad({ a, b, c, d }, n, { col, col, col, col });
    };
    // Each wall in its own frame: `o` its inner face's left end seen from the
    // room, `t` along it to the right, `n` into the room, `len` long. The
    // first is the window's (+z: every Playroom grid straight points at it).
    struct Wall { float3 o, t, n; float len; };
    const Wall walls[4] = {
        { { x1, 0, z1 }, { -1, 0, 0 }, { 0, 0, -1 }, x1 - x0 },
        { { x0, 0, z1 }, { 0, 0, -1 }, { 1, 0, 0 }, z1 - z0 },
        { { x0, 0, z0 }, { 1, 0, 0 }, { 0, 0, 1 }, x1 - x0 },
        { { x1, 0, z0 }, { 0, 0, 1 }, { -1, 0, 0 }, z1 - z0 },
    };
    // The window: centred where the grid straight points (x = 0, the lap's
    // origin), kept clear of the corners.
    const float winHalf = 0.5f * kRoomWinW;
    const float winC = std::min(x1 - winHalf - 12.0f, std::max(x0 + winHalf + 12.0f, 0.0f));
    const float winS = (x1 - winC) - winHalf, winE = winS + kRoomWinW;   // along the first wall
    const float sill = floorY + kRoomSill, lintel = sill + kRoomWinH;
    const float dado = floorY + kRoomDado, top = floorY + kRoomH;
    for (int w = 0; w < 4; w++) {
        const Wall& W = walls[w];
        const float3 mid = W.o + W.t * (0.5f * W.len);
        const float reach = 0.5f * W.len + 3.0f;
        if (mKitFieldMaxX > mKitFieldMinX   // the gallery's field wins, as in the ring
                && mid.x + reach > mKitFieldMinX - ttp::rt::kKitFieldClear
                && mid.x - reach < mKitFieldMaxX + ttp::rt::kKitFieldClear
                && mid.z + reach > mKitFieldMinZ - ttp::rt::kKitFieldClear
                && mid.z - reach < mKitFieldMaxZ + ttp::rt::kKitFieldClear) {
            continue;
        }
        mHillAnchors.push_back({ mid.x, mid.z, top - 1.0f });
        // The face, in columns and in rows (the dado band, the rail's, the
        // wall over it in two), the window's hole left out of the first.
        const int cols = std::max(1, (int) std::ceil(W.len / kRoomStep));
        const float rows[5] = { foot, dado, dado + kRoomRail, 0.5f * (dado + top), top };
        for (int c = 0; c < cols; c++) {
            const float s0 = W.len * c / cols, s1 = W.len * (c + 1) / cols;
            for (int r = 0; r < 4; r++) {
                const float3& col = r == 0 ? DADO : r == 1 ? TRIM : WALL;
                const auto face = [&](float a, float b, float lo, float hi) {
                    if (b <= a || hi <= lo) return;
                    flat(W.o + W.t * a + Y * lo, W.o + W.t * b + Y * lo, W.o + W.t * b + Y * hi,
                            W.o + W.t * a + Y * hi, W.n, col);
                };
                const float lo = rows[r], hi = rows[r + 1];
                if (w == 0 && s1 > winS && s0 < winE && hi > sill && lo < lintel) {
                    const float a = std::max(s0, winS), b = std::min(s1, winE);
                    face(s0, a, lo, hi);
                    face(b, s1, lo, hi);
                    face(a, b, lo, std::max(lo, sill));
                    face(a, b, std::min(hi, lintel), hi);
                } else {
                    face(s0, s1, lo, hi);
                }
            }
        }
        // A box standing `d` proud of the wall: [a, b] along it, [lo, hi] up.
        const auto block = [&](float a, float b, float lo, float hi, float d, const float3& col) {
            const float3 A = W.o + W.t * a, B = W.o + W.t * b, An = A + W.n * d, Bn = B + W.n * d;
            flat(An + Y * lo, Bn + Y * lo, Bn + Y * hi, An + Y * hi, W.n, col);   // front
            flat(A + Y * hi, B + Y * hi, Bn + Y * hi, An + Y * hi, Y, col);         // top
            flat(A + Y * lo, B + Y * lo, Bn + Y * lo, An + Y * lo, -Y, col);        // underside
            flat(A + Y * lo, An + Y * lo, An + Y * hi, A + Y * hi, -W.t, col);      // ends
            flat(B + Y * lo, Bn + Y * lo, Bn + Y * hi, B + Y * hi, W.t, col);
        };
        // The skirting board with a bead along its top, and the dado rail,
        // which stops at the window's frame.
        block(0, W.len, foot, floorY + kRoomSkirt, 0.5f, TRIM);
        block(0, W.len, floorY + kRoomSkirt, floorY + kRoomSkirt + 0.35f, 0.7f, TRIM);
        const float frameS = winS - 1.4f, frameE = winE + 1.4f;   // the frame's outer edges (below)
        if (w == 0 && dado + kRoomRail > sill - 2.2f) {
            block(0, frameS, dado, dado + kRoomRail, 0.4f, TRIM);
            block(frameE, W.len, dado, dado + kRoomRail, 0.4f, TRIM);
        } else {
            block(0, W.len, dado, dado + kRoomRail, 0.4f, TRIM);
        }
        // BUNTING all round the room: a string of flags in the toys' four
        // colours, swagged between pins every kBuntPin, clear of the window
        // and its curtains.
        {
            const float pinY = floorY + kBuntY, clearA = winS - 15.0f, clearB = winE + 15.0f;
            const int spans = std::max(1, (int) std::floor((W.len - 8.0f) / kBuntPin));
            const float s0 = 0.5f * (W.len - spans * kBuntPin);
            int flag = w * 7;
            for (int sp = 0; sp < spans; sp++) {
                const float a = s0 + sp * kBuntPin, b = a + kBuntPin;
                if (w == 0 && b > clearA && a < clearB) continue;
                const int n = (int) std::floor(kBuntPin / 2.6f);
                for (int k = 0; k < n; k++) {
                    const float t0 = (k + 0.15f) / n, t1 = (k + 0.85f) / n, tm = 0.5f * (t0 + t1);
                    const auto sag = [&](float t) { return pinY - kBuntSag * 4.0f * t * (1.0f - t); };
                    const float3 o = W.o + W.n * 0.35f;
                    const float3 p0 = o + W.t * (a + kBuntPin * t0) + Y * sag(t0);
                    const float3 p1 = o + W.t * (a + kBuntPin * t1) + Y * sag(t1);
                    const float3 tip = o + W.t * (a + kBuntPin * tm) + Y * (sag(tm) - 2.6f);
                    const float3 c = colour(flag++ % 4);
                    quad({ p0, p1, tip, tip }, W.n, { c, c, c, c });
                }
            }
        }
        if (w != 0) continue;
        // THE WINDOW. Its glass is the daylight, a sky deeper at the top, in
        // bands so the gradient has rows (lit full, as a top is: it is light).
        const float3 g0 = W.o + W.t * winS + W.n * 0.05f, g1 = W.o + W.t * winE + W.n * 0.05f;
        for (int k = 0; k < 4; k++) {
            const float lo = sill + kRoomWinH * k / 4, hi = sill + kRoomWinH * (k + 1) / 4;
            const float3 cl = SKY_LOW + (SKY_TOP - SKY_LOW) * ((float) k / 4);
            const float3 ch = SKY_LOW + (SKY_TOP - SKY_LOW) * ((float) (k + 1) / 4);
            quad({ g0 + Y * lo, g1 + Y * lo, g1 + Y * hi, g0 + Y * hi }, Y, { cl, cl, ch, ch });
        }
        // Two clouds going by outside, white blocks on the sky.
        const float3 cloud{ 0.97f, 0.97f, 0.97f };
        for (const float4& c : { float4{ 0.28f, 0.72f, 0.20f, 0.09f }, float4{ 0.70f, 0.52f, 0.14f, 0.07f } }) {
            const float a = winS + kRoomWinW * (c.x - c.z), b = winS + kRoomWinW * (c.x + c.z);
            const float lo = sill + kRoomWinH * (c.y - c.w), hi = sill + kRoomWinH * (c.y + c.w);
            const float3 o = W.o + W.n * 0.1f;
            quad({ o + W.t * a + Y * lo, o + W.t * b + Y * lo, o + W.t * b + Y * hi, o + W.t * a + Y * hi },
                    Y, { cloud, cloud, cloud, cloud });
        }
        const float F = 1.4f, midS = 0.5f * (winS + winE), midY = 0.5f * (sill + lintel);
        block(winS - F, winS, sill - F, lintel + F, 0.6f, TRIM);            // the frame
        block(winE, winE + F, sill - F, lintel + F, 0.6f, TRIM);
        block(winS, winE, lintel, lintel + F, 0.6f, TRIM);
        block(winS - F - 1.2f, winE + F + 1.2f, sill - F - 0.8f, sill, 2.0f, TRIM);   // the sill
        block(midS - 0.45f, midS + 0.45f, sill, lintel, 0.4f, TRIM);        // the glazing bars
        block(winS, winE, midY - 0.45f, midY + 0.45f, 0.4f, TRIM);
        // The curtains, drawn back either side in three folds, on a rod.
        const float rod = lintel + 4.0f;
        block(winS - 13.0f, winE + 13.0f, rod - 0.5f, rod + 0.5f, 1.6f, ROD);
        for (const float side : { -1.0f, 1.0f }) {
            const float edge = side < 0 ? winS - F + 2.5f : winE + F - 2.5f;
            for (int k = 0; k < 3; k++) {
                const float a = edge - side * (k * 3.2f), b = a - side * 3.2f;
                block(std::min(a, b), std::max(a, b), sill - 6.0f, rod - 0.4f, 1.2f + 0.5f * (k % 2), CURTAIN);
            }
        }
    }
}

bool TtpRenderer::buildStatic(const std::string& key, const ttp::RaceTrack& geo,
        const ttp::rt::Theme& theme, const ttp::rt::WearPlan& wear) {
    PhaseLog phases{ mEngine };
    // THE TILES (tileMajor, bakePlacements), twice as coarse where a draw costs
    // more than the vertices a coarser tile submits: the Android GL fallback
    // (a draw is driver CPU there; init) and the lite tier, whose box is as
    // bound by draws as by vertices at four players. Lite's cut that a racer
    // cannot see at all: measured on the heavy tracks, a quarter of the 4P
    // frame's draws for 2-3% more of its vertices (less of each sheet culled).
    const bool coarse = mAndroidGl || mLite;
    mSheetTile = coarse ? 2.0f * kSheetTile : kSheetTile;
    mSheetMinTris = coarse ? 4 * kSheetMinTris : kSheetMinTris;
    mPieceTile = coarse ? 2.0f * kPieceTile : kPieceTile;

    TrackBin tb;
    applyTheme(tb, theme);
    fillGeometry(tb, geo);
    tb.buildArclengthIndex(); // frameAt's bin lookup — see the comment there
    setupTerrain(tb); // before the ground sheet and every builder that stands on it
    {
        // The light every static sheet is folded with (Mesh::bakeLight) —
        // before the first of them is built, and pre-exposed the way Filament
        // hands the same rig to the shader (lightColorIntensity.w and
        // iblLuminance both carry the camera's exposure).
        const MatteRig rig = matteRig(tb);
        const float exposure = mCamera ? Exposure::exposure(*mCamera) : 0.0f;
        mBakeRig = { rig.sunColor * (rig.sunLux * exposure / (float) M_PI),
                     rig.sh0, rig.sh1, rig.hemiLux * exposure, mCamera != nullptr };
    }
    const float groundY = tb.groundY;

    if (!buildRoadMesh(tb)) return false;
    // The deck's fixed furniture becomes stamps on the road we just built, and
    // its paint (repairs, pads) goes onto the chunks that carry it. Without a
    // vroad material there are no stamps: the deck draws bare.
    if (mRoadMaterial) {
        buildStaticDeckDecals(tb);
        buildDeckPaint(tb, wear);
    }

    // Ground sheet at groundY: the biome's banding as vertex-colour bands,
    // read from the same groundPalette the tiled canvas rasterizes.
    {
        // Every ground kind is the same tiled-canvas idiom (textures.js): N
        // vertical bands of a per-kind luminance/hue wobble over a base colour,
        // 33.3u per tile. Only the banding (and the wood's board seams, which
        // do read) crosses over — the JS speckle passes are deliberately gone
        // (see buildGroundTexture).
        std::vector<GroundBand>& bands = mGroundBands;
        bands.clear();
        const auto shade = [](uint32_t base, float fr, float fg, float fb) {
            return float3{ srgbChannel(std::min(1.0f, ((base >> 16) & 0xff) / 255.0f * fr)),
                           srgbChannel(std::min(1.0f, ((base >> 8) & 0xff) / 255.0f * fg)),
                           srgbChannel(std::min(1.0f, (base & 0xff) / 255.0f * fb)) };
        };
        const GroundPalette& pal = groundPalette(tb.groundKind);
        if (tb.groundKind == 4) {
            // wood — each band IS a plank, with a dark seam between
            const float bw = 1.0f / pal.bands, seam = 2.0f / 256; // 2px of the 256px tile
            for (int i = 0; i < pal.bands; i++) {
                float f[3];
                pal.factor(i, f);
                if (i) {
                    // The seam is STROKED at kWoodSeamAlpha over the plank, not
                    // painted solid — the raw seam colour reads as a black gap
                    // between boards. 0.45f is its paired complement, a literal
                    // on purpose (never derived as 1 - alpha).
                    const float3 board = shade(pal.base, f[0], f[1], f[2]);
                    const float3 ink = shade(kWoodSeamInk, 1, 1, 1);
                    bands.push_back({ seam, board * 0.45f + ink * kWoodSeamAlpha });
                }
                bands.push_back({ bw - (i ? seam : 0), shade(pal.base, f[0], f[1], f[2]) });
            }
        } else {
            for (int i = 0; i < pal.bands; i++) {
                float f[3];
                pal.factor(i, f);
                bands.push_back({ 1.0f / pal.bands,
                        shade(tb.groundBase ? tb.groundBase : pal.base, f[0], f[1], f[2]) });
            }
        }
        // The bands stay — the berms sample them by world x (groundColorAt),
        // which is how the JS shares one texture between floor and kerb. The
        // FLOOR mesh itself builds AFTER the builders below, because the
        // landmark spots carve clearings into the terrain field it samples.
    }



    // The gallery's kit field, off in every build but its own. BEFORE the hill
    // ring, which is the one thing in the scene that reaches as far out as the
    // field does: the ring reads the bounds this leaves behind and stands no
    // hill inside them, so the field gets the clear horizon a browser needs
    // instead of a row of models parked behind a mountain.
    phases.mark("prologue");
    buildKitField(tb);

    // Horizon hill ring (environment.js buildHillRingGeometry, 'dome' shape):
    // 18 squashed spheres, fully deterministic index math, theme colours cycled,
    // ring pushed out for big circuits (sf) exactly like setTrack does.
    {
        float maxR = 0;
        for (const auto& s : tb.samples) {
            maxR = std::max(maxR, std::sqrt(s.pos.x * s.pos.x + s.pos.z * s.pos.z));
        }
        const float sf = std::max(1.0f, (maxR + 60.0f) / 150.0f);
        mHillSf = sf; // the balloon's orbit radius scales with the same push-out
        // Four silhouettes (buildHillRingGeometry): meadow domes, canyon mesas
        // (flat-topped 9-sided talus cones), the playroom's walls (below)
        // and beach islands (fewer, lower, farther domes — the sea has to show
        // BETWEEN them). Feature count, scale and radius all vary per shape.
        const uint32_t shape = tb.hillShape;
        const int count = shape == 1 ? 14 : shape == 2 ? 0 : shape == 3 ? 9 : 18;
        if (shape == 2) buildRoomRing(tb);
        for (int i = 0; i < count; i++) {
            float sx, sy, sz, a, r, yaw = 0;
            if (shape == 1) {        // mesa
                yaw = (i % 7) * 0.9f;
                sy = 8 + (i % 3) * 4.5f;
                sx = 20 + (i % 4) * 8; sz = 16 + ((i + 2) % 4) * 7;
                a = ((float) i / count) * 2.0f * (float) M_PI + (i % 5) * 0.17f;
                r = 152 + (i % 3) * 20;
            } else if (shape == 3) { // island
                sy = 3.5f + (i % 3) * 2.2f;
                sx = 28 + (i % 4) * 11; sz = 20 + ((i + 1) % 4) * 8;
                a = ((float) i / count) * 2.0f * (float) M_PI + (i % 5) * 0.21f;
                r = 172 + (i % 3) * 24;
            } else {                 // dome
                sy = 7 + (i % 3) * 4;
                sx = 26 + (i % 4) * 9; sz = 22 + ((i + 1) % 4) * 8;
                a = ((float) i / count) * 2.0f * (float) M_PI + (i % 5) * 0.13f;
                r = 150 + (i % 3) * 18;
            }
            const float cx = std::cos(a) * r, cz = std::sin(a) * r;
            // The gallery's kit field takes precedence over the horizon where
            // the two meet (DEV; mKitField* is empty in every other build). A
            // hill is the only thing out there big enough to hide a row of
            // models behind, and a browser you have to fly around a mountain to
            // read is not one. Skipped whole rather than moved: the ring is
            // deterministic index math, and nudging one feature would land it
            // on its neighbour.
            if (mKitFieldMaxX > mKitFieldMinX
                    && (cx + sx) * sf > mKitFieldMinX - ttp::rt::kKitFieldClear
                    && (cx - sx) * sf < mKitFieldMaxX + ttp::rt::kKitFieldClear
                    && (cz + sz) * sf > mKitFieldMinZ - ttp::rt::kKitFieldClear
                    && (cz - sz) * sf < mKitFieldMaxZ + ttp::rt::kKitFieldClear) {
                continue;
            }
            mHillAnchors.push_back({ cx, cz, sy - 1.0f }); // authored coords
            const float3 hc = srgbToLinear(
                    tb.hillColors.empty() ? 0x8cc578u
                                          : tb.hillColors[i % tb.hillColors.size()]);
            const uint32_t col = packAlbedo(hc, 1.0f);
            const float cyw = std::cos(yaw), syw = std::sin(yaw);
            const auto rot = [&](const float3& p) {
                return float3{ p.x * cyw + p.z * syw, p.y, -p.x * syw + p.z * cyw };
            };
            // The mesa yaws BEFORE its non-uniform scale (facet phase).
            const auto place = [&](float3 p) {
                if (yaw != 0) p = rot(p);
                p = { p.x * sx, p.y * sy, p.z * sz };
                return float3{ (p.x + cx) * sf, p.y - 1.0f, (p.z + cz) * sf };
            };
            if (shape == 1) {
                // A mesa as the canyon's rock stands: a talus apron, then
                // cliffs of level strata stepping back over a bench to a
                // flat cap, each stratum its own colour of the palette with
                // a pale seam under each bench, on a ragged nine-sided
                // outline every level shares (so a cliff stands plumb).
                // Every third one is a low table with no upper tier, every
                // other one's upper tier is a butte standing well in from
                // the bench. Each facet has corners of its own: flat faces
                // (a smooth cone read as a sand lump, never as rock).
                constexpr int N = 9;
                const bool low = i % 3 == 2;
                const float up = i % 2 ? 0.44f : 0.585f; // the upper tier's radius
                // {radius, height} of each ring, foot to cap
                const float ring[8][2] = {
                    { 1.0f, 0.0f }, { 0.74f, 0.36f }, { 0.7f, 0.58f }, { 0.695f, 0.65f },
                    { up + 0.02f, 0.67f }, { up, 0.87f }, { up - 0.005f, 0.93f }, { up - 0.01f, 1.0f } };
                // The lite tier's has no seams: the box's frame cannot show
                // a stratum that thin, and the ring stands in every cell.
                const int liteRing[5] = { 0, 1, 3, 4, 7 };
                const uint32_t liteBand[4] = { 0, 1, 3, 4 };
                const int rings = mLite ? (low ? 3 : 5) : (low ? 4 : 8);
                const auto rock = [&](int k) {
                    return srgbToLinear(tb.hillColors.empty() ? 0x8cc578u
                            : tb.hillColors[(size_t) (i + k) % tb.hillColors.size()]);
                };
                const auto tone = [&](int k, float f) { return packAlbedo(rock(k) * f, 1.0f); };
                // the pale stratum: the palette's rock bleached toward white
                const uint32_t seam = packAlbedo(mix(rock(2), float3{ 1.0f }, 0.45f), 1.0f);
                // talus, cliff, seam, bench, cliff, seam, cap rock
                const uint32_t band[7] = { tone(0, 1.0f), tone(1, 0.92f), seam, tone(2, 1.0f),
                                           tone(1, 1.0f), seam, tone(0, 0.8f) };
                float jag[N];
                for (int k = 0; k < N; k++) {
                    jag[k] = 0.84f + 0.24f * std::fabs(std::sin((float) (i * 7 + k * 13) * 1.37f));
                }
                const auto at = [&](int r, int k) {
                    const float a = (float) (k % N) / N * 2.0f * (float) M_PI;
                    // the foot spreads rounder than the cliffs over it
                    const float j = r == 0 ? 0.5f + 0.5f * jag[k % N] : jag[k % N];
                    const float* const at = ring[mLite ? liteRing[r] : r];
                    return place({ std::cos(a) * at[0] * j, at[1], std::sin(a) * at[0] * j });
                };
                const auto quad = [&](const float3& a, const float3& b, const float3& c,
                        const float3& d, uint32_t colour) {
                    const uint32_t base = (uint32_t) mHills.verts.size();
                    for (const float3& p : { a, b, c, d }) mHills.verts.push_back({ p.x, p.y, p.z, colour });
                    for (const uint32_t t : { 0u, 2u, 1u, 0u, 3u, 2u }) mHills.idx.push_back(base + t);
                };
                for (int r = 0; r + 1 < rings; r++) {
                    const uint32_t colour = band[mLite ? liteBand[r] : (uint32_t) r];
                    for (int k = 0; k < N; k++) quad(at(r, k), at(r, k + 1), at(r + 1, k + 1), at(r + 1, k), colour);
                }
                const float3 mid = place({ 0, ring[mLite ? liteRing[rings - 1] : rings - 1][1], 0 });
                const uint32_t capCol = tone(2, 1.0f);
                for (int k = 0; k < N; k++) {
                    const uint32_t base = (uint32_t) mHills.verts.size();
                    for (const float3& p : { at(rings - 1, k), at(rings - 1, k + 1), mid }) {
                        mHills.verts.push_back({ p.x, p.y, p.z, capCol });
                    }
                    for (const uint32_t t : { 0u, 2u, 1u }) mHills.idx.push_back(base + t);
                }
            } else {
                appendSphere(mHills, 8, 5, place,
                        [&](const float3&) { return col; }, true);
            }
        }
        if (shape == 1) accumulateNormals(mHills);   // the room lays its own (buildRoomRing)
        mHills.bakeLight = true;
        // The ring stands all round the circuit, so one renderable is in every
        // cell's frustum; tiles let each cell draw only the hills it faces.
        tileMajor(mHills, mSheetTile, mSheetMinTris);
        if (!buildMesh(mHills)) return false;
    }

    // Race-fog colour for the cell views (renderCells applies it): the same
    // theme colour as the sky horizon, so distant geometry dissolves into sky.
    mFogColor = srgbToLinear(tb.fog);
    // tb.fogTune is NOT read here: the ramp arrives per view, already scaled.
    // It stays in the payload for the framing code (libttp-runtime's
    // framing.cc), which scales bbFog/raceFog by it.

    // The JS light rig (environment.js "toy lighting"): the warm KEY from
    // near-overhead (theme.key: 0xffe8d0 @1.4, position 2,12,1.5) plus the
    // sky/ground HEMISPHERE fill (theme.hemi: white / 0x9aa68f @2.2) — the
    // hemisphere encodes exactly as 2-band SH (constant + y). Relative
    // strengths keep the hemi dominant, matching the soft toy read.
    // Both intensities were calibrated against the JS pane at the grass rig
    // (key 1.4 / hemi 2.2), so a biome's own intensities ride in as a RATIO on
    // those calibration points rather than as absolute numbers.
    const MatteRig rig = matteRig(tb);
    mSun = utils::EntityManager::get().create();
    // No engine shadows: bakeShadowMap bakes the sun once per static scene into
    // the receivers' visibility maps. Leaving Filament's on would re-render the
    // same static depth pass per view per frame.
    LightManager::Builder(LightManager::Type::DIRECTIONAL)
            .color(rig.sunColor)
            .intensity(rig.sunLux)
            .direction(-kToSun)
            .castShadows(false)
            .build(*mEngine, mSun);
    mScene->addEntity(mSun);
    {
        // The y band stays at three's HemisphereLight weighting (E = (sky+gnd)/2
        // + (sky−gnd)/2·n.y). Scaling it down by the SH convolution ratio
        // (0.866) was tried on the theory that Filament over-weights it — it
        // made every biome worse, so the two evaluations already agree.
        const float3 sh[4] = { rig.sh0, rig.sh1, { 0, 0, 0 }, { 0, 0, 0 } };
        mAmbient = IndirectLight::Builder()
                .irradiance(2, sh)
                .intensity(rig.hemiLux)
                .build(*mEngine);
        mScene->setIndirectLight(mAmbient);

        // THE SKY DOME (TtpRenderer.h, mSkyDome): the biome's elevation
        // gradient as graded vertex colours on a unit sphere, 49 rings so the
        // pow() curve between rings is a straight segment under a code value
        // of the cubemap it replaced. Placed and scaled per cell in
        // renderCells. Not a caster (buildMesh's default layer), so the sun
        // bake never sees it; not fogged (vsky.mat); never culled, its box
        // holds the eye.
        const auto vsky = mAssets.find("vsky.filamat");
        if (!mSkyMaterial && vsky != mAssets.end()) {
            mSkyMaterial = Material::Builder()
                    .package(vsky->second.data(), vsky->second.size())
                    .build(*mEngine);
        }
        // LITE: a third of the rings and three quarters of the spokes. The
        // dome is never culled, so every cell pays all of it, about 7% of the
        // 4P frame's vertices; the coarse one is a quarter of that, and the
        // gradient between its rings strays a few code values.
        const int R = mLite ? 16 : SKY_DOME_RINGS, S = mLite ? 24 : SKY_DOME_SEGS;
        mSkyInset = std::cos((float) M_PI / S) * std::cos((float) M_PI / (2 * R));
        if (mSkyMaterial) {
            const float3 top = skyLinear(tb.sky[0]), hor = skyLinear(tb.sky[1]),
                         low = skyLinear(tb.sky[2]);
            mSkyDome.verts.clear();
            mSkyDome.idx.clear();
            for (int r = 0; r <= R; r++) {
                const float el = ((float) r / R - 0.5f) * (float) M_PI;   // nadir .. zenith
                const float t = std::sin(el), ce = std::cos(el);
                const float3 c = t >= 0
                        ? mix(hor, top, std::pow(t, tb.skyCurve))
                        : mix(hor, low, std::min(1.0f, -t * 3.0f));
                const uint32_t col = packShown(c, 1.0f);
                for (int sg = 0; sg <= S; sg++) {
                    const float az = (float) sg / S * 2.0f * (float) M_PI;
                    mSkyDome.verts.push_back({ ce * std::cos(az), t, ce * std::sin(az), col });
                }
            }
            for (int r = 0; r < R; r++) {
                for (int sg = 0; sg < S; sg++) {
                    const uint32_t q = (uint32_t) (r * (S + 1) + sg), p = q + S + 1;
                    for (uint32_t ix : { q, p, q + 1, q + 1, p, p + 1 }) {
                        mSkyDome.idx.push_back((decltype(mSkyDome.idx)::value_type) ix);
                    }
                }
            }
            buildMesh(mSkyDome, true, sceneInstance(mSkyMaterial));
        }
    }

    // Furniture: item boxes at their authored anchors (availability reconciled
    // per frame from the snapshot), a banana pool for dropped hazards, and the
    // boost-pad overlays.
    mBoxAsset = loadInstancedProp("item-box.glb", tb.boxes.size(), mBoxInstances);
    // TrackProps sizes the kit box to BOX_H 0.3 world units (the GLB ships
    // 0.445 tall) and floats its BASE BOX_FLOAT 0.18 over the deck — the
    // native pool used to place the raw asset at a 0.42 hover, so the boxes
    // read half again too big and sat too high.
    mBoxScale = 1.0f;
    if (mBoxAsset) {
        const filament::Aabb bb = mBoxAsset->getBoundingBox();
        const float h = bb.max.y - bb.min.y;
        if (h > 1e-3f) mBoxScale = 0.3f / h;
    }
    // The collect fade runs on a BLEND clone of the same GLB (Display.js patches
    // it with ghostGlb, as the monster's ghost bodies are): the kit material is
    // OPAQUE, so the solid instance above cannot be faded at all. The grab hands
    // the box over to its twin at the same pose and ramps that one's alpha out.
    mBoxFadeAsset = loadInstancedProp("item-box-fade.glb", tb.boxes.size(),
            mBoxFadeInstances, false);
    mBoxXf.clear();
    for (const TrackBin::Box& b : tb.boxes) {
        mBoxXf.push_back(tb.frameAt(b.s).basis(b.lat));
    }
    // loadInstancedProp added every pool member; the first reconcile removes
    // whatever isn't live (frame 1, like the ghosts). Seeded 1 for that.
    mBoxIn.assign(mBoxInstances.size(), 1);
    mBoxFadeIn.assign(mBoxFadeInstances.size(), 1);
    mEffectsWarm = false; // a new scene's pools have not drawn yet
    // Resolve the emissive-bearing material instances once — the gold throb
    // retints these per frame instead of string-probing every material.
    mBoxGlowMats.clear();
    mBoxGlowPulse = -1; // fresh instances hold defaults, not the last pulse
    const auto collectGlow = [&](gltfio::FilamentInstance* inst) {
        if (!inst) return;
        MaterialInstance* const* mats = inst->getMaterialInstances();
        for (size_t mi = 0; mi < inst->getMaterialInstanceCount(); mi++) {
            if (!mats[mi]->getMaterial()->hasParameter("emissiveFactor")) continue;
            if (std::find(mBoxGlowMats.begin(), mBoxGlowMats.end(), mats[mi])
                    == mBoxGlowMats.end()) {
                mBoxGlowMats.push_back(mats[mi]);
            }
        }
    };
    for (auto* inst : mBoxInstances) collectGlow(inst);
    for (auto* inst : mBoxFadeInstances) collectGlow(inst);
    // The box tint (kBoxTint). The fade twins take it per frame with their
    // alpha, which overwrites the whole factor.
    for (auto* inst : mBoxInstances) {
        MaterialInstance* const* mats = inst->getMaterialInstances();
        for (size_t mi = 0; mi < inst->getMaterialInstanceCount(); mi++) {
            if (!mats[mi]->getMaterial()->hasParameter("baseColorFactor")) continue;
            mats[mi]->setParameter("baseColorFactor", math::float4{ kBoxTintFactor, 1.0f });
        }
    }
    mBananaAsset = loadInstancedProp("item-banana.glb", 8, mBananaInstances);
    mBananaIn.assign(mBananaInstances.size(), 1);
    // Contact blobs for the FLOATING props (TrackProps' _boxShadow) are all
    // road-shader stamps now: the boxes' in buildStaticDeckDecals, the
    // bananas' and rockets' in the render loop.
    phases.mark("props");
    buildWater(tb);
    buildPonds(tb);
    buildFliers(tb);
    buildOils(tb);   // the cones and signs; the slick itself is a road stamp
    phases.mark("w:water+oil");
    buildStructures(tb);
    // The track's set pieces before anything seeded: they are authored, so
    // they win their ground, and every pass after keeps out of mSetFeet.
    buildSetPieces(tb);
    buildStructuresReceiver();   // after the set pieces: their `floor` parts join it
    // Landmarks FIRST: their spots carve flat clearings into the terrain field
    // (mTerrainFlats), which the scatter and the ground mesh then sample. The
    // three streams are independently seeded, so this order moves nothing.
    buildLandmarks(tb);
    phases.mark("w:struct+land");
    buildTerrainGrid(tb); // the clearings are carved; freeze the surface
    buildVergeBand(tb);   // and lay the road's verge over it, before anything stands there
    phases.mark("w:terrain");
    buildSightLines(tb);  // the scatter and the props keep out of them
    buildScenery(tb);
    phases.mark("w:scenery");
    buildProps(tb);
    phases.mark("w:props");
    buildClutter(tb);
    phases.mark("w:clutter");

    // The ground sheet, last of the static builders: the terrain field is
    // only complete once the landmark spots have carved their clearings.
    {
        const float G = 400.0f, TILE = kGroundTile;
        const uint32_t white = packAlbedo(float3{ 1, 1, 1 }, 1.0f);
        // A flat sheet, SUBDIVIDED. The step is not about shape — the sheet is
        // flat — it is about the FOG, which is evaluated per VERTEX now
        // (ttp_fog.inc) and therefore interpolates linearly between them. The
        // ground used to be four corners spanning ±400, all of them past the
        // fog's cut-off, so every fragment of it read "no fog" and a sand
        // track's horizon stayed perfectly crisp while everything standing on
        // it faded. 20 u is five samples across the 70→170 u ramp the race
        // profile uses, which linear interpolation of that exponential carries
        // with no visible kink — and it is a TRIANGLE budget as much as a
        // vertex one: at 10 u the sheet measured 3 ms of extra setup on the
        // reference Android GPU, at 20 u well under one.
        constexpr float STEP = 20.0f;
        const auto flatSheet = [&](float x0, float z0, float x1, float z1) {
            if (!(x1 > x0) || !(z1 > z0)) return;
            const int nx = std::max(1, (int) std::lround((x1 - x0) / STEP));
            const int nz = std::max(1, (int) std::lround((z1 - z0) / STEP));
            const uint32_t base = (uint32_t) mGround.verts.size();
            for (int r = 0; r <= nz; r++) {
                for (int c = 0; c <= nx; c++) {
                    const float x = x0 + (x1 - x0) * ((float) c / nx);
                    const float z = z0 + (z1 - z0) * ((float) r / nz);
                    mGround.verts.push_back({ x, groundY, z, white });
                    mGround.uvs.push_back({ x / TILE, z / TILE });
                    mGround.normals.push_back(float3{ 0, 1, 0 });
                }
            }
            for (int r = 0; r < nz; r++) {
                for (int c = 0; c < nx; c++) {
                    const uint32_t a = base + (uint32_t) (r * (nx + 1) + c);
                    const uint32_t b = a + 1, d = a + (uint32_t) nx + 1, e = d + 1;
                    mGround.idx.insert(mGround.idx.end(), { a, d, b, b, d, e });
                }
            }
        };
        if (mTerrainAmp <= 0) {
            flatSheet(-G, -G, G, G);
            kitFieldApron(mGround, groundY, TILE, white);
        } else {
            // Heightfield grid over the terrain region, flat sheet as a 4-strip
            // ring out to ±G. One mesh, one material instance — the relief costs
            // vertices, never draw calls. The heights are the STORED grid
            // (buildTerrainGrid), the same surface every placement stood on;
            // the border rows sit exactly at groundY (terrainY fades to 0
            // there), so the ring joins without a seam.
            const int cols = mGroundGrid.cols, rows = mGroundGrid.rows;
            const float sx = mGroundGrid.sx, sz = mGroundGrid.sz;
            const auto hAt = [&](int c, int r) {
                c = std::min(cols, std::max(0, c));
                r = std::min(rows, std::max(0, r));
                return mGroundGrid.h[(size_t) r * (cols + 1) + c];
            };
            for (int r = 0; r <= rows; r++) {
                for (int c = 0; c <= cols; c++) {
                    const float x = mTerrainX0 + c * sx, z = mTerrainZ0 + r * sz;
                    // Central-difference heightfield normal — analytic, so the
                    // hills shade smooth at any grid step.
                    const float3 n = normalize(float3{
                            (hAt(c - 1, r) - hAt(c + 1, r)) / (2 * sx), 1.0f,
                            (hAt(c, r - 1) - hAt(c, r + 1)) / (2 * sz) });
                    const size_t gv = (size_t) r * (cols + 1) + c;
                    mGround.verts.push_back({ x, hAt(c, r), z,
                            packAlbedo(groundTint(tb.groundKind, mGroundDell[gv], mGroundBed[gv], n.y)
                                       * landTint(x, z), 1.0f) });
                    mGround.uvs.push_back({ x / TILE, z / TILE });
                    mGround.normals.push_back(n);
                }
            }
            for (int r = 0; r < rows; r++) {
                for (int c = 0; c < cols; c++) {
                    const uint32_t a = (uint32_t) (r * (cols + 1) + c);
                    const uint32_t b = a + 1;
                    const uint32_t d = a + (uint32_t) cols + 1, e = d + 1;
                    mGround.idx.insert(mGround.idx.end(), { a, d, b, b, d, e });
                }
            }
            // The verge band (buildVergeBand) after the grid: the vis bake
            // draws the ground depth-tested, and the band lies over it.
            {
                const uint32_t base = (uint32_t) mGround.verts.size();
                for (size_t i = 0; i < mBandVerts.size(); i++) {
                    const Vertex& v = mBandVerts[i];
                    mGround.verts.push_back(v);
                    mGround.uvs.push_back({ v.px / TILE, v.pz / TILE });
                    mGround.normals.push_back(mBandNormals[i]);
                }
                for (const uint32_t q : mBandIdx) mGround.idx.push_back(base + q);
            }
            gateRock(mGround, tb.groundKind);
            const auto flatQuad = flatSheet;
            flatQuad(-G, -G, mTerrainX0, G);            // west strip
            flatQuad(mTerrainX1, -G, G, G);             // east strip
            flatQuad(mTerrainX0, -G, mTerrainX1, mTerrainZ0); // north strip
            flatQuad(mTerrainX0, mTerrainZ1, mTerrainX1, G);  // south strip
            kitFieldApron(mGround, groundY, TILE, white);

            // Depth-pass stand-in (see the caster note before bakeShadowMap):
            // the relief must NOT cast — a heightfield rendered into its own
            // shadow map self-shadows the swells into dotted acne trails —
            // but ground receivers still need a floor in the map or the
            // road's penumbra collapses against the far plane. This flat quad
            // at groundY is that floor: layer bit 0 cleared so no main view
            // ever draws it, bit 1 set (below) so the bake does. At the
            // lowest ground, which is the plain except under a sunk sea: the
            // beach going down to it would bake as shadowed by the floor.
            const float floorY = std::min(groundY,
                    *std::min_element(mGroundGrid.h.begin(), mGroundGrid.h.end()));
            mGroundProxy.verts = {
                { -G, floorY, -G, white }, { G, floorY, -G, white },
                { -G, floorY, G, white }, { G, floorY, G, white } };
            mGroundProxy.idx = { 0, 2, 1, 1, 2, 3 };
            if (buildMesh(mGroundProxy)) {
                auto& rcm = mEngine->getRenderableManager();
                const auto ri = rcm.getInstance(mGroundProxy.entity);
                if (ri) rcm.setLayerMask(ri, 0x01, 0x00);
            }
        }
        // The sheet is the size of the world; cut per tile so a cell submits
        // the tiles in its frustum rather than all of it, four times over.
        tileMajor(mGround, mSheetTile, mSheetMinTris);
        bakeVertexLight(mGround);
        if (mGroundMaterial) {
            mGroundTex = buildGroundTexture(tb.groundKind, tb.groundBase);
            MaterialInstance* gmi = sceneInstance(mGroundMaterial);
            mGroundInst = gmi; // bound to its visibility map once it is baked
            if (mGroundTex) {
                TextureSampler smp(TextureSampler::MinFilter::LINEAR_MIPMAP_LINEAR,
                        TextureSampler::MagFilter::LINEAR);
                smp.setWrapModeS(TextureSampler::WrapMode::REPEAT);
                smp.setWrapModeT(TextureSampler::WrapMode::REPEAT);
                // 4, the same on every ground texture. Priced on the Android box
                // (2026-10-14, 4P 720): aniso off is a null, so it is free.
                smp.setAnisotropy(4.0f);
                gmi->setParameter("albedo", mGroundTex, smp);
            }
            setRockParams(gmi, tb.groundKind, groundY);
            if (!buildMesh(mGround, true, gmi)) return false;
        } else if (!buildMesh(mGround)) {
            return false;
        }
    }

    // The rubber layer — one R8 accumulation texture in track space (s across
    // the width, lat across the height), rasterized on the CPU (mSkidPix) and
    // uploaded as dirty rects, sampled by every vroad instance. Per-track
    // because its width is the lap length at a fixed texel density; the
    // density is capped by the width ceiling (mMaxTextureDim), so a very long
    // lap trades edge crispness, never correctness.
    if (tb.length > 1.0f) {
        float maxHalf = tb.roadWidth * 0.5f;
        for (const TrackBin::Sample& r : tb.rings) {
            maxHalf = std::max(maxHalf, r.width * 0.5f);
        }
        // +0.7: kerb reach plus margin, so the widest mark a wheel can lay
        // still sits rows away from the CLAMP edge rows the shader relies on
        // staying empty (see bindSkidLayer).
        mSkidLatHalf = maxHalf + 0.7f;
        // 80 texels/u along s would match lat's 512 rows (~80/u), but no
        // shipped lap is short enough to get it: the cap (mMaxTextureDim, 8192
        // on every platform) binds on all of them and leaves s at ~18-25
        // texels/u, so the grid is ~4x ANISOTROPIC. Where it clamps, the
        // angle-aware feather in the render block widens instead, so a long
        // lap gets SOFTER diagonals, never blockier ones — which is why the
        // clamp is a quality trade and not a defect.
        const uint32_t W = (uint32_t) std::min((float) mMaxTextureDim,
                std::max(512.0f, std::round(tb.length * 80.0f)));
        const uint32_t H = 512;
        mSkidTexelS = tb.length / (float) W;
        mSkidTexelLat = (2.0f * mSkidLatHalf) / (float) H;
        // UPLOAD-ONLY — no COLOR_ATTACHMENT, no RenderTarget, ever. The
        // GPU-stamped shape was tried in every RT arrangement on the A10X
        // and each tripped a different below-the-API device behaviour; the
        // full account is at mSkidPix in TtpRenderer.h. The CPU raster in
        // renderSkids is the only writer, through setImage.
        // Every slot of the ring, or none: a layer missing a slot would draw
        // stale ink every other frame.
        for (uint32_t k = 0; k < mSkidRingN; k++) {
            mSkidRing.push_back(Texture::Builder()
                    .width(W).height(H).levels(0xff) // full chain — see the mip
                                                     // refresh in the stamp block
                    .format(Texture::InternalFormat::R8)
                    .usage(Texture::Usage::SAMPLEABLE | Texture::Usage::UPLOADABLE
                            | Texture::Usage::GEN_MIPMAPPABLE)
                    .build(*mEngine));
        }
        if (std::find(mSkidRing.begin(), mSkidRing.end(), nullptr) != mSkidRing.end()) {
            for (Texture* t : mSkidRing) if (t) mEngine->destroy(t);
            mSkidRing.clear();
        }
        mSkidOwed.assign(mSkidRing.size(), {});
        mSkidRingAt = 0;
        mSkidRingAdvance = false;
        mSkidTex = mSkidRing.empty() ? nullptr : mSkidRing[0];
        if (mSkidTex) {
            mSkidTexW = W;
            mSkidTexH = H;
            mSkidPix.assign((size_t) W * H, 0);
            // The chain's CPU truth, one buffer per level below 0 — about a
            // third of level 0 again. refreshSkidMips keeps them in step
            // under the dirty rects.
            mSkidMips.clear();
            for (uint32_t w = W, h = H; w > 1 || h > 1;) {
                w = std::max(1u, w >> 1);
                h = std::max(1u, h >> 1);
                mSkidMips.emplace_back((size_t) w * h, (uint8_t) 0);
            }
            // Zero the texture NOW, not via mSkidWipe on the first frame: a
            // fresh texture holds garbage, and the frame loop's skid block
            // only runs when the scene has wheel trails — the LOBBY preview
            // has none, so a deferred wipe left its road speckled with
            // uninitialized memory. clearSkidLayer also generates the mip
            // chain off the zeroed level 0 (the GL backend clamps sampling
            // to level 0 until the first generateMipmaps; Metal has no such
            // clamp, so an un-generated chain is garbage under the
            // mipped tap).
            clearSkidLayer();
        } else {
            mSkidLatHalf = 0;
        }
        // The road instances bound the null texture while the road was built;
        // now the real one exists, rebind them all.
        if (mRoadInst) bindSkidLayer(mRoadInst);
        for (RoadChunk& rc : mRoadChunks) {
            if (rc.mi) bindSkidLayer(rc.mi);
        }
    }

    // Ambient particles (theme.ambient): the first `count` of buildAmbient's
    // 74747 stream as tiny tinted sprites. The mesh is SEEDS ONLY — vpoint.mat
    // applies the kind's motion preset (flake / mote / sand / pollen) and wraps
    // x/z around each view's camera, so the count is "particles in the air
    // around a camera", not over the map, and nothing here is touched again
    // after this build (see the material's header).
    if (mPointMaterial && tb.ambKind != 0 && tb.ambCount > 0) {
        const int AMB_COUNT = (int) std::min(tb.ambCount, 9600u);
        constexpr float AMB_H = 34.0f;
        // Half the JS Points sprite size — the material pushes each corner out
        // by this along the camera axes, and the fragment's inscribed circle
        // spans the full `size` (vpoint.mat).
        mAmbSize = tb.ambSize * 0.5f;
        const float bandH = std::max(2.0f, AMB_H * tb.ambBand);
        mAmbBandH = bandH;
        uint32_t s74 = 74747;
        const auto arnd = [&]() {
            s74 = s74 * 1664525u + 1013904223u;
            return (double) s74 / 4294967296.0;
        };
        // Flake floor: terrain sampled at the grid corners, then the road
        // ribbon's own CPU verts rasterized in as a cell max — each vert bumps
        // its four surrounding corners, so the bilinear tap never
        // underestimates under the deck. Uploaded as an R16F texture for the
        // shader's fade; the other kinds get a floor far below everything.
        int floorN = 1;
        std::vector<math::half> floorTexels{ math::half(-1000.0f) };
        if (tb.ambKind == ttp::rt::AMB_FLAKE) {
            constexpr int N = kAmbFloorN;
            const float cell = 2 * kAmbR / (N - 1);
            std::vector<float> floorY((size_t) N * N);
            for (int gz = 0; gz < N; gz++) {
                for (int gx = 0; gx < N; gx++) {
                    floorY[(size_t) gz * N + gx] =
                            groundSurfaceY(tb, -kAmbR + gx * cell, -kAmbR + gz * cell);
                }
            }
            for (const Vertex& rv : mRoad.verts) {
                const int gx = (int) std::floor((rv.px + kAmbR) / cell);
                const int gz = (int) std::floor((rv.pz + kAmbR) / cell);
                for (int dz = 0; dz <= 1; dz++) {
                    for (int dx = 0; dx <= 1; dx++) {
                        const int cx = gx + dx, cz = gz + dz;
                        if (cx < 0 || cx >= N || cz < 0 || cz >= N) continue;
                        float& h = floorY[(size_t) cz * N + cx];
                        h = std::max(h, rv.py);
                    }
                }
            }
            floorN = N;
            floorTexels.assign(floorY.begin(), floorY.end());
        }
        mAmbFloorTex = Texture::Builder()
                .width((uint32_t) floorN).height((uint32_t) floorN).levels(1)
                .sampler(Texture::Sampler::SAMPLER_2D)
                .format(Texture::InternalFormat::R16F)
                .build(*mEngine);
        {
            // The upload is asynchronous — heap-owned pixels with a release
            // callback, the same rule as the ground tile above.
            auto* px = new std::vector<math::half>(std::move(floorTexels));
            mAmbFloorTex->setImage(*mEngine, 0, Texture::PixelBufferDescriptor(
                    px->data(), px->size() * sizeof(math::half),
                    Texture::Format::R, Texture::Type::HALF,
                    [](void*, size_t, void* user) {
                        delete (std::vector<math::half>*) user;
                    }, px));
        }
        const uint32_t tint = packShown(srgbToLinear(tb.ambTint), 1.0f, tb.ambOpacity);
        // THREE vertices per particle, all carrying the SAME seed: the corner
        // in uv0 is what vpoint.mat spreads along the camera's right/up, so the
        // sprite faces every cell's camera — and the fragment cuts the unit
        // circle out of the triangle (its corners sit at radius 2), so it comes
        // out as round as the quad it replaced for three quarters of the
        // vertices. The seed hash lands identically on all three, keeping the
        // sprite rigid.
        mPollen.verts.resize(AMB_COUNT * 3);
        mPollen.uvs.resize(AMB_COUNT * 3);
        mPollen.idx.resize(AMB_COUNT * 3);
        static const math::float2 CORNER[3] = { { 0, 2 }, { -1.7320508f, -1 }, { 1.7320508f, -1 } };
        for (int i = 0; i < AMB_COUNT; i++) {
            const Vertex seed = { (float) arnd() * kAmbBox, (float) arnd() * AMB_H,
                                  (float) arnd() * kAmbBox, tint };
            for (int k = 0; k < 3; k++) {
                mPollen.verts[i * 3 + k] = seed;
                mPollen.uvs[i * 3 + k] = CORNER[k];
            }
        }
        // No vertex is shared, so the index buffer is the identity; it exists
        // to satisfy buildMesh.
        std::iota(mPollen.idx.begin(), mPollen.idx.end(), 0u);
        mPollenMat = sceneInstance(mPointMaterial);
        mPollenMat->setParameter("halfSize", mAmbSize); // re-fitted per frame, below
        mPollenMat->setParameter("time", 0.0f);         // advanced per frame
        mPollenMat->setParameter("fall", tb.ambFall);
        mPollenMat->setParameter("wind", tb.ambWind);
        mAmbFall = tb.ambFall;
        mAmbWind = tb.ambWind;
        mPollenMat->setParameter("bob", tb.ambBob);
        mPollenMat->setParameter("bandH", bandH);
        // Shrunk per cell count below — and what an overview frame (viewCount
        // 0) keeps, since renderAmbient's refit only runs for an active view.
        mPollenMat->setParameter("boxXZ", kAmbBox);
        mPollenMat->setParameter("lite", 0.0f);
        mPollenMat->setParameter("floorOrigin", math::float2{ -kAmbR, -kAmbR });
        mPollenMat->setParameter("floorInvSpan", 1.0f / (2 * kAmbR));
        mPollenMat->setParameter("floorTex", mAmbFloorTex,
                TextureSampler(TextureSampler::MinFilter::LINEAR,
                        TextureSampler::MagFilter::LINEAR));
        // The life's knobs (vpoint.mat), every one off: the weather's path.
        for (const char* k : { "mask", "tile", "flutter" }) {
            mPollenMat->setParameter(k, 0.0f);
        }
        if (!buildMesh(mPollen, true, mPollenMat)) return false;
        // The drawn positions follow the cameras, so no authored-time AABB can
        // bound them: make the box world-sized instead of culling on a lie.
        auto& rcm = mEngine->getRenderableManager();
        rcm.setAxisAlignedBoundingBox(rcm.getInstance(mPollen.entity),
                { { 0, 0, 0 }, { 1e4f, 1e4f, 1e4f } });
    }
    if (mPointMaterial && tb.life.kind != 0 && tb.life.count > 0 && !tb.life.near.empty()) buildLife(tb);

    // Impact bursts, the JS spec (TrackProps): a THIN shockwave ring that
    // sweeps 0.25 → 2.0 world over IMPACT_TIME 0.7 s at CONSTANT width and
    // fades out, plus a cream flash ball (r 0.62) that pops to full in ~0.1 s
    // and then fades over IMPACT_FLASH_TIME 0.5 s. Both ADDITIVE — see
    // vburst.mat for why that and the shader-side ring matter.
    //
    // Per-slot material instances: radius, width and fade are all material
    // parameters, so the meshes themselves never change after this.
    if (mBurstMaterial) {
        for (int bi = 0; bi < 2; bi++) {
            // Ring: every vertex sits at the LOCAL ORIGIN and the shader pushes
            // it out along the camera axes, so the CPU only ever moves the
            // burst centre. uv0 = (angle in turns, side across the width).
            Mesh& ring = mBurstMeshes[bi];
            const uint32_t rc = packShown(srgbToLinear(0xffe6b0), 1.0f, 1.0f);
            const int SEG = 36;
            for (int j = 0; j <= SEG; j++) {
                const float u = (float) j / SEG;
                ring.verts.push_back({ 0, 0, 0, rc });
                ring.uvs.push_back({ u, -1.0f });
                ring.verts.push_back({ 0, 0, 0, rc });
                ring.uvs.push_back({ u, 1.0f });
            }
            for (int j = 0; j < SEG; j++) {
                const uint32_t b = j * 2;
                ring.idx.insert(ring.idx.end(), { b, b + 1, b + 2, b + 1, b + 3, b + 2 });
            }
            mBurstRingMats[bi] = sceneInstance(mBurstMaterial);
            if (!buildMesh(ring, false, mBurstRingMats[bi])) return false;
            // The ring's own vertices are a POINT, so its bounds are one too —
            // a frustum test on them would drop the halo the moment the
            // detonation point left the screen while the wave still crossed it.
            setMeshCulling(ring, false);
            // Ball: ring = (0, 0) leaves the shader displacement at zero, so
            // the sphere's own geometry and its transform scale are the shape.
            Mesh& ball = mBurstBalls[bi];
            appendSphere(ball, 10, 7, [](const float3& p) { return p; },
                    [&](const float3&) { return packShown(srgbToLinear(0xffe0a8), 1.0f, 1.0f); });
            ball.uvs.assign(ball.verts.size(), math::float2{ 0, 0 });
            mBurstBallMats[bi] = sceneInstance(mBurstMaterial);
            mBurstBallMats[bi]->setParameter("ring", math::float2{ 0, 0 });
            if (!buildMesh(ball, false, mBurstBallMats[bi])) return false;
        }
    }

    // Baked lawn shadows: one merged mesh of soft ink discs at the collected
    // caster spots, displaced along the key-light slant like a real bake.
    if (mBlendMaterial && !mShadowSpots.empty()) {
        const uint32_t core = packShown(srgbToLinear(0x2a2735), 1.0f, 0.30f);
        const uint32_t rim = packShown(srgbToLinear(0x2a2735), 1.0f, 0.0f);
        for (const math::float4& s : mShadowSpots) {
            // spot = { worldX, worldZ, radius, casterHeight }.
            if (s.w <= 0) continue;   // a footprint only: nothing to cast
            // key from (2,12,1.5): shadow shifts opposite, scaled by height.
            const float ox = -2.0f / 12.0f * s.w, oz = -1.5f / 12.0f * s.w;
            const float cx = s.x + ox, cz = s.y + oz;
            const float r = s.z;
            // Conformed per vertex onto the ground MESH's own surface
            // (groundSurfaceY), with a mid ring: a plain fan interpolates
            // straight across grid creases, and over a valley crease the chord
            // dips under the drawn ground. Half the span, a quarter the sag.
            constexpr float LIFT = 0.03f;
            // LITE: an octagon. The rim fades to nothing, so its corners do
            // not read; the discs were several percent of the 4P frame.
            const int SEG = mLite ? 8 : 14;
            const uint32_t mid = packShown(srgbToLinear(0x2a2735), 1.0f, 0.15f);
            const uint32_t base = (uint32_t) mGroundShadows.verts.size();
            mGroundShadows.verts.push_back(
                    { cx, groundSurfaceY(tb, cx, cz) + LIFT, cz, core });
            for (const float ring : { 0.5f, 1.0f }) {
                for (int j = 0; j <= SEG; j++) {
                    const float a = (float) j / SEG * 2.0f * (float) M_PI;
                    const float vx = cx + std::cos(a) * r * ring;
                    const float vz = cz + std::sin(a) * r * ring;
                    mGroundShadows.verts.push_back({ vx,
                            groundSurfaceY(tb, vx, vz) + LIFT, vz,
                            ring < 1.0f ? mid : rim });
                }
            }
            const uint32_t r0 = base + 1, r1 = base + 1 + (SEG + 1);
            for (int j = 0; j < SEG; j++) {
                mGroundShadows.idx.insert(mGroundShadows.idx.end(),
                        { base, r0 + (uint32_t) j, r0 + (uint32_t) j + 1 });
                mGroundShadows.idx.insert(mGroundShadows.idx.end(),
                        { r0 + (uint32_t) j, r1 + (uint32_t) j, r1 + (uint32_t) j + 1,
                          r0 + (uint32_t) j, r1 + (uint32_t) j + 1, r0 + (uint32_t) j + 1 });
            }
        }
        // Cut per tile like the ground. Overlapping discs across a tile seam
        // may now blend in either order, which is the same picture: they are
        // one colour, and `over` with one colour commutes.
        tileMajor(mGroundShadows, mSheetTile, mSheetMinTris);
        buildMesh(mGroundShadows, true, mBlendMaterial->getDefaultInstance());
    }

    // Rocket pool — TrackProps _buildRocketProto's toy rocket, 4 clones parked
    // until the snapshot carries in-flight rockets: red body cylinder, long
    // cream nose cone, 3 dark radial fins (built nose-up +Y, ×1.12), plus a
    // separate blend-material tail flame per rocket (additive isn't available
    // in vblend — a bright warm orange at 0.7 alpha reads the same at speed).
    {
        const auto rocketPart = [&](Mesh& m, const Prim& prim, float lx, float ly,
                float lz, uint32_t hex, float shade = 1.0f) {
            const uint32_t c = packShown(srgbToLinear(hex), shade);
            const uint32_t base = (uint32_t) m.verts.size();
            for (const float3& v : prim.v) {
                m.verts.push_back({ (v.x + lx) * 1.12f, (v.y + ly) * 1.12f,
                                    (v.z + lz) * 1.12f, c });
            }
            for (const uint32_t i : prim.i) m.idx.push_back(base + i);
        };
        mRockets.resize(4);
        mRocketFlames.resize(4);
        auto& tcm2 = mEngine->getTransformManager();
        for (size_t r = 0; r < mRockets.size(); r++) {
            Mesh& m = mRockets[r];
            buildRocketModel([&](const Prim& p, float lx, float ly, float lz,
                    uint32_t hex, float shade) { rocketPart(m, p, lx, ly, lz, hex, shade); },
                    mModelVariant[MODEL_ROCKET]);
            if (!buildMesh(m)) break;
            tcm2.setTransform(tcm2.getInstance(m.entity),
                    mat4f::translation(float3{ 0, -1000, 0 }));
            if (mBlendMaterial) {
                // ONE cone, one colour. It was a 0.09-long orange smudge no
                // wider than the boat-tail it hung off, which made the one part
                // of the model that says "under power" the part nobody could
                // see; a halo-and-core pair fixed that and was more flame than
                // the object needed. What actually did the work was the SIZE,
                // so keep the size and drop the second cone and the second hue.
                // Still STEADY, not pulsing (see the note above): the jitter the
                // JS had was noise at this scale.
                Mesh& fm = mRocketFlames[r];
                // SMALL, and set back past the boat-tail. It reached forward to
                // the body at full width and the wings are the same gold, so the
                // two ran together into one yellow mass at the back of the
                // rocket. Two things separate them now: the mouth starts BEHIND
                // the boat-tail, so a ring of deep red sits between the wing
                // roots and the fire, and it is narrower than the tail it comes
                // out of rather than as wide as the body.
                //
                // The hue is still yellow, one shade brighter than the wings'
                // gold — they now differ by VALUE where before they differed by
                // nothing, which is what stops them merging when the rocket is
                // small and moving.
                constexpr float FR = 0.046f, FH = 0.135f, FY0 = -0.182f;
                const uint32_t fc = packShown(srgbToLinear(0xffe86b), 1.0f, 0.90f);
                const Prim flame = applyPre(primCone(FR, FH, 14),
                        mat4f::rotation((float) M_PI, float3{ 1, 0, 0 }));
                for (const float3& v : flame.v) {
                    fm.verts.push_back({ v.x * 1.12f, (v.y + FY0 - FH / 2) * 1.12f,
                                         v.z * 1.12f, fc });
                }
                for (const uint32_t i : flame.i) fm.idx.push_back(i);
                if (!buildMesh(fm, true, mBlendMaterial->getDefaultInstance())) break;
                tcm2.setTransform(tcm2.getInstance(fm.entity),
                        mat4f::translation(float3{ 0, -1000, 0 }));
            }
        }
    }

    // Hot-air balloon (environment.js buildBalloon/applyBalloon) — the grass
    // theme's mid-field hero: an 8-gore envelope (panel colours alternating
    // per FACE by centroid longitude), a warm-brown rigging frustum and a
    // hanging basket, drifting a very slow lap of the horizon. Unit-sized
    // here; the per-frame pose scales and orbits it (with the cloud trick's
    // push-out past the fog cutoff — the JS material is fog:false).
    if (tb.balloonPanels.size() >= 2) {
        Mesh& m = mBalloon;
        const float3 PANELS[2] = { srgbToLinear(tb.balloonPanels[0]),
                                   srgbToLinear(tb.balloonPanels[1]) };
        mBalloonY = tb.balloonY;
        mBalloonSize = tb.balloonSize;
        const int WS = 16, HS = 12, GORES = 8;
        const auto spherePt = [&](int ix, int iy) {
            const float u = (float) ix / WS, v = (float) iy / HS;
            const float phi = v * (float) M_PI, theta = u * 2.0f * (float) M_PI;
            return float3{ -std::cos(theta) * std::sin(phi), std::cos(phi),
                           std::sin(theta) * std::sin(phi) };
        };
        // SHARED CORNERS, on exact bits. Every triangle meeting at a grid
        // point gets the same position and normal bit for bit (one spherePt
        // call per corner, normalize() of that same point), and the colour
        // changes only across a gore seam, so a key on all three makes them
        // one vertex: the same triangles with the same attributes at every
        // corner, from a third of the vertices in every cell's draw. The same
        // pixels too, but by the opaque-range order contract rather than by
        // construction: shared corners let buildMesh's vertex-reuse reorder
        // permute the triangles, and vlit culls nothing, so a pixel where a
        // back face meets a front one at one depth goes to whichever draws
        // first. buildMesh's own weld (weldExact) is for a mesh that carries
        // nothing a normal could split, and this one is lit, so the key is
        // built here. The poles' signed zeros and the float seam at theta 2π
        // stay apart, which is the exact rule and not a flaw in it.
        std::map<std::array<uint32_t, 7>, uint32_t> corners;
        const auto corner = [&](const float3& p, const float3& n, uint32_t col) {
            static_assert(sizeof(float3) == 3 * sizeof(uint32_t), "float3 is three words");
            std::array<uint32_t, 7> key;
            std::memcpy(&key[0], &p, sizeof(float3));
            std::memcpy(&key[3], &n, sizeof(float3));
            key[6] = col;
            const auto [it, fresh] = corners.try_emplace(key, (uint32_t) m.verts.size());
            if (fresh) {
                m.verts.push_back({ p.x, p.y, p.z, col });
                m.normals.push_back(n);
            }
            m.idx.push_back(it->second);
        };
        const auto pushTri = [&](const float3& a, const float3& b, const float3& c) {
            // face gore by centroid longitude → crisp seams (per-face paint)
            const float cx3 = (a.x + b.x + c.x) / 3, cz3 = (a.z + b.z + c.z) / 3;
            const int gore = ((int) std::floor(
                    (std::atan2(cz3, cx3) + (float) M_PI) / (2.0f * (float) M_PI) * GORES))
                    % GORES;
            const uint32_t col = packAlbedo(PANELS[gore % 2], 1.0f);
            for (const float3& p : { a, b, c }) {
                corner(float3{ p.x, p.y * 1.08f, p.z }, normalize(p), col);
            }
        };
        for (int iy = 0; iy < HS; iy++) {
            for (int ix = 0; ix < WS; ix++) {
                const float3 a = spherePt(ix, iy), b = spherePt(ix, iy + 1);
                const float3 c = spherePt(ix + 1, iy), d = spherePt(ix + 1, iy + 1);
                pushTri(a, b, c);
                pushTri(c, b, d);
            }
        }
        // rigging frustum (open cylinder 0.55 → 0.2, h 0.55 @ y −1.18) + basket
        const auto pushQuad = [&](const float3& a, const float3& b, const float3& c,
                const float3& d, const float3& n, uint32_t col) {
            for (const float3& p : { a, b, c, c, b, d }) corner(p, n, col);
        };
        const uint32_t RIG = packAlbedo(srgbToLinear(0x6f5a40), 1.0f);
        for (int s = 0; s < 8; s++) {
            const float a1 = (float) s / 8 * 2.0f * (float) M_PI;
            const float a2 = (float) (s + 1) / 8 * 2.0f * (float) M_PI;
            const float3 t1 = { std::cos(a1) * 0.55f, -0.905f, std::sin(a1) * 0.55f };
            const float3 t2 = { std::cos(a2) * 0.55f, -0.905f, std::sin(a2) * 0.55f };
            const float3 b1 = { std::cos(a1) * 0.2f, -1.455f, std::sin(a1) * 0.2f };
            const float3 b2 = { std::cos(a2) * 0.2f, -1.455f, std::sin(a2) * 0.2f };
            const float3 n = normalize(float3{ std::cos((a1 + a2) / 2), 0.3f,
                                               std::sin((a1 + a2) / 2) });
            pushQuad(t1, b1, t2, b2, n, RIG);
        }
        const uint32_t BSK = packAlbedo(srgbToLinear(0x8a6f4d), 1.0f);
        const float bx = 0.21f, by0 = -1.76f, by1 = -1.44f;
        const float3 c000{ -bx, by0, -bx }, c100{ bx, by0, -bx },
                     c010{ -bx, by1, -bx }, c110{ bx, by1, -bx },
                     c001{ -bx, by0, bx },  c101{ bx, by0, bx },
                     c011{ -bx, by1, bx },  c111{ bx, by1, bx };
        pushQuad(c010, c000, c110, c100, { 0, 0, -1 }, BSK);
        pushQuad(c111, c101, c011, c001, { 0, 0, 1 }, BSK);
        pushQuad(c011, c001, c010, c000, { -1, 0, 0 }, BSK);
        pushQuad(c110, c100, c111, c101, { 1, 0, 0 }, BSK);
        pushQuad(c000, c001, c100, c101, { 0, -1, 0 }, BSK);
        pushQuad(c010, c011, c110, c111, { 0, 1, 0 }, BSK);
        // The sky's: no alpha tells vlit.mat to leave it unfogged.
        for (Vertex& v : m.verts) v.abgr &= 0x00ffffffu;
        if (!buildMesh(m)) return false;
        // How far the unit mesh reaches from its origin, so the per-cell pose
        // can keep the whole balloon inside the far plane (orientCellBillboards).
        mBalloonExt = 0;
        for (const Vertex& v : m.verts) {
            mBalloonExt = std::max(mBalloonExt, length(float3{ v.px, v.py, v.pz }));
        }
        auto& tcmB = mEngine->getTransformManager();
        tcmB.setTransform(tcmB.getInstance(m.entity),
                mat4f::translation(float3{ 0, -1000, 0 }));
    }

    // Boost aura colour: boostShades.disk (accent +15%). The disc itself is a
    // road-shader stamp sized per frame in render().
    mBoostDiskLin = srgbToLinear(ttp::rt::boost_shades(tb.boostCol).disk);

    phases.mark("world+ground");
    buildGantry(tb);
    // Sun shadows: who casts, who catches. AFTER the gantry — it's a caster.
    //
    // This used to be a CPU bake that ray-traced the sun per road vertex and
    // multiplied the result into the vertex colours. It could never be right:
    // the road's rings sit ~0.24 u apart, so a Gouraud-stretched occlusion term
    // cannot resolve an edge that a 2048² map resolves at ~0.05 u. So
    // bakeShadowMap renders a REAL shadow map once and decodes it into the
    // receivers' visibility maps.
    //
    // Caster/receiver sets: the fixed track geometry casts, the road, the
    // ground, the structures and the berms catch, and NOTHING else does — cars,
    // props and scenery carry their own ground blobs (setShadows(false) on
    // every glTF asset, since gltfio opts renderables IN by default).
    // The WHOLE road casts, not just the elevated chunks.
    //
    // It is not really about what the road throws on the floor — a deck lying
    // flat on the ground throws almost nothing. It is about what the map HOLDS
    // where the road is. Outside every caster the depth map still reads its
    // clear value, the far plane, and the receiver's soft-min then compares
    // itself against the far plane instead of against its own surface. That
    // pushes the lit/shadow crossing to ~94% occluder share — back into the
    // blur kernel's tail, the same place k = 80 used to put it — so the
    // penumbra collapses no matter how wide the kernel is. It was measured:
    // with a ground-level deck receiving, 4x the blur sigma bought only 1.8x
    // the edge width instead of 4x.
    //
    // Free in every sense that matters: bakeShadowMap fits its ortho box to
    // mRoad's own vertices, not to the caster set, so texel density is
    // untouched, and the road is one already-chunked mesh in a depth-only pass.
    setMeshShadows(mRoad, true, true);
    // ...and the floor, for exactly the same reason. Two triangles in a
    // depth-only pass, and without them every ground receiver compares itself
    // against the far plane and gets the collapsed penumbra described above.
    // The heightfield receives but must not cast (its flat PROXY casts in its
    // place — see the ground build); the flat-quad biomes keep the original
    // two-triangle self.
    setMeshShadows(mGround, mTerrainAmp <= 0, true);
    setMeshShadows(mGroundProxy, true, false);
    setMeshShadows(mGantry, true, true);
    setMeshShadows(mStructures, true, true);
    setMeshShadows(mBerms, true, true);

    // The sun's map, rendered once now that every caster exists, and decoded
    // into the receivers' visibility maps.
    phases.mark("gantry");
    bakeShadowMap(tb, key);
    phases.mark("shadowBake");
    // Every receiver takes its baked visibility map — resident from this bake,
    // a reused one or an imported blob alike, which is why the binds sit here
    // and not inside the bake: the deck its track-space map (vroadvis.mat), the
    // ground and the structures their light-space ones (vvis.mat).
    bindRoadVisMap(mRoadInst);
    for (const RoadChunk& ch : mRoadChunks) bindRoadVisMap(ch.mi);
    bindVisMap(mGroundInst, mVisMap);
    bindVisMap(mStaticInst, mStructVisMap);

    // Clouds (environment.js): 8 puffs, deterministic index math. The JS
    // sprites are fog:false and drift ACROSS the field in authored space;
    // here each cloud stores its AUTHORED position and the render loop pushes
    // it out to the 405 unfogged band ALONG ITS CURRENT DIRECTION per frame
    // (a build-time push broke as soon as a cloud drifted over the middle —
    // the pre-scaled puff hung huge and fogged right over the track).
    if (mCloudMaterial) {
        // The puff's SHAPE is vcloud.mat's, evaluated per fragment from uv0 —
        // so a sprite is one small polygon and the silhouette stays smooth
        // however large the push-out draws it. Everything below is just where
        // and how big.
        //
        // THE POLYGON IS THE PUFF'S SUPPORT HULL, NOT A RECTANGLE. vcloud.mat's
        // alpha is exactly zero outside its discs grown by SOFT (the smoothstep
        // saturates there), so a rectangle's corners spend fragments that blend
        // nothing: the octagon of the discs' support lines keeps every non-zero
        // texel. The alpha field is the rectangle's; the rasterizer's
        // interpolation over the new triangulation is what moves, by a few
        // levels on a near puff's soft edge (the frame map, 2026-10-29). Fanned
        // from the centroid: fat triangles keep the attribute gradients honest
        // on a puff a few pixels wide. The discs, SOFT and the field size mirror
        // vcloud.mat; tests/shader-cpp-constants.test.js holds the two together.
        const auto puffPoly = [&](Mesh& m, float sw, float sh, uint32_t colour) {
            struct Disc { float cx, cy, r; };   // in the 128x64 field vcloud.mat samples
            static const Disc DISCS[5] = {
                { 36, 36, 14 }, { 58, 30, 17 }, { 84, 36, 14 }, { 68, 42, 11 }, { 46, 42, 10 } };
            constexpr float SOFT = 8.5f;
            constexpr int N = 8;                // support directions = hull corners
            float dx[N], dy[N], sup[N];
            for (int k = 0; k < N; k++) {
                dx[k] = std::cos((float) k * 2.0f * (float) M_PI / N);
                dy[k] = std::sin((float) k * 2.0f * (float) M_PI / N);
                sup[k] = -1e9f;
                for (const Disc& d : DISCS) {
                    sup[k] = std::max(sup[k], d.cx * dx[k] + d.cy * dy[k] + d.r + SOFT);
                }
            }
            // Each corner is where two neighbouring support lines meet; the
            // centroid is vertex N.
            float cu = 0, cv = 0;
            for (int k = 0; k < N; k++) {
                const int n = (k + 1) % N;
                const float det = dx[k] * dy[n] - dx[n] * dy[k];
                const float px = (sup[k] * dy[n] - sup[n] * dy[k]) / det;
                const float py = (dx[k] * sup[n] - dx[n] * sup[k]) / det;
                const float u = px / 128.0f, v = py / 64.0f;   // v runs DOWN the field
                m.verts.push_back({ (u - 0.5f) * sw, (0.5f - v) * sh, 0, colour });
                m.uvs.push_back({ u, v });
                cu += u; cv += v;
            }
            cu /= N; cv /= N;
            m.verts.push_back({ (cu - 0.5f) * sw, (0.5f - cv) * sh, 0, colour });
            m.uvs.push_back({ cu, cv });
            for (uint32_t k = 0; k < N; k++) {
                m.idx.push_back(N); m.idx.push_back(k); m.idx.push_back((k + 1) % N);
            }
        };
        // theme.clouds dresses the same 8 sprites: `count` hides the tail,
        // scale/aspect restretch the authored width, opacity + tint repaint.
        const int nClouds = (int) std::min<uint32_t>(8, tb.cloudCount);
        mClouds.resize(nClouds);
        mCloudPos.resize(nClouds);
        const float3 cloudTint = srgbToLinear(tb.cloudTint);
        for (int i = 0; i < nClouds; i++) {
            const float a = (float) i / 8 * 2.0f * (float) M_PI + (i % 3) * 0.45f;
            const float r = 180 + (i % 4) * 38;
            const float w = 50 + (i % 3) * 20;
            mCloudPos[i] = { std::cos(a) * r, 42.0f + (i % 3) * 16,
                             std::sin(a) * r };
            // Sprite hull, billboarded per view in render(). Geometry at
            // AUTHORED size — the per-frame push-out scales the transform
            // (softened, k^0.55: cameras sit far from the origin, so full-k
            // clouds loom oversized). DEF_CLOUDS aspect is 0.42.
            const float sw = w * tb.cloudScale;
            puffPoly(mClouds[i], sw, sw * tb.cloudAspect,
                    packShown(cloudTint, 1.0f, tb.cloudOpacity));
            if (!buildMesh(mClouds[i], true, mCloudMaterial->getDefaultInstance())) {
                return false;
            }
        }
        // Dust banks (theme.haze): the SAME soft puff, but low (hill height),
        // huge and bank-flat — distance fog gives uniform haze, these give it
        // structure among the mesas. Left at their authored radius rather than
        // pushed out past the fog like the clouds: they belong IN the dusty
        // air, and the haze tint is the fog colour anyway.
        const int nHaze = (int) std::min(5u, tb.hazeCount);
        mHaze.resize(nHaze);
        mHazePos.resize(nHaze);
        const float3 hazeTint = srgbToLinear(tb.hazeTint);
        for (int i = 0; i < nHaze; i++) {
            const float a = (float) i / 5 * 2.0f * (float) M_PI + (i % 2) * 0.7f;
            const float r = 132 + (i % 3) * 34;
            mHazePos[i] = { std::cos(a) * r, 9.0f + (i % 3) * 7, std::sin(a) * r };
            const float sw = (95.0f + (i % 3) * 28) * tb.hazeScale;
            puffPoly(mHaze[i], sw, sw * 0.14f, // HAZE_ASPECT — banks, not puffs
                    packShown(hazeTint, 1.0f, tb.hazeOpacity));
            // Priority 5 draws a bank AFTER the clouds (default 4). Both write
            // no depth, so the blend pass's order is the whole of what decides
            // which composites over which, and a bank is the nearer sheet.
            if (!buildMesh(mHaze[i], true, mCloudMaterial->getDefaultInstance(), 5)) {
                return false;
            }
        }
    }

    // Texture decodes ride the provider's async queue even on the synchronous
    // loadResources path — finished textures only ATTACH on a queue pump (the
    // sync path pumps at the START of the next load, so without this the last
    // assets' textures never bind and those models render black).
    pumpTextures();
    // A build puts every sheet back in the scene, so an ablation arm has to be
    // re-stated or it would quietly end at the next track.
    if (!mDressSheets) applyDressSheets();
    // The dressing regroups once, on the next frame, over everything above —
    // and only here: the field's monster pools are not in it, so a field
    // rebuild must not take the whole dressing apart and regroup it.
    mDressMergeDirty = true;
    mTrack = std::make_unique<TrackBin>(std::move(tb));
    phases.mark("epilogue");
    phases.print("ttp build phases:");
    return true;
}

bool TtpRenderer::buildField(const std::vector<TtpRosterCar>& roster) {
    if (!mTrack) return false;
    PhaseLog phases{ mEngine };
    applyRoster(*mTrack, roster);
    const uint32_t carCount = (uint32_t) mTrack->carColors.size();
    // Cars: the real GLB when the shell provided the slot's model (gltfio +
    // ubershaders, textures via stb), else a roster-coloured box marker.
    mCars.resize(carCount);
    mCarAssets.assign(carCount, nullptr);
    mCarGhostAssets.assign(carCount, nullptr);
    mCarGhostIn.assign(carCount, 1); // loadCarAsset adds them; frame 1 removes them
    mMonsterViews.assign(carCount, {});
    // The field's biggest phase: gltfio parsing and uploading the car GLBs
    // the body pool did not keep (mBodyPool).
    for (uint32_t c = 0; c < carCount; c++) {
        if (!buildCarSlot(c)) return false;
    }
    phases.mark("cars");
    // THE POOLS SIZED BY THE COUNT — the monster rig and its ghost, the boost
    // streaks — are built for a new count only (releaseMonsterPools,
    // releaseStreakPool), and the streaks for a new scene too. A field of the
    // size they were built for takes them back as releaseField left them: out
    // of the scene, as a fresh build's first frame would.
    if (mMonsterPoolCars != (int) carCount) {
        releaseMonsterPools();
        // Monster chassis pool (one per car): the kit monster truck with its cab
        // node collapsed — the transformed player's own car body seats the slot
        // per frame (MonsterRig's graft; gunmetal recolour is later polish).
        mMonsterAsset = loadInstancedProp(kMonsterGlb, carCount, mMonsterInstances);
        mMonsterGhostAsset = loadInstancedProp(kMonsterGhostGlb, carCount, mMonsterGhostInstances);
        // Both pools land IN the scene (loadInstancedProp adds them), so seed the
        // membership state to "in" — the first frame takes them straight back out.
        mMonsterIn.assign(carCount, 1);
        mMonsterGhostIn.assign(carCount, 1);
        // MonsterRig keeps only the kit's frame: the `cab` goes (the player's body
        // takes its place) AND so does `chassis-trim` — the round shock pods over
        // the wheels plus the rear spoiler bar. Leaving the trim in made the native
        // truck read a size bulkier than the JS one.
        const auto collapseNodes = [&](gltfio::FilamentAsset* asset) {
            if (!asset) return;
            auto& tcmC = mEngine->getTransformManager();
            std::vector<utils::Entity> hits(carCount * 4);
            for (const char* nm : { "cab", "chassis-trim" }) {
                const size_t n = asset->getEntitiesByName(nm, hits.data(), hits.size());
                for (size_t i = 0; i < n; i++) {
                    tcmC.setTransform(tcmC.getInstance(hits[i]), mat4f::scaling(float3{ 0.001f }));
                }
            }
        };
        collapseNodes(mMonsterAsset);
        collapseNodes(mMonsterGhostAsset);
        if (mMonsterGhostAsset) {
            auto& tcmG = mEngine->getTransformManager();
            for (auto* inst : mMonsterGhostInstances) {
                if (!inst) continue;
                tcmG.setTransform(tcmG.getInstance(inst->getRoot()),
                        mat4f::translation(float3{ 0, -1000, 0 }));
            }
            // The ghost GLB already carries alpha 0.5 on its material (ghostGlb
            // patches the JSON), so it only needs the same chassis-only recolour —
            // its tyres keep their colour at half opacity, like the JS clone does.
            recolourMonsterChassis(mMonsterGhostAsset, mMonsterGhostInstances,
                    math::float4{ srgbToLinear(0x565b63), 0.5f });
        }
        if (mMonsterAsset) {
            const filament::Aabb mb = mMonsterAsset->getBoundingBox();
            mMonsterHalfLen = (mb.max.z - mb.min.z) * 0.5f;
            // The rig's wheels, per instance — these are what turn while the
            // monster is up (the car's own are scaled to nothing). Rest
            // translations are kept so the roll spins each tyre IN PLACE, and the
            // roll axis sign is measured off a rear wheel exactly as the car's is.
            auto& tcmW = mEngine->getTransformManager();
            auto& rcmW = mEngine->getRenderableManager();
            mMonsterWheels.assign(mMonsterInstances.size(), {});
            for (size_t i = 0; i < mMonsterInstances.size(); i++) {
                gltfio::FilamentInstance* inst = mMonsterInstances[i];
                if (!inst) continue;
                MonsterWheels& mw = mMonsterWheels[i];
                const utils::Entity* ents = inst->getEntities();
                for (size_t k = 0; k < inst->getEntityCount(); k++) {
                    const char* nm = mMonsterAsset->getName(ents[k]);
                    if (!nm) continue;
                    utils::Entity* slot = nullptr;
                    float3* rest = nullptr;
                    if (!std::strcmp(nm, "wheel-fl")) { slot = &mw.fl; rest = &mw.flT; }
                    else if (!std::strcmp(nm, "wheel-fr")) { slot = &mw.fr; rest = &mw.frT; }
                    else if (!std::strcmp(nm, "wheel-bl")) { slot = &mw.bl; rest = &mw.blT; }
                    else if (!std::strcmp(nm, "wheel-br")) { slot = &mw.br; rest = &mw.brT; }
                    if (!slot) continue;
                    *slot = ents[k];
                    *rest = tcmW.getTransform(tcmW.getInstance(ents[k]))[3].xyz;
                }
                if (!mw.bl.isNull()) {
                    const mat4f local = tcmW.getTransform(tcmW.getInstance(mw.bl));
                    const float3 axis = (mat4f::rotation((float) M_PI, float3{ 0, 1, 0 }) * local)[0].xyz;
                    mw.rollSign = axis.x >= 0 ? 1.0f : -1.0f;
                }
                // Fat monster tyre, measured once off a rear wheel — the same box
                // answers both questions. RADIUS: roll rate is travel/radius, so the
                // big wheels have to turn SLOWER than the car's for the same ground
                // speed. CONTACT WIDTH: measured exactly as the car's is
                // (loadCarAsset), so the rubber it lays down is as fat as it is.
                if (mMonsterWheelRadius <= 0 && !mw.bl.isNull()) {
                    const auto ri = rcmW.getInstance(mw.bl);
                    if (ri) {
                        const filament::Box bx = rcmW.getAxisAlignedBoundingBox(ri);
                        const mat4f wm = tcmW.getWorldTransform(tcmW.getInstance(mw.bl));
                        float lo = 1e9f, hi = -1e9f;
                        for (int sx = -1; sx <= 1; sx += 2)
                            for (int sy = -1; sy <= 1; sy += 2)
                                for (int sz = -1; sz <= 1; sz += 2) {
                                    const float3 corner = bx.center + bx.halfExtent
                                            * float3{ (float) sx, (float) sy, (float) sz };
                                    const float y = (wm * float4{ corner, 1 }).y;
                                    lo = std::min(lo, y);
                                    hi = std::max(hi, y);
                                }
                        mMonsterWheelRadius = std::max(0.04f, (hi - lo) * 0.5f);
                        const float wx = bx.halfExtent.x * 2, wz = bx.halfExtent.z * 2;
                        if (wx > 0 && wz > 0) {
                            mMonsterSkidWidth = std::min(0.24f,
                                    std::max(0.06f, std::min(wx, wz)));
                        }
                    }
                }
            }
            // Neutral gunmetal frame (MonsterRig's recolour) — CHASSIS ONLY. The
            // whole truck shares one `colormap` material, so recolouring every
            // instance flattened the TYRES to the same grey too: with no tread or
            // hub shading left on them, the wheels look painted on and their
            // rotation is invisible. The JS clones the material for the chassis
            // mesh alone and drops its map, so do the same here — a per-primitive
            // instance on that renderable, with the atlas neutralised by a white
            // 1×1 so the flat colour is all that's left.
            // MONSTER_CHASSIS_COLOR 0x565b63, through sRGB→linear: baseColorFactor
            // is a LINEAR glTF factor, and the eyeballed 0.42/0.44/0.50 that used to
            // sit here is that colour's *sRGB* triple — four times too bright once
            // the shader stopped ignoring it (it never ran until the loader learned
            // node names).
            const float3 chassis = srgbToLinear(0x565b63);
            recolourMonsterChassis(mMonsterAsset, mMonsterInstances,
                    math::float4{ chassis, 1.0f });
        }
        mMonsterPoolCars = (int) carCount;
    }
    phases.mark("monsters");
    mWheelTrails.assign(carCount * 4, {}); // each wheel's run on the rubber layer
    mStreakSeed.resize(carCount);
    for (uint32_t c = 0; c < carCount; c++) mStreakSeed[c] = 0x5eed + c * 977;
    for (Streak& st : mStreaks) { st.dead = true; st.alpha = 0; } // a kept pool's race state
    const bool newStreaks = mStreakPoolCars != (int) carCount;
    if (newStreaks) releaseStreakPool();
    if (newStreaks && mBlendMaterial) {
        // Boost wind streaks: the JS is a UNIT QUAD (length along Z, width
        // along X, facing +Y) carrying makeStreakTexture — an ellipse
        // (rx 24, ry 3 on a 64×16 canvas) blurred by 3px, so it's soft at both
        // ends AND almost entirely feather across its width. Reproduced as a
        // grid with that blurred coverage baked into the vertex alpha (the old
        // centre-fade fan read as a hard lens); the per-frame envelope scales
        // it. Axial-billboarded per cell, cycled front→back while boosting.
        mStreaks.assign(carCount * 4, {});
        mStreakMeshes.resize(carCount * 4);
        const float3 STREAKC = srgbToLinear(ttp::rt::boost_shades(mTrack->boostCol).streak);
        {
            const BlurKernel blur(3.0f);
            const auto ellipse = [](float x, float y) {
                const float u = (x - 32.0f) / 24.0f, v = (y - 8.0f) / 3.0f;
                return u * u + v * v <= 1.0f;
            };
            constexpr int NU = 20, NV = 6; // along length × across width
            std::vector<uint8_t> alpha((NU + 1) * (NV + 1));
            for (int j = 0; j <= NV; j++) {
                for (int i2 = 0; i2 <= NU; i2++) {
                    const float cx = (float) i2 / NU * 64.0f, cy = (float) j / NV * 16.0f;
                    alpha[j * (NU + 1) + i2] = (uint8_t) std::lround(
                            255.0f * blur.coverage(cx, cy, ellipse));
                }
            }
            for (size_t si = 0; si < mStreakMeshes.size(); si++) {
                Mesh& m = mStreakMeshes[si];
                for (int j = 0; j <= NV; j++) {
                    for (int i2 = 0; i2 <= NU; i2++) {
                        const uint8_t a = alpha[j * (NU + 1) + i2];
                        const float x = (float) j / NV - 0.5f;  // across the width
                        const float z = (float) i2 / NU - 0.5f; // along travel
                        m.verts.push_back({ x, 0, z,
                                packShown(STREAKC, 1.0f, a / 255.0f) });
                        m.local.push_back({ x, z, a });
                    }
                }
                for (int j = 0; j < NV; j++) {
                    for (int i2 = 0; i2 < NU; i2++) {
                        const uint32_t b = (uint32_t) (j * (NU + 1) + i2);
                        const uint32_t n = b + (uint32_t) (NU + 1);
                        m.idx.insert(m.idx.end(), { b, n, b + 1, b + 1, n, n + 1 });
                    }
                }
                if (!buildMesh(m, true, mBlendMaterial->getDefaultInstance())) return false;
                // Vulkan's ring (renderCars has the why). Slot 0 is the vb
                // buildMesh just filled; every other slot gets its own buffer
                // in the SAME layout and the same opening bytes. Position +
                // colour (buffer 0) is the streak's only vertex buffer, so it
                // is all a ring slot carries.
                if (mCellRing > 1) {
                    Streak& st = mStreaks[si];
                    st.ringVbs.assign(1, m.vb);
                    st.ringVerts.assign(mCellRing, m.verts);
                    for (uint32_t k = 1; k < mCellRing; k++) {
                        VertexBuffer* vb = buildVertexBuffer(
                                (uint32_t) m.verts.size(), m.layout);
                        vb->setBufferAt(*mEngine, 0, VertexBuffer::BufferDescriptor(
                                st.ringVerts[k].data(),
                                st.ringVerts[k].size() * sizeof(Vertex), nullptr));
                        st.ringVbs.push_back(vb);
                    }
                }
                auto& tcmS = mEngine->getTransformManager();
                tcmS.setTransform(tcmS.getInstance(m.entity),
                        mat4f::translation(float3{ 0, -1000, 0 }));
            }
        }
    }

    // Ghost body variants (50%-alpha patched GLBs) for the monster occlusion
    // fade — loaded LAST, with a full decode pump after each: interleaving
    // them with the solid cars doubled the in-flight decode queue and dropped
    // a car's colormap (it rendered gray). Parked until a swap needs them.
    for (uint32_t c = 0; c < carCount; c++) buildCarGhost(c);

    pumpTextures(); // the same pump as buildStatic's, for the field's own loads
    mStreakPoolCars = (int) carCount; // keyed only once whole: a failed build retries
    phases.mark("streaks+ghosts");
    phases.print("ttp build phases: field");
    // Every scene build ends here. An ablation mask sent before it tagged
    // nothing it just added (debugFeatureMask tags what exists); re-tag, or a
    // sweep whose mask was set before launch draws every group and reads as
    // "this feature is free".
    if (mFeatureTagged) tagFeatures();
    return true;
}

// The sky, baked once per distinct set of authored colours.
//
// The gradient is DIRECTIONAL — it depends on nothing but the view ray's y, a
// property the dome's own note called out ("its gradient is directional —
// screen-identical") — so a cubemap holds all of it, and a skybox draws it at
// infinity where no far plane can reach it.
//
// PRE-GRADED, like every colour the scene reads (TtpRendererImpl.h) — the
// skybox material is FILAMENT'S and writes what it samples straight out. And
// PRE-DIVIDED by
// iblLuminance, exactly as fogColorGraded is and for the same reason: the
// sampled path ends in `sky.rgb *= frameUniforms.iblLuminance`. Reading
// skybox.mat's `featureLevel: 0` as "that branch is compiled out" is wrong —
// measured, the multiply happens, and the sky came out at 0.73x.
//
// HENCE RGBA16F rather than RGBA8: the divide lifts a graded value above 1.0
// wherever iblLuminance is under it, which a normalised format would clip. 64
// a face is plenty — the skybox samples with MagFilter::LINEAR over a gradient
// with no high-frequency content in it.
bool TtpRenderer::buildScene(const std::string& key, const ttp::RaceTrack& geo,
        const ttp::rt::Theme& theme, const std::vector<TtpRosterCar>& roster,
        const ttp::rt::WearPlan& wear) {
    releaseScene();
    // The materials are RENDERER scope — compiled once from the provided
    // .filamat bytes and reused by every scene after.
    const auto mat = mAssets.find("vcolor.filamat");
    if (mat == mAssets.end()) return false;
    if (!mMaterial) {
        mMaterial = Material::Builder()
                .package(mat->second.data(), mat->second.size())
                .build(*mEngine);
    }
    if (!mMaterial) return false;

    const auto blend = mAssets.find("vblend.filamat");
    if (!mBlendMaterial && blend != mAssets.end()) {
        mBlendMaterial = Material::Builder()
                .package(blend->second.data(), blend->second.size())
                .build(*mEngine);
    }
    const auto vlit = mAssets.find("vlit.filamat");
    if (!mLitMaterial && vlit != mAssets.end()) {
        mLitMaterial = Material::Builder()
                .package(vlit->second.data(), vlit->second.size())
                .build(*mEngine);
    }
    // The road deck's own material: the shared matte light (ttp_shade.inc),
    // baked, plus a uv0 channel carrying track space, so deck decals can be
    // shaded INTO the road instead of laid over it. Optional — without it the
    // road draws its bare vertex colours and gets no stamped decals.
    const auto vroad = mAssets.find("vroad.filamat");
    if (!mRoadMaterial && vroad != mAssets.end()) {
        mRoadMaterial = Material::Builder()
                .package(vroad->second.data(), vroad->second.size())
                .build(*mEngine);
    }
    // The kit's GLBs — cars, props, scenery, landmarks — shaded like the rest of
    // the scene instead of through gltfio's PBR ubershader. Optional in the same
    // way vroad is: without it ensureAssetLoader keeps the ubershader and the
    // models render as they did before (see vglb.mat).
    const auto vglb = mAssets.find("vglb.filamat");
    if (!mGlbMaterial && vglb != mAssets.end()) {
        mGlbMaterial = Material::Builder()
                .package(vglb->second.data(), vglb->second.size())
                .build(*mEngine);
    }
    // ...and the same material with alpha, for the ghost twins (see vglbfade.mat).
    // Optional on its own: without it a BLEND twin falls back to the ubershader,
    // which is what it did before this material existed.
    const auto vglbfade = mAssets.find("vglbfade.filamat");
    if (!mGlbFadeMaterial && vglbfade != mAssets.end()) {
        mGlbFadeMaterial = Material::Builder()
                .package(vglbfade->second.data(), vglbfade->second.size())
                .build(*mEngine);
    }
    // ...and flat-interpolated, for the welded car bodies (see vglbflat.mat).
    // Optional too: without it the bodies keep vglb and their own vertices.
    const auto vglbflat = mAssets.find("vglbflat.filamat");
    if (!mGlbFlatMaterial && vglbflat != mAssets.end()) {
        mGlbFlatMaterial = Material::Builder()
                .package(vglbflat->second.data(), vglbflat->second.size())
                .build(*mEngine);
    }
    const auto vground = mAssets.find("vground.filamat");
    if (!mGroundMaterial && vground != mAssets.end()) {
        mGroundMaterial = Material::Builder()
                .package(vground->second.data(), vground->second.size())
                .build(*mEngine);
    }
    // The static receivers' visibility BAKE material (vvis.mat) — used inside
    // bakeShadowMap, never in a frame. Optional like the rest: without it the
    // bake is skipped and bindVisMap's white fallback leaves them fully lit
    // (the same degradation a missing ESM already means).
    const auto vvis = mAssets.find("vvis.filamat");
    if (!mVisMaterial && vvis != mAssets.end()) {
        mVisMaterial = Material::Builder()
                .package(vvis->second.data(), vvis->second.size())
                .build(*mEngine);
    }
    // The DECK's visibility BAKE material (vroadvis.mat) — the road's half of
    // what vvis does for the ground, used once per track inside bakeShadowMap
    // and never in a frame. Optional like the rest: without it no map is baked
    // and bindRoadVisMap's 0 lat span leaves the deck fully lit.
    const auto vroadvis = mAssets.find("vroadvis.filamat");
    if (!mRoadVisMaterial && vroadvis != mAssets.end()) {
        mRoadVisMaterial = Material::Builder()
                .package(vroadvis->second.data(), vroadvis->second.size())
                .build(*mEngine);
    }
    // The car shadow's pass material (vshadow.mat; TtpRenderer.h, kCarShadowSlots).
    const auto vshadow = mAssets.find("vshadow.filamat");
    if (!mShadowMaterial && vshadow != mAssets.end()) {
        mShadowMaterial = Material::Builder()
                .package(vshadow->second.data(), vshadow->second.size())
                .build(*mEngine);
    }
    const auto vpoint = mAssets.find("vpoint.filamat");
    if (!mPointMaterial && vpoint != mAssets.end()) {
        mPointMaterial = Material::Builder()
                .package(vpoint->second.data(), vpoint->second.size())
                .build(*mEngine);
    }
    const auto vcloud = mAssets.find("vcloud.filamat");
    if (!mCloudMaterial && vcloud != mAssets.end()) {
        mCloudMaterial = Material::Builder()
                .package(vcloud->second.data(), vcloud->second.size())
                .build(*mEngine);
    }
    const auto vburst = mAssets.find("vburst.filamat");
    if (!mBurstMaterial && vburst != mAssets.end()) {
        mBurstMaterial = Material::Builder()
                .package(vburst->second.data(), vburst->second.size())
                .build(*mEngine);
    }
    const auto vesm = mAssets.find("vesm.filamat");
    if (!mEsmMaterial && vesm != mAssets.end()) {
        mEsmMaterial = Material::Builder()
                .package(vesm->second.data(), vesm->second.size())
                .build(*mEngine);
    }
    const auto vpresent = mAssets.find("vpresent.filamat");
    if (!mPresentMaterial && vpresent != mAssets.end()) {
        mPresentMaterial = Material::Builder()
                .package(vpresent->second.data(), vpresent->second.size())
                .build(*mEngine);
    }
    const auto voverlay = mAssets.find("voverlay.filamat");
    if (!mOverlayMaterial && voverlay != mAssets.end()) {
        mOverlayMaterial = Material::Builder()
                .package(voverlay->second.data(), voverlay->second.size())
                .build(*mEngine);
    }
    // EVERY MATERIAL, NOT THREE. vglbfade, vburst and voverlay each carried a
    // prewarm of their own, added one at a time as someone felt its first-use
    // compile as a hitch, on the theory that "every other material draws on the
    // first frame after build, which compiles its programs while the lobby is
    // still up". That theory is wrong: a Material compiles a PROGRAM PER
    // VARIANT, and the lobby's single overview camera exercises a different
    // variant set than a race does (chase cams, split cells, the depth and
    // shadow passes). The rest of the set therefore compiles at GO, on
    // Filament's BACKEND thread — which is why neither instrument could see it:
    // the app thread records a frame in 1.5 ms and returns, the GPU timer
    // measures only what executed, and the stall arrives as beginFrame refusing
    // to hand out a drawable. Measured on an A10X solo at 4K: 7-40 fps for
    // ~2.3 s from GO, with the GPU at 9 ms of a 16.7 ms budget throughout.
    //
    // compile() is async on a driver-side queue, so a build is all headroom.
    for (Material* m : { mMaterial, mBlendMaterial, mLitMaterial,
                         mRoadMaterial, mGlbMaterial, mGlbFadeMaterial, mGlbFlatMaterial,
                         mGroundMaterial, mPointMaterial, mCloudMaterial,
                         mBurstMaterial, mEsmMaterial,
                         mPresentMaterial, mOverlayMaterial,
                         mVisMaterial }) {
        if (m) m->compile(Material::CompilerPriorityQueue::HIGH);
    }
    mEngine->flush(); // start any prewarm compiles queued above immediately
    // Between frames — the present material only lands now. Gated exactly
    // like the resize path: with the antialias pass off nothing ever reads
    // the target, and building it here was what left the present instance
    // holding a texture the next gated resize would free (see
    // destroySceneTarget). The frame path re-ensures lazily when AA is on.
    if (mAntialias) ensureSceneTarget();
    // No "track.bin" gate here any more, and nothing replaces it: the scene is
    // a function of `geo` and `theme`, both of which the caller HAS (they are
    // C++ objects, not payloads that might be missing). An empty roster is a
    // legal scene — it is what the lobby's track preview is before any car
    // joins it.
    if (!buildStatic(key, geo, theme, wear)) return false;
    mStaticKey = key;
    return buildField(roster);
}

bool TtpRenderer::rebuildField(const std::vector<TtpRosterCar>& roster) {
    releaseField();
    resetRace();
    return buildField(roster);
}

// THE CUP'S AMBIENT LIFE (theme.life; TtpRenderer.h, mLife). Its texture
// first, over the flake floor's grid: R the floor it lives on, G where.
void TtpRenderer::buildLife(const TrackBin& tb) {
    using ttp::rt::AMB_PETAL;
    const ttp::rt::AmbientSpec& a = tb.life;
    constexpr int N = kAmbFloorN;
    const float cell = 2 * kAmbR / (N - 1);
    // Round the anchors: full inside 40% of the reach, nothing past it.
    const auto nearAnchor = [&](float x, float z) {
        float best = 1e30f;
        for (const LifeAnchor& f : mLifeAnchors) {
            const float dx = x - f.x, dz = z - f.z;
            const float u = std::max(0.0f, std::fabs(dx * f.ax + dz * f.az) - f.hx);
            const float v = std::max(0.0f, std::fabs(-dx * f.az + dz * f.ax) - f.hz);
            best = std::min(best, u * u + v * v);
        }
        const float r = std::max(a.reach, 0.5f);
        return 1.0f - smooth01((std::sqrt(best) - 0.4f * r) / (0.6f * r));
    };
    std::vector<math::half> texels((size_t) N * N * 2);
    for (int gz = 0; gz < N; gz++) {
        for (int gx = 0; gx < N; gx++) {
            const float x = -kAmbR + gx * cell, z = -kAmbR + gz * cell;
            const size_t i = (size_t) gz * N + gx;
            texels[i * 2] = math::half(groundSurfaceY(tb, x, z));
            texels[i * 2 + 1] = math::half(nearAnchor(x, z));
        }
    }
    mLifeTex = Texture::Builder()
            .width((uint32_t) N).height((uint32_t) N).levels(1)
            .sampler(Texture::Sampler::SAMPLER_2D)
            .format(Texture::InternalFormat::RG16F)
            .build(*mEngine);
    {
        auto* px = new std::vector<math::half>(std::move(texels));   // heap-owned: the upload is async
        mLifeTex->setImage(*mEngine, 0, Texture::PixelBufferDescriptor(
                px->data(), px->size() * sizeof(math::half),
                Texture::Format::RG, Texture::Type::HALF,
                [](void*, size_t, void* user) { delete (std::vector<math::half>*) user; }, px));
    }

    // The seeds: in the tiles where it lives, as many a tile as the camera
    // box would hold over that much ground (`count` keeps the weather's
    // meaning), grouped by kLifeChunk blocks of the world, each its own
    // renderable culled on its own bounds.
    const float bandH = std::max(2.0f, 34.0f * a.band);   // how high above its floor a sprite stands
    uint32_t s = 0x1f3a5c7u;
    const auto rnd = [&]() {
        s = s * 1664525u + 1013904223u;
        return (float) ((double) s / 4294967296.0);
    };
    constexpr uint32_t kMaxLife = 6000;
    constexpr int kLifeChunk = 8;   // tiles a block's side: 32 u
    std::vector<float3> seeds;
    {
        const float T = kLifeTile, per = (float) a.count * T * T / (kAmbBox * kAmbBox);
        const int t0 = (int) std::floor(-kAmbR / T), t1 = (int) std::ceil(kAmbR / T);
        for (int cz = t0; cz < t1; cz += kLifeChunk) {
            for (int cx = t0; cx < t1; cx += kLifeChunk) {
                const size_t first = seeds.size();
                for (int tz = cz; tz < std::min(cz + kLifeChunk, t1); tz++) {
                    for (int tx = cx; tx < std::min(cx + kLifeChunk, t1); tx++) {
                        const float x0 = tx * T, z0 = tz * T;
                        float m = 0;
                        for (const float2 q : { float2{ 0.5f, 0.5f }, float2{ 0, 0 }, float2{ 1, 0 },
                                                float2{ 0, 1 }, float2{ 1, 1 } }) {
                            m = std::max(m, nearAnchor(x0 + q.x * T, z0 + q.y * T));
                        }
                        if (m < 0.05f) continue;
                        const int k = (int) (per + rnd());
                        for (int j = 0; j < k && seeds.size() < kMaxLife; j++) {
                            // Clear of the tile's edges: the shader finds the
                            // tile again from the reconstructed seed. Its height
                            // is the floor's plus where in the band it starts,
                            // which the band's wrap takes as a phase, and which
                            // gives the block's bounds the right height.
                            const float x = x0 + 0.05f + rnd() * (T - 0.1f), z = z0 + 0.05f + rnd() * (T - 0.1f);
                            const float floor = groundSurfaceY(tb, x, z);
                            seeds.push_back({ x, floor + rnd() * bandH, z });
                        }
                    }
                }
                if (seeds.size() > first) mLife.tileStarts.push_back((uint32_t) first);   // one sprite, one triangle
            }
        }
    }
    if (seeds.empty()) return;
    const uint32_t tintA = packShown(srgbToLinear(a.tint), 1.0f, a.opacity);
    const uint32_t tintB = packShown(srgbToLinear(a.tint2 ? a.tint2 : a.tint), 1.0f, a.opacity);
    static const math::float2 CORNER[3] = { { 0, 2 }, { -1.7320508f, -1 }, { 1.7320508f, -1 } };
    mLife.verts.resize(seeds.size() * 3);
    mLife.uvs.resize(seeds.size() * 3);
    mLife.idx.resize(seeds.size() * 3);
    for (size_t i = 0; i < seeds.size(); i++) {
        const Vertex v{ seeds[i].x, seeds[i].y, seeds[i].z, (i & 1) ? tintB : tintA };
        for (int k = 0; k < 3; k++) {
            mLife.verts[i * 3 + k] = v;
            mLife.uvs[i * 3 + k] = CORNER[k];
        }
    }
    std::iota(mLife.idx.begin(), mLife.idx.end(), 0u);
    mLifeHalf = a.size * 0.5f;
    mLifeMat = sceneInstance(mPointMaterial);
    mLifeMat->setParameter("halfSize", mLifeHalf);
    mLifeMat->setParameter("time", 0.0f);
    mLifeMat->setParameter("fall", a.fall);
    mLifeMat->setParameter("wind", a.wind);
    mLifeMat->setParameter("bob", a.bob);
    mLifeMat->setParameter("bandH", bandH);
    mLifeMat->setParameter("boxXZ", kAmbBox);
    mLifeMat->setParameter("lite", 0.0f);
    mLifeMat->setParameter("floorOrigin", math::float2{ -kAmbR, -kAmbR });
    mLifeMat->setParameter("floorInvSpan", 1.0f / (2 * kAmbR));
    mLifeMat->setParameter("floorTex", mLifeTex,
            TextureSampler(TextureSampler::MinFilter::LINEAR, TextureSampler::MagFilter::LINEAR));
    mLifeMat->setParameter("mask", 1.0f);
    mLifeMat->setParameter("tile", kLifeTile);
    mLifeMat->setParameter("flutter", a.kind == AMB_PETAL ? 1.0f : 0.0f);
    if (!buildMesh(mLife, true, mLifeMat)) return;
    auto& rcm = mEngine->getRenderableManager();
    // A block's seeds bound its sprites but for their drift out to the tile's
    // edge, their size, and the band's reach over the seed.
    const float pad = 0.2f + a.size;
    for (size_t i = 0; i <= mLife.chunks.size(); i++) {
        const auto ri = rcm.getInstance(i ? mLife.chunks[i - 1] : mLife.entity);
        if (!ri) continue;
        const Box b = rcm.getAxisAlignedBoundingBox(ri);
        const float3 lo = b.getMin() - float3{ pad, pad + bandH, pad }, hi = b.getMax() + float3{ pad, pad + bandH, pad };
        rcm.setAxisAlignedBoundingBox(ri, Box().set(lo, hi));
    }
}
