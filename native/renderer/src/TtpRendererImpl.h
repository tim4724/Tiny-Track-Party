#pragma once
#include "TtpRenderer.h"

#include <filament/Camera.h>
#include <filament/Engine.h>
#include <filament/Exposure.h>
#include <filament/IndirectLight.h>
#include <filament/LightManager.h>
#include <filament/IndexBuffer.h>
#include <filament/InstanceBuffer.h>
#include <filament/Material.h>
#include <filament/MaterialInstance.h>
#include <filament/RenderableManager.h>
#include <filament/RenderTarget.h>
#include <filament/Renderer.h>
#include <filament/Scene.h>
#include <filament/Skybox.h>
#include <filament/Texture.h>
#include <filament/TextureSampler.h>
#include <filament/SwapChain.h>
#include <filament/TransformManager.h>
#include <filament/VertexBuffer.h>
#include <filament/View.h>
#include <filament/Viewport.h>

#include <math/mat4.h>
#include <math/vec2.h>
#include <math/vec3.h>

#include <geometry/SurfaceOrientation.h>

#include <gltfio/AssetLoader.h>
#include <gltfio/FilamentAsset.h>
#include <gltfio/MaterialProvider.h>
#include <gltfio/FilamentInstance.h>
#include <gltfio/ResourceLoader.h>
#include <gltfio/TextureProvider.h>
#include <gltfio/materials/uberarchive.h>

#include <utils/EntityManager.h>
#include <utils/NameComponentManager.h>

#include <algorithm>
#include <cmath>
#include <chrono>
#include <cstring>
#include <functional>
#include <limits>
#include <string>

using namespace filament;
using namespace filament::math;

namespace {

// THERE IS NO SCENE PAYLOAD ANY MORE, and the way that happened is worth
// keeping. Up to v15 a "track.bin" buffer carried the whole built track —
// samples, furniture, pillars, berms — serialized by a second, JS
// implementation of the track builder that ran in the browser on every race.
// v16 dropped that (the renderer meshes from the ttp::RaceTrack the sim itself
// is racing on — see fillGeometry) but still carried the resolved biome, which
// the browser authored. v17 dropped that too (the palette is C++ data now,
// libttp-runtime/ttp/theme.h, resolved from the track's own cup), leaving one
// version-stamped byte layout for the last thing the shell genuinely supplies:
// who is in this race and what their cars look like.
//
// That last remnant is gone as well. It was a hand-rolled encoder in JS and a
// hand-rolled parser here, agreeing by comment, which every future shell would
// have had to reimplement byte for byte — and no fixture in the tree could see
// a disagreement, because nothing ever recorded a track.bin. The roster arrives
// as TtpRosterCar structs (ttp_render.h), parsed once by libttp-runtime, and
// the biome as a ttp::rt::Theme; buildScene takes both. applyRoster and
// applyTheme below are where each lands on TrackBin.

// Bare-asphalt margin either side of a launch strip, so the road's dashes and
// edge lines stop clear of the chevrons rather than grazing them.
constexpr float kStripMargin = 0.12f;
// The key light's axis — theme.key sits at (2, 12, 1.5), as the JS placed it.
// ONE spelling for the sun entity (buildTrackScene), the shadow camera
// (bakeShadowMap) and the road's baked vertex light (fillRoadLight).
const float3 kToSun = normalize(float3{ 2.0f, 12.0f, 1.5f });
// Cones per oil slick. Fixed: no shipped track authors a coned oil, and the
// codegen refuses one rather than dropping the field silently.
constexpr uint32_t kOilCones = 4;

// Lawn base — makeLawnTexture's flat ground colour (#6aa84f); the stripe/grain
// texture detail is later work.
constexpr uint32_t LAWN_SRGB = 0x6aa84f;
// Sky-dome radius. The JS dome sits at 420, but Filament's fog is CAMERA-
// relative: chase cams roam up to ~100u from the origin, so sky content in a
// 405 band could pass within the 400 fog cutoff of a cell's camera and render
// FOGGED (a pale wedge over the track — the JS clouds/balloon are fog:false).
// The dome scales up (its gradient is directional — screen-identical) and the
// unfogged band moves to SKY_BAND so no camera ever sees sky content closer
// than the cutoff.
constexpr float SKY_R = 600.0f;
constexpr float SKY_BAND = 520.0f; // clouds/balloon push-out radius (min camera distance ≈ 420)

// sRGB 0xrrggbb → linear float3, matching THREE.Color's conversion — the JS
// ribbon feeds LINEAR vertex colours, and parity depends on doing the same.
inline float srgbChannel(float c) {
    return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f);
}
inline float3 srgbToLinear(uint32_t rgb) {
    return { srgbChannel(((rgb >> 16) & 0xff) / 255.0f),
             srgbChannel(((rgb >> 8) & 0xff) / 255.0f),
             srgbChannel((rgb & 0xff) / 255.0f) };
}

