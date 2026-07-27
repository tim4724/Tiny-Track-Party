/*
 * ttp_render.h — libttp-renderer's INPUT CONTRACT: the plain-data frame the
 * renderer draws, and nothing else. This is an internal C++ header, not an ABI
 * (docs/native-port/architecture.md: runtime/ttp_runtime.h is the one
 * disciplined C ABI). It stays C-shaped because the tvOS and Android shells
 * fill the same structs.
 *
 * No versioning between layers — they always ship together. TtpFrameInput
 * carries a layout version only so a stale serialized FIXTURE is detected
 * loudly rather than misread.
 */
#ifndef TTP_RENDER_H
#define TTP_RENDER_H

/* <math.h> is here for ttp_grid_cols alone — see its comment below. Nothing
 * else in this header needs more than <stdint.h>, and it must stay that way:
 * libttp-runtime, the renderer and every platform shell all include this. */
#include <math.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * One frame of everything that moves. Built by libttp-runtime's frame builder
 * straight off the live Game — it never leaves the process, so "plain data"
 * here buys layout stability for the tvOS/Android shells and a serializable
 * fixture format, not marshalling.
 */
typedef struct TtpVec3 { float x, y, z; } TtpVec3;

typedef struct TtpCarInput {
    TtpVec3 pos, forward, up; /* contract pose (world units) */
    float spd, steer, brake, boostMul; /* spd NORMALIZED v/vmax (0..~2 under boost) */
    float monster;  /* 1 = monster-truck transform active */
    float spin;     /* spin-out whirl angle (rad) — cosmetic body yaw + skid scribbles */
    float scrub;    /* 1 = grinding the wall/curb (snapshot onWall) — full-strength skids */
} TtpCarInput;

typedef struct TtpViewInput {
    float world[16]; /* camera world matrix, column-major (three.js layout) */
    float fov, aspect, nearZ, farZ;
    /* LINEAR distance fog for this view (three.js Fog near/far, already scaled
     * by the biome's fogTune), because the profile is per-surface, not global:
     * the race cells, the lobby's perimeter orbit and the overview each run
     * their own ramp, and the gallery runs none. fogFar <= fogNear = no fog. */
    float fogNear, fogFar;
} TtpViewInput;

/* A dropped banana hazard (contract snapshot.bananas): track-space position —
 * the renderer resolves world placement via its own centerline interpolation. */
typedef struct TtpBananaInput {
    float s, lat;
} TtpBananaInput;

/* An in-flight homing rocket (contract snapshot.rockets), track-space. */
typedef struct TtpRocketInput {
    float s, lat;
} TtpRocketInput;

/* One rocket detonation, fired on the frame the engine reports it.
 *
 * The renderer used to INFER these from rocketCount dropping, and place the
 * burst at the rocket's last known spot. That is wrong for the case that
 * matters most: a rocket that HIT a car detonates ON that car, and the car
 * keeps driving — so a burst pinned to the impact point immediately falls
 * behind its victim's own chase camera, i.e. the one player guaranteed to be
 * looking at it never sees it. The events carry which of the two it was:
 *   car >= 0  — a hit on that car (index into cars[]); the fireball rides it
 *   car <  0  — a whiff self-destruct at track position (s, lat) */
typedef struct TtpBurstInput {
    int32_t car;
    float s, lat;
} TtpBurstInput;

/* Header, followed CONTIGUOUSLY by cars[carCount], views[viewCount],
 * boxStates[boxCount] (u32: 1 = available, 0 = collected; indexed like the
 * scene payload's box list), bananas[bananaCount], rockets[rocketCount] and
 * bursts[burstCount]. */
typedef struct TtpFrameInput {
    uint32_t version;  /* TTP_FRAME_INPUT_VERSION */
    float dt;          /* seconds since previous frame */
    uint32_t carCount;
    uint32_t viewCount;
    uint32_t boxCount;
    uint32_t bananaCount;
    uint32_t rocketCount;
    uint32_t burstCount; /* detonations fired THIS frame (usually 0) */
    uint32_t flags;    /* reserved (no flags defined) */
    float sceneT;      /* the driving renderer's scene clock (accumulated dt since
                        * its scene booted) — phase source for every wall-clock
                        * cosmetic (box bob/spin, cloud drift, balloon lap, rocket
                        * roll), so both renderers animate in the SAME phase */
} TtpFrameInput;


#define TTP_FRAME_INPUT_VERSION 9u

static inline const TtpCarInput* ttp_frame_cars(const TtpFrameInput* f) {
    return (const TtpCarInput*) (f + 1);
}
static inline const TtpViewInput* ttp_frame_views(const TtpFrameInput* f) {
    return (const TtpViewInput*) (ttp_frame_cars(f) + f->carCount);
}
static inline const uint32_t* ttp_frame_box_states(const TtpFrameInput* f) {
    return (const uint32_t*) (ttp_frame_views(f) + f->viewCount);
}
static inline const TtpBananaInput* ttp_frame_bananas(const TtpFrameInput* f) {
    return (const TtpBananaInput*) (ttp_frame_box_states(f) + f->boxCount);
}
static inline const TtpRocketInput* ttp_frame_rockets(const TtpFrameInput* f) {
    return (const TtpRocketInput*) (ttp_frame_bananas(f) + f->bananaCount);
}
static inline const TtpBurstInput* ttp_frame_bursts(const TtpFrameInput* f) {
    return (const TtpBurstInput*) (ttp_frame_rockets(f) + f->rocketCount);
}

