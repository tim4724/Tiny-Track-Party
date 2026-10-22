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

## Where it stands (2026-10-22, the package on `0d2e5286`)

**Every player count runs at 60 fps; what differs is the resolution.**
Pinned, pretzel, 75 s races, after the fragment package and the car-shadow
ring (the last two rows of the shipped-levers table):

| players | rung | heavy p50 | skipped frames a race | clean seconds |
|---|---|---|---|---|
| 1 | 1080 | 11.4-11.9 ms | 14-23 | 68-69 of 75 |
| 2 | 1080 | 12.1 ms | none | 75 of 75 |
| 3 | 1080 | 13.6-14.3 ms | 9-18, at most 4-6 in any 10 s | 65-67 of 75 |
| 4 | 720 | 11.9-12.6 ms | 8-9 | 67-68 of 75 |

Adaptive, 100 s: one and three players race the first ~59 s at 1080 (0.3-0.4
skips/s) and step to 720 once, where they stay; four players place from the
lobby's 1080, fail it in 2 s and hold 720 with 0.2 skips/s (83 of 97 clean
seconds). The 720 rung is 40-60% idle for every count, so the next lever on
the box is the ladder (Open), not the frame.

Before the package, pinned on `0d2e5286` the same day, 4P/720 read 14.2-14.9
ms heavy and 1P/1080 17.2-18.7 (1.9-2.8 skips/s): the built roster
(`44ed7176`) and the kerb bevel (`95b5edea`) had grown the frame from the
13.0-13.2 / 15.7 of the 2026-10-17 record (the scene budget's recorded worst
frames are +2.8% / +7.8% on pretzel since its last record), and neither was
priced on the box.

**The 4P heavy second at 720, assembled** (2026-10-17, `eca93da5`, before
the two levers above; pretzel, ablations against two base
runs at 12.98 / 13.22 ms heavy):

| item | ms | |
|---|---|---|
| the deck | 3.8 | its AREA: the fragment is two taps and a mix, and `LOD_ALL` null says its vertex count is not it |
| the empty frame | 2.7 | four passes, their clears, the sky dome's fill; ~0.4 ms per extra cell: per-pass fixed work and kick gaps, the first pass's full clear, and the HUD window's GL work inside the timer (Closed > Pass structure) |
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

**What the GPU is doing in a heavy frame** (2026-10-22, `0d2e5286`, the
vendor render-stage trace with its 28 counters at 1 ms, pretzel):

| | 4P/720 | 1P/1080 |
|---|---|---|
| kicks per frame | exactly 4 TA (vertex/binning) + 4 3D (fragment), no partial renders | 1 + 1 |
| the chains | TA 1.80 / 3.19 / 2.54 / 2.95 ms serial on its queue (10.5), 3D 3.80 / 2.66 / 3.39 / 1.98 (11.8), first TA exposed 1.7-2.0, ~0.15 between 3D kicks | TA 2.65-3.0 exposed, 3D 12.2-13.5 |
| fragment shader load | 55-60% | 90% (saturated) |
| vertex shader load | 21% | 21% of a frame whose TA phase is ~17% of it: the TA is vertex-ALU bound |
| texture unit / memory interface / register overload | 37% / 12% / 0 | 47% / 2% / 0 |
| cycles per fragment, per vertex | 12-15, ~51 | ~29, ~50 |

