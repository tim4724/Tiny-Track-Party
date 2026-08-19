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
 * physical pixels. Returns 1 on success, 0 on failure.
 *
 * `const void*`, not `const char*`. Only ONE of the three platforms passes a
 * string here — the web, whose selector is a `const char*` the surface file
 * casts back on arrival — and the other two pass an opaque handle. Typing the
 * parameter as the web's case made the majority spelling the wrong one: tvOS
 * carried a whole extra header and forwarder whose only job was to keep a
 * `CAMetalLayer*` -> `const char*` reinterpret out of the Swift call site, and
 * Android would have owed the same for its ANativeWindow*. Nothing about the
 * emscripten binding changes — cwrap's 'string' argument type marshals a JS
 * string to a pointer regardless of how C spells the parameter. */
TTP_ABI int ttp_display_create(const void* surface, uint32_t width, uint32_t height);
TTP_ABI void ttp_display_resize(uint32_t width, uint32_t height);
/* Block until the renderer's driver thread has executed everything recorded so
 * far. A shell calls this ONCE before resizing the window's buffer queue
 * underneath a threaded backend: a frame recorded at the old size whose buffer
 * is dequeued after the resize lands mis-scaled on the glass for one frame —
 * the Android shell's rare "scene shrinks for a frame" flicker. */
TTP_ABI void ttp_display_drain(void);
TTP_ABI void ttp_display_destroy(void);

/* NO ttp_display_ui_scale. There was one — physical pixels per UI point, so the
 * renderer's chrome could be sized in the CSS pixels display.css authored it in.
 * A shell porting from an older revision should delete its call, not look for a
 * replacement: a UI point needs the panel's physical size and a viewing
 * distance, and a TV shell has neither, so every platform's honest value was
 * just its buffer-resolution ratio. The overlay sizes itself off the cell now
 * (TtpRenderer::drawOverlay), and every number crossing this ABI is back in the
 * surface's own physical pixels. */

/* THE NEXT OPERATING POINT — how big the surface should be AND how often to
 * present it — decided from what the last window of frames cost. Writes
 * {scale, presentDivisor} into `out2` and returns 1; returns 0 and touches
 * nothing if `out2` is null.
 *
 * ONE CALL FOR BOTH, because they are one decision. Frame rate and resolution
 * are two ways of spending the same GPU milliseconds, and ttp/render_scale.h
 * lays them out as a single ordered list of operating points around a desired
 * spot of 1080 lines at 60 Hz: below it resolution gives way and the rate does
 * not, above it the rate goes first. A shell that could take one answer and
 * skip the other would be arbitrating between them itself, which is the whole
 * thing this layer exists to prevent.
 *
 *   curScale / curDivisor          the operating point in force. The divisor is
 *                                  "present every Nth vsync"; 1 is the panel's
 *                                  own rate.
 *   gpuP95Ms / gpuFrames           p95 GPU MILLISECONDS from a timer query
 *                                  around the frame, and how many frames carried
 *                                  a result. Pass 0 where there is no timer.
 *                                  RAW ms and not a share of budget: the budget
 *                                  is what this call decides when it picks a
 *                                  rate, and it is also what lets the cost model
 *                                  survive a rate change, since what a frame
 *                                  costs does not depend on how often it shows.
 *   presentP95Ms / presentFrames   p95 frame interval, and its sample count.
 *   presentFloorMs                 ttp_display_present_floor's running answer.
 *   sinceChangeSec                 seconds the CURRENT POINT has been in force.
 *   sinceSceneSec                  seconds the CURRENT SCENE has been in force —
 *                                  since the build, not since the last resize.
 *                                  A point inherited from a scene that no longer
 *                                  exists has no tenure in this one, so the rule
 *                                  lets the climb back to this scene's level run
 *                                  at one evidence window per step instead of one
 *                                  lap. Pass a large value where there is no such
 *                                  thing as a scene.
 *   prevScale / prevCostMs         the last observation at a DIFFERENT scale.
 *                                  Pass 0/0 until there has been one, and DROP IT
 *                                  on a scene build — a fit whose two points
 *                                  straddle a scene change measures a slope
 *                                  belonging to neither. The rule SOLVES for the
 *                                  point that fits the budget rather than
 *                                  comparing one number to a threshold, and two
 *                                  observations at two scales are what let it
 *                                  separate the resolution-independent half of
 *                                  frame cost from the per-pixel half.
 *   minScale / maxScale            the band, as scale factors on the surface's
 *                                  layout size. Pass minScale 0 for no extra
 *                                  narrowing: the LADDER owns the floor, and a
 *                                  shell may not reach below its bottom rung.
 *   baseLines                      buffer lines a scale of 1.0 means on this
 *                                  surface — the view's height in physical
 *                                  pixels on a TV, the container's CSS height in
 *                                  a browser. The rungs are LINE COUNTS (720,
 *                                  1080, …), so this is what makes one mean the
 *                                  same picture on every platform.
 *   panelMs                        the panel's own present period, ONE VSYNC:
 *                                  16.7 on a 60 Hz TV, 8.3 on a 120 Hz one. 0
 *                                  means "assume 60". Without it the rule cannot
 *                                  know what a rate step is worth, and a fixed
 *                                  60 Hz budget spends a 120 Hz panel's headroom
 *                                  on pixels every time.
 *
 * Everything JUDGED about those numbers — which signal decides, which
 * directions each may move in, how many samples a percentile needs, the holds
 * and the order of the operating points — is in ttp/render_scale.h, where every
 * leg's ctest executes it. Hand over measurements, not opinions, and honour the
 * answer; a shell that has measured nothing gets its current point back.
 *
 * Pure arithmetic, no display state: both of these answer before
 * ttp_display_create and after ttp_display_destroy. */
