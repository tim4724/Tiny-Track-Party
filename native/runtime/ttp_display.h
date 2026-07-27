// ttp_display.h — the DISPLAY half of the runtime C ABI: the surface, the
// scene, the cameras and the frame. Sibling of ttp_runtime.h (sim) and
// ttp_party.h (party), same conventions (ttp_abi.h).
//
// The point of this layer is what it does NOT take. A frame carries no car
// poses, no camera matrices and no item state: ttp_display_frame reads the
// bound session's live Game in C++ and hands libttp-renderer a TtpFrameInput
// it built in-process. The shell's whole per-frame job is one call with a dt.
//
// SINGLETON, deliberately. There is one canvas, one GL context and one Filament
// engine per process on every platform we ship, so a handle would be a handle
// that is always 1. State that used to live in the JS renderer (which cars own
// split-screen cells, what the camera is doing) lives here instead.
//
// Only compiled into the browser module when a Filament SDK is configured; see
// native/CMakeLists.txt.
#ifndef TTP_DISPLAY_H
#define TTP_DISPLAY_H

#include <stdint.h>

#include "ttp_abi.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ---- surface ------------------------------------------------------------ */

/* surface is platform-defined: a CSS selector for the target <canvas> on web,
 * a CAMetalLayer* on tvOS, an ANativeWindow* on Android. width/height are
 * physical pixels. Returns 1 on success, 0 on failure. */
TTP_ABI int ttp_display_create(const char* surface, uint32_t width, uint32_t height);
TTP_ABI void ttp_display_resize(uint32_t width, uint32_t height);
TTP_ABI void ttp_display_destroy(void);

/* ---- scene -------------------------------------------------------------- */

/* Hand the display a named asset's bytes (materials, GLBs, textures). The shell
 * owns fetching; the bytes are copied before this returns. 0 on success. */
TTP_ABI int ttp_display_asset(const char* name, const uint8_t* bytes, uint32_t len);

/* Build the scene from the assets provided so far — "track.bin" (the track plus
 * its resolved biome theme and roster) and the GLBs/textures it names.
 *
 * rosterIdsJson is that roster's car ids as a JSON array, in slot order. The
 * renderer bakes a car's model and livery into its slot at build time, so this
 * is what lets every later frame put each car back in ITS slot by identity
 * rather than by position in some separately-maintained list.
 *
 * Every race start comes through here, since a Grand Prix chains four tracks
 * and even a restart wants the skid ribbons, kicked cones and collected boxes
 * back at their opening state. Returns 0 on success. */
TTP_ABI int ttp_display_build(const char* rosterIdsJson);

/* Tear the scene down; the engine, views, materials and provided assets live
 * on, so the next ttp_display_build is cheap. */
TTP_ABI void ttp_display_release(void);

/* ---- what to draw ------------------------------------------------------- */

/* The session whose cars this display draws (0 = none: an empty track, which is
 * what the lobby's track preview is before the attract race starts). */
TTP_ABI void ttp_display_bind(int session);

/* The cars that own a split-screen cell, as a JSON array of scalar ids, in cell
 * order. Everything else in the field is still drawn — it just has no camera.
 * An empty array means the single overview camera fills the surface. */
TTP_ABI void ttp_display_cells(const char* idsJson);

/* Camera mode for a surface with no cells (ttp_display_cells empty). */
#define TTP_CAM_STILL  0  /* the fitted whole-track iso view, held still */
#define TTP_CAM_ORBIT  1  /* turntable: circle the track at the overview radius */
#define TTP_CAM_BBOX   2  /* lobby: sweep an ellipse hugging the track's bbox */
#define TTP_CAM_FREE   3  /* inspector: the shell drives, via ttp_display_look */
TTP_ABI void ttp_display_camera(int mode);

/* Free-cam pose (TTP_CAM_FREE only): eye + look target in world units. */
TTP_ABI void ttp_display_look(double eyeX, double eyeY, double eyeZ,
                              double tgtX, double tgtY, double tgtZ);

/* Distance fog on/off for this surface. Track previews want it off (haze would
 * clip the far side of the circuit); racing and the lobby orbit want it on. */
TTP_ABI void ttp_display_fog(int enabled);

/* The sun's baked shadow map on/off, from the next ttp_display_build onwards.
 *
 * Baking is a 2048² depth pass over the whole circuit plus an ESM blur, run
 * once per track (never per frame). That is nothing on a GPU, but under the
 * software GL of a headless test runner it is one of the heaviest frames in the
 * whole session, and a Grand Prix chains four tracks. E2E turns it off; nothing
 * on the shipped path does. Off renders lit but unshadowed — the same thing a
 * track that bakes no map has always produced. */
TTP_ABI void ttp_display_shadows(int enabled);

/* Hold the field where it is: cars keep the pose they were last drawn at, with
 * every motion cue (speed, steer, brake, boost, wall scrub) zeroed, so nothing
 * keeps spinning its wheels or laying rubber while standing still.
 *
 * Two callers, both cases where the engine's live state is NOT what should be on
 * screen. The pause overlay: the sim is stopped mid-corner, so a car's stored
 * speed would keep the cosmetics running. And the end-of-race fast-forward,
 * which runs the deterministic sim to the flag with no rendering — the just-
 * finished human keeps driving a victory lap, so without a hold their chase
 * camera is seen whipping across the track behind the results glass. */
TTP_ABI void ttp_display_hold(int held);

/* ---- the frame ---------------------------------------------------------- */

/* Draw one frame of the bound session. Returns 1 when it drew, 0 when the
 * renderer skipped it and the surface still holds the previous frame.
 *
 * dt drives the scene clock (cosmetic phase: box bob, cloud drift, skid decay,
 * camera damping), NOT the sim — ttp_update owns that and the shell calls it
 * first. dt 0 re-presents the last frame unchanged, which is what a canvas
 * readback needs (pixels only survive inside the task that drew them). */
TTP_ABI int ttp_display_frame(double dtSeconds);

/* A rocket detonation, queued for the NEXT frame. The renderer cannot infer
 * these: a rocket that hit a car detonates ON that car and rides it out, while
 * a whiff self-destructs at a track point. idJson names the victim, or is null
 * for a whiff at (s, lat). */
TTP_ABI void ttp_display_burst(const char* idJson, double s, double lat);

/* ---- diagnostics -------------------------------------------------------- */

/* Last frame's per-section wall clock (milliseconds), and the matching comma-
 * joined section names. The array is the renderer's own — read it, don't free. */
TTP_ABI const double* ttp_display_profile(void);
TTP_ABI const char* ttp_display_profile_names(void);

#ifdef __cplusplus
}
#endif

#endif /* TTP_DISPLAY_H */
