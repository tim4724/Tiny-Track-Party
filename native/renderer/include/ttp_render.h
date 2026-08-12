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
 * One car's SLOT in the scene: the only thing about a race the shell genuinely
 * knows, which is who is in it and what their car looks like. Handed over once
 * per scene build, in slot order; the renderer bakes each entry into its slot
 * and every later frame puts a car back in ITS slot by identity.
 *
 * This used to be "track.bin" — a hand-rolled, version-stamped byte buffer that
 * public/shared/trackBin.js wrote and TtpRenderer.cpp parsed. Both halves are
 * gone. The format cost every shell a byte-exact encoder for a layout documented
 * in a comment, which is the same shape of silent divergence the effect-list
 * ABIs exist to prevent; the roster crosses the ttp_display_build boundary as
 * JSON now and libttp-runtime's parseRoster (ttp/roster.h) fills this struct,
 * so the colour arithmetic is written once.
 */
typedef struct TtpRosterCar {
    uint32_t colorABGR;   /* livery, premultiplied-alpha-free 0xAABBGGRR */
    /* Which kit model this slot drives. The renderer never resolves it to a
     * file — the shell fetches the GLB and provides it as car<slot>.glb — but a
     * re-roster (ttp_display_reroster) needs to know whether a slot's MODEL
     * changed. */
    int32_t carIndex;
} TtpRosterCar;

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
    /* The same steer shaped by the sim's OWN exponent — sign(s)*|s|^STEER_EXPO,
     * with STEER_SIGN applied, exactly the `steerIn` Game::update multiplies its
     * turn rate by. So this is proportional to the car's yaw rate and `steer` is
     * not, which is the whole reason it exists: the front wheels yaw with THIS.
     *
     * They yawed with `steer` until 2026-07-29 and so LED the car through the
     * entire mid-range, where players actually live — at half tilt the wheels
     * showed half lock while the car was turning at 0.42 of full rate. Note the
     * fix is the CURVE, never the magnitude: a physically correct front-wheel
     * angle is atan(wheelbase * yawRate / v), which is ~3-6 degrees at racing
     * speed against the ±0.5 rad the renderer draws, and it shrinks as speed
     * rises. That would delete the input-acknowledged cue precisely when the
     * player is steering hardest, and slam to full lock at a standstill.
     *
     * `authority` (0.4..1 with speed) is deliberately NOT folded in either: real
     * wheels at rest DO turn to full lock while the car fails to rotate, which
     * is the thing authority models.
     *
     * `steer` keeps the raw curve because its other two consumers want it — the
     * body lean, and the skid slip threshold whose authored 0.815 saturation
     * point is written against that curve. */
    float steerYaw;
    float monster;  /* 1 = monster-truck transform active */
    float spin;     /* spin-out whirl angle (rad) — cosmetic body yaw + skid scribbles */
    float scrub;    /* 1 = grinding the wall/curb (snapshot onWall) — full-strength skids */
    /* Collision half-extents in the car's own frame (world units), at the sim's
     * CURRENT footprint scale — monster growth included. The cone/sign kick
     * tests the marker against this oriented rectangle, so the punt happens on
     * body contact rather than at a fixed radius from the car's centre. */
    float halfLen, halfWid;
    /* WHERE THE CAR IS IN TRACK SPACE — the sim's own (totalS, lat), not a
     * re-derivation of it. The renderer has to seat the body on the deck, and
     * the deck is a surface parameterised by exactly these two numbers, so the
     * seat is an evaluation rather than a search the moment they cross.
     *
     * It replaced a per-frame project() of the car's world position against the
     * ribbon's ring polyline. That answered the same question, but through a
     * DISCRETE nearest-segment pick, and every discrete decision on a per-frame
     * geometry path is a place the answer can hop between two almost-equal
     * candidates and put a step into the pose. Handing the number over costs
     * eight bytes and deletes the whole class.
     *
     * trackS is the ACCUMULATED arclength (laps included, as the sim keeps it);
     * every reader wraps it itself. */
    float trackS, trackLat;
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

/* One split-screen cell's 2D overlay — the steer bar, and nothing else.
 *
 * The HUD lives in the shells (DOM/CSS, SwiftUI, Compose) because the Sticker
 * Bash look is a UI-toolkit problem. TWO elements are exempt, by the line in
 * docs/native-port/shared-cpp-plan.md: cell-anchored AND textless goes to the
 * renderer, anything carrying type or sticker chrome stays in the shell. That
 * admits the steer bar and the cell dividers; it keeps out the place/lap
 * ordinal, the name chip, the item slot, the FINISHED card and the reconnect QR.
 *
 * Anchoring is the reason it can be here at all: a cell's rectangle is already
 * a C++ answer (ttp_grid_cell), so the bar cannot drift from the viewport it
 * belongs to the way a second layout in the shell could. */
