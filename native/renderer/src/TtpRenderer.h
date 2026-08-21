// libttp-renderer — platform-free Filament renderer (docs/native-port/plan.md
// Track R). Shells prepare the surface (GL context current / CAMetalLayer) and
// pass backend + native window through init(); everything else lives here so
// the same code ships on web, tvOS and Android TV.
//
// The scene is built from three things the caller already holds: the built
// track (ttp::RaceTrack — the one the sim races on), the resolved biome
// (ttp::rt::Theme), and the roster's liveries (TtpRosterCar). NONE of them is
// serialized any more — "track.bin", the last byte payload, went when the
// roster started crossing typed. From those come the road ribbon swept from the
// centerline, ground/sky/hills, scenery and furniture, cars from provided GLBs,
// and 2×2 split-screen with per-cell cameras from FrameInput.views. An EMPTY
// roster is a legal scene: it is what the lobby's track preview draws.
#pragma once

#include "ttp_render.h"

// The built track the scene is meshed from. libttp-track is platform-free and
// header-light; this pulls in the geometry PODs only (no track catalogue — which
// track to build stays the runtime's decision, not the renderer's).
#include "ttp/trackbuilder.h"

// The resolved biome. Same deal: libttp-runtime owns the palette tables, and
// this is a HEADER dependency on the resolved struct — never a link edge, since
// libttp-runtime must stay buildable (and ctested) on the legs that have no
// Filament SDK.
#include "ttp/theme.h"
#include "ttp/wear.h"
// The GLB mesh reader behind the merged draw groups — header-only for the same
// no-link-edge reason as theme.h above; ctests execute it on every leg.
#include "ttp/glb_mesh.h"

#include <backend/DriverEnums.h>
#include <math/mat4.h>
#include <math/vec3.h>
#include <utils/Entity.h>

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace filament {
class Engine;
class IndirectLight;
class SwapChain;
class Renderer;
class View;
class Scene;
class Camera;
class Skybox;
class Texture;
class RenderTarget;
class Material;
class VertexBuffer;
class IndexBuffer;
class MaterialInstance;
class InstanceBuffer;
namespace gltfio {
class AssetLoader;
class FilamentAsset;
class FilamentInstance;
class MaterialProvider;
class ResourceLoader;
class TextureProvider;
} // namespace gltfio
} // namespace filament

namespace utils {
class NameComponentManager;
} // namespace utils

class TtpRenderer {
public:
    // Out of line: members hold unique_ptr<TrackBin> (incomplete here).
    TtpRenderer();
    ~TtpRenderer();

    TtpRenderer(const TtpRenderer&) = delete;
    TtpRenderer& operator=(const TtpRenderer&) = delete;

    // nativeWindow: what the platform's createSwapChain wants (nullptr on web —
    // the shell already made the WebGL2 context current).
    //
    // stereoEyes > 0 configures the ENGINE for OVR_multiview stereo (2 eyes is
    // what the blobs bake — matc has no eye-count key). Engine-creation-time
    // only, which is why it rides init rather than a setter; a MULTIVIEW engine
    // with no stereo view set costs the same as a NONE one (measured on the
    // box), so the Android surface passes 2 unconditionally and
    // setMultiview() switches the actual render path live. Android-only:
    // glFramebufferTextureMultiviewOVR is compiled out everywhere else.
    bool init(filament::backend::Backend backend, void* nativeWindow,
            uint32_t width, uint32_t height, uint8_t stereoEyes = 0);
    // The live half of the multiview switch: route split-screen cells through
    // the stereo passes (renderCellsMultiview) instead of one render() per
    // cell. A no-op unless init() configured stereo and the served blobs carry
    // the multiview variants (mPresentMvMaterial is the probe for that).
    //
    // mode 0 = never; 1 = FOUR cells only (the default — the measured policy:
    // 4P collapses two whole pass floors and wins the tail, while 2P pays the
    // resolve for one floor and 3P renders its odd cell twice, both measured
    // REGRESSIONS — shells/androidtv/CLAUDE.md); 2 = any split (experiments).
    void setMultiview(int mode) { mMultiviewMode = mode; }
    // The platform surface reports the device's GL_MAX_TEXTURE_SIZE here
    // before init; unreported keeps the conservative 8192 floor. See
    // mMaxTextureDim for what it buys the skid layer.
    void setMaxTextureDim(uint32_t d) { if (d >= 2048) mMaxTextureDim = d; }
    void resize(uint32_t width, uint32_t height);
    // Skip the sun's shadow bake for every scene built from here on. The bake is
    // a 2048² depth pass over the whole circuit plus its ESM blur, once per
    // track — cheap on a GPU, a genuinely heavy frame under software GL, and a
    // Grand Prix pays it four times. Headless automation turns it off (the JS
    // renderer this replaced did the same, via navigator.webdriver → key
    // .castShadow = false). Takes effect at the next buildScene; not a live
    // toggle, since the map is baked into the scene.
    // Clears the bake's reuse key with it: shadows-off drops the resident maps,
    // so the next build must re-bake rather than match a key against nothing.
    void setShadowsEnabled(bool on) { mShadowsEnabled = on; mBakedKey.clear(); mRoadLight.clear(); }

    // ---- model variants (dev) ---------------------------------------------
    // Which take on a named prop ("rocket", "gnome", "train") this and every
    // later scene is built with, and — for the asset gallery's MODEL BENCH —
    // which prop to stand ALL of its variants in a row of instead of building
    // the usual landmark set. Both are latched, like the biome override: they
    // change what the next buildScene meshes, not what a frame draws.
    //
    // Variant 0 is the ORIGINAL geometry of each, kept as the thing the others
    // are argued against; what actually ships is mModelVariant's defaults, see
    // there. An out-of-range variant clamps to that model's own count (they
    // differ). Unknown names are ignored — for the bench that means off, which
    // "" also means.
    void setModelVariant(const char* model, int variant);
    void setModelBench(const char* model);

    // ---- the kit field (dev) ----------------------------------------------
    // Stand `count` provided models — kit0.glb … kit<count-1>.glb — on clear
    // ground beside the track, each seated on the surface at the size it would
    // ship. That is the asset gallery's browser for the Kenney kits the game
    // picks from: a sheet of preview renders can say what a model is, and only
    // the field can say whether it belongs beside what already ships.
    //
    // Latched like the bench, and for the same reason — the field is meshed at
    // buildScene. 0 builds no field, which is every caller but the gallery.
    //
    // kitFieldLayout() answers where they ended up: a JSON array in the same
    // order, one {"d","h","w","x","y","z"} per model — its size, measured off
    // its own glTF AABB, and the spot it stands on. The chrome frames a model
    // from that, so the two cannot disagree about where one is or how big.
    void setKitField(int count);
    const char* kitFieldLayout() const { return mKitLayout.c_str(); }

    bool provideAsset(const char* name, const uint8_t* bytes, uint32_t len);
    // The bytes provided under `name`, or nullptr. The scene's caller needs the
    // scenery GLBs back: half of a biome's recolour rule is each model's own
    // AUTHORED material colours, and this class is where those bytes live.
    const std::vector<uint8_t>* asset(const char* name) const;
    // `geo` is the built track this scene is meshed from — the SAME ttp::RaceTrack
    // the sim races on, handed straight over rather than serialized; `theme` is
    // the resolved biome, likewise a live object rather than a payload; `roster`
    // is the one thing the SHELL supplies, in slot order, and it too is now
    // plain structs rather than the "track.bin" byte buffer it used to be.
    // NOTHING about a scene is serialized any more.
    // `wear` is the road-wear plan for the same track (ttp/wear.h) — computed
    // by the CALLER (the display shim links libttp-runtime; this class only
    // includes its headers): its patches become deck PAINT (buildDeckPaint),
    // not decals.
    // What THIS build's static scene is, for the shadow bake's reuse test —
    // see bakeShadowMap. The renderer is handed geometry and a theme, neither of
    // which names anything; only the shim knows a scene is "cove under the beach
    // biome". Latched before buildScene, like the biome one level up, and EMPTY
    // means "never reuse" so a caller that has not thought about it cannot
    // accidentally opt in.
    void setBakeKey(const char* key) { mBakeKey = key ? key : ""; }

    // The resident sun bake as bytes, and back. See the block comment above
    // exportBake in TtpRendererBakes.cpp for why this crosses the ABI at all.
    // export answers false when nothing is baked; import answers false for any
    // blob it does not fully trust, and leaves a resident bake untouched when
    // it does.
    bool exportBake(std::vector<uint8_t>& out);
    bool importBake(const uint8_t* bytes, uint32_t len);

    bool buildScene(const ttp::RaceTrack& geo, const ttp::rt::Theme& theme,
            const std::vector<TtpRosterCar>& roster, const ttp::rt::WearPlan& wear);
    // Re-dress the BUILT scene's car slots in place — same track, same slot
    // count, camera state and cosmetic clocks untouched. `remodel` slots reload
    // their GLB (the shell re-provided car<slot>.glb first) plus ghost and
    // silhouette; `redress` slots rebuild only what wears the livery.
    // Which slots go in which list is planReroster's call (ttp/roster.h) — this
    // performs it. False = no scene to re-dress or a slot failed; the caller
    // falls back to a full build.
    bool reroster(const std::vector<TtpRosterCar>& roster,
            const std::vector<uint32_t>& remodel,
            const std::vector<uint32_t>& redress);
    // Destroy everything the scene owns — meshes, glTF assets, lights, sky,
    // material instances — and reset the per-scene state, so buildScene() can
    // run again on a new track (a Grand Prix chains four of them) or a new
    // roster. The engine, views, materials and provided asset bytes survive.
    void releaseScene();
    bool render(const TtpFrameInput& input); // false = beginFrame skipped (stale canvas)

    // The rect view i actually RENDERS into, in GL viewport terms (bottom-left
    // origin) — a tile of the split-screen grid, after that grid has been
    // fitted to the aspect band as one piece. The runtime asks for it to size
    // its projection to what is really drawn.
    struct CellRect { int32_t x, y; uint32_t w, h; };
    CellRect cellRect(uint32_t n, uint32_t i) const;

    // THE SAME RECT, TOP-LEFT, which is the form every consumer of the ANSWER
    // wants: ttp_display_cell_rects hands it to the shell for the HUD, and
    // drawOverlay places the steer bar with it.
    //
    // It exists because those two had drifted apart. drawOverlay used
    // ttp_grid_cell — the RAW surface tiled edge to edge — while the picture is
    // fitted to the aspect band and centred, so wherever a bar appears the two
    // disagree about where a cell is. Measured at 2560x720 with four cells:
    // the steer bars sat at x 640 and 1920, the raw grid's cell centres, while
    // their cells were actually centred at 860 and 1700 — each bar a fifth of a
    // cell out, hugging the wrong side, under a car that was not there. The
    // shell's own chrome (name chip, place, lap) was right all along, because it
    // comes from cellRect; the bar was the one piece drawn off a second grid.
    //
    // Note what is NOT a consumer: the divider SPAN. It stays the canvas — see
    // drawOverlay.
    TtpCellRect cellRectTopLeft(uint32_t n, uint32_t i) const;

    // The ONE number a cell's projection needs, for an n-cell layout on this
    // surface: the cell's ASPECT. It is handed to the projection, where it
    // decides how much is revealed beside the authored vertical view.
    //
    // There is no second number. A cell used to also get its share of the grid's
    // HEIGHT, and the vertical fov was cropped by it (ttp::rt::cellFov); see
    // buildFrame's note for why splitting no longer re-frames.
    //
    // It lives with the rects rather than in each shell because it is a pure
    // function of the same grid, and a shell that derived it would be a fourth
    // copy of it. tvOS and Android call this and pass it straight through.
    float cellAspect(uint32_t n) const;

