# The Android TV box: where the frame goes, and what has been tried

The one perf record for the reference Android box. It replaces two files that
had grown to 2,500 lines between them: this file's earlier dated narrative and
`androidtv-4p-plan.md`, the four-player plan whose goal was met and whose
machinery (sub-floor rungs, the 30 Hz backstop, the masked silhouette loop,
the road-space shadow layer) no longer exists. Every reading below is dated
and names its build, so a code comment pointing at "the frame map, <date>"
still lands on its entry. The full text of each entry, with its arms and
readings, is in git: `git show e3299bc5:docs/perf/androidtv-frame-map.md` and
`git show e3299bc5:docs/perf/androidtv-4p-plan.md`.

The RULES for measuring (and the traps behind them) are in
`shells/androidtv/CLAUDE.md`; the renderer's mechanisms are in
`native/renderer/CLAUDE.md`. This file holds what was MEASURED: numbers rot,
so they live here, stamped, and nowhere else.

## The box

| | |
|---|---|
| Device | Google TV Streamer (kirkwood), Android 14 / API 34, 32-bit userspace (armeabi-v7a) |
| GPU | PowerVR Rogue GE9215, Vulkan driver 23.2. A tile-based deferred renderer with hidden-surface removal: opaque overdraw is free and draw ORDER is not a lever |
| Vulkan facts (`cmd gpu vkjson`) | max 2D image 4096 (GL reports 8192); `samplerAnisotropy` supported (16x); `shaderFloat16` supported and real (forcing vroad's fragment highp cost +1.3 ms, 2026-10-04) |
| Backend | Vulkan, the shipping default. GL costs +10.9 ms at 4P (2026-08-23): its backend thread is 36% inside `libGLESv2_powervr.so`. GL-era numbers do not transfer |
| Output | The HDMI mode does not reach the app's buffers: at 3840x2160@60 (a capture card, 2026-10-17) the SurfaceView is still 1080 lines tall and the hardware composer scales it, so `--pin 0.666667` is 720 lines on either panel. The shell user cannot switch the HDMI mode (`set-user-preferred-display-mode` is refused), so whether a 4K output costs the GPU anything through scan-out bandwidth is unmeasured |
| Thermal | Cold after a reboot reads 3% off warm. Never throttles: a 15-minute 4P soak peaked at 48 C on the board against a 76 C first trip point, GPU cooling device at 0 (2026-10-09) |

## Where it stands (2026-10-17, `eca93da5`)

**Every player count runs at 60 fps; what differs is the resolution.**
Adaptive, 100 s counted, pretzel for one to three players and glacier for four:

| players | at 1080 | then | heavy p50 at the settled rung | clean seconds |
|---|---|---|---|---|
| 1 | 17 s, 0.7 skips/s | 720 | 8.1 ms | 82 of 83 |
| 2 | 30 s, 0.3 skips/s | 720 | 7.5 ms | 69 of 69 |
| 3 | 16 s, 0.3 skips/s | 720 | 9.9 ms | 82 of 83 |
| 4 | never | 720 all race | 11.9 ms | 97 of 99 |

One to three players left 1080 on the opening pack and spent the rest of
the race at 720 with 40-55% of the GPU budget idle. That was the rule, not the
GPU, and the rule is replaced — see "The resolution rule". (Before display space,
4P at 720 was a coin flip: two of five races retreated to 540 on the opening
pack.)

**The 4P heavy second at 720, assembled** (pretzel, ablations against two base
runs at 12.98 / 13.22 ms heavy):

| item | ms | |
|---|---|---|
| the deck | 3.8 | its AREA: the fragment is two taps and a mix, and `LOD_ALL` null says its vertex count is not it |
| the empty frame | 2.7 | four passes, their clears, the sky dome's fill; ~0.4 ms per extra cell |
| terrain | 1.5 | the fill it covers; no member dominates (hills, ground, lawn discs, structures each 0.0-0.5) |
| dressing | 0.8 | |
| decals + the car-shadow pass | 0.8 | `TTP_FEAT_ROAD_DECALS` also hides the shadow pass |
| cars | 0.7 | |
| rubber tap | 0.4 | |
| sun-vis taps | 0.3 | the deck's, the ground's and the structures' |
| paint, effects, sky, fog | under 0.3 each | |

About 11.5 of 13; the remainder is the overlap an ablation cannot see.
Every static surface is unlit with its light baked; only what moves lights
live, per vertex. Nothing per-pixel is left to strip without changing the look.

**The cost model.** The frame is `fixed + fill * s^2` (`s` = lines/1080). 4P
pretzel on 2026-10-12 fitted `6.6 + 23.9 s^2` within 0.3 ms at four pins;
after the display-space change the fixed half is near 4 ms. By that split two
players would cost ~12 ms heavy at 1080 and three ~17; pinned, they read 13.5
and 15.7 (Open, below).

**The CPU side is not the bound.** At 4P both the frame thread and Filament's
backend (`FEngine::loop`) sit near 6.5 ms of the 16.7 budget (2026-10-03,
pinned 432). On the frame thread `cellRender` (cull and command generation,
per cell) is the only phase that scales with cells; `cars` fell from ~1 ms to
0.2-0.4 when the shadow left the CPU raster. What is left on the backend is the
present submit (~24%) and ~7-9 us of driver per draw — not one fault.

## The shipped levers, in order

What each bought, on the build and arm of its day (4P unless noted; "heavy" is
the heavy-30% GPU p50, the only saturated number). Mechanisms are in the
comments beside the code.

| date | change | measured |
|---|---|---|
| 2026-08 | Vulkan the default | 4P/540 GPU median ~27 -> ~17 ms; 32 -> 48 fps |
| 2026-08-23 | staging-buffer bypass | ~1.5 ms off the fixed half |
| 2026-08-24 | `timeBeforeEvictionFbo` 3 -> 60 (`TtpVulkanPlatform`) | backend thread 9.3 -> 7.0 ms/frame; `RGXAddRenderTarget` and FBO churn gone from the profile |
| 2026-09-02 | the deck's far ribbon (`LodRange`, `chooseLods`), chunks of 26 rings, `kLodPx` 2 | vista heavy 20.95 -> 14.2-14.5 at 432 |
| 2026-09-02 | static sheets and kit copies BAKED (`Mesh::bakeLight`, `MergedGroup::baked`) | heavy 14.6 -> 13.5-13.9 at 432 |
| 2026-09-03 | upload rects merged per frame (`kUploadEventTexels`): every `setImage` is its own kick | 540 heavy 17.4 -> 15.4-15.9 |
| 2026-09-04 | the 2D overlay folded into the cells' passes (a load and store of the whole canvas for a few rects) | -0.7 to -1.1 ms heavy |
| 2026-09-04 | rubber mips: one level per frame (`refreshSkidMips`) | clean 28/31 -> 31/34 of 40 |
| 2026-09-09 | snow cloud: `count / cells` sprites, three vertices each, `lite` at 3+ cells | glacier 4P/540 typical 18.4 -> 15.5 |
| 2026-09-09 | terrain relief grid 4.5 u -> 9 u | ribbon 720 heavy 23.4 -> 22.5 |
| 2026-09-10 | sheets cut tile-major (`kSheetTile` 48 u) | -1 ms on quiet seconds, vista unchanged; +0.5 ms frame thread |
| 2026-10-03 | car-shadow texture kept bound, three Views per cell (`mCellRing`), no software divides in the raster | backend -1.1 ms/frame, main -0.5 |
| 2026-10-03 | boost-streak buffers in a ring of three: one staged write serialises the whole frame | 540 skips 1.5-1.7 -> 0.4-0.7/s |
| 2026-10-03/08 | the window stops painting under the surface, then clears only tracked rects (`WindowErase`) | pretzel 720 skips 539 -> 416 per 80 s, tidepool 394 -> 259 |
| 2026-10-04 | deck layer uvs computed per vertex (non-dependent reads) | 1080 heavy 34.0-34.9 -> 33.1-33.6 |
| 2026-10-04 | race HUD sticker groups in retained layers | RenderThread 328 -> 132 ms/s; 540 skips to 0.0-0.1/s |
| 2026-10-04 | snow flakes and cars drawn only into the cells that can see them | glacier typical 12.6-12.9 -> 11.7-12.0 |
| 2026-10-06 | coarse flowers (the user's pick over fewer or swapped ones), exact vertex weld, per-cell far forms (`meshopt_simplify`) | flowers: pretzel heavy 15.7-16.9 -> 14.8-15.7; weld: flurry skips 43 -> 24 per 80 s; far forms: flurry 13 -> 8 |
| 2026-10-06 | compositor timing off (`isCompositorTimingSupported`), clamp-free mip filter | beginFrame worst 4.3-5.4 -> 1.5-3.5 ms |
| 2026-10-06 | the bench compiles `speed`; the APK carries a baseline profile | an adb install runs at `verify`, which is not what a player runs |
| 2026-10-08 | AudioMixer / DisplayHost keep rules (an interpreted mixer starved the driver thread) | pretzel drops per race 15.4 -> 9.8 |
| 2026-10-08 | later cells clear their own viewport instead of loading it (fork, proposed upstream) | pretzel 720 drops 425 -> 237 per 80 s, tidepool 232 -> 58 |
| 2026-10-09 | opaque triangles reordered for vertex reuse (deck ACMR 2.0 -> 1.14) | tidepool heavy 15.9 -> 15.1 |
| 2026-10-09 | the item roulette without its transform (Android only) | pretzel skips 158 -> 119 a race; the window's cost, not Filament's |
| 2026-10 | VkPipelineCache persisted across launches | first-use pipeline compiles off the race |
| 2026-10-14 | paint loop bounds box; B-spline gate at 0.6 x remapLo; deck and ground in `vertexDomain : world` | -0.9 to -1.75 ms heavy together; clean 38-41 -> 57-59 of 75 |
| 2026-10-14 | sky as a vertex-gradient dome at each cell's eye, not a cubemap skybox | -0.5 / -0.7 ms heavy |
| 2026-10-17 | the car shadow as one draw per car on the deck, clipped to the stamp's support | -1.4 to -1.8 ms heavy against the road-space layer; skips ~75 -> ~20 per 75 s |
| 2026-10-17 | the scene authored in display space: no fragment encodes | -1.4 / -1.5 ms all seconds; 4P holds 720 all race |

## The resolution rule, replaced (2026-10-18)

**The old rule could not climb back inside a scene.** It steered off the GPU
timer through a `fixed + fill * s^2` model fitted from two windows at two
resolutions. On a step down, the window it recorded as the model's point was
the late one (GPU p95 over 0.90 of budget), so the rung just left was always
predicted at its own retreat cost, over the 0.85 climb target: no climb back
until the next scene build. One to three players left 1080 on the opening
pack and spent the rest of the race at 720 with 40-55% of the budget idle.

What 1080 is worth to them, pinned for a whole race (`eca93da5`, pretzel,
100 s counted):

| players | fps | skips/s | clean seconds | heavy p50 | most frames missed in any 10 s |
|---|---|---|---|---|---|
| 1 | 58.8 | 1.2 | 79 of 100 | 15.7 | 40 (13-18 s) |
| 2 | 59.9 | 0.1 | 92 of 100 | 13.5 | 4 |
| 3 | 59.2 | 0.8 | 83 of 100 | 15.7 | 46 (28-32 s) |

One full-screen cell frames more deck than two half cells, which is why one
player is no cheaper than three.

**The rule now (`ttp/render_scale.h`) counts MISSED FRAMES and nothing else**,
so it is the same on a browser with no GPU timer. A rung is left on 15 missed
frames in the last 10 s, climbed after 10 clean seconds once it has stood
40 s, and a step down within 30 s of entering a rung FAILS it, doubling the
wait before the next try (to 320 s at once if it failed before a full window,
which is a rung that cannot hold at all). A scene build forgives nothing — a
cup is one session, the same players race after race — and a rung held for
30 s clears its failures. The rate is the panel's own: a 120 Hz panel is held
at 120 with pixels.

Against the old rule, adaptive pretzel races, 100 s counted, seconds at 1080
and moves per race read off the rule's own log (`1.0-e3299bc5-dirty` builds,
installs alternated; four races of the old rule, two of the final rule):

| players | old rule: 1080 / moves | new rule: 1080 / moves |
|---|---|---|
| 1 | 14-30 s / 1 | 16-49 s / 1-3 |
| 2 | 16-39 s / 1, once 100 s / 0 | 59-100 s / 0-2 |
| 3 | 15-16 s / 1 | 19-59 s / 2 |
| 4 | 0 / 1 | 0 / 1 |

Two players now keep 1080 for most or all of a race; one and three players
still leave it on the opening pack, as they should (pinned there they skip
0.8-1.2 frames a second), and get it back late in some races. The threshold
was 10 first: two players then always left 1080 at the same ~38 s stretch and
came back 40 s later, and one 4P race dipped 720 to 540 on its vista. And
before the instant-fail jump, four players tried 1080 once a race and paid
2 s at ~50 fps for it.

**A whole cup in one process** (the `session` scenario: 45 s of lobby, then the
first cup with four players; the bench above relaunches the app per race and
cannot show this):

| rule | lobby | race 1 | races 2-4 |
|---|---|---|---|
| no player count | held 1080 | started at 1080: 62 frames missed in its first 6 s (~37 fps), down to 720 at 5.4 s | 720, no move, 0-7 skipped frames each |
| per player count, a new count placed a rung lower (tried, dropped) | dipped to 720 on its own boot (~20 frames, 20-25 s in) | started at 720; one try of 1080 at 80 s, 15 frames in 3 s, back | 720, no move, 1-3 skipped frames each |

So each scene starts on the rung its player count last held, and the lobby,
back from a cup, is placed straight on its own rung. A count not seen yet
starts where the scene before it was, and only missed frames move the rung,
so its race 1 pays the first row's opening seconds. Placing it lower was
tried: it cost every 1080-ceiling device its pixels on each new count,
whether it could hold 1080 or not, and put the host's half-rate offer in
front of devices that never missed a frame.

## Open

**THE EMPTY FRAME's per-cell term, ~1.2 ms at 4P.** Every group off, pinned
720 (light / heavy p50): 1P 1.05 / 1.44, 2P 1.04 / 1.58, 3P 1.39 / 2.18, 4P
2.16 / 2.7. The only collector is one render pass with four viewports instead
of a pass per View — a Filament fork change. Neither a constrained render
area nor scoping the first pass moved it (Closed, below).

**A 4P-only look tier: the rubber tap** (skid marks are ~2 px wide in a 4P
cell; 0.4 ms heavy since display space, 0.6-0.8 before it). Priced, not taken.

## Closed — measured, and not worth taking

Do not rebuild these without a reason the entry does not already answer. Dated
by the reading that closed it; the build is the one of its day.

**Pass structure and the swap chain**

| lever | verdict |
|---|---|
| per-cell quarter-size targets | ~0.4 ms won at identical fill, the composite back cost ~5x that |
| Vulkan `renderArea` confined to the pass viewport (fork patch) | NULL (2026-09-04): the GPU only touches the tiles a draw reaches. The first version shipped for an hour as a BLACK picture — a Vulkan-backend change is verified by a screen capture on the box |
| the swap chain's first pass scoped to its viewport | NULL (2026-10-12) |
| multiview (`OVR_multiview2`) | DELETED: GL-only, re-runs per-view geometry by design, regressed 2P and 3P |
| depth-EQUAL stamp pass for the masked shadows | NULL (2026-08-24): the fragments cost the same in any pass |
| sRGB swap chain instead of a shader encode | a 3.5 ms LOSS on GL (`EGL_KHR_gl_colorspace`), NULL on Vulkan (2026-09-02); moot since display space |
| swap-chain image count / MAILBOX | latency 48-49 ms in every arm: it is the platform's frame timeline (SurfaceFlinger's +70 ms slot), not the queue (2026-09-02) |
| a third app layer (an overlay SurfaceView for the tags) | the composer takes two app layers; a third drops both to GPU composition, heavy 18.5 ms (2026-10-14) |