// Bind the silhouette array to a vroad instance, clamped bilinear. Every
// instance of the road material needs this: a declared sampler must be bound
// even while maskCount is 0.
inline void bindDecalMask(MaterialInstance* mi, Texture* arr) {
    TextureSampler ms(TextureSampler::MinFilter::LINEAR,
            TextureSampler::MagFilter::LINEAR);
    ms.setWrapModeS(TextureSampler::WrapMode::CLAMP_TO_EDGE);
    ms.setWrapModeT(TextureSampler::WrapMode::CLAMP_TO_EDGE);
    mi->setParameter("decalMask", arr, ms);
}

// THE GRADE, on the CPU. MIRRORED FROM ttp_grade.inc — read that file first; it
// carries what moving the grade into the scene materials bought and what it
// cost. Only two colours need this side of it, and both for the same reason:
// they are written by shaders that are FILAMENT'S, not ours, so they cannot
// include the shader half. The skybox (a flat colour behind the gradient dome)
// and the fog (composited inside every surface shader, after material() has
// already returned an sRGB value).
constexpr float kGradeExposure = 1.1f;   // == ttp_grade.inc's TTP_GRADE_EXPOSURE
inline float gradeChannel(float linear) {
    const float c = std::max(linear * kGradeExposure, 0.0f);
    const float s = c <= 0.0031308f ? c * 12.92f
                                    : 1.055f * std::pow(c, 1.0f / 2.4f) - 0.055f;
    return std::min(std::max(s, 0.0f), 1.0f);
}
inline float3 gradeSrgb(const float3& linear) {
    return { gradeChannel(linear.x), gradeChannel(linear.y), gradeChannel(linear.z) };
}
// Canvas `filter: blur(Npx)` is a Gaussian of stddev N. Both soft sprites the
// JS bakes into textures (the wind streak's ellipse, the chimney smoke's disc)
// are only a couple of sigma across, so the r ≫ sigma closed form is no good —
// convolve numerically instead. `inside` is the unblurred shape mask in canvas
// pixels; the result is its coverage at (px, py). The cloud puff was baked here
// too until its shape moved into vcloud.mat, which is where a NEW soft sprite
// should go: a shader evaluates the field per pixel and cannot facet.
struct BlurKernel {
    std::vector<float2> off;
    std::vector<float> w;
    float sum = 0;
    explicit BlurKernel(float sigma, int half = 7) {
        const float step = 3.0f * sigma / half;
        for (int iy = -half; iy <= half; iy++) {
            for (int ix = -half; ix <= half; ix++) {
                const float x = ix * step, y = iy * step;
                const float g = std::exp(-(x * x + y * y) / (2 * sigma * sigma));
                off.push_back({ x, y });
                w.push_back(g);
                sum += g;
            }
        }
    }
    float coverage(float px, float py,
            const std::function<bool(float, float)>& inside) const {
        float acc = 0;
        for (size_t i = 0; i < off.size(); i++) {
            if (inside(px + off[i].x, py + off[i].y)) acc += w[i];
        }
        return sum > 0 ? acc / sum : 0.0f;
    }
};

// boostShades — every boost SURFACE from the one biome accent, so the pad, the
// launch strip, the under-car aura and the streaks stay in lockstep — lives in
// libttp-runtime/ttp/theme.h as ttp::rt::boost_shades, where the frozen theme
// corpus pins it shade by shade. This file used to re-derive it from a local
// mixHex and four retyped coefficients, and the shade that had no pad to keep it
// honest (the wind streak) had drifted to a hardcoded near-white.

inline uint32_t packLinear(const float3& lin, float ao, float alpha = 1.0f) {
    const auto b = [&](float v) -> uint32_t {
        const float x = std::min(1.0f, std::max(0.0f, v));
        return (uint32_t) std::lround(x * 255.0f);
    };
    return (b(alpha) << 24) | (b(lin.z * ao) << 16) | (b(lin.y * ao) << 8) | b(lin.x * ao);
}

} // namespace