    // A cell's shape is held in this band, and the band is the ONLY thing about
    // the picture a layout may change. 16:9 is the BASE — the authored
    // composition, and the floor a too-tall tile is letterboxed up to. 21:9 caps
    // how far past it a wide tile may go before the sides become bars.
    //
    // Width past the base only REVEALS: the vertical fov is the rig's authored
    // one in every layout, so a wider cell is the base picture with more world at
    // the sides. Narrower would HIDE world, which is why the base is a hard floor
    // and the cap is only taste.
    static constexpr float CELL_BASE_ASPECT = 16.0f / 9.0f;
    static constexpr float CELL_MAX_ASPECT = 21.0f / 9.0f;

    // What the built track measures, for the runtime's overview cameras and fog
    // bands (TtpTrackFraming, ttp_render.h — the plain-data contract, so the
    // runtime can consume it without knowing this class exists).
    bool trackFraming(TtpTrackFraming& out) const;

    // Worst-case distance from a camera orbiting at (radius, height) about the
    // track centre to any centerline point — a point sitting diametrically
    // opposite it. The overview fog's near plane starts just past this, so the
    // whole circuit stays crisp however the turntable is pointed.
    float maxOrbitDist(float radius, float height) const;

    // Per-section wall clock of the last frame, in milliseconds. Diagnostic
    // only — the sections are cheap (a clock read each) and the array is what
    // ttp_profile() hands the page. Order matches kProfileNames. New slots go
    // AFTER kProfTotal: every reader maps by name, but keeping the original
    // indices stable is free and keeps an old APK readable by a new script.
    //
    // kProfDecalUp is a SUB-SPAN of kProfWorld (uploadDeckDecals runs inside
    // renderWorld), so world keeps meaning what it always did; a world spike
    // with a matching decalUp spike is the per-chunk uniform writes.
    // kProfBuild is the frame-input build (ttp::rt::buildFrame), which runs in
    // ttp_display_core BEFORE render() — inside the shell's per-frame span
    // (the ttp:render atrace marker) but outside kProfTotal. The core posts it
    // via noteBuildMs so the one profile array covers that whole span.
    enum ProfileSlot : uint32_t {
        kProfCars = 0, kProfWorld, kProfSkids, kProfAmbient, kProfBeginFrame,
        kProfCellSetup, kProfCellRender, kProfPresent, kProfEndFrame, kProfTotal,
        kProfDecalUp, kProfBuild,
        kProfCount
    };
    const double* profile() const { return mProfile; }
    void noteBuildMs(double ms) { mProfile[kProfBuild] = ms; }
    static const char* const* profileNames();

    // The BACKEND's own GPU timer, in milliseconds, or 0 where there is none.
    // See ttp_display_gpu_ms for which platforms answer and which do not.
    double gpuMs() const { return mGpuMs; }

    // The full-screen antialias pass, and with it the offscreen scene buffer it
    // exists to filter. See ttp_display_antialias.
    void setAntialias(bool on) {
        if (mAntialias == on) return;
        mAntialias = on;
        if (!on) destroySceneTarget();   // ~8 MB at 1080p, and nothing reads it now
    }

    // Block until the driver thread has executed everything recorded so far —
    // the one safe moment for a shell to resize the window's buffer queue
    // underneath it (ttp_display_drain has the why).
    void drain();

private:
    // One interleaved vertex everywhere for now: position + sRGB colour, drawn
    // by the shared unlit "vcolor" material (the cheap-matte families land with
    // the material-inventory work, plan.md Track R step 1).
    struct Vertex {
        float px, py, pz;
        uint32_t abgr;
    };

    struct Mesh {
        filament::VertexBuffer* vb = nullptr;
        filament::IndexBuffer* ib = nullptr;
        utils::Entity entity;
        // Extra renderables over RANGES of the same buffers (chunked meshes —
        // the road). One renderable spanning a whole circuit can never be
        // frustum-culled; a chain of them culls down to what's on screen.
        std::vector<utils::Entity> chunks;
        // CPU copies stay alive for the whole run — BufferDescriptors carry no
        // release callback, so the GPU upload may read them at any flush.
        std::vector<Vertex> verts;
        std::vector<uint32_t> idx;
        // Optional per-vertex normals → the mesh renders LIT (vlit material,
        // qtangents in a second buffer slot). Empty = unlit vcolor.
        std::vector<filament::math::float3> normals;
        std::vector<filament::math::quatf> quats; // derived; alive for upload
        // Optional UV0, in its own buffer slot: the road (track space, which
        // vroad shades its decals from), the ambient-particle sprites (the
        // corner offset vpoint billboards by) and the cloud/haze puffs (the
        // field vcloud shapes them from). Most meshes are position + colour, so
        // UVs stay out of the shared vertex.
        std::vector<filament::math::float2> uvs;
        // Optional BAKED per-vertex matte light (half4, rgb·1) — the road
        // under the baked-light vroad, filled by fillRoadLight. Non-empty ⇒
        // buildMesh feeds CUSTOM0 INSTEAD of TANGENTS (nothing at draw time
        // reads the normal; m.normals stays populated for the CPU bake).
        // Alive for the run like every CPU copy here, and bakeShadowMap
        // re-uploads it in place once the ESM exists.
        std::vector<filament::math::half4> custom0;
        uint8_t custom0Slot = 0;
        // Flat-decal template in car-local (x, z) with its rest alpha: the
        // conform rewrites `verts` into world space from this every frame.
        struct Local { float x, z; uint8_t a; };
        std::vector<Local> local;
        // Whether this mesh's entities are currently IN mScene. Pooled meshes
        // (blobs, streaks, rockets, bursts) leave the scene when they go idle
        // rather than parking underground — see setMeshInScene.
        bool inScene = false;
    };

    struct TrackBin; // one scene's roster + theme + geometry (defined in the .cpp)

    filament::Engine* mEngine = nullptr;
    filament::SwapChain* mSwapChain = nullptr;
    filament::Renderer* mRenderer = nullptr;
    filament::View* mView = nullptr; // single default view (no-views fallback)
    filament::Scene* mScene = nullptr;
    filament::Camera* mCamera = nullptr;
    filament::Skybox* mSkybox = nullptr;
    filament::Material* mMaterial = nullptr;    // unlit vertex-colour
    filament::Material* mLitMaterial = nullptr; // cheap-matte lit (custom Lambert)
    // vlit minus the sun-shadow sampler (vlitns.mat), for the dressing that
    // never reads the map — a bound sampler is per-draw descriptor cost even
    // when shadowTexel=0 early-outs every fragment. Null on a shell whose
    // asset set predates it; buildMesh then falls back to vlit.
    filament::Material* mLitPlainMaterial = nullptr;
    // The road deck only: mLitMaterial's shading (shared via ttp_shade.inc)
    // plus a uv0 channel carrying track space (s, lat), so flat deck decals are
    // SHADED INTO the road rather than laid over it — no lift, no z-fight,
    // no render order. Null if the shell served no vroad.filamat, in which
    // case the road falls back to vlit and stamps nothing.
    filament::Material* mRoadMaterial = nullptr;
    filament::MaterialInstance* mRoadInst = nullptr;
    // THE PER-FRAME GATHER cap, and it is CPU-side only: this list is the whole
    // scene's decals before any chunk sees them, so it costs a memcpy and
    // nothing on the GPU. The two numbers that DO cost are below.
    static constexpr int kMaxDeckDecals = 32;
    // PER CHUNK, PER CHANNEL — and these are the expensive constants in the
    // renderer. vroad declares one dynamically-indexed uniform array per field
    // per channel, and a PowerVR pays for a declared array whether or not the
    // loop runs: measured on a GE9215 over a frozen single-player race at
    // 1280x720, one mixed 32-entry list (7 arrays, 3584 bytes) cost 25.9 ms of
    // GPU, the same seven arrays at 16 cost 18.9 and at 8 cost 17.6. Splitting
    // by kind buys the capacity back — a masked entry needs five fields and a
    // profile entry three, so 8+8 is 1024 bytes for sixteen entries where one
    // mixed list of eight spent 896 for eight.
    //
    // Eight profile is the item-box shadows, oil slicks and boost auras within
    // one ~35u chunk; the fold takes them in the shell's priority order, so an
    // overflow drops the last aura rather than a marker. RAISING IT IS
    // MEASURABLE IN THE FRAME, and the parked-view reading that declared size
    // had become free does NOT survive a real pack: the 2026-08-18 spectate-7
    // arm that raised profile to 16 with nothing else changed cost +1.1 ms
    // p50 / +1.5 p95 at 720p. vroad.mat's float4[8]s must agree;
    // tests/road-decal-caps.test.js holds the two together.
    //
    // THE MASKED BUDGET IS PER VIEW, and this constant is that rule.
    //
    // The budget is what the active cameras may dress in true silhouettes
    // between them — a camera's own car plus adjacent rivals — and it is also
    // the declared array size.
    //
    // It was a single GLOBAL pool of four, ranked by distance to the NEAREST
    // camera, and that is a bug the moment the screen splits: four cameras
    // competing for four slots have no headroom at all, so one bot drafting
    // any player (a drafting car sits within a metre of that player's eye,
    // nearer than the player's own car at CHASE_DIST) evicted the
    // fourth-ranked car — which is some other player's own car — straight to
    // the texture blob, with no crossfade because the rank gate jumps lodT to
    // 1. User-caught: "with 4 players one of them has an oval blob".
    //
    // FOUR, spent ROUND ROBIN over the active views: every camera takes its
    // first choice before any takes its second, so a four-way split spends the
    // whole budget on round one — each player's own car — while solo spends
    // all four rounds on its single view, exactly as it always did. One
    // number, not a total plus a per-view allowance: round-robin already says
    // "fair", and a single view must be able to take the lot.
    //
    // The live entry count is therefore four at EVERY player count, which is
    // why the rule costs nothing — only WHICH four changes.
    //
    // FOUR AND NOT EIGHT IS MEASURED, and the measurement is worth keeping
    // because the intuition it killed was reasonable. Ablating the whole decal
    // channel at 4 players / 720p saves only ~0.55 ms (interleaved ABAB,
    // inside this box's noise), which reads like an invitation to dress all
    // eight cars. It is not: a build that raised this cap to 8 cost +4.96 ms
    // p50 (30.98 -> 35.93, fps 28 -> 25, three interleaved reps, no overlap),
    // while the same build at 1 player measured ZERO against [4] (17.47 vs
    // 17.28). So the cost is NOT linear in live entries and NOT the declared
    // size — it is the per-chunk BOUNDS BOX: four masked cars in a split sit
    // in four different chunks with a tight box each, and eight put two in a
    // chunk with a union spanning both, so the fragments that enter the loop
    // multiply as well as the iterations they then run. Raising this cap
    // needs a per-entry reject, not a bigger budget.
    static constexpr int kMaxMaskedDeckDecals = 4;
    static constexpr int kMaxProfileDeckDecals = 8;
    // The STATIC list's own cap. The per-chunk bounds above are what the shader
    // sees — uploadDeckDecals folds each ~35u chunk its own nearby subset — so
    // the track-wide list may exceed them. This is only a guard: since the pads
    // left for the paint channel the statics are the boxes plus the slicks, well
    // under it on any catalogue track.
    static constexpr int kMaxStaticDeckDecals = 96;
    // Deck-paint entries per road chunk — matches vroad.mat's float4[8]. A
    // chunk carries a couple of repairs (3..6 over a whole lap) plus whatever
    // pads land in its ~35u; the surplus is simply dropped.
    static constexpr int kMaxChunkPaint = 8;
    // The entry layout for BOTH deck channels — vroad reads rect/color/shape
    // the same way whichever array they arrive in (paint fills only those
    // three; the mask fields below are the decal channel's alone). Kept POD
    // with no padding: uploadDeckDecals memcmps these to skip a chunk whose
    // list hasn't changed.
    struct DeckDecal {
        filament::math::float4 rect;   // s, lat, halfS, halfLat — ALL world units
        filament::math::float4 color;  // linear rgb, peak alpha
        filament::math::float4 shape;  // innerFrac, isEllipse, kneeAlpha, chevrons
        // sin, cos, decalMask layer, masked flag. All zero for a profile decal;
        // masked decals (the car shadows) carry their heading rotation and the
        // silhouette layer, and rect.zw become the halves in the CAR's frame.
        filament::math::float4 texrot;
        // Masked decals only (zero on profile decals): the DECK point under
        // the car and the deck-plane axes at its in-plane heading (NOT the
        // car's own axes — these are the heading dropped into the plane the
        // car sits on, see renderCars). The MASK samples a rigid planar
        // projection of the fragment's world position onto these — track
        // space only BOUNDS the
        // stamp (the |ds|/|dl| reject, which is what keeps a loop's other
        // deck out). Painting the silhouette itself in curvilinear (s, lat)
        // bent it around every bend, and the per-triangle kinks of the
        // interpolated field made that wrap RIPPLE through the sharp-edged
        // mask as the car crossed rings — the "shadow edges shimmer in
        // corners" report. A plane has no kinks; the stamp is rigid, exactly
        // what the mesh-sheet shadow drew before 3688c5b.
        // The w slots carry the stamp's MEASURED track-space reach — half an
        // arclength window in wfwd.w, half a lateral one in wright.w. They are
        // not derivable from rect.zw: those are world lengths and this test is
        // in arclength, which the deck's fanning iso-lines make a different
        // number everywhere off the centreline. vroad.mat and foldToChunk both
        // read them and must read the same one.
        filament::math::float4 wpos;   // xyz deck point under the car
        filament::math::float4 wfwd;   // xyz heading in the plane (unit), w half-s
        filament::math::float4 wright; // xyz its right (unit),           w half-lat
    };
    std::vector<DeckDecal> mDeckDecals;      // gathered per frame
    std::vector<DeckDecal> mDeckDecalsLast;  // last frame's, for debugDeckDecals()

