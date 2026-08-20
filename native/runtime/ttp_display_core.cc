// ttp_display_core.cc — the SHARED half of the display ABI: every extern "C"
// body in ttp_display.h that names no platform API, which is all of them
// except creating and destroying the surface. The web, tvOS and Android TV
// modules all compile this file; each adds only its own surface file
// (ttp_display_web.cc and siblings) holding the GL context / CAMetalLayer /
// ANativeWindow and the TtpRenderer construction.
//
// This file DOES name TtpRenderer, which is why it lives beside the ABI shims
// (an SDK-gated source, like the surface files) and not in libttp-runtime:
// libttp-runtime and the renderer may not link each other (native/CLAUDE.md),
// and CI's Filament-less legs never compile this file. Keep anything that a
// ctest should pin OUT of here — the camera maths, the roster parse and the
// re-roster plan all live in libttp-runtime for exactly that reason.
//
// The ABI's camera modes and libttp-runtime's CamMode are two spellings of one
// set of values, and the static_asserts tying them together are deliberately
// NOT here: this file is added to the build only with -DFILAMENT_SDK, so an
// assert in it is compiled by no CI leg and catches a renumbered enum only on
// a dev box that happens to have the SDK. They live at the top of
// runtimetest/frame_check.cc instead, which every leg builds and ctests.

#include "ttp_display.h"
#include "ttp_display_core.h"
#include "ttp_error.h"

#include <chrono>
#include <cstdio>
#include <string>
#include <vector>

#include "TtpRenderer.h"
#include "ttp/canonical.h"
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
#include "ttp/wear.h"
#include "ttp_render.h"
#include "ttp_session.h"

using ttp::Game;
using ttp::ScalarId;
using ttp::rt::atRest;
using ttp::rt::DisplayCore;
using ttp::rt::parseIds;

namespace ttp {
namespace rt {

DisplayCore*& displayCore() {
    static DisplayCore* core = nullptr;
    return core;
}

}  // namespace rt
}  // namespace ttp

namespace {

// The singleton slot, under the name every body below has always used.
DisplayCore*& g_disp = ttp::rt::displayCore();

// Ask the renderer for what only it can measure — the track's bounding box and
// the worst-case orbit distance over its centerline samples — and let
// libttp-runtime solve the rigs and fog bands from those numbers.
//
// The two-pass call is deliberate. maxOrbitDist is asked in terms of the orbit
// ring (ovRadius, ovHeight) that solveFraming itself derives from the box, so the
// first pass exists purely to read that ring out; only ovFogNear/ovFogFar depend
// on the answer, so nothing else is discarded. Cost: two dozen float ops, once
// per scene build.
void solveFraming(DisplayCore& d) {
    TtpTrackFraming tf;
    if (!d.renderer->trackFraming(tf)) { d.framing = ttp::rt::Framing(); return; }
    const ttp::rt::Framing ring = ttp::rt::solveFraming(tf, 0);
    d.framing = ttp::rt::solveFraming(tf, d.renderer->maxOrbitDist(ring.ovRadius, ring.ovHeight));
}

}  // namespace