// Everything one scene is built from, in one struct: the roster's liveries
// (copied off the shell's TtpRosterCar slots), the biome (copied in from a
// resolved ttp::rt::Theme) and the geometry (taken off the built
// ttp::RaceTrack). All three used to arrive serialized; none of them does now.
struct TtpRenderer::TrackBin {
    struct Sample {
        float3 pos, lat, up;
        float width, s;
        // Travel direction. The JS frame derives lateral = tangent × up
        // (Centerline._sampleInto), so recovering the tangent is up × lateral —
        // cross(lat, up) is its NEGATIVE, which pointed the boost-pad chevrons
        // and the rocket noses backwards.
        float3 tangent() const { return normalize(cross(up, lat)); }
        // Upright frame for a prop sitting `latOff` off the centreline: +Z along
        // travel, +Y the road normal, RIGHT-HANDED. (lat, up, tangent) is
        // left-handed — using it as a basis MIRRORS the model, which flips the
        // winding of every gltfio prop placed with it.
        mat4f basis(float latOff) const {
            return mat4f{ float4{ -lat, 0 }, float4{ up, 0 }, float4{ tangent(), 0 },
                          float4{ pos + lat * latOff, 1 } };
        }
    };
    std::vector<Sample> samples;
    // The ring frames buildRoadMesh swept (uniform arclength step, closed),
    // retained because project() must scan THESE chords — see its comment.
    // deckGap/deckLine are the deck profile's gap and edge-line widths, set by
    // buildRoadMesh from the SAME locals it sweeps with, so project() can
    // reconstruct the deck strip boundaries without a second derivation.
    std::vector<Sample> rings;
    float deckGap = 0, deckLine = 0;
    static constexpr float kDashW = 0.18f;
    std::vector<uint32_t> carColors;
    uint32_t pal[7]; // asphalt line dash kerbA kerbB skirt shoulder (sRGB)
    float kerbW = 0.22f, kerbH = 0.20f;
    bool edgeLines = true;
    std::vector<std::pair<float, float>> zones; // launch strips: (s, halfLen+margin)
    uint32_t sky[3];                            // zenith horizon below (sRGB)
    uint32_t fog = 0x8ecae6;
    uint32_t hillShape = 0;                     // 0 dome, 1 mesa, 2 block, 3 island
    std::vector<uint32_t> hillColors;
    struct Box { float s, lat; };
    std::vector<Box> boxes;                     // item-box anchors
    struct Pad { uint32_t kind; float s, lat, p0, p1; }; // 0 disc(r=p0), 1 strip(hl=p0,hw=p1)
    std::vector<Pad> pads;
    // Scenery palette (theme.scenery) + the exact placement-stream seeds.
    uint32_t scSeed1 = 0, scSeed2 = 0;
    float scDensity = 0, scMixTree = 0, scMixBush = 0;
    struct TreeEntry { uint32_t model; float w, s0, s1; };
    std::vector<TreeEntry> scTrees;
    bool scHasBush = false;
    struct { uint32_t model; float s0, s1, sink; } scBush{};
    std::vector<uint32_t> scRocks{ 0xaaaaaa, 0xb4a898, 0x9aa2a4 };
    float scRockS[2] = { 0.3f, 0.45f };
    uint32_t scModelCount = 0;
    // Trackside props (theme.props): scattered set dressing, bound as
    // prop<i>.glb by slot.
    uint32_t prModelCount = 0;
    float prDensity = 0;
    struct PropStamp { uint32_t slot; float w, s0, s1; bool face; };
    std::vector<PropStamp> prScatter;
    uint32_t lmSeed = 0;                 // landmark stream (51966-FNV)
    std::vector<uint32_t> lmKinds;       // 0 gnome, 1 doghouse, 2 picnic
    float clDensity = 0;                 // clutter (only 'flower' ported)
    struct ClutterKind { uint32_t kind; float w; std::vector<uint32_t> tints; };
    std::vector<ClutterKind> clKinds;
    struct Oil { float s, lat, radius; uint32_t cones; };
    std::vector<Oil> oils;               // authored slick hazards
    // Support structures (track.js buildPoles/buildPillars/buildLoopPoles) and
    // the grass BERMS lofted under raised, non-pillared deck (buildHills).
    struct Pole { float s, lat, radius; };
    std::vector<Pole> poles;             // concrete posts on the road
    struct Pillar { float x, z, baseY, topY, radius; };
    std::vector<Pillar> pillars;         // columns under a raised deck
    struct Post { float x, z, radius; float3 cPos, cUp; };
    std::vector<Post> supportPosts;      // loop shafts (top cut to the deck underside)
    struct BermRing { float cx, cz, lx, lz, halfW, topL, topR; };
    std::vector<std::vector<BermRing>> berms;
    uint32_t structureCol = 0x9aa1b4;    // theme.structure (toy concrete)
    float roadWidth = 5, groundY = 0, length = 0;
    bool closed = true;

    // ── Theme block (everything else the biome dresses) ───────────────────
    // Copied in by applyTheme from an already-RESOLVED ttp::rt::Theme: the
    // per-kind ambient presets, the cloud/bird/plane defaults and the per-track
    // ambient patch are folded in there, so nothing here applies a default.
    uint32_t groundKind = 0;             // 0 lawn 1 sand 2 redrock 3 snow 4 wood
    float fogTune = 1;
    uint32_t keyCol = 0xfff1d0;
    float keyIntensity = 1.4f;
    uint32_t hemiSky = 0xffffff, hemiGround = 0x9aa68f;
    float hemiIntensity = 2.2f;
    uint32_t cloudCount = 8, cloudTint = 0xffffff;
    float cloudOpacity = 0.8f, cloudScale = 1, cloudAspect = 0.42f;
    uint32_t gateCol = 0xffffff;
    uint32_t gantryPylon = 0xff5040, gantryFinial = 0xfff6eb;
    bool gantryHasRings = false;         // rings → the pylon wears lighthouse bands
    uint32_t gantryRings = 0xff5040;
    uint32_t boostCol = 0x22c9b6;
    bool hasWater = false;
    uint32_t waterFoam = 0xffffff, waterShallow = 0x62d3c8;
    uint32_t waterDeep = 0x2596c8, waterWet = 0x7d5f34;
    uint32_t shoreSeed = 0;              // shorelineFn's FNV-1a over the track id
    uint32_t hazeCount = 0, hazeTint = 0xffffff;
    float hazeOpacity = 0.16f, hazeScale = 1;
    uint32_t ambKind = 0;                // 0 none 1 pollen 2 mote 3 sand 4 flake
    uint32_t ambCount = 0, ambTint = 0xffffff;
    float ambSize = 0.3f, ambOpacity = 0.85f;
    float ambFall = 1, ambWind = 0.7f, ambBob = 0, ambBand = 1;
    uint32_t birdCount = 0, birdTint = 0xffffff;
    float birdSize = 2.4f, birdY = 18, birdRc = 120, birdRb = 22;
    float birdSpeed = 0.2f, birdFlap = 0.8f, birdFlapHz = 1.8f, birdDys = 1;
    uint32_t kiteCount = 0;
    float kiteSize = 2.8f, kiteY = 13;
    std::vector<uint32_t> kiteTints;
    bool hasPlane = false;
    uint32_t planeTint = 0xfaf7ec;
    float planeSize = 3.2f, planeY = 22, planeA0 = 1.3f;
    float planeRc = 95, planeRb = 32, planeSpeed = 0.3f, planeBank = 0.4f;
    std::vector<uint32_t> balloonPanels;
    float balloonY = 44, balloonSize = 6;
    bool hasIce = false;
    uint32_t iceSheet = 0xa9d7ee, iceFrost = 0xf0f8fd;
    // Per-scenery-model recolour (theme.scenery[].tint), resolved against each
    // model's own glTF materials to gltfio material NAMES — the untextured
    // Nature-Kit palms and cacti ship in their authored teal/peach and need the
    // biome's palette.
    struct MatTint { std::string name; uint32_t rgb; };
    std::vector<std::vector<MatTint>> modelTints;

