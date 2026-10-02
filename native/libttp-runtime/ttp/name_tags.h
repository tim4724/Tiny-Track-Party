// name_tags — where each split-screen cell shows the other cars' names.
//
// A tag floats over every other car in your cell, CPU included. The TEXT is
// drawn by the shell's UI toolkit at the panel's native resolution, because the
// renderer's buffer is scaled down under load (ttp/render_scale.h) and type
// rendered into it goes soft exactly on the box that needs it most. So this
// decides WHERE and HOW STRONGLY, per frame, and the shell draws what it is told.
//
// Read off the frame the renderer was just handed, so a tag is projected
// through the same camera and the same car pose as the picture under it. A
// shell that draws the tag in the same frame it presents that picture keeps the
// two together; one that projected on its own clock would trail its car.
//
// A cell never tags the car it follows, nor lets that car hide a tag. A tag
// HIDES when something solid in the 3D scene stands between the camera and THE
// TAG ITSELF, since a sticker drawn on top of a bridge deck that ought to be in
// front of it reads as broken. It is the tag that is tested, not its car: a car
// half behind something keeps its name wherever the tag floats clear, and a car
// out of sight loses it only because its tag is out of sight too. Two things
// are solid. A monster truck, as a box, unless the renderer is ghosting it in
// that cell (ttp_monster_ghosted); ordinary cars never hide a tag, because they
// overlap constantly in a pack and a tag winking in and out over every pass
// reads worse than one drawn over a car's corner. And the road deck
// (NameTagDeck): a bridge, a crest, the far side of a loop. The ground's
// relief, the scenery and the walls do NOT hide a tag.
#pragma once

#include <cstdint>
#include <vector>

#include "ttp/trackbuilder.h"
#include "ttp/vecmath.h"
#include "ttp_render.h"

namespace ttp {
namespace rt {

// How far above the car's own origin, along its up axis, the tag is anchored
// (world units): just over the roof, so a monster truck's rig lifts it by the
// difference in height.
constexpr float NAME_TAG_LIFT = 0.45f, NAME_TAG_MONSTER_LIFT = 0.85f;
// The point the occlusion test aims at, this far above the anchor (world
// units): roughly the sticker's middle at race distances, since the shells
// stand the sticker clear above the point its tail marks.
constexpr float NAME_TAG_BODY = 0.2f;
// Eye distance at which a tag starts to fade, and past which it is gone.
constexpr float NAME_TAG_FADE = 18.0f, NAME_TAG_FAR = 26.0f;
// Scale 1 is the size the shells draw a sticker at, and it is the CLOSEST size:
// a rival within NAME_TAG_CLOSE of the camera (beside you, or just behind: the
// chase camera sits barely a car length back) fills much of the cell, and a tag
// no bigger than a distant one looks lost on it. From there it shrinks linearly
// to NAME_TAG_NEAR_SCALE at NAME_TAG_NEAR, then to NAME_TAG_FAR_SCALE at
// NAME_TAG_FAR. Slower than perspective on purpose: the car shrinks as 1/d, and
// a tag doing the same is unreadable exactly where a rival is worth naming.
// Shrinking only, so a shell never scales its raster up and softens the type.
constexpr float NAME_TAG_CLOSE = 1.5f, NAME_TAG_NEAR = 4.0f;
constexpr float NAME_TAG_NEAR_SCALE = 0.75f, NAME_TAG_FAR_SCALE = 0.375f;
// Seconds a tag takes to fade out when something covers it, and back in.
constexpr float NAME_TAG_COVER_FADE = 0.12f;
// A monster truck as an occluder box in its own frame (half width, height, half
// length; world units): the kit chassis with the car's body grafted on top,
// measured off the GLBs' extents.
constexpr float NAME_TAG_MONSTER_HALF_W = 0.32f, NAME_TAG_MONSTER_H = 0.8f, NAME_TAG_MONSTER_HALF_L = 0.44f;

// The road deck as an occluder: the flat pieces between neighbouring centerline
// samples, edge to edge across the road's width, in chunks under one bounding
// box so a ray tests a few dozen boxes and only the pieces of the chunks it
// crosses. Built once per scene (nameTagDeck); empty = no deck test.
struct NameTagDeck {
    std::vector<V3> left, right;  // per sample, the deck's two edges
    struct Chunk {
        V3 lo, hi;                // bounds of its pieces' corners
        uint32_t first, count;    // piece i spans sample i to sample i+1 (mod n)
    };
    std::vector<Chunk> chunks;
};

// Pieces per chunk.
constexpr uint32_t NAME_TAG_DECK_CHUNK = 16;

NameTagDeck nameTagDeck(const std::vector<OutSample>& samples, bool closed);

struct NameTag {
    int32_t cell;    // the cell the tag is drawn in
    int32_t target;  // the roster slot of the car it names
    float x, y;      // anchor, fractions of the surface, top-left origin
    float scale;     // 1 closest .. NAME_TAG_FAR_SCALE far
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
                              const NameTagDeck& deck, std::vector<float>& cover);

}  // namespace rt
}  // namespace ttp
