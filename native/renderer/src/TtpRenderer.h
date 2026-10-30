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
// The GLB mesh reader behind the merged draw groups, and the flat-body weld
// they draw the car bodies with — header-only for the same no-link-edge reason
// as theme.h above; ctests execute both on every leg.
#include "ttp/flat_weld.h"
#include "ttp/glb_mesh.h"
namespace ttp { namespace kitcolors { struct Mesh; struct Model; } }
#include "ttp/car_footprint.h"
#include "ttp/ground_grid.h"
#include "ttp/name_tags.h"
#include "ttp/set_motion.h"


// The car contact shadow's constants, and the ONE place they are written down:
// the renderer holds one const instance (mShadowTune). Every value is the
// shipped look, the measurements behind each sit beside it, and
// native/renderer/CLAUDE.md has the rules they serve.
//
// THE SHAPE IS A ROUNDED RECT FITTED TO EACH MODEL (bakeCarFootprint) — four
// corners for every car, the user's call after seeing the alternatives on the
// glass. A fitted k-gon carried more silhouette and read WORSE where it
// mattered: the roster's one distinctive footprint, Rumble, is an open-wheeler
// — a narrow rear body with a GAP to wheels that poke past it — and a lobeless
// closed-form shape can only render that as lumps. The rect is per-car through
// its fit (fill across, fill along) and is the cheap raster: half the channel's CPU on the Android box
// against sampling an outline mask sixteen times a texel.
struct CarShadowTuning {
    float ao = 0.62f;          // the stamp's peak opacity
    // Summed-coverage ceiling (vshadow.mat's extent.w). The layer this
    // replaced accumulated with saturating ADD, where the masked loop before
    // it composited two overlapped stamps as a mix-of-mixes —
    // at full wheel load 1-(1-0.710)² ~ 0.916 (0.710 = ao deepened by the
    // loadGain term) — so the cap keeps a pile-up as dark as the loop drew
    // it instead of letting addition run it toward black.
    float cap = 0.918f;
    float loadGain = 0.08f / 0.55f;  // deepening at full body pitch
    uint32_t ink = 0x171513u;  // the shadow's colour, sRGB
    float overscan = 1.45f;    // footprint's share of the stamp quad
    // The stamp's scale on the fitted footprint, both axes: just past the
    // wheels, so the corners do not leave a tyre standing on bare road.
    float size = 1.04f;
    // THE CORNER RADIUS, as a fraction of the half-extent (1 is an ellipse),
    // the same for every car, and square enough to keep the wheels inside the
    // shadow — "very rounded" read as too small (the user's call 2026-10-23).
    // car_footprint.h says why the fit does not measure one.
    float corner = 0.3f;
    // THE STORED FIELD'S WIDTH — deliberately wider than the penumbra the
    // player sees, because the remap below carves the visible edge out of its
    // middle and a wide smooth field is what keeps that edge sub-texel under
    // the raster's per-frame re-landing. The die-cut era's sweep stands as
    // the evidence: on identical gated frames 0.030 cut edge flicker 25%,
    // 0.040 43%, 0.060 61% — wider is calmer, and the old reason to stop
    // (the outline mask's wheel lobes blurring away) left with the rounded
    // rect, which has no lobes to lose.
    float blur = 0.07f;        // the field's ramp, as a fraction of mask width
    // The tail-cut remap, AS FRACTIONS OF THE PEAK ALPHA — `placeCarShadow`
    // multiplies them by `ao` on the way to the uniform. The SHADER takes it on
    // the interpolated field (the signed-distance trick); taking it in the
    // raster instead measured 44% MORE edge flicker on identical gated frames.
    //
    // **A WIDE MEDIUM BAND OVER A WIDE FIELD IS THE LOOK**, settled on the
    // road-space layer this pass replaced and kept: `remapLo` clips the faint
    // tail, `remapHi` saturating at mid-field pulls the visible transition
    // tight. A narrow band (the die-cut's 0.39..0.61) is the other cliff, a
    // slope that facets on the texel grid; 0.2..0.8 is the middle — outline
    // defined, tail clipped, slope ~1.7 against the die-cut's ~4.5. The band
    // must stay non-empty: a degenerate smoothstep is UB.
    float remapLo = 0.2f;
    float remapHi = 0.8f;
};

#include <backend/DriverEnums.h>
#include <math/mat4.h>
#include <math/vec3.h>
#include <utils/Entity.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace filament {
class Engine;
class Fence;
class IndirectLight;
class SwapChain;
class Renderer;
class View;
class Scene;
class Camera;
class Texture;
class RenderTarget;
class Material;
class VertexBuffer;
class IndexBuffer;
class MaterialInstance;
class InstanceBuffer;
namespace backend {
class Platform;
} // namespace backend
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
#if defined(__ANDROID__)
    // Before init: the file the Vulkan backend keeps its compiled pipelines in
    // between runs. Unset keeps them in memory, as every other backend does.
    void setPipelineCacheFile(std::string path) { mPipelineCacheFile = std::move(path); }
    // Start the engine before there is a window, and return at once: the
    // driver (Vulkan instance and device, the pipeline cache read, or the EGL
    // context) comes up on Filament's own thread while the shell's main thread
    // gets on with its first frames, and init() collects it, waiting only for
    // whatever is left. No window is needed until init's createSwapChain. The
    // backend init is later handed must be this one. Call it on the thread init
    // runs on — Filament hands the engine back only there.
    void prepare(filament::backend::Backend backend);