    // render(), split along the profiler's zones (TtpRendererFrame.cpp). What
    // crosses a phase boundary crosses as a parameter: the car contract slots,
    // the ground-conformed car positions, and the boost auras held back so
    // every aura composites UNDER every shadow (a mix composite REPLACES what
    // is under it, so the mesh era's order inverts — see render()'s auraDecals).
    void renderCars(const TtpFrameInput& input, const TtpCarInput* cars, uint32_t nCars,
            std::vector<filament::math::float3>& carPosW, std::vector<DeckDecal>& auraDecals);
    void renderWorld(const TtpFrameInput& input, const TtpCarInput* cars, uint32_t nCars,
            const std::vector<filament::math::float3>& carPosW, std::vector<DeckDecal>& auraDecals);
    void renderSkids(const TtpFrameInput& input, const TtpCarInput* cars, uint32_t nCars);
    void renderAmbient(const TtpFrameInput& input);
    void renderCells(const TtpFrameInput& input, double& tMark);
    void readGpuTimer();
    // Decals that never move — boost pads, launch strips, oil slicks, item-box
    // contact shadows. Resolved once at track build and re-queued each frame,
    // which is cheaper than it sounds (a memcpy of a handful of float4s) and
    // keeps ONE code path for compositing order.
    std::vector<DeckDecal> mStaticDeckDecals;
    // ONE MATERIAL INSTANCE PER ROAD CHUNK, each told only the decals that
    // overlap its own stretch of track. The road is already chunked for frustum
    // culling, and a chunk covers a contiguous arclength range because the ribbon
    // is built ring by ring — so the same split culls decals for free. Without
    // it every road fragment tested every decal on the lap: measured 0.358 ms of
    // a 0.949 ms frame, against 0.591 ms with the loop compiled out.
    struct RoadChunk {
        filament::MaterialInstance* mi;
        float sMin, sMax;   // arclength covered, before the decal margin
        // What this chunk's instance was last handed in each channel (folded),
        // so a chunk whose stretch nothing dynamic crossed skips its uniform
        // writes entirely. TWO lists because the two have separate caps: a
        // chunk can overflow one and not the other, and comparing a
        // concatenation would then rewrite both.
        std::vector<DeckDecal> lastMask, lastProf;
        // The paint entries this chunk was built with. Written once per track,
        // so it is kept only so the ablation debug can put the channel back.
        int paintN = 0;
    };
    std::vector<RoadChunk> mRoadChunks;
    // Ditto for the whole-lap fallback chunk.
    std::vector<DeckDecal> mRoadInstLastMask, mRoadInstLastProf;
    int mRoadInstPaintN = 0;               // and its RoadChunk::paintN
    // The masked decals' silhouette store: one 2D-array texture, one layer per
    // distinct car MODEL, one for the monster rig, one for the generic
    // superellipse. Engine-lifetime — layers are REBAKED per scene, the flags
    // below say which ones currently hold this scene's bake.
    //
    // MODEL, NOT SLOT. Eight cars race but the kit holds four models, so a
    // per-slot store baked the same silhouette up to twice over and spent
    // 512 KB a layer doing it. A slot claims its layer by the BYTES of its
    // GLB (claimMaskLayer), so two players in one model at different liveries
    // share one bake — coverage rides ALPHA, which carries no colour.
    // protocol.js's CAR_MODELS is the source for the count and
    // tests/mask-layer-models.test.js holds this constant to it; a fifth model
    // added without raising it would silently fall back to the generic oval.
    static constexpr int kMaskLayerModels = 4;
    static constexpr int kMaskLayerMonster = kMaskLayerModels;
    static constexpr int kMaskLayerGeneric = kMaskLayerModels + 1;
    static constexpr int kMaskLayers = kMaskLayerModels + 2;
    // Cell size: 256 wide for the same banding reason bakeSilhouette gives, and
    // 2:1 because a kit car's footprint is ~2:1 — the stretch onto the decal
    // rect is then near-isotropic, so the baked blur stays round.
    static constexpr int kMaskCellW = 256, kMaskCellH = 512;
    filament::Texture* mDecalMaskArray = nullptr;
    uint16_t mMaskLayerBakedBits = 0;
    // What each MODEL layer currently holds, as an FNV-1a of the GLB that was
    // baked into it — the claim key. It deliberately outlives a re-roster: a
    // slot re-dressed into a model another slot already baked reuses that
    // layer and skips the bake entirely, which is what closes the old "generic
    // oval until the re-dress rebakes" window.
    uint64_t mMaskLayerKey[kMaskLayerModels] = {};
    std::vector<int> mMaskLayerOfSlot;   // slot -> layer, from claimMaskLayer
    // Resolve slot `c`'s silhouette layer, baking into it only if no layer
    // already holds that GLB. Returns kMaskLayerGeneric when the roster holds
    // more distinct models than there are layers.
    int claimMaskLayer(uint32_t c, const std::vector<uint8_t>& glb);
    filament::Texture* ensureDecalMaskArray();
    // The rubber layer's tap binding (the 1x1 null texture is the
    // engine-lifetime half). The per-track texture + CPU buffer are made in
    // buildTrackScene and die in releaseScene.
    void bindSkidLayer(filament::MaterialInstance* mi);
    // Zero the rubber layer: memset the CPU buffer, upload level 0 whole,
    // regenerate the mip chain. Build-time init and the race-restart wipe.
    void clearSkidLayer();
    // Saturating-additive CPU raster of one stamp triangle (texel space,
    // top-left fill rule, ink linearly interpolated) into mSkidPix.
    void rasterSkidTri(const filament::math::float2* p, const float* ink);
    // Push this frame's dirty rects to the texture as sub-rect uploads.
    void uploadSkidRects();
    void refreshSkidMips();
    filament::math::float3 mBoostDiskLin{};
    // The one vlit instance that SAMPLES the baked sun map. Three's receiver set
    // is the road, the structures and the berms and nothing else — the lawn,
    // the hills and the scenery opt out — so the receivers get this instance and
    // everyone else keeps the default (whose shadowTexel is 0 = always lit).
    filament::MaterialInstance* mLitShadowInst = nullptr;
    utils::Entity mCameraEntity;

    // Split-screen cells, grown on demand to FrameInput.viewCount.
    std::vector<filament::View*> mCellViews;
    std::vector<filament::Camera*> mCellCameras;
    std::vector<utils::Entity> mCellCameraEntities;

    // The scene buffer every cell draws into, and the one full-screen pass that
    // grades + antialiases it onto the canvas. Filament's own post chain is two
    // passes PER VIEW on this backend and can't fuse them without framebuffer
    // fetch (see vpresent.mat), so we run it ourselves: N cells into one target,
    // then one present. Recreated by resize(); torn down with the engine, not
    // with the scene (they are canvas-scope, not track-scope).
    filament::Texture* mSceneColor = nullptr;
    filament::Texture* mSceneDepth = nullptr;
    filament::RenderTarget* mSceneRT = nullptr;
    filament::Material* mPresentMaterial = nullptr;
    filament::MaterialInstance* mPresentInstance = nullptr;
    filament::View* mPresentView = nullptr;
    filament::Scene* mPresentScene = nullptr;
    filament::Camera* mPresentCamera = nullptr;
    utils::Entity mPresentCameraEntity;
    utils::Entity mPresentQuad;
    filament::VertexBuffer* mPresentVB = nullptr;
    filament::IndexBuffer* mPresentIB = nullptr;
    // Size the scene buffer to the canvas (no-op when it already fits), and
    // stand up the present view on first use. Both no-op without vpresent.
    void ensureSceneTarget();
    // The fullscreen triangle + present view, WITHOUT the scene target: the
    // silhouette bakes' blur pass needs it too, and burying it inside
    // ensureSceneTarget (AA-gated since the stale-handle fix) silently
    // starved every car bake on the AA-off shell — the masked shadows all
    // fell back to the generic superellipse and nobody's harness camera sat
    // close enough to see the oval. Idempotent; engine-lifetime.
    void ensurePresentQuad();
    void destroySceneTarget();

