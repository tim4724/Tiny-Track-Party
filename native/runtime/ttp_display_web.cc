// ttp_display_web.cc — the WEB shell's half of the display runtime: the
// emscripten surface (the WebGL2 context on the target <canvas>), the TtpRenderer
// singleton, and the extern "C" ABI in ttp_display.h.
//
// Everything that names NO platform API — the cameras, the framing/fog solve and
// the per-frame TtpFrameInput assembled off the live Game — lives in
// libttp-runtime (native/libttp-runtime/ttp/) instead. That library compiles and
// is tested on every leg; this file needs a Filament SDK and a browser, so it
// compiles on one machine configuration and no ctest ever sees it. Keep the split
// that way: if a line here does not touch emscripten or TtpRenderer, it is in the
// wrong file.
//
// The tvOS and Android TV shells get siblings of this file (ttp_display_tvos.cc,
// ttp_display_android.cc) when those platforms land: same extern "C" surface,
// same ttp::rt::DisplayState, a CAMetalLayer* / ANativeWindow* where the WebGL
// context is here. They are not written yet, and an empty stub would only be a
// guess at APIs nobody has run.

#include "ttp_display.h"

#include <emscripten/emscripten.h>
#include <emscripten/html5_webgl.h>

#include <string>
#include <vector>

#include "TtpRenderer.h"
#include "ttp/frame_builder.h"
#include "ttp/framing.h"
#include "ttp/game.h"
#include "ttp/hud.h"
#include "ttp/race_track.h"
#include "ttp/roster.h"
#include "ttp/scalar_id.h"
#include "ttp/showcase.h"
#include "ttp/theme.h"
#include "ttp/trackbuilder.h"
#include "ttp_render.h"
#include "ttp_session.h"

using ttp::Game;
using ttp::ScalarId;
using ttp::rt::atRest;
using ttp::rt::parseIds;

// The ABI's camera modes and libttp-runtime's CamMode are two spellings of one
// set of values, and the static_asserts tying them together are deliberately NOT
// here: this file is added to the build only with -DFILAMENT_SDK, so an assert
// in it is compiled by no CI leg and catches a renumbered enum only on a dev box
// that happens to have the SDK. They live at the top of
// runtimetest/frame_check.cc instead, which every leg builds and ctests.

namespace {

// The platform half of the display, over the platform-free state the frame
// builder works on. Deriving rather than embedding keeps every field reading
// exactly as it did when the two halves were one file.
struct Display : ttp::rt::DisplayState {
    TtpRenderer* renderer = nullptr;
    EMSCRIPTEN_WEBGL_CONTEXT_HANDLE context = 0;
    bool built = false;
    // The asset gallery's showroom (ttp_display_showcase). Latched beside
    // `biome` because it is the same kind of thing: what the next build
    // RESOLVES, not what a frame draws.
    bool showcase = false;
};

Display* g_disp = nullptr;

// Ask the renderer for what only it can measure — the track's bounding box and
// the worst-case orbit distance over its centerline samples — and let
// libttp-runtime solve the rigs and fog bands from those numbers.
//
// The two-pass call is deliberate. maxOrbitDist is asked in terms of the orbit
// ring (ovRadius, ovHeight) that solveFraming itself derives from the box, so the
// first pass exists purely to read that ring out; only ovFogNear/ovFogFar depend
// on the answer, so nothing else is discarded. Cost: two dozen float ops, once
// per scene build.
void solveFraming(Display& d) {
    TtpTrackFraming tf;
    if (!d.renderer->trackFraming(tf)) { d.framing = ttp::rt::Framing(); return; }
    const ttp::rt::Framing ring = ttp::rt::solveFraming(tf, 0);
    d.framing = ttp::rt::solveFraming(tf, d.renderer->maxOrbitDist(ring.ovRadius, ring.ovHeight));
}

}  // namespace