    // Arclength interpolation over the samples (shared by the road sweep, the
    // furniture placement and the per-frame banana conform). EXACT port of
    // Centerline._sampleInto: non-uniform Catmull-Rom (cubic Hermite with
    // finite-difference tangents), lateral derived from the curve's tangent —
    // the linear lerp it replaced drifted a few cm on bends, which flipped
    // furniture clearance tests (the gnome never spawned, the doghouse landed
    // on the wrong side) and bowed every painted band between rings.
    // Uniform arclength bins -> first sample index at or before that arclength.
    // frameAt is the hottest function in the renderer (the conformed decals call
    // it three times per vertex, ~500 times per car per frame) and it was
    // binary-searching ~900 samples on every call. The knots are dense and
    // roughly evenly spaced, so a bin lookup lands within a sample or two and the
    // walk below finishes immediately.
    std::vector<uint32_t> sBins;
    static constexpr size_t kSBins = 2048;
    void buildArclengthIndex() {
        sBins.clear();
        const size_t n = samples.size();
        if (n < 2 || !(length > 0)) return;
        sBins.assign(kSBins, 0);
        size_t i = 0;
        for (size_t b = 0; b < kSBins; b++) {
            const float target = (float) b / kSBins * length;
            while (i + 1 < n && samples[i + 1].s <= target) i++;
            sBins[b] = (uint32_t) i;
        }
    }

    Sample frameAt(float s) const {
        const size_t n = samples.size();
        float w = std::fmod(s, length);
        if (w < 0) w += length;
        // Largest index i with samples[i].s <= w (capped at n−1) — _seg().
        size_t i;
        if (!sBins.empty()) {
            size_t b = (size_t) (w / length * (float) kSBins);
            if (b >= kSBins) b = kSBins - 1;
            i = sBins[b];
            while (i + 1 < n && samples[i + 1].s <= w) i++;
        } else {
            size_t lo = 0, hi = n;
            while (lo < hi) { const size_t mid = (lo + hi) / 2; (samples[mid].s <= w) ? lo = mid + 1 : hi = mid; }
            i = (lo == 0) ? 0 : lo - 1; // JS _seg: i stays 0 below the first knot
        }
        const auto idx = [&](long k) { return (size_t) (((k % (long) n) + (long) n) % (long) n); };
        const Sample& pA = samples[idx((long) i - 1)];
        const Sample& pB = samples[i];
        const Sample& pC = samples[idx((long) i + 1)];
        const Sample& pD = samples[idx((long) i + 2)];
        // Unwrap arclengths relative to the segment start so they stay
        // monotonic across the start/finish seam.
        const float sB = pB.s;
        float sA = pA.s, sC = pC.s, sD = pD.s;
        while (sA > sB) sA -= length;
        while (sC < sB) sC += length;
        while (sD < sC) sD += length;
        float h = sC - sB;
        if (h == 0) h = 1e-6f;
        const float u = (w - sB) / h, u2 = u * u, u3 = u2 * u;
        const float dCA = (sC - sA) != 0 ? sC - sA : 1e-6f;
        const float dDB = (sD - sB) != 0 ? sD - sB : 1e-6f;
        const float3 mB = (pC.pos - pA.pos) * (h / dCA);
        const float3 mC = (pD.pos - pB.pos) * (h / dDB);
        const float h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u;
        const float h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
        Sample r;
        r.pos = pB.pos * h00 + mB * h10 + pC.pos * h01 + mC * h11;
        // Derivative of the same curve → tangent; lateral = tangent × up.
        const float g00 = 6 * u2 - 6 * u, g10 = 3 * u2 - 4 * u + 1;
        const float g01 = -6 * u2 + 6 * u, g11 = 3 * u2 - 2 * u;
        const float3 tan = normalize(pB.pos * g00 + mB * g10 + pC.pos * g01 + mC * g11);
        r.up = normalize(mix(pB.up, pC.up, u));
        r.lat = normalize(cross(tan, r.up));
        r.width = pB.width + (pC.width - pB.width) * u;
        r.s = w;
        return r;
    }