    // Multiview split-screen (Android only — see shells/androidtv/CLAUDE.md).
    // The cells render as ceil(n/2) two-eye stereo passes into one 2D-array
    // texture (layer i = cell i), resolved onto the swap chain by one
    // vpresentmv pass. Engine config comes from init(stereoEyes); the path
    // itself is a live switch (setMultiview) so an A/B runs on one launch.
    uint8_t mStereoEyes = 0;             // 0 = no working stereo (unasked, or the driver refused)
    int mMultiviewMode = 1;              // setMultiview; 1 = 4-cell splits only
    // Does this frame take the stereo route? The mode's cell policy, plus the
    // hard constraints (a stereo engine, no overview — its full-surface rect
    // fits no cell-sized layer).
    bool multiviewWants(uint32_t viewCount, uint32_t flags) const {
        if (!mStereoEyes || mMultiviewMode <= 0) return false;
        if (flags & TTP_FRAME_OVERVIEW) return false;
        return mMultiviewMode == 1 ? viewCount == kMvLayers
                                   : viewCount >= 2 && viewCount <= kMvLayers;
    }
    filament::Texture* mMvColor = nullptr;      // RGBA8 array, kMvLayers deep
    filament::Texture* mMvDepth = nullptr;
    uint32_t mMvW = 0, mMvH = 0;                // the layer (== cell) size
    static constexpr uint32_t kMvLayers = 4;    // 2 passes x 2 eyes
    filament::RenderTarget* mMvRT[2] = {};      // pass p -> layers 2p, 2p+1
    filament::View* mMvViews[2] = {};
    filament::Camera* mMvCameras[2] = {};
    utils::Entity mMvCameraEntities[2];
    filament::Material* mPresentMvMaterial = nullptr;   // vpresentmv.filamat
    filament::MaterialInstance* mPresentMvInstance = nullptr;
    filament::View* mMvPresentView = nullptr;
    filament::Scene* mMvPresentScene = nullptr;
    utils::Entity mMvPresentQuad;
    // True when the targets exist at the given cell size — (re)builds on a
    // size change, which resize() forces by tearing down (same rule as the
    // scene target: swap between frames only).
    bool ensureMultiviewTargets(uint32_t cellW, uint32_t cellH);
    void destroyMultiviewTargets();
    // False (without having rendered anything) when the stereo targets cannot
    // stand up — the caller then runs the classic per-cell path instead.
    bool renderCellsMultiview(const TtpFrameInput& input, double& tMark);
    // The per-cell scene mutations, factored so the stereo path can run them
    // per PASS (both eyes see one scene state): billboards turn toward camPos,
    // the monster ghost swap keys on "any cell in cellMask wants the ghost".
    void orientCellBillboards(const filament::math::float3& camPos);
    void applyMonsterGhosts(uint32_t cellMask);

    // The 2D cell overlay — the split-screen dividers and the per-player steer
    // bar (voverlay.mat carries the whole argument for why these two, and only
    // these two, are drawn here rather than by the shell's UI layer).
    //
    // Canvas scope, like the present pass: a pool of unit quads, each with its
    // own MaterialInstance, scaled and placed by the transform manager and drawn
    // through one ortho camera in PIXEL space. Elements are handed out per frame
    // from the front of the pool and the tail is dropped from the scene, so the
    // count follows the split without allocating per frame.
    filament::Material* mOverlayMaterial = nullptr;
    filament::View* mOverlayView = nullptr;
    filament::Scene* mOverlayScene = nullptr;
    filament::Camera* mOverlayCamera = nullptr;
    utils::Entity mOverlayCameraEntity;
    filament::VertexBuffer* mOverlayVB = nullptr;
    filament::IndexBuffer* mOverlayIB = nullptr;
    struct OverlayQuad {
        utils::Entity entity;
        filament::MaterialInstance* mi = nullptr;
        bool inScene = false;
    };
    std::vector<OverlayQuad> mOverlayQuads;
    uint32_t mOverlayUsed = 0;
    void ensureOverlay();
    // Next pooled quad, placed at (x, y, w, h) in DEVICE pixels with a TOP-LEFT
    // origin (the units ttp_grid_cell answers in). Returns its instance for the
    // caller to paint, or nullptr if the material never arrived.
    filament::MaterialInstance* overlayQuad(float x, float y, float w, float h);
    void drawOverlay(const TtpFrameInput& input);

    Mesh mRoad;
    Mesh mGround;
    // The heightfield's stand-in in the shadow bake's depth pass: a flat quad
    // at groundY, drawn by no main view (layer bit 0 cleared). The relief
    // itself must not cast — see the caster note before bakeShadowMap.
    Mesh mGroundProxy;
    // The ground's tiled colour bands (the biome's lawn/sand/redrock/snow/wood
    // canvas, baked to vertex colour). The berms tile the SAME texture in the
    // JS, so they sample this by world x.
    struct GroundBand { float w; filament::math::float3 col; }; // w = fraction of a tile
    std::vector<GroundBand> mGroundBands;
    static constexpr float kGroundTile = 600.0f / 18.0f;
    filament::math::float3 groundColorAt(float x) const;
    // Terrain relief: rolling hills on the ground sheet, flat under and beside
    // the road (see setupTerrain). Amp 0 = the flat-quad biomes (sand, wood).
    float mTerrainAmp = 0;
    uint32_t mTerrainSeed = 0;
    float mTerrainX0 = 0, mTerrainZ0 = 0, mTerrainX1 = 0, mTerrainZ1 = 0;
    // Flat clearings the landmark spots carve into the relief (so a windmill
    // never stands on a slope). Registered by buildLandmarks BEFORE the ground
    // mesh and the scatter sample the field — see the builder order.
    struct TerrainFlat { float x, z, r; };
    std::vector<TerrainFlat> mTerrainFlats;
    void setupTerrain(const TrackBin& tb);
    float terrainY(const TrackBin& tb, float x, float z) const;
    // The sampled heightfield the ground MESH is built from, kept so every
    // placement stands on the mesh's own piecewise-linear surface rather than
    // the analytic field — between grid vertices they differ by enough to bury
    // a shadow disc or a starfish. Filled by buildTerrainGrid, read by
    // groundSurfaceY (which answers groundY wherever the grid is absent).
    std::vector<float> mTerrainHs;
    int mTerrainCols = 0, mTerrainRows = 0;
    float mTerrainSx = 0, mTerrainSz = 0;
    void buildTerrainGrid(const TrackBin& tb);
    float groundSurfaceY(const TrackBin& tb, float x, float z) const;
    float footprintY(const TrackBin& tb, float x, float z, float r) const;
    // Build the biome's 256² floor texture (textures.js makeLawn/Sand/RedRock/
    // Snow/WoodFloorTexture, ported pixel-for-pixel) and hand it to Filament.
    filament::Texture* buildGroundTexture(uint32_t kind);
    // Top-down alpha coverage of a loaded car, blurred into decalMask array
    // layer `maskLayer` for the road-shader shadow decal (see uploadDeckDecals).
    // The entity overload is what the INSTANCED monster rig needs: gltfio hands
    // an instanced asset's renderables to the FilamentInstance, not the asset.
    void bakeSilhouette(filament::gltfio::FilamentAsset* asset,
            const filament::math::float3& bbMin, const filament::math::float3& bbMax,
            int maskLayer);
    void bakeSilhouette(const utils::Entity* entities, size_t count,
            const filament::math::float3& bbMin, const filament::math::float3& bbMax,
            int maskLayer);
    // The split-screen grid for n cells — SceneRenderer's bestGrid, so the 3D
    // cells land where the DOM HUD puts its labels. cellRect tiles with it.
    struct GridDims { uint32_t cols, rows; };
    GridDims gridDims(uint32_t n) const;
    // MonsterRig's gunmetal frame: repaint the chassis primitive only, since
    // the whole truck shares one material and the tyres must keep their colour.
    void recolourMonsterChassis(filament::gltfio::FilamentAsset* asset,
            const std::vector<filament::gltfio::FilamentInstance*>& instances,
            const filament::math::float4& rgba);
    Mesh mSky;   // vertex-gradient dome at SKY_R (past the fog cutoff)
    Mesh mHills; // horizon dome ring
    // Per-feature anchors {x, z, top} in AUTHORED coords — the offshore
    // landmarks (lighthouse, sailboat) sit on the LOWEST island.
    std::vector<filament::math::float3> mHillAnchors;
    // The fitted shoreline radius at a bearing (buildWater); the sailboat
    // anchors off the same curve. Null when the theme carries no water.
    std::function<float(float)> mShoreFn;
    std::vector<Mesh> mCars; // box markers — fallback when a car has no GLB

    // Real car models (gltfio). mCarAssets[i] is null when car i fell back to
    // its box marker; otherwise the asset root is posed per frame.
    //
    // mMatProvider is TtpGlbMaterials when the shell served vglb.filamat — the
    // kit's own matte material for everything it can express, wrapped around an
    // ubershader provider (which it owns) for the rest. Without vglb it IS the
    // ubershader provider, which is what every shell had before. See vglb.mat.
    filament::gltfio::MaterialProvider* mMatProvider = nullptr;
    filament::Material* mGlbMaterial = nullptr;
    filament::Material* mGlbFadeMaterial = nullptr;
    filament::gltfio::AssetLoader* mAssetLoader = nullptr;
    filament::gltfio::ResourceLoader* mResourceLoader = nullptr;
    filament::gltfio::TextureProvider* mStbProvider = nullptr;
    // glTF NODE NAMES. Optional to gltfio and easy to leave out — but without
    // it FilamentAsset::getName() returns nullptr for EVERY entity, silently,
    // while getFirstEntityByName() keeps working off its own map. Three things
    // read names and all three quietly did nothing: the monster chassis
    // recolour, the monster wheel handles, and the graft-seat measurement
    // (which skips the car's WHEELS — with the skip dead the box reached the
    // ground and the truck's body rode ~0.07 too high).
    utils::NameComponentManager* mNames = nullptr;
    std::vector<filament::gltfio::FilamentAsset*> mCarAssets;
    // 50%-alpha ghost variants (patched GLBs) — the monster occlusion fade
    // swaps the whole rig (chassis AND grafted body) like the JS traversal.
    std::vector<filament::gltfio::FilamentAsset*> mCarGhostAssets;
    // Scene-membership state for the pools that spend most of a race idle
    // (setInstanceInScene / setAssetInScene are edge-triggered on these).
    std::vector<uint8_t> mCarGhostIn, mMonsterIn, mMonsterGhostIn, mBananaIn;
    // Wheel cosmetics (SceneRenderer setCarPose): front wheels yaw with
    // steerYaw (±WHEEL_TURN_MAX — the expo-shaped steer, so the deflection
    // tracks the car's yaw RATE rather than the raw tilt) and all four roll at
    // WHEEL_SPIN_SCALE × v/r.
    struct CarWheels {
        utils::Entity fl, fr, bl, br;
        filament::math::float3 flT, frT, blT, brT; // original local translations
        float roll = 0;                            // accumulated roll angle (wrapped (−π,π])
        float lean = 0;                            // damped body roll (JS LEAN_MAX 0.05, 0.2/frame)
        float steerYawS = 0;                       // damped steerYaw — phone steer steps at the wire rate
        float pitch = 0, prevSpd = 0;              // weight-transfer state (dspd of NORMALIZED spd)
        float accelNorm = 0;                       // forward-bite 0..1 — launch-scratch skids read it
        filament::math::float3 lastPos{};          // wheel-roll travel measurement
        bool hasLastPos = false;
        float lastDs = 0;                          // this frame's travel — streaks read it
        float rollSign = -1, pitchSign = -1;       // posed-frame X axis sign (addCar's measurement)
        // ── Ground conform ──────────────────────────────────────────────
        // Each wheel's rest offset in the POSED body frame (+x right, +y up,
        // +z forward), world units — measured off the loaded model rather
        // than reused from the AABB, so the probes straddle the real wheel
        // track and base. `assetScale` converts a world-unit travel back into
        // the node-local units its own translation is written in.
        filament::math::float3 wheelOff[4]{};       // fl, fr, bl, br
        float assetScale = 1.0f;
        bool hasWheelOff = false;
        // (Suspension travel itself is NOT here: it is recomputed from the
        // frame's own contacts and never damped, so it is a local in
        // renderCars, not state. See TrackBin's ruled-surface note for why a
        // rigid body needs it at all.)
        // Worst |contact − fitted plane| over the four wheels, world units.
        // Diagnostic (ttp_display_debug_decals): it is the size of the
        // compromise the travel above is absorbing.
        float wheelGap = 0;
        // Second differences of the seated pose and of the fitted normal,
        // beside the CONTRACT pose's own. Driving smoothly over a smooth deck
        // the first difference is near constant, so what survives differencing
        // twice is frame-to-frame wobble and nothing else. `upJitter` is the
        // one that matters and the one that had no reference last time: the
        // conform's own contribution is the DIFFERENCE between jitter and
        // rawJitter, and the contract pose has no normal to compare against.
        filament::math::float3 prevPos{}, prevStep{};
        filament::math::float3 prevRaw{}, prevRawStep{};
        filament::math::float3 prevUp{}, prevUpStep{};
        float jitter = 0, rawJitter = 0, upJitter = 0;
        bool hasPrev = false;
        float skidWidth = 0.12f;                   // tyre-contact width (wheel AABB, clamped)
        float skidHold = 0;                        // scuff strength, released over SKID_RELEASE
        float skidAllHold = 0;                     // same, for the four-wheel (scrub/spin) channel
        float footW = 0.95f, footL = 2.0f;         // car footprint (asset AABB) — blob + boost disk
        bool monsterOn = false;                    // morph edge detect
        float popT = 0;                            // grow/shrink pop clock (0.34 s)
        utils::Entity axle;                        // exposed axle rod (some models) — stripped by MonsterRig
        filament::math::float3 axleT{};
        // MonsterRig graft offset: the wheel-less body's seat in the kit cab
        // slot (centre in x/z, bottom-aligned + MOUNT_LIFT).
        filament::math::float3 monsterMount{ 0, 0.28f, 0 };
    };
    std::vector<CarWheels> mCarWheels;
    // Per-cell monster ghosting: the swap runs between render() calls, so each
    // cell sees the truck solid or 50%-alpha according to its OWN block test.
    struct MonsterView {
        bool on = false;
        uint32_t mask = 0;               // bit per view: this cell's view is blocked
        filament::math::mat4f rig{};     // chassis pose
        filament::math::mat4f body{};    // grafted body pose (rig × mount)
    };
    std::vector<MonsterView> mMonsterViews;

