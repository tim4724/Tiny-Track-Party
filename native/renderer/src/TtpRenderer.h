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
class ColorGrading;
struct ToneMapper;
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
    bool init(filament::backend::Backend backend, void* nativeWindow,
            uint32_t width, uint32_t height);
    void resize(uint32_t width, uint32_t height);
    // Skip the sun's shadow bake for every scene built from here on. The bake is
    // a 2048² depth pass over the whole circuit plus its ESM blur, once per
    // track — cheap on a GPU, a genuinely heavy frame under software GL, and a
    // Grand Prix pays it four times. Headless automation turns it off (the JS
    // renderer this replaced did the same, via navigator.webdriver → key
    // .castShadow = false). Takes effect at the next buildScene; not a live
    // toggle, since the map is baked into the scene.
    void setShadowsEnabled(bool on) { mShadowsEnabled = on; }

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
    bool buildScene(const ttp::RaceTrack& geo, const ttp::rt::Theme& theme,
            const std::vector<TtpRosterCar>& roster);
    // Re-dress the BUILT scene's car slots in place — same track, same slot
    // count, camera state and cosmetic clocks untouched. `remodel` slots reload
    // their GLB (the shell re-provided car<slot>.glb first) plus ghost,
    // silhouette and plate; `redress` slots rebuild only what wears the livery.
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
    // ttp_profile() hands the page. Order matches kProfileNames.
    enum ProfileSlot : uint32_t {
        kProfCars = 0, kProfWorld, kProfSkids, kProfAmbient, kProfBeginFrame,
        kProfCellSetup, kProfCellRender, kProfPresent, kProfEndFrame, kProfTotal,
        kProfCount
    };
    const double* profile() const { return mProfile; }
    static const char* const* profileNames();

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
        // Optional UV0, in its own buffer slot. Only the sprite cloud carries
        // one (the corner offset its material billboards by) — every other mesh
        // is position + colour, so UVs stay out of the shared vertex.
        std::vector<filament::math::float2> uvs;
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
    // The road deck only: mLitMaterial's shading (shared via ttp_shade.inc)
    // plus a uv0 channel carrying track space (s, lat), so flat deck decals are
    // SHADED INTO the road rather than laid over it — no lift, no z-fight,
    // no render order. Null if the shell served no vroad.filamat, in which
    // case the road falls back to vlit and stamps nothing.
    filament::Material* mRoadMaterial = nullptr;
    filament::MaterialInstance* mRoadInst = nullptr;
    static constexpr int kMaxDeckDecals = 32;  // matches vroad.mat's float4[32]
    struct DeckDecal {
        filament::math::float4 rect;   // s, lat, halfS, halfLat — ALL world units
        filament::math::float4 color;  // linear rgb, peak alpha
        filament::math::float4 shape;  // innerFrac, isEllipse, kneeAlpha, spare
    };
    std::vector<DeckDecal> mDeckDecals;      // gathered per frame
    std::vector<DeckDecal> mDeckDecalsLast;  // last frame's, for debugDeckDecals()
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
    };
    std::vector<RoadChunk> mRoadChunks;
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
    void destroySceneTarget();

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
    // Ground-conform probe accelerator: XZ hash of mRoad's triangles (the JS
    // keeps per-tile collision clones out of the scene graph and raycasts them;
    // our ribbon is one soup, so the grid buckets triangles instead).
    static constexpr float kRoadCell = 2.0f;
    std::unordered_map<uint64_t, std::vector<uint32_t>> mRoadGrid; // cell → first vertex of each tri
    Mesh mGround;
    // The ground's tiled colour bands (the biome's lawn/sand/redrock/snow/wood
    // canvas, baked to vertex colour). The berms tile the SAME texture in the
    // JS, so they sample this by world x.
    struct GroundBand { float w; filament::math::float3 col; }; // w = fraction of a tile
    std::vector<GroundBand> mGroundBands;
    static constexpr float kGroundTile = 600.0f / 18.0f;
    filament::math::float3 groundColorAt(float x) const;
    // Build the biome's 256² floor texture (textures.js makeLawn/Sand/RedRock/
    // Snow/WoodFloorTexture, ported pixel-for-pixel) and hand it to Filament.
    filament::Texture* buildGroundTexture(uint32_t kind);
    filament::Texture* buildShadowMask();
    // Top-down alpha coverage of a loaded car, at the blob quad's exact framing.
    // The entity overload is what the INSTANCED monster rig needs: gltfio hands
    // an instanced asset's renderables to the FilamentInstance, not the asset.
    filament::Texture* bakeSilhouette(filament::gltfio::FilamentAsset* asset,
            const filament::math::float3& bbMin, const filament::math::float3& bbMax);
    filament::Texture* bakeSilhouette(const utils::Entity* entities, size_t count,
            const filament::math::float3& bbMin, const filament::math::float3& bbMax);
    // Point a ground blob's decal instance at a mask. `baked` = a silhouette
    // that came out of bakeSilhouette (single level, already blurred); false is
    // the mipmapped generic rounded-rect fallback.
    void setBlobMask(filament::MaterialInstance* mi, filament::Texture* mask, bool baked);
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

    // Real car models (gltfio + ubershaders). mCarAssets[i] is null when car i
    // fell back to its box marker; otherwise the asset root is posed per frame.
    filament::gltfio::MaterialProvider* mMatProvider = nullptr;
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
        float pitch = 0, prevSpd = 0;              // weight-transfer state (dspd of NORMALIZED spd)
        float accelNorm = 0;                       // forward-bite 0..1 — launch-scratch skids read it
        filament::math::float3 lastPos{};          // wheel-roll travel measurement
        bool hasLastPos = false;
        float lastDs = 0;                          // this frame's travel — streaks read it
        float rollSign = -1, pitchSign = -1;       // posed-frame X axis sign (addCar's measurement)
        float wheelbase = 1.6f;                    // front↔rear axle span (ground-conform probes)
        float rideOff = 0;                         // damped road-minus-centreline offset
        bool hasRide = false;                      // rideOff seeded (re-seeds after a stunt)
        float skidWidth = 0.12f;                   // tyre-contact width (wheel AABB, clamped)
        float skidHold = 0;                        // scuff strength, released over SKID_RELEASE
        float skidAllHold = 0;                     // same, for the four-wheel (scrub/spin) channel
        float footW = 0.95f, footL = 2.0f;         // car footprint (asset AABB) — blob + boost disk
        filament::math::float3 bbMin{}, bbMax{};   // asset AABB — rear plate anchor
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
    // snapshot) and dropped bananas (dynamic pool), both instanced kit GLBs;
    // boost pads are painted overlays (mPads, polygon-offset material).
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
    // Every box's contact blob is baked into the ONE mPropShadows mesh, so a
    // collected box's blob can only be hidden by rewriting its slice of the
    // vertex alphas: `mBoxShadowRest` is the baked colour to scale, and
    // `mBoxShadowFade` what is currently uploaded (re-upload only on a change).
    std::vector<uint32_t> mBoxShadowRest;
    std::vector<uint8_t> mBoxShadowFade;
    uint32_t mBoxShadowStride = 0;             // verts per box in mPropShadows
    Mesh mStructures;             // pillars / poles / loop shafts (matte concrete)
    Mesh mBerms;                  // grass lofted under a raised, non-pillared deck
    Mesh mPropShadows;            // baked contact blobs under the item boxes
    std::vector<Mesh> mPropBlobs; // pooled blobs for bananas + rockets (per frame)
    Mesh mPads;
    filament::MaterialInstance* mPadMat = nullptr;
    float mTime = 0; // idle-animation clock (accumulated FrameInput.dt)

    // Translucent bits (vblend material, vertex alpha): per-car ground blobs.
    filament::Material* mBlendMaterial = nullptr;
    // Round camera-facing sprites (vpoint): the ambient-particle cloud. The
    // billboard + the radial falloff both live in the shader — see vpoint.mat.
    filament::Material* mPointMaterial = nullptr;
    filament::MaterialInstance* mPollenMat = nullptr; // owns the sprite's halfSize
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
    // Textured translucent decals (vdecal): the car's conformed ground shadow,
    // whose penumbra is far too tight to carry in vertex alpha.
    filament::Material* mDecalMaterial = nullptr;
    filament::Texture* mShadowMaskTex = nullptr;
    // The frozen sun shadow map and the matrix that puts a world position in
    // its [0,1] texture space (see bakeShadowMap).
    filament::Texture* mShadowMap = nullptr;
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
    // Per-car ground-shadow silhouette, rendered top-down off the real model
    // (SceneRenderer._bakeCarShadow's trick). Null falls back to mShadowMaskTex.
    std::vector<filament::Texture*> mCarSilhouettes;
    std::vector<Mesh> mCarBlobs;
    // Each blob's own decal instance, kept so the mask can be swapped for the
    // monster rig's outline while the truck is up (edge-triggered on blobMask).
    std::vector<filament::MaterialInstance*> mCarBlobMats;
    std::vector<filament::Texture*> mCarBlobMasks; // which mask each blob wears now
    std::vector<Mesh> mPlates; // rear name plates (livery sticker + pixel-font name)
    std::vector<Mesh> mBoostDisks; // teal aura while boostMul > 1
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
    // ...and its inverse, cached because the streak billboards need it ONCE PER
    // CELL while the basis itself only changes once per car per frame. Inverting
    // it at the use site meant a general 4x4 inverse per streak per cell — 128 of
    // them a frame at the 4-player cap, all but 32 of which recomputed a matrix
    // that had not moved since the last cell.
    std::vector<filament::math::mat4f> mCarBasisInv;
    // Skid trails — full SkidMarks.js port: per-wheel connected ribbons
    // (shared joint edges), slip/scrub/spin/brake/launch channels, peak-alpha
    // by strength, SKID_LIFE fade to the SKID_PATINA floor. One ring buffer of
    // 3-column stamps (feathered width via vertex alpha: 0 | peak | 0).
    Mesh mSkids;
    uint32_t mSkidCursor = 0;
    struct WheelTrail {
        filament::math::float3 last{}, dir{}, edgeL{}, edgeR{};
        bool hasEdge = false, seeded = false;
        int slot = -1; // ring slot currently growing under this wheel
    };
    std::vector<WheelTrail> mWheelTrails; // carCount × 4 (fl fr bl br)
    std::vector<float> mSkidLife, mSkidPeak; // per ring slot
    std::vector<int> mSkidOwner;             // slot → wheel index growing there (−1 free)
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
    // Drifting cloud puffs (soft ellipsoid stand-ins for the JS sprites).
    std::vector<Mesh> mClouds;
    std::vector<filament::math::float3> mCloudPos; // current position (x drifts)
    // Low dust banks (theme.haze) — same puff, bank-flat, drifting faster.
    std::vector<Mesh> mHaze;
    std::vector<filament::math::float3> mHazePos;
    // Trackside scenery: instanced tree/bush GLBs + a merged boulder mesh.
    std::vector<filament::gltfio::FilamentAsset*> mSceneryAssets;
    std::vector<std::vector<filament::gltfio::FilamentInstance*>> mSceneryInstances;
    Mesh mBoulders;
    Mesh mLandmarks; // procedural hero set-pieces (seeded placement)
    Mesh mWindmill;  // the windmill's rotor — its own mesh, spun per frame
    // Chimney smoke (cabin): three soft puffs rising on a staggered loop.
    std::vector<Mesh> mSmoke;
    filament::math::float3 mSmokeOrigin{};
    // The wind-up train: loco + key, driven round a stadium oval each frame.
    Mesh mTrain, mTrainKey;
    // Per-model variant picks and the bench, indexed by the .cpp's ModelId
    // (rocket, gnome, train). Sized by hand because that enum lives beside the
    // builders it names; a static_assert in the .cpp holds the two together.
    //
    // THESE DEFAULTS ARE WHAT THE GAME DRAWS, and all three are settled picks
    // off the model bench (/gallery-assets.html): the detailed gnome, the
    // classic loco, and the cruise missile. The rocket took five rounds to
    // land, and 2..3 are the two unpicked readings of the same brief, kept
    // because the bench is worth more with them in it than the source is
    // shorter without.
    //
    // Variant 0 is the pre-bench geometry on every row and is kept — a bench
    // with no "what we have today" in it is not a comparison — but it is no
    // longer any model's default, so a shell that never calls setModelVariant
    // now gets the picked set rather than the original one.
    // gallery-assets.js's BENCH_MODELS mirrors these for its captions.
    int mModelVariant[3] = { 1, 1, 1 };
    int mBenchModel = -1;

    filament::math::float3 mTrainCentre{};
    float mTrainCos = 1, mTrainSin = 0;
    bool mHasTrain = false;
    filament::math::mat4f mWindmillBase{};
    // Baked lawn shadows: soft ink blobs under trees/pylons/landmarks — the
    // stand-in for the JS shadow map's casters landing on grass.
    std::vector<filament::math::float4> mShadowSpots; // x, z, radius, height
    Mesh mGroundShadows;
    Mesh mClutter;   // near-field flowers (rand2 stream)
    Mesh mBalloon;   // hot-air balloon (theme.balloon — grass/sunset hero)
    float mBalloonY = 44, mBalloonSize = 6; // theme.balloon orbit height + scale
    float mHillSf = 1; // hill-ring push-out factor (balloon orbit radius scales with it)
    Mesh mOils;      // authored slick hazards (overlay discs)
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
    // The RIG's top-down outline, for the ground blob while the truck is up —
    // painting the little car's silhouette under a lifted four-wheeled chassis
    // put a car-shaped smudge between tyres that were nowhere near it.
    filament::Texture* mMonsterSilhouette = nullptr;
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
    // is anchored in the world or depth-tested (the rear name plates, the boost
    // aura, the skids, the gantry).

    // Ambient particles (theme.ambient): base positions from the 74747 stream,
    // drifted per frame (fall/wind/bob) with a whole-VB re-upload.
    Mesh mPollen;
    std::vector<filament::math::float3> mAmbBase;
    std::vector<float> mAmbSpeed;
    // The kind's motion preset (AMB_KINDS, resolved into track.bin).
    float mAmbSize = 0.15f, mAmbFall = 0.1f, mAmbWind = 1.2f;
    float mAmbBob = 0.6f, mAmbBandH = 34.0f * 0.35f;
    std::vector<filament::math::float3> mPrevRockets;
    uint32_t mPrevRocketCount = 0;
    filament::math::float3 mLastCar0{}; // reset/teleport detector
    utils::Entity mSun;
    utils::Entity mFill;
    filament::IndirectLight* mAmbient = nullptr;
    // Linear tonemap on the race cells: Three.js outputs linear→sRGB (its own
    // grading lives in the present shader), so Filament's default ACES would
    // shift every colour the parity diff is trying to judge.
    filament::ToneMapper* mToneMapper = nullptr;
    filament::ColorGrading* mColorGrading = nullptr;

    double mProfile[kProfCount] = {};
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
    bool buildTrackScene(const std::vector<TtpRosterCar>& roster, const ttp::RaceTrack& geo,
            const ttp::rt::Theme& theme);
    // The roster half of TrackBin — a copy now that the liveries arrive typed.
    static void applyRoster(TrackBin& out, const std::vector<TtpRosterCar>& roster);
    static void applyTheme(TrackBin& out, const ttp::rt::Theme& theme);
    // The geometry half, copied (and float-narrowed) straight off the built
    // track. Also derives what used to be computed JS-side from the geometry:
    // the launch-strip blanking zones and the scenery/landmark/clutter seeds.
    static void fillGeometry(TrackBin& out, const ttp::RaceTrack& geo);
    bool buildRoadMesh(const TrackBin& tb);
    void buildRoadGrid();
    // Height of the road ribbon straight below (x, z), picking the deck nearest
    // `refY` (stacked strands) and keeping only near-horizontal faces — the
    // SceneRenderer _roadHitY probe the ground-conform rides on. `hit` reports
    // whether anything was under the point at all.
    float roadHitY(float x, float z, float refY, bool* hit) const;
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
    bool buildCarPlate(const TrackBin& tb, uint32_t c);  // rear name plate (GLB cars only)
    bool buildCarBlob(uint32_t c);                       // contact-shadow grid, mask from the silhouette
    void destroyCarSlot(uint32_t c);                     // the inverse of the four above
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
    void buildPadsMesh(const TrackBin& tb);
    void buildWater(const TrackBin& tb);
    void buildFliers(const TrackBin& tb);
    void buildGantry(const TrackBin& tb);
    void buildScenery(const TrackBin& tb);
    void buildLandmarks(const TrackBin& tb);
    void buildClutter(const TrackBin& tb);
    void buildStructures(const TrackBin& tb);
    void setMeshShadows(Mesh& m, bool cast, bool receive);
    // Render the static track's depth from the sun ONCE, into a texture the lit
    // materials sample for themselves. Filament re-renders its own shadow map
    // per VIEW per frame, which a 4-way split pays for four times over; the JS
    // renders one and freezes it (SceneRenderer.setTrack), and so do we.
    void bakeShadowMap(const TrackBin& tb);
    // Hand the baked map + its world→light matrix to a material instance.
    void bindShadowMap(filament::MaterialInstance* mi);
    filament::MaterialInstance* litShadowInstance();
    // The deck's instance of mRoadMaterial (or litShadowInstance() when the
    // road material is absent). Separate from litShadowInstance because that
    // one is shared with the structures and berms, which must not stamp.
    filament::MaterialInstance* roadInstance();
    void addDeckDecal(float s, float lat, float halfS, float halfLat,
            const filament::math::float3& linCol, float alpha,
            float inner, float kneeAlpha, bool ellipse);
    void uploadDeckDecals();
    // Resolve the decals that never move — pads, launch strips, oil slicks and
    // item-box contact shadows — into mStaticDeckDecals, once per track.
    void buildStaticDeckDecals(const TrackBin& tb);