    // ── THE DECK AS A SURFACE ────────────────────────────────────────────
    // Every DECK point of the road's cross-section sits at y == 0 in the frame
    // (buildRoadMesh's profile table — the kerbs and skirts are the only ones
    // that leave it), so at each arclength the drivable deck is a straight LINE
    // across, and the whole surface is that line swept along s:
    //
    //     P(s, l) = frameAt(s).pos + frameAt(s).lat * l
    //
    // A RULED surface, and two consequences run through everything that seats a
    // car on it:
    //
    //  - ACROSS the car there is nothing to fit. Two wheels at the same
    //    arclength are exactly coplanar with the deck, at any bank, always.
    //  - ALONG it there is. Where the deck twists, consecutive rulings are SKEW
    //    lines, so the four wheel corners of a rigid body are genuinely not
    //    coplanar and NO pose lands all four. That residual is the wheels' own
    //    travel to absorb, not a pose to solve harder for.
    //
    // This is the SMOOTH surface; the mesh is chords between rings and sags
    // below it (buildRoadMesh's RING STEP note has the measured budget).
    // Seating on the smooth one is deliberate — the faceted one kinks at every
    // ring, and a body posed off it steps once per ring crossing.
    float3 deckPoint(float s, float l) const {
        const Sample f = frameAt(s);
        return f.pos + f.lat * l;
    }

    // dP/ds at (s, l) — the deck's along-track direction AT THAT LATERAL
    // OFFSET, which is not the centreline's tangent once the deck twists or the
    // width tapers. A CENTRAL DIFFERENCE rather than an analytic derivative,
    // and that is the point: `lat(s)` is built from an up that frameAt LERPS
    // between knots, so it kinks at every one and has no derivative there. A
    // difference of a continuous function is continuous, kinks included.
    static constexpr float kDeckH = 0.05f;
    float3 deckTangent(float s, float l) const {
        return (deckPoint(s + kDeckH, l) - deckPoint(s - kDeckH, l)) * (0.5f / kDeckH);
    }

    // Foot of a world point on that surface, as (s, l), refined in place from a
    // seed the caller already has — for a wheel that is its car's own track
    // spot, which is never more than a body length away.
    //
    // GAUSS-NEWTON, AND THAT IS THE POINT. project() below answers the same
    // question by picking the nearest ring segment, and a pick can FLIP between
    // two almost-equal candidates from one frame to the next. That is tolerable
    // for a decal (it re-packs every frame anyway) and not for geometry: the
    // previous attempt at seating the car fitted its body plane to four
    // project() probes, and the flips arrived as the whole car's lean wobbling
    // — about 0.4 degrees a frame on Skyline, which is what got it reverted.
    // This has no branch to flip: it is a smooth function of p.
    //
    // dP/dl is `lat` and is UNIT, so the lateral half is exact in one step and
    // only s iterates. `s` stays in the caller's UNWRAPPED frame (frameAt wraps
    // internally), so a car near the start line does not need seam handling.
    //
    // THE PER-STEP CLAMP IS NOT A TUNING CONSTANT. Where the deck curves
    // tightly, a lateral offset approaching the corner's own radius makes the
    // offset curve nearly stall — |dP/ds| collapses, and a Gauss-Newton step
    // that divides by it explodes. Measured on cloverleaf: one iteration jumped
    // 21u of arclength, and the next two "converged" onto a different part of
    // the circuit, which arrived as a single frame of 58 degrees of lean on an
    // otherwise smooth hairpin. It bounds ONE step, not the total excursion —
    // the iterations that follow can still walk further, which they need to,
    // because a foot's arclength offset exceeds its world offset by the same
    // fanning factor (measured up to ~2.2x on the catalogue). So a legitimate
    // solve is unaffected and a diverging one cannot leave the neighbourhood.
    // With it, the worst lean over the catalogue is 3.4 degrees.
    void deckFoot(const float3& p, float& s, float& l) const {
        constexpr float kMaxStep = 1.0f;   // world-ish units of arclength
        for (int it = 0; it < 6; it++) {
            const Sample f = frameAt(s);
            l += dot(p - (f.pos + f.lat * l), f.lat);
            const float3 ds = deckTangent(s, l);
            const float d2 = dot(ds, ds);
            if (d2 < 1e-9f) break;
            const float raw = dot(p - (f.pos + f.lat * l), ds) / d2;
            const float step = std::min(kMaxStep, std::max(-kMaxStep, raw));
            s += step;
            // Converged. The iteration is a contraction, so stopping here costs
            // less than the tolerance — and it is what keeps the ordinary case
            // (a smooth deck, two steps) off the six-iteration worst case.
            if (std::fabs(step) < 1e-4f) break;
        }
    }