    // Track furniture: item boxes (static anchors, availability from the
    // snapshot) and dropped bananas (dynamic pool), both instanced kit GLBs.
    std::unique_ptr<TrackBin> mTrack; // kept for render-time banana placement
    filament::gltfio::FilamentAsset* mBoxAsset = nullptr;
    filament::gltfio::FilamentAsset* mBoxFadeAsset = nullptr; // BLEND twin, collect fade
    filament::gltfio::FilamentAsset* mBananaAsset = nullptr;
    std::vector<filament::gltfio::FilamentInstance*> mBoxInstances;
    std::vector<filament::gltfio::FilamentInstance*> mBoxFadeInstances;
    std::vector<filament::gltfio::FilamentInstance*> mBananaInstances;
    std::vector<filament::math::mat4f> mBoxXf; // box anchor bases (world)
    float mBoxScale = 1.0f;                    // kit box → BOX_H 0.3 world units
    std::vector<float> mBoxCollectT;           // grow+fade burst clocks (TrackProps)
    std::vector<uint8_t> mBoxPrevAvail;        // availability edge detect
    // Scene membership for the box pools (setInstanceInScene state): a collected
    // box leaves the scene, and its fade twin is only IN it for the 0.2 s poof.
    std::vector<uint8_t> mBoxIn, mBoxFadeIn;
    // Every box-pool MaterialInstance carrying emissiveFactor, resolved once at
    // load — the throb retints these instead of string-probing every material of
    // every instance per frame.
    std::vector<filament::MaterialInstance*> mBoxGlowMats;
    float mBoxGlowPulse = -1; // last pulse written; -1 = force the first write
    Mesh mStructures;             // pillars / poles / loop shafts (matte concrete)
    Mesh mBerms;                  // grass lofted under a raised, non-pillared deck
    float mTime = 0; // idle-animation clock (accumulated FrameInput.dt)