TTP_ABI int ttp_display_step(double curScale, int curDivisor,
                             double gpuP95Ms, int gpuFrames,
                             double presentP95Ms, double presentFloorMs,
                             int presentFrames, double sinceChangeSec,
                             double sinceSceneSec,
                             double prevScale, double prevCostMs,
                             double minScale, double maxScale,
                             double baseLines, double panelMs,
                             double* out2);

/* The device's own fastest present, folded one window at a time: pass the value
 * this returned last time (0 to begin) and the window's p05 frame interval, keep
 * what comes back, and hand it to ttp_display_step as presentFloorMs.
 *
 * The shell holds it because it is a MEASUREMENT — but WHICH samples may become
 * one, and the fact that it must outlive both the stats window and a resize, are
 * rules, and they are in ttp/render_scale.h with the rest. */
TTP_ABI double ttp_display_present_floor(double prevFloorMs, double p05Ms);

/* ---- scene -------------------------------------------------------------- */

/* Hand the display a named asset's bytes (materials, GLBs, textures). The shell
 * owns fetching; the bytes are copied before this returns. 1 on success —
 * predicate polarity, like every int on the ABI. */
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
 * field is parked (ttp_display_hold): a pair of rockets in the item run at the
 * head of the exhibition straight, and a monster rig on every slot in the back
 * half of the grid. Those two are the only things the renderer draws that a
 * track descriptor cannot author — a rocket is a homing projectile, the monster
 * truck is a transform of a car — so without this a gallery could show them
 * only by running a race. Lifting the hold drops them and hands the scene back
 * to the sim.
 *
 * Off by default and reached by nothing on the shipping path — the gallery
 * (/gallery-assets.html) is its only caller. A shell in showcase mode must fetch
 * its scenery bytes from ttp_theme_showcase_models() rather than
 * ttp_theme_scenery_models(): the slot list is longer, and it is the same list
 * for every biome. */
TTP_ABI void ttp_display_showcase(int on);