    // Ring index nearest an arclength — project()'s hint currency, for a caller
    // that knows its own s but has never projected (the skid trails seed from
    // the car, which no longer projects for its seat).
    int ringHint(float s) const {
        const int n = (int) rings.size();
        if (n < 1 || !(length > 0)) return -1;
        float w = std::fmod(s, length);
        if (w < 0) w += length;
        const int k = (int) (w / length * (float) n);
        return k < 0 ? 0 : (k >= n ? n - 1 : k);
    }

    // Foot of `p` on the RENDERED road: used to re-express a car-local point
    // as (arclength, lateral) so flat decals can be CONFORMED to the deck —
    // the JS raycasts the rendered road for the same result.
    //
    // The answer must agree with what the RASTERIZER computes from uv0, or
    // the difference oscillates under a driving car at knot-crossing rate —
    // the shadow's jiggle, a few cm on the trick tracks. Three approximations
    // were peeled off it in turn, each one visibly smaller and each still
    // visible (measured on the playroom catalogue with points generated ON
    // the mesh, truth by construction):
    //
    //  - WHICH CURVE: the raw contract samples are chords of a curve the
    //    mesh never draws (it sweeps the cubic THROUGH those knots) — worst
    //    0.043u at 1.6u off centre. Hence the ring polyline.
    //  - WHICH FOOT: the deck's iso-arclength lines run parallel to the ring
    //    cross-sections, which FAN on a bend; a perpendicular foot onto the
    //    chord is exact on the centreline only — still 0.029u off centre.
    //    Hence the ring-plane blend, d0/(d0−d1) with the ring tangents as
    //    normals: exactly 0 and 1 AT the rings, continuous across them.
    //  - WHICH FIELD: uv0 is interpolated linearly PER TRIANGLE, and the wide
    //    road strips make skewed triangles whose field kinks at each diagonal
    //    — even the plane blend is still ~0.02u off mid-strip. Hence the
    //    exact evaluation at the end: same quad, same diagonal, same
    //    barycentric interpolation as the GPU, zero at deck level by
    //    construction.
    //
    // `hint` is the caller's ring index from its previous projection (-1 to
    // start). A car crosses a fraction of a ring per frame, so the scan is a
    // small window around the hint; the full sweep below runs only on the
    // first frame, after a respawn, or when the windowed winner looks wrong.
    // (It used to also hand back the 3D deck point and the facet ridge
    // height, for callers placing GEOMETRY against the road — every decal is
    // road-shader paint now, so (outS, outLat) is the whole answer.)
    void project(float3 p, const float3& up, float& outS, float& outLat,
            int* hint = nullptr) const {
        const std::vector<Sample>& knots = rings.empty() ? samples : rings;
        const size_t n = knots.size();
        if (n < 2) { outS = 0; outLat = 0; return; }
        float bestD = 1e30f, bestT = 0;
        size_t bestI = 0;
        const auto trySeg = [&](size_t i) {
            const Sample& a = knots[i];
            const float3 ab = knots[(i + 1) % n].pos - a.pos;
            const float len2 = dot(ab, ab);
            float t = len2 > 1e-12f ? dot(p - a.pos, ab) / len2 : 0.0f;
            t = std::min(1.0f, std::max(0.0f, t));
            const float3 d = p - (a.pos + ab * t);
            const float dd = dot(d, d);
            if (dd < bestD) { bestD = dd; bestI = i; bestT = t; }
        };
        // ±12 rings ≈ ±6u of track: an order of magnitude past what a car
        // covers in a frame, cheap enough that widening it costs nothing.
        constexpr long W = 12;
        bool solved = false;
        if (hint && *hint >= 0 && (size_t) *hint < n) {
            for (long k = -W; k <= W; k++)
                trySeg((size_t) ((((long) *hint + k) % (long) n + (long) n) % (long) n));
            // Trust the window only if the winner sits strictly INSIDE it and
            // within a deck's reach of the car (8u — clear of any jump apex):
            // a respawn moves the car half a circuit in one frame, and a
            // winner pressed against the window's edge means the true foot is
            // likely beyond it.
            long rel = (long) bestI - *hint;
            if (rel > (long) n / 2) rel -= (long) n;
            if (rel < -(long) n / 2) rel += (long) n;
            solved = (rel < 0 ? -rel : rel) < W && bestD < 64.0f;
        }
        if (!solved) {
            bestD = 1e30f;
            // Where the track crosses over itself — a loop, a bridge — the
            // closest segment in space can be the OTHER deck, and the decal
            // snaps between the two branches as the car drives. Only segments
            // whose road normal agrees with the caller's rules them out. (The
            // windowed path needs no such filter: continuity with the last
            // frame IS the branch choice, banked deck included.)
            for (int pass = 0; pass < 2 && bestD > 1e29f; pass++) {
                for (size_t i = 0; i < n; i++) {
                    if (pass == 0 && dot(knots[i].up, up) < 0.3f) continue; // wrong branch
                    trySeg(i);
                }
            }
        }
        // The perpendicular pick is only the coarse locator. Resolve the quad
        // by ring-plane SIDEDNESS: the ring planes (normal = ring tangent)
        // contain the ring lines, so d0 >= 0 && d1 < 0 is exactly "between
        // this quad's two edge lines". The nearest chord can disagree right
        // at a ring, and evaluating the neighbour quad's (differently tilted)
        // strip planes there is what threw the canyon hairpins off.
        if (&knots == &rings) {
            for (int walk = 0; walk < 4; walk++) {
                const Sample& wa = knots[bestI];
                const Sample& wb = knots[(bestI + 1) % n];
                if (dot(p - wa.pos, wa.tangent()) < 0) bestI = (bestI + n - 1) % n;
                else if (dot(p - wb.pos, wb.tangent()) >= 0) bestI = (bestI + 1) % n;
                else break;
            }
        }
        if (hint) *hint = (int) bestI;
        const Sample& a = knots[bestI];
        const Sample& b = knots[(bestI + 1) % n];
        const float d0 = dot(p - a.pos, a.tangent());
        const float d1 = dot(p - b.pos, b.tangent());
        float t = (d0 - d1) != 0 ? d0 / (d0 - d1) : bestT;
        t = std::min(1.0f, std::max(0.0f, t));
        float sB = b.s;
        if (sB < a.s) sB += length; // start/finish seam
        // Ring-plane blend: continuous everywhere, and the fallback answer
        // when the exact evaluation below has nothing to stand on.
        outS = a.s + (sB - a.s) * t;
        const float3 q = a.pos + (b.pos - a.pos) * t;
        const float3 latS = normalize(mix(a.lat, b.lat, t));
        outLat = dot(p - q, latS);
        if (&knots != &rings || deckGap <= 0) return;

        // EXACT FIELD EVALUATION. The rasterizer interpolates uv0 linearly
        // PER TRIANGLE, and on a bend the wide road strips make skewed
        // triangles whose field kinks at every diagonal — against that field
        // even the plane blend is off by up to ~0.02u mid-strip (measured,
        // playroom catalogue), a sawtooth at ring-crossing rate under a
        // cornering car. So finish the way the GPU does: drop p onto the deck
        // ALONG THE SMOOTH ROAD UP (per-triangle normals would turn ride
        // height into a fresh per-triangle sawtooth), find the strip quad,
        // split it by the same diagonal buildRoadMesh winds — (i,a)-(i+1,b) —
        // and interpolate the corners' own uv0. Exact at deck level by
        // construction; a ride height above it costs height x up-drift,
        // smooth by construction.
        const float3 upS = normalize(mix(a.up, b.up, t));
        const float hA = a.width * 0.5f, hB = b.width * 0.5f;
        const auto stripBounds = [&](float h, float* o) {
            o[0] = -h; o[1] = -h + deckGap; o[2] = -h + deckGap + deckLine;
            o[3] = -kDashW / 2; o[4] = kDashW / 2;
            o[5] = h - deckGap - deckLine; o[6] = h - deckGap; o[7] = h;
        };
        float bA[8], bB[8];
        stripBounds(hA, bA);
        stripBounds(hB, bB);
        const float l = std::min(bA[7] - 1e-4f, std::max(bA[0] + 1e-4f, outLat));
        int j = 0;
        while (j < 6 && l > bA[j + 1]) j++;
        const float3 A = a.pos + a.lat * bA[j];
        const float3 B = a.pos + a.lat * bA[j + 1];
        const float3 C = b.pos + b.lat * bB[j + 1];
        const float3 D = b.pos + b.lat * bB[j];
        // Drop p along -upS onto the triangle's plane, then barycentric
        // weights of the hit. w[1] is the middle vertex's weight — its sign
        // against the A-C diagonal picks the triangle, as rasterization does.
        float w0, w1, w2;
        const auto dropBary = [&](const float3& T0, const float3& T1, const float3& T2) {
            const float3 nrm = cross(T1 - T0, T2 - T0);
            const float den = dot(upS, nrm);
            if (std::fabs(den) < 1e-7f) return false; // deck edge-on to up: keep the blend
            const float3 hit = p - upS * (dot(p - T0, nrm) / den);
            const float3 v0 = T1 - T0, v1 = T2 - T0, v2 = hit - T0;
            const float d00 = dot(v0, v0), d01 = dot(v0, v1), d11 = dot(v1, v1);
            const float d20 = dot(v2, v0), d21 = dot(v2, v1);
            const float dn = d00 * d11 - d01 * d01;
            if (std::fabs(dn) < 1e-9f) return false;
            w1 = (d11 * d20 - d01 * d21) / dn;
            w2 = (d00 * d21 - d01 * d20) / dn;
            w0 = 1.0f - w1 - w2;
            return true;
        };
        if (!dropBary(A, B, C)) return;
        if (w1 >= 0) {
            outS = (w0 + w1) * a.s + w2 * sB;
            outLat = w0 * bA[j] + w1 * bA[j + 1] + w2 * bB[j + 1];
        } else if (dropBary(A, C, D)) {
            outS = w0 * a.s + (w1 + w2) * sB;
            outLat = w0 * bA[j] + w1 * bB[j + 1] + w2 * bB[j];
        }
    }
};