    // Translucent bits (vblend material, vertex alpha): baked ground shadows,
    // the water glaze, tree canopies.
    filament::Material* mBlendMaterial = nullptr;
    // Round camera-facing sprites (vpoint): the ambient-particle cloud. The
    // billboard + the radial falloff both live in the shader — see vpoint.mat.
    filament::Material* mPointMaterial = nullptr;
    filament::MaterialInstance* mPollenMat = nullptr; // owns the sprite's halfSize
    // Soft puffs (vcloud): the sky clouds and the dust banks. Their five-lobe
    // silhouette is shader-side too — see vcloud.mat for why it is not baked.
    filament::Material* mCloudMaterial = nullptr;
    // Additive rocket blast (vburst): the flash ball and the camera-facing
    // shockwave ring, whose radius/width/fade are material parameters.
    filament::Material* mBurstMaterial = nullptr;
    // Textured ground (vground): the biome's floor canvas, generated as pixels
    // to match the JS canvas texture rather than approximated with bands.
    filament::Material* mGroundMaterial = nullptr;
    // Bake-time filter that turns the raw depth map into a blurred ESM.
    filament::Material* mEsmMaterial = nullptr;
    // Bake-time gaussian over the per-car silhouette mask (vblur.mat).
    filament::Material* mBlurMaterial = nullptr;
    filament::Texture* mGroundTex = nullptr; // scene scope — a new biome, a new floor
    // The ground's own instance, kept so the baked sun map can be bound to it
    // after bakeShadowMap runs (it is created well before that).
    filament::MaterialInstance* mGroundInst = nullptr;
    filament::Texture* mWhiteTex = nullptr;  // 1×1, neutralises a glTF base-colour map
    // The frozen sun shadow map and the matrix that puts a world position in
    // its [0,1] texture space (see bakeShadowMap).
    filament::Texture* mShadowMap = nullptr;
    // The GROUND's baked sun-visibility map (vvis.mat, rendered inside
    // bakeShadowMap over the same light camera), and the material that bakes
    // it. Per-scene like the ESM; vground taps it instead of running the ESM
    // decode per fragment — bindVisMap is the one binder.
    filament::Texture* mVisMap = nullptr;
    filament::Material* mVisMaterial = nullptr;
    // The bake's reuse test — see bakeShadowMap for the whole argument.
    // mBakeKey is what the caller says the NEXT build's statics are; mBakedKey
    // is what the resident maps were actually made from. They match exactly when
    // a rebuild changed only the field.
    std::string mBakeKey;
    std::string mBakedKey;
    // The ROAD's baked vertex light for mBakedKey's track, kept beside the maps
    // it was derived from. The road MESH is rebuilt on every build, but for the
    // same track it is rebuilt IDENTICALLY (build_race_track is a pure function
    // of the descriptor), so its CUSTOM0 is too — and re-deriving it means
    // reading the ESM back off the GPU (~30 ms) and evaluating the matte-light
    // split per vertex (~15 ms) to arrive at bytes we already had. A few hundred
    // KB against the 2 MB map next to it.
    std::vector<filament::math::half4> mRoadLight;
    // See setShadowsEnabled. False leaves mShadowMap null, which is already the
    // "this track baked no map" path: bindShadowMap falls back to the 1×1 white
    // texture and passes shadowTexel 0, and vlit.mat reads that as fully lit.
    bool mShadowsEnabled = true;
    filament::math::mat4f mShadowFromWorld;
    float mShadowTexel = 0.05f; // world units per shadow texel; also the "a map
                                // is bound" sentinel the samplers test on
    // ESM exponent, shared by the bake filter (vesm.mat) and the two materials
    // that sample the result. It is not a quality dial: it decides WHERE in the
    // blur kernel the lit/shadow crossing lands. The receiver compares in log
    // space, so the crossing sits where the occluder holds exp(-k*gap) of the
    // kernel, gap being the normalised occluder-to-receiver depth. Small k puts
    // that in the kernel's bulk — an average over many texels, so the contour is
    // a smooth curve. Large k drives it into the gaussian's tail, where one
    // texel dominates and the same contour comes out as a staircase; 80 did
    // exactly that, and no amount of resolution, blur or filtering fixed it
    // because the contour was in the wrong place, not badly sampled.
    // The cost of lowering it is leak: an occluder a long way above its receiver
    // eventually stops reaching full darkness. 8 clears every catalogue track.
    static constexpr float kShadowEsmK = 8.0f;
    // Normalised shadow depth per WORLD unit (1 / the ortho depth range), so the
    // slope-scaled bias in vlit/vground means the same distance on every track.
    float mShadowDepthScale = 0.0f;
    // Boost wind streaks (SceneRenderer STREAK_*): 4 thin axial-billboard
    // quads per car slicing past the body while boosting.
    struct Streak {
        float x = 0, y = 0, z = 0, len = 1;
        float alpha = 0;
        bool dead = true;
    };
    std::vector<Streak> mStreaks;              // carCount × 4
    std::vector<Mesh> mStreakMeshes;           // carCount × 4 (vblend ellipses)
    std::vector<uint32_t> mStreakSeed;         // per-car respawn LCG
    std::vector<filament::math::mat4f> mCarBasis; // road-aligned pose per car (streak parent)
    // project()'s warm start, per car: the ring segment the car's decal landed
    // on last frame. Cleared with the track (ring indices die with it).
    std::vector<int> mDecalProjHint;
    // ...and its inverse, cached because the streak billboards need it ONCE PER
    // CELL while the basis itself only changes once per car per frame. Inverting
    // it at the use site meant a general 4x4 inverse per streak per cell — 128 of
    // them a frame at the 4-player cap, all but 32 of which recomputed a matrix
    // that had not moved since the last cell.
    std::vector<filament::math::mat4f> mCarBasisInv;
    // Skid trails — the same per-wheel channels the SkidMarks.js port drove
    // (slip/scrub/spin/brake/launch, attack/release strength), but committed
    // segments are RASTERIZED ON THE CPU into a persistent track-space R8
    // accumulation buffer (mSkidPix) whose dirty rects upload into mSkidTex,
    // the texture vroad.mat samples. Ink is PERMANENT until the race-restart
    // wipe (a memset + full re-upload) — there is no decay pass, which is
    // what keeps the steady-state cost at a few tiny sub-rect uploads plus
    // one tap the road already amortizes.
    //
    // NO RENDER TARGET, DELIBERATELY — this texture must never carry
    // COLOR_ATTACHMENT. The GPU-stamped shape (vskid.mat quads into an
    // attached RT) was tried in every arrangement on the A10X Apple TV and
    // each tripped a different below-the-API device behaviour: a persistent
    // target's texture sampled as zero unless its binding churned every
    // frame, a transient-per-pass target lost the accumulated ink, and the
    // persistent+rebind+zeroed shape still artifacted in real races. The
    // 2026-08-14 source audit of the pinned Filament fork showed the Metal
    // backend emits IDENTICAL command streams for those arrangements — the
    // difference was inside the driver, so no RT arrangement can be trusted
    // for an ACCUMULATING target on that device. Plain uploads are the one
    // path every texture in the game already proves out, and dropping the
    // pass also drops a full-size TBDR load/store per stamp frame.
    filament::Texture* mSkidTex = nullptr;        // per-track, R8, upload-only
    filament::Texture* mSkidNullTex = nullptr;    // 1x1 zero, binds when no track
    std::vector<uint8_t> mSkidPix;                // CPU truth, W×H, row 0 = -latHalf
    uint32_t mSkidTexW = 0, mSkidTexH = 0;
    // Dirty texel rects laid this frame, in UNWRAPPED x (may run past W; the
    // upload splits at the seam). A handful per frame — one per committed
    // segment, merged when they touch.
    struct SkidRect { int x0, y0, x1, y1; };      // half-open [x0,x1)×[y0,y1)
    std::vector<SkidRect> mSkidDirty;
    // The mip chain's CPU truth, levels 1.. (level 0 is mSkidPix), plus the
    // PHYSICAL-x rects awaiting the throttled per-level refresh — see
    // refreshSkidMips for why generateMipmaps could not stay.
    std::vector<std::vector<uint8_t>> mSkidMips;
    std::vector<SkidRect> mSkidMipDirty;
    float mSkidLatHalf = 0;                       // half the lat span the texture covers
    // Texel edges in world units per axis. The stamp feather is sized from
    // the texel footprint along the mark's own width direction, so straights
    // (resolved by the fine lat axis) stay crisp while diagonal segments —
    // which alias against the coarser s axis — get just enough ramp.
    float mSkidTexelS = 0, mSkidTexelLat = 0;
    // The device's real GL_MAX_TEXTURE_SIZE, set by the platform surface
    // before init (8192 = the conservative floor when no shell reports one).
    // At 16384 the skid texture reaches 80 texels/u along s on ordinary lap
    // lengths — the same density as lat, so the grid is isotropic and a
    // diagonal mark resolves exactly like a straight one.
    //
    // ONLY THE WEB SURFACE REPORTS ONE (`ttp_display_web.cc`), because only it
    // makes its own GL context before handing Filament a null window and so has
    // something to ask. tvOS and Android TV let Filament create the context
    // inside init() and keep this default — so on those two the layer is 8192
    // wide and the grid is 3-4x ANISOTROPIC, which is what the angle-aware
    // feather in the stamp block is actually holding together. Any note that
    // says "16k" is describing the web alone.
    uint32_t mMaxTextureDim = 8192;
    // The grade's sRGB curve as a 1024-entry table — ttp_grade.inc has why.
    filament::Texture* mGradeLut = nullptr;
    bool mSkidWipe = false;    // clear the layer on the next stamp pass (race restart)
    // The layer's mip refresh (see the stamp block): stamps land in mip 0; the
    // chain regenerates at most ~7 Hz so minified marks stop scintillating
    // without a per-frame megatexel pass. PER-SCENE, like mSkidWipe — mSkidMipsAt
    // is on the mTime clock, which restarts at 0 with every scene build.
    bool mSkidMipsDirty = false;
    float mSkidMipsAt = 0;
    float mSkidUpAt = 0; // level-0 upload throttle, same per-scene clock
    // ── The car-shadow layer ────────────────────────────────────────────
    // The eight contact shadows as a per-frame CPU-rasterized track-space R8
    // texture (the rubber layer's idiom — same mapping, same lat span, so
    // vroad's tap reuses the rubber uv), replacing vroad's masked uniform
    // loop: under a real pack that loop was ~5 ms of the 720p frame and only
    // structure moved it. TRANSIENT, unlike the rubber: renderCars erases
    // last frame's stamps and lays this frame's, so unlike the rubber there
    // is no throttle to hide behind — which is why the texture is a PAIR.
    // Each frame uploads the WHOLE level 0 as ONE setImage into the texture
    // the driver is NOT reading (the instances are re-pointed at it after
    // the upload), so the respecify-while-in-flight stall the skid layer's
    // ~30 Hz throttle exists to dodge has no texture to land on. One 256-512
    // KB upload event per frame, against the 16-24 dirty-rect events an
    // in-place scheme would cost — the skid layer proved the driver bills
    // per EVENT on an in-flight texture, not per byte.
    // No mips, deliberately: the masked loop sampled its silhouette at LOD 0
    // with no chain either, so minification behaves exactly as it did.
    filament::Texture* mCarShadowTex[2] = { nullptr, nullptr };
    std::vector<uint8_t> mCarShadowPix;    // CPU raster truth, W×H, row 0 = -latHalf
    uint32_t mCarShadowW = 0, mCarShadowH = 0;
    uint32_t mCarShadowPing = 0;           // which of the pair takes the NEXT upload
    std::vector<SkidRect> mCarShadowDirty; // last raster's rects (unwrapped x) — the erase list
    bool mCarShadowUpload = false;         // the CPU buffer changed since the last upload
    // The silhouette SOURCE the raster samples: the CPU superellipse
    // (superellipseMaskPixels — the decalMask array's generic layer, i.e. the
    // shipped fallback look), for EVERY car. At the layer's texel density the
    // baked per-car silhouettes are indistinguishable from it, and evaluating
    // it on the CPU retires the per-scene readback the bakes would need.
    // Engine-lifetime: the shape never changes.
    std::vector<float> mCarShadowMask;
    static constexpr int kCarShadowMaskW = 64, kCarShadowMaskH = 128;
    // 128 rows over the rubber layer's ±skidLatHalf (~20 texels/u across lat);
    // width targets 8 texels/u of arclength, clamped — coarse next to the
    // rubber's 80/u ON PURPOSE: the stamp is a pre-blurred blob, and the
    // whole texture must be cheap to rebuild and upload every frame.
    static constexpr int kCarShadowH = 128;
    // Independent capability probes on the served vroad — the current blob
    // carries both (the hybrid's near/far halves); see TtpRendererDecals.cpp.
    bool roadHasMaskLoop() const;   // hasParameter("maskRect")
    bool roadHasCarShadow() const;  // hasParameter("carShadow")
    void bindCarShadow(filament::MaterialInstance* mi, filament::Texture* t);
    void eraseCarShadow();          // zero last frame's rects in the CPU buffer
    // One car's stamp: six deckFoot-projected points (the cull-window probes,
    // now kept) rasterized as TWO warped quads with the silhouette sampled
    // bilinearly across them — the bending of track space lives INSIDE the
    // stamp, second-order per slice, instead of smearing it axis-aligned.
    void rasterCarShadowStamp(const filament::math::float2* sl, float carS, float alpha);
    void rasterCarShadowTri(const filament::math::float2* p,
            const filament::math::float2* uv, float alpha);
    void uploadCarShadow();         // the one setImage + the ping-pong rebind
    struct WheelTrail {
        filament::math::float2 last{}, dir{}, edgeL{}, edgeR{}; // all (s, lat)
        bool hasEdge = false, seeded = false;
        int projHint = -1;     // project()'s warm start
    };
    std::vector<WheelTrail> mWheelTrails; // carCount × 4 (fl fr bl br)
    float mMonsterFootW = 0, mMonsterFootL = 0; // monster asset footprint (blob swap)
    Mesh mGantry; // procedural start/finish gantry (FinishGate.js port)
    // The sea ring + its wet-sand glaze (theme.water), fitted to the track's
    // own shoreline.
    Mesh mWater, mWet;
    // Fliers (theme.birds / kites / paperPlane): billboard glyphs built as real
    // stroked geometry (the JS canvas sprites), plus the playroom's 3D dart.
    std::vector<Mesh> mBirds;
    std::vector<Mesh> mKites;
    Mesh mPlane;
    // Drifting cloud puffs: one billboarded quad each, shaped by vcloud.mat.
    std::vector<Mesh> mClouds;
    std::vector<filament::math::float3> mCloudPos; // current position (x drifts)
    // Low dust banks (theme.haze) — same puff, bank-flat, drifting faster.
    std::vector<Mesh> mHaze;
    std::vector<filament::math::float3> mHazePos;
    // Trackside scenery: instanced tree/bush GLBs + a merged boulder mesh.
    std::vector<filament::gltfio::FilamentAsset*> mSceneryAssets;
    std::vector<std::vector<filament::gltfio::FilamentInstance*>> mSceneryInstances;
    // Trackside props (prop<i>.glb): scattered set dressing.
    std::vector<filament::gltfio::FilamentAsset*> mPropAssets;
    std::vector<std::vector<filament::gltfio::FilamentInstance*>> mPropInstances;
    // The "spin" node of every placed prop that has one — turned about its own
    // origin each frame (buildProps). The toy train's rails are its only user.
    std::vector<utils::Entity> mPropSpins;
    Mesh mBoulders;
    Mesh mLandmarks; // procedural hero set-pieces (seeded placement)
    Mesh mWindmill;  // the windmill's rotor — its own mesh, spun per frame
    // Chimney smoke (cabin): three soft puffs rising on a staggered loop.
    std::vector<Mesh> mSmoke;
    filament::math::float3 mSmokeOrigin{};
    // Per-model variant picks and the bench, indexed by the .cpp's ModelId
    // (rocket, gnome, train, starfish). Sized by hand because that enum lives
    // beside the builders it names; a static_assert in the .cpp holds the two
    // together.
    //
    // THESE DEFAULTS ARE WHAT THE GAME DRAWS, and all four are settled picks
    // off the model bench (/gallery-assets.html): the detailed gnome, the
    // classic loco, the cruise missile, and the smooth flat starfish (the
    // original's five arms, hub removed, blunt and flat on the sand). The
    // rocket took five rounds and the starfish two; each row's unpicked
    // readings are kept because the bench is worth more with them in it than
    // the source is shorter without.
    //
    // Variant 0 is the pre-bench geometry on every row and is kept — a bench
    // with no "what we have today" in it is not a comparison — but it is no
    // longer any model's default, so a shell that never calls setModelVariant
    // now gets the picked set rather than the original one.
    // gallery-assets.js's BENCH_MODELS mirrors these for its captions.
    int mModelVariant[4] = { 1, 1, 1, 4 };
    int mBenchModel = -1;
    // The kit field: one asset per model (no instancing — every one of them is
    // a different model, which is the point), and the layout the chrome reads
    // back. Empty unless the gallery latched it on.
    int mKitFieldCount = 0;
    std::vector<filament::gltfio::FilamentAsset*> mKitAssets;
    std::string mKitLayout = "[]";
    // What ground the field ended up covering, so the horizon ring can leave it
    // alone (see buildTrackScene). Inverted — max < min — when there is no
    // field, which is every build but the gallery's.
    float mKitFieldMinX = 0, mKitFieldMaxX = -1, mKitFieldMinZ = 0, mKitFieldMaxZ = -1;