/* ---- model variants (DEV) ----------------------------------------------- *
 *
 * Some of what the renderer draws is procedural geometry authored in C++
 * rather than a GLB from the kit — the garden gnome, the wind-up train, the
 * rocket. There is no file to open and no modelling tool in the loop, so the
 * only way to argue about one of those shapes is to build two and look at
 * them, which is what these two latches are for.
 *
 * ttp_display_model_variant picks which take on `model` ("rocket", "gnome",
 * "train") every scene from here on is built with. A shell that never calls it
 * draws the PICKED set, which is the C++ default (TtpRenderer.h) and not
 * variant 0 — variant 0 is each model's pre-bench geometry, kept so the bench
 * has something to argue against. An unknown name is ignored; an out-of-range
 * variant clamps to that model's own count, which differs per model.
 *
 * ttp_display_bench turns the next build into a MODEL BENCH for `model`: every
 * variant of it standing in a row on the verge, all facing the road, and NO
 * other landmarks at all — a doghouse behind the middle gnome is a thumb on
 * the scale. null or "" builds the normal scene.
 *
 * Latched, like ttp_display_biome, and for the same reason: they change what
 * the next ttp_display_build meshes. Reached only by the asset gallery
 * (/gallery-assets.html); nothing on the shipping path calls either. */
TTP_ABI void ttp_display_model_variant(const char* model, int variant);
TTP_ABI void ttp_display_bench(const char* model);

/* ---- the kit field (DEV) ------------------------------------------------ *
 *
 * The other half of the gallery's question. The showroom above stages what the
 * game DRAWS; this stands what it could have drawn — every model of the Kenney
 * kits it picks from — on clear ground beyond the track, each at the size it
 * would ship and under the same light. A sheet of preview renders can say what
 * a model is; only this can say whether it belongs beside what already ships.
 *
 * The shell provides the bytes as kit0.glb … kit<count-1>.glb and passes the
 * count here; 0 builds no field. Latched, like the bench: it changes what the
 * next ttp_display_build meshes. WHICH models, and in what order, is entirely
 * the shell's — the kits are not in the tree and this layer has never heard of
 * them (see scripts/fetch-kits.mjs).
 *
 * ttp_display_kit_field_layout answers where they ended up, as a JSON array in
 * the same order — one {"d","h","w","x","y","z"} per model: its size, measured
 * off its own glTF AABB, and the spot it stands on. The height is there for the
 * same reason as the footprint — a chrome framing one model needs to know
 * whether it is a coin or a loop. A chrome that wants to fly
 * its camera to a model reads it here rather than re-deriving the packing,
 * which is the one way the two could disagree about where a model is. Valid
 * until the next build; "[]" when no field is staged. */
TTP_ABI void ttp_display_kit_field(int count);
TTP_ABI const char* ttp_display_kit_field_layout(void);

/* Build the scene for `trackId` from the GLBs/textures the resolved biome names
 * and the roster handed over here.
 *
 * NEITHER THE GEOMETRY NOR THE PALETTE is among them. This runs the native
 * TrackBuilder on trackId and meshes from the result, which is the same
 * ttp::RaceTrack a session on that track races on — so the road drawn and the
 * road driven are one object, not two builds of one descriptor that could drift.
 * The biome comes from that track's own cup (or ttp_display_biome), resolved out
 * of the C++ palette tables, so the look is not authored per shell either.
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
 * (ttp/roster.h) is its only reader, so the colour arithmetic is written once
 * for three shells.
 *
 * Every race start comes through here, since a Grand Prix chains four tracks
 * and even a restart wants the skid ribbons, kicked cones and collected boxes
 * back at their opening state. Returns 1 on success, 0 on refusal (no
 * display, an unknown trackId, a failed scene build — ttp_last_error says
 * which). */
TTP_ABI int ttp_display_build(const char* trackId, const char* rosterJson);