#endif
    void resize(uint32_t width, uint32_t height);
    // Skip the sun's shadow bake for every scene built from here on. The bake is
    // a 2048² depth pass over the whole circuit plus its ESM blur, once per
    // track — cheap on a GPU, a genuinely heavy frame under software GL, and a
    // Grand Prix pays it four times. Headless automation turns it off (the JS
    // renderer this replaced did the same, via navigator.webdriver → key
    // .castShadow = false). Takes effect at the next buildScene; not a live
    // toggle, since the map is baked into the scene.
    // Latched, like every input below that is not in the scene key: a change
    // drops the resident static scene (dropStaticKey).
    void setShadowsEnabled(bool on) {
        if (on != mShadowsEnabled) { mShadowsEnabled = on; dropStaticKey(); }
    }

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

    // ---- the set-piece layout (dev) ---------------------------------------
    // Where the track's set pieces ended up, for the landmark gallery's camera
    // (the shape is ttp_display_set_layout's). The footprint is mSetFeet's
    // own, so a camera framing a piece and the keep-outs every later pass
    // honours cannot disagree about where it stands. Written once per static
    // scene; kNoSetLayout before one is built, and the ABI's answer when
    // there is no renderer at all.
    const char* setLayout() const { return mSetLayout.c_str(); }
    // Where buildScenery stood each tree and boulder, for the same camera's
    // sight lines (the shape is ttp_display_scatter_layout's); "[]" before a
    // build.
    const char* scatterLayout() const { return mScatterLayout.c_str(); }
    // The built static scene's ground height at (x, z): groundSurfaceY, the
    // surface every scattered piece stands on, or the berm under raised road
    // where one stands higher (bermY). 0 with no scene.
    float groundY(float x, float z) const;
    // What keeps a set piece's surface over (x, z), spanning world heights lo
    // to hi, from standing there in the built scene: "road", "pillar", "berm",
    // "piece" (another piece's foot; set layout row `skip` is not counted) or
    // "sea"; "" where it may stand. For the landmark gallery's placement
    // search, which moves pieces it has not built.
    const char* spotIssue(float x, float z, float lo, float hi, int skip) const;
    static constexpr const char* kNoSetLayout = "{\"groundY\":0,\"length\":0,\"pieces\":[]}";

    bool provideAsset(const char* name, const uint8_t* bytes, uint32_t len);

    // ---- what still has to be handed over ---------------------------------
    //
    // Provisioning is mostly RE-work. `mAssets` survives releaseScene, so across
    // two builds the props are always the same bytes, the textures always are,
    // the scenery is whenever the biome held, and the cars are unless somebody
    // actually picked a different one. A re-dress is worse: the roster moves for
    // a ready toggle, a rename or a seat expiry, none of which change a byte.
    //
    // WHICH ONES ARE STALE IS ENGINE KNOWLEDGE, and it lives here for the reason
    // the blob walk gives one layer up: a shell that mirrors the asset map has
    // to invalidate its mirror when a destroyed surface takes the map away, and
    // only one of three shells ever had that mirror at all. `mAssetTag` lives
    // and dies with `mAssets`, so there is nothing to invalidate.
    //
    // THE TAG IS WHAT THE BYTES ARE A FUNCTION OF, in the caller's vocabulary —
    // a kit model's base name, a texture's authored URI. Not the asset name:
    // `scenery3.glb` is different bytes when the biome changes, while
    // `Textures/colormap.png` never is.
    struct AssetWant {
        std::string name;
        std::string tag;
        // What a DERIVED asset is made out of (a ghost's model). Answering the
        // derivative alone would ask a shell to derive from bytes it did not
        // fetch, so a wanted derivative brings its source with it.
        std::string from;
    };
    // The subset of `want` this engine does not already hold under that tag.
    // Remembers every entry's tag, so the provideAsset that follows stamps it.
    std::vector<std::string> assetPlan(const std::vector<AssetWant>& want);
    // The images[].uri every held model references that is not held itself.
    // Answered from the bytes the engine has, so a model the plan above skipped
    // still contributes its textures — which is the whole reason the shells can
    // stop reading a GLB they already handed over.
    std::vector<std::string> assetTextures();
    // The bytes provided under `name`, or nullptr. The scene's caller needs the
    // scenery GLBs back: half of a biome's recolour rule is each model's own
    // AUTHORED material colours, and this class is where those bytes live.
    const std::vector<uint8_t>* asset(const char* name) const;
    // Which backend the engine runs (filament::Backend as an int). Rides every
    // blob key: a blob's byte orientation is a fact about the backend that read
    // it back — see the flip note in stageBlob.
    int backendId() const;

    // ---- derived bytes, kept between runs ---------------------------------
    //
    // WHAT A KEY IS HERE. Every blob this class can produce is named by a key in
    // the renderer's own vocabulary; the FILE it lands in is the display shim's
    // business (ttp/blobstore.h) and nothing below knows a filename. The one
    // kind is the sun bake — one blob per scene, `track|biome|showcase|backend`.
    //
    // STAGE, THEN FINISH, and that is not tidiness. A readback never completes
    // inside the build that issues it (ttp_display.h, "derived bytes"), so an
    // export that insisted on answering at once could never answer. `stage`
    // snapshots everything that is NOT a readback — headers, matrices, the
    // row-flip convention — and issues the reads; `collectStagedBlobs` finishes
    // any whose reads have landed, on a later frame beat, on every backend. The
    // snapshot is what makes
    // that safe: a staged blob owns its own metadata, so the build that lands it
    // need not be the build that made it.
    //
    // import answers false for any blob it does not fully trust, and leaves what
    // is resident untouched when it does.
    // NO bakeBlobKeys(). A scene's bake key needs the biome latched, which
    // happens one layer up, so the shim composes it there (bakeKeyFor) and this
    // class never spells it — one rule, one place (root CLAUDE.md rule 1).
    // Is this key's thing already in the engine, so the caller need not read it?
    bool blobResident(const std::string& key) const;
    // Snapshot + issue. False when there is nothing to stage under that key.
    bool stageBlob(const std::string& key);
    // Move a finished blob's bytes out. False while it is still coming, which
    // is how the caller polls: it holds the key/filename pairing, so there is
    // nothing for this class to enumerate.
    bool takeStagedBlob(const std::string& key, std::vector<uint8_t>& out);
    // Take a blob back, and answer WHICH key it turned out to be — the bytes
    // say (importBlob reads their header), and the caller cannot know
    // before asking. Empty means refused: a version it does not know, or bytes
    // that do not describe what they claim.
    //
    // ANSWERING THE KEY IS LOAD-BEARING, not a convenience. It used to answer a
    // bool, so a caller could only ask "is anything resident now?" and had to
    // mark every resident key as having come from the store. One offered blob
    // then vouched for its siblings, and a blob that was resident but had never
    // been written was skipped by every later build — a cache that silently
    // stopped filling, which is the failure this whole path exists to remove.
    std::string importBlob(const uint8_t* bytes, uint32_t len);

    // Has a frame of the CURRENT scene FINISHED on the GPU — not merely been
    // submitted, which is all render()'s true says. The two part company on a
    // queueing backend: Vulkan's first frames after a build sit behind the
    // pipeline-compile storm, so the compositor has nothing to latch for over a
    // second while render() keeps answering true. A boot cover that lifts on
    // render()'s word uncovers that gap as a black lobby (the Android shell's
    // hasPainted latch is the caller). Polls a fence armed by the first
    // presented frame after a build; sticky true until the scene is released.
    bool settled();

    // The built scene's ground surface, as the mesh draws it (ttp/ground_grid.h).
    const ttp::rt::GroundGrid& groundGrid() const { return mGroundGrid; }

    // Slot i as the name tags see it (ttp/name_tags.h), measured off the model
    // at load: its roof over its origin as drawn — in the monster rig while
    // `monster` — and the body it grafts into that rig, the seat it sits on and
    // its half width and length (wheels off).
    ttp::rt::NameTagShape carShape(uint32_t i, bool monster) const {
        static const CarWheels unmeasured{};
        const CarWheels& w = i < mCarWheels.size() ? mCarWheels[i] : unmeasured;
        if (!monster) return { w.roof, w.monsterSeat, w.monsterBodyHalf.x, w.monsterBodyHalf.y };
        const float s = w.rigScale;
        return { w.monsterRoof * s, w.monsterSeat * s, w.monsterBodyHalf.x * s, w.monsterBodyHalf.y * s, s };
    }

    // THE SCENE IS TWO THINGS WITH TWO LIFETIMES. The STATIC scene — the
    // track, its dressing, the sky, the sun bake — is a function of `key`
    // (what the shim says the scene is OF: track, biome, showcase, backend)
    // plus the inputs latched on this class (shadows, the bench, the model
    // variants, the kit field), whose setters drop it. The FIELD — the cars and
    // everything sized by them — is a function of the roster. A join, a leave,
    // a launch or a restart on the same track changes only the field, so it is
    // all a build of a resident key pays (rebuildField); nothing static ever
    // depends on the roster, and anything added to the static half must not.
    //
    // `geo` is the built track this scene is meshed from — the SAME
    // ttp::RaceTrack the sim races on, handed straight over rather than
    // serialized; `theme` is the resolved biome, likewise a live object;
    // `roster` is the one thing the SHELL supplies, in slot order; `wear` is
    // the road-wear plan for the same track (ttp/wear.h), computed by the
    // caller, whose patches become deck PAINT (buildDeckPaint). NOTHING about
    // a scene is serialized.
    bool buildScene(const std::string& key, const ttp::RaceTrack& geo,
            const ttp::rt::Theme& theme, const std::vector<TtpRosterCar>& roster,
            const ttp::rt::WearPlan& wear);
    bool staticResident(const std::string& key) const {
        return !key.empty() && key == mStaticKey;
    }
    // A new field on the resident static scene, which is put back at its
    // opening state on the way (resetRace): cones upright, no rubber.
    bool rebuildField(const std::vector<TtpRosterCar>& roster);
    // Re-dress the BUILT scene's car slots in place — same track, same slot
    // count, camera state and cosmetic clocks untouched. `remodel` slots reload
    // their GLB (the shell provided the new model's first) plus ghost and
    // shadow fit; `redress` slots rebuild only what wears the livery.
    // Which slots go in which list is planReroster's call (ttp/roster.h) — this
    // performs it. False = no scene to re-dress or a slot failed; the caller
    // falls back to a full build.
    bool reroster(const std::vector<TtpRosterCar>& roster,
            const std::vector<uint32_t>& remodel,
            const std::vector<uint32_t>& redress);
    // Tear down the field alone; the static scene stays resident under its
    // key until a build of another key or the destructor frees it.
    void releaseField();
    // …and the pools keyed by the field's car count, which releaseField keeps:
    // the monster rig and its ghost, kept across scenes too, and the boost
    // streaks, which wear the scene's boost colour.
    void releaseMonsterPools();
    void releaseStreakPool();
    // Both halves — meshes, glTF assets, lights, sky, material instances —
    // back to bare engine. The engine, views, materials and provided asset
    // bytes survive.
    void releaseScene();
    bool render(const TtpFrameInput& input); // false = beginFrame skipped (stale canvas)
    // The frame's CPU half alone — the seating, the props, the skid stamps, the
    // ambient clocks — with nothing submitted and the stamps' uploads deferred
    // to the next render(). ttp_display_advance says what for.
    bool advance(const TtpFrameInput& input);

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
        // qtangents in a second buffer slot) unless it bakes its light
        // (custom0, bakeLight). Empty = unlit vcolor.
        std::vector<filament::math::float3> normals;
        std::vector<filament::math::quatf> quats; // derived; alive for upload
        // Optional UV0, in its own buffer slot: the road (track space, which
        // vroad shades its decals from), the ambient-particle sprites (the
        // corner offset vpoint billboards by) and the cloud/haze puffs (the
        // field vcloud shapes them from). Most meshes are position + colour, so
        // UVs stay out of the shared vertex.
        std::vector<filament::math::float2> uvs;
        // Optional BAKED per-vertex matte light, DISPLAY-ENCODED: custom0.xyz
        // the ambient term, custom1.xyz ambient + sun (the receiver's fragment
        // mixes the two through its visibility tap), custom0.w the raw NoL the
        // visibility bakes read — every static shadow RECEIVER
        // (the road, the ground, the structures, the berms), filled by
        // bakeVertexLight. Non-empty ⇒ buildMesh feeds CUSTOM0/1 INSTEAD of
        // TANGENTS (nothing at draw time reads the normal). Alive for the run
        // like every CPU copy here.
        std::vector<filament::math::half4> custom0, custom1;
        // OPT-IN for a STATIC lit sheet: buildMesh folds the matte light into
        // the vertex colours (bakedMatteLight) and draws it UNLIT, so nothing
        // at draw time transforms a normal or shades a fragment. Only a mesh
        // that never moves after build may say so — a transform would carry
        // the baked light with it, so what moves stays on vlit.
        bool bakeLight = false;
        // OPT-IN for a static mesh that is already unlit (a baked kit run):
        // buildMesh welds its exact duplicate vertices, as it does for every
        // bakeLight sheet. Only a mesh whose CPU copy is never rewritten by
        // index after build may say so.
        bool weld = false;
        // OPT-IN for a mesh buildMesh welds (see `weld`): each of its
        // renderables gets a far form simplified to kFarTol (mLods).
        bool simplify = false;
        // Flat-decal template in car-local (x, z) with its rest alpha: the
        // conform rewrites `verts` into world space from this every frame.
        struct Local { float x, z; uint8_t a; };
        std::vector<Local> local;
        // Whether this mesh's entities are currently IN mScene. Pooled meshes
        // (blobs, streaks, rockets, bursts) leave the scene when they go idle
        // rather than parking underground — see setMeshInScene.
        bool inScene = false;
        // SPATIAL chunk ranges, in triangles, from tileMajor(): buildMesh
        // draws each range as its own renderable with its own box, instead of
        // cutting `chunkTris` off the triangle ORDER. Empty = by order.
        std::vector<uint32_t> tileStarts;
        // The vertex layout buildMesh chose: slot 0 is the shared Vertex, then
        // qtangents (lit), UV0 and the baked CUSTOM0, each in a slot of its own
        // only when present. Kept so a second buffer for this mesh (the
        // streak ring) is built to it through buildVertexBuffer — the layout
        // keys Vulkan's vertex-input state, and any difference is a pipeline
        // compiled on first draw.
        struct Layout {
            bool lit = false, uv = false, baked = false;
            uint8_t uvSlot() const { return lit ? 2 : 1; }
            // custom0's slot; custom1 is the next one.
            uint8_t customSlot() const {
                return (uint8_t) (1 + (lit ? 1 : 0) + (uv ? 1 : 0));
            }
        };
        Layout layout;
    };

    // Reorder a static sheet's triangles by the ground tile their centroid
    // falls in and record the tile ranges in `tileStarts`, so every renderable
    // buildMesh makes of it covers ONE tile and a cell's frustum can reject
    // the rest. A sheet the size of the world in one renderable is drawn whole
    // by every cell however little of it is on screen; cut on triangle ORDER
    // a row-major grid gives bands that cross every frustum exactly like the
    // whole — which is what the 2026-09-04 "range chunk" arm measured, and
    // why it read null (docs/perf/androidtv-frame-map.md). Tiles with fewer
    // than `minTris` triangles are merged into the next, so a sparse sheet
    // does not become hundreds of renderables.
    static void tileMajor(Mesh& m, float tile, uint32_t minTris);
    // 48 u tiles: a 4P cell's frustum to the fog is a wedge a few tiles wide,
    // and the world is ±400 u, so a sheet is at most a few hundred ranges;
    // a range under 64 triangles is not worth a renderable of its own.
    static constexpr float kSheetTile = 48.0f;
    static constexpr uint32_t kSheetMinTris = 64;
    // The live values: the constants above, or coarser on the Android GL
    // fallback (init), where a draw costs more than the vertices it saves.
    float mSheetTile = kSheetTile;
    uint32_t mSheetMinTris = kSheetMinTris;
    // A set piece's bake tile (bakePlacements), split by whole part. Finer
    // than a sheet's because a piece is dense where a sheet is sparse, so a
    // tile drawn whole to a camera beside it costs vertices a sheet's would
    // not; doubled on the GL fallback like the sheet's.
    static constexpr float kPieceTile = 8.0f;
    float mPieceTile = kPieceTile;

    struct TrackBin; // one scene's roster + theme + geometry (defined in the .cpp)

    filament::Engine* mEngine = nullptr;
#if defined(__ANDROID__)
    // The Vulkan platform with the framebuffer-eviction override (see
    // TtpRenderer::init) — caller-owned, so it outlives the engine here.
    std::unique_ptr<filament::backend::Platform> mVkPlatform;
    std::string mPipelineCacheFile;
    // prepare()'s engine until init or the destructor collects it.
    struct PendingEngine;
    std::shared_ptr<PendingEngine> mPending;
    filament::Engine* collectEngine();