extern "C" {

// ---------------------------------------------------------------------------
// Surface.
// ---------------------------------------------------------------------------
int ttp_display_create(const char* surface, uint32_t width, uint32_t height) {
    if (g_disp) return 1;

    EmscriptenWebGLContextAttributes attrs;
    emscripten_webgl_init_context_attributes(&attrs);
    // Mirror filament-js's canvas glue (web/filament-js/extensions.js).
    attrs.majorVersion = 2;
    attrs.minorVersion = 0;
    attrs.alpha = false;
    attrs.depth = true;
    attrs.stencil = false;
    attrs.antialias = false;
    // Keep the drawing buffer readable after present: the gallery's still
    // capture reads this canvas back, and a beginFrame frame-skip would
    // otherwise leave it blank at exactly the moment the capture samples it.
    attrs.preserveDrawingBuffer = true;
    attrs.enableExtensionsByDefault = true;
    attrs.powerPreference = EM_WEBGL_POWER_PREFERENCE_HIGH_PERFORMANCE;

    // The context must exist and be current BEFORE the Filament engine does —
    // PlatformWebGL assumes a current context and createSwapChain(nullptr).
    const EMSCRIPTEN_WEBGL_CONTEXT_HANDLE ctx = emscripten_webgl_create_context(surface, &attrs);
    if (ctx <= 0) return 0;
    if (emscripten_webgl_make_context_current(ctx) != EMSCRIPTEN_RESULT_SUCCESS) {
        emscripten_webgl_destroy_context(ctx);
        return 0;
    }

    auto* renderer = new TtpRenderer();
    if (!renderer->init(filament::backend::Backend::OPENGL, nullptr, width, height)) {
        delete renderer;
        emscripten_webgl_destroy_context(ctx);
        return 0;
    }
    g_disp = new Display();
    g_disp->renderer = renderer;
    g_disp->context = ctx;
    g_disp->width = width;
    g_disp->height = height;
    return 1;
}

void ttp_display_resize(uint32_t width, uint32_t height) {
    if (!g_disp) return;
    g_disp->width = width ? width : 1;
    g_disp->height = height ? height : 1;
    g_disp->renderer->resize(g_disp->width, g_disp->height);
}

void ttp_display_ui_scale(double scale) {
    if (g_disp && scale > 0) g_disp->uiScale = (float) scale;
}

void ttp_display_destroy(void) {
    if (!g_disp) return;
    delete g_disp->renderer;
    emscripten_webgl_destroy_context(g_disp->context);
    delete g_disp;
    g_disp = nullptr;
}

// ---------------------------------------------------------------------------
// Scene.
// ---------------------------------------------------------------------------
int ttp_display_asset(const char* name, const uint8_t* bytes, uint32_t len) {
    if (!g_disp) return 1;
    return g_disp->renderer->provideAsset(name, bytes, len) ? 0 : 1;
}

void ttp_display_biome(const char* name) {
    if (!g_disp) return;
    g_disp->biome = (name && ttp::rt::has_biome(name)) ? name : "";
}

void ttp_display_showcase(int on) {
    if (g_disp) g_disp->showcase = on != 0;
}

int ttp_display_build(const char* trackId, const char* rosterJson) {
    if (!g_disp) return 1;
    const ttp::TrackDef* def = trackId ? ttp::find_track_def(trackId) : nullptr;
    if (!def) return 1;
    // Parsed BEFORE anything is torn down: a malformed roster is still a legal
    // scene (an empty one), but the parse must not straddle the release below.
    const ttp::rt::Roster roster = ttp::rt::parseRoster(rosterJson);
    if (g_disp->built) g_disp->renderer->releaseScene();
    g_disp->built = false;
    // laps and seed do not reach the geometry — build_race_track only stamps them
    // onto RaceTrack.totalLaps/.seed, and the renderer reads neither. The scene is
    // a function of the track descriptor alone.
    const ttp::RaceTrack geo = ttp::build_race_track(*def, 1, 0u);
    // The look, likewise a function of the track: its cup names the biome unless
    // the inspector override forced one.
    const char* biome = g_disp->biome.empty() ? ttp::rt::biome_for_track(trackId)
                                              : g_disp->biome.c_str();
    // The gallery's showroom resolves through showcase_theme instead: the SAME
    // palette this line would have produced, carrying every biome's vocabulary
    // (ttp_display_showcase). Nothing on the shipping path takes that branch.
    ttp::rt::Theme theme = g_disp->showcase ? ttp::rt::showcase_theme(biome, trackId)
                                            : ttp::rt::resolve_theme(biome, trackId);
    // The one part of the palette that cannot be resolved from data alone: a
    // scenery recolour keyed by AUTHORED colour has to read the model's own glTF
    // materials. Those bytes are already here — the shell provided them as
    // scenery<i>.glb, i being the model's index in this same list.
    for (size_t i = 0; i < theme.scenery.models.size(); i++) {
        const std::vector<uint8_t>* glb =
                g_disp->renderer->asset(("scenery" + std::to_string(i) + ".glb").c_str());
        theme.modelTints.push_back(glb
                ? ttp::rt::resolve_model_tints(biome, theme.scenery.models[i],
                                               glb->data(), glb->size())
                : std::vector<ttp::rt::MatTint>());
    }
    if (!g_disp->renderer->buildScene(geo, theme, roster.cars)) return 1;
    g_disp->built = true;
    g_disp->roster = roster.ids;
    // A rebuild is a new track or a new field; either way the springs must not
    // drag the old frame's camera into it.
    g_disp->chase.clear();
    g_disp->sceneT = 0;
    g_disp->bursts.clear();
    solveFraming(*g_disp);
    // Start the turntable on the still view's own bearing, so a preview's first
    // frame is the framing the track was fitted for.
    g_disp->orbitAngle = g_disp->framing.ovBearing;
    return 0;
}

void ttp_display_release(void) {
    if (!g_disp || !g_disp->built) return;
    g_disp->renderer->releaseScene();
    g_disp->built = false;
    g_disp->roster.clear();
    g_disp->chase.clear();
    g_disp->held.clear();  // a field belongs to the scene it was read from
}

// ---------------------------------------------------------------------------
// What to draw.
// ---------------------------------------------------------------------------
void ttp_display_bind(int session) {
    if (!g_disp) return;
    if (g_disp->session == session) return;
    // A new session is a new field: the springs must not drag the last race's
    // camera into it, and a hold taken at the old race's finish is spent.
    g_disp->chase.clear();
    g_disp->hold = false;
    g_disp->held.clear();
    g_disp->session = session;
}

void ttp_display_cells(const char* idsJson) {
    if (!g_disp) return;
    g_disp->cells = parseIds(idsJson);
}

int ttp_display_cell_rects(float* out, int maxCells) {
    if (!g_disp || !out || maxCells <= 0) return 0;
    const uint32_t n = (uint32_t) g_disp->cells.size();
    if (!n) return 0;
    const uint32_t want = n < (uint32_t) maxCells ? n : (uint32_t) maxCells;
    for (uint32_t i = 0; i < want; i++) {
        // The RENDERER owns the rect: it letterboxes the grid as ONE piece, so a
        // cell is a tile of the capped picture and not of the raw surface. Asking
        // it is the whole point of this export — a shell that re-derived the grid
        // would put its labels on the surface where the picture is not. The
        // renderer's own steer bar and dividers ask the same function, so the
        // shell's chrome and the renderer's cannot land on different grids.
        const TtpCellRect r = g_disp->renderer->cellRectTopLeft(n, i);
        out[i * 4 + 0] = (float) r.x;
        out[i * 4 + 1] = (float) r.y;
        out[i * 4 + 2] = (float) r.w;
        out[i * 4 + 3] = (float) r.h;
    }
    return (int) want;
}

void ttp_display_cell_cards(uint32_t mask) {
    if (g_disp) g_disp->cardMask = mask;
}

const TtpHudBlock* ttp_display_hud(void) {
    // An empty block rather than null with no display: ttp_abi.h's rule is that
    // an absent singleton answers emptily, and the shell's loop is then the same
    // shape whether or not boot() has resolved a display for it.
    static const TtpHudBlock kEmpty = { TTP_HUD_BLOCK_VERSION, 0,
                                        (uint32_t) sizeof(TtpHudSlot), 0 };
    if (!g_disp) return &kEmpty;
    const Game* eng = g_disp->session ? ttp_session_engine(g_disp->session) : nullptr;
    return ttp::rt::buildHud(*g_disp, eng);
}

void ttp_display_dividers(int enabled) {
    if (g_disp) g_disp->dividers = enabled != 0;
}

void ttp_display_camera(int mode) {
    if (g_disp) g_disp->camMode = mode;
}

void ttp_display_look(double eyeX, double eyeY, double eyeZ,
                      double tgtX, double tgtY, double tgtZ) {
    if (!g_disp) return;
    g_disp->freeEye = { (float) eyeX, (float) eyeY, (float) eyeZ };
    g_disp->freeTarget = { (float) tgtX, (float) tgtY, (float) tgtZ };
}

void ttp_display_fog(int enabled) {
    if (g_disp) g_disp->fog = enabled != 0;
}

void ttp_display_shadows(int enabled) {
    if (g_disp) g_disp->renderer->setShadowsEnabled(enabled != 0);
}

void ttp_display_hold(int held) {
    if (!g_disp) return;
    g_disp->hold = held != 0;
    if (!g_disp->hold) { g_disp->held.clear(); return; }
    // Freeze the poses already on screen and drop every motion cue with them,
    // so the held field neither drives nor spins its wheels.
    for (TtpCarInput& c : g_disp->held) atRest(c);
}

void ttp_display_burst(const char* idJson, double s, double lat) {
    if (!g_disp) return;
    TtpBurstInput b{};
    b.car = -1;
    b.s = (float) s;
    b.lat = (float) lat;
    const ScalarId id = ttp::parse_scalar_id(idJson);
    if (!id.isNull()) {
        for (size_t i = 0; i < g_disp->roster.size(); i++) {
            if (g_disp->roster[i] == id) { b.car = (int32_t) i; b.s = 0; b.lat = 0; break; }
        }
    }
    g_disp->bursts.push_back(b);
}

// ---------------------------------------------------------------------------
// The frame.
// ---------------------------------------------------------------------------
int ttp_display_frame(double dtSeconds) {
    if (!g_disp || !g_disp->built) return 0;
    Display& d = *g_disp;
    const float dt = (float) dtSeconds;
    // The one seam into the sim half of the runtime (ttp_session.h): the display
    // reads the bound session's live Game instead of being handed a serialized
    // copy of it back from the shell.
    const Game* eng = d.session ? ttp_session_engine(d.session) : nullptr;
    // Match the renderer's own viewport exactly, or the projection disagrees
    // with the rect it lands in. cellRect is a tile of the LETTERBOXED grid, so
    // this is the aspect of what is actually drawn; widthFrac measures that
    // picture against a 16:9 view of the same height, which is the reference the
    // chase lens is solved against. Only the renderer knows either number.
    const uint32_t nCells = (uint32_t) d.cells.size();
    const TtpRenderer::CellRect r = d.renderer->cellRect(nCells ? nCells : 1, 0);
    const float cellAspect = (float) r.w / (float) (r.h ? r.h : 1);
    const float widthFrac =
            (float) r.w / ((16.0f / 9.0f) * (float) (d.height ? d.height : 1));
    const TtpFrameInput* head = ttp::rt::buildFrame(d, eng, dt, cellAspect, widthFrac);
    return d.renderer->render(*head) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Diagnostics.
// ---------------------------------------------------------------------------
const double* ttp_display_profile(void) {
    return g_disp ? g_disp->renderer->profile() : nullptr;
}

const char* ttp_display_profile_names(void) {
    static std::string joined;
    if (joined.empty()) {
        for (const char* const* n = TtpRenderer::profileNames(); *n; ++n) {
            if (!joined.empty()) joined += ',';
            joined += *n;
        }
    }
    return joined.c_str();
}

}  // extern "C"