extern "C" {

// ---------------------------------------------------------------------------
// Surface. Creation and destruction are the PLATFORM's (ttp_display_web.cc
// and siblings); a resize only reaches the renderer, so it is shared.
// ---------------------------------------------------------------------------
void ttp_display_resize(uint32_t width, uint32_t height) {
    if (!g_disp) return;
    g_disp->width = width ? width : 1;
    g_disp->height = height ? height : 1;
    g_disp->renderer->resize(g_disp->width, g_disp->height);
}

void ttp_display_drain(void) {
    if (g_disp && g_disp->renderer) g_disp->renderer->drain();
}

// ---------------------------------------------------------------------------
// Scene.
// ---------------------------------------------------------------------------
int ttp_display_asset(const char* name, const uint8_t* bytes, uint32_t len) {
    // PREDICATE polarity (1 = accepted), like every other int on the ABI. This
    // and build were the two outcome-style (0 = success) returns; both flipped
    // when the polarity zoo was retired (ttp_abi.h).
    if (!g_disp) return 0;
    return g_disp->renderer->provideAsset(name, bytes, len) ? 1 : 0;
}

void ttp_display_biome(const char* name) {
    if (!g_disp) return;
    g_disp->biome = (name && ttp::rt::has_biome(name)) ? name : "";
}

void ttp_display_showcase(int on) {
    if (g_disp) g_disp->showcase = on != 0;
}

void ttp_display_model_variant(const char* model, int variant) {
    if (g_disp && g_disp->renderer) g_disp->renderer->setModelVariant(model, variant);
}

void ttp_display_bench(const char* model) {
    if (g_disp && g_disp->renderer) g_disp->renderer->setModelBench(model);
}

void ttp_display_kit_field(int count) {
    if (g_disp && g_disp->renderer) g_disp->renderer->setKitField(count);
}

const char* ttp_display_kit_field_layout(void) {
    // The renderer owns the string (it is written once per build), so this
    // hands back its buffer rather than copying into a static of its own.
    return (g_disp && g_disp->renderer) ? g_disp->renderer->kitFieldLayout() : "[]";
}

int ttp_display_build(const char* trackId, const char* rosterJson) {
    ttp::clear_error();
    // The two ways this refuses are unrelated and read identically from outside:
    // a shell that never created a surface, and one that named a track nobody
    // ships. Both used to be a bare 1.
    if (!g_disp) {
        ttp::set_error("ttp_display_build: no display — ttp_display_create was not called");
        return 0;
    }
    const ttp::TrackDef* def = trackId ? ttp::find_track_def(trackId) : nullptr;
    if (!def) {
        ttp::set_error(std::string("ttp_display_build: no track \"")
                       + (trackId ? trackId : "") + "\" in this build (catalogue or dev)");
        return 0;
    }
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
    // scenery<i>.glb, i being the model's index in this same list. Resolved per
    // MODEL, so the showroom above gets the same palm the beach does.
    for (size_t i = 0; i < theme.scenery.models.size(); i++) {
        const std::vector<uint8_t>* glb =
                g_disp->renderer->asset(("scenery" + std::to_string(i) + ".glb").c_str());
        theme.modelTints.push_back(glb
                ? ttp::rt::resolve_model_tints(theme.scenery.models[i],
                                               glb->data(), glb->size())
                : std::vector<ttp::rt::MatTint>());
    }
    // The road's wear — the asphalt patches — is planned HERE (the shim links
    // libttp-runtime; the renderer only performs). Pure function of the same
    // built track the sim races plus the deck the biome surfaces it with (a
    // moulded-plastic deck plans none), like the theme.
    const ttp::rt::WearPlan wear = ttp::rt::compute_wear_plan(geo, theme.road);
    if (!g_disp->renderer->buildScene(geo, theme, roster.cars, wear)) return 0;
    g_disp->built = true;
    g_disp->roster = roster.ids;
    g_disp->rosterCars = roster.cars; // ttp_display_reroster's diff base
    // A rebuild is a new track or a new field; either way the springs must not
    // drag the old frame's camera into it.
    g_disp->chase.clear();
    g_disp->steerBar.clear();
    g_disp->sceneT = 0;
    g_disp->bursts.clear();
    solveFraming(*g_disp);
    // Start the turntable on the still view's own bearing, so a preview's first
    // frame is the framing the track was fitted for.
    g_disp->orbitAngle = g_disp->framing.ovBearing;
    return 1;
}

int ttp_display_reroster(const char* rosterJson) {
    ttp::clear_error();
    // PREDICATE polarity (1 = re-dressed), like asset and build now. 0 means
    // this was NOT a re-dress and the shell performs the fallback build.
    if (!g_disp || !g_disp->built) {
        ttp::set_error("ttp_display_reroster: no built scene to re-dress");
        return 0;
    }
    const ttp::rt::Roster next = ttp::rt::parseRoster(rosterJson);
    ttp::rt::Roster prev;
    prev.ids = g_disp->roster;
    prev.cars = g_disp->rosterCars;
    // The decision is libttp-runtime's (ctested); this file only performs it.
    const ttp::rt::RerosterPlan plan = ttp::rt::planReroster(prev, next);
    if (!plan.ok) {
        ttp::set_error("ttp_display_reroster: the field changed shape — that is a build");
        return 0;
    }
    if (!g_disp->renderer->reroster(next.cars, plan.remodel, plan.redress)) {
        ttp::set_error("ttp_display_reroster: a slot failed to rebuild — fall back to a build");
        return 0;
    }
    // Deliberately NOT touched: sceneT, orbitAngle, chase, steerBar, framing.
    // The scene never went away, so nothing about the cameras did either.
    g_disp->rosterCars = next.cars;
    return 1;
}

void ttp_display_release(void) {
    if (!g_disp || !g_disp->built) return;
    g_disp->renderer->releaseScene();
    g_disp->built = false;
    g_disp->roster.clear();
    g_disp->rosterCars.clear();
    g_disp->chase.clear();
    g_disp->steerBar.clear();
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
    g_disp->steerBar.clear();
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
    // The surface the renderer laid the grid out on, which is what the fractions
    // below are fractions OF. Guarded because ttp_display_resize floors both at
    // 1, and a divide by zero here would answer inf to every shell at once.
    const double sw = g_disp->width > 0 ? (double) g_disp->width : 1.0;
    const double sh = g_disp->height > 0 ? (double) g_disp->height : 1.0;
    for (uint32_t i = 0; i < want; i++) {
        // The RENDERER owns the rect: it letterboxes the grid as ONE piece, so a
        // cell is a tile of the capped picture and not of the raw surface. Asking
        // it is the whole point of this export — a shell that re-derived the grid
        // would put its labels on the surface where the picture is not. The
        // renderer's own steer bar and dividers ask the same function, so the
        // shell's chrome and the renderer's cannot land on different grids.
        const TtpCellRect r = g_disp->renderer->cellRectTopLeft(n, i);
        // NORMALISED, because a rect in surface pixels only means anything
        // ALONGSIDE the surface size — and the render scale moves that under the
        // shell. Handing the two out separately made every HUD a two-value read
        // that had to be taken in one breath, and two of the three shells had
        // already failed it: tvOS placed the whole HUD off a stale `uiScale`, and
        // Android divided fresh rects by a `surfaceWidth` Compose could not see
        // change. A fraction needs no partner, so neither bug can be written.
        out[i * 4 + 0] = (float) (r.x / sw);
        out[i * 4 + 1] = (float) (r.y / sh);
        out[i * 4 + 2] = (float) (r.w / sw);
        out[i * 4 + 3] = (float) (r.h / sh);
    }
    return (int) want;
}

void ttp_display_cell_cards(uint32_t mask) {
    if (g_disp) g_disp->cardMask = mask;
}

const char* ttp_display_slot_ids_json(void) {
    static std::string buf;
    if (!g_disp || !g_disp->built) return "[]";
    ttp::Value a = ttp::Value::Arr();
    for (const auto& id : g_disp->roster) a.push(id.toValue());
    ttp::canonical_stringify_into(a, buf);   // an array of scalars: order kept
    return buf.c_str();
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
    DisplayCore& d = *g_disp;
    const float dt = (float) dtSeconds;
    // The one seam into the sim half of the runtime (ttp_session.h): the display
    // reads the bound session's live Game instead of being handed a serialized
    // copy of it back from the shell.
    const Game* eng = d.session ? ttp_session_engine(d.session) : nullptr;
    // Match the renderer's own viewport exactly, or the projection disagrees with
    // the rect it lands in. The number comes from the renderer (cellAspect)
    // rather than being worked out here: it is a function of the LETTERBOXED
    // grid, and a shell deriving it would be a copy of it that could drift.
    const uint32_t nCells = (uint32_t) d.cells.size();
    // buildFrame is inside the shell's per-frame span (the ttp:render atrace
    // marker) but outside the renderer's kProfTotal; posting it into the
    // profile array is what lets a scripted sweep attribute a CPU spike to the
    // input build without a second ABI call. Same steady_clock as ttpNowMs.
    const auto tBuild = std::chrono::steady_clock::now();
    const TtpFrameInput* head =
            ttp::rt::buildFrame(d, eng, dt, d.renderer->cellAspect(nCells));
    d.renderer->noteBuildMs(std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - tBuild).count());
    return d.renderer->render(*head) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Diagnostics.
// ---------------------------------------------------------------------------
const double* ttp_display_profile(void) {
    return g_disp ? g_disp->renderer->profile() : nullptr;
}

void ttp_display_antialias(int on) {
    if (g_disp && g_disp->renderer) g_disp->renderer->setAntialias(on != 0);
}

double ttp_display_gpu_ms(void) {
    return g_disp && g_disp->renderer ? g_disp->renderer->gpuMs() : 0.0;
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

void ttp_display_debug_hide_cars(int on) {
    if (g_disp && g_disp->renderer) g_disp->renderer->debugHideCars(on != 0);
}

void ttp_display_debug_wipe_skids(void) {
    if (g_disp && g_disp->renderer) g_disp->renderer->debugWipeSkids();
}

void ttp_display_debug_force_mask_layer(int layer) {
    if (g_disp && g_disp->renderer) g_disp->renderer->debugForceMaskLayer(layer);
}

void ttp_display_debug_features(unsigned int mask) {
    if (g_disp && g_disp->renderer) g_disp->renderer->debugFeatureMask((uint32_t) mask);
}

const char* ttp_display_debug_decals(void) {
    static std::string json;
    json = "[";
    if (g_disp && g_disp->renderer) {
        const auto& v = g_disp->renderer->debugDeckDecals();
        char buf[400];
        for (size_t i = 0; i < v.size(); i++) {
            if (i) json += ',';
            snprintf(buf, sizeof buf,
                    "{\"s\":%.4f,\"lat\":%.4f,\"halfS\":%.4f,\"halfLat\":%.4f,"
                    "\"r\":%.4f,\"g\":%.4f,\"b\":%.4f,\"a\":%.4f,"
                    "\"inner\":%.3f,\"ellipse\":%.1f,\"knee\":%.3f,"
                    "\"sin\":%.4f,\"cos\":%.4f,\"layer\":%.0f,\"masked\":%.0f,"
                    // The GROUND-CONFORM's numbers, not the shadow's: the worst
                    // wheel-to-deck gap and the rendered pose's jitter beside
                    // the contract pose's. The sim's own snapshot cannot show
                    // any of it, because the conform runs after it.
                    //
                    // MEANINGFUL ON MASKED ENTRIES ONLY. They ride `shape`,
                    // which is spare on a car stamp but on a PROFILE decal is
                    // genuinely inner/ellipse/knee/chevrons — so these four keys
                    // on a pad or an oil slick are that profile wearing the
                    // wrong labels. Filter on `masked` before reading them.
                    "\"wheelGap\":%.4f,\"jitter\":%.5f,"
                    "\"rawJitter\":%.5f,\"upJitter\":%.5f,"
                    // …and the stamp's MEASURED track-space cull window, the
                    // half-reaches vroad.mat and foldToChunk both test against.
                    // Worth reading because they cannot be inferred from
                    // halfS/halfLat: those are world lengths, and winS is an
                    // ARCLENGTH, which the deck's fanning iso-lines make a
                    // different number everywhere off the centreline. Compare
                    // them against hypot(halfS, halfLat) to see how far wrong a
                    // constant window would be at this spot.
                    "\"winS\":%.4f,\"winLat\":%.4f}",
                    v[i].rect.x, v[i].rect.y, v[i].rect.z, v[i].rect.w,
                    v[i].color.x, v[i].color.y, v[i].color.z, v[i].color.w,
                    v[i].shape.x, v[i].shape.y, v[i].shape.z,
                    v[i].texrot.x, v[i].texrot.y, v[i].texrot.z, v[i].texrot.w,
                    v[i].shape.x, v[i].shape.y, v[i].shape.z, v[i].shape.w,
                    v[i].wfwd.w, v[i].wright.w);
            json += buf;
        }
    }
    json += ']';
    return json.c_str();
}

}  // extern "C"
