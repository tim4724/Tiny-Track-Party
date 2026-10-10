// name_tags — where each split-screen cell shows the other players' names.
//
// A tag floats over every other PLAYER's car in your cell: a car that owns a
// cell of its own. CPU cars never get one (user decision: a CPU's name says
// nothing to the couch, and its sticker buries the friend worth naming), so a
// solo race has no tags at all and does none of this work. The TEXT is
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
// A cell never tags the car it follows. A tag HIDES when something solid in
// the 3D scene stands between the camera and THE TAG ITSELF, since a sticker
// drawn on top of something that ought to be in front of it reads as broken.
// It is the tag that is tested, not its car: a car half behind something keeps
// its name wherever the tag floats clear, and a car out of sight loses it only
// because its tag is out of sight too. The tag is the sticker's box on screen,
// as the shell measured it (NameTagSize), and what decides is the SHARE of it
// covered: past NAME_TAG_HIDE_AT the whole tag fades out. A tag is all or
// nothing, because a clip would have to ride the frame on every shell.
//
// Two things are solid. A monster truck, as a box, projected whole onto the
// screen — only the part of it nearer than the tag — so its share is an exact
// area; the cell's OWN truck counts too, since the chase camera can ride below
// its roof, unless the camera is inside it or the renderer is ghosting it in that
// cell (ttp_monster_ghosted). And the road deck (NameTagDeck): a bridge, a
// crest, the far side of a loop, sampled by rays on a grid over the sticker.
// The two shares add. Ordinary cars never hide a tag, because they overlap
// constantly in a pack and a tag winking in and out over every pass reads
// worse than one drawn over a car's corner. The ground's relief, the scenery
// and the walls do NOT hide a tag.
#pragma once

#include <cstdint>
#include <vector>

#include "ttp/trackbuilder.h"
#include "ttp/vecmath.h"
#include "ttp_render.h"

namespace ttp {
namespace rt {

// How far above the car's ROOF, along its up axis, the tag is anchored (world
// units). The roof is measured per car off the model it is drawing (the
// caller's `shapes`), so a low car's tag sits as close to it as a tall car's
// does, and a monster truck's rig lifts it by the rig's own height.
constexpr float NAME_TAG_ROOF_GAP = 0.0f;
// A tag hides once this share of its sticker is covered, and shows again only
// below the second: the gap keeps a truck's edge parked on the line from
// flickering the tag.
constexpr float NAME_TAG_HIDE_AT = 0.35f, NAME_TAG_SHOW_AT = 0.2f;
// The deck is sampled on an N x N grid over the sticker (a bridge is too many
// triangles to project; a truck is projected whole instead).
constexpr int NAME_TAG_DECK_GRID = 3;
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
// A monster truck's CHASSIS as an occluder box in its own frame (half width,
// half length; world units), the kit's extents at its authored size, from the
// ground up to the seat its car's body is grafted on. The body above is a second box of its own
// measured size (NameTagShape): it is narrower than the wheels, and a tag over
// the roof meets it first, so one box the chassis's width all the way up hid
// tags early.
constexpr float NAME_TAG_MONSTER_HALF_W = 0.32f, NAME_TAG_MONSTER_HALF_L = 0.44f;

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
    float kerbH = 0;              // the theme's kerb height along both edges (kerbBlocks)
};

// Pieces per chunk.
constexpr uint32_t NAME_TAG_DECK_CHUNK = 16;

NameTagDeck nameTagDeck(const std::vector<OutSample>& samples, bool closed);

// Does the road deck stand between `eye` and `p`? The first `eyeClear` and the
// last `farClear` units of the line are exempt — the end at a car, so the deck
// it sits on never hides it. The tags ask it, and so does the follow camera
// (ttp/camera.h), each with its own clearances.
bool deckBlocks(const NameTagDeck& deck, V3 eye, V3 p, float eyeClear, float farClear);

// Does a kerb — a wall kerbH tall standing up from either edge of the deck —
// stand between `eye` and `p`? The tags never ask (a kerb hides a car's wheels,
// never the sticker over its roof); the follow camera does, so a low side view
// does not film the cars through the kerb.
bool kerbBlocks(const NameTagDeck& deck, V3 eye, V3 p);

struct NameTag {
    int32_t cell;    // the cell the tag is drawn in
    int32_t target;  // the roster slot of the car it names
    float x, y;      // anchor, fractions of the surface, top-left origin
    float scale;     // 1 closest .. NAME_TAG_FAR_SCALE far
    float alpha;     // 0..1
};

// A sticker's box as its shell draws it at scale 1, as fractions of the surface
// (w of its width, h and lift of its height): centred on the anchor, its bottom
// edge `lift` above it. The shell measures it (ttp_display_name_tag_size) since
// only the shell knows its font; the box scales about the anchor with the tag.
struct NameTagSize {
    float w, h, lift;
};

// What a shell that has not measured yet is assumed to draw: 28.8 px type on a
// 1080-line panel (the authored size, display.css `.name-tag`), a typical short
// name three em wide, the box 1.3 em tall and lifted 0.4 em.
inline NameTagSize nameTagSizeFallback(float surfaceW, float surfaceH) {
    const float em = 0.0267f;  // of the height
    return { 3 * em * surfaceH / surfaceW, 1.3f * em, 0.4f * em };
}

// A car as the tags see it, as drawn this frame. `roof` is the height of its
// roof over its origin, monster rig included: where its tag is anchored. For a
// monster truck it is also the top of the occluder, which is the chassis box up
// to `seat` and the car's body above it, `bodyHalfW` x `bodyHalfL` (wheels off).
// `rigScale` is the scale the rig is drawn at, which the chassis box rides.
struct NameTagShape {
    float roof;
    float seat, bodyHalfW, bodyHalfL;
    float rigScale = 1;
};

// The cover state of one (view, car) across frames, kept by the caller.
struct NameTagCover {
    float clear = 1;      // 1 = shown, 0 = gone; fades at NAME_TAG_COVER_FADE
    bool hidden = false;  // the hysteresis latch between HIDE_AT and SHOW_AT
};

// Every tag for frame `f`. `pictures` holds 4 floats per view — x, y, w, h of
// that cell's picture rect as fractions of the surface, top-left origin
// (ttp_display_cell_rects' first rect). `shapes` and `sizes` hold one entry
// per car: its shape as drawn this frame, and its sticker. Tags come back
// grouped by cell in cell order and, within a cell, FAR TO NEAR, so a shell
// stacking them in order puts the nearer name on top. Empty for an overview
// frame and for fewer than two cells.
//
// `cover` is one entry per (view, car) — the caller keeps it and hands it back;
// a size that does not fit this frame is reset. Each tag's alpha is its
// distance fade times that entry's `clear`.
std::vector<NameTag> nameTags(const TtpFrameInput& f, const float* pictures, const NameTagShape* shapes,
                              const NameTagSize* sizes, const NameTagDeck& deck,
                              std::vector<NameTagCover>& cover);

}  // namespace rt
}  // namespace ttp