**Geometry, culling and draws**

| lever | verdict |
|---|---|
| distance LOD for anything but the deck, fog culling, a far-plane cut | the scenery ends where the fog saturates: 600 -> 100 u moved the submitted count ~2% |
| deck: a second coarser ribbon past 60 u, a nearer gate, `kLodPx` 4, chunks of 13 or 52 rings, a 6-strip far cross-section | all NULL (2026-09-02..10-17): the camera's own chunk is always near |
| `LOD_ALL` (far ribbon everywhere) | its -1.1 ms was the car shadow failing the depth test on chords; with shadowed chunks pinned near it is NULL (2026-10-17) |
| a tighter ribbon chord (0.005 u) | the far ribbon's value IS the loose chord on gently curved far rings (2026-09-10) |
| back-face culling the deck and the ground (per-instance `setCullingMode`) | NULL (2026-10-04) |
| static sheets as range chunks (by triangle ORDER) | NULL by construction; tile-major chunks shipped instead (2026-09-10) |
| six-sided far pillars, baked train rails, flower stand-ins past 0.4 u | NULL (2026-10-06) |
| chase FOV 48 instead of 55 degrees | a wash: fewer primitives, each covering more tiles (2026-09-10) |
| merged vs unmerged draw groups, one shared MaterialInstance | draw COUNT does not matter here; the merge steadies the tail and is load-bearing on tvOS |
| coarser deck / terrain geometry | -0.4 ms GPU for +0.55 ms of frame thread |
| the road's ring step 0.48 -> 0.72 u | 0.3 ms, for real chord sag on every track (GL era) |
| bigger deck chunks (13 -> 6 a lap) | +2.7 ms of fill: the per-chunk cull and decal window widen (GL era) |
| ground and hills drawn after every opaque | NULL: the tiler already rejects the overdraw |
| terrain by member (hills, ground sheet, lawn discs, structures) | 0.0-0.5 each against the group's 1.3-1.4 (2026-10-17) |

