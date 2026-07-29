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
/* The packed HUD readback's layout. Plain data with no platform in it, so it
 * lives beside the renderer's frame contract in libttp-runtime rather than
 * here — same reason, and same shape, as ttp_render.h. */
#include "ttp_hud.h"

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

/* Physical pixels per UI point on this surface: devicePixelRatio on web,
 * UIScreen.nativeScale on tvOS, density on Android. Defaults to 1.
 *
 * This is the ONE unit conversion the C side is told about, and it exists
 * because the renderer now draws two pieces of chrome (see
 * ttp_display_cell_rects) whose sizes are authored in the UI's units — a 34 pt
 * bar with a 4 pt border — rather than in the world's. Everything else here
 * stays in the surface's own physical pixels, so a shell that never calls this
 * is still correct everywhere except the size of those two elements.
 *
 * NOT devicePixelRatio by another name: points and density are the same idea on
 * all three platforms, which is why it can cross the boundary when a CSS pixel
 * could not. <= 0 is ignored. */
TTP_ABI void ttp_display_ui_scale(double scale);

/* ---- scene -------------------------------------------------------------- */

/* Hand the display a named asset's bytes (materials, GLBs, textures). The shell
 * owns fetching; the bytes are copied before this returns. 0 on success. */
TTP_ABI int ttp_display_asset(const char* name, const uint8_t* bytes, uint32_t len);

/* Force a biome on every scene built from here on, regardless of the track's
 * cup — the ?biome= inspector override, which is how any track gets compared in
 * any look. null, "" or an unknown name clears it and lets the cup decide;
 * ttp_theme_has_biome (ttp_theme.h) is the validity test a shell should use if
 * it wants to tell the user their spelling was wrong. */
TTP_ABI void ttp_display_biome(const char* name);

/* Build every scene from here on as the ASSET GALLERY's showroom
 * (ttp/showcase.h): the resolved biome's palette carrying the UNION of every
 * biome's vocabulary — all nine scenery models, all seventeen hero landmarks,
 * all ten clutter kinds and every flier rig — so one scene holds everything the
 * renderer draws rather than one cup's share of it.
 *
 * A LATCHED FLAG, like ttp_display_biome, and for the same reason: it changes
 * what the next ttp_display_build resolves, so it cannot be an argument to the
 * frame and must not be a mode the renderer has to keep two versions of.
 *
 * It also puts the showroom's STANDING EXHIBITS on every frame drawn while the
 * field is parked (ttp_display_hold): a pair of rockets on the furniture
 * straight, and the monster rig on the back of the grid. Those two are the only
 * things the renderer draws that a track descriptor cannot author — a rocket is
 * a homing projectile, the monster truck is a transform of a car — so without
 * this a gallery could show them only by running a race. Lifting the hold drops
 * them and hands the scene back to the sim.
 *
 * Off by default and reached by nothing on the shipping path — the gallery
 * (/gallery-assets.html) is its only caller. A shell in showcase mode must fetch
 * its scenery bytes from ttp_theme_showcase_models() rather than
 * ttp_theme_scenery_models(): the slot list is longer, and it is the same list
 * for every biome. */
TTP_ABI void ttp_display_showcase(int on);

/* Build the scene for `trackId` from the GLBs/textures the resolved biome names
 * and the roster handed over here.
 *
 * NEITHER THE GEOMETRY NOR THE PALETTE is among them. This runs the native
 * TrackBuilder on trackId and meshes from the result, which is the same
 * ttp::RaceTrack a session on that track races on — so the road drawn and the
 * road driven are one object, not two builds of one descriptor that could drift.
 * The biome comes from that track's own cup (or ttp_display_biome), resolved out
 * of the C++ palette tables, so the look is not authored per shell either.
 * Returns 1 on an unknown trackId.
 *
 * rosterJson is the field in SLOT order — the ONE thing about a race that only
 * the shell knows, since the sim's cars carry no livery and no display name:
 *
 *   [{"id": <scalar>, "name": "…", "carIndex": <n>, "color": "#rrggbb"}, …]
 *
 * The renderer bakes each car's model and livery into its slot here, so this is
 * what lets every later frame put each car back in ITS slot by identity rather
 * than by position in some separately-maintained list. An empty array is legal
 * and is what the lobby's track preview builds with.
 *
 * IT USED TO BE TWO THINGS: the ids came through here and the liveries arrived
 * as a "track.bin" asset — a version-stamped byte buffer with a writer in JS and
 * a parser in the renderer, agreeing by comment. Every shell owed that format a
 * byte-exact encoder, and no fixture in the tree could ever have caught the two
 * drifting. Now one argument carries the roster and libttp-runtime's parseRoster
 * (ttp/roster.h) is its only reader, so the colour arithmetic and the per-model
 * name-plate table are written once for three shells.
 *
 * Every race start comes through here, since a Grand Prix chains four tracks
 * and even a restart wants the skid ribbons, kicked cones and collected boxes
 * back at their opening state. Returns 0 on success. */
