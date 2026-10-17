#pragma once
#include "TtpRenderer.h"

#include <filament/Camera.h>
#include <filament/Engine.h>
#include <filament/Exposure.h>
#include <filament/Fence.h>
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
#include <utils/Log.h>
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
// ONE spelling for the sun entity (buildStatic), the shadow camera
// (bakeShadowMap) and the receivers' baked vertex light (bakeVertexLight).
const float3 kToSun = normalize(float3{ 2.0f, 12.0f, 1.5f });
// Cones per oil slick. Fixed: no shipped track authors a coned oil, and the
// codegen refuses one rather than dropping the field silently.
constexpr uint32_t kOilCones = 4;

// Lawn base — makeLawnTexture's flat ground colour (#6aa84f); the stripe/grain
// texture detail is later work.
constexpr uint32_t LAWN_SRGB = 0x6aa84f;
// Where the distance fog stops (fogFor's cutOffDistance, ttp_fog.inc's far
// exit): sky content beyond it renders unfogged, the JS clouds/balloon's
// fog:false. Inside it the fog is already near-opaque, so a sprite that crosses
// it does not fade, it FLIPS to the fog colour — the sky colour, on most
// biomes — and vanishes.
constexpr float FOG_CUTOFF = 400.0f;
// Clouds/balloon push-out radius: past FOG_CUTOFF from a camera near the
// origin, inside CAM_FAR from it.
//
// THE BAND IS MEASURED FROM THE ORIGIN, FOG AND THE FAR PLANE FROM THE EYE. The
// chase cam roams to the circuit's rim, over 170 u out on the big tracks (nine
// of the twenty catalogue tracks pass 115 u). So on the far side of the origin a
// sprite sits PAST the 600 u far plane and is sliced by it as the car drives (a
// cloud wiping in and out with a hard edge), and on the NEAR side it sits
// INSIDE the fog cutoff and flips to the sky colour (a cloud that disappears
// and comes back as the car turns; seen on the Backyard cup, where three of the
// four tracks roam past 130 u). The band only PLACES a sprite;
// orientCellBillboards then slides it along its own sight line for each cell,
// at the same angular size, until its whole extent is past FOG_CUTOFF and
// inside farZ.
//
// THE SKY DOME IS NOT SUBJECT TO THIS RULE (TtpRenderer.h, mSkyDome): it is
// centred on each cell's camera and scaled to that view's far plane, so its
// distance from the eye is fixed and no far plane can clip it. Pushing a
// world-origin dome out to 600 for this same fog rule is what used to punch a
// moving circular hole in the sky.
constexpr float SKY_BAND = 520.0f;

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

// The sky's authored colours, decoded the way the shipped JS pipeline does:
// TWICE. paintSky pre-linearises what the pipeline then linearises again, which
// renders a deeper sky than the raw hexes — measured against the live pane.
// Parity means reproducing the shipped transfer, quirk included. Shared because
// the skybox bake and its flat fallback must not drift apart.
inline float3 skyLinear(uint32_t rgb) {
    const float3 once = srgbToLinear(rgb);
    return float3{ srgbChannel(once.x), srgbChannel(once.y), srgbChannel(once.z) };
}

