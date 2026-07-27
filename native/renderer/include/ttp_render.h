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

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * One frame of everything that moves. Built by the runtime (ttp_display.cc)
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

#ifdef __cplusplus
}
#endif

#endif /* TTP_RENDER_H */
