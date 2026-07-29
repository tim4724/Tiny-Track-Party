// frame_check — buildFrame, buildHud, atRest, parseIds and parseRoster,
// driven directly.
//
// WHY IT EXISTS. runtime_check pins the cameras, the framing/fog solve and the
// split-screen grid, but it calls those three primitives itself: it never runs
// the 200-line block that ASSEMBLES a frame out of them. That block — which car
// lands in which roster slot, which cell gets which camera, what "held" means,
// which bananas are live — was the largest thing lifted out of the
// Filament-gated shim, and moving it into libttp-runtime bought it COMPILE
// coverage on all four legs and nothing more. This is the gate that executes it.
//
// ttp::rt::buildHud is here for exactly the same reason. hud_check replays the
// ui-corpus through `hudSlot`, which settles the per-car RULE and nothing else:
// the corpus carries snapshot-level values, not a live Game, so the block
// ASSEMBLY around it — roster-slot mapping, zeroing the slots no car claims, the
// header, the reused scratch — had compile-only coverage too. It needs a Game
// with a shuffled roster and a car-less seat, which is the fixture this file
// already stands up. It stays OUT of hud_check because these are behavioural
// assertions (see below), and that file is class-1 JS-recorded evidence.
//
// WHAT THIS IS. A BEHAVIOURAL gate, like hazard_check — not a corpus and not
// conformance evidence. SceneRenderer's frame assembly was deleted with the JS
// renderer, so there is no oracle left to record against; the assertions encode
// the invariants the code states, and say NOTHING about whether the port from JS
// was right. Only the golden traces can settle a parity question.
//
// WHY ASSERTIONS AND NOT A QUANTIZED CORPUS. Almost everything buildFrame does
// is exactly reproducible on every leg: the car block is `(float)` casts, one
// division and one multiply by STEER_SIGN; the counts and the roster mapping are
// integers; the fog bands and the still/free eyes are copies and adds. The two
// places that touch the platform's libm — the chase spring and the orbit
// cos/sin — are checked against a REFERENCE ChaseCam driven with the same
// inputs in this same process, so they are bit-equal here whatever the libm
// does. Nothing in this file needs the 4-significant-digit treatment
// runtime_check's corpus needs, so nothing in it takes it.

#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "ttp/camera.h"
#include "ttp/frame_builder.h"
#include "ttp/framing.h"
#include "ttp/game.h"
#include "ttp/hud.h"
#include "ttp/roster.h"
#include "ttp/race_track.h"
#include "ttp/util.h"
#include "ttp/vecmath.h"
#include "ttp_display.h"
#include "ttp_render.h"

using namespace ttp;
using ttp::rt::ChaseCam;
using ttp::rt::DisplayState;
using ttp::rt::Framing;
using ttp::rt::V3;

// The renderer measures the cell rect on the shipping path; this check has no
// renderer, so it reproduces the same two numbers from the grid ttp_grid_cols
// defines. widthFrac 1 is the single-player fixed point, which is what every
// case here framed against before the lens was pinned to pixel scale.
static void caseCell(const rt::DisplayState& d, float* aspect, float* widthFrac) {
  const uint32_t n = d.cells.empty() ? 1u : (uint32_t) d.cells.size();
  const uint32_t cols = ttp_grid_cols(n, d.width, d.height);
  const uint32_t rows = (n + cols - 1) / cols;
  const uint32_t w = d.width / cols, h = d.height / rows;
  *aspect = (float) w / (float) (h ? h : 1);
  *widthFrac = (float) w / ((16.0f / 9.0f) * (float) (d.height ? d.height : 1));
}
static float caseAspect(const rt::DisplayState& d) {
  float a = 1, wf = 1; caseCell(d, &a, &wf); return a;
}
static float caseWidthFrac(const rt::DisplayState& d) {
  float a = 1, wf = 1; caseCell(d, &a, &wf); return wf;
}


// ---------------------------------------------------------------------------
// The ABI's camera modes and libttp-runtime's enum are two spellings of one set
// of values. The ABI (runtime/ttp_display.h) is frozen and the library
// deliberately does not include it — it is emscripten-tagged and platform-facing
// — so the pair needs exactly one binding, and this is it.
//
// It used to live in the ABI shim, which is added to the build only with
// -DFILAMENT_SDK: no CI leg compiled it, so a renumbered enum reached every
// green leg and failed on one dev box. A test TU may include both headers (the
// emscripten tag is harmless here), and this one is built and ctested on
// ubuntu/macOS/wasm/tvOS-sim.
// ---------------------------------------------------------------------------
static_assert(TTP_CAM_STILL == ttp::rt::CAM_STILL, "camera mode drift");
static_assert(TTP_CAM_ORBIT == ttp::rt::CAM_ORBIT, "camera mode drift");
static_assert(TTP_CAM_BBOX == ttp::rt::CAM_BBOX, "camera mode drift");
static_assert(TTP_CAM_FREE == ttp::rt::CAM_FREE, "camera mode drift");