**The deck's shader**

| lever | verdict |
|---|---|
| the masked silhouette loop's five escapes (fetch, precision, uniform writes, texture space, pass) | all dead (2026-08-24); the loop itself is deleted |
| a per-chunk box in front of the shadow tap (`shadowBounds`, `blobBounds`) | NULL twice; the second "win" was the shadow not drawing (2026-09-04). Verify a car-shadow change on a frame where the shadow is VISIBLE |
| a per-chunk gate on the rubber tap, on the sun-vis tap | NULL / ~0.15 ms (2026-09-04, 2026-10-14): what is on screen is the few chunks under the cars |
| the paint and profile loops compiled OUT (a `lean` material constant) | NULL (2026-10-17): once the fragment is short, the arrays' declared size stops costing |
| the loops gated by a 32-bin occupancy mask; the chevron loop bounded | NULL (2026-10-17). A chevron loop with DYNAMIC bounds hung the GPU outright (`waitForever: Pipeline stage signal fence`) |
| the rubber tap's filtering (bilinear-mip-nearest, no anisotropy) | NULL: the cost is the fetch over a 16k-texel layer (2026-10-17) |
| one two-channel layer for rubber + shadow | NULL as a probe (2026-10-14) |
| `doubleSided : false` on vroad | NULL: Filament drops the unread normal varying anyway |
| skipping the rubber's mip refresh | ~0.6 ms, and the far field scintillates without it |
| a mip chain on the sun-vis maps | NULL, and it softens the far shadow (2026-10-14) |
| the fog per vertex removed (`TTP_FEAT_FOG_VERTEX`), a fog early-out past 95% | NULL (2026-08-23, 2026-08-24) |
| fp16 in the vertex stage | the ALU is Filament's own transform pipeline; ours moves under 0.2 ms (2026-08-23, counted in the SPIR-V) |

