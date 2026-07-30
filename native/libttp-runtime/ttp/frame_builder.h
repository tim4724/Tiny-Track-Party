// frame_builder — the per-frame TtpFrameInput, assembled straight off the live
// Game, and the display state it is assembled from.
//
// This is the reason the display layer exists at all. The two-module shape
// serialized every car pose and camera matrix through JS on every frame —
// snapshot JSON out of the sim, Float32Array into the renderer. Here the sim and
// the renderer share a heap, so the frame is assembled from `Game::cars()` in
// place and the boundary is one call with a dt.
//
// Lifted verbatim out of runtime/ttp_display.cc (DELETED — git history has it;
// its platform half is runtime/ttp_display_web.cc). What did NOT come with it is
// everything that names a platform: the GL context, the TtpRenderer handle and
// the session-handle lookup all stay in the ABI shim beside the extern "C"
// surface. The shim's Display DERIVES from DisplayState, so the state fields
// read the same on both sides of the split.
#pragma once

#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "ttp/camera.h"
#include "ttp/framing.h"
#include "ttp/scalar_id.h"
#include "ttp/vecmath.h"
#include "ttp_render.h"

namespace ttp {

class Game;

namespace rt {

// Camera mode for a surface with no cells. These are the values of the TTP_CAM_*
// macros in runtime/ttp_display.h — the FROZEN C ABI, which this library
// deliberately does not include (it is emscripten-tagged and platform-facing).
//
// The two are tied together by static_asserts at the top of
// runtimetest/frame_check.cc: exactly one binding, in a translation unit EVERY
// leg compiles. They used to sit in the ABI shim, which the build adds only with
// -DFILAMENT_SDK — so no CI leg ever compiled them and a renumbered enum reached
// four green legs before failing on the one dev box with the SDK. The assert
// below is the local half: it freezes these numbers where a reorder would happen.
enum CamMode : int {
    CAM_STILL = 0,  // the fitted whole-track iso view, held still
    CAM_ORBIT = 1,  // turntable: circle the track at the overview radius
    CAM_BBOX  = 2,  // lobby: sweep an ellipse hugging the track's bbox
    CAM_FREE  = 3,  // inspector: the shell drives, via ttp_display_look
};
static_assert(CAM_STILL == 0 && CAM_ORBIT == 1 && CAM_BBOX == 2 && CAM_FREE == 3,
              "CamMode carries the frozen TTP_CAM_* ABI values — do not renumber");

// How fast a steer bar chases the tilt behind it, as an exponential time
// constant in seconds. 50 ms is what the phone puts on its OWN bar
// (controller.css), so the two ends of the same reading lag alike.
constexpr float STEER_BAR_TAU = 0.05f;

// Everything the display owns that is not the renderer or the platform surface.
struct DisplayState {
    // The surface, in its own physical pixels — the only unit this struct
    // speaks. A uiScale lived here until frame ABI v11; see TtpFrameInput.
    uint32_t width = 1, height = 1;

    int session = 0;                    // bound session handle (0 = draw an empty track)
    std::vector<ScalarId> roster;       // slot order, fixed at build
    std::vector<ScalarId> cells;        // cars owning a split-screen cell, in cell order
    std::map<std::string, ChaseCam> chase;

    // Where each cell car's steer bar is actually DRAWN, eased toward the live
    // tilt (STEER_BAR_TAU). Keyed and cleared exactly like `chase`, and for the
    // same reason: it is smoothing state, so a new track or field must not drag
    // the last one's value in. Absent reads as 0, which is the centred bar a
    // car starts at.
    std::map<std::string, float> steerBar;

    // Cell overlay state (TtpCellHudInput). `cardMask` bit i = a centred card
    // owns cell i (finished, or dropped and showing the reconnect QR), which is
    // exactly when its steer bar is hidden. Latched by the shell rather than
    // read per frame: it is a state transition a handful of times a race, and
    // the alternative — the shell describing its cards to C++ every frame — is
    // the serialized-HUD shape this whole layer exists to avoid.
    uint32_t cardMask = 0;
    bool dividers = true;               // ?dividers=0 debug toggle

    bool hold = false;                  // draw the last-read field, at rest
    std::vector<TtpCarInput> held;

    // The ?biome= inspector override: force a biome on every track regardless
    // of its cup, so any track can be compared in any look. Empty = the cup
    // decides (ttp::rt::biome_for_track). Held here rather than in a shell so
    // all three read the same field.
    std::string biome;