/* Re-dress the BUILT scene's car slots in place: same rosterJson shape as
 * ttp_display_build, same slot ids in the same order, with only models and
 * liveries changed. The scene, the camera state and the cosmetic clocks are
 * untouched — which is the whole point: a lobby car pick must not snap the
 * preview's orbit back to its start bearing, and it must not pay a track
 * re-mesh and shadow re-bake for a livery.
 *
 * The shell re-provides car<slot>.glb for a slot whose model changed BEFORE
 * calling (fetching is its job, as at build); everything else — which slots
 * changed, whether a change is a model reload or just a re-dress of the
 * markers — is decided here (ttp/roster.h planReroster).
 *
 * Returns 1 when it re-dressed. 0 means this was NOT a re-dress — no scene, a
 * join/leave/reorder, a slot that failed to rebuild — and the shell performs
 * the fallback: a full ttp_display_build. */
TTP_ABI int ttp_display_reroster(const char* rosterJson);

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
 * no pose, no speed, no camera, no car id — the slot's identity is
 * ttp_display_slot_ids_json below, read from the same roster the scene was
 * built with rather than from a list the shell keeps.
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

/* Slot i's car id, as a JSON array in the block's slot order — the other half
 * of the HUD readback. The shell used to keep its own copy of this list from
 * the roster it passed to build, and a drifted index was swallowed silently;
 * now the ONE owner is the built scene's roster (reroster cannot change it —
 * C++ refuses id-list changes there). "[]" with no display or unbuilt scene,
 * which reads as a HUD with no rows. */
TTP_ABI const char* ttp_display_slot_ids_json(void);

/* The chunky ink rules on the seams between split-screen cells. On by default;
 * the display's ?dividers=0 debug toggle turns them off so the look can be
 * A/B'd at a party. */
TTP_ABI void ttp_display_dividers(int enabled);

/* Camera mode for a surface with no cells (ttp_display_cells empty).
 *
 * DEFAULTS TO TTP_CAM_BBOX — the lobby preview's sweep — because that is the
 * only one of the four the shipping game ever wants; the other three belong to
 * gallery and inspector surfaces, which all push a mode explicitly. A shell
 * that never calls this therefore gets a moving preview rather than a frozen
 * one, which is the difference between forgetting the call and shipping a
 * lobby that looks like a still photograph of a correct render. */
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

/* The full-screen antialias pass, ON by default. Off is a QUALITY TRADE a weak
 * GPU may take: the cells then draw straight onto the swap chain, so the frame
 * loses both the offscreen buffer's store and vpresent's full-screen read, and
 * the picture keeps its stair-steps.
 *
 * IT IS NOT A SMALL SAVING, which is why it is a switch rather than a constant.
 * Measured on a PowerVR GE9215 (Google TV Streamer) at 1920x1080 with the
 * backend's own GPU timer: an empty frame costs 25.2 ms with the pass and
 * 15.3 ms without, and a full lobby 91.2 against 78.5. A whole 60 Hz budget is
 * 16.7 ms, so on that device the antialiasing alone is most of a frame.
 *
 * The shell decides, because affordability is a fact about ITS device. */
TTP_ABI void ttp_display_antialias(int on);

/* ---- diagnostics -------------------------------------------------------- */

/* Last frame's per-section wall clock (milliseconds), and the matching comma-
 * joined section names. The array is the renderer's own — read it, don't free. */
TTP_ABI const double* ttp_display_profile(void);
TTP_ABI const char* ttp_display_profile_names(void);

/* The last resolved GPU duration for a frame, in milliseconds, straight off the
 * backend's own timer. 0 means THERE IS NO NUMBER, and a caller must treat that
 * as "no signal" rather than as a fast frame.
 *
 * WHERE IT IS REAL: the GL backend where EXT_disjoint_timer_query exists, which
 * is every Android GL ES 3 device this ships to. WHERE IT IS 0: emscripten,
 * because Filament's GL backend compiles the timer-query probe out there and
 * lands on a fallback that measures CPU time and says so in its own comment —
 * the web shell wraps its own WebGL timer query around the frame instead and
 * this must not be mistaken for it.
 *
 * This is the ONE measurement that can see HEADROOM. A vsync-locked present
 * cadence looks identical at 10 % and 95 % load, which is why the render scale
 * rule (ttp/render_scale.h) may only step DOWN without this and can step both
 * ways with it. */
TTP_ABI double ttp_display_gpu_ms(void);

