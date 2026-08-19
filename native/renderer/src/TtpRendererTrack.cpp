// Split from the original single-file TtpRenderer.cpp along its subsystem
// seams; TtpRendererImpl.h carries what the topic files share. Pure code
// motion — behaviour, member set and ABI are unchanged.
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
} // namespace

// Rolling hills for the biomes whose ground is open country (lawn, redrock,
// snow). Sand stays flat — the beach's shoreline and water sheet assume the
// plane — and so does the playroom's wood floor: an indoor floor with hills
// under the boards reads as a defect, not a landscape.
void TtpRenderer::setupTerrain(const TrackBin& tb) {
    switch (tb.groundKind) {
        case 0: mTerrainAmp = 4.6f; break;  // lawn
        case 2: mTerrainAmp = 6.5f; break;  // redrock — badlands earn the drama
        case 3: mTerrainAmp = 5.2f; break;  // snow
        default: mTerrainAmp = 0; break;    // sand, wood
    }
    mTerrainHs.clear();
    mTerrainCols = mTerrainRows = 0;
    // Own stream, derived from the scatter seed: reusing scSeed1's VALUE (not
    // its stream) keeps every existing tree/clutter/landmark roll untouched.
    mTerrainSeed = tb.scSeed1 ^ 0x7465726eu;
    mTerrainFlats.clear();
    float x0 = 1e30f, z0 = 1e30f, x1 = -1e30f, z1 = -1e30f;
    for (const auto& s : tb.samples) {
        x0 = std::min(x0, s.pos.x); x1 = std::max(x1, s.pos.x);
        z0 = std::min(z0, s.pos.z); z1 = std::max(z1, s.pos.z);
    }
    // Hills live in the track's own neighbourhood; past the region the flat
    // sheet resumes, well before the horizon ring's feature bases.
    const float EXT = 90.0f, LIM = 390.0f;
    mTerrainX0 = std::max(x0 - EXT, -LIM); mTerrainX1 = std::min(x1 + EXT, LIM);
    mTerrainZ0 = std::max(z0 - EXT, -LIM); mTerrainZ1 = std::min(z1 + EXT, LIM);
    if (tb.samples.empty()) mTerrainAmp = 0;
}

float TtpRenderer::terrainY(const TrackBin& tb, float x, float z) const {
    if (mTerrainAmp <= 0) return tb.groundY;
    // Fade to the flat plane at the region border, so the outer sheet joins
    // without a step.
    const float border = std::min(
            std::min(x - mTerrainX0, mTerrainX1 - x),
            std::min(z - mTerrainZ0, mTerrainZ1 - z));
    if (border <= 0) return tb.groundY;
    // Flat corridor: distance past the road EDGE (each sample's own width, like
    // the scatter's isClear), ramping to full height 28u out. Raised deck keeps
    // its flat ground too — the pillars, posts and berms under it stand on it.
    float edge = 1e30f;
    for (const auto& s : tb.samples) {
        const float dx = x - s.pos.x, dz = z - s.pos.z;
        const float d = std::sqrt(dx * dx + dz * dz) - s.width * 0.5f;
        if (d < edge) edge = d;
        if (edge <= 4.0f) return tb.groundY;
    }
    float mask = smooth01((edge - 4.0f) / 24.0f) * smooth01(border / 24.0f);
    for (const TerrainFlat& f : mTerrainFlats) {
        if (mask <= 0) break;
        const float dx = x - f.x, dz = z - f.z;
        mask *= smooth01((std::sqrt(dx * dx + dz * dz) - f.r) / 8.0f);
    }
    if (mask <= 0) return tb.groundY;
    // Broad swells with a whisper of detail: short wavelengths at these
    // amplitudes read as lumps tracking the road outline, not landscape.
    const float n = 0.78f * terrainNoise(mTerrainSeed, x / 92.0f, z / 92.0f)
                  + 0.22f * terrainNoise(mTerrainSeed ^ 0x9e3779b9u, x / 34.0f, z / 34.0f);
    // Shaped so valleys sit flat and hills round off — pure noise reads as
    // static, not landscape.
    return tb.groundY + mTerrainAmp * mask * std::pow(n, 1.15f);
}

// Sample the analytic field once at the mesh's own resolution. Runs after
// buildLandmarks (whose spots carve the clearings) and before every builder
// that stands anything on the ground.
void TtpRenderer::buildTerrainGrid(const TrackBin& tb) {
    if (mTerrainAmp <= 0) return;
    mTerrainCols = std::min(96, std::max(12,
            (int) std::ceil((mTerrainX1 - mTerrainX0) / 4.5f)));
    mTerrainRows = std::min(96, std::max(12,
            (int) std::ceil((mTerrainZ1 - mTerrainZ0) / 4.5f)));
    mTerrainSx = (mTerrainX1 - mTerrainX0) / mTerrainCols;
    mTerrainSz = (mTerrainZ1 - mTerrainZ0) / mTerrainRows;
    mTerrainHs.resize((size_t) (mTerrainCols + 1) * (mTerrainRows + 1));
    for (int r = 0; r <= mTerrainRows; r++) {
        for (int c = 0; c <= mTerrainCols; c++) {
            mTerrainHs[(size_t) r * (mTerrainCols + 1) + c] = terrainY(tb,
                    mTerrainX0 + c * mTerrainSx, mTerrainZ0 + r * mTerrainSz);
        }
    }
}

// The grounding rule for chunky pieces: the LOWEST surface point under the
// footprint, so a slope-centre height can't leave the downhill edge hanging
// in silhouette on a dune face.
float TtpRenderer::footprintY(const TrackBin& tb, float x, float z, float r) const {
    float y = groundSurfaceY(tb, x, z);
    for (const auto& o : { float2{ r, 0 }, float2{ -r, 0 },
                           float2{ 0, r }, float2{ 0, -r } }) {
        y = std::min(y, groundSurfaceY(tb, x + o.x, z + o.y));
    }
    return y;
}

float TtpRenderer::groundSurfaceY(const TrackBin& tb, float x, float z) const {
    if (mTerrainHs.empty()) return tb.groundY;
    const float u = (x - mTerrainX0) / mTerrainSx, v = (z - mTerrainZ0) / mTerrainSz;
    if (u <= 0 || v <= 0 || u >= mTerrainCols || v >= mTerrainRows) return tb.groundY;
    const int c = std::min(mTerrainCols - 1, (int) u);
    const int r = std::min(mTerrainRows - 1, (int) v);
    const float fu = u - c, fv = v - r;
    const auto h = [&](int cc, int rr) {
        return mTerrainHs[(size_t) rr * (mTerrainCols + 1) + cc];
    };
    // TRIANGLE-exact, not bilinear: the mesh splits each cell along the b–d
    // anti-diagonal (see the index loop), and a blob draped onto the other
    // interpolant would still dip under the drawn surface.
    const float a = h(c, r), b = h(c + 1, r), d = h(c, r + 1), e = h(c + 1, r + 1);
    if (fu + fv <= 1.0f) return a + (b - a) * fu + (d - a) * fv;
    return e + (d - e) * (1.0f - fu) + (b - e) * (1.0f - fv);
}