// THE SCENE IS AUTHORED IN DISPLAY SPACE. Every colour a scene material reads
// — a vertex colour, a texture's bytes, a colour parameter, a baked light term
// — is already what the panel shows (sRGB, pre-exposed), and the fragment
// stage only MULTIPLIES and MIXES. No material encodes anything per fragment.
//
// Why that is exact where it matters: the sRGB curve is a power law (its toe
// and offset aside), so enc(a * b) == enc(a) * enc(b): a surface's light and
// its albedo can each be encoded on their own and multiplied in the shader.
// The exposure rides the LIGHT (displayLight), never the albedo (encodeSrgb),
// so a product carries it exactly once; a colour drawn as-is, by an unlit
// material, carries it itself (gradeSrgb / packShown). A light term is NOT
// clamped at 1 — a sunlit face reaches 1.1x and the clip happens where it
// always did, on the product, in the 8-bit scene buffer.
//
// What is only NEAR exact: the sRGB toe and the 0.055 offset make the product
// of two encodes differ from the encode of the product by a few levels in the
// darks (a 0.02 albedo under full light: +4 of 255), and a static receiver's
// light sum is mixed through its shadow map in display space, which moves the
// middle of a penumbra by 3-6 levels under this game's soft sun. Both were
// judged on paused frames against the per-fragment grade they replaced and
// read at the noise floor (docs/perf/androidtv-frame-map.md, 2026-10-17).
//
// What it replaced: `ttp_grade.inc`, three dependent LUT taps per shaded
// fragment, 0.8 ms of a four-player 720 heavy second on the Android box. The
// same reasoning is why the skybox and the fog colour were always pre-graded
// here: Filament's own shaders consume them and could not include ours.
// "Grade" in these names is the display exposure the encode carries — what the
// per-fragment grade used to apply — and the names stayed with the constant.
constexpr float kGradeExposure = 1.1f;   // == ttp_shade.inc's TTP_GRADE_EXPOSURE
// linear → sRGB, no exposure, NOT clamped above 1: a colour the shader
// MULTIPLIES by a light term (an albedo, a tint, a shadow's ink). A factor over
// 1 (kBoxTint) stays over 1.
inline float encodeSrgb(float linear) {
    const float c = std::max(linear, 0.0f);
    return c <= 0.0031308f ? c * 12.92f : 1.055f * std::pow(c, 1.0f / 2.4f) - 0.055f;
}
inline float3 encodeSrgb(const float3& linear) {
    return { encodeSrgb(linear.x), encodeSrgb(linear.y), encodeSrgb(linear.z) };
}
// An authored sRGB hex as the albedo the shader wants: its own bytes.
inline float3 srgbUnit(uint32_t rgb) {
    return { ((rgb >> 16) & 0xff) / 255.0f, ((rgb >> 8) & 0xff) / 255.0f, (rgb & 0xff) / 255.0f };
}
// A LIGHT term: exposed, encoded, and NOT clamped (see above).
inline float displayLight(float linear) { return encodeSrgb(linear * kGradeExposure); }
inline float3 displayLight(const float3& linear) {
    return { displayLight(linear.x), displayLight(linear.y), displayLight(linear.z) };
}
// A colour SHOWN as it is (an unlit vertex colour, the skybox, the fog):
// exposed, encoded, clamped.
inline float gradeChannel(float linear) { return std::min(displayLight(linear), 1.0f); }
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

// The vertex colour, packed ABGR — in DISPLAY SPACE (above). Two spellings,
// because which one a mesh wants is a fact about the material that draws it:
//   packAlbedo — a colour a light term multiplies in the shader (vlit), in the
//                receivers (vground, vroad), or at build (a bakeLight sheet,
//                which buildMesh folds into packShown); `ao` darkens it in
//                linear before the encode.
//   packShown  — a colour drawn as it is by an unlit material (vcolor, vblend,
//                vcloud, vpoint, vburst, vsky): exposed, encoded, clamped.
inline uint32_t packAbgr(const float3& enc, float alpha) {
    const auto b = [](float v) -> uint32_t {
        return (uint32_t) std::lround(std::min(1.0f, std::max(0.0f, v)) * 255.0f);
    };
    return (b(alpha) << 24) | (b(enc.z) << 16) | (b(enc.y) << 8) | b(enc.x);
}
inline uint32_t packAlbedo(const float3& lin, float ao, float alpha = 1.0f) {
    return packAbgr(encodeSrgb(lin * ao), alpha);
}
inline uint32_t packShown(const float3& lin, float ao, float alpha = 1.0f) {
    return packAbgr(gradeSrgb(lin * ao), alpha);
}
// The inverse of packAlbedo's encode, for buildMesh's fold: the sRGB bytes
// back to linear, where the light multiplies.
inline float3 unpackAlbedo(uint32_t abgr) {
    return { srgbChannel((float) (abgr & 0xff) / 255.0f),
             srgbChannel((float) ((abgr >> 8) & 0xff) / 255.0f),
             srgbChannel((float) ((abgr >> 16) & 0xff) / 255.0f) };
}