// The generic ground-shadow mask (the decalMask array's fallback layer): a
// superellipse footprint with the JS bake's penumbra.
//
// SceneRenderer renders each car model top-down into a 128-wide target and
// blurs the result by round(128 × 0.022) ≈ 3 px — "a crisp shadow edge near the
// loop's hard cast shadow, not a wide soft ring", as the source puts it. That
// is ~5% of the half-width, so the shape has to come from a texture.
//
// The one thing this does NOT reproduce is the outline: three's is the model's
// real silhouette (cabin narrow, wheels poking out), ours a superellipse fitted
// to the same footprint. Same size, same softness, rounder corners.
// The pixels, at any resolution: a superellipse over 1/1.45 of the frame
// (SHADOW_OVERSCAN) with the JS bake's blur.
inline std::vector<float> superellipseMaskPixels(int TW, int TH) {
    std::vector<float> a((size_t) TW * TH, 0.0f);
    // Footprint occupies 1/1.45 of the quad (SHADOW_OVERSCAN), leaving the rest
    // as room for the blur tail — exactly how the JS frames its bake.
    const float hw = (TW * 0.5f) / 1.45f, hl = (TH * 0.5f) / 1.45f;
    for (int y = 0; y < TH; y++) {
        for (int x = 0; x < TW; x++) {
            const float dx = std::fabs(x + 0.5f - TW * 0.5f) / hw;
            const float dz = std::fabs(y + 0.5f - TH * 0.5f) / hl;
            const float q = std::cbrt(dx * dx * dx + dz * dz * dz); // 1 at the edge
            a[(size_t) y * TW + x] = q <= 1.0f ? 1.0f : 0.0f;
        }
    }
    // Separable box blur ×3 ≈ the canvas filter's Gaussian, at the same radius.
    const int R = std::max(2, (int) std::lround(TW * 0.022f));
    std::vector<float> tmp(a.size());
    const auto pass = [&](std::vector<float>& src, std::vector<float>& dst, bool horiz) {
        for (int y = 0; y < TH; y++)
            for (int x = 0; x < TW; x++) {
                float s = 0; int n = 0;
                for (int k = -R; k <= R; k++) {
                    const int px = horiz ? x + k : x, py = horiz ? y : y + k;
                    if (px < 0 || px >= TW || py < 0 || py >= TH) { n++; continue; } // outside = 0
                    s += src[(size_t) py * TW + px];
                    n++;
                }
                dst[(size_t) y * TW + x] = s / (float) n;
            }
    };
    for (int i = 0; i < 3; i++) { pass(a, tmp, true); pass(tmp, a, false); }
    return a;
}


