// ttp_display.cc — the display half of the runtime (see ttp_display.h).
//
// Owns three things the JS renderer used to own:
//   1. the platform surface (the WebGL2 context on the target <canvas>),
//   2. the cameras — one spring chase per split-screen cell, plus the lobby and
//      gallery overview rigs,
//   3. the per-frame TtpFrameInput, built straight off the live Game.
//
// (3) is the reason this file exists. The two-module shape serialized every car
// pose and camera matrix through JS on every frame — snapshot JSON out of the
// sim, Float32Array into the renderer. Here the sim and the renderer share a
// heap, so the frame is assembled from `Game::cars()` in place and the boundary
// is one call with a dt.

#include "ttp_display.h"

#include <emscripten/emscripten.h>
#include <emscripten/html5_webgl.h>

#include <cmath>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include "TtpRenderer.h"
#include "ttp/game.h"
#include "ttp/json_parse.h"
#include "ttp/scalar_id.h"
#include "ttp/util.h"
#include "ttp_render.h"
#include "ttp_session.h"

using ttp::Car;
using ttp::Game;
using ttp::ScalarId;
using ttp::Value;

namespace {

// ---------------------------------------------------------------------------
// Small vector helpers. Cosmetic math only — nothing here is conformance-
// bearing, so it runs in plain float, unlike everything in libttp-sim.
// ---------------------------------------------------------------------------
struct V3 {
    float x = 0, y = 0, z = 0;
};
V3 operator+(V3 a, V3 b) { return { a.x + b.x, a.y + b.y, a.z + b.z }; }
V3 operator-(V3 a, V3 b) { return { a.x - b.x, a.y - b.y, a.z - b.z }; }
V3 operator*(V3 a, float k) { return { a.x * k, a.y * k, a.z * k }; }
float dot(V3 a, V3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
V3 cross(V3 a, V3 b) {
    return { a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x };
}
V3 norm(V3 a) {
    const float l = std::sqrt(dot(a, a));
    return l > 0 ? a * (1.0f / l) : V3{ 0, 0, 1 };
}
V3 lerp(V3 a, V3 b, float t) { return a + (b - a) * t; }
V3 v3(const ttp::Vec3& v) { return { (float) v.x, (float) v.y, (float) v.z }; }

// A camera world matrix, column-major, for an eye looking at `target` with
// `up` — three.js Matrix4.lookAt's basis, which is what TtpViewInput.world is
// documented to carry. Camera looks down -Z, so the Z column points BACK.
void lookAtWorld(float out[16], V3 eye, V3 target, V3 up) {
    V3 z = eye - target;
    if (dot(z, z) == 0) z.z = 1;
    z = norm(z);
    V3 x = cross(up, z);
    if (dot(x, x) == 0) {  // eye directly above/below the target
        if (std::fabs(up.z) == 1) z.x += 1e-4f; else z.z += 1e-4f;
        z = norm(z);
        x = cross(up, z);
    }
    x = norm(x);
    const V3 y = cross(z, x);
    out[0] = x.x;  out[1] = x.y;  out[2] = x.z;  out[3] = 0;
    out[4] = y.x;  out[5] = y.y;  out[6] = y.z;  out[7] = 0;
    out[8] = z.x;  out[9] = z.y;  out[10] = z.z; out[11] = 0;
    out[12] = eye.x; out[13] = eye.y; out[14] = eye.z; out[15] = 1;
}

// ---------------------------------------------------------------------------
// The per-player spring chase camera — an exact port of ChaseCamera.js, whose
// tuning comments are the reference for every constant here.
//
// Close chase sitting LOW and just behind the car with a fairly tight lens, so
// the camera stays comfortable to drive rather than steeply top-down.
// ---------------------------------------------------------------------------
constexpr float CHASE_DIST = 1.35f, CHASE_HEIGHT = 0.64f, CHASE_LOOK = 1.5f;
constexpr float CHASE_TGT_UP = 0.11f;      // look point barely above the road
constexpr float CAM_POS_RATE = 7.0f, CAM_TGT_RATE = 13.0f;  // damping (1/s)
// The position spring lags the car by ~velocity/rate, so the faster you go the
// further back the camera sits. The follow rate therefore climbs with spd²:
// fast straights and boosts tighten and stay glued (the car stays big), while
// slow corners keep the base rate and its loose swing-behind.
constexpr float CAM_POS_RATE_SPD = 13.0f;
constexpr float CAM_RATE_SPD_MAX = 1.6f;   // cap, so a future >1.6 boost can't go rigid
constexpr float BASE_FOV = 55.0f;
// Sense of speed, no shake: FOV widens and the chase stretches back with speed.
// `spd` is normalised to the car's own vmax and a boost pushes it past 1, so
// both cues over-extend exactly as much as the car actually overspeeds. The FOV
// response is asymmetric — it kicks wide fast (a boost lands as a hit) and eases
// back slow (running out of boost is a taper, not a snap).
constexpr float FOV_GAIN = 4.0f, FOV_RISE = 9.0f, FOV_FALL = 3.0f;
constexpr float CHASE_DIST_GAIN = 0.06f;
constexpr float CAM_NEAR = 0.1f, CAM_FAR = 600.0f;

struct ChaseCam {
    V3 pos, target;
    float fov = BASE_FOV;
    bool init = false;  // first update snaps, so it doesn't lag in from the origin

    void update(const ttp::Pose& pose, float spd, float dt) {
        const V3 p = v3(pose.pos), fwd = v3(pose.forward), up = v3(pose.up);
        const V3 want = p + fwd * -(CHASE_DIST + CHASE_DIST_GAIN * spd) + up * CHASE_HEIGHT;
        const V3 wantTgt = p + fwd * CHASE_LOOK + up * CHASE_TGT_UP;
        // Frame-rate-independent damping → smooth lag/swing behind through turns.
        const float rateSpd = spd < CAM_RATE_SPD_MAX ? spd : CAM_RATE_SPD_MAX;
        const float aPos = 1 - std::exp(-(CAM_POS_RATE + CAM_POS_RATE_SPD * rateSpd * rateSpd) * dt);
        const float aTgt = 1 - std::exp(-CAM_TGT_RATE * dt);
        if (!init) { pos = want; target = wantTgt; init = true; }
        else { pos = lerp(pos, want, aPos); target = lerp(target, wantTgt, aTgt); }
        const float fovTarget = BASE_FOV + spd * FOV_GAIN;
        const float fovRate = fovTarget > fov ? FOV_RISE : FOV_FALL;
        fov += (fovTarget - fov) * (1 - std::exp(-fovRate * dt));
    }
};

// ---------------------------------------------------------------------------
// Overview rigs (SceneRenderer's _loop, ported).
// ---------------------------------------------------------------------------
constexpr float OVERVIEW_FOV = 50.0f;
// The overview only ever frames whole tracks, so it can afford a far near plane
// and a long reach. The FREE cam is the exception: it flies right up to
// geometry, and at near 4 whatever you fly up to is simply clipped away.
constexpr float OV_NEAR = 4.0f, OV_FAR = 1500.0f, FREE_NEAR = 0.1f;
constexpr float LOBBY_ORBIT_SPEED = 0.1f;  // rad/s (~63 s per turn) — calm, never dizzying
constexpr float BBOX_ORBIT_SPEED = 0.16f;  // rad/s (~39 s per loop)
constexpr float BBOX_CLEARANCE = 8.0f;     // world units outside the bbox edge — tight
constexpr float BBOX_HEIGHT_K = 0.7f;      // height = this × the AVERAGE half-extent …
constexpr float BBOX_HEIGHT_BASE = 24.0f;  // … + this, so the frame looks DOWN onto the track
constexpr float RACE_FOG_NEAR = 70.0f, RACE_FOG_FAR = 170.0f;

// Everything the overview cameras and the fog profiles derive from the track,
// solved once per scene build rather than per frame.
struct Framing {
    V3 center;
    V3 ovOffset;                        // the fitted iso view's offset from centre
    float ovRadius = 0, ovHeight = 0;   // …and the same thing as orbit terms
    float ovBearing = 0;                // its compass bearing, where the orbits start
    float bbAx = 0, bbAz = 0, bbHeight = 0;
    float ovFogNear = 0, ovFogFar = 0;  // whole-track turntable
    float bbFogNear = 0, bbFogFar = 0;  // lobby perimeter orbit
    float raceFogNear = 0, raceFogFar = 0;
};

struct Display {
    TtpRenderer* renderer = nullptr;
    EMSCRIPTEN_WEBGL_CONTEXT_HANDLE context = 0;
    uint32_t width = 1, height = 1;
    bool built = false;

    int session = 0;                    // bound session handle (0 = draw an empty track)
    std::vector<ScalarId> roster;       // slot order, fixed at build
    std::vector<ScalarId> cells;        // cars owning a split-screen cell, in cell order
    std::map<std::string, ChaseCam> chase;

    bool hold = false;                  // draw the last-read field, at rest
    std::vector<TtpCarInput> held;

    int camMode = TTP_CAM_STILL;
    V3 freeEye, freeTarget;
    bool fog = true;
    Framing framing;

    float sceneT = 0;                   // cosmetic clock (see TtpFrameInput.sceneT)
    float orbitAngle = 0;
    std::vector<TtpBurstInput> bursts;  // queued since the last frame
    std::vector<uint8_t> frame;         // TtpFrameInput scratch, reused every frame
};

Display* g_disp = nullptr;

// Solve the overview rigs + fog bands from the built track's samples. Ported
// from SceneRenderer.setTrack; the bounding box is over the CENTERLINE points,
// not the dressed scene, which is what the JS box was too.
void solveFraming(Display& d) {
    Framing f;
    TtpRenderer::TrackFraming tf;
    if (!d.renderer->trackFraming(tf)) { d.framing = f; return; }

    f.center = { tf.centerX, tf.centerY, tf.centerZ };
    const float halfX = tf.sizeX * 0.5f, halfZ = tf.sizeZ * 0.5f;
    const float radius = (tf.sizeX > tf.sizeZ ? tf.sizeX : tf.sizeZ) * 0.5f + 8;
    // Whole-track fit distance for the gallery turntable, along the same iso
    // direction the still overview uses.
    const float dist = radius / std::tan((OVERVIEW_FOV * (float) M_PI / 180) / 2) * 0.9f;
    const V3 dir = norm(V3{ 0.35f, 0.8f, 0.9f });
    f.ovOffset = dir * dist;
    // Horizontal radius + height of that iso offset, reused by the lobby and
    // gallery orbits so the moving camera keeps the same framing as the still
    // one — and its bearing, so an orbit's first frame IS the still.
    f.ovRadius = std::hypot(f.ovOffset.x, f.ovOffset.z);
    f.ovHeight = f.ovOffset.y;
    f.ovBearing = std::atan2(f.ovOffset.z, f.ovOffset.x);

    // Overview fog: reusing the race fog here would veil the far half of a track
    // framed from ~100-190u out. Instead start the fog just PAST the farthest the
    // track can sit from the orbiting camera — so the whole circuit stays crisp —
    // then dissolve over a WIDE band, because a narrow one gets compressed into a
    // hard line at the grazing horizon angle where a wide one reads as haze.
    f.ovFogNear = d.renderer->maxOrbitDist(f.ovRadius, f.ovHeight) + 12;
    f.ovFogFar = f.ovFogNear + (220.0f > radius * 2 ? 220.0f : radius * 2);

    // Lobby perimeter orbit: hug just outside the XZ bbox so the camera traces
    // the track's overall shape up close (elongated tracks → elongated path).
    f.bbAx = halfX + BBOX_CLEARANCE;
    f.bbAz = halfZ + BBOX_CLEARANCE;
    // Height off the AVERAGE half-extent (not the max), so a very elongated track
    // isn't over-elevated into a top-down view on its narrow sides.
    f.bbHeight = BBOX_HEIGHT_K * (halfX + halfZ) * 0.5f + BBOX_HEIGHT_BASE;
    // With the camera hugging the track, keep the near road crisp but haze the
    // open field SOON, so the empty grass outside the circuit dissolves into the
    // sky instead of reading as a flat plane.
    const float wide = halfX > halfZ ? halfX : halfZ;
    f.bbFogNear = 55 * tf.fogTune;
    f.bbFogFar = (55 + (110.0f > wide * 1.2f ? 110.0f : wide * 1.2f)) * tf.fogTune;
    f.raceFogNear = RACE_FOG_NEAR * tf.fogTune;
    f.raceFogFar = RACE_FOG_FAR * tf.fogTune;
    d.framing = f;
}

std::vector<ScalarId> parseIds(const char* json) {
    std::vector<ScalarId> out;
    if (!json) return out;
    bool ok = false;
    const Value v = ttp::json::parse(json, &ok);
    if (!ok || v.type != Value::ARR) return out;
    for (const Value& e : v.arr) {
        if (e.type == Value::NUM) out.push_back(ScalarId::Num(e.num));
        else if (e.type == Value::STR) out.push_back(ScalarId::Str(e.str));
    }
    return out;
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

int ttp_display_build(const char* rosterIdsJson) {
    if (!g_disp) return 1;
    if (g_disp->built) g_disp->renderer->releaseScene();
    g_disp->built = false;
    if (!g_disp->renderer->buildScene()) return 1;
    g_disp->built = true;
    g_disp->roster = parseIds(rosterIdsJson);
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

void ttp_display_hold(int held) {
    if (!g_disp) return;
    g_disp->hold = held != 0;
    if (!g_disp->hold) { g_disp->held.clear(); return; }
    // Freeze the poses already on screen and drop every motion cue with them,
    // so the held field neither drives nor spins its wheels.
    for (TtpCarInput& c : g_disp->held) {
        c.spd = c.steer = c.brake = c.spin = c.scrub = 0;
        c.boostMul = 1;
    }
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
    Game* eng = d.session ? ttp_session_engine(d.session) : nullptr;

    // Cars, in ROSTER order: the renderer baked each slot's model and livery at
    // build time, so slot i must keep carrying the car the roster named. Ids,
    // not indices — `cars()` is insertion order and the roster is cell order.
    std::vector<const Car*> cars(d.roster.size(), nullptr);
    if (eng) {
        for (const auto& cp : eng->cars()) {
            for (size_t i = 0; i < d.roster.size(); i++) {
                if (d.roster[i] == cp->id) { cars[i] = cp.get(); break; }
            }
        }
    }

    // Views: one chase camera per cell car, or a single overview when no car
    // owns a cell (the lobby's attract race, the gallery, a track preview).
    const bool raceCams = !d.cells.empty() && eng;
    uint32_t viewCount = raceCams ? (uint32_t) d.cells.size() : 1;
    float aspect = (float) d.width / (float) (d.height ? d.height : 1);
    if (raceCams) {
        // Match the renderer's own viewport split exactly, or the projection
        // disagrees with the cell it lands in.
        const uint32_t cols = d.renderer->gridCols(viewCount);
        const uint32_t rows = (viewCount + cols - 1) / cols;
        aspect = (float) (d.width / cols) / (float) (d.height / rows);
    }

    const size_t nBananas = eng ? eng->bananas().size() : 0;  // filtered below
    const size_t nRockets = eng ? eng->rockets().size() : 0;
    const size_t nBoxes = eng ? eng->boxes().size() : 0;

    const size_t bytes = sizeof(TtpFrameInput) + cars.size() * sizeof(TtpCarInput)
            + viewCount * sizeof(TtpViewInput) + nBoxes * sizeof(uint32_t)
            + nBananas * sizeof(TtpBananaInput) + nRockets * sizeof(TtpRocketInput)
            + d.bursts.size() * sizeof(TtpBurstInput);
    if (d.frame.size() < bytes) d.frame.resize(bytes);
    auto* head = reinterpret_cast<TtpFrameInput*>(d.frame.data());
    std::memset(head, 0, sizeof(TtpFrameInput));
    head->version = TTP_FRAME_INPUT_VERSION;
    head->dt = dt;
    head->carCount = (uint32_t) cars.size();
    head->viewCount = viewCount;
    head->boxCount = (uint32_t) nBoxes;
    head->burstCount = (uint32_t) d.bursts.size();

    auto* outCars = const_cast<TtpCarInput*>(ttp_frame_cars(head));
    if (d.hold && d.held.size() == cars.size()) {
        std::memcpy(outCars, d.held.data(), cars.size() * sizeof(TtpCarInput));
    } else {
        for (size_t i = 0; i < cars.size(); i++) {
            TtpCarInput& o = outCars[i];
            std::memset(&o, 0, sizeof(o));
            const Car* c = cars[i];
            if (!c) continue;
            o.pos = { (float) c->pose.pos.x, (float) c->pose.pos.y, (float) c->pose.pos.z };
            o.forward = { (float) c->pose.forward.x, (float) c->pose.forward.y, (float) c->pose.forward.z };
            o.up = { (float) c->pose.up.x, (float) c->pose.up.y, (float) c->pose.up.z };
            o.spd = c->vmax != 0 ? (float) (c->v / c->vmax) : 0;
            o.steer = (float) c->steer;
            o.brake = (float) c->brake;
            o.boostMul = (float) c->boostMul;
            o.monster = c->monsterT > 0 ? 1.0f : 0.0f;
            o.spin = (float) c->spin;
            o.scrub = c->onWall ? 1.0f : 0.0f;
        }
        // Keep this frame's field, so a hold taken mid-race has something to
        // hold — ttp_display_hold zeroes the motion cues on the way in.
        d.held.assign(outCars, outCars + cars.size());
    }

    auto* outViews = const_cast<TtpViewInput*>(ttp_frame_views(head));
    const float fogNear = !d.fog ? 0
            : raceCams ? d.framing.raceFogNear
            : d.camMode == TTP_CAM_BBOX ? d.framing.bbFogNear
            : d.framing.ovFogNear;
    const float fogFar = !d.fog ? 0
            : raceCams ? d.framing.raceFogFar
            : d.camMode == TTP_CAM_BBOX ? d.framing.bbFogFar
            : d.framing.ovFogFar;
    if (raceCams) {
        for (size_t i = 0; i < d.cells.size(); i++) {
            ChaseCam& cam = d.chase[d.cells[i].key()];
            const Car* c = nullptr;
            for (size_t j = 0; j < d.roster.size(); j++) {
                if (d.roster[j] == d.cells[i]) { c = cars[j]; break; }
            }
            if (c) cam.update(c->pose, c->vmax != 0 ? (float) (c->v / c->vmax) : 0, dt);
            TtpViewInput& v = outViews[i];
            lookAtWorld(v.world, cam.pos, cam.target, c ? v3(c->pose.up) : V3{ 0, 1, 0 });
            v.fov = cam.fov;
            v.aspect = aspect;
            v.nearZ = CAM_NEAR;
            v.farZ = CAM_FAR;
            v.fogNear = fogNear;
            v.fogFar = fogFar;
        }
    } else {
        const Framing& f = d.framing;
        V3 eye, target = f.center;
        if (d.camMode == TTP_CAM_FREE) {
            eye = d.freeEye;
            target = d.freeTarget;
        } else if (d.camMode == TTP_CAM_BBOX) {
            d.orbitAngle += BBOX_ORBIT_SPEED * dt;
            eye = { f.center.x + std::cos(d.orbitAngle) * f.bbAx,
                    f.center.y + f.bbHeight,
                    f.center.z + std::sin(d.orbitAngle) * f.bbAz };
        } else if (d.camMode == TTP_CAM_ORBIT) {
            d.orbitAngle += LOBBY_ORBIT_SPEED * dt;
            eye = { f.center.x + std::cos(d.orbitAngle) * f.ovRadius,
                    f.center.y + f.ovHeight,
                    f.center.z + std::sin(d.orbitAngle) * f.ovRadius };
        } else {
            eye = f.center + f.ovOffset;  // the fitted whole-track iso view, held still
        }
        TtpViewInput& v = outViews[0];
        lookAtWorld(v.world, eye, target, V3{ 0, 1, 0 });
        v.fov = OVERVIEW_FOV;
        v.aspect = aspect;
        v.nearZ = d.camMode == TTP_CAM_FREE ? FREE_NEAR : OV_NEAR;
        v.farZ = OV_FAR;
        v.fogNear = fogNear;
        v.fogFar = fogFar;
    }

    auto* outBoxes = const_cast<uint32_t*>(ttp_frame_box_states(head));
    if (eng) {
        const auto& boxes = eng->boxes();
        for (size_t i = 0; i < boxes.size(); i++) outBoxes[i] = boxes[i].cooldown <= 0 ? 1u : 0u;
    }

    // Bananas are live only once armed — an unarmed one is not on the track yet
    // and drawing it would show the dropper a hazard they haven't dropped.
    auto* outBananas = const_cast<TtpBananaInput*>(ttp_frame_bananas(head));
    uint32_t nb = 0;
    if (eng) {
        const double now = eng->elapsed();
        for (const auto& b : eng->bananas()) {
            if (now < b.liveAt) continue;
            outBananas[nb].s = (float) b.s;
            outBananas[nb].lat = (float) b.lat;
            nb++;
        }
    }
    head->bananaCount = nb;

    auto* outRockets = const_cast<TtpRocketInput*>(ttp_frame_rockets(head));
    if (eng) {
        const auto& rockets = eng->rockets();
        for (size_t i = 0; i < rockets.size(); i++) {
            outRockets[i].s = (float) ttp::wrap_s(rockets[i].s, eng->length());
            outRockets[i].lat = (float) rockets[i].lat;
        }
        head->rocketCount = (uint32_t) rockets.size();
    }

    auto* outBursts = const_cast<TtpBurstInput*>(ttp_frame_bursts(head));
    for (size_t i = 0; i < d.bursts.size(); i++) outBursts[i] = d.bursts[i];
    d.bursts.clear();

    d.sceneT += dt;
    head->sceneT = d.sceneT;
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
