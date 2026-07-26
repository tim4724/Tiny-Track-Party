// libttp-renderer — platform-free Filament renderer (docs/native-port/plan.md
// Track R). Shells prepare the surface (GL context current / CAMetalLayer) and
// pass backend + native window through init(); everything else lives here so
// the same code ships on web, tvOS and Android TV.
//
// The scene is built entirely from the serialized track payload ("track.bin"):
// road ribbon swept from the centerline, ground/sky/hills, scenery and
// furniture, cars from provided GLBs, and 2×2 split-screen with per-cell
// cameras from FrameInput.views. buildScene() fails without that payload.
#pragma once

#include "ttp_runtime.h"

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
    bool provideAsset(const char* name, const uint8_t* bytes, uint32_t len);
    bool buildScene();
    // Destroy everything the scene owns — meshes, glTF assets, lights, sky,
    // material instances — and reset the per-scene state, so buildScene() can
    // run again on a new track.bin (a Grand Prix chains four of them) or a new
    // roster. The engine, views, materials and provided asset bytes survive.
    void releaseScene();
    bool render(const TtpFrameInput& input); // false = beginFrame skipped (stale canvas)

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

    struct TrackBin; // parsed "track.bin" payload (defined in the .cpp)

    filament::Engine* mEngine = nullptr;
    filament::SwapChain* mSwapChain = nullptr;
    filament::Renderer* mRenderer = nullptr;
    filament::View* mView = nullptr; // single default view (no-views fallback)
    filament::Scene* mScene = nullptr;
    filament::Camera* mCamera = nullptr;
    filament::Skybox* mSkybox = nullptr;
    filament::Material* mMaterial = nullptr;    // unlit vertex-colour
    filament::Material* mLitMaterial = nullptr; // cheap-matte lit (custom Lambert)
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
    filament::Texture* bakeSilhouette(filament::gltfio::FilamentAsset* asset,
            const filament::math::float3& bbMin, const filament::math::float3& bbMax);
    // Split-screen column count for n cells — SceneRenderer's bestGrid, so the
    // 3D cells land where the DOM HUD puts its labels.
    uint32_t bestGridCols(uint32_t n) const;
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
    std::vector<filament::gltfio::FilamentAsset*> mCarAssets;
    // 50%-alpha ghost variants (patched GLBs) — the monster occlusion fade
    // swaps the whole rig (chassis AND grafted body) like the JS traversal.
    std::vector<filament::gltfio::FilamentAsset*> mCarGhostAssets;
    // Scene-membership state for the pools that spend most of a race idle
    // (setInstanceInScene / setAssetInScene are edge-triggered on these).
    std::vector<uint8_t> mCarGhostIn, mMonsterIn, mMonsterGhostIn, mBananaIn;
    // Wheel cosmetics (SceneRenderer setCarPose): front wheels yaw with steer
    // (±WHEEL_TURN_MAX) and all four roll at WHEEL_SPIN_SCALE × v/r.
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
    filament::gltfio::FilamentAsset* mBananaAsset = nullptr;
    std::vector<filament::gltfio::FilamentInstance*> mBoxInstances;
    std::vector<filament::gltfio::FilamentInstance*> mBananaInstances;
    std::vector<filament::math::mat4f> mBoxXf; // box anchor bases (world)
    float mBoxScale = 1.0f;                    // kit box → BOX_H 0.3 world units
    std::vector<float> mBoxCollectT;           // grow+pop burst clocks (TrackProps)
    std::vector<uint8_t> mBoxPrevAvail;        // availability edge detect
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
    // Textured ground (vground): the biome's floor canvas, generated as pixels
    // to match the JS canvas texture rather than approximated with bands.
    filament::Material* mGroundMaterial = nullptr;
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
    filament::math::mat4f mShadowFromWorld;
    float mShadowTexel = 0.05f; // world units per shadow texel, for the bias
    // Depth bias, in the map's normalised depth. Derived per track from a fixed
    // WORLD bias so its on-the-ground meaning does not scale with track size.
    static constexpr float kShadowWorldBias = 0.20f; // 20 cm along the light
    float mShadowDepthBias = 0.0f;
    // Per-car ground-shadow silhouette, rendered top-down off the real model
    // (SceneRenderer._bakeCarShadow's trick). Null falls back to mShadowMaskTex.
    std::vector<filament::Texture*> mCarSilhouettes;
    std::vector<Mesh> mCarBlobs;
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
    std::vector<Mesh> mRockets;      // in-flight toy rockets (pool of 4)
    std::vector<Mesh> mRocketFlames; // per-rocket blend tail flames
    // Impact bursts: expanding rings where a rocket vanished (hit or whiff).
    struct Burst {
        filament::math::float3 pos{};
        float t = -1; // <0 idle; else seconds since impact
    };
    Burst mBursts[2];
    Mesh mBurstMeshes[2]; // shockwave rings
    Mesh mBurstBalls[2];  // flash balls
    // No HUD here by design: everything in SCREEN space (place card, lap pill,
    // item slot, name chip, countdown, results) belongs to the shell's own UI
    // layer — DOM/CSS on web, Compose on Android TV, SwiftUI on tvOS. The
    // renderer draws only what is anchored in the world or depth-tested (the
    // rear name plates, the boost aura, the skids, the gantry).

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
    bool buildTrackScene(const std::vector<uint8_t>& bin);
    bool parseTrackBin(const std::vector<uint8_t>& bin, TrackBin& out);
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
    void ensureAssetLoader();
    void registerAssetUris(filament::gltfio::FilamentAsset* asset);
    filament::gltfio::FilamentAsset* loadInstancedProp(const char* assetName,
            size_t count, std::vector<filament::gltfio::FilamentInstance*>& out);
    void buildPadsMesh(const TrackBin& tb);
    void buildWater(const TrackBin& tb);
    void buildFliers(const TrackBin& tb);
    void buildGantry(const TrackBin& tb);
    void buildScenery(const TrackBin& tb);
    void buildLandmarks(const TrackBin& tb);
    void buildClutter(const TrackBin& tb);
    void buildStructures(const TrackBin& tb);
    void setMeshShadows(Mesh& m, bool cast, bool receive);
    void setMeshShadowsAbove(Mesh& m, float minY);
    // Render the static track's depth from the sun ONCE, into a texture the lit
    // materials sample for themselves. Filament re-renders its own shadow map
    // per VIEW per frame, which a 4-way split pays for four times over; the JS
    // renders one and freezes it (SceneRenderer.setTrack), and so do we.
    void bakeShadowMap(const TrackBin& tb);
    // Hand the baked map + its world→light matrix to a material instance.
    void bindShadowMap(filament::MaterialInstance* mi);
    filament::MaterialInstance* litShadowInstance();
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