    filament::math::mat4f mWindmillBase{};
    // Baked lawn shadows: soft ink blobs under trees/pylons/landmarks — the
    // stand-in for the JS shadow map's casters landing on grass.
    std::vector<filament::math::float4> mShadowSpots; // x, z, radius, height
    Mesh mGroundShadows;
    Mesh mClutter;   // near-field flowers (rand2 stream)
    Mesh mBalloon;   // hot-air balloon (theme.balloon — grass/sunset hero)
    float mBalloonY = 44, mBalloonSize = 6; // theme.balloon orbit height + scale
    float mHillSf = 1; // hill-ring push-out factor (balloon orbit radius scales with it)
    filament::gltfio::FilamentAsset* mConeAsset = nullptr;
    std::vector<filament::gltfio::FilamentInstance*> mConeInstances;
    // Kickable-cone state — TrackProps._stepCones verbatim (cosmetic; the sim
    // drives straight through). A passing car punts the cone, it tumbles under
    // gravity, bounces off the LOCAL road surface with friction, is clamped
    // inside the kerbs, and once its energy dies it topples onto its side and
    // STAYS knocked over for the rest of the race.
    struct ConeState {
        filament::math::mat4f home{};   // rest transform (road basis at the spot)
        filament::math::quatf quat{};   // current orientation
        filament::math::quatf flatTarget{};
        bool hasFlat = false;           // easing over to the toppled pose
        filament::math::float3 pos{};
        filament::math::float3 vel{};
        filament::math::float3 spinAxis{ 0, 1, 0 };
        float spinRate = 0;
        bool airborne = false;
        float homeS = 0;                // arclength of the rest spot (road probe)
        float restRoadY = 0;
        bool hasRest = false;
        float radius = 0.1f, loY = 0, hiY = 0.3f; // silhouette proxy (base rim + apex)
        bool posed = false;             // rest transform pushed; settled cones skip the write
    };
    std::vector<ConeState> mConeStates;
    // Water biomes swap the warning cone for an A-frame "wet floor" sign —
    // procedural, so it's a mesh per marker rather than a GLB instance.
    std::vector<Mesh> mSignMeshes;
    // Monster chassis pool (MonsterRig: cab dropped, car body seats the slot).
    filament::gltfio::FilamentAsset* mMonsterAsset = nullptr;
    std::vector<filament::gltfio::FilamentInstance*> mMonsterInstances;
    filament::gltfio::FilamentAsset* mMonsterGhostAsset = nullptr; // 50%-alpha fade variant
    std::vector<filament::gltfio::FilamentInstance*> mMonsterGhostInstances;
    // The RIG's own wheels, per instance. While the monster is up the car's
    // wheels are collapsed and these are the ones on the ground, so they take
    // over the roll/steer cosmetics (the JS swaps c.frontWheels/backWheels to
    // the rig's handles for exactly this). Named lookups are per INSTANCE —
    // getEntitiesByName spans the whole pool.
    struct MonsterWheels {
        utils::Entity fl, fr, bl, br;
        filament::math::float3 flT, frT, blT, brT; // rest local translations
        float rollSign = -1;
    };
    std::vector<MonsterWheels> mMonsterWheels;
    float mMonsterWheelRadius = 0; // measured off a rear tyre (JS: bbox.y / 2)
    float mMonsterSkidWidth = 0;   // the rig's tyre-contact width (fat = fat marks)
    std::vector<Mesh> mRockets;      // in-flight toy rockets (pool of 4)
    std::vector<Mesh> mRocketFlames; // per-rocket blend tail flames
    // Impact bursts: expanding rings where a rocket vanished (hit or whiff).
    struct Burst {
        filament::math::float3 pos{};   // the shockwave ring's fixed impact point
        filament::math::float3 ball{};  // the fireball, which TRAILS a hit car
        float t = -1;                   // <0 idle; else seconds since impact
        int32_t car = -1;               // >=0: rode this car in; the ball follows it
    };
    Burst mBursts[2];
    Mesh mBurstMeshes[2]; // shockwave rings
    Mesh mBurstBalls[2];  // flash balls
    // One vburst instance each: the ring's radius/width and both fades are
    // material parameters, so nothing about these meshes changes per frame.
    filament::MaterialInstance* mBurstRingMats[2] = { nullptr, nullptr };
    filament::MaterialInstance* mBurstBallMats[2] = { nullptr, nullptr };
    // Almost no HUD here by design: everything in SCREEN space that carries
    // TYPE or sticker chrome (place card, lap pill, item slot, name chip,
    // countdown, results, the FINISHED card, the reconnect QR) belongs to the
    // shell's own UI layer — DOM/CSS on web, Compose on Android TV, SwiftUI on
    // tvOS. The two exceptions are the steer bar and the cell dividers
    // (mOverlay*, voverlay.mat): cell-anchored and textless, so they need no
    // toolkit and must not be laid out twice. Everything else the renderer draws
    // is anchored in the world or depth-tested (the boost aura, the skids, the
    // gantry).

    // Ambient particles (theme.ambient): immutable SEEDS in a kAmbBox-wide
    // column; vpoint.mat evaluates the motion and wraps x/z around each view's
    // camera per frame, so after the build the CPU never touches this mesh —
    // the only per-frame work is the `time` uniform (renderAmbient).
    Mesh mPollen;
    float mAmbSize = 0.15f; // half the authored sprite size; re-fitted per frame
    // Flake floor (FLAKE kind only): a coarse max-height grid of terrain + road
    // ribbon over the whole track, uploaded as an R16F texture the vertex
    // shader taps so a falling flake fades out ONTO the surface instead of
    // depth-slicing through an elevated deck. The other kinds bind a 1x1
    // "-1000" texel — canyon sand BLOWS across the deck at ground height, and
    // flooring it would dim the streaks over the road.
    filament::Texture* mAmbFloorTex = nullptr;
    static constexpr float kAmbR = 170.0f;  // the flake-floor grid's half-span
    static constexpr int kAmbFloorN = 86;   // ~4u cells across it
    static constexpr float kAmbBox = 60.0f; // the camera box's x/z extent
    std::vector<filament::math::float3> mPrevRockets;
    uint32_t mPrevRocketCount = 0;
    filament::math::float3 mLastCar0{}; // reset/teleport detector: first...
    filament::math::float3 mLastCarN{}; // ...and last car — both must jump
    utils::Entity mSun;
    utils::Entity mFill;
    filament::IndirectLight* mAmbient = nullptr;

    double mProfile[kProfCount] = {};
    double mGpuMs = 0.0;
    bool mAntialias = true;
    uint32_t mWidth = 0;
    uint32_t mHeight = 0;
    bool mHasTrack = false;
    filament::math::float3 mFogColor = { 0, 0, 0 }; // linear; set at scene build

    std::unordered_map<std::string, std::vector<uint8_t>> mAssets;
    std::vector<filament::MaterialInstance*> mSceneMatInstances;

    void updateCamera();
    // A MaterialInstance owned by the SCENE (not the renderer): recorded so
    // releaseScene() can free it when the track is torn down.
    filament::MaterialInstance* sceneInstance(filament::Material* m);
    bool buildMesh(Mesh& m, bool addToScene = true,
            filament::MaterialInstance* materialInstance = nullptr,
            uint8_t priority = 4, // blend-pass order; see the Builder call
            // Split into renderables of at most this many triangles, each with
            // its own bounds and frustum culling ON. 0 = one renderable, no
            // culling (the default every dynamic mesh wants).
            uint32_t chunkTris = 0);
    void destroyMesh(Mesh& m);
    // fillRoadLight + the vertex upload that has to follow it.
    void applyRoadLight(const TrackBin& tb, const float* esm,
            uint32_t esmW, uint32_t esmH);

    // Read the resident ESM back and refill the road's baked vertex light.
    void refillRoadLight(const TrackBin& tb);

    // One of the bake's targets back to the CPU, RGBA as every backend wants.
    // `asFloat` picks the pixel type (the ESM is R16F and reads as FLOAT, the
    // visibility map is R8 and reads as UBYTE); the enum itself cannot appear
    // here, where filament::Texture is only forward-declared.
    bool readBakeTexture(filament::Texture* tex, bool asFloat,
            std::vector<uint8_t>& out);

    bool buildTrackScene(const std::vector<TtpRosterCar>& roster, const ttp::RaceTrack& geo,
            const ttp::rt::Theme& theme, const ttp::rt::WearPlan& wear);
    // The roster half of TrackBin — a copy now that the liveries arrive typed.
    static void applyRoster(TrackBin& out, const std::vector<TtpRosterCar>& roster);
    static void applyTheme(TrackBin& out, const ttp::rt::Theme& theme);
    // The geometry half, copied (and float-narrowed) straight off the built
    // track. Also derives what used to be computed JS-side from the geometry:
    // the launch-strip blanking zones and the scenery/landmark/clutter seeds.
    static void fillGeometry(TrackBin& out, const ttp::RaceTrack& geo);
    bool buildRoadMesh(TrackBin& tb); // also retains the ring polyline on the bin
    void accumulateNormals(Mesh& m);
    void appendSphere(Mesh& mesh, int wseg, int hseg,
            const std::function<filament::math::float3(const filament::math::float3&)>& transform,
            const std::function<uint32_t(const filament::math::float3&)>& colorAt,
            bool lit = false);
    bool loadCarAsset(uint32_t index, const std::vector<uint8_t>& glb);
    // One car slot's scene pieces, shared verbatim between buildTrackScene and
    // reroster(). Each reads the roster fields off `tb` (the build's local bin,
    // or the retained mTrack on a re-roster) and assumes the per-car containers
    // are already sized to the field.
    bool buildCarSlot(const TrackBin& tb, uint32_t c);   // GLB via loadCarAsset, else box marker
    void buildCarGhost(uint32_t c);                      // 50%-alpha occlusion twin (+ decode pump)
    void destroyCarSlot(uint32_t c);                     // the inverse of the two above
    void dropAsset(filament::gltfio::FilamentAsset*& a);
    // Attach finished texture decodes: the async queue only binds on a pump, so
    // every batch of loads ends with one (see the note in buildTrackScene).
    void pumpTextures();
    void ensureAssetLoader();
    void registerAssetUris(filament::gltfio::FilamentAsset* asset);
    // shareMaterials false keeps each instance's own MaterialInstance, so they
    // can be tinted APART — costing the draw-call batching the sharing buys.
    // Only the box fade pool wants it: two players can grab two boxes a beat
    // apart, and on one shared material the second grab would rewrite the
    // first's alpha mid-fade.
    filament::gltfio::FilamentAsset* loadInstancedProp(const char* assetName,
            size_t count, std::vector<filament::gltfio::FilamentInstance*>& out,
            bool shareMaterials = true);