**Shading, lighting, colour**

| lever | verdict |
|---|---|
| matte light moved to the vertex stage for the kit and lit sheets | a LOSS at 4 cells (2026-09-02): the frame was vertex-bound; BAKING it is what paid |
| the kit material lit per vertex | the vertex light costs what the fragment shade saved (2026-09-02) |
| a world-domain twin of `vcolor` for sheets and kit runs | NULL (2026-10-14): the dressing's vertices are not where the vertex cost is |
| the grade at the vertex on flat sheets; an ALU sRGB approximation | NULL / no cheaper (one full-screen transcendental is ~3 ms here); the grade is gone since display space |
| the cloud puffs' discs baked to a texture | NULL: the sky arm is fill (2026-10-17) |
| the B-spline under the car shadow dropped | -0.6 ms but bands pulse in motion; kept (2026-10-14), and moot since the pass |

**Uploads**

| lever | verdict |
|---|---|
| barrier stage masks, a twin texture nothing samples, fewer rows, no mip usage | all NULL (2026-09-03): the COUNT of copies is the cost, which the merge took |
| the rubber's level-0 upload throttled | NULL (2026-08-26); the throttle is gone, the trail's head sits at the tyre |
| the car shadow's raster + upload | +0.03 ms GPU (2026-10-12); the layer is gone since the pass |