// WHERE A BUILD'S TIME GOES, as one log line of named phases. A scene build
// blocks the Android shell's main thread, and that shell's own step timing
// proved nearly all of it is inside the renderer — so the phases have to be
// nameable from in here or not at all. Diagnostic only: a clock read per phase
// on a path that runs once per scene.
struct PhaseLog {
    // A BUILD'S PHASE ENDS BY HANDING ITS COMMANDS TO THE DRIVER THREAD. Filament
    // queues a build's uploads until something flushes, and nothing does until
    // the build returns — so the driver sat idle through the whole build and then
    // uploaded all of it in front of the first frame. flush() does not wait.
    filament::Engine* engine = nullptr;
    std::vector<std::pair<const char*, double>> phases;
    std::chrono::steady_clock::time_point at = std::chrono::steady_clock::now();
    void mark(const char* name) {
        if (engine) engine->flush();
        const auto now = std::chrono::steady_clock::now();
        phases.emplace_back(name, std::chrono::duration<double, std::milli>(now - at).count());
        at = now;
    }
    void print(const char* head) const {
        double total = 0;
        auto& line = utils::slog.i << head;
        for (const auto& p : phases) {
            line << " " << p.first << " " << (int) (p.second + 0.5);
            total += p.second;
        }
        line << " | total " << (int) (total + 0.5) << " ms" << utils::io::endl;
    }
};

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
    std::vector<int32_t> carModels; // per slot: TtpRosterCar::carIndex
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
    std::vector<float> kickers;          // each kicker ramp's FOOT arclength
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
        // i is in [0, n-1] on both paths, so one conditional step wraps each
        // neighbour, with no integer divide on this per-query path.
        const size_t iA = i == 0 ? n - 1 : i - 1;
        size_t iC = i + 1;
        if (iC >= n) iC -= n;
        size_t iD = iC + 1;
        if (iD >= n) iD -= n;
        const Sample& pA = samples[iA];
        const Sample& pB = samples[i];
        const Sample& pC = samples[iC];
        const Sample& pD = samples[iD];
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

    // The deck's seven strips at a ring of half-width h, as the EIGHT lat
    // bounds buildRoadMesh sweeps (gap, line, road, dash, road, line, gap):
    // the uv0.y every deck vertex of that ring carries. One derivation for
    // project() below and for deckTriAt, which must agree with it exactly.
    void deckStripBounds(float h, float* o) const {
        o[0] = -h; o[1] = -h + deckGap; o[2] = -h + deckGap + deckLine;
        o[3] = -kDashW / 2; o[4] = kDashW / 2;
        o[5] = h - deckGap - deckLine; o[6] = h - deckGap; o[7] = h;
    }

    // THE MESH'S OWN uv0 -> WORLD MAP, one triangle at a time. The road is
    // ring quads split by the (i,a)-(i+1,b) diagonal, and the GPU interpolates
    // uv0 linearly over each triangle, so world position is AFFINE in (s, lat)
    // inside one and kinks at every edge. This answers which triangle holds
    // a track-space point and hands back its three corners in both spaces, so
    // a caller can evaluate that affine map — the inverse of project()'s
    // exact field, and the only placement a track-space layer can be written
    // in that lands where the shader reads it. (project() is the forward
    // direction: world -> the (s, lat) the rasterizer would interpolate.)
    //
    // `ring`/`strip`/`side` are the triangle's identity, so a caller walking
    // texels can tell a change of triangle from the previous texel's. False
    // off the deck — |lat| past the ring's outer bound, or inside a strip the
    // profile gives zero width — where no fragment carries that uv.
    struct DeckTri {
        int ring = -1, strip = -1, side = 0;
        float2 U[3];   // (s, lat) — uv0 as the vertices carry it
        float3 W[3];   // the same three vertices in world space
    };
    // One ring quad's worth of the map: the two rings' uv0.x, their eight
    // strip bounds and their world frames. A caller walking texels keeps one
    // and re-picks triangles inside it, since a stamp's row crosses a ring
    // every few texels but a ring only every few rows.
    struct DeckQuad {
        int ring = -1;
        float sa = 0, sb = 0;
        float bA[8], bB[8];
        float3 posA, latA, posB, latB;
    };
    int deckRingAt(float sWrapped) const {
        const size_t n = rings.size();
        if (n < 2 || !(length > 0)) return -1;
        int i = (int) (sWrapped / length * (float) n);
        return i < 0 ? 0 : (i >= (int) n ? (int) n - 1 : i);
    }
    void deckQuadAt(int i, DeckQuad& q) const {
        const size_t n = rings.size();
        const Sample& a = rings[(size_t) i];
        const Sample& b = rings[(size_t) i + 1 == n ? 0 : (size_t) i + 1];
        q.ring = i;
        // uv0.x is the UNWRAPPED ring index over N (buildRoadMesh's uIdx), so
        // the seam quad runs to exactly L. Same expression, same rounding.
        q.sa = (float) i / n * length;
        q.sb = (float) (i + 1) / n * length;
        deckStripBounds(a.width * 0.5f, q.bA);
        deckStripBounds(b.width * 0.5f, q.bB);
        q.posA = a.pos; q.latA = a.lat;
        q.posB = b.pos; q.latB = b.lat;
    }
    // The triangle of quad `q` holding (sWrapped, lat): false off the deck.
    bool deckTriIn(const DeckQuad& q, float sWrapped, float lat, DeckTri& out) const {
        const float span = q.sb - q.sa;
        const float t = span > 0 ? std::min(1.0f, std::max(0.0f, (sWrapped - q.sa) / span)) : 0.0f;
        // The strip whose two SLANTED uv edges (the bounds lerp ring to ring
        // where the width tapers) bracket lat at this t.
        int j = -1;
        for (int k = 0; k < 7; k++) {
            const float lo = q.bA[k] + (q.bB[k] - q.bA[k]) * t;
            const float hi = q.bA[k + 1] + (q.bB[k + 1] - q.bA[k + 1]) * t;
            if (lat >= lo && lat < hi) { j = k; break; }
        }
        if (j < 0) return false;
        // Which side of the diagonal A-C: ABOVE it (lat past the diagonal's
        // lat at this t) is B's side, triangle (A, B, C); below is (A, C, D)
        // — the two the soup winds, in that vertex order. On the diagonal
        // both agree, so the tie goes to (A, B, C).
        deckTri(q, j, lat >= deckDiagonalLat(q, j, t) ? 0 : 1, out);
        return true;
    }
    // The lat at which strip j's diagonal A-C crosses the ring-parameter t.
    float deckDiagonalLat(const DeckQuad& q, int j, float t) const {
        return q.bA[j] + (q.bB[j + 1] - q.bA[j]) * t;
    }
    // Strip j's triangle on `side` (0 = (A, B, C), 1 = (A, C, D)) of quad q.
    void deckTri(const DeckQuad& q, int j, int side, DeckTri& out) const {
        const float2 A{ q.sa, q.bA[j] }, B{ q.sa, q.bA[j + 1] };
        const float2 C{ q.sb, q.bB[j + 1] }, D{ q.sb, q.bB[j] };
        out.ring = q.ring;
        out.strip = j;
        out.side = side;
        out.U[0] = A;
        out.W[0] = q.posA + q.latA * q.bA[j];
        if (side == 0) {
            out.U[1] = B; out.W[1] = q.posA + q.latA * q.bA[j + 1];
            out.U[2] = C; out.W[2] = q.posB + q.latB * q.bB[j + 1];
        } else {
            out.U[1] = C; out.W[1] = q.posB + q.latB * q.bB[j + 1];
            out.U[2] = D; out.W[2] = q.posB + q.latB * q.bB[j];
        }
    }
    bool deckTriAt(float s, float lat, DeckTri& out) const {
        float w = std::fmod(s, length);
        if (w < 0) w += length;
        const int i = deckRingAt(w);
        if (i < 0) return false;
        DeckQuad q;
        deckQuadAt(i, q);
        return deckTriIn(q, w, lat, out);
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
            const float3 ab = knots[i + 1 == n ? 0 : i + 1].pos - a.pos;
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
            // (hint + k) mod n for k = -W..W, in that order: the start is the
            // k = -W term, then each step wraps by compare (indices repeat when
            // n is under 2W+1).
            size_t j = (size_t) ((((long) *hint - W) % (long) n + (long) n) % (long) n);
            for (long k = -W; k <= W; k++) {
                trySeg(j);
                j = j + 1 == n ? 0 : j + 1;
            }
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
                const Sample& wb = knots[bestI + 1 == n ? 0 : bestI + 1];
                if (dot(p - wa.pos, wa.tangent()) < 0) bestI = bestI == 0 ? n - 1 : bestI - 1;
                else if (dot(p - wb.pos, wb.tangent()) >= 0) bestI = bestI + 1 == n ? 0 : bestI + 1;
                else break;
            }
        }
        if (hint) *hint = (int) bestI;
        const Sample& a = knots[bestI];
        const Sample& b = knots[bestI + 1 == n ? 0 : bestI + 1];
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
        float bA[8], bB[8];
        deckStripBounds(a.width * 0.5f, bA);
        deckStripBounds(b.width * 0.5f, bB);
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



// A prop contact blob's ink and rest opacity (makeBlobShadowTexture), shared
// by the item-box stamps below, the box collect fade, and the banana/rocket
// stamps in the render loop.
constexpr float kBlobShadowAlpha = 0.4f;

// The item box's baseColorFactor, a LINEAR multiplier over the kit atlas's
// purple. The atlas face alone is darker than the deck, so a box read on hue
// only; this lifts it clear of the road. The white stars ride the same
// material, so a channel too low to clip once lit tints them: this G and B
// trade faintly peach stars under warm light for a more vibrant body.
constexpr float3 kBoxTint{ 2.35f, 1.6f, 1.58f };
// ...as the base-colour FACTOR the box's instances carry: display-encoded,
// like every factor (displayKitFactors).
inline const float3 kBoxTintFactor = encodeSrgb(kBoxTint);


// The car ground shadow's ink, opacity and coverage cap live in
// CarShadowTuning (TtpRenderer.h); the prop blobs at 0.40 and the lawn discs
// at 0.30 sit lighter on purpose.