/* What the built track measures, for the runtime's overview cameras and fog
 * bands. The box is over the CENTERLINE points, like SceneRenderer's was.
 *
 * Lives here rather than inside TtpRenderer because both sides of the split
 * need it: the renderer fills it (it owns the parsed track), libttp-runtime's
 * solveFraming consumes it, and libttp-runtime must not know TtpRenderer
 * exists. */
typedef struct TtpTrackFraming {
    float centerX, centerY, centerZ;
    float sizeX, sizeY, sizeZ;
    float fogTune;
} TtpTrackFraming;

/* Split-screen column count for n views on a w x h surface — SceneRenderer's
 * bestGrid, verbatim: score every column count by how far the resulting cell is
 * from square, plus a real penalty per wasted cell, and take the cheapest.
 * `ceil(sqrt(n))` is NOT the same function: on a 16:9 screen it puts two players
 * SIDE BY SIDE where this stacks them, and 7 players in a 3x3 where an ultrawide
 * takes 4x2. Guessing it anywhere would put the 3D cells and the DOM HUD (which
 * places every label, place card and steer bar) in different places.
 *
 * THREE callers had three copies of this: the renderer's viewport split, the
 * runtime's per-cell camera aspect, and Stage.js's HUD layout. It is a pure
 * function of (n, w, h), so it is one static inline in the header both C++
 * layers already include — deliberately NOT a function in libttp-runtime, which
 * would put a link edge between the renderer and a library it must not need.
 * The shell's copy is gone: it ASKS, via ttp_display_cell_rects. */
static inline uint32_t ttp_grid_cols(uint32_t n, uint32_t w, uint32_t h) {
    if (n == 0) return 1;
    /* Landscape is a HARD preference, not a weighted one. A racing cell wants to
     * be wider than it is tall: the road runs away toward a horizon, so the
     * useful information is spread horizontally, and a tall narrow cell crops the
     * very thing the player steers by (the track ahead and to the sides) while
     * spending pixels on sky and bonnet. Distance-from-square alone put two
     * players side by side (0.89:1) and three in a row (0.59:1) on a 16:9 screen.
     * So: if ANY layout gives landscape cells, only those are considered, and the
     * score picks between them; portrait is reachable only when nothing else is
     * (one player on a phone held upright).
     *
     * This replaces a +2.0 cost term that did the same job by arithmetic. The two
     * agree on every display shape we could construct — |log(aspect)| only exceeds
     * 2 past 7.4:1, so the penalty was already decisive — but a rule that says
     * what it means cannot be defeated by a screen nobody tried. */
    const float W = (float) w, H = (float) h;
    uint32_t best = 1;
    float bestCost = INFINITY;
    int bestLandscape = 0;
    for (uint32_t cols = 1; cols <= n; cols++) {
        const uint32_t rows = (n + cols - 1) / cols;
        const float cellAspect = (W / cols) / (H / rows);
        const int landscape = cellAspect >= 1.0f;
        /* distance from square + a real penalty per wasted cell (so 4 -> 2x2) */
        const float cost = fabsf(logf(cellAspect)) + (cols * rows - n) * 0.4f;
        if ((landscape && !bestLandscape)
                || (landscape == bestLandscape && cost < bestCost)) {
            bestCost = cost; best = cols; bestLandscape = landscape;
        }
    }
    return best;
}

/* One split-screen cell's rectangle, in the SURFACE's own pixels. */
typedef struct TtpCellRect { uint32_t x, y, w, h; } TtpCellRect;

/* Cell `i` of `n` on a w x h surface: the grid ttp_grid_cols scores, filled
 * row-major from the TOP LEFT. i >= n is an empty rect (all zero).
 *
 * Top-left origin, because that is what every consumer of the ANSWER uses — the
 * DOM HUD, the tvOS/Android overlays, and the renderer's own row order. GL
 * viewports are bottom-left, so the one flip lives where GL is spoken
 * (TtpRenderer::render) rather than being everyone's problem.
 *
 * Cells are whole pixels, so the last column/row leaves up to cols-1 (rows-1)
 * pixels of the surface owned by no cell. That truncation is the renderer's, and
 * it is exactly why the HUD must not compute its own: floor(W/cols) in CSS
 * pixels and floor(W*dpr/cols)/dpr are DIFFERENT edges on a fractional-DPR
 * surface, and the labels would drift off the cells the player sees. */
static inline TtpCellRect ttp_grid_cell(uint32_t i, uint32_t n, uint32_t w, uint32_t h) {
    TtpCellRect r = { 0u, 0u, 0u, 0u };
    if (i >= n) return r;
    const uint32_t cols = ttp_grid_cols(n, w, h);
    const uint32_t rows = (n + cols - 1) / cols;
    r.w = w / cols;
    r.h = h / rows;
    r.x = (i % cols) * r.w;
    r.y = (i / cols) * r.h;
    return r;
}

#ifdef __cplusplus
}
#endif

#endif /* TTP_RENDER_H */