TTP_ABI int ttp_display_build(const char* trackId, const char* rosterJson);

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

/* WHERE those cells are: the rectangles this surface is split into for the cars
 * ttp_display_cells named, in cell order. The shell asks instead of computing
 * it, so its HUD cannot disagree with the 3D — one function
 * (ttp_grid_cell, renderer/ttp_render.h) answers both, and the column scoring in
 * it is not ceil(sqrt(n)): a racing cell wants to be wider than tall, so two
 * players on a 16:9 screen are STACKED rather than side by side.
 *
 * Writes 4 floats per cell — x, y, width, height, TOP-LEFT origin — and returns
 * how many cells it wrote: min(cells, maxCells), or 0 when no car owns one
 * (out null, or ttp_display_cells empty/never called). Neither an int PREDICATE
 * nor an OUTCOME (ttp_abi.h): a COUNT, like ttp_room_size and
 * ttp_room_connected_count.
 *
 * Units are the surface's PHYSICAL pixels, the same ones ttp_display_create and
 * ttp_display_resize take. A shell drawing its overlay in scaled units divides
 * by its own scale factor — the browser by devicePixelRatio, the one number the
 * C side is never told (CSS pixels are not a concept tvOS or Android shares).
 *
 * Answers whether or not a scene is built: the layout is a function of the
 * surface and the cell list alone, so the HUD stays put while a Grand Prix
 * releases one track's scene and builds the next.
 *
 * TWO cell-anchored elements are NOT the shell's to place, and do not come back
 * through here: the STEER BAR and the DIVIDERS between cells, which the renderer
 * draws itself (ttp_render.h TtpCellHudInput). Both are textless, so neither
 * needs the UI toolkit the rest of the HUD is written against, and both are
 * pinned to a cell — the one thing this function proves the shell cannot compute
 * a second opinion of. Everything carrying type stays above, placed from these
 * rects: the place/lap ordinal, the name chip, the item slot, the FINISHED card
 * and the reconnect QR. */
TTP_ABI int ttp_display_cell_rects(float* out, int maxCells);

/* Which cells have a centred card over them — bit i for cell i, in the order
 * ttp_display_cells named. A set bit hides that cell's steer bar, which is
 * exactly what the DOM did when a player FINISHED or dropped and was shown the
 * reconnect QR: they are not steering, and the card is the cell's message.
 *
 * A latched flag rather than a per-frame report, because that is what it is —
 * two or three transitions in a race. The card ITSELF stays in the shell (it
 * carries type), so this is the whole of what the renderer needs to know about
 * it: one bit, not a description. */
TTP_ABI void ttp_display_cell_cards(uint32_t mask);

/* WHAT that HUD says: the bound session's per-player race values, packed, one
 * entry per roster slot in ttp_display_build order (ttp_hud.h). Place, lap,
 * total laps, the held item as a CODE, finished, finish time — the six values
 * the shell used to pull out of ttp_snapshot_json by parsing the entire race
 * state and discarding all of it but these.
 *
 * A READBACK, not a frame. Since the steer bar moved into the renderer nothing
 * in the HUD changes faster than a place does, so the shell polls this AT ITS OWN
 * CADENCE rather than being pushed a stream. That rate is genuinely the shell's
 * to pick and nothing here depends on it: this call is a struct read with no
 * allocation, and the values behind it move under one time a second across a full
 * field. The web shell uses HUD_TICK_MS (display/Stage.js, 160 ms); a shell that
 * polls twice as often, or that drives the paint off its own UI framework's
 * invalidation instead, is equally correct. It is also the whole of what leaves:
 * no pose, no speed, no camera, no car id.
 *
 * Never null, and answers with or without a built scene — a slot no live car
 * claims comes back zeroed rather than stale, so a Grand Prix swapping tracks
 * underneath the HUD reads as "nothing to say yet", not as last race's places.
 * The block is the display's own scratch, valid until the next
 * ttp_display_hud: read it now, don't keep it and don't free it (the
 * ttp_display_profile convention).
 *
 * ttp_snapshot_json is NOT going anywhere — abi_check and the eight golden
 * traces depend on it byte-for-byte forever. This is about the shipping game no
 * longer calling it. */
TTP_ABI const TtpHudBlock* ttp_display_hud(void);

/* The chunky ink rules on the seams between split-screen cells. On by default;
 * the display's ?dividers=0 debug toggle turns them off so the look can be
 * A/B'd at a party. */
TTP_ABI void ttp_display_dividers(int enabled);

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
