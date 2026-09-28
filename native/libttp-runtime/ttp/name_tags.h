// name_tags — where each split-screen cell shows the other cars' names.
//
// A tag floats over every other car in your cell, CPU included. The TEXT is drawn by the
// shell's UI toolkit at the panel's native resolution, because the renderer's
// buffer is scaled down under load (ttp/render_scale.h) and type rendered into
// it goes soft exactly on the box that needs it most. So this decides WHERE and
// HOW STRONGLY, per frame, and the shell draws what it is told.
//
// Read off the frame the renderer was just handed, so a tag is projected
// through the same camera and the same car pose as the picture under it. A
// shell that draws the tag in the same frame it presents that picture keeps the
// two together; one that projected on its own clock would trail its car.
//
// A cell never tags the car it follows, and HIDES the tag of a car the other
// cars cover: each car is a box, and a tag goes when every ray from the camera to
// a handful of points on its car is blocked, so a car half behind a truck keeps
// its name. A monster truck the renderer is ghosting in that cell
// (ttp_monster_ghosted) is see-through and blocks nothing. The track itself is
// NOT an occluder: a car behind a hill or a wall still shows its tag.
#pragma once

#include <cstdint>
#include <vector>

#include "ttp_render.h"

namespace ttp {
namespace rt {

// How far above the car's own origin, along its up axis, the tag is anchored
// (world units; the roster cars are ~0.3 tall).
constexpr float NAME_TAG_LIFT = 0.45f;
// Eye distance at which a tag starts to fade, and past which it is gone.
constexpr float NAME_TAG_FADE = 18.0f, NAME_TAG_FAR = 26.0f;
// Full size out to NAME_TAG_NEAR, then shrinking linearly to NAME_TAG_FAR_SCALE
// at NAME_TAG_FAR. Slower than perspective on purpose: the car shrinks as 1/d,
// and a tag doing the same is unreadable exactly where a rival is worth naming.
constexpr float NAME_TAG_NEAR = 4.0f;
constexpr float NAME_TAG_FAR_SCALE = 0.5f;
// Seconds a tag takes to fade out when its car goes behind another, and back in.
constexpr float NAME_TAG_COVER_FADE = 0.12f;
// The occluder box every car is, in its own frame (half width, height, half
// length; world units), measured off the roster GLBs' extents. A monster truck
// is its rig: the kit chassis with the car's body grafted on top.
constexpr float NAME_TAG_CAR_HALF_W = 0.27f, NAME_TAG_CAR_H = 0.4f, NAME_TAG_CAR_HALF_L = 0.44f;
constexpr float NAME_TAG_MONSTER_HALF_W = 0.32f, NAME_TAG_MONSTER_H = 0.8f;

struct NameTag {
    int32_t cell;    // the cell the tag is drawn in
    int32_t target;  // the roster slot of the car it names
    float x, y;      // anchor, fractions of the surface, top-left origin
    float scale;     // 1 near .. NAME_TAG_FAR_SCALE far
    float alpha;     // 0..1
};

// Every tag for frame `f`. `pictures` holds 4 floats per view — x, y, w, h of
// that cell's picture rect as fractions of the surface, top-left origin
// (ttp_display_cell_rects' first rect). Tags come back grouped by cell in cell
// order and, within a cell, FAR TO NEAR, so a shell stacking them in order puts
// the nearer name on top. Empty for an overview frame; a solo race tags the CPU.
//
// `cover` is the fade state across frames, one entry per (view, car) — the
// caller keeps it and hands it back; a size that does not fit this frame is
// reset. Each tag's alpha is its distance fade times that state, which moves
// toward covered or clear at NAME_TAG_COVER_FADE over f.dt.
std::vector<NameTag> nameTags(const TtpFrameInput& f, const float* pictures,
                              std::vector<float>& cover);

}  // namespace rt
}  // namespace ttp