// The painted road — a direct port of render/track.js buildRoad's sweep: a
// 16-point cross-section (skirt/kerb/gap/line/asphalt/dash) swept along a fine
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
    const float cw = tb.kerbW, ch = tb.kerbH, deck = 0.34f;
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

    // Cross-section profile, strips and baked AO — verbatim from buildRoad.
    struct PPoint { int sign; float off, y; };
    const PPoint P[16] = {
        { -1, -cw, -deck }, { -1, -cw, 0 }, { -1, -cw, ch }, { -1, 0, ch },
        { -1, 0, 0 }, { -1, gap, 0 }, { -1, gap + lw, 0 },
        { 0, -dashW / 2, 0 }, { 0, dashW / 2, 0 },
        { 1, -gap - lw, 0 }, { 1, -gap, 0 }, { 1, 0, 0 },
        { 1, 0, ch }, { 1, cw, ch }, { 1, cw, 0 }, { 1, cw, -deck },
    };
    enum Kind { K_SKIRT, K_KERB, K_GAP, K_LINE, K_ROAD, K_DASH };
    struct Strip { int a, b; Kind kind; int side; }; // side: -1 L, +1 R, 0 n/a
    const Strip STRIPS[16] = {
        { 0, 1, K_SKIRT, 0 }, { 1, 2, K_KERB, -1 }, { 2, 3, K_KERB, -1 },
        { 3, 4, K_KERB, -1 }, { 4, 5, K_GAP, 0 }, { 5, 6, K_LINE, 0 },
        { 6, 7, K_ROAD, 0 }, { 7, 8, K_DASH, 0 }, { 8, 9, K_ROAD, 0 },
        { 9, 10, K_LINE, 0 }, { 10, 11, K_GAP, 0 }, { 11, 12, K_KERB, 1 },
        { 12, 13, K_KERB, 1 }, { 13, 14, K_KERB, 1 }, { 14, 15, K_SKIRT, 0 },
        { 15, 0, K_SKIRT, 0 },
    };
    const float AO[16] = { 0.55f, 0.65f, 0.90f, 1.0f, 0.70f, 0.90f, 1.0f, 1.0f,
                           1.0f, 1.0f, 0.90f, 0.70f, 1.0f, 0.90f, 0.65f, 0.55f };

    // THE DECK FLAG. The section above is a CLOSED ring, so its last strip —
    // P[15] back to P[0] — is the road's UNDERSIDE, spanning the deck's whole lat
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
    // STRIPS by hand, so it cannot drift when the section changes; and the sweep
    // never shares a vert across quads, so it is a per-quad constant with
    // nothing to interpolate across. A FULL-WIDTH decal is safe now too: a
    // launch strip may fill the deck edge to edge without climbing a kerb.
    constexpr float OFF_DECK_LAT = 1000.0f;

    const auto pointAt = [&](uint32_t i, int j) {
        const TrackBin::Sample& f = frames[i];
        const float l = P[j].sign * halfAt(i) + P[j].off;
        return f.pos + f.up * P[j].y + f.lat * l;
    };

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

    // Sweep: indexed QUADS — 4 verts + 6 indices per strip per ring pair,
    // per-vert AO from its own profile point. The old 6-vert soup's two
    // diagonal verts were attribute-identical duplicates; they are shared by
    // index now, INSIDE a quad only. Verts stay UNSHARED across quads (each
    // quad still owns its corners → crisp paint bands, hard profile corners,
    // per-quad colour and deck flag), and the triangles, winding and
    // attributes are unchanged — byte-identical rasterization at 4
    // vertex-shader invocations per quad instead of 6.
    static const int VSEQ_PT[4] = { 0, 1, 1, 0 };   // a@i, b@i, b@ni, a@ni
    mRoad.verts.reserve((size_t) N * 16 * 4);
    mRoad.normals.reserve((size_t) N * 16 * 4);
    mRoad.uvs.reserve((size_t) N * 16 * 4);
    mRoad.idx.reserve((size_t) N * 16 * 6);
    for (uint32_t i = 0; i < N; i++) {
        const uint32_t ni = (i + 1) % N;
        const float3 colL = bandCol(kerbL, i), colR = bandCol(kerbR, i);
        const bool bare = bareAsphalt(i);
        for (const Strip& st : STRIPS) {
            const bool onDeck = P[st.a].y == 0.0f && P[st.b].y == 0.0f;
            float3 cb;
            switch (st.kind) {
                case K_KERB: cb = st.side > 0 ? colR : colL; break;
                case K_SKIRT: cb = SKIRT; break;
                case K_DASH: cb = bare ? ASPHALT : (dashOn(i) ? DASHC : ASPHALT); break;
                case K_LINE: cb = bare ? ASPHALT : (tb.edgeLines ? LINE : SHOULDER); break;
                case K_GAP: cb = tb.edgeLines ? ASPHALT : SHOULDER; break;
                default: cb = ASPHALT; break;
            }
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
                const float3 n = cross(across, tans[ring]);
                const float len = length(n);
                return len > 1e-9f ? n / len : frames[ring].up;
            };
            const float3 nA = stripNormal(i), nB = stripNormal(ni);
            const uint32_t base = (uint32_t) mRoad.verts.size();
            for (int v = 0; v < 4; v++) {
                const int pt = VSEQ_PT[v] ? st.b : st.a;
                const uint32_t ri = ringIdx[v];
                const float3 p = pointAt(ri, pt);
                mRoad.verts.push_back({ p.x, p.y, p.z, packLinear(cb, AO[pt]) });
                mRoad.normals.push_back(ri == i ? nA : nB);
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
                mRoad.uvs.push_back({ (float) uIdx[v] / N * L,
                        onDeck ? P[pt].sign * halfAt(ri) + P[pt].off
                               : OFF_DECK_LAT });
            }
            // The soup's two triangles, verbatim: (a@i, b@i, b@ni) then
            // (a@i, b@ni, a@ni) — the (i,a)-(i+1,b) diagonal project() splits
            // by. Keep the order: same winding, same provoking vertex per
            // triangle, so the rasterizer sees exactly what the soup drew.
            const uint32_t quad[6] = { base, base + 1, base + 2,
                                       base, base + 2, base + 3 };
            mRoad.idx.insert(mRoad.idx.end(), quad, quad + 6);
        }
    }
    // BAKED VERTEX LIGHT. When the served vroad wants CUSTOM0 (its requires
    // block), the matte light is evaluated on the CPU instead of per vertex
    // per frame. Filled UNSHADOWED here — identical to the live evaluation's
    // shadowTexel-0 answer — so every path that never reaches the ESM
    // (shadows disabled, no float-target support, an early bake return) draws
    // what it always drew; bakeShadowMap re-fills it from the finished ESM
    // and re-uploads in place. An OLD vroad.filamat (tangents + live ESM
    // decode) leaves custom0 empty and keeps the old shape end to end.
    const bool bakedLight = mRoadMaterial != nullptr
            && mRoadMaterial->getRequiredAttributes()[VertexAttribute::CUSTOM0];
    if (bakedLight) {
        mRoad.custom0.resize(mRoad.verts.size(),
                math::half4{ 1.0f, 1.0f, 1.0f, 1.0f });
        fillRoadLight(tb, nullptr, 0, 0);
    }
    // Chunked: ~2.5k triangles a piece, each with its own bounds, so a chase
    // camera pays for the stretch of circuit it can actually see instead of all
    // ~59k triangles of it — per cell, every frame. (Three's ribbon is chunked
    // at 160 rings for exactly this.) mRoad.verts still carries every quad
    // corner as a point set — its readers (the AMB_FLAKE floor raster, the
    // shadow bake's fit) take a max/bound per point, which merging the
    // diagonal's exact duplicates cannot change.
    constexpr uint32_t kRoadChunkTris = 2500;
    if (!buildMesh(mRoad, true, roadInstance(), 4, kRoadChunkTris)) return false;

    // Per-chunk material instances. Each ring contributes 16 strips of 2
    // triangles, so a chunk's triangle range maps straight back to an arclength
    // range, and uploadDeckDecals can hand each chunk only what overlaps it.
    mRoadChunks.clear();
    if (mRoadMaterial) {
        auto& rcm = mEngine->getRenderableManager();
        const uint32_t trisPerRing = 16 * 2;
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
            MaterialInstance* mi = sceneInstance(mRoadMaterial);
            // Absent on the baked-light vroad — its ESM decode ran at build
            // (fillRoadLight); an old blob still carries the live one.
            if (mRoadMaterial->hasParameter("shadowTexel")) {
                mi->setParameter("shadowTexel", 0.0f);
            }
            if (roadHasMaskLoop()) mi->setParameter("maskCount", 0);
            mi->setParameter("profCount", 0);
            mi->setParameter("paintCount", 0);
            // Build-time constants: the wrap and this chunk's own midpoint never
            // change again, so uploadDeckDecals only ever writes the decal set.
            mi->setParameter("trackLength", L);
            mi->setParameter("invTrackLength", L > 0.0f ? 1.0f / L : 0.0f);
            mi->setParameter("chunkMid", (sMin + sMax) * 0.5f);
            // The silhouette array serves the masked loop's NEAR cars; the
            // far cars' carShadow layer is created after the rubber layer
            // below (the two share a lat span) and re-bound there.
            if (roadHasMaskLoop()) {
                if (Texture* arr = ensureDecalMaskArray()) bindDecalMask(mi, arr);
            }
            bindSkidLayer(mi);
            if (roadHasCarShadow()) {
                bindCarShadow(mi, mCarShadowTex[0]);
                mi->setParameter("maskInk", math::float4{ kCarBlobInk.x,
                        kCarBlobInk.y, kCarBlobInk.z, 0.0f });
            }
            rcm.setMaterialInstanceAt(ri, 0, mi);
            mRoadChunks.push_back({ mi, sMin, sMax, {} });
        }
    }
    // The whole-lap fallback instance carries the same build-time wrap
    // constants as the chunks, so uploadDeckDecals only ever writes decal sets.
    if (mRoadInst) {
        mRoadInst->setParameter("trackLength", L);
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
Texture* TtpRenderer::buildGroundTexture(uint32_t kind) {
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
    switch (kind) {
        case 1: { // sand — gentle wind ripples
            const int base[3] = { 222, 200, 150 };
            sweep(10, base, [](int i, float* f) { f[0] = f[1] = f[2] = (i % 2) ? 1.03f : 0.975f; });
            break;
        }
        case 2: { // redrock — sediment strata (a hue wobble)
            const int base[3] = { 211, 150, 113 };
            sweep(8, base, [](int i, float* f) {
                const bool rust = i % 2;
                f[0] = rust ? 1.008f : 0.997f;
                f[1] = rust ? 0.972f : 1.024f;
                f[2] = rust ? 0.958f : 1.036f;
            });
            break;
        }
        case 3: { // snow — whisper-contrast drift banding
            const int base[3] = { 237, 242, 247 };
            sweep(10, base, [](int i, float* f) { f[0] = f[1] = f[2] = (i % 2) ? 1.012f : 0.988f; });
            break;
        }
        case 4: { // wood — planks: per-board tone, seams, end joints, knots
            constexpr int BOARDS = 8;
            const int base[3] = { 201, 156, 104 };
            const float bw = (float) S / BOARDS;
            sweep(BOARDS, base, [](int i, float* f) {
                f[0] = f[1] = f[2] = 0.96f + ((i * 37) % 5) * 0.02f;
            });
            // Board seams: a 2px dark line stroked between planks…
            for (int i = 1; i < BOARDS; i++) {
                blend((int) std::floor(i * bw) - 1, 0, 2, S, 96, 66, 40, 0.55f);
            }
            // …and staggered end joints, offset per board so they never align.
            for (int i = 0; i < BOARDS; i++) {
                blend((int) std::floor(i * bw), (i * 149 + 40) % S,
                        (int) std::ceil(bw), 2, 96, 66, 40, 0.55f);
            }
            break;
        }
        default: { // lawn — mowing stripes
            const int base[3] = { 106, 168, 79 };
            sweep(8, base, [](int i, float* f) { f[0] = f[1] = f[2] = (i % 2) ? 1.04f : 0.965f; });
            break;
        }
    }
    Texture* tex = Texture::Builder()
            .width(S).height(S).levels(9) // 256² down to 1×1
            .format(Texture::InternalFormat::SRGB8_A8)
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
    const float halfSpan = defHalf + tb.kerbW + 0.25f + 0.3f;
    const float CLEARH = 2.0f, BANNER_H = 0.8f, BANNER_D = 0.12f;

    const auto quadW = [&](const float3& a, const float3& b, const float3& c,
            const float3& d, const float3& col) {
        const uint32_t base = (uint32_t) mGantry.verts.size();
        const uint32_t cc = packLinear(col, 1.0f);
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
        const uint32_t cLo = packLinear(col, aoLo);
        const uint32_t cHi = packLinear(col, aoHi);
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
                tubeAo(sx, 0.30f, 0.30f, footY + (topY - footY) * f0,
                        footY + (topY - footY) * f1, (b % 2) ? RING_C : PYLON_C,
                        1.0f, 1.0f);
            }
        } else {
            tube(sx, 0.30f, footY, topY, PYLON_C);
        }
        // Finial: a flush dome cap at PYLON_R (an oversized/pillbox cap swallows
        // the pylon top with a visible crease).
        const int RINGS = 4, SEG = 12;
        const uint32_t capBase = (uint32_t) mGantry.verts.size();
        const uint32_t domeC = packLinear(FINIAL_C, 1.0f);
        for (int r = 0; r <= RINGS; r++) {
            const float phi = (float) r / RINGS * (float) M_PI / 2;
            const float rr = std::cos(phi) * 0.30f, yy = std::sin(phi) * 0.30f;
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
    buildMesh(mGantry);
}

// The matte light rig, as NUMBERS: exactly what the scene's sun and
// IndirectLight are built from in buildTrackScene, and exactly what
// fillRoadLight bakes into the road's vertices — ONE derivation so the two
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

bool TtpRenderer::buildTrackScene(const std::vector<TtpRosterCar>& roster,
        const ttp::RaceTrack& geo, const ttp::rt::Theme& theme,
        const ttp::rt::WearPlan& wear) {
    TrackBin tb;
    applyRoster(tb, roster);
    applyTheme(tb, theme);
    fillGeometry(tb, geo);
    tb.buildArclengthIndex(); // frameAt's bin lookup — see the comment there
    setupTerrain(tb); // before the ground sheet and every builder that stands on it
    const uint32_t carCount = (uint32_t) tb.carColors.size();
    const float groundY = tb.groundY;

    if (!buildRoadMesh(tb)) return false;
    // The deck's fixed furniture becomes stamps on the road we just built, and
    // its paint (repairs, pads) goes onto the chunks that carry it. Without a
    // vroad material there are no stamps: the deck draws bare.
    if (mRoadMaterial) {
        buildStaticDeckDecals(tb);
        buildDeckPaint(tb, wear);
    }

    // Ground sheet at groundY with the lawn's mowing stripes as vertex-colour
    // bands (makeLawnTexture: 8 stripes per 33.3u tile, ×1.04 / ×0.965 on the
    // #6aa84f base; the fine grain is texture detail for later).
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
        switch (tb.groundKind) {
            case 1: // sand — gentle wind ripples, half the lawn's contrast
                for (int i = 0; i < 10; i++) {
                    const float f = (i % 2) ? 1.03f : 0.975f;
                    bands.push_back({ 1.0f / 10, shade(0xdec896, f, f, f) });
                }
                break;
            case 2: // redrock — sediment strata (a hue wobble, not just luminance)
                for (int i = 0; i < 8; i++) {
                    const bool rust = i % 2;
                    bands.push_back({ 1.0f / 8, shade(0xd39671,
                            rust ? 1.008f : 0.997f, rust ? 0.972f : 1.024f,
                            rust ? 0.958f : 1.036f) });
                }
                break;
            case 3: // snow — whisper-contrast drift banding
                for (int i = 0; i < 10; i++) {
                    const float f = (i % 2) ? 1.012f : 0.988f;
                    bands.push_back({ 1.0f / 10, shade(0xedf2f7, f, f, f) });
                }
                break;
            case 4: { // wood — each band IS a plank, with a dark seam between
                const float bw = 1.0f / 8, seam = 2.0f / 256; // 2px of the 256px tile
                for (int i = 0; i < 8; i++) {
                    const float f = 0.96f + ((i * 37) % 5) * 0.02f;
                    if (i) {
                        // The seam is STROKED at 0.55 alpha over the plank, not
                        // painted solid — the raw seam colour reads as a black
                        // gap between boards.
                        const float3 board = shade(0xc99c68, f, f, f);
                        const float3 ink = shade(0x604228, 1, 1, 1);
                        bands.push_back({ seam, board * 0.45f + ink * 0.55f });
                    }
                    bands.push_back({ bw - (i ? seam : 0), shade(0xc99c68, f, f, f) });
                }
                break;
            }
            default: // lawn — mowing stripes
                for (int i = 0; i < 8; i++) {
                    const float f = (i % 2) ? 1.04f : 0.965f;
                    bands.push_back({ 1.0f / 8, shade(LAWN_SRGB, f, f, f) });
                }
                break;
        }
        // The bands stay — the berms sample them by world x (groundColorAt),
        // which is how the JS shares one texture between floor and kerb. The
        // FLOOR mesh itself builds AFTER the builders below, because the
        // landmark spots carve clearings into the terrain field it samples.
    }


    // Sky dome (environment.js paintSky): vertex gradient zenith→horizon→below,
    // the same hand-tuned easing. Sits at SKY_R, past the fog cutoff — the sky
    // is the backdrop the fog dissolves INTO, never fogged itself.
    {
        // The shipped JS pipeline effectively sRGB-decodes the dome's authored
        // colours TWICE (paintSky pre-linearises what the pipeline linearises
        // again), rendering a deeper sky than the raw hexes — measured against
        // the live pane. Parity means reproducing the shipped transfer, quirk
        // included.
        const auto skyLin = [](uint32_t rgb) {
            const float3 once = srgbToLinear(rgb);
            return float3{ srgbChannel(once.x), srgbChannel(once.y), srgbChannel(once.z) };
        };
        const float3 top = skyLin(tb.sky[0]);
        const float3 hor = skyLin(tb.sky[1]);
        const float3 low = skyLin(tb.sky[2]);
        // The gradient only varies vertically, so the height segments carry the
        // picture; the 20 wall segments are silhouette only, and the dome is a
        // backdrop seen from inside — nothing reads its horizontal facets.
        appendSphere(mSky, 20, 16,
                [&](const float3& p) { return p * SKY_R; },
                [&](const float3& p) {
                    const float t = p.y; // -1 nadir .. 1 zenith
                    const float3 c = t >= 0
                            ? mix(hor, top, std::pow(t, 0.65f))
                            : mix(hor, low, std::min(1.0f, -t * 3.0f));
                    return packLinear(c, 1.0f);
                });
        if (!buildMesh(mSky)) return false;
    }

    // The gallery's kit field, off in every build but its own. BEFORE the hill
    // ring, which is the one thing in the scene that reaches as far out as the
    // field does: the ring reads the bounds this leaves behind and stands no
    // hill inside them, so the field gets the clear horizon a browser needs
    // instead of a row of models parked behind a mountain.
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
        // (flat-topped 9-sided talus cones), playroom blocks (yawed near-cubes)
        // and beach islands (fewer, lower, farther domes — the sea has to show
        // BETWEEN them). Feature count, scale and radius all vary per shape.
        const uint32_t shape = tb.hillShape;
        const int count = shape == 1 ? 14 : shape == 2 ? 10 : shape == 3 ? 9 : 18;
        for (int i = 0; i < count; i++) {
            float sx, sy, sz, a, r, yaw = 0;
            if (shape == 1) {        // mesa
                yaw = (i % 7) * 0.9f;
                sy = 8 + (i % 3) * 4.5f;
                sx = 20 + (i % 4) * 8; sz = 16 + ((i + 2) % 4) * 7;
                a = ((float) i / count) * 2.0f * (float) M_PI + (i % 5) * 0.17f;
                r = 152 + (i % 3) * 20;
            } else if (shape == 2) { // block
                sy = 13 + (i % 3) * 5;
                sx = 14 + (i % 4) * 5; sz = 14 + ((i + 2) % 4) * 5;
                yaw = (i % 7) * 0.85f; // scaled BEFORE the yaw — a sheared box loses the block read
                a = ((float) i / count) * 2.0f * (float) M_PI + (i % 5) * 0.23f;
                r = 158 + (i % 3) * 22;
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
            const uint32_t col = packLinear(hc, 1.0f);
            const float cyw = std::cos(yaw), syw = std::sin(yaw);
            const auto rot = [&](const float3& p) {
                return float3{ p.x * cyw + p.z * syw, p.y, -p.x * syw + p.z * cyw };
            };
            // The mesa yaws BEFORE its non-uniform scale (facet phase), the
            // block scales first (yawing a scaled box would shear it, and the
            // crisp block silhouette is the whole point).
            const bool yawFirst = (shape == 1);
            const auto place = [&](float3 p) {
                if (yaw != 0 && yawFirst) p = rot(p);
                p = { p.x * sx, p.y * sy, p.z * sz };
                if (yaw != 0 && !yawFirst) p = rot(p);
                return float3{ (p.x + cx) * sf, p.y - 1.0f, (p.z + cz) * sf };
            };
            if (shape == 1 || shape == 2) {
                // Unit protos with their base at y=0 (so the y scale IS the
                // feature height): a 9-sided talus cone with a 0.58 plateau,
                // or a cube.
                const Prim pr = (shape == 1) ? primCylinder(0.58f, 1.0f, 1.0f, 9)
                                             : primBox(1, 1, 1);
                const uint32_t base = (uint32_t) mHills.verts.size();
                for (const float3& v : pr.v) {
                    const float3 w = place({ v.x, v.y + 0.5f, v.z });
                    mHills.verts.push_back({ w.x, w.y, w.z, col });
                }
                for (const uint32_t idx : pr.i) mHills.idx.push_back(base + idx);
            } else {
                appendSphere(mHills, 8, 5, place,
                        [&](const float3&) { return col; }, true);
            }
        }
        if (shape == 1 || shape == 2) accumulateNormals(mHills);
        if (!buildMesh(mHills)) return false;
    }

    // Race-fog colour for the cell views (ensureCells applies it): the same
    // theme colour as the sky horizon, so distant geometry dissolves into sky.
    mFogColor = srgbToLinear(tb.fog);
    // tb.fogTune is NOT read here: the ramp arrives per view, already scaled.
    // It stays in the payload for whoever computes the cameras (the JS display
    // today, libttp-runtime once the JS retires).

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
    // No engine shadows: the map is baked once by bakeShadowMap and sampled by
    // the lit materials themselves. Leaving Filament's on would re-render the
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
    }

    // Cars: the real GLB when the shell provided "car<i>.glb" (gltfio +
    // ubershaders, textures via stb), else a roster-coloured box marker.
    mCars.resize(carCount);
    mCarAssets.assign(carCount, nullptr);
    mCarGhostAssets.assign(carCount, nullptr);
    mCarGhostIn.assign(carCount, 1); // loadCarAsset adds them; frame 1 removes them
    mMonsterViews.assign(carCount, {});
    for (uint32_t c = 0; c < carCount; c++) {
        if (!buildCarSlot(tb, c)) return false;
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
    mBananaAsset = loadInstancedProp("item-banana.glb", 8, mBananaInstances);
    mBananaIn.assign(mBananaInstances.size(), 1);
    // Contact blobs for the FLOATING props (TrackProps' _boxShadow) are all
    // road-shader stamps now: the boxes' in buildStaticDeckDecals, the
    // bananas' and rockets' in the render loop.
    // Monster chassis pool (one per car): the kit monster truck with its cab
    // node collapsed — the transformed player's own car body seats the slot
    // per frame (MonsterRig's graft; gunmetal recolour is later polish).
    mMonsterAsset = loadInstancedProp("vehicle-monster-truck.glb", carCount, mMonsterInstances);
    mMonsterGhostAsset = loadInstancedProp("monster-ghost.glb", carCount, mMonsterGhostInstances);
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
        const filament::Aabb mbb = mMonsterAsset->getBoundingBox();
        if (mbb.max.x > mbb.min.x) {
            mMonsterFootW = mbb.max.x - mbb.min.x;
            mMonsterFootL = mbb.max.z - mbb.min.z;
            // The rig's own outline, off instance 0 while the whole pool still
            // sits at rest (loadInstancedProp adds them un-posed; the first
            // frame is what takes them out of the scene). One bake serves every
            // car — the truck under them all is the same truck.
            if (!mMonsterInstances.empty() && mMonsterInstances[0]) {
                bakeSilhouette(mMonsterInstances[0]->getEntities(),
                        mMonsterInstances[0]->getEntityCount(), mbb.min, mbb.max,
                        kMaskLayerMonster);
            }
        }
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
    buildWater(tb);
    buildFliers(tb);
    buildOils(tb);   // the cones and signs; the slick itself is a road stamp
    buildStructures(tb);
    // Landmarks FIRST: their spots carve flat clearings into the terrain field
    // (mTerrainFlats), which the scatter and the ground mesh then sample. The
    // three streams are independently seeded, so this order moves nothing.
    buildLandmarks(tb);
    buildTerrainGrid(tb); // the clearings are carved; freeze the surface
    buildScenery(tb);
    buildProps(tb);
    buildClutter(tb);

    // The ground sheet, last of the static builders: the terrain field is
    // only complete once the landmark spots have carved their clearings.
    {
        const float G = 400.0f, TILE = kGroundTile;
        const uint32_t white = packLinear(float3{ 1, 1, 1 }, 1.0f);
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
            const int cols = mTerrainCols, rows = mTerrainRows;
            const float sx = mTerrainSx, sz = mTerrainSz;
            const auto hAt = [&](int c, int r) {
                c = std::min(cols, std::max(0, c));
                r = std::min(rows, std::max(0, r));
                return mTerrainHs[(size_t) r * (cols + 1) + c];
            };
            for (int r = 0; r <= rows; r++) {
                for (int c = 0; c <= cols; c++) {
                    const float x = mTerrainX0 + c * sx, z = mTerrainZ0 + r * sz;
                    mGround.verts.push_back({ x, hAt(c, r), z, white });
                    mGround.uvs.push_back({ x / TILE, z / TILE });
                    // Central-difference heightfield normal — analytic, so the
                    // hills shade smooth at any grid step.
                    mGround.normals.push_back(normalize(float3{
                            (hAt(c - 1, r) - hAt(c + 1, r)) / (2 * sx), 1.0f,
                            (hAt(c, r - 1) - hAt(c, r + 1)) / (2 * sz) }));
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
            // ever draws it, bit 1 set (below) so the bake does.
            mGroundProxy.verts = {
                { -G, groundY, -G, white }, { G, groundY, -G, white },
                { -G, groundY, G, white }, { G, groundY, G, white } };
            mGroundProxy.idx = { 0, 2, 1, 1, 2, 3 };
            if (buildMesh(mGroundProxy)) {
                auto& rcm = mEngine->getRenderableManager();
                const auto ri = rcm.getInstance(mGroundProxy.entity);
                if (ri) rcm.setLayerMask(ri, 0x01, 0x00);
            }
        }
        if (mGroundMaterial) {
            mGroundTex = buildGroundTexture(tb.groundKind);
            MaterialInstance* gmi = sceneInstance(mGroundMaterial);
            mGroundInst = gmi; // bound to the sun map once it is baked, below
            if (mGroundTex) {
                TextureSampler smp(TextureSampler::MinFilter::LINEAR_MIPMAP_LINEAR,
                        TextureSampler::MagFilter::LINEAR);
                smp.setWrapModeS(TextureSampler::WrapMode::REPEAT);
                smp.setWrapModeT(TextureSampler::WrapMode::REPEAT);
                smp.setAnisotropy(4.0f); // three sets the same on every ground texture
                gmi->setParameter("albedo", mGroundTex, smp);
            }
            if (!buildMesh(mGround, true, gmi)) return false;
        } else if (!buildMesh(mGround)) {
            return false;
        }
    }

    // The rubber layer — one R8 accumulation texture in track space (s across
    // the width, lat across the height), rasterized on the CPU (mSkidPix) and
    // uploaded as dirty rects, sampled by every vroad instance. Per-track
    // because its width is the lap length at a fixed texel density; the
    // density is capped by the device's max texture size, so a very long
    // lap trades edge crispness, never correctness.
    mWheelTrails.assign(carCount * 4, {});
    if (tb.length > 1.0f) {
        float maxHalf = tb.roadWidth * 0.5f;
        for (const TrackBin::Sample& r : tb.rings) {
            maxHalf = std::max(maxHalf, r.width * 0.5f);
        }
        // +0.7: kerb reach plus margin, so the widest mark a wheel can lay
        // still sits rows away from the CLAMP edge rows the shader relies on
        // staying empty (see bindSkidLayer).
        mSkidLatHalf = maxHalf + 0.7f;
        // 80 texels/u along s — the SAME density as lat's 512 rows (~80/u),
        // so on hardware whose real texture limit accommodates it the grid is
        // ISOTROPIC and a diagonal mark resolves exactly like a straight one.
        // The cap is the device's reported GL_MAX_TEXTURE_SIZE, and ONLY THE
        // WEB REPORTS ONE (mMaxTextureDim): tvOS and Android TV keep the 8192
        // default, where every shipped track clamps and the grid comes out
        // 3-4x anisotropic rather than isotropic. Where it clamps, the
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
        mSkidTex = Texture::Builder()
                .width(W).height(H).levels(0xff) // full chain — see the mip
                                                 // refresh in the stamp block
                .format(Texture::InternalFormat::R8)
                .usage(Texture::Usage::SAMPLEABLE | Texture::Usage::UPLOADABLE
                        | Texture::Usage::GEN_MIPMAPPABLE)
                .build(*mEngine);
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
            // trilinear tap).
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

        // The CAR-SHADOW layer — the texture path replacing vroad's masked
        // uniform loop, only when the served blob carries the tap. It rides
        // the rubber layer's lat span (mSkidLatHalf) so the shader's one uv
        // serves both taps, which is why it is created here, inside the same
        // guard. A PAIR, both zeroed now (a fresh texture holds garbage —
        // the lobby-speckle lesson): the per-frame upload alternates between
        // them so it never lands on the texture the driver is reading
        // (uploadCarShadow has the whole argument). W targets 8 texels/u of
        // arclength — coarse against the rubber's 80 on purpose: the stamp
        // is a pre-blurred blob and the whole level re-uploads every frame,
        // so W bounds that event's size (512 KB at the 4096 cap).
        if (mSkidTex && roadHasCarShadow()) {
            mCarShadowH = (uint32_t) kCarShadowH;
            mCarShadowW = (uint32_t) std::min(4096.0f,
                    std::max(1024.0f, std::round(tb.length * 8.0f)));
            if (mCarShadowMask.empty()) {
                mCarShadowMask = superellipseMaskPixels(kCarShadowMaskW, kCarShadowMaskH);
            }
            bool ok = true;
            for (int t = 0; t < 2 && ok; t++) {
                mCarShadowTex[t] = Texture::Builder()
                        .width(mCarShadowW).height(mCarShadowH).levels(1)
                        .format(Texture::InternalFormat::R8)
                        // UPLOAD-ONLY, like the rubber: no COLOR_ATTACHMENT,
                        // ever (the A10X RT law — see mSkidPix).
                        .usage(Texture::Usage::SAMPLEABLE | Texture::Usage::UPLOADABLE)
                        .build(*mEngine);
                if (!mCarShadowTex[t]) { ok = false; break; }
                const size_t bytes = (size_t) mCarShadowW * mCarShadowH;
                auto* zeros = new uint8_t[bytes]();
                mCarShadowTex[t]->setImage(*mEngine, 0,
                        Texture::PixelBufferDescriptor(zeros, bytes,
                                Texture::Format::R, Texture::Type::UBYTE,
                                [](void* b, size_t, void*) { delete[] (uint8_t*) b; },
                                nullptr));
            }
            if (ok) {
                mCarShadowPix.assign((size_t) mCarShadowW * mCarShadowH, 0);
                mCarShadowDirty.clear();
                // 1, not 0: the instances below bind tex[0], so the FIRST
                // upload must land on tex[1] — starting at 0 respecified the
                // very texture the driver was reading, once per scene, which
                // is the exact in-flight conflict the pair exists to avoid.
                mCarShadowPing = 1;
                mCarShadowUpload = false;
                const math::float4 ink{ kCarBlobInk.x, kCarBlobInk.y,
                        kCarBlobInk.z, kCarShadowCap };
                if (mRoadInst) {
                    bindCarShadow(mRoadInst, mCarShadowTex[0]);
                    mRoadInst->setParameter("maskInk", ink);
                }
                for (RoadChunk& rc : mRoadChunks) {
                    if (!rc.mi) continue;
                    bindCarShadow(rc.mi, mCarShadowTex[0]);
                    rc.mi->setParameter("maskInk", ink);
                }
            } else {
                // No layer, no tap: maskInk.w stayed 0 at instance creation,
                // so the deck simply draws no car shadows — the same benign
                // state a shell with no vroad at all is already in.
                for (auto*& t : mCarShadowTex) {
                    if (t) { mEngine->destroy(t); t = nullptr; }
                }
                mCarShadowW = mCarShadowH = 0;
            }
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
        // by this along the camera axes, so the quad spans the full `size`.
        mAmbSize = tb.ambSize * 0.5f;
        const float bandH = std::max(2.0f, AMB_H * tb.ambBand);
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
        const uint32_t tint = packLinear(srgbToLinear(tb.ambTint), 1.0f, tb.ambOpacity);
        // Four vertices per particle, all carrying the SAME seed: the corner in
        // uv0 is what vpoint.mat spreads along the camera's right/up, so the
        // sprite faces every cell's camera and comes out round — and the seed
        // hash lands identically on all four, keeping the quad rigid.
        mPollen.verts.resize(AMB_COUNT * 4);
        mPollen.uvs.resize(AMB_COUNT * 4);
        mPollen.idx.resize(AMB_COUNT * 6);
        static const math::float2 CORNER[4] = { { -1, -1 }, { 1, -1 }, { 1, 1 }, { -1, 1 } };
        static const uint32_t QUAD[6] = { 0, 1, 2, 0, 2, 3 };
        for (int i = 0; i < AMB_COUNT; i++) {
            const Vertex seed = { (float) arnd() * kAmbBox, (float) arnd() * AMB_H,
                                  (float) arnd() * kAmbBox, tint };
            for (int k = 0; k < 4; k++) {
                mPollen.verts[i * 4 + k] = seed;
                mPollen.uvs[i * 4 + k] = CORNER[k];
            }
            for (int k = 0; k < 6; k++) mPollen.idx[i * 6 + k] = i * 4 + QUAD[k];
        }
        mPollenMat = sceneInstance(mPointMaterial);
        mPollenMat->setParameter("halfSize", mAmbSize); // re-fitted per frame, below
        mPollenMat->setParameter("time", 0.0f);         // advanced per frame
        mPollenMat->setParameter("fall", tb.ambFall);
        mPollenMat->setParameter("wind", tb.ambWind);
        mPollenMat->setParameter("bob", tb.ambBob);
        mPollenMat->setParameter("bandH", bandH);
        mPollenMat->setParameter("boxXZ", kAmbBox);
        mPollenMat->setParameter("floorOrigin", math::float2{ -kAmbR, -kAmbR });
        mPollenMat->setParameter("floorInvSpan", 1.0f / (2 * kAmbR));
        mPollenMat->setParameter("floorTex", mAmbFloorTex,
                TextureSampler(TextureSampler::MinFilter::LINEAR,
                        TextureSampler::MagFilter::LINEAR));
        if (!buildMesh(mPollen, true, mPollenMat)) return false;
        // The drawn positions follow the cameras, so no authored-time AABB can
        // bound them: make the box world-sized instead of culling on a lie.
        auto& rcm = mEngine->getRenderableManager();
        rcm.setAxisAlignedBoundingBox(rcm.getInstance(mPollen.entity),
                { { 0, 0, 0 }, { 1e4f, 1e4f, 1e4f } });
    }

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
            const uint32_t rc = packLinear(srgbToLinear(0xffe6b0), 1.0f, 1.0f);
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
                    [&](const float3&) { return packLinear(srgbToLinear(0xffe0a8), 1.0f, 1.0f); });
            ball.uvs.assign(ball.verts.size(), math::float2{ 0, 0 });
            mBurstBallMats[bi] = sceneInstance(mBurstMaterial);
            mBurstBallMats[bi]->setParameter("ring", math::float2{ 0, 0 });
            if (!buildMesh(ball, false, mBurstBallMats[bi])) return false;
        }
    }

    // Baked lawn shadows: one merged mesh of soft ink discs at the collected
    // caster spots, displaced along the key-light slant like a real bake.
    if (mBlendMaterial && !mShadowSpots.empty()) {
        const uint32_t core = packLinear(srgbToLinear(0x2a2735), 1.0f, 0.30f);
        const uint32_t rim = packLinear(srgbToLinear(0x2a2735), 1.0f, 0.0f);
        for (const math::float4& s : mShadowSpots) {
            // spot = { worldX, worldZ, radius, casterHeight }.
            // key from (2,12,1.5): shadow shifts opposite, scaled by height.
            const float ox = -2.0f / 12.0f * s.w, oz = -1.5f / 12.0f * s.w;
            const float cx = s.x + ox, cz = s.y + oz;
            const float r = s.z;
            // Conformed per vertex onto the ground MESH's own surface
            // (groundSurfaceY), with a mid ring: a plain fan interpolates
            // straight across grid creases, and over a valley crease the chord
            // dips under the drawn ground. Half the span, a quarter the sag.
            constexpr float LIFT = 0.03f;
            const int SEG = 14;
            const uint32_t mid = packLinear(srgbToLinear(0x2a2735), 1.0f, 0.15f);
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
            const uint32_t c = packLinear(srgbToLinear(hex), shade);
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
                const uint32_t fc = packLinear(srgbToLinear(0xffe86b), 1.0f, 0.90f);
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
        const auto pushTri = [&](const float3& a, const float3& b, const float3& c) {
            // face gore by centroid longitude → crisp seams (per-face paint)
            const float cx3 = (a.x + b.x + c.x) / 3, cz3 = (a.z + b.z + c.z) / 3;
            const int gore = ((int) std::floor(
                    (std::atan2(cz3, cx3) + (float) M_PI) / (2.0f * (float) M_PI) * GORES))
                    % GORES;
            const uint32_t col = packLinear(PANELS[gore % 2], 1.0f);
            for (const float3& p : { a, b, c }) {
                m.verts.push_back({ p.x, p.y * 1.08f, p.z, col });
                m.normals.push_back(normalize(p));
                m.idx.push_back((uint32_t) m.idx.size());
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
            for (const float3& p : { a, b, c, c, b, d }) {
                m.verts.push_back({ p.x, p.y, p.z, col });
                m.normals.push_back(n);
                m.idx.push_back((uint32_t) m.idx.size());
            }
        };
        const uint32_t RIG = packLinear(srgbToLinear(0x6f5a40), 1.0f);
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
        const uint32_t BSK = packLinear(srgbToLinear(0x8a6f4d), 1.0f);
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
        if (!buildMesh(m)) return false;
        auto& tcmB = mEngine->getTransformManager();
        tcmB.setTransform(tcmB.getInstance(m.entity),
                mat4f::translation(float3{ 0, -1000, 0 }));
    }

    // Boost aura colour: boostShades.disk (accent +15%). The disc itself is a
    // road-shader stamp sized per frame in render().
    mBoostDiskLin = srgbToLinear(ttp::rt::boost_shades(tb.boostCol).disk);
    if (mBlendMaterial) {
        // Boost wind streaks: the JS is a UNIT QUAD (length along Z, width
        // along X, facing +Y) carrying makeStreakTexture — an ellipse
        // (rx 24, ry 3 on a 64×16 canvas) blurred by 3px, so it's soft at both
        // ends AND almost entirely feather across its width. Reproduced as a
        // grid with that blurred coverage baked into the vertex alpha (the old
        // centre-fade fan read as a hard lens); the per-frame envelope scales
        // it. Axial-billboarded per cell, cycled front→back while boosting.
        mStreaks.assign(carCount * 4, {});
        mStreakMeshes.resize(carCount * 4);
        mStreakSeed.resize(carCount);
        for (uint32_t c = 0; c < carCount; c++) mStreakSeed[c] = 0x5eed + c * 977;
        const float3 STREAKC = srgbToLinear(ttp::rt::boost_shades(tb.boostCol).streak);
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
            for (auto& m : mStreakMeshes) {
                for (int j = 0; j <= NV; j++) {
                    for (int i2 = 0; i2 <= NU; i2++) {
                        const uint8_t a = alpha[j * (NU + 1) + i2];
                        const float x = (float) j / NV - 0.5f;  // across the width
                        const float z = (float) i2 / NU - 0.5f; // along travel
                        m.verts.push_back({ x, 0, z,
                                packLinear(STREAKC, 1.0f, a / 255.0f) });
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
                auto& tcmS = mEngine->getTransformManager();
                tcmS.setTransform(tcmS.getInstance(m.entity),
                        mat4f::translation(float3{ 0, -1000, 0 }));
            }
        }
    }

    buildGantry(tb);
    // Sun shadows: who casts, who catches. AFTER the gantry — it's a caster.
    //
    // This used to be a CPU bake that ray-traced the sun per road vertex and
    // multiplied the result into the vertex colours. It could never be right:
    // the road's rings sit ~0.24 u apart, so a Gouraud-stretched occlusion term
    // cannot resolve an edge that a 2048² map resolves at ~0.05 u, and every
    // attempt to hide that (a fat PCF disc) just traded wedges for mush. The JS
    // does not bake vertices at all — it renders a REAL shadow map once and
    // freezes it. Filament has no freeze, so the map re-renders per view per
    // frame; the scene behind it is static, so the picture is identical and the
    // only cost is one depth pass of the track (measured below the noise floor
    // against the 130 ms the bake charged at every scene build).
    //
    // Caster/receiver sets are three's, verbatim: the fixed track geometry
    // casts, the road and its structures catch, and NOTHING else does — cars,
    // props and scenery carry their own ground blobs (setShadows(false) on
    // every glTF asset, since gltfio opts renderables IN by default), and the
    // grass deliberately opts out so an elevated car's blob can't detach onto
    // it far below the deck.
    // The WHOLE road casts, not just the elevated chunks (the JS used maxY >
    // 0.8 over a ground plane at −1, and this was that filter, verbatim).
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

    // Frustum culling for the static furniture. Everything here is either
    // fixed in world space or moved by a transform (which Filament applies to
    // the bounds), so a build-time box stays honest — unlike the decals and
    // ribbons, whose vertices are rewritten in world space per frame and which
    // therefore stay opted out. Off-screen scenery was being drawn in full, in
    // every cell: a 4-way split paid for the whole circuit four times.
    for (Mesh* m : { &mStructures, &mBerms, &mGantry, &mBoulders, &mLandmarks,
                     &mClutter, &mWater, &mWet,
                     &mBalloon, &mWindmill }) {
        setMeshCulling(*m, true);
    }

    // The sun's map, rendered once now that every caster exists, and handed to
    // the materials that sample it.
    bakeShadowMap(tb);
    bindShadowMap(litShadowInstance());
    // The deck is the main RECEIVER, but under the baked-light vroad there is
    // nothing to bind: its ESM decode ran once inside bakeShadowMap
    // (fillRoadLight) and the result is vertex data. Only an OLD vroad blob
    // (live decode) still carries the five shadow parameters.
    if (mRoadMaterial && mRoadMaterial->hasParameter("shadowTexel")) {
        if (mRoadInst) bindShadowMap(mRoadInst);
        for (const RoadChunk& ch : mRoadChunks) bindShadowMap(ch.mi);
    }
    // ...and the ground takes its BAKED visibility map instead — an elevated
    // deck lays its shape on the floor below through vvis's one-time decode.
    if (mGroundInst) bindVisMap(mGroundInst);
    // Every other vlit instance still needs its sampler resolved, but with
    // shadowTexel 0 so the lookup is skipped entirely.
    Texture* const map = mShadowMap;
    mShadowMap = nullptr;
    bindShadowMap(mLitMaterial ? mLitMaterial->getDefaultInstance() : nullptr);
    for (MaterialInstance* mi : mSceneMatInstances) {
        if (mi != mLitShadowInst && mi->getMaterial() == mLitMaterial) bindShadowMap(mi);
    }
    mShadowMap = map;

    // Clouds (environment.js): 8 puffs, deterministic index math. The JS
    // sprites are fog:false and drift ACROSS the field in authored space;
    // here each cloud stores its AUTHORED position and the render loop pushes
    // it out to the 405 unfogged band ALONG ITS CURRENT DIRECTION per frame
    // (a build-time push broke as soon as a cloud drifted over the middle —
    // the pre-scaled puff hung huge and fogged right over the track).
    if (mCloudMaterial) {
        // The puff's SHAPE is vcloud.mat's, evaluated per fragment from uv0 —
        // so a sprite is one quad and the silhouette stays smooth however large
        // the push-out draws it. Everything below is just where and how big.
        const auto puffQuad = [&](Mesh& m, float sw, float sh, uint32_t colour) {
            for (int j = 0; j < 2; j++) {
                for (int k = 0; k < 2; k++) {
                    m.verts.push_back({ (k - 0.5f) * sw, (0.5f - j) * sh, 0, colour });
                    m.uvs.push_back({ (float) k, (float) j }); // v runs DOWN the field
                }
            }
            m.idx = { 0, 2, 1, 1, 2, 3 };
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
            // Sprite quad, billboarded per view in render(). Geometry at
            // AUTHORED size — the per-frame push-out scales the transform
            // (softened, k^0.55: cameras sit far from the origin, so full-k
            // clouds loom oversized). DEF_CLOUDS aspect is 0.42.
            const float sw = w * tb.cloudScale;
            puffQuad(mClouds[i], sw, sw * tb.cloudAspect,
                    packLinear(cloudTint, 1.0f, tb.cloudOpacity));
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
            puffQuad(mHaze[i], sw, sw * 0.14f, // HAZE_ASPECT — banks, not puffs
                    packLinear(hazeTint, 1.0f, tb.hazeOpacity));
            // Priority 5 draws a bank AFTER the clouds (default 4). Both write
            // no depth, so the blend pass's order is the whole of what decides
            // which composites over which, and a bank is the nearer sheet.
            if (!buildMesh(mHaze[i], true, mCloudMaterial->getDefaultInstance(), 5)) {
                return false;
            }
        }
    }

    // Ghost body variants (50%-alpha patched GLBs) for the monster occlusion
    // fade — loaded LAST, with a full decode pump after each: interleaving
    // them with the solid cars doubled the in-flight decode queue and dropped
    // a car's colormap (it rendered gray). Parked until a swap needs them.
    for (uint32_t c = 0; c < carCount; c++) buildCarGhost(c);

    // Texture decodes ride the provider's async queue even on the synchronous
    // loadResources path — finished textures only ATTACH on a queue pump (the
    // sync path pumps at the START of the next load, so without this the last
    // assets' textures never bind and those cars render black).
    pumpTextures();
    mTrack = std::make_unique<TrackBin>(std::move(tb));
    mDecalProjHint.clear(); // ring indices belong to the track just replaced
    return true;
}

bool TtpRenderer::buildScene(const ttp::RaceTrack& geo, const ttp::rt::Theme& theme,
        const std::vector<TtpRosterCar>& roster, const ttp::rt::WearPlan& wear) {
    // Re-entrant: the game calls this again for every race (releaseScene()
    // first). The three materials are RENDERER scope — compiled once from the
    // provided .filamat bytes and reused by every scene after.
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
    // vlit minus the shadow sampler, for every lit mesh that is not a shadow
    // RECEIVER (only the structures and berms are — litShadowInstance). Those
    // draws used to bind the ESM plus four dead uniforms purely so a
    // shadowTexel of 0 could early-out. Optional the same way vroad is: an
    // older asset set falls back to vlit and draws the identical picture.
    const auto vlitns = mAssets.find("vlitns.filamat");
    if (!mLitPlainMaterial && vlitns != mAssets.end()) {
        mLitPlainMaterial = Material::Builder()
                .package(vlitns->second.data(), vlitns->second.size())
                .build(*mEngine);
    }
    // The road deck's own material: vlit's shading (they share ttp_shade.inc)
    // plus a uv0 channel carrying track space, so deck decals can be shaded INTO
    // the road instead of laid over it. Optional — a shell whose asset set
    // predates it falls back to vlit and simply gets no stamped decals.
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
        // PREWARM. Every other material draws on the first frame after build,
        // which compiles its programs while the lobby is still up. This one's
        // first draw is the first item-box poof (the fade twin enters the
        // scene only then), and on Metal that first-use compile was a felt
        // hitch mid-race — once per run, on whichever car collected first.
        // compile() is async on a driver-side queue, so build-time is all
        // headroom; the flush below starts it immediately.
        if (mGlbFadeMaterial) {
            mGlbFadeMaterial->compile(Material::CompilerPriorityQueue::HIGH);
        }
    }
    const auto vground = mAssets.find("vground.filamat");
    if (!mGroundMaterial && vground != mAssets.end()) {
        mGroundMaterial = Material::Builder()
                .package(vground->second.data(), vground->second.size())
                .build(*mEngine);
    }
    // The ground's visibility BAKE material (vvis.mat) — used once per track
    // inside bakeShadowMap, never in a frame. Optional like the rest: without
    // it the bake is skipped and bindVisMap's white fallback leaves the
    // ground fully lit (the same degradation a missing ESM already means).
    const auto vvis = mAssets.find("vvis.filamat");
    if (!mVisMaterial && vvis != mAssets.end()) {
        mVisMaterial = Material::Builder()
                .package(vvis->second.data(), vvis->second.size())
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
        // Same deferred-first-draw prewarm as vglbfade: this one's first draw
        // is the first rocket blast.
        if (mBurstMaterial) {
            mBurstMaterial->compile(Material::CompilerPriorityQueue::HIGH);
        }
    }
    const auto vblur = mAssets.find("vblur.filamat");
    if (!mBlurMaterial && vblur != mAssets.end()) {
        mBlurMaterial = Material::Builder()
                .package(vblur->second.data(), vblur->second.size())
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
        // Same deferred-first-draw prewarm: hudCount stays 0 until the race
        // cams go live, so this one's first draw is the first race frame —
        // the compile stall would land right on the countdown.
        if (mOverlayMaterial) {
            mOverlayMaterial->compile(Material::CompilerPriorityQueue::HIGH);
        }
    }
    // THE GRADE'S CURVE AS A TABLE — see ttp_grade.inc for why a texture beats a
    // `pow` here. Built once, handed to every
    // material that grades as a MATERIAL default, because the instances are made
    // in a dozen places while the Materials are all built right here.
    if (!mGradeLut) {
        auto* px = new std::vector<uint8_t>(1024);
        for (int i = 0; i < 1024; i++) {
            const float c = (float) i / 1023.0f;
            const float e = c <= 0.0031308f ? c * 12.92f
                                            : 1.055f * std::pow(c, 1.0f / 2.4f) - 0.055f;
            (*px)[(size_t) i] = (uint8_t) std::lround(
                    std::min(1.0f, std::max(0.0f, e)) * 255.0f);
        }
        mGradeLut = Texture::Builder().width(1024).height(1).levels(1)
                .format(Texture::InternalFormat::R8)
                .usage(Texture::Usage::SAMPLEABLE | Texture::Usage::UPLOADABLE)
                .build(*mEngine);
        if (mGradeLut) {
            mGradeLut->setImage(*mEngine, 0,
                    Texture::PixelBufferDescriptor(px->data(), px->size(),
                            Texture::Format::R, Texture::Type::UBYTE,
                            [](void*, size_t, void* u) { delete (std::vector<uint8_t>*) u; },
                            px));
        } else {
            delete px;
        }
    }
    if (mGradeLut) {
        TextureSampler gs(TextureSampler::MinFilter::LINEAR,
                TextureSampler::MagFilter::LINEAR);
        gs.setWrapModeS(TextureSampler::WrapMode::CLAMP_TO_EDGE);
        gs.setWrapModeT(TextureSampler::WrapMode::CLAMP_TO_EDGE);
        for (Material* m : { mMaterial, mBlendMaterial, mLitMaterial,
                             mLitPlainMaterial, mRoadMaterial,
                             mGlbMaterial, mGlbFadeMaterial, mGroundMaterial,
                             mPointMaterial, mCloudMaterial, mBurstMaterial }) {
            if (m && m->hasParameter("gradeLut")) {
                m->setDefaultParameter("gradeLut", mGradeLut, gs);
            }
        }
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
    mHasTrack = true;
    // Sky: flat daylight blue behind the gradient dome (which the fog dissolves
    // into) — a backstop for the sliver the dome doesn't cover.
    //
    // PRE-GRADED, because Filament's skybox material writes its constant colour
    // straight out and cannot include ttp_grade.inc. Left linear it is the one
    // surface in the frame that skips the encode, and it shows up as a band of
    // the wrong blue along the horizon where the dome stops.
    {
        const float3 sky = gradeSrgb(float3{ 0.53f, 0.78f, 0.92f });
        mSkybox = Skybox::Builder()
                .color(float4{ sky, 1.0f })
                .build(*mEngine);
    }
    mScene->setSkybox(mSkybox);
    return buildTrackScene(roster, geo, theme, wear);
}