    // The asset gallery's showroom (ttp_display_showcase). Latched beside
    // `biome` because it is mostly the same kind of thing — what the next BUILD
    // resolves its theme through (ttp/showcase.h) — but it is read here too:
    // while the field is PARKED (`hold`) the frame carries the showroom's
    // standing exhibits, the two things a race would otherwise have to produce
    // before anyone could look at them (a rocket, the monster rig). Off
    // everywhere on the shipping path.
    bool showcase = false;

    // THE SHIPPING GAME'S RIG, not "no rig". With no cells the only surface
    // this library draws is the LOBBY PREVIEW, and its answer is the bbox
    // sweep; STILL, ORBIT and FREE belong to the gallery and the inspector, and
    // every one of those surfaces pushes what it wants explicitly.
    //
    // It defaulted to CAM_STILL, a mode the game never asks for, and that fails
    // INVISIBLY: a shell that has not found `ttp_display_camera` renders the
    // circuit perfectly and never moves it, so a lobby preview is a photograph
    // and nothing anywhere reports a problem. A default that is one of the real
    // answers costs nothing to override and removes the whole class.
    int camMode = CAM_BBOX;
    V3 freeEye, freeTarget;
    bool fog = true;
    Framing framing;

    float sceneT = 0;                   // cosmetic clock (see TtpFrameInput.sceneT)
    float orbitAngle = 0;
    std::vector<TtpBurstInput> bursts;  // queued since the last frame
    std::vector<uint8_t> frame;         // TtpFrameInput scratch, reused every frame
    // TtpHudBlock scratch (ttp/hud.h), likewise reused. The HUD is a ~6 Hz POLL
    // rather than a per-frame push — the one element that needed 60 Hz, the
    // steer bar, is drawn by the renderer now — so this is refilled far more
    // rarely than `frame`, and for a different reader.
    std::vector<uint8_t> hudBlock;
};

// Freeze one car: pose kept, every motion cue dropped (see the definition).
void atRest(TtpCarInput& c);

// The ABI's JSON array of scalar ids (a roster, a cell list) as ids.
std::vector<ScalarId> parseIds(const char* json);

// WHERE THE CELLS ARE IS THE RENDERER'S ANSWER, not this library's, and there is
// no cellRects here on purpose. A declaration used to sit at this spot claiming
// the opposite — that the rects are a pure function of the surface and the cell
// list, so the body belonged in libttp-runtime where a ctest could reach it. It
// had no definition and no caller, and the premise was wrong: the grid is
// fitted to an aspect band as one piece and centred (TtpRenderer::cellRect), so
// the rect depends on constants only the renderer holds — a cell's SHAPE is a
// rendering decision, where the grid that placed it is a layout one. What
// ships is ttp_display_cell_rects -> TtpRenderer::cellRectTopLeft, and the
// renderer's own steer bar and dividers read the same function.
//
// The cost of leaving the wrong story in a header is not hypothetical: it is
// what let drawOverlay place two HUD elements on the raw surface grid for as
// long as it did, with a comment claiming they came from the shell's rects.

// Assemble one frame into d.frame and return its header, which is followed
// CONTIGUOUSLY by the arrays (ttp_render.h). `eng` is the bound session's live
// Game, or nullptr for an empty track. Never returns null; the pointer is valid
// until the next buildFrame on the same state.
//
// `aspect` describes the CELL the race cameras render into, and comes from the
// renderer because only it knows the grid (it fits it as one piece). It is
// ignored when no car owns a cell; the overview measures the whole surface.
//
// A CELL IS A SMALL SCREEN, NOT A CROP OF A BIG ONE — the whole camera story is
// that one line, and the vertical fov is therefore the rig's authored one in
// every layout. What varies between cells is only their SHAPE, held to
// TtpRenderer's 16:9..21:9 band, and aspect enters at the projection alone: a
// wider cell reveals more world at the sides and changes nothing else.
//
// It used to CROP instead, scaling tan(vFov/2) by the cell's share of the grid's
// height, so a row of cells saw 1/rows of the authored view and the car held its
// PIXEL size across a split. Two layouts of the same player count then framed the
// car completely differently: a 2-player pair is STACKED on a 16:9 surface (2
// rows, half the fov) and SIDE BY SIDE on an ultrawide (1 row, all of it), so the
// car filled its cell in one and sat small in the other — while single player,
// resized through both shapes, never moved. Splitting now does what shrinking the
// window does, which is what a player reads it as.
TtpFrameInput* buildFrame(DisplayState& d, const Game* eng, float dt, float aspect);

}  // namespace rt
}  // namespace ttp