The GPU clock reads 650 MHz on every sample of every race (DVFS never moves;
the operating-point table is unreadable without root). Memory bandwidth, the
texture unit, register pressure and depth traffic (never stored) are not the
bound anywhere; shader ALU is, fragment first. Within a frame the later cells'
TA hides under the earlier cells' 3D with 0.6 / 0.9 / 1.5 ms of slack, so at
4P/720 a fragment cut converts up to ~1.2-1.5 ms before the TA chain binds;
at 1P/1080 fragment cuts convert 1:1 and the exposed first TA is on the
critical path of every frame. Whether frame N+1's first TA can run under
frame N's last 3D is UNMEASURED: the tracer stalls submission so no traced
boundary is backed up (two counts read off traces, "5 of 715" and "268 of
682", were both artefacts, see the traps), and until 2026-10-22 the command
stream forbade it anyway (the car-shadow pass staged three buffer copies at
the head of every frame, each waiting on the previous submission and fenced
by a `TRANSFER -> VERTEX_INPUT` barrier; the ring below removed them, and the
first TA still starts ~0.25 ms after the two head kicks that remain).

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
| 2026-10-22 | the car-shadow pass's vertex and index buffers in a ring of three (the streak ring's rule: a buffer an in-flight frame still references is STAGED, three copies and a `VERTEX_INPUT` barrier ahead of every frame's first TA) | head transfer kicks per frame 5 -> 2 (per-submission trace fold); skipped frames per 75 s, three alternated rounds on one install: 1P/1080 555 -> 474, 3P/1080 839 -> 652, 4P/720 153 -> 74 (one round dominates); the GPU timer cannot see it (its interval starts after the copies) |
| 2026-10-22 | the fragment package: no scene material writes `emissive` (Filament's addEmissive exposure maths left every unlit fragment), display-colour varyings mediump, the fog composite and the deck's chunk-local arclength folded per vertex, the deck's vis tap on a bare .xy varying | against the ring arm, alternated installs, pretzel: 1P/1080 heavy p50 18.0-18.8 -> 11.4-11.9 (-6.6 ms), skipped frames per 75 s 606 -> 54, clean seconds 53-54 -> 68-69; 4P/720 heavy 14.5-14.6 -> 11.9-12.1 (-2.6), skips 46 -> 17, clean 60-62 -> 67-68. Far beyond the deck's flat ceiling (-1.8 / -0.2 below), so most of it is the emissive and mediump halves on EVERY material: the folds alone had read -0.76 at 1P/1080 and null at 4P/720 |

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

**A 4P-only look tier: the rubber tap** (skid marks are ~2 px wide in a 4P
cell; 0.4 ms heavy since display space, 0.6-0.8 before it). Priced, not taken.

**An intermediate rung for one and three players** (the user's call: the
ladder's clean-fraction doctrine, shared with the web and tvOS). Measured
before the package (`0d2e5286`, pretzel, 100 s, 2026-10-22), when 1080 missed
40-46 frames in its worst 10 s window against the 15 the rule leaves a rung
at; after it, one and three players hold 1080 for the first ~59 s and step
down once, so the rung's case is now the second half of the race rather than
the opening pack. Pinned with no code:

| arm | heavy p50 | clean seconds | skips | most missed in any 10 s |
|---|---|---|---|---|
| 1P 1600x900 (`--pin 0.833333`) | 12.3 | 96 of 103 | 13 | 3 |
| 3P 1600x900 | 13.7 | 91 of 100 | 10 | 4 |
| 1P 1408x810 (`--pin 0.75`; the 64-wide rule turns 1440 into 1408) | 10.3 | 95 of 100 | 8 | 2 |
| 3P 1408x810 | 12.1 | 97 of 100 | 3 | 2 |

Both hold on pretzel; 900 is +56% pixels over 720 at the same 60 fps, 810
+24% with more margin but an anisotropic 15/11 x 4/3 upscale. Whether the
6/5 scaler pattern reads as the crawl the ladder doctrine forbids has not
been photographed on this box (the look probe: pins 1.0, 0.833333, 0.75,
0.666667 at the 4K output on a held frame and a slow pan). The cost is one
extra failed rung on a session's first 4P race unless the instant-fail jump
steps two rungs. A 900 rung is `kScaleLadder` plus the ctest's rung counts.

**Two conditional head-of-frame arms** (fork, hours each, judged by skips at
1P/1080 and 3P/1080): the swap-chain acquire wait injected at
`COLOR_ATTACHMENT_OUTPUT` instead of `ALL_COMMANDS` (upstream-idiomatic), then
the GPU timer queries off outside the bench. They decide whether the first TA
can hide under the previous frame's 3D once the ring removed the vertex-stage
hold; the two head kicks that remain (unattributed: the query-pool reset and a
copy) still precede the first TA by ~0.25 ms.

**Car far forms** (per-cell `LodRange` for the merged car groups, past the
8.6 u gate at 4P/720): 0.4-0.7 ms of heavy p50, ~85% of it in the TAs that
hide within the frame, so it buys missed frames only after fragment cuts have
used the 0.6 / 0.9 / 1.5 ms of slack; the smooth-roster export overlaps it
almost entirely (one or the other, the user's look call).

## Closed — measured, and not worth taking

Do not rebuild these without a reason the entry does not already answer. Dated
by the reading that closed it; the build is the one of its day.

**Pass structure and the swap chain**

| lever | verdict |
|---|---|
| per-cell quarter-size targets | ~0.4 ms won at identical fill, the composite back cost ~5x that |
| Vulkan `renderArea` confined to the pass viewport (fork patch) | NULL (2026-09-04): the GPU only touches the tiles a draw reaches. The first version shipped for an hour as a BLACK picture — a Vulkan-backend change is verified by a screen capture on the box |
| the swap chain's first pass scoped to its viewport | NULL by the timer (2026-10-12). The 2026-10-22 trace (below the table) prices it at ~0.3 ms of GPU, inside the heavy seconds' noise |
| one render pass for all the cells (a fork change, aimed at the empty frame's per-cell term) | a LOSS by construction (2026-10-22): the cells' geometry, 9.5 ms of a heavy 4P frame, runs under the earlier cells' fragment work, which one pass would forbid. (The "consecutive frames do not overlap, 5 of 715" this row once cited was the tracer's own stall, not a property of the frame; see the traps) |
| swap-chain compression (`VK_EXT_image_compression_control_swapchain`), an RGB565 swap chain, the first pass's clear scoped to its grid slot | closed by the counters (2026-10-22): `dumpsys SurfaceFlinger` reads `compressed: false` on every buffer, the pixel back end is at 4% and the memory interface at 2-12%, so the stores are not what a frame waits on; the first pass's full clear+store is ~0.3 ms by trace and null by the timer |
| submitting each cell's command buffer as it is recorded (per-View `driver.flush`) | pacing only: the GPU span is unchanged and the frame-skipper's window is fresh at every count (S, vsync to submit, cannot reach it), so at most a few of a race's skips (2026-10-22, by arithmetic) |
| the cheapest cell drawn first | ~0.1 ms at most: the first cell's geometry already takes about as long as the cheapest cell's (2026-10-22) |
| multiview (`OVR_multiview2`) | DELETED: GL-only, re-runs per-view geometry by design, regressed 2P and 3P |
| depth-EQUAL stamp pass for the masked shadows | NULL (2026-08-24): the fragments cost the same in any pass |

**The per-cell term, traced per pass (2026-10-22, `0d2e5286`, pretzel).** The
GPU timer read the empty frame (every group off, pinned 720) at 1.44 ms heavy
p50 for one player and 2.7 for four. Perfetto's `gpu.renderstages`, fed by the
box's vendor producer (`/vendor/lib/libgpudataproducer.so`, whose `start` an
adb-launched binary calls), times each pass's vertex/binning (TA) and fragment
(3D) phases. A heavy 4P/720 frame is 2.1 ms of the first cell's TA with the 3D
unit idle, 11.8 of fragment and 0.36 of idle between 3D kicks (14.5 span, the
rest small TA waits). In the empty frame, one to four players adds 0.9 ms of
GPU span: ~0.3 the first pass clearing and storing the whole surface (536 us
against ~250 for a later quarter), 0.17 kick gaps, ~0.35 per-pass fixed work.
The timer's remaining ~0.3 was the HUD window's GL work landing inside its
interval (tags off, empty 4P/720 heavy p50: 2.35 -> 2.04 ms); at the full
frame it costs nothing (CPU, driver and platform: the HUD window). Depth is
never loaded or stored (the `Z Load/Store` counter reads 0).
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
| simpler models, priced against their own ceiling (2026-10-21, `0d2e5286`, pretzel, per-second pairs, heavy p50 ~14.3 base; pairs are two rounds) | geometry here costs by the OBJECT, not by its vertex count. The ceiling, dressing and cars both removed: 4P/720 heavy p50 -3.0 / -3.3 ms (dressing -1.4 / -2.2, cars -2.0 / -2.4; skipped frames ~25 -> ~4 a minute); 1P/1080 null (the deck's fill); 3P/1080 -0.8 / -2.2 and still 69-77 skipped frames a minute, so no geometry buys any player count a rung. Dressing split: sheets -0.5 / -1.1, kit copies -0.3 / -0.8. The REALISTIC cut does not follow the ceiling: lean flowers (3x2 spheres, capless stems, same stream, about half the flower vertices) NULL over three alternated installs (+0.1 / -0.1 / -0.5); the smooth+12 cars bought ~0.5 (2026-10-20) |
| 16-bit indices and narrower attributes, dead varyings stripped, f16 varyings (a fork patch), the live-lit car vertex at fp16, a light cubemap for the car vertex, flat shading by provoking vertex, back-face culling the cars, a leaner sky dome and lawn discs | closed by the counters and the frame shape (2026-10-22): the TA phase is vertex-ALU bound with the memory interface at 2-12% and register overload 0, so bytes per vertex are not what it waits on; the cars' whole vertex cost is ~0.3-0.45 ms at 4P/720 (the Smooth reading) so no term of it clears 0.3; and a TA cut converts only in the first cell's exposed TA until fragment cuts use the within-frame slack |

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
| the deck's fragment BODY at 4P/720 (a flat fragment, in-build arm, `0d2e5286`, two alternated rounds) | -0.2 ms heavy (+0.35 / -0.73): the deck's 3.8 ms there is its area, its TA share and its iterators, not its shader; no diet of the deck's own fragment ops can move 4P/720 (2026-10-22). At 1P/1080 the same arm reads -1.8 ms (-1.94 / -1.62), the ceiling of every deck fragment lever at that rung |
| the rubber layer's texel density (4096 -> 2048 wide) | not built: the Vulkan box already caps the layer at 4096 (the frame map's "8192" is GL's), the texture unit sits at 37-47% and the near deck magnifies level 0 whatever the width (2026-10-22) |

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
| coalescing a frame's `setImage` copies into one command (fork), deferring the deep rubber mip levels, capping the per-frame kicks | priced, not taken (2026-10-22): the rubber's kicks beyond the constant head kicks are ~0.05-0.07 ms each, serial between 3D kicks, 0.2-0.35 ms a frame on average and 0.5-1.3 on the burst frames; days of layout-tracking fork work whose failure mode is stale ink, on the unverified premise that one multi-region copy is one kick on this driver |

**CPU, driver and platform**

| lever | verdict |
|---|---|
| Filament's queue at VK global priority HIGH | ~-13% skips, but the window's frames finish ~2 ms later and tags can pair with the wrong 3D frame; not taken (2026-10-04). Revisit only with a rule that counts the window's GPU time |
| `Engine::flush` after the uploads | NULL (2026-10-03) |
| `set-fixed-performance-mode-enabled` | NULL (2026-10-12); devfreq is not readable from adb |
| GPU clock: a game power mode, an ADPF hint, any governor lever | the clock counter reads 650 MHz on every sample of every race, quiet and heavy seconds alike (2026-10-22); the MT8696 exposes no `/proc/gpufreq` and devfreq is denied, so whether 650 is the top operating point cannot be read from adb |
| a render thread (the main thread's drops) | drops/s 0 typical and 0 worst on a speed-compiled 4P/720 race (2026-10-22): every missed frame is a frame-skipper decline, the GPU's |
| the rule's tolerance (a longer scene grace, a wider window, a higher threshold) | nothing for 1P/3P (2026-10-22): their 1080 skipping is 5-7 a second on the vistas inside every lap, not the pack alone; only 2P's late retreats would move |
| the frame-timeline API (`postVsyncCallback`) | the +53 ms slot needs the GPU done within ~6 ms of the callback; not built |
| hardware divide (`-march=armv7ve`), PGO/ThinLTO, a fork patch to `FView::partition` | priced, not taken (2026-10-03) |
| inlining the mixer's `lerp` | 21% SLOWER: R8 folds the mixer into one method ART compiles worse |
| the HUD window (tags off, hud off) | NULL since the window erase (2026-10-14, 2026-10-17); it was 2.3 ms on 2026-09-28. Still NULL with ~0.45 ms of GPU a 4P frame left in its own GL context, where the game's timer cannot see it: that work lands in the GPU's idle time (`0d2e5286`, tags off vs on, 4P/720 pretzel, three alternated rounds: heavy p50 -0.07 / +0.11 / +0.41 ms, skipped frames per 60 s 11 -> 23, 25 -> 29, 7 -> 8; 2026-10-22) |

## Traps that live only in this file's history

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
- **A render-stage trace is per-kick physics, never cadence.** The vendor
  producer (`/vendor/lib/libgpudataproducer.so`) halves the frame rate while
  it streams, with or without counters (60 fps before and after a 20 s
  window, 19-40 fps with 20-40 skips/s inside it), so no traced boundary is
  backed up and nothing about inter-frame gaps, overlap or late presents can
  be read off one. Two overlap counts were published off traces and both were
  wrong: "5 of 715" (the tracer's stall) and "268 of 682" (a frame stride
  that ignored the HUD window's GL context, whose ~1 ms 3D kick per frame
  rides the same queue, so every "overlap" was a cell boundary inside one
  frame). Count per `vkQueueSubmit` with the context tagged, or not at all.
- **A build-time arm needs the mask before the build.** The shell applied
  `debug.ttp.features` at the frame loop's first slow tick, 45 ms after the
  scene built; a material picked per instance at build read the shipped arm
  whatever the mask said, and the first probe run measured nothing. The
  knobs are polled before the first build now (`GameCoordinator`); an arm's
  picture is the check (the flat deck still showed rubber).