#endif
    filament::SwapChain* mSwapChain = nullptr;
    filament::Renderer* mRenderer = nullptr;
    filament::View* mView = nullptr; // single default view (no-views fallback)
    filament::Scene* mScene = nullptr;
    filament::Camera* mCamera = nullptr;
    // THE SKY IS A DOME CENTRED ON EACH CELL'S CAMERA (vsky.mat): a unit
    // sphere carrying the biome's elevation gradient as graded vertex colours,
    // which renderCells moves to the cell's eye and scales to that view's own
    // far plane before every render(). Two earlier shapes, and why not them:
    //
    // - A dome of fixed radius centred on the WORLD ORIGIN: the far plane is
    //   measured from the camera, so once a car left the origin the dome's far
    //   side was clipped and a circular hole slid around the sky. Centred on
    //   the eye and sized from the view's farZ, no radius is ever past the
    //   plane and the camera is never through the shell.
    // - Filament's Skybox over a cubemap of the same gradient (2026-10-14):
    //   its full-screen draw samples the cubemap on every sky pixel through
    //   the skybox material, ~0.6 ms of a 4P 720 heavy second on the Android
    //   box, where a vista is mostly sky. The dome's fragment is a varying
    //   read. Same picture to the eye (the gradient is 8-bit per vertex, 49
    //   rings, where the cubemap was 64 texels a face).
    filament::Material* mSkyMaterial = nullptr;   // renderer-lifetime, like vroadvis
    Mesh mSkyDome;
    filament::Material* mMaterial = nullptr;    // unlit vertex-colour
    // Cheap-matte live-lit (vlit.mat, custom Lambert): the meshes that MOVE.
    // Every static lit surface bakes its light instead (custom0, bakeLight).
    filament::Material* mLitMaterial = nullptr;
    // The road deck only: the matte light baked per vertex (ttp_shade.inc)
    // plus a uv0 channel carrying track space (s, lat), so flat deck decals are
    // SHADED INTO the road rather than laid over it — no lift, no z-fight,
    // no render order. Null if the shell served no vroad.filamat, in which
    // case the road draws its bare vertex colours and stamps nothing.
    filament::Material* mRoadMaterial = nullptr;
    filament::MaterialInstance* mRoadInst = nullptr;
    // THE PER-FRAME GATHER cap, and it is CPU-side only: this list is the whole
    // scene's decals before any chunk sees them, so it costs a memcpy and
    // nothing on the GPU. The two numbers that DO cost are below.
    static constexpr int kMaxDeckDecals = 32;
    // PER CHUNK — and this is the expensive constant in the renderer. vroad
    // declares one dynamically-indexed uniform array per field, and a PowerVR
    // pays for a declared array whether or not the loop runs: measured on a
    // GE9215 over a frozen single-player race at 1280x720, one mixed 32-entry
    // list (7 arrays, 3584 bytes) cost 25.9 ms of GPU, the same seven arrays at
    // 16 cost 18.9 and at 8 cost 17.6.
    //
    // Eight profile is the item-box shadows, oil slicks and boost auras within
    // one ~35u chunk; the fold takes them in the shell's priority order, so an
    // overflow drops the last aura rather than a marker. RAISING IT IS
    // MEASURABLE IN THE FRAME, and the parked-view reading that declared size
    // had become free does NOT survive a real pack: the 2026-08-18 spectate-7
    // arm that raised profile to 16 with nothing else changed cost +1.1 ms
    // p50 / +1.5 p95 at 720p. vroad.mat's float4[8]s must agree;
    // tests/road-decal-caps.test.js holds the two together.
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
    // the same way whichever array they arrive in. Kept POD with no padding
    // (thirteen floats): uploadDeckDecals memcmps these to skip a chunk whose
    // list hasn't changed.
    struct DeckDecal {
        filament::math::float4 rect;   // s, lat, halfS, halfLat — ALL world units
        filament::math::float4 color;  // linear rgb, peak alpha
        filament::math::float4 shape;  // innerFrac, isEllipse, kneeAlpha, chevrons
        // 1 on a car's contact-shadow entry, 0 on everything else. A car entry
        // is READBACK ONLY (ttp_display_debug_decals): the shadow pass
        // draws the shadow, so foldToChunk folds the entry into no chunk.
        float car;
    };
    std::vector<DeckDecal> mDeckDecals;      // gathered per frame
    std::vector<DeckDecal> mDeckDecalsLast;  // last frame's, for debugDeckDecals()

    // render(), split along the profiler's zones (TtpRendererFrame.cpp). What
    // crosses a phase boundary crosses as a parameter: the car contract slots,
    // the ground-conformed car positions, and the boost auras held back so
    // they lead the frame's dynamic stamps (render()'s auraDecals has the
    // compositing order).
    void renderCars(const TtpFrameInput& input, const TtpCarInput* cars, uint32_t nCars,
            std::vector<filament::math::float3>& carPosW, std::vector<DeckDecal>& auraDecals);
    void renderWorld(const TtpFrameInput& input, const TtpCarInput* cars, uint32_t nCars,
            const std::vector<filament::math::float3>& carPosW, std::vector<DeckDecal>& auraDecals);
    // render() and advance() are one body: `draw` is where they part.
    bool frame(const TtpFrameInput& input, bool draw);
    void renderSkids(const TtpFrameInput& input, const TtpCarInput* cars, uint32_t nCars);
    void renderAmbient(const TtpFrameInput& input);
    // The ambient cloud's per-cell index subset (mAmbCull*): false leaves the
    // cloud on its whole count/cells range.
    bool cullAmbientCells(const TtpFrameInput& input, uint32_t slot);
    void restoreAmbientRange();
    void releaseAmbientCull();
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
        // What this chunk's instance was last handed (folded), so a chunk
        // whose stretch nothing dynamic crossed skips its uniform writes
        // entirely.
        std::vector<DeckDecal> lastProf;
        // The paint entries this chunk was built with. Written once per track,
        // so it is kept only so the ablation debug can put the channel back.
        int paintN = 0;
    };
    std::vector<RoadChunk> mRoadChunks;
    // The deck's far ribbon (buildRoadMesh): a second index buffer over the
    // road's own vertices, listed in mLods per chunk. The CPU copy stays alive
    // for the run and is BURIED with the road (buryMeshBuffers' rule); the
    // buffer dies in releaseScene.
    filament::IndexBuffer* mRoadFarIb = nullptr;
    std::vector<uint32_t> mRoadFarIdx;
    // THE FAR FORMS. A renderable listed here owns two index ranges over its
    // own vertices: the one it ships and a cheaper one that strays at most
    // `err` world units from it. chooseLods points it at one of them per CELL,
    // the far one wherever the nearest point of its box is far enough that
    // `err` covers under kLodPx pixels of THAT cell, so a big cell pushes the
    // swap out on its own and a 4-way split's small ones pull it in. Nothing
    // else about the renderable changes: culling, material and decal fold are
    // its own. Listed: the deck's chunks (buildRoadMesh) and every static mesh
    // built with `simplify` (buildMesh).
    struct LodRange {
        utils::Entity entity;
        filament::VertexBuffer* vb = nullptr;
        filament::IndexBuffer* ib = nullptr;      // the near range's buffer
        filament::IndexBuffer* farIb = nullptr;   // the far range's
        uint32_t off = 0, cnt = 0, farOff = 0, farCnt = 0;
        filament::math::float3 lo{ 0 }, hi{ 0 };
        float err = 0;
        bool far = false;
        // A road chunk's ring range (ring1 exclusive); -1 on a static mesh.
        // A chunk a car shadow lies on this frame stays NEAR in every cell
        // (mShadowRings): the pass's geometry is the fine rings' own planes,
        // and under the far ribbon's chords (up to kDeckLodTol off them) it
        // failed the depth test — no shadow under a car on a far chunk, which
        // LOD_ALL showed under the player's own.
        int ring0 = -1, ring1 = -1;
    };
    std::vector<LodRange> mLods;
    // The ring intervals (wrapped, [a, b)) this frame's car shadows cover,
    // from placeCarShadow; cleared with the draws.
    std::vector<std::pair<int, int>> mShadowRings;
    // EVERY cell count draws the far forms past their gate, one player included
    // (the user's call for the deck, 2026-09-02; it began as a split-only
    // trade). With the deck's tolerance a 270-line cell swaps past ~10 u, a
    // 1080-line one past ~40 u and a 2160-line one past ~80 u. Dropping the
    // gate altogether measured 1.2 ms more on the box's 4P heavy seconds and
    // was shipped for an hour; the user wanted a threshold back.
    static constexpr float kLodPx = 2.0f;   // the user asked for aggressive
    // How far a far-ribbon chord may leave the rings it spans (buildRoadMesh).
    static constexpr float kDeckLodTol = 0.08f;
    // How far a static mesh's simplified far form may stray (buildMesh).
    static constexpr float kFarTol = 0.2f;
    // Picks every listed renderable's range for a camera at `cam` in a cell
    // with `pxPerRad` pixels per radian; 0 puts them all on their near range.
    void chooseLods(const filament::math::float3& cam, float pxPerRad);
    // TTP_DEBUG_NO_LOD keeps every near range, so a sweep prices the far
    // forms as interleaved arms; TTP_DEBUG_LOD_ALL draws every far range,
    // gate or no gate, own car included: what the trade looks like where the
    // eye can resolve it, which past the gate it cannot.
    static constexpr uint32_t kDebugNoLod = 0x1000000;
    static constexpr uint32_t kDebugLodAll = 0x8000000;
    bool mLodOff = false, mLodAll = false;
    // TTP_DEBUG_SHADOW_SOLID: every car shadow drawn as an opaque black
    // die-cut of its fitted rect (placeCarShadow), the probe for judging the
    // pass's placement and depth on a TV.
    static constexpr uint32_t kDebugShadowSolid = 0x4000000;
    bool mShadowSolid = false;
    // Ditto for the whole-lap fallback chunk.
    std::vector<DeckDecal> mRoadInstLastProf;
    int mRoadInstPaintN = 0;               // and its RoadChunk::paintN
    // The rubber layer's tap binding (the 1x1 null texture is the
    // engine-lifetime half). The per-track texture + CPU buffer are made in
    // buildStatic and die in releaseScene.
    void bindSkidLayer(filament::MaterialInstance* mi);
    // Zero the rubber layer: memset the CPU buffer, upload level 0 whole,
    // regenerate the mip chain. Build-time init and the race-restart wipe.
    void clearSkidLayer();
    // Saturating-additive CPU raster of one stamp triangle (texel space,
    // top-left fill rule, ink linearly interpolated) into mSkidPix.
    void rasterSkidTri(const filament::math::float2* p, const float* ink);
    // Push this frame's dirty rects to the texture as sub-rect uploads.
    void uploadSkidRects();
    void flushSkidLayer();      // a drawn frame's uploads + mips (TtpRendererFrame.cpp)
    void refreshSkidMips();
    filament::math::float3 mBoostDiskLin{};
    // The structures' and berms' instance of mGroundMaterial: white albedo,
    // their own visibility map (mStructVisMap). Scene-scoped; staticInstance()
    // makes it on first ask, since the structures are built before the ground.
    filament::MaterialInstance* mStaticInst = nullptr;
    utils::Entity mCameraEntity;

    // Split-screen cells, grown on demand to FrameInput.viewCount. Each cell
    // owns ONE camera and mCellRing identical Views, cell i's at
    // mCellViews[i * mCellRing + slot]; every cell of a frame renders the same
    // slot, and the slot moves once per frame (ensureCells says why).
    std::vector<filament::View*> mCellViews;
    std::vector<filament::Camera*> mCellCameras;
    std::vector<utils::Entity> mCellCameraEntities;
    uint32_t mCellRing = 1;
    uint32_t mCellRingAt = 0;

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
    // sun bake's ESM blur draws it too (bakeShadowMap ensures it), and on the
    // AA-off TV shells ensureSceneTarget (AA-gated since the stale-handle fix)
    // never creates it. Idempotent; engine-lifetime.
    void ensurePresentQuad();
    void destroySceneTarget();

    // The per-cell scene mutations the cell loop runs between render() calls:
    // billboards turn toward camPos, the sky sprites (clouds, balloon) are
    // fitted between FOG_CUTOFF and the sky dome (SKY_DOME_SHARE), and the
    // monster ghost swap keys on "does THIS cell want the ghost". All take one
    // cell and must — see the bodies.
    void orientCellBillboards(const filament::math::float3& camPos, float farZ);
    void applyMonsterGhosts(uint32_t cell);

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
        filament::Scene* scene = nullptr;   // where it currently lives (null = nowhere)
        // The one cell this quad lies inside (a steer bar), or -1 for one that
        // crosses them all (a divider). Folded, a bar is in the scene only
        // while its own cell renders — applyCellSteerBars.
        int32_t cell = -1;
    };
    std::vector<OverlayQuad> mOverlayQuads;
    uint32_t mOverlayUsed = 0;
    // FOLDED: the quads live in the main scene and each race cell draws its
    // own inside its pass (voverlay.mat says how), and mOverlayView does not
    // render. Unfolded (a present pass: antialias) they live in mOverlayScene.
    bool mOverlayFolded = false;
    void ensureOverlay();
    // Next pooled quad, placed at (x, y, w, h) in DEVICE pixels with a TOP-LEFT
    // origin (the units ttp_grid_cell answers in); `cell` as OverlayQuad says.
    // Returns its instance for the caller to paint, or nullptr if the material
    // never arrived.
    filament::MaterialInstance* overlayQuad(float x, float y, float w, float h,
            int32_t cell = -1);
    // Between render() calls in the folded cell loop: this cell's steer bar
    // into the scene, every other cell's out of it.
    void applyCellSteerBars(uint32_t cell);
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
    // Terrain relief: the ground rises under raised road, and rolls into
    // hills away from it (see setupTerrain). Amp 0 = the flat-quad biomes
    // (sand, wood), which keep the plain.
    float mTerrainAmp = 0;
    uint32_t mTerrainSeed = 0;
    float mTerrainX0 = 0, mTerrainZ0 = 0, mTerrainX1 = 0, mTerrainZ1 = 0;
    // Clearings the set pieces and landmark spots level into the relief (so a
    // windmill never stands on a slope), each at its own height `y`: the
    // ground already there, never a plinth raised for it. Registered BEFORE
    // the ground mesh and the scatter sample the field — see the builder order.
    // A rounded rectangle: half extents hx, hz along the axes (ax, az) and
    // (-az, ax), grown by r; a landmark's round spot has zero extents. Level
    // inside, back to the land over 8 u.
    struct TerrainFlat { float x, z, ax, az, hx, hz, r, y; };
    std::vector<TerrainFlat> mTerrainFlats;
    void setupTerrain(const TrackBin& tb);
    // The ground's height at (x, z): with the clearings levelled in, or as the
    // land lies before any of them (`withFlats` false) — the height a clearing
    // is levelled TO, so a piece stands where the ground already was.
    float terrainY(const TrackBin& tb, float x, float z, bool withFlats = true) const;
    // `dell`, if asked: how far down a swell the point lies, 0 near the road.
    float terrainField(const TrackBin& tb, float x, float z, bool withFlats,
            float* dell = nullptr) const;
    // The track's landforms (TrackBin::land), resolved by setupTerrain into the
    // world: an anchor, its local +X axis (ax, az; +Z is (-az, ax)), the form's
    // own lengths and heights already scaled, and the box it can reach.
    // `piece` the set piece it came with (-1: the track's own), `base` what
    // that piece's mound or fan rises from (setupTerrain), `tint` the
    // multiplier it lays over the ground's colour (1: none).
    struct LandShape {
        uint32_t kind;
        int piece;
        float x, z, ax, az, len, r, r1, w, rz, h, h1, top, shape;
        float x0, z0, x1, z1;
        float base;
        filament::math::float3 tint;
    };
    std::vector<LandShape> mLand;
    float landforms(float x, float z, float edge, float lift, float hill, float* dell) const;
    // The landforms' tints at (x, z), multiplied: what the ground's colour
    // wears there over groundTint (a glacier's ice, a piste).
    filament::math::float3 landTint(float x, float z) const;
    float roadLift(const TrackBin& tb, float x, float z, float& edge) const;
    // Per set piece that brings its own ground (SET_GROUND), how far over the
    // plain it stands, as it was modelled on it, levelling no clearing: 0, or
    // for a mound the land's lift at its anchor. -1 for every other piece.
    std::vector<float> mSetOwnGround;
    // THE BEACH'S DUNES. Sand rolls like the other biomes, but only on the
    // LAND side of the road: inside the lap's loop (mInland, a raster of the
    // centreline polygon), never on the beach between the road and the sea, so
    // the sea shows from every stretch of road (a ring of dunes round the
    // island read as a wall and hid it). Everything, the authored landforms
    // included, sinks to exactly the plain short of the waterline (mShoreR),
    // where the water sheet and the wet sand lie flat on it.
    std::vector<uint8_t> mInland;
    int mInlandCols = 0, mInlandRows = 0;
    static constexpr float kInlandCell = 2.0f;
    std::vector<float> mShoreR;   // the shoreline's radius, kShoreSpokes bearings round
    static constexpr int kShoreSpokes = 360;
    // The plain is kept kShoreKeep inside the waterline (past the wet sand's
    // inner edge) and the land is back to full kShoreRamp further in.
    static constexpr float kShoreKeep = 15.0f, kShoreRamp = 18.0f;
    void setupBeachMask(const TrackBin& tb);
    // The share of the land that stands at (x, z), and through `inland`
    // whether that is inside the loop. 1 and 1 off the beach.
    float beachMask(float x, float z, float& inland) const;
    // The lowest the land lies under a clearing's footprint (sampled at most
    // the grid's step apart), before any clearing: what it is levelled to.
    float naturalFootY(const TrackBin& tb, const TerrainFlat& f) const;

    // The corridor the hills keep clear of the road, and the ramp back up to
    // full height past it. Named because the SAMPLE INDEX's search radius is
    // derived from them: they used to be two literals inside terrainY.
    static constexpr float kFlatR = 4.0f;
    static constexpr float kRampR = 24.0f;
    // THE RAISED GROUND. Under and beside raised road the land comes up to
    // kRaiseDrop under the deck's top, so the road stands on short stilts over
    // land instead of tall ones over the plain at its lowest point. The 1.3 u
    // of pillar it leaves showing under the slab keeps the elevated toy-track
    // read. Within kRaiseFlatR of the road the deck that counts is the
    // NEAREST one (so a crest hump gets its full lift); past that, a blend of
    // the decks nearby weighted by nearness, relaxing to the plain over
    // kRaiseRampR. Either way held under every OTHER strand of road nearby
    // (so no bank rises beside the lower road at a crossing or across a
    // hairpin): see terrainField.
    static constexpr float kRaiseDrop = 1.64f;
    static constexpr float kRaiseFlatR = 6.0f;
    static constexpr float kRaiseRampR = 30.0f;
    // How far along the lap a section must be from the nearest one to count
    // as ANOTHER strand of road: further than any section of the same strand
    // can be while still within kRaiseFlatR of the point.
    static constexpr float kOtherStrandS = 24.0f;
    // How steeply the ground may climb away from another strand of road past
    // kRaiseFlatR (rise per unit out).
    static constexpr float kStrandSlope = 0.5f;
    // THE CAP, per grid vertex (buildTerrainCap): every triangle a deck
    // crosses stays kDeckClear under that deck's lowest section corner.
    // terrainCapAt reads it anywhere, as the lowest corner of the triangle
    // the point lies in.
    static constexpr float kDeckClear = 0.12f;
    // The deck slab's depth under its top (buildRoadMesh sweeps it): what the
    // cap clears and what the supports stop under.
    static constexpr float kDeckDepth = 0.34f;
    std::vector<float> mTerrainCap;
    void buildTerrainCap(const TrackBin& tb);
    float terrainCapAt(float x, float z) const;
    // Per sample, for the raised ground: the deck's top at its low edge and
    // its arclength weight (samples are unevenly spaced, so each speaks for
    // its own span).
    std::vector<float> mTsiTopY, mTsiSpan;
    // terrainField's scratch: the samples in reach of the point it is on, with
    // their distance past the edge (kept to save an allocation per call).
    mutable std::vector<std::pair<uint32_t, float>> mTsiNear;
    // Bucket size for that index. Anything from "a few samples per cell" up
    // works; this keeps the neighbourhood search at 3x3 for a typical track.
    static constexpr float kIndexCell = 32.0f;

    void buildTerrainSampleIndex(const TrackBin& tb);
    std::vector<std::vector<uint32_t>> mTsiCells;  // XZ bucket -> sample indices
    int mTsiCols = 0, mTsiRows = 0;
    float mTsiX0 = 0, mTsiZ0 = 0, mTsiReach = 0;
    // The sampled heightfield the ground MESH is built from, kept so every
    // placement stands on the mesh's own piecewise-linear surface rather than
    // the analytic field — between grid vertices they differ by enough to bury
    // a shadow disc or a starfish. Filled by buildTerrainGrid, read by
    // groundSurfaceY (which answers groundY wherever the grid is absent), and
    // handed out by groundGrid() so the follow camera keeps clear of it.
    ttp::rt::GroundGrid mGroundGrid;
    void buildTerrainGrid(const TrackBin& tb);
    // Per grid vertex, terrainField's dell term, for the ground's colour.
    std::vector<float> mGroundDell;
    // The ground colour at a grid vertex: a low-contrast tint off the shape of
    // the land (its dells, its steep faces), multiplied over the biome's
    // texture. Never per-vertex noise: a speckle reads as a texture pattern.
    filament::math::float3 groundTint(uint32_t groundKind, float dell, float upY) const;
    float groundSurfaceY(const TrackBin& tb, float x, float z) const;
    float footprintY(const TrackBin& tb, float x, float z, float r) const;
    // The lowest and highest surface points under the same probes.
    filament::math::float2 footprintSpan(const TrackBin& tb, float x, float z, float r) const;
    // Build the biome's 256² floor texture (textures.js makeLawn/Sand/RedRock/
    // Snow/WoodFloorTexture, ported pixel-for-pixel) and hand it to Filament.
    filament::Texture* buildGroundTexture(uint32_t kind);
    // The split-screen grid for n cells — SceneRenderer's bestGrid, so the 3D
    // cells land where the DOM HUD puts its labels. cellRect tiles with it.
    struct GridDims { uint32_t cols, rows; };
    GridDims gridDims(uint32_t n) const;
    // MonsterRig's gunmetal frame: repaint the chassis primitive only, since
    // the whole truck shares one material and the tyres must keep their colour.
    // Encode a freshly made asset's base-colour factors for display (the
    // definition says why and where).
    void displayKitFactors(filament::gltfio::FilamentAsset* asset);
    void recolourMonsterChassis(filament::gltfio::FilamentAsset* asset,
            const std::vector<filament::gltfio::FilamentInstance*>& instances,
            const filament::math::float4& rgba);
    Mesh mHills; // horizon dome ring
    // Per-feature anchors {x, z, top} in AUTHORED coords — the offshore
    // landmarks (lighthouse, sailboat) sit on the LOWEST island.
    std::vector<filament::math::float3> mHillAnchors;
    // The fitted shoreline radius at a bearing (buildWater); the sailboat
    // anchors off the same curve. Null when the theme carries no water.
    std::function<float(float)> mShoreFn;
    // What the shoreline is drawn from: the track's samples and the phases its
    // shore seed gives (shoreline()), so the sea and the dunes read one curve.
    struct Shoreline {
        std::vector<filament::math::float2> pts;
        float shorePh[4], crinklePh[3], swashPh[3];
        float at(float a) const;   // the radius at bearing a
        static float harm(const float (*h)[2], int n, const float* ph, float a);
    };
    static Shoreline shoreline(const TrackBin& tb);
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
    // ...and the flat-interpolated one for the welded car bodies (vglbflat.mat,
    // ttp/flat_weld.h). Optional: without it no body is rewritten or welded.
    filament::Material* mGlbFlatMaterial = nullptr;
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
    //
    // The half width and length a body grafted onto the monster truck is
    // fitted to: the kit truck's chassis width and wheel footprint, in its
    // own units (vehicle-monster-truck.glb).
    static constexpr filament::math::float2 MONSTER_BODY_HALF{ 0.21875f, 0.4375f };
    struct CarWheels {
        utils::Entity fl, fr, bl, br;
        filament::math::float3 flT, frT, blT, brT; // original local translations
        float roll = 0;                            // accumulated roll angle (wrapped (−π,π])
        float lean = 0;                            // damped body roll (JS LEAN_MAX 0.05, 0.2/frame)
        float steerYawS = 0;                       // damped steerYaw — phone steer steps at the wire rate
        float pitch = 0, prevSpd = 0;              // weight-transfer state (dspd of NORMALIZED spd)
        float prevAir = 0, airRate = 0;            // last frame's height off the deck, and its rate
        float squash = 0, squashV = 0;             // landing spring: body offset along up (<= 0)
        float airPitch = 0;                        // the body's eased pitch against the deck
        float droop = 0;                           // how far the wheels hang, eased (AIR_DROOP)
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
        float wheelRadius = 0.125f;                // rolling radius (wheel AABB) — the roll animation
        float skidHold = 0;                        // scuff strength, released over SKID_RELEASE
        float skidAllHold = 0;                     // same, for the four-wheel (scrub/spin) channel
        float footW = 0.95f, footL = 2.0f;         // car footprint (asset AABB) — blob + boost disk
        float roof = 0.45f, monsterRoof = 0.85f;   // roof over the car's origin (asset AABB), and with
                                                   // its body grafted into the monster rig — name tags
        float monsterSeat = 0.3675f;               // where that grafted body sits in the rig, and its
        filament::math::float2 monsterBodyHalf = MONSTER_BODY_HALF;  // half width/length, wheels off
        bool monsterOn = false;                    // morph edge detect (with popT, kept across destroyCarSlot)
        float rigScale = 1;                        // the monster rig's drawn scale (mMonsterHalfLen);
                                                   // set by renderCars, read only while monster
        float popT = 0;                            // grow/shrink pop clock (0.34 s)
        utils::Entity axle;                        // exposed axle rod (some models) — stripped by MonsterRig
        filament::math::float3 axleT{};
        // MonsterRig graft offset: the wheel-less body's seat on the kit truck
        // (centred on its wheel footprint, bottom on the cab slot floor + MOUNT_LIFT).
        filament::math::float3 monsterMount{ 0, 0.28f, 0 };
        filament::math::float3 monsterBodyScale{ 1 };  // and the body's fit to the truck: chassis-wide,
                                                   // wheel-footprint-long, its own height
    };
    std::vector<CarWheels> mCarWheels;
    // The rolling radius of whichever tyre is actually ON THE ROAD: the rig's
    // fat one while a monster transform is up (the car's own are scaled to
    // nothing there), the car's measured one otherwise. The roll's
    // readability slowdown is WHEEL_SPIN_SCALE's job alone; it does not
    // belong in a radius.
    float wheelRadiusFor(const CarWheels& w, bool monster) const {
        return (monster && mMonsterWheelRadius > 0) ? mMonsterWheelRadius * w.rigScale
                                                    : w.wheelRadius;
    }
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
    // Whether this scene has drawn one member of every effect pool yet
    // (warmEffectPipelines). Cleared by each buildStatic.
    bool mEffectsWarm = false;
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
    // THE static-receiver material (vground.mat): baked vertex light, one
    // baked-visibility tap. The ground wears its biome canvas (generated as
    // pixels to match the JS canvas texture); the structures and berms wear
    // white through mStaticInst.
    filament::Material* mGroundMaterial = nullptr;
    // Bake-time filter that turns the raw depth map into a blurred ESM.
    filament::Material* mEsmMaterial = nullptr;
    filament::Texture* mGroundTex = nullptr; // scene scope — a new biome, a new floor
    // The ground's own instance, kept so the baked sun map can be bound to it
    // after bakeShadowMap runs (it is created well before that).
    filament::MaterialInstance* mGroundInst = nullptr;
    filament::Texture* mWhiteTex = nullptr;  // 1×1, neutralises a glTF base-colour map
    // The baked sun-visibility maps on the light's grid (vvis.mat, rendered
    // inside bakeShadowMap through the ESM's camera), and the material that
    // bakes them: the GROUND's, and the STRUCTURES' and berms' — two maps
    // because one single-valued light-space map cannot hold a surface and an
    // occluder above it (bakeShadowMap). vground taps them; bindVisMap is the
    // one binder. These two and mRoadVisMap ARE the bake: the ESM they were
    // decoded from is a local of bakeShadowMap.
    filament::Texture* mVisMap = nullptr;
    filament::Texture* mStructVisMap = nullptr;
    filament::Material* mVisMaterial = nullptr;
    // The ROAD DECK's baked sun-visibility map (vroadvis.mat), in TRACK space
    // rather than the light's grid — a barrel roll and the deck it shadows land
    // in one light-space texel, and a loop has two arclengths at one (x, z).
    // vroad taps it once per deck fragment; bindRoadVisMap is the one binder,
    // and mRoadVisLatHalf is the deck's own ±maxHalf so an off-deck lat clamps
    // onto the deck edge (see the material for the whole argument).
    filament::Texture* mRoadVisMap = nullptr;
    filament::Material* mRoadVisMaterial = nullptr;
    float mRoadVisLatHalf = 0;
    // What the resident static scene is OF (buildScene's key), empty while none
    // is: set only once a static build has finished, so one that failed partway
    // is rebuilt whole. mBakedKey is the same for the resident VISIBILITY MAPS
    // alone, which an imported blob brings without a scene (importBlob).
    std::string mStaticKey;
    std::string mBakedKey;
    // A latched static input changed: the next build is a full one and
    // re-bakes, since the casters may have moved with it.
    void dropStaticKey() { mStaticKey.clear(); mBakedKey.clear(); }
    // settled()'s state: the fence armed by the first presented frame after a
    // build, and the sticky answer once it signals. Cleared in releaseField.
    filament::Fence* mSettleFence = nullptr;
    bool mSettled = false;

    // ---- the graveyard --------------------------------------------------
    //
    // A DEAD SCENE'S CPU BUFFERS, OUTLIVING THE MESHES THAT OWNED THEM.
    //
    // Every upload here hands Filament a raw pointer with a null release
    // callback (see Mesh's own note), so the driver may still read `verts` when
    // the Mesh is destroyed. `releaseScene` used to make that safe by draining
    // the whole pipeline first — a `flushAndWait` measured at 24-205 ms on the
    // Android box against 6-8 ms of teardown, i.e. almost entirely a wait, paid
    // on EVERY rebuild including the ones the bake cache already made cheap.
    //
    // Outliving the destroy is the same guarantee for none of the wait: the
    // bytes stay put until the frames that could still be reading them have
    // gone by, and the main thread walks away immediately. Nothing here becomes
    // concurrent — the GPU was always asynchronous; we simply stop standing
    // still for it.
    //
    // WHY A DELAY AT ALL, when the uploads happened at build time: some meshes
    // re-upload per frame (the decal conform rewrites `verts` into world space
    // every frame) and some late (bakeShadowMap re-uploads CUSTOM0), so a
    // teardown can land with uploads still in flight. That is precisely what
    // the fence was for.
    struct MeshGrave {
        std::vector<Vertex> verts;
        std::vector<uint32_t> idx;
        std::vector<filament::math::float3> normals;
        std::vector<filament::math::quatf> quats;
        std::vector<filament::math::float2> uvs;
        std::vector<filament::math::half4> custom0;
        // Frames still to survive. Counted DOWN on presented frames only: a
        // scene released while nothing is drawing (the lobby's fade, a
        // surface gone) must not have its buffers freed by a clock that keeps
        // running while the GPU does not.
        //
        // Graves therefore ACCUMULATE across a build, which renders no frames —
        // four back-to-back releases were measured holding 296 at once — and go
        // to zero within three frames of the picture coming back. The `graves`
        // count on the release log is there to keep that honest: a number that
        // does not return to 0 at rest is a leak, and this held CPU copies of a
        // whole scene.
        uint32_t grace = 0;
    };
    std::vector<MeshGrave> mGraves;

    // Frames a buried buffer must outlive. Three presented frames is well past
    // any upload the frame before the teardown could still have owed, and the
    // cost of being generous is a few hundred KB held a few frames longer.
    static constexpr uint32_t kGraveGraceFrames = 3;

    // Bury one mesh's CPU buffers instead of freeing them.
    void buryMeshBuffers(Mesh& m);
    // Age the graves by one presented frame, freeing what has served its time.
    void ageGraves();
    // Free every grave NOW, fence first. For teardowns that cannot wait for
    // frames because none are coming.
    void drainGravesBlocking();
    // See setShadowsEnabled. False leaves the visibility maps null, which is
    // already the "this track baked no map" path: the binders fall back to the
    // 1×1 white texture, which reads as fully lit.
    bool mShadowsEnabled = true;
    // World → the light's [0,1] texture space: the bake's camera, kept because
    // vground's vertex stage maps every receiver vertex into its visibility map
    // through it (and the blob carries it).
    filament::math::mat4f mShadowFromWorld;
    // ESM exponent, shared by the bake filter (vesm.mat) and the two bakes
    // that decode the result. It is not a quality dial: it decides WHERE in the
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
    // Boost wind streaks (SceneRenderer STREAK_*): 4 thin axial-billboard
    // quads per car slicing past the body while boosting.
    struct Streak {
        float x = 0, y = 0, z = 0, len = 1;
        float alpha = 0;
        bool dead = true;
        // The mesh's vertex buffers as a ring of mCellRing, when that is more
        // than one (renderCars says why); empty otherwise. ringVbs[0] is the
        // mesh's own vb, and ringVerts[k] is the bytes slot k last uploaded.
        std::vector<filament::VertexBuffer*> ringVbs;
        std::vector<std::vector<Vertex>> ringVerts;
        uint32_t ringAt = 0;
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
    // The slot drawn this frame: always mSkidRing[mSkidRingAt] (or null).
    filament::Texture* mSkidTex = nullptr;        // per-track, R8, upload-only
    // The layer's textures: ONE everywhere but the Android GL backend, where
    // two are drawn alternately. That driver answers an upload into a texture
    // a frame in flight samples with a copy of the WHOLE texture, so each
    // frame uploads into the slot the frame before last drew: the frame
    // skipper polls that frame's fence and skips this frame while it is
    // unsignalled, so a drawn frame's slot is never still being read. Every
    // upload the drawn slot takes is OWED to the others (mSkidOwed) and paid
    // from the CPU truth when their turn comes.
    std::vector<filament::Texture*> mSkidRing;
    uint32_t mSkidRingN = 1;          // slots to build per track; init() decides
    uint32_t mSkidRingAt = 0;         // the drawn slot's index
    // The last frame drew, so the ring steps before this frame's uploads. A
    // skipped frame does not step it, which keeps the ring on the skipper's
    // own two-frame window.
    bool mSkidRingAdvance = false;
    // The Android GL fallback (init): the GL backend on the box, never the
    // web's. Every GL-only decision in the renderer keys on this.
    bool mAndroidGl = false;
    // On it, opaque renderables are grouped by material through their priority
    // (applyGlPriorities), re-applied whenever a merge rebuild changed the scene.
    bool mGlPrioDirty = false;
    void applyGlPriorities();
    struct SkidOwed { int level; int x0, y0, x1, y1; };
    std::vector<std::vector<SkidOwed>> mSkidOwed;
    void uploadSkidLevel(filament::Texture* t, int level, int x0, int y0, int x1, int y1,
            bool owe = true);
    void stepSkidRing();
    filament::Texture* mSkidNullTex = nullptr;    // 1x1 zero, binds when no track
    std::vector<uint8_t> mSkidPix;                // CPU truth, W×H, row 0 = -latHalf
    uint32_t mSkidTexW = 0, mSkidTexH = 0;
    // Dirty texel rects laid this frame, in UNWRAPPED x (may run past W; the
    // upload splits at the seam). A handful per frame — one per committed
    // segment, merged when they touch.
    struct SkidRect { int x0, y0, x1, y1; };      // half-open [x0,x1)×[y0,y1)
    std::vector<SkidRect> mSkidDirty;
    static constexpr size_t kSkidDirtyMax = 32;   // past this the list is one union rect
    bool mSkidCatchUp = false;                    // undrawn frames stamped; refresh all mips
    static void mergeUploadRects(std::vector<SkidRect>& rects);   // TtpRendererDecals.cpp
    // The mip chain's CPU truth, levels 1.. (level 0 is mSkidPix), plus the
    // PHYSICAL-x rects awaiting the throttled per-level refresh — see
    // refreshSkidMips for why generateMipmaps could not stay.
    std::vector<std::vector<uint8_t>> mSkidMips;
    std::vector<SkidRect> mSkidMipDirty;
    // A refresh pass in flight: the rects the NEXT level is filtered under,
    // and that level (0 = idle). One level per frame — see refreshSkidMips.
    std::vector<SkidRect> mSkidMipRects;
    int mSkidMipLevel = 0;
    float mSkidLatHalf = 0;                       // half the lat span the texture covers
    // Texel edges in world units per axis. The stamp feather is sized from
    // the texel footprint along the mark's own width direction, so straights
    // (resolved by the fine lat axis) stay crisp while diagonal segments —
    // which alias against the coarser s axis — get just enough ramp.
    float mSkidTexelS = 0, mSkidTexelLat = 0;
    // The rubber layer's width ceiling: a CHOSEN cross-platform policy, not a
    // device measurement. init() clamps it DOWN to what the driver admits (a
    // real box's Vulkan driver caps 2D images at 4096) and nothing raises it.
    //
    // The web surface used to hand in its own GL_MAX_TEXTURE_SIZE, so a
    // hardware-GL browser ran the layer at 16384. Halving that halves every
    // place the width is spent, per-frame included: ~5.3 MiB of GPU and as much
    // CPU, half the race-restart re-upload, and — because a stamp's texel span
    // along s scales with texW — half the area rasterSkidTri fills, half the
    // bytes each dirty rect uploads, half of what refreshSkidMips walks.
    //
    // What it costs is anisotropy, and the grid was NEVER isotropic: lat is
    // ~80 texels/u while s at 8192 runs ~18-25 over the shipped tracks, so the
    // s-axis texel footprint exactly doubles and ~2x anisotropic becomes ~4x.
    // (Isotropy would want a lap under ~205 u; the shortest shipped one is
    // 335.) The angle-aware feather in the stamp block absorbs it — it sizes
    // its ramp from mSkidTexelS per scene, so a diagonal mark gets SOFTER
    // rather than blockier.
    uint32_t mMaxTextureDim = 8192;
    bool mSkidWipe = false;    // clear the layer on the next stamp pass (race restart)
    // The layer's mip refresh (see the stamp block): stamps land in mip 0; the
    // chain regenerates at most ~7 Hz so minified marks stop scintillating
    // without a per-frame megatexel pass. PER-SCENE, like mSkidWipe — mSkidMipsAt
    // is on the mTime clock, which restarts at 0 with every scene build.
    bool mSkidMipsDirty = false;
    float mSkidMipsAt = 0;
    // The shape the pass stamps, PER MODEL: the rounded rect fitted to the
    // car's own top-down outline (ttp/car_footprint.h), rasterized on the CPU
    // from the same GLB bytes the merged draw groups already decode.
    //
    // It is a fact about the KIT, not about this race, so it is keyed by the
    // model and survives releaseScene: the field is eight cars over four
    // models, and a re-dress into a model someone else drives costs nothing.
    //
    // **THE AABB CANNOT DO THIS JOB.** All four roster cars measure x ±0.26 to
    // ±0.28 by z ±0.438, so a shape sized off the bounding box is the SAME
    // shape for every one of them. The outline inside the box is the only
    // thing that differs, and the fit is what carries it.
    std::unordered_map<uint64_t, ttp::rt::RoundedFit> mCarShadowFits;
    std::vector<uint64_t> mCarShadowMaskOfSlot;  // slot -> model key (0 = none)
    // The resolution the outline is rasterized at for the fit. Every fitted
    // rect is measured at it, so changing it changes every car's shadow.
    static constexpr int kCarShadowMaskW = 64, kCarShadowMaskH = 128;
    // Capture one model's outline out of its GLB bytes + the asset's node
    // transforms, rasterize it and fit it. **THE ASSET MUST BE AT ITS PARSE
    // POSE** — call this only from the load path, never once a frame has posed
    // the car: a posed car's world transform puts it hundreds of units from
    // the mask's frame, which rasterizes to nothing (the law `mBodyRest`
    // exists for one level up). Answers false when the model could not be
    // read, which leaves that car on the default fit rather than on a blank
    // stamp.
    bool bakeCarFootprint(uint64_t key, const std::vector<uint8_t>& glb,
            filament::gltfio::FilamentAsset* asset,
            const filament::math::float3& bbMin, const filament::math::float3& bbMax);
    // Which fit slot `i` stamps — its model's, or the default. The raster
    // evaluates one expression whatever is in it, so a fit to this model costs
    // exactly what a generic one costs.
    ttp::rt::RoundedFit carShadowFitFor(size_t slot) const;
    // A car wearing the MONSTER keeps its own shape; the stamp scales by
    // these two factors instead. Deriving the size from the truck's AABB (and
    // its own fitted outline) read too big; a single 1.2 both ways read too
    // narrow at the wheels AND too long — because the truck's MEASURED
    // footprint (GLB node-transformed AABBs) is only ~1.14x the cars' width
    // and exactly their length. Width carries margin on top of that ratio
    // because the fit's corner rounding and the soft band's half-alpha edge
    // both sit inside the geometric box, right where the corner wheels are.
    // Both are at the rig's AUTHORED size, so they ride its rigScale too.
    static constexpr float kMonsterShadowScaleW = 1.35f;
    static constexpr float kMonsterShadowScaleL = 1.05f;
    // THE CAR SHADOW AS A PASS (vshadow.mat): ONE blended primitive for every
    // car over the road's own triangles under each, the fitted rounded rect
    // sampled from an atlas tile locked to the car's frame. Built with the
    // road (buildCarShadowDraws), handed its geometry every frame
    // (placeCarShadow per car, flushCarShadows once), empty (count 0) between.
    // One draw rather than one per car: on the Android GL fallback every draw
    // and every instance's uniform write is backend-thread CPU, and the car's
    // frame is per-vertex data the clip already computes.
    static constexpr size_t kCarShadowSlots = 8;
    // Ring cells a stamp may span, each way, on the longest car at the widest
    // yaw; the vertex and index caps are for the clipped polygons of all
    // slots together.
    static constexpr int kCarShadowRings = 12;
    static constexpr size_t kCarShadowVtxCap = kCarShadowSlots * 512;
    static constexpr size_t kCarShadowIdxCap = kCarShadowSlots * 1024;
    // ONE renderable and ONE primitive, over a vertex and an index buffer
    // filled by placeCarShadow per car and uploaded by flushCarShadows each
    // frame: per car, the road's OWN
    // triangles under the stamp's box, CLIPPED to it. For every ring cell the
    // box spans and every deck strip it touches, the cell's two triangles are
    // clipped in (t, lat) to the box and each clipped corner is mapped through
    // that triangle's affine map, so every vertex lies on a plane the road
    // itself rasterizes and the depth test ties everywhere. The two earlier
    // shapes failed on depth: the road's whole cells were half a lane wide
    // (a millisecond more than the layer), and a ruled strip between ring
    // lines sat behind the road's chord where the deck twists, so a banked
    // stretch had no shadow and its ends flickered (the frame map, 2026-10-14).
    utils::Entity mCarShadowEntity;
    filament::MaterialInstance* mCarShadowMi = nullptr;   // a scene instance
    // Which arm the instance's fill and ink were last set for
    // (TTP_DEBUG_SHADOW_SOLID), so a frame writes them only on a change;
    // -1 is neither, a fresh instance.
    int mCarShadowSolidBound = -1;
    // The buffers are a RING of mCellRing pairs (the streak ring's rule;
    // buildCarShadowDraws has the why), and flushCarShadows advances the slot
    // once per upload.
    std::vector<filament::VertexBuffer*> mCarShadowVbRing;
    std::vector<filament::IndexBuffer*> mCarShadowIbRing;
    uint32_t mCarShadowRingAt = 0;
    std::vector<filament::math::float3> mCarShadowPos;     // this frame's rows
    std::vector<filament::math::half4> mCarShadowC0;        // ...and their baked light
    std::vector<filament::math::float4> mCarShadowUv;       // ...atlas (u, v), peak alpha
    std::vector<uint32_t> mCarShadowIdx;
    // The deck's baked light per RING (the mean of the ring's deck vertices'
    // custom0), so a stamp row lights as the deck under it does.
    std::vector<filament::math::half4> mRingLight;
    void flushCarShadows();
    // The stamps, one per car MODEL (the fit's key), each a tile of ONE
    // atlas, baked on first use and kept for the run like the parsed-kit
    // cache. `support` is the stamp-local (u0, u1, v0, v1) box outside which
    // the baked field is zero: placeCarShadow clips the geometry to it, so no
    // fragment is drawn where the stamp has nothing to draw, and no sample
    // leaves the tile. `tile` is the tile's atlas origin.
    struct CarShadowStamp { filament::math::float4 support{}; filament::math::float2 tile{}; };
    std::unordered_map<uint64_t, CarShadowStamp> mCarShadowStamps;
    // kCarShadowAtlasTiles x kCarShadowAtlasTiles tiles of 128 texels. The
    // tiles sit on power-of-two offsets, so the mip chain never mixes two of
    // them; it stops at 8-texel tiles, where a bilinear tap at a support's
    // edge still reads its own tile's empty margin.
    static constexpr uint32_t kCarShadowStampTexels = 128;
    static constexpr uint32_t kCarShadowAtlasTiles = 4;
    static constexpr uint32_t kCarShadowAtlasLevels = 5;
    filament::Texture* mCarShadowAtlas = nullptr;   // renderer-lifetime
    const CarShadowStamp* carShadowStamp(uint64_t key, const ttp::rt::RoundedFit& fit);
    filament::Material* mShadowMaterial = nullptr;   // renderer-lifetime
    void buildCarShadowDraws();
    void hideCarShadowDraws();
    void placeCarShadow(size_t slot, const filament::math::float3& origin,
            const filament::math::float3& fwd, const filament::math::float3& right,
            float halfF, float halfR, float carS, float alpha,
            const ttp::rt::RoundedFit& fit);
    struct WheelTrail {
        filament::math::float2 last{}, dir{}, edgeL{}, edgeR{}; // all (s, lat)
        bool hasEdge = false, seeded = false;
        int projHint = -1;     // project()'s warm start
    };
    std::vector<WheelTrail> mWheelTrails; // carCount × 4 (fl fr bl br)
    // The contact shadow's constants (CarShadowTuning says why each is what it
    // is).
    const CarShadowTuning mShadowTune{};
    // mShadowTune.ink decoded once, so the per-frame writer pays no sRGB
    // decode — three pow() calls each.
    filament::math::float3 mShadowInkLinear{ 0.00967f, 0.00787f, 0.00615f };
    Mesh mGantry; // procedural start/finish gantry (FinishGate.js port)
    // The sea ring + its wet-sand glaze (theme.water), fitted to the track's
    // own shoreline.
    Mesh mWater, mWet;
    // Fliers (theme.birds / kites / paperPlane): billboard glyphs built as real
    // stroked geometry (the JS canvas sprites), plus the playroom's 3D dart.
    std::vector<Mesh> mBirds;
    std::vector<Mesh> mKites;
    Mesh mPlane;
    // Drifting cloud puffs: one billboarded support octagon each (puffPoly),
    // shaped by vcloud.mat.
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
    // The track's set pieces (set<i>.glb): composed landmarks the TRACK places
    // (buildSetPieces), merged and baked with the props. mSetFeet is what each
    // one covers on the ground — an oriented rectangle, because a fort is
    // twenty units across and three deep, and a circle round it would clear a
    // whole verge — which every later placement pass keeps out of.
    std::vector<filament::gltfio::FilamentAsset*> mSetAssets;
    std::vector<std::vector<filament::gltfio::FilamentInstance*>> mSetInstances;
    struct SetFoot { float x, z, ax, az, hx, hz, top; };  // centre, +X axis, half extents, world top
    std::vector<SetFoot> mSetFeet;
    bool inSetFoot(float x, float z, float margin) const;
    // The chase camera's view up the road, one segment every 2 u of the lap
    // (buildSightLines), and whether something standing at (x, z), plan
    // radius r, rising to `top`, would cut one — the scatter's keep-out on
    // the inside of bends.
    struct SightLine { filament::math::float3 a, b; };
    std::vector<SightLine> mSightLines;
    static constexpr float kSightAhead = 18.0f;
    void buildSightLines(const TrackBin& tb);
    bool blocksRoadAhead(float x, float z, float r, float top) const;
    std::string mSetLayout = kNoSetLayout;
    std::string mScatterLayout = "[]";
    // The grass BERMS under raised deck reach a few units past the kerb, and
    // the scatters ground a piece on the terrain beneath them, so one standing
    // on a berm's flank is half inside it. inBerm is that keep-out; bermEdge
    // is how far out the berm beside a centreline point reaches (0 = none).
    bool inBerm(const TrackBin& tb, float x, float z, float margin) const;
    float bermEdge(const TrackBin& tb, float x, float z) const;
    // The berms' own surface height at (x, z), read off the strips
    // buildStructures stitches between consecutive rings; -1e30 off every berm.
    float bermY(const TrackBin& tb, float x, float z) const;
    // The "spin" node of every placed prop that has one — turned about its own
    // origin each frame (buildProps). The toy train's rails are its only user.
    std::vector<utils::Entity> mPropSpins;
    // THE SET PIECES' MOVING PARTS (TtpRendererMotion.cpp; the `anim_` grammar
    // is ttp/set_motion.h's). Each part is ONE unlit mesh baked in its node's
    // own frame, its light frozen at the rest pose, drawn through a
    // MergedGroup in mMergedDress (so teardown, the feature tags and the GL
    // priorities are the baked runs'), and posed each frame by one transform:
    // rest * the verbs' closed form of the scene clock and the cars.
    struct SetMover {
        utils::Entity ent;                  // the baked mesh's renderable
        filament::math::mat4f rest;         // the node's world transform at rest
        filament::math::mat3f restInv;      // its rotation's inverse, scale removed
        float scale = 1;                    // its uniform world scale
        float phase = 0;
        int path = -1;                      // into mSetPaths
        int parent = -1;                    // the mover it rides, built before it
        filament::math::mat4f onParent;     // its rest in the parent's rest frame
        ttp::rt::SetMotion motion;
    };
    struct SetPath {                        // a closed polyline in world space
        std::vector<filament::math::float3> pts;
        std::vector<float> at;              // arclength at each point; at.back() = the loop
    };
    std::vector<SetMover> mSetMovers;
    std::vector<SetPath> mSetPaths;
    std::vector<ttp::rt::SetMotionCar> mSetMotionCars;   // per-frame scratch
    std::vector<filament::math::mat4f> mSetMoverNow;      // per-frame: each mover's world
    // The outermost `anim_` node over `ent` in a set piece (the nearest with
    // `outermost` false), or null.
    utils::Entity setAnimRoot(const filament::gltfio::FilamentAsset* asset,
            utils::Entity ent, bool outermost = true) const;
    void keepTravellersOutOfBake(const filament::gltfio::FilamentAsset* asset,
            filament::gltfio::FilamentInstance* inst);
    void buildSetMovers();
    void stepSetMovers(const std::vector<filament::math::float3>& carPosW);
    // The smoke puffs over a chimney at `origin` (a set piece's `anim_smoke`,
    // or the procedural cabin's).
    void buildSmokePuffs(const filament::math::float3& origin);
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
    // alone (see buildStatic). Inverted — max < min — when there is no
    // field, which is every build but the gallery's.
    float mKitFieldMinX = 0, mKitFieldMaxX = -1, mKitFieldMinZ = 0, mKitFieldMaxZ = -1;

    filament::math::mat4f mWindmillBase{};
    // Baked lawn shadows: soft ink blobs under trees/pylons/landmarks — the
    // stand-in for the JS shadow map's casters landing on grass.
    std::vector<filament::math::float4> mShadowSpots; // x, z, radius, height (0: no disc)
    Mesh mGroundShadows;
    Mesh mClutter;   // near-field flowers (rand2 stream)
    Mesh mBalloon;   // hot-air balloon (theme.balloon — grass/sunset hero)
    float mBalloonY = 44, mBalloonSize = 6; // theme.balloon orbit height + scale
    float mBalloonExt = 0; // the unit mesh's reach from its origin (read at build)
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
    static constexpr const char* kMonsterGlb = "vehicle-monster-truck.glb";
    static constexpr const char* kMonsterGhostGlb = "monster-ghost.glb";
    filament::gltfio::FilamentAsset* mMonsterAsset = nullptr;
    std::vector<filament::gltfio::FilamentInstance*> mMonsterInstances;
    filament::gltfio::FilamentAsset* mMonsterGhostAsset = nullptr; // 50%-alpha fade variant
    std::vector<filament::gltfio::FilamentInstance*> mMonsterGhostInstances;
    // The chassis recolour's duplicates (recolourMonsterChassis): owned by the
    // monster pools, so releaseMonsterPools frees them — on the scene's list they
    // piled up per rebuild.
    std::vector<filament::MaterialInstance*> mMonsterMatInstances;
    // The car count the monster pools were built for; -1 = build them again
    // (none yet, a monster GLB re-provided). Nothing else they are made of
    // varies, so a new scene keeps them.
    int mMonsterPoolCars = -1;
    // The same for the boost streaks, which a new scene also drops: their
    // vertices carry its boost colour. -1 likewise after a build that failed.
    int mStreakPoolCars = -1;
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
    // Half the rig's length as authored. The rig is DRAWN at the length of the
    // footprint the frame hands it (TtpCarInput::halfLen, the sim's
    // MONSTER_HALF_LEN), so the truck is exactly as big as what it hits.
    // Everything above is measured at the authored size and scales by
    // CarWheels::rigScale where it is used.
    float mMonsterHalfLen = 0;
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
    // camera per frame, so after the build the CPU touches this mesh only
    // when the cell count changes (renderAmbient re-fits the draw range, the
    // box and `lite`); otherwise the per-frame work is the `time` and
    // `halfSize` uniforms.
    Mesh mPollen;
    float mAmbSize = 0.15f; // half the authored sprite size; re-fitted per frame
    uint32_t mAmbCells = 0; // the cell count the draw range, box and lite were fitted to
    // This frame's sprite halfSize and `time`, exactly as renderAmbient set
    // the uniforms: the per-cell cull replays the shader's motion with them.
    float mAmbHalfSize = 0;
    float mAmbTime = 0;
    float mAmbBandH = 0;        // the `bandH` uniform, set once at build
    float mAmbFall = 0, mAmbWind = 0;   // the `fall` and `wind` uniforms, set at build
    // Per-cell subset of the cloud: each cell draws only the sprites that can
    // reach ITS frustum, as indices into the same vertex buffer in ascending
    // order (cullAmbientCells). One index buffer per ring slot, written once a
    // frame; each slot's (vb, ib) pair is pinned by a parked renderable that is
    // in no scene, so the per-cell setGeometryAt never drops the factory's last
    // reference and rebuilds the hardware primitive.
    std::vector<filament::IndexBuffer*> mAmbCullIbs;
    std::vector<utils::Entity> mAmbCullHolds;
    std::vector<uint32_t> mAmbCellOff, mAmbCellCnt;
    uint32_t mAmbCullCap = 0;   // indices each slot buffer holds
    uint32_t mAmbCullFrames = 0;
    bool mAmbSubset = false;    // the renderable is on a subset range right now
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
    filament::math::float3 mLastCar0{}; // reset/teleport detector: first...
    filament::math::float3 mLastCarN{}; // ...and last car — both must jump
    utils::Entity mSun;
    filament::IndirectLight* mAmbient = nullptr;

    double mProfile[kProfCount] = {};
    double mGpuMs = 0.0;
    bool mAntialias = true;
    uint32_t mWidth = 0;
    uint32_t mHeight = 0;
    filament::math::float3 mFogColor = { 0, 0, 0 }; // linear; set at scene build

    std::unordered_map<std::string, std::vector<uint8_t>> mAssets;
    // What each held asset's bytes are a function of, in the caller's own
    // vocabulary — see AssetWant. Same lifetime as mAssets by construction,
    // which is the point of keeping it here rather than in a shell.
    std::unordered_map<std::string, std::string> mAssetTag;
    // …and what the last assetPlan said each name WOULD be a function of, so the
    // provideAsset that answers it can stamp the tag without a second crossing.
    std::unordered_map<std::string, std::string> mAssetWantTag;
    // A model's images[].uri list, by ASSET NAME. The texture step needs it and
    // used to get it by re-scanning a container the shell had just read — which
    // is exactly the read the plan above exists to skip.
    //
    // BY NAME AND NOT BY CONTENT HASH, which the first version did: hashing is
    // a byte-at-a-time FNV over the whole buffer, so consulting the cache
    // re-read every model it was there to avoid re-reading. That is ~1.2 MB
    // a build in play and tens of megabytes in the gallery's kit field. The name
    // is exact because provideAsset is the only place an asset's bytes change,
    // and it drops the entry.
    std::unordered_map<std::string, std::vector<std::string>> mAssetUriCache;
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
    // Merge the vertices equal in position and colour, keeping each one's
    // first slot and the triangle order. For a mesh that carries nothing else.
    static void weldExact(Mesh& m);
    // A kit prim with its bitwise-equal (position, normal, uv) vertices made
    // one; `reorder` reorders over the unwelded corners first
    // (TtpRenderer.cpp has why).
    static ttp::rt::GlbMeshPrim weldPrimExact(const ttp::rt::GlbMeshPrim& p, bool reorder);
    // One range's simplified far form, appended to m.idx (buildMesh's own).
    // `scale` is meshopt's for the whole vertex set; `lockBorder` keeps a
    // range's open edges where a neighbouring range shares them.
    static LodRange farForm(Mesh& m, size_t idx0, size_t idxN, float scale, bool lockBorder);
    // An empty VertexBuffer in `layout` (see Mesh::Layout); buildMesh's own.
    filament::VertexBuffer* buildVertexBuffer(uint32_t vertexCount, const Mesh::Layout& layout);
    void destroyMesh(Mesh& m);
    // The bake's exponential shadow map and the two numbers its decode needs.
    // A LOCAL of bakeShadowMap, handed to the passes that read it and destroyed
    // when they are done — nothing samples it in a frame.
    struct SunEsm {
        filament::Texture* map = nullptr;
        float texel = 0;        // world units per ESM texel (the slope bias)
        float depthScale = 0;   // normalised depth per world unit
    };
    // Bake the deck's sun visibility into mRoadVisMap (vroadvis.mat), in track
    // space. A no-op without a built road, which leaves the map null and the
    // tap answering fully lit.
    void bakeRoadVis(const TrackBin& tb, const SunEsm& esm);
    // The visibility bakes' one shape: draw `draws` with `mi` through `cam` into
    // a fresh w×h R8 target cleared to 1 (fully lit), DEPTH-TESTED when asked.
    // Records and returns without a wait; null if the target cannot be made.
    struct BakeDraw {
        filament::VertexBuffer* vb;
        filament::IndexBuffer* ib;
        size_t count;
    };
    filament::Texture* bakeR8(filament::MaterialInstance* mi, filament::Camera* cam,
            uint32_t w, uint32_t h, const std::vector<BakeDraw>& draws, bool depthTested);
    // Bind mRoadVisMap (or the 1×1 stand-in) to one road material instance.
    void bindRoadVisMap(filament::MaterialInstance* mi);
    // vroad's sunVis lat scale, and its own "no map" signal — 0 means the
    // shader takes no tap at all. ONE derivation: the feature ablation sets the
    // same parameter, and a second spelling would drift from the binder.
    float roadVisLatSpan() const {
        return (mRoadVisMap && mRoadVisLatHalf > 0.0f) ? 0.5f / mRoadVisLatHalf : 0.0f;
    }

    // Finish any staged blob whose reads have all landed, and retire the
    // textures they were reading from. Called from the frame beat on every
    // backend — staging never waits on the GPU (ttp_display.h, "derived bytes").
    // A no-op on any frame with nothing staged, which is almost all of them.
    void collectStagedBlobs();

    // ---- staged blobs ------------------------------------------------------
    //
    // A texture readback that a blob is waiting on. It lands on a later frame
    // beat on every backend, never inside the build that issued it
    // (ttp_display.h's "derived bytes" section has why).
    //
    // ONE READ IS OWNED BY ONE STAGED BLOB, so retiring a blob retires exactly
    // its reads. A pool keyed by texture cannot say that: a texture a later bake
    // reallocated matches nothing, and its read is never retired — a buffer and
    // a RenderTarget over freed storage held for the life of the page.
    struct StagedRead {
        filament::Texture* tex = nullptr;       // null: an absent map, w = h = 0
        uint32_t w = 0, h = 0;                  // snapshotted: `tex` may be gone by now
        std::vector<uint8_t> px;
        std::atomic<bool> done{ false };
        filament::RenderTarget* rt = nullptr;   // outlives the issue; freed on finish
    };

    // Derived bytes whose metadata is already snapshotted and whose pixels are
    // still coming. See the public stageBlob for the whole argument.
    struct StagedBlob {
        std::string key;
        bool flip = false;                      // the writer's GL row flip, latched here
        std::vector<uint8_t> head;              // everything before the first read's pixels
        std::vector<std::unique_ptr<StagedRead>> reads;
        std::vector<uint8_t> bytes;             // the finished blob; empty until it is
        bool finished = false;
    };
    std::vector<std::unique_ptr<StagedBlob>> mStaged;

    // Issue one R8 read into a staged blob.
    bool issueRead(StagedBlob& blob, filament::Texture* tex);
    // Splice landed pixels onto the snapshotted head, GL's row flip away
    // from the texture's own order.
    void finishBakeBlob(StagedBlob& blob);
    // Retire a staged blob's reads: free the RenderTargets, and LEAK the buffer
    // of any read that never landed. The driver may still hold a pointer into it
    // and there is no tick left that will fire the callback.
    void retireStaged(StagedBlob& blob);
    // Is a texture still the destination of an unfinished read?
    bool readInFlight(const filament::Texture* tex) const;
    // Textures a staged read is still writing into, kept alive past the bake that
    // replaced them. Destroying one under an outstanding readPixels is a write
    // into freed storage.
    std::vector<filament::Texture*> mTexGraves;
    // Destroy any grave nothing is reading from any more.
    void drainTexGraves();
    // Swap the resident visibility maps, sending any the reads still need to the
    // graves instead of destroying them. Every path that replaces them goes
    // through here.
    void replaceVisMaps(filament::Texture* ground, filament::Texture* structures,
            filament::Texture* road);

    // The two halves of buildScene and releaseScene (see buildScene). The
    // static build leaves its TrackBin in mTrack for the field to read.
    bool buildStatic(const std::string& key, const ttp::RaceTrack& geo,
            const ttp::rt::Theme& theme, const ttp::rt::WearPlan& wear);
    bool buildField(const std::vector<TtpRosterCar>& roster);
    void releaseStatic();
    // What a race leaves on the static scene — rubber, kicked cones, collected
    // boxes, live bursts — back to its opening state. Not the car shadows:
    // every frame places them afresh (hideCarShadowDraws, then placeCarShadow).
    void resetRace();
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
    bool loadCarAsset(uint32_t index, const std::string& name, const std::vector<uint8_t>& glb);
    // One car slot's scene pieces, shared verbatim between buildField and
    // reroster(). Each reads the roster fields off mTrack and assumes the
    // per-car containers are already sized to the field.
    bool buildCarSlot(uint32_t c);   // GLB via loadCarAsset, else box marker
    void buildCarGhost(uint32_t c);                      // 50%-alpha occlusion twin (+ decode pump)
    void destroyCarSlot(uint32_t c);                     // the inverse of the two above
    void dropAsset(filament::gltfio::FilamentAsset*& a);
    // Attach finished texture decodes: the async queue only binds on a pump, so
    // every batch of loads ends with one (see the note in buildStatic).
    void pumpTextures();
    void ensureAssetLoader();
    void registerAssetUris(filament::gltfio::FilamentAsset* asset);
    // shareMaterials true points every copy at instance 0's materials and frees
    // each copy's own set, so a copy's getMaterialInstances() is EMPTY: read a
    // copy's materials through rcm.getMaterialInstanceAt.
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
        std::vector<uint32_t> colors;   // vglbflat's required COLOR (never read)
        std::vector<uint32_t> idx;
    };
    struct MergedGroup {
        utils::Entity ent;
        std::vector<MergedPrim> prims;
        filament::InstanceBuffer* ibuf = nullptr;
        // THE BAKED FORM, for a STATIC group whose model the kit colour table
        // knows (generated/kit_colors.h): the copies expanded into one
        // world-space mesh with base colour x matte light folded per vertex,
        // drawn unlit — no instance buffer, no tangents, no texture, no
        // shading. `ent` is this mesh's entity and `prims`/`ibuf` stay empty.
        // Expanded rather than instanced because the light depends on each
        // copy's own rotation. bakeMergedRun builds it.
        Mesh baked;
        std::vector<utils::Entity> sources;      // one gltfio node per instance
        std::vector<filament::math::mat4f> xf;   // mirror scratch
        float radius = 0;                        // mesh-local bound, world AABB
        bool dynamic = false;                    // mirror world transforms per frame
        uint8_t feat = 0;                        // kFeat* bit for tagFeatures
    };
    std::vector<MergedGroup> mMergedCars;   // rebuilt whenever the roster moves
    std::vector<MergedGroup> mMergedDress;  // built once per scene's dressing
    // THE DRESSING ABLATION, in two halves because the group's cost is in two
    // halves and no layer bit is left to split it with (kFeat* fills the byte).
    // mDressKeep is the fraction of each merged group's COPIES that is kept;
    // mDressSheets is whether the one-renderable SHEETS are in the scene.
    float mDressKeep = 1.0f;
    bool mDressSheets = true;
    bool mCarMergeDirty = false;
    bool mDressMergeDirty = false;
    bool mMergeOff = false;                 // kFeatNoMerge (ablation only)
    std::vector<uint64_t> mCarModelKey;     // per slot: FNV of its GLB bytes
    std::vector<uint64_t> mCarGhostKey;     // …and of its ghost twin's, for the pool

    // PARSED BODIES, KEPT BY MODEL — the same argument the sun bake and the
    // shadow fits already won, one level up. gltfio parsing a GLB and
    // uploading its buffers is the biggest recurring phase of a build (`cars`
    // in the phase log), and releaseScene used to destroy every one of them
    // while the shadow fits keyed off those same bytes survived. The field is
    // usually unchanged across a build: a Grand Prix is four races on one grid,
    // and the lobby rebuilds on every join, pick and launch.
    //
    // KEYED BY THE BYTES, NEVER BY THE SLOT. `glbKey` is the model
    // identity everything per-model here uses; keying by slot is the exact bug
    // that once dropped a car's shadow to a generic shape when the next race
    // moved it.
    // A vector per key, because two slots wearing one model need two ASSETS —
    // each carries its own entities and transforms.
    //
    // Safe to reuse without re-dressing, and that is reroster's finding rather
    // than an assumption: a livery change touches no GLB at all ("the GLB body
    // keeps its own paint"), so a body is a pure function of its model bytes.
    std::unordered_map<uint64_t, std::vector<filament::gltfio::FilamentAsset*>> mBodyPool;

    // How many parked bodies to hold. Eight slots over four car models plus the
    // ghosts, so this covers a full grid twice over; a cache with no cap is a
    // leak (libttp-runtime/ttp/blobstore.h makes the same point about disk), and
    // GPU memory has no eviction signal to derive one from.
    static constexpr size_t kBodyPoolMax = 24;
    size_t mBodyPoolCount = 0;

    // Park a parsed body for reuse instead of destroying it, or destroy it when
    // the pool is full. Takes the pointer by reference and nulls it, like
    // dropAsset, so no caller can keep a handle to something it gave away.
    void parkAsset(uint64_t key, filament::gltfio::FilamentAsset*& a);
    // …and back, at its parse pose (mBodyRest): null when nothing is parked for
    // this model.
    filament::gltfio::FilamentAsset* takeAsset(uint64_t key);
    // Destroy everything parked. Teardown only — a scene release PARKS.
    void drainBodyPool();

    // THE POSE A FRESH PARSE WOULD HAVE HANDED OVER: every node's own local
    // transform, snapshotted before any frame has touched the asset and put back
    // by takeAsset. Parking restores nothing (see parkAsset), so a parked body
    // still wears the last frame's pose — the root, the four wheels' steer, roll
    // and suspension, the axle, a monster's collapsed tyres — while loadCarAsset
    // measures the seats it fills CarWheels with on the stated assumption that
    // those nodes are at rest. Reusing without this fed each rebuild's
    // measurement the previous one's pose, and the drift compounded across races
    // until a corner's wheel visibly left the road.
    //
    // Keyed by the ASSET rather than by the model, so nothing here rests on two
    // parses of the same bytes numbering their entities alike.
    struct RestPose {
        std::vector<filament::math::mat4f> nodes;  // parallel to getEntities()
        filament::math::mat4f root;                // gltfio's own, not in there
    };
    std::unordered_map<const filament::gltfio::FilamentAsset*, RestPose> mBodyRest;
    void snapshotRestPose(filament::gltfio::FilamentAsset* a);
    void restoreRestPose(filament::gltfio::FilamentAsset* a);
    // Parsed kit geometry, keyed by the bytes' FNV. Engine-lifetime — the kit's
    // bytes never change, so a cup's four scenes parse each model once.
    std::unordered_map<uint64_t, std::vector<ttp::rt::GlbMeshNode>> mGlbMeshCache;
    // The welded form of each flat prim drawn with vglbflat, keyed by the
    // prim's address in mGlbMeshCache (whose entries are never erased, so the
    // address is the prim's identity). The weld is quadratic in triangles, so
    // it is paid once per model, not per roster rebuild.
    std::unordered_map<const ttp::rt::GlbMeshPrim*, ttp::rt::FlatWeld> mFlatWelds;
    // Which parse an instanced dressing asset was loaded from (scene scope).
    std::unordered_map<const filament::gltfio::FilamentAsset*, uint64_t> mAssetMeshKey;
    // The model identity of asset `name` (whose bytes are `glb`), memoised
    // by name for the same reason mAssetUriCache is.
    uint64_t glbKey(const std::string& name, const std::vector<uint8_t>& glb);
    std::unordered_map<std::string, uint64_t> mGlbKeyOf;
    const std::vector<ttp::rt::GlbMeshNode>* glbMeshes(uint64_t key,
            const std::vector<uint8_t>& glb);
    bool buildMergedGroup(std::vector<MergedGroup>& out,
            const std::vector<utils::Entity>& sources,
            const std::vector<ttp::rt::GlbMeshPrim>& prims, bool dynamic,
            uint8_t feat, const ttp::kitcolors::Mesh* colors = nullptr);
    bool bakeMergedRun(MergedGroup& g, const std::vector<ttp::rt::GlbMeshPrim>& prims,
            const ttp::kitcolors::Mesh& colors,
            utils::Entity src0);
    bool bakeFactors(utils::Entity src, const std::vector<ttp::rt::GlbMeshPrim>& prims,
            const ttp::kitcolors::Mesh& colors, std::vector<filament::math::float3>& factor);
    void appendBaked(Mesh& m, const filament::math::mat4f& xf,
            const std::vector<ttp::rt::GlbMeshPrim>& prims,
            const ttp::kitcolors::Mesh& colors,
            const std::vector<filament::math::float3>& factor);
    // A set piece's still parts, one baked mesh per PLACEMENT (the Dressing.cpp
    // comment): `still` is each (entity slot, parsed mesh) that stands still.
    bool bakePlacements(const std::vector<filament::gltfio::FilamentInstance*>& insts,
            const std::vector<ttp::rt::GlbMeshNode>& nodes,
            const ttp::kitcolors::Model& colors,
            const std::vector<std::pair<size_t, int>>& still);
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
    void buildRoomRing(const TrackBin& tb, float sf);
    void kitFieldApron(Mesh& ground, float groundY, float tile, uint32_t col) const;
    void buildProps(const TrackBin& tb);
    void buildLandmarks(const TrackBin& tb);
    void buildSetPieces(const TrackBin& tb);
    void buildClutter(const TrackBin& tb);
    void buildStructures(const TrackBin& tb);
    void setMeshShadows(Mesh& m, bool cast, bool receive);
    // Render the static track's depth from the sun ONCE per static scene and
    // decode it into the receivers' visibility maps. Filament re-renders its own
    // shadow map per VIEW per frame, which a 4-way split pays four times over.
    void bakeShadowMap(const TrackBin& tb, const std::string& key);
    // The matte light rig's NUMBERS — sun colour/lux and the hemisphere's
    // 2-band SH, UNEXPOSED — one derivation for the scene's lights and the
    // baked vertex light (mBakeRig), so the two cannot drift.
    struct MatteRig {
        filament::math::float3 sunColor;
        float sunLux;
        filament::math::float3 sh0, sh1;
        float hemiLux;
    };
    MatteRig matteRig(const TrackBin& tb) const;
    // The matte light a static sheet's vertices are folded with at build
    // (Mesh::bakeLight): the CPU twin of ttpMatteAmbient + ttpMatteSunTerm at
    // visibility 1, pre-exposed
    // exactly as the shader's frame uniforms are. buildStatic sets it
    // before the first sheet is built. bakeVertexLight is the same twin for the
    // shadow RECEIVERS, which keep their light in CUSTOM0 because their sun term
    // is multiplied by a visibility tap at draw; a sheet receives no shadow, so
    // the whole product can be stored in its colour.
    struct BakeRig {
        filament::math::float3 sunPre{ 0 }, sh0{ 0 }, sh1{ 0 };
        float hemiPre = 0.0f;
        bool valid = false;
    };
    BakeRig mBakeRig;
    filament::math::float4 matteTerms(const filament::math::float3& n) const;
    filament::math::float3 bakedMatteLight(const filament::math::float3& n) const;
    // A shadow receiver's smooth light — ttpMatteAmbient and the sun term, the
    // CPU twin of ttp_shade.inc — into m.custom0 (ambient, and NoL in .w for
    // the bakes) and m.custom1 (ambient + sun), both display-encoded
    // (displayLight), one per vertex, from m.normals. Visibility is not in it:
    // that is a baked map's tap.
    void bakeVertexLight(Mesh& m) const;
    // Hand the ESM + its world→light matrix to one of the bake's instances.
    void bindShadowMap(filament::MaterialInstance* mi, const SunEsm& esm);
    // Hand a visibility map (or the white stand-in) + the matrix to a receiver.
    void bindVisMap(filament::MaterialInstance* mi, filament::Texture* map);
    filament::MaterialInstance* staticInstance();
    // The fog colour to give Filament, pre-graded — see the definition for why
    // the grade cannot stay in the shader for this one.
    filament::math::float3 fogColorGraded(const filament::Camera* cam) const;
    // The 1×1 white, made on first ask. Three callers want one for three
    // reasons: it neutralises a glTF base-colour map, it stands in for the sun
    // map on a track that baked none, and it fills vglb's base-colour sampler
    // for a glTF material that carries no texture at all.
    filament::Texture* whiteTexture();
    // The deck's instance of mRoadMaterial; null when the road material is
    // absent.
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
    // The lap-wrap fold both deck channels share — see the definition. Fills
    // `out` in list order up to `cap`, so an overflowing chunk keeps the head.
    static int foldToChunk(const std::vector<DeckDecal>& src, float mid,
            float halfSpan, float L, DeckDecal* out, int cap);
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
    void setDressKeep(float frac);
    void setDressSheets(bool on);
    void applyDressSheets();
    void forEachDressSheet(const std::function<void(const Mesh&)>& fn) const;
    // DEBUG: the STATIC dressing still drawing live-lit after the merge — per
    // model, how many draws missed the bake. Every way a model falls off the
    // baked path (an undecodable GLB, ambiguous node names, a colour table
    // that disagrees with the geometry) is silent on the glass and costs
    // vertex shading in every cell, so the scene budget gate reads this.
    // What moves (a spin subtree, the cone pool) is not counted. A set piece's
    // `anim_` part needs no exemption: its baked mover took it out of the scene
    // (buildSetMovers), so it is counted only when that bake failed, which is
    // exactly a part left standing live-lit.
    std::vector<std::pair<std::string, int>> debugLiveDressing() const;
    void debugWipeSkids() { mSkidWipe = true; }
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
    // A channel that rides a Filament VIEW GLOBAL instead of a material
    // parameter, because every material includes the .inc it lives in
    // (ttp_fog.inc). kFeatFogVertex is NOT a finer kFeatFog: that one moves
    // the fog's parameters and cannot reach ttpFogFactor's own maths.
    static constexpr uint32_t kFeatFogVertex = 0x8000;
    // TTP_DEBUG_NO_DECAL_* / DECAL_CAPS_HALF — kFeatRoadDecals decomposed
    // into its sub-arms, inverted like kFeatNoMerge (ttp_display.h's comment
    // has each arm's meaning). 0x10000 and 0x200000..0x800000 are HOLES left by
    // the deleted masked-shadow probes: never reuse them, the hand-typed masks
    // in docs/perf depend on every other bit staying put.
    static constexpr uint32_t kDebugNoDecalProfile = 0x20000;
    static constexpr uint32_t kDebugNoDecalBlob    = 0x40000;
    static constexpr uint32_t kDebugNoDecalStatics = 0x80000;
    static constexpr uint32_t kDebugDecalCapsHalf  = 0x100000;
    static constexpr uint32_t kDebugDecalAll = kDebugNoDecalProfile
            | kDebugNoDecalBlob | kDebugNoDecalStatics | kDebugDecalCapsHalf;
    void debugFeatureMask(uint32_t mask);