public:
    // DEBUG: what was actually packed for the road last frame. Exists so the
    // decal numbers can be read and compared against the car's own position
    // instead of inferred from pixels — which is how a wrong lateral coordinate
    // survived several rounds of colour-coded shader probes.
    const std::vector<DeckDecal>& debugDeckDecals() const { return mDeckDecalsLast; }
private:
    // Frustum culling, off by default (buildMesh): a mesh whose vertices are
    // rewritten in WORLD space every frame — the conformed decals, the skid
    // ribbons, the billboards — outlives its build-time bounds, so only meshes
    // that stay put (or move by transform) may opt in.
    void setMeshCulling(Mesh& m, bool enable);
    void refreshBounds(Mesh& m);
    void setShadows(const utils::Entity* e, size_t n, bool cast, bool receive);
    // Add/remove from mScene, edge-triggered. The idiomatic way to hide
    // something in Filament: a parked transform still costs a prepare slot per
    // cell, scene membership costs a bitset bit. See the definitions.
    void setMeshInScene(Mesh& m, bool on);
    void setInstanceInScene(filament::gltfio::FilamentInstance* inst, uint8_t& state, bool on);
    void setAssetInScene(filament::gltfio::FilamentAsset* asset, uint8_t& state, bool on);
    // Drop a flat car-local decal (boost aura, ground blob) onto the deck:
    // every template vertex is re-expressed as (arclength, lateral) about the
    // car's foot and re-placed by frameAt, so the sheet BENDS over crests,
    // banks and loop walls. The JS raycasts each vertex onto the rendered road
    // for the same result; a single flat quad clipped through curving decks.
    void conformDecal(Mesh& mesh, const filament::math::mat4f& basis,
            float sx, float sz, float lift, float alphaScale);
    // Same, for a caller that already knows (s, lat) — skips project()'s linear
    // scan of the whole centreline.
    void conformDecalAt(Mesh& mesh, const filament::math::mat4f& basis,
            float s0, float lat0, float sx, float sz, float lift, float alphaScale);
    void buildOils(const TrackBin& tb);
    void ensureCells(uint32_t count);
};