    // ---- Merged draw groups (explicit instancing) --------------------------
    // The 4-player frame on the TV boxes is bound by SUBMISSION — ~30 µs per
    // draw on the Android box, and the world is submitted once per cell —
    // while Filament's automatic instancing cannot batch most of the kit (it
    // is depth-bucketed and winding-split; see the shell docs). So the two
    // families that are many-copies-of-one-mesh — the car field and the
    // per-copy dressing — are re-issued as ONE renderable per distinct MESH
    // with an explicit InstanceBuffer: geometry decoded from the same GLB
    // bytes the shell already provided (ttp/glb_mesh.h), materials SHARED from
    // the gltfio-loaded originals, and the original renderables taken out of
    // the scene. The gltfio node entities STAY, transforms and all: every
    // behaviour that rides a transform — wheel spin/steer/travel, the monster
    // park, the ghost swap, debugHideCars — is inherited by mirroring node
    // world transforms into the instance buffer (updateMergedTransforms),
    // never re-implemented. A model this machinery cannot fully decode keeps
    // drawing exactly as gltfio loaded it — merging is an optimisation with a
    // whole-model fallback, not a second code path to keep correct.
    struct MergedPrim {
        filament::VertexBuffer* vb = nullptr;
        filament::IndexBuffer* ib = nullptr;
        // CPU copies stay alive for the group's life — BufferDescriptors carry
        // no release callback (the Mesh rule).
        std::vector<filament::math::float3> pos;
        std::vector<filament::math::quatf> quats;
        std::vector<filament::math::float2> uvs;
        std::vector<uint32_t> idx;
    };
    struct MergedGroup {
        utils::Entity ent;
        std::vector<MergedPrim> prims;
        filament::InstanceBuffer* ibuf = nullptr;
        std::vector<utils::Entity> sources;      // one gltfio node per instance
        std::vector<filament::math::mat4f> xf;   // mirror scratch
        float radius = 0;                        // mesh-local bound, world AABB
        bool dynamic = false;                    // mirror world transforms per frame
        uint8_t feat = 0;                        // kFeat* bit for tagFeatures
    };
    std::vector<MergedGroup> mMergedCars;   // rebuilt whenever the roster moves
    std::vector<MergedGroup> mMergedDress;  // built once per scene's dressing
    bool mCarMergeDirty = false;
    bool mDressMergeDirty = false;
    bool mMergeOff = false;                 // kFeatNoMerge (ablation only)
    std::vector<uint64_t> mCarModelKey;     // per slot: FNV of its GLB bytes
    // Parsed kit geometry, keyed by the bytes' FNV. Engine-lifetime — the kit's
    // bytes never change, so a cup's four scenes parse each model once.
    std::unordered_map<uint64_t, std::vector<ttp::rt::GlbMeshNode>> mGlbMeshCache;
    // Which parse an instanced dressing asset was loaded from (scene scope).
    std::unordered_map<const filament::gltfio::FilamentAsset*, uint64_t> mAssetMeshKey;
    static uint64_t glbBytesKey(const std::vector<uint8_t>& glb);
    const std::vector<ttp::rt::GlbMeshNode>* glbMeshes(uint64_t key,
            const std::vector<uint8_t>& glb);
    bool buildMergedGroup(std::vector<MergedGroup>& out,
            const std::vector<utils::Entity>& sources,
            const std::vector<ttp::rt::GlbMeshPrim>& prims, bool dynamic,
            uint8_t feat);
    void destroyMergedGroups(std::vector<MergedGroup>& groups);
    void mirrorMergedGroup(MergedGroup& g,
            filament::math::float3& mn, filament::math::float3& mx);
    void rebuildCarMerge();
    void buildDressingMerge();
    void mergeInstancedSet(const filament::gltfio::FilamentAsset* asset,
            const std::vector<filament::gltfio::FilamentInstance*>& insts,
            bool dynamic);
    void updateMergedTransforms();
    void buildWater(const TrackBin& tb);
    void buildFliers(const TrackBin& tb);
    void buildGantry(const TrackBin& tb);
    void buildScenery(const TrackBin& tb);
    void buildKitField(const TrackBin& tb);
    void kitFieldApron(Mesh& ground, float groundY, float tile, uint32_t col) const;
    void buildProps(const TrackBin& tb);
    void buildLandmarks(const TrackBin& tb);
    void buildClutter(const TrackBin& tb);
    void buildStructures(const TrackBin& tb);
    void setMeshShadows(Mesh& m, bool cast, bool receive);
    // Render the static track's depth from the sun ONCE, into a texture the lit
    // materials sample for themselves. Filament re-renders its own shadow map
    // per VIEW per frame, which a 4-way split pays for four times over; the JS
    // renders one and freezes it (SceneRenderer.setTrack), and so do we.
    void bakeShadowMap(const TrackBin& tb);
    // The matte light rig's NUMBERS — sun colour/lux and the hemisphere's
    // 2-band SH, UNEXPOSED — one derivation for the scene's lights
    // (buildTrackScene) and the road's baked vertex light (fillRoadLight),
    // so the two cannot drift.
    struct MatteRig {
        filament::math::float3 sunColor;
        float sunLux;
        filament::math::float3 sh0, sh1;
        float hemiLux;
    };
    MatteRig matteRig(const TrackBin& tb) const;
    // Evaluate the road's matte light — ttpMatteLight's CPU twin, the fwidth
    // AA floor dropped exactly as vvis.mat's bake drops it — into
    // mRoad.custom0. `esm` is bakeShadowMap's blurred exponential map read
    // back as RGBA floats (Renderer::readPixels convention: TOP row first on
    // every backend); null means "no map baked" and answers fully lit, like
    // the shader's shadowTexel-0 early-out did.
    void fillRoadLight(const TrackBin& tb, const float* esm,
            uint32_t esmW, uint32_t esmH);
    // Hand the baked map + its world→light matrix to a material instance.
    void bindShadowMap(filament::MaterialInstance* mi);
    void bindVisMap(filament::MaterialInstance* mi);
    filament::MaterialInstance* litShadowInstance();
    // The fog colour to give Filament, pre-graded — see the definition for why
    // the grade cannot stay in the shader for this one.
    filament::math::float3 fogColorGraded(const filament::Camera* cam) const;
    // The 1×1 white, made on first ask. Three callers want one for three
    // reasons: it neutralises a glTF base-colour map, it stands in for the sun
    // map on a track that baked none, and it fills vglb's base-colour sampler
    // for a glTF material that carries no texture at all.
    filament::Texture* whiteTexture();
    // The deck's instance of mRoadMaterial (or litShadowInstance() when the
    // road material is absent). Separate from litShadowInstance because that
    // one is shared with the structures and berms, which must not stamp.
    filament::MaterialInstance* roadInstance();
    // Pushes into mDeckDecals unless `out` redirects it (the held-back aura
    // list) — either way this is the ONE place the profile-decal layout is
    // assembled.
    void addDeckDecal(float s, float lat, float halfS, float halfLat,
            const filament::math::float3& linCol, float alpha,
            float inner, float kneeAlpha, bool ellipse,
            std::vector<DeckDecal>* out = nullptr);
    // The entry layout, built in ONE place for every producer in both channels.
    static DeckDecal makeStamp(float s, float lat, float halfS, float halfLat,
            const filament::math::float3& col, float alpha, float inner, float knee,
            bool ellipse, int chevrons);
    // Which entries a fold takes. The DECAL channel now runs two folds over one
    // source list — masked and profile have separate uniform arrays and separate
    // caps in vroad.mat — while the PAINT channel takes everything.
    enum class DecalKind { All, Masked, Profile };
    // The lap-wrap fold both deck channels share — see the definition. Fills
    // `out` in list order up to `cap`, so an overflowing chunk keeps the head.
    static int foldToChunk(const std::vector<DeckDecal>& src, float mid,
            float halfSpan, float L, DeckDecal* out, int cap,
            DecalKind kind = DecalKind::All);
    void uploadDeckDecals();
    // Resolve the decals that never move — oil slicks and item-box contact
    // shadows — into mStaticDeckDecals, once per track.
    void buildStaticDeckDecals(const TrackBin& tb);
    // The deck's own paint — the asphalt patches (ttp/wear.h) and the boost
    // pads. NOT decals: paint is the surface, so the rubber layer composites
    // OVER it. Written straight onto the road chunks once per track, so none
    // of it touches a per-frame path.
    void buildDeckPaint(const TrackBin& tb, const ttp::rt::WearPlan& wear);
public:
    // DEBUG: what was actually packed for the road last frame. Exists so the
    // decal numbers can be read and compared against the car's own position
    // instead of inferred from pixels — which is how a wrong lateral coordinate
    // survived several rounds of colour-coded shader probes.
    const std::vector<DeckDecal>& debugDeckDecals() const { return mDeckDecalsLast; }
    // DECAL ISOLATION. A contact shadow is a dark patch on asphalt, under an
    // opaque car, on a deck that also carries laid rubber — so on an ordinary
    // frame you cannot say which dark pixel is which, and several rounds of
    // this were argued from ambiguous screenshots. These make the stamp the
    // only thing on the road. Nothing on the shipping path reads them.
    void debugHideCars(bool on) { mHideCars = on; }
    void debugWipeSkids() { mSkidWipe = true; }
    // Force every masked stamp onto ONE mask layer, or −1 to leave each car on
    // its own. kMaskLayerGeneric is the generic superellipse, a shape correct
    // by construction, so it separates "the bake is wrong" from "everything
    // downstream of the bake is wrong" without reading the texture back.
    // Clamped: the layer count shrank when the store went per-model, and an
    // out-of-range index would sample past the array rather than fail.
    void debugForceMaskLayer(int layer) {
        mForceMaskLayer = layer < 0 ? -1
                : (layer >= kMaskLayers ? kMaskLayers - 1 : layer);
    }

    // FEATURE ABLATION — the per-feature cost map's only instrument.
    //
    // The frame is submission-bound (per-cell draw calls, not fill), so "what
    // does the sky cost" cannot be answered by reading a shader: it is a
    // question about how many renderables a feature puts in front of every
    // cell's culler. This drops one group at a time and lets the GPU timer
    // answer. `mask` carries kFeat* bits; a cleared bit hides that group.
    //
    // WHY LAYERS AND NOT SCENE MEMBERSHIP: half these groups are pools whose
    // membership the frame itself rewrites (boxes, streaks, bursts), so a
    // removal would be undone by the next update pass. A layer bit is set once
    // and filtered at the view, which is also where the per-cell cost is.
    // The trade is that FScene::prepare still walks a hidden entity — the
    // reading is the DRAW half of a feature's cost, not the whole of it.
    static constexpr uint8_t kFeatRoad     = 0x04; // the deck ribbon (chunked)
    static constexpr uint8_t kFeatTerrain  = 0x08; // ground, sky, hills, water, structures
    static constexpr uint8_t kFeatDressing = 0x10; // scenery, props, landmarks, clutter, cones
    static constexpr uint8_t kFeatSky      = 0x20; // clouds, haze, fliers, balloon
    static constexpr uint8_t kFeatCars     = 0x40; // car GLBs, monster rigs, boost streaks
    static constexpr uint8_t kFeatEffects  = 0x80; // item pools, rockets, bursts, ambient
    static constexpr uint8_t kFeatAll = kFeatRoad | kFeatTerrain | kFeatDressing
            | kFeatSky | kFeatCars | kFeatEffects;
    // The road turns out to BE the frame's cost, so it gets a second set of
    // bits — its fragment shader's four channels, switched by the uniforms that
    // already gate them (vroad.mat early-outs on each count / half-width being
    // zero). These do not hide anything: the same deck is drawn, shaded with
    // one channel skipped, which is exactly what a candidate optimisation of
    // that channel could ever be worth.
    static constexpr uint32_t kFeatRoadDecals = 0x0100;
    static constexpr uint32_t kFeatRoadRubber = 0x0200;
    static constexpr uint32_t kFeatRoadPaint  = 0x0400;
    static constexpr uint32_t kFeatRoadShadow = 0x0800;
    static constexpr uint32_t kFeatRoadAll = kFeatRoadDecals | kFeatRoadRubber
            | kFeatRoadPaint | kFeatRoadShadow;
    // SCENE-WIDE channels, the same idea one level up: the same picture drawn
    // with one per-fragment term skipped, on every surface at once rather than
    // on the deck alone. Filament's fog is the first, because it is composited
    // inside EVERY surface shader and so cannot be ablated by hiding anything.
    static constexpr uint32_t kFeatFog = 0x1000;
    // TTP_DEBUG_NO_MERGE — SET takes the merged draw groups apart, so a sweep
    // prices the merging itself as interleaved arms on one launch.
    static constexpr uint32_t kFeatNoMerge = 0x2000;
    void debugFeatureMask(uint32_t mask);
private:
    bool mHideCars = false;
    int mForceMaskLayer = -1;
    // Feature-ablation state (debugFeatureMask). mFeatureTagged latches the one
    // pass that moves every renderable off the default layer bit onto its
    // group's — until a caller asks, nothing here touches a shipped frame.
    uint8_t mFeatureMask = kFeatAll;
    uint32_t mRoadMask = kFeatRoadAll;
    bool mFogOn = true;
    bool mFeatureTagged = false;
    void tagFeatures();
    void tagEntities(const utils::Entity* e, size_t n, uint8_t bit);
    void tagMesh(const Mesh& m, uint8_t bit);
    void applyRoadDebug();
    // Frustum culling, off by default (buildMesh): a mesh whose vertices are
    // rewritten in WORLD space every frame — the billboards, the burst pools —
    // outlives its build-time bounds, so only meshes that stay put (or move by
    // transform) may opt in.
    void setMeshCulling(Mesh& m, bool enable);
    void refreshBounds(Mesh& m);
    void setShadows(const utils::Entity* e, size_t n, bool cast, bool receive);
    // Add/remove from mScene, edge-triggered. The idiomatic way to hide
    // something in Filament: a parked transform still costs a prepare slot per
    // cell, scene membership costs a bitset bit. See the definitions.
    void setMeshInScene(Mesh& m, bool on);
    void setInstanceInScene(filament::gltfio::FilamentInstance* inst, uint8_t& state, bool on);
    void setAssetInScene(filament::gltfio::FilamentAsset* asset, uint8_t& state, bool on);
    void buildOils(const TrackBin& tb);
    void ensureCells(uint32_t count);
};