**CPU, driver and platform**

| lever | verdict |
|---|---|
| Filament's queue at VK global priority HIGH | ~-13% skips, but the window's frames finish ~2 ms later and tags can pair with the wrong 3D frame; not taken (2026-10-04). Revisit only with a rule that counts the window's GPU time |
| `Engine::flush` after the uploads | NULL (2026-10-03) |
| `set-fixed-performance-mode-enabled` | NULL (2026-10-12); devfreq is not readable from adb |
| the frame-timeline API (`postVsyncCallback`) | the +53 ms slot needs the GPU done within ~6 ms of the callback; not built |
| hardware divide (`-march=armv7ve`), PGO/ThinLTO, a fork patch to `FView::partition` | priced, not taken (2026-10-03) |
| inlining the mixer's `lerp` | 21% SLOWER: R8 folds the mixer into one method ART compiles worse |
| the HUD window (tags off, hud off) | NULL since the window erase (2026-10-14, 2026-10-17); it was 2.3 ms on 2026-09-28 |

## Two traps that live only in this file's history

- **A feature bit is a LOWER bound on a channel's cost.** It gates shading; it
  cannot un-bind a sampler, un-declare an attribute or un-send an upload. Two
  shadow commits that cost a rung at 432 could not be bought back with their
  own bits (bisected, 2026-08-28), and the grade's bit read 0.8 ms where
  removing the grade bought 1.5 (register pressure in a long fragment). Never
  size a revert from an ablation.
- **Photograph an arm that reads too good.** `camera_at_origin` set before the
  first View is a silent no-op: an arm read 10 ms against 17 because the deck
  had left the screen (2026-10-14). The render-area patch read as a win while
  the screen was black (2026-09-04).