/* DEBUG: the deck decals packed for the road material last frame, as JSON
 * [{s,lat,halfS,halfLat,r,g,b,a,inner,ellipse,knee}]. Exists because a wrong
 * lateral coordinate survived several rounds of colour-coded shader probes —
 * reading the actual floats and comparing them against the car's own position
 * is one arithmetic check instead of a guess. */
TTP_ABI const char* ttp_display_debug_decals(void);

// Decal isolation, for looking at a deck stamp on its own: hide every car body,
// and wipe the laid rubber. A contact shadow is otherwise a dark patch under an
// opaque car on a deck carrying dark tyre trails, which is unreadable — see the
// warp bench (?scenario=warp), which binds these to keys.
TTP_ABI void ttp_display_debug_hide_cars(int on);
TTP_ABI void ttp_display_debug_wipe_skids(void);

// Force every car's shadow onto ONE decalMask layer (-1 = each car on its own).
// 9 is the generic superellipse — a shape correct by construction, so it
// separates "the bake is wrong" from "everything downstream of it is wrong".
TTP_ABI void ttp_display_debug_force_mask_layer(int layer);

/* FEATURE ABLATION, for the per-feature cost map. Each bit KEEPS one group of
 * renderables; a cleared bit hides it, so the GPU timer around the frame reads
 * that group's draw cost directly. The frame is submission-bound (per-cell draw
 * calls rather than fill), which is why the question is answered by removing
 * groups and not by reading a shader.
 *
 * The mask is latched, and the first call also does the one-time tag pass, so
 * nothing on the shipped path pays for this until something asks. Passing
 * TTP_FEAT_ALL restores the full picture but leaves the tags in place — which
 * is the intended way to run a sweep, since it keeps every arm on the same
 * code path. What it CANNOT measure is a hidden group's FScene::prepare, which
 * still runs: this is the draw half of a feature's cost. */
#define TTP_FEAT_ROAD     0x04  /* the deck ribbon — decals, rubber and paint ride its shader */
#define TTP_FEAT_TERRAIN  0x08  /* ground, sky dome, hills, water, pillars, berms, gantry */
#define TTP_FEAT_DRESSING 0x10  /* scenery, props, landmarks, clutter, cones, signs */
#define TTP_FEAT_SKY      0x20  /* clouds, dust banks, birds, kites, balloon */
#define TTP_FEAT_CARS     0x40  /* car GLBs, monster rigs, boost streaks */
#define TTP_FEAT_EFFECTS  0x80  /* item pools, rockets, bursts, ambient particles */
/* The road turns out to BE the frame's cost, so it has a second set of bits:
 * the four channels of its fragment shader, switched by the uniforms that
 * already gate them. These hide nothing — the same deck is drawn, one channel
 * shorter — which is the most any optimisation of that channel could be worth.
 * The paint channel is static per track and is restored from what the build
 * wrote, so an arm may turn it off and a later arm turn it back on. */
#define TTP_FEAT_ROAD_DECALS 0x0100  /* the per-fragment decal loop (shadows, auras, statics) */
#define TTP_FEAT_ROAD_RUBBER 0x0200  /* the laid-rubber texture tap */
#define TTP_FEAT_ROAD_PAINT  0x0400  /* the deck's own paint (repairs, boost pads) */
#define TTP_FEAT_ROAD_SHADOW 0x0800  /* the GROUND's baked sun-vis tap (the road's
                                        light is baked into its vertices at track
                                        build, so this arm has no road half) */
/* SCENE-WIDE channels: the same picture with one per-fragment term skipped on
 * every surface. Filament's fog is composited INSIDE each surface shader, so it
 * cannot be ablated by hiding a group — it needs a bit of its own. */
#define TTP_FEAT_FOG      0x1000 /* the distance fog every surface composites */
#define TTP_FEAT_ALL      0x1FFC
TTP_ABI void ttp_display_debug_features(unsigned int mask);

#ifdef __cplusplus
}
#endif

#endif /* TTP_DISPLAY_H */