namespace {

int failures = 0;
int checks = 0;

void check(bool ok, const std::string& what) {
  checks++;
  if (!ok) {
    failures++;
    std::fprintf(stderr, "FAIL %s\n", what.c_str());
  }
}

void checkF(float got, float want, const std::string& what) {
  checks++;
  if (got != want) {
    failures++;
    std::fprintf(stderr, "FAIL %s: got %.9g, want %.9g\n", what.c_str(), (double)got, (double)want);
  }
}

void checkU(uint32_t got, uint32_t want, const std::string& what) {
  checks++;
  if (got != want) {
    failures++;
    std::fprintf(stderr, "FAIL %s: got %u, want %u\n", what.c_str(), got, want);
  }
}

void checkMat(const float got[16], const float want[16], const std::string& what) {
  checks++;
  if (std::memcmp(got, want, 16 * sizeof(float)) != 0) {
    failures++;
    std::fprintf(stderr, "FAIL %s: camera world matrix differs\n", what.c_str());
    for (int i = 0; i < 16; i++) {
      if (got[i] != want[i])
        std::fprintf(stderr, "     [%2d] got %.9g, want %.9g\n", i, (double)got[i], (double)want[i]);
    }
  }
}

bool sameVec(const TtpVec3& o, const Vec3& v) {
  return o.x == (float)v.x && o.y == (float)v.y && o.z == (float)v.z;
}

// Every field of one car slot, against the Car the roster put in it.
void checkCar(const TtpCarInput& o, const Car& c, const std::string& what) {
  check(sameVec(o.pos, c.pose.pos), what + ".pos");
  check(sameVec(o.forward, c.pose.forward), what + ".forward");
  check(sameVec(o.up, c.pose.up), what + ".up");
  checkF(o.spd, c.vmax != 0 ? (float)(c.v / c.vmax) : 0.0f, what + ".spd");
  checkF(o.steer, (float)(ttp::STEER_SIGN * c.steer), what + ".steer");
  checkF(o.brake, (float)c.brake, what + ".brake");
  checkF(o.boostMul, (float)c.boostMul, what + ".boostMul");
  checkF(o.monster, c.monsterT > 0 ? 1.0f : 0.0f, what + ".monster");
  checkF(o.spin, (float)c.spin, what + ".spin");
  checkF(o.scrub, c.onWall ? 1.0f : 0.0f, what + ".scrub");
}

void checkEmptyHudSlot(const TtpHudSlot& s, const std::string& what) {
  TtpHudSlot zero;
  std::memset(&zero, 0, sizeof zero);
  check(std::memcmp(&s, &zero, sizeof zero) == 0,
        what + " — a roster slot no live car claims is zeroed, not stale");
}

void checkEmptySlot(const TtpCarInput& o, const std::string& what) {
  TtpCarInput zero;
  std::memset(&zero, 0, sizeof zero);
  check(std::memcmp(&o, &zero, sizeof zero) == 0,
        what + " — a roster slot with no car in the field is left entirely zeroed");
}

void checkView(const TtpViewInput& v, const float world[16], float fov, float aspect,
               float nearZ, float farZ, float fogNear, float fogFar, const std::string& what) {
  checkMat(v.world, world, what + ".world");
  checkF(v.fov, fov, what + ".fov");
  checkF(v.aspect, aspect, what + ".aspect");
  checkF(v.nearZ, nearZ, what + ".nearZ");
  checkF(v.farZ, farZ, what + ".farZ");
  checkF(v.fogNear, fogNear, what + ".fogNear");
  checkF(v.fogFar, fogFar, what + ".fogFar");
}

const double DT_MS = 1000.0 / 60.0;
const float DT = 1.0f / 60;

// The "square" case from runtime_check's framing table, so both gates solve the
// same rig and a framing change shows up in the corpus rather than only here.
const TtpTrackFraming TF = {12.5f, 1.5f, -30.25f, 182.0f, 14.0f, 176.0f, 1.0f};
const float MAX_ORBIT_DIST = 214.37f;

const Id P0 = Id::Num(0);
const Id P1 = Id::Num(1);
const Id P2 = Id::Str("cpu-bolt");
// In the roster, never in the field: a seat whose car has not been added (or has
// just been removed), which the shell can and does hand us mid-build.
const Id GHOST = Id::Str("no-such-car");

std::vector<PlayerDesc> threePlayers() {
  return {PlayerDesc{P0, false, Stats{}}, PlayerDesc{P1, false, Stats{}},
          PlayerDesc{P2, false, Stats{}}};
}

DisplayState freshState() {
  DisplayState d;
  d.width = 1920;
  d.height = 1080;
  d.framing = rt::solveFraming(TF, MAX_ORBIT_DIST);
  d.camMode = TTP_CAM_STILL;
  d.fog = true;
  return d;
}

// Give each car a distinct, non-zero set of cosmetic cues, so a slot that reads
// the wrong car (or a field that is never copied) cannot look right by accident.
void dressCars(Game& game) {
  Car& a = *game.cars()[0];
  a.v = 12.5; a.vmax = 25.0; a.steer = 0.37; a.brake = 0.5; a.boostMul = 1.75;
  a.monsterT = 0.0; a.spin = 0.9; a.onWall = true;

  Car& b = *game.cars()[1];
  // vmax 0 is the guard arm: a car with no top speed must read spd 0, not inf.
  b.v = 9.0; b.vmax = 0.0; b.steer = -0.62; b.brake = 0.125; b.boostMul = 1.0;
  b.monsterT = 1.5; b.spin = 0.0; b.onWall = false;

  Car& c = *game.cars()[2];
  c.v = 3.25; c.vmax = 26.5; c.steer = 0.11; c.brake = 0.0; c.boostMul = 2.0;
  c.monsterT = 0.0; c.spin = 0.25; c.onWall = false;
}

float carSpd(const Car& c) { return c.vmax != 0 ? (float)(c.v / c.vmax) : 0.0f; }

// ---------------------------------------------------------------------------
// 1. parseIds — the ABI's JSON id arrays. Numbers and strings are DISTINCT
//    identities; anything else in the array, and any non-array text, is dropped
//    rather than decayed into car 0.
// ---------------------------------------------------------------------------
void testParseIds() {
  check(rt::parseIds(nullptr).empty(), "parseIds(nullptr) is empty");
  check(rt::parseIds("").empty(), "parseIds(\"\") is empty");
  check(rt::parseIds("[]").empty(), "parseIds(\"[]\") is empty");
  check(rt::parseIds("not json").empty(), "parseIds ignores unparseable text");
  check(rt::parseIds("{\"0\":1}").empty(), "parseIds ignores a non-array");
  check(rt::parseIds("3").empty(), "parseIds ignores a bare scalar");

  const std::vector<Id> ids = rt::parseIds("[2, \"cpu-bolt\", null, true, [7], {\"a\":1}, 0]");
  check(ids.size() == 3, "parseIds keeps only the numbers and strings, in array order");
  if (ids.size() == 3) {
    check(ids[0] == Id::Num(2), "parseIds: a number id");
    check(ids[1] == Id::Str("cpu-bolt"), "parseIds: a string id");
    check(ids[2] == Id::Num(0), "parseIds: 0 is an id, not an absence");
    check(!(ids[1] == Id::Num(0)), "parseIds keeps string and number identities distinct");
  }
}

// ---------------------------------------------------------------------------
// 1b. parseRoster — ttp_display_build's roster argument.
//
//     THIS IS THE GATE THAT REPLACED A FORMAT. The liveries used to reach the
//     renderer as "track.bin", packed by public/shared/trackBin.js and unpacked
//     by TtpRenderer.cpp, and NOTHING in the tree could see the two disagree —
//     no corpus recorded a track.bin, and the renderer compiles on one machine
//     configuration. The arithmetic lives in libttp-runtime now precisely so a
//     ctest on every leg can run it, and this is that ctest.
//
//     A behavioural gate, like its neighbours: these assertions encode what the
//     JS writer did, transcribed from it, and are not parity evidence.
// ---------------------------------------------------------------------------
void testParseRoster() {
  check(rt::parseRoster(nullptr).ids.empty(), "parseRoster(nullptr) is empty");
  check(rt::parseRoster("not json").ids.empty(), "parseRoster ignores unparseable text");
  check(rt::parseRoster("[]").ids.empty(), "an empty roster is legal — it is the lobby preview");
  check(rt::parseRoster("[{\"name\":\"Ada\"}]").ids.empty(),
        "a slot with no id is dropped: it could never be matched to a car");

  // The livery: '#rrggbb' -> 0xAABBGGRR, opaque.
  check(rt::liveryABGR("#ff8000") == 0xFF0080FFu, "livery: red/green/blue land in the right bytes");
  check(rt::liveryABGR("") == 0xFF888888u, "an ABSENT colour is the grey the JS default was");
  check(rt::liveryABGR("#zzzzzz") == 0xFF000000u,
        "an UNPARSEABLE colour is opaque black — parseInt's NaN through the old bit-ops");

  // The plate table wraps, exactly as the shell's own modulo did.
  check(rt::plateY(0) == 0.157f && rt::plateY(1) == 0.245f, "plateY is per MODEL");
  check(rt::plateY(4) == rt::plateY(0), "plateY wraps past the last model");
  check(rt::plateY(-1) == rt::plateY(3), "…and a negative index wraps forward, never off the front");

  const rt::Roster r = rt::parseRoster(
      "[{\"id\":2,\"name\":\"Ada\",\"carIndex\":1,\"color\":\"#112233\"},"
      " {\"id\":\"ai-0\",\"name\":\"Bartholomew\",\"carIndex\":0,\"color\":\"#445566\"},"
      " {\"id\":7}]");
  check(r.ids.size() == 3 && r.cars.size() == 3, "ids and cars are the same list, in slot order");
  if (r.ids.size() == 3 && r.cars.size() == 3) {
    check(r.ids[0] == Id::Num(2) && r.ids[1] == Id::Str("ai-0"),
          "a slot id keeps its JSON-scalar identity");
    check(std::string(r.cars[0].name) == "Ada", "a short name fills the plate and stops");
    check(std::string(r.cars[1].name) == "Bartholo", "a long name is cut to the plate's 8 chars");
    check(r.cars[0].plateY == rt::plateY(1), "the plate height follows the car's MODEL");
    check(r.cars[2].colorABGR == 0xFF888888u && std::string(r.cars[2].name).empty(),
          "a slot with only an id still builds — grey, no plate text, first model");
  }

  // The plate is filled from UTF-16 code UNITS, which is what charCodeAt gave
  // the retired JS writer. It matters for exactly one input: an astral
  // character is two units, and the low one masks to NUL, ending the plate.
  const rt::Roster emoji = rt::parseRoster("[{\"id\":1,\"name\":\"\\ud83d\\ude00ab\"}]");
  check(emoji.cars.size() == 1 && std::string(emoji.cars[0].name) == "=",
        "an emoji eats two plate slots and terminates it, as it always has");
}

// ---------------------------------------------------------------------------
// 2. atRest — the pose survives, every motion cue dies. This is the whole
//    definition of a "held" car (ttp_display_hold).
// ---------------------------------------------------------------------------
void testAtRest() {
  TtpCarInput c;
  std::memset(&c, 0, sizeof c);
  c.pos = {1.5f, 2.25f, -3.75f};
  c.forward = {0.5f, 0.0f, 0.5f};
  c.up = {0.0f, 1.0f, 0.0f};
  c.spd = 0.8f; c.steer = -0.4f; c.brake = 0.6f; c.boostMul = 1.9f;
  c.monster = 1.0f; c.spin = 2.5f; c.scrub = 1.0f;

  rt::atRest(c);

  check(c.pos.x == 1.5f && c.pos.y == 2.25f && c.pos.z == -3.75f, "atRest keeps the position");
  check(c.forward.x == 0.5f && c.up.y == 1.0f, "atRest keeps the orientation");
  checkF(c.spd, 0.0f, "atRest zeroes spd");
  checkF(c.steer, 0.0f, "atRest zeroes steer");
  checkF(c.brake, 0.0f, "atRest zeroes brake");
  checkF(c.spin, 0.0f, "atRest zeroes spin");
  checkF(c.scrub, 0.0f, "atRest zeroes scrub");
  checkF(c.boostMul, 1.0f, "atRest returns boostMul to 1, not 0");
  checkF(c.monster, 1.0f, "atRest keeps the monster transform (a shape, not a motion cue)");
}

// ---------------------------------------------------------------------------
// 3. The car block: ROSTER order, by identity. The renderer bakes each slot's
//    model and livery at scene build, so slot i must keep carrying the car the
//    roster named — `cars()` is insertion order and is deliberately not it.
// ---------------------------------------------------------------------------
void testCarsAndRoster(const GameTrack& track) {
  Game game(threePlayers(), track, nullptr);
  dressCars(game);
  const Car& c0 = *game.cars()[0];
  const Car& c1 = *game.cars()[1];
  const Car& c2 = *game.cars()[2];

  DisplayState d = freshState();
  // Deliberately NOT insertion order, and with a seat whose car is absent.
  d.roster = {P2, P0, GHOST, P1};



  const TtpFrameInput* h = rt::buildFrame(d, &game, DT, caseAspect(d), caseWidthFrac(d));
  const TtpCarInput* cars = ttp_frame_cars(h);

  checkU(h->version, TTP_FRAME_INPUT_VERSION, "header version");
  checkF(h->dt, DT, "header dt");
  checkU(h->carCount, 4, "carCount is the ROSTER size, not the field size");
  checkU(h->viewCount, 1, "no cells means one overview view");
  checkU(h->boxCount, (uint32_t)game.boxes().size(), "boxCount");
  checkU(h->burstCount, 0, "no bursts queued");
  checkU(h->flags, TTP_FRAME_DIVIDERS, "the cell dividers are on unless a shell says otherwise");
  checkU(h->hudCount, 0, "no cells means no cell overlays");
  checkF(h->uiScale, 1.0f, "uiScale defaults to 1, so a shell that never sets it still draws");
  checkF(h->sceneT, DT, "sceneT accumulates dt");

  checkCar(cars[0], c2, "slot 0 (cpu-bolt)");
  checkCar(cars[1], c0, "slot 1 (0)");
  checkEmptySlot(cars[2], "slot 2 (no-such-car)");
  checkCar(cars[3], c1, "slot 3 (1)");

  // The mapping is by identity, so it must survive the field being reordered
  // under a fixed roster.
  check(!sameVec(cars[0].pos, c0.pose.pos) || !sameVec(cars[1].pos, c2.pose.pos),
        "the roster mapping is not simply insertion order");

  // No bound session: every slot empty, no props, still exactly one view.
  DisplayState e = freshState();
  e.roster = {P0, P1};
  const TtpFrameInput* n = rt::buildFrame(e, nullptr, DT, caseAspect(e), caseWidthFrac(e));
  checkU(n->carCount, 2, "an unbound display still emits a slot per roster entry");
  checkU(n->boxCount, 0, "an unbound display has no boxes");
  checkU(n->bananaCount, 0, "an unbound display has no bananas");
  checkU(n->rocketCount, 0, "an unbound display has no rockets");
  checkU(n->viewCount, 1, "an unbound display draws one overview");
  checkEmptySlot(ttp_frame_cars(n)[0], "unbound slot 0");
  checkEmptySlot(ttp_frame_cars(n)[1], "unbound slot 1");
}

// ---------------------------------------------------------------------------
// 4. Hold — the pause overlay and the end-of-race fast-forward. While the sizes
//    match the last-read field is re-emitted verbatim; when a seat expires
//    mid-pause the roster shrinks, the memcpy cannot fire, and the LIVE read has
//    to be put at rest instead or the frozen field spins its wheels behind the
//    overlay.
// ---------------------------------------------------------------------------
void testHold(const GameTrack& track) {
  Game game(threePlayers(), track, nullptr);
  dressCars(game);

  DisplayState d = freshState();
  d.roster = {P0, P1, GHOST, P2};

  const TtpFrameInput* h = rt::buildFrame(d, &game, DT, caseAspect(d), caseWidthFrac(d));
  std::vector<TtpCarInput> live(ttp_frame_cars(h), ttp_frame_cars(h) + h->carCount);
  check(d.held.size() == 4, "a live frame keeps the field, so a later hold has something to hold");

  // Move the world on. A held frame must not notice.
  Car& a = *game.cars()[0];
  a.pose.pos = Vec3(a.pose.pos.x + 25.0, a.pose.pos.y + 4.0, a.pose.pos.z - 9.0);
  a.v = 24.0;
  a.steer = -0.9;
  a.spin = 3.0;

  d.hold = true;
  h = rt::buildFrame(d, &game, DT, caseAspect(d), caseWidthFrac(d));
  checks++;
  if (std::memcmp(ttp_frame_cars(h), live.data(), live.size() * sizeof(TtpCarInput)) != 0) {
    failures++;
    std::fprintf(stderr, "FAIL a held frame re-emits the last-read field verbatim\n");
  }

  // A seat expires mid-pause: its car is forfeit and the scene rebuilds with a
  // shorter roster, so the sizes no longer match.
  d.roster = {P0, P1, P2};
  h = rt::buildFrame(d, &game, DT, caseAspect(d), caseWidthFrac(d));
  const TtpCarInput* held = ttp_frame_cars(h);
  checkU(h->carCount, 3, "the shortened roster is what the frame carries");
  check(sameVec(held[0].pos, a.pose.pos),
        "a hold that outlived its field falls back to the LIVE pose");
  checkF(held[0].spd, 0.0f, "…with speed at rest");
  checkF(held[0].steer, 0.0f, "…with steer at rest");
  checkF(held[0].spin, 0.0f, "…with spin at rest");
  checkF(held[0].brake, 0.0f, "…with brake at rest");
  checkF(held[0].scrub, 0.0f, "…with scrub at rest");
  checkF(held[0].boostMul, 1.0f, "…and boostMul back at 1");
  check(d.held.size() == 3, "the re-read field replaces the stale one");

  // Releasing the hold goes straight back to the live read.
  d.hold = false;
  h = rt::buildFrame(d, &game, DT, caseAspect(d), caseWidthFrac(d));
  checkCar(ttp_frame_cars(h)[0], a, "released hold, slot 0");
}

// ---------------------------------------------------------------------------
// 5. The single overview view: all four camera modes, both fog arms, the
//    aspect, and the near/far planes that differ between the fitted rigs and the
//    free inspector cam.
// ---------------------------------------------------------------------------
void testOverviewViews(const GameTrack& track) {
  Game game(threePlayers(), track, nullptr);
  DisplayState d = freshState();
  d.roster = {P0, P1, P2};
  const Framing& f = d.framing;
  const float aspect = 1920.0f / 1080.0f;

  // --- STILL: the fitted whole-track iso view, held still.
  {
    d.camMode = TTP_CAM_STILL;
    const float before = d.orbitAngle;
    const TtpFrameInput* h = rt::buildFrame(d, &game, DT, caseAspect(d), caseWidthFrac(d));
    float want[16];
    rt::lookAtWorld(want, f.center + f.ovOffset, f.center, V3{0, 1, 0});
    checkView(ttp_frame_views(h)[0], want, rt::OVERVIEW_FOV, aspect, rt::OV_NEAR, rt::OV_FAR,
              f.ovFogNear, f.ovFogFar, "still");
    checkF(d.orbitAngle, before, "the still view does not advance the turntable");
  }

  // --- ORBIT: the turntable, at the overview ring.
  {
    d.camMode = TTP_CAM_ORBIT;
    const float want_angle = d.orbitAngle + rt::LOBBY_ORBIT_SPEED * DT;
    const TtpFrameInput* h = rt::buildFrame(d, &game, DT, caseAspect(d), caseWidthFrac(d));
    checkF(d.orbitAngle, want_angle, "orbit advances by LOBBY_ORBIT_SPEED * dt");
    const V3 eye = {f.center.x + std::cos(want_angle) * f.ovRadius, f.center.y + f.ovHeight,
                    f.center.z + std::sin(want_angle) * f.ovRadius};
    float want[16];
    rt::lookAtWorld(want, eye, f.center, V3{0, 1, 0});
    checkView(ttp_frame_views(h)[0], want, rt::OVERVIEW_FOV, aspect, rt::OV_NEAR, rt::OV_FAR,
              f.ovFogNear, f.ovFogFar, "orbit");
  }

  // --- BBOX: the lobby's perimeter sweep, with its OWN fog band.
  {
    d.camMode = TTP_CAM_BBOX;
    const float want_angle = d.orbitAngle + rt::BBOX_ORBIT_SPEED * DT;
    const TtpFrameInput* h = rt::buildFrame(d, &game, DT, caseAspect(d), caseWidthFrac(d));
    checkF(d.orbitAngle, want_angle, "bbox advances by BBOX_ORBIT_SPEED * dt");
    const V3 eye = {f.center.x + std::cos(want_angle) * f.bbAx, f.center.y + f.bbHeight,
                    f.center.z + std::sin(want_angle) * f.bbAz};
    float want[16];
    rt::lookAtWorld(want, eye, f.center, V3{0, 1, 0});
    checkView(ttp_frame_views(h)[0], want, rt::OVERVIEW_FOV, aspect, rt::OV_NEAR, rt::OV_FAR,
              f.bbFogNear, f.bbFogFar, "bbox");
    check(f.bbFogNear != f.ovFogNear,
          "premise: the lobby band really does differ from the overview band");
  }

  // --- FREE: the shell drives, and the near plane comes right in.
  {
    d.camMode = TTP_CAM_FREE;
    d.freeEye = {40.0f, 18.0f, -5.5f};
    d.freeTarget = {12.5f, 1.5f, -30.25f};
    const float before = d.orbitAngle;
    const TtpFrameInput* h = rt::buildFrame(d, &game, DT, caseAspect(d), caseWidthFrac(d));
    float want[16];
    rt::lookAtWorld(want, d.freeEye, d.freeTarget, V3{0, 1, 0});
    checkView(ttp_frame_views(h)[0], want, rt::OVERVIEW_FOV, aspect, rt::FREE_NEAR, rt::OV_FAR,
              f.ovFogNear, f.ovFogFar, "free");
    checkF(d.orbitAngle, before, "the free cam does not advance the turntable");
  }

  // --- Fog off: both ends collapse to 0, which is what the renderer reads as
  //     "no fog" (fogFar <= fogNear).
  {
    d.camMode = TTP_CAM_BBOX;
    d.fog = false;
    const TtpFrameInput* h = rt::buildFrame(d, &game, DT, caseAspect(d), caseWidthFrac(d));
    checkF(ttp_frame_views(h)[0].fogNear, 0.0f, "fog off: near");
    checkF(ttp_frame_views(h)[0].fogFar, 0.0f, "fog off: far");
    d.fog = true;
  }

  // --- A zero-height surface must not divide by it.
  {
    d.camMode = TTP_CAM_STILL;
    d.width = 800;
    d.height = 0;
    const TtpFrameInput* h = rt::buildFrame(d, &game, DT, caseAspect(d), caseWidthFrac(d));
    checkF(ttp_frame_views(h)[0].aspect, 800.0f, "a zero-height surface falls back to height 1");
  }
}

// ---------------------------------------------------------------------------
// 6. Split-screen: one chase camera per cell, the cell aspect that has to match
//    the renderer's own viewport split, and the fallback for a cell whose car is
//    not in this scene.
// ---------------------------------------------------------------------------
void testRaceViews(const GameTrack& track) {
  Game game(threePlayers(), track, nullptr);
  dressCars(game);
  const Car& c0 = *game.cars()[0];
  const Car& c2 = *game.cars()[2];

  DisplayState d = freshState();
  d.roster = {P2, P0, GHOST, P1};
  d.cells = {P0, P2};

  const uint32_t cols = ttp_grid_cols(2, d.width, d.height);
  const uint32_t rows = (2 + cols - 1) / cols;
  const float cellAspect = (float)(d.width / cols) / (float)(d.height / rows);
  const float cellWidthFrac =
      (float)(d.width / cols) / ((16.0f / 9.0f) * (float)(d.height ? d.height : 1));

  // The reference rig: the same spring, fed the same poses in the same order.
  ChaseCam refA, refC;
  const TtpFrameInput* h = nullptr;
  for (int frame = 0; frame < 4; frame++) {
    h = rt::buildFrame(d, &game, DT, caseAspect(d), caseWidthFrac(d));
    refA.update(c0.pose, carSpd(c0), DT);
    refC.update(c2.pose, carSpd(c2), DT);

    const TtpViewInput* views = ttp_frame_views(h);
    checkU(h->viewCount, 2, "one view per cell");
    float wantA[16], wantC[16];
    rt::lookAtWorld(wantA, refA.pos, refA.target, rt::v3(c0.pose.up));
    rt::lookAtWorld(wantC, refC.pos, refC.target, rt::v3(c2.pose.up));
    checkView(views[0], wantA, rt::cellFov(refA.fov, cellAspect, cellWidthFrac), cellAspect, rt::CAM_NEAR, rt::CAM_FAR,
              d.framing.raceFogNear, d.framing.raceFogFar, "cell 0");
    checkView(views[1], wantC, rt::cellFov(refC.fov, cellAspect, cellWidthFrac), cellAspect, rt::CAM_NEAR, rt::CAM_FAR,
              d.framing.raceFogNear, d.framing.raceFogFar, "cell 1");
  }
  check(refA.pos.x != 0 || refA.pos.z != 0, "premise: the chase rig actually moved off the origin");
  check(d.framing.raceFogNear == rt::RACE_FOG_NEAR,
        "racing cells run the fixed race band, not a track-sized one");

  // Cells are ORDER, not identity-sorted: swapping them swaps the views, and
  // each cell keeps its own spring across the swap (keyed by car id).
  {
    d.cells = {P2, P0};
    h = rt::buildFrame(d, &game, DT, caseAspect(d), caseWidthFrac(d));
    refA.update(c0.pose, carSpd(c0), DT);
    refC.update(c2.pose, carSpd(c2), DT);
    float wantC[16];
    rt::lookAtWorld(wantC, refC.pos, refC.target, rt::v3(c2.pose.up));
    checkMat(ttp_frame_views(h)[0].world, wantC, "swapped cells put cpu-bolt in cell 0");
    check(d.chase.size() == 2, "one spring per cell car, keyed by id");
  }

  // A cell whose car is not in this scene's roster: no spring has ever been
  // seeded for it, so it gets the unseeded rig rather than a camera pointed at
  // whatever happens to be at the origin — and the OTHER cell still races.
  {
    DisplayState m = freshState();
    m.roster = {P0, P1, P2};
    m.cells = {P0, Id::Str("stranger")};
    const TtpFrameInput* f = rt::buildFrame(m, &game, DT, caseAspect(m), caseWidthFrac(m));
    checkU(f->viewCount, 2, "an unknown cell still occupies its cell");
    ChaseCam unseeded;
    float want[16];
    rt::lookAtWorld(want, unseeded.pos, unseeded.target, V3{0, 1, 0});
    checkMat(ttp_frame_views(f)[1].world, want, "an unknown cell gets the unseeded rig");
    checkF(ttp_frame_views(f)[1].fov,
         rt::cellFov(rt::BASE_FOV, caseAspect(m), caseWidthFrac(m)),
         "…at the base FOV, through the cell lens");
  }

  // …but if NO cell has a car in this scene, fall back to the overview
  // entirely: this is reachable whenever the cells are set before the scene
  // holding those cars has finished building.
  {
    DisplayState m = freshState();
    m.roster = {P0, P1, GHOST};
    m.cells = {GHOST};
    const TtpFrameInput* f = rt::buildFrame(m, &game, DT, caseAspect(m), caseWidthFrac(m));
    checkU(f->viewCount, 1, "a cell list with no car in the field falls back to the overview");
    checkF(ttp_frame_views(f)[0].fov, rt::OVERVIEW_FOV, "…which is the overview rig");
    checkF(ttp_frame_views(f)[0].fogNear, m.framing.ovFogNear, "…on the overview fog band");
  }
}

// ---------------------------------------------------------------------------
// 7. The props: box availability, the banana liveness filter, the rocket wrap,
//    the burst queue drain and the scene clock.
// ---------------------------------------------------------------------------
void testProps(const BuiltRaceTrack& base) {
  // A fresh track, with two authored bananas spliced in. Authored bananas
  // RESPAWN, which is the only way a banana is in the list but not yet live —
  // exactly the state the liveness filter exists for.
  BuiltRaceTrack bt;
  std::string err;
  if (!build_race_track_by_id("tidepool", 3, 42u, bt, err)) {
    std::fprintf(stderr, "FAIL rebuild tidepool: %s\n", err.c_str());
    failures++;
    return;
  }
  check(bt.game.bananas.empty(), "premise: the catalogue track carries no bananas of its own");
  check(!base.game.boxes.empty(), "premise: the catalogue track carries item boxes");

  const double BANANA_S = 60.0, BANANA_LAT = 0.25;
  const double SPARE_S = 160.0, SPARE_LAT = -0.5;
  bt.game.bananas.push_back(BananaRt{0, BANANA_S, BANANA_LAT, Id::None(), 0, true, 0, false});
  bt.game.bananas.push_back(BananaRt{0, SPARE_S, SPARE_LAT, Id::None(), 0, true, 0, false});

  Game game(threePlayers(), bt.game, nullptr);

  // Park one car on an item box and another on the first banana, and hold them
  // there while the sim runs: a car with no brake input drives itself at full
  // throttle, and item boxes are inert until LAUNCH_GATE (1.5 s) has passed, so
  // "place and step once" collects nothing.
  const BoxRt box0 = game.boxes()[0];
  Car& collector = *game.cars()[0];
  Car& slipper = *game.cars()[1];
  bool collected = false;
  for (int i = 0; i < 300 && !collected; i++) {
    collector.totalS = box0.s;
    collector.lat = box0.lat;
    collector.v = 0;
    slipper.totalS = BANANA_S;
    slipper.lat = BANANA_LAT;
    slipper.v = 0;
    game.update(DT_MS);
    collected = game.boxes()[0].cooldown > 0;
  }
  check(collected, "premise: the parked car collected the box it is sitting on");

  std::vector<uint32_t> wantBoxes;
  uint32_t taken = 0;
  for (const BoxRt& b : game.boxes()) {
    const uint32_t state = b.cooldown <= 0 ? 1u : 0u;
    if (!state) taken++;
    wantBoxes.push_back(state);
  }
  check(taken > 0, "premise: at least one box was collected, so both arms are on the path");
  check(taken < wantBoxes.size(), "premise: not every box was collected");

  check(game.bananas().size() == 2, "premise: both authored bananas are still in the list");
  uint32_t liveBananas = 0;
  for (const BananaRt& b : game.bananas()) {
    if (game.elapsed() < b.liveAt) continue;
    liveBananas++;
  }
  checkU(liveBananas, 1, "premise: the driven-over banana is respawning, the spare is live");

  // Rockets are staged AFTER the last update, so their arclength is exactly what
  // was handed in — including the unwrapped values stepRockets legitimately
  // produces, which the frame has to wrap before the renderer places them.
  const double len = game.length();
  game.stageRocket(len + 12.5, 0.75, 9.0, P0);
  game.stageRocket(-3.0, -1.25, 9.0, P1);

  DisplayState d = freshState();
  d.roster = {P0, P1, P2};
  d.bursts.push_back(TtpBurstInput{-1, 42.5f, 0.5f});
  d.bursts.push_back(TtpBurstInput{2, 0.0f, 0.0f});

  const TtpFrameInput* h = rt::buildFrame(d, &game, DT, caseAspect(d), caseWidthFrac(d));

  checkU(h->boxCount, (uint32_t)wantBoxes.size(), "boxCount");
  const uint32_t* boxes = ttp_frame_box_states(h);
  bool boxesOk = true;
  for (size_t i = 0; i < wantBoxes.size(); i++) {
    if (boxes[i] != wantBoxes[i]) boxesOk = false;
  }
  check(boxesOk, "a box reads available exactly while its respawn cooldown has run out");

  checkU(h->bananaCount, 1, "an unarmed banana is not on the track yet and is not drawn");
  checkF(ttp_frame_bananas(h)[0].s, (float)SPARE_S, "the live banana is compacted to index 0");
  checkF(ttp_frame_bananas(h)[0].lat, (float)SPARE_LAT, "…with its lateral offset");

  checkU(h->rocketCount, 2, "rocketCount");
  checkF(ttp_frame_rockets(h)[0].s, (float)ttp::wrap_s(len + 12.5, len), "a rocket past the line wraps");
  checkF(ttp_frame_rockets(h)[0].lat, 0.75f, "rocket 0 lateral");
  checkF(ttp_frame_rockets(h)[1].s, (float)ttp::wrap_s(-3.0, len), "a rocket behind the line wraps");
  checkF(ttp_frame_rockets(h)[1].lat, -1.25f, "rocket 1 lateral");
  check(ttp_frame_rockets(h)[0].s != (float)(len + 12.5), "premise: the wrap actually moved it");

  checkU(h->burstCount, 2, "both queued detonations are on this frame");
  check(ttp_frame_bursts(h)[0].car == -1 && ttp_frame_bursts(h)[0].s == 42.5f &&
            ttp_frame_bursts(h)[0].lat == 0.5f,
        "a whiff burst carries its track position");
  check(ttp_frame_bursts(h)[1].car == 2, "a hit burst carries its victim's slot");
  check(d.bursts.empty(), "the burst queue is drained by the frame that carries it");

  checkF(h->sceneT, DT, "the scene clock starts at the first dt");
  h = rt::buildFrame(d, &game, DT, caseAspect(d), caseWidthFrac(d));
  checkU(h->burstCount, 0, "a drained queue does not repeat itself");
  checkF(h->sceneT, DT + DT, "the scene clock accumulates");
}

// ---------------------------------------------------------------------------
// 9. The cell overlay — the steer bar's per-cell block (TtpCellHudInput).
//
//    This is the one place a HUD value is assembled in C++ at all, and the two
//    fields in it are both places a plausible-looking mistake is invisible on
//    screen. `steer` must be the RAW tilt: every other steer number in this file
//    carries STEER_SIGN, because the front wheels and the body lean have to turn
//    the way the car turns, and a bar that took the same treatment would simply
//    lean the wrong way — which reads as "the phone is mis-calibrated", not as a
//    renderer bug. `car` must be the ROSTER SLOT, because that is what indexes
//    the liveries the renderer baked; the cell INDEX is a different number that
//    happens to be equal in the easy case.
// ---------------------------------------------------------------------------
void testCellHud(const GameTrack& track) {
  Game game(threePlayers(), track, nullptr);
  dressCars(game);
  const Car& c0 = *game.cars()[0];
  const Car& c2 = *game.cars()[2];

  check(ttp::STEER_SIGN != 1, "premise: raw and signed steer are actually different numbers");
  check(c0.steer != 0 && c2.steer != 0, "premise: both cells' cars are steering");

  DisplayState d = freshState();
  d.uiScale = 2.0f;
  // Cell order and roster order deliberately disagree, and the roster carries a
  // seat with no car: cell 0 is roster slot 1, cell 1 is roster slot 0.
  d.roster = {P2, P0, GHOST, P1};
  d.cells = {P0, P2};

  {
    const TtpFrameInput* h = rt::buildFrame(d, &game, DT, caseAspect(d), caseWidthFrac(d));
    const TtpCellHudInput* hud = ttp_frame_hud(h);
    checkU(h->hudCount, 2, "one cell overlay per cell");
    checkF(h->uiScale, 2.0f, "uiScale reaches the frame");
    check(hud[0].car == 1, "cell 0's car is its ROSTER SLOT, not its cell index");
    check(hud[1].car == 0, "cell 1's car is its roster slot");
    checkF(hud[0].steer, (float)c0.steer, "the bar carries RAW tilt");
    checkF(hud[1].steer, (float)c2.steer, "…for every cell");
    check(hud[0].steer != ttp_frame_cars(h)[1].steer,
          "the bar's steer is NOT the car cue's — that one carries STEER_SIGN");
    checkU(hud[0].flags, TTP_HUD_STEER_BAR, "the bar is drawn by default");
    checkU(hud[1].flags, TTP_HUD_STEER_BAR, "…in every cell");
  }

  // A centred card (FINISHED, or the reconnect QR) owns a cell: that cell's bar
  // goes, and ONLY that cell's — the mask is per cell, in cell order.
  {
    d.cardMask = 0x2;
    const TtpFrameInput* h = rt::buildFrame(d, &game, DT, caseAspect(d), caseWidthFrac(d));
    const TtpCellHudInput* hud = ttp_frame_hud(h);
    checkU(hud[0].flags, TTP_HUD_STEER_BAR, "a card over cell 1 leaves cell 0 alone");
    checkU(hud[1].flags, 0, "a card over cell 1 takes cell 1's bar");
    check(hud[1].car == 0, "…but the cell still names its car");
    d.cardMask = 0;
  }

  // Held (the pause overlay, the end-of-race fast-forward): the field is at
  // rest, so the bars are centred with it. A bar still showing full lock behind
  // the pause glass says the player is steering, which they are not.
  {
    d.hold = true;
    const TtpFrameInput* h = rt::buildFrame(d, &game, DT, caseAspect(d), caseWidthFrac(d));
    const TtpCellHudInput* hud = ttp_frame_hud(h);
    checkF(hud[0].steer, 0.0f, "a held field centres its bars");
    checkU(hud[0].flags, TTP_HUD_STEER_BAR, "…without hiding them");
    d.hold = false;
    d.held.clear();
  }

  // ?dividers=0 — the seams go, the bars stay.
  {
    d.dividers = false;
    const TtpFrameInput* h = rt::buildFrame(d, &game, DT, caseAspect(d), caseWidthFrac(d));
    checkU(h->flags & TTP_FRAME_DIVIDERS, 0, "the divider flag follows the toggle");
    checkU(h->hudCount, 2, "…and takes nothing else with it");
    d.dividers = true;
  }

  // A cell naming a car this scene has never heard of: no slot, so no livery to
  // wear and nothing to draw a bar for. The OTHER cell is unaffected.
  {
    DisplayState m = freshState();
    m.roster = {P0, P1, P2};
    m.cells = {P0, Id::Str("stranger")};
    const TtpFrameInput* h = rt::buildFrame(m, &game, DT, caseAspect(m), caseWidthFrac(m));
    const TtpCellHudInput* hud = ttp_frame_hud(h);
    checkU(h->hudCount, 2, "an unknown cell still occupies its cell");
    check(hud[1].car < 0, "…with no roster slot behind it");
    checkF(hud[1].steer, 0.0f, "…and no tilt to show");
    check(hud[0].car == 0, "the known cell is untouched");
  }

  // A roster seat whose car has left the field (or has not been added yet): the
  // slot is real — the renderer baked a livery into it — but there is no car to
  // read a tilt off.
  {
    DisplayState m = freshState();
    m.roster = {P0, GHOST};
    m.cells = {P0, GHOST};
    const TtpFrameInput* h = rt::buildFrame(m, &game, DT, caseAspect(m), caseWidthFrac(m));
    const TtpCellHudInput* hud = ttp_frame_hud(h);
    check(hud[1].car == 1, "a car-less roster seat still names its slot");
    checkF(hud[1].steer, 0.0f, "…and reads centred");
  }

  // No cell has a car in this scene, so the views collapse to the single
  // overview — and a bar anchored to a cell that is not being drawn would be
  // hanging in the middle of it.
  {
    DisplayState m = freshState();
    m.roster = {P0, P1, GHOST};
    m.cells = {GHOST};
    const TtpFrameInput* h = rt::buildFrame(m, &game, DT, caseAspect(m), caseWidthFrac(m));
    checkU(h->viewCount, 1, "premise: this is the overview fallback");
    checkU(h->hudCount, 0, "the overview carries no cell overlays");
  }
}

// ---------------------------------------------------------------------------
// 10. The HUD block (ttp/hud.h) — the ASSEMBLY around hudSlot.
//
//     What the per-car RULE answers is hud_check's, replayed against the
//     JS-recorded ui-corpus; nothing here re-litigates it. What is left is
//     everything the corpus cannot reach because it carries values instead of a
//     race: which car lands in which slot, what a slot no car claims contains,
//     the header a shell strides the array with, and the scratch the block is
//     assembled into being REUSED across rosters of different lengths.
// ---------------------------------------------------------------------------
void checkHudSlot(const TtpHudSlot& got, const Game& g, const Car& c, const std::string& what) {
  const TtpHudSlot want =
      rt::hudSlot((int32_t) c.rank, (int32_t) g.displayLap(c), (int32_t) g.totalLaps(),
                  c.item, c.finished, !c.finishTimeNull, c.finishTime);
  checks++;
  if (std::memcmp(&got, &want, sizeof want) != 0) {
    failures++;
    std::fprintf(stderr,
                 "FAIL %s: place %d/%d lap %d/%d laps %d/%d item %d/%d flags %u/%u t %g/%g\n",
                 what.c_str(), got.place, want.place, got.lap, want.lap, got.totalLaps,
                 want.totalLaps, got.item, want.item, got.flags, want.flags, got.finishTime,
                 want.finishTime);
  }
}

void testHud(const GameTrack& track) {
  Game game(threePlayers(), track, nullptr);
  Car& a = *game.cars()[0];
  Car& b = *game.cars()[1];
  Car& c = *game.cars()[2];
  // Distinct on every field a slot carries, so a slot reading the wrong car
  // cannot look right by accident.
  a.rank = 3; a.lap = 1.5; a.item = "banana";
  b.rank = 1; b.lap = 3.0; b.item = "rocket";
  b.finished = true; b.finishTimeNull = false; b.finishTime = 42.5;
  c.rank = 2; c.lap = 2.25; c.item = "";
  check(a.rank != c.rank, "premise: the cars really do disagree about their places");

  DisplayState d = freshState();
  // Deliberately NOT insertion order, and with a seat whose car is absent —
  // the same fixture the frame builder is driven with above.
  d.roster = {P2, P0, GHOST, P1};

  const TtpHudBlock* h = rt::buildHud(d, &game);
  const TtpHudSlot* s = ttp_hud_slots(h);

  checkU(h->version, TTP_HUD_BLOCK_VERSION, "header version");
  checkU(h->slotCount, 4, "slotCount is the ROSTER size, not the field size");
  checkU(h->stride, (uint32_t) sizeof(TtpHudSlot),
         "the header carries the stride, so a shell can walk the array without this struct");
  checkU(h->flags, 0, "header flags are reserved and zero");

  checkHudSlot(s[0], game, c, "slot 0 (cpu-bolt)");
  checkHudSlot(s[1], game, a, "slot 1 (0)");
  checkEmptyHudSlot(s[2], "slot 2 (no-such-car)");
  checkHudSlot(s[3], game, b, "slot 3 (1)");
  check(s[0].place == c.rank && s[1].place == a.rank,
        "slots map by ROSTER position, not the sim's insertion order");
  checkU(s[0].flags & TTP_HUD_SLOT_LIVE, TTP_HUD_SLOT_LIVE, "a claimed slot is LIVE");
  checkU(s[2].flags & TTP_HUD_SLOT_LIVE, 0, "a car-less seat comes back without LIVE");
  // Not the gate itself (that is hud_check's, against the corpus) — only that
  // the three facts behind it reach the block at all.
  check(s[1].item == TTP_ITEM_BANANA, "a live slot carries its held item's code");
  check(s[3].item == TTP_ITEM_NONE, "a finished car's slot reads empty");
  checkU(s[3].flags, TTP_HUD_SLOT_LIVE | TTP_HUD_SLOT_FINISHED | TTP_HUD_SLOT_TIMED,
         "…with the finish flags, and a time that is a number");

  // No bound session: a slot per seat, none of them live. This is the display
  // between scenes, and it must not answer with the last race's places.
  {
    const TtpHudBlock* n = rt::buildHud(d, nullptr);
    checkU(n->slotCount, 4, "an unbound display still emits a slot per roster entry");
    for (uint32_t i = 0; i < n->slotCount; i++)
      checkEmptyHudSlot(ttp_hud_slots(n)[i], "unbound slot " + std::to_string(i));
  }

  // The scratch is grown and never shrunk, so a roster that gets longer and
  // then shorter is where a stale slot would survive: the short block must
  // report the short count and re-resolve every slot in it, including the ones
  // a live car held one build ago.
  {
    DisplayState m = freshState();
    m.roster = {P0, P1, P2, GHOST, GHOST, GHOST};
    const TtpHudBlock* big = rt::buildHud(m, &game);
    checkU(big->slotCount, 6, "the long roster");
    const size_t grown = m.hudBlock.size();
    check(grown >= sizeof(TtpHudBlock) + 6 * sizeof(TtpHudSlot), "premise: the scratch grew to fit");
    checkU(ttp_hud_slots(big)[0].flags & TTP_HUD_SLOT_LIVE, TTP_HUD_SLOT_LIVE,
           "premise: slot 0 of the long roster is live");

    m.roster = {GHOST, P1};
    const TtpHudBlock* small = rt::buildHud(m, &game);
    checkU(small->slotCount, 2, "a shorter roster reports the SHORT count");
    check(m.hudBlock.size() == grown, "…out of the same scratch, which is not shrunk");
    checkEmptyHudSlot(ttp_hud_slots(small)[0], "shrunk slot 0");
    checkHudSlot(ttp_hud_slots(small)[1], game, b, "shrunk slot 1");
  }
}

}  // namespace

int main() {
  BuiltRaceTrack bt;
  std::string err;
  if (!build_race_track_by_id("tidepool", 3, 42u, bt, err)) {
    std::fprintf(stderr, "FAIL build tidepool: %s\n", err.c_str());
    return 2;
  }

  testParseIds();
  testParseRoster();
  testAtRest();
  testCarsAndRoster(bt.game);
  testHold(bt.game);
  testOverviewViews(bt.game);
  testRaceViews(bt.game);
  testCellHud(bt.game);
  testHud(bt.game);
  testProps(bt);

  std::printf("frame builder check: %d assertions, %d failures\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
