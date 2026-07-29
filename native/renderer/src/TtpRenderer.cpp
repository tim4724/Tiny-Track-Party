#include "TtpRenderer.h"

#include <filament/Camera.h>
#include <filament/ColorGrading.h>
#include <filament/Engine.h>
#include <filament/IndirectLight.h>
#include <filament/LightManager.h>
#include <filament/ToneMapper.h>
#include <filament/IndexBuffer.h>
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
float srgbChannel(float c) {
    return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f);
}
float3 srgbToLinear(uint32_t rgb) {
    return { srgbChannel(((rgb >> 16) & 0xff) / 255.0f),
             srgbChannel(((rgb >> 8) & 0xff) / 255.0f),
             srgbChannel((rgb & 0xff) / 255.0f) };
}
// Canvas `filter: blur(Npx)` is a Gaussian of stddev N. Both soft sprites the
// JS bakes into textures (the cloud puff's five discs, the wind streak's
// ellipse) are only a couple of sigma across, so the r ≫ sigma closed form is
// no good — convolve numerically instead. `inside` is the unblurred shape mask
// in canvas pixels; the result is its coverage at (px, py).
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

uint32_t packLinear(const float3& lin, float ao, float alpha = 1.0f) {
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
    std::vector<uint32_t> carColors;
    std::vector<std::string> carNames; // rear name plates
    std::vector<float> carPlateY;      // per-model plate height (PLATE_Y); <0 = auto
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

    // Foot of `p` on the centreline (Centerline.nearest): used to re-express a
    // car-local point as (arclength, lateral) so flat decals can be CONFORMED
    // to the deck — the JS raycasts the rendered road for the same result.
    //
    // Projects onto the closest SEGMENT, not the closest sample: the closest
    // point on a polyline moves continuously with p, while a per-sample frame
    // snaps as the nearest knot changes — which shifted the whole decal by a
    // few mm several times a second (the shadow's jitter).
    void project(const float3& p, const float3& up, float& outS, float& outLat) const {
        const size_t n = samples.size();
        if (n < 2) { outS = 0; outLat = 0; return; }
        float bestD = 1e30f, bestT = 0;
        size_t bestI = 0;
        // Where the track crosses over itself — a loop, a bridge — the closest
        // segment in space can be the OTHER deck, and the decal snaps between
        // the two branches as the car drives. Only segments whose road normal
        // agrees with the caller's rules them out.
        for (int pass = 0; pass < 2 && bestD > 1e29f; pass++) {
            for (size_t i = 0; i < n; i++) {
                const Sample& a = samples[i];
                if (pass == 0 && dot(a.up, up) < 0.3f) continue; // wrong branch
                const float3 ab = samples[(i + 1) % n].pos - a.pos;
                const float len2 = dot(ab, ab);
                float t = len2 > 1e-12f ? dot(p - a.pos, ab) / len2 : 0.0f;
                t = std::min(1.0f, std::max(0.0f, t));
                const float3 d = p - (a.pos + ab * t);
                const float dd = dot(d, d);
                if (dd < bestD) { bestD = dd; bestI = i; bestT = t; }
            }
        }
        const Sample& a = samples[bestI];
        const Sample& b = samples[(bestI + 1) % n];
        float sB = b.s;
        if (sB < a.s) sB += length; // start/finish seam
        outS = a.s + (sB - a.s) * bestT;
        const float3 q = a.pos + (b.pos - a.pos) * bestT;
        const float3 lat = normalize(mix(a.lat, b.lat, bestT));
        outLat = dot(p - q, lat);
    }
};

TtpRenderer::TtpRenderer() = default;

bool TtpRenderer::init(backend::Backend backend, void* nativeWindow,
        uint32_t width, uint32_t height) {
    mEngine = Engine::create(backend);
    if (mEngine) {
        // The scenery is dozens of copies of a handful of GLBs — trees, boxes,
        // cones — and each instance was its own draw call. Filament can merge
        // identical primitives that share a MaterialInstance into one instanced
        // draw; three gets the same effect by merging its scenery into a single
        // mesh, which is most of why it issues 42 draws a frame where we issue
        // 111.
        mEngine->setAutomaticInstancingEnabled(true);
    }
    if (!mEngine) return false;
    mSwapChain = mEngine->createSwapChain(nativeWindow);
    mRenderer = mEngine->createRenderer();
    // Clear the colour buffer at the start of a frame. It costs nothing (a load
    // action) and it defines the slivers no cell viewport covers: cell width is
    // floor(canvas/cols), so up to cols-1 columns belong to no view at all, and
    // the present pass reads them.
    Renderer::ClearOptions clear{};
    clear.clear = true;
    clear.clearColor = { 0.0f, 0.0f, 0.0f, 1.0f };
    mRenderer->setClearOptions(clear);
    mScene = mEngine->createScene();
    mView = mEngine->createView();
    mCameraEntity = utils::EntityManager::get().create();
    mCamera = mEngine->createCamera(mCameraEntity);
    mView->setCamera(mCamera);
    mView->setScene(mScene);
    mView->setPostProcessingEnabled(false);
    resize(width, height);
    return true;
}

void TtpRenderer::resize(uint32_t width, uint32_t height) {
    mWidth = width;
    mHeight = height;
    mView->setViewport({ 0, 0, width, height });
    updateCamera();
    // Called between frames, which is the only safe place to swap the scene
    // buffer: render() must never find a size mismatch, so rebuild it here.
    destroySceneTarget();
    ensureSceneTarget();
}

void TtpRenderer::updateCamera() {
    constexpr double ZOOM = 1.5;
    const double aspect = mHeight ? (double) mWidth / mHeight : 1.0;
    mCamera->setProjection(Camera::Projection::ORTHO,
            -aspect * ZOOM, aspect * ZOOM, -ZOOM, ZOOM, 0.0, 1.0);
}

bool TtpRenderer::provideAsset(const char* name, const uint8_t* bytes,
        uint32_t len) {
    if (!name || (!bytes && len)) return false;
    mAssets[name].assign(bytes, bytes + len);
    return true;
}

const std::vector<uint8_t>* TtpRenderer::asset(const char* name) const {
    const auto it = mAssets.find(name);
    return it == mAssets.end() ? nullptr : &it->second;
}

bool TtpRenderer::buildMesh(Mesh& m, bool addToScene,
        MaterialInstance* materialInstance, uint8_t priority, uint32_t chunkTris) {
    if (m.verts.empty() || m.idx.empty() || m.idx.size() % 3) return false;
    static_assert(sizeof(Vertex) == 16, "unexpected vertex layout");
    const bool lit = !m.normals.empty() && mLitMaterial != nullptr;
    const bool uv = !m.uvs.empty();
    const uint8_t uvSlot = lit ? 2 : 1;
    VertexBuffer::Builder vbb;
    vbb.vertexCount((uint32_t) m.verts.size())
            .bufferCount((uint8_t) (1 + (lit ? 1 : 0) + (uv ? 1 : 0)))
            .attribute(VertexAttribute::POSITION, 0,
                    VertexBuffer::AttributeType::FLOAT3, 0, sizeof(Vertex))
            .attribute(VertexAttribute::COLOR, 0,
                    VertexBuffer::AttributeType::UBYTE4, 12, sizeof(Vertex))
            .normalized(VertexAttribute::COLOR);
    if (uv) {
        vbb.attribute(VertexAttribute::UV0, uvSlot,
                VertexBuffer::AttributeType::FLOAT2, 0, sizeof(math::float2));
    }
    if (lit) {
        // Lit shading needs the TANGENTS frame; derive qtangents from the
        // builder-supplied normals (arbitrary tangent — no normal maps here).
        vbb.attribute(VertexAttribute::TANGENTS, 1,
                VertexBuffer::AttributeType::FLOAT4, 0, sizeof(math::quatf));
    }
    m.vb = vbb.build(*mEngine);
    m.vb->setBufferAt(*mEngine, 0, VertexBuffer::BufferDescriptor(
            m.verts.data(), m.verts.size() * sizeof(Vertex), nullptr));
    if (uv) {
        m.uvs.resize(m.verts.size(), math::float2{ 0, 0 });
        m.vb->setBufferAt(*mEngine, uvSlot, VertexBuffer::BufferDescriptor(
                m.uvs.data(), m.uvs.size() * sizeof(math::float2), nullptr));
    }
    if (lit) {
        m.normals.resize(m.verts.size(), float3{ 0, 1, 0 });
        m.quats.resize(m.verts.size());
        geometry::SurfaceOrientation* so = geometry::SurfaceOrientation::Builder()
                .vertexCount(m.verts.size())
                .normals(m.normals.data())
                .build();
        if (so) {
            so->getQuats(m.quats.data(), m.quats.size());
            delete so;
        }
        m.vb->setBufferAt(*mEngine, 1, VertexBuffer::BufferDescriptor(
                m.quats.data(), m.quats.size() * sizeof(math::quatf), nullptr));
    }
    m.ib = IndexBuffer::Builder()
            .indexCount((uint32_t) m.idx.size())
            .bufferType(IndexBuffer::IndexType::UINT)
            .build(*mEngine);
    m.ib->setBuffer(*mEngine, IndexBuffer::BufferDescriptor(
            m.idx.data(), m.idx.size() * sizeof(uint32_t), nullptr));
    // Real bounds, per renderable. These were a ±1000 stand-in for years —
    // harmless while nothing used them, fatal once the sun started casting
    // (Filament sizes the shadow frustum from the CASTERS' bounds, and a 2 km
    // cube of "road" stretched a 2048² map over the whole world) and useless
    // for culling. Meshes whose verts are rewritten in world space every frame
    // keep whatever their template spanned, which is exactly why culling is
    // opt-in: they must never be culled on a stale box.
    const auto boundsOf = [&](size_t idx0, size_t idxN) {
        float3 lo{ 1e30f }, hi{ -1e30f };
        for (size_t k = idx0; k < idx0 + idxN; k++) {
            const Vertex& v = m.verts[m.idx[k]];
            lo = min(lo, float3{ v.px, v.py, v.pz });
            hi = max(hi, float3{ v.px, v.py, v.pz });
        }
        return filament::Box{ (lo + hi) * 0.5f, max((hi - lo) * 0.5f, float3{ 1e-3f }) };
    };
    MaterialInstance* const mi = materialInstance ? materialInstance
            : lit ? mLitMaterial->getDefaultInstance()
                  : mMaterial->getDefaultInstance();
    const size_t triCount = m.idx.size() / 3;
    // One renderable, or a chain of them over ranges of the SAME buffers. The
    // road is the reason: a whole circuit in one draw is a whole circuit's
    // worth of vertices every frame, in every split-screen cell, however little
    // of it is on screen. Three chunks its ribbon for the same reason.
    const size_t perChunk = chunkTris ? std::min<size_t>(chunkTris, triCount) : triCount;
    for (size_t t0 = 0; t0 < triCount; t0 += perChunk) {
        const size_t n = std::min(perChunk, triCount - t0);
        utils::Entity e = utils::EntityManager::get().create();
        RenderableManager::Builder(1)
                .boundingBox(boundsOf(t0 * 3, n * 3))
                // Blend-pass draw order (default 4). The flat road decals stack
                // in a fixed order — skids under the ground shadow, both under
                // the boost aura — instead of by an arbitrary depth sort.
                .priority(priority)
                .material(0, mi)
                .geometry(0, RenderableManager::PrimitiveType::TRIANGLES,
                        m.vb, m.ib, t0 * 3, n * 3)
                // Frustum culling for everything. The bounds are real now, and
                // the few meshes that rewrite their vertices in world space
                // every frame (the conformed decals, the skid pool, the ambient
                // band) refresh theirs in the same breath — see refreshBounds.
                // Pointing the camera at empty sky used to still cost 69 draw
                // calls; per-draw GPU cost is ~18 µs, so that was over a
                // millisecond of drawing nothing.
                .culling(true)
                .receiveShadows(false)
                .castShadows(false)
                .build(*mEngine, e);
        if (t0 == 0) m.entity = e; else m.chunks.push_back(e);
        if (addToScene) mScene->addEntity(e);
    }
    m.inScene = addToScene;
    return true;
}

// Only ever called from releaseScene(), which flushes first — so dropping the
// CPU copies here is safe even though their BufferDescriptors carry no release
// callback. Clearing them is not optional: every builder push_backs, so a mesh
// rebuilt over stale vectors comes out with its previous contents still in it
// (doubled geometry AND a leak, ~14 MB a race).
void TtpRenderer::destroyMesh(Mesh& m) {
    for (utils::Entity e : m.chunks) {
        mScene->remove(e);
        mEngine->destroy(e);
        utils::EntityManager::get().destroy(e);
    }
    m.chunks.clear();
    if (!m.entity.isNull()) {
        mScene->remove(m.entity);
        mEngine->destroy(m.entity);
        utils::EntityManager::get().destroy(m.entity);
        m.entity = {};
    }
    if (m.vb) { mEngine->destroy(m.vb); m.vb = nullptr; }
    if (m.ib) { mEngine->destroy(m.ib); m.ib = nullptr; }
    m.inScene = false;
    m.verts = {};
    m.idx = {};
    m.normals = {};
    m.quats = {};
    m.uvs = {};
    m.local = {};
}

// The roster half of TrackBin, copied off the slots the shell handed over.
//
// This used to be a byte parser over "track.bin" — a version word, three
// parallel arrays and four length checks, mirrored by a writer in JS. The
// liveries arrive as plain structs now (libttp-runtime's parseRoster does the
// colour arithmetic and the plate table once), so what is left is a copy.
void TtpRenderer::applyRoster(TrackBin& out, const std::vector<TtpRosterCar>& roster) {
    const size_t n = roster.size();
    out.carColors.resize(n);
    out.carNames.resize(n);
    out.carPlateY.resize(n);
    for (size_t i = 0; i < n; i++) {
        out.carColors[i] = roster[i].colorABGR;
        out.carNames[i] = roster[i].name; // NUL-terminated, 8 chars max
        out.carPlateY[i] = roster[i].plateY;
    }
}

// The biome half of TrackBin, taken straight off the resolved theme.
//
// This used to arrive in track.bin, authored in the browser: ~120 colours and
// intensities per biome serialized into a flat tag/value block that a JS writer
// and this reader had to keep in lockstep by hand. The palette is C++ data now
// (libttp-runtime/ttp/theme.h), already resolved — the ambient kind's motion
// preset, the cloud/bird/plane defaults and the per-track ambient patch are all
// folded in — so this is a copy, not a decode, and there is no defaulting left
// to disagree about.
//
// The field names are kept verbatim from the payload they replace, so every
// reader downstream (buildRoadMesh, buildScenery, the sky dome, the fog bands)
// is untouched by the move.
void TtpRenderer::applyTheme(TrackBin& out, const ttp::rt::Theme& th) {
    out.pal[0] = th.road.asphalt; out.pal[1] = th.road.line; out.pal[2] = th.road.dash;
    out.pal[3] = th.road.kerbA;   out.pal[4] = th.road.kerbB;
    out.pal[5] = th.road.skirt;   out.pal[6] = th.road.shoulder;
    out.kerbW = th.road.kerbW;
    out.kerbH = th.road.kerbH;
    out.edgeLines = th.road.edgeLines;

    out.sky[0] = th.sky[0]; out.sky[1] = th.sky[1]; out.sky[2] = th.sky[2];
    out.fog = th.fog;
    out.hillShape = th.hillShape;
    out.hillColors = th.hills;

    // Scenery models are named in the theme and indexed here: the index IS the
    // scenery<i>.glb slot the shell provided them in (ttp_theme_scenery_models
    // hands out the same list, in the same order).
    const ttp::rt::ScenerySpec& sc = th.scenery;
    const auto modelIndex = [&](const std::string& m) -> uint32_t {
        for (size_t i = 0; i < sc.models.size(); i++) if (sc.models[i] == m) return (uint32_t) i;
        return 0;
    };
    out.scDensity = sc.density;
    out.scMixTree = sc.mixTree;
    out.scMixBush = sc.mixBush;
    out.scTrees.clear();
    for (const ttp::rt::TreeSpec& t : sc.trees) {
        out.scTrees.push_back({ modelIndex(t.model), t.w, t.s0, t.s1 });
    }
    out.scHasBush = sc.hasBush;
    if (sc.hasBush) {
        out.scBush = { modelIndex(sc.bush.model), sc.bush.s0, sc.bush.s1, sc.bush.sink };
    }
    out.scRocks = sc.rocks;
    out.scRockS[0] = sc.rockS[0];
    out.scRockS[1] = sc.rockS[1];
    out.scModelCount = (uint32_t) sc.models.size();
    out.clDensity = sc.clutterDensity;
    out.clKinds.clear();
    for (const ttp::rt::ClutterSpec& c : sc.clutter) out.clKinds.push_back({ c.kind, c.w, c.tints });

    out.lmKinds = th.landmarks;
    out.structureCol = th.structure;

    out.groundKind = th.groundKind;
    out.fogTune = th.fogTune;
    out.keyCol = th.key.color;
    out.keyIntensity = th.key.intensity;
    out.hemiSky = th.hemi.sky;
    out.hemiGround = th.hemi.ground;
    out.hemiIntensity = th.hemi.intensity;
    out.cloudCount = th.clouds.count;
    out.cloudOpacity = th.clouds.opacity;
    out.cloudScale = th.clouds.scale;
    out.cloudAspect = th.clouds.aspect;
    out.cloudTint = th.clouds.tint;
    out.gateCol = th.gate;
    out.gantryPylon = th.gantry.pylon;
    out.gantryFinial = th.gantry.finial;
    out.gantryHasRings = th.gantry.hasRings;
    out.gantryRings = th.gantry.rings;
    out.boostCol = th.boost;
    out.hasWater = th.hasWater;
    if (th.hasWater) {
        out.waterFoam = th.water.foam;
        out.waterShallow = th.water.shallow;
        out.waterDeep = th.water.deep;
        out.waterWet = th.water.wet;
        out.shoreSeed = th.water.shoreSeed;
    }
    out.hazeCount = th.haze.count;
    out.hazeOpacity = th.haze.opacity;
    out.hazeTint = th.haze.tint;
    out.hazeScale = th.haze.scale;
    out.ambKind = th.ambient.kind;
    out.ambCount = th.ambient.count;
    out.ambSize = th.ambient.size;
    out.ambOpacity = th.ambient.opacity;
    out.ambTint = th.ambient.tint;
    out.ambFall = th.ambient.fall;
    out.ambWind = th.ambient.wind;
    out.ambBob = th.ambient.bob;
    out.ambBand = th.ambient.band;
    out.birdCount = th.birds.count;
    out.birdTint = th.birds.tint;
    out.birdSize = th.birds.size;
    out.birdY = th.birds.y;
    out.birdRc = th.birds.rc;
    out.birdRb = th.birds.rb;
    out.birdSpeed = th.birds.speed;
    out.birdFlap = th.birds.flap;
    out.birdFlapHz = th.birds.flapHz;
    out.birdDys = th.birds.dys;
    out.kiteCount = th.kites.count;
    out.kiteSize = th.kites.size;
    out.kiteY = th.kites.y;
    out.kiteTints = th.kites.tints;
    out.hasPlane = th.hasPlane;
    if (th.hasPlane) {
        out.planeTint = th.plane.tint;
        out.planeSize = th.plane.size;
        out.planeY = th.plane.y;
        out.planeA0 = th.plane.a0;
        out.planeRc = th.plane.rc;
        out.planeRb = th.plane.rb;
        out.planeSpeed = th.plane.speed;
        out.planeBank = th.plane.bank;
    }
    out.balloonPanels = th.balloon.panels;
    out.balloonY = th.balloon.y;
    out.balloonSize = th.balloon.size;
    out.hasIce = th.hasIce;
    if (th.hasIce) { out.iceSheet = th.ice.sheet; out.iceFrost = th.ice.frost; }

    out.modelTints.clear();
    for (const std::vector<ttp::rt::MatTint>& model : th.modelTints) {
        std::vector<TrackBin::MatTint> pairs;
        for (const ttp::rt::MatTint& t : model) pairs.push_back({ t.name, t.rgb });
        out.modelTints.push_back(std::move(pairs));
    }
}

// The geometry half of TrackBin, taken straight off the built track.
//
// This used to arrive in track.bin, serialized by a SECOND implementation of the
// track builder that ran in JS on every race. There is one builder now, it runs
// here, and the object below is the same ttp::RaceTrack the sim is racing on —
// so the road the player drives and the road they see cannot disagree.
//
// Everything narrows double -> float: the renderer's whole vertex path is float,
// and the sim's doubles never come back the other way.
void TtpRenderer::fillGeometry(TrackBin& out, const ttp::RaceTrack& geo) {
    out.roadWidth = (float) geo.roadWidth;
    out.groundY = (float) geo.groundY;
    out.length = (float) geo.length;
    out.closed = geo.closed;

    out.samples.resize(geo.samples.size());
    for (size_t i = 0; i < geo.samples.size(); i++) {
        const ttp::OutSample& s = geo.samples[i];
        TrackBin::Sample& d = out.samples[i];
        d.pos = { (float) s.pos.x, (float) s.pos.y, (float) s.pos.z };
        d.lat = { (float) s.lateral.x, (float) s.lateral.y, (float) s.lateral.z };
        d.up = { (float) s.up.x, (float) s.up.y, (float) s.up.z };
        d.width = (float) s.width;
        d.s = (float) s.s;
    }

    out.boxes.clear();
    for (const ttp::Box& b : geo.boxes) out.boxes.push_back({ (float) b.s, (float) b.lat });

    out.pads.clear();
    out.zones.clear();
    for (const ttp::Pad& p : geo.pads) {
        if (p.strip) {
            out.pads.push_back({ 1u, (float) p.s, (float) p.lat,
                                 (float) p.halfLen, (float) p.halfWidth });
            // Bare-asphalt blanking around a launch strip: the road's dashes and
            // edge lines stop short of it, with a small margin so the paint does
            // not graze the chevrons.
            out.zones.push_back({ (float) p.s, (float) (p.halfLen + kStripMargin) });
        } else {
            out.pads.push_back({ 0u, (float) p.s, (float) p.lat, (float) p.radius, 0.0f });
        }
    }

    out.oils.clear();
    for (const ttp::Hazard& h : geo.hazards) {
        // Cone count is fixed: no shipped track authors one, and the codegen
        // (gen-track-defs-header.mjs) refuses a furniture entry that carries
        // `cones` rather than silently dropping it.
        out.oils.push_back({ (float) h.s, (float) h.lat, (float) h.radius, kOilCones });
    }

    // Ghost poles are collision proxies for supports that are already drawn
    // elsewhere (bridge pillars, loop shafts) — meshing them would double them up.
    out.poles.clear();
    for (const ttp::Pole& p : geo.poles) {
        if (p.ghost) continue;
        out.poles.push_back({ (float) p.s, (float) p.lat, (float) p.radius });
    }

    out.pillars.clear();
    for (const ttp::Pillar& p : geo.pillars) {
        out.pillars.push_back({ (float) p.x, (float) p.z, (float) p.baseY,
                                (float) p.topY, (float) p.radius });
    }

    out.supportPosts.clear();
    for (const ttp::SupportPost& p : geo.supportPosts) {
        out.supportPosts.push_back({ (float) p.x, (float) p.z, (float) p.radius,
                { (float) p.contactPos.x, (float) p.contactPos.y, (float) p.contactPos.z },
                { (float) p.contactUp.x, (float) p.contactUp.y, (float) p.contactUp.z } });
    }

    out.berms.clear();
    out.berms.reserve(geo.hills.size());
    for (const std::vector<ttp::HillRing>& run : geo.hills) {
        std::vector<TrackBin::BermRing> rings;
        rings.reserve(run.size());
        for (const ttp::HillRing& r : run) {
            rings.push_back({ (float) r.cx, (float) r.cz, (float) r.lx, (float) r.lz,
                              (float) r.halfW, (float) r.topL, (float) r.topR });
        }
        out.berms.push_back(std::move(rings));
    }

    // The scatter streams' seeds. These are a function of the GEOMETRY — the
    // built length, rounded to the centimetre and spelled as a decimal string,
    // hashed three ways — so they are derived here rather than sent. Reproducing
    // the JS exactly matters: a different seed reshuffles every tree, landmark
    // and clutter piece on every track.
    //
    // NOTE the string is length ALONE. The JS read `track.id || track.name`
    // first, but buildTrack's output object carried neither, so that prefix was
    // always empty and the shipped scatter has only ever depended on length.
    {
        const double rounded = std::floor(geo.length * 100.0 + 0.5); // JS Math.round
        char digits[32];
        std::snprintf(digits, sizeof digits, "%.0f", rounded);
        uint32_t s1 = 2166136261u, s2 = 5381u, s3 = 51966u; // scatter, clutter, landmarks
        for (const char* c = digits; *c; ++c) {
            const uint32_t ch = (uint32_t) (unsigned char) *c;
            s1 = (s1 ^ ch) * 16777619u;
            s2 = (s2 ^ ch) * 16777619u;
            s3 = (s3 ^ ch) * 16777619u;
        }
        out.scSeed1 = s1;
        out.scSeed2 = s2;
        out.lmSeed = s3;
    }
}

// The painted road — a direct port of render/track.js buildRoad's sweep: a
// 16-point cross-section (skirt/kerb/gap/line/asphalt/dash) swept along a fine
// uniform resample, per-side kerb striping banded by EACH KERB EDGE's own
// arclength (even-band snap → clean seam), dash cadence snapped to whole ring
// runs, bare asphalt under launch strips, and the same baked-AO gradients.
// Unlit for now (the JS ribbon is Lambert; the matte-material family is later
// work) — the AO carries most of the plastic-toy form.
bool TtpRenderer::buildRoadMesh(const TrackBin& tb) {
    const size_t nSrc = tb.samples.size();
    const float L = tb.length;
    if (nSrc < 2 || L <= 0 || !tb.closed) return false;

    // Arclength interpolation over the serialized samples (they're the contract
    // centerline samples, unevenly spaced ~0.4–1.5u; the paint needs ~0.24u).
    // Catmull-Rom via TrackBin::frameAt — the JS sweep samples the same cubic.
    const auto frameAt = [&](float s) { return tb.frameAt(s); };

    // Constants — identical to buildRoad's.
    const float defHalf = tb.roadWidth / 2;
    const float cw = tb.kerbW, ch = tb.kerbH, deck = 0.34f;
    const float gap = std::min(0.07f, defHalf * 0.3f);
    const float lw = std::min(0.20f, defHalf * 0.5f - gap);
    const float stripeLen = 2.0f, dashW = 0.18f;
    const float DASH_PERIOD = 5.76f, DASH_FRAC = 0.25f;

    const float minBand = std::min(stripeLen, DASH_PERIOD * DASH_FRAC);
    uint32_t N = (uint32_t) std::min(4000L, std::max(8L,
            std::lround(L / std::min(0.24f, std::max(0.06f, minBand / 3)))));
    const uint32_t dashCycles = (uint32_t) std::max(2L, std::lround(L / DASH_PERIOD));
    uint32_t ringsPerCycle = std::max(4u, (uint32_t) std::lround((double) N / dashCycles));
    if (ringsPerCycle * dashCycles > 4000) ringsPerCycle = std::max(4u, 4000u / dashCycles);
    N = ringsPerCycle * dashCycles;
    const uint32_t dashRingsOn = std::min(ringsPerCycle - 1,
            std::max(1u, (uint32_t) std::lround(ringsPerCycle * DASH_FRAC)));

    std::vector<TrackBin::Sample> frames(N);
    for (uint32_t i = 0; i < N; i++) frames[i] = frameAt(((float) i / N) * L);
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
    // the lane, while makePadStripTexture lays a 5×2 GRID of chevrons. It's now
    // real stroked geometry in buildPadsMesh.)

    // ANALYTIC normals (the JS lesson: computing normals on unindexed soup
    // flat-shades per face and bands every vertical curve): a strip's normal
    // at ring i is across × tangent, smooth ALONG the road while duplicated
    // verts keep profile corners hard. doubleSided flips per fragment.
    std::vector<float3> tans(N);
    for (uint32_t i = 0; i < N; i++) {
        tans[i] = frames[(i + 1) % N].pos - frames[(i + N - 1) % N].pos;
    }

    // Sweep: unindexed soup (each quad owns its verts → crisp paint bands),
    // 6 verts per strip per ring pair, per-vert AO from its own profile point.
    static const int VSEQ_PT[6] = { 0, 1, 1, 0, 1, 0 };   // a,b,b,a,b,a
    mRoad.verts.reserve((size_t) N * 16 * 6);
    mRoad.normals.reserve((size_t) N * 16 * 6);
    for (uint32_t i = 0; i < N; i++) {
        const uint32_t ni = (i + 1) % N;
        const float3 colL = bandCol(kerbL, i), colR = bandCol(kerbR, i);
        const bool bare = bareAsphalt(i);
        for (const Strip& st : STRIPS) {
            float3 cb;
            switch (st.kind) {
                case K_KERB: cb = st.side > 0 ? colR : colL; break;
                case K_SKIRT: cb = SKIRT; break;
                case K_DASH: cb = bare ? ASPHALT : (dashOn(i) ? DASHC : ASPHALT); break;
                case K_LINE: cb = bare ? ASPHALT : (tb.edgeLines ? LINE : SHOULDER); break;
                case K_GAP: cb = tb.edgeLines ? ASPHALT : SHOULDER; break;
                default: cb = ASPHALT; break;
            }
            const uint32_t ringIdx[6] = { i, i, ni, i, ni, ni };
            const auto stripNormal = [&](uint32_t ring) {
                const float3 across = pointAt(ring, st.b) - pointAt(ring, st.a);
                const float3 n = cross(across, tans[ring]);
                const float len = length(n);
                return len > 1e-9f ? n / len : frames[ring].up;
            };
            const float3 nA = stripNormal(i), nB = stripNormal(ni);
            for (int v = 0; v < 6; v++) {
                const int pt = VSEQ_PT[v] ? st.b : st.a;
                const float3 p = pointAt(ringIdx[v], pt);
                mRoad.verts.push_back({ p.x, p.y, p.z, packLinear(cb, AO[pt]) });
                mRoad.normals.push_back(ringIdx[v] == i ? nA : nB);
            }
        }
    }
    mRoad.idx.resize(mRoad.verts.size());
    for (uint32_t i = 0; i < mRoad.idx.size(); i++) mRoad.idx[i] = i;
    // Chunked: ~2.5k triangles a piece, each with its own bounds, so a chase
    // camera pays for the stretch of circuit it can actually see instead of all
    // ~59k triangles of it — per cell, every frame. (Three's ribbon is chunked
    // at 160 rings for exactly this.) The CPU-side soup in mRoad.verts is
    // untouched: the ground-conform probes still read the whole ribbon.
    return buildMesh(mRoad, true, litShadowInstance(), 4, 2500);
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

// The biome's floor canvas, ported from textures.js pixel for pixel: N vertical
// bands of a per-kind luminance/hue wobble over a base colour, then the kind's
// speckle pass (2×2 stamps alpha-blended over the bands). The wood adds the
// pieces the band approximation could never carry — a dark seam stroked between
// planks, staggered END joints across each board, and knots.
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
    // Speckle: `n` 2×2 stamps on the shared (i*53, i*97) lattice.
    const auto speckle = [&](int n, int r, int g, int b, float a0, float step) {
        for (int i = 0; i < n; i++) {
            blend((i * 53) % S, (i * 97) % S, 2, 2, r, g, b, a0 + (i % 3) * step);
        }
    };
    switch (kind) {
        case 1: { // sand — gentle wind ripples, then darker grit
            const int base[3] = { 222, 200, 150 };
            sweep(10, base, [](int i, float* f) { f[0] = f[1] = f[2] = (i % 2) ? 1.03f : 0.975f; });
            speckle(140, 150, 120, 80, 0.05f, 0.03f);
            break;
        }
        case 2: { // redrock — sediment strata (a hue wobble), then iron flecks
            const int base[3] = { 211, 150, 113 };
            sweep(8, base, [](int i, float* f) {
                const bool rust = i % 2;
                f[0] = rust ? 1.008f : 0.997f;
                f[1] = rust ? 0.972f : 1.024f;
                f[2] = rust ? 0.958f : 1.036f;
            });
            speckle(120, 120, 62, 38, 0.06f, 0.03f);
            break;
        }
        case 3: { // snow — whisper-contrast drift banding, then ice flecks
            const int base[3] = { 237, 242, 247 };
            sweep(10, base, [](int i, float* f) { f[0] = f[1] = f[2] = (i % 2) ? 1.012f : 0.988f; });
            speckle(90, 168, 184, 204, 0.05f, 0.025f);
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
            speckle(60, 110, 74, 44, 0.08f, 0.04f);
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

bool TtpRenderer::trackFraming(TtpTrackFraming& out) const {
    if (!mTrack || mTrack->samples.empty()) return false;
    float3 lo = mTrack->samples[0].pos, hi = lo;
    for (const TrackBin::Sample& s : mTrack->samples) {
        lo = min(lo, s.pos);
        hi = max(hi, s.pos);
    }
    const float3 c = (lo + hi) * 0.5f, size = hi - lo;
    out.centerX = c.x; out.centerY = c.y; out.centerZ = c.z;
    out.sizeX = size.x; out.sizeY = size.y; out.sizeZ = size.z;
    out.fogTune = mTrack->fogTune;
    return true;
}

float TtpRenderer::maxOrbitDist(float radius, float height) const {
    if (!mTrack || mTrack->samples.empty()) return 0;
    TtpTrackFraming f{};
    trackFraming(f);
    const float ringY = f.centerY + height;
    float worst = 0;
    for (const TrackBin::Sample& s : mTrack->samples) {
        const float horiz = std::hypot(s.pos.x - f.centerX, s.pos.z - f.centerZ) + radius;
        const float d = std::hypot(horiz, s.pos.y - ringY);
        if (d > worst) worst = d;
    }
    return worst;
}

// Split-screen column count. The scoring — including the hard landscape
// preference — lives in ttp_grid_cols (renderer/include/ttp_render.h) so that
// the renderer's viewport split and the runtime's per-cell camera aspect are one
// definition rather than copies that can disagree about where a cell is; the
// reasoning lives with it there.
uint32_t TtpRenderer::bestGridCols(uint32_t n) const {
    return ttp_grid_cols(n, mWidth, mHeight);
}

// Where cell i is drawn: its tile in a GRID that is letterboxed as one piece.
//
// A cell wider than CELL_MAX_ASPECT is width the camera declines to use, so it
// is not drawn — but the bars that leaves belong at the SCREEN's edges, never
// between two pictures. Letterboxing each cell on its own would put a gutter
// down the middle of a 2x2 on an ultrawide (two 330px half-bars meeting as one
// 660px band) while the edges got half as much: the same pixels saved, arranged
// as a seam through the layout. So cap the width of the whole grid instead and
// tile it edge to edge inside that, and every bar ends up on the outside.
//
// The bars cost nothing to draw: the clear colour is black (setClearOptions in
// init) and the scene target is cleared whole by the first view of the frame.
// And they cost nothing to LOSE, either — no pixel the camera would have shown
// is dropped. Any grid whose cells are already at or under the cap (all of 1, 2,
// 3 and 4 players on a 16:9 screen but the stacked pair) is untouched.
//
// Bottom-left origin, because GL viewports are; row 0 is the TOP row, as the
// DOM HUD lays it out (Stage.js has the same rules, pinned to these).
TtpRenderer::CellRect TtpRenderer::cellRect(uint32_t n, uint32_t i) const {
    const uint32_t cols = bestGridCols(n);
    const uint32_t rows = (n + cols - 1) / cols;
    const uint32_t ch = mHeight / rows;
    uint32_t stageW = mWidth;
    const uint32_t capped = (uint32_t) ((float) ch * CELL_MAX_ASPECT * (float) cols);
    if (capped < stageW) stageW = capped;
    const uint32_t cw = stageW / cols;
    // Centre what the columns actually cover, so integer division can't drift
    // the grid off-centre by up to cols-1 pixels.
    const uint32_t x0 = (mWidth - cw * cols) / 2;
    const uint32_t col = i % cols, row = i / cols;
    return { (int32_t) (x0 + col * cw),
             (int32_t) (mHeight - (row + 1) * ch), cw, ch };
}

TtpCellRect TtpRenderer::cellRectTopLeft(uint32_t n, uint32_t i) const {
    if (i >= n) return TtpCellRect{ 0u, 0u, 0u, 0u };
    const CellRect r = cellRect(n, i);
    return TtpCellRect{ (uint32_t) r.x, (uint32_t) ((int32_t) mHeight - r.y - (int32_t) r.h),
                        r.w, r.h };
}

// Repaint the monster truck's CHASSIS (only) to one flat neutral, per instance.
//
// Every mesh in vehicle-monster-truck.glb shares a single `colormap` material,
// so there is no material-level handle on "the frame" — setting the base factor
// on the asset's instances repaints the tyres with it. The JS answer is to clone
// the material for the chassis mesh and null its map; the Filament equivalent is
// a per-PRIMITIVE instance on the chassis renderable, with the palette atlas
// swapped for a white 1×1 so the flat colour is the whole result.
void TtpRenderer::recolourMonsterChassis(gltfio::FilamentAsset* asset,
        const std::vector<gltfio::FilamentInstance*>& instances, const math::float4& rgba) {
    if (!asset) return;
    if (!mWhiteTex) {
        static const uint8_t WHITE[4] = { 255, 255, 255, 255 };
        mWhiteTex = Texture::Builder()
                .width(1).height(1).levels(1)
                .format(Texture::InternalFormat::SRGB8_A8)
                .sampler(Texture::Sampler::SAMPLER_2D)
                .build(*mEngine);
        if (mWhiteTex) {
            mWhiteTex->setImage(*mEngine, 0, Texture::PixelBufferDescriptor(
                    WHITE, sizeof(WHITE), Texture::Format::RGBA, Texture::Type::UBYTE));
        }
    }
    auto& rcm = mEngine->getRenderableManager();
    const TextureSampler smp(TextureSampler::MinFilter::NEAREST, TextureSampler::MagFilter::NEAREST);
    for (gltfio::FilamentInstance* inst : instances) {
        if (!inst) continue;
        const utils::Entity* ents = inst->getEntities();
        for (size_t k = 0; k < inst->getEntityCount(); k++) {
            const char* nm = asset->getName(ents[k]);
            if (!nm || std::strcmp(nm, "chassis") != 0) continue;
            const auto ri = rcm.getInstance(ents[k]);
            if (!ri) continue;
            for (size_t p = 0, n = rcm.getPrimitiveCount(ri); p < n; p++) {
                MaterialInstance* src = rcm.getMaterialInstanceAt(ri, p);
                if (!src) continue;
                MaterialInstance* own = MaterialInstance::duplicate(src, "monster-chassis");
                if (!own) continue;
                if (own->getMaterial()->hasParameter("baseColorFactor")) {
                    own->setParameter("baseColorFactor", rgba);
                }
                if (mWhiteTex && own->getMaterial()->hasParameter("baseColorMap")) {
                    own->setParameter("baseColorMap", mWhiteTex, smp);
                }
                mSceneMatInstances.push_back(own); // released with the scene
                rcm.setMaterialInstanceAt(ri, p, own);
            }
        }
    }
}

// The car's ground-shadow mask: a superellipse footprint with the JS bake's
// penumbra, at a resolution that can actually hold it.
//
// SceneRenderer renders each car model top-down into a 128-wide target and
// blurs the result by round(128 × 0.022) ≈ 3 px — "a crisp shadow edge near the
// loop's hard cast shadow, not a wide soft ring", as the source puts it. That
// is ~5% of the half-width, so the shape has to come from a texture; a vertex
// falloff on the conform grid could only ever be a smudge.
//
// The one thing this does NOT reproduce is the outline: three's is the model's
// real silhouette (cabin narrow, wheels poking out), ours a superellipse fitted
// to the same footprint. Same size, same softness, rounder corners.
Texture* TtpRenderer::buildShadowMask() {
    constexpr int TW = 128, TH = 160; // ~ the footprint's 1:1.25 aspect
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
    // White RGB so blurring the edge fades ALPHA only — a dark fringe otherwise
    // (the JS forces the same).
    auto* px = new std::vector<uint8_t>((size_t) TW * TH * 4, 255);
    for (size_t i = 0; i < a.size(); i++) {
        (*px)[i * 4 + 3] = (uint8_t) std::lround(std::min(1.0f, std::max(0.0f, a[i])) * 255.0f);
    }
    Texture* tex = Texture::Builder()
            .width(TW).height(TH).levels(8)
            .format(Texture::InternalFormat::SRGB8_A8)
            .sampler(Texture::Sampler::SAMPLER_2D)
            .usage(Texture::Usage::DEFAULT | Texture::Usage::GEN_MIPMAPPABLE)
            .build(*mEngine);
    if (!tex) { delete px; return nullptr; }
    tex->setImage(*mEngine, 0, Texture::PixelBufferDescriptor(
            px->data(), px->size(), Texture::Format::RGBA, Texture::Type::UBYTE,
            [](void*, size_t, void* user) { delete (std::vector<uint8_t>*) user; }, px));
    tex->generateMipmaps(*mEngine);
    return tex;
}

// Both blob masks arrive PRE-BLURRED — the baked silhouette through vblur, the
// generic rounded-rect fallback by construction — so the decal samples once and
// does no filtering of its own. Only the fallback carries mips.
void TtpRenderer::setBlobMask(MaterialInstance* mi, Texture* mask, bool baked) {
    if (!mi || !mask) return;
    TextureSampler smp(baked ? TextureSampler::MinFilter::LINEAR
                             : TextureSampler::MinFilter::LINEAR_MIPMAP_LINEAR,
            TextureSampler::MagFilter::LINEAR);
    smp.setWrapModeS(TextureSampler::WrapMode::CLAMP_TO_EDGE);
    smp.setWrapModeT(TextureSampler::WrapMode::CLAMP_TO_EDGE);
    mi->setParameter("albedo", mask, smp);
}

// The car's ground shadow, shaped like the CAR. SceneRenderer._bakeCarShadow
// puts an orthographic camera over the model, renders a flat white mask on
// transparent, and reads it back for the blur; the same picture here comes from
// an offscreen RenderTarget rendered with renderStandaloneView (there is no
// readback on this side, so the blur moved into vdecal.mat instead).
//
// The framing is the JS's: footprint × SHADOW_OVERSCAN, so the silhouette lands
// at footprint scale inside a quad with room for the penumbra tail. The camera
// looks UP from under the model rather than down on it: the outline is the same
// either way, and this is the handedness that makes the blob mesh's own UVs
// (u across → car right, v along → car forward) land unmirrored.
//
// Alpha is the coverage channel — opaque glTF materials write 1.0 there and the
// clear leaves 0 — which is why the bake needs no lights and doesn't care that
// an unlit car in an empty scene renders black.
Texture* TtpRenderer::bakeSilhouette(gltfio::FilamentAsset* asset,
        const float3& bbMin, const float3& bbMax) {
    if (!asset) return nullptr;
    return bakeSilhouette(asset->getEntities(), asset->getEntityCount(), bbMin, bbMax);
}

Texture* TtpRenderer::bakeSilhouette(const utils::Entity* entities, size_t count,
        const float3& bbMin, const float3& bbMax) {
    if (!entities || !count || !mRenderer || bbMax.x <= bbMin.x) return nullptr;
    // 128 was the pixelation: a hard-edged 128-px mask softened by a 25-tap
    // gaussian resolves its edge in about five quantised steps, and those steps
    // are the banding in the blob's gradient. 256 plus the bake-time blur below
    // gives the hardware something smooth to interpolate, and still only costs
    // ~0.5 MB a car.
    constexpr int TW = 256;
    const float hw = (bbMax.x - bbMin.x) * 0.5f * 1.45f;
    const float hl = (bbMax.z - bbMin.z) * 0.5f * 1.45f;
    if (hw <= 0 || hl <= 0) return nullptr;
    const int TH = std::max(16, (int) std::lround(TW * (hl / hw)));
    Texture* tex = Texture::Builder()
            .width((uint32_t) TW).height((uint32_t) TH).levels(1)
            .format(Texture::InternalFormat::RGBA8)
            .usage(Texture::Usage::COLOR_ATTACHMENT | Texture::Usage::SAMPLEABLE)
            .build(*mEngine);
    if (!tex) return nullptr;
    RenderTarget* rt = RenderTarget::Builder()
            .texture(RenderTarget::AttachmentPoint::COLOR, tex)
            .build(*mEngine);
    Scene* scene = mEngine->createScene();
    utils::Entity camEnt = utils::EntityManager::get().create();
    Camera* cam = mEngine->createCamera(camEnt);
    View* view = mEngine->createView();
    const float cx = (bbMin.x + bbMax.x) * 0.5f, cz = (bbMin.z + bbMax.z) * 0.5f;
    const float h = (bbMax.y - bbMin.y) + 2.0f;
    scene->addEntities(entities, count);
    cam->setProjection(Camera::Projection::ORTHO, -hw, hw, -hl, hl, 0.01, h);
    cam->lookAt({ cx, bbMin.y - 1.0f, cz }, { cx, bbMax.y, cz }, { 0, 0, -1 });
    view->setScene(scene);
    view->setCamera(cam);
    view->setViewport({ 0, 0, (uint32_t) TW, (uint32_t) TH });
    view->setRenderTarget(rt);
    view->setPostProcessingEnabled(false); // tone mapping would eat the alpha
    view->setShadowingEnabled(false);
    view->setBlendMode(View::BlendMode::TRANSLUCENT); // OPAQUE forces alpha to 1
    const Renderer::ClearOptions prev = mRenderer->getClearOptions();
    Renderer::ClearOptions co{};
    co.clearColor = { 0, 0, 0, 0 };
    co.clear = true;
    mRenderer->setClearOptions(co);
    mRenderer->renderStandaloneView(view);
    mRenderer->setClearOptions(prev);
    for (size_t i = 0; i < count; i++) scene->remove(entities[i]);
    mEngine->destroy(view);
    mEngine->destroy(rt);
    mEngine->destroyCameraComponent(camEnt);
    utils::EntityManager::get().destroy(camEnt);
    mEngine->destroy(scene);

    // Blur it ONCE, here, instead of rebuilding the penumbra with a 25-tap
    // gaussian in every fragment of every frame (see vblur.mat).
    if (mBlurMaterial && mPresentVB && mPresentIB) {
        Texture* soft = Texture::Builder()
                .width((uint32_t) TW).height((uint32_t) TH).levels(1)
                .format(Texture::InternalFormat::RGBA8)
                .usage(Texture::Usage::COLOR_ATTACHMENT | Texture::Usage::SAMPLEABLE)
                .build(*mEngine);
        if (soft) {
            RenderTarget* brt = RenderTarget::Builder()
                    .texture(RenderTarget::AttachmentPoint::COLOR, soft)
                    .build(*mEngine);
            MaterialInstance* bmi = mBlurMaterial->createInstance();
            TextureSampler ssmp(TextureSampler::MinFilter::LINEAR,
                    TextureSampler::MagFilter::LINEAR);
            ssmp.setWrapModeS(TextureSampler::WrapMode::CLAMP_TO_EDGE);
            ssmp.setWrapModeT(TextureSampler::WrapMode::CLAMP_TO_EDGE);
            bmi->setParameter("src", tex, ssmp);
            bmi->setParameter("texel",
                    math::float2{ 1.0f / (float) TW, 1.0f / (float) TH });
            bmi->setParameter("radius", 0.9f); // kernel spacing in source texels
            utils::Entity bq = utils::EntityManager::get().create();
            RenderableManager::Builder(1)
                    .boundingBox({ { 0, 0, 0 }, { 1, 1, 1 } })
                    .material(0, bmi)
                    .geometry(0, RenderableManager::PrimitiveType::TRIANGLES,
                            mPresentVB, mPresentIB, 0, 3)
                    .culling(false).castShadows(false).receiveShadows(false)
                    .build(*mEngine, bq);
            Scene* bs = mEngine->createScene();
            bs->addEntity(bq);
            utils::Entity bcamEnt = utils::EntityManager::get().create();
            Camera* bcam = mEngine->createCamera(bcamEnt);
            bcam->setProjection(Camera::Projection::ORTHO, -1, 1, -1, 1, 0, 1);
            View* bv = mEngine->createView();
            bv->setScene(bs);
            bv->setCamera(bcam);
            bv->setViewport({ 0, 0, (uint32_t) TW, (uint32_t) TH });
            bv->setRenderTarget(brt);
            bv->setPostProcessingEnabled(false);
            bv->setShadowingEnabled(false);
            bv->setFrustumCullingEnabled(false);
            bv->setBlendMode(View::BlendMode::TRANSLUCENT); // the mask IS alpha
            Renderer::ClearOptions bco{};
            bco.clear = true;
            bco.clearColor = { 0, 0, 0, 0 };
            const Renderer::ClearOptions bprev = mRenderer->getClearOptions();
            mRenderer->setClearOptions(bco);
            mRenderer->renderStandaloneView(bv);
            mRenderer->setClearOptions(bprev);
            mEngine->flushAndWait(); // `tex` dies next; let the pass read it first
            mEngine->destroy(bv);
            mEngine->destroy(brt);
            mEngine->destroy(bs);
            mEngine->destroy(bq);
            utils::EntityManager::get().destroy(bq);
            mEngine->destroyCameraComponent(bcamEnt);
            utils::EntityManager::get().destroy(bcamEnt);
            mEngine->destroy(bmi);
            mEngine->destroy(tex);
            return soft;
        }
    }
    return tex;
}

// ── Ground-conform probe ─────────────────────────────────────────────────────
// SceneRenderer keeps per-tile collision clones OUT of the scene graph and
// raycasts them straight down under each axle (_roadHitY). Our ribbon is one
// unindexed soup, so bucket its triangles by XZ cell instead and do the same
// cast analytically. Cells are small (kRoadCell) because the sweep lays ~0.24u
// rings: a 6u cell like the JS grid's would hold thousands of triangles.
static inline uint64_t roadCellKey(int cx, int cz) {
    return ((uint64_t) (uint32_t) cx << 32) | (uint32_t) cz;
}

void TtpRenderer::buildRoadGrid() {
    mRoadGrid.clear();
    const size_t triCount = mRoad.verts.size() / 3;
    for (size_t t = 0; t < triCount; t++) {
        const Vertex& a = mRoad.verts[t * 3];
        const Vertex& b = mRoad.verts[t * 3 + 1];
        const Vertex& c = mRoad.verts[t * 3 + 2];
        const float x0 = std::min(a.px, std::min(b.px, c.px));
        const float x1 = std::max(a.px, std::max(b.px, c.px));
        const float z0 = std::min(a.pz, std::min(b.pz, c.pz));
        const float z1 = std::max(a.pz, std::max(b.pz, c.pz));
        const int cx0 = (int) std::floor(x0 / kRoadCell), cx1 = (int) std::floor(x1 / kRoadCell);
        const int cz0 = (int) std::floor(z0 / kRoadCell), cz1 = (int) std::floor(z1 / kRoadCell);
        for (int cx = cx0; cx <= cx1; cx++) {
            for (int cz = cz0; cz <= cz1; cz++) {
                mRoadGrid[roadCellKey(cx, cz)].push_back((uint32_t) (t * 3));
            }
        }
    }
}

float TtpRenderer::roadHitY(float x, float z, float refY, bool* hit) const {
    *hit = false;
    const auto it = mRoadGrid.find(roadCellKey((int) std::floor(x / kRoadCell),
            (int) std::floor(z / kRoadCell)));
    if (it == mRoadGrid.end()) return refY; // off-track: caller keeps the centreline
    float best = refY, bestErr = 1e30f;
    for (const uint32_t t : it->second) {
        const Vertex& a = mRoad.verts[t];
        const Vertex& b = mRoad.verts[t + 1];
        const Vertex& c = mRoad.verts[t + 2];
        // Barycentric in the XZ plane — a vertical ray hits iff (x, z) is inside
        // the triangle's projection.
        const float d = (b.pz - c.pz) * (a.px - c.px) + (c.px - b.px) * (a.pz - c.pz);
        if (std::fabs(d) < 1e-9f) continue;
        const float l1 = ((b.pz - c.pz) * (x - c.px) + (c.px - b.px) * (z - c.pz)) / d;
        const float l2 = ((c.pz - a.pz) * (x - c.px) + (a.px - c.px) * (z - c.pz)) / d;
        const float l3 = 1.0f - l1 - l2;
        if (l1 < -1e-4f || l2 < -1e-4f || l3 < -1e-4f) continue;
        const float y = l1 * a.py + l2 * b.py + l3 * c.py;
        if (y > refY + 6.0f) continue; // the JS ray starts 6u above the car
        // Near-horizontal faces only (|n.y| > 0.1 normalized): drops the kerbs'
        // inner/outer walls and the skirt, keeps banked decks and ramps.
        const float3 e1{ b.px - a.px, b.py - a.py, b.pz - a.pz };
        const float3 e2{ c.px - a.px, c.py - a.py, c.pz - a.pz };
        const float3 n = cross(e1, e2);
        const float nl = length(n);
        if (nl < 1e-12f || std::fabs(n.y) <= 0.1f * nl) continue;
        const float err = std::fabs(y - refY);
        if (err < bestErr) { bestErr = err; best = y; *hit = true; }
    }
    return best;
}

// Unit UV-sphere (widthSegments × heightSegments, THREE.SphereGeometry layout):
// used by the sky dome (32×16) and hill domes (8×5). Appends transformed verts
// with a per-vertex colour callback into a Mesh.
void TtpRenderer::appendSphere(Mesh& mesh, int wseg, int hseg,
        const std::function<float3(const float3&)>& transform,
        const std::function<uint32_t(const float3&)>& colorAt, bool lit) {
    auto& verts = mesh.verts;
    auto& idx = mesh.idx;
    const uint32_t base = (uint32_t) verts.size();
    for (int iy = 0; iy <= hseg; iy++) {
        const float v = (float) iy / hseg;
        const float phi = v * (float) M_PI;
        for (int ix = 0; ix <= wseg; ix++) {
            const float u = (float) ix / wseg;
            const float theta = u * 2.0f * (float) M_PI;
            const float3 p = { -std::cos(theta) * std::sin(phi), std::cos(phi),
                               std::sin(theta) * std::sin(phi) };
            const float3 w = transform(p);
            verts.push_back({ w.x, w.y, w.z, colorAt(p) });
            if (lit) mesh.normals.push_back(p); // unit-sphere dir ≈ good enough
        }
    }
    const int stride = wseg + 1;
    for (int iy = 0; iy < hseg; iy++) {
        for (int ix = 0; ix < wseg; ix++) {
            const uint32_t a = base + iy * stride + ix;
            const uint32_t b = a + stride;
            idx.insert(idx.end(), { a, b, a + 1, a + 1, b, b + 1 });
        }
    }
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

// Area-weighted per-vertex normal accumulation: soup faces come out flat,
// shared-ring surfaces smooth — the toy read either way.
void TtpRenderer::accumulateNormals(Mesh& m) {
    m.normals.assign(m.verts.size(), float3{ 0, 0, 0 });
    for (size_t i = 0; i + 2 < m.idx.size(); i += 3) {
        const Vertex& A = m.verts[m.idx[i]];
        const Vertex& B = m.verts[m.idx[i + 1]];
        const Vertex& C = m.verts[m.idx[i + 2]];
        const float3 a{ A.px, A.py, A.pz }, b{ B.px, B.py, B.pz }, c{ C.px, C.py, C.pz };
        const float3 n = cross(b - a, c - a); // area-weighted
        m.normals[m.idx[i]] += n;
        m.normals[m.idx[i + 1]] += n;
        m.normals[m.idx[i + 2]] += n;
    }
    for (float3& n : m.normals) {
        const float len = length(n);
        n = len > 1e-9f ? n / len : float3{ 0, 1, 0 };
    }
}

// Trackside scenery — an EXACT replay of buildScenery's seeded streams (the
// same LCG, the same rand() consumption order, the same corridor clearance),
// so every tree/bush/boulder lands where the Three.js scatter puts it. Trees
// and bushes become gltfio instances (per-tree shade jitter is consumed from
// the stream but not applied — instances share materials); boulders are a
// merged vertex-tinted icosahedron mesh.
void TtpRenderer::buildScenery(const TrackBin& tb) {
    // NOT gated on having trees. The playroom is an indoor floor with none at
    // all (mix.tree = 0, so every roll lands on the "boulder" channel, which is
    // what its scattered toy bits ARE) — bailing here dropped that whole pass
    // and left the floor bare. The JS bails inside placeTree instead, and only
    // for a roll that actually wants a tree.
    if (tb.scDensity <= 0) return;
    uint32_t seed = tb.scSeed1;
    const auto rnd = [&]() {
        seed = seed * 1664525u + 1013904223u;
        return (double) seed / 4294967296.0;
    };
    const float defHalf = tb.roadWidth / 2;
    const float MARGIN = 2.2f;
    const auto isClear = [&](float x, float z) {
        for (const auto& s : tb.samples) {
            const float half = s.width / 2 + MARGIN;
            const float dx = x - s.pos.x, dz = z - s.pos.z;
            if (dx * dx + dz * dz < half * half) return false;
        }
        return true;
    };

    struct Placement { uint32_t model; float x, z, s, syJit, yaw, sink; };
    std::vector<Placement> placements;
    // placeTree with the exact rand order: pick, size, yaw, height jitter,
    // shade (consumed; unapplied — see above).
    const auto placeTree = [&](float x, float z, int forceModel, float forceS, float sink) {
        uint32_t model = 0;
        float s = forceS;
        if (forceModel < 0) {
            // No tree palette (the playroom): bail BEFORE drawing, exactly where
            // the JS does, so the shared rand stream stays in step.
            if (tb.scTrees.empty()) return;
            const double r = rnd();
            double acc = 0;
            model = tb.scTrees.back().model;
            float s0 = tb.scTrees.back().s0, s1 = tb.scTrees.back().s1;
            for (const auto& e : tb.scTrees) {
                acc += e.w;
                if (r < acc) { model = e.model; s0 = e.s0; s1 = e.s1; break; }
            }
            s = s0 + (float) rnd() * s1;
        } else {
            model = (uint32_t) forceModel;
        }
        const float yaw = (float) rnd() * 2.0f * (float) M_PI;
        const float syJit = 0.92f + (float) rnd() * 0.16f;
        (void) rnd(); // shade
        placements.push_back({ model, x, z, s, syJit, yaw, sink });
    };

    struct Boulder { float x, z, rr, sy, yaw; uint32_t grey; float shade; };
    std::vector<Boulder> boulders;
    for (float d = 0; d < tb.length; d += 7) {
        const TrackBin::Sample f = tb.frameAt(d);
        const float half = f.width / 2;
        for (const int side : { -1, 1 }) {
            if (rnd() > tb.scDensity) continue;
            const float lat = side * (half + 2.5f + (float) rnd() * 9.0f);
            const float x = f.pos.x + f.lat.x * lat + ((float) rnd() - 0.5f) * 3.0f;
            const float z = f.pos.z + f.lat.z * lat + ((float) rnd() - 0.5f) * 3.0f;
            if (!isClear(x, z)) continue;
            const double roll = rnd();
            if (roll < tb.scMixTree) {
                placeTree(x, z, -1, 0, 0);
                if (rnd() < 0.45) { // copse companions
                    const int extra = 1 + (int) std::floor(rnd() * 2);
                    for (int e = 0; e < extra; e++) {
                        const float a = (float) rnd() * 2.0f * (float) M_PI;
                        const float r = 1.6f + (float) rnd() * 1.6f;
                        const float ex = x + std::cos(a) * r, ez = z + std::sin(a) * r;
                        if (isClear(ex, ez)) placeTree(ex, ez, -1, 0, 0);
                    }
                }
            } else if (roll < tb.scMixBush && tb.scHasBush) {
                const float bs = tb.scBush.s0 + (float) rnd() * tb.scBush.s1;
                placeTree(x, z, (int) tb.scBush.model, bs, tb.scBush.sink);
            } else {
                Boulder b;
                b.rr = tb.scRockS[0] + (float) rnd() * tb.scRockS[1];
                b.grey = tb.scRocks[(size_t) std::floor(rnd() * tb.scRocks.size())];
                b.shade = 0.92f + (float) rnd() * 0.16f;
                b.sy = 0.55f + (float) rnd() * 0.3f;
                b.yaw = (float) rnd() * 2.0f * (float) M_PI;
                b.x = x; b.z = z;
                boulders.push_back(b);
            }
        }
    }

    // Trees/bushes: one instanced asset per scenery model.
    mSceneryAssets.resize(tb.scModelCount, nullptr);
    mSceneryInstances.resize(tb.scModelCount);
    for (uint32_t m = 0; m < tb.scModelCount; m++) {
        size_t count = 0;
        for (const auto& p : placements) if (p.model == m) count++;
        if (!count) continue;
        const std::string name = "scenery" + std::to_string(m) + ".glb";
        mSceneryAssets[m] = loadInstancedProp(name.c_str(), count, mSceneryInstances[m]);
        if (!mSceneryAssets[m]) continue;
        // The kits ship several of these with metallicFactor 1, which under real
        // PBR renders them near-BLACK (a metal with only the SH ambient to
        // reflect). The JS never sees it — every scenery piece is Lambert
        // there — so force the same matte read on all of them.
        //
        // Biome recolour on top: buildScenery bakes theme tints into vertex
        // colours for UNTEXTURED models; here the same colours land on the
        // matching material instances (gltfio names them after the glTF
        // material). The JS's small per-tree shade jitter isn't reproduced —
        // these are shared instances.
        for (auto* inst : mSceneryInstances[m]) {
            MaterialInstance* const* mis = inst->getMaterialInstances();
            for (size_t i = 0; i < inst->getMaterialInstanceCount(); i++) {
                mis[i]->setParameter("metallicFactor", 0.0f);
                mis[i]->setParameter("roughnessFactor", 1.0f);
                if (m >= tb.modelTints.size()) continue;
                const char* nm = mis[i]->getName();
                for (const auto& t : tb.modelTints[m]) {
                    if (t.name == nm) {
                        mis[i]->setParameter("baseColorFactor",
                                float4{ srgbToLinear(t.rgb), 1.0f });
                    }
                }
            }
        }
        auto& tcm = mEngine->getTransformManager();
        size_t k = 0;
        for (const auto& p : placements) {
            if (p.model != m) continue;
            const mat4f xf = mat4f::translation(
                    float3{ p.x, tb.groundY - p.sink * p.s, p.z })
                    * mat4f::rotation(p.yaw, float3{ 0, 1, 0 })
                    * mat4f::scaling(float3{ p.s, p.s * p.syJit, p.s });
            tcm.setTransform(tcm.getInstance(mSceneryInstances[m][k]->getRoot()), xf);
            mShadowSpots.push_back({ p.x, p.z, 0.62f * p.s, 0.8f * p.s });
            k++;
        }
    }

    // Boulders: flat-shaded icosahedra, vertex-tinted greys.
    if (!boulders.empty()) {
        const float T = (1.0f + std::sqrt(5.0f)) / 2.0f;
        const float3 V[12] = {
            { -1, T, 0 }, { 1, T, 0 }, { -1, -T, 0 }, { 1, -T, 0 },
            { 0, -1, T }, { 0, 1, T }, { 0, -1, -T }, { 0, 1, -T },
            { T, 0, -1 }, { T, 0, 1 }, { -T, 0, -1 }, { -T, 0, 1 },
        };
        const int F[20][3] = {
            { 0, 11, 5 }, { 0, 5, 1 }, { 0, 1, 7 }, { 0, 7, 10 }, { 0, 10, 11 },
            { 1, 5, 9 }, { 5, 11, 4 }, { 11, 10, 2 }, { 10, 7, 6 }, { 7, 1, 8 },
            { 3, 9, 4 }, { 3, 4, 2 }, { 3, 2, 6 }, { 3, 6, 8 }, { 3, 8, 9 },
            { 4, 9, 5 }, { 2, 4, 11 }, { 6, 2, 10 }, { 8, 6, 7 }, { 9, 8, 1 },
        };
        const float INV = 1.0f / std::sqrt(1 + T * T);
        for (const Boulder& b : boulders) {
            const uint32_t col = packLinear(srgbToLinear(b.grey), b.shade);
            const float cy = std::cos(b.yaw), sy = std::sin(b.yaw);
            for (const auto& face : F) {
                for (int vi = 0; vi < 3; vi++) {
                    float3 p = V[face[vi]] * INV;
                    p = { p.x * b.rr, p.y * b.rr * b.sy, p.z * b.rr };
                    const float rx = p.x * cy + p.z * sy, rz = -p.x * sy + p.z * cy;
                    mBoulders.verts.push_back({ b.x + rx, tb.groundY + b.rr * 0.25f + p.y,
                                                b.z + rz, col });
                }
            }
        }
        mBoulders.idx.resize(mBoulders.verts.size());
        for (uint32_t i = 0; i < mBoulders.idx.size(); i++) mBoulders.idx[i] = i;
        accumulateNormals(mBoulders); // soup → flat faceted, the kit read
        buildMesh(mBoulders);
    }
}

namespace {
// Minimal primitive soup generators for the landmark builders (THREE-geometry
// layouts: primitives centred like their THREE counterparts). Verts append as
// {pos} + a caller-side transform + flat colour.
using PrimVerts = std::vector<float3>;
struct Prim { PrimVerts v; std::vector<uint32_t> i; };

// Per-FACE vertices, like THREE.BoxGeometry. Sharing the 8 corners let
// accumulateNormals average the three face normals into each corner, so every
// box came out SMOOTH-shaded — a gradient across each wall instead of six flat
// tones (the doghouse's brown was the tell).
Prim primBox(float w, float h, float d) {
    Prim p;
    const float x = w / 2, y = h / 2, z = d / 2;
    const float3 c[8] = { { -x, -y, -z }, { x, -y, -z }, { -x, y, -z }, { x, y, -z },
                          { -x, -y, z }, { x, -y, z }, { -x, y, z }, { x, y, z } };
    static const uint32_t FACE[6][6] = {
        { 0,2,1, 1,2,3 }, { 4,5,6, 5,7,6 }, { 0,1,4, 1,5,4 },
        { 2,6,3, 3,6,7 }, { 0,4,2, 2,4,6 }, { 1,3,5, 3,7,5 },
    };
    for (const auto& f : FACE) {
        uint32_t map[8];
        bool has[8] = {};
        for (int k = 0; k < 6; k++) {
            const uint32_t src = f[k];
            if (!has[src]) {
                map[src] = (uint32_t) p.v.size();
                p.v.push_back(c[src]);
                has[src] = true;
            }
            p.i.push_back(map[src]);
        }
    }
    return p;
}
Prim primCylinder(float rTop, float rBot, float h, int seg) {
    Prim p;
    for (int j = 0; j <= seg; j++) {
        const float a = (float) j / seg * 2.0f * (float) M_PI;
        p.v.push_back({ std::cos(a) * rBot, -h / 2, std::sin(a) * rBot });
        p.v.push_back({ std::cos(a) * rTop, h / 2, std::sin(a) * rTop });
    }
    for (int j = 0; j < seg; j++) {
        const uint32_t a = j * 2, b = a + 1, c2 = a + 2, d = a + 3;
        p.i.insert(p.i.end(), { a, c2, b, b, c2, d });
    }
    // Caps get their OWN rim vertices (THREE.CylinderGeometry does the same):
    // sharing the wall's rim rounds the top edge off into the side.
    const uint32_t capBase = (uint32_t) p.v.size();
    for (int j = 0; j <= seg; j++) {
        const float a = (float) j / seg * 2.0f * (float) M_PI;
        p.v.push_back({ std::cos(a) * rBot, -h / 2, std::sin(a) * rBot });
        p.v.push_back({ std::cos(a) * rTop, h / 2, std::sin(a) * rTop });
    }
    const uint32_t botC = (uint32_t) p.v.size(); p.v.push_back({ 0, -h / 2, 0 });
    const uint32_t topC = (uint32_t) p.v.size(); p.v.push_back({ 0, h / 2, 0 });
    for (int j = 0; j < seg; j++) {
        p.i.insert(p.i.end(), { botC, capBase + (uint32_t) j * 2,
                capBase + (uint32_t) (j + 1) * 2 });
        p.i.insert(p.i.end(), { topC, capBase + (uint32_t) (j + 1) * 2 + 1,
                capBase + (uint32_t) j * 2 + 1 });
    }
    return p;
}
Prim primCone(float r, float h, int seg) { return primCylinder(0.001f, r, h, seg); }
Prim primIco(float r) {
    Prim p;
    const float T = (1.0f + std::sqrt(5.0f)) / 2.0f;
    const float3 V[12] = { { -1, T, 0 }, { 1, T, 0 }, { -1, -T, 0 }, { 1, -T, 0 },
                           { 0, -1, T }, { 0, 1, T }, { 0, -1, -T }, { 0, 1, -T },
                           { T, 0, -1 }, { T, 0, 1 }, { -T, 0, -1 }, { -T, 0, 1 } };
    const int F[20][3] = { { 0,11,5 },{ 0,5,1 },{ 0,1,7 },{ 0,7,10 },{ 0,10,11 },
                           { 1,5,9 },{ 5,11,4 },{ 11,10,2 },{ 10,7,6 },{ 7,1,8 },
                           { 3,9,4 },{ 3,4,2 },{ 3,2,6 },{ 3,6,8 },{ 3,8,9 },
                           { 4,9,5 },{ 2,4,11 },{ 6,2,10 },{ 8,6,7 },{ 9,8,1 } };
    const float inv = r / std::sqrt(1 + T * T);
    // SOUP, not shared corners: PolyhedronGeometry flat-shades at detail 0
    // (computeVertexNormals per face), and the faceted read is the point —
    // boulders, pebbles, scrub and the hoodoo caps all want it.
    for (const auto& f : F) {
        for (const int k : { 0, 1, 2 }) {
            p.i.push_back((uint32_t) p.v.size());
            p.v.push_back(V[f[k]] * inv);
        }
    }
    return p;
}
// One level of THREE.IcosahedronGeometry's subdivision (detail 1): each face
// split into four, every vertex pushed back onto the sphere.
Prim primIcoDetail(float r, int detail) {
    Prim p = primIco(1.0f);
    if (detail <= 0) { for (float3& v : p.v) v = v * r; return p; }
    for (int d = 0; d < detail; d++) {
        Prim q;
        // SHARE the corners: PolyhedronGeometry normalizes its normals once it
        // subdivides (detail > 0), so the result reads as a smooth ball, and
        // shared corners are what let accumulateNormals average into that.
        std::unordered_map<uint64_t, uint32_t> seen;
        const auto vert = [&](const float3& v) {
            const auto key = [](float f) { return (uint64_t) (uint32_t) std::lround(f * 100000.0f); };
            const uint64_t k = key(v.x) * 73856093ull ^ key(v.y) * 19349663ull ^ key(v.z) * 83492791ull;
            const auto it = seen.find(k);
            if (it != seen.end()) return it->second;
            const uint32_t idx = (uint32_t) q.v.size();
            q.v.push_back(v);
            seen[k] = idx;
            return idx;
        };
        for (size_t t = 0; t + 2 < p.i.size(); t += 3) {
            const float3 a = p.v[p.i[t]], b = p.v[p.i[t + 1]], c = p.v[p.i[t + 2]];
            const float3 ab = normalize((a + b) * 0.5f);
            const float3 bc = normalize((b + c) * 0.5f);
            const float3 ca = normalize((c + a) * 0.5f);
            const uint32_t ia = vert(a), ib = vert(b), ic = vert(c);
            const uint32_t iab = vert(ab), ibc = vert(bc), ica = vert(ca);
            for (const uint32_t k : { ia, iab, ica, iab, ib, ibc, ica, ibc, ic, iab, ibc, ica }) {
                q.i.push_back(k);
            }
        }
        p = q;
    }
    for (float3& v : p.v) v = v * r;
    return p;
}

// UV sphere over a PHI RANGE (THREE.SphereGeometry's phiStart/phiLength args):
// the seashell is the top half of a squashed dome.
Prim primSphereBand(float r, int ws, int hs, float phi0, float phiLen) {
    Prim p;
    for (int iy = 0; iy <= hs; iy++) {
        const float phi = phi0 + (float) iy / hs * phiLen;
        for (int ix = 0; ix <= ws; ix++) {
            const float th = (float) ix / ws * 2.0f * (float) M_PI;
            p.v.push_back({ -std::cos(th) * std::sin(phi) * r, std::cos(phi) * r,
                            std::sin(th) * std::sin(phi) * r });
        }
    }
    const int stride = ws + 1;
    for (int iy = 0; iy < hs; iy++) {
        for (int ix = 0; ix < ws; ix++) {
            const uint32_t a = iy * stride + ix, b = a + stride;
            p.i.insert(p.i.end(), { a, b, a + 1, a + 1, b, b + 1 });
        }
    }
    return p;
}

Prim primSphere(float r, int ws, int hs) {
    Prim p;
    for (int iy = 0; iy <= hs; iy++) {
        const float phi = (float) iy / hs * (float) M_PI;
        for (int ix = 0; ix <= ws; ix++) {
            const float th = (float) ix / ws * 2.0f * (float) M_PI;
            p.v.push_back({ -std::cos(th) * std::sin(phi) * r, std::cos(phi) * r,
                            std::sin(th) * std::sin(phi) * r });
        }
    }
    const int stride = ws + 1;
    for (int iy = 0; iy < hs; iy++) {
        for (int ix = 0; ix < ws; ix++) {
            const uint32_t a = iy * stride + ix, b = a + stride;
            p.i.insert(p.i.end(), { a, b, a + 1, a + 1, b, b + 1 });
        }
    }
    return p;
}
Prim primTorusArc(float R, float tube, int tubeSeg, int radSeg, float arc) {
    Prim p;
    for (int j = 0; j <= radSeg; j++) {
        const float u = (float) j / radSeg * arc;
        for (int k = 0; k <= tubeSeg; k++) {
            const float v = (float) k / tubeSeg * 2.0f * (float) M_PI;
            p.v.push_back({ (R + tube * std::cos(v)) * std::cos(u),
                            tube * std::sin(v),
                            (R + tube * std::cos(v)) * std::sin(u) });
        }
    }
    const int stride = tubeSeg + 1;
    for (int j = 0; j < radSeg; j++) {
        for (int k = 0; k < tubeSeg; k++) {
            const uint32_t a = j * stride + k, b = a + stride;
            p.i.insert(p.i.end(), { a, b, a + 1, a + 1, b, b + 1 });
        }
    }
    return p;
}
Prim applyPre(Prim p, const mat4f& m) {
    for (auto& v : p.v) v = (m * float4{ v, 1 }).xyz;
    return p;
}

// A flat PLATE: a convex outline in the (y,z) plane, extruded by `t` along x.
//
// The one shape neither a box nor a cylinder makes — a fin, a cowcatcher, a
// hat brim, a nameplate. Every model that wanted one before either did without
// or spent a rotated box on it, which is why the rocket's fins were rectangles
// standing straight up rather than anything swept. Outline points are (y, z)
// and must be convex and consistently wound; the material culls nothing, so a
// backwards winding costs shading, not visibility.
Prim primPlate(const std::vector<std::pair<float, float>>& yz, float t) {
    Prim p;
    const uint32_t n = (uint32_t) yz.size();
    if (n < 3) return p;
    const float h = t / 2;
    for (int side = 0; side < 2; side++) {
        for (const auto& q : yz) p.v.push_back({ side ? h : -h, q.first, q.second });
    }
    for (uint32_t k = 1; k + 1 < n; k++) {
        p.i.insert(p.i.end(), { 0u, k + 1, k });                    // -x face
        p.i.insert(p.i.end(), { n, n + k, n + k + 1 });             // +x face
    }
    for (uint32_t k = 0; k < n; k++) {                              // the rim
        const uint32_t a = k, b = (k + 1) % n;
        p.i.insert(p.i.end(), { a, b, n + b, a, n + b, n + a });
    }
    return p;
}

// ---------------------------------------------------------------------------
// MODEL VARIANTS — three takes on each of the props worth looking at closely.
//
// WHY THESE ARE FUNCTIONS AND NOT INLINE IN buildLandmarks. Two callers need
// the same geometry from different frames: the landmark placer, which stands
// ONE of them wherever its clearance search lands, and the MODEL BENCH, which
// stands ALL of them in a row so they can be judged against each other. A
// model authored inline in the placer can only ever be seen in the place the
// placer chose, next to nothing to compare it with — which is how the rocket
// shipped as four rectangles and a cone for as long as it did.
//
// Everything emits through a `part` callback in the model's OWN local frame
// (y up, +z forward, origin on the ground for the standing models and at the
// body centre for the rocket, whose +y is its nose). Placement, yaw and world
// offset are the caller's.
//
// VARIANT 0 IS ALWAYS WHAT SHIPPED BEFORE, byte for byte. That is what makes
// the bench a decision rather than a fait accompli: the row's first entry is
// the thing being argued against, and picking it is a legitimate outcome.
// ---------------------------------------------------------------------------

using PartFn = std::function<void(const Prim&, float, float, float, uint32_t, float)>;

enum ModelId { MODEL_ROCKET = 0, MODEL_GNOME = 1, MODEL_TRAIN = 2, MODEL_COUNT = 3 };

// How many takes each model has. PER MODEL, because they are not all being
// asked the same question: the gnome and the train were asked "how much
// detail", which two answers bracket, while the rocket is being asked "what
// SHAPE", and that needs as many entries as there are shapes worth arguing
// about. A single count for all three would either starve one row or pad the
// others with a duplicate.
inline int modelVariantCount(int id) { return id == MODEL_ROCKET ? 4 : 3; }

// Model ids are a URL param and a dropdown value, so they are spelled, not
// numbered. Unknown names answer -1 (the caller leaves the bench off).
int modelIdByName(const char* name) {
    if (!name || !*name) return -1;
    const std::string n = name;
    if (n == "rocket") return MODEL_ROCKET;
    if (n == "gnome") return MODEL_GNOME;
    if (n == "train") return MODEL_TRAIN;
    return -1;
}

const mat4f rotXm(float a) { return mat4f::rotation(a, float3{ 1, 0, 0 }); }
const mat4f rotYm(float a) { return mat4f::rotation(a, float3{ 0, 1, 0 }); }
const mat4f rotZm(float a) { return mat4f::rotation(a, float3{ 0, 0, 1 }); }

// ---- the wind-up train's stadium ------------------------------------------
// Two straights along local X at z = ±TRAIN_RT, joined by half-circles at
// x = ±TRAIN_LT/2, run counter-clockwise.
//
// ONE definition of it, and that is the point of these being here. The RAILS
// are laid from this at scene build and the LOCO is driven round it every
// frame, from code eight thousand lines apart — and sleepers spaced along a
// path that disagreed by a hair with the one the train takes is a toy train
// running beside its own track. The two used to share nothing but a pair of
// retyped constants and a comment.
constexpr float TRAIN_RT = 5.0f, TRAIN_LT = 7.0f;
// THE GAUGE IS THE LOCO'S OWN WHEEL TRACK (buildTrainModel puts the tyres at
// x = ±0.58). It was 0.32 — barely half that — so the wheels ran outside the
// rails, which nobody could see while the "track" was two thin brown lines
// lying in the grass. A ladder of sleepers makes it obvious in one glance, and
// that is the general shape of what laying real track flushed out.
constexpr float TRAIN_GAUGE = 0.58f;      // rail centres, either side of the line
constexpr float TRAIN_SLEEPER_Y = 0.055f; // sleeper top
constexpr float TRAIN_RAIL_Y = 0.10f;     // rail axis, sitting on the sleepers
constexpr float TRAIN_RAIL_R = 0.045f;
// What the loco's wheels stand on: the top of the railhead, not its centre.
constexpr float TRAIN_RIDE_Y = TRAIN_RAIL_Y + TRAIN_RAIL_R;

struct TrainAt { float x, z, dx, dz; };
inline float trainPerim() { return 2 * TRAIN_LT + 2 * (float) M_PI * TRAIN_RT; }
inline TrainAt trainAt(float s) {
    const float R = TRAIN_RT, L = TRAIN_LT, ARC = (float) M_PI * R;
    if (s < L) return { -L / 2 + s, -R, 1, 0 };                 // near straight, +X
    if (s < L + ARC) {                                          // right end
        const float u = (s - L) / R;
        return { L / 2 + std::sin(u) * R, -std::cos(u) * R, std::cos(u), std::sin(u) };
    }
    if (s < 2 * L + ARC) {                                      // far straight, -X
        return { L / 2 - (s - L - ARC), R, -1, 0 };
    }
    const float u = (s - 2 * L - ARC) / R;                      // left end
    return { -L / 2 - std::sin(u) * R, std::cos(u) * R, -std::cos(u), -std::sin(u) };
}

// ---- rocket ---------------------------------------------------------------
// SLEEK AND MODERN, decided after four rounds of toy shapes were turned down.
// v1 "cruise" is the one that was picked and is what ships; 2 and 3 are the
// other two readings of the same brief, kept for comparison.
//
// THE RULE IS "NO BANDS", not "no colour", and that distinction is the whole
// lesson of this file. Every attempt before these inherited red-and-cream
// BANDING from v0, and banding is why so many of them read as a traffic cone or
// a lighthouse whatever shape they were given — it was a palette problem being
// solved as a shape problem for four rounds. The picked one is red and yellow
// and still reads as a machine, because the colour changes where the OBJECT
// changes: nose, body, tail, wings. A stripe is what a toy has; a change of
// part is what a machine has.
//
// Colour zones are LARGE and there are never more than three hues on one model.
//
// ONE CONSTRAINT STILL SHAPES ALL OF THEM: TtpRenderer::render whizz-rolls a
// rocket about its travel axis at 9 rad/s, so anything not rotationally
// symmetric WHIRLS. Fins at 90 or 120 degrees read as a still object because
// the eye cannot tell one blade from the next; a pair of wings or a stripe down
// one side reads as a propeller. Everything here is on the axis, three-fold or
// four-fold.
//
// Ship scale is 0.2 world units and it is only ever seen crossing the screen at
// speed, so VALUE is the other thing that matters: the body stays near-white on
// all three, because the thing it flies over is dark asphalt and a mid-grey
// missile disappears into it.
void buildRocketModel(const PartFn& part, int variant) {
    constexpr uint32_t SHELL = 0xeef1f5,   // cool near-white — the body, always
                       GREY = 0x9aa3b0,    // mid, for the second zone
                       GRAPHITE = 0x3d4453;// dark, for tails and blades
    constexpr uint32_t RED = 0xe6492d, CREAM = 0xfff3e0, DARK = 0x37414f;
    // Nose is local +Y; the renderer lays that along the direction of travel.
    if (variant <= 0) {
        // v0 — the original toy rocket, kept as the thing to argue against and
        // as the only place that red-and-cream survives.
        part(primCylinder(0.07f, 0.085f, 0.2f, 14), 0, 0, 0, RED, 1.0f);
        part(primCone(0.07f, 0.17f, 14), 0, 0.185f, 0, CREAM, 1.0f);
        for (int i = 0; i < 3; i++) {
            const float a = (float) i * (2.0f * (float) M_PI / 3);
            part(applyPre(primBox(0.012f, 0.085f, 0.07f), rotYm((float) M_PI / 2 - a)),
                    std::cos(a) * 0.085f, -0.055f, std::sin(a) * 0.085f, DARK, 1.0f);
        }
        return;
    }
    if (variant == 1) {
        // v1 "cruise" — THE PICK, and now in the game's own colours: a red
        // parallel body, a yellow OGIVE nose (a stretched sphere, so there is
        // no crease where a cone would meet the tube), a deep-red boat-tail and
        // THREE swept wings.
        //
        // Red and yellow rather than the grey it was drawn in, and the no-bands
        // rule is what keeps that from sliding back into the traffic cone every
        // earlier attempt turned into: these are four PARTS in two hues, not
        // stripes painted across one shape. The wings are yellow because they
        // are the thinnest thing on it and the first to be lost against a dark
        // deck; the nose is yellow because that is the end you want to read
        // when it is coming at you.
        constexpr uint32_t HULL = 0xe6492d, TRIM = 0xf2c14e, DEEP = 0xa8382a;
        part(primCylinder(0.078f, 0.078f, 0.240f, 18), 0, 0, 0, HULL, 1.0f);
        part(applyPre(primSphere(0.078f, 18, 12),
                    mat4f::scaling(float3{ 1.0f, 1.9f, 1.0f })), 0, 0.120f, 0, TRIM, 1.0f);
        part(primCylinder(0.078f, 0.056f, 0.055f, 18), 0, -0.1475f, 0, DEEP, 1.0f);
        // Kept SMALL: they sit on the back third of the body and reach about
        // half a body-radius past it, which is enough to read as wings without
        // becoming the widest thing about the object. Three at 120 degrees is
        // rotationally symmetric enough that the 9 rad/s roll reads as a still
        // object rather than a propeller.
        const Prim wing = primPlate({ { -0.052f, 0.068f }, { -0.164f, 0.068f },
                                      { -0.170f, 0.130f }, { -0.100f, 0.122f } }, 0.012f);
        for (int i = 0; i < 3; i++) {
            part(applyPre(wing, rotYm((float) i * (2.0f * (float) M_PI / 3))), 0, 0, 0,
                    TRIM, 1.0f);
        }
        return;
    }
    if (variant == 2) {
        // v2 "stealth" — the same class of object built out of FLAT PLANES
        // instead of curves: six-sided body and nose, so it catches the light in
        // facets rather than a smooth gradient, with three hard angular blades.
        // The difference from v1 is entirely geometric — same palette, same
        // proportions, no curve anywhere.
        part(primCylinder(0.072f, 0.090f, 0.235f, 6), 0, 0, 0, SHELL, 1.0f);
        part(primCone(0.072f, 0.175f, 6), 0, 0.205f, 0, GRAPHITE, 1.0f);
        part(primCylinder(0.090f, 0.066f, 0.050f, 6), 0, -0.1425f, 0, GREY, 1.0f);
        const Prim fin = primPlate({ { -0.030f, 0.076f }, { -0.150f, 0.086f },
                                     { -0.168f, 0.170f } }, 0.014f);
        for (int i = 0; i < 3; i++) {
            part(applyPre(fin, rotYm((float) i * (2.0f * (float) M_PI / 3))), 0, 0, 0,
                    GRAPHITE, 1.0f);
        }
        return;
    }
    // v3 "lance" — long and slender, and finned along its LENGTH rather than at
    // the tail: four narrow strakes running most of the body. That puts the
    // widest part of the outline in the middle instead of at one end, which is
    // the one proportion none of the eleven shapes before this had.
    part(primCylinder(0.060f, 0.070f, 0.300f, 16), 0, 0, 0, SHELL, 1.0f);
    part(primCone(0.060f, 0.175f, 16), 0, 0.2375f, 0, GRAPHITE, 1.0f);
    part(primCylinder(0.070f, 0.052f, 0.045f, 16), 0, -0.1725f, 0, GRAPHITE, 1.0f);
    const Prim strake = primPlate({ { 0.105f, 0.062f }, { -0.135f, 0.068f },
                                    { -0.135f, 0.101f }, { 0.088f, 0.079f } }, 0.010f);
    for (int i = 0; i < 4; i++) {
        part(applyPre(strake, rotYm((float) i * (float) M_PI / 2)), 0, 0, 0, GREY, 1.0f);
    }
}

// ---- garden gnome ---------------------------------------------------------
// Origin on the ground, facing +z. ~2.7 units tall at v0.
void buildGnomeModel(const PartFn& part, int variant) {
    constexpr uint32_t COAT = 0x3b6fb0, BOOT = 0x4a3a2e, SKIN = 0xf0c8a2,
                       NOSE = 0xe8a87e, HAIR = 0xf5f2ea, HAT = 0xd8463f,
                       GOLD = 0xf2c14e, INK = 0x2a2735, ROSY = 0xe89a86;
    if (variant <= 0) {
        // v0 — what shipped: cone, ball, beard, hat. No arms, no face.
        part(primCone(0.62f, 1.3f, 10), 0, 0.65f, 0, COAT, 1.0f);
        for (const int sd : { -1, 1 })
            part(primIcoDetail(0.13f, 1), sd * 0.24f, 0.09f, 0.14f, BOOT, 1.0f);
        part(primSphere(0.36f, 12, 9), 0, 1.42f, 0, SKIN, 1.0f);
        part(primIcoDetail(0.1f, 1), 0, 1.4f, 0.35f, NOSE, 1.0f);
        Prim beard = primIcoDetail(0.32f, 1);
        for (auto& v : beard.v) { v.y *= 1.2f; v.z *= 0.62f; }
        part(beard, 0, 1.12f, 0.18f, HAIR, 1.0f);
        part(applyPre(primCone(0.42f, 1.25f, 10), rotXm(-0.12f)), 0, 2.1f, -0.04f, HAT, 1.0f);
        return;
    }

    // Shared between v1 and v2: the body, the face and the beard. Only the hat
    // and what he is holding change.
    for (const int sd : { -1, 1 }) {
        part(primIcoDetail(0.155f, 1), sd * 0.25f, 0.11f, 0.13f, BOOT, 1.0f);
        part(primIcoDetail(0.095f, 1), sd * 0.25f, 0.075f, 0.29f, BOOT, 0.92f);
    }
    part(primCone(0.64f, 1.28f, 14), 0, 0.64f, 0, COAT, 1.0f);
    part(primTorusArc(0.375f, 0.072f, 8, 22, 2.0f * (float) M_PI), 0, 0.62f, 0, BOOT, 1.0f);
    part(primBox(0.17f, 0.15f, 0.07f), 0, 0.62f, 0.40f, GOLD, 1.0f);
    for (const int sd : { -1, 1 }) {
        part(applyPre(primCylinder(0.085f, 0.105f, 0.44f, 9), rotZm(sd * 0.62f)),
                sd * 0.31f, 0.82f, 0.07f, COAT, 1.0f);
        part(primSphere(0.10f, 9, 7), sd * 0.50f, 0.63f, 0.13f, SKIN, 1.0f);
    }
    part(primSphere(0.36f, 14, 10), 0, 1.42f, 0, SKIN, 1.0f);
    for (const int sd : { -1, 1 }) {
        part(primSphere(0.046f, 8, 6), sd * 0.135f, 1.505f, 0.305f, INK, 1.0f);
        part(primIcoDetail(0.078f, 1), sd * 0.225f, 1.40f, 0.255f, ROSY, 1.0f);
        part(primIcoDetail(0.10f, 1), sd * 0.125f, 1.305f, 0.305f, HAIR, 1.0f);
    }
    part(primIcoDetail(0.115f, 1), 0, 1.40f, 0.335f, NOSE, 1.0f);
    {
        Prim b1 = primIcoDetail(0.335f, 1);
        for (auto& v : b1.v) { v.y *= 1.15f; v.z *= 0.62f; }
        part(b1, 0, 1.14f, 0.18f, HAIR, 1.0f);
        Prim b2 = primIcoDetail(0.245f, 1);
        for (auto& v : b2.v) { v.y *= 1.20f; v.z *= 0.60f; }
        part(b2, 0, 0.88f, 0.215f, HAIR, 0.97f);
        part(primIcoDetail(0.15f, 1), 0, 0.70f, 0.235f, HAIR, 0.94f);
    }

    if (variant == 1) {
        // v1 "detailed" — the same gnome, finished: a brimmed hat that sits on
        // the head rather than balancing on it.
        part(primCylinder(0.50f, 0.545f, 0.09f, 16), 0, 1.66f, 0, HAT, 1.0f);
        part(applyPre(primCone(0.44f, 1.20f, 14), rotXm(-0.14f)), 0, 2.28f, -0.02f, HAT, 1.0f);
        part(primSphere(0.085f, 8, 6), 0, 2.874f, -0.104f, HAT, 0.95f);
        return;
    }

    // v2 "storybook" — v1 plus the two things that turn an ornament into a
    // character: a tall FLOPPY hat with a bend in it, and something in his hand.
    part(primCylinder(0.48f, 0.545f, 0.09f, 16), 0, 1.66f, 0, HAT, 1.0f);
    part(applyPre(primCylinder(0.30f, 0.46f, 0.78f, 14), rotXm(-0.10f)), 0, 2.09f, -0.02f, HAT, 1.0f);
    part(applyPre(primCone(0.31f, 0.95f, 12), rotXm(-0.62f)), 0, 2.62f, -0.30f, HAT, 0.97f);
    part(primSphere(0.095f, 8, 6), 0, 2.90f, -0.79f, HAIR, 1.0f);
    // The lantern, hung off the right hand on a wire hoop.
    part(applyPre(primTorusArc(0.10f, 0.018f, 6, 14, (float) M_PI), rotZm((float) M_PI / 2)),
            0.50f, 0.50f, 0.13f, INK, 1.0f);
    part(primBox(0.20f, 0.24f, 0.20f), 0.50f, 0.30f, 0.13f, GOLD, 1.0f);
    part(primBox(0.24f, 0.05f, 0.24f), 0.50f, 0.43f, 0.13f, INK, 1.0f);
    part(primBox(0.24f, 0.05f, 0.24f), 0.50f, 0.17f, 0.13f, INK, 1.0f);
    // A toadstool at his other foot — the thing every garden gnome is sold with.
    part(primCylinder(0.075f, 0.095f, 0.26f, 10), -0.62f, 0.13f, 0.32f, HAIR, 1.0f);
    part(applyPre(primSphere(0.21f, 12, 8), mat4f::scaling(float3{ 1.0f, 0.62f, 1.0f })),
            -0.62f, 0.27f, 0.32f, HAT, 1.0f);
    for (int i = 0; i < 4; i++) {
        const float a = (float) i * (float) M_PI / 2 + 0.4f;
        part(primSphere(0.035f, 6, 5), -0.62f + std::cos(a) * 0.11f, 0.375f,
                0.32f + std::sin(a) * 0.11f, HAIR, 1.0f);
    }
}

// ---- wind-up train --------------------------------------------------------
// Origin on the ground at the loco's centre, facing +z (the direction of
// travel). The winding key is a second mesh and gets its own builder.
void buildTrainModel(const PartFn& part, int variant) {
    constexpr uint32_t BODY = 0x3b6fb0, TRIM = 0xd8463f, GOLD = 0xf2c14e,
                       IRON = 0x2f2b38, GLASS = 0x2a3550, STEEL = 0x4a4653;
    const float PI2 = (float) M_PI / 2;
    if (variant <= 0) {
        // v0 — what shipped: seven boxes and a cylinder.
        part(primBox(1.0f, 0.36f, 2.4f), 0, 0.52f, 0, BODY, 1.0f);
        part(applyPre(primCylinder(0.44f, 0.44f, 1.45f, 12), rotXm(PI2)), 0, 1.02f, 0.45f, TRIM, 1.0f);
        part(primBox(1.05f, 0.95f, 0.85f), 0, 1.15f, -0.85f, BODY, 1.0f);
        part(primBox(1.15f, 0.16f, 1.0f), 0, 1.72f, -0.85f, TRIM, 1.0f);
        part(primCylinder(0.14f, 0.2f, 0.5f, 10), 0, 1.62f, 0.95f, GOLD, 1.0f);
        part(primSphere(0.18f, 10, 7), 0, 1.5f, 0.25f, GOLD, 1.0f);
        for (const int sd : { -1, 1 }) for (const float wz : { 0.65f, -0.65f }) {
            part(applyPre(primCylinder(0.3f, 0.3f, 0.14f, 12), rotZm(PI2)),
                    sd * 0.56f, 0.3f, wz, IRON, 1.0f);
        }
        return;
    }

    if (variant == 1) {
        // v1 "classic" — the same loco with the parts a loco actually has: a
        // smokebox and its door, boiler bands, a flared funnel, a lamp, glazed
        // cab windows, buffers, a cowcatcher and wheels with hubs and a rod.
        part(primBox(1.06f, 0.24f, 2.50f), 0, 0.40f, 0, IRON, 1.0f);
        part(primBox(1.22f, 0.09f, 2.42f), 0, 0.545f, 0, BODY, 1.0f);
        part(applyPre(primCylinder(0.44f, 0.46f, 1.52f, 18), rotXm(PI2)), 0, 1.02f, 0.40f, TRIM, 1.0f);
        for (const float bz : { 0.02f, 0.80f }) {
            part(applyPre(primCylinder(0.475f, 0.475f, 0.085f, 18), rotXm(PI2)),
                    0, 1.02f, bz, GOLD, 1.0f);
        }
        part(applyPre(primCylinder(0.455f, 0.455f, 0.24f, 18), rotXm(PI2)), 0, 1.02f, 1.24f, IRON, 1.0f);
        part(applyPre(primCylinder(0.325f, 0.325f, 0.07f, 16), rotXm(PI2)), 0, 1.02f, 1.375f, STEEL, 1.0f);
        part(primBox(0.075f, 0.56f, 0.04f), 0, 1.02f, 1.405f, GOLD, 1.0f);
        part(primBox(0.56f, 0.075f, 0.04f), 0, 1.02f, 1.405f, GOLD, 1.0f);
        part(primCylinder(0.155f, 0.135f, 0.46f, 14), 0, 1.55f, 0.92f, IRON, 1.0f);
        part(primCylinder(0.235f, 0.165f, 0.16f, 14), 0, 1.82f, 0.92f, IRON, 1.0f);
        part(primSphere(0.20f, 12, 9), 0, 1.44f, 0.26f, GOLD, 1.0f);
        part(primCylinder(0.05f, 0.05f, 0.16f, 8), 0, 1.60f, 0.26f, GOLD, 1.0f);
        part(primCylinder(0.045f, 0.045f, 0.22f, 8), 0.20f, 1.54f, -0.10f, GOLD, 1.0f);
        part(primBox(1.04f, 0.96f, 0.86f), 0, 1.16f, -0.86f, BODY, 1.0f);
        for (const int sd : { -1, 1 }) {
            part(primBox(0.045f, 0.44f, 0.46f), sd * 0.53f, 1.32f, -0.86f, GLASS, 1.0f);
        }
        part(primBox(0.42f, 0.38f, 0.05f), 0, 1.34f, -0.44f, GLASS, 1.0f);
        part(primBox(1.26f, 0.06f, 1.10f), 0, 1.655f, -0.86f, GOLD, 1.0f);
        part(primBox(1.20f, 0.11f, 1.04f), 0, 1.735f, -0.86f, TRIM, 1.0f);
        part(applyPre(primCylinder(0.13f, 0.13f, 0.17f, 12), rotXm(PI2)), 0, 1.44f, 1.44f, GOLD, 1.0f);
        part(applyPre(primCylinder(0.095f, 0.095f, 0.05f, 12), rotXm(PI2)), 0, 1.44f, 1.53f, 0xfff3e0, 1.0f);
        for (const int sd : { -1, 1 }) {
            part(applyPre(primCylinder(0.075f, 0.075f, 0.18f, 8), rotXm(PI2)),
                    sd * 0.38f, 0.50f, 1.47f, IRON, 1.0f);
        }
        // Cowcatcher: a raked plate each side of the centreline.
        for (const int sd : { -1, 1 }) {
            part(applyPre(primPlate({ { 0.30f, 0.0f }, { -0.24f, 0.0f },
                                      { -0.24f, 0.46f }, { 0.16f, 0.30f } }, 0.07f),
                        rotYm(sd * 0.42f)), sd * 0.20f, 0.36f, 1.32f, IRON, 1.0f);
        }
        for (const int sd : { -1, 1 }) {
            for (const float wz : { 0.62f, -0.62f }) {
                part(applyPre(primCylinder(0.34f, 0.34f, 0.13f, 16), rotZm(PI2)),
                        sd * 0.58f, 0.34f, wz, IRON, 1.0f);
                part(applyPre(primCylinder(0.20f, 0.20f, 0.15f, 12), rotZm(PI2)),
                        sd * 0.60f, 0.34f, wz, TRIM, 1.0f);
                part(applyPre(primCylinder(0.065f, 0.065f, 0.17f, 8), rotZm(PI2)),
                        sd * 0.62f, 0.34f, wz, GOLD, 1.0f);
            }
            part(applyPre(primCylinder(0.20f, 0.20f, 0.11f, 14), rotZm(PI2)),
                    sd * 0.56f, 0.22f, 1.16f, IRON, 1.0f);
            part(primBox(0.055f, 0.10f, 1.30f), sd * 0.68f, 0.50f, 0, STEEL, 1.0f);
        }
        return;
    }

    // v2 "chunky" — a different toy rather than a busier one: shorter, taller
    // and rounder, the way a wooden pull-along reads, with spoked wheels and a
    // funnel you can see from the far side of the track.
    part(primBox(1.16f, 0.28f, 2.10f), 0, 0.44f, 0, IRON, 1.0f);
    part(applyPre(primCylinder(0.56f, 0.58f, 1.30f, 20), rotXm(PI2)), 0, 1.10f, 0.30f, TRIM, 1.0f);
    part(applyPre(primCylinder(0.60f, 0.60f, 0.13f, 20), rotXm(PI2)), 0, 1.10f, 0.92f, GOLD, 1.0f);
    part(applyPre(primSphere(0.575f, 18, 12), mat4f::scaling(float3{ 1, 1, 0.55f })),
            0, 1.10f, 1.00f, TRIM, 1.0f);
    part(applyPre(primCylinder(0.30f, 0.30f, 0.08f, 16), rotXm(PI2)), 0, 1.10f, 1.30f, GOLD, 1.0f);
    part(primCylinder(0.20f, 0.17f, 0.52f, 16), 0, 1.72f, 0.72f, IRON, 1.0f);
    part(primCylinder(0.34f, 0.21f, 0.22f, 16), 0, 2.06f, 0.72f, IRON, 1.0f);
    part(primSphere(0.26f, 14, 10), 0, 1.62f, 0.10f, GOLD, 1.0f);
    part(applyPre(primSphere(0.62f, 18, 12), mat4f::scaling(float3{ 1, 1, 0.86f })),
            0, 1.26f, -0.76f, BODY, 1.0f);
    part(primBox(1.24f, 1.02f, 0.92f), 0, 1.16f, -0.76f, BODY, 1.0f);
    for (const int sd : { -1, 1 }) {
        part(primBox(0.05f, 0.46f, 0.50f), sd * 0.62f, 1.34f, -0.76f, GLASS, 1.0f);
    }
    part(primBox(1.36f, 0.13f, 1.06f), 0, 1.79f, -0.76f, GOLD, 1.0f);
    part(primSphere(0.13f, 10, 8), 0, 1.90f, -0.76f, TRIM, 1.0f);
    // The bell, on a yoke over the boiler.
    part(primCylinder(0.055f, 0.13f, 0.17f, 10), 0, 1.62f, 0.46f, GOLD, 1.0f);
    // Chunky spoked wheels: a tyre, a hub and six spokes turned about the axle.
    for (const int sd : { -1, 1 }) {
        for (const float wz : { 0.58f, -0.58f }) {
            part(applyPre(primCylinder(0.42f, 0.42f, 0.16f, 18), rotZm(PI2)),
                    sd * 0.62f, 0.42f, wz, IRON, 1.0f);
            part(applyPre(primCylinder(0.35f, 0.35f, 0.17f, 18), rotZm(PI2)),
                    sd * 0.635f, 0.42f, wz, GOLD, 1.0f);
            for (int k = 0; k < 6; k++) {
                part(applyPre(primBox(0.19f, 0.62f, 0.10f),
                            rotXm((float) k * (float) M_PI / 6)),
                        sd * 0.645f, 0.42f, wz, TRIM, 1.0f);
            }
            part(applyPre(primCylinder(0.10f, 0.10f, 0.19f, 10), rotZm(PI2)),
                    sd * 0.65f, 0.42f, wz, IRON, 1.0f);
        }
    }
}

// The winding key. v0 is what shipped; the others give it a shaft collar and a
// proper bow, since on the bench it is the part nearest the viewer.
void buildTrainKeyModel(const PartFn& part, int variant) {
    constexpr uint32_t GOLD = 0xf2c14e, IRON = 0x2f2b38;
    if (variant <= 0) {
        part(applyPre(primCylinder(0.07f, 0.07f, 0.5f, 8),
                    mat4f::translation(float3{ 0, 0.25f, 0 })), 0, 0, 0, GOLD, 1.0f);
        for (const int sd : { -1, 1 })
            part(primBox(0.5f, 0.3f, 0.09f), sd * 0.28f, 0.62f, 0, GOLD, 0.95f);
        return;
    }
    part(applyPre(primCylinder(0.075f, 0.075f, 0.52f, 10),
                mat4f::translation(float3{ 0, 0.26f, 0 })), 0, 0, 0, GOLD, 1.0f);
    part(primCylinder(0.13f, 0.13f, 0.07f, 12), 0, 0.10f, 0, IRON, 1.0f);
    part(primCylinder(0.11f, 0.11f, 0.06f, 12), 0, 0.55f, 0, IRON, 1.0f);
    for (const int sd : { -1, 1 }) {
        part(applyPre(primTorusArc(0.20f, 0.055f, 8, 16, (float) M_PI),
                    rotZm(sd > 0 ? 0.0f : (float) M_PI) * rotXm((float) M_PI / 2)),
                sd * 0.20f, 0.70f, 0, GOLD, 1.0f);
        part(primBox(0.34f, 0.10f, 0.075f), sd * 0.17f, 0.70f, 0, GOLD, 0.95f);
    }
}
} // namespace

// Near-field ground clutter — the flower patches, on their own rand2 stream
// (seed 5381-FNV) exactly like buildScenery's clutter pass. Only the 'flower'
// kind is ported; palettes with other kinds send no clutter config at all.
void TtpRenderer::buildClutter(const TrackBin& tb) {
    if (tb.clKinds.empty() || tb.clDensity <= 0) return;
    uint32_t seed = tb.scSeed2;
    const auto rnd = [&]() {
        seed = seed * 1664525u + 1013904223u;
        return (double) seed / 4294967296.0;
    };
    const float gy = tb.groundY;
    const float CL_MARGIN = 0.7f;
    const auto isClearC = [&](float x, float z) {
        for (const auto& s : tb.samples) {
            const float h = s.pos.y - gy;
            const float half = s.width / 2 + CL_MARGIN + (h > 0.5f ? 0.6f + 0.8f * h : 0.0f);
            const float dx = x - s.pos.x, dz = z - s.pos.z;
            if (dx * dx + dz * dz < half * half) return false;
        }
        return true;
    };
    int geoms = 0;
    const auto put = [&](Prim p, const mat4f& m, uint32_t hex, float shade) {
        const uint32_t c = packLinear(srgbToLinear(hex), shade);
        const uint32_t base = (uint32_t) mClutter.verts.size();
        for (const float3& v : p.v) {
            const float3 w = (m * float4{ v, 1 }).xyz;
            mClutter.verts.push_back({ w.x, w.y, w.z, c });
        }
        for (const uint32_t i : p.i) mClutter.idx.push_back(base + i);
        geoms++;
    };
    const auto T = [](float x, float y, float z) { return mat4f::translation(float3{ x, y, z }); };
    const auto SC = [](float x, float y, float z) { return mat4f::scaling(float3{ x, y, z }); };
    const auto RY = [](float a) { return mat4f::rotation(a, float3{ 0, 1, 0 }); };
    const auto RZ = [](float a) { return mat4f::rotation(a, float3{ 0, 0, 1 }); };

    for (float d = 0; d < tb.length && geoms < 700; d += 5) {
        const TrackBin::Sample f = tb.frameAt(d);
        const float half = f.width / 2;
        for (const int side : { -1, 1 }) {
            if (rnd() > tb.clDensity) continue;
            const float lat = side * (half + 1.3f + (float) rnd() * 3.4f);
            const float x = f.pos.x + f.lat.x * lat + ((float) rnd() - 0.5f) * 1.6f;
            const float z = f.pos.z + f.lat.z * lat + ((float) rnd() - 0.5f) * 1.6f;
            if (!isClearC(x, z)) continue;
            const double r = rnd(); // weighted kind pick (one draw)
            double acc = 0;
            const TrackBin::ClutterKind* entry = &tb.clKinds.back();
            for (const auto& e : tb.clKinds) { acc += e.w; if (r < acc) { entry = &e; break; } }
            const auto pick = [&](const TrackBin::ClutterKind* e) {
                return e->tints.empty() ? 0xffffffu
                        : e->tints[(size_t) std::floor(rnd() * e->tints.size())];
            };
            if (entry->kind != 0) {
                // ---- the small kinds (CLUTTER_BUILDERS, verbatim draws) ----
                switch (entry->kind) {
                    case 1: { // shell — a squashed half-dome, tipped a touch
                        const float rr = 0.24f + (float) rnd() * 0.1f;
                        const float rz = 0.12f + (float) rnd() * 0.1f;
                        const float ry = (float) rnd() * 2.0f * (float) M_PI;
                        put(primSphereBand(rr, 8, 4, 0, (float) M_PI / 2),
                                T(x, gy + 0.03f, z) * RY(ry) * RZ(rz) * SC(1, 0.55f, 1.2f),
                                pick(entry), 0.96f + (float) rnd() * 0.1f);
                        break;
                    }
                    case 2: { // starfish — five flattened arms off a small hub
                        const uint32_t hex = pick(entry);
                        const float a0 = (float) rnd() * 2.0f * (float) M_PI;
                        const float sc = 0.8f + (float) rnd() * 0.5f;
                        put(primCylinder(0.11f * sc, 0.13f * sc, 0.09f * sc, 5),
                                T(x, gy + 0.045f * sc, z), hex, 1.0f);
                        for (int k = 0; k < 5; k++) {
                            put(applyPre(primCone(0.1f * sc, 0.44f * sc, 5),
                                        mat4f::rotation((float) M_PI / 2, float3{ 1, 0, 0 })),
                                    T(x, gy, z) * RY(a0 + ((float) k / 5) * 2.0f * (float) M_PI)
                                            * T(0, 0.045f * sc, 0.28f * sc) * SC(1, 0.45f, 1),
                                    hex, 0.94f + (k % 2) * 0.08f);
                        }
                        break;
                    }
                    case 3: { // driftwood — two thin rods, kinked where they meet
                        const uint32_t hex = pick(entry);
                        const float a = (float) rnd() * 2.0f * (float) M_PI;
                        put(applyPre(primCylinder(0.07f, 0.09f, 1.5f, 6),
                                    mat4f::rotation((float) M_PI / 2, float3{ 0, 0, 1 })),
                                T(x, gy + 0.08f, z) * RY(a), hex, 1.0f);
                        put(applyPre(primCylinder(0.05f, 0.06f, 0.9f, 6),
                                    mat4f::rotation((float) M_PI / 2, float3{ 0, 0, 1 })),
                                T(x + std::cos(a) * 0.55f, gy + 0.06f, z - std::sin(a) * 0.55f)
                                        * RY(a + 0.6f), hex, 0.92f);
                        break;
                    }
                    case 4: { // drift — a wind-blown snow heap
                        const float sx = 0.9f + (float) rnd() * 0.9f;
                        const float sy = 0.28f + (float) rnd() * 0.12f;
                        const float sz = 0.55f + (float) rnd() * 0.5f;
                        const float ry = (float) rnd() * 2.0f * (float) M_PI;
                        put(primIcoDetail(1.0f, 1), T(x, gy + 0.07f, z) * RY(ry) * SC(sx, sy, sz),
                                pick(entry), 0.97f + (float) rnd() * 0.06f);
                        break;
                    }
                    case 5: { // scrub — a dry sage tuft, sometimes two clumped
                        const int n2 = 1 + (rnd() < 0.4 ? 1 : 0);
                        for (int i = 0; i < n2; i++) {
                            const float rr = 0.3f + (float) rnd() * 0.18f;
                            const float sy = 0.55f + (float) rnd() * 0.2f;
                            const float ry = (float) rnd() * 2.0f * (float) M_PI;
                            put(primIco(rr), T(x + i * 0.5f, gy + 0.12f, z + i * 0.3f)
                                            * RY(ry) * SC(1, sy, 1),
                                    pick(entry), 0.9f + (float) rnd() * 0.2f);
                        }
                        break;
                    }
                    case 6: { // pebbles — a little cluster of rust stones
                        const int n2 = 3 + (int) std::floor(rnd() * 2);
                        for (int i = 0; i < n2; i++) {
                            const float rr = 0.09f + (float) rnd() * 0.09f;
                            const float ox = ((float) rnd() - 0.5f) * 0.7f;
                            const float oz = ((float) rnd() - 0.5f) * 0.7f;
                            put(primIco(rr), T(x + ox, gy + rr * 0.5f, z + oz),
                                    pick(entry), 0.9f + (float) rnd() * 0.2f);
                        }
                        break;
                    }
                    case 7: { // brick — a studded toy brick
                        const uint32_t hex = pick(entry);
                        const float a = (float) rnd() * 2.0f * (float) M_PI;
                        put(primBox(0.62f, 0.3f, 0.34f), T(x, gy + 0.15f, z) * RY(a), hex, 1.0f);
                        for (const int sd : { -1, 1 }) {
                            put(primCylinder(0.09f, 0.09f, 0.1f, 8),
                                    T(x, gy, z) * RY(a) * T(sd * 0.15f, 0.34f, 0), hex, 1.06f);
                        }
                        break;
                    }
                    case 8: { // marble — a lost glass bead
                        put(primSphere(0.19f, 10, 7), T(x, gy + 0.19f, z), pick(entry), 1.05f);
                        break;
                    }
                    case 9: { // domino — white tile, dark midline, 3+5 pips
                        const float a = (float) rnd() * 2.0f * (float) M_PI;
                        const mat4f frame = T(x, gy, z) * RY(a);
                        put(primBox(0.56f, 0.12f, 1.06f), frame * T(0, 0.06f, 0), pick(entry), 1.0f);
                        put(primBox(0.58f, 0.025f, 0.06f), frame * T(0, 0.12f, 0), 0x3a3442, 1.0f);
                        static const float PIPS[8][2] = {
                            { 0, -0.28f }, { -0.14f, -0.15f }, { 0.14f, -0.41f },
                            { -0.14f, 0.15f }, { 0.14f, 0.15f }, { 0, 0.28f },
                            { -0.14f, 0.41f }, { 0.14f, 0.41f },
                        };
                        for (const auto& pip : PIPS) {
                            put(primCylinder(0.045f, 0.045f, 0.035f, 6),
                                    frame * T(pip[0], 0.128f, pip[1]), 0x3a3442, 1.0f);
                        }
                        break;
                    }
                    default: break;
                }
                continue;
            }
            // ---- flower patch (CLUTTER_BUILDERS.flower, verbatim draws) ----
            const int n = 3 + (int) std::floor(rnd() * 3);
            struct Bloom { float x, z, r; };
            std::vector<Bloom> spots;
            for (int i = 0; i < n; i++) {
                const float s = 0.85f + (float) rnd() * 0.45f;
                const float headR = 0.28f * s;
                float fx = 0, fz = 0;
                bool found = false;
                for (int t = 0; t < 6 && !found; t++) {
                    const float a = (float) rnd() * 2.0f * (float) M_PI;
                    const float rr = (float) rnd() * 0.9f;
                    const float px = x + std::cos(a) * rr, pz = z + std::sin(a) * rr;
                    bool ok = true;
                    for (const Bloom& sp : spots) {
                        if (std::hypot(px - sp.x, pz - sp.z) < headR + sp.r + 0.05f) { ok = false; break; }
                    }
                    if (ok) { fx = px; fz = pz; found = true; }
                }
                if (!found) continue;
                spots.push_back({ fx, fz, headR });
                const float h = (0.26f + (float) rnd() * 0.12f) * s;
                const uint32_t hex = entry->tints.empty() ? 0xffffffu
                        : entry->tints[(size_t) std::floor(rnd() * entry->tints.size())];
                const float ph = (float) rnd() * 2.0f * (float) M_PI;
                put(primCylinder(0.038f * s, 0.05f * s, h, 5), T(fx, gy + h / 2, fz),
                        0x4e8a44, 0.92f + (float) rnd() * 0.14f);
                for (int k = 0; k < 2; k++) {
                    const float la = ph + k * 2.4f + 0.7f;
                    put(primSphere(0.1f * s, 6, 4),
                            T(fx + std::cos(la) * 0.16f * s, gy + 0.03f, fz + std::sin(la) * 0.16f * s)
                                    * RY(-la) * SC(1.7f, 0.3f, 0.7f),
                            0x5a9a50, 0.9f + (float) rnd() * 0.12f);
                }
                for (int k = 0; k < 5; k++) {
                    const float pa = ph + ((float) k / 5) * 2.0f * (float) M_PI;
                    put(primSphere(0.09f * s, 6, 4),
                            T(fx + std::cos(pa) * 0.13f * s, gy + h + 0.02f * s, fz + std::sin(pa) * 0.13f * s)
                                    * RY(-pa) * RZ(0.4f) * SC(1.5f, 0.4f, 0.85f),
                            hex, 0.95f + (float) rnd() * 0.1f);
                }
                put(primSphere(0.08f * s, 6, 5), T(fx, gy + h + 0.03f * s, fz) * SC(1, 0.7f, 1),
                        0xf2c14e, 1.05f);
            }
        }
    }
    if (!mClutter.verts.empty()) {
        accumulateNormals(mClutter);
        buildMesh(mClutter, true, nullptr, 4, 2000);
    }
}

// Grass-biome landmarks — verbatim placement streams (seed 51966-FNV) and the
// track.js builders' numbers: the gnome, the doghouse, the picnic spread.
static_assert(MODEL_COUNT == 3, "TtpRenderer::mModelVariant is sized to ModelId");

void TtpRenderer::setModelVariant(const char* model, int variant) {
    const int id = modelIdByName(model);
    if (id < 0) return;
    const int n = modelVariantCount(id);
    mModelVariant[id] = variant < 0 ? 0 : (variant >= n ? n - 1 : variant);
}

void TtpRenderer::setModelBench(const char* model) { mBenchModel = modelIdByName(model); }

void TtpRenderer::buildLandmarks(const TrackBin& tb) {
    // The BENCH has no landmark set behind it — it replaces one — so it must
    // not be gated on the theme listing kinds the way everything below is.
    if (tb.lmKinds.empty() && mBenchModel < 0) return;
    uint32_t seed = tb.lmSeed;
    const auto rnd = [&]() {
        seed = seed * 1664525u + 1013904223u;
        return (double) seed / 4294967296.0;
    };
    const float gy = tb.groundY;
    const auto isClear = [&](float x, float z, float m) {
        for (const auto& s : tb.samples) {
            const float h = s.pos.y - gy;
            const float lim = s.width / 2 + m + (h > 0.5f ? 0.6f + 0.8f * h : 0.0f);
            const float dx = x - s.pos.x, dz = z - s.pos.z;
            if (dx * dx + dz * dz < lim * lim) return false;
        }
        return true;
    };
    struct Foot { float x, z, r; };
    std::vector<Foot> placed;
    // Pieces painted PER FACE (the ball's panels, the umbrella's gores) have to
    // be vertex soup, so accumulateNormals would flat-shade them — where the JS
    // keeps the sphere's own smooth normals through paintFaces/toNonIndexed.
    // Their analytic normals are recorded here and written back afterwards.
    std::vector<std::pair<uint32_t, float3>> smoothNormals;
    const auto smooth = [&](uint32_t idx, const mat4f& m, const float3& localDir) {
        const mat3f nm = transpose(inverse(m.upperLeft()));
        smoothNormals.emplace_back(idx, normalize(nm * normalize(localDir)));
    };
    const auto clearSpot = [&](float x, float z, float m) {
        if (!isClear(x, z, m)) return false;
        for (const auto& p : placed) {
            const float dx = x - p.x, dz = z - p.z, lim = m + p.r;
            if (dx * dx + dz * dz < lim * lim) return false;
        }
        return true;
    };
    struct Spot { float x, z, yaw; bool ok; };
    const auto findSpot = [&](float s0, float off, float m) -> Spot {
        for (float s = s0; s < tb.length - 10; s += 3) {
            const TrackBin::Sample f = tb.frameAt(s);
            if (f.pos.y - gy > 0.8f) continue;
            const int side = rnd() < 0.5 ? -1 : 1;
            const float lat = side * (f.width / 2 + off);
            const float x = f.pos.x + f.lat.x * lat, z = f.pos.z + f.lat.z * lat;
            if (!clearSpot(x, z, m)) continue;
            placed.push_back({ x, z, m });
            const float fx = -f.lat.x * side, fz = -f.lat.z * side;
            return { x, z, std::atan2(fx, fz), true };
        }
        return { 0, 0, 0, false };
    };
    const auto findSpotMid = [&](float m) -> Spot {
        float mx = 0, mz = 0;
        for (const auto& s : tb.samples) { mx += s.pos.x; mz += s.pos.z; }
        mx /= tb.samples.size(); mz /= tb.samples.size();
        for (int ring = 0; ring < 9; ring++) {
            const float rr = ring * 3.5f;
            const int n = ring == 0 ? 1 : 8;
            const float a0 = (float) rnd() * 2.0f * (float) M_PI;
            for (int k = 0; k < n; k++) {
                const float a = a0 + ((float) k / n) * 2.0f * (float) M_PI;
                const float px = mx + std::cos(a) * rr, pz = mz + std::sin(a) * rr;
                if (!clearSpot(px, pz, m)) continue;
                placed.push_back({ px, pz, m });
                return { px, pz, (float) rnd() * 2.0f * (float) M_PI, true };
            }
        }
        return { 0, 0, 0, false };
    };
    const auto has = [&](uint32_t k) {
        return std::find(tb.lmKinds.begin(), tb.lmKinds.end(), k) != tb.lmKinds.end();
    };
    // part(): pre-transformed prim → local offset → yaw → world, flat colour.
    const auto part = [&](const Prim& prim, float lx, float ly, float lz,
            const Spot& sp, uint32_t hex, float shade = 1.0f) {
        const mat4f m = mat4f::translation(float3{ sp.x, gy, sp.z })
                * mat4f::rotation(sp.yaw, float3{ 0, 1, 0 })
                * mat4f::translation(float3{ lx, ly, lz });
        const uint32_t c = packLinear(srgbToLinear(hex), shade);
        const uint32_t base = (uint32_t) mLandmarks.verts.size();
        for (const float3& v : prim.v) {
            const float3 w = (m * float4{ v, 1 }).xyz;
            mLandmarks.verts.push_back({ w.x, w.y, w.z, c });
        }
        for (const uint32_t i : prim.i) mLandmarks.idx.push_back(base + i);
    };
    const auto rotX = [](float a) { return mat4f::rotation(a, float3{ 1, 0, 0 }); };
    const auto rotY = [](float a) { return mat4f::rotation(a, float3{ 0, 1, 0 }); };
    const auto rotZ = [](float a) { return mat4f::rotation(a, float3{ 0, 0, 1 }); };

    // A model builder emits in its OWN local frame; this binds one to a placed
    // spot so the builder never learns where it stands (see buildRocketModel).
    const auto at = [&](const Spot& sp) {
        return [&, sp](const Prim& prim, float lx, float ly, float lz,
                uint32_t hex, float shade) { part(prim, lx, ly, lz, sp, hex, shade); };
    };

    // ---- the MODEL BENCH ---------------------------------------------------
    // Every variant of one model, in a row on the verge, all facing the road.
    // The row replaces the landmark set entirely: this is a scene for judging
    // one thing, and a doghouse behind the middle gnome is a thumb on the
    // scale. Stand on the road opposite the middle entry and the three are
    // side by side at near-equal distance, which is the only way a shape
    // argument gets settled.
    if (mBenchModel >= 0 && mBenchModel < MODEL_COUNT) {
        constexpr float BENCH_S0 = 26, BENCH_OFF = 4.2f;
        // Spacing is per model for the same reason the COUNT is: the rocket row
        // is five entries of a narrow object, and at the gnome's spacing it
        // would run 28 units up the straight and have to be viewed from so far
        // back that the shapes stop resolving — which is the one thing a bench
        // may not do.
        const float BENCH_STEP = mBenchModel == MODEL_ROCKET ? 5.6f : 7.0f;
        // The ROCKET ships at 0.2 world units — a fist. Judged at that size a
        // bench tells you nothing but which one is a dot, so its row is blown
        // up and the legend says by how much. Nothing else is rescaled.
        const float scale = mBenchModel == MODEL_ROCKET ? 9.0f : 1.0f;
        const float lift = mBenchModel == MODEL_ROCKET ? 3.1f : 0.0f;
        // A PRESENTATION YAW off square, per model, because "facing the road"
        // is not the same as "the angle this shape reads at". A gnome is a
        // front elevation and wants none; a locomotive seen nose-on is a dark
        // rectangle with a lamp on it, and everything the detail went into —
        // the boiler bands, the rods, the wheels, the cab — is edge-on to the
        // viewer. Three quarters is the angle a toy train is photographed at.
        const float present = mBenchModel == MODEL_TRAIN ? 0.85f : 0.0f;
        const int nv = modelVariantCount(mBenchModel);
        for (int v = 0; v < nv; v++) {
            // LAID OUT BACKWARDS ALONG THE TRACK, on purpose. The row faces the
            // road, so the only place it can be read from is the far verge —
            // and from there the track runs right to left. Placing v0 at the
            // FAR end puts it on the left of the one shot this whole mode
            // exists to produce, which is the order the legend lists them in.
            const float s = BENCH_S0 + (float) (nv - 1 - v) * BENCH_STEP;
            if (s > tb.length - 10) break;
            const TrackBin::Sample f = tb.frameAt(s);
            const float lat = f.width / 2 + BENCH_OFF;
            const Spot sp{ f.pos.x + f.lat.x * lat, f.pos.z + f.lat.z * lat,
                           std::atan2(-f.lat.x, -f.lat.z) + present, true };
            mShadowSpots.push_back({ sp.x, sp.z, 1.6f, 1.6f });
            const PartFn emit = [&, sp, scale, lift](const Prim& prim, float lx,
                    float ly, float lz, uint32_t hex, float shade) {
                Prim s2 = prim;
                if (scale != 1.0f) for (auto& q : s2.v) q *= scale;
                part(s2, lx * scale, ly * scale + lift, lz * scale, sp, hex, shade);
            };
            if (mBenchModel == MODEL_ROCKET) buildRocketModel(emit, v);
            else if (mBenchModel == MODEL_GNOME) buildGnomeModel(emit, v);
            else {
                buildTrainModel(emit, v);
                // The key rides behind the loco rather than on it, which is
                // where the render loop puts it in play.
                const PartFn keyEmit = [&, sp](const Prim& prim, float lx, float ly,
                        float lz, uint32_t hex, float shade) {
                    part(prim, lx, ly + 0.9f, lz - 1.9f, sp, hex, shade);
                };
                buildTrainKeyModel(keyEmit, v);
            }
        }
        if (!mLandmarks.verts.empty()) {
            accumulateNormals(mLandmarks);
            buildMesh(mLandmarks);
        }
        return;
    }

    // The kinds run in buildLandmarks' SOURCE order (not id order): several
    // share one rand stream, so the draw order is part of the contract.

    // Both offshore pieces take their bearing from the LOWEST island of the
    // horizon ring: the tower dominates a low silhouette instead of poking out
    // of a tall dune. Anchors are authored coords — the hills' push-out scales
    // them (mHillSf), exactly as setTrack has already scaled the ring.
    const float3* lowest = nullptr;
    for (const float3& a : mHillAnchors) {
        if (!lowest || a.z < lowest->z) lowest = &a; // .z carries `top`
    }
    if (has(7) && lowest) { // lighthouse — banded tower on its island
        constexpr float LH = 1.75f; // LH_SCALE (~16.5u tall)
        const Spot at{ lowest->x * mHillSf, lowest->y * mHillSf, 0, true };
        const float baseY = lowest->z - 0.8f; // sunk into the island crown
        const auto seg = [&](float r0, float r1, float h, float cy, uint32_t hex,
                int radial = 10) {
            part(primCylinder(r0 * LH, r1 * LH, h * LH, radial), 0, baseY + cy * LH, 0,
                    at, hex);
        };
        static const uint32_t BANDS[4] = { 0xf5efe2, 0xe4604a, 0xf5efe2, 0xe4604a };
        for (int i = 0; i < 4; i++) {
            const float h = 1.9f, r0 = 1.22f - (i + 1) * 0.09f, r1 = 1.22f - i * 0.09f;
            seg(r0, r1, h, i * h + h / 2, BANDS[i]);
        }
        seg(1.05f, 1.05f, 0.32f, 7.76f, 0x5c6470); // gallery deck
        seg(0.62f, 0.62f, 0.85f, 8.35f, 0xffd98a); // lamp room — warm, reads lit
        part(primCone(0.85f * LH, 0.9f * LH, 10), 0, baseY + 9.2f * LH, 0, at, 0xb2453a);
    }
    if (has(8) && mShoreFn) { // sailboat — anchored out in the shallows
        // A third of the way round from the lighthouse's island, so the two
        // never share a sight-line; radius = the shoreline ON THAT BEARING
        // plus an open-water margin.
        const float ba = (lowest ? std::atan2(lowest->y, lowest->x) : 0.0f) + 2.3f;
        const float br = mShoreFn(ba) + 22.0f;
        const float bx = std::cos(ba) * br, bz = std::sin(ba) * br;
        const float wy = gy + 0.12f; // rides ON the water sheet (WATER_LIFT)
        const float yaw = (float) rnd() * 2.0f * (float) M_PI;
        constexpr float HEEL = 0.09f; // a sailing boat leans
        const mat4f frame = mat4f::translation(float3{ bx, wy, bz })
                * rotY(yaw) * rotZ(HEEL);
        const auto bpart = [&](Prim prim, float lx, float ly, float lz, uint32_t hex) {
            const mat4f m = frame * mat4f::translation(float3{ lx, ly, lz });
            const uint32_t c = packLinear(srgbToLinear(hex), 1.0f);
            const uint32_t base = (uint32_t) mLandmarks.verts.size();
            for (const float3& v : prim.v) {
                const float3 w = (m * float4{ v, 1 }).xyz;
                mLandmarks.verts.push_back({ w.x, w.y, w.z, c });
            }
            for (const uint32_t i : prim.i) mLandmarks.idx.push_back(base + i);
        };
        // Right-triangle sail: a thin 3-prism, base dropped to y=0 and SHEARED
        // so the apex sits over the `lead` base corner — that edge becomes the
        // vertical luff, the way a sail actually hangs.
        const auto sail = [&](float sy, float sz, float lead) {
            // THREE's thetaStart π/2 lands the SAME three corners as ours (a
            // reordering, not a rotation), so only the rotateZ carries over.
            Prim g = applyPre(primCylinder(1, 1, 0.09f, 3), rotZ((float) M_PI / 2));
            const float k = (lead * 0.866f * sz) / (1.5f * sy);
            for (float3& v : g.v) {
                float3 p{ v.x, v.y * sy, v.z * sz };
                p.y += 0.5f * sy;
                p.z += k * p.y;
                v = p;
            }
            return g;
        };
        bpart(primBox(1.7f, 0.55f, 4.4f), 0, 0.2f, -0.6f, 0xd94f3d);   // hull
        bpart(applyPre(primBox(1.2f, 0.55f, 1.2f), rotY((float) M_PI / 4)),
                0, 0.2f, 1.6f, 0xd94f3d);                              // pointed stem
        bpart(primBox(1.9f, 0.34f, 4.6f), 0, 0.62f, -0.6f, 0xf7f5ee);  // gunwale band
        bpart(applyPre(primBox(1.34f, 0.34f, 1.34f), rotY((float) M_PI / 4)),
                0, 0.62f, 1.7f, 0xf7f5ee);
        bpart(primBox(1.05f, 0.5f, 1.5f), 0, 1.04f, -1.2f, 0xf3e9d8);  // cabin
        bpart(primBox(1.2f, 0.1f, 1.65f), 0, 1.33f, -1.2f, 0xd94f3d);  // cabin roof
        bpart(primCylinder(0.07f, 0.1f, 5.8f, 6), 0, 2.9f, 0.3f, 0x8a6f4d); // mast
        bpart(applyPre(primCylinder(0.06f, 0.06f, 2.5f, 6), rotX((float) M_PI / 2)),
                0, 1.55f, -0.85f, 0x8a6f4d);                           // boom
        bpart(sail(2.53f, 1.31f, 1), 0, 1.55f, -0.915f, 0xf7f5ee);     // main
        bpart(primBox(0.11f, 0.42f, 1.7f), 0, 2.3f, -0.69f, 0xd94f3d); // racing band
        bpart(sail(2.27f, 1.115f, -1), 0, 1.0f, 1.386f, 0xfdf8ec);     // jib
        bpart(applyPre(primCone(0.26f, 0.7f, 3), rotX(-(float) M_PI / 2)
                    * mat4f::scaling(float3{ 1, 1, 0.5f })),
                0, 5.85f, -0.1f, 0xd94f3d);                            // masthead pennant
    }

    if (has(3)) { // hoodoo — a balanced-rock family trackside (canyon)
        const uint32_t* rocks = tb.scRocks.data();
        const auto hoodoo = [&](float hx, float hz, float T) {
            const float radii[4] = { 0.20f * T, 0.15f * T, 0.115f * T, 0.095f * T };
            const float hts[3] = { 0.30f * T, 0.24f * T, 0.19f * T };
            float cy = 0;
            for (int li = 0; li < 3; li++) {
                const float ry = (float) rnd() * 2.0f * (float) M_PI;
                const Spot at{ hx, hz, 0, true };
                part(applyPre(primCylinder(radii[li + 1], radii[li], hts[li], 8), rotY(ry)),
                        0, cy + hts[li] / 2 - 0.15f, 0, at, rocks[li % 3],
                        0.9f + (float) rnd() * 0.18f);
                cy += hts[li];
            }
            const float ry = (float) rnd() * 2.0f * (float) M_PI;
            const Spot at{ hx, hz, 0, true };
            // Sequenced: C++ leaves argument evaluation order unspecified, and
            // these two draws must come off the stream in the JS's order.
            const uint32_t capCol = rocks[(size_t) std::floor(rnd() * 3)];
            const float capShade = 0.95f + (float) rnd() * 0.15f;
            part(applyPre(primIco(0.24f * T),
                        rotY(ry) * mat4f::scaling(float3{ 1, 0.62f, 0.88f })),
                    0, cy + 0.1f * T - 0.15f, 0, at, capCol, capShade);
        };
        for (float s = 35; s < tb.length - 10; s += 3) {
            const TrackBin::Sample f = tb.frameAt(s);
            if (f.pos.y - gy > 0.8f) continue;
            const int side = rnd() < 0.5 ? -1 : 1;
            const float lat = side * (f.width / 2 + 6.5f);
            const float x = f.pos.x + f.lat.x * lat, z = f.pos.z + f.lat.z * lat;
            if (!isClear(x, z, 5)) continue;
            const float3 tan = f.tangent();
            hoodoo(x, z, 8.6f); // the tall one
            hoodoo(x + tan.x * 3.8f + f.lat.x * side * 1.6f,
                   z + tan.z * 3.8f + f.lat.z * side * 1.6f, 5.4f);
            hoodoo(x - tan.x * 3.2f + f.lat.x * side * 2.2f,
                   z - tan.z * 3.2f + f.lat.z * side * 2.2f, 3.6f);
            placed.push_back({ x, z, 6 });
            mShadowSpots.push_back({ x, z, 2.4f, 6.0f });
            break; // one family is a landmark; a forest of them is scenery
        }
    }

    if (has(4)) { // snowman — the trackside greeter (snow)
        for (float s = 30; s < tb.length - 10; s += 3) {
            const TrackBin::Sample f = tb.frameAt(s);
            if (f.pos.y - gy > 0.8f) continue;
            const int side = rnd() < 0.5 ? -1 : 1;
            const float lat = side * (f.width / 2 + 3.6f);
            const float x = f.pos.x + f.lat.x * lat, z = f.pos.z + f.lat.z * lat;
            if (!isClear(x, z, 2.6f)) continue;
            const float fx = -f.lat.x * side, fz = -f.lat.z * side; // faces the road
            const Spot sp{ x, z, std::atan2(fx, fz), true };
            const auto ball = [&](float r, float cy, uint32_t hex) {
                part(primIcoDetail(r, 2), 0, cy, 0, sp, hex, 0.98f);
            };
            ball(1.05f, 0.72f, 0xf6f9fc); // base, sunk into the snow
            ball(0.78f, 2.02f, 0xfafcfe);
            ball(0.54f, 3.08f, 0xf6f9fc); // head
            // Carrot nose: a tapered cone with a rounded nub, drooped a touch.
            {
                constexpr float NOSE = 0.32f, TIP = 0.06f;
                const mat4f into = rotX((float) M_PI / 2 + 0.16f);
                part(applyPre(primCylinder(TIP, 0.19f, NOSE, 16), into),
                        0, 3.12f, 0.58f, sp, 0xe8833a);
                part(applyPre(applyPre(primSphere(TIP, 12, 8),
                            mat4f::translation(float3{ 0, NOSE / 2, 0 })), into),
                        0, 3.12f, 0.58f, sp, 0xe8833a);
            }
            // Coal: eyes + smile on the head, three buttons down the belly
            // (offsets in the facing frame — ox right, oz toward the road).
            const auto dot = [&](float ox, float oy, float oz, float r) {
                part(primIcoDetail(r, 1), ox, oy, oz, sp, 0x343a44);
            };
            dot(-0.2f, 3.32f, 0.44f, 0.08f); dot(0.2f, 3.32f, 0.44f, 0.08f);
            for (int i = -2; i <= 2; i++) dot(i * 0.12f, 2.82f + i * i * 0.03f, 0.46f, 0.05f);
            dot(0, 2.30f, 0.72f, 0.08f); dot(0, 2.00f, 0.76f, 0.08f); dot(0, 1.70f, 0.72f, 0.08f);
            // Soft knit beanie: rolled brim, stretched crown dome, pom-pom.
            constexpr uint32_t HAT = 0x3b6fb0;
            part(primTorusArc(0.42f, 0.15f, 12, 24, 2.0f * (float) M_PI), 0, 3.5f, 0, sp, HAT, 1.08f);
            part(applyPre(primSphereBand(0.42f, 20, 12, 0, (float) M_PI / 2),
                        mat4f::scaling(float3{ 1, 1.28f, 1 })), 0, 3.5f, 0, sp, HAT);
            part(primIcoDetail(0.17f, 2), 0, 4.12f, 0, sp, 0xf6f9fc);
            // Knit scarf: a ring at the neck with a tail draped down the belly.
            part(primTorusArc(0.47f, 0.14f, 12, 24, 2.0f * (float) M_PI), 0, 2.66f, 0, sp, 0xd8463f);
            part(applyPre(primBox(0.26f, 0.62f, 0.14f),
                        rotX(0.45f) * mat4f::translation(float3{ 0, -0.31f, 0 })),
                    0, 2.62f, 0.5f, sp, 0xd8463f, 1.04f);
            // Twig arms: chunky stubs swung out and tilted up, with a shoulder knob.
            for (const int sd : { 1, -1 }) {
                part(applyPre(primCylinder(0.06f, 0.09f, 0.95f, 8),
                            rotZ(-sd * ((float) M_PI / 2 - 0.5f))
                                    * mat4f::translation(float3{ 0, 0.47f, 0 })),
                        sd * 0.62f, 2.24f, 0, sp, 0x6b4a2f);
                part(primIcoDetail(0.09f, 1), sd * 0.62f, 2.24f, 0, sp, 0x6b4a2f);
            }
            placed.push_back({ x, z, 3 });
            mShadowSpots.push_back({ x, z, 1.1f, 3.5f });
            break;
        }
    }

    if (has(5)) { // blocks — giant alphabet blocks (playroom)
        static const uint32_t TONES[3] = { 0xe66a5a, 0x5a8fd8, 0xf2c14e };
        const auto block = [&](float bx, float bz, float size, float cy, float yaw,
                uint32_t hex) {
            const Spot at{ bx, bz, yaw, true };
            part(primBox(size, size, size), 0, cy + size / 2, 0, at, hex,
                    0.97f + (float) rnd() * 0.06f);
            // Face panels: lighter plates proud of the four sides + the top
            // (a plain cube reads as a shipping crate).
            const float pw = size * 0.72f, t = 0.05f, off = size / 2 + t / 2 - 0.01f;
            const float PL[5][6] = {
                { off, 0, 0, t, pw, pw }, { -off, 0, 0, t, pw, pw },
                { 0, 0, off, pw, pw, t }, { 0, 0, -off, pw, pw, t },
                { 0, off, 0, pw, t, pw },
            };
            for (const auto& p : PL) {
                part(applyPre(primBox(p[3], p[4], p[5]),
                            mat4f::translation(float3{ p[0], p[1], p[2] })),
                        0, cy + size / 2, 0, at, 0xf7ead2, 0.98f);
            }
        };
        for (float s = 55; s < tb.length - 10; s += 3) {
            const TrackBin::Sample f = tb.frameAt(s);
            if (f.pos.y - gy > 0.8f) continue;
            const int side = rnd() < 0.5 ? -1 : 1;
            const float lat = side * (f.width / 2 + 6.0f);
            const float x = f.pos.x + f.lat.x * lat, z = f.pos.z + f.lat.z * lat;
            if (!isClear(x, z, 5)) continue;
            const float3 tan = f.tangent();
            block(x, z, 3.2f, 0, (float) rnd() * 0.6f, TONES[0]);
            block(x + tan.x * 3.4f + f.lat.x * side * 1.3f,
                  z + tan.z * 3.4f + f.lat.z * side * 1.3f,
                  2.6f, 0, 0.5f + (float) rnd() * 0.5f, TONES[1]);
            block(x + tan.x * 0.4f, z + tan.z * 0.4f, 2.4f, 3.2f,
                  (float) rnd() * (float) M_PI * 0.5f, TONES[2]);
            placed.push_back({ x, z, 5.5f });
            mShadowSpots.push_back({ x, z, 2.2f, 3.2f });
            break;
        }
    }

    if (has(9)) { // duck — a chunky bath-toy spectator (playroom)
        constexpr uint32_t YELLOW = 0xf6cf46, BILL = 0xf2953c;
        for (float s = 30; s < tb.length - 10; s += 3) {
            const TrackBin::Sample f = tb.frameAt(s);
            if (f.pos.y - gy > 0.8f) continue;
            const int side = rnd() < 0.5 ? -1 : 1;
            const float lat = side * (f.width / 2 + 4.2f);
            const float x = f.pos.x + f.lat.x * lat, z = f.pos.z + f.lat.z * lat;
            if (!isClear(x, z, 3)) continue;
            const float fx = -f.lat.x * side, fz = -f.lat.z * side;
            const Spot sp{ x, z, std::atan2(fx, fz), true };
            part(applyPre(primIcoDetail(1.5f, 1),
                        mat4f::scaling(float3{ 1.1f, 0.82f, 1.35f })),
                    0, 1.2f, -0.2f, sp, YELLOW); // chesty hull
            for (const int sd : { -1, 1 }) { // wing slabs against the hull
                part(applyPre(primIcoDetail(0.8f, 1),
                            rotZ(sd * 0.22f) * rotX(-0.38f)
                                    * mat4f::scaling(float3{ 0.3f, 0.66f, 1.2f })),
                        sd * 1.44f, 1.55f, -0.45f, sp, YELLOW, 0.94f);
            }
            part(applyPre(primCone(0.55f, 1.1f, 6), rotX(-(float) M_PI / 2 - 0.65f)),
                    0, 1.75f, -1.85f, sp, YELLOW, 0.98f); // tail flicks up and aft
            part(primIcoDetail(0.9f, 1), 0, 2.72f, 0.7f, sp, YELLOW, 1.02f); // head
            part(applyPre(primIcoDetail(0.5f, 1),
                        mat4f::scaling(float3{ 1.7f, 0.45f, 1.15f })),
                    0, 2.55f, 1.5f, sp, BILL); // one broad smiling paddle
            for (const int sd : { -1, 1 }) { // eyes wide apart on the sides
                part(primIcoDetail(0.14f, 1), sd * 0.68f, 2.99f, 1.23f, sp, 0x343a44);
            }
            placed.push_back({ x, z, 3 });
            mShadowSpots.push_back({ x, z, 1.6f, 2.7f });
            break;
        }
    }

    if (has(10)) { // ball — the classic panelled play ball (playroom)
        constexpr float BR = 1.5f;
        static const uint32_t PANELS[6] = { 0xdf4a3c, 0xf5f2ea, 0x3f6fd1,
                                            0xf5f2ea, 0xf2c14e, 0xf5f2ea };
        for (float s = 85; s < tb.length - 10; s += 3) {
            const TrackBin::Sample f = tb.frameAt(s);
            if (f.pos.y - gy > 0.8f) continue;
            const int side = rnd() < 0.5 ? -1 : 1;
            const float lat = side * (f.width / 2 + 4.8f);
            const float x = f.pos.x + f.lat.x * lat, z = f.pos.z + f.lat.z * lat;
            if (!isClear(x, z, 2.8f)) continue;
            // Panels are painted PER FACE by centroid longitude (per-vertex
            // lerping smears the seams) with white polar caps cut at a whole
            // latitude ring, then the ball is tilted — a settled ball never
            // sits pole-up, and the tilt is what makes the panels read.
            const Prim sph = primSphere(BR, 18, 12);
            const float rz = 0.35f + (float) rnd() * 0.4f;
            const float ry = (float) rnd() * 2.0f * (float) M_PI;
            const mat4f m = mat4f::translation(float3{ x, gy + BR * 0.92f, z })
                    * rotY(ry) * rotZ(rz);
            constexpr float CAP_LAT = (float) M_PI / 6;
            for (size_t t = 0; t + 2 < sph.i.size(); t += 3) {
                const float3 a = sph.v[sph.i[t]], b = sph.v[sph.i[t + 1]];
                const float3 c = sph.v[sph.i[t + 2]];
                const float3 ctr = (a + b + c) / 3.0f;
                const float polar = std::acos(ctr.y / std::max(1e-6f, length(ctr)));
                const uint32_t hex = (polar < CAP_LAT || polar > (float) M_PI - CAP_LAT)
                        ? 0xf5f2eau
                        : PANELS[(size_t) std::floor(
                                ((std::atan2(ctr.z, ctr.x) + (float) M_PI)
                                        / (2 * (float) M_PI)) * 6) % 6];
                const uint32_t col = packLinear(srgbToLinear(hex), 1.0f);
                const uint32_t base = (uint32_t) mLandmarks.verts.size();
                for (const float3& v : { a, b, c }) {
                    const float3 w = (m * float4{ v, 1 }).xyz;
                    smooth((uint32_t) mLandmarks.verts.size(), m, v);
                    mLandmarks.verts.push_back({ w.x, w.y, w.z, col });
                }
                mLandmarks.idx.insert(mLandmarks.idx.end(), { base, base + 1, base + 2 });
            }
            placed.push_back({ x, z, 2.5f });
            mShadowSpots.push_back({ x, z, 1.5f, 3.0f });
            break;
        }
    }

    if (has(11)) { // umbrella — a day at the beach
        const Spot sp = findSpot(45, 5.2f, 4);
        if (sp.ok) {
            constexpr float TILT = 0.2f; // leans gently toward the road
            // The pole runs UP INTO the dome, so the fabric hangs off its stick.
            part(applyPre(primCylinder(0.07f, 0.09f, 4.1f, 8),
                        rotX(TILT) * mat4f::translation(float3{ 0, 2.05f, 0 })),
                    0, 0, 0, sp, 0xf0e6d4);
            // Canopy: coral/cream gores by longitude, per face. TWO shells —
            // the landmark material is single-sided, so a lone dome vanishes
            // from below; a smaller inner copy with flipped winding lines it.
            for (const bool inner : { false, true }) {
                const Prim dome = primSphereBand(inner ? 1.97f : 2.0f, 20, 5,
                        0, (float) M_PI / 2.15f);
                const mat4f m = mat4f::translation(float3{ sp.x, gy, sp.z })
                        * rotY(sp.yaw) * rotX(TILT)
                        * mat4f::translation(float3{ 0, 3.06f, 0 })
                        * mat4f::scaling(float3{ 1, 0.62f, 1 });
                for (size_t t = 0; t + 2 < dome.i.size(); t += 3) {
                    const float3 a = dome.v[dome.i[t]], b = dome.v[dome.i[t + 1]];
                    const float3 c = dome.v[dome.i[t + 2]];
                    const float3 ctr = (a + b + c) / 3.0f;
                    const int gore = (int) std::floor(
                            ((std::atan2(ctr.z, ctr.x) + (float) M_PI)
                                    / (2 * (float) M_PI)) * 10) % 2;
                    const uint32_t col = packLinear(
                            srgbToLinear(gore ? 0xe4604a : 0xf7f0e2),
                            inner ? 0.72f : 1.0f);
                    const uint32_t base = (uint32_t) mLandmarks.verts.size();
                    for (const float3& v : { a, b, c }) {
                        const float3 w = (m * float4{ v, 1 }).xyz;
                        smooth((uint32_t) mLandmarks.verts.size(), m, inner ? -v : v);
                        mLandmarks.verts.push_back({ w.x, w.y, w.z, col });
                    }
                    if (inner) {
                        mLandmarks.idx.insert(mLandmarks.idx.end(),
                                { base, base + 2, base + 1 }); // faces down/inward
                    } else {
                        mLandmarks.idx.insert(mLandmarks.idx.end(),
                                { base, base + 1, base + 2 });
                    }
                }
            }
            part(applyPre(primSphere(0.11f, 8, 6),
                        rotX(TILT) * mat4f::translation(float3{ 0, 4.36f, 0 })),
                    0, 0, 0, sp, 0xe4604a); // finial caps the crown
            part(primBox(2.7f, 0.06f, 1.5f), 2.5f, 0.05f, 0.5f, sp, 0x5fc4b8);  // towel
            part(primBox(2.7f, 0.075f, 0.34f), 2.5f, 0.05f, 1.05f, sp, 0xf7f0e2);
            part(primBox(0.7f, 0.5f, 0.45f), -2.1f, 0.27f, 0.4f, sp, 0xd8463f); // cooler
            part(primBox(0.74f, 0.14f, 0.49f), -2.1f, 0.59f, 0.4f, sp, 0xf5f0e2);
            mShadowSpots.push_back({ sp.x, sp.z, 2.2f, 4.4f });
        }
    }

    if (has(12)) { // sandcastle — a bucket-castle at sandbox scale
        Spot sp = findSpotMid(3.2f);
        if (!sp.ok) sp = findSpot(80, 6.0f, 3.2f);
        if (sp.ok) {
            static const uint32_t SAND[2] = { 0xe8d49e, 0xdfc98e };
            constexpr float S = 0.44f;
            const float KR = 0.8f * S, KH = 1.9f * S;
            part(primCylinder(KR * 0.94f, KR, KH, 10), 0, KH / 2, 0, sp, SAND[0], 1.02f);
            part(primCylinder(KR * 0.98f, KR * 0.94f, 0.1f * S, 10),
                    0, KH + 0.05f * S, 0, sp, SAND[1]);
            for (int mi = 0; mi < 6; mi++) { // the crenellations
                const float ma = ((float) mi / 6) * 2.0f * (float) M_PI + 0.26f;
                part(applyPre(primBox(0.34f * S, 0.3f * S, 0.16f * S), rotY(-ma)),
                        std::cos(ma) * KR * 0.82f, KH + 0.22f * S,
                        std::sin(ma) * KR * 0.82f, sp, SAND[1], 1.04f);
            }
            const auto tower = [&](float lx, float lz, float r, float h) {
                part(primCylinder(r * 0.92f, r, h, 10), lx, h / 2, lz, sp, SAND[0], 1.02f);
                part(primCone(r * 1.08f, r * 0.9f, 10), lx, h + r * 0.42f, lz, sp,
                        SAND[1], 0.96f);
            };
            for (const int tx2 : { 1, -1 }) {
                for (const int tz2 : { 1, -1 }) {
                    tower(tx2 * 1.35f * S, tz2 * 1.35f * S, 0.5f * S, 1.2f * S);
                }
            }
            const float W[4][4] = { { 0, 1.35f * S, 1.9f * S, 0.3f * S },
                                    { 0, -1.35f * S, 1.9f * S, 0.3f * S },
                                    { 1.35f * S, 0, 0.3f * S, 1.9f * S },
                                    { -1.35f * S, 0, 0.3f * S, 1.9f * S } };
            for (const auto& w : W) { // curtain walls
                part(primBox(w[2], 0.75f * S, w[3]), w[0], 0.37f * S, w[1], sp,
                        SAND[0], 0.94f);
            }
            part(primBox(0.5f * S, 0.5f * S, 0.12f * S), 0, 0.25f * S, 1.5f * S,
                    sp, 0x6b5a3e); // dark gateway
            const float SH[3][2] = { { 0.8f, 2.1f }, { 2.4f, 2.4f }, { 4.2f, 2.2f } };
            for (const auto& sh : SH) { // shells dotted around the base
                part(applyPre(primSphereBand(0.16f * S, 8, 4, 0, (float) M_PI / 2),
                            rotY(sh[0]) * mat4f::scaling(float3{ 1, 0.5f, 1.15f })),
                        std::cos(sh[0]) * sh[1] * S, 0.02f,
                        std::sin(sh[0]) * sh[1] * S, sp, 0xecc8b4, 1.02f);
            }
            part(primCylinder(0.03f, 0.03f, 0.8f * S, 6), 0, KH + 0.6f * S, 0, sp, 0x8a6f4d);
            part(applyPre(primCone(0.16f * S, 0.5f * S, 3), rotZ(-(float) M_PI / 2)),
                    0.3f * S, KH + 0.85f * S, 0, sp, 0xd94f3d); // pennant
            mShadowSpots.push_back({ sp.x, sp.z, 1.4f, 1.2f });
        }
    }

    if (has(6)) { // windmill — a western water-pump derrick with a spinning rotor
        const Spot sp = findSpot(70, 13 + (float) rnd() * 5, 5);
        if (sp.ok) {
            constexpr float H = 10.5f; // hub height
            constexpr uint32_t TIMBER = 0x9a7050, STEEL = 0xc6cbd6;
            // Four legs leaning in from a 2.7-square base to a 0.7-square top.
            for (const int sx2 : { 1, -1 }) {
                for (const int sz2 : { 1, -1 }) {
                    const float3 dir{ (0.35f - 1.35f) * sx2, H, (0.35f - 1.35f) * sz2 };
                    const float len = length(dir);
                    const quatf q = quatf::fromDirectedRotation(float3{ 0, 1, 0 },
                            normalize(dir));
                    part(applyPre(primCylinder(0.1f, 0.15f, len, 6),
                                mat4f(q) * mat4f::translation(float3{ 0, len / 2, 0 })),
                            1.35f * sx2, 0, 1.35f * sz2, sp, TIMBER,
                            0.94f + ((sx2 + sz2 + 2) % 3) * 0.04f);
                }
            }
            for (const float bh : { 3.6f, 7.0f }) { // two brace frames
                const float hw = 1.35f + (0.35f - 1.35f) * (bh / H);
                const float B[4][4] = { { 0, hw, hw * 2 + 0.2f, 0.09f },
                                        { 0, -hw, hw * 2 + 0.2f, 0.09f },
                                        { hw, 0, 0.09f, hw * 2 + 0.2f },
                                        { -hw, 0, 0.09f, hw * 2 + 0.2f } };
                for (const auto& b : B) {
                    part(primBox(b[2], 0.09f, b[3]), b[0], bh, b[1], sp, TIMBER, 0.9f);
                }
            }
            part(primBox(1.35f, 0.14f, 1.35f), 0, H + 0.07f, 0, sp, TIMBER, 1.05f);
            part(primBox(0.45f, 0.4f, 0.8f), 0, H + 0.35f, 0.05f, sp, STEEL, 0.9f);
            part(primBox(0.08f, 0.08f, 1.6f), 0, H + 0.35f, -0.95f, sp, STEEL, 0.85f);
            part(primBox(0.05f, 0.75f, 0.9f), 0, H + 0.42f, -1.85f, sp, 0xd8463f);
            // The rotor is its own mesh — the render loop spins it about the
            // facing axis (the JS registers it with the per-track anim list).
            {
                const auto rpart = [&](const Prim& prim, uint32_t hex, float shade) {
                    const uint32_t c = packLinear(srgbToLinear(hex), shade);
                    const uint32_t base = (uint32_t) mWindmill.verts.size();
                    for (const float3& v : prim.v) {
                        mWindmill.verts.push_back({ v.x, v.y, v.z, c });
                    }
                    for (const uint32_t i : prim.i) mWindmill.idx.push_back(base + i);
                };
                rpart(applyPre(primCylinder(0.22f, 0.22f, 0.2f, 10),
                            rotX((float) M_PI / 2)), STEEL, 1.05f);
                for (int bi = 0; bi < 12; bi++) { // 12 flat blades fanned in XY
                    rpart(applyPre(primBox(0.3f, 1.8f, 0.04f),
                                rotZ(((float) bi / 12) * 2.0f * (float) M_PI)
                                        * mat4f::translation(float3{ 0, 1.1f, 0 })),
                            STEEL, 0.92f + (bi % 3) * 0.05f);
                }
                rpart(applyPre(primTorusArc(1.95f, 0.045f, 6, 28, 2.0f * (float) M_PI),
                            rotX((float) M_PI / 2)), STEEL, 0.88f); // the outer band
                accumulateNormals(mWindmill);
                buildMesh(mWindmill);
                const float fx = std::sin(sp.yaw), fz = std::cos(sp.yaw);
                mWindmillBase = mat4f::translation(
                        float3{ sp.x + fx * 0.75f, gy + H + 0.35f, sp.z + fz * 0.75f })
                        * mat4f::rotation(sp.yaw, float3{ 0, 1, 0 });
            }
            mShadowSpots.push_back({ sp.x, sp.z, 2.0f, 10.5f });
        }
    }

    if (has(13)) { // cabin — a log cabin with smoke curling from the chimney
        const Spot sp = findSpot(65, 10 + (float) rnd() * 5, 5);
        if (sp.ok) {
            constexpr uint32_t LOG = 0x8a6142, LOG2 = 0x7a5438, SNOWC = 0xf3f7fb;
            for (int row = 0; row < 5; row++) { // log courses
                const float ly = 0.26f + row * 0.5f;
                for (const float zoff : { 1.8f, -1.8f }) { // front/back along local X
                    part(applyPre(primCylinder(0.26f, 0.26f, 5.0f, 7),
                                rotZ((float) M_PI / 2)),
                            0, ly, zoff, sp, row % 2 ? LOG : LOG2,
                            0.97f + (row % 3) * 0.03f);
                }
                for (const float xoff : { 2.3f, -2.3f }) { // sides, half a course up
                    part(applyPre(primCylinder(0.26f, 0.26f, 4.0f, 7),
                                rotX((float) M_PI / 2)),
                            xoff, ly + 0.25f, 0, sp, row % 2 ? LOG2 : LOG,
                            0.96f + (row % 2) * 0.04f);
                }
            }
            for (int gi = 0; gi < 3; gi++) { // gable ends shorten toward the ridge
                const float ly = 2.76f + gi * 0.48f;
                for (const float zoff : { 1.8f, -1.8f }) {
                    part(applyPre(primCylinder(0.24f, 0.24f, 3.4f - gi * 1.1f, 7),
                                rotZ((float) M_PI / 2)),
                            0, ly, zoff, sp, gi % 2 ? LOG : LOG2);
                }
            }
            for (const int sd : { -1, 1 }) { // snow-heaped roof slabs
                part(applyPre(primBox(3.05f, 0.22f, 5.4f), rotZ(sd * 0.6f)),
                        sd * -1.2f, 3.6f, 0, sp, SNOWC);
            }
            part(applyPre(primCylinder(0.18f, 0.18f, 5.45f, 7), rotX((float) M_PI / 2)),
                    0, 4.32f, 0, sp, SNOWC, 0.98f); // snow-capped ridge log
            part(primBox(0.9f, 1.5f, 0.14f), 0.95f, 0.75f, 1.98f, sp, 0x4a3a2e);  // door
            part(primBox(0.78f, 0.68f, 0.14f), -1.0f, 1.35f, 1.98f, sp, 0xffd98a); // lit window
            part(primBox(0.92f, 0.1f, 0.16f), -1.0f, 1.74f, 1.99f, sp, 0x4a3a2e);  // lintel
            part(primBox(0.55f, 2.3f, 0.55f), -0.95f, 3.5f, -0.95f, sp, 0x9fa8ba); // chimney
            part(primBox(0.68f, 0.14f, 0.68f), -0.95f, 4.68f, -0.95f, sp, 0xb9c1d0);
            // Chimney smoke: three soft puffs rising, growing and fading on a
            // staggered loop (the JS sprites, as blend quads billboarded per cell).
            {
                const float cy2 = std::cos(sp.yaw), sy2 = std::sin(sp.yaw);
                mSmokeOrigin = { sp.x + (-0.95f) * cy2 + (-0.95f) * sy2,
                                 gy + 4.75f,
                                 sp.z - (-0.95f) * sy2 + (-0.95f) * cy2 };
                if (mBlendMaterial) {
                    mSmoke.resize(3);
                    const BlurKernel blur(6.0f);
                    constexpr int NX = 16, NY = 16;
                    for (Mesh& m : mSmoke) {
                        for (int j = 0; j <= NY; j++) {
                            for (int k = 0; k <= NX; k++) {
                                const float px = (float) k / NX * 64.0f;
                                const float py = (float) j / NY * 64.0f;
                                const float cov = blur.coverage(px, py,
                                        [](float bx, float by) {
                                            const float dx = bx - 32, dy = by - 32;
                                            return dx * dx + dy * dy <= 18 * 18;
                                        });
                                m.verts.push_back({ (float) k / NX - 0.5f,
                                                    0.5f - (float) j / NY, 0,
                                                    packLinear(srgbToLinear(0xeef2f6),
                                                            1.0f, cov) });
                            }
                        }
                        for (int j = 0; j < NY; j++) {
                            for (int k = 0; k < NX; k++) {
                                const uint32_t b = (uint32_t) (j * (NX + 1) + k);
                                const uint32_t n = b + (uint32_t) (NX + 1);
                                m.idx.insert(m.idx.end(), { b, n, b + 1, b + 1, n, n + 1 });
                            }
                        }
                        buildMesh(m, true, mBlendMaterial->getDefaultInstance(), 5);
                    }
                }
            }
            mShadowSpots.push_back({ sp.x, sp.z, 3.0f, 4.3f });
        }
    }

    if (has(0)) { // gnome
        const Spot sp = findSpot(30, 3.4f, 2.2f);
        if (sp.ok) {
            mShadowSpots.push_back({ sp.x, sp.z, 0.9f, 1.2f });
            buildGnomeModel(at(sp), mModelVariant[MODEL_GNOME]);
        }
    }
    if (has(1)) { // doghouse
        const float off = 8 + (float) rnd() * 3;
        const Spot sp = findSpot(60, off, 3.2f);
        if (sp.ok) {
            mShadowSpots.push_back({ sp.x, sp.z, 2.3f, 1.4f });
            const uint32_t WALL = 0xc4573f, ROOF = 0x5e4434, TRIM = 0xf5f0e2, DARK = 0x3a3040;
            part(primBox(2.3f, 1.5f, 2.6f), 0, 0.75f, 0, sp, WALL);
            part(applyPre(primBox(1.64f, 1.64f, 2.55f), rotZ((float) M_PI / 4)), 0, 1.5f, 0, sp, WALL, 0.98f);
            for (const int sd : { -1, 1 })
                part(applyPre(primBox(1.85f, 0.13f, 3.0f), rotZ(sd * -(float) M_PI / 4)),
                        sd * 0.62f, 2.08f, 0, sp, ROOF);
            part(applyPre(primBox(0.26f, 0.26f, 3.05f), rotZ((float) M_PI / 4)), 0, 2.7f, 0, sp, ROOF, 1.12f);
            part(primBox(1.0f, 0.98f, 0.1f), 0, 0.49f, 1.31f, sp, TRIM);
            part(applyPre(primCylinder(0.5f, 0.5f, 0.1f, 12), rotX((float) M_PI / 2)), 0, 0.98f, 1.31f, sp, TRIM);
            part(primBox(0.84f, 0.84f, 0.12f), 0, 0.42f, 1.33f, sp, DARK);
            part(applyPre(primCylinder(0.42f, 0.42f, 0.12f, 12), rotX((float) M_PI / 2)), 0, 0.84f, 1.33f, sp, DARK);
            part(primCylinder(0.32f, 0.26f, 0.2f, 10), 1.35f, 0.1f, 1.7f, sp, 0xd8463f);
            const float boneYaw = 0.7f;
            part(applyPre(primCylinder(0.07f, 0.07f, 0.55f, 6), rotY(boneYaw) * rotZ((float) M_PI / 2)),
                    -1.15f, 0.08f, 1.55f, sp, 0xf3ecdc);
            for (const int be : { -1, 1 }) for (const int bs : { -1, 1 }) {
                part(applyPre(primSphere(0.09f, 6, 5),
                        rotY(boneYaw) * mat4f::translation(float3{ be * 0.28f, 0, bs * 0.07f })),
                        -1.15f, 0.09f, 1.55f, sp, 0xf3ecdc);
            }
        }
    }
    if (has(2)) { // picnic
        Spot sp = findSpotMid(3.2f);
        if (!sp.ok) sp = findSpot(95, 4.8f, 3.2f);
        if (sp.ok) {
            mShadowSpots.push_back({ sp.x, sp.z, 2.1f, 0.4f });
            // Blanket: 5×5 chequer grid, thrown slightly askew.
            const Spot bsp = { sp.x, sp.z, sp.yaw + 0.26f, true };
            const float CELL = 3.4f / 5;
            for (int gx = 0; gx < 5; gx++) for (int gz = 0; gz < 5; gz++) {
                // paintFaces keys checks on centroid/0.68 — same parity here
                const uint32_t col = ((gx + gz) % 2) ? 0xd8463f : 0xf5f0e2;
                Prim q = primBox(CELL, 0.06f, CELL);
                part(q, -1.7f + (gx + 0.5f) * CELL, 0.04f, -1.7f + (gz + 0.5f) * CELL, bsp, col);
            }
            part(primBox(0.85f, 0.55f, 0.55f), 0.7f, 0.3f, 0.6f, sp, 0x8a6f4d);
            part(applyPre(primTorusArc(0.3f, 0.05f, 8, 14, (float) M_PI), rotY((float) M_PI / 2)),
                    0.7f, 0.57f, 0.6f, sp, 0x6e563c);
            part(primBox(0.72f, 0.5f, 0.5f), -0.85f, 0.29f, -0.7f, sp, 0xd8463f);
            part(primBox(0.76f, 0.14f, 0.54f), -0.85f, 0.6f, -0.7f, sp, 0xf5f0e2);
            part(primCylinder(0.22f, 0.22f, 0.04f, 12), -0.35f, 0.07f, 0.9f, sp, 0xf7f5ee);
            part(primCylinder(0.22f, 0.22f, 0.04f, 12), 0.55f, 0.07f, -0.55f, sp, 0xf7f5ee);
        }
    }

    if (has(14)) { // crayons — four fat wax sticks spilled, a fifth thrown across
        const Spot sp = findSpot(110, 4.4f, 3);
        if (sp.ok) {
            static const uint32_t COLS[5] = { 0xd8463f, 0x3f6fd1, 0x3fa14e,
                                              0xf2a83c, 0x8a76d8 };
            const float a0 = (float) rnd() * 2.0f * (float) M_PI; // the spill's heading
            const float px2 = std::sin(a0), pz2 = std::cos(a0);   // spread axis
            for (int i = 0; i < 5; i++) {
                const bool onTop = i == 4;
                const float ai = onTop ? a0 + 1.25f
                                       : a0 + ((float) rnd() - 0.5f) * 0.2f;
                const float off = onTop ? 0.15f : (i - 1.5f) * 0.6f;
                const float slide = onTop ? 0.0f : ((float) rnd() - 0.5f) * 0.8f;
                const float ox = px2 * off + std::cos(ai) * slide;
                const float oz = pz2 * off - std::sin(ai) * slide;
                const float lift = onTop ? 0.33f : 0.0f;
                const Spot at{ sp.x, sp.z, 0, true };
                const auto make = [&](Prim g, uint32_t hex, float shade) {
                    part(applyPre(g, rotY(ai) * rotZ((float) M_PI / 2)),
                            ox, 0.17f + lift, oz, at, hex, shade);
                };
                make(primCylinder(0.16f, 0.16f, 2.3f, 9), COLS[i], 1.0f);
                make(applyPre(primCone(0.16f, 0.42f, 9),
                            mat4f::translation(float3{ 0, 1.36f, 0 })), COLS[i], 1.08f);
                make(primCylinder(0.18f, 0.18f, 1.3f, 9), COLS[i], 0.88f); // paper band
            }
            mShadowSpots.push_back({ sp.x, sp.z, 1.4f, 0.4f });
        }
    }

    if (has(15)) { // books — three stacked picture books, spines askew
        const Spot sp = findSpot(130, 8 + (float) rnd() * 3, 3);
        if (sp.ok) {
            static const uint32_t COVERS[3] = { 0x3f6fd1, 0xd8463f, 0x3fa14e };
            float ty = 0;
            for (int i = 0; i < 3; i++) {
                const float w = 2.6f - i * 0.35f, d = 1.9f - i * 0.22f, h = 0.42f;
                const float a = ((float) rnd() - 0.5f) * 0.7f;
                const Spot at{ sp.x, sp.z, a, true };
                part(primBox(w - 0.18f, h - 0.13f, d - 0.12f), 0.06f, ty + h / 2, 0,
                        at, 0xf7f5ee);
                part(primBox(w, 0.07f, d), 0, ty + h - 0.035f, 0, at, COVERS[i]);
                part(primBox(w, 0.07f, d), 0, ty + 0.035f, 0, at, COVERS[i], 0.94f);
                part(primBox(0.1f, h, d), -w / 2 + 0.05f, ty + h / 2, 0, at,
                        COVERS[i], 0.88f);
                ty += h;
            }
            mShadowSpots.push_back({ sp.x, sp.z, 1.5f, 1.3f });
        }
    }

    if (has(16)) { // train — a wind-up loco trundling a slow oval on the floor
        constexpr float RT = TRAIN_RT, LT = TRAIN_LT;
        constexpr float OM = RT + LT / 2 + 1.5f;    // footprint kept clear
        Spot sp = findSpotMid(OM);                  // the middle of the floor first
        if (!sp.ok) sp = findSpot(40, OM + 2, OM);
        if (sp.ok) {
            // The oval's long axis rides the road tangent. findSpotMid yaws at
            // random, so derive the frame from the spot's own yaw either way.
            const float ao = sp.yaw;
            const float co = std::cos(ao), so = std::sin(ao);
            const Spot rail{ sp.x, sp.z, ao, true };
            // THE TRACK, which used to be two brown hoops lying in the grass at
            // y 0.03 — the same thin cylinder for the straights and the bends,
            // no sleepers, and a loco whose wheels passed straight through it.
            // A model railway is read by its LADDER: cross-ties at a regular
            // beat, with the rails proud on top of them.
            //
            // Sleepers walk the shared stadium path (trainAt) at a fixed
            // spacing, so they follow the ends round instead of stopping at the
            // straights, and so they cannot drift from the line the loco takes.
            constexpr float TIE_STEP = 0.62f;
            const float perim = trainPerim();
            const int ties = (int) std::round(perim / TIE_STEP);
            for (int i = 0; i < ties; i++) {
                const TrainAt t = trainAt((float) i * (perim / (float) ties));
                const float head = std::atan2(t.dx, t.dz);
                part(applyPre(primBox(TRAIN_GAUGE * 2 + 0.34f, TRAIN_SLEEPER_Y, 0.2f),
                            rotY(head)),
                        t.x, TRAIN_SLEEPER_Y / 2, t.z, rail, 0x9a7b52, 1.0f);
            }
            // Rails: STEEL now, not wood, and sitting on the ties rather than in
            // the grass. Same two-piece construction as before (a cylinder per
            // straight, a half-torus per end) because it costs four prims for
            // the whole loop where a swept ribbon would cost hundreds.
            for (const float rr : { RT - TRAIN_GAUGE, RT + TRAIN_GAUGE }) {
                for (const float zs : { -rr, rr }) { // two straights
                    part(applyPre(primCylinder(TRAIN_RAIL_R, TRAIN_RAIL_R, LT, 8),
                                rotZ((float) M_PI / 2)),
                            0, TRAIN_RAIL_Y, zs, rail, 0x8d949e, 1.0f);
                }
                for (const int es : { 1, -1 }) {     // two half-torus ends
                    part(applyPre(primTorusArc(rr, TRAIN_RAIL_R, 8, 30, (float) M_PI),
                                rotY(es * ((float) M_PI / 2))),
                            es * (LT / 2), TRAIN_RAIL_Y, 0, rail, 0x8d949e, 1.0f);
                }
            }
            // The loco (and its winding key) are their own meshes — the render
            // loop drives them round the stadium.
            const auto lp = [&](Mesh& mesh, Prim prim, float lx, float ly, float lz,
                    uint32_t hex, float shade) {
                const uint32_t c = packLinear(srgbToLinear(hex), shade);
                const uint32_t base = (uint32_t) mesh.verts.size();
                for (const float3& v : prim.v) {
                    mesh.verts.push_back({ v.x + lx, v.y + ly, v.z + lz, c });
                }
                for (const uint32_t i : prim.i) mesh.idx.push_back(base + i);
            };
            const int tv = mModelVariant[MODEL_TRAIN];
            buildTrainModel([&](const Prim& p, float lx, float ly, float lz,
                    uint32_t hex, float shade) { lp(mTrain, p, lx, ly, lz, hex, shade); }, tv);
            accumulateNormals(mTrain);
            buildMesh(mTrain);
            buildTrainKeyModel([&](const Prim& p, float lx, float ly, float lz,
                    uint32_t hex, float shade) { lp(mTrainKey, p, lx, ly, lz, hex, shade); }, tv);
            accumulateNormals(mTrainKey);
            buildMesh(mTrainKey);
            // ON the rails, not through them: the loco's wheels stand at y 0,
            // so the whole thing rides at the rail head. Before the ties went in
            // the track was a decal under a train sitting on the grass, and the
            // difference did not show; now it would.
            mTrainCentre = { sp.x, gy + TRAIN_RIDE_Y, sp.z };
            mTrainCos = co;
            mTrainSin = so;
            mHasTrain = true;
        }
    }
    if (!mLandmarks.verts.empty()) {
        accumulateNormals(mLandmarks);
        for (const auto& [idx, n] : smoothNormals) {
            if (idx < mLandmarks.normals.size()) mLandmarks.normals[idx] = n;
        }
        buildMesh(mLandmarks);
    }
}

// Frozen sun shadow, baked ONCE at scene build (the JS renderer bakes its
// shadow map once per track — moving casters carry blobs instead): darken road
// verts occluded from the sun by ELEVATED road geometry (loop/bridge decks) or
// the gantry. Grid-pruned ray/triangle tests keep the bake to a few ms; the
// road VB re-uploads once with the darkened colours.
// ── The frozen sun shadow map ────────────────────────────────────────────────
// Filament renders a shadow map per VIEW per frame. That is the right default
// for a scene with a moving sun, and exactly wrong here: nothing that casts
// ever moves, and a 4-way split-screen re-renders the identical 2048² depth
// pass four times a frame (measured at 1.29 ms per extra cell — the single
// biggest cost in split-screen). The JS renders one map in setTrack, freezes it
// with `shadowMap.autoUpdate = false`, and reuses it for every cell.
//
// So we render our own, once, at scene build: an ortho camera down the sun's
// axis fitted to the track, a depth-only render target, and a layer-filtered
// view so only the casters land in it. The lit materials sample it themselves
// (bindShadowMap hands them the texture and the matrix); Filament's own shadow
// machinery is off entirely, which also drops the per-fragment cascade logic.
//
// Caster set and fit are three's: the fixed track geometry, framed to the road
// bbox grown by the tallest structure, at the same 2048² and the same
// ~2.5-texel normal bias.
void TtpRenderer::bakeShadowMap(const TrackBin& tb) {
    if (mShadowMap) { mEngine->destroy(mShadowMap); mShadowMap = nullptr; }
    // Shadows off (headless automation — see setShadowsEnabled): leave the map
    // null and let the established no-map path carry it. Everything downstream
    // already handles this, because a track whose road has no verts reaches the
    // same state one line below.
    if (!mShadowsEnabled) return;
    if (mRoad.verts.empty() || !mRenderer) return;
    constexpr uint32_t SM = 2048;
    // Fit: the road's own bounds, padded for the structures under it and the
    // gantry over it. A tight box is the whole point — texel size is what the
    // shadow's edge resolves to (three refits its ortho box per track for the
    // same reason).
    float3 lo{ 1e30f }, hi{ -1e30f };
    for (const Vertex& v : mRoad.verts) {
        lo = min(lo, float3{ v.px, v.py, v.pz });
        hi = max(hi, float3{ v.px, v.py, v.pz });
    }
    lo -= float3{ 4.0f, 8.0f, 4.0f };
    hi += float3{ 4.0f, 8.0f, 4.0f };
    const float3 centre = (lo + hi) * 0.5f;
    const float3 toSun = normalize(float3{ 2.0f, 12.0f, 1.5f }); // theme.key, as the JS places it
    // Distance to stand the light off at: the bounding-sphere radius still
    // decides that (it has to clear the geometry from any angle), but it no
    // longer decides the ortho BOX — see below.
    const float radius = length(hi - lo) * 0.5f;

    mShadowMap = Texture::Builder()
            .width(SM).height(SM).levels(1)
            .format(Texture::InternalFormat::DEPTH24)
            .usage(Texture::Usage::DEPTH_ATTACHMENT | Texture::Usage::SAMPLEABLE)
            .build(*mEngine);
    if (!mShadowMap) return;
    RenderTarget* rt = RenderTarget::Builder()
            .texture(RenderTarget::AttachmentPoint::DEPTH, mShadowMap)
            .build(*mEngine);
    utils::Entity camEnt = utils::EntityManager::get().create();
    Camera* cam = mEngine->createCamera(camEnt);
    View* view = mEngine->createView();
    // Aim first, THEN fit the box to what the light actually sees.
    //
    // The ortho used to be a square ±radius, i.e. sized to the bounding SPHERE.
    // A track is nothing like a sphere: skysnake's footprint in the light's own
    // axes is 58.7 x 115.4, so a 127.5 x 127.5 box spent well over half its
    // texels on empty floor, and the shadow edge resolved to 0.062 world units
    // when it could resolve to 0.029. Project the eight bbox corners through the
    // real view matrix (rather than deriving the basis by hand and getting
    // lookAt's convention wrong) and take the extents.
    cam->lookAt(centre + toSun * (radius * 2.0f), centre, float3{ 0, 0, 1 });
    float2 vlo{ 1e30f }, vhi{ -1e30f };
    float dNear = 1e30f, dFar = -1e30f;
    {
        const mat4f V{ cam->getViewMatrix() };
        for (int c = 0; c < 8; c++) {
            const float3 corner{ (c & 1) ? hi.x : lo.x, (c & 2) ? hi.y : lo.y,
                                 (c & 4) ? hi.z : lo.z };
            const float3 p = (V * float4{ corner, 1.0f }).xyz;
            vlo = min(vlo, float2{ p.x, p.y });
            vhi = max(vhi, float2{ p.x, p.y });
            // View space looks down -Z, so distance from the light is -z.
            dNear = std::min(dNear, -p.z);
            dFar = std::max(dFar, -p.z);
        }
    }
    // Half-width of the shadow's soft edge, as a Gaussian sigma in WORLD units.
    // The bake blur below is sized from it, and so is the frustum margin here,
    // because a kernel that reaches past the map's border smears it.
    //
    // THE KNEE IS HERE. Once the kernel stopped being a comb (see vesm.mat) the
    // old 0.55 was simply too wide: a deck's shadow arrived as a smear that no
    // longer described the deck. Sweeping it on skysnake's loop, 10-90 edge
    // width against a fixed camera ran 9.4 px at 0.55, 6.8 at 0.39, 5.6 at
    // 0.28, 5.0 at 0.19 — and below 0.28 the ramp's smoothness falls apart
    // (normalised roughness 0.086 -> 0.099 -> 0.202) while barely narrowing,
    // because a penumbra thinner than a couple of ESM texels cannot survive the
    // runtime's single bilinear tap. So 0.28: most of the sharpening, none of
    // the return of the texel grid. Pair it with vlit/vground's kPenumbraWorld,
    // which floors the width from the receiver side and was halved to match.
    constexpr float kPenumbraSigmaWorld = 0.28f;
    // Margin so the bake blur never reaches off the edge of the map. Outside it
    // CLAMP_TO_EDGE repeats the border texel, which would smear whatever the
    // outermost row happens to hold inward by the kernel's whole reach. Four
    // texels covers the sampling itself; 3.5 sigma covers the blur, and the blur
    // is specified in WORLD units so that half has to be too.
    const float2 margin{
        std::max((vhi.x - vlo.x) / (float) SM * 4.0f, kPenumbraSigmaWorld * 3.5f),
        std::max((vhi.y - vlo.y) / (float) SM * 4.0f, kPenumbraSigmaWorld * 3.5f) };
    vlo -= margin;
    vhi += margin;
    cam->setProjection(Camera::Projection::ORTHO,
            vlo.x, vhi.x, vlo.y, vhi.y,
            std::max(0.0f, dNear - 1.0f), dFar + 1.0f);
    // The slope-scaled bias below wants the COARSER of the two axes.
    mShadowTexel = std::max(vhi.x - vlo.x, vhi.y - vlo.y) / (float) SM;
    // Normalised depth per world unit, so a bias expressed in metres means the
    // same thing on a small circuit and a large one.
    mShadowDepthScale = 1.0f
            / std::max(1.0f, (dFar + 1.0f) - std::max(0.0f, dNear - 1.0f));
    view->setScene(mScene);
    view->setCamera(cam);
    view->setViewport({ 0, 0, SM, SM });
    view->setRenderTarget(rt);
    view->setPostProcessingEnabled(false);
    view->setShadowingEnabled(false);
    // Casters only. NOTE THE 0xff: View::setVisibleLayers MERGES rather than
    // assigns — mVisibleLayers = (mVisibleLayers & ~select) | (values & select),
    // starting from 0x1 — so a select of 0x02 leaves bit 0 SET, and since the
    // test is a plain AND against a layer mask that is 0x1 on every renderable
    // by default, this pass used to render the ENTIRE SCENE into the depth map.
    // Two things came of that: the careful caster set below (elevated road, the
    // gantry, the structures, the berms) was decorative, and every pool that is
    // posed per frame — the car GLBs, their ghosts, the monster rigs, the item
    // boxes, the bananas — was still sitting at its IDENTITY transform when the
    // bake ran, so their stacked silhouette got burnt into the map at the world
    // origin. That is the mystery blob on the ground at (0, 0) on every track.
    view->setVisibleLayers(0xff, 0x02);
    const Renderer::ClearOptions prev = mRenderer->getClearOptions();
    Renderer::ClearOptions co{};
    co.clear = true;
    mRenderer->setClearOptions(co);
    mRenderer->renderStandaloneView(view);
    mRenderer->setClearOptions(prev);

    // World → shadow texture space. Read the matrices BEFORE the camera is
    // destroyed — doing it after is a use-after-free that shows up as a wasm
    // out-of-bounds trap three call frames deep, with nothing pointing back
    // here.
    //
    // Filter the raw depth into a blurred EXPONENTIAL map, then throw the depth
    // away. See vesm.mat: exp(-k·d) is linear under filtering, so the softness
    // is baked in here ONCE and the runtime lookup is a single bilinear tap
    // instead of an N-tap PCF in every lit fragment of every cell. It also
    // means the map's resolution no longer sets the edge's softness — the blur
    // does — so ESM_SM can be well under the depth map's own size.
    // mPresentVB is the shared fullscreen triangle; without vpresent there is none.
    bool esmOk = false;
    if (mEsmMaterial && mPresentVB && mPresentIB) {
        // A QUARTER of the depth map's size. The blur, not the resolution, sets
        // how soft the edge is (see vesm.mat), so this only has to be fine
        // enough that a texel is small next to the penumbra it carries. Pass one
        // still reads every depth texel, so what lands here is an already-smooth
        // field and storing it coarsely costs almost nothing: 2048 -> 1024 left
        // the ramp identical (10-90 width 6.5 px both ways, roughness 0.035 vs
        // 0.036) and the contour indistinguishable, for a quarter of the memory
        // — 16 MB -> 4 MB resident, and a bake peak of 16 MB rather than 40.
        //
        // The floor is real, though. Walking it down on glacier, whose elevated
        // deck throws a long shadow past a row of pillars: 512 is still smooth,
        // 256 SCALLOPS the contour visibly. What matters is sigma measured in
        // THESE texels, so sharpening the penumbra walks toward that floor from
        // the other side: glacier is the catalogue's coarsest map and now
        // carries about 1.6 of them. Re-checked at the sharpened sigma, 1024 and
        // 2048 render that contour indistinguishably (mean 0.12/255 apart, and
        // the visibility field itself is smooth in both), so the quarter of the
        // memory stands. Sharpen much further and this has to go back up.
        // Runtime is a single bilinear tap at any of these sizes.
        constexpr uint32_t ESM_SM = 1024;

        // TWO PASSES, one per axis. Separating it is what makes a wide kernel
        // affordable: sigma is what the penumbra inherits, and reaching a useful
        // sigma with the old single-pass square would have cost (6·sigma)²
        // taps a texel. Two 81-tap passes cost 162.
        //
        // The penumbra is specified in WORLD units so the edge is equally soft
        // on the smallest circuit and the largest; mShadowTexel converts it to
        // the map's own grid. vesm then takes one tap per texel — see the long
        // note there for why anything sparser bands, which is the entire reason
        // this is a uniform and not a spacing.
        //
        // The clamp is vesm's R/3: across the catalogue sigma runs 3.2 texels
        // (glacier) to 6.4 (skyline), so it never binds today. If a future
        // track's light frustum came out finer still, this truncates its
        // Gaussian at 3 sigma-worth of taps — a slightly tighter penumbra —
        // rather than stretching the taps back out into a comb.
        const float sigmaTexels = std::min(kPenumbraSigmaWorld
                        / std::max(1e-4f, mShadowTexel), 40.0f / 3.0f);

        Texture* esm = Texture::Builder()
                .width(ESM_SM).height(ESM_SM).levels(1)
                .format(Texture::InternalFormat::R32F)
                .usage(Texture::Usage::COLOR_ATTACHMENT | Texture::Usage::SAMPLEABLE)
                .build(*mEngine);
        // Ping target for the horizontal pass. Its own filtering matters: pass
        // two samples it at whole-texel offsets, so NEAREST would be exact, but
        // LINEAR costs nothing and forgives the half-texel rounding.
        Texture* tmp = esm ? Texture::Builder()
                .width(ESM_SM).height(ESM_SM).levels(1)
                .format(Texture::InternalFormat::R32F)
                .usage(Texture::Usage::COLOR_ATTACHMENT | Texture::Usage::SAMPLEABLE)
                .build(*mEngine) : nullptr;
        if (esm && tmp) {
            // The fullscreen triangle, its scene and its camera are the same for
            // both passes; only the material instance and the target differ.
            utils::Entity q = utils::EntityManager::get().create();
            Scene* qs = mEngine->createScene();
            utils::Entity qcamEnt = utils::EntityManager::get().create();
            Camera* qcam = mEngine->createCamera(qcamEnt);
            qcam->setProjection(Camera::Projection::ORTHO, -1, 1, -1, 1, 0, 1);

            TextureSampler nsmp(TextureSampler::MinFilter::NEAREST,
                    TextureSampler::MagFilter::NEAREST);
            nsmp.setWrapModeS(TextureSampler::WrapMode::CLAMP_TO_EDGE);
            nsmp.setWrapModeT(TextureSampler::WrapMode::CLAMP_TO_EDGE);
            TextureSampler lsmp(TextureSampler::MinFilter::LINEAR,
                    TextureSampler::MagFilter::LINEAR);
            lsmp.setWrapModeS(TextureSampler::WrapMode::CLAMP_TO_EDGE);
            lsmp.setWrapModeT(TextureSampler::WrapMode::CLAMP_TO_EDGE);

            const Renderer::ClearOptions eprev = mRenderer->getClearOptions();
            Renderer::ClearOptions eco{};
            eco.clear = true;
            eco.clearColor = { 1, 0, 0, 0 }; // exp(0) = fully lit outside the map

            // src, its sampler, its size, the axis, and whether src is raw depth.
            const struct { Texture* src; bool depth; float2 dir; Texture* dst; }
                    passes[2] = {
                { mShadowMap, true,  { 1.0f, 0.0f }, tmp },
                { tmp,        false, { 0.0f, 1.0f }, esm },
            };
            for (const auto& p : passes) {
                MaterialInstance* emi = mEsmMaterial->createInstance();
                emi->setParameter("src", p.src, p.depth ? nsmp : lsmp);
                emi->setParameter("k", kShadowEsmK);
                const float srcSize = (float) (p.depth ? SM : ESM_SM);
                emi->setParameter("texel", float2{ 1.0f / srcSize, 1.0f / srcSize });
                emi->setParameter("dir", p.dir);
                // sigma is in SOURCE texels, and the two passes have
                // different sources: pass one reads the depth map, pass two
                // reads this material's own 1/4-scale output.
                emi->setParameter("sigma", sigmaTexels
                        * (p.depth ? 1.0f : (float) ESM_SM / (float) SM));
                emi->setParameter("fromDepth", p.depth ? 1.0f : 0.0f);
                RenderableManager::Builder(1)
                        .boundingBox({ { 0, 0, 0 }, { 1, 1, 1 } })
                        .material(0, emi)
                        .geometry(0, RenderableManager::PrimitiveType::TRIANGLES,
                                mPresentVB, mPresentIB, 0, 3)
                        .culling(false).castShadows(false).receiveShadows(false)
                        .build(*mEngine, q);
                qs->addEntity(q);
                RenderTarget* ert = RenderTarget::Builder()
                        .texture(RenderTarget::AttachmentPoint::COLOR, p.dst)
                        .build(*mEngine);
                View* qv = mEngine->createView();
                qv->setScene(qs);
                qv->setCamera(qcam);
                qv->setViewport({ 0, 0, ESM_SM, ESM_SM });
                qv->setRenderTarget(ert);
                qv->setPostProcessingEnabled(false);
                qv->setShadowingEnabled(false);
                qv->setFrustumCullingEnabled(false);
                mRenderer->setClearOptions(eco);
                mRenderer->renderStandaloneView(qv);
                mRenderer->setClearOptions(eprev);
                // Both passes read a texture the next step destroys or writes.
                mEngine->flushAndWait();
                mEngine->destroy(qv);
                mEngine->destroy(ert);
                qs->remove(q);
                mEngine->destroy(q); // the renderable, not the entity
                mEngine->destroy(emi);
            }
            utils::EntityManager::get().destroy(q);
            mEngine->destroy(qs);
            mEngine->destroyCameraComponent(qcamEnt);
            utils::EntityManager::get().destroy(qcamEnt);
            mEngine->destroy(tmp);
            mEngine->destroy(mShadowMap); // 2048² DEPTH24 -> 2048² R32F
            mShadowMap = esm;
            esmOk = true;
        } else if (esm) {
            mEngine->destroy(esm);
        }
    }
    if (!esmOk) {
        // R32F needs EXT_color_buffer_float, and vpresent has to be present for
        // the fullscreen triangle. Without both, the raw depth map is still
        // sitting in mShadowMap — but the samplers now do an ESM lookup, which
        // is meaningless on depth. Drop it: bindShadowMap then binds the 1x1
        // white stand-in with shadowTexel 0, which reads as "fully lit".
        if (mShadowMap) { mEngine->destroy(mShadowMap); mShadowMap = nullptr; }
    }

    // Clip → texture space. x and y are the usual half-scale; z needs a NEGATIVE
    // one, and getting that wrong is why no track has ever had a correct baked
    // sun shadow.
    //
    // Both halves of the convention were measured rather than assumed:
    //   - getProjectionMatrix() returns clip z in [-1,1] (near = -1). Pushing
    //     the road's eight bbox corners through it prints z/w spanning
    //     [-0.19, +0.19] — dead centred on zero, not inside [0,1].
    //   - the map itself holds REVERSED depth, 1 at the light. Rendering our
    //     computed z and the stored texel into two channels and fitting one
    //     against the other over the whole road gives stored = -0.87·ours + 0.93,
    //     i.e. stored ≈ 1 - ours.
    // So the row is -0.5·z + 0.5: near (-1) → 1, far (+1) → 0.
    //
    // The old matrix left z alone, believing it already arrived as reversed
    // [0,1]. Half of every track then fell below zero and took sunVisibility's
    // out-of-range early-out (fully lit, by accident), and the half above it
    // compared a [0, 0.19] value against a [0.5, 0.6] one and came back fully
    // shadowed. A FLAT track lands entirely on the lit side and looks correct
    // for free, which is why this survived: only a track that climbs straddles
    // zero, and then you get skysnake's hard-edged half-dark road.
    const mat4f lightViewProj{ cam->getProjectionMatrix() * cam->getViewMatrix() };
    const mat4f bias{ float4{ 0.5f, 0, 0, 0 }, float4{ 0, 0.5f, 0, 0 },
                      float4{ 0, 0, -0.5f, 0 }, float4{ 0.5f, 0.5f, 0.5f, 1 } };
    mShadowFromWorld = bias * lightViewProj;

    mEngine->destroy(view);
    mEngine->destroy(rt);
    mEngine->destroyCameraComponent(camEnt);
    utils::EntityManager::get().destroy(camEnt);
}

// The shared receiver instance, created on first use so the road (built before
// the bake) can already reference it; bindShadowMap fills it in afterwards.
MaterialInstance* TtpRenderer::litShadowInstance() {
    if (!mLitShadowInst && mLitMaterial) {
        mLitShadowInst = sceneInstance(mLitMaterial);
        mLitShadowInst->setParameter("shadowTexel", 0.0f);
    }
    return mLitShadowInst;
}

void TtpRenderer::bindShadowMap(MaterialInstance* mi) {
    if (!mi) return;
    // A sampler must be bound even when a track baked no map (Filament draws
    // with every sampler resolved), so keep the 1×1 white around for it.
    if (!mShadowMap && !mWhiteTex) {
        static const uint8_t WHITE[4] = { 255, 255, 255, 255 };
        mWhiteTex = Texture::Builder()
                .width(1).height(1).levels(1)
                .format(Texture::InternalFormat::SRGB8_A8)
                .sampler(Texture::Sampler::SAMPLER_2D)
                .build(*mEngine);
        if (mWhiteTex) {
            mWhiteTex->setImage(*mEngine, 0, Texture::PixelBufferDescriptor(
                    WHITE, sizeof(WHITE), Texture::Format::RGBA, Texture::Type::UBYTE));
        }
    }
    Texture* tex = mShadowMap ? mShadowMap : mWhiteTex;
    if (!tex) return;
    TextureSampler smp(TextureSampler::MinFilter::LINEAR, TextureSampler::MagFilter::LINEAR);
    smp.setWrapModeS(TextureSampler::WrapMode::CLAMP_TO_EDGE);
    smp.setWrapModeT(TextureSampler::WrapMode::CLAMP_TO_EDGE);
    mi->setParameter("shadowMap", tex, smp);
    mi->setParameter("shadowFromWorld", mShadowFromWorld);

    // Sampling step + the normal offset that keeps a curving deck from
    // shadowing itself (three refits the same guard to its texel size).
    mi->setParameter("shadowTexel", mShadowMap ? mShadowTexel : 0.0f);
    mi->setParameter("shadowK", kShadowEsmK);
    mi->setParameter("shadowDepthScale", mShadowDepthScale);
}

// Shadow opt-in. buildMesh and gltfio disagree on the default (mesh: neither,
// glTF: both), so every renderable that matters says so explicitly — see the
// caster/receiver note in buildTrackScene for who is in which set.
void TtpRenderer::setMeshShadows(Mesh& m, bool cast, bool receive) {
    if (m.entity.isNull()) return;
    setShadows(&m.entity, 1, cast, receive);
    if (!m.chunks.empty()) setShadows(m.chunks.data(), m.chunks.size(), cast, receive);
}

// Re-derive a mesh's bounds from its CPU vertices. Cheap (these pools are
// thousands of verts, not the road's hundred thousand) and the price of letting
// a mesh whose geometry moves every frame still be frustum-culled.
void TtpRenderer::refreshBounds(Mesh& m) {
    if (m.entity.isNull() || m.verts.empty()) return;
    auto& rcm = mEngine->getRenderableManager();
    const auto range = [&](utils::Entity e, size_t i0, size_t n) {
        const auto ri = rcm.getInstance(e);
        if (!ri) return;
        float3 lo{ 1e30f }, hi{ -1e30f };
        for (size_t k = i0; k < i0 + n && k < m.idx.size(); k++) {
            const Vertex& v = m.verts[m.idx[k]];
            lo = min(lo, float3{ v.px, v.py, v.pz });
            hi = max(hi, float3{ v.px, v.py, v.pz });
        }
        if (hi.x < lo.x) return;
        rcm.setAxisAlignedBoundingBox(ri,
                { (lo + hi) * 0.5f, max((hi - lo) * 0.5f, float3{ 1e-3f }) });
    };
    if (m.chunks.empty()) {
        // One renderable = every vertex belongs to it, so walk `verts` directly.
        // Going through `idx` visits each vertex once per triangle that uses it
        // — 840 scattered loads for the car blob's 165 points — and buys nothing
        // when there is no index range to respect. (Measured 15.6 µs vs 2.7 µs
        // per blob in wasm, and every conformDecal ends in one of these.)
        const auto ri = rcm.getInstance(m.entity);
        if (!ri) return;
        float3 lo{ 1e30f }, hi{ -1e30f };
        for (const Vertex& v : m.verts) {
            lo = min(lo, float3{ v.px, v.py, v.pz });
            hi = max(hi, float3{ v.px, v.py, v.pz });
        }
        if (hi.x < lo.x) return;
        rcm.setAxisAlignedBoundingBox(ri,
                { (lo + hi) * 0.5f, max((hi - lo) * 0.5f, float3{ 1e-3f }) });
    } else {
        const size_t per = m.idx.size() / (m.chunks.size() + 1);
        range(m.entity, 0, per);
        for (size_t c = 0; c < m.chunks.size(); c++) range(m.chunks[c], (c + 1) * per, per);
    }
}

void TtpRenderer::setMeshCulling(Mesh& m, bool enable) {
    if (m.entity.isNull()) return;
    auto& rcm = mEngine->getRenderableManager();
    const auto set = [&](utils::Entity e) {
        const auto ri = rcm.getInstance(e);
        if (ri) rcm.setCulling(ri, enable);
    };
    set(m.entity);
    for (utils::Entity e : m.chunks) set(e);
}

// Scene membership as the on/off switch, instead of a transform that parks the
// thing 1000 units underground.
//
// Parking is invisible but not free: an entity in the Scene pays a full
// FScene::prepare slot — a double-precision world transform, a frustum test, a
// UBO slot, a draw command and its place in the sort — and it pays it ONCE PER
// CELL. A 4-way split has ~126 permanently-parked renderables (the four car
// ghosts, the monster rigs and their ghosts, the banana/rocket/blob pools, the
// impact bursts, the boost streaks and discs), so that is ~500 prepare slots a
// frame spent on things nobody can see. FScene::prepare only walks SET bits, so
// removing an entity costs it exactly nothing.
//
// Both helpers are edge-triggered — the flag is the last state pushed, so a
// pool that stays parked for a whole race issues one remove and nothing else.
void TtpRenderer::setMeshInScene(Mesh& m, bool on) {
    if (m.entity.isNull() || m.inScene == on) return;
    m.inScene = on;
    if (on) {
        mScene->addEntity(m.entity);
        for (utils::Entity e : m.chunks) mScene->addEntity(e);
    } else {
        mScene->remove(m.entity);
        for (utils::Entity e : m.chunks) mScene->remove(e);
    }
}

void TtpRenderer::setInstanceInScene(gltfio::FilamentInstance* inst, uint8_t& state, bool on) {
    if (!inst || state == (on ? 1 : 0)) return;
    state = on ? 1 : 0;
    if (on) mScene->addEntities(inst->getEntities(), inst->getEntityCount());
    else mScene->removeEntities(inst->getEntities(), inst->getEntityCount());
}

void TtpRenderer::setAssetInScene(gltfio::FilamentAsset* asset, uint8_t& state, bool on) {
    if (!asset || state == (on ? 1 : 0)) return;
    state = on ? 1 : 0;
    if (on) mScene->addEntities(asset->getEntities(), asset->getEntityCount());
    else mScene->removeEntities(asset->getEntities(), asset->getEntityCount());
}

void TtpRenderer::setShadows(const utils::Entity* e, size_t n, bool cast, bool receive) {
    auto& rcm = mEngine->getRenderableManager();
    for (size_t i = 0; i < n; i++) {
        const auto ri = rcm.getInstance(e[i]);
        if (!ri) continue;
        // Layer bit 1 IS the caster set: it is what bakeShadowMap's view filters
        // on. Bit 0 (every renderable's default) stays set, so the main views
        // are unaffected. The engine's own flags follow along for the day
        // Filament's shadows come back for something dynamic.
        rcm.setLayerMask(ri, 0x02, cast ? 0x02 : 0x00);
        rcm.setCastShadows(ri, cast);
        rcm.setReceiveShadows(ri, receive);
    }
}

bool TtpRenderer::buildTrackScene(const std::vector<TtpRosterCar>& roster,
        const ttp::RaceTrack& geo, const ttp::rt::Theme& theme) {
    TrackBin tb;
    applyRoster(tb, roster);
    applyTheme(tb, theme);
    fillGeometry(tb, geo);
    tb.buildArclengthIndex(); // frameAt's bin lookup — see the comment there
    const uint32_t carCount = (uint32_t) tb.carColors.size();
    const std::vector<uint32_t>& carColors = tb.carColors;
    const float groundY = tb.groundY;

    if (!buildRoadMesh(tb)) return false;
    buildRoadGrid(); // ground-conform probe accelerator (see roadHitY)

    // Ground sheet at groundY with the lawn's mowing stripes as vertex-colour
    // bands (makeLawnTexture: 8 stripes per 33.3u tile, ×1.04 / ×0.965 on the
    // #6aa84f base; the fine grain is texture detail for later).
    {
        // Every ground kind is the same tiled-canvas idiom (textures.js): N
        // vertical bands of a per-kind luminance/hue wobble over a base colour,
        // 33.3u per tile. The speckle passes are sub-pixel at any race camera
        // distance, so only the banding (and the wood's board seams, which do
        // read) crosses over.
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
        // FLOOR itself is now the real texture: one quad, UVs in tiles, so the
        // wood's plank seams and end joints survive (bands can only vary in x).
        const float G = 400.0f, TILE = kGroundTile;
        const uint32_t white = packLinear(float3{ 1, 1, 1 }, 1.0f);
        mGround.verts.push_back({ -G, groundY, -G, white });
        mGround.verts.push_back({ G, groundY, -G, white });
        mGround.verts.push_back({ -G, groundY, G, white });
        mGround.verts.push_back({ G, groundY, G, white });
        mGround.uvs = { { -G / TILE, -G / TILE }, { G / TILE, -G / TILE },
                        { -G / TILE, G / TILE }, { G / TILE, G / TILE } };
        mGround.idx = { 0, 2, 1, 1, 2, 3 };
        mGround.normals.assign(mGround.verts.size(), float3{ 0, 1, 0 });
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
        appendSphere(mSky, 32, 16,
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
    mSun = utils::EntityManager::get().create();
    // No engine shadows: the map is baked once by bakeShadowMap and sampled by
    // the lit materials themselves. Leaving Filament's on would re-render the
    // same static depth pass per view per frame.
    LightManager::Builder(LightManager::Type::DIRECTIONAL)
            .color(srgbToLinear(tb.keyCol))
            .intensity(48000.0f * (tb.keyIntensity / 1.4f))
            .direction(normalize(float3{ -2.0f, -12.0f, -1.5f }))
            .castShadows(false)
            .build(*mEngine, mSun);
    mScene->addEntity(mSun);
    {
        const float3 skyC = srgbToLinear(tb.hemiSky);
        const float3 gndC = srgbToLinear(tb.hemiGround);
        // The y band stays at three's HemisphereLight weighting (E = (sky+gnd)/2
        // + (sky−gnd)/2·n.y). Scaling it down by the SH convolution ratio
        // (0.866) was tried on the theory that Filament over-weights it — it
        // made every biome worse, so the two evaluations already agree.
        const float3 sh[4] = { (skyC + gndC) * 0.5f, (skyC - gndC) * 0.5f,
                               { 0, 0, 0 }, { 0, 0, 0 } };
        mAmbient = IndirectLight::Builder()
                .irradiance(2, sh)
                .intensity(28000.0f * (tb.hemiIntensity / 2.2f))
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
        const auto glb = mAssets.find("car" + std::to_string(c) + ".glb");
        if (glb != mAssets.end() && loadCarAsset(c, glb->second)) continue;
        Mesh& m = mCars[c];
        const uint32_t col = carColors[c];
        const float HL = 0.62f, HW = 0.36f, Y0 = 0.06f, Y1 = 0.62f;
        for (const float y : { Y0, Y1 }) {
            m.verts.push_back({ -HW, y, -HL, col });
            m.verts.push_back({  HW, y, -HL, col });
            m.verts.push_back({ -HW, y,  HL, col });
            m.verts.push_back({  HW, y,  HL, col });
        }
        m.idx = { 0,1,2, 1,3,2,  4,6,5, 5,6,7,   // bottom, top
                  0,2,4, 2,6,4,  1,5,3, 3,5,7,   // sides
                  2,3,6, 3,7,6,  0,4,1, 1,4,5 }; // front, back
        if (!buildMesh(m)) return false;
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
    mBananaAsset = loadInstancedProp("item-banana.glb", 8, mBananaInstances);
    // Contact blobs for the FLOATING props (TrackProps' _boxShadow): a box's
    // real sun shadow lands raked off to one side, so a soft smudge is painted
    // on the deck directly beneath it as the position cue. makeBlobShadowTexture
    // falls off 1 → 0.82 at 0.55r → 0 at the rim, tinted 0x1c1a18 at 0.4.
    // Boxes are static (baked here); bananas and rockets carry a pooled blob
    // conformed per frame (scaled 0.7 and 0.95, as in the JS).
    if (mBlendMaterial) {
        const float3 SH = srgbToLinear(0x1c1a18);
        const uint32_t A0 = packLinear(SH, 1.0f, 0.4f);
        const uint32_t A1 = packLinear(SH, 1.0f, 0.4f * 0.82f);
        const uint32_t A2 = packLinear(SH, 1.0f, 0.0f);
        constexpr int SEG = 20;
        const auto ring = [&](Mesh& m, uint32_t base) {
            const uint32_t r0 = base + 1, r1 = r0 + SEG + 1;
            for (int j = 0; j < SEG; j++) {
                m.idx.insert(m.idx.end(), { base, r0 + (uint32_t) j, r0 + (uint32_t) j + 1 });
                m.idx.insert(m.idx.end(), { r0 + (uint32_t) j, r1 + (uint32_t) j, r1 + (uint32_t) j + 1,
                        r0 + (uint32_t) j, r1 + (uint32_t) j + 1, r0 + (uint32_t) j + 1 });
            }
        };
        for (const TrackBin::Box& b : tb.boxes) { // baked onto the deck
            constexpr float R = 0.3f;
            const auto at = [&](float rx, float rz) {
                const TrackBin::Sample f = tb.frameAt(b.s + rz);
                return f.pos + f.lat * (b.lat + rx) + f.up * 0.004f;
            };
            const uint32_t base = (uint32_t) mPropShadows.verts.size();
            const float3 c0 = at(0, 0);
            mPropShadows.verts.push_back({ c0.x, c0.y, c0.z, A0 });
            for (const float rr : { 0.55f, 1.0f }) {
                for (int j = 0; j <= SEG; j++) {
                    const float a = (float) j / SEG * 2.0f * (float) M_PI;
                    const float3 p = at(std::cos(a) * R * rr, std::sin(a) * R * rr);
                    mPropShadows.verts.push_back({ p.x, p.y, p.z, rr < 1.0f ? A1 : A2 });
                }
            }
            ring(mPropShadows, base);
        }
        // Each box owns an equal, contiguous slice of the baked mesh — that is
        // what lets the reconcile fade one box's blob out when it is collected.
        mBoxShadowStride = tb.boxes.empty() ? 0
                : (uint32_t) (mPropShadows.verts.size() / tb.boxes.size());
        mBoxShadowRest.clear();
        mBoxShadowRest.reserve(mPropShadows.verts.size());
        for (const Vertex& v : mPropShadows.verts) mBoxShadowRest.push_back(v.abgr);
        mBoxShadowFade.assign(tb.boxes.size(), 255);
        if (!mPropShadows.verts.empty()) {
            MaterialInstance* mi = sceneInstance(mBlendMaterial);
            mi->setPolygonOffset(-2.0f, -2.0f);
            buildMesh(mPropShadows, true, mi);
        }
        // Pooled unit blobs for the dynamic props (conformed + scaled per frame).
        mPropBlobs.resize(mBananaInstances.size() + 4);
        for (Mesh& m : mPropBlobs) {
            m.verts.push_back({ 0, 0, 0, A0 });
            m.local.push_back({ 0, 0, (uint8_t) std::lround(0.4f * 255.0f) });
            for (const float rr : { 0.55f, 1.0f }) {
                for (int j = 0; j <= SEG; j++) {
                    const float a = (float) j / SEG * 2.0f * (float) M_PI;
                    const float x = std::cos(a) * rr, z = std::sin(a) * rr;
                    m.verts.push_back({ x, 0, z, rr < 1.0f ? A1 : A2 });
                    m.local.push_back({ x, z, (uint8_t) (rr < 1.0f
                            ? std::lround(0.4f * 0.82f * 255.0f) : 0) });
                }
            }
            ring(m, 0);
            MaterialInstance* mi = sceneInstance(mBlendMaterial);
            mi->setPolygonOffset(-2.0f, -2.0f);
            if (!buildMesh(m, true, mi)) return false;
            auto& tcmB = mEngine->getTransformManager();
            tcmB.setTransform(tcmB.getInstance(m.entity),
                    mat4f::translation(float3{ 0, -1000, 0 }));
        }
    }
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
                mMonsterSilhouette = bakeSilhouette(mMonsterInstances[0]->getEntities(),
                        mMonsterInstances[0]->getEntityCount(), mbb.min, mbb.max);
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
    buildPadsMesh(tb);
    buildWater(tb);
    buildFliers(tb);
    buildOils(tb);
    buildStructures(tb);
    buildScenery(tb);
    buildLandmarks(tb);
    buildClutter(tb);

    // Skid pool — SkidMarks.js port. SKID_POOL 4-column stamps (rear L/l/r/R,
    // front L/l/r/R): the two INNER columns carry the full alpha and the outer
    // pair sits SKID_FEATHER out at zero, so the rubber reads as one even band
    // with a soft edge. (It was 3 columns reproducing the JS texture's 0→1→0
    // linear gradient across the whole width — which painted a dark centre line
    // with the tyre's edges fading to nothing, nothing like a tyre print.)
    // Colour SKID_COLOR 0x241f1c; per-slot life/peak drive the SKID_LIFE fade
    // down to the SKID_PATINA floor.
    if (mBlendMaterial) {
        constexpr uint32_t SKID_POOL = 4096;
        const uint32_t ink0 = packLinear(srgbToLinear(0x241f1c), 1.0f, 0.0f);
        mSkids.verts.assign(SKID_POOL * 8, { 0, -1000, 0, ink0 });
        mSkids.idx.resize(SKID_POOL * 18);
        for (uint32_t q = 0; q < SKID_POOL; q++) {
            const uint32_t b = q * 8;      // rear b..b+3, front b+4..b+7 (L→R)
            uint32_t* dst = &mSkids.idx[(size_t) q * 18];
            for (uint32_t k = 0; k < 3; k++) { // one quad per column pair
                const uint32_t r = b + k, f = b + 4 + k;
                const uint32_t src[6] = { r, f + 1, r + 1, r, f, f + 1 };
                std::copy(src, src + 6, dst + k * 6);
            }
        }
        MaterialInstance* mi = sceneInstance(mBlendMaterial);
        mi->setPolygonOffset(-2.0f, -2.0f); // JS decal pull: never z-fight the road
        // Chunked, because the pool is drawn whether or not it holds anything:
        // 4096 slots is 24k triangles submitted in EVERY cell, every frame, and
        // a fresh track has none of them alive. Chunks that hold only parked
        // slots (y = -1000) fall outside every frustum and cull away; the ones
        // that hold real marks are a stretch of track, so a cell only pays for
        // the rubber it can actually see. refreshBounds re-fits them per frame.
        buildMesh(mSkids, true, mi, 2, 1536);
        mWheelTrails.assign(carCount * 4, {});
        mSkidLife.assign(SKID_POOL, 0.0f);
        mSkidPeak.assign(SKID_POOL, 0.0f);
        mSkidOwner.assign(SKID_POOL, -1);
        mSkidCursor = 0;
    }

    // Ambient particles (theme.ambient): the first `count` of buildAmbient's
    // 74747 stream as tiny tinted sprites, drifted per frame by the kind's
    // motion preset (flake / mote / sand / pollen — all resolved into the
    // theme, ttp::rt::ambientKind).
    if (mPointMaterial && tb.ambKind != 0 && tb.ambCount > 0) {
        const int AMB_COUNT = (int) std::min(tb.ambCount, 2400u);
        constexpr float AMB_R = 170.0f, AMB_H = 34.0f;
        // Half the JS Points sprite size — the material pushes each corner out
        // by this along the camera axes, so the quad spans the full `size`.
        mAmbSize = tb.ambSize * 0.5f;
        mAmbFall = tb.ambFall;
        mAmbWind = tb.ambWind;
        mAmbBob = tb.ambBob;
        mAmbBandH = std::max(2.0f, AMB_H * tb.ambBand);
        uint32_t s74 = 74747;
        const auto arnd = [&]() {
            s74 = s74 * 1664525u + 1013904223u;
            return (double) s74 / 4294967296.0;
        };
        mAmbBase.resize(AMB_COUNT);
        mAmbSpeed.resize(AMB_COUNT);
        for (int i = 0; i < AMB_COUNT; i++) {
            const float a = (float) arnd() * 2.0f * (float) M_PI;
            const float r = std::sqrt((float) arnd()) * AMB_R;
            mAmbBase[i] = { std::cos(a) * r, (float) arnd() * AMB_H, std::sin(a) * r };
            mAmbSpeed[i] = 1.1f + (float) arnd() * 1.4f;
        }
        const uint32_t tint = packLinear(srgbToLinear(tb.ambTint), 1.0f, tb.ambOpacity);
        // Four vertices per particle, all carrying the SAME world centre: the
        // corner in uv0 is what vpoint.mat spreads along the camera's right/up,
        // so the sprite faces every cell's camera and comes out round.
        mPollen.verts.resize(AMB_COUNT * 4, { 0, -1000, 0, tint });
        mPollen.uvs.resize(AMB_COUNT * 4);
        mPollen.idx.resize(AMB_COUNT * 6);
        static const math::float2 CORNER[4] = { { -1, -1 }, { 1, -1 }, { 1, 1 }, { -1, 1 } };
        static const uint32_t QUAD[6] = { 0, 1, 2, 0, 2, 3 };
        for (int i = 0; i < AMB_COUNT; i++) {
            for (int k = 0; k < 4; k++) mPollen.uvs[i * 4 + k] = CORNER[k];
            for (int k = 0; k < 6; k++) mPollen.idx[i * 6 + k] = i * 4 + QUAD[k];
        }
        mPollenMat = sceneInstance(mPointMaterial);
        mPollenMat->setParameter("halfSize", mAmbSize); // re-fitted per frame, below
        if (!buildMesh(mPollen, true, mPollenMat)) return false;
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
            const float3 ctr = { s.x + ox, groundY + 0.02f, s.y + oz };
            const float r = s.z;
            const uint32_t base = (uint32_t) mGroundShadows.verts.size();
            mGroundShadows.verts.push_back({ ctr.x, ctr.y, ctr.z, core });
            const int SEG = 14;
            for (int j = 0; j <= SEG; j++) {
                const float a = (float) j / SEG * 2.0f * (float) M_PI;
                mGroundShadows.verts.push_back({ ctr.x + std::cos(a) * r, ctr.y,
                        ctr.z + std::sin(a) * r, rim });
            }
            for (int j = 0; j < SEG; j++) {
                mGroundShadows.idx.insert(mGroundShadows.idx.end(),
                        { base, base + 1 + (uint32_t) j, base + 2 + (uint32_t) j });
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
                // The mouth sits at the tail of the body and the cone runs back
                // (-Y) from there.
                constexpr float FR = 0.062f, FH = 0.200f, FY0 = -0.165f;
                const uint32_t fc = packLinear(srgbToLinear(0xffd23f), 1.0f, 0.88f);
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

    // Per-car ground blobs (the frozen sun never sees cars — they carry a
    // contact shadow instead, the JS renderer's `ao` plane). The JS shadow is
    // a BAKED top-down car silhouette with a ~2% blur, tinted UNDER_AO_COLOR
    // 0x171513, on a footprint × SHADOW_OVERSCAN 1.45 quad so the feather lands
    // beyond the wheels.
    //
    // The OPACITY is the one thing here that is not the JS's. Blocking the sun
    // leaves a surface its ambient, which on these rigs is about 65% of lit —
    // so a real cast shadow is a 35% dip, and painting one wants roughly that
    // opacity. The JS's UNDER_AO_OPACITY 0.55 was a 56% dip, picked when cast
    // shadows were a vague haze; against a sharp one the car looked pressed
    // into a hole. 0.35 is measured against the deck (34% dip on skysnake) and
    // is close enough on every biome — the rigs only span 32% to 36%. It also
    // puts the car back between its siblings, the prop blobs at 0.40 and the
    // lawn discs at 0.30.
    //
    // It's a GRID, like the JS's (which is why a shadow can hug a bending deck
    // at all): the conform lands each vertex on the road and the quads between
    // them are chords, so a fan spanning half the car cut straight through a
    // crest. The silhouette is a rounded-rect falloff evaluated per vertex.
    if (mBlendMaterial) {
        mCarBlobs.resize(carCount);
        mCarBlobMats.assign(carCount, nullptr);
        mCarBlobMasks.assign(carCount, nullptr);
        const float3 INKC = srgbToLinear(0x171513);
        constexpr float AO = 0.35f;                   // see the note above
        for (uint32_t c = 0; c < carCount; c++) {
            Mesh& m = mCarBlobs[c];
            const float fw = (mCarWheels.size() > c) ? mCarWheels[c].footW : 0.95f;
            const float fl = (mCarWheels.size() > c) ? mCarWheels[c].footL : 2.0f;
            const float W = fw * 1.45f, L = fl * 1.45f;   // SHADOW_OVERSCAN quad
            // The SHAPE now lives in a texture (buildShadowMask), because the JS
            // silhouette's penumbra is three pixels of a 128-wide bake — about
            // 5% of the half-width — and a falloff evaluated on a 10×14 grid
            // can't hold an edge that tight. It just made the blob vague. The
            // grid stays: it exists so the sheet can CONFORM to a curving deck.
            constexpr int GW = 10, GL = 14;               // grid segments
            for (int j = 0; j <= GL; j++) {
                for (int i = 0; i <= GW; i++) {
                    const float x = ((float) i / GW - 0.5f) * W;
                    const float z = ((float) j / GL - 0.5f) * L;
                    m.verts.push_back({ x, 0.02f, z, packLinear(INKC, 1.0f, AO) });
                    m.uvs.push_back({ (float) i / GW, (float) j / GL });
                    m.local.push_back({ x, z, (uint8_t) std::lround(AO * 255.0f) });
                }
            }
            for (int j = 0; j < GL; j++) {
                for (int i = 0; i < GW; i++) {
                    const uint32_t b = (uint32_t) (j * (GW + 1) + i);
                    const uint32_t n = b + (uint32_t) (GW + 1);
                    m.idx.insert(m.idx.end(), { b, n, b + 1, b + 1, n, n + 1 });
                }
            }
            MaterialInstance* mi = mDecalMaterial ? sceneInstance(mDecalMaterial)
                                                  : sceneInstance(mBlendMaterial);
            mi->setPolygonOffset(-2.0f, -2.0f); // never z-fight the deck it hugs
            if (mDecalMaterial) {
                // The car's own outline when we could bake it; the generic
                // rounded-rect only when a car has no GLB (box marker).
                Texture* mask = (mCarSilhouettes.size() > c) ? mCarSilhouettes[c] : nullptr;
                bool baked = mask != nullptr;
                if (!mask) {
                    if (!mShadowMaskTex) mShadowMaskTex = buildShadowMask();
                    mask = mShadowMaskTex;
                }
                if (mask) {
                    setBlobMask(mi, mask, baked);
                    mCarBlobMasks[c] = mask;
                }
                mCarBlobMats[c] = mi; // the monster swaps this mask per frame
            } else {
                m.uvs.clear(); // vblend has no uv0 attribute
            }
            if (!buildMesh(m, true, mi, 3)) return false;
        }
        // Rear name plates (makePlate): a livery rounded-rect sticker with a
        // white feathered rim and the player's name, fixed to the car's rear
        // — the chase cam reads the plate of whoever it's chasing. The face is
        // a pixel font (the JS sets Fredoka); it's MIXED CASE like the roster,
        // since a shouty all-caps "MIA" was the loudest difference on the plate.
        mPlates.resize(carCount);
        // 5 wide × 9 rows (bit 4 = leftmost column): rows 0–6 are the cap band
        // (uppercase fills it), lowercase sits on rows 2–6 with ascenders up to
        // row 0 and descenders on rows 7–8.
        static const uint8_t PL[26][9] = {
            { 0,0, 0x0E,0x01,0x0F,0x11,0x0F, 0,0 },              // a
            { 0x10,0x10, 0x1E,0x11,0x11,0x11,0x1E, 0,0 },        // b
            { 0,0, 0x0E,0x11,0x10,0x11,0x0E, 0,0 },              // c
            { 0x01,0x01, 0x0F,0x11,0x11,0x11,0x0F, 0,0 },        // d
            { 0,0, 0x0E,0x11,0x1F,0x10,0x0E, 0,0 },              // e
            { 0x06,0x09, 0x08,0x1C,0x08,0x08,0x08, 0,0 },        // f
            { 0,0, 0x0F,0x11,0x11,0x0F,0x01, 0x01,0x0E },        // g
            { 0x10,0x10, 0x1E,0x11,0x11,0x11,0x11, 0,0 },        // h
            { 0x04,0x00, 0x0C,0x04,0x04,0x04,0x0E, 0,0 },        // i
            { 0x02,0x00, 0x06,0x02,0x02,0x02,0x02, 0x12,0x0C },  // j
            { 0x10,0x10, 0x12,0x14,0x18,0x14,0x12, 0,0 },        // k
            { 0x0C,0x04, 0x04,0x04,0x04,0x04,0x0E, 0,0 },        // l
            { 0,0, 0x1A,0x15,0x15,0x15,0x15, 0,0 },              // m
            { 0,0, 0x1E,0x11,0x11,0x11,0x11, 0,0 },              // n
            { 0,0, 0x0E,0x11,0x11,0x11,0x0E, 0,0 },              // o
            { 0,0, 0x1E,0x11,0x11,0x1E,0x10, 0x10,0x10 },        // p
            { 0,0, 0x0F,0x11,0x11,0x0F,0x01, 0x01,0x01 },        // q
            { 0,0, 0x16,0x19,0x10,0x10,0x10, 0,0 },              // r
            { 0,0, 0x0F,0x10,0x0E,0x01,0x1E, 0,0 },              // s
            { 0x08,0x08, 0x1C,0x08,0x08,0x09,0x06, 0,0 },        // t
            { 0,0, 0x11,0x11,0x11,0x13,0x0D, 0,0 },              // u
            { 0,0, 0x11,0x11,0x11,0x0A,0x04, 0,0 },              // v
            { 0,0, 0x11,0x11,0x15,0x15,0x0A, 0,0 },              // w
            { 0,0, 0x11,0x0A,0x04,0x0A,0x11, 0,0 },              // x
            { 0,0, 0x11,0x11,0x11,0x0F,0x01, 0x01,0x0E },        // y
            { 0,0, 0x1F,0x02,0x04,0x08,0x1F, 0,0 },              // z
        };
        static const uint8_t PF[26][7] = {
            { 0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11 },  // A
            { 0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E },  // B
            { 0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E },  // C
            { 0x1E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1E },  // D
            { 0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F },  // E
            { 0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10 },  // F
            { 0x0E, 0x11, 0x10, 0x13, 0x11, 0x11, 0x0F },  // G
            { 0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11 },  // H
            { 0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E },  // I
            { 0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C },  // J
            { 0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11 },  // K
            { 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F },  // L
            { 0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11 },  // M
            { 0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11 },  // N
            { 0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E },  // O
            { 0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10 },  // P
            { 0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D },  // Q
            { 0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11 },  // R
            { 0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E },  // S
            { 0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04 },  // T
            { 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E },  // U
            { 0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04 },  // V
            { 0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0A },  // W
            { 0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11 },  // X
            { 0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04 },  // Y
            { 0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F },  // Z
        };
        for (uint32_t c = 0; c < carCount; c++) {
            if (mCarAssets.size() <= c || !mCarAssets[c] || mCarWheels.size() <= c) continue;
            Mesh& m = mPlates[c];
            const CarWheels& cw = mCarWheels[c];
            const std::string name = (tb.carNames.size() > c) ? tb.carNames[c] : "";
            // ABGR roster colour → sRGB rgb
            const uint32_t abgr = (tb.carColors.size() > c) ? tb.carColors[c] : 0xff888888u;
            const uint32_t rgb = ((abgr & 0xff) << 16) | (abgr & 0xff00) | ((abgr >> 16) & 0xff);
            const float3 livery = srgbToLinear(rgb);
            const float3 white = { 1, 1, 1 };
            // visible plate: capped to the car's rear, JS 232:92 aspect
            const float W = std::min(0.2f, cw.footW * 0.92f);
            const float H = W * (92.0f / 232.0f);
            // Hand-tuned rear-panel height for this model when the payload
            // carries one (SceneRenderer's PLATE_Y), else the old fraction.
            const float authored = (tb.carPlateY.size() > c) ? tb.carPlateY[c] : -1.0f;
            const float cy = authored >= 0 ? authored
                    : cw.bbMin.y + 0.46f * (cw.bbMax.y - cw.bbMin.y);
            const float cz = cw.bbMax.z + 0.008f;
            // rounded-rect layer (plate local: x MIRRORED so the face reads
            // correctly from BEHIND the car — the chase cam looks along −z)
            const auto roundRect = [&](float hw, float hh, float r, float z,
                    const float3& col) {
                const uint32_t cc = packLinear(col, 1.0f);
                std::vector<float2> ring;
                const float qx[4] = { hw - r, -(hw - r), -(hw - r), hw - r };
                const float qy[4] = { hh - r, hh - r, -(hh - r), -(hh - r) };
                const float a0[4] = { 0, (float) M_PI / 2, (float) M_PI, 3 * (float) M_PI / 2 };
                for (int k = 0; k < 4; k++) {
                    for (int j = 0; j <= 3; j++) {
                        const float a = a0[k] + (float) j / 3 * (float) M_PI / 2;
                        ring.push_back({ qx[k] + std::cos(a) * r, qy[k] + std::sin(a) * r });
                    }
                }
                const uint32_t base = (uint32_t) m.verts.size();
                m.verts.push_back({ 0, cy, cz + z, cc });
                for (const float2& q : ring) {
                    m.verts.push_back({ -q.x, cy + q.y, cz + z, cc });
                }
                const uint32_t NR = (uint32_t) ring.size();
                for (uint32_t j = 0; j < NR; j++) {
                    m.idx.insert(m.idx.end(),
                            { base, base + 1 + j, base + 1 + (j + 1) % NR });
                }
            };
            const float pad = W * (6.0f / 232.0f), rr = W * (16.0f / 232.0f);
            roundRect(W / 2, H / 2, rr, 0, white);
            roundRect(W / 2 - pad, H / 2 - pad, rr * 0.75f, 0.0015f, livery);
            // name — white pixel glyphs, auto-fit to the field width. The cap
            // band is 42% of the plate height, matching the JS's 54px Fredoka
            // on its 92px plate (the old 50% ran visibly large).
            if (!name.empty()) {
                const uint32_t nc = packLinear(white, 1.0f);
                const float maxW = W - 2 * pad - W * (24.0f / 232.0f);
                float px = (0.42f * H) / 7.0f;
                const float tw = (float) (name.size() * 6 - 1);
                if (tw * px > maxW) px = maxW / tw;
                // The pose's half-turn maps asset-local +x to the viewer's
                // RIGHT, so the first glyph starts at −x — laying it out from
                // +x downward printed the name mirrored.
                const float x0 = -tw * px / 2;
                const float y0 = cy - 3.5f * px;
                for (size_t ci2 = 0; ci2 < name.size(); ci2++) {
                    const char ch = name[ci2];
                    const uint8_t* g = nullptr;
                    uint8_t rows = 7;
                    if (ch >= 'A' && ch <= 'Z') g = PF[ch - 'A'];
                    else if (ch >= 'a' && ch <= 'z') { g = PL[ch - 'a']; rows = 9; }
                    if (!g) continue;
                    for (int row = 0; row < rows; row++) {
                        for (int cx = 0; cx < 5; cx++) {
                            if (!((g[row] >> (4 - cx)) & 1)) continue;
                            const float gx = x0 + ((float) (ci2 * 6 + cx)) * px;
                            const float gy = y0 + (float) (6 - row) * px;
                            const uint32_t b = (uint32_t) m.verts.size();
                            m.verts.push_back({ gx, gy, cz + 0.003f, nc });
                            m.verts.push_back({ gx + px, gy, cz + 0.003f, nc });
                            m.verts.push_back({ gx, gy + px, cz + 0.003f, nc });
                            m.verts.push_back({ gx + px, gy + px, cz + 0.003f, nc });
                            m.idx.insert(m.idx.end(),
                                    { b, b + 1, b + 2, b + 1, b + 3, b + 2 });
                        }
                    }
                }
            }
            if (!buildMesh(m)) return false;
            auto& tcmP = mEngine->getTransformManager();
            tcmP.setTransform(tcmP.getInstance(m.entity),
                    mat4f::translation(float3{ 0, -1000, 0 }));
        }
        // Boost aura: the teal pool under a boosting car (SceneRenderer's
        // boostDisk). Colour = boostShades.disk (accent +15%), profile =
        // makeBoostDiskTexture's falloff — SOLID to 0.72 of the radius (alpha
        // 1 → 0.94) then a linear feather to 0 at the rim, which the two
        // concentric rings reproduce exactly. Unit radius; conformed onto the
        // road per frame (a flat disc clipped through every bend).
        mBoostDisks.resize(carCount);
        const float3 TEALC = srgbToLinear(ttp::rt::boost_shades(tb.boostCol).disk);
        for (uint32_t c = 0; c < carCount; c++) {
            Mesh& m = mBoostDisks[c];
            const int SEG = 16; // BOOST_DISK_SEG
            const auto ringVert = [&](float rad, float alpha) {
                const uint32_t col = packLinear(TEALC, 1.0f, alpha);
                const uint8_t a8 = (uint8_t) std::lround(alpha * 255.0f);
                for (int j = 0; j <= SEG; j++) {
                    const float ang = (float) j / SEG * 2.0f * (float) M_PI;
                    const float x = std::cos(ang) * rad, z = std::sin(ang) * rad;
                    m.verts.push_back({ x, 0, z, col });
                    m.local.push_back({ x, z, a8 });
                }
            };
            m.verts.push_back({ 0, 0, 0, packLinear(TEALC, 1.0f, 1.0f) });
            m.local.push_back({ 0, 0, 255 });
            ringVert(0.72f, 0.94f);
            ringVert(1.0f, 0.0f);
            const uint32_t ring0 = 1, ring1 = ring0 + SEG + 1;
            for (int j = 0; j < SEG; j++) {
                const uint32_t i1 = ring0 + (uint32_t) j, i2 = i1 + 1;
                const uint32_t o1 = ring1 + (uint32_t) j, o2 = o1 + 1;
                m.idx.insert(m.idx.end(), { 0, i1, i2 });
                m.idx.insert(m.idx.end(), { i1, o1, o2, i1, o2, i2 });
            }
            MaterialInstance* mi = sceneInstance(mBlendMaterial);
            mi->setPolygonOffset(-2.0f, -2.0f); // conformed, but never z-fight
            if (!buildMesh(m, true, mi, 5)) return false;
        }
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
    setMeshShadows(mGround, true, true);
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
                     &mClutter, &mPropShadows, &mPads, &mOils, &mWater, &mWet,
                     &mBalloon, &mWindmill, &mTrain, &mTrainKey }) {
        setMeshCulling(*m, true);
    }

    // The sun's map, rendered once now that every caster exists, and handed to
    // the materials that sample it.
    bakeShadowMap(tb);
    bindShadowMap(litShadowInstance());
    // ...and the ground, so an elevated deck lays its shape on the floor below.
    if (mGroundInst) bindShadowMap(mGroundInst);
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
    if (mBlendMaterial) {
        // theme.clouds dresses the same 8 sprites: `count` hides the tail,
        // scale/aspect restretch the authored width, opacity + tint repaint.
        const int nClouds = (int) std::min<uint32_t>(8, tb.cloudCount);
        mClouds.resize(nClouds);
        mCloudPos.resize(nClouds);
        // makeCloudTexture: five discs at 0.95 alpha, EACH blurred by 5px and
        // composited source-over into ONE 128×64 texture, then drawn at the
        // sprite's 0.8 opacity. That compositing order matters — five separate
        // translucent fans stack to a different (much harder) alpha in the
        // overlaps, which is why the puffs read as flat white blobs. Bake the
        // composited coverage into a grid instead: one soft, genuinely blurry
        // quad per cloud. The alpha field is shape-only, so it's computed once
        // and shared by all eight.
        static const float LOBES[5][3] = {
            { 36, 36, 14 }, { 58, 30, 17 }, { 84, 36, 14 },
            { 68, 42, 11 }, { 46, 42, 10 },
        };
        constexpr int NX = 32, NY = 16;
        std::vector<uint8_t> alpha((NX + 1) * (NY + 1));
        {
            const BlurKernel blur(5.0f);
            for (int j = 0; j <= NY; j++) {
                for (int i = 0; i <= NX; i++) {
                    const float cx = (float) i / NX * 128.0f, cy = (float) j / NY * 64.0f;
                    float clear = 1.0f; // ∏(1 − aᵢ): source-over compositing
                    for (const auto& lb : LOBES) {
                        const float lx = lb[0], ly = lb[1], lr = lb[2];
                        const float cov = blur.coverage(cx, cy,
                                [&](float x, float y) {
                                    const float dx = x - lx, dy = y - ly;
                                    return dx * dx + dy * dy <= lr * lr;
                                });
                        clear *= (1.0f - 0.95f * cov);
                    }
                    alpha[j * (NX + 1) + i] = (uint8_t) std::lround(
                            255.0f * (1.0f - clear)); // shape only; opacity per sprite
                }
            }
        }
        const float3 cloudTint = srgbToLinear(tb.cloudTint);
        for (int i = 0; i < nClouds; i++) {
            const float a = (float) i / 8 * 2.0f * (float) M_PI + (i % 3) * 0.45f;
            const float r = 180 + (i % 4) * 38;
            const float w = 50 + (i % 3) * 20;
            mCloudPos[i] = { std::cos(a) * r, 42.0f + (i % 3) * 16,
                             std::sin(a) * r };
            Mesh& m = mClouds[i];
            // Sprite quad, billboarded per view in render(). Geometry at
            // AUTHORED size — the per-frame push-out scales the transform
            // (softened, k^0.55: cameras sit far from the origin, so full-k
            // clouds loom oversized). DEF_CLOUDS aspect is 0.42.
            const float sw = w * tb.cloudScale, sh = sw * tb.cloudAspect;
            for (int j = 0; j <= NY; j++) {
                for (int k = 0; k <= NX; k++) {
                    const float x = ((float) k / NX - 0.5f) * sw;
                    const float y = (0.5f - (float) j / NY) * sh;
                    m.verts.push_back({ x, y, 0,
                            packLinear(cloudTint, 1.0f,
                                    alpha[j * (NX + 1) + k] / 255.0f * tb.cloudOpacity) });
                }
            }
            for (int j = 0; j < NY; j++) {
                for (int k = 0; k < NX; k++) {
                    const uint32_t b = (uint32_t) (j * (NX + 1) + k);
                    const uint32_t n = b + (uint32_t) (NX + 1);
                    m.idx.insert(m.idx.end(), { b, n, b + 1, b + 1, n, n + 1 });
                }
            }
            if (!buildMesh(m, true, mBlendMaterial->getDefaultInstance())) return false;
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
            Mesh& m = mHaze[i];
            const float sw = (95.0f + (i % 3) * 28) * tb.hazeScale;
            const float sh = sw * 0.14f; // HAZE_ASPECT — banks, not puffs
            for (int j = 0; j <= NY; j++) {
                for (int k = 0; k <= NX; k++) {
                    const float x = ((float) k / NX - 0.5f) * sw;
                    const float y = (0.5f - (float) j / NY) * sh;
                    m.verts.push_back({ x, y, 0,
                            packLinear(hazeTint, 1.0f,
                                    alpha[j * (NX + 1) + k] / 255.0f * tb.hazeOpacity) });
                }
            }
            for (int j = 0; j < NY; j++) {
                for (int k = 0; k < NX; k++) {
                    const uint32_t b = (uint32_t) (j * (NX + 1) + k);
                    const uint32_t n = b + (uint32_t) (NX + 1);
                    m.idx.insert(m.idx.end(), { b, n, b + 1, b + 1, n, n + 1 });
                }
            }
            if (!buildMesh(m, true, mBlendMaterial->getDefaultInstance(), 5)) return false;
        }
    }

    // Ghost body variants (50%-alpha patched GLBs) for the monster occlusion
    // fade — loaded LAST, with a full decode pump after each: interleaving
    // them with the solid cars doubled the in-flight decode queue and dropped
    // a car's colormap (it rendered gray). Parked until a swap needs them.
    for (uint32_t c = 0; c < carCount; c++) {
        if (!mCarAssets[c]) continue;
        const auto ghost = mAssets.find("car" + std::to_string(c) + "-ghost.glb");
        if (ghost == mAssets.end()) continue;
        gltfio::FilamentAsset* ga = mAssetLoader->createAsset(
                ghost->second.data(), (uint32_t) ghost->second.size());
        if (!ga) continue;
        registerAssetUris(ga);
        if (!mResourceLoader->loadResources(ga)) {
            mAssetLoader->destroyAsset(ga);
            continue;
        }
        ga->releaseSourceData();
        mScene->addEntities(ga->getEntities(), ga->getEntityCount());
        setShadows(ga->getEntities(), ga->getEntityCount(), false, false);
        auto& tcmG = mEngine->getTransformManager();
        tcmG.setTransform(tcmG.getInstance(ga->getRoot()),
                mat4f::translation(float3{ 0, -1000, 0 }));
        // The ghost body is only ever shown as the GRAFTED monster body, and
        // MonsterRig strips the car's wheels before seating it — collapse them
        // once here (this instance's wheels are never animated).
        for (const char* wn : { "wheel-fl", "wheel-fr", "wheel-bl", "wheel-br", "axle" }) {
            const utils::Entity we = ga->getFirstEntityByName(wn);
            if (we.isNull()) continue;
            const auto wi = tcmG.getInstance(we);
            mat4f local = mat4f::scaling(float3{ 1e-4f });
            local[3] = tcmG.getTransform(wi)[3];
            tcmG.setTransform(wi, local);
        }
        mCarGhostAssets[c] = ga;
        if (mStbProvider) {
            mStbProvider->waitForCompletion();
            mResourceLoader->asyncUpdateLoad();
        }
    }

    // Texture decodes ride the provider's async queue even on the synchronous
    // loadResources path — finished textures only ATTACH on a queue pump (the
    // sync path pumps at the START of the next load, so without this the last
    // assets' textures never bind and those cars render black).
    if (mStbProvider) {
        mStbProvider->waitForCompletion();
        mResourceLoader->asyncUpdateLoad();
    }
    mTrack = std::make_unique<TrackBin>(std::move(tb));
    return true;
}

void TtpRenderer::ensureAssetLoader() {
    if (mAssetLoader) return;
    mMatProvider = gltfio::createUbershaderProvider(mEngine,
            UBERARCHIVE_DEFAULT_DATA, UBERARCHIVE_DEFAULT_SIZE);
    gltfio::AssetConfiguration ac{};
    ac.engine = mEngine;
    ac.materials = mMatProvider;
    // Node names, which gltfio only records when handed a manager. Without
    // one getName() is nullptr everywhere and every name-driven rule below
    // (chassis recolour, monster wheels, the "skip the wheels" graft-seat
    // measurement) no-ops without a word.
    mNames = new utils::NameComponentManager(utils::EntityManager::get());
    ac.names = mNames;
    mAssetLoader = gltfio::AssetLoader::create(ac);
    gltfio::ResourceConfiguration rc{};
    rc.engine = mEngine;
    rc.gltfPath = nullptr;
    rc.normalizeSkinningWeights = true;
    mResourceLoader = new gltfio::ResourceLoader(rc);
    mStbProvider = gltfio::createStbProvider(mEngine);
    mResourceLoader->addTextureProvider("image/png", mStbProvider);
    mResourceLoader->addTextureProvider("image/jpeg", mStbProvider);
}

// The kit GLBs reference their texture by EXTERNAL uri (Textures/colormap.png)
// — the shell provides those bytes under that exact name; register them so
// loadResources finds them (no filesystem here). mAssets outlives the loader,
// so the descriptors carry no release callback.
void TtpRenderer::registerAssetUris(filament::gltfio::FilamentAsset* asset) {
    const char* const* uris = asset->getResourceUris();
    for (size_t u = 0; u < asset->getResourceUriCount(); u++) {
        const auto res = mAssets.find(uris[u]);
        if (res != mAssets.end()) {
            mResourceLoader->addResourceData(uris[u],
                    gltfio::ResourceLoader::BufferDescriptor(
                            res->second.data(), res->second.size(), nullptr));
        }
    }
}

bool TtpRenderer::loadCarAsset(uint32_t index, const std::vector<uint8_t>& glb) {
    ensureAssetLoader();
    gltfio::FilamentAsset* asset =
            mAssetLoader->createAsset(glb.data(), (uint32_t) glb.size());
    if (!asset) return false;
    registerAssetUris(asset);
    if (!mResourceLoader->loadResources(asset)) {
        mAssetLoader->destroyAsset(asset);
        return false;
    }
    asset->releaseSourceData();
    mScene->addEntities(asset->getEntities(), asset->getEntityCount());
    // Cars neither cast nor catch the sun shadow (they carry a ground blob) —
    // gltfio opts renderables in by default, the JS opts them out.
    setShadows(asset->getEntities(), asset->getEntityCount(), false, false);
    mCarAssets[index] = asset;

    // Wheel handles for the per-frame steer/roll cosmetics. Original local
    // translations are kept so the animation rotates each wheel IN PLACE.
    if (mCarWheels.size() <= index) mCarWheels.resize(index + 1);
    CarWheels& w = mCarWheels[index];
    auto& tcm = mEngine->getTransformManager();
    const auto grab = [&](const char* name, utils::Entity& e, float3& t) {
        e = asset->getFirstEntityByName(name);
        if (!e.isNull()) {
            const mat4f local = tcm.getTransform(tcm.getInstance(e));
            t = local[3].xyz;
        }
    };
    grab("wheel-fl", w.fl, w.flT);
    grab("wheel-fr", w.fr, w.frT);
    grab("wheel-bl", w.bl, w.blT);
    grab("wheel-br", w.br, w.brT);
    grab("axle", w.axle, w.axleT);
    // Roll/pitch axis sign, measured exactly as addCar does: the node's local
    // +X in the POSED frame (the kit models face −Z, so the pose's half-turn
    // flips it). Positive rotation about the POSED +X rolls the wheel forward
    // and noses the body down — apply the raw angle about the model-local axis
    // and both run BACKWARDS (the wheels visibly span the wrong way).
    if (!w.bl.isNull()) {
        const mat4f local = tcm.getTransform(tcm.getInstance(w.bl));
        const float3 axis = (mat4f::rotation(M_PI, float3{ 0, 1, 0 }) * local)[0].xyz;
        w.rollSign = axis.x >= 0 ? 1.0f : -1.0f;
    }
    w.pitchSign = w.rollSign; // same posed frame (the body carries no extra yaw)
    // Wheelbase = front-axle mid → rear-axle mid, the span the ground-conform
    // probes straddle (addCar measures the same distance off the posed model).
    if (!w.fl.isNull() && !w.fr.isNull() && !w.bl.isNull() && !w.br.isNull()) {
        // WORLD transforms: the wheel nodes' local translations sit inside the
        // asset's own scaled hierarchy, so the local delta isn't in world units.
        const auto wp = [&](utils::Entity e) {
            return tcm.getWorldTransform(tcm.getInstance(e))[3].xyz;
        };
        const float3 fm = (wp(w.fl) + wp(w.fr)) * 0.5f, bm = (wp(w.bl) + wp(w.br)) * 0.5f;
        const float wb = length(fm - bm);
        if (wb > 0.2f) w.wheelbase = wb;
    }
    // MonsterRig graft seat: bbox of the body with the WHEELS (and axle) taken
    // off, centred on the kit's cab slot in x/z and bottom-aligned to the slot
    // floor plus MOUNT_LIFT (−0.07, which drops the cab onto the suspension
    // rods). The slot is a fixed property of vehicle-monster-truck.glb — the
    // cab shares its vertex buffer with the chassis (the split is index-only),
    // so its runtime AABB spans the whole body and can't be measured here.
    {
        constexpr float SLOT_MIN_Y = 0.4375f, SLOT_CX = 0.0f, SLOT_CZ = -0.03125f;
        constexpr float MOUNT_LIFT = -0.07f;
        auto& rcm = mEngine->getRenderableManager();
        float3 lo{ 1e9f }, hi{ -1e9f };
        for (size_t k = 0; k < asset->getEntityCount(); k++) {
            const utils::Entity e = asset->getEntities()[k];
            const char* nm = asset->getName(e);
            if (nm && (std::strncmp(nm, "wheel", 5) == 0 || std::strcmp(nm, "axle") == 0)) continue;
            const auto ri = rcm.getInstance(e);
            if (!ri) continue;
            const filament::Box bx = rcm.getAxisAlignedBoundingBox(ri);
            const mat4f wm = tcm.getWorldTransform(tcm.getInstance(e));
            for (int sx = -1; sx <= 1; sx += 2)
                for (int sy = -1; sy <= 1; sy += 2)
                    for (int sz = -1; sz <= 1; sz += 2) {
                        const float3 corner = bx.center
                                + bx.halfExtent * float3{ (float) sx, (float) sy, (float) sz };
                        const float3 wp = (wm * float4{ corner, 1 }).xyz;
                        lo = min(lo, wp);
                        hi = max(hi, wp);
                    }
        }
        if (hi.y > lo.y) {
            w.monsterMount = { SLOT_CX - (lo.x + hi.x) * 0.5f,
                               (SLOT_MIN_Y - lo.y) + MOUNT_LIFT,
                               SLOT_CZ - (lo.z + hi.z) * 0.5f };
        }
    }
    // Footprint (blob shadow + boost-disk sizing) from the asset AABB — the JS
    // measures the posed proto's Box3 the same way.
    const filament::Aabb bb = asset->getBoundingBox();
    if (bb.max.x > bb.min.x) {
        w.footW = bb.max.x - bb.min.x;
        w.footL = bb.max.z - bb.min.z;
        w.bbMin = bb.min;
        w.bbMax = bb.max;
        // Ground-shadow silhouette, off THIS model, while it still sits at rest.
        if (mCarSilhouettes.size() <= index) mCarSilhouettes.resize(index + 1, nullptr);
        mCarSilhouettes[index] = bakeSilhouette(asset, bb.min, bb.max);
    }
    // Tyre-contact width for the skid ribbons: min(0.24, max(0.06,
    // min(wheelBox.x, wheelBox.z))) — SceneRenderer addCar's measurement.
    if (!w.bl.isNull()) {
        auto& rcm = mEngine->getRenderableManager();
        const auto ri = rcm.getInstance(w.bl);
        if (ri) {
            const filament::Box box = rcm.getAxisAlignedBoundingBox(ri);
            const float wx = box.halfExtent.x * 2, wz = box.halfExtent.z * 2;
            if (wx > 0 && wz > 0) {
                w.skidWidth = std::min(0.24f, std::max(0.06f, std::min(wx, wz)));
            }
        }
    }
    return true;
}

// Instanced prop pool (item boxes, bananas): one shared GLB, `count` instances,
// each posed independently via its root. Unused pool entries park underground.
gltfio::FilamentAsset* TtpRenderer::loadInstancedProp(const char* assetName,
        size_t count, std::vector<gltfio::FilamentInstance*>& out,
        bool shareMaterials) {
    const auto it = mAssets.find(assetName);
    if (it == mAssets.end() || count == 0) return nullptr;
    ensureAssetLoader();
    out.assign(count, nullptr);
    gltfio::FilamentAsset* asset = mAssetLoader->createInstancedAsset(
            it->second.data(), (uint32_t) it->second.size(), out.data(), count);
    if (!asset) { out.clear(); return nullptr; }
    registerAssetUris(asset);
    if (!mResourceLoader->loadResources(asset)) {
        mAssetLoader->destroyAsset(asset);
        out.clear();
        return nullptr;
    }
    asset->releaseSourceData();
    for (auto* inst : out) {
        mScene->addEntities(inst->getEntities(), inst->getEntityCount());
        // Props and scenery are not shadow casters in the JS either (each
        // floating prop carries its own baked contact blob instead).
        setShadows(inst->getEntities(), inst->getEntityCount(), false, false);
    }
    // Point every instance at instance 0's materials. gltfio hands each
    // FilamentInstance its own MaterialInstance so they can be tinted apart —
    // we tint per MODEL, not per instance (the box fade pool is the one
    // exception, and opts out via shareMaterials) — and that alone stops Filament's
    // automatic instancing from batching them, since it needs identical
    // geometry AND the same MaterialInstance. Fifty trees were fifty draw
    // calls; three merges its scenery into one mesh for the same reason.
    auto& rcm = mEngine->getRenderableManager();
    if (shareMaterials && out.size() > 1 && out[0]) {
        const size_t nEnt = out[0]->getEntityCount();
        for (size_t i = 1; i < out.size(); i++) {
            if (!out[i] || out[i]->getEntityCount() != nEnt) continue;
            for (size_t e = 0; e < nEnt; e++) {
                const auto ri0 = rcm.getInstance(out[0]->getEntities()[e]);
                const auto ri = rcm.getInstance(out[i]->getEntities()[e]);
                if (!ri0 || !ri) continue;
                const size_t prims = std::min(rcm.getPrimitiveCount(ri),
                        rcm.getPrimitiveCount(ri0));
                for (size_t p = 0; p < prims; p++) {
                    rcm.setMaterialInstanceAt(ri, p, rcm.getMaterialInstanceAt(ri0, p));
                }
            }
        }
    }
    return asset;
}

// Project the decal's origin onto the centreline, then conform. Callers that
// already know where they are on the ribbon should use conformDecalAt directly:
// project() is a linear scan over every centreline sample (twice, if the first
// pass's normal test rejects everything), and the bananas, rockets and boost
// discs all have the arclength in hand — the bananas and rockets straight from
// FrameInput, the disc from the ground blob that was conformed six lines earlier
// for the same car at the same pose.
void TtpRenderer::conformDecal(Mesh& mesh, const mat4f& basis, float sx, float sz,
        float lift, float alphaScale) {
    if (!mTrack || mesh.entity.isNull() || !mesh.vb || mesh.local.empty()) return;
    float s0 = 0, lat0 = 0;
    mTrack->project(basis[3].xyz, basis[1].xyz, s0, lat0);
    conformDecalAt(mesh, basis, s0, lat0, sx, sz, lift, alphaScale);
}

void TtpRenderer::conformDecalAt(Mesh& mesh, const mat4f& basis, float s0, float lat0,
        float sx, float sz, float lift, float alphaScale) {
    if (!mTrack || mesh.entity.isNull() || !mesh.vb || mesh.local.empty()) return;
    const TrackBin::Sample f0 = mTrack->frameAt(s0);
    const float3 tan0 = f0.tangent();
    const float3 rightW = basis[0].xyz, fwdW = basis[2].xyz;
    const float3 origin = basis[3].xyz;
    for (size_t k = 0; k < mesh.local.size() && k < mesh.verts.size(); k++) {
        const Mesh::Local& t = mesh.local[k];
        const float3 v = rightW * (t.x * sx) + fwdW * (t.z * sz);
        // The JS lays the decal FLAT in the car's tangent plane and raycasts
        // each vertex down the surface normal, so a curving deck shortens or
        // stretches the sheet as it falls onto it. Carrying the offset as
        // arclength instead wrapped the full length around a loop, which is
        // what made the shadow balloon there. Two Newton steps slide (s, lat)
        // until the road point sits under the flat point.
        const float3 q = origin + v;
        float s = s0 + dot(v, tan0);
        float lat = lat0 + dot(v, f0.lat);
        TrackBin::Sample f = mTrack->frameAt(s);
        for (int it = 0; it < 2; it++) {
            const float3 d = (f.pos + f.lat * lat) - q;
            s -= dot(d, f.tangent());
            lat -= dot(d, f.lat);
            f = mTrack->frameAt(s);
        }
        const float3 p = f.pos + f.lat * lat + f.up * lift;
        Vertex& o = mesh.verts[k];
        o.px = p.x; o.py = p.y; o.pz = p.z;
        const uint32_t a = (uint32_t) std::lround(
                std::min(255.0f, std::max(0.0f, t.a * alphaScale)));
        o.abgr = (o.abgr & 0x00ffffffu) | (a << 24);
    }
    mesh.vb->setBufferAt(*mEngine, 0, VertexBuffer::BufferDescriptor(
            mesh.verts.data(), mesh.verts.size() * sizeof(Vertex), nullptr));
    refreshBounds(mesh); // the sheet just moved; its box has to follow
    // The verts are world-space now — clear any parking transform.
    auto& tcm = mEngine->getTransformManager();
    tcm.setTransform(tcm.getInstance(mesh.entity), mat4f{});
}

// Boost pads as painted overlays: the chevron DISC (makePadTexture) or the
// loop-mouth launch STRIP (makePadStripTexture), drawn just above the deck with
// polygon offset. Both are built as GEOMETRY in the source textures' own canvas
// coordinates — the chevrons are the canvas polylines STROKED (round caps and
// joins, same lineWidth), not the cross-bands this first shipped with, and each
// canvas point maps through frameAt so the art follows the road's curve.
// The sea ring (theme.water): a flat ring around the play field whose radial
// vertex-colour bands sell the read — a bright foam line at the shore, then
// turquoise shallows deepening to blue out past the fog — plus the wet-sand
// glaze hugging the inside of the waterline. The shoreline is per-ANGLE, fitted
// to the track's own convex support (fitWater/shorelineFn), so an oval circuit
// gets an oval island and the surf never floods the road.
void TtpRenderer::buildWater(const TrackBin& tb) {
    if (!tb.hasWater || !mBlendMaterial) return;
    constexpr float WATER_INNER = 135.0f, WATER_LIFT = 0.12f;
    constexpr float WATER_SHADE = 1.0f; // the flat sheet's constant Lambert term
    constexpr int SEG = 288;
    constexpr float SHORE_MARGIN = 26, SHORE_WOBBLE = 22, SHORE_CRINKLE = 2.6f;
    constexpr float SHORE_FADE = 220, SWASH_RANGE = 0.62f, SWASH_ZONE = 20;
    // [radius, colour param (0..2 = foam→shallow→deep), alpha]
    static const float BANDS[9][3] = {
        { WATER_INNER,        0,     0    },
        { WATER_INNER + 1.2f, 0,     0.9f },
        { WATER_INNER + 4.0f, 0,     0.92f },
        { WATER_INNER + 4.4f, 0.8f,  0.88f },
        { WATER_INNER + 9,    0.9f,  0.86f },
        { WATER_INNER + 20,   1,     0.95f },
        { WATER_INNER + 60,   1.55f, 1 },
        { WATER_INNER + 180,  2,     1 },
        { 2600,               2,     1 },
    };
    static const float WET[5][2] = { // [radius, alpha]
        { WATER_INNER - 13,   0 },
        { WATER_INNER - 8.5f, 0.10f },
        { WATER_INNER - 8.0f, 0.24f },
        { WATER_INNER - 2,    0.42f },
        { WATER_INNER + 2.5f, 0.5f },
    };
    static const float SHORE_H[4][2] = { { 2, 1 }, { 3, 0.72f }, { 5, 0.44f }, { 7, 0.26f } };
    static const float CRINKLE_H[3][2] = { { 11, 1 }, { 17, 0.62f }, { 29, 0.34f } };
    static const float SWASH_H[3][2] = { { 3, 1 }, { 7, 0.55f }, { 13, 0.3f } };

    uint32_t seed = tb.shoreSeed;
    const auto rnd = [&]() {
        seed = seed * 1664525u + 1013904223u;
        return (float) ((double) seed / 4294967296.0);
    };
    float shorePh[4], crinklePh[3], swashPh[3];
    for (float& p : shorePh) p = rnd() * 2.0f * (float) M_PI;
    for (float& p : crinklePh) p = rnd() * 2.0f * (float) M_PI;
    for (float& p : swashPh) p = rnd() * 2.0f * (float) M_PI;
    const auto harm = [](const float (*h)[2], int n, const float* ph, float a) {
        float sum = 0, w = 0;
        for (int i = 0; i < n; i++) { sum += h[i][1] * std::sin(h[i][0] * a + ph[i]); w += h[i][1]; }
        return sum / w;
    };
    // Convex support of the track's samples at this bearing + the lobes/crinkle.
    const auto shoreAt = [&](float a) {
        const float cx = std::cos(a), cz = std::sin(a);
        float support = 0;
        for (const auto& s : tb.samples) {
            support = std::max(support, s.pos.x * cx + s.pos.z * cz);
        }
        return support + SHORE_MARGIN
                + SHORE_WOBBLE * (0.5f + 0.5f * harm(SHORE_H, 4, shorePh, a))
                + SHORE_CRINKLE * harm(CRINKLE_H, 3, crinklePh, a);
    };
    mShoreFn = shoreAt; // the sailboat anchors off the same curve
    std::vector<float> cosA(SEG + 1), sinA(SEG + 1), shoreR(SEG + 1), swashF(SEG + 1);
    float outer = 0;
    for (int si = 0; si <= SEG; si++) {
        const float a = (float) (si % SEG) / SEG * 2.0f * (float) M_PI;
        cosA[si] = std::cos(a); sinA[si] = std::sin(a);
        shoreR[si] = shoreAt(a);
        swashF[si] = 1 + SWASH_RANGE * harm(SWASH_H, 3, swashPh, a);
        outer = std::max(outer, shoreR[si]);
    }
    const float y = tb.groundY + WATER_LIFT;
    const float3 foam = srgbToLinear(tb.waterFoam);
    const float3 shallow = srgbToLinear(tb.waterShallow);
    const float3 deep = srgbToLinear(tb.waterDeep);
    const auto ringMesh = [&](Mesh& m, const std::function<float(int)>& radiusAt,
            int rings, bool fade, float lift,
            const std::function<uint32_t(int)>& colAt) {
        for (int ri = 0; ri < rings; ri++) {
            const float off = radiusAt(ri) - WATER_INNER;
            // The outline relaxes back to a circle as the water deepens — out
            // past the fog the far rings only need to reach the sky.
            const float t = fade ? std::min(1.0f, std::fabs(off) / SHORE_FADE) : 0.0f;
            const float sw = std::max(0.0f, 1 - std::fabs(off) / SWASH_ZONE);
            const uint32_t c = colAt(ri);
            for (int si = 0; si <= SEG; si++) {
                const float r = shoreR[si] * (1 - t) + outer * t
                        + off * (1 + (swashF[si] - 1) * sw);
                m.verts.push_back({ cosA[si] * r, y + lift, sinA[si] * r, c });
            }
        }
        const uint32_t verts = SEG + 1;
        for (int ri = 0; ri + 1 < rings; ri++) {
            for (int si = 0; si < SEG; si++) {
                const uint32_t a = ri * verts + si, b = a + verts;
                m.idx.insert(m.idx.end(), { a, a + 1, b, a + 1, b + 1, b });
            }
        }
    };
    // Damp sand first (it draws under the sea), then the sheet.
    {
        const uint32_t wet = tb.waterWet;
        ringMesh(mWet, [](int ri) { return WET[ri][0]; }, 5, false, -0.05f, [&](int ri) {
            return packLinear(srgbToLinear(wet), 1.0f, WET[ri][1]);
        });
        MaterialInstance* mi = sceneInstance(mBlendMaterial);
        mi->setPolygonOffset(-1.0f, -1.0f);
        buildMesh(mWet, true, mi, 1);
    }
    {
        ringMesh(mWater, [](int ri) { return BANDS[ri][0]; }, 9, true, 0.0f, [&](int ri) {
            const float t = BANDS[ri][1];
            const float3 c = t <= 1 ? mix(foam, shallow, t) : mix(shallow, deep, t - 1);
            return packLinear(c, WATER_SHADE, BANDS[ri][2]);
        });
        // The JS sheet is Lambert, but it's FLAT and horizontal, so its shading
        // is one constant — folded into the vertex colours instead, since the
        // lit material family isn't a blending one. WATER_SHADE is that
        // constant, matched against the live pane.
        MaterialInstance* mi = sceneInstance(mBlendMaterial);
        mi->setPolygonOffset(-1.0f, -1.0f);
        buildMesh(mWater, true, mi, 2); // after the wet sand, before every flier
    }
}

// Fliers: gulls/vultures/geese circling their roosts (theme.birds), kites
// bobbing on their strings over the shore (theme.kites) and the playroom's
// paper dart (theme.paperPlane). The JS birds/kites are canvas SPRITES; here
// their glyphs are built as real geometry in the sprite's unit quad (the
// canvas maps isotropically once the sprite's own aspect is applied), and the
// render loop yaws them to face each cell's camera like the clouds.
void TtpRenderer::buildFliers(const TrackBin& tb) {
    if (!mBlendMaterial) return;
    // Round-capped polyline stroke in CANVAS pixels, mapped into the quad by
    // `toLocal` — the same idiom buildPadsMesh uses for the pad chevrons.
    const auto stroke = [&](Mesh& m, const std::vector<float2>& pts, float halfW,
            uint32_t col, const std::function<float3(float2)>& toLocal) {
        const auto push = [&](float2 p) {
            const float3 v = toLocal(p);
            m.verts.push_back({ v.x, v.y, v.z, col });
        };
        for (size_t i = 0; i + 1 < pts.size(); i++) {
            const float2 a = pts[i], b = pts[i + 1];
            const float2 d = b - a;
            const float len = std::sqrt(d.x * d.x + d.y * d.y);
            if (len < 1e-5f) continue;
            const float2 n{ -d.y / len * halfW, d.x / len * halfW };
            const uint32_t base = (uint32_t) m.verts.size();
            push(a + n); push(b + n); push(a - n); push(b - n);
            m.idx.insert(m.idx.end(), { base, base + 1, base + 2,
                                        base + 1, base + 3, base + 2 });
        }
        // Round caps + joins: a fan at every vertex keeps corners closed.
        for (const float2& p : pts) {
            const uint32_t base = (uint32_t) m.verts.size();
            push(p);
            constexpr int SEG = 8;
            for (int k = 0; k <= SEG; k++) {
                const float a = (float) k / SEG * 2.0f * (float) M_PI;
                push(p + float2{ std::cos(a) * halfW, std::sin(a) * halfW });
            }
            for (int k = 0; k < SEG; k++) {
                m.idx.insert(m.idx.end(), { base, base + 1 + (uint32_t) k,
                                            base + 2 + (uint32_t) k });
            }
        }
    };
    const auto quadratic = [](float2 a, float2 c, float2 b, int seg,
            std::vector<float2>& out) {
        for (int i = 1; i <= seg; i++) {
            const float t = (float) i / seg, u = 1 - t;
            out.push_back(a * (u * u) + c * (2 * u * t) + b * (t * t));
        }
    };

    // Birds: 4 sprites of a 2:1 double-arc glyph (64×32 canvas, 4.5px stroke).
    if (tb.birdCount > 0) {
        mBirds.resize(std::min(tb.birdCount, 4u));
        const uint32_t col = packLinear(srgbToLinear(tb.birdTint), 1.0f, 1.0f);
        const auto toLocal = [](float2 p) {
            return float3{ (p.x - 32.0f) / 64.0f, (16.0f - p.y) / 32.0f, 0 };
        };
        std::vector<float2> path{ { 6, 22 } };
        quadratic({ 6, 22 }, { 20, 6 }, { 32, 18 }, 8, path);
        quadratic({ 32, 18 }, { 44, 6 }, { 58, 22 }, 8, path);
        for (Mesh& m : mBirds) {
            stroke(m, path, 2.25f, col, toLocal);
            if (!buildMesh(m, true, mBlendMaterial->getDefaultInstance())) return;
        }
    }

    // Kites: a filled diamond, a lazy-S tail and two little bows (64² canvas).
    if (tb.kiteCount > 0) {
        mKites.resize(std::min(tb.kiteCount, 2u));
        const auto toLocal = [](float2 p) {
            return float3{ (p.x - 32.0f) / 64.0f, (32.0f - p.y) / 64.0f, 0 };
        };
        for (size_t i = 0; i < mKites.size(); i++) {
            Mesh& m = mKites[i];
            const uint32_t tint = tb.kiteTints.empty()
                    ? 0xffffffu : tb.kiteTints[i % tb.kiteTints.size()];
            const uint32_t col = packLinear(srgbToLinear(tint), 1.0f, 1.0f);
            const uint32_t colT = packLinear(srgbToLinear(tint), 1.0f, 0.9f);
            const float2 D[4] = { { 32, 2 }, { 48, 18 }, { 32, 40 }, { 16, 18 } };
            const uint32_t base = (uint32_t) m.verts.size();
            for (const float2& p : D) {
                const float3 v = toLocal(p);
                m.verts.push_back({ v.x, v.y, v.z, col });
            }
            m.idx.insert(m.idx.end(), { base, base + 1, base + 2,
                                        base, base + 2, base + 3 });
            std::vector<float2> tail{ { 32, 40 } };
            quadratic({ 32, 40 }, { 40, 48 }, { 32, 53 }, 5, tail);
            quadratic({ 32, 53 }, { 24, 58 }, { 30, 62 }, 5, tail);
            stroke(m, tail, 1.2f, colT, toLocal);
            for (const float2& b : { float2{ 36, 47 }, float2{ 27, 57 } }) {
                stroke(m, { b, b }, 2.6f, col, toLocal);
            }
            if (!buildMesh(m, true, mBlendMaterial->getDefaultInstance())) return;
        }
    }

    // Paper dart: three flat triangles (two dihedral-V wings + a hanging keel),
    // nose +Z, unit-sized — the render loop scales and banks it. Both windings
    // stand in for the JS material's DoubleSide.
    if (tb.hasPlane) {
        static const float3 TRIS[9] = {
            { 0, 0, 0.55f }, { 0, 0.02f, -0.5f }, { -0.42f, 0.17f, -0.5f },
            { 0, 0, 0.55f }, { 0.42f, 0.17f, -0.5f }, { 0, 0.02f, -0.5f },
            { 0, 0, 0.55f }, { 0, -0.2f, -0.42f }, { 0, 0.02f, -0.5f },
        };
        const uint32_t col = packLinear(srgbToLinear(tb.planeTint), 1.0f);
        for (const float3& v : TRIS) mPlane.verts.push_back({ v.x, v.y, v.z, col });
        for (uint32_t t = 0; t < 3; t++) {
            mPlane.idx.insert(mPlane.idx.end(), { t * 3, t * 3 + 1, t * 3 + 2,
                                                  t * 3, t * 3 + 2, t * 3 + 1 });
        }
        accumulateNormals(mPlane);
        buildMesh(mPlane);
    }
}

void TtpRenderer::buildPadsMesh(const TrackBin& tb) {
    if (tb.pads.empty()) return;
    // boostShades(theme.boost) — one accent per biome drives every surface.
    const ttp::rt::BoostShades boost = ttp::rt::boost_shades(tb.boostCol);
    const float3 PAD_LIGHT = srgbToLinear(boost.light);   // disc core
    const float3 PAD_BASE = srgbToLinear(boost.base);     // disc mid stop (0.7)
    const float3 PAD_DARK = srgbToLinear(boost.dark);     // disc rim
    const float3 STRIP_BODY = srgbToLinear(boost.strip);  // flat strip body
    const float3 CREAM = srgbToLinear(0xfdf3cf);
    const float LIFT = 0.01f;

    const auto push = [&](const float3& p, uint32_t c) {
        mPads.verts.push_back({ p.x, p.y, p.z, c });
    };
    const auto quadIdx = [&](uint32_t base) {
        mPads.idx.insert(mPads.idx.end(),
                { base, base + 2, base + 1, base + 1, base + 2, base + 3 });
    };
    // Stroke a canvas-space polyline with round caps + joins (the 2D context's
    // lineCap/lineJoin 'round'), mapped to the deck by `toWorld`.
    const auto stroke = [&](const std::vector<float2>& pts, float lw,
            const std::function<float3(const float2&)>& toWorld, const float3& col) {
        const uint32_t cc = packLinear(col, 1.0f);
        const float hw = lw / 2;
        for (size_t k = 0; k + 1 < pts.size(); k++) {
            const float2 d = pts[k + 1] - pts[k];
            const float len = std::sqrt(d.x * d.x + d.y * d.y);
            if (len < 1e-5f) continue;
            const float2 n = { -d.y / len * hw, d.x / len * hw };
            const uint32_t base = (uint32_t) mPads.verts.size();
            push(toWorld(pts[k] + n), cc);
            push(toWorld(pts[k] - n), cc);
            push(toWorld(pts[k + 1] + n), cc);
            push(toWorld(pts[k + 1] - n), cc);
            quadIdx(base);
        }
        for (const float2& q : pts) { // round cap / join
            const int SEG = 8;
            const uint32_t base = (uint32_t) mPads.verts.size();
            push(toWorld(q), cc);
            for (int j = 0; j <= SEG; j++) {
                const float a = (float) j / SEG * 2.0f * (float) M_PI;
                push(toWorld(q + float2{ std::cos(a) * hw, std::sin(a) * hw }), cc);
            }
            for (int j = 0; j < SEG; j++) {
                mPads.idx.insert(mPads.idx.end(),
                        { base, base + 1 + (uint32_t) j, base + 2 + (uint32_t) j });
            }
        }
    };

    for (const TrackBin::Pad& pad : tb.pads) {
        if (pad.kind == 1) {
            // ---- launch strip: makePadStripTexture on a 320×128 canvas, u
            // across the lane and v along travel (the JS decal's UVs).
            const float halfL = pad.p0, halfW = pad.p1;
            const auto toWorld = [&](const float2& q) {
                const float d = (0.5f - q.y / 128.0f) * 2 * halfL;
                const TrackBin::Sample f = tb.frameAt(pad.s + d);
                return f.pos + f.lat * (pad.lat + (q.x / 320.0f - 0.5f) * 2 * halfW)
                        + f.up * LIFT;
            };
            const uint32_t body = packLinear(STRIP_BODY, 1.0f);
            constexpr int ROWS = 16, COLS = 4; // follow the deck's curve
            for (int r = 0; r < ROWS; r++) {
                for (int cc2 = 0; cc2 < COLS; cc2++) {
                    const float y0 = r * (128.0f / ROWS), y1 = (r + 1) * (128.0f / ROWS);
                    const float x0 = cc2 * (320.0f / COLS), x1 = (cc2 + 1) * (320.0f / COLS);
                    const uint32_t base = (uint32_t) mPads.verts.size();
                    push(toWorld({ x0, y0 }), body);
                    push(toWorld({ x1, y0 }), body);
                    push(toWorld({ x0, y1 }), body);
                    push(toWorld({ x1, y1 }), body);
                    quadIdx(base);
                }
            }
            // 5×2 grid of cream chevrons, apex toward canvas-top = travel.
            constexpr int COLS_C = 5, ROWS_C = 2;
            constexpr float CW = 320.0f / COLS_C, GAP = 26, CHEV = 22;
            constexpr float HALF = CW * 0.32f, Y0 = (128 - ((ROWS_C - 1) * GAP + CHEV)) / 2;
            const auto lift = [&](const float2& q) {
                const float d = (0.5f - q.y / 128.0f) * 2 * halfL;
                const TrackBin::Sample f = tb.frameAt(pad.s + d);
                return f.pos + f.lat * (pad.lat + (q.x / 320.0f - 0.5f) * 2 * halfW)
                        + f.up * (LIFT + 0.002f);
            };
            for (int c2 = 0; c2 < COLS_C; c2++) {
                const float cx = (c2 + 0.5f) * CW;
                for (int r2 = 0; r2 < ROWS_C; r2++) {
                    const float y = Y0 + r2 * GAP;
                    stroke({ { cx - HALF, y + CHEV }, { cx, y }, { cx + HALF, y + CHEV } },
                            9.0f, lift, CREAM);
                }
            }
        } else {
            // ---- chevron disc: makePadTexture on a 64×64 canvas, the disc
            // inscribed in it (CircleGeometry UVs) — radial gradient light →
            // base (0.7) → dark rim, then 3 stroked chevrons.
            const float r = pad.p0;
            const auto toWorld = [&](const float2& q) {
                const float d = (0.5f - q.y / 64.0f) * 2 * r;
                const TrackBin::Sample f = tb.frameAt(pad.s + d);
                return f.pos + f.lat * (pad.lat + (q.x / 64.0f - 0.5f) * 2 * r) + f.up * LIFT;
            };
            const int SEG = 24;
            const uint32_t cCore = packLinear(PAD_LIGHT, 1.0f);
            const uint32_t cMid = packLinear(PAD_BASE, 1.0f);
            const uint32_t cRim = packLinear(PAD_DARK, 1.0f);
            const uint32_t base = (uint32_t) mPads.verts.size();
            push(toWorld({ 32, 32 }), cCore);
            for (const float rr : { 0.7f, 1.0f }) {
                for (int j = 0; j <= SEG; j++) {
                    const float a = (float) j / SEG * 2.0f * (float) M_PI;
                    push(toWorld({ 32 + std::cos(a) * 32 * rr, 32 + std::sin(a) * 32 * rr }),
                            rr < 1.0f ? cMid : cRim);
                }
            }
            const uint32_t ring0 = base + 1, ring1 = ring0 + SEG + 1;
            for (int j = 0; j < SEG; j++) {
                mPads.idx.insert(mPads.idx.end(),
                        { base, ring0 + (uint32_t) j, ring0 + (uint32_t) j + 1 });
                mPads.idx.insert(mPads.idx.end(),
                        { ring0 + (uint32_t) j, ring1 + (uint32_t) j, ring1 + (uint32_t) j + 1,
                          ring0 + (uint32_t) j, ring1 + (uint32_t) j + 1, ring0 + (uint32_t) j + 1 });
            }
            const auto lift = [&](const float2& q) {
                const float d = (0.5f - q.y / 64.0f) * 2 * r;
                const TrackBin::Sample f = tb.frameAt(pad.s + d);
                return f.pos + f.lat * (pad.lat + (q.x / 64.0f - 0.5f) * 2 * r)
                        + f.up * (LIFT + 0.002f);
            };
            constexpr int N = 3;
            constexpr float GAP = 13, CHEV = 10, WING = 16;
            constexpr float Y0 = (64 - ((N - 1) * GAP + CHEV)) / 2;
            for (int j = 0; j < N; j++) {
                const float y = Y0 + j * GAP;
                stroke({ { 32 - WING, y + CHEV }, { 32, y }, { 32 + WING, y + CHEV } },
                        6.0f, lift, CREAM);
            }
        }
    }
    mPadMat = sceneInstance(mMaterial);
    mPadMat->setPolygonOffset(-3.0f, -3.0f);
    buildMesh(mPads, true, mPadMat);
}

// Support structures + berms — track.js buildPoles / buildPillars /
// buildLoopPoles / buildHills. The port used to stand an item-CONE at every
// authored pole, which is neither the right shape nor the right thing: these
// are matte concrete posts. The berms are the grass the JS lofts under a
// raised, non-pillared deck; without them the elevated section floats over a
// hole in the world with its grey skirt hanging out (that's the "missing green
// hill" under gate0's overpass).
void TtpRenderer::buildStructures(const TrackBin& tb) {
    const float3 STRUCT = srgbToLinear(tb.structureCol);
    const uint32_t sc = packLinear(STRUCT, 1.0f);
    // Vertical cylinder, optionally with its top clipped to a plane (the loop
    // shafts meet the deck's angled underside flush instead of poking through).
    const auto column = [&](float x, float z, float r, float y0, float y1,
            const float3* planeP, const float3* planeN) {
        constexpr int SEG = 12;
        const uint32_t base = (uint32_t) mStructures.verts.size();
        const auto topAt = [&](float vx, float vz) {
            if (!planeP || !planeN || std::fabs(planeN->y) < 1e-4f) return y1;
            const float py = planeP->y
                    - (planeN->x * (vx - planeP->x) + planeN->z * (vz - planeP->z)) / planeN->y;
            return std::min(y1, py);
        };
        for (int j = 0; j <= SEG; j++) {
            const float a = (float) j / SEG * 2.0f * (float) M_PI;
            const float vx = x + std::cos(a) * r, vz = z + std::sin(a) * r;
            mStructures.verts.push_back({ vx, y0, vz, sc });
            mStructures.verts.push_back({ vx, topAt(vx, vz), vz, sc });
        }
        for (int j = 0; j < SEG; j++) {
            const uint32_t a0 = base + (uint32_t) j * 2, b0 = a0 + 1, a1 = a0 + 2, b1 = a0 + 3;
            mStructures.idx.insert(mStructures.idx.end(), { a0, b0, a1, b0, b1, a1 });
        }
        const uint32_t cap = (uint32_t) mStructures.verts.size();
        mStructures.verts.push_back({ x, topAt(x, z), z, sc });
        for (int j = 0; j < SEG; j++) {
            mStructures.idx.insert(mStructures.idx.end(),
                    { cap, base + (uint32_t) j * 2 + 1, base + ((uint32_t) j + 1) * 2 + 1 });
        }
    };

    for (const TrackBin::Pillar& p : tb.pillars) {
        column(p.x, p.z, p.radius, p.baseY, std::max(p.baseY + 0.1f, p.topY), nullptr, nullptr);
    }
    // Poles: from the road surface (EMBED 0.06 below) up to just under the deck
    // crossing overhead (TUCK 0.34), or POST_UP 2.0 above the road with nothing
    // over them — buildPoles' own search over the centreline samples.
    for (const TrackBin::Pole& p : tb.poles) {
        const TrackBin::Sample f = tb.frameAt(p.s);
        const float3 base = f.pos + f.lat * p.lat;
        float topY = base.y + 2.0f, bestD = 1e30f;
        for (const TrackBin::Sample& s : tb.samples) {
            if (s.pos.y - base.y < 1.5f) continue;
            const float dx = s.pos.x - base.x, dz = s.pos.z - base.z;
            const float d = dx * dx + dz * dz;
            if (d < 4.0f && d < bestD) { bestD = d; topY = s.pos.y - 0.34f; }
        }
        column(base.x, base.z, p.radius, base.y - 0.06f,
                std::max(base.y - 0.06f + 0.3f, topY), nullptr, nullptr);
    }
    // Loop shafts: built tall from the lawn, then cut to the road's underside.
    for (const TrackBin::Post& p : tb.supportPosts) {
        const float3 n = p.cUp;
        const float3 planeP = p.cPos - n * 0.34f; // deck thickness
        column(p.x, p.z, p.radius, tb.groundY - 0.1f, p.cPos.y + 1.0f, &planeP, &n);
    }
    if (!mStructures.verts.empty()) {
        accumulateNormals(mStructures);
        if (!buildMesh(mStructures, true, litShadowInstance())) return;
    }

    // Berms: consecutive cross-section rings stitched into a grass surface that
    // meets the road underside and flares down to the lawn (buildHills verbatim
    // — left slope, top, right slope; flare grows with height for a constant
    // slope angle).
    const float gy = tb.groundY;
    const auto corners = [&](const TrackBin::BermRing& r, float3 out[4]) {
        const float flare = 0.6f + 0.8f * std::max(0.0f, std::max(r.topL, r.topR) - gy);
        const float hw = r.halfW, ox = r.lx, oz = r.lz;
        out[0] = { r.cx - ox * (hw + flare), gy, r.cz - oz * (hw + flare) };
        out[1] = { r.cx - ox * hw, r.topL, r.cz - oz * hw };
        out[2] = { r.cx + ox * hw, r.topR, r.cz + oz * hw };
        out[3] = { r.cx + ox * (hw + flare), gy, r.cz + oz * (hw + flare) };
    };
    const auto quad = [&](const float3& a, const float3& b, const float3& c, const float3& d) {
        const uint32_t base = (uint32_t) mBerms.verts.size();
        for (const float3& p : { a, b, c, d }) {
            mBerms.verts.push_back({ p.x, p.y, p.z,
                    packLinear(groundColorAt(p.x), 1.0f) });
        }
        mBerms.idx.insert(mBerms.idx.end(), { base, base + 1, base + 2, base, base + 2, base + 3 });
    };
    for (const auto& run : tb.berms) {
        if (run.size() < 2) continue;
        float3 A[4], B[4];
        corners(run[0], A);
        for (size_t i = 1; i < run.size(); i++) {
            corners(run[i], B);
            quad(A[0], A[1], B[1], B[0]); // left slope
            quad(A[1], A[2], B[2], B[1]); // top, under the road
            quad(A[2], A[3], B[3], B[2]); // right slope
            for (int k = 0; k < 4; k++) A[k] = B[k];
        }
    }
    if (!mBerms.verts.empty()) {
        accumulateNormals(mBerms);
        buildMesh(mBerms, true, litShadowInstance());
    }
}

// Oil slicks + warning cones. The slick is TrackProps' dark translucent disc
// (0x161425 @ 0.7, real RoadDecal clipping later); the cones ring it exactly
// like _buildHazards (n on radius×1.05, half-step offset, clamped inside the
// kerb). (Authored poles are concrete posts — see buildStructures.)
void TtpRenderer::buildOils(const TrackBin& tb) {
    if ((tb.oils.empty() && tb.poles.empty())) return;
    if (!tb.oils.empty() && mBlendMaterial) {
        // The slick reskins per biome: a turquoise puddle on the beach, a pale
        // glacial sheet on the snow, the dark oil film everywhere else — each
        // with a foam/frost rim ring so it reads as a feature with an edge.
        const uint32_t c = tb.hasWater
                ? packLinear(srgbToLinear(tb.waterShallow), 1.0f, 0.55f)
                : tb.hasIce ? packLinear(srgbToLinear(tb.iceSheet), 1.0f, 0.45f)
                            : packLinear(srgbToLinear(0x161425), 1.0f, 0.7f);
        const bool hasRim = tb.hasWater || tb.hasIce;
        const uint32_t rimC = packLinear(
                srgbToLinear(tb.hasWater ? tb.waterFoam : tb.iceFrost), 1.0f, 0.5f);
        for (const TrackBin::Oil& o : tb.oils) {
            const TrackBin::Sample f = tb.frameAt(o.s);
            const float3 tanv = f.tangent();
            const float3 ctr = f.pos + f.lat * o.lat + f.up * 0.012f;
            const uint32_t base = (uint32_t) mOils.verts.size();
            mOils.verts.push_back({ ctr.x, ctr.y, ctr.z, c });
            const int SEG = 16;
            for (int j = 0; j <= SEG; j++) {
                const float a = (float) j / SEG * 2.0f * (float) M_PI;
                const float3 p = ctr + f.lat * (std::cos(a) * o.radius)
                        + tanv * (std::sin(a) * o.radius);
                mOils.verts.push_back({ p.x, p.y, p.z, c });
            }
            for (int j = 0; j < SEG; j++) {
                mOils.idx.insert(mOils.idx.end(),
                        { base, base + 1 + (uint32_t) j, base + 2 + (uint32_t) j });
            }
            if (!hasRim) continue;
            // Rim annulus (0.82 r → r), painted over the coplanar disc.
            const uint32_t rb = (uint32_t) mOils.verts.size();
            for (int j = 0; j <= SEG; j++) {
                const float a = (float) j / SEG * 2.0f * (float) M_PI;
                for (const float rr : { o.radius * 0.82f, o.radius }) {
                    const float3 p = ctr + f.lat * (std::cos(a) * rr)
                            + tanv * (std::sin(a) * rr) + f.up * 0.002f;
                    mOils.verts.push_back({ p.x, p.y, p.z, rimC });
                }
            }
            for (int j = 0; j < SEG; j++) {
                const uint32_t q = rb + (uint32_t) j * 2;
                mOils.idx.insert(mOils.idx.end(), { q, q + 1, q + 2, q + 1, q + 3, q + 2 });
            }
        }
        MaterialInstance* mi = sceneInstance(mBlendMaterial);
        mi->setPolygonOffset(-2.0f, -2.0f);
        buildMesh(mOils, true, mi);
    }
    // Cones: hazard rings + gate poles, one instanced pool.
    struct ConeSpot { float s, lat; };
    std::vector<ConeSpot> spots;
    const float coneEdge = tb.roadWidth / 2 - 0.35f;
    for (const TrackBin::Oil& o : tb.oils) {
        const uint32_t n = o.cones ? o.cones : 4;
        const float ring = o.radius * 1.05f;
        for (uint32_t i = 0; i < n; i++) {
            const float a = (i + 0.5f) * (2.0f * (float) M_PI / n);
            const float lat = o.lat + std::sin(a) * ring;
            spots.push_back({ o.s + std::cos(a) * ring,
                    std::max(-coneEdge, std::min(coneEdge, lat)) });
        }
    }
    if (!spots.empty() && tb.hasWater) {
        // Beach: the slick's markers are folding "wet floor" signs, not cones —
        // two safety-yellow panels hinged at a ridge and splayed at the base,
        // and on each outward face the "slippery road" pictogram every driver
        // already knows (MUTCD W8-5): a car head-on over two snaking skid
        // tracks, in black on the safety yellow.
        constexpr float WETSIGN_H = 0.46f;
        constexpr float RIDGE = 1.0f, SPLAY = 0.30f;      // proto: ridge y, foot half-splay
        const float S = WETSIGN_H / RIDGE;                 // scaled to the marker height
        const float L = std::sqrt(RIDGE * RIDGE + SPLAY * SPLAY);
        const float Wp = L * 0.66f, topHW = Wp * 0.33f, botHW = Wp * 0.50f;
        constexpr float TD = 0.05f;
        constexpr float TAU = 2.0f * (float) M_PI;
        // ---- the shell ------------------------------------------------------
        // A MOULDED panel, not a cut card: rounded corners, and a shallow
        // chamfer running the whole way round the face. The chamfer is what
        // sells it — the face is flat, so under a single key light it can only
        // ever be one shade; a band angled out of that plane is the only thing
        // on the panel that catches the light differently.
        constexpr float R_TOP = 0.10f, R_BOT = 0.06f;   // corner radii, in panel units
        constexpr float BEV = 0.024f, BEVD = 0.012f;    // chamfer: wide and shallow
        constexpr int ARC = 4, NPT = 4 * (ARC + 1);     // outline: 4 rounded corners
        constexpr float FACE_W = TD / 2, LIP_W = FACE_W - BEVD, BACK_W = -TD / 2;
        // Hinge barrel over the ridge, wide enough to swallow both panel tops —
        // the detail that reads "one folding sign" rather than "two boards".
        constexpr float HINGE_R = 0.042f, HINGE_HW = 0.150f;
        constexpr int HINGE_SEG = 8;
        constexpr uint32_t PANEL_FACE = 0xf6c400, PANEL_BEV = 0xefb70e,
                           PANEL_WALL = 0xd9a300;
        struct Pt { float u, v; };
        // ---- the pictogram --------------------------------------------------
        // In panel units (u across, v up the panel, origin at its centre), laid
        // on planes a hair proud of the face: ink first, then the cut-outs a
        // hair proud of THAT, so the depth test alone stacks them. The cut-outs
        // are painted in PANEL_FACE — being the face's own yellow is the whole
        // trick, so they must never drift apart.
        constexpr uint32_t INK = 0x141414;
        constexpr float Z = FACE_W + 0.004f, ZCUT = FACE_W + 0.007f;
        // The car, head-on, sized off the PANEL WIDTH — all the room there is.
        // Wide and low (~6:5 including tyres); a squarer silhouette reads as a
        // tower. What makes it a CAR at size is the two cut-outs, the
        // windscreen and the headlamps: without them it is a black blob
        // whatever the outline does. The whole symbol sits a touch low so its
        // top and bottom margins LOOK equal — the panel leans away at the top,
        // where an equal margin subtends less.
        constexpr float CAR_Y = 0.135f;                     // car centre up the panel
        constexpr float TYRE_V = -0.18f, SILL = -0.105f, SHOULDER = 0.04f, ROOF = 0.18f;
        constexpr float ROOF_HW = 0.122f, SHLD_HW = 0.215f; // cabin, flaring down to the body
        constexpr float BODY_LO = 0.205f;                   // body tucks in a touch at the bumper
        constexpr float TYRE_LO = 0.100f, TYRE_HI = 0.185f; // wheel tabs, yellow showing between
        constexpr float SCR_HI = 0.152f, SCR_LO = 0.058f;   // windscreen, inset in the cabin
        constexpr float SCR_HW_HI = 0.108f, SCR_HW_LO = 0.168f;
        constexpr float LAMP_U = 0.140f, LAMP_V = -0.036f, LAMP_R = 0.042f;
        // The tracks: no longer than the car is tall — this is a car with skid
        // marks, not skid marks with a car on top. Only the SPLAY is mirrored;
        // the wobble is common to both, because these are one car's two tyres
        // and they swing left and right together. Mirroring the wobble too made
        // the pair pinch and splay like a bowtie, which no skid does.
        constexpr float TRACK_V0 = -0.01f, TRACK_V1 = -0.35f;
        constexpr float TRACK_U0 = 0.085f, TRACK_U1 = 0.185f;
        constexpr float SPLAY_EXP = 1.25f;                  // fans late: close under the car
        constexpr float WOB = 0.058f, WAVES = 1.45f;
        constexpr float WOB_FADE = 0.72f;                   // straight run-out at the tail
        // One width end to end. A taper into a flared foot was tried and read
        // as a paint drip rather than a tyre print — and it is the stroke that
        // caps the wobble, since the ribbon folds on the inside of its own
        // bends once the turn radius (~1/(WOB·WAVES²)) drops under the
        // half-stroke. Even and thin buys the wobble its room.
        constexpr float STROKE = 0.020f;
        mSignMeshes.resize(spots.size());
        mConeStates.resize(spots.size());
        auto& tcm = mEngine->getTransformManager();
        for (size_t i = 0; i < spots.size(); i++) {
            Mesh& m = mSignMeshes[i];
            const auto panel = [&](int sd) {
                // Panel frame: foot → ridge is "up", the sign's width is x.
                const float3 up = normalize(float3{ 0, RIDGE, -(float) sd * SPLAY });
                const float3 wide{ (float) sd, 0, 0 };
                const float3 nrm = normalize(cross(wide, up));
                const float3 org{ 0, RIDGE / 2 * S, (float) sd * SPLAY / 2 * S };
                const auto vert = [&](float u, float v, float w) {
                    const float3 p = org + wide * (u * S) + up * (v * S) + nrm * (w * S);
                    return p;
                };
                const float hl = L / 2;
                const auto face = [&](const float3& a, const float3& b, const float3& c,
                        const float3& d, uint32_t hex) {
                    const uint32_t col = packLinear(srgbToLinear(hex), 1.0f);
                    const uint32_t base = (uint32_t) m.verts.size();
                    for (const float3& p : { a, b, c, d }) m.verts.push_back({ p.x, p.y, p.z, col });
                    m.idx.insert(m.idx.end(), { base, base + 2, base + 1,
                                                base + 1, base + 2, base + 3 });
                };
                const auto tri3 = [&](const float3& a, const float3& b, const float3& c,
                        uint32_t hex) {
                    const uint32_t col = packLinear(srgbToLinear(hex), 1.0f);
                    const uint32_t base = (uint32_t) m.verts.size();
                    for (const float3& p : { a, b, c }) m.verts.push_back({ p.x, p.y, p.z, col });
                    m.idx.insert(m.idx.end(), { base, base + 1, base + 2 });
                };
                // Rounded-trapezoid outline, CCW in (u, v) seen from the face.
                const auto rounded = [](float tw, float bw, float h, float rT, float rB, Pt* out) {
                    const Pt cor[4] = { { -tw, h }, { -bw, -h }, { bw, -h }, { tw, h } };
                    const float rad[4] = { rT, rB, rB, rT };
                    int n = 0;
                    for (int c = 0; c < 4; c++) {
                        const Pt prev = cor[(c + 3) & 3], at = cor[c], next = cor[(c + 1) & 3];
                        float au = prev.u - at.u, av = prev.v - at.v;
                        float bu = next.u - at.u, bv = next.v - at.v;
                        const float la = std::sqrt(au * au + av * av);
                        const float lb = std::sqrt(bu * bu + bv * bv);
                        au /= la; av /= la; bu /= lb; bv /= lb;
                        const float dotv = std::max(-1.0f, std::min(1.0f, au * bu + av * bv));
                        const float half = std::acos(dotv) / 2;         // half the interior angle
                        const float r = rad[c];
                        const float back = r / std::tan(half);          // tangent point set-back
                        float xu = au + bu, xv = av + bv;               // inward bisector
                        const float lx = std::sqrt(xu * xu + xv * xv);
                        xu /= lx; xv /= lx;
                        const float hub = r / std::sin(half);           // corner → arc centre
                        const float cu = at.u + xu * hub, cv = at.v + xv * hub;
                        const float a0 = std::atan2(at.v + av * back - cv, at.u + au * back - cu);
                        float a1 = std::atan2(at.v + bv * back - cv, at.u + bu * back - cu);
                        while (a1 - a0 > (float) M_PI) a1 -= TAU;   // sweep the short way
                        while (a1 - a0 < -(float) M_PI) a1 += TAU;
                        for (int k = 0; k <= ARC; k++) {
                            const float a = a0 + (a1 - a0) * k / ARC;
                            out[n++] = { cu + std::cos(a) * r, cv + std::sin(a) * r };
                        }
                    }
                };
                // The face outline is the shell's, inset by the chamfer width.
                // Offsetting the SLANTED sides needs the true perpendicular
                // step, not a plain shave off the half-width.
                const float slope = (botHW - topHW) / (-2 * hl);
                const float perp = BEV * std::sqrt(1 + slope * slope);
                Pt shell[NPT], flat[NPT];
                rounded(topHW, botHW, hl, R_TOP, R_BOT, shell);
                rounded(topHW - slope * BEV - perp, botHW + slope * BEV - perp, hl - BEV,
                        R_TOP - BEV, R_BOT - BEV, flat);
                // Ring between two loops; the first must be the nearer one, which
                // is what puts the winding the right way out.
                const auto ring = [&](const Pt* A, float za, const Pt* B, float zb, uint32_t hex) {
                    for (int k = 0; k < NPT; k++) {
                        const int k2 = (k + 1) % NPT;
                        face(vert(A[k].u, A[k].v, za), vert(A[k2].u, A[k2].v, za),
                             vert(B[k].u, B[k].v, zb), vert(B[k2].u, B[k2].v, zb), hex);
                    }
                };
                const auto fanFill = [&](const Pt* P, float z, uint32_t hex, bool outward) {
                    for (int k = 1; k + 1 < NPT; k++) {
                        const float3 a = vert(P[0].u, P[0].v, z);
                        const float3 b = vert(P[k].u, P[k].v, z);
                        const float3 c = vert(P[k + 1].u, P[k + 1].v, z);
                        if (outward) tri3(a, b, c, hex); else tri3(a, c, b, hex);
                    }
                };
                fanFill(flat, FACE_W, PANEL_FACE, true);        // the printed face
                ring(flat, FACE_W, shell, LIP_W, PANEL_BEV);    // chamfer
                ring(shell, LIP_W, shell, BACK_W, PANEL_WALL);  // side wall
                fanFill(shell, BACK_W, PANEL_WALL, false);      // inside of the A
                const auto band = [&](float vT, float hwT, float vB, float hwB,
                        float z, uint32_t hex) {
                    face(vert(-hwT, CAR_Y + vT, z), vert(hwT, CAR_Y + vT, z),
                         vert(-hwB, CAR_Y + vB, z), vert(hwB, CAR_Y + vB, z), hex);
                };
                band(ROOF, ROOF_HW, SHOULDER, SHLD_HW, Z, INK);  // cabin, flaring outward
                band(SHOULDER, SHLD_HW, SILL, BODY_LO, Z, INK);  // body + grille
                for (const float sd2 : { -1.0f, 1.0f }) {        // wheel tabs under the sill
                    const float a = sd2 < 0 ? -TYRE_HI : TYRE_LO;
                    const float b = sd2 < 0 ? -TYRE_LO : TYRE_HI;
                    face(vert(a, CAR_Y + SILL, Z), vert(b, CAR_Y + SILL, Z),
                         vert(a, CAR_Y + TYRE_V, Z), vert(b, CAR_Y + TYRE_V, Z), INK);
                }
                band(SCR_HI, SCR_HW_HI, SCR_LO, SCR_HW_LO, ZCUT, PANEL_FACE); // windscreen
                const auto lamp = [&](float cu) {
                    constexpr int SEG = 12;
                    const uint32_t col = packLinear(srgbToLinear(PANEL_FACE), 1.0f);
                    const uint32_t base = (uint32_t) m.verts.size();
                    const float3 c0 = vert(cu, CAR_Y + LAMP_V, ZCUT);
                    m.verts.push_back({ c0.x, c0.y, c0.z, col });
                    for (int j = 0; j <= SEG; j++) {
                        const float a = (float) j / SEG * TAU;
                        const float3 p = vert(cu + std::cos(a) * LAMP_R,
                                CAR_Y + LAMP_V + std::sin(a) * LAMP_R, ZCUT);
                        m.verts.push_back({ p.x, p.y, p.z, col });
                    }
                    for (uint32_t j = 0; j < SEG; j++) {
                        m.idx.insert(m.idx.end(), { base, base + 1 + j, base + 2 + j });
                    }
                };
                lamp(-LAMP_U);
                lamp(LAMP_U);
                // Each track is swept PERPENDICULAR to its own path, so the
                // stroke keeps its weight through the curves instead of
                // squashing wherever the path runs diagonally.
                const auto skid = [&](float sd2) {
                    constexpr int SEG = 26;
                    constexpr float DV = TRACK_V1 - TRACK_V0;   // v is linear in t
                    constexpr float TAIL = 1.0f - WOB_FADE;
                    float pu = 0, pv = 0, pnu = 0, pnv = 0;
                    for (int j = 0; j <= SEG; j++) {
                        const float t = (float) j / SEG;
                        const float ph = t * WAVES * TAU;
                        const float fan = std::pow(t, SPLAY_EXP);
                        const float ease = t < WOB_FADE ? 1.0f : (1.0f - t) / TAIL;
                        const float dease = t < WOB_FADE ? 0.0f : -1.0f / TAIL;
                        const float wob = WOB * ease * std::sin(ph);
                        const float u = sd2 * (TRACK_U0 + (TRACK_U1 - TRACK_U0) * fan) + wob;
                        const float v = TRACK_V0 + DV * t;
                        const float dfan = t > 0 ? SPLAY_EXP * std::pow(t, SPLAY_EXP - 1) : 0.0f;
                        const float du = sd2 * (TRACK_U1 - TRACK_U0) * dfan
                                + WOB * (dease * std::sin(ph)
                                        + ease * WAVES * TAU * std::cos(ph));
                        const float inv = STROKE / std::sqrt(du * du + DV * DV);
                        const float nu = DV * inv, nv = -du * inv; // |n| = half-stroke, to the left
                        if (j) {
                            face(vert(pu + pnu, pv + pnv, Z), vert(pu - pnu, pv - pnv, Z),
                                 vert(u + nu, v + nv, Z), vert(u - nu, v - nv, Z), INK);
                        }
                        pu = u; pv = v; pnu = nu; pnv = nv;
                    }
                };
                skid(-1.0f);
                skid(1.0f);
            };
            panel(1);
            panel(-1);
            // The hinge, in the SIGN's own frame (x across, y up off the road,
            // z fore-aft) rather than either panel's: it belongs to both. Both
            // panel tops land exactly on (0, RIDGE, 0), so a barrel there
            // swallows the seam.
            {
                const auto barrel = [&](float x, float a) {
                    return float3{ x * S, (RIDGE + std::sin(a) * HINGE_R) * S,
                                   std::cos(a) * HINGE_R * S };
                };
                for (int k = 0; k < HINGE_SEG; k++) {
                    const float a0 = (float) k / HINGE_SEG * TAU;
                    const float a1 = (float) (k + 1) / HINGE_SEG * TAU;
                    const float3 A = barrel(-HINGE_HW, a0), B = barrel(HINGE_HW, a0);
                    const float3 C = barrel(-HINGE_HW, a1), D = barrel(HINGE_HW, a1);
                    const uint32_t col = packLinear(srgbToLinear(PANEL_WALL), 1.0f);
                    const uint32_t base = (uint32_t) m.verts.size();
                    for (const float3& p : { A, B, C, D }) {
                        m.verts.push_back({ p.x, p.y, p.z, col });
                    }
                    m.idx.insert(m.idx.end(), { base, base + 1, base + 2,
                                                base + 1, base + 3, base + 2 });
                    // Knuckle ends, so the barrel is a closed solid.
                    for (const float end : { -HINGE_HW, HINGE_HW }) {
                        const float3 hub{ end * S, RIDGE * S, 0 };
                        const float3 p0 = barrel(end, a0), p1 = barrel(end, a1);
                        const uint32_t cb = (uint32_t) m.verts.size();
                        for (const float3& p : { hub, p0, p1 }) {
                            m.verts.push_back({ p.x, p.y, p.z, col });
                        }
                        if (end < 0) m.idx.insert(m.idx.end(), { cb, cb + 1, cb + 2 });
                        else         m.idx.insert(m.idx.end(), { cb, cb + 2, cb + 1 });
                    }
                }
            }
            accumulateNormals(m);
            buildMesh(m);
            const TrackBin::Sample f = tb.frameAt(spots[i].s);
            // Cones are radial, but the A-frame has a front and a back: stand it
            // on the road normal with its faces along the track.
            const mat4f home = f.basis(spots[i].lat);
            mConeStates[i].home = home;
            mConeStates[i].quat = mat3f(home.upperLeft()).toQuaternion();
            mConeStates[i].pos = home[3].xyz;
            mConeStates[i].homeS = spots[i].s;
            mConeStates[i].radius = botHW * S;
            mConeStates[i].loY = 0;
            mConeStates[i].hiY = (RIDGE + HINGE_R) * S; // the barrel is the high point now
            tcm.setTransform(tcm.getInstance(m.entity), home);
        }
    } else if (!spots.empty()) {
        mConeAsset = loadInstancedProp("item-cone.glb", spots.size(), mConeInstances);
        if (mConeAsset) {
            auto& tcm = mEngine->getTransformManager();
            mConeStates.resize(spots.size());
            // Silhouette proxy for the ground clamp: a cone's lowest point under
            // any rotation is on its base rim or at the apex, so those points
            // alone reproduce the JS's sampled-vertex _groundOffset exactly.
            float coneR = 0.1f, coneLo = 0.0f, coneHi = 0.3f;
            {
                const filament::Aabb bb = mConeAsset->getBoundingBox();
                if (bb.max.y > bb.min.y) {
                    coneLo = bb.min.y;
                    coneHi = bb.max.y;
                    coneR = std::max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) * 0.5f;
                }
            }
            for (size_t i = 0; i < spots.size(); i++) {
                const TrackBin::Sample f = tb.frameAt(spots[i].s);
                const mat4f home = f.basis(spots[i].lat);
                mConeStates[i].home = home;
                mConeStates[i].quat = mat3f(home.upperLeft()).toQuaternion();
                mConeStates[i].pos = home[3].xyz;
                mConeStates[i].homeS = spots[i].s;
                mConeStates[i].radius = coneR;
                mConeStates[i].loY = coneLo;
                mConeStates[i].hiY = coneHi;
                tcm.setTransform(tcm.getInstance(mConeInstances[i]->getRoot()), home);
            }
        }
    }
}

bool TtpRenderer::buildScene(const ttp::RaceTrack& geo, const ttp::rt::Theme& theme,
        const std::vector<TtpRosterCar>& roster) {
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
    const auto vground = mAssets.find("vground.filamat");
    if (!mGroundMaterial && vground != mAssets.end()) {
        mGroundMaterial = Material::Builder()
                .package(vground->second.data(), vground->second.size())
                .build(*mEngine);
    }
    const auto vdecal = mAssets.find("vdecal.filamat");
    if (!mDecalMaterial && vdecal != mAssets.end()) {
        mDecalMaterial = Material::Builder()
                .package(vdecal->second.data(), vdecal->second.size())
                .build(*mEngine);
    }
    const auto vpoint = mAssets.find("vpoint.filamat");
    if (!mPointMaterial && vpoint != mAssets.end()) {
        mPointMaterial = Material::Builder()
                .package(vpoint->second.data(), vpoint->second.size())
                .build(*mEngine);
    }
    const auto vburst = mAssets.find("vburst.filamat");
    if (!mBurstMaterial && vburst != mAssets.end()) {
        mBurstMaterial = Material::Builder()
                .package(vburst->second.data(), vburst->second.size())
                .build(*mEngine);
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
    }
    ensureSceneTarget(); // between frames — the material only lands now
    // No "track.bin" gate here any more, and nothing replaces it: the scene is
    // a function of `geo` and `theme`, both of which the caller HAS (they are
    // C++ objects, not payloads that might be missing). An empty roster is a
    // legal scene — it is what the lobby's track preview is before any car
    // joins it.
    mHasTrack = true;
    // Sky: flat daylight blue behind the gradient dome (which the fog dissolves
    // into) — a backstop for the sliver the dome doesn't cover.
    mSkybox = Skybox::Builder()
            .color(float4{ 0.53f, 0.78f, 0.92f, 1.0f })
            .build(*mEngine);
    mScene->setSkybox(mSkybox);
    return buildTrackScene(roster, geo, theme);
}

// Filament's exponential fog standing in for a three.js LINEAR ramp [near,
// far]. Fitted by least squares WEIGHTED BY SCREEN AREA (a ground plane at
// distance d covers ∝1/d² pixels, so the near half of the ramp carries most of
// the frame): onset a fifteenth of the span past `near`, density 1.85 over the
// span. At the shipped race profile (70 → 170) that is 77.5 / 0.0185 — mean
// |Δfog| 0.055 against the ramp, where fitting the far end alone crushed the
// middle and a uniform-weight fit under-fogged the near deck.
static View::FogOptions fogFor(float near, float far, const float3& color) {
    View::FogOptions fog{};
    fog.color = color;
    fog.heightFalloff = 0.0f;
    fog.cutOffDistance = 400.0f; // keeps the SKY_R dome unfogged (fog:false in the JS)
    if (!(far > near)) { fog.enabled = false; return fog; }
    const float span = far - near;
    fog.distance = near + 0.075f * span;
    fog.density = 1.85f / span;
    fog.enabled = true;
    return fog;
}

// The scene buffer (canvas-sized RGBA8 + depth) all the cells draw into, plus
// the one-triangle view that grades it onto the canvas. Creation only — the
// teardown half lives in resize(), because freeing a target the views still
// point at has to happen BETWEEN frames: doing it inside beginFrame/endFrame
// (which is where render() would notice a size change) aborts the module.
// Without vpresent.filamat this does nothing and the cells fall back to
// Filament's own post chain — an old asset set still renders, just slower.
void TtpRenderer::ensureSceneTarget() {
    if (!mPresentMaterial || !mWidth || !mHeight || mSceneRT) return;
    // R11F_G11F_B10F, LINEAR: four bytes a pixel, same as the RGBA8 three uses
    // here, but floating point. Three can afford 8 bits because its banding is
    // its OWN shading quantised; ours would be a DIFFERENT shading quantised,
    // and a linear 8-bit step becomes a whole visible sRGB step once the
    // present pass expands the darks — the parity diff rose measurably (4.0 →
    // 4.5 mean |Δ| over the frame catalogue) purely from that. The float buffer
    // is what Filament's own post chain used before we took it over, and it
    // costs nothing extra to keep. No alpha channel: the view is OPAQUE and the
    // present ignores it (blending reads source alpha, not destination).
    mSceneColor = Texture::Builder()
            .width(mWidth).height(mHeight).levels(1)
            .usage(Texture::Usage::COLOR_ATTACHMENT | Texture::Usage::SAMPLEABLE)
            .format(Texture::InternalFormat::R11F_G11F_B10F)
            .build(*mEngine);
    mSceneDepth = Texture::Builder()
            .width(mWidth).height(mHeight).levels(1)
            .usage(Texture::Usage::DEPTH_ATTACHMENT)
            .format(Texture::InternalFormat::DEPTH32F)
            .build(*mEngine);
    mSceneRT = RenderTarget::Builder()
            .texture(RenderTarget::AttachmentPoint::COLOR, mSceneColor)
            .texture(RenderTarget::AttachmentPoint::DEPTH, mSceneDepth)
            .build(*mEngine);

    if (!mPresentInstance) {
        mPresentInstance = mPresentMaterial->createInstance();
        mPresentInstance->setParameter("exposure", 1.1f); // SceneRenderer DEF_EXPOSURE
        // The fullscreen triangle, in clip space (vertexDomain:device), exactly
        // as Filament builds its own: one triangle, no camera, no transform.
        static const math::float4 verts[3] = {
            { -1.0f, -1.0f, 1.0f, 1.0f },
            {  3.0f, -1.0f, 1.0f, 1.0f },
            { -1.0f,  3.0f, 1.0f, 1.0f },
        };
        static const uint16_t indices[3] = { 0, 1, 2 };
        mPresentVB = VertexBuffer::Builder()
                .vertexCount(3).bufferCount(1)
                .attribute(VertexAttribute::POSITION, 0,
                        VertexBuffer::AttributeType::FLOAT4, 0, sizeof(math::float4))
                .build(*mEngine);
        mPresentVB->setBufferAt(*mEngine, 0,
                VertexBuffer::BufferDescriptor(verts, sizeof(verts), nullptr));
        mPresentIB = IndexBuffer::Builder()
                .indexCount(3).bufferType(IndexBuffer::IndexType::USHORT)
                .build(*mEngine);
        mPresentIB->setBuffer(*mEngine,
                IndexBuffer::BufferDescriptor(indices, sizeof(indices), nullptr));
        mPresentQuad = utils::EntityManager::get().create();
        RenderableManager::Builder(1)
                .boundingBox({ { 0, 0, 0 }, { 1, 1, 1 } })
                .material(0, mPresentInstance)
                .geometry(0, RenderableManager::PrimitiveType::TRIANGLES,
                        mPresentVB, mPresentIB, 0, 3)
                .culling(false)          // clip-space verts: the box means nothing
                .castShadows(false).receiveShadows(false)
                .build(*mEngine, mPresentQuad);
        mPresentScene = mEngine->createScene();
        mPresentScene->addEntity(mPresentQuad);
        mPresentCameraEntity = utils::EntityManager::get().create();
        mPresentCamera = mEngine->createCamera(mPresentCameraEntity);
        mPresentCamera->setProjection(Camera::Projection::ORTHO, -1, 1, -1, 1, 0, 1);
        mPresentView = mEngine->createView();
        mPresentView->setScene(mPresentScene);
        mPresentView->setCamera(mPresentCamera);
        mPresentView->setPostProcessingEnabled(false); // we ARE the post chain
        mPresentView->setShadowingEnabled(false);
        mPresentView->setFrustumCullingEnabled(false);
    }
    TextureSampler sampler(TextureSampler::MinFilter::LINEAR, TextureSampler::MagFilter::LINEAR);
    sampler.setWrapModeS(TextureSampler::WrapMode::CLAMP_TO_EDGE);
    sampler.setWrapModeT(TextureSampler::WrapMode::CLAMP_TO_EDGE);
    mPresentInstance->setParameter("scene", mSceneColor, sampler);
    mPresentInstance->setParameter("texel",
            math::float2{ 1.0f / (float) mWidth, 1.0f / (float) mHeight });
    mPresentView->setViewport({ 0, 0, mWidth, mHeight });
}

// Between frames only (resize / teardown): the views and the present instance
// still reference these, so drop those references and let the driver drain
// before freeing.
void TtpRenderer::destroySceneTarget() {
    if (!mSceneRT) return;
    for (View* v : mCellViews) v->setRenderTarget(nullptr);
    mEngine->flushAndWait();
    mEngine->destroy(mSceneRT); mSceneRT = nullptr;
    mEngine->destroy(mSceneColor); mSceneColor = nullptr;
    mEngine->destroy(mSceneDepth); mSceneDepth = nullptr;
}

void TtpRenderer::ensureCells(uint32_t count) {
    while (mCellViews.size() < count) {
        View* v = mEngine->createView();
        utils::Entity camEnt = utils::EntityManager::get().create();
        Camera* cam = mEngine->createCamera(camEnt);
        v->setCamera(cam);
        v->setScene(mScene);
        // Nothing in this scene casts a Filament shadow (the sun's map is baked
        // once per track — see bakeShadowMap) and nothing refracts, but a View
        // defaults both systems ON and re-asks every frame, per cell. Say no
        // once instead.
        v->setShadowingEnabled(false);
        v->setScreenSpaceRefractionEnabled(false);
        if (mPresentMaterial) {
            // Post OFF: the cells write plain linear colour into the shared
            // scene buffer and vpresent grades + antialiases the lot in ONE
            // pass, instead of two per cell (see vpresent.mat). Nothing is lost
            // doing it ourselves — every material here is unlit and writes its
            // own final colour, so Filament's tonemap had nothing to undo.
            v->setPostProcessingEnabled(false);
        } else {
            // No vpresent.filamat provided: fall back to Filament's chain, with
            // the linear tonemap + 1.1 exposure grade three's present applies.
            if (!mColorGrading) {
                mToneMapper = new LinearToneMapper();
                mColorGrading = ColorGrading::Builder()
                        .toneMapper(mToneMapper)
                        .exposure(0.1375f) // stops: 2^0.1375 ≈ 1.1
                        .build(*mEngine);
            }
            v->setPostProcessingEnabled(true);
            View::RenderQuality rq{};
            rq.hdrColorBuffer = View::QualityLevel::MEDIUM;
            v->setRenderQuality(rq);
            v->setColorGrading(mColorGrading);
            v->setAntiAliasing(View::AntiAliasing::FXAA);
        }
        mCellViews.push_back(v);
        mCellCameras.push_back(cam);
        mCellCameraEntities.push_back(camEnt);
    }
}

// ---------------------------------------------------------------------------
// The 2D cell overlay: the split-screen dividers and the per-player steer bar.
//
// The rule that admits these two and nothing else is in voverlay.mat, which also
// carries why they composite in sRGB. What lives here is the plumbing: a pool of
// unit quads through one ortho camera in PIXEL space, drawn straight onto the
// swap chain AFTER the present pass.
// ---------------------------------------------------------------------------

// 0xRRGGBB as it is written on screen. NOT srgbToLinear: this pass runs past the
// grade, so the value written IS the panel value (see voverlay.mat).
static float3 hudRgb(uint32_t rgb) {
    return { ((rgb >> 16) & 0xff) / 255.0f, ((rgb >> 8) & 0xff) / 255.0f,
             (rgb & 0xff) / 255.0f };
}

void TtpRenderer::ensureOverlay() {
    if (mOverlayView || !mOverlayMaterial) return;
    // The unit quad every element scales out of. Positions only — the material
    // needs no vertex colour, and its one varying is derived from the position.
    static const float3 verts[4] = {
        { 0, 0, -1 }, { 1, 0, -1 }, { 1, 1, -1 }, { 0, 1, -1 },
    };
    static const uint16_t indices[6] = { 0, 1, 2, 0, 2, 3 };
    mOverlayVB = VertexBuffer::Builder()
            .vertexCount(4).bufferCount(1)
            .attribute(VertexAttribute::POSITION, 0,
                    VertexBuffer::AttributeType::FLOAT3, 0, sizeof(float3))
            .build(*mEngine);
    mOverlayVB->setBufferAt(*mEngine, 0,
            VertexBuffer::BufferDescriptor(verts, sizeof(verts), nullptr));
    mOverlayIB = IndexBuffer::Builder()
            .indexCount(6).bufferType(IndexBuffer::IndexType::USHORT)
            .build(*mEngine);
    mOverlayIB->setBuffer(*mEngine,
            IndexBuffer::BufferDescriptor(indices, sizeof(indices), nullptr));

    mOverlayScene = mEngine->createScene(); // deliberately lightless
    mOverlayCameraEntity = utils::EntityManager::get().create();
    mOverlayCamera = mEngine->createCamera(mOverlayCameraEntity);
    mOverlayView = mEngine->createView();
    mOverlayView->setScene(mOverlayScene);
    mOverlayView->setCamera(mOverlayCamera);
    // TRANSLUCENT is what makes this an OVERLAY: the view blends onto whatever
    // the present pass already put on the canvas instead of replacing it.
    mOverlayView->setBlendMode(View::BlendMode::TRANSLUCENT);
    mOverlayView->setPostProcessingEnabled(false); // we are past the grade
    mOverlayView->setShadowingEnabled(false);
    mOverlayView->setFrustumCullingEnabled(false);
}

MaterialInstance* TtpRenderer::overlayQuad(float x, float y, float w, float h) {
    if (!mOverlayMaterial || w <= 0 || h <= 0) return nullptr;
    ensureOverlay();
    if (mOverlayQuads.size() <= mOverlayUsed) {
        OverlayQuad q;
        q.mi = mOverlayMaterial->createInstance();
        q.entity = utils::EntityManager::get().create();
        RenderableManager::Builder(1)
                .boundingBox({ { 0, 0, 0 }, { 1, 1, 1 } })
                .material(0, q.mi)
                .geometry(0, RenderableManager::PrimitiveType::TRIANGLES,
                        mOverlayVB, mOverlayIB, 0, 6)
                .culling(false)
                .castShadows(false).receiveShadows(false)
                .build(*mEngine, q.entity);
        mOverlayQuads.push_back(q);
    }
    OverlayQuad& q = mOverlayQuads[mOverlayUsed++];
    if (!q.inScene) { mOverlayScene->addEntity(q.entity); q.inScene = true; }
    // ttp_grid_cell measures from the TOP left, like the DOM and like every
    // consumer of the answer; the ortho camera below is ordinary GL, measuring
    // from the bottom. This is the one flip — the same one the cell viewports
    // make. It costs the shapes nothing: both are symmetric about their own
    // horizontal midline, so the material never has to know which way is up.
    auto& tcm = mEngine->getTransformManager();
    tcm.setTransform(tcm.getInstance(q.entity),
            mat4f::translation(float3{ x, (float) mHeight - y - h, 0 })
                    * mat4f::scaling(float3{ w, h, 1 }));
    q.mi->setParameter("size", float2{ w, h });
    return q.mi;
}

void TtpRenderer::drawOverlay(const TtpFrameInput& input) {
    const uint32_t before = mOverlayUsed;
    mOverlayUsed = 0;
    if (mOverlayMaterial && input.hudCount && mWidth && mHeight) {
        // Physical pixels per UI point. Every size below is the CSS number out
        // of display.css, so this is the only place the two units meet.
        const float s = input.uiScale > 0 ? input.uiScale : 1.0f;
        const float4 ink{ hudRgb(TTP_HUD_INK), 1.0f };
        const float3 surface = hudRgb(TTP_HUD_SURFACE);
        const uint32_t n = input.hudCount;

        // .cell-divider — a 4 px ink rule down every seam that has cells on both
        // sides, SPANNING THE WHOLE CANVAS, deduplicated exactly as the DOM's
        // loop was: one rule per distinct cell edge, not one per cell.
        //
        // The seam positions come from cellRectTopLeft, the letterboxed grid the
        // shell is also handed. For every layout this game can produce that is
        // the same number ttp_grid_cell gave (a 2-column seam is at W/2 either
        // way, and 3+ columns needs 5 players), so this is about being derived
        // from one grid rather than two, not about moving a line.
        //
        // The SPAN stays the canvas, and that is deliberate rather than an
        // oversight: clipping the rules to the picture is visibly wrong on the
        // STACKED PAIR, which is not an exotic layout but the ordinary 2-player
        // one — a 16:9 surface splits into two 3.56:1 cells, which is past
        // CELL_MAX_ASPECT, so the picture is inset with bars either side and the
        // rule between the two views would stop short of the screen edges.
        // tests/e2e/flow.spec.js samples that seam row and holds this.
        if (input.flags & TTP_FRAME_DIVIDERS) {
            uint32_t xs[8], ys[8], nx = 0, ny = 0;
            for (uint32_t i = 0; i < n; i++) {
                const TtpCellRect r = cellRectTopLeft(n, i);
                bool seen = false;
                for (uint32_t k = 0; k < nx; k++) seen = seen || xs[k] == r.x;
                if (r.x > 0 && !seen && nx < 8) xs[nx++] = r.x;
                seen = false;
                for (uint32_t k = 0; k < ny; k++) seen = seen || ys[k] == r.y;
                if (r.y > 0 && !seen && ny < 8) ys[ny++] = r.y;
            }
            // rgba(42, 39, 53, 0.88) — the ink, let through by the tiniest bit.
            const float4 rule{ ink.xyz, 0.88f };
            for (uint32_t k = 0; k < nx; k++) {
                if (MaterialInstance* mi =
                            overlayQuad(xs[k] - 2 * s, 0, 4 * s, (float) mHeight)) {
                    mi->setParameter("shape", float3{ 0, 0, 0 });
                    mi->setParameter("fill", float3{ 0, 0, 0 });
                    mi->setParameter("ink", rule);
                    mi->setParameter("surface", surface);
                    mi->setParameter("bar", surface);
                }
            }
            for (uint32_t k = 0; k < ny; k++) {
                if (MaterialInstance* mi =
                            overlayQuad(0, ys[k] - 2 * s, (float) mWidth, 4 * s)) {
                    mi->setParameter("shape", float3{ 0, 0, 0 });
                    mi->setParameter("fill", float3{ 0, 0, 0 });
                    mi->setParameter("ink", rule);
                    mi->setParameter("surface", surface);
                    mi->setParameter("bar", surface);
                }
            }
        }

        // .cell-steer — width clamp(190px, 16.5vw, 270px), height 34, border 4,
        // pill radius, bottom-anchored 61 above the cell's bottom edge and
        // centred on it. The viewport the 16.5vw measures is this SURFACE: a TV
        // shell has no second viewport behind its canvas, and taking one from
        // the browser would put a web idea back into the contract.
        const float barW = std::max(190 * s, std::min(0.165f * mWidth, 270 * s));
        const float barH = 34 * s, border = 4 * s;
        const float innerW = barW - 2 * border, innerH = barH - 2 * border;
        const TtpCellHudInput* hud = ttp_frame_hud(&input);
        for (uint32_t i = 0; i < n; i++) {
            if (!(hud[i].flags & TTP_HUD_STEER_BAR)) continue;
            const TtpCellRect cell = cellRectTopLeft(n, i);
            MaterialInstance* mi = overlayQuad(cell.x + (cell.w - barW) * 0.5f,
                    cell.y + cell.h - 61 * s, barW, barH);
            if (!mi) continue;
            // The livery this cell's car wears, straight off the roster the
            // renderer baked its model from — the shell never restates it.
            float3 bar = surface;
            if (mTrack && hud[i].car >= 0
                    && (size_t) hud[i].car < mTrack->carColors.size()) {
                const uint32_t abgr = mTrack->carColors[hud[i].car];
                bar = hudRgb(((abgr & 0xff) << 16) | (abgr & 0xff00)
                        | ((abgr >> 16) & 0xff));
            }
            // .cell-steer__fill: half the interior wide, centred, translated by
            // 50 % of ITS OWN width per unit of tilt — so full lock puts the
            // fill's edge on the interior's edge and never past it.
            mi->setParameter("shape", float3{ barH * 0.5f, border, 3 * s });
            mi->setParameter("fill",
                    float3{ border + innerW * (0.25f + 0.25f * hud[i].steer),
                            innerW * 0.5f, innerH * 0.5f });
            mi->setParameter("ink", ink);
            mi->setParameter("surface", surface);
            mi->setParameter("bar", bar);
        }
    }
    // Retire what this frame did not claim. Scene membership, not a parked
    // transform: the pool outlives every split it ever drew.
    for (uint32_t i = mOverlayUsed; i < before && i < mOverlayQuads.size(); i++) {
        if (!mOverlayQuads[i].inScene) continue;
        mOverlayScene->remove(mOverlayQuads[i].entity);
        mOverlayQuads[i].inScene = false;
    }
    if (mOverlayUsed && mOverlayView) {
        mOverlayView->setViewport({ 0, 0, mWidth, mHeight });
        mOverlayCamera->setProjection(Camera::Projection::ORTHO,
                0, (double) mWidth, 0, (double) mHeight, 0, 2);
    }
}

// Diagnostic frame profiler. std::chrono::steady_clock is what emscripten maps
// to performance.now(); on the native shells it is the monotonic clock. A dozen
// reads a frame is far below the noise of what it measures.
static double ttpNowMs() {
    using namespace std::chrono;
    return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}

const char* const* TtpRenderer::profileNames() {
    static const char* names[] = { "cars", "world", "skids", "ambient",
            "beginFrame", "cellSetup", "cellRender", "present", "endFrame",
            "total", nullptr };
    return names;
}

bool TtpRenderer::render(const TtpFrameInput& input) {
    if (input.version != TTP_FRAME_INPUT_VERSION) return false;
    // Every wall-clock cosmetic phases off the DRIVING scene's clock — an own
    // accumulated clock would drift by the boot-time difference between the
    // two renderers (the balloon hung at a different bearing).
    mTime = input.sceneT;
    const double tFrame0 = ttpNowMs();
    double tMark = tFrame0;
    auto& tcm = mEngine->getTransformManager();

    // Cars follow the contract poses: basis (right, up, forward) + pos. GLB
    // assets get an extra half-turn — Kenney vehicles are modelled facing -Z
    // (same fix as the Three.js renderer's base yaw).
    const TtpCarInput* cars = ttp_frame_cars(&input);
    const uint32_t nCars = std::min<uint32_t>(input.carCount, (uint32_t) mCars.size());
    // Conformed car positions, kept for the props that test against the car's
    // RENDERED spot (cone kicks) rather than the raw contract pose.
    std::vector<float3> carPosW(nCars);
    for (uint32_t i = 0; i < nCars; i++) {
        const TtpCarInput& c = cars[i];
        const float3 fwd = { c.forward.x, c.forward.y, c.forward.z };
        const float3 up = { c.up.x, c.up.y, c.up.z };
        const float3 right = normalize(cross(up, fwd));
        // ── Ground-conform (SceneRenderer setCarPose) ───────────────────────
        // The contract pose rides the CENTRELINE; the rendered ribbon sits a
        // little off it (arclength faceting, the profile's crown, the bank at
        // the car's lateral offset), so following it directly sinks the body
        // in. Probe the ribbon under both axles and ride the axle MEAN — the
        // body is pitched to the axle chord, so the mean is where both axles
        // touch. The centre probe survives as a crest guard (ride the peak
        // where the deck bulges above the chord). Damp the OFFSET from the
        // smooth centreline, not the absolute height: the probes jump at deck
        // seams, and the climb itself already lives in pos.y. `stunt` fades the
        // straight-down probe out once the deck rolls past ~14° (meaningless on
        // a loop wall) and lifts along the frame's up instead.
        float3 carPos = { c.pos.x, c.pos.y, c.pos.z };
        if (mHasTrack && i < mCarWheels.size()) {
            constexpr float RIDE_HEIGHT = -0.004f, RIDE_DAMP = 18.0f;
            CarWheels& rw = mCarWheels[i];
            const float stunt = std::min(1.0f, std::max(0.0f, (0.97f - up.y) / 0.10f));
            if (stunt < 1) {
                float3 flat = { fwd.x, 0, fwd.z };
                const float fl = length(flat);
                if (fl > 1e-3f) {
                    flat /= fl;
                    const float half = rw.wheelbase * 0.5f;
                    bool okC = false, okF = false, okB = false;
                    const float yC = roadHitY(carPos.x, carPos.z, carPos.y, &okC);
                    const float yF = roadHitY(carPos.x + flat.x * half,
                            carPos.z + flat.z * half, carPos.y, &okF);
                    const float yB = roadHitY(carPos.x - flat.x * half,
                            carPos.z - flat.z * half, carPos.y, &okB);
                    bool onRoad = false;
                    float roadY = 0;
                    if (okF && okB) {
                        const float mid = (yF + yB) * 0.5f;
                        roadY = okC ? std::max(mid, yC) : mid;
                        onRoad = true;
                    } else if (okC) {
                        roadY = yC; // off the edge / gate seam: centre probe only
                        onRoad = true;
                    }
                    if (onRoad) {
                        const float offTarget = roadY - carPos.y;
                        const float a = 1.0f - std::exp(-RIDE_DAMP * input.dt);
                        rw.rideOff = rw.hasRide ? rw.rideOff + (offTarget - rw.rideOff) * a
                                                : offTarget;
                        rw.hasRide = true;
                        carPos.y = c.pos.y + (rw.rideOff + RIDE_HEIGHT) * (1 - stunt);
                    }
                }
            } else {
                rw.hasRide = false; // re-seed the damped offset coming off a stunt
            }
            if (stunt > 0) carPos += up * (RIDE_HEIGHT * stunt);
        }
        carPosW[i] = carPos;
        float carS = 0, carLat = 0;   // this car's spot on the ribbon, projected once
        bool haveCarS = false;
        const mat4f m{ float4{ right, 0 }, float4{ up, 0 }, float4{ fwd, 0 },
                       float4{ carPos, 1 } };
        if (mCarAssets.size() > i && mCarAssets[i]) {
            static const mat4f FLIP = mat4f::rotation(M_PI, float3{ 0, 1, 0 });
            // Spin-out whirl (oil, lightning): the JS yaws the whole model by
            // c.spin on top of its base yaw (car.rotation.y = baseYaw + spin).
            const mat4f base = (c.spin != 0)
                    ? m * mat4f::rotation(c.spin, float3{ 0, 1, 0 }) * FLIP
                    : m * FLIP;
            // Body lean + weight transfer — SceneRenderer setCarPose verbatim:
            // lean target steer × LEAN_MAX (0.05), smoothed 0.2/frame; pitch
            // from d(spd)/dt of the NORMALIZED spd over PITCH_ACCEL_NORM 0.8,
            // dive gated on real brake (×3, saturates at 1/3 pedal), damped at
            // PITCH_RATE 6/s.
            //
            // The BODY leans, the wheels do NOT: a car banking into a corner
            // rolls on its springs while its tyres stay planted. The JS gets
            // that by reparenting the four wheel nodes (and any exposed axle
            // rod) off the body onto the car group before rolling the body.
            // Here the whole asset hangs off one root transform, so instead
            // the root carries the lean and each wheel's local transform
            // cancels it back out (`bodyRot` below) — the wheel nodes are
            // direct children of the body node with an IDENTITY local frame in
            // every kit GLB, so the plain inverse is the right cancel. Leaning
            // the wheels too was the "whole car tilts on steering" tell.
            mat4f bodyRot{};    // R: the lean/dive the body wears
            mat4f popScale{};   // S: monster morph spring (uniform, commutes)
            if (mCarWheels.size() > i) {
                CarWheels& w = mCarWheels[i];
                w.lean += (c.steer * 0.05f - w.lean) * 0.2f;
                const float dspd = (c.spd - w.prevSpd) / std::max(input.dt, 1e-3f);
                w.prevSpd = c.spd;
                const float pitchAmt = std::max(-1.0f, std::min(1.0f, dspd / 0.8f));
                w.accelNorm = pitchAmt > 0 ? pitchAmt : 0;
                const float diveGate = std::min(1.0f, c.brake * 3.0f);
                const float pitchTarget = -pitchAmt
                        * (pitchAmt < 0 ? 0.08f * diveGate : 0.03f);
                w.pitch += (pitchTarget - w.pitch)
                        * (1.0f - std::exp(-6.0f * input.dt));
                bodyRot = mat4f::rotation(w.pitch * w.pitchSign, float3{ 1, 0, 0 })
                        * mat4f::rotation(w.lean, float3{ 0, 0, 1 });
                // Morph pop (MonsterRig): on a monster edge the WHOLE rig
                // (chassis + grafted body — this pose feeds both) springs
                // 0.5→1 over POP_TIME 0.34 s with the 1.70158 ease-out-back
                // overshoot. (The JS shrink-out animates the outgoing rig,
                // which here parks instantly — both edges pop in.)
                const bool monNow = c.monster > 0.5f;
                if (monNow != w.monsterOn) w.popT = 0.34f;
                w.monsterOn = monNow;
                if (w.popT > 0) {
                    w.popT -= input.dt;
                    const float t = 1.0f - std::max(0.0f, w.popT) / 0.34f;
                    const float u = t - 1.0f;
                    const float k = 1.70158f;
                    const float s = 0.5f + 0.5f * (1.0f + u * u * ((k + 1) * u + k));
                    popScale = mat4f::scaling(float3{ s });
                }
            }
            // Flat = road-aligned, no lean (the monster chassis and its tyres
            // ride this); pose = the leaning body the car model wears.
            const mat4f flat = base * popScale;
            mat4f pose = base * bodyRot * popScale;
            // bodyRot is a product of two rotations, so its inverse is its
            // transpose. filament's inverse() is the general pivoting
            // Gauss-Jordan (~1.4 µs in wasm); the transpose is a few loads.
            const mat4f bodyRotInv = transpose(bodyRot);
            // Monster occlusion fade — SceneRenderer's _monsterBlocksView rule
            // verbatim: in front of the camera, nearer than that cell's own
            // car, and within MONSTER_BLOCK_DIST (3.0) of it. The JS ghosts it
            // PER CELL, and so do we: the test runs per view into a bitmask and
            // the per-view pass below swaps solid/ghost between render() calls
            // (single-threaded, so each cell sees its own state — the same
            // trick the cloud billboards use). A global swap used to ghost the
            // truck in every cell, including its own driver's.
            uint32_t blockMask = 0;
            if (c.monster > 0.5f && input.viewCount > 0) {
                const TtpViewInput* vws = ttp_frame_views(&input);
                const float3 mon = carPos;
                for (uint32_t vi = 0; vi < input.viewCount && vi < input.carCount; vi++) {
                    if (vi == i) continue;
                    const float3 camP = { vws[vi].world[12], vws[vi].world[13], vws[vi].world[14] };
                    const float3 f = float3{ cars[vi].pos.x, cars[vi].pos.y, cars[vi].pos.z } - camP;
                    const float3 mv = mon - camP;
                    if (dot(mv, f) <= 0) continue;               // behind the camera
                    if (dot(mv, mv) >= dot(f, f)) continue;      // beyond the car
                    const float3 d = mon - (camP + f);
                    if (dot(d, d) < 3.0f * 3.0f) blockMask |= (1u << vi);
                }
            }
            static const mat4f MPARK2 = mat4f::translation(float3{ 0, -1000, 0 });
            const bool isMonster = c.monster > 0.5f
                    && mMonsterInstances.size() > i && mMonsterInstances[i];
            // MonsterRig graft: the kit chassis (cab collapsed) rides the pose;
            // the player's own car body — WHEELS STRIPPED — seats the cab slot,
            // bottom-aligned to the slot floor plus MOUNT_LIFT. (The old code
            // lifted the whole car, own wheels and all, by a flat 0.42.)
            //
            // The rig rides FLAT: the JS grafts the body in as a child node and
            // leans only that, so the truck's own chassis and fat tyres stay
            // planted. The graft's lean therefore composes AFTER the mount —
            // it pivots about the cab slot, not about the car's road origin.
            const mat4f rigPose = flat;
            if (isMonster) {
                pose = flat * mat4f::translation(mCarWheels[i].monsterMount) * bodyRot;
            } else if (c.monster > 0.5f && (mMonsterInstances.size() <= i || !mMonsterInstances[i])) {
                pose = pose * mat4f::scaling(float3{ 1.45f, 1.35f, 1.45f }); // no GLB fallback
            }
            // Solid placement now; the per-view pass re-swaps the blocked cells.
            //
            // The monster rig, its ghost and the car's own ghost only exist for
            // one item, so they live OUT of the scene until this car actually
            // needs them (setInstanceInScene / setAssetInScene are edge
            // triggered). Parking them underground instead cost ~78 prepare
            // slots per cell, every frame, for a race in which nobody picks the
            // truck up. `wantGhosts` is deliberately the whole frame's worth:
            // the per-cell pass below decides WHICH cells see the ghost, but
            // membership has to cover any cell that might.
            const bool wantGhosts = isMonster && blockMask != 0;
            if (mMonsterIn.size() > i) {
                setInstanceInScene(mMonsterInstances.size() > i ? mMonsterInstances[i] : nullptr,
                        mMonsterIn[i], isMonster);
            }
            if (mMonsterGhostIn.size() > i) {
                setInstanceInScene(mMonsterGhostInstances.size() > i ? mMonsterGhostInstances[i] : nullptr,
                        mMonsterGhostIn[i], wantGhosts);
            }
            if (mCarGhostIn.size() > i) {
                setAssetInScene(mCarGhostAssets.size() > i ? mCarGhostAssets[i] : nullptr,
                        mCarGhostIn[i], wantGhosts);
            }
            if (isMonster && mMonsterInstances.size() > i && mMonsterInstances[i]) {
                tcm.setTransform(tcm.getInstance(mMonsterInstances[i]->getRoot()), rigPose);
            }
            tcm.setTransform(tcm.getInstance(mCarAssets[i]->getRoot()), pose);
            if (mMonsterViews.size() > i) {
                MonsterView& mv = mMonsterViews[i];
                mv.on = isMonster;
                mv.mask = blockMask;
                mv.rig = rigPose;
                mv.body = pose;
            }
            // Rear name plate rides the body pose (banks/dives/pops with it).
            // It's a child of the NORMAL body in the JS, so it vanishes with
            // the car while the monster transform is up.
            if (mPlates.size() > i && !mPlates[i].entity.isNull()) {
                tcm.setTransform(tcm.getInstance(mPlates[i].entity),
                        isMonster ? MPARK2 : pose);
            }
            // Wheel cosmetics (SceneRenderer's readability numbers): roll from
            // the car's REAL travel this frame (ds/r × WHEEL_SPIN_SCALE 0.4 —
            // the marshalled spd is NORMALIZED and can't drive it), fronts yaw
            // ±0.5 rad with steer. Teleport-sized jumps don't spin the wheels.
            if (mCarWheels.size() > i) {
                constexpr float WHEEL_TURN_MAX = 0.5f;
                constexpr float WHEEL_SPIN_SCALE = 0.4f;
                constexpr float WHEEL_RADIUS = 0.13f;
                constexpr float ROLL_SEG_MAX = 1.5f;
                CarWheels& w = mCarWheels[i];
                const float3 posW = carPos;
                float ds = 0;
                if (w.hasLastPos) {
                    const float3 d = posW - w.lastPos;
                    const float len = length(d);
                    ds = len * (dot(d, fwd) >= 0 ? 1.0f : -1.0f);
                }
                w.lastPos = posW;
                w.hasLastPos = true;
                w.lastDs = ds; // the boost streaks cycle at this real travel speed
                // While the monster is up its own fat tyres are the ones on the
                // ground, so the roll accumulates at THEIR radius (the JS swaps
                // c.wheelRadius to the rig's for the same reason).
                const float radius = (isMonster && mMonsterWheelRadius > 0)
                        ? mMonsterWheelRadius : WHEEL_RADIUS;
                if (std::fabs(ds) < ROLL_SEG_MAX) {
                    w.roll += (ds / radius) * WHEEL_SPIN_SCALE;
                    w.roll = std::fmod(std::fmod(w.roll + (float) M_PI, 2.0f * (float) M_PI)
                            + 2.0f * (float) M_PI, 2.0f * (float) M_PI) - (float) M_PI;
                }
                // Steer yaw is about the wheel's local +Y, and the pose's
                // half-turn is ITSELF about Y — so unlike the roll axis, this
                // one is NOT flipped and takes the JS's angle as-is. Negating
                // it steered the front wheels the wrong way.
                const float yaw = c.steer * WHEEL_TURN_MAX;
                const mat4f rollM = mat4f::rotation(w.roll * w.rollSign, float3{ 1, 0, 0 });
                const mat4f steerRoll = mat4f::rotation(yaw, float3{ 0, 1, 0 }) * rollM;
                // MonsterRig strips the car's own wheels (and any exposed axle
                // rod) before grafting the body onto the monster chassis — so
                // collapse them while the transform is up, or the little tyres
                // hang in mid-air beside the big ones.
                const auto spin = [&](utils::Entity e, const float3& t, const mat4f& r) {
                    if (e.isNull()) return;
                    mat4f local = isMonster ? mat4f::scaling(float3{ 1e-4f }) : r;
                    local[3] = float4{ t, 1 };
                    // …and undo the body's lean/dive: the root above carries it,
                    // but tyres stay planted on the road (see `bodyRot`).
                    tcm.setTransform(tcm.getInstance(e), bodyRotInv * local);
                };
                spin(w.fl, w.flT, steerRoll);
                spin(w.fr, w.frT, steerRoll);
                spin(w.bl, w.blT, rollM);
                spin(w.br, w.brT, rollM);
                if (!w.axle.isNull()) spin(w.axle, w.axleT, mat4f{});
                // …and the rig's own wheels, which are the ones actually
                // touching the road while the monster is up. Same roll clock,
                // this rig's axis sign, and nothing to collapse.
                if (isMonster && mMonsterWheels.size() > i) {
                    const MonsterWheels& mw = mMonsterWheels[i];
                    const mat4f mRoll = mat4f::rotation(w.roll * mw.rollSign, float3{ 1, 0, 0 });
                    const mat4f mSteer = mat4f::rotation(yaw, float3{ 0, 1, 0 }) * mRoll;
                    const auto turn = [&](utils::Entity e, const float3& t, const mat4f& r) {
                        if (e.isNull()) return;
                        mat4f local = r;
                        local[3] = float4{ t, 1 };
                        tcm.setTransform(tcm.getInstance(e), local);
                    };
                    turn(mw.fl, mw.flT, mSteer);
                    turn(mw.fr, mw.frT, mSteer);
                    turn(mw.bl, mw.blT, mRoll);
                    turn(mw.br, mw.brT, mRoll);
                }
            }
        } else if (!mCars[i].entity.isNull()) {
            tcm.setTransform(tcm.getInstance(mCars[i].entity), m);
        }
        // Ground blob rides the road-aligned pose basis (it conforms to
        // whatever the car drives — bank, hill, loop deck), spun by the
        // spin-out whirl so the silhouette tracks the car (the JS shadow's
        // rotated right/forward axes). A monster swaps to its own footprint.
        if (mCarBlobs.size() > i && !mCarBlobs[i].entity.isNull()) {
            const mat4f bm = (c.spin != 0)
                    ? m * mat4f::rotation(c.spin, float3{ 0, 1, 0 })
                    : m;
            float sx = 1, sz = 1;
            const bool monsterBlob = c.monster > 0.5f && mMonsterFootW > 0
                    && mCarWheels.size() > i;
            if (monsterBlob) {
                sx = mMonsterFootW / mCarWheels[i].footW;
                sz = mMonsterFootL / mCarWheels[i].footL;
            }
            // …and to the RIG's OUTLINE, not just its size. Scaling the little
            // car's silhouette up to truck dimensions painted a car-shaped
            // smudge under a chassis whose four fat tyres are the only things
            // touching the road. Edge-triggered: setParameter rebinds a sampler.
            if (mCarBlobMats.size() > i && mCarBlobMats[i]) { // sized with mCarBlobMasks
                Texture* want = monsterBlob && mMonsterSilhouette
                        ? mMonsterSilhouette
                        : (mCarSilhouettes.size() > i && mCarSilhouettes[i])
                                ? mCarSilhouettes[i] : mShadowMaskTex;
                if (want && want != mCarBlobMasks[i]) {
                    setBlobMask(mCarBlobMats[i], want, want != mShadowMaskTex);
                    mCarBlobMasks[i] = want;
                }
            }
            // Load shift: the harder the body pitches, the closer the chassis
            // presses to the road (JS aoMat.opacity = 0.55 + AO_LOAD_GAIN·k).
            // Carried across as the RELATIVE gain it was, 0.08/0.55, so it still
            // deepens the blob by 15% at full pitch now that the base opacity
            // comes from the light rig instead of from that 0.55.
            const float load = mCarWheels.size() > i
                    ? std::min(1.0f, std::fabs(mCarWheels[i].pitch) / 0.08f) : 0.0f;
            // One projection per car, shared with the boost disc below: both
            // decals hang off the same origin and the same road frame.
            mTrack->project(bm[3].xyz, bm[1].xyz, carS, carLat);
            haveCarS = true;
            conformDecalAt(mCarBlobs[i], bm, carS, carLat, sx, sz, 0.02f,
                    1.0f + (0.08f / 0.55f) * load);
        }
        // Boost wind streaks (SceneRenderer STREAK_*): while boosting, cycle
        // each streak front (0.7) → back (−2.4) past the body at the car's
        // real travel speed (+3 floor), sin(π·progress) opacity envelope at
        // peak 0.15 × (0.5 + 0.5k). Respawns draw a per-car LCG (the JS uses
        // Math.random — character parity, not per-pixel). Alpha lands in the
        // centre vertex; the per-view pass orients the billboards.
        if (mCarBasis.size() < nCars) mCarBasis.resize(nCars);
        if (mCarBasisInv.size() < nCars) mCarBasisInv.resize(nCars);
        if (mCarBasis.size() > i) { mCarBasis[i] = m; mCarBasisInv[i] = inverse(m); }
        if (mStreaks.size() >= (i + 1) * 4 && mStreakSeed.size() > i) {
            const bool on = c.boostMul > 1.001f;
            CarWheels* cwp = mCarWheels.size() > i ? &mCarWheels[i] : nullptr;
            const float dtc = std::max(input.dt, 1e-3f);
            const float wspd = cwp
                    ? std::min(std::fabs(cwp->lastDs), 1.5f) / dtc + 3.0f : 8.0f;
            const float kk = std::min(1.0f, (c.boostMul - 1.0f) / 0.6f);
            const float fw = cwp ? cwp->footW : 0.95f;
            uint32_t& sr = mStreakSeed[i];
            const auto rnd = [&]() {
                sr = sr * 1664525u + 1013904223u;
                return (float) ((double) sr / 4294967296.0);
            };
            constexpr float FRONT = 0.7f, BACK = -2.4f, SPAN = FRONT - BACK;
            for (int s = 0; s < 4; s++) {
                Streak& st = mStreaks[i * 4 + s];
                Mesh& sm = mStreakMeshes[i * 4 + s];
                if (sm.entity.isNull()) continue;
                float alpha = 0;
                if (!on) {
                    st.dead = true;
                } else {
                    if (st.dead) {
                        st.z = FRONT + rnd() * SPAN * 0.8f;
                        st.x = (rnd() < 0.5f ? -1.0f : 1.0f) * (0.45f + rnd() * 0.4f) * fw;
                        st.y = 0.1f + rnd() * 0.3f;
                        st.len = 0.6f + rnd() * 0.5f;
                        st.dead = false;
                    }
                    st.z -= wspd * input.dt;
                    if (st.z < BACK) {
                        st.dead = true;
                    } else {
                        const float p = std::min(1.0f,
                                std::max(0.0f, (FRONT - st.z) / SPAN));
                        alpha = std::sin((float) M_PI * p) * 0.15f * (0.5f + 0.5f * kk);
                    }
                }
                if (alpha != st.alpha) {
                    // The JS animates the material's opacity, which scales the
                    // whole blurred texture — so scale every baked vertex alpha.
                    st.alpha = alpha;
                    const float k2 = std::min(1.0f, std::max(0.0f, alpha));
                    for (size_t vi = 0; vi < sm.verts.size() && vi < sm.local.size(); vi++) {
                        const uint32_t au = (uint32_t) std::lround(sm.local[vi].a * k2);
                        sm.verts[vi].abgr = (sm.verts[vi].abgr & 0x00ffffffu) | (au << 24);
                    }
                    sm.vb->setBufferAt(*mEngine, 0, VertexBuffer::BufferDescriptor(
                            sm.verts.data(), sm.verts.size() * sizeof(Vertex), nullptr));
                }
            }
        }
        // Boost pool: the JS breathes both the opacity (min(0.85, 0.7 + k·0.3)
        // × pulse) and the radius ((footW+footL)/2 × (1.25 + k·1.4) × 0.5),
        // then CONFORMS every ring vertex onto the deck.
        if (mBoostDisks.size() > i && !mBoostDisks[i].entity.isNull()) {
            static const mat4f PARKED = mat4f::translation(float3{ 0, -1000, 0 });
            if (c.boostMul > 1.001f) {
                const float k = c.boostMul - 1.0f;
                const float pulse = 0.9f + 0.1f * std::sin(mTime * 11.0f);
                const float sc = (1.25f + k * 1.4f) * (0.94f + 0.08f * pulse);
                const float fw = mCarWheels.size() > i ? mCarWheels[i].footW : 0.95f;
                const float fl = mCarWheels.size() > i ? mCarWheels[i].footL : 2.0f;
                const float outerR = (fw + fl) * 0.5f * sc * 0.5f;
                if (!haveCarS) {
                    mTrack->project(m[3].xyz, m[1].xyz, carS, carLat);
                    haveCarS = true;
                }
                conformDecalAt(mBoostDisks[i], m, carS, carLat, outerR, outerR, 0.02f,
                        std::min(0.85f, 0.7f + k * 0.3f) * pulse);
            } else {
                tcm.setTransform(tcm.getInstance(mBoostDisks[i].entity), PARKED);
            }
        }
    }
    mProfile[kProfCars] = ttpNowMs() - tMark; tMark += mProfile[kProfCars];

    // Clouds drift slowly east, wrapping outside the playfield. The JS drifts
    // 0.7 u/s in AUTHORED space (r ≈ 180–294) and wraps at ±300; these clouds
    // were pushed out by k = 405/r, so both the drift and the wrap scale by
    // the same k or the two panes' clouds shear apart over a race.
    // Cloud drift is CLOSED-FORM off the marshalled scene clock (x0 + 0.7·T,
    // wrapped over the 600u period) — incremental accumulation would carry a
    // phase offset from whenever this renderer booted vs the driving scene.
    // (mCloudPos holds the authored INITIAL; the per-view pass adds drift.)

    // Hot-air balloon: a very slow lap of the horizon at cloud height
    // (stepBalloon — bearing 2.4 + t·0.012, thermal breathe sin(t·0.11)·1.4),
    // pushed past the fog cutoff with the cloud trick (JS fog:false).
    if (!mBalloon.entity.isNull()) {
        const float r = 112.0f * mHillSf;
        const float k = r < SKY_BAND ? SKY_BAND / r : 1.0f;
        const float a = 2.4f + mTime * 0.012f;
        const float y = mBalloonY + std::sin(mTime * 0.11f) * 1.4f;
        tcm.setTransform(tcm.getInstance(mBalloon.entity),
                mat4f::translation(float3{ std::cos(a) * r * k, y * k, std::sin(a) * r * k })
                * mat4f::scaling(float3{ mBalloonSize * k }));
    }

    // The paper dart glides its lazy banked circle (stepPaperPlane), riding the
    // hill push-out like the balloon. (The birds and kites are SPRITES — they
    // re-aim per cell, down with the cloud billboards.)
    if (mTrack && !mPlane.entity.isNull()) {
        const TrackBin& t = *mTrack;
        const float ph = mTime * t.planeSpeed;
        const float cx = std::cos(t.planeA0) * t.planeRc * mHillSf;
        const float cz = std::sin(t.planeA0) * t.planeRc * mHillSf;
        const float3 p{ cx + std::cos(ph) * t.planeRb,
                        t.planeY + std::sin(ph * 2.1f) * 1.1f, // long shallow swoops
                        cz + std::sin(ph) * t.planeRb };
        const float yaw = std::atan2(-std::sin(ph), std::cos(ph));
        tcm.setTransform(tcm.getInstance(mPlane.entity),
                mat4f::translation(p) * mat4f::rotation(yaw, float3{ 0, 1, 0 })
                * mat4f::rotation(t.planeBank + std::sin(mTime * 0.7f) * 0.12f,
                        float3{ 0, 0, 1 })
                * mat4f::scaling(float3{ t.planeSize }));
    }

    // The wind-up train trundles its stadium oval (two straights along local X
    // at z = ±RT, run CCW), nose along the tangent, key winding as it goes.
    if (mHasTrain) {
        // The path is trainAt()'s, which is also what the sleepers were laid
        // along — see the note there. This used to be a second copy of the same
        // piecewise walk, with its own RT and LT.
        const TrainAt t = trainAt(std::fmod(mTime * 1.9f, trainPerim())); // ~1.9 u/s
        const float lpx = t.x, lpz = t.z, dx = t.dx, dz = t.dz;
        const float co = mTrainCos, so = mTrainSin;
        const mat4f pose = mat4f::translation(float3{
                    mTrainCentre.x + lpx * co + lpz * so, mTrainCentre.y,
                    mTrainCentre.z - lpx * so + lpz * co })
                * mat4f::rotation(std::atan2(dx * co + dz * so, -dx * so + dz * co),
                        float3{ 0, 1, 0 });
        if (!mTrain.entity.isNull()) tcm.setTransform(tcm.getInstance(mTrain.entity), pose);
        if (!mTrainKey.entity.isNull()) {
            tcm.setTransform(tcm.getInstance(mTrainKey.entity),
                    pose * mat4f::translation(float3{ 0, 1.8f, -0.85f })
                    * mat4f::rotation(mTime * 2.6f, float3{ 0, 1, 0 }));
        }
    }

    // Chimney smoke: each puff rises, grows and dissolves over ~6 s, staggered
    // in thirds. Billboarded toward this frame's first camera (they're tiny and
    // far; a per-cell re-aim isn't worth the extra state).
    if (!mSmoke.empty() && input.viewCount > 0) {
        const TtpViewInput& v0 = ttp_frame_views(&input)[0];
        const float3 camP{ v0.world[12], v0.world[13], v0.world[14] };
        for (size_t i = 0; i < mSmoke.size(); i++) {
            if (mSmoke[i].entity.isNull()) continue;
            const float u = std::fmod(mTime * 0.16f + (float) i / 3, 1.0f);
            const float3 p{ mSmokeOrigin.x + u * 1.7f
                                    + std::sin(mTime * 0.8f + i * 2.1f) * 0.15f,
                            mSmokeOrigin.y + u * 3.4f, mSmokeOrigin.z };
            const float w = 0.7f + u * 2.2f;
            // The JS fades the sprite's opacity; ours bakes alpha into the mesh,
            // so shrink to nothing at the ends instead (same read at this size).
            const float fade = 0.42f * std::min(1.0f, u * 5) * (1 - u) / 0.42f;
            const float yaw = std::atan2(camP.x - p.x, camP.z - p.z);
            tcm.setTransform(tcm.getInstance(mSmoke[i].entity),
                    mat4f::translation(p) * mat4f::rotation(yaw, float3{ 0, 1, 0 })
                    * mat4f::scaling(float3{ w * fade, w * 0.62f * fade, 1 }));
        }
    }

    // The windmill's multi-blade rotor spins about its facing axis.
    if (!mWindmill.entity.isNull()) {
        tcm.setTransform(tcm.getInstance(mWindmill.entity),
                mWindmillBase * mat4f::rotation(mTime * 0.85f, float3{ 0, 0, 1 }));
    }

    // Kickable cones — TrackProps._stepCones. A car centre inside CONE_KICK_R
    // (on the SAME deck) punts the cone away from itself; it arcs, tumbles,
    // bounces off the local road surface with friction, is shoved back inside
    // the kerbs, and on settling topples onto its side and stays down.
    if (!mConeStates.empty() && mTrack) {
        constexpr float KICK_R = 0.7f, KICK_Y = 1.0f, KICK_MIN = 2.5f, KICK_GAIN = 6.0f;
        constexpr float KICK_UP = 2.6f, GRAVITY = 16.0f, RESTITUTION = 0.42f;
        constexpr float FRICTION = 0.6f, SETTLE = 0.4f, TOPPLE = 7.0f;
        constexpr float EDGE_MARGIN = 0.35f, WALL_RESTITUTION = 0.5f;
        // Lowest point of the cone's silhouette under `q`, relative to its
        // origin: the minimum over the base rim and the apex (a cone touches
        // the ground nowhere else), matching the JS's sampled-vertex scan.
        const auto groundOffset = [](const ConeState& cs, const quatf& q) {
            float lo = 1e9f;
            for (int k = 0; k < 12; k++) {
                const float a = (float) k * (2.0f * (float) M_PI / 12);
                const float3 v{ std::cos(a) * cs.radius, cs.loY, std::sin(a) * cs.radius };
                lo = std::min(lo, (q * v).y);
            }
            lo = std::min(lo, (q * float3{ 0, cs.hiY, 0 }).y);
            return std::min(0.0f, lo);
        };
        // A cone lying on its side rests on its SLANT, so its axis pitches up
        // toward the base by ψ = asin(r / h): aim the axis along the lean with
        // the apex dipped ψ below horizontal.
        const auto coneFlatPose = [](const ConeState& cs) {
            const float3 axis = cs.quat * float3{ 0, 1, 0 };
            const float hl = std::sqrt(axis.x * axis.x + axis.z * axis.z);
            float dx, dz;
            if (hl > 1e-3f) { dx = axis.x / hl; dz = axis.z / hl; }
            else {
                const float sl = std::sqrt(cs.spinAxis.x * cs.spinAxis.x
                        + cs.spinAxis.z * cs.spinAxis.z);
                const float n = sl > 1e-6f ? sl : 1.0f;
                dx = cs.spinAxis.z / n; dz = -cs.spinAxis.x / n;
            }
            const float psi = std::asin(std::min(1.0f,
                    cs.radius / std::max(1e-3f, cs.hiY - cs.loY)));
            const float3 target{ dx * std::cos(psi), -std::sin(psi), dz * std::cos(psi) };
            return quatf::fromDirectedRotation(normalize(axis), normalize(target)) * cs.quat;
        };
        const auto rotateTowards = [](const quatf& q, const quatf& t, float maxAngle) {
            const float d = std::fabs(q.x * t.x + q.y * t.y + q.z * t.z + q.w * t.w);
            const float ang = 2.0f * std::acos(std::min(1.0f, d));
            if (ang < 1e-6f) return t;
            return normalize(slerp(q, t, std::min(1.0f, maxAngle / ang)));
        };
        for (size_t ci = 0; ci < mConeStates.size(); ci++) {
            ConeState& cs = mConeStates[ci];
            const bool isSign = mSignMeshes.size() > ci && !mSignMeshes[ci].entity.isNull();
            if (!isSign && (mConeInstances.size() <= ci || !mConeInstances[ci])) continue;
            auto inst = isSign ? tcm.getInstance(mSignMeshes[ci].entity)
                               : tcm.getInstance(mConeInstances[ci]->getRoot());
            if (!cs.airborne) {
                if (cs.hasFlat) {
                    cs.quat = rotateTowards(cs.quat, cs.flatTarget, TOPPLE * input.dt);
                    if (cs.hasRest) cs.pos.y = cs.restRoadY - groundOffset(cs, cs.quat);
                    const float d = std::fabs(cs.quat.x * cs.flatTarget.x
                            + cs.quat.y * cs.flatTarget.y + cs.quat.z * cs.flatTarget.z
                            + cs.quat.w * cs.flatTarget.w);
                    if (2.0f * std::acos(std::min(1.0f, d)) < 1e-3f) cs.hasFlat = false;
                }
                for (uint32_t i = 0; i < nCars && i < carPosW.size(); i++) {
                    const TtpCarInput& c = cars[i];
                    if (c.spd < 0.05f) continue; // a stationary car doesn't kick
                    const float dx = cs.pos.x - carPosW[i].x, dz = cs.pos.z - carPosW[i].z;
                    const float d2 = dx * dx + dz * dz;
                    if (d2 >= KICK_R * KICK_R) continue;
                    if (std::fabs(cs.pos.y - carPosW[i].y) >= KICK_Y) continue; // same deck only
                    float dirx, dirz;
                    if (d2 < 1e-4f) {
                        const float fl = std::sqrt(c.forward.x * c.forward.x
                                + c.forward.z * c.forward.z);
                        const float n = fl > 1e-6f ? fl : 1.0f;
                        dirx = c.forward.x / n; dirz = c.forward.z / n;
                    } else {
                        const float len = std::sqrt(d2);
                        dirx = dx / len; dirz = dz / len;
                    }
                    const float power = KICK_MIN + KICK_GAIN * c.spd;
                    cs.vel = { dirx * power, KICK_UP, dirz * power };
                    cs.spinAxis = normalize(float3{ -dirz, 0, dirx });
                    cs.spinRate = power * 2.2f;
                    cs.airborne = true;
                    cs.hasFlat = false; // re-kicked mid-topple → tumble afresh
                    break;
                }
                tcm.setTransform(inst, mat4f::translation(cs.pos) * mat4f(cs.quat));
                continue;
            }
            cs.vel.y -= GRAVITY * input.dt;
            cs.pos += cs.vel * input.dt;
            cs.quat = normalize(quatf::fromAxisAngle(cs.spinAxis, cs.spinRate * input.dt)
                    * cs.quat);
            // Settle onto the road WHERE IT LANDED, not the spawn height: sample
            // the ribbon at the cone's current (s, lat) and use it for both the
            // floor and the kerb clamp.
            const float3 homeP = cs.home[3].xyz;
            const TrackBin::Sample f0 = mTrack->frameAt(cs.homeS);
            const float along = dot(cs.pos - homeP, f0.tangent());
            const TrackBin::Sample f = mTrack->frameAt(cs.homeS + along);
            const float latOff = dot(cs.pos - f.pos, f.lat);
            const float roadY = f.pos.y + f.lat.y * latOff;
            cs.restRoadY = roadY;
            cs.hasRest = true;
            const float gOff = groundOffset(cs, cs.quat);
            if (cs.pos.y + gOff <= roadY) {
                cs.pos.y = roadY - gOff;
                if (cs.vel.y < 0) cs.vel.y = -cs.vel.y * RESTITUTION;
                cs.vel.x *= FRICTION;
                cs.vel.z *= FRICTION;
                cs.spinRate *= FRICTION;
                if (cs.vel.y < SETTLE
                        && (cs.vel.x * cs.vel.x + cs.vel.z * cs.vel.z) < SETTLE * SETTLE) {
                    cs.vel = {};
                    cs.spinRate = 0;
                    cs.airborne = false;
                    cs.flatTarget = coneFlatPose(cs); // topple onto its side
                    cs.hasFlat = true;
                }
            }
            const float edge = f.width / 2 - EDGE_MARGIN;
            if (std::fabs(latOff) > edge) {
                const float sgn = latOff > 0 ? 1.0f : -1.0f;
                cs.pos += f.lat * (sgn * edge - latOff);
                const float vLat = dot(cs.vel, f.lat);
                if (vLat * sgn > 0) cs.vel += f.lat * (-vLat * (1 + WALL_RESTITUTION));
            }
            tcm.setTransform(inst, mat4f::translation(cs.pos) * mat4f(cs.quat));
        }
    }

    // Ambient drift (stepAmbient): sink at fall-scaled per-particle speed, ride
    // the eastward wind, wander vertically, wrapping inside the kind's height
    // band and the authored spread.
    if (!mPollen.entity.isNull() && !mAmbBase.empty()) {
        const float FALL = mAmbFall, WIND = mAmbWind, BOB = mAmbBob;
        constexpr float AMB_R = 170.0f;
        const float BAND_H = mAmbBandH;
        for (size_t i = 0; i < mAmbBase.size(); i++) {
            const float t = mTime;
            float x = mAmbBase[i].x + WIND * t;
            x = std::fmod(x + AMB_R, 2 * AMB_R) - AMB_R;
            float y = mAmbBase[i].y - mAmbSpeed[i] * FALL * t
                    + std::sin(t * 0.7f + i) * BOB * 0.3f;
            y = std::fmod(std::fmod(y, BAND_H) + BAND_H, BAND_H) + 0.5f;
            const float z = mAmbBase[i].z;
            // All four corners get the centre; the material spreads them.
            Vertex* v = &mPollen.verts[i * 4];
            for (int k = 0; k < 4; k++) { v[k].px = x; v[k].py = y; v[k].pz = z; }
        }
        mPollen.vb->setBufferAt(*mEngine, 0, VertexBuffer::BufferDescriptor(
                mPollen.verts.data(), mPollen.verts.size() * sizeof(Vertex), nullptr));
        refreshBounds(mPollen);
    }

    // Furniture reconcile: boxes hide when collected (respawn = state flips
    // back), bananas place the first N pool entries at their track positions.
    // Idle motion (box spin + bob) runs on the marshalled scene clock (mTime,
    // set at the top of render()).
    if (mTrack) {
        // Gold emissive throb (TrackProps _stepBoxes): synchronized across
        // boxes — 0xffd23f at 0.16 + 0.18·(0.5 + 0.5·sin(4.5t)).
        if (mBoxAsset) {
            const float pulse = 0.16f + 0.18f * (0.5f + 0.5f * std::sin(mTime * 4.5f));
            const float3 gold = srgbToLinear(0xffd23f) * pulse;
            // The fade twins carry it too, or a box would drop its glow on the
            // frame it is grabbed — the one frame anyone is looking at it.
            const auto glow = [&](gltfio::FilamentInstance* inst) {
                if (!inst) return;
                MaterialInstance* const* mats = inst->getMaterialInstances();
                for (size_t mi = 0; mi < inst->getMaterialInstanceCount(); mi++) {
                    if (mats[mi]->getMaterial()->hasParameter("emissiveFactor")) {
                        mats[mi]->setParameter("emissiveFactor", gold);
                    }
                }
            };
            for (auto* inst : mBoxInstances) glow(inst);
            for (auto* inst : mBoxFadeInstances) glow(inst);
        }
        const uint32_t* boxStates = ttp_frame_box_states(&input);
        const uint32_t nBoxes = std::min<uint32_t>(input.boxCount,
                (uint32_t) std::min(mBoxInstances.size(), mBoxXf.size()));
        static const mat4f PARK = mat4f::translation(float3{ 0, -1000, 0 });
        if (mBoxCollectT.size() < nBoxes) mBoxCollectT.assign(nBoxes, 0.0f);
        if (mBoxPrevAvail.size() < nBoxes) mBoxPrevAvail.assign(nBoxes, 1);
        // Collect burst (TrackProps): a grabbed box GROWS (→2.1×) while it fades,
        // spinning up 2.2×. That is the authored beat, and it can finally be
        // rendered as authored — the BLEND twin carries the alpha the solid
        // instance has no channel for, so the growth reads as a poof dispersing
        // instead of a box inflating in the road. The old `pop` tail is gone
        // with it: it only ever existed to stand in for this alpha.
        constexpr float POOF = 0.2f;
        bool shadowsDirty = false;
        for (uint32_t i = 0; i < nBoxes; i++) {
            auto inst = tcm.getInstance(mBoxInstances[i]->getRoot());
            gltfio::FilamentInstance* fadeInst =
                    mBoxFadeInstances.size() > i ? mBoxFadeInstances[i] : nullptr;
            const bool avail = boxStates[i] != 0;
            // With no BLEND twin there is nothing to fade, and a grow with no
            // fade is the box inflating — so skip the burst and just go.
            if (!avail && mBoxPrevAvail[i]) mBoxCollectT[i] = fadeInst ? POOF : 0.0f;
            mBoxPrevAvail[i] = avail ? 1 : 0;
            // Hover: the box's BASE floats BOX_FLOAT 0.18 over the deck and
            // bobs ±BOX_BOB_AMP 0.07 at ω 3.0 with the 0.9·i phase stagger.
            const float bob = 0.18f + 0.07f * std::sin(mTime * 3.0f + 0.9f * i);
            const mat4f hover = mBoxXf[i] * mat4f::translation(float3{ 0, bob, 0 });
            float alpha = 1.0f; // the box's own opacity, and its blob's
            if (!avail && mBoxCollectT[i] > 0 && fadeInst) {
                mBoxCollectT[i] = std::max(0.0f, mBoxCollectT[i] - input.dt);
                alpha = mBoxCollectT[i] / POOF;                  // 1 → 0
                const float grow = 1.0f + (1.0f - alpha) * 1.1f; // 1 → 2.1
                tcm.setTransform(inst, PARK);
                tcm.setTransform(tcm.getInstance(fadeInst->getRoot()),
                        hover * mat4f::rotation(mTime * 1.6f * 2.2f, float3{ 0, 1, 0 })
                        * mat4f::scaling(float3{ mBoxScale * grow }));
                MaterialInstance* const* mats = fadeInst->getMaterialInstances();
                for (size_t mi = 0; mi < fadeInst->getMaterialInstanceCount(); mi++) {
                    if (mats[mi]->getMaterial()->hasParameter("baseColorFactor")) {
                        mats[mi]->setParameter("baseColorFactor",
                                math::float4{ 1, 1, 1, alpha });
                    }
                }
            } else if (!avail) {
                tcm.setTransform(inst, PARK);
                if (fadeInst) tcm.setTransform(tcm.getInstance(fadeInst->getRoot()), PARK);
                alpha = 0.0f;
            } else {
                mBoxCollectT[i] = 0;
                // Idle (TrackProps _stepBoxes): spin 1.6 rad/s in unison.
                tcm.setTransform(inst, hover
                        * mat4f::rotation(mTime * 1.6f, float3{ 0, 1, 0 })
                        * mat4f::scaling(float3{ mBoxScale }));
                if (fadeInst) tcm.setTransform(tcm.getInstance(fadeInst->getRoot()), PARK);
            }
            const uint8_t fade = (uint8_t) std::lround(alpha * 255.0f);
            if (i < mBoxShadowFade.size() && mBoxShadowFade[i] != fade) {
                mBoxShadowFade[i] = fade;
                shadowsDirty = true;
            }
        }
        // One re-upload of the whole baked blob mesh, only on a state change —
        // a box collect or respawn, so a handful of frames per race.
        if (shadowsDirty && mPropShadows.vb && mBoxShadowStride) {
            for (size_t i = 0; i < mBoxShadowFade.size(); i++) {
                const size_t v0 = i * mBoxShadowStride;
                const size_t v1 = std::min(v0 + mBoxShadowStride, mPropShadows.verts.size());
                for (size_t v = v0; v < v1; v++) {
                    const uint32_t rest = mBoxShadowRest[v];
                    const uint32_t a = ((rest >> 24) * mBoxShadowFade[i] + 127) / 255;
                    mPropShadows.verts[v].abgr = (a << 24) | (rest & 0x00ffffffu);
                }
            }
            mPropShadows.vb->setBufferAt(*mEngine, 0, VertexBuffer::BufferDescriptor(
                    mPropShadows.verts.data(),
                    mPropShadows.verts.size() * sizeof(Vertex), nullptr));
        }
        // Ground blob under each dynamic prop (TrackProps shares one blob geo,
        // scaled 0.7 for a banana and 0.95 for a rocket).
        const auto placeBlob = [&](size_t slot, const TrackBin::Sample& f, float lat,
                float scale, bool live) {
            if (mPropBlobs.size() <= slot || mPropBlobs[slot].entity.isNull()) return;
            if (!live) {
                tcm.setTransform(tcm.getInstance(mPropBlobs[slot].entity), PARK);
                return;
            }
            const float r = 0.3f * scale;
            // f came from frameAt(item.s), so the arclength is already exact —
            // no need to project the resulting world point back onto the curve.
            conformDecalAt(mPropBlobs[slot], f.basis(lat), f.s, lat, r, r, 0.02f, 1.0f);
        };
        const TtpBananaInput* bananas = ttp_frame_bananas(&input);
        for (uint32_t j = 0; j < (uint32_t) mBananaInstances.size(); j++) {
            auto inst = tcm.getInstance(mBananaInstances[j]->getRoot());
            if (j >= input.bananaCount) {
                tcm.setTransform(inst, PARK);
                placeBlob(j, {}, 0, 0.7f, false);
                continue;
            }
            const TrackBin::Sample bf = mTrack->frameAt(bananas[j].s);
            placeBlob(j, bf, bananas[j].lat, 0.7f, true);
            tcm.setTransform(inst, bf.basis(bananas[j].lat));
        }
        const TtpRocketInput* rockets = ttp_frame_rockets(&input);
        std::vector<float3> nowRockets;
        for (uint32_t j = 0; j < (uint32_t) mRockets.size(); j++) {
            if (mRockets[j].entity.isNull()) continue;
            auto inst = tcm.getInstance(mRockets[j].entity);
            const bool haveFlame = mRocketFlames.size() > j
                    && !mRocketFlames[j].entity.isNull();
            if (j >= input.rocketCount) {
                tcm.setTransform(inst, PARK);
                if (haveFlame) {
                    tcm.setTransform(tcm.getInstance(mRocketFlames[j].entity), PARK);
                }
                placeBlob(mBananaInstances.size() + j, {}, 0, 0.95f, false);
                continue;
            }
            // Nose (local +Y) along the travel tangent, ROCKET_HOVER 0.32
            // above the deck, whizz-rolling about its axis at 9 rad/s.
            const TrackBin::Sample f = mTrack->frameAt(rockets[j].s);
            placeBlob(mBananaInstances.size() + j, f, rockets[j].lat, 0.95f, true);
            const float3 tanv = f.tangent();
            const float3 p = f.pos + f.lat * rockets[j].lat + f.up * 0.32f;
            nowRockets.push_back(p);
            const mat4f rocketXf = mat4f{ float4{ f.lat, 0 }, float4{ tanv, 0 },
                    float4{ cross(f.lat, tanv), 0 }, float4{ p, 1 } }
                    * mat4f::rotation(mTime * 9.0f, float3{ 0, 1, 0 });
            tcm.setTransform(inst, rocketXf);
            if (haveFlame) {
                // STEADY. The flame used to pulse (the JS jittered its
                // opacity, this scaled it) — at the size a rocket reads on a TV
                // that is not a flicker, it is noise: too small to see as fire
                // and too busy to ignore. A constant flame is the clearer cue.
                tcm.setTransform(tcm.getInstance(mRocketFlames[j].entity), rocketXf);
            }
        }
        // A sim reset (fixture scrubbing) teleports every car — clear the
        // rocket trackers so the count drop can't fire a stale-position burst,
        // and wipe the skid layer (the JS clears marks + patina on restart).
        if (input.carCount > 0) {
            const float3 c0 = { cars[0].pos.x, cars[0].pos.y, cars[0].pos.z };
            if (length(c0 - mLastCar0) > 5.0f) {
                mPrevRockets.clear();
                mPrevRocketCount = 0;
                for (Burst& b : mBursts) b.t = -1;
                if (!mSkids.entity.isNull() && !mSkidLife.empty()) {
                    for (WheelTrail& t : mWheelTrails) t = {};
                    std::fill(mSkidLife.begin(), mSkidLife.end(), 0.0f);
                    std::fill(mSkidPeak.begin(), mSkidPeak.end(), 0.0f);
                    std::fill(mSkidOwner.begin(), mSkidOwner.end(), -1);
                    mSkidCursor = 0;
                    for (auto& v : mSkids.verts) { v.py = -1000; v.abgr &= 0x00ffffffu; }
                    mSkids.vb->setBufferAt(*mEngine, 0, VertexBuffer::BufferDescriptor(
                            mSkids.verts.data(), mSkids.verts.size() * sizeof(Vertex), nullptr));
                    refreshBounds(mSkids);
                }
            }
            mLastCar0 = c0;
        }
        // Detonations, as the engine reported them this frame.
        //
        // This used to be INFERRED from rocketCount dropping, and the burst was
        // pinned to the rocket's last known spot. That is exactly wrong for a
        // HIT: the rocket detonates on a car, the car drives on, and the burst
        // is left behind — so the victim's own chase camera, the one view
        // guaranteed to be pointed at it, is the only view that never sees it.
        // The events say which case it is, so the fireball can ride the car out
        // like the JS does (TrackProps IMPACT_FOLLOW) while the shockwave ring
        // stays put at the impact point.
        const TtpBurstInput* bursts = ttp_frame_bursts(&input);
        for (uint32_t bi = 0; bi < input.burstCount; bi++) {
            Burst* slot = nullptr;
            for (Burst& b : mBursts) { if (b.t < 0) { slot = &b; break; } }
            if (!slot) break; // two at once is already more than reads
            const TtpBurstInput& ev = bursts[bi];
            if (ev.car >= 0 && (uint32_t) ev.car < nCars && (size_t) ev.car < carPosW.size()) {
                // On the car body, like spawnImpact's carGroup.position + up·0.3.
                const TtpCarInput& hit = cars[ev.car];
                slot->pos = carPosW[ev.car]
                        + float3{ hit.up.x, hit.up.y, hit.up.z } * 0.3f;
                slot->car = ev.car;
            } else {
                const TrackBin::Sample f = mTrack->frameAt(ev.s);
                slot->pos = f.pos + f.lat * ev.lat + f.up * 0.3f;
                slot->car = -1;
            }
            slot->ball = slot->pos;
            slot->t = 0;
        }
        mPrevRockets = std::move(nowRockets);
        mPrevRocketCount = input.rocketCount;
        for (int bi = 0; bi < 2; bi++) {
            Burst& b = mBursts[bi];
            if (mBurstMeshes[bi].entity.isNull()) continue;
            auto ringI = tcm.getInstance(mBurstMeshes[bi].entity);
            auto ballI = tcm.getInstance(mBurstBalls[bi].entity);
            constexpr float DUR = 0.7f, FLASH = 0.5f; // IMPACT_TIME / IMPACT_FLASH_TIME
            if (b.t >= 0) {
                b.t += input.dt;
                if (b.t >= DUR) b.t = -1;
            }
            if (b.t < 0) {
                setMeshInScene(mBurstMeshes[bi], false);
                setMeshInScene(mBurstBalls[bi], false);
                continue;
            }
            // The fireball chases the car it hit as that car spins away
            // (TrackProps IMPACT_FOLLOW 10/s); the ring stays at the impact.
            if (b.car >= 0 && (uint32_t) b.car < nCars && (size_t) b.car < carPosW.size()) {
                const TtpCarInput& hit = cars[b.car];
                const float3 target = carPosW[b.car]
                        + float3{ hit.up.x, hit.up.y, hit.up.z } * 0.3f;
                b.ball += (target - b.ball) * std::min(1.0f, 10.0f * input.dt);
            }
            // Ring: IMPACT_RING_R0 0.25 → R1 2.0 on the JS ease-out
            // (1-(1-t)²), half-width held at IMPACT_RING_W 0.05 the whole way,
            // alpha IMPACT_RING_OPACITY 0.55 tapering to nothing.
            const float tr = b.t / DUR;
            const float R = 0.25f + 1.75f * (1.0f - (1.0f - tr) * (1.0f - tr));
            setMeshInScene(mBurstMeshes[bi], true);
            tcm.setTransform(ringI, mat4f::translation(b.pos));
            if (mBurstRingMats[bi]) {
                mBurstRingMats[bi]->setParameter("ring", math::float2{ R, 0.05f });
                mBurstRingMats[bi]->setParameter("tint",
                        math::float4{ 1, 1, 1, 0.55f * (1.0f - tr) });
            }
            // Ball: pops to IMPACT_FLASH_R 0.62 in ~0.1 s and then HOLDS that
            // size while its brightness dies — a fireball that shrank instead
            // read as a balloon deflating.
            const float tf = std::min(1.0f, b.t / FLASH);
            const bool ballUp = b.t < FLASH;
            setMeshInScene(mBurstBalls[bi], ballUp);
            if (ballUp) {
                tcm.setTransform(ballI, mat4f::translation(b.ball)
                        * mat4f::scaling(float3{ 0.62f
                                * (0.5f + 0.5f * std::min(1.0f, tf * 5.0f)) }));
                if (mBurstBallMats[bi]) {
                    const float a = tf < 0.25f ? 1.0f
                            : std::max(0.0f, 1.0f - (tf - 0.25f) / 0.75f);
                    mBurstBallMats[bi]->setParameter("tint", math::float4{ 1, 1, 1, a });
                }
            }
        }
    }

    mProfile[kProfWorld] = ttpNowMs() - tMark; tMark += mProfile[kProfWorld];

    // Skid trails — SkidMarks.js layTrails + step, ported. Each marking wheel
    // grows a CONNECTED ribbon: the stamp under the wheel stretches to the
    // contact point every frame, freezes at SKID_SEG_MIN and hands its leading
    // edge to the next stamp (shared joint edges keep bends clean). Channels:
    // slip past SKID_THRESH, curb scrub (all four wheels, full strength),
    // spin-out scribbles, brake bite, launch scratch. Marks fade over
    // SKID_LIFE to the SKID_PATINA floor and linger until recycled.
    if (!mSkids.entity.isNull() && !mWheelTrails.empty()) {
        constexpr float SKID_MAX_OPACITY = 0.28f, SKID_THRESH = 0.2f;
        constexpr float SKID_LIFE = 1.2f, SKID_PATINA = 0.22f;
        constexpr float SKID_SEG_MIN = 0.25f, SKID_SEG_MAX = 1.5f;
        constexpr float SKID_EDGE_DOT = 0.3f, SKID_BRAKE_MIN = 0.6f;
        constexpr float SKID_LAUNCH_MIN = 0.5f;
        constexpr float SKID_ATTACK = 0.1f;  // s from nothing to full strength
        constexpr float SKID_RELEASE = 0.4f; // s from full strength to nothing
        // Edge softening, as a fraction of the half-width. Small on purpose: the
        // mark is meant to read as an even band of rubber that happens not to
        // have a razor edge, NOT as an airbrushed streak.
        constexpr float SKID_FEATHER = 0.22f;
        // The stamp's INNER columns — the only four of its eight vertices that
        // carry ink. Both the write and the fade below reach for exactly these.
        static constexpr int INK[] = { 1, 2, 5, 6 };
        const uint32_t POOL = (uint32_t) mSkidLife.size();
        bool dirty = false;
        const auto detach = [&](WheelTrail& t) {
            if (t.slot < 0) return;
            mSkidOwner[t.slot] = -1;
            t.slot = -1;
        };
        const auto resetWheel = [&](WheelTrail& t) {
            detach(t);
            t.seeded = false;
            t.hasEdge = false;
        };
        // The ribbon has ENDED: release the slot and re-anchor on the contact
        // patch, so whatever is drawn next starts from where the tyre is NOW.
        // The joint edge goes with it — there is no trail left to rejoin, and
        // keeping a stale edge would stretch the next stamp back to it.
        const auto restart = [&](WheelTrail& t, const float3& gp) {
            detach(t);
            t.last = gp;
            t.hasEdge = false;
        };
        // Positions + peak alpha for slot q: 4 columns per edge (L 0 | l peak |
        // r peak | R 0), rear edge → front edge. The inner pair sits
        // SKID_FEATHER in from the tyre's edge, so everything between them is
        // one flat tone and only the last sliver ramps off.
        const auto writeSlot = [&](int q, const float3& rC, const float3& rHalf,
                const float3& fC, const float3& fHalf, float strength) {
            Vertex* v = &mSkids.verts[(size_t) q * 8];
            const float3 rIn = rHalf * (1.0f - SKID_FEATHER);
            const float3 fIn = fHalf * (1.0f - SKID_FEATHER);
            const float3 pts[8] = { rC - rHalf, rC - rIn, rC + rIn, rC + rHalf,
                                    fC - fHalf, fC - fIn, fC + fIn, fC + fHalf };
            for (int k = 0; k < 8; k++) {
                v[k].px = pts[k].x; v[k].py = pts[k].y; v[k].pz = pts[k].z;
            }
            const float peak = SKID_MAX_OPACITY * strength;
            const uint32_t a = (uint32_t) std::lround(
                    std::min(1.0f, std::max(0.0f, peak)) * 255.0f);
            for (int k : INK) v[k].abgr = (v[k].abgr & 0x00ffffffu) | (a << 24);
            mSkidLife[q] = SKID_LIFE;
            mSkidPeak[q] = peak;
            dirty = true;
        };
        for (uint32_t i = 0; i < nCars; i++) {
            const TtpCarInput& c = cars[i];
            if (mCarWheels.size() <= i) continue;
            CarWheels& cw = mCarWheels[i];
            WheelTrail* trails = &mWheelTrails[i * 4];
            const float spd = c.spd; // NORMALIZED v/vmax, like the JS snapshot
            const bool scrub = c.scrub > 0.5f;
            if (spd <= 0.05f && !scrub) {
                for (int wi = 0; wi < 4; wi++) resetWheel(trails[wi]);
                continue;
            }
            const float3 fwd = { c.forward.x, c.forward.y, c.forward.z };
            const float3 up = { c.up.x, c.up.y, c.up.z };
            const float3 posW = { c.pos.x, c.pos.y, c.pos.z };
            const float turn = std::min(1.0f, std::fabs(c.steer));
            const bool spinning = std::fabs(c.spin) > 0.05f;
            const float slip = scrub ? 1.0f
                    : std::max(0.0f, (turn - SKID_THRESH) / (1.0f - SKID_THRESH));
            const float brakeBite = (c.brake > SKID_BRAKE_MIN && spd > 0.25f)
                    ? (c.brake - SKID_BRAKE_MIN) / (1.0f - SKID_BRAKE_MIN) : 0.0f;
            const float launch = (cw.accelNorm > SKID_LAUNCH_MIN && spd < 0.5f)
                    ? std::min(1.0f, (cw.accelNorm - SKID_LAUNCH_MIN) / (1.0f - SKID_LAUNCH_MIN))
                            * (1.0f - spd / 0.5f) * 0.6f : 0.0f;
            const float raw = (scrub || spinning) ? 1.0f
                    : std::min(1.0f, std::max(slip * 1.3f, std::max(brakeBite, launch)));
            // Attack over SKID_ATTACK, release over the slower SKID_RELEASE
            // (SkidMarks.js released only — it attacked in a single frame).
            // The RELEASE is load-bearing: a scuff that stops dead leaves a
            // DASH, because bots weaving down a bendy stretch cross the scuff
            // threshold every few frames and clip the curb in between, and every
            // dip detaches the ribbon (below) so the fresh unjoined rear edges
            // stack into dark bars. Holding the strength through the dips keeps
            // one trail that fades instead.
            // The ATTACK is what makes a mark read as being LAID DOWN, because
            // `raw` is all but binary in practice: the phone's brake is a 0/1,
            // so `brakeBite` is only ever exactly 1.0, and `slip * 1.3`
            // saturates at a steer input of 0.815 that any real corner passes.
            // Unramped, every scuff arrived at peak ink already formed. A tenth
            // of a second is roughly the first car length getting dark.
            cw.skidHold = raw > cw.skidHold
                    ? std::min(raw, cw.skidHold + input.dt / SKID_ATTACK)
                    : std::max(raw, cw.skidHold - input.dt / SKID_RELEASE);
            const float strength = cw.skidHold;
            // Wheel contact patches from the posed wheel nodes (whirl included,
            // lean/dive not — JS wheels are children of the yawed car, not the
            // leaning body), dropped onto the road plane under the car.
            static const mat4f FLIP = mat4f::rotation(M_PI, float3{ 0, 1, 0 });
            const float3 right = normalize(cross(up, fwd));
            const mat4f m2{ float4{ right, 0 }, float4{ up, 0 }, float4{ fwd, 0 },
                            float4{ posW, 1 } };
            const mat4f poseSpun = (c.spin != 0)
                    ? m2 * mat4f::rotation(c.spin, float3{ 0, 1, 0 }) * FLIP
                    : m2 * FLIP;
            // While the monster transform is up the car's own wheels are scaled
            // to nothing and the RIG's fat tyres are the ones on the road, so
            // the trails come off THEIR contact points and carry THEIR width.
            // The rig rides the same `base` frame the car does (rigPose = flat),
            // so its rest translations live in this very local space.
            const bool onRig = c.monster > 0.5f && mMonsterWheels.size() > i
                    && !mMonsterWheels[i].bl.isNull();
            const MonsterWheels* mwp = onRig ? &mMonsterWheels[i] : nullptr;
            const float3 wlocal[4] = {
                mwp ? mwp->flT : cw.flT, mwp ? mwp->frT : cw.frT,
                mwp ? mwp->blT : cw.blT, mwp ? mwp->brT : cw.brT,
            };
            // The four-wheel channel releases on the same taper, so the fronts
            // fade out with the rears instead of stopping mid-mark.
            cw.skidAllHold = (scrub || spinning) ? 1.0f
                    : std::max(0.0f, cw.skidAllHold - input.dt / SKID_RELEASE);
            const bool marksAll = cw.skidAllHold > 0.02f;
            if (!marksAll) { resetWheel(trails[0]); resetWheel(trails[1]); }
            const float halfW = (mwp && mMonsterSkidWidth > 0
                    ? mMonsterSkidWidth : cw.skidWidth) / 2;
            for (int wi = marksAll ? 0 : 2; wi < 4; wi++) {
                WheelTrail& st = trails[wi];
                float3 gp = (poseSpun * float4{ wlocal[wi], 1 }).xyz;
                gp = gp - up * dot(gp - posW, up); // contact patch on the road plane
                if (!st.seeded) { st.last = gp; st.seeded = true; st.hasEdge = false; continue; }
                const float3 seg = gp - st.last;
                const float dist = length(seg);
                if (dist > SKID_SEG_MAX) { restart(st, gp); continue; }
                if (strength <= 0.02f) {
                    // Re-anchor EVERY frame while not marking, not just once the
                    // wheel has moved SKID_SEG_MIN: that parked `last` up to a
                    // quarter unit behind the tyre, and since the next scuff's
                    // first stamp spans last→gp the whole gap was written in ONE
                    // frame at full ink. A brake tap POPPED a mark 0.19 u long
                    // out of 0.075 u of travel, on a car 0.88 u long.
                    restart(st, gp);
                    continue;
                }
                if (dist < 1e-4f) continue;
                const float3 dir = seg * (1.0f / dist);
                const float3 U = normalize(up);
                float3 F = dir - U * dot(dir, U);
                if (dot(F, F) < 1e-9f) continue;
                F = normalize(F);
                const float3 Lv = cross(F, U) * halfW;
                if (st.hasEdge && dot(st.dir, dir) < SKID_EDGE_DOT) st.hasEdge = false;
                float3 rL, rR;
                if (st.hasEdge) { rL = st.edgeL; rR = st.edgeR; }
                else {
                    rL = st.last - Lv + U * 0.006f;
                    rR = st.last + Lv + U * 0.006f;
                }
                const float3 fL = gp - Lv + U * 0.006f;
                const float3 fR = gp + Lv + U * 0.006f;
                if (st.slot < 0) {
                    st.slot = (int) (mSkidCursor % POOL);
                    mSkidCursor = (mSkidCursor + 1) % POOL;
                    const int prev = mSkidOwner[st.slot];
                    if (prev >= 0) mWheelTrails[prev].slot = -1;
                    mSkidOwner[st.slot] = (int) (i * 4 + wi);
                }
                writeSlot(st.slot, (rL + rR) * 0.5f, (rR - rL) * 0.5f,
                        (fL + fR) * 0.5f, (fR - fL) * 0.5f, strength);
                st.dir = dir;
                if (dist >= SKID_SEG_MIN) {
                    detach(st);
                    st.edgeL = fL; st.edgeR = fR; st.hasEdge = true;
                    st.last = gp;
                }
            }
        }
        // Fade every live mark toward its patina floor (JS step()).
        for (uint32_t q = 0; q < POOL; q++) {
            if (mSkidLife[q] <= 0) continue;
            mSkidLife[q] -= input.dt;
            const float k = std::max(mSkidLife[q] / SKID_LIFE, 0.0f);
            const float a = mSkidPeak[q] * (SKID_PATINA + (1.0f - SKID_PATINA) * k);
            const uint32_t au = (uint32_t) std::lround(
                    std::min(1.0f, std::max(0.0f, a)) * 255.0f);
            Vertex* v = &mSkids.verts[(size_t) q * 8];
            for (int k : INK) v[k].abgr = (v[k].abgr & 0x00ffffffu) | (au << 24);
            dirty = true;
        }
        // YES, THIS RE-UPLOADS THE WHOLE POOL — 4096 slots x 8 verts x 16 B =
        // 512 KB — and refreshBounds rescans all 73,728 indices behind it, on
        // essentially every frame of a race (any mark laid in the last SKID_LIFE
        // seconds keeps `dirty` set). It looks like the obvious thing to make
        // incremental, so: MEASURED BEFORE BELIEVING IT, in the browser at the
        // 4-player cap with bots laying real rubber, off ttp_display_profile's
        // own kProfSkids — 0.2 ms, inside a 0.9 ms CPU frame, against a 16.7 ms
        // budget. That is 1.2% of the budget, with zero dropped vsyncs.
        //
        // So a min/max touched range here would buy back well under 1% of a
        // frame, in the one file in this tree that no ctest compiles and no
        // fixture covers. Not worth it. If that trade ever changes — a much
        // slower TV part, a bigger pool, or skids landing on the same frame as
        // something else expensive — the shape to reach for is tracking the
        // lowest and highest slot touched this frame and passing a byteOffset
        // to setBufferAt; the writes are already slot-indexed, so it is a small
        // change. Re-measure first.
        if (dirty) {
            mSkids.vb->setBufferAt(*mEngine, 0, VertexBuffer::BufferDescriptor(
                    mSkids.verts.data(), mSkids.verts.size() * sizeof(Vertex), nullptr));
            refreshBounds(mSkids);
        }
    }

    mProfile[kProfSkids] = ttpNowMs() - tMark; tMark += mProfile[kProfSkids];

    // Ambient sprite size. THREE.Points are sized in SCREEN space — its shader
    // is `gl_PointSize = size * (canvasHeight/2) / distance` — so a particle's
    // world extent works out to `size × rows × tan(fov/2)`, where `rows` is the
    // split-screen row count. That layout term is an accident of three using the
    // WHOLE canvas height while rendering into a cell, and it means the same
    // theme draws snow twice as big in a 4-player race as in a 1-player one.
    // Matching it is the parity goal, so we fit the same number each frame; if
    // the three side ever loses the quirk, this collapses to a constant.
    if (mPollenMat) {
        const uint32_t vc = input.viewCount;
        const uint32_t rows = vc ? (vc + (uint32_t) std::ceil(std::sqrt((double) vc)) - 1)
                        / (uint32_t) std::ceil(std::sqrt((double) vc))
                : 1u;
        const float fov = vc ? ttp_frame_views(&input)[0].fov : 50.0f;
        mPollenMat->setParameter("halfSize",
                mAmbSize * (float) rows * std::tan(fov * (float) M_PI / 360.0f));
    }

    // Frame pacing. beginFrame() drops a frame when the GPU is behind — it waits
    // on a fence from two frames ago, and on WEB that fence signals late enough
    // that it dropped ~38% of frames on an idle GPU. The cost is a stale canvas
    // while the page keeps ticking at full rate: the visible framerate falls but
    // the rAF-counting fps meter still reads 60, which is exactly what a stutter
    // with no explanation looks like. In a browser the pacing is already done
    // for us — rAF fires on the compositor's schedule and stops firing when we
    // can't keep up — so we take the choice the API offers: "when beginFrame()
    // returns false, the caller has the choice to either skip the frame ... or
    // proceed as though true was returned" (Renderer.h). Native shells keep the
    // skipper; they have a real display pipeline behind them and no rAF.
    // The 2D cell overlay's geometry for this frame — placed before beginFrame,
    // since it edits scene membership, and drawn after the present pass below.
    drawOverlay(input);

    mProfile[kProfAmbient] = ttpNowMs() - tMark; tMark += mProfile[kProfAmbient];
    const bool pace = mRenderer->beginFrame(mSwapChain);
    mProfile[kProfBeginFrame] = ttpNowMs() - tMark; tMark += mProfile[kProfBeginFrame];
#if defined(__EMSCRIPTEN__)
    (void) pace;
#else
    if (!pace) return false; // legit frame skip — canvas is STALE
#endif

    const TtpViewInput* views = ttp_frame_views(&input);
    if (input.viewCount == 0) {
        mRenderer->render(mView);
    } else {
        // Split-screen: same cell grid as the display (bestGrid ≈ square-ish,
        // row 0 on top — flipped here because GL viewports are bottom-left).
        mProfile[kProfCellSetup] = 0; mProfile[kProfCellRender] = 0;
        ensureSceneTarget();
        ensureCells(input.viewCount);
        for (uint32_t i = 0; i < input.viewCount; i++) {
            const CellRect rect = cellRect(input.viewCount, i);
            View* v = mCellViews[i];
            Camera* cam = mCellCameras[i];
            // Every cell into the one scene buffer, each in its own sub-rect.
            // Filament drops the colour clear after the first view of a frame
            // (depth still clears per view), so the cells accumulate instead of
            // wiping each other — the same thing three does with one target and
            // per-cell viewport + scissor.
            v->setRenderTarget(mSceneRT);
            v->setViewport({ rect.x, rect.y, rect.w, rect.h });
            mat4f world;
            std::memcpy(&world, views[i].world, sizeof(world));
            cam->setModelMatrix(world);
            cam->setProjection(views[i].fov, views[i].aspect,
                    views[i].nearZ, views[i].farZ, Camera::Fov::VERTICAL);
            // Fog rides the VIEW: the race cells, the lobby's perimeter orbit
            // and the overview each run their own ramp, and the gallery runs
            // none (fogFar <= fogNear).
            v->setFogOptions(fogFor(views[i].fogNear, views[i].fogFar, mFogColor));
            // Per-cell monster fade: a truck looming in front of THIS cell's
            // car swaps to its 50%-alpha ghost (chassis + grafted body), while
            // every other cell — including the monster driver's own — keeps it
            // solid. Same between-render() trick as the cloud billboards.
            for (size_t mi = 0; mi < mMonsterViews.size(); mi++) {
                const MonsterView& mv = mMonsterViews[mi];
                if (!mv.on) continue;
                const bool ghost = (mv.mask >> i) & 1u;
                static const mat4f GPARK = mat4f::translation(float3{ 0, -1000, 0 });
                const bool haveRigGhost = mMonsterGhostInstances.size() > mi
                        && mMonsterGhostInstances[mi];
                const bool haveBodyGhost = mCarGhostAssets.size() > mi && mCarGhostAssets[mi];
                const bool useGhost = ghost && haveRigGhost && haveBodyGhost;
                if (mMonsterInstances.size() > mi && mMonsterInstances[mi]) {
                    tcm.setTransform(tcm.getInstance(mMonsterInstances[mi]->getRoot()),
                            useGhost ? GPARK : mv.rig);
                }
                if (haveRigGhost) {
                    tcm.setTransform(tcm.getInstance(mMonsterGhostInstances[mi]->getRoot()),
                            useGhost ? mv.rig : GPARK);
                }
                if (mCarAssets.size() > mi && mCarAssets[mi]) {
                    tcm.setTransform(tcm.getInstance(mCarAssets[mi]->getRoot()),
                            useGhost ? GPARK : mv.body);
                }
                if (haveBodyGhost) {
                    tcm.setTransform(tcm.getInstance(mCarGhostAssets[mi]->getRoot()),
                            useGhost ? mv.body : GPARK);
                }
            }
            // Fliers ride the same per-cell billboard trick as the clouds.
            // Birds circle their roosts with a wing-beat that squashes the
            // glyph's height (SceneRenderer's flap); kites bob around their
            // anchors and sway on the string.
            if (mTrack && !mBirds.empty()) {
                const TrackBin& t = *mTrack;
                for (size_t bi = 0; bi < mBirds.size(); bi++) {
                    if (mBirds[bi].entity.isNull()) continue;
                    const float a0 = ((float) bi / 4) * 2.0f * (float) M_PI + (bi % 3) * 0.8f;
                    const float dy = (bi % 3) * 2.5f;
                    const float ph0 = bi * 2.1f, sp = 0.82f + (bi % 4) * 0.12f;
                    const float ph = ph0 + mTime * t.birdSpeed * sp;
                    const float3 p{
                        std::cos(a0) * t.birdRc * mHillSf + std::cos(ph) * t.birdRb,
                        t.birdY + dy * t.birdDys + std::sin(ph * 2.3f) * 0.9f,
                        std::sin(a0) * t.birdRc * mHillSf + std::sin(ph) * t.birdRb };
                    const float beat = 0.5f + 0.5f * std::sin(
                            (mTime * sp * t.birdFlapHz + ph0) * 2.0f * (float) M_PI);
                    const float yaw = std::atan2(world[3].x - p.x, world[3].z - p.z);
                    tcm.setTransform(tcm.getInstance(mBirds[bi].entity),
                            mat4f::translation(p) * mat4f::rotation(yaw, float3{ 0, 1, 0 })
                            * mat4f::scaling(float3{ t.birdSize,
                                    t.birdSize * 0.5f * (1 - t.birdFlap * 0.48f * beat), 1 }));
                }
            }
            if (mTrack && !mKites.empty()) {
                const TrackBin& t = *mTrack;
                for (size_t ki = 0; ki < mKites.size(); ki++) {
                    if (mKites[ki].entity.isNull()) continue;
                    const float a0 = 0.9f + ki * 2.6f, r = 105.0f + ki * 18.0f;
                    const float ph = ki * 1.7f;
                    const float3 p{
                        std::cos(a0) * r * mHillSf + std::sin(mTime * 0.55f + ph) * 2.2f,
                        t.kiteY + std::sin(mTime * 0.85f + ph * 2) * 1.6f
                                + std::sin(mTime * 2.1f + ph) * 0.35f,
                        std::sin(a0) * r * mHillSf + std::cos(mTime * 0.5f + ph) * 2.2f };
                    const float yaw = std::atan2(world[3].x - p.x, world[3].z - p.z);
                    const float roll = std::sin(mTime * 0.9f + ph) * 0.14f;
                    tcm.setTransform(tcm.getInstance(mKites[ki].entity),
                            mat4f::translation(p) * mat4f::rotation(yaw, float3{ 0, 1, 0 })
                            * mat4f::rotation(roll, float3{ 0, 0, 1 })
                            * mat4f::scaling(float3{ t.kiteSize }));
                }
            }
            // Dust banks drift faster than the clouds above them (wind shear
            // sells "dust", not "low cloud"), wrapping outside the hill ring.
            for (size_t hi = 0; hi < mHaze.size(); hi++) {
                if (mHaze[hi].entity.isNull()) continue;
                const float wrap = 300.0f * mHillSf;
                float3 p = mHazePos[hi];
                p.x = std::fmod(std::fmod(p.x + 2.2f * mTime + wrap, 2 * wrap)
                        + 2 * wrap, 2 * wrap) - wrap;
                p.x *= 1.0f; p.z *= mHillSf;
                const float yaw = std::atan2(world[3].x - p.x, world[3].z - p.z);
                tcm.setTransform(tcm.getInstance(mHaze[hi].entity),
                        mat4f::translation(p) * mat4f::rotation(yaw, float3{ 0, 1, 0 }));
            }
            // Per-view cloud billboards: single-threaded rendering executes
            // each render() immediately, so re-aiming the sprites between
            // cells gives every camera its own facing (the JS sprite way).
            for (size_t ci = 0; ci < mClouds.size(); ci++) {
                if (mClouds[ci].entity.isNull()) continue;
                // Push the AUTHORED position out to the SKY_BAND unfogged
                // band along its current direction (drift moves it in
                // authored space, like the JS). Size keeps the k^0.55
                // softening CALIBRATED AT THE 405 BAND, rescaled to the
                // farther SKY_BAND so the angular look is unchanged.
                float3 p0 = mCloudPos[ci];
                p0.x = std::fmod(std::fmod(p0.x + 0.7f * mTime + 300.0f, 600.0f)
                        + 600.0f, 600.0f) - 300.0f; // JS drift, closed-form
                const float len = std::max(1.0f, length(p0));
                const float k = SKY_BAND / len;
                const float3 p = p0 * k;
                const float sk = std::pow(405.0f / len, 0.55f) * (SKY_BAND / 405.0f);
                const float yaw = std::atan2(world[3].x - p.x, world[3].z - p.z);
                mEngine->getTransformManager().setTransform(
                        mEngine->getTransformManager().getInstance(mClouds[ci].entity),
                        mat4f::translation(p) * mat4f::rotation(yaw, float3{ 0, 1, 0 })
                        * mat4f::scaling(float3{ sk }));
            }
            // Boost streaks: AXIAL billboards (streakBillboard) — spin each
            // about its length axis (local Z) so the face (+Y) turns toward
            // THIS cell's camera; a fixed quad is edge-on from dead astern.
            for (size_t si = 0; si < mStreakMeshes.size(); si++) {
                Mesh& sm = mStreakMeshes[si];
                if (sm.entity.isNull()) continue;
                auto& tcmV = mEngine->getTransformManager();
                auto sInst = tcmV.getInstance(sm.entity);
                const Streak& st = mStreaks[si];
                const size_t car = si / 4;
                if (st.dead || st.alpha <= 0 || mCarBasis.size() <= car
                        || mCarBasisInv.size() <= car) {
                    tcmV.setTransform(sInst,
                            mat4f::translation(float3{ 0, -1000, 0 }));
                    continue;
                }
                const mat4f& P = mCarBasis[car];
                // The inverse is the car's, not the cell's — cached per car per
                // frame above rather than recomputed for each of the four cells.
                const float3 camL = (mCarBasisInv[car]
                        * float4{ world[3].x, world[3].y, world[3].z, 1 }).xyz;
                const float3 vv = camL - float3{ st.x, st.y, st.z };
                const float beta = std::atan2(-vv.x, vv.y);
                tcmV.setTransform(sInst,
                        P * mat4f::translation(float3{ st.x, st.y, st.z })
                          * mat4f::rotation(beta, float3{ 0, 0, 1 })
                          * mat4f::scaling(float3{ 0.07f, 1.0f, st.len }));
            }
            mProfile[kProfCellSetup] += ttpNowMs() - tMark; tMark = ttpNowMs();
            mRenderer->render(v);
            mProfile[kProfCellRender] += ttpNowMs() - tMark; tMark = ttpNowMs();
        }
        // One pass for the whole canvas: grade, sRGB, FXAA, done.
        if (mSceneRT) mRenderer->render(mPresentView);
    }
    // The cell overlay goes on LAST, over the graded canvas — see voverlay.mat
    // for why it is past the grade and not inside it.
    if (mOverlayUsed && mOverlayView) mRenderer->render(mOverlayView);
    mProfile[kProfPresent] = ttpNowMs() - tMark; tMark = ttpNowMs();
    mRenderer->endFrame();
    mProfile[kProfEndFrame] = ttpNowMs() - tMark;
    mProfile[kProfTotal] = ttpNowMs() - tFrame0;
    return true;
}

// A MaterialInstance owned by the scene: recorded for releaseScene().
MaterialInstance* TtpRenderer::sceneInstance(Material* m) {
    MaterialInstance* mi = m->createInstance();
    mSceneMatInstances.push_back(mi);
    return mi;
}

// Tear the scene down to bare engine + materials + provided bytes. The game
// rebuilds through here on every race: a Grand Prix chains four tracks, and
// even a restart on the SAME track wants the skid ribbons, kicked cones and
// collected boxes back at their starting state. Everything below is scene
// scope; the engine, swap chain, views, cameras, the three materials, the
// glTF loaders and mAssets all survive.
void TtpRenderer::releaseScene() {
    if (!mEngine) return;
    // Retire every in-flight command first: the meshes' CPU copies go with
    // them below, and the driver must not still be reading a BufferDescriptor
    // that points into one.
    mEngine->flushAndWait();
    destroyMesh(mRoad);
    destroyMesh(mGround);
    destroyMesh(mSky);
    destroyMesh(mHills);
    destroyMesh(mBalloon);
    for (auto& m : mCars) destroyMesh(m);
    destroyMesh(mPads);
    destroyMesh(mGantry);
    for (auto& m : mCarBlobs) destroyMesh(m);
    for (auto& m : mStreakMeshes) destroyMesh(m);
    for (auto& m : mPlates) destroyMesh(m);
    for (auto& m : mBoostDisks) destroyMesh(m);
    for (auto& m : mClouds) destroyMesh(m);
    destroyMesh(mBoulders);
    destroyMesh(mLandmarks);
    destroyMesh(mGroundShadows);
    destroyMesh(mClutter);
    destroyMesh(mOils);
    destroyMesh(mStructures);
    destroyMesh(mBerms);
    for (auto& m : mHaze) destroyMesh(m);
    destroyMesh(mWindmill);
    destroyMesh(mTrain);
    destroyMesh(mTrainKey);
    for (auto& m : mSmoke) destroyMesh(m);
    for (auto& m : mSignMeshes) destroyMesh(m);
    destroyMesh(mWater);
    destroyMesh(mWet);
    destroyMesh(mPlane);
    for (auto& m : mBirds) destroyMesh(m);
    for (auto& m : mKites) destroyMesh(m);
    destroyMesh(mPropShadows);
    for (auto& m : mPropBlobs) destroyMesh(m);
    destroyMesh(mSkids);
    for (auto& m : mBurstMeshes) destroyMesh(m);
    for (auto& m : mBurstBalls) destroyMesh(m);
    destroyMesh(mPollen);
    for (auto& m : mRockets) destroyMesh(m);
    for (auto& m : mRocketFlames) destroyMesh(m);
    // glTF assets own their instances — drop the entities from the scene first
    // so nothing dangles between destroyAsset() and the next build.
    const auto dropAsset = [&](gltfio::FilamentAsset*& a) {
        if (!a) return;
        mScene->removeEntities(a->getEntities(), a->getEntityCount());
        mAssetLoader->destroyAsset(a);
        a = nullptr;
    };
    for (auto*& a : mCarAssets) dropAsset(a);
    // Baked per-car silhouettes die with the roster that produced them.
    for (Texture*& t : mCarSilhouettes) { if (t) mEngine->destroy(t); t = nullptr; }
    mCarSilhouettes.clear();
    for (auto*& a : mCarGhostAssets) dropAsset(a);
    for (auto*& a : mSceneryAssets) dropAsset(a);
    dropAsset(mBoxAsset);
    dropAsset(mBoxFadeAsset);
    dropAsset(mBananaAsset);
    dropAsset(mConeAsset);
    dropAsset(mMonsterAsset);
    dropAsset(mMonsterGhostAsset);
    if (mResourceLoader) mResourceLoader->evictResourceData(); // decoded glTF source cache
    for (auto* mi : mSceneMatInstances) mEngine->destroy(mi);
    mSceneMatInstances.clear();
    mLitShadowInst = nullptr; // was one of those — never dangle into the next build
    if (mShadowMap) { mEngine->destroy(mShadowMap); mShadowMap = nullptr; }
    mPadMat = nullptr;
    for (utils::Entity e : { mSun, mFill }) {
        if (!e.isNull()) {
            mScene->remove(e);
            mEngine->destroy(e);
            utils::EntityManager::get().destroy(e);
        }
    }
    mSun = {};
    mFill = {};
    if (mAmbient) { mScene->setIndirectLight(nullptr); mEngine->destroy(mAmbient); mAmbient = nullptr; }
    if (mSkybox) { mScene->setSkybox(nullptr); mEngine->destroy(mSkybox); mSkybox = nullptr; }

    // Pools and per-scene state, back to their constructed values.
    mCars.clear();
    mCarAssets.clear();
    mCarGhostAssets.clear();
    mCarWheels.clear();
    mMonsterViews.clear();
    mMonsterInstances.clear();
    mMonsterGhostInstances.clear();
    mBoxInstances.clear();
    mBoxFadeInstances.clear();
    mBananaInstances.clear();
    mConeInstances.clear();
    mSceneryAssets.clear();
    mSceneryInstances.clear();
    mBoxXf.clear();
    mGroundInst = nullptr; // a scene instance; sceneInstance() owns the teardown
    mBoxCollectT.clear();
    mBoxPrevAvail.clear();
    mBoxShadowRest.clear();
    mBoxShadowFade.clear();
    mBoxShadowStride = 0;
    mCarGhostIn.clear();
    mMonsterIn.clear();
    mMonsterGhostIn.clear();
    mBananaIn.clear();
    mConeStates.clear();
    mSignMeshes.clear();
    mCarBlobs.clear();
    // Scene-scope instances (sceneInstance owns them) — drop the handles only.
    mCarBlobMats.clear();
    mCarBlobMasks.clear();
    mPlates.clear();
    mBoostDisks.clear();
    mStreaks.clear();
    mStreakMeshes.clear();
    mStreakSeed.clear();
    mCarBasis.clear();
    mCarBasisInv.clear();
    mPropBlobs.clear();
    mRockets.clear();
    mRocketFlames.clear();
    mPrevRockets.clear();
    mPrevRocketCount = 0;
    for (Burst& b : mBursts) b = {};
    // The instances themselves are scene-scoped (sceneInstance), already
    // destroyed above — just drop the dangling handles.
    for (int bi = 0; bi < 2; bi++) { mBurstRingMats[bi] = nullptr; mBurstBallMats[bi] = nullptr; }
    mClouds.clear();
    mCloudPos.clear();
    mHaze.clear();
    mHazePos.clear();
    mBirds.clear();
    mKites.clear();
    mSmoke.clear();
    mShadowSpots.clear();
    mPollenMat = nullptr; // a scene-scope instance — sceneInstance() destroyed it
    if (mGroundTex) { mEngine->destroy(mGroundTex); mGroundTex = nullptr; }
    mAmbBase.clear();
    mAmbSpeed.clear();
    mWheelTrails.clear();
    mSkidLife.clear();
    mSkidPeak.clear();
    mSkidOwner.clear();
    mSkidCursor = 0;
    mRoadGrid.clear();
    mGroundBands.clear();
    mHillAnchors.clear();
    mShoreFn = nullptr;
    mTrack.reset();
    mHasTrack = false;
    mHasTrain = false;
    mHillSf = 1;
    mTime = 0;
    mLastCar0 = {};
    mMonsterFootW = mMonsterFootL = 0;
    mMonsterWheels.clear();
    mMonsterWheelRadius = 0;
    mMonsterSkidWidth = 0;
    if (mMonsterSilhouette) { mEngine->destroy(mMonsterSilhouette); mMonsterSilhouette = nullptr; }
    mBoxScale = 1.0f;
}

TtpRenderer::~TtpRenderer() {
    if (!mEngine) return;
    releaseScene();
    if (mBlendMaterial) mEngine->destroy(mBlendMaterial);
    if (mPointMaterial) mEngine->destroy(mPointMaterial);
    if (mBurstMaterial) mEngine->destroy(mBurstMaterial);
    if (mGroundMaterial) mEngine->destroy(mGroundMaterial);
    if (mEsmMaterial) mEngine->destroy(mEsmMaterial);
    if (mBlurMaterial) mEngine->destroy(mBlurMaterial);
    if (mWhiteTex) mEngine->destroy(mWhiteTex);
    if (mShadowMaskTex) mEngine->destroy(mShadowMaskTex);
    if (mShadowMap) mEngine->destroy(mShadowMap);
    if (mDecalMaterial) mEngine->destroy(mDecalMaterial);
    delete mResourceLoader;
    delete mStbProvider;
    if (mAssetLoader) gltfio::AssetLoader::destroy(&mAssetLoader);
    delete mNames; // outlives the loader: it holds the name components
    mNames = nullptr;
    if (mMatProvider) { mMatProvider->destroyMaterials(); delete mMatProvider; }
    if (mColorGrading) mEngine->destroy(mColorGrading);
    delete mToneMapper;
    destroySceneTarget();
    if (mPresentView) mEngine->destroy(mPresentView);
    if (mPresentScene) mEngine->destroy(mPresentScene);
    if (mPresentCamera) {
        mEngine->destroyCameraComponent(mPresentCameraEntity);
        utils::EntityManager::get().destroy(mPresentCameraEntity);
    }
    if (mPresentQuad) {
        mEngine->destroy(mPresentQuad);
        utils::EntityManager::get().destroy(mPresentQuad);
    }
    if (mPresentVB) mEngine->destroy(mPresentVB);
    if (mPresentIB) mEngine->destroy(mPresentIB);
    if (mPresentInstance) mEngine->destroy(mPresentInstance);
    if (mPresentMaterial) mEngine->destroy(mPresentMaterial);
    for (OverlayQuad& q : mOverlayQuads) {
        mEngine->destroy(q.entity);
        utils::EntityManager::get().destroy(q.entity);
        if (q.mi) mEngine->destroy(q.mi);
    }
    mOverlayQuads.clear();
    if (mOverlayView) mEngine->destroy(mOverlayView);
    if (mOverlayScene) mEngine->destroy(mOverlayScene);
    if (mOverlayCamera) {
        mEngine->destroyCameraComponent(mOverlayCameraEntity);
        utils::EntityManager::get().destroy(mOverlayCameraEntity);
    }
    if (mOverlayVB) mEngine->destroy(mOverlayVB);
    if (mOverlayIB) mEngine->destroy(mOverlayIB);
    if (mOverlayMaterial) mEngine->destroy(mOverlayMaterial);
    if (mMaterial) mEngine->destroy(mMaterial);
    if (mLitMaterial) mEngine->destroy(mLitMaterial);
    for (size_t i = 0; i < mCellViews.size(); i++) {
        mEngine->destroy(mCellViews[i]);
        mEngine->destroyCameraComponent(mCellCameraEntities[i]);
        utils::EntityManager::get().destroy(mCellCameraEntities[i]);
    }
    mEngine->destroy(mView);
    mEngine->destroy(mScene);
    mEngine->destroy(mRenderer);
    mEngine->destroy(mSwapChain);
    mEngine->destroyCameraComponent(mCameraEntity);
    utils::EntityManager::get().destroy(mCameraEntity);
    Engine::destroy(&mEngine);
}