private:
    bool mHideCars = false;
    // Feature-ablation state (debugFeatureMask). mFeatureTagged latches the one
    // pass that moves every renderable off the default layer bit onto its
    // group's — until a caller asks, nothing here touches a shipped frame.
    uint8_t mFeatureMask = kFeatAll;
    uint32_t mRoadMask = kFeatRoadAll;
    uint32_t mDecalDebug = 0;
    bool mFogOn = true;
    // The ablation view-global, in the sense the shaders read it: ZERO is the
    // shipped picture, so a View nobody set renders correctly (ttp_fog.inc).
    filament::math::float4 mDebugGlobals{ 0.0f, 0.0f, 0.0f, 0.0f };
    void applyDebugGlobals(filament::View* v) const;
    bool mFeatureTagged = false;
    void tagFeatures();
    void tagEntities(const utils::Entity* e, size_t n, uint8_t bit);
    void tagMesh(const Mesh& m, uint8_t bit);
    void applyRoadDebug();
    // Frustum culling, on by default (buildMesh): opt OUT for meshes the
    // shader expands past their build-time bounds (the burst ring).
    void setMeshCulling(Mesh& m, bool enable);
    void setShadows(const utils::Entity* e, size_t n, bool cast, bool receive);
    // Add/remove from mScene, edge-triggered. The idiomatic way to hide
    // something in Filament: a parked transform still costs a prepare slot per
    // cell, scene membership costs a bitset bit. See the definitions.
    void setMeshInScene(Mesh& m, bool on);
    void setInstanceInScene(filament::gltfio::FilamentInstance* inst, uint8_t& state, bool on);
    void setAssetInScene(filament::gltfio::FilamentAsset* asset, uint8_t& state, bool on);
    void warmEffectPipelines(const TtpFrameInput& input);
    void buildOils(const TrackBin& tb);
    void ensureCells(uint32_t count);
};