// A prop contact blob's ink and rest opacity (makeBlobShadowTexture), shared
// by the item-box stamps below, the box collect fade, and the banana/rocket
// stamps in the render loop.
constexpr float kBlobShadowAlpha = 0.4f;


// The car ground shadow's ink (the JS UNDER_AO_COLOR) and base opacity, for
// the masked road-shader decal. 0.35 is the measured 35% ambient dip: blocking
// the sun leaves a surface its ambient, which on these rigs spans 32% to 36%
// of lit (34% measured on skysnake). The JS's UNDER_AO_OPACITY 0.55 was a 56%
// dip, picked when cast shadows were a vague haze; against a sharp one the car
// looked pressed into a hole. It also sits the car between its siblings, the
// prop blobs at 0.40 and the lawn discs at 0.30.
inline const float3 kCarBlobInk = srgbToLinear(0x171513);

constexpr float kCarBlobAO = 0.35f;

// The hybrid shadow LOD's band, in world units of distance to the closest
// ACTIVE camera (renderCars). Inside kShadowLodNear a car's contact shadow is
// the true MASKED baked silhouette — near is where its car-shape reads, and
// where the carShadow layer's ~8 texels/u visibly cannot carry it (the blob
// under the player's own car was the tell). Past kShadowLodFar the shadow is
// the texture raster alone; between, the two crossfade with complementary
// alphas. 14u keeps the own car (~2u) and adjacent rivals silhouetted while
// bounding the masked list at [4].
//
// Note the two distances answer different questions and both are needed. The
// band above is against the CLOSEST camera, because that is who the fade has
// to look right to. WHICH cars get a masked entry at all is decided against
// the camera doing the picking, taking turns — see TtpRenderer.h's
// kMaxMaskedDeckDecals for why a single global rank is starvable.
constexpr float kShadowLodNear = 10.0f;
constexpr float kShadowLodFar = 14.0f;

// The carShadow layer's cap on summed coverage (maskInk.w — also the tap's
// enable). The raster accumulates with saturating ADD (the rubber's idiom),
// where the old masked loop composited two overlapped stamps as a mix-of-mixes
// — at full wheel load, 1-(1-0.402)² = 0.642 (0.402 = kCarBlobAO deepened by
// the 0.08/0.55 load term). Capping the tap there keeps a loaded pile-up as
// dark as it used to be instead of letting addition run it toward black;
// three-deep pile-ups still read a shade lighter than the loop's 0.78.
constexpr float kCarShadowCap = 0.642f;