typedef struct TtpCellHudInput {
    /* Which car this cell follows, as an index into cars[] — the roster slot,
     * so the bar wears the same livery the model does. < 0 = no car (nothing to
     * draw). NOT a car id: no identity crosses this boundary. */
    int32_t car;
    /* Where to draw the fill, -1..1: the phone's RAW tilt, eased toward over
     * ~50 ms (STEER_BAR_TAU) so the bar does not step at the packet rate.
     * Deliberately NOT TtpCarInput.steer, which carries STEER_SIGN because the
     * VISUAL cues (front-wheel yaw, body lean) have to turn the way the car
     * turns. The bar mirrors the phone's own bar, so it wants the raw value —
     * and the phone eases its own by the same 50 ms. */
    float steer;
    uint32_t flags; /* TTP_HUD_STEER_BAR */
} TtpCellHudInput;

/* Draw this cell's steer bar. Clear while a centred card owns the cell — the
 * player has FINISHED, or has dropped and is being shown the reconnect QR — for
 * the same reason the DOM hid it: they are not steering, and the card is what
 * the cell is saying. */
#define TTP_HUD_STEER_BAR 1u

/* TtpFrameInput.flags */
#define TTP_FRAME_DIVIDERS 1u /* draw the ink rules on the split-screen seams */
/* The single view is a whole-SURFACE overview — the lobby's perimeter orbit, the
 * gallery turntable, a track preview, the free inspector cam — and not a
 * split-screen cell. It renders into the surface ENTIRE, never into the grid
 * fitted to TtpRenderer's 16:9..21:9 band.
 *
 * The band is a statement about a CELL: 16:9 is the authored chase composition,
 * a narrower tile would HIDE world, so a short tile is letterboxed up to it. An
 * overview has no authored composition to protect — it frames whatever track it
 * is given — and buildFrame already measures its projection against the whole
 * surface. Sending it through the fitted rect was therefore wrong twice over on
 * any display outside the band: it letterboxed a picture that wanted the screen,
 * AND it aimed a projection at a shape it was not drawn into. Measured in the
 * browser at 1280x800: a 1.6 projection rendered into a 1.778 rect, so the lobby
 * stretched 11% horizontally inside 40 px bars. A 2560x720 ultrawide is the same
 * arithmetic taken further — squeezed to 66%, inside 440 px ones. Nothing pinned
 * it because a 16:9 surface is the one shape where the fitted rect IS the
 * surface, and that is what every fixture measures.
 *
 * No version bump: the bit is additive and the layout is unchanged, so a renderer
 * built without it letterboxes as before rather than rejecting the frame. */
#define TTP_FRAME_OVERVIEW 2u

/* Chrome colours for the overlay, as 0xRRGGBB. These are `--ink` and
 * `--surface` from public/shared/theme.css, which is the authored source for
 * the sticker palette; tests/design-tokens.test.js holds these two against the
 * baked token table so the two languages cannot drift apart silently.
 *
 * Only these two. A third would mean the look is being rebuilt here rather than
 * quoted — the livery colour arrives as roster data (TtpRosterCar), and every
 * other surface in view is drawn by the renderer from the biome palette. */
#define TTP_HUD_INK     0x2A2735u
#define TTP_HUD_SURFACE 0xFFFFFFu

/* Header, followed CONTIGUOUSLY by cars[carCount], views[viewCount],
 * boxStates[boxCount] (u32: 1 = available, 0 = collected; indexed like the
 * scene payload's box list), bananas[bananaCount], rockets[rocketCount],
 * bursts[burstCount] and hud[hudCount]. */
typedef struct TtpFrameInput {
    uint32_t version;  /* TTP_FRAME_INPUT_VERSION */
    float dt;          /* seconds since previous frame */
    uint32_t carCount;
    uint32_t viewCount;
    uint32_t boxCount;
    uint32_t bananaCount;
    uint32_t rocketCount;
    uint32_t burstCount; /* detonations fired THIS frame (usually 0) */
    uint32_t hudCount;   /* cell overlays — viewCount while cells are up, else 0 */
    uint32_t flags;    /* TTP_FRAME_* */
    float sceneT;      /* the driving renderer's scene clock (accumulated dt since
                        * its scene booted) — phase source for every wall-clock
                        * cosmetic (box bob/spin, cloud drift, balloon lap, rocket
                        * roll), so both renderers animate in the SAME phase */
    /* NO UI SCALE. A uiScale lived here until v11 (removed with
     * ttp_display_ui_scale — see it for why a TV cannot supply one). The cell
     * overlay measures itself against the cell and the surface now, so every
     * number crossing this boundary is in the surface's own physical pixels. Do
     * not add a second unit system back. */
} TtpFrameInput;


#define TTP_FRAME_INPUT_VERSION 12u

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
static inline const TtpCellHudInput* ttp_frame_hud(const TtpFrameInput* f) {
    return (const TtpCellHudInput*) (ttp_frame_bursts(f) + f->burstCount);
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
