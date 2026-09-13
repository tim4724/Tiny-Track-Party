// name_tags — where each split-screen cell shows the OTHER players' names.
//
// A tag floats over a rival human's car in your cell. The TEXT is drawn by the
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
// Only cars that own a cell get a tag: those are the humans, and a cell never
// tags its own car. No occlusion test — a tag behind a hill still shows, which
// for a rival's name is the useful answer.
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
// The scale a tag has reached at NAME_TAG_FAR, from 1 at the eye: a far rival's
// tag reads as further away without shrinking below legibility.
constexpr float NAME_TAG_FAR_SCALE = 0.7f;

struct NameTag {
    int32_t cell;    // the cell the tag is drawn in
    int32_t target;  // the cell whose car it names
    float x, y;      // anchor, fractions of the surface, top-left origin
    float scale;     // 1 near .. NAME_TAG_FAR_SCALE far
    float alpha;     // 0..1
};

// Every tag for frame `f`. `pictures` holds 4 floats per view — x, y, w, h of
// that cell's picture rect as fractions of the surface, top-left origin
// (ttp_display_cell_rects' first rect). Tags come back grouped by cell in cell
// order and, within a cell, FAR TO NEAR, so a shell stacking them in order puts
// the nearer name on top. Empty for an overview frame.
std::vector<NameTag> nameTags(const TtpFrameInput& f, const float* pictures);

}  // namespace rt
}  // namespace ttp
