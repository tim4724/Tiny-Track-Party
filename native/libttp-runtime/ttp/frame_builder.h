// frame_builder — the per-frame TtpFrameInput, assembled straight off the live
// Game, and the display state it is assembled from.
//
// This is the reason the display layer exists at all. The two-module shape
// serialized every car pose and camera matrix through JS on every frame —
// snapshot JSON out of the sim, Float32Array into the renderer. Here the sim and
// the renderer share a heap, so the frame is assembled from `Game::cars()` in
// place and the boundary is one call with a dt.
//
// Lifted verbatim out of runtime/ttp_display.cc. What did NOT come with it is
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

// Everything the display owns that is not the renderer or the platform surface.
struct DisplayState {
    uint32_t width = 1, height = 1;

    int session = 0;                    // bound session handle (0 = draw an empty track)
    std::vector<ScalarId> roster;       // slot order, fixed at build
    std::vector<ScalarId> cells;        // cars owning a split-screen cell, in cell order
    std::map<std::string, ChaseCam> chase;

    bool hold = false;                  // draw the last-read field, at rest
    std::vector<TtpCarInput> held;

    int camMode = CAM_STILL;
    V3 freeEye, freeTarget;
    bool fog = true;
    Framing framing;

    float sceneT = 0;                   // cosmetic clock (see TtpFrameInput.sceneT)
    float orbitAngle = 0;
    std::vector<TtpBurstInput> bursts;  // queued since the last frame
    std::vector<uint8_t> frame;         // TtpFrameInput scratch, reused every frame
};

// Freeze one car: pose kept, every motion cue dropped (see the definition).
void atRest(TtpCarInput& c);

// The ABI's JSON array of scalar ids (a roster, a cell list) as ids.
std::vector<ScalarId> parseIds(const char* json);

// Assemble one frame into d.frame and return its header, which is followed
// CONTIGUOUSLY by the arrays (ttp_render.h). `eng` is the bound session's live
// Game, or nullptr for an empty track. Never returns null; the pointer is valid
// until the next buildFrame on the same state.
// The chase lens for one cell: BASE_FOV is authored VERTICAL, so a shorter cell
// would draw the car smaller. This solves the fov that holds PIXEL SCALE instead,
// making every cell a true crop of the single-player view. Exposed because it is
// part of the shared camera model — the tvOS and Android shells frame with it too.
float cellFov(float fovV, float aspect, float widthFrac);

// `aspect` and `widthFrac` describe the CELL the race cameras render into, and
// are passed in rather than derived because only the renderer knows the rect: it
// letterboxes the grid as ONE piece, so a cell is a tile of the capped picture,
// not of the raw surface. widthFrac is that picture's width against a 16:9 view
// OF THE SAME HEIGHT — the reference the lens is solved against. Both are ignored
// when no car owns a cell; the overview sets its own fov.
TtpFrameInput* buildFrame(DisplayState& d, const Game* eng, float dt,
                          float aspect, float widthFrac);

}  // namespace rt
}  // namespace ttp
